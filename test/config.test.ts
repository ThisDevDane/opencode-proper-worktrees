import assert from "node:assert/strict";
import test from "node:test";

import { readOptions, relativeCopyPath } from "../config.ts";

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
  ]) {
    assert.throws(() => readOptions(options));
  }
});
