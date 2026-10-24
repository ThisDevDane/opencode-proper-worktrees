import { readFile } from "node:fs/promises";
import { isAbsolute, posix, resolve, win32 } from "node:path";

import { parse, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

import { hasCode } from "./copy.ts";

export interface Options {
  branchPrefix: string;
  copyPaths: string[];
}

export function relativeCopyPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    value.includes(":") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error("copyPaths must contain relative paths without '..', backslashes, or .git.");
  }
  const path = posix.normalize(value).replace(/\/$/, "");
  if (path === ".") {
    throw new Error("copyPaths cannot include the whole checkout. List files or folders instead.");
  }
  return path;
}

function readCopyPaths(value: unknown): string[] {
  const paths = value === undefined ? [] : value;
  if (!Array.isArray(paths)) {
    throw new Error("copyPaths must be an array of relative file or folder paths.");
  }
  return [...new Set(paths.map(relativeCopyPath))];
}

export function readOptions(options: Record<string, unknown>): Options {
  for (const key of Object.keys(options)) {
    if (key !== "branchPrefix" && key !== "copyPaths") {
      throw new Error(`Unknown opencode-proper-worktrees option: ${key}`);
    }
  }
  const branchPrefix = options.branchPrefix === undefined ? "opencode/" : options.branchPrefix;
  if (typeof branchPrefix !== "string" || /[\s\0]/.test(branchPrefix)) {
    throw new Error("branchPrefix must be a string without whitespace or null bytes.");
  }
  return { branchPrefix, copyPaths: readCopyPaths(options.copyPaths) };
}

export async function readProjectCopyPaths(
  sourceRoot: string,
  defaults: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  const path = resolve(sourceRoot, ".opencode", "worktree.jsonc");
  let text: string;
  try {
    text = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return [...defaults];
    }
    throw error;
  }

  try {
    const errors: ParseError[] = [];
    const config: unknown = parse(text, errors, { allowTrailingComma: true });
    const error = errors[0];
    if (error) {
      throw new Error(`${printParseErrorCode(error.error)} at offset ${error.offset}.`);
    }
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error("Project configuration must be an object.");
    }
    for (const key of Object.keys(config)) {
      if (key !== "copyPaths" && key !== "inheritCopyPaths") {
        throw new Error(`Unknown project option: ${key}`);
      }
    }
    const inherit = "inheritCopyPaths" in config ? config.inheritCopyPaths : true;
    if (typeof inherit !== "boolean") {
      throw new Error("inheritCopyPaths must be a boolean.");
    }
    const paths = readCopyPaths("copyPaths" in config ? config.copyPaths : undefined);
    return [...new Set([...(inherit ? defaults : []), ...paths])];
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}
