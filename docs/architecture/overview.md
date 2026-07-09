# Overview

OCC is structured as five cooperating layers. Each layer has a clear
responsibility and a well-known set of entry files. This document maps the
layers, the project layout, and the end-to-end data flow of a single agent
turn.

## The five layers

```
┌─────────────────────────────────────────────────────────────┐
│  1. Entry & Bootstrap   cli.tsx → main.tsx → init.ts         │
│     Polyfills, fast-paths, Commander CLI, service init       │
├─────────────────────────────────────────────────────────────┤
│  2. UI Layer (Ink)      src/ink/ (custom fork) + components/ │
│     React reconciler, REPL screen, prompts, permissions UI   │
├─────────────────────────────────────────────────────────────┤
│  3. Core Loop           query.ts + QueryEngine.ts            │
│     API streaming, tool-call dispatch, turn management       │
├─────────────────────────────────────────────────────────────┤
│  4. Tool & Permission   Tool.ts + tools.ts + utils/perm…     │
│     Tool registry, execution, rule matching, classifiers     │
├─────────────────────────────────────────────────────────────┤
│  5. Services & Infra    services/, daemon/, mcp/, skills/    │
│     API client, MCP, compaction, daemon supervisor, hooks    │
└─────────────────────────────────────────────────────────────┘
```

### 1. Entry & Bootstrap

- **`src/entrypoints/cli.tsx`** — the true entrypoint (`bun run dev` runs it
  directly). Injects runtime polyfills before anything else loads:
  `feature()` (the build-time-macro stand-in), `globalThis.MACRO` (version,
  build time, changelog), and `BUILD_TARGET` / `BUILD_ENV` / `INTERFACE_TYPE`
  globals. It also implements fast-paths (`--version`, `--dump-system-prompt`,
  `--claude-in-chrome-mcp`) that avoid loading the full CLI.
- **`src/main.tsx`** — Commander.js CLI definition (~4900 lines). Parses
  arguments, initializes services (auth, analytics, policy), then either
  launches the interactive REPL (`src/screens/REPL.tsx`) or runs in pipe mode
  (`-p`).
- **`src/entrypoints/init.ts`** — one-time initialization: telemetry, config
  loading, trust dialog.

### 2. UI Layer (Ink)

OCC ships a **custom Ink fork** in `src/ink/` rather than using upstream Ink.
The fork contains its own React reconciler (`src/ink/reconciler.ts`, built on
`react-reconciler`), a terminal I/O layer (`src/ink/termio/`), a layout engine
(`src/ink-layout/`, `src/native-ts/yoga-layout/`), and custom hooks
(`src/ink/hooks/`: `useInput`, `useTerminalSize`, `useSearchHighlight`).

- **`src/ink.ts`** — the render wrapper; injects `ThemeProvider`.
- **`src/screens/REPL.tsx`** — the interactive REPL screen (~5100 lines).
  Handles user input, message display, tool-permission prompts, and keyboard
  shortcuts. This is the largest single component in the codebase.
- **`src/components/`** — React components rendered to the terminal: `App.tsx`
  (root provider), `Messages.tsx` / `MessageRow.tsx` (conversation rendering),
  `PromptInput/` (input handling), `permissions/` (approval UI), `FleetView/`
  (daemon task list), plus `diff/`, `Settings/`, `skills/`, `tasks/`, etc.

React Compiler output is used throughout — components contain `_c(N)`
memoization boilerplate, which is normal for this codebase.

### 3. Core Loop

- **`src/query.ts`** (~1860 lines) — the main API query function. An async
  generator (`export async function* query`) that sends messages to the Claude
  API, streams `BetaRawMessageStreamEvent` events, dispatches tool calls, and
  yields `Message` / `StreamEvent` / `ToolUseSummaryMessage` back to the
  caller. See [the-loop.md](./the-loop.md).
- **`src/QueryEngine.ts`** (~1320 lines) — higher-level orchestrator wrapping
  `query()`. The `QueryEngine` class owns conversation state (`mutableMessages`,
  `totalUsage`, `readFileState`, `permissionDenials`), compaction triggers, and
  turn-level bookkeeping. One `QueryEngine` per conversation; each
  `submitMessage()` starts a new turn.

### 4. Tool & Permission

- **`src/Tool.ts`** (~820 lines) — the `Tool` type and utilities
  (`findToolByName`, `toolMatchesName`). A tool defines `name`, `description`,
  `inputSchema` (Zod), `call()`, `checkPermissions()`, `validateInput()`, and
  many optional predicates (`isReadOnly`, `isDestructive`,
  `isConcurrencySafe`, `interruptBehavior`). See [tools.md](./tools.md).
- **`src/tools.ts`** (~420 lines) — the tool registry. Assembles the tool list
  with conditional loading via `feature()` flags and `process.env.USER_TYPE`.
- **`src/tools/<Name>/`** — each tool in its own directory (e.g.
  `BashTool/`, `FileEditTool/`, `AgentTool/`, `WorkflowTool/`).
- **`src/utils/permissions/`** — the permission model. `permissions.ts`
  exports `hasPermissionsToUseTool` (the `CanUseToolFn`); `classifierDecision.ts`
  + `yoloClassifier.ts` implement the auto-mode AI classifier;
  `dangerousPatterns.ts` blocks destructive commands. See
  [permissions.md](./permissions.md).

### 5. Services & Infrastructure

- **`src/services/api/claude.ts`** — core API client (request building,
  streaming, multi-provider). See [streaming.md](./streaming.md).
- **`src/services/mcp/`** — MCP client (`client.ts`), connection management.
  See [mcp.md](./mcp.md).
- **`src/services/compact/`** — compaction/summarization. See
  [token-management.md](./token-management.md).
- **`src/daemon/`** — daemon supervisor, worker registry, remote control. See
  [daemon.md](./daemon.md).
- **`src/skills/`** + **`src/tools/SkillTool/`** — skills system. See
  [skills.md](./skills.md).
- **`src/utils/hooks.ts`** + **`src/utils/hooks/`** — hook runtime. See
  [hooks.md](./hooks.md).

## Project layout

```
src/
├── entrypoints/        Bootstrap: cli.tsx, main.tsx, init.ts, mcp.ts, sdk/
├── screens/            REPL.tsx (interactive screen)
├── ink/                Custom Ink fork (reconciler, hooks, termio, layout)
├── components/         React/Ink UI components
├── query/              (helpers) — core loop lives in src/query.ts
├── query.ts            ★ Main API query generator (agentic loop)
├── QueryEngine.ts      ★ Orchestrator wrapping query()
├── Tool.ts             ★ Tool type + utilities
├── tools.ts            ★ Tool registry
├── tools/<Name>/       One directory per tool
├── services/
│   ├── api/            claude.ts (API client), providers
│   ├── mcp/            MCP client + connections
│   ├── compact/        Compaction
│   └── …               skillSearch, sessionTranscript, oauth, etc.
├── utils/
│   ├── permissions/    Permission model + classifiers
│   ├── settings/       3-tier settings hierarchy
│   ├── hooks/          Hook runtime
│   ├── model/          Provider selection, model config
│   ├── skills/         Skill discovery utilities
│   ├── featureFlags.ts ★ FEATURE_ALLOWLIST
│   └── …               bash, git, sandbox, memory, telemetry, etc.
├── daemon/             Supervisor, workerRegistry, remoteControl, lockfile
├── state/              AppState.tsx + store.ts (Zustand-style)
├── commands/           Slash commands (one dir per command)
├── keybindings/        Keybinding system (contexts, resolver, vim)
├── vim/                Vim-mode state machine (motions, operators, transitions)
├── skills/             Bundled skills
├── tasks/              Task types (LocalAgent, RemoteAgent, Workflow, …)
├── context/            (context assembly lives in src/context.ts)
├── context.ts          ★ System/user context assembly
├── constants/          prompts, tools, querySource
└── types/              message.ts, permissions.ts, tools.ts, global.d.ts
```

The `packages/` directory holds the Bun workspace stubs: `packages/@ant/`
(Computer Use stubs) and `packages/*` (napi stubs except `color-diff-napi`).
Internal packages are resolved via `workspace:*`.

## End-to-end data flow of one turn

```
User types in REPL
        │
        ▼
REPL.tsx  ──submitMessage()──►  QueryEngine
                                   │
                                   ├─ build ToolUseContext (tools, mcpClients,
                                   │    readFileState, setAppState, …)
                                   ├─ getSystemContext() + getUserContext()
                                   │    (git status, CLAUDE.md, date)
                                   ├─ getSystemPrompt()  (constants/prompts.ts)
                                   │
        ┌──────────────────────────┘
        ▼
query()  async generator   (src/query.ts)
        │
        ├─ API client stream  (services/api/claude.ts)
        │     BetaRawMessageStreamEvent
        │       ├─ message_start / message_delta
        │       ├─ content_block_start (text | thinking | tool_use)
        │       ├─ content_block_delta (text | input_json_delta | thinking)
        │       └─ content_block_stop / message_stop
        │
        ├─ yield StreamEvent → REPL renders token-by-token
        │
        ├─ on stop_reason == "tool_use":
        │     for each tool_use block:
        │       1. validateInput()
        │       2. checkPermissions() → hasPermissionsToUseTool
        │            (rules → classifier → prompt UI)
        │       3. run PreToolUse hooks
        │       4. tool.call()  → ToolResult
        │       5. run PostToolUse hooks
        │       6. append tool_result message
        │     continue loop (next API request with tool results)
        │
        └─ on stop_reason == "end_turn" / max_turns / abort:
              yield Terminal → QueryEngine stores messages
                                   │
                                   ▼
                              REPL renders final state
```

## State management

- **`src/state/AppState.tsx`** — central app-state type and React context
  provider. Holds messages, tools, permission context, MCP connections, tasks,
  and more.
- **`src/state/store.ts`** — a Zustand-style store for `AppState`.
- **`src/bootstrap/state.ts`** — module-level singletons for session-global
  values (session ID, CWD, project root, token counts).
- The `ToolUseContext` (defined in `src/Tool.ts`) is the per-turn mutable bag
  passed into every tool `call()`: it carries `getAppState`/`setAppState`,
  `readFileState`, `abortController`, `messages`, `mcpClients`, and dozens of
  optional hooks for progress, notifications, and SDK status.

## What is deliberately trimmed

OCC explicitly removes or stubs secondary Claude Code subsystems to keep the
surface auditable:

- **Computer Use** (`@ant/*`) — stub packages in `packages/@ant/`.
- **napi packages** (audio, image, url, modifiers) — stubs, except
  `color-diff-napi` which is fully implemented.
- **Analytics / GrowthBook / Sentry** — empty implementations.
- **Magic Docs / Voice Mode / LSP server** — removed.
- **Plugins / Marketplace** — removed (though `/plugin` command shell exists).
- **MCP OAuth** — simplified.

Most internal feature flags (`COORDINATOR_MODE`, `KAIROS`, `PROACTIVE`,
`UDS_INBOX`, `QUICK_SEARCH`, `TERMINAL_PANEL`, …) remain **off** because
`feature()` returns `false` for them. The live flags are enumerated in
`src/utils/featureFlags.ts` and covered in [configuration.md](./configuration.md).
