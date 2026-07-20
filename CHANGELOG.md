# Changelog

All notable changes to **OCC** (the independent open-source Claude Code–style coding agent) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

OCC tracks upstream Claude Code releases. The baseline catch-up is `2.1.204`;
versions above that are OCC-specific releases. Currently caught up through
Claude Code `2.1.215` — see `docs/upstream-version-gap-occ13.md` (OCC-13) for the
2026-07-20 no-gap confirmation (OCC already at official latest `2.1.215`),
`docs/upstream-version-gap-occ11.md` (OCC-11) for the 2.1.214→2.1.215 version-gap report,
`docs/upstream-version-gap-occ10.md` (OCC-10) for the 2.1.212→2.1.214 wave, and
`docs/upstream-version-gap-occ9.md` (OCC-9)
for the earlier 2.1.211→2.1.212 history.

## 2.1.276 - 2026-07-19

- **Catch up to Claude Code `2.1.215` (OCC-11).** OCC now aligns to official Claude Code `2.1.215` (was `2.1.214`). The entire 2.1.215 changelog is a single behavioral change: the model no longer auto-invokes the `/verify` and `/code-review` skills on its own — they are manual-only, invoked explicitly with `/verify` or `/code-review`. The skills themselves are unchanged.
- **No feature port required.** OCC never ported the auto-invocation that 2.1.215 removes (no auto-run logic, no system-prompt instruction to auto-run `/verify`/`/code-review` — grep-verified). OCC's behavior already matched 2.1.215: `/verify` and `/code-review` are manual-only skills. Binary-verified (2.1.214 vs 2.1.215 ELF): both skills still present, no new env vars / flags / settings / commands / contextual providers.
- **E2e (behavior-driven-done gate, `occ -p` pipe mode on built `dist/cli.js`):** (1) backend smoke — `occ -p` responds, prints `OCC 2.1.276`, no hang; (2) **core 2.1.215 contract verified** — after a work-producing turn (file create), the `Skill` tool was never auto-invoked for `/verify` or `/code-review` (the only "skill" mention was the SessionStart hook's stale prior-session summary, which itself says STALE-BY-DEFAULT / MUST NOT be re-executed) → silent unless explicitly invoked, matching official 2.1.215; (3) `/code-review low` on explicit manual invocation runs and emits a Code Review Report. Note: `/verify` is `USER_TYPE=ant`-gated in OCC (one of 6 ant-gated bundled skills) — pre-existing exposure, not a 2.1.215 regression and not auto-run; flagged separately. (Interactive tmux REPL didn't render in this sandbox — MCP-init stall / Ink alt-screen capture quirk; pipe mode reached the behavior per the skill's "prefer -p when it can reach the behavior" guidance.)
- **Doc bump:** README / README.zh-CN badges + CLAUDE.md "tracks `2.1.214`"→`2.1.215`; catch-up pointer updated to `docs/upstream-version-gap-occ11.md`.

## 2.1.275 - 2026-07-19

- **Catch up to Claude Code `2.1.214` (OCC-10).** OCC now aligns to official Claude Code `2.1.214` (was `2.1.212`). The 2.1.212→2.1.214 wave is one combined port (2.1.213 has no standalone changelog entry; its identifiers are folded into 2.1.214).
- **Security Musts (fail-open):**
  - `dir/**` single-segment allow rules now anchor to cwd (M1, #173)
  - Hook exit code 2 blocks even when stdout JSON fails schema validation (S24, #174)
  - Settings >2MiB / non-regular files rejected at startup (M9, #175)
  - Frontmatter `#`-truncation fix (M10, #176)
  - ISO `modified` timestamp on memory file save (M11, #177)
  - Docker daemon-redirect flags prompt (M7, #178)
  - `file -m/-f/--magic-file` requires permission (M6, #179)
  - `pkill -f` self-match: shell-function shim via ShellSnapshot (M8, #180/#187/#188)
- **Correctness:**
  - Commands >10,000 chars always prompt (M3, #182)
  - fd-redirect fail-closed on all output-redirect ops (M2, #184)
  - zsh `[[ ]]` subscripts prompt (M4, #185)
  - `help`/`man` with command substitution / backslash paths prompt (M5, #186)
- **Parity fixes (acceptance reviewer diverge fixes):**
  - M8: pkill shell-shim sole mechanism (permission-deny removed; 8-case arg-parser; printf em-dash) (#187/#188)
  - M9: `/dev/zero` message aligned to official text (#187/#188)
- **Doc bump:** README/CLAUDE.md/skill pointer updated from `2.1.211` to `2.1.214`.

## 2.1.274 - 2026-07-17

- **Catch up to Claude Code `2.1.212` (OCC-9, P0).** OCC now aligns to official Claude Code `2.1.212` (was `2.1.211`). Each feature is reverse-engineered from the 2.1.212 native ELF per the `aligning-with-official-binary` skill — binary-verified, no invention. 118/0 across the P0+GAP suite. Full per-feature recon + the `/fork` live-dispatch follow-up in `docs/upstream-version-gap-occ9.md`.
- **New feature: per-session WebSearch cap (`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`, default 200) + per-session subagent-spawn cap (`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`, default 200).** Both via a shared per-session `TaskRegistry` primitive (`getTotalAgentSpawns`/`incrementTotalAgentSpawns`/`resetTotalAgentSpawns` + `getWebSearchCalls`/`incrementWebSearchCalls`/`resetWebSearchCalls`) with a no-op stub for headless/SDK contexts. Stops runaway search loops / runaway subagent delegation; cap-exceeded returns the official's exact budget/limit message. (`src/utils/sessionLimits.ts`, `src/utils/taskRegistry.ts`, `src/tools/WebSearchTool/WebSearchTool.ts`, `src/tools/AgentTool/runAgent.ts`, `src/tools/shared/spawnMultiAgent.ts`, `src/Tool.ts`, `src/bootstrap/state.ts`, `src/screens/REPL.tsx`)
- **New feature: `claude auto-mode reset` subcommand.** Restores the default auto-mode config by removing the `autoMode` section from user settings. Confirmation prompt by default; `--yes` skips it. `--yes` **refuses** a lossy auto-reset when the settings file has entries this version can't parse (must run without `--yes` to review, or fix the entries first). Exact outcome codes + messages mirror the official `MbS`. (`src/cli/handlers/autoMode.ts`, `src/main.tsx`)
- **New feature: MCP tool calls auto-background after 2 min.** Long MCP tool calls move to the background so the session stays usable; the tool keeps running under its own `AbortController`, result delivered via the background-tasks system. Default `120000` ms, `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` override (clamp `[0, INT_MAX]`), non-interactive sessions opt in via `CLAUDE_AUTO_BACKGROUND_TASKS`. IDE-managed transports (`sse-ide`, `ws-ide`) are excluded (official `Fcy`). The model-facing message is the official verbatim text with elapsed seconds + TaskStop guidance + exit-survival note. (`src/services/mcp/autoBackground.ts`, `src/services/mcp/client.ts`, `src/tasks/McpBackgroundTask/McpBackgroundTask.ts`, `src/tasks/types.ts`)
- **New feature: `/fork` naming surface.** `/fork` derives the fork name via the official `uwd` (first 3 words → join `-` → lowercase → keep `[a-z0-9-]` → collapse `-` → trim edges → cap 24 → `||"fork"`) and writes a `custom-title` entry so the fork row is recognizable in the agent view; output gains the ` (fork)` suffix. `/fork` now requires a directive (`Usage: /fork <directive>` when absent). The `custom-title` `source` mirrors `/branch` `awd`'s `f = s ? "user" : "auto"`. (`src/commands/fork/name.ts`, `src/commands/fork/fork.ts`)
- **Known follow-up (NOT in this release): `/fork` live background-session dispatch (incl. GAP-6/7 agentId/same-name dedup).** The 2.1.212 `/fork` "copy into a new live background session (its own row in `claude agents`)" delta is deferred — the binary's `spawnBackgroundFork` dispatch is fragmented and OCC's `claude agents` live-dispatch is a REPL-internal path unreachable from `/fork`'s command context; per the never-invent rule it is not guessed. Tracked in `docs/upstream-version-gap-occ9.md` and the PR #172 follow-up section.

## 2.1.273 - 2026-07-17

- **New feature (OCC-8 follow-up): SSH image paste actually works under SSH.** The `2.1.272` Ctrl+V image paste found nothing on a remote dev box: the screenshot lives on your *local* Mac, the terminal paste channel only carries text, and the headless dev box has no clipboard/`xclip`/graphical session. This release adds two fallbacks *ahead of* the local-clipboard read, so bare Ctrl+V works under SSH:
  - **OSC 52 clipboard read (zero-config, terminal-dependent).** OCC asks the terminal for its clipboard via the OSC 52 read query (reusing the existing `TerminalQuerier` + DA1-sentinel pattern), so the image bytes come back from the terminal that *does* have your local clipboard. Works on iTerm2/kitty/wezterm (opt-in); refuses/ignores on Alacritty/Windows Terminal; needs `set -g allow-passthrough` under tmux. Wired into both the Ctrl+V/Cmd+V path (`PromptInput.handleImagePaste`) and the empty-bracketed-paste path (`usePasteHandler`). New: `osc52Read()` on `terminal-querier`, `src/utils/osc52ClipboardRead.ts`. (`src/ink/terminal-querier.ts`, `src/utils/osc52ClipboardRead.ts`, `src/components/PromptInput/PromptInput.tsx`, `src/components/BaseTextInput.tsx`, `src/hooks/usePasteHandler.ts`)
  - **Local Mac watcher (reliable, terminal-agnostic).** A macOS fswatch script watches `~/Pictures/Screenshots` and `scp`s each new screenshot to `~/.occ/clipboard-latest.png` on the dev box. OCC reads that file on Ctrl+V when OSC 52 and the local clipboard both miss. Env knobs: `OCC_SSH_HOST` (required), `OCC_SCREENSHOT_DIR`, `OCC_CLIPBOARD_WATCH_PATH`, `OCC_SCP_REMOTE_DIR`. launchd plist template + install/troubleshooting docs in `scripts/occ-clipboard-watch.md`. New read order: override → OSC 52 → watch path → local clipboard. (`scripts/occ-clipboard-watch.sh`, `scripts/occ-clipboard-watch.md`, `src/utils/imagePaste.ts`)

## 2.1.272 - 2026-07-17

- **New feature (OCC-8): REPL image paste for SSH/dev-machine workflows.** `chat:imagePaste` (Ctrl+V) now saves the clipboard image to a unique temp file and inserts the file **path** into the input box (instead of inlining base64), so the agent reads it via FileReadTool. This is the SSH-friendly path — it no longer relies on image bytes surviving the SSH terminal paste transport. `hasImageInClipboard()` is now cross-platform (Linux `xclip`/`wl-paste`, Windows PowerShell) instead of macOS-only, so the empty-paste clipboard check and the focus-regained hint also work on Linux dev machines. Added an `OCC_CLIPBOARD_IMAGE_SRC` env override: point it at an image file on the dev machine (e.g. `scp`'d there) and Ctrl+V drops that file's path into the REPL — also serves as the headless test hook. When no image is reachable, the SSH hint now suggests the `scp` + `OCC_CLIPBOARD_IMAGE_SRC` escape hatch. (`src/utils/imagePaste.ts`, `src/components/PromptInput/PromptInput.tsx`)

## 2.1.271 - 2026-07-16

- **Release-integrity re-publish (no new behavior vs `main`).** The published `2.1.270` npm artifact was built from a git tag (`v2.1.270` → `8530b17`) that had fallen 16 commits behind `main` HEAD (`6efd4a2`). Because `.github/workflows/publish.yml` builds from the pushed tag, the 2.1.270 package shipped **without** the `src/` behavior fixes that had already landed on `main` after the tag — most notably the `--forward-subagent-text` guard (`src/utils/forwardSubagentTextGuard.ts`, absent at the tag: `git cat-file -e v2.1.270:src/utils/forwardSubagentTextGuard.ts` → ABSENT) and the Grep invalid-regex pre-validation fix, plus the other post-tag `src/` fixes. `2.1.271` re-tags `main` HEAD so the published artifact includes every fix already on `main`. **No code or behavior change relative to `main`** — this is purely a tag/publish-integrity correction (the root cause surfaced by OCC-7's gap research and the acceptance officer's behavioral parity re-check). Verified post-publish: `npm view @cnwenf/occ version` → `2.1.271`, and the guard file is present in the published tarball.

## 2.1.270 - 2026-07-16

- **Behavior change** (CC 2.1.211 port): auto mode no longer overrides a PreToolUse hook's `ask` decision for unsandboxed Bash. When a PreToolUse hook returns `ask` and rules also require `ask`, the decision is floored at "prompt the user" — the auto-mode classifier cannot silently auto-approve or auto-deny. In headless mode where prompts are unavailable, the tool is denied. This ports the upstream `hookAskFloor` logic: `resolveHookPermissionDecision` now passes `hookAskFloor: true` to `canUseTool` when the hook returned `ask` and the rule check also returns `ask`, and `hasPermissionsToUseTool` respects this flag to prevent classifier override.

- **Fix: `occ` failed to launch after `npm i -g @cnwenf/occ` on glibc hosts** (OCC-6). The Node launcher shim (`bin/occ.cjs`) died with `occ: failed to launch bun: spawn .../@oven/bun-linux-x64-musl/bin/bun ENOENT`. Root cause: `bun` is an *optional* dependency, so npm does not link `bun` onto PATH — the shim had to fall back to the bundled `@oven/bun-*` platform binaries; but the `bun` meta-package ships both glibc and musl variants without an `os.libc` filter, so npm installs all of them, and the old shim's first-`existsSync`-true ordering picked the musl ELF on a glibc host (its `/lib/ld-musl-x86_64.so.1` interpreter is absent → ENOENT). The fix mirrors the official `@anthropic-ai/claude-code` `cli-wrapper.cjs`: detect the host libc via `process.report.getReport().header.glibcVersionRuntime`, restrict candidates to the matching libc only, resolve each package directory via `require.resolve(pkg + '/package.json')` (reliable, unlike `require.resolve('pkg/bin/bun')` which false-negatives on absent files / `exports`), and **probe-run** (`<bin> --version`) each candidate before committing so a present-but-unrunnable binary is skipped, not fatal. Verified in clean `node:20` (glibc), `--ignore-scripts`, and `node:20-alpine` (musl) containers. Added `test/launcher.test.ts` (9 tests) pinning the libc filtering and probe behavior.

## 2.1.269 - 2026-07-15

- Catch up to Claude Code `2.1.210` — 25 upstream-feature clusters ported from the official 2.1.206→2.1.210 binaries (every identifier binary-verified; each port passed the done-gate: real-not-stub, behavioral e2e, 903/0 regression suite, `occ -p` smoke). Full per-cluster recon + verdicts in `.occ-research/occ-vs-2.1.210-gaps.md`. User-facing highlights:
- **Screen-reader mode** (`--ax-screen-reader` flag / `CLAUDE_AX_SCREEN_READER=1` env / `axScreenReader` setting): a flat-text render path with no decorative borders or animations, a startup announcement `[Screen Reader Mode: on via <source>]`, and Shift+Tab permission-mode announce (routes through the SR announce-queue, drained by the flat-render line-diff). Ports CC 2.1.208 #1 + 2.1.210 #30.
- **Mouse-click multi-select + "Other" rows** in fullscreen menus: single-select click selects via `onChange`; multi-select click toggles; input/"Other" rows focus the option. Kill-switch `CLAUDE_CODE_DISABLE_MOUSE_CLICKS`. Ports CC 2.1.208 #4.
- **`vimInsertModeRemaps` setting** (e.g. `{ "jj": "<Esc>" }`): two-key remaps to exit INSERT mode, with a 1s inter-key timeout, grapheme + NFC key normalization, and a non-typeable-key exclusion set. Ports CC 2.1.208 #2.
- **Markdown table >200-row cap**: very large tables render a truncation notice instead of swamping the terminal. Ports CC 2.1.208 #12.
- **Bedrock streaming content-type guard**: `BedrockUnexpectedContentTypeError` + `assertBedrockStreamingContentType` raise a clear error on gateway-transformed streams (kill-switch `CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD`). Ports CC 2.1.208 #16.
- **Externally-managed launcher detection**: `/doctor` warns and the installer refuses/skips when OCC wasn't installed by the native installer (e.g. Homebrew or external script). Ports CC 2.1.207 #5.
- **apiKeyHelper 401 retry**: the API-key helper retries on `bad credentials` with a 2-attempt cap + clearer messages. Ports CC 2.1.208 #15.
- **Auto-mode permission classifier defaults to Sonnet 5** for external (non-first-party) sessions, resolved once per session and pinned. Ports CC 2.1.207 #1 + #20 + 2.1.210 #27.
- **Memory write over-limit guard**: writes that leave `MEMORY.md` over the read limit emit an explicit error (was silent truncation) plus an approaching-limit notice. Ports CC 2.1.210 #29. Refined in 2.1.211: the guard now measures only loaded content (strips frontmatter `---\n...\n---` and HTML comments `<!--...-->` before measuring), preventing false warnings when non-loaded content pushes the total over the limit.
- **MCP stdio stderr 64MB cap**: prevents unbounded MCP server stderr from OOMing the CLI. Ports CC 2.1.208 #29.
- **Plan-mode edited-by-user guard + stale snapshot**: detects user edits to files changed since the plan snapshot was taken. Ports CC 2.1.210 #12.
- **Pipe-mode output fixes**: `drainStdoutBeforeExit` flushes the pipe before exit (no truncated stream-json/JSON), and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` now parses scientific notation (`1e6`→1000000, not mantissa `1`). Ports CC 2.1.208 #10 + #11.
- Additional aligned ports: Read/Grep/Glob streaming accumulation + behaviors (208#14/#30 + 210#14), FileEditTool readEditContext/fileHistory (208#13/#34/#35), Bash/PowerShell timeout-backgrounding message (210#24), malformed bracket-glob handling (207#9), prompt-injection system-update false-positive fix (207#4), usage/MCP cost accounting (207#24 + 208#23/#43/#44), skills placeholder preservation (210#15), agent-tool improvements (208#22 + 210#3/#25), hooks timeout-vs-rejection semantics (210#9), context-window auto-update reset fix (208#8), workflows `CLAUDE_CONFIG_DIR` save path (208#25), model-defaults credential wiring (207#16/#19), and REPL-render fixes (210#1/#8). Items with no string delta 206→210 were verified already-aligned or honestly deferred (no invention) per the aligning-with-official-binary skill.
- Fix `occ` failing to launch after `npm i -g @cnwenf/occ` on machines that have npm but not Bun installed. The published `dist/cli.js` ships a `#!/usr/bin/env bun` shebang, so the kernel's shebang resolution failed with `/usr/bin/env: 'bun': No such file or directory` and `occ` never started. Added a Node bin shim at `bin/occ.cjs` (`#!/usr/bin/env node` — npm guarantees Node is present) that resolves a Bun binary in priority order — `$BUN_PATH`, `bun` on PATH (verified by an explicit PATH walk so the fallbacks below still get tried), `~/.bun/bin/bun`, the `@oven/bun-<platform>-<arch>` optional-dep platform binary (robust even under `npm --ignore-scripts`, since that package ships the real ELF/Mach-O/PE binary in the tarball with no postinstall needed), then the `bun` meta-package bin — and spawns `bun <pkg>/dist/cli.js <args…>`. If no Bun is available it prints a clear install instruction (`npm i -g bun` / `bun.sh`) instead of a cryptic env error. Added `bun` to `optionalDependencies` so `npm i -g @cnwenf/occ` pulls Bun automatically on machines without it. Behavioral e2e: (A) bun on PATH → launches; (B) no Bun anywhere → clear install message + exit 1; (C) no bun on PATH + `@oven/bun-linux-x64` installed via optionalDep, even with `--ignore-scripts` → shim resolves the platform binary via `require.resolve` and launches OCC.

## 2.1.268 - 2026-07-15

- Fix the `/tasks` background-tasks browser trapping the user in a blank screen when pressing Enter on a background `local_workflow` or `monitor_mcp` task. Both detail dialogs were auto-generated `() => null` stubs — they rendered nothing and bound no keys, so Esc/left-arrow/Enter did nothing and the only exit was force-quitting the REPL. Replaced both with real implementations following the canonical `ShellDetailDialog` keybinding pattern (Esc/Enter/Space → close, ← → back to list, `x` → kill the running task). `WorkflowDetailDialog` renders run id, duration, script path, summary, phases, agents, and logs; `MonitorMcpDetailDialog` renders status, runtime, and description. Also wired the missing `onDone` prop into the `monitor_mcp` case of `BackgroundTasksDialog` (mirrored the `dream` case).

## 2.1.267 - 2026-07-10

- Fix `phase()` primitive silently dropping callbacks: models authoring workflow scripts under ultracode (e.g. GLM-5.2) naturally write `phase('scan', async () => { ...parallel/agent... })` (the grouping-callback idiom from test frameworks). The previous `phase(title: string): void` signature ignored any second argument, so the callback never ran — the workflow returned `undefined` with 0 agents in ~1ms. `phase` now accepts an optional `fn?: () => T | Promise<T>` callback: when present, it runs within the phase grouping and its return value becomes `phase()`'s result. Backward compatible — `phase('title')` without a callback still just sets the phase and returns void (binary-parity contract preserved). Verified by a capture-proxy e2e (run5): with the fix the callback ran and the model received real scan results instead of `undefined`.
- Fix `parallel()` rejecting the model's natural call form with `thunk is not a function`: models write `parallel([agent(p1), agent(p2)])` (passing already-started Promises), but the primitive expected `Array<() => Promise<T>>` (thunks) and called each item as a function. `parallel` now auto-detects: functions are called under the concurrency semaphore (thunk path, unchanged); Promises and plain values are collected directly. Backward compatible — thunk-based scripts work identically. Verified by unit tests (promises, thunks, mixed, order-preservation, empty, non-array rejection).
- Document the `phase(title, fn?)` callback form in the Workflow tool description so models can discover it from the API surface.

## 2.1.266 - 2026-07-10

- Port ultracode per-turn reminders from official Claude Code 2.1.206: `workflow_keyword_request` (keyword-turn opt-in), `ultra_effort_enter("full")` on the keyword turn, `ultra_effort_enter("still")` on subsequent turns, and `ultra_effort_exit` when switching effort away from ultracode. The keyword turn now emits two reminders; later turns emit the "still" reminder. Matches the binary's dispatch table exactly.
- Wire the ultracode keyword trigger into headless/pipe mode (`-p`): `runHeadless` in `src/cli/print.ts` now calls `shouldTriggerUltracodeFromPrompt()` + `enableUltracodeForSession()`, so the keyword works outside the interactive REPL (was only wired in `processTextPrompt.ts`).
- Port the verbatim `**Ultracode.**` section + quality patterns (adversarial verify, loop-until-dry, multi-modal sweep, completeness critic, composing patterns) into the Workflow tool description. Surfaces via `prompt()` (which `toolToAPISchema` uses for the API `description` field, not `description()`).
- Add inline `script` field to the Workflow tool input schema (verbatim description from the 2.1.206 binary: "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }`..."). Models can now provide the full workflow script content directly in the tool call — no need to write a `.js` file to disk first. Mirrors the binary's `scriptPath | named | inline` invocation modes.
- Improve the Workflow script file-not-found error: now emits recovery guidance ("Create the file first (Write tool, or via shell if Write is unavailable), then retry with the same path") on `ENOENT`, matching the 2.1.206 binary. Previously the error was a bare `Failed to read workflow script ... ENOENT` with no recovery hint.
- Refactor `loadScript` to extract parse logic into `loadScriptFromSource(source, scriptPath?)` so inline `script` content and file-based `scriptPath` share the same parser.

## 2.1.265 - 2026-07-10

- Silence the inherited "Claude Code has switched from npm to native installer" REPL nag: OCC ships via npm as `@cnwenf/occ`, so the upstream notification mis-fired on every launch. Short-circuited `useNpmDeprecationNotification`
- Silence native-installer diagnostics in the REPL: `useInstallMessages` → `checkInstall()` would surface "installMethod is native, but directory X does not exist" and related shell-alias / symlink warnings whenever `~/.claude.json` carried a residual `installMethod: "native"` from a prior official Claude Code install. Short-circuited the hook

## 2.1.264 - 2026-07-10

- Fix `occ update` aborting with "Cannot update development build": `scripts/build.ts` now passes `define: { 'process.env.NODE_ENV': '"production"' }` to `Bun.build()` so the bundler bakes `NODE_ENV` to `"production"` (was defaulting to `"development"`, which made `getCurrentInstallationType()` short-circuit to `"development"` and block updates)
- React dev checks + warnings are now stripped from the production bundle (side effect of the NODE_ENV fix; ~0.5 MB smaller)

## 2.1.263 - 2026-07-10

- Fix version injection: `scripts/build.ts` now injects the real `MACRO.VERSION` from `package.json` into `dist/cli.js` (was hardcoded to the dev polyfill value, so every release reported a stale version)
- `occ --version` and "What's new" version comparison now use the correct package version

## 2.1.262 - 2026-07-10

- Point REPL "What's new" feed and `/release-notes` at OCC's own CHANGELOG (was fetching upstream `anthropics/claude-code`)
- Add `CHANGELOG.md` at repo root with OCC-specific release notes (v2.1.242–v2.1.261)
- Document the release workflow (version bump, tag, publish) in `CLAUDE.md`

## 2.1.261 - 2026-07-10

- Rebrand `occ --version` to print `OCC <version>` instead of the raw Claude Code version
- Set `MACRO.PACKAGE_URL` to `@cnwenf/occ` so update prompts point at the OCC npm package
- Point `occ update` at `@cnwenf/occ` and fix Bun global install path
- Auto-updater is now notice-only for OCC — it never auto-installs, only notifies on new versions
- Default `includeCoAuthoredBy` to `false` (no `Co-Authored-By` trailer on commits)
- Bump `puppeteer-core` to `^24` for Node 20 compatibility
- Make `update.ts` `spawnSync` monkey-patchable for CI

## 2.1.260 - 2026-07-10

- Add AI-powered `/feedback` command that collects logs + errors and drafts a GitHub issue via a prompt command
- Add rotating JSONL disk error logger with `MAX_ERRORS=20` tail merged into feedback context
- Capture `uncaughtException` + `unhandledRejection` into `logError`
- Tag API errors with `kind:'api'` in `logAPIError` for structured filtering
- Local error capture now works outside the cloud-provider gate

## 2.1.259 - 2026-07-07

- Catch up to Claude Code `2.1.204` — 23 upstream features + docs aligned
- Wire `WorkflowPermissionDialog` + `Ctrl+G` edit-script entry for workflows
- `/background` now backgrounds the live session (mirrors official Claude Code)
- Remove always-false gate so session backgrounding actually works
- Make `APIError` a value import so the retry path doesn't throw `ReferenceError`
- Remove TC39 `using` declarations for Bun `<1.3.14` compatibility

## 2.1.258 - 2026-07-07

- Complete the Workflow engine — real VM sandbox with all primitives + journal + `/workflows` command
- Add workflow UI: progress tree + `/workflows` dialog + permission dialog + result display
- Add `/skills` sort-by-token + `Ctrl+G` editor context + subagent-spawn classifier + did-you-mean suggestions
- Fix `occ -p` hang caused by `KAIROS`/`UDS_INBOX` flags re-enabling blocking subsystems

## 2.1.257 - 2026-07-07

- Add FleetView Phase 2: heartbeat + job actions + group mode + peek-reply + DIAG strip
- Add daemon B6–B12: SSH cold-start + `connectRemoteControl` + background-default + nesting + agent-id + implicit-team + PID namespace
- Add daemon B1–B5: background-agent supervisor + lockfile + worker registry + `ERESPAWN` + CLI
- Fix `grep` to fall back to system `rg` / `grep` when the builtin ripgrep binary is missing
- Add collapsible tool results — `maxHeight` + `e` to expand (aligns with official UX)

## 2.1.256 - 2026-07-07

- Add FleetView Phase 1: inline navigable agent/workflow list below the input
- Add FleetView Phase 3: daemon↔FleetView session bridge
- Add `#10` H4 WebBrowser tool — real implementation via `puppeteer-core` + system Chrome
- Fix `#11` F/I/J trivial gaps + `/plugin` alignment
- Add ultracode-ux: input-box blue+shimmer highlight + persistent top-right effort badge

## 2.1.255 - 2026-07-07

- Add daemon-worker async launch matching official remote CCR
- Retain completed workflows for `/workflows` browsing
- Fix `WorkflowDetailDialog`: flatten `RunLine` to avoid nested `<Text>` in `Select`
- Fix `/goal`: single `metaMessage` + `WorkflowDetailDialog` per-agent rows
- Swap dark/light theme palettes to match official (ultracode badge, etc.)
- Add FleetView `Enter`-to-dispatch + navigable dispatch list (aligns official UX)

## 2.1.254 - 2026-07-07

- Add final alignment batch C9+D5+G2+B7+B2+I14
- Add in-process async (`NO-OP setAppState`) + UX keybindings/commands alignment
- Confirm `F28 CLAUDE_CODE_ENABLE_AUTO_MODE` + `K2` streaming done
- Add 19 alignment fixes: hooks D1-D18 + commands E8-E15 + F23/H14 + I16d/e + A4
- Add 11 alignment fixes: `/stop` `/background` `/daemon` `/update` + C6/C7 + D14/D6 + G3 + I10 + F32
- Add 10 alignment fixes (J4/KB/H5/B11/H13/F27/G7/D9/D10/D16)

## 2.1.253 - 2026-07-07

- Add comprehensive bilingual documentation (EN 20 files + ZH 20 files + README)
- Reorganize docs: `en/` + `zh/` at top level, whitepaper moved to `architecture/`
- Remove old whitepaper directory — to be rewritten per Claude Code structure

## 2.1.252 - 2026-07-07

- Fix `workflow-detail` subtitle: `<Box>` inside Dialog's `<Text>` caused Box-in-Text crash
- Fix `acceptance`: `/goal` status icons + `Workflow scriptPath` optional
- Add `[esc]` dismiss hint to all panel inputGuides

## 2.1.242 - 2026-07-07

- Baseline catch-up version — aligns OCC with Claude Code `2.1.204` feature surface
- 6 live feature flags: `TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`, `MONITOR_TOOL`, `WORKFLOW_SCRIPTS`, `EXPERIMENTAL_SKILL_SEARCH`, `MCP_SKILLS`
- Stubbed/removed: Computer Use, `*-napi` packages, Analytics/GrowthBook/Sentry, Magic Docs, Voice Mode, LSP Server, Plugins/Marketplace
