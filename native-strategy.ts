import { Git } from "@opencode/core/git";
import { WorktreeGit } from "@opencode/core/worktree/git";
import { Worktree } from "@opencode/plugin";
import type { WorktreeDefinition } from "@opencode/plugin/promise/worktree";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { FSUtil } from "@opencode/util/fs-util";
import { Cause, Effect, Exit } from "effect";

// Keep all Core internals here. These imports and service wiring target Core 2.1.4,
// not a supported plugin contract or the host's currently selected strategy.
const services = LayerNode.compile(LayerNode.group([Git.node, FSUtil.node]));
const absolutePath = Worktree.Info.fields.directory.make;
type Native = Effect.Success<typeof WorktreeGit.make>;

async function run<A, E>(
  operation: (native: Native) => Effect.Effect<A, E>,
  signal: AbortSignal,
): Promise<A> {
  signal.throwIfAborted();
  // Acquire and release the native services with each operation. No global runtime
  // survives plugin unload, and cancellation waits for Effect's finalizers.
  const exit = await Effect.runPromiseExit(
    WorktreeGit.make.pipe(Effect.flatMap(operation), Effect.provide(services)),
    { signal },
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  signal.throwIfAborted();
  const error = Cause.squash(exit.cause);
  if (error instanceof Git.WorktreeError) {
    throw new Worktree.OperationError({
      message: error.message,
      forceRequired: error.forceRequired,
    });
  }
  throw error;
}

export function nativeStrategy(): WorktreeDefinition {
  return {
    id: "git",
    create: (input, { signal }) =>
      run(
        (native) =>
          native.create({
            ...input,
            sourceDirectory: absolutePath(input.sourceDirectory),
            directory: absolutePath(input.directory),
          }),
        signal,
      ),
    remove: (input, { signal }) =>
      run(
        (native) =>
          native.remove({
            ...input,
            directory: absolutePath(input.directory),
          }),
        signal,
      ),
    list: (source, { signal }) => run((native) => native.list(absolutePath(source)), signal),
  };
}
