import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { Worktree } from "@opencode/plugin";

import { exists } from "../copy.ts";
import { git } from "../git.ts";
import { nativeStrategy } from "../native-strategy.ts";
import { makeStrategy } from "../worktrees.ts";
import { fixture, signal, snapshot } from "./helpers.ts";

test("creates an attached branch with the default prefix at source HEAD", async (t) => {
  const f = await fixture(t);
  const strategy = makeStrategy();
  assert.deepEqual(await strategy.create(f, { signal: signal() }), { directory: f.directory });
  const branch = (await git(f.directory, ["symbolic-ref", "--short", "HEAD"])).trim();
  assert.match(branch, /^opencode\/my-task-[a-f0-9-]+$/);
  assert.equal((await git(f.directory, ["rev-parse", "HEAD"])).trim(), f.initial);
  assert.equal((await git(f.source, ["branch", "--show-current"])).trim(), "main");
  assert.equal(await readFile(join(f.directory, "README.md"), "utf8"), "committed\n");
  assert.equal(await git(f.directory, ["status", "--porcelain"]), "");
});

test("custom prefix and starting ref create a new branch without switching the source", async (t) => {
  const f = await fixture(t);
  await git(f.source, ["branch", "earlier", f.initial]);
  await writeFile(join(f.source, "README.md"), "later\n");
  const later = await snapshot(f.source, f.initial);
  await makeStrategy({ branchPrefix: "dane/task-" }).create(
    { ...f, branch: "earlier" },
    { signal: signal() },
  );
  assert.match(
    (await git(f.directory, ["branch", "--show-current"])).trim(),
    /^dane\/task-my-task-/,
  );
  assert.equal((await git(f.directory, ["rev-parse", "HEAD"])).trim(), f.initial);
  assert.equal((await git(f.source, ["rev-parse", "HEAD"])).trim(), later);
});

test("creates from the selected linked checkout, not the canonical checkout", async (t) => {
  const f = await fixture(t);
  const linked = join(f.root, "other checkout");
  await git(f.source, ["worktree", "add", "-b", "other", "--", linked]);
  await writeFile(join(linked, "README.md"), "other branch\n");
  const other = await snapshot(linked, f.initial);
  await writeFile(join(linked, ".env"), "from selected checkout");
  await makeStrategy({ copyPaths: [".env"] }).create(
    { sourceDirectory: linked, directory: f.directory },
    { signal: signal() },
  );
  assert.equal((await git(f.directory, ["rev-parse", "HEAD"])).trim(), other);
  assert.equal(await readFile(join(f.directory, ".env"), "utf8"), "from selected checkout");
});

test("copies ignored files and folders, preserves relative paths, and skips missing paths", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, "local", "nested"), { recursive: true });
  await writeFile(join(f.source, ".env"), "SECRET=fixture\n", { mode: 0o600 });
  await writeFile(join(f.source, "local", "nested", "settings.json"), "{}");
  await writeFile(join(f.source, "local", "run"), "#!/bin/sh\n");
  await chmod(join(f.source, "local", "run"), 0o755);
  await writeFile(join(f.source, "unselected"), "do not copy");
  await makeStrategy({ copyPaths: [".env", "local", "missing", "absent/nested"] }).create(f, {
    signal: signal(),
  });
  assert.equal(await readFile(join(f.directory, ".env"), "utf8"), "SECRET=fixture\n");
  assert.equal(await readFile(join(f.directory, "local", "nested", "settings.json"), "utf8"), "{}");
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(f.directory, ".env"))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(f.directory, "local", "run"))).mode & 0o777, 0o755);
  }
  assert.equal(await exists(join(f.directory, "unselected")), false);
  assert.equal(await exists(join(f.directory, "missing")), false);
});

test("merges directories without overwriting files from the selected starting ref", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, "config"));
  await writeFile(join(f.source, "config", "tracked"), "committed");
  await snapshot(f.source, f.initial);
  await writeFile(join(f.source, "config", "tracked"), "dirty source");
  await writeFile(join(f.source, "config", "extra"), "local file");
  await makeStrategy({ copyPaths: ["config", "config/extra"] }).create(f, { signal: signal() });
  assert.equal(await readFile(join(f.directory, "config", "tracked"), "utf8"), "committed");
  assert.equal(await readFile(join(f.directory, "config", "extra"), "utf8"), "local file");
});

test("copies internal relative symlinks, but never nested .git metadata", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, "local", ".git"), { recursive: true });
  await writeFile(join(f.source, "local", ".git", "config"), "not copied");
  await writeFile(join(f.source, "local", "file"), "data");
  await symlink("file", join(f.source, "local", "link"));
  await makeStrategy({ copyPaths: ["local"] }).create(f, { signal: signal() });
  assert.equal(await readlink(join(f.directory, "local", "link")), "file");
  assert.equal(await readFile(join(f.directory, "local", "link"), "utf8"), "data");
  assert.equal(await exists(join(f.directory, "local", ".git")), false);
});

test("failed copy rolls back only its worktree and branch", async (t) => {
  const f = await fixture(t);
  const external = join(f.root, "outside");
  await writeFile(external, "untouched");
  await symlink("../outside", join(f.source, ".env"));
  const branches = await git(f.source, ["branch", "--list"]);
  await assert.rejects(
    makeStrategy({ copyPaths: [".env"] }).create(f, { signal: signal() }),
    /symlink/,
  );
  assert.equal(await exists(f.directory), false);
  assert.equal(await git(f.source, ["branch", "--list"]), branches);
  assert.equal((await nativeStrategy().list(f.source, { signal: signal() })).length, 1);
  assert.equal(await readFile(external, "utf8"), "untouched");
});

test("does not traverse source symlink ancestors or destination symlink directories", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "outside"));
  await writeFile(join(f.root, "outside", "file"), "outside");
  await symlink("../outside", join(f.source, "local"));
  await assert.rejects(
    makeStrategy({ copyPaths: ["local/file"] }).create(f, { signal: signal() }),
    /symlink/,
  );
  assert.equal(await exists(f.directory), false);
  // A committed destination symlink must not receive files from a source directory.
  await symlink("../outside", join(f.source, "config"));
  await snapshot(f.source, f.initial);
  await rename(join(f.source, "config"), join(f.source, "saved-link"));
  await mkdir(join(f.source, "config"));
  await writeFile(join(f.source, "config", "file"), "do not write through link");
  await assert.rejects(
    makeStrategy({ copyPaths: ["config"] }).create(f, { signal: signal() }),
    /symlink/,
  );
  assert.equal(await readFile(join(f.root, "outside", "file"), "utf8"), "outside");
});

test("discovery persists across plugin reloads and branch renames without claiming other worktrees", async (t) => {
  const f = await fixture(t);
  await makeStrategy().create(f, { signal: signal() });
  const unrelated = join(f.root, "unrelated");
  await git(f.source, ["worktree", "add", "--detach", "--", unrelated]);
  await git(f.directory, ["branch", "-m", "renamed"]);
  const discovered = await makeStrategy({ branchPrefix: "new/" }).list(f.source, {
    signal: signal(),
  });
  assert.deepEqual(discovered, [
    { directory: f.source, type: "root" },
    { directory: f.directory, type: "worktree" },
  ]);
});

test("removal requires force for dirty worktrees and retains the branch", async (t) => {
  const f = await fixture(t);
  const strategy = makeStrategy();
  await strategy.create(f, { signal: signal() });
  const branch = (await git(f.directory, ["branch", "--show-current"])).trim();
  await writeFile(join(f.directory, "untracked"), "keep until confirmed");
  await assert.rejects(
    strategy.remove({ directory: f.directory, force: false }, { signal: signal() }),
    (error: unknown) => {
      assert.ok(error instanceof Worktree.OperationError);
      assert.equal(error.forceRequired, true);
      return true;
    },
  );
  assert.equal(await exists(f.directory), true);
  await strategy.remove({ directory: f.directory, force: true }, { signal: signal() });
  assert.equal(await exists(f.directory), false);
  assert.equal((await git(f.source, ["rev-parse", `refs/heads/${branch}`])).trim(), f.initial);
});

test("removes a clean worktree without force", async (t) => {
  const f = await fixture(t);
  const strategy = makeStrategy();
  await strategy.create(f, { signal: signal() });
  await strategy.remove({ directory: f.directory, force: false }, { signal: signal() });
  assert.equal(await exists(f.directory), false);
});

test("ignored files require force, including edits to copied files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, ".env"), "fixture");
  const strategy = makeStrategy({ copyPaths: [".env"] });
  await strategy.create(f, { signal: signal() });
  for (const contents of ["fixture", "edited after creation"]) {
    await writeFile(join(f.directory, ".env"), contents);
    assert.equal(await git(f.directory, ["status", "--porcelain"]), "");
    await assert.rejects(
      strategy.remove({ directory: f.directory, force: false }, { signal: signal() }),
      (error: unknown) => {
        assert.ok(error instanceof Worktree.OperationError);
        assert.equal(error.forceRequired, true);
        return true;
      },
    );
    assert.equal(await readFile(join(f.directory, ".env"), "utf8"), contents);
  }
  await strategy.remove({ directory: f.directory, force: true }, { signal: signal() });
  assert.equal(await exists(f.directory), false);
});

test("refuses to remove the root, unrelated worktrees, and nested directories", async (t) => {
  const f = await fixture(t);
  const unrelated = join(f.root, "unrelated");
  await git(f.source, ["worktree", "add", "--detach", "--", unrelated]);
  const strategy = makeStrategy();
  await strategy.create(f, { signal: signal() });
  await mkdir(join(f.directory, "nested"));
  for (const directory of [f.source, unrelated, join(f.directory, "nested")]) {
    await assert.rejects(
      strategy.remove({ directory, force: true }, { signal: signal() }),
      /not owned/,
    );
    assert.equal(await exists(directory), true);
  }
});

test("rejects invalid refs, invalid prefixes, existing destinations, and recursive copies", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    makeStrategy().create({ ...f, branch: "missing-ref" }, { signal: signal() }),
  );
  await assert.rejects(
    makeStrategy({ branchPrefix: "bad..prefix/" }).create(f, { signal: signal() }),
  );
  await assert.rejects(
    makeStrategy().create({ ...f, directory: f.source }, { signal: signal() }),
    /already exists/,
  );
  await assert.rejects(
    makeStrategy({ copyPaths: ["local"] }).create(
      { ...f, directory: join(f.source, "local", "nested") },
      { signal: signal() },
    ),
    /contains the worktree/,
  );
  assert.equal((await nativeStrategy().list(f.source, { signal: signal() })).length, 1);
  assert.equal((await git(f.source, ["branch", "--list"])).trim(), "* main");
});

test("honors a worktree destination nested inside the source checkout", async (t) => {
  const f = await fixture(t);
  const directory = join(f.source, ".worktrees", "nested");
  await makeStrategy().create({ ...f, directory }, { signal: signal() });
  assert.match((await git(directory, ["branch", "--show-current"])).trim(), /^opencode\/nested-/);
});

test("honors pre-aborted operations without changing the repository", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("cancelled fixture"));
  const strategy = makeStrategy();
  await assert.rejects(strategy.create(f, { signal: controller.signal }), /cancelled fixture/);
  await assert.rejects(strategy.list(f.source, { signal: controller.signal }), /cancelled fixture/);
  await assert.rejects(
    strategy.remove({ directory: f.source, force: true }, { signal: controller.signal }),
    /cancelled fixture/,
  );
  assert.equal(await exists(f.directory), false);
});
