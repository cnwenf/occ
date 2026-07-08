# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an **independent open-source implementation** of a Claude Code–style coding agent. The goal is to provide core coding-agent functionality while trimming secondary capabilities. Many modules are stubbed or feature-flagged off. The codebase has ~1341 tsc type errors (mostly `unknown`/`never`/`{}` types) — these do **not** block Bun runtime execution.

## Commands

```bash
# Install dependencies
bun install

# Dev mode (direct execution via Bun). Version prints as 888 when working.
bun run dev
# equivalent to: bun run src/entrypoints/cli.tsx

# Pipe mode
echo "say hello" | bun run src/entrypoints/cli.tsx -p

# Build (outputs dist/cli.js, ~25MB)
bun run build

# Lint / format (Biome — formatter is DISABLED to avoid massive diffs; lint only)
bun run lint
bun run lint:fix
bun run format

# Tests (Bun test runner; config in bunfig.toml, root=".", timeout=10000)
bun test
bun test test/e2e               # run a directory
bun test path/to/file.test.ts   # run a single file

# Detect unused exports/dependencies
bun run check:unused            # knip — config in knip.json

# Code health check
bun run health                  # scripts/health-check.ts
```

Requires Bun >= 1.3.11 (use `bun upgrade` — older Bun causes spurious errors). Requires a valid Anthropic API key (or Bedrock/Vertex creds).

A `pre-commit` hook (`.githooks/`, wired via `bun run prepare` → `core.hooksPath .githooks`) runs `biome lint` on staged `src/*.{ts,tsx,js,jsx}` files. Bypass with `--no-verify` when lint errors are from pre-existing noise.

## Architecture

### Runtime & Build

- **Runtime**: Bun (not Node.js). All imports, builds, and execution use Bun APIs.
- **Build**: `bun build src/entrypoints/cli.tsx --outdir dist --target bun` — single-file bundle.
- **Module system**: ESM (`"type": "module"`), TSX with `react-jsx` transform.
- **Monorepo**: Bun workspaces — internal packages live in `packages/` resolved via `workspace:*`.

### Entry & Bootstrap

1. **`src/entrypoints/cli.tsx`** — True entrypoint. Injects runtime polyfills at the top:
   - `feature()` returns `true` for flags in the `FEATURE_ALLOWLIST` (`src/utils/featureFlags.ts` — includes `WORKFLOW_SCRIPTS`, `MONITOR_TOOL`, `TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`), `false` otherwise. Most internal features (COORDINATOR_MODE, KAIROS, PROACTIVE, etc.) remain disabled.
   - `globalThis.MACRO` — simulates build-time macro injection (VERSION, BUILD_TIME, etc.).
   - `BUILD_TARGET`, `BUILD_ENV`, `INTERFACE_TYPE` globals.
2. **`src/main.tsx`** — Commander.js CLI definition. Parses args, initializes services (auth, analytics, policy), then launches the REPL or runs in pipe mode.
3. **`src/entrypoints/init.ts`** — One-time initialization (telemetry, config, trust dialog).

Other entrypoints in `src/entrypoints/`: `mcp.ts` (runs Claude Code as an MCP server, exposing commands like `/review` as tools), and `sdk/` (type definitions + schemas for the `@anthropic-ai/claude-agent-sdk` surface: `coreTypes`, `controlTypes`, `runtimeTypes`, `settingsTypes`, `toolTypes`). The `sdk/` types are the public SDK contract — generated files are marked `.generated.ts`.

### Core Loop

- **`src/query.ts`** — The main API query function. Sends messages to Claude API, handles streaming responses, processes tool calls, and manages the conversation turn loop.
- **`src/QueryEngine.ts`** — Higher-level orchestrator wrapping `query()`. Manages conversation state, compaction, file history snapshots, attribution, and turn-level bookkeeping. Used by the REPL screen.
- **`src/screens/REPL.tsx`** — The interactive REPL screen (React/Ink component). Handles user input, message display, tool permission prompts, and keyboard shortcuts.

### API Layer

- **`src/services/api/claude.ts`** — Core API client. Builds request params (system prompt, messages, tools, betas), calls the Anthropic SDK streaming endpoint, and processes `BetaRawMessageStreamEvent` events.
- Supports multiple providers: Anthropic direct, AWS Bedrock, Google Vertex, Azure.
- Provider selection in `src/utils/model/providers.ts`.

### Tool System

- **`src/Tool.ts`** — Tool interface definition (`Tool` type) and utilities (`findToolByName`, `toolMatchesName`).
- **`src/tools.ts`** — Tool registry. Assembles the tool list; some tools are conditionally loaded via `feature()` flags or `process.env.USER_TYPE`.
- **`src/tools/<ToolName>/`** — Each tool in its own directory (e.g., `BashTool`, `FileEditTool`, `GrepTool`, `AgentTool`).
- Tools define: `name`, `description`, `inputSchema` (JSON Schema), `call()` (execution), and optionally a React component for rendering results.

### UI Layer (Ink)

- **`src/ink.ts`** — Ink render wrapper with ThemeProvider injection.
- **`src/ink/`** — Custom Ink framework (forked/internal): custom reconciler, hooks (`useInput`, `useTerminalSize`, `useSearchHighlight`), virtual list rendering.
- **`src/components/`** — React components rendered in terminal via Ink. Key ones:
  - `App.tsx` — Root provider (AppState, Stats, FpsMetrics).
  - `Messages.tsx` / `MessageRow.tsx` — Conversation message rendering.
  - `PromptInput/` — User input handling.
  - `permissions/` — Tool permission approval UI.
- Components use React Compiler runtime (`react/compiler-runtime`) — output has `_c()` memoization calls throughout.

### State Management

- **`src/state/AppState.tsx`** — Central app state type and context provider. Contains messages, tools, permissions, MCP connections, etc.
- **`src/state/store.ts`** — Zustand-style store for AppState.
- **`src/bootstrap/state.ts`** — Module-level singletons for session-global state (session ID, CWD, project root, token counts).

### Context & System Prompt

- **`src/context.ts`** — Builds system/user context for the API call (git status, date, CLAUDE.md contents, memory files).
- **`src/utils/claudemd.ts`** — Discovers and loads CLAUDE.md files from project hierarchy.

### Feature Flag System

All `feature('FLAG_NAME')` calls come from `bun:bundle` (a build-time API). In OCC, `feature()` is implemented in `src/utils/featureFlags.ts` as `FEATURE_ALLOWLIST.has(name)` — it returns `true` for allowlisted flags (`WORKFLOW_SCRIPTS`, `MONITOR_TOOL`, `TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`) and `false` for everything else. This means the workflow engine, Monitor tool, transcript classifier, and bash classifier are LIVE; most other internal features (COORDINATOR_MODE, KAIROS, PROACTIVE, etc.) remain disabled.

### Stubbed/Deleted Modules

| Module | Status |
|--------|--------|
| Computer Use (`@ant/*`) | Stub packages in `packages/@ant/` |
| `*-napi` packages (audio, image, url, modifiers) | Stubs in `packages/` (except `color-diff-napi` which is fully implemented) |
| Analytics / GrowthBook / Sentry | Empty implementations |
| Magic Docs / Voice Mode / LSP Server | Removed |
| Plugins / Marketplace | Removed |
| MCP OAuth | Simplified |

### Key Type Files

- **`src/types/global.d.ts`** — Declares `MACRO`, `BUILD_TARGET`, `BUILD_ENV` and internal Anthropic-only identifiers.
- **`src/types/internal-modules.d.ts`** — Type declarations for `bun:bundle`, `bun:ffi`, `@anthropic-ai/mcpb`.
- **`src/types/message.ts`** — Message type hierarchy (UserMessage, AssistantMessage, SystemMessage, etc.).
- **`src/types/permissions.ts`** — Permission mode and result types.

## Working with This Codebase

- **Don't try to fix all tsc errors** — they don't affect runtime. `tsconfig.json` has `strict: false` and `skipLibCheck: true`; `tsc` is not part of CI. Lint (Biome) is the gate, and many `suspicious` rules are deliberately off (see `biome.json`) to tolerate the loose output.
- **`feature()` is always `false`** — any code behind a feature flag is dead code in this build.
- **React Compiler output** — Components have memoization boilerplate (`const $ = _c(N)`). This is normal.
- **`bun:bundle` import** — In `src/main.tsx` and other files, `import { feature } from 'bun:bundle'` works at build time. At dev-time, the polyfill in `cli.tsx` provides it.
- **`src/` path alias** — tsconfig maps `src/*` to `./src/*`. Imports like `import { ... } from 'src/utils/...'` are valid.
