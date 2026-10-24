import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { Worktree } from "@opencode/plugin";
import type { WorktreeDefinition } from "@opencode/plugin/promise/worktree";

import { readOptions } from "./config.ts";
import { copyPaths, exists, hasCode, inside } from "./copy.ts";
import { git } from "./git.ts";
import { nativeStrategy } from "./native-strategy.ts";

const strategyID = "opencode-proper-worktrees";
const markerName = `${strategyID}.json`;

function branchName(prefix: string, directory: string): string {
  const name =
    basename(directory)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "worktree";
  return `${prefix}${name}-${randomUUID().slice(0, 12)}`;
}

async function markerPath(directory: string, signal?: AbortSignal): Promise<string> {
  return (
    await git(directory, ["rev-parse", "--path-format=absolute", "--git-path", markerName], signal)
  ).replace(/\r?\n$/, "");
}

async function owned(directory: string, signal: AbortSignal): Promise<boolean> {
  const path = await markerPath(directory, signal);
  try {
    const marker: unknown = JSON.parse(await readFile(path, "utf8"));
    return (
      typeof marker === "object" &&
      marker !== null &&
      "strategy" in marker &&
      marker.strategy === strategyID &&
      "version" in marker &&
      marker.version === 1
    );
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
}

export function makeStrategy(
  options: Record<string, unknown> = {},
  native: WorktreeDefinition = nativeStrategy(),
): WorktreeDefinition {
  const config = readOptions(options);
  return {
    id: strategyID,
    async create(input, { signal }) {
      signal.throwIfAborted();
      const source = await realpath(input.sourceDirectory);
      const directory = resolve(input.directory);
      if (await exists(directory)) {
        throw new Error(`Worktree destination already exists: ${directory}`);
      }
      await mkdir(dirname(directory), { recursive: true });
      // Resolve the parent before containment checks, including symlinked destination parents.
      const target = resolve(await realpath(dirname(directory)), basename(directory));
      const sourceRoot = (await git(source, ["rev-parse", "--show-toplevel"], signal)).replace(
        /\r?\n$/,
        "",
      );
      for (const path of config.copyPaths) {
        if (inside(resolve(sourceRoot, path), target)) {
          throw new Error(`Copy path contains the worktree destination: ${path}`);
        }
      }
      const branch = branchName(config.branchPrefix, target);
      await git(source, ["check-ref-format", "--branch", branch], signal);
      // Core creates the detached worktree from the requested starting ref. Our
      // post-processing finishes before OpenCode receives its result.
      const created = await native.create(
        { ...input, sourceDirectory: source, directory: target },
        { signal },
      );
      let start: string | undefined;
      try {
        start = (await git(created.directory, ["rev-parse", "HEAD"], signal)).trim();
        await git(created.directory, ["switch", "--no-track", "-c", branch], signal);
        await writeFile(
          await markerPath(created.directory, signal),
          JSON.stringify({ strategy: strategyID, version: 1 }),
          { flag: "wx" },
        );
        await copyPaths(sourceRoot, created.directory, config.copyPaths, signal);
        signal.throwIfAborted();
        return created;
      } catch (error) {
        try {
          const current = (
            await git(created.directory, ["rev-parse", "--symbolic-full-name", "HEAD"])
          ).trim();
          if (current !== "HEAD" && current !== `refs/heads/${branch}`) {
            throw new Error("Rollback refused: worktree branch changed.");
          }
          // The returned directory belongs to this successful native create.
          // Cleanup must run even when the original request was cancelled.
          await native.remove(
            { directory: created.directory, force: true },
            { signal: new AbortController().signal },
          );
          if (current === `refs/heads/${branch}` && start) {
            // Do not delete an existing branch when 'switch -c' failed. An expected
            // OID also protects commits made after our branch was attached.
            await git(source, ["update-ref", "-d", `refs/heads/${branch}`, start]);
          }
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Worktree preparation failed; rollback was incomplete at ${created.directory}.`,
          );
        }
        throw error;
      }
    },
    async remove({ directory, force }, { signal }) {
      signal.throwIfAborted();
      const target = await realpath(directory);
      const inventory = await native.list(target, { signal });
      if (
        inventory.some((item) => item.type === "root" && resolve(item.directory) === target) ||
        !(await owned(target, signal)) ||
        !inventory.some((item) => resolve(item.directory) === target)
      ) {
        throw new Error("Refusing to remove a checkout not owned by opencode-proper-worktrees.");
      }
      if (
        !force &&
        (await git(
          target,
          ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"],
          signal,
        ))
      ) {
        throw new Worktree.OperationError({
          message:
            "Worktree has uncommitted, untracked, or ignored files. Confirm forced removal to discard them.",
          forceRequired: true,
        });
      }
      await native.remove({ directory: target, force }, { signal });
      // Keep the branch and its commits after worktree removal.
    },
    async list(source, { signal }) {
      const result: { directory: string; type: "root" | "worktree" }[] = [];
      const inventory = await native.list(source, { signal });
      for (const item of inventory) {
        signal.throwIfAborted();
        if (item.type === "root" || (await owned(item.directory, signal))) {
          result.push(item);
        }
      }
      return result;
    },
  };
}
