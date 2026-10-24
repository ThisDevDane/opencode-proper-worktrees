import { spawn } from "node:child_process";

export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(`git ${args[0]} failed: ${stderr.trim() || `exit ${exitCode}`}`);
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Argument arrays keep paths, refs, and prefixes out of the shell.
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        failure ??= new Error("Git output exceeded 16 MiB.");
        stop();
      } else {
        chunks.push(chunk);
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      failure = error;
    });
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) {
      stop();
    }
    // Wait for close even on cancellation so rollback cannot race the Git process.
    child.once("close", (code) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) {
        reject(signal.reason);
      } else if (failure) {
        reject(failure);
      } else if (code !== 0) {
        reject(new GitError(args, code, Buffer.concat(stderr).toString("utf8")));
      } else {
        resolve(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}
