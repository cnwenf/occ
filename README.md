# Open C Code (OCC)

> A safe, open-source coding agent — capabilities aligned with Claude Code.

[![npm version](https://img.shields.io/npm/v/@cnwenf/occ.svg)](https://www.npmjs.com/package/@cnwenf/occ)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-%23000000.svg)](https://bun.sh/)
[![Tracks: Claude Code 2.1.210](https://img.shields.io/badge/Tracks-Claude%20Code%202.1.210-blueviolet.svg)](https://docs.anthropic.com/en/docs/claude-code)

[简体中文](./README.zh-CN.md) · **English**

---

## What is OCC

**Open C Code (OCC)** is an open-source coding agent. Its capabilities are aligned with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (currently tracking `2.1.210`). The code is fully open, auditable, backdoor-free, and your data stays under your control.

> Note: catch-up to Claude Code `2.1.211` is in progress — see `docs/upstream-version-gap.md`.

If you worry that a closed-source CLI might hide backdoors, or that your code and credentials are uploaded to unauditable services, OCC is for you: all source is open and unobfuscated, the build is reproducible from source, and API credentials are sent only to endpoints you configure.

## Positioning

- 🔓 **Open & auditable** — full source, no obfuscation, line-by-line reviewable.
- 🛡️ **Transparent & safe** — no telemetry black boxes, no hidden reporting; behavior you can supervise.
- 🎯 **Capability-aligned** — REPL, tool system, permission model, MCP, sub-agents, slash commands — on par with Claude Code.
- 🔧 **Data sovereignty** — API Key / Bedrock / Vertex / Azure credentials stay on your machine; requests go only to endpoints you specify.
- 🧩 **Hackable** — trim, extend, or fork subsystems; feature flags and a workspace stub layer make the boundary between live and trimmed code explicit.

## Quick install

```bash
npm i -g @cnwenf/occ   # install
occ                    # launch the interactive REPL
```

Requires a valid Anthropic API Key (or AWS Bedrock / Google Vertex / Azure Foundry credentials).

## Feature highlights

- 🖥️ **Interactive REPL** — Ink terminal renderer with full UI: vim mode, themes, scroll, search highlight, virtual lists.
- 🔧 **Full tool suite** — Bash, Read, Edit, Write, NotebookEdit, Grep, Glob, Agent, WebFetch, WebSearch, WebBrowser (real Chrome via CDP), Todo, Skills, and more.
- 🤖 **Sub-agents** — spawn fork / async / background / remote agents; team swarms (`TeamCreate`/`TeamDelete`) and worktree isolation.
- 🔀 **Workflow engine** — vm-sandboxed multi-agent workflow scripts; `/workflows` browse + async launch (`remote: true`) + progress tracking. _(live via `WORKFLOW_SCRIPTS`)_
- 📊 **Monitor tool** — self-contained monitoring. _(live via `MONITOR_TOOL`)_
- 🌐 **WebBrowser** — navigate, read page text, screenshot, and batch actions through a real Chrome instance (CDP).
- 🛡️ **Permission model** — `default` / `acceptEdits` / `plan` / `bypassPermissions` modes, auto-approval, destructive-command blocking, path validation, rule matching.
- 🪝 **Hooks** — `PreToolUse`, `PostToolUse`, `PermissionDenied`, `Stop`, and more, configurable via `settings.json`.
- 🧩 **MCP support** — connect external tools via Model Context Protocol servers (`--mcp-config`, `.mcp.json`); list/read MCP resources.
- 🎯 **Skills system** — frontmatter-driven skills, `/skills` discovery + cache, attribution, MCP-delivered skills. _(live via `EXPERIMENTAL_SKILL_SEARCH` + `MCP_SKILLS`)_
- 📝 **`/goal` tracking** — set a session goal with a Stop hook that keeps the agent on-target.
- ⚡ **`/effort ultracode`** — max-reasoning effort level with badge + keyword trigger; also `low`/`medium`/`high`/`max`/`auto`.
- 🎨 **Custom themes** — `/color` and `/theme` for live theming and custom theme creation.
- ⌨️ **Keybindings** — vim mode, `Ctrl+L` clear, `Ctrl+J` newline, scroll, configurable via `/keybindings`.
- 🌍 **Language setting** — instruct OCC to respond in your preferred language.
- 🔄 **Session management** — `/resume`, auto-compaction, `/doctor`, `/status`, `/cost`.
- 🧠 **Smart classifiers** — transcript + bash command classification. _(live via `TRANSCRIPT_CLASSIFIER` + `BASH_CLASSIFIER`)_

## OCC vs Claude Code

| | OCC | Claude Code |
|---|---|---|
| **Source** | Fully open, unobfuscated | Closed binary |
| **Auditability** | Line-by-line reviewable | No |
| **Telemetry** | Minimal (analytics stubbed) | Standard |
| **Data sovereignty** | Credentials stay on your machine; requests only to endpoints you configure | Anthropic endpoints |
| **Capability parity** | Tracks CC `2.1.210` | Reference implementation |
| **Providers** | Anthropic Direct, Bedrock, Vertex, Azure | Anthropic, Bedrock, Vertex |
| **Cost** | Free & open-source (MIT) | Subscription |
| **Build** | Reproducible from source | N/A |

## Quick start

```bash
# interactive REPL
occ

# pipe mode (-p) — non-interactive
echo "say hello" | occ -p

# run from source (dev)
bun run dev
```

## Slash commands

OCC ships dozens of slash commands. Highlights:

| Category | Commands |
|---|---|
| **Session** | `/clear` `/compact` `/autocompact` `/resume` `/status` `/cost` `/doctor` `/export` `/context` |
| **Model & effort** | `/model` `/effort` `/fast` `/usage` |
| **Configuration** | `/config` `/permissions` `/keybindings` `/color` `/theme` `/memory` `/init` `/login` `/logout` |
| **Agents & tasks** | `/agents` `/background` `/daemon` `/stop` `/tasks` `/goal` `/skills` `/hooks` `/plugin` |
| **MCP** | `/mcp` |
| **Review & git** | `/review` `/commit` `/commit-push-pr` `/diff` `/branch` `/pr_comments` |
| **Help** | `/help` `/update` `/onboarding` |

## Tools

**Always available:** `Bash`, `FileRead`, `FileEdit`, `FileWrite`, `NotebookEdit`, `Grep`, `Glob`, `Agent`, `TaskOutput`, `TaskStop`, `WebFetch`, `WebSearch`, `WebBrowser` (Navigate / GetPageText / Screenshot / Batch), `TodoWrite`, `AskUserQuestion`, `Skill`, `EnterPlanMode`, `ExitPlanMode`, `Cron` (Create / Delete / List), `Brief`, `ListMcpResources`, `ReadMcpResource`, `ReadMcpResourceDir`.

**Live (feature-allowlisted):** `Workflow` (`WORKFLOW_SCRIPTS`), `Monitor` (`MONITOR_TOOL`).

**Conditional:** `TaskCreate`/`Get`/`Update`/`List` (Todo v2), `EnterWorktree`/`ExitWorktree` (worktree mode), `ToolSearch` (deferred tool loading), `PowerShell` (Windows), `LSP` (`ENABLE_LSP_TOOL`).

**Disabled / stubbed:** subsystems behind non-allowlisted feature flags — `Sleep`, `RemoteTrigger`, `SendUserFile`, `PushNotification`, `SubscribePR`, `ListPeers`, `Snip`, coordinator/bridge/voice modes, and ANT-only stubs (`Tungsten`, `REPL`, `SuggestBackgroundPR`). Computer Use (`@ant/*`) and most `*-napi` packages are stubs (`color-diff-napi` is fully implemented). Analytics / GrowthBook / Sentry are empty implementations.

## Configuration

OCC reads settings from (later files override earlier):

- `~/.claude/settings.json` — user-global
- `.claude/settings.json` — project-shared (checked in)
- `.claude/settings.local.json` — project-local (gitignored)

Configure permissions, hooks, model, theme, MCP servers, and keybindings there. Provider credentials live in env vars (`ANTHROPIC_API_KEY`, `AWS_*`, `CLAUDE_CODE_USE_VERTEX`, etc.) — never in source.

For the full settings reference, environment variables, and permission modes, see [CLAUDE.md](./CLAUDE.md).

## Architecture overview

```
src/entrypoints/cli.tsx   true entrypoint (runtime polyfills, macros)
src/main.tsx              Commander.js CLI definition
src/query.ts              main API query loop (streaming + tool-call loop)
src/QueryEngine.ts        conversation orchestrator (state, compaction, attribution)
src/screens/REPL.tsx      interactive REPL screen (React/Ink)
src/services/api/         API clients (Anthropic / Bedrock / Vertex / Azure)
src/tools/<Name>/         one directory per tool
src/ink/                  custom Ink framework (reconciler, hooks, virtual list)
src/commands/<Name>/      one directory per slash command
packages/                 workspace stubs (@ant/*, *-napi)
```

**Runtime & build:** Bun (not Node). ESM + TSX with `react-jsx`. Single-file bundle via `bun build`. Bun workspaces resolve internal `packages/*`.

**Core loop:** `query.ts` sends messages to the Claude API, handles streaming, processes tool calls, and manages the conversation turn loop. `QueryEngine.ts` wraps it with state, compaction, and file-history snapshots.

**Feature flags:** `feature(name)` returns `true` for an allowlist — `WORKFLOW_SCRIPTS`, `MONITOR_TOOL`, `TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`, `EXPERIMENTAL_SKILL_SEARCH`, `MCP_SKILLS` — and `false` for everything else. This reactivates the workflow engine, Monitor tool, skill discovery, MCP skills, and the transcript/bash classifiers at runtime; most other internal subsystems (COORDINATOR_MODE, KAIROS, PROACTIVE, BRIDGE_MODE, VOICE_MODE, etc.) stay disabled.

## Build from source

Requires [Bun](https://bun.sh/) >= 1.3.11 (use `bun upgrade` — older Bun causes spurious errors).

```bash
bun install
bun run dev          # run from source; version prints 2.1.210 when working
bun run build        # output: dist/cli.js (~26 MB, single-file bundle)
bun test             # test suite (Bun test runner)
bun run lint         # Biome lint (formatter disabled to avoid large diffs)
bun run check:unused # knip — detect unused exports/dependencies
bun run health       # code health check
```

> **Note on type errors:** the codebase carries ~1300 non-blocking `tsc` type errors (loose `unknown`/`never`/`{}` types throughout). They do **not** affect Bun runtime execution. Lint (Biome) is the gate, not `tsc`.

For architecture, entry/bootstrap, tool system, UI layer, and module-status details, see [CLAUDE.md](./CLAUDE.md).

## Status

- Tracks Claude Code **`2.1.210`**.
- Published to npm as [`@cnwenf/occ`](https://www.npmjs.com/package/@cnwenf/occ).
- Many modules are intentionally stubbed or feature-flagged off — see "Disabled / stubbed" above.

## Docs

- [CLAUDE.md](./CLAUDE.md) — engineering guide: commands, architecture, working with the codebase.
- [docs/](./docs/) — architecture whitepaper (Mintlify `.mdx`): [introduction](./docs/introduction/what-is-claude-code.mdx), [the loop](./docs/conversation/the-loop.mdx), [tools](./docs/tools/what-are-tools.mdx), [permission model](./docs/safety/permission-model.mdx), [hooks](./docs/extensibility/hooks.mdx), [skills](./docs/extensibility/skills.mdx), [MCP](./docs/extensibility/mcp-protocol.mdx), [sub-agents](./docs/agent/sub-agents.mdx).

## Contributing

Contributions are welcome. Please:

1. Open an issue to discuss the change first for non-trivial work.
2. Keep code under 800 lines/file, functions under 50 lines, no deep nesting.
3. Run `bun run lint` and `bun test` before submitting — Biome lint is the gate.
4. Follow [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
5. Don't try to fix all `tsc` type errors — they don't affect the Bun runtime and `tsc` is not in CI.

A `pre-commit` hook (`.githooks/`, wired via `bun run prepare`) runs `biome lint` on staged `src/*.{ts,tsx,js,jsx}` files. Bypass with `--no-verify` when lint errors are from pre-existing noise.

## License

MIT License — see [LICENSE](./LICENSE).
