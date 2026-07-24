# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an **independent open-source implementation** of a Claude Code–style coding agent. The goal is to provide core coding-agent functionality while trimming secondary capabilities. Many modules are stubbed or feature-flagged off. It last fully aligned to Claude Code `2.1.218` (official latest as of 2026-07-22; full portable alignment via OCC-19, PRs #199–#228 — every portable 2.1.216/217/218 item is on `main`; see `docs/upstream-version-gap-occ19.md` for the 2.1.216/217/218 catch-up ledger, `docs/upstream-version-gap-occ13.md` for the prior no-gap confirmation, and `docs/upstream-version-gap-occ11.md` for the 2.1.214→2.1.215 catch-up). Live TUI/REPL acceptance e2e is deferred to a non-sandbox environment per the OCC-11 sandbox-stall constraint. The codebase has ~1341 tsc type errors (mostly `unknown`/`never`/`{}` types) — these do **not** block Bun runtime execution.

## CLI Flag Divergences (OCC-21)

OCC tracks Claude Code `2.1.218` `--help` but diverges by design on a few flags:

- **`--bg` / `--background`** — accepted for CLI compatibility (not rejected as "unknown option") but OCC manages background sessions via the self-built **daemon supervisor** subcommands (`occ daemon start`, `occ agents`, `occ attach <id>`, `occ logs`, `occ stop`) rather than this flag. Invoking `--bg` prints a redirect to those subcommands and exits. This is option B of the OCC-21 Gap-2b verdict: the `feature('BG_SESSIONS')` fast-path in `cli.tsx` is dead code (upstream 2.1.211 removed the gate; OCC's trimmed build keeps it off), so reactivating it is riskier than documenting the daemon replacement.
- **`--plugin-url <url>`** — registered + implemented, but **HTTPS-only** (OCC hardening; the official accepts any URL). A plaintext/local plugin URL is a tampering/SSRF footgun and conflicts with OCC's "safe, auditable" ethos. Fetch is size-capped (100 MiB) and streamed to a session temp `.zip`; extraction reuses OCC's existing zip-cache path-traversal guard. See `src/utils/plugins/fetchPluginZip.ts`.
- **`--exclude-dynamic-system-prompt-sections`** — registered + wired: relocates per-machine dynamic sections from the system prompt into the first user message (headless path only; `--print` / SDK), matching the 2.1.218 boundary-marker split.
- **`--prompt-suggestions [value]`** — registered + wired to the existing SDK `promptSuggestions` path; requires `--print --output-format=stream-json` (binary-verified guard).

## Tool Set & Help Divergences (OCC-24)

OCC tracks Claude Code `2.1.218` `mcp`/`--help` surface. The divergences below are **by design** (flag-safety or OCC-specific features), not alignment debt.

### `mcp login` / `mcp logout` (aligned in OCC-24)

`claude mcp login <name>` / `claude mcp logout <name>` are registered + implemented (OAuth for HTTP/SSE via `performMCPOAuthFlow`; `--no-browser` prints the auth URL and accepts a pasted redirect URL for SSH/headless). `mcp login/logout/get/list --help` are byte-identical to the 2.1.218 binary. A claude.ai connector (`claudeai-proxy`) authenticates via the Anthropic account, so `mcp login` on one routes to `auth login` rather than the per-server consent flow; `mcp logout` on a stdio/connector server reports no stored OAuth credentials.

### stream-json `init` tool set (Obs C — by design)

`occ -p --output-format=stream-json` exposes a different default tool set than the 2.1.218 binary:

- **OCC-only** (not in official `-p`): `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` (OCC enables interactive tools in print mode to support stream-json interactive `-p`); `browser_batch` / `navigate` / `screenshot` / `get_page_text` (OCC's WebBrowser tool — real Chrome via CDP, an OCC-specific feature official does not ship as a built-in).
- **Official-only** (not in OCC `-p`): `CronCreate` / `CronDelete` / `CronList`, `SendMessage` / `BriefTool`, `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate`, `PushNotification`, `ReportFindings`, `ScheduleWakeup`, `DesignSync`.

These OCC-absent tools **exist in OCC source** (`src/tools.ts` `getBaseTools()` registers them) but are filtered from the `-p` init event because their `isEnabled()` gates on feature flags that are **intentionally off** in the production build (`KAIROS`/`KAIROS_BRIEF` for `BriefTool`/`SendMessage`; `isTodoV2Enabled()` for the `Task*` set; etc.). Re-enabling those flags is unsafe — `feature('KAIROS')` re-activates the BriefTool 5-minute loop that hangs `occ` (the same risk the `aligning-with-official-binary` guidance warns about and that the OCC-24 `--brief` flag exposure deliberately avoided by separating flag visibility from behavior activation). The interactive REPL (non-`-p`) path still surfaces these tools through its own enablement. Aligning the `-p` default set to official would require either re-enabling unsafe flags or a deeper rework of the print-mode enablement conditions — deferred with this rationale rather than risk a regression.

### `--help` wrapping (Gap-5 — partial fix + deferral)

`createSortedHelpConfig()` now pins `helpWidth: 80` for non-TTY stdout (TTY stays dynamic — no new interactive divergence). This makes **leaf subcommand** `--help` (e.g. `mcp login --help`, `mcp logout --help`, `mcp get --help`, `mcp list --help`) byte-identical to the 2.1.218 binary, including description wrapping. The **top-level `occ --help`** and **multi-subcommand `mcp --help` Commands list** still render long option/command descriptions on a single wide line (no wrap), diverging from the binary's separate-indented-line + wrap layout. Root cause: OCC's bundled Commander `Help` layout algorithm differs from the binary's for long signatures, and the `helpWidth` knob does not change that algorithm. Forcing a custom `helpInformation` override to match would risk regressing the byte-identical leaf-subcommand helps and is low priority — deferred with rationale.

## Bundled workflows & safe-mode divergences (OCC-31)

### Bundled workflows (incl. `/deep-research`) — trimmed by design

Official Claude Code 2.1.218 ships built-in **bundled workflows** registered via `initBundledWorkflows()` — notably `deep-research` (manual-only, `disableModelInvocation: true`; a multi-agent harness: 5 parallel WebSearch agents → URL-dedup → fetch top 15 sources → extract falsifiable claims → 3-vote adversarial verification → synthesize a cited report), plus `code-review`/`pr-review-artifact` and others. These surface as slash commands (e.g. `/deep-research`) and via the `Workflow({name: ...})` tool.

OCC keeps the bundled-workflow **infrastructure** wired (`src/tools/WorkflowTool/bundled/index.js` `initBundledWorkflows`/`getBundledWorkflow`/`listBundledWorkflows`, `createWorkflowCommand.ts`, the `WORKFLOW_SCRIPTS` feature flag — all live) but ships **zero bundled workflows** (`BUNDLED_WORKFLOWS = new Map()`). OCC discovers user-defined workflows from `.claude/workflows/` + `~/.claude/workflows/` at runtime instead. This is an intentional trim, not alignment debt: faithfully porting `deep-research` would require extracting a large minified multi-agent orchestration script from the native ELF and re-implementing it byte-faithfully, which conflicts with OCC's "safe, auditable, trim secondary capabilities" ethos and risks an invented/partial implementation (forbidden by the `aligning-with-official-binary` skill — "Never invent"). OCC's `/code-review` surface is implemented separately (not via bundled workflow). Users who need `deep-research`-style behavior can drop a workflow script into `.claude/workflows/`. Tracked as a documented divergence rather than silently missing.

### `--safe-mode` — narrower disabled scope than official (by design)

Official `--safe-mode` disables a broad set: CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands/agents, output styles, workflows, custom themes, keybindings, and more. OCC's `--safe-mode` (`CLAUDE_CODE_SAFE_MODE`) disables a **narrower** set: plugins (`pluginLoader.ts`), bundled skills (`src/skills/bundled/index.ts`), and SessionStart/setup hooks (`src/utils/sessionStart.ts`). It does NOT disable CLAUDE.md auto-discovery, user skills, MCP servers, custom commands/agents, output styles, workflows, themes, or keybindings. OCC's `--safe-mode` help text intentionally describes only what OCC actually disables (accurate but shorter than the official text) rather than copying the official wording (which would overstate OCC's behavior). Aligning the disabled scope to the full official set is a broad behavioral change deferred from the release path; tracked here as a documented by-design divergence.

```bash
# Install dependencies
bun install

# Dev mode (direct execution via Bun). Version prints as 2.1.270 (dev polyfill;
# build overrides with pkg.version) when the cli.tsx MACRO polyfill is active;
# prints 888 if the polyfill is bypassed.
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

## Release Workflow

OCC publishes to npm as `@cnwenf/occ`. The version in `package.json` is the source of truth. CI auto-bumps and tags, but the manual flow is:

1. **Update `CHANGELOG.md`** — add a `## <version> - YYYY-MM-DD` section at the top (below the header) with `- ` bullet entries for user-facing changes. The REPL "What's new" feed and `/release-notes` command fetch this file from GitHub (`src/utils/releaseNotes.ts` → `RAW_CHANGELOG_URL`). Format matters: `parseChangelog()` splits on `## ` headers and extracts `- ` bullets.
2. **Bump version** — edit `"version"` in `package.json` to the new semver (e.g. `2.1.262`). Keep it monotonically increasing; OCC tracks upstream Claude Code but versions its own releases above the `2.1.214` baseline.
3. **Commit** — `git commit -am "chore(release): <version>"` (or let CI do it).
4. **Tag** — `git tag v<version>` (e.g. `v2.1.262`) and `git push --tags`. The tag marks the release point.
5. **Publish** — `bun run build` produces `dist/cli.js`, then `npm publish` (the `prepublishOnly` script auto-builds). CI handles this on tag push.

### How "What's new" works

`src/setup.ts` calls `checkForReleaseNotes()` at startup → `fetchAndStoreChangelog()` pulls `RAW_CHANGELOG_URL` → writes `~/.claude/cache/changelog.md` → `parseChangelog()` parses it → `getRecentReleaseNotes()` returns up to 5 bullets newer than the user's last-seen version → `createWhatsNewFeed()` in `src/components/LogoV2/feedConfigs.tsx` renders the feed with footer `/release-notes for more`.

So: **if `CHANGELOG.md` isn't updated or the tag isn't pushed, the REPL "What's new" won't reflect the new release.** The fetch is against the `main` branch raw URL, not the npm package.

## Architecture

### Runtime & Build

- **Runtime**: Bun (not Node.js). All imports, builds, and execution use Bun APIs.
- **Build**: `bun build src/entrypoints/cli.tsx --outdir dist --target bun` — single-file bundle.
- **Module system**: ESM (`"type": "module"`), TSX with `react-jsx` transform.
- **Monorepo**: Bun workspaces — internal packages live in `packages/` resolved via `workspace:*`.

### Entry & Bootstrap

1. **`src/entrypoints/cli.tsx`** — True entrypoint. Injects runtime polyfills at the top:
   - `feature()` returns `true` for flags in the `FEATURE_ALLOWLIST` (`src/utils/featureFlags.ts` — 6 flags: `TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`, `MONITOR_TOOL`, `WORKFLOW_SCRIPTS`, `EXPERIMENTAL_SKILL_SEARCH`, `MCP_SKILLS`), `false` otherwise. Most internal features (COORDINATOR_MODE, KAIROS, PROACTIVE, etc.) remain disabled. Note: `cli.tsx` has a *separate, smaller* 2-flag allowlist (`TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`) for the dev-time polyfill — see the file header comment; `featureFlags.ts` is the canonical runtime source.
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

All `feature('FLAG_NAME')` calls come from `bun:bundle` (a build-time API). In OCC, `feature()` is implemented in `src/utils/featureFlags.ts` as `FEATURE_ALLOWLIST.has(name)`. The 6 allowlisted (LIVE) flags and what they un-gate:

- `TRANSCRIPT_CLASSIFIER` + `BASH_CLASSIFIER` — auto permission mode (AI classifier for transcripts + bash commands).
- `MONITOR_TOOL` — self-contained monitoring tool (no blocking init).
- `WORKFLOW_SCRIPTS` — vm-sandboxed multi-agent workflow engine (`/workflows` command + Workflow tool).
- `EXPERIMENTAL_SKILL_SEARCH` — turn-zero skill discovery/prefetch (filesystem index + in-memory cache).
- `MCP_SKILLS` — fetches skill modules exposed by MCP servers declaring the `io.modelcontextprotocol/skills` extension (only runs when an MCP server is connected).

Every other flag (COORDINATOR_MODE, KAIROS, PROACTIVE, UDS_INBOX, ABLATION_BASELINE, …) returns `false` → that code path is dead in this build. The `featureFlags.ts` file header documents which flags are unsafe to re-enable (KAIROS and UDS_INBOX hang the query path when enabled).

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
- **`feature()` returns `false` for non-allowlisted flags** — any code behind a flag *not* in the 6-flag `FEATURE_ALLOWLIST` (see above) is dead code in this build. Allowlisted subsystems (workflow, monitor, skills, auto-mode classifiers) are live.
- **React Compiler output** — Components have memoization boilerplate (`const $ = _c(N)`). This is normal.
- **`bun:bundle` import** — In `src/main.tsx` and other files, `import { feature } from 'bun:bundle'` works at build time. At dev-time, the polyfill in `cli.tsx` provides it.
- **`src/` path alias** — tsconfig maps `src/*` to `./src/*`. Imports like `import { ... } from 'src/utils/...'` are valid.
