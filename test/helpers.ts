import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { git } from "../git.ts";

export const signal = () => new AbortController().signal;

// Fixture objects do not depend on or alter the developer's Git identity, signing, or hooks.
export async function snapshot(source: string, parent?: string): Promise<string> {
  await git(source, ["add", "."]);
  const tree = (await git(source, ["write-tree"])).trim();
  const object = [
    `tree ${tree}`,
    ...(parent ? [`parent ${parent}`] : []),
    "author Fixture <fixture@example.invalid> 1700000000 +0000",
    "committer Fixture <fixture@example.invalid> 1700000000 +0000",
    "",
    "test: seed checkout",
    "",
    "Assisted-by: opencode/gpt-6.1-sol",
    "",
  ].join("\n");
  const oid = execFileSync("git", ["-C", source, "hash-object", "-t", "commit", "-w", "--stdin"], {
    input: object,
    encoding: "utf8",
  }).trim();
  await git(source, ["update-ref", "HEAD", oid]);
  return oid;
}

export async function fixture(t: TestContext) {
  const base = process.env.OPENCODE_TEST_TMPDIR ?? tmpdir();
  const root = await mkdtemp(join(base, "proper-worktrees-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source checkout");
  await mkdir(source);
  await git(source, ["init", "--initial-branch=main"]);
  await writeFile(join(source, "README.md"), "committed\n");
  await writeFile(join(source, ".gitignore"), ".env\nlocal/\nnode_modules/\n");
  const initial = await snapshot(source);
  const directory = join(root, "worktrees", "My task");
  return { root, source, sourceDirectory: source, directory, initial };
}
