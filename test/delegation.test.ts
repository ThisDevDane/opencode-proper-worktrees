import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { WorktreeDefinition } from "@opencode/plugin/promise/worktree";

import { exists } from "../copy.ts";
import { git } from "../git.ts";
import { nativeStrategy } from "../native-strategy.ts";
import { makeStrategy } from "../worktrees.ts";
import { fixture, signal } from "./helpers.ts";

test("wrapper calls native create first, prepares the result, and delegates list/remove", async (t) => {
  const f = await fixture(t);
  const native = nativeStrategy();
  const calls: string[] = [];
  let result: { directory: string } | undefined;
  await writeFile(join(f.source, ".env"), "fixture");
  const spy: WorktreeDefinition = {
    ...native,
    async create(input, context) {
      calls.push("create");
      assert.equal(input.branch, f.initial);
      result = await native.create(input, context);
      assert.equal(
        (await git(result.directory, ["rev-parse", "--symbolic-full-name", "HEAD"])).trim(),
        "HEAD",
      );
      assert.equal(await exists(join(result.directory, ".env")), false);
      return result;
    },
    async list(source, context) {
      calls.push("list");
      return native.list(source, context);
    },
    async remove(input, context) {
      calls.push("remove");
      return native.remove(input, context);
    },
  };
  const strategy = makeStrategy({ branchPrefix: "wrapped/", copyPaths: [".env"] }, spy);
  assert.equal(await strategy.create({ ...f, branch: f.initial }, { signal: signal() }), result);
  assert.deepEqual(calls, ["create"]);
  assert.match((await git(f.directory, ["branch", "--show-current"])).trim(), /^wrapped\//);
  assert.equal(await readFile(join(f.directory, ".env"), "utf8"), "fixture");
  await strategy.list(f.source, { signal: signal() });
  assert.deepEqual(calls, ["create", "list"]);
  await strategy.remove({ directory: f.directory, force: true }, { signal: signal() });
  assert.deepEqual(calls, ["create", "list", "list", "remove"]);
});

test("wrapper prepares and returns the actual native destination", async (t) => {
  const f = await fixture(t);
  const actual = join(f.root, "actual destination");
  const native = nativeStrategy();
  await writeFile(join(f.source, ".env"), "fixture");
  const strategy = makeStrategy(
    { copyPaths: [".env"] },
    {
      ...native,
      create: (input, context) => native.create({ ...input, directory: actual }, context),
    },
  );
  assert.deepEqual(await strategy.create(f, { signal: signal() }), { directory: actual });
  assert.equal(await exists(f.directory), false);
  assert.match((await git(actual, ["branch", "--show-current"])).trim(), /^opencode\//);
  assert.equal(await readFile(join(actual, ".env"), "utf8"), "fixture");
});

test("failed preparation removes through the native strategy", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "outside"), "untouched");
  await symlink("../outside", join(f.source, ".env"));
  const native = nativeStrategy();
  let removed = false;
  const strategy = makeStrategy(
    { copyPaths: [".env"] },
    {
      ...native,
      async remove(input, context) {
        assert.equal(input.directory, f.directory);
        assert.equal(input.force, true);
        removed = true;
        await native.remove(input, context);
      },
    },
  );
  await assert.rejects(strategy.create(f, { signal: signal() }), /symlink/);
  assert.equal(removed, true);
  assert.equal(await exists(f.directory), false);
  assert.equal((await git(f.source, ["branch", "--list"])).trim(), "* main");
});

test("cancellation after native creation still rolls back with a fresh signal", async (t) => {
  const f = await fixture(t);
  const native = nativeStrategy();
  const controller = new AbortController();
  const reason = new Error("cancelled after native create");
  let removed = false;
  const strategy = makeStrategy(
    {},
    {
      ...native,
      async create(input, context) {
        const created = await native.create(input, context);
        controller.abort(reason);
        return created;
      },
      async remove(input, context) {
        assert.equal(context.signal.aborted, false);
        removed = true;
        await native.remove(input, context);
      },
    },
  );
  await assert.rejects(
    strategy.create(f, { signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  assert.equal(removed, true);
  assert.equal(await exists(f.directory), false);
  assert.equal((await git(f.source, ["branch", "--list"])).trim(), "* main");
});

test("wrapper does not remove anything when native creation fails", async (t) => {
  const f = await fixture(t);
  const reason = new Error("native creation failed");
  const strategy = makeStrategy(
    {},
    {
      ...nativeStrategy(),
      async create() {
        throw reason;
      },
      async remove() {
        assert.fail("failed native create does not grant ownership");
      },
    },
  );
  await assert.rejects(
    strategy.create(f, { signal: signal() }),
    (error: unknown) => error === reason,
  );
});
