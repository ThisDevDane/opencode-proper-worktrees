import { isAbsolute, posix, win32 } from "node:path";

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
  const paths = options.copyPaths === undefined ? [] : options.copyPaths;
  if (!Array.isArray(paths)) {
    throw new Error("copyPaths must be an array of relative file or folder paths.");
  }
  return { branchPrefix, copyPaths: [...new Set(paths.map(relativeCopyPath))] };
}
