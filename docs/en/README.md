# OCC Documentation

**Open C Code (OCC)** — a safe, open-source coding agent whose capabilities are aligned with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) `2.1.204`.

OCC is fully open source, unobfuscated, and reproducible from source. Your API credentials stay on your machine and requests go only to endpoints you configure. Published to npm as [`@cnwenf/occ`](https://www.npmjs.com/package/@cnwenf/occ).

## Getting started

- [Overview](./overview.md) — what OCC is, how it relates to Claude Code, what's trimmed
- [Installation](./installation.md) — install from npm, build from source, requirements
- [Quickstart](./quickstart.md) — your first session, interactive REPL, pipe mode
- [CLI Reference](./cli-reference.md) — every CLI flag and subcommand

## Using OCC

- [Tools](./tools.md) — Bash, Read, Edit, Write, Grep, Glob, Agent, WebFetch, Task*, Workflow, Monitor, and more
- [Slash Commands](./slash-commands.md) — `/model`, `/mcp`, `/config`, `/goal`, `/workflows`, `/skills`, `/effort`, etc.
- [Permissions](./permissions.md) — permission modes, safety, destructive blocks, auto mode
- [Memory](./memory.md) — CLAUDE.md hierarchy, auto-memory, `/pause-memory`
- [Settings](./settings.md) — `settings.json`, environment variables, provider config
- [Keybindings](./keybindings.md) — keyboard shortcuts, vim mode, custom bindings

## Extending OCC

- [MCP](./mcp.md) — Model Context Protocol servers and resources
- [Skills](./skills.md) — skill system, frontmatter, `/skills`, custom skills
- [Hooks](./hooks.md) — PreToolUse, PostToolUse, Stop, and other lifecycle hooks
- [Sub-agents](./sub-agents.md) — the Agent tool, background agents, worktree isolation

## Advanced

- [Workflows](./workflows.md) — the Workflow tool, `/workflows`, multi-agent scripts
- [Daemon](./daemon.md) — background agents, async workflows, daemon lifecycle
- [FleetView](./fleetview.md) — agent fleets, peers, teams
- [Remote Control](./remote-control.md) — HTTP server on Unix socket, token auth
- [Troubleshooting](./troubleshooting.md) — common issues, `/doctor`, debugging

## At a glance

| | |
|---|---|
| Package | `@cnwenf/occ` |
| Version | `2.1.204` (tracks Claude Code `2.1.204`) |
| Runtime | Bun >= 1.3.11 (not Node.js) |
| License | MIT |
| Providers | Anthropic direct, AWS Bedrock, Google Vertex, Azure Foundry |
| Build | `bun run build` → `dist/cli.js` (~26 MB, single-file bundle) |

> **Note:** OCC carries ~1300 non-blocking `tsc` type errors (loose `unknown`/`never`/`{}` types). They do **not** affect Bun runtime execution. Lint (Biome) is the gate, not `tsc`.
