import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { Worktree } from "@opencode/plugin";

import { exists } from "../copy.ts";
import { git } from "../git.ts";
import { nativeStrategy } from "../native-strategy.ts";
import { fixture, signal } from "./helpers.ts";

test("native adapter creates detached worktrees and delegates discovery and removal", async (t) => {
  const f = await fixture(t);
  const native = nativeStrategy();
  const created = await native.create({ ...f, branch: f.initial }, { signal: signal() });
  assert.deepEqual(created, { directory: f.directory });
  assert.equal(
    (await git(created.directory, ["rev-parse", "--symbolic-full-name", "HEAD"])).trim(),
    "HEAD",
  );
  assert.equal((await git(created.directory, ["rev-parse", "HEAD"])).trim(), f.initial);
  assert.deepEqual(await native.list(f.source, { signal: signal() }), [
    { directory: f.source, type: "root" },
    { directory: f.directory, type: "worktree" },
  ]);
  await native.remove({ directory: created.directory, force: false }, { signal: signal() });
  assert.equal(await exists(created.directory), false);
});

test("native Git errors become public operation errors with force confirmation intact", async (t) => {
  const f = await fixture(t);
  const native = nativeStrategy();
  await assert.rejects(
    native.create({ ...f, branch: "missing-ref" }, { signal: signal() }),
    (error: unknown) => {
      assert.ok(error instanceof Worktree.OperationError);
      assert.match(error.message, /missing-ref/);
      return true;
    },
  );
  await native.create(f, { signal: signal() });
  await writeFile(join(f.directory, "README.md"), "dirty native worktree");
  await assert.rejects(
    native.remove({ directory: f.directory, force: false }, { signal: signal() }),
    (error: unknown) => {
      assert.ok(error instanceof Worktree.OperationError);
      assert.equal(error.forceRequired, true);
      return true;
    },
  );
  assert.equal(await exists(f.directory), true);
  await native.remove({ directory: f.directory, force: true }, { signal: signal() });
});

test("native adapter honors cancellation before acquiring services or running Git", async (t) => {
  const f = await fixture(t);
  const native = nativeStrategy();
  const controller = new AbortController();
  const reason = new Error("cancelled native operation");
  controller.abort(reason);
  const context = { signal: controller.signal };
  await assert.rejects(native.create(f, context), (error: unknown) => error === reason);
  await assert.rejects(native.list(f.source, context), (error: unknown) => error === reason);
  await assert.rejects(
    native.remove({ directory: f.source, force: true }, context),
    (error: unknown) => error === reason,
  );
  assert.equal(await exists(f.directory), false);
});
