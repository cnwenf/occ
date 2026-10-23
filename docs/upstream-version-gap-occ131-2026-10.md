# Upstream version gap — OCC-131 round (official claude-code 2.1.308 → 2.1.309)

Round date: 2026-10-24. Issue: OCC-131. Branch: `agent/occ/8ab7772c` (base `c4d4165f`, v2.1.401).
This is the authoritative ledger for the round. Per-item research detail lives in `docs/gap-research-309/`
(triage-T1..T4 + changelog items) and the forensics report (archived summary in §2.3 below).

## §1 Baseline

| | OCC (before round) | Official |
|---|---|---|
| Tracked version | 2.1.308 (partial), release v2.1.401, HEAD `c4d4165f` | **2.1.309** (npm `latest`/`next`; `stable` dist-tag still 2.1.308) |
| Changelog items | — | 79 (2.1.309 section, `/tmp/cc-CHANGELOG.md` lines 3-84) |
| Binary (linux-x64 ELF) | — | BIN308 `vprev/package/claude` md5 `b6f2a180949e09189d748852a49535cd`, 292,232,560 B → BIN309 `vver/package/claude` md5 `f7ab0febdb48bc73f98c89867ce81d26`, 293,469,552 B |
| Version-string census | — | BIN309: `2.1.309` ×2839, `2.1.308` ×1 (residual) |
| Forensics method | — | read-only: `strings -n 8`, `comm -13` sorted diffs, `grep -aboF` byte offsets, bounded `dd`. **Official binaries were never executed.** |

## §2 Triage — all 79 items

Verdict counts after cross-agent reconciliation: **PORT 23 · STAGED 21 · N-A 35** (79 total).
Full per-item evidence (OCC surface, current behavior, official byte offsets, action) in
`docs/gap-research-309/triage-T1.md` (items 1-16, chunks T1-A/B/C/D), `triage-T2.md` (17-40),
`triage-T3.md` (41-57), `triage-T4.md` (58-79).

### 2.1 PORT — 23 items (landed this round)

| Item | One-line | OCC target |
|---|---|---|
| 1 | Sandboxed Bash ran the user shell's startup files outside the sandbox before each command → spawn `/bin/sh -c <wrapped>` for sandboxed POSIX + `sandbox_wrap_unconfined` abort | `src/utils/Shell.ts:335-357` |
| 3 | Sandboxed commands / auto-accepted edits could modify the `--mcp-config` file → denyWrite protection | `src/utils/sandbox/sandbox-adapter.ts:563-648`, `src/utils/permissions/filesystem.ts:230-258`, `src/main.tsx` (--mcp-config parse) |
| 10 | Worktrees/branch checkouts now ignore git replace refs (`GIT_NO_REPLACE_OBJECTS=1` via the central builder — official `aor`→`air`: default-inject + removed from scrub list, BIN309 @240286082) | shared git-env builder (new), `src/utils/worktree.ts` |
| 12 | Nested CLAUDE.md over the size limit loads only its start (budget `max(40000, ctx×0.05×4)`, cut at last newline, surrogate-safe, banner `> Only the start of this file is shown. For the rest, call Read on <path> with offset=<lines+2> and a limit.`, `nested_file_cut` telemetry, `isPartialView` seed) — BIN309 @126474228/@252513483 | `src/utils/attachments.ts:1891,1049`, `src/utils/memoryThreshold.ts` |
| 14 | Key-bound slash commands no longer run in the shell from `!` mode (`inputModeOverride:'prompt'` extended to the keybound-command loop, BIN308 @273947007 → BIN309 @274974889) | `src/hooks/useCommandKeybindings.tsx:78-85`, `src/screens/REPL.tsx` onSubmit |
| 16 | Long tool-output previews no longer cut through an emoji (`re(e,i)` surrogate-safe slicer replaces raw `.slice`, BIN309 @247455011; slicer body `function fe(e,t){…replace(/[\uD800-\uDBFF]$/,"")}`) | `src/utils/toolResultStorage.ts:355` + shared `safeSlice` util (also used by item 12) |
| 20 | `claude remote-control` status line showed literal `HEAD` for a non-git folder → `not_a_repo` sentinel | `src/utils/git/gitFilesystem.ts:617` |
| 21 | Split-pane / separate-window teammates now inherit the leader's `--tools` / deny rules | `src/utils/swarm/spawnUtils.ts:38`, `src/tools/shared/spawnMultiAgent.ts:253-318` |
| 23 | `/rewind` list showed "No code changes" for turns that changed files via Bash / subagent / `/code-review --fix` | `src/components/MessageSelector.tsx:739-742`, `src/utils/forkedAgent.ts:528` |
| 24 | `/privacy-settings` showed a session-memoized stale "Help improve our AI models" value; now says when the setting can't be fetched (=F-9) | `src/services/api/grove.ts:58`, `src/commands/privacy-settings/privacy-settings.tsx:6` |
| 25 | Feedback said "try again later" when the org doesn't accept feedback → server's reason + bug-report pointer (=F-10a) | `src/components/Feedback.tsx:216-219,546-553` |
| 26 | Oversized `/feedback` failed → resent without the transcript (`fitFeedbackPayloadToBudget`; "Feedback payload too large" is a minifier false-positive per forensics — pre-existing in 308) (=F-10b) | `src/components/Feedback.tsx:180-198,514-521` |
| 27 | A skill in an `--add-dir` folder is now offered as `<folder>:<name>` when another skill holds its name (=F-12) | `src/skills/loadSkillsDir.ts:1090-1128,847-867`, `src/commands.ts:406` |
| 32 | PowerShell hooks now block when the hook program exits code 2; `"shell":"powershell"` PreToolUse/PermissionRequest hooks no longer fail open when Git for Windows is missing | `src/utils/shell/powershellProvider.ts:12-18`, `src/utils/hooks.ts:1935-1938` |
| 37 | Fine-grained tool streaming now on for Bedrock when `ANTHROPIC_BEDROCK_BASE_URL` is the default `bedrock-runtime.<region>.amazonaws.com` | `src/utils/api.ts:221-233`, `src/utils/model/providers.ts:149-167` |
| 41 | Windows PowerShell permission checks no longer auto-approve `Set-Location`/`cd` to the current dir carrying extra args | `src/tools/PowerShellTool/powershellPermissions.ts:1392-1408` |
| 42 | macOS CLT: official 309 module is `Lvn` message @240801195 + predicate `JNe(n,e){return!1}` @240801245 — a **false stub** in the linux binary, but wired at 3 real call sites (git-spawn guard @240891566 returns `{stdout:"",stderr:Lvn,code:127}`; settings-tracking @242744613; `gitAvailable` cache @249720743). PORT = dormant byte-parity: message constant + faithful predicate + guard shape, filedoc-declared (no invented darwin logic) | new module + git-spawn helper guard |
| 44 | Claude Code's own git commands now always run in English (`LC_ALL=C`+`LANGUAGE=C`, `userLocale` opt-out) + Windows speed (=F-2: frozen `b=Object.freeze({LC_ALL:"C",LANGUAGE:"C"})`, builder `Ts(e,r={})`) | shared git-env builder, `src/utils/execFileNoThrow.ts:136`, `src/utils/git.ts` |
| 46 | Disk-full: Bash cut off by a full disk says so and names the folder; full temp volume prints a clear message, not raw ENOSPC (=F-7; verbatim texts @249267257/@252265507) | `src/utils/Shell.ts:87-89` `formatDiskFullStartError` + Bash cut-off path |
| 52 | `sed -i` gets the standard Bash prompt and runs as written (no simulated file-edit preview); excluded from `/rewind` (=F-5) | `src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:96-110`, `src/tools/BashTool/BashTool.tsx:258-273,440-497,812-813,629`, `sedEditParser.ts`, `SedEditPermissionRequest.tsx` |
| 54 | Dangerous-rm deny message parity: `…or this session cannot prompt).` → `…or none was shown.` (BIN308 2 hits → BIN309 0; `none was shown` 0 → 2 @125537381/@254010415; builder `XOr` @32644128). Desktop/VSCode-host scoping half = N-A (host not shipped; OCC already denies immediately) | `src/tools/BashTool/dangerousRmAutoDeny.ts:109` + 2 test files |
| 56 | Worktree creation/reuse: `GIT_NO_LAZY_FETCH=1` (=F-4 core, folded into the shared builder); partial-clone detection (`extensions.partialclone`/`remote.*.promisor`/`remote.*.partialclonefilter`); explicit promisor pre-fetch when a Bash sandbox is configured; verbatim diagnostics ("on-demand fetching switched off" ×6 new, `[worktree] explicit fetch from ${remote} failed:`) | `src/utils/worktree.ts:301,350,516,549-566` |
| 66 | [VSCode] feedback error showed only an HTTP status when the org doesn't accept feedback — portable delta deduped into items 25/26 (shared org-refusal reason plumbing); the VSCode-extension surface itself is N-A for OCC | `src/components/Feedback.tsx` (with 25/26) |

Forensics add (not a changelog item): **F-20 CLI CA-store diagnostics** — "No certificate authority to trust…",
"every certificate in the system CA store is expired…" (~@129588000, new in 309, absent from OCC `src/utils/caCerts.ts`) → PORT.

### 2.2 STAGED — 21 items (recorded, not implemented)

| Item | Reason |
|---|---|
| 2 | macOS `denyWrite` glob real-location twins — needs unported `realPathTwins` machinery + `tengu_hushed_caraway` gate |
| 4 | Disabled MCP server reconnected by later permission prompt — needs 309 unified-snapshot-config + `mcp-config-changed` rebuild |
| 5 | Bash redirect-failure variable trust — needs unported `INJECTED_SHELL_VARIABLE_CODE_DETECTION` AST parser |
| 6 | Compound `cd`-then-git prompting — needs 309's reworked `commandMayBeGit` recursive splitting |
| 7 | `Edit(path)` deny vs Bash redirect in subshell — OCC already immune; needs bash-prefix-parser port for structural parity |
| 8 | Worktree-isolation locale-prefixed command guard (see T1-C) |
| 9 | Worktree-isolation zsh arithmetic guard (see T1-C) |
| 13 | ctrl+enter send-now: fix lives in the low-latency submit engine (`isDispatchingForModel` on `RAe` guard) — engine unported (sendNow.ts Phases 2-4); porting the guard alone = dead code |
| 15 | ctrl+o "Waiting to be delivered" (=F-11) — view over the inter-session delivery backend (`deliveryId`, UDS inbox); UDS_INBOX/KAIROS dead in OCC |
| 18 | Claude-Desktop-hosted session message loss — desktop transport unported |
| 28 | `/verify` `/code-review` nested-package skill on shell-changed files — shell-touched-files mechanism not byte-pinnable |
| 38 | "Waiting for API response" route-dependent 20s/45s (=F-1) — string absent from OCC src; no ping-aware banner / first-byte-timeout subsystem (prior-round A5) |
| 39 | GitHub role-name/placeholder mentions notifying users — fix mechanism not byte-pinnable |
| 45 | Hooks module nested-too-deep error names file (=F-8) — STAGED per forensics |
| 47 | /claude-api skill API-tracing offer — skill-content corpus unported (OCC skill .md files are stubs) |
| 48 | /claude-api skill live-docs check — same |
| 49 | Self-hosted runner interrupted-tool-call "outcome unknown" (=F-16 adjacent) — runner surface |
| 51 | /claude-api skill SA-key/WIF OTel destinations — skill-content corpus |
| 53 | `claude ultrareview` workspace trust (=F-6) — needs unported `offerBridgeWorkspaceTrust`/`canPromptForWorkspaceTrust` asker; flag/env portable in isolation but no faithful prompt/refusal path to attach to |
| 55 | Sandbox-excluded commands ask-before-write while sandbox enabled-but-cannot-run — exact decision predicate not recoverable from strings (STOP per skill; needs dedicated per-site decompilation) |
| 57 | /claude-api Managed Agents `multiagent_20261001` — changed text inside zst payload; corpus + cloud backend unported |

Forensics-only STAGED: **F-13** `CLAUDE_CODE_RESUME_SHOWS_CUT_OFF_CALLS` (env+killswitch-gated experimental;
resume-tail taxonomy untracked in OCC), **F-15** `CLAUDE_CODE_SYNC_PLUGINS_DOWNLOAD_CONCURRENCY` (claude.ai
plugin-sync surface trimmed in OCC).

### 2.3 N-A — 35 items

11 (profile-store symlink — already covered by OCC's realpath-based protection) · 17 (PDF page-range ENOENT —
OCC **structurally immune**: unsandboxed `execa` render + plain `Error` rethrow, errno-gated branch unreachable) ·
19, 29, 30, 31, 33, 34, 35, 36 (desktop-app multi-account / claude-api skill `.md` content stubs OCC-44 / mods
`turn.step` / claude.ai sync / artifact cloud subsystem) · 22 (`/rename` leak — **already aligned**: OCC stores
`custom-title` vs `ai-title` separately, resume-safe) · 40 (Linux sandbox deny lifetime — OCC **immune**:
`denyWrite` rebuilt per command, no session state; nested-userns bypass already patched in the 2.1.305 backport) ·
43 (self-hosted runner `--startup-timeout-min`) · 50 (bundled dataviz skill content) · 58-65, 67-79 (VSCode
extension UI, Cloud sessions web UI, Claude Tag/Slack, Code Review cloud — surfaces OCC does not ship).

Forensics-only N-A: **F-14** `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MSG` (registry-only name, no reader in 309) ·
**F-16** (runner outcome-unknown — strings pre-existing, wiring-only) · **F-17** (item-1 native side — no portable
JS delta beyond what WP-sandbox ports) · **F-18** (pure-Anthropic-surface umbrella).

### 2.4 Reconciliation notes (errata vs `docs/gap-research-309/README.md` first draft)

1. **Items 15/16 were transposed** in the README WP table: 15 = ctrl+o waiting messages (STAGED, T1-D),
   16 = emoji-preview slicer (PORT, T1-D). This ledger is correct.
2. **Items 53/54 were transposed** in the README WP table ("WP-ultrareview | 54"): 53 = ultrareview trust
   (STAGED, T3), 54 = dangerous-rm deny message parity (PORT, T3).
3. **Item 10 promoted STAGED→PORT**: T1-C staged it because "OCC has no unified git-env builder surface" —
   but F-2/F-3 recovered the full frozen builder (`M`, `b`, `Ts`, `air` semantics, scrub list, `vTt`
   `-c safe.bareRepository=explicit -c protocol.file.allow=never`), and items 44+56 require that builder
   this round anyway. The builder is ported with `air`'s 309 semantics (`GIT_NO_REPLACE_OBJECTS:"1"` as a
   merge default; scrub list `["GIT_LFS_SKIP_SMUDGE","GIT_NO_LAZY_FETCH"]`), which lands item 10 faithfully
   for every call site routed through it.
4. **Item 42 resolved PORT (dormant parity)**: the official predicate `JNe` is a false stub in the linux
   binary; call sites verified real (@240891566/@242744613/@249720743). OCC ports the message + predicate +
   guard shape byte-faithfully with a filedoc deviation note; no darwin behavior is invented.
5. **F-1/F-11 downgraded to STAGED** vs the forensics priority table (subsystem gates above); **F-4 upgraded
   to PORT** for its core (env + detection + verbatim diagnostics) per T3's item-56 byte evidence.
6. Minifier false positives confirmed (forensics): `GATEWAY_HINT_HEADERS`, `SIMULATE_PROXY_USAGE`, the 45000
   spinner constants, "Feedback payload too large" — all pre-existing in BIN308; trailing-char env names
   (e.g. `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS6`) are artifacts.

### 2.5 Security-relevant items this round

Items **1** (sandbox startup-file escape), **3** (MCP-config write protection), **16** (transcript JSON
integrity), **10/44/56** (git env hardening: replace refs, locale, lazy fetch, scrub list,
`safe.bareRepository=explicit`, `protocol.file.allow=never`, `GIT_SSH_COMMAND:"false"` unless ssh allowed) —
flagged for the 安全审核员 backdoor audit in the handoff.

## §3 Implementation

Eight disjoint work packages, developed in parallel (no shared files):

| WP | Items | Files (exclusive owner) |
|---|---|---|
| A git-env | 10, 44, 56, 42, 20 | new `gitEnv` module, `execFileNoThrow.ts`, `git.ts`, `worktree.ts`, `gitFilesystem.ts`, new macos-git-missing module |
| B sandbox | 1, 3, 46 | `Shell.ts`, `sandbox-adapter.ts`, `permissions/filesystem.ts`, `main.tsx` (--mcp-config) |
| C context | 12, 16 | `attachments.ts`, `toolResultStorage.ts`, new `safeSlice` util |
| D input | 14 | `useCommandKeybindings.tsx`, `REPL.tsx` |
| E feedback/privacy | 24, 25, 26, 66 | `Feedback.tsx`, `grove.ts`, `privacy-settings.tsx` |
| F perms | 32, 41, 37 | `hooks.ts`, `powershellProvider.ts`, `powershellPermissions.ts`, `api.ts`, `model/providers.ts` |
| G bash/rewind | 52, 54, 23 | `BashTool.tsx`, `BashPermissionRequest.tsx`, `sedEditParser.ts`, `SedEditPermissionRequest.tsx`, `dangerousRmAutoDeny.ts`, `MessageSelector.tsx`, `forkedAgent.ts` |
| H misc | 21, 27, F-20 | `spawnUtils.ts`, `spawnMultiAgent.ts`, `loadSkillsDir.ts`, `commands.ts`, `caCerts.ts` |

_(Per-WP results, deviations and test evidence: filled in after implementation — see §4.)_

## §4 Tests

_(Full suite + build + Docker e2e + tmux REPL round-trip results: filled in after verification.)_

## §5 Acceptance

_(Consistency-vs-official-2.1.309 acceptance axis: filled in after verification.)_

## §6 Release record

_(Release v2.1.4xx, tag/publish.yml/npm-E404 status, releases↔tags symmetry check: filled in at release time.)_
