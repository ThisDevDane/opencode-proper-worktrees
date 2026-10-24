import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function copyPaths(
  source: string,
  destination: string,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const root = await realpath(source);
  const target = await realpath(destination);

  // Check every ancestor, not just realpath of the final file. Never write through a symlink.
  async function parents(base: string, path: string, create: boolean): Promise<boolean> {
    const parent = dirname(path);
    if (parent === base) {
      return true;
    }
    if (!inside(base, parent)) {
      throw new Error(`Copy path leaves its checkout: ${path}`);
    }
    if (!(await parents(base, parent, create))) {
      return false;
    }
    signal.throwIfAborted();
    if (create) {
      await mkdir(parent).catch((error: unknown) => {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
      });
    }
    try {
      const info = await lstat(parent);
      if (info.isSymbolicLink()) {
        throw new Error(`Copy path traverses a symlink: ${parent}`);
      }
      return info.isDirectory();
    } catch (error) {
      if (!create && hasCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  async function copy(path: string): Promise<void> {
    signal.throwIfAborted();
    const from = resolve(root, path);
    const to = resolve(target, path);
    if (!inside(root, from) || !inside(target, to)) {
      throw new Error("Copy path leaves its checkout.");
    }
    const info = await lstat(from);
    if (info.isDirectory()) {
      await mkdir(to).catch((error: unknown) => {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
      });
      const existing = await lstat(to);
      if (existing.isSymbolicLink()) {
        throw new Error(`Copy destination is a symlink: ${to}`);
      }
      if (!existing.isDirectory()) {
        return;
      }
      for (const name of await readdir(from)) {
        // Never transplant Git metadata, including that of nested repositories.
        if (name.toLowerCase() !== ".git") {
          await copy(`${path}/${name}`);
        }
      }
      return;
    }
    if (await exists(to)) {
      return;
    }
    if (info.isFile()) {
      await copyFile(from, to, constants.COPYFILE_EXCL);
    } else if (info.isSymbolicLink()) {
      const link = await readlink(from);
      if (
        isAbsolute(link) ||
        !inside(root, resolve(dirname(from), link)) ||
        !inside(target, resolve(dirname(to), link)) ||
        !inside(root, await realpath(from))
      ) {
        throw new Error(`Copy symlink must be relative and stay inside the checkout: ${path}`);
      }
      await symlink(link, to);
    } else {
      throw new Error(
        `Only regular files, directories, and internal symlinks can be copied: ${path}`,
      );
    }
  }

  for (const path of paths) {
    signal.throwIfAborted();
    const from = resolve(root, path);
    if (!(await parents(root, from, false)) || !(await exists(from))) {
      continue;
    }
    if (!(await parents(target, resolve(target, path), true))) {
      continue;
    }
    await copy(path);
  }
  signal.throwIfAborted();
}
