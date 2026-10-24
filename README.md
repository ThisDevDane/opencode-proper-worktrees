# opencode-proper-worktrees

An OpenCode V2 plugin that creates Git worktrees on new branches instead of detached HEADs. Set a branch prefix and choose local files or folders to copy into each worktree, including Git-ignored files such as `.env`.

## Requirements

- OpenCode V2 with a compatible Effect 4.0.1 runtime, tested against OpenCode 2.1.4. Other releases need compatibility testing because this plugin imports Core internals.
- Git on the OpenCode server's PATH.
- A repository with at least one commit.
- Node 24.12 or later in the Node 24 series for development.

## Install the plugin

Add the plugin to your global or project `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "git+ssh://git@github.com/ThisDevDane/opencode-proper-worktrees.git#main",
      "options": {
        "branchPrefix": "dane/",
        "copyPaths": [".env", ".env.local", "local/settings"],
      },
    },
  ],
}
```

The SSH URL uses your existing Git credentials. For a local checkout, replace `package` with an absolute directory path such as `/workspaces/opencode-proper-worktrees`.

OpenCode reloads configuration changes automatically. Use `/reload` to force a reload.

You can also install the Git package with the CLI, then add `options` to its configuration entry:

```sh
opencode plugin add 'git+ssh://git@github.com/ThisDevDane/opencode-proper-worktrees.git#main'
opencode plugin update 'git+ssh://git@github.com/ThisDevDane/opencode-proper-worktrees.git#main'
```

## Configuration

| Option         | Default       | Behavior                                                                                                                                                         |
| -------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branchPrefix` | `"opencode/"` | Prepended verbatim to each generated branch name. Include `/` or `-` if wanted. An empty string disables the prefix. The result must be a valid Git branch name. |
| `copyPaths`    | `[]`          | Literal checkout-relative file or directory paths. Directories copy recursively, including ignored and untracked contents. No glob or `~` expansion.             |

For a worktree named `task`, the default branch looks like `opencode/task-<random-suffix>`. The random suffix avoids branch collisions when names repeat. OpenCode still controls worktree naming and placement.

Set the destination separately with OpenCode's standard `worktree.directory` setting:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "worktree": { "directory": "../worktrees" },
}
```

Relative destinations resolve against the canonical checkout, not the plugin directory. Without this setting, OpenCode uses its normal server data directory.

### Branches and source checkouts

New branches start at the selected source checkout's `HEAD`, or at the starting ref supplied to OpenCode's create operation. That starting ref does not become the new branch name. The source checkout stays on its original branch.

The plugin applies to new worktrees created through OpenCode. It does not convert existing detached worktrees. If several plugins register worktree strategies, OpenCode selects the last active registration.

### Native strategy wrapper

The plugin imports `WorktreeGit` from `@opencode/core/worktree/git`. Core creates the detached worktree first. The plugin then attaches a generated branch and copies configured paths before returning Core's result to OpenCode. Startup therefore waits for both steps.

Core also performs worktree discovery and removal. The plugin only adds ownership filtering and the removal safety check described below. It does not implement `git worktree add`, `list`, or `remove` itself.

All internal imports, service setup, cancellation, and native error conversion live in `native-strategy.ts`. The Core and utility packages are pinned to 2.1.4. This reuses that version's implementation, not the running host's selected strategy. Updating OpenCode does not automatically update the pinned implementation. This approach adds Core's dependency tree and relies on internal APIs that can change between releases.

### Copy behavior

- Paths resolve from the selected source checkout's root. OpenCode loads plugin options from the canonical checkout, even when creating from another checkout.
- Missing paths are skipped, so shared configurations can list optional files.
- Directories merge, but existing destination files are never overwritten. Modified tracked files therefore keep the version from the starting ref.
- Files copy independently of Git's ignore rules. The plugin does not stage them or change ignore rules. Non-ignored copies appear as untracked files.
- Absolute paths, parent traversal, the entire checkout, and `.git` paths are rejected. Nested `.git` entries are skipped. A copy path cannot contain the worktree destination.
- Relative symlinks can copy when their targets resolve inside the source checkout. Absolute, broken, or escaping symlinks fail creation. Include a link's target in `copyPaths` if the starting ref does not contain it. Copying never traverses a source or destination symlink directory.

Only list files you want duplicated. Copying `.env` also duplicates its secrets onto the server filesystem. This is a one-time copy during creation, not synchronization.

### Discovery and removal

The plugin records ownership in each linked worktree's Git administration directory, outside its working files. Refresh discovers owned worktrees after reloads, even if their branches have been renamed. It does not claim unrelated worktrees.

Removal keeps the branch and its commits. Uncommitted, untracked, or ignored files require force confirmation. This includes unchanged files copied by the plugin. Unlike Git's normal clean-worktree check, ignored files such as `.env` are not silently discarded.

If branch attachment or copying fails after native creation succeeds, the plugin asks Core to remove the new worktree and deletes its unchanged generated branch. Failures inside native creation follow Core's behavior. A rollback failure reports the destination for manual inspection. Keep this plugin loaded while removing worktrees it owns. OpenCode will not silently use another strategy when the recorded owner is unavailable.

## Development

The project follows `opencode-rider-hooks` and `opencode-podman-sandbox`: a root TypeScript entrypoint, pnpm lockfile, native Node tests, and no build step. Lint, formatting, hk, and CI follow the sandbox plugin's setup. Effect is a peer dependency because OpenCode supplies its runtime instance. Development pins Effect 4.0.1 to match Core 2.1.4. Unused watcher and parser build scripts from Core's dependency tree are explicitly disabled in `pnpm-workspace.yaml`.

```sh
mise trust
mise install
pnpm install --frozen-lockfile
pnpm check
```

Optional local hooks:

```sh
hk install
```

Tests use the imported native strategy with temporary Git repositories and do not call a live OpenCode server. They cover delegation, attached branches, starting refs, ignored-file copying, symlink checks, rollback, discovery, forced removal, and native error conversion. Set `OPENCODE_TEST_TMPDIR` to choose the temporary parent directory.
