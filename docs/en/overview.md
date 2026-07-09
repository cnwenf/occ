# Overview

**Open C Code (OCC)** is an open-source coding agent whose capabilities are aligned with Anthropic's [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`2.1.204`). It is an independent, fully-auditable reconstruction — not a wrapper around the closed-source binary.

## Why OCC

If you worry that a closed-source CLI might hide backdoors, or that your code and credentials are uploaded to unauditable services, OCC is the alternative: all source is open and unobfuscated, the build is reproducible from source, and API credentials are sent only to endpoints you configure.

| Pillar | What it means |
|---|---|
| Open & auditable | Full source, no obfuscation, line-by-line reviewable |
| Transparent & safe | No telemetry black boxes, no hidden reporting; behavior you can supervise |
| Capability-aligned | REPL, tool system, permission model, MCP, sub-agents, slash commands — on par with Claude Code |
| Data sovereignty | API Key / Bedrock / Vertex / Azure credentials stay on your machine |

## Identity

| | |
|---|---|
| npm package | [`@cnwenf/occ`](https://www.npmjs.com/package/@cnwenf/occ) |
| Version | `2.1.204` (tracks Claude Code `2.1.204`) |
| License | MIT, Copyright (c) 2026 cnwenf |
| Runtime | Bun (not Node.js), >= 1.3.11 |
| Module system | ESM, TSX with `react-jsx` transform |
| Binary | `occ` → `dist/cli.js` (~26 MB single-file bundle) |

> The internal program name is `claude`, so `occ --version` prints `2.1.204 (Claude Code)` and help text references "Claude Code". You invoke the published binary as `occ`.

## Relationship to Claude Code

OCC mirrors the official binary's behavior. For example, provider selection order in `src/utils/model/providers.ts` is documented as matching the official `2.1.204` binary selection order exactly. Where Claude Code relies on closed-source Anthropic internal services (Statsig feature gating, telemetry, the plugin marketplace), OCC replaces them with transparent, open equivalents or trims them.

## Supported API providers

OCC supports multiple LLM providers, selected via environment variables. API client code lives in `src/services/api/`.

| Env var | Provider | Notes |
|---|---|---|
| (none) | `firstParty` | Anthropic direct (default) |
| `CLAUDE_CODE_USE_BEDROCK` | `bedrock` | AWS Bedrock |
| `CLAUDE_CODE_USE_FOUNDRY` | `foundry` | Azure Foundry |
| `CLAUDE_CODE_USE_ANTHROPIC_AWS` | `anthropic_aws` | Claude Platform on AWS (2.1.198) |
| `CLAUDE_CODE_USE_MANTLE` | `mantle` | Bedrock Mantle (2.1.94) |
| `CLAUDE_CODE_USE_VERTEX` | `vertex` | Google Vertex |

Auth env vars: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`. Skip-auth vars (`CLAUDE_CODE_SKIP_BEDROCK_AUTH`, etc.) bypass credential checks when using a proxy.

## Feature flags

In the official build, `feature('FLAG')` is a build-time gate injected by `bun:bundle`. In OCC it is a runtime stand-in (`src/utils/featureFlags.ts`): `feature()` returns `true` only for flags in the `FEATURE_ALLOWLIST`, `false` for everything else.

**Live flags (true):**

| Flag | What it enables |
|---|---|
| `TRANSCRIPT_CLASSIFIER` | Auto permission mode (AI classifier) |
| `BASH_CLASSIFIER` | Bash-command classification for auto mode |
| `MONITOR_TOOL` | Monitor tool (2.1.200, self-contained) |
| `WORKFLOW_SCRIPTS` | Workflow engine — vm-sandboxed multi-agent scripts (2.1.154) |
| `EXPERIMENTAL_SKILL_SEARCH` | Skill discovery / turn-zero prefetch (2.1.200) |
| `MCP_SKILLS` | Fetch skill modules from MCP servers (2.1.200) |

**Disabled flags (false):** `COORDINATOR_MODE`, `KAIROS`, `PROACTIVE`, `UDS_INBOX`, `DAEMON`, `BG_SESSIONS`, `BRIDGE_MODE`, `DIRECT_CONNECT`, `SSH_REMOTE`, `LODESTONE`, `CHICAGO_MCP`, `WEB_BROWSER_TOOL`, `TEMPLATES`, and others. Code behind these flags is dead code in this build.

## What's trimmed or stubbed

OCC deliberately trims secondary capabilities. Many modules are stubbed or feature-flagged off.

| Module | Status |
|---|---|
| Computer Use (`@ant/*`) | Stub packages in `packages/@ant/` |
| `*-napi` packages (audio, image, url, modifiers) | Stubs (except `color-diff-napi`, fully implemented) |
| Analytics / GrowthBook / Sentry | Empty implementations |
| Magic Docs / Voice Mode / LSP Server | Removed |
| Plugins / Marketplace | Removed |
| MCP OAuth | Simplified |

## Architecture at a glance

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

### Entry & bootstrap

1. **`src/entrypoints/cli.tsx`** — true entrypoint. Injects runtime polyfills (`feature()`, `globalThis.MACRO`, `BUILD_TARGET`/`BUILD_ENV`/`INTERFACE_TYPE`). Fast-paths `--version`/`-v` to print `2.1.204 (Claude Code)` with zero imports, then loads `src/main.tsx`.
2. **`src/main.tsx`** — Commander.js CLI definition. Parses args, runs `init()` via a `preAction` hook, then launches the REPL or runs in pipe mode.
3. **`src/entrypoints/init.ts`** — one-time initialization (telemetry, config, trust dialog, repo detection, graceful shutdown).

### Core loop

- **`src/query.ts`** — the main API query function: streaming responses, tool-call processing, conversation turn loop.
- **`src/QueryEngine.ts`** — higher-level orchestrator wrapping `query()`: conversation state, compaction, file-history snapshots, attribution.
- **`src/screens/REPL.tsx`** — the interactive REPL (React/Ink): user input, message display, tool permission prompts, keyboard shortcuts.

## Status caveats

- The codebase carries ~1300 non-blocking `tsc` type errors (loose `unknown`/`never`/`{}` types). They do **not** affect Bun runtime execution. **Lint (Biome) is the gate, not `tsc`.**
- React Compiler output appears throughout components as `_c()` memoization calls — this is normal, not hand-written.
- The `bun:bundle` import works at build time; at dev-time the polyfill in `cli.tsx` provides it.

## Next steps

- [Installation](./installation.md) — get OCC running
- [Quickstart](./quickstart.md) — your first session
- [CLI Reference](./cli-reference.md) — every flag and subcommand
