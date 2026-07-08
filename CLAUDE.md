# Fan Control Workshop

This repo is a hands-on exercise. Your job is to build an MCP server (and, later,
to optimize a fan controller) for a thermal simulator.

## Where to work

- `src/mcp-server.ts` — the MCP server. This is the main thing you build.
- `src/controller.ts` — the fan controller you'll optimize later.
- `src/engine-api.ts` — the engine's **public contract**: the operations you can
  drive (`reset`, `readController`, `deployController`, `runScenario`,
  `runCustomScenario`, `getLastRun`) and the shapes of the data they return
  (`SimState`, `RunResult`, `TraceSegment`, `TraceName`). Build against this.

## What's off-limits, and why

`src/internal/` holds the simulator, scoring, workload traces, and engine
implementation. It is **intentionally unreadable** (blocked by a `permissions.deny`
rule) — the point of the exercise is to discover how the device behaves
*empirically*, through the tools you build and the runs you execute, not by
reading the physics. Don't try to route around the block (e.g. via a script that
opens those files); doing so defeats the exercise. Everything you need to build
the MCP server is in `src/engine-api.ts`.

## Do not look at other git branches

Work only on the branch you are on. Other branches (e.g. `mcp`, `solution`)
contain reference implementations and the exercise's answers. Do not read them
by any means — this includes `git checkout`/`git switch` to another branch,
`git show <branch>:<file>`, `git diff <branch>`, `git log`/`git log -p` across
branches, `git worktree`, `git cat-file`, `git stash` contents, or any other way
of inspecting content that isn't on your current working branch. Looking at that
content defeats the exercise.
