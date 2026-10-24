import { Plugin } from "@opencode/plugin";

import { makeStrategy } from "./worktrees.ts";

export default Plugin.define({
  id: "opencode-proper-worktrees",
  async setup(ctx) {
    const strategy = makeStrategy(ctx.options);
    await ctx.worktree.transform((editor) => editor.add(strategy));
  },
});
