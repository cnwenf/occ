# Changelog

All notable changes to **OCC** (the independent open-source Claude Code–style coding agent) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

OCC tracks upstream Claude Code releases. The baseline catch-up is `2.1.204`;
versions above that are OCC-specific releases. Currently caught up through
Claude Code `2.1.211` — see `docs/upstream-version-gap.md` for the version-gap
report and `.occ-research/` for the upstream catch-up changelog.

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
