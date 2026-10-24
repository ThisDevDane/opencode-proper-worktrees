import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { Plugin } from "@opencode/plugin";
import type { WorktreeDefinition, WorktreeEditor } from "@opencode/plugin/promise/worktree";

import { git } from "../git.ts";
import plugin from "../index.ts";
import { fixture, signal } from "./helpers.ts";

test("V2 setup registers a strategy that uses plugin options", async (t) => {
  const f = await fixture(t);
  let registered: WorktreeDefinition | undefined;
  const ctx = {
    options: { branchPrefix: "plugin/", copyPaths: [".env"] },
    worktree: {
      async transform(callback: (editor: WorktreeEditor) => void) {
        callback({
          add: (strategy) => {
            registered = strategy;
          },
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Plugin.Context;
  assert.equal(plugin.id, "opencode-proper-worktrees");
  await plugin.setup(ctx);
  assert.ok(registered);
  assert.equal(registered.id, plugin.id);
  await writeFile(join(f.source, ".env"), "fixture");
  await registered.create(f, { signal: signal() });
  assert.match((await git(f.directory, ["branch", "--show-current"])).trim(), /^plugin\//);
  assert.equal(await readFile(join(f.directory, ".env"), "utf8"), "fixture");
});

test("invalid options fail setup before a worktree transform is registered", async () => {
  const ctx = {
    options: { copyPaths: ["../outside"] },
    worktree: { transform: () => assert.fail("must validate before registration") },
  } as unknown as Plugin.Context;
  await assert.rejects(async () => plugin.setup(ctx), /copyPaths/);
});
