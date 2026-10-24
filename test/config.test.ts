import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { readOptions, readProjectCopyPaths, relativeCopyPath } from "../config.ts";
import { signal } from "./helpers.ts";

async function project(t: TestContext) {
  const root = await mkdtemp(
    join(process.env.OPENCODE_TEST_TMPDIR ?? tmpdir(), "proper-worktrees-config-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, ".opencode", "worktree.jsonc") };
}

test("defaults and literal relative copy paths", () => {
  assert.deepEqual(readOptions({}), { branchPrefix: "opencode/", copyPaths: [] });
  assert.deepEqual(
    readOptions({ branchPrefix: "", copyPaths: ["./local/", "local", "file with spaces"] }),
    {
      branchPrefix: "",
      copyPaths: ["local", "file with spaces"],
    },
  );
});

test("reject unsafe paths, malformed options, and misspelled keys", () => {
  for (const path of [
    "",
    ".",
    "./",
    "..",
    "../secret",
    "local/../secret",
    "/secret",
    "C:\\secret",
    "C:/secret",
    "C:secret",
    "local\\secret",
    ".git",
    "local/.GIT/config",
    "bad\0path",
    false,
  ]) {
    assert.throws(() => relativeCopyPath(path), /copyPaths/);
  }
  for (const options of [
    { branchPrefix: 1 },
    { branchPrefix: null },
    { branchPrefix: "bad prefix/" },
    { copyPaths: "local" },
    { copyPaths: null },
    { copyPaths: [1] },
    { copyPath: [".env"] },
    { inheritCopyPaths: false },
  ]) {
    assert.throws(() => readOptions(options));
  }
});

test("missing project configuration preserves plugin defaults", async (t) => {
  const { root } = await project(t);
  const defaults = [".env", "local"];
  assert.deepEqual(await readProjectCopyPaths(root, defaults, signal()), defaults);
  await mkdir(join(root, ".opencode"));
  assert.deepEqual(await readProjectCopyPaths(root, defaults, signal()), defaults);
});

test("project JSONC adds normalized, deduplicated paths to plugin defaults", async (t) => {
  const { root, path } = await project(t);
  await mkdir(join(root, ".opencode"));
  await writeFile(
    path,
    `{
      // Project-specific files, including optional local settings.
      "copyPaths": ["./.env", "local/", "local", "file with spaces",],
    }`,
  );
  const defaults = [".env", "global"];
  assert.deepEqual(await readProjectCopyPaths(root, defaults, signal()), [
    ".env",
    "global",
    "local",
    "file with spaces",
  ]);
  assert.deepEqual(defaults, [".env", "global"]);
  for (const config of [{}, { copyPaths: [] }, { inheritCopyPaths: true }]) {
    await writeFile(path, JSON.stringify(config));
    assert.deepEqual(await readProjectCopyPaths(root, defaults, signal()), defaults);
  }
});

test("projects can replace defaults or disable copying", async (t) => {
  const { root, path } = await project(t);
  await mkdir(join(root, ".opencode"));
  await writeFile(
    path,
    JSON.stringify({ copyPaths: ["./local/", "local"], inheritCopyPaths: false }),
  );
  assert.deepEqual(await readProjectCopyPaths(root, [".env"], signal()), ["local"]);
  for (const config of [{ copyPaths: [], inheritCopyPaths: false }, { inheritCopyPaths: false }]) {
    await writeFile(path, JSON.stringify(config));
    assert.deepEqual(await readProjectCopyPaths(root, [".env"], signal()), []);
  }
});

test("invalid project syntax and values fail with the configuration filename", async (t) => {
  const { root, path } = await project(t);
  await mkdir(join(root, ".opencode"));
  for (const text of [
    "",
    "// only a comment",
    "/* unterminated comment",
    '{"copyPaths":[".env"]',
    '{"copyPaths":[".env",invalid]}',
    '{"copyPaths":[".env"] "inheritCopyPaths":false}',
    "{} {}",
    ...[
      null,
      [],
      true,
      1,
      "local",
      { copyPaths: "local" },
      { copyPaths: null },
      { copyPaths: [1] },
      { copyPaths: ["../secret"] },
      { copyPaths: ["/secret"] },
      { copyPaths: ["local\\secret"] },
      { copyPaths: [".git/config"] },
      { copyPaths: ["."] },
      { copyPath: [".env"] },
      { branchPrefix: "project/" },
      { inheritCopyPaths: "false" },
      { inheritCopyPaths: null },
      { inheritCopyPaths: 0 },
    ].map((config) => JSON.stringify(config)),
  ]) {
    await writeFile(path, text);
    await assert.rejects(
      readProjectCopyPaths(root, [".env"], signal()),
      /Invalid .*worktree\.jsonc:/,
      text,
    );
  }
});

test("project configuration read errors and cancellation do not fall back to defaults", async (t) => {
  const { root, path } = await project(t);
  await mkdir(path, { recursive: true });
  await assert.rejects(readProjectCopyPaths(root, [".env"], signal()), { code: "EISDIR" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readProjectCopyPaths(root, [".env"], controller.signal), {
    name: "AbortError",
  });
});
