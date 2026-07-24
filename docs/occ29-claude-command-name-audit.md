# OCC-29 — `claude`-command-name residual audit & fix

> Scope: every place user-facing reminder/prompt text still wrote the **OCC
> command name** as `claude` (the upstream binary name). OCC-27 (2.1.282) did a
> broad first pass; this is the comprehensive sweep that closes what it missed
> and routes every fix through the single `CLI_BINARY_NAME` source.

## Unified bin-name source (already in place from OCC-27)

- `src/constants/cli.ts` exports `CLI_BINARY_NAME`, read from
  `globalThis.MACRO.BINARY_NAME` with a `'occ'` fallback.
- `scripts/build.ts` injects `MACRO.BINARY_NAME` from the sole `package.json.bin`
  key (`occ`) at build time; `src/entrypoints/cli.tsx` polyfills it to `"occ"`
  for dev mode.
- Result: one source of truth. All OCC-29 fixes below import and interpolate
  `CLI_BINARY_NAME` — **no `occ` literal is hardcoded at any fix site.**

## Fixed in this release (user-facing command-name residuals OCC-27 missed)

| File:line | Before | After | Surface |
|---|---|---|---|
| `src/main.tsx:1042` | `program.name('claude')` | `program.name(CLI_BINARY_NAME)` | `occ --help` usage line — was `Usage: claude`, now `Usage: occ` |
| `src/main.tsx:965` | `process.title = 'claude'` | `process.title = CLI_BINARY_NAME` | terminal tab title / `ps` process name |
| `src/utils/statusNoticeDefinitions.tsx:76` | `` `claude /logout`. `` | `` {`\`${CLI_BINARY_NAME} /logout\`.`} `` | auth-conflict status banner (external-token notice) |
| `src/utils/statusNoticeDefinitions.tsx:102` | `` `occ /logout`. `` (hardcoded by OCC-27) | `` {`\`${CLI_BINARY_NAME} /logout\`.`} `` | api-key-conflict banner — consolidated to the constant |
| `src/utils/statusNoticeDefinitions.tsx:139` | `'claude /logout'` (×2 in ternary) | `` `${CLI_BINARY_NAME} /logout` `` | both-auth-methods banner |
| `src/utils/statusNoticeDefinitions.tsx:143` | `'claude /logout to sign out of claude.ai.'` | `` `${CLI_BINARY_NAME} /logout to sign out of claude.ai.` `` | both-auth-methods banner |
| `src/utils/swarm/backends/registry.ts` (×4) | `tmux new-session -s claude` | `tmux new-session -s ${CLI_BINARY_NAME}` | agent-swarm tmux install hint example label |

> The exit/resume banner (`src/utils/gracefulShutdown.ts:180`,
> `occ --resume <id>`) and cross-project resume copy, `/fork`+`/branch` hints,
> print-mode validation, tips, completion cache, etc. were already routed
> through `CLI_BINARY_NAME` by OCC-27 — confirmed, unchanged.

## Intentionally NOT changed (legitimate `claude` — keep)

- **Brand / model / product names**: `Claude Code` (program description), model
  family names in `src/utils/commitAttribution.ts` (`claude-opus-4-6`, …), the
  `Claude` attribution co-author label.
- **`claude.ai` URLs** and `code.claude.com` / `platform.claude.com` domains.
- **`.claude` configuration/install paths**: `~/.claude/`, `getClaudeTempDirName()`
  (`claude-{uid}`), `~/.claude/local`, `~/.claude/sessions`.
- **`claude://` deep-link protocol** (`src/utils/desktopDeepLink.ts`,
  `src/utils/deepLink/registerProtocol.ts`) — the URL scheme owned by the
  Claude Desktop app integration, not the OCC command.
- **`@claude` / `claude-code` / `claude-plugins-official` GitHub / package refs.**
- **`CLAUDE_*` env vars**, `claude.ai` connector / subscriber identifiers.
- **Theme color token `'claude'`** (the brand orange; `color="claude"`,
  `claudeShimmer`) — a theme key, not a command name.
- **Code comments** (`// … claude …`) — not user-facing. e.g.
  `src/main.tsx:703`, `src/utils/process.ts:13`, `src/utils/auth.ts:256`.

## Documented as follow-up (not changed — release-risk / breaking)

### A. OCC-27's hardcoded-`occ` strings (53 sites across ~29 files)

These already **display correct `occ`** (so the acceptance bar "all user-facing
command names consistently `occ`, no `claude` residue" is met), but OCC-27
wrote them as literals rather than `${CLI_BINARY_NAME}`. Retro-converting them
is a mechanical, low-value, non-zero-risk refactor (many sit inside
single-quoted strings containing literal backticks, e.g.
`'No plugins installed. Use \`occ plugin install\` to install a plugin.'`),
with no per-string test coverage. To keep this release low-risk, the conversion
is deferred. Safe recipe when taken on:

- **Template-literal sites** (e.g. most of `src/bridge/*`): replace
  `occ <sub>` → `${CLI_BINARY_NAME} <sub>` — the surrounding escaped display
  backticks are unaffected.
- **Single/double-quoted sites**: split at the `occ` token and concatenate —
  `'… \`occ auth login\` …'` → `'… \`' + CLI_BINARY_NAME + ' auth login\` …'`.
- Add `import { CLI_BINARY_NAME } from '<rel>/constants/cli.js'` to each file.

Files: `src/main.tsx`, `src/cli/update.ts`, `src/cli/handlers/{mcp,autoMode,
daemon,plugins}.ts(x)`, `src/components/{AutoUpdater,mcp/MCPSettings}.tsx`,
`src/daemon/install.ts`, `src/bridge/*`, `src/services/mcp/auth.ts`,
`src/commands/{insights,mcp/addCommand,mcp/xaaIdpCommand,fork/*,exit/exit.tsx}`,
`src/utils/{gracefulShutdown,completionCache,statusNoticeDefinitions,
doctorDiagnostic,auth,autoUpdater,settings/*}.ts`.

### B. Inherited native-installer / doctor / deep-link on-disk binary-name layout

`getBinaryName()` in `src/utils/nativeInstaller/installer.ts` returns
`'claude'`/`'claude.exe'`; install/data dirs are `claude/versions`,
`claude/staging`, `claude/locks`, `~/.local/bin/claude`, `~/.local/share/claude`;
`src/utils/doctorDiagnostic.ts` does `which('claude')` and checks npm
`bin/claude`; `src/utils/localInstaller.ts` installs `…/local/claude`;
`src/utils/deepLink/registerProtocol.ts:resolveClaudePath` resolves
`~/.local/bin/claude`. These reference the **physical installed binary / data
dirs**, not user-facing "run this command" text. Renaming is a **breaking
install-layout change** (orphans existing data, breaks the auto-update migration
path) and is out of scope for a text-residual sweep. OCC's primary distribution
is the npm package `@cnwenf/occ` (bin `occ`); the native-installer path is
inherited from Claude Code and the `which('claude')` branch is gated behind
`isInBundledMode()` (not hit by npm installs). Tracked for a dedicated migration
issue. The `claude://` protocol and old-`claude`-alias cleanup messages are
legitimately `claude` (Claude Desktop protocol / removing upstream aliases).

## REPL / runtime verification (this release)

- `bun run build` → `injected MACRO.BINARY_NAME=occ`, `MACRO.VERSION=2.1.283`.
- `occ --help` → `Usage: occ [options] [command] [prompt]` (was `claude`).
- `occ mcp --help` → `Usage: occ mcp [options] [command]`.
- `occ daemon --help` → `Usage: occ daemon [options] [command]`.
- Unknown-option error path → no `claude` token.
- Zero `claude` command-name residue across all `--help` outputs.
- Exit banner (`gracefulShutdown.ts:180`) renders `occ --resume` via
  `${CLI_BINARY_NAME}` (spec: `test/e2e/resume-command-name.e2e.test.ts`,
  sandbox-stalled per OCC-11, unchanged by this work).
- `src/constants/__tests__/cli.test.ts` passes (binary name tied to
  `package.json.bin`).
- Biome lint on the three touched files: no new diagnostics (only pre-existing
  `suppressions/unused` warnings).

## Acceptance check

- [x] Complete audit checklist (this doc) posted to the issue.
- [x] Unified bin-name source (`CLI_BINARY_NAME`); all fix sites route through it.
- [x] All user-facing command names consistently `occ`; no `claude` residue.
- [x] REPL/runtime verification of `--help`, subcommand `--help`, error path.
- [ ] Merged to `main` + released (tag `v2.1.283`, `/releases` ↔ `/tags`).
