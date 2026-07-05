# Open C Code (OCC)

> A safe, open-source coding agent — capabilities fully aligned with Claude Code.

[简体中文](./README.zh-CN.md) · **English**

---

## What is this

**Open C Code (OCC)** is an open-source coding agent. Its capabilities are aligned with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (currently tracking `2.1.200`). The code is fully open, auditable, backdoor-free, and your data stays under your control.

If you worry that a closed-source CLI might hide backdoors, or that your code and credentials are uploaded to unauditable services, OCC is for you: all source is open and unobfuscated, the build is reproducible from source, and API credentials are sent only to endpoints you configure.

## Positioning

- 🔓 **Open & auditable** — full source, no obfuscation, line-by-line reviewable.
- 🛡️ **Transparent & safe** — no telemetry black boxes, no hidden reporting; behavior you can supervise.
- 🎯 **Capability-aligned** — REPL, tool system, permission model, MCP, sub-agents, slash commands — on par with Claude Code.
- 🔧 **Data sovereignty** — API Key / Bedrock / Vertex / Azure credentials stay on your machine; requests go only to endpoints you specify.

## Status

- Tracks Claude Code **`2.1.200`**.
- The codebase carries ~1300 non-blocking `tsc` type errors (loose `unknown`/`never`/`{}` types throughout). They do **not** affect Bun runtime execution. Lint (Biome) is the gate, not `tsc`.
- All internal feature flags (`feature(...)`) are polyfilled to `false` — internal-only features (COORDINATOR_MODE, KAIROS, PROACTIVE, etc.) are disabled.
- Published to npm as [`@cnwenf/occ`](https://www.npmjs.com/package/@cnwenf/occ).

## Install

```bash
npm i -g @cnwenf/occ
occ
```

Requires a valid Anthropic API Key (or Bedrock / Vertex / Azure Foundry credentials).

## Quick start

```bash
# interactive REPL
occ

# pipe mode (-p)
echo "say hello" | occ -p
```

## Capabilities

### Core systems
- **REPL** — Ink terminal renderer, full interactive UI.
- **API layer** — Anthropic Direct, AWS Bedrock, Google Vertex, Azure Foundry (API Key + OAuth / credential refresh).
- **Query loop** — streaming conversation, tool-call loop, auto-compaction, token tracking (`query.ts`).
- **Conversation engine** — state, attribution, file-history snapshots (`QueryEngine.ts`).
- **Context** — git status, CLAUDE.md hierarchy, memory files.
- **Permissions** — plan / auto / manual modes, YOLO classifier, path validation, rule matching.
- **Hooks** — pre/post tool use, configurable via `settings.json`.
- **Session resume** (`/resume`), **doctor** (`/doctor`), **auto-compaction**.

### Tools (always available)
Bash, FileRead, FileEdit, FileWrite, NotebookEdit, Agent (sub-agent spawn: fork / async / background / remote), WebFetch, WebSearch, AskUserQuestion, SendMessage, Skill, EnterPlanMode, ExitPlanMode, TodoWrite (v1), Brief, TaskOutput, TaskStop, ListMcpResources, ReadMcpResource, SyntheticOutput.

### Tools (conditional)
Glob, Grep (default on); TaskCreate/Get/Update/List (Todo v2), EnterWorktree/ExitWorktree, TeamCreate/Delete (agent swarms), ToolSearch, PowerShell (Windows), LSP (`ENABLE_LSP_TOOL`).

### Disabled / stubbed
- Feature-flagged off (all `feature()` return false): Sleep, Cron, RemoteTrigger, Monitor, WebBrowser, Workflow, PushNotification, etc.
- ANT-only stubs: Tungsten, REPL, SuggestBackgroundPR.
- Removed/simplified: Computer Use (`@ant/*`), most `*-napi` packages (audio/image/url/modifiers — `color-diff-napi` is fully implemented), Analytics / GrowthBook / Sentry (empty), Magic Docs / Voice Mode / LSP server, Plugins / Marketplace, MCP OAuth (simplified).

### Slash commands
Dozens implemented: `/add-dir`, `/agents`, `/branch`, `/clear`, `/compact`, `/config`, `/context`, `/cost`, `/doctor`, `/effort`, `/export`, `/fast`, `/goal`, `/help`, `/init`, `/login`, `/mcp`, `/memory`, `/model`, `/permissions`, `/resume`, `/review`, `/status`, `/todo`, and more.

### MCP
Connect external tools via Model Context Protocol servers (`--mcp-config`, `.mcp.json`). OAuth flow simplified.

## Build from source

Requires [Bun](https://bun.sh/) >= 1.3.11.

```bash
bun install
bun run dev          # run from source; version prints 2.1.200 when working
bun run build        # output: dist/cli.js (~26 MB, 5300+ modules, single-file bundle)
bun test             # test suite
bun run lint         # Biome lint (formatter disabled to avoid large diffs)
```

For architecture, entry/bootstrap, tool system, UI layer, and module-status details, see [CLAUDE.md](./CLAUDE.md).

## Project layout

```
src/entrypoints/cli.tsx   # true entrypoint (runtime polyfills, macros)
src/main.tsx              # Commander CLI definition
src/query.ts              # main API query loop
src/QueryEngine.ts        # conversation orchestrator
src/screens/REPL.tsx      # interactive REPL screen
src/services/api/         # API clients (Anthropic / Bedrock / Vertex / Azure)
src/tools/<Name>/         # one directory per tool
src/ink/                  # custom Ink framework
packages/                 # workspace stubs (@ant/*, *-napi)
```

## License

MIT License — see [LICENSE](./LICENSE).
