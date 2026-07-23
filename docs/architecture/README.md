# OCC Architecture

> Architecture reference for **Open C Code (OCC)** — an open-source coding agent
> whose capabilities track Claude Code `2.1.204`. This document set describes
> OCC's actual implementation: real file paths, function names, and data flow.

OCC is a Bun-runtime TypeScript application that renders an interactive REPL in
the terminal via a custom Ink fork, drives an agentic loop against the Claude
API, executes a suite of file/system/web tools under a layered permission
model, and integrates MCP servers, sub-agents, workflows, and a daemon
supervisor. The codebase is fully open and un-obfuscated; ~1341 `tsc` type
errors (mostly `unknown`/`never`/`{}`) are tolerated and do **not** block Bun
execution — Biome lint is the gate, not `tsc`.

## How OCC differs from Claude Code

| Concern | Claude Code | OCC |
|---|---|---|
| Source | Closed binary | Fully open, un-obfuscated, reproducible build |
| Runtime | Node / bundled binary | Bun (single-file bundle, `target: bun`) |
| Feature flags | Build-time via `bun:bundle`, gated at runtime by Statsig | Runtime `FEATURE_ALLOWLIST` set in `src/utils/featureFlags.ts` |
| Telemetry | Standard | Analytics/GrowthBook/Sentry stubbed to empty implementations |
| Providers | Anthropic, Bedrock, Vertex | Anthropic, Bedrock, Vertex, **Azure Foundry** |
| Trimmed subsystems | N/A | Computer Use, Magic Docs, Voice, LSP server, Plugins/Marketplace, MCP OAuth — stubbed or removed |

## Document index

| Document | Topic |
|---|---|
| [overview.md](./overview.md) | 5-layer architecture, data flow, project layout |
| [the-loop.md](./the-loop.md) | Agentic loop: `query.ts` + `QueryEngine`, turn cycle, tool execution |
| [streaming.md](./streaming.md) | Streaming response pipeline, token-by-token, thinking blocks |
| [context-assembly.md](./context-assembly.md) | System prompt, CLAUDE.md, memory, env info, lean prompt |
| [token-management.md](./token-management.md) | Context window, compaction, token budget |
| [tools.md](./tools.md) | Tool interface, registration, permission checks, sandboxing |
| [permissions.md](./permissions.md) | Permission modes, rules, auto-mode classifier, destructive blocks |
| [mcp.md](./mcp.md) | MCP client, server, transports, config scopes |
| [hooks.md](./hooks.md) | Hook events, execution, JSON output, PreToolUse/PostToolUse |
| [skills.md](./skills.md) | Skills frontmatter, discovery, attribution, shadowing |
| [sub-agents.md](./sub-agents.md) | Agent tool, subagent context, worktree isolation, background |
| [workflows.md](./workflows.md) | Workflow engine, VM sandbox, primitives, journal, async launch |
| [daemon.md](./daemon.md) | Daemon supervisor, workers, lockfile, FleetView, remote control |
| [keybindings.md](./keybindings.md) | Keybinding contexts, default bindings, vim mode |
| [repl-welcome.md](./repl-welcome.md) | Startup welcome hierarchy, responsive tiers, motion, compatibility |
| [configuration.md](./configuration.md) | Settings hierarchy, feature flags, env vars, providers |
| [build-and-runtime.md](./build-and-runtime.md) | Bun runtime, build pipeline, entrypoints, polyfills |

## Reading order

New contributors should read in this order:

1. **[overview](./overview.md)** — understand the five layers and how a turn flows.
2. **[build-and-runtime](./build-and-runtime.md)** — how the process boots and bundles.
3. **[the-loop](./the-loop.md)** — the heart: `query()` → API → tool execution → repeat.
4. **[context-assembly](./context-assembly.md)** + **[token-management](./token-management.md)** — what fills the context window and how it is bounded.
5. **[tools](./tools.md)** + **[permissions](./permissions.md)** — how actions are executed and gated.
6. The remaining subsystem docs as needed.

## Conventions used in this documentation

- **File paths** are repo-relative and absolute-anchored at `/root/code/occ` (e.g. `src/query.ts`).
- **Function names** appear in `code()` formatting and reference the actual exported symbol.
- **Feature flags** are referenced by their `FEATURE_ALLOWLIST` string (e.g. `WORKFLOW_SCRIPTS`).
- Code blocks labeled "pattern" illustrate the shape of real code, not verbatim copies.
