# Upstream Version Gap — OCC-160 round (official 2.1.300 → 2.1.301)

- **Date**: 2026-10-17
- **Issue**: OCC-160
- **OCC before**: release `2.1.385`, tracks official `2.1.300` (OCC-118 round ledger: `docs/upstream-version-gap-occ118-2026-10.md`)
- **Official latest (npm)**: `2.1.301` (published 2026-10-15T14:34:23Z; `next` = 2.1.302 — out of scope this round, tracking `latest` only)
- **Binaries** (linux-x64, forensics only — never executed):
  - 2.1.300: md5 `db0f0a5dc2fd7f82584283d4817b61a1`, 266,972,344 bytes (matches the OCC-118 ledger record)
  - 2.1.301: md5 `7f52c3d8eda2796a6002cb7380aabfb9`, 267,955,384 bytes (+983,040)
- **Strings diff**: `strings -n 8 | sort -u` → 300: 325,730 lines; 301: 326,698; new 17,819 / removed 16,851 (mostly minified-identifier churn).
- **Changelog**: 57 entries under `## 2.1.301` in the official CHANGELOG.md (raw.githubusercontent.com/anthropics/claude-code/main).

## 1. New env-var surface (token-set diff, artifact-filtered)

Genuinely new in 2.1.301 (grep -c verified against both full string sets):

| Env var | 300 | 301 | Verdict |
|---|---|---|---|
| `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` | 0 | 4 | **PORT** (WP-A) — changelog-documented |
| `CLAUDE_CODE_ATTACHMENTS_IN_USER_DATA` | 0 | 5 | N-A — not in changelog; attachment-store location flag in the internal env registry table (@103279328, adjacent to `CLAUDE_CODE_SLEEP_COMPACT`, `CLAUDE_CODE_JIT_POLICY_AFTER_STARTUP` etc.); no observable behavior surface recoverable without deep decompilation of the attachment store; STAGED-watch |
| `CLAUDE_CODE_DAPPER_CUPCAKE` | 0 | 3 | N-A — internal codename flag (`tengu_dapper_cupcake` @107371408) in the GitHub-comment-posting relay surface ("alreadyPosted/commentUrl/refreshedBehindModel") — backend-coupled, not portable |

All other `NEW env tokens` from the raw comm diff are minification-adjacency artifacts (trailing identifier chars; each has a mirror in the "removed" set with a different trailing char — e.g. `…AUTOINSTALL4`/`…AUTOINSTALLH`). Verified removed: none genuine.

## 2. Changelog triage (57 entries)

### PORT (byte-verified this round, via parallel work packages)

| # | Entry | WP | Evidence anchor (v301 ELF) |
|---|---|---|---|
| P1 | `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` — unattended retry mode ends a request at a usage limit that resets too far away instead of waiting | WP-A | code @228699313 (429 branch), accumulation @228701537, ledger init @228688688 (`capacityWait:{spentMs:0,usageLimitSpentMs:0}`), export map @216688553; constants `esn="anthropic-ratelimit-unified-overage-status"`, `g9e="anthropic-ratelimit-unified-overage-disabled-reason"`, `pvn=300000`, `mvn=21600000`; new telemetry reason `api_request_usage_limit_wait_too_long` (300=0, 301=2) |
| P2 | Grep/Glob: search program failed unexpectedly before returning results → error, not "no matches" | WP-B | `RipgrepOutputError` + message "The search failed, so this is not a \"no matches\" result: … Do not run a recursive search in the shell instead (for example grep -r, find or rg): it can reach what this tool is set to leave out…" @108889808; telemetry "ripgrep unexpected exit with no results"; `RipgrepAbnormalExitError` "Search failed. ripgrep rejected the pattern, glob, or…" adjacent; both absent from 300 |
| P3 | OTEL `tool_decision`: `classifier_verdict` + `permission_mode` | WP-C | `classifier_category` 300=0→301=2; `classifier_verdict` 300=2→301=3 (token region @ "matchingAllowRules…classifierAllowed…classifier_category"); OCC emitter exists (`src/hooks/toolPermission/permissionLogging.ts` `logOTelEvent('tool_decision', {decision, source, tool_name})`) |
| P4 | OTEL `tool_decision`: `classifier_category` (built-in rule a classifier block matched, under `OTEL_LOG_TOOL_DETAILS=1`) | WP-C | same as P3 |
| P5 | vim `%` motion: jump to matching bracket, alone or with d/c/y | WP-D | OCC `src/vim/motions.ts` has no `%` (grep 0 hits); official motion table in 301 ELF |
| P6 | vim: fixed staying in INSERT after Escape on slow/busy machine | WP-D | 301 vim transition region |
| P7 | vim: Esc discarding typed AskUserQuestion answer — free-text field supports vim NORMAL, Esc cancels only from NORMAL | WP-D | 301 AskUserQuestion region |
| P8 | skills/commands arg-name fill cap: first 64 names × 64 chars (stall fix) + placeholder memory fix | WP-E | 301 arg-expansion region (two changelog entries, one mechanism) |
| P9 | Read tool: binary files (.xlsm, .parquet, .epub, .heic …) read as text | WP-F | NEW dotted binary-extension list ONLY in 301 (`.flac/.aac/…/.parquet/.feather/.npy/.npz/.pickle/.psd/…` region; v300 has no such list); OCC `FileReadTool.ts:842` message exists, list needs alignment |
| P10 | `fable`/`best` alias erroring when newest Fable unavailable → retry once on previous Fable | WP-G | 301 model-alias fallback region; OCC `src/utils/model/model.ts` case 'fable' exists |
| P11 | VTE <0.53 (MATE Terminal/RHEL 8): stray `>0q` on folder-trust prompt + `>4m` before shell prompt at exit | WP-H | extends OCC-113's `52;c` suppression; OCC sites `src/ink/terminal.ts`, `src/ink/termio/osc.ts`, `src/utils/env.ts` |
| P12 | iTerm2: stray `GOK` text in prompt at startup | WP-H | 301 terminal-quirk region |

### STAGED (real gap, needs dedicated per-site decompilation — not guessed this round)

| # | Entry | Rationale |
|---|---|---|
| S1 | Quit removes `WorktreeCreate`-hook worktree without asking when it may hold unpushed commits | OCC has the WorktreeCreate hook (OCC-118 #24) but the quit-time cleanup prompt chain needs its own forensics pass |
| S2 | "Please run /login" misleading on full disk → name the disk, say delete files | auth-refresh error path; needs login-refresh decompilation |
| S3 | Workflow agents skipping step + run reporting success after harness note ("task text carries no user authority") | OCC workflow engine live; the harness-note acknowledgment semantics need careful prompt-region diffing |
| S4 | Sign-in refresh timeouts / unexpected sign-outs after short command exits mid token-refresh | auth lifecycle race; deep subsystem |
| S5 | Tool call cut off by mid-turn message during permission check reported to model as user-rejected | OCC has the misreport test surface; the mid-turn abort classification change needs per-site forensics |
| S6 | Model switch to smaller context window: summarize by previous model first + don't spend credits without asking (2 entries) | coupled compaction/credits subsystem change |
| S7 | Repeated compaction on unpicked model behind LLM gateway naming a different model | gateway model-identity trust; coupled with S6 region |
| S8 | Markdown header-only table draws nothing when too wide (incl. plan approval card) | table layout algorithm; renderer forensics |
| S9 | Skills not listed to model after `/rewind` | rewind + skill-listing interaction |
| S10 | Resumed-session compaction row offering ctrl+o for unloaded history → path text + fullscreen | row-renderer state |
| S11 | "new task? /clear to save tokens" hint returns right after interrupt | hint-gating state machine |
| S12 | Plugin/skill hook `ask` prompt not showing source plugin/skill | permission-prompt provenance |
| S13 | `/diff` reftable conflicted cherry-pick/revert when a git check timed out/failed | extends OCC-118 #29; timeout-branch forensics |
| S14 | Workflow scripts asking permission / refused after Bash `cd` in same session | path-resolution vs permission-rule interplay |
| S15 | Dim text on dark ANSI theme + 16-color terminals (3 sub-behaviors) | extends OCC-118 #47 faintInk; theme-layer forensics |
| S16 | `application-inference-profile` model name running `awsAuthRefresh` when provider ≠ Bedrock | provider-gate one-liner candidate but the auth-refresh call graph needs verification |
| S17 | Subagent progress trail incremental rendering (perf) | render-pipeline rework |
| S18 | Fullscreen `/compact` + auto-compact UI freeze | OCC fullscreen surface partial |
| S19 | Windows: stopped background PowerShell missing closing `[killed]` line | Windows-only path; OCC PowerShell background surface needs verification |

### N-A (not applicable to OCC's trimmed surface)

| # | Entry | Reason |
|---|---|---|
| N1 | `claude-api` skill OTel tracing guidance incl. `ant` CLI | Anthropic-internal `ant` CLI; OCC's bundled claude-api content is its own |
| N2 | mod `Input` `rows` field | OCC ships no mods system (grep: no mod-hook surface) |
| N3 | mod `$.model.fork` nothing-to-fork before first response | mods N-A |
| N4 | mod hook `.catch` semantics change | mods N-A |
| N5 | mod `$.env.set` resolve shape | mods N-A |
| N6 | mods tree above question dialog (48 rows Markdown) | mods N-A |
| N7 | artifact updates refused under PreToolUse Edit/Write hook → edit+republish | OCC ships no Artifact publish system (only ReviewArtifactTool) |
| N8 | artifacts sticky-header band (mobile apps) | artifacts N-A |
| N9 | Self-hosted runner ×3 (Slack MCP restricted settings; deleted-source-branch misreport; release-retry log count) | runner-backend coupled (OCC keeps only a trimmed runner surface) |
| N10 | [VSCode] ×6 (LaTeX math, Get-more-usage link, crash-loop reopen, thinking re-parse, diagnostics rule code, dictation audio module) | OCC ships no VSCode extension |
| N11 | /claude-api skill CMEK external-key endpoint text | skill .md content fix for official bundled skill text; OCC claudeApiContent is its own doc surface — fold into N1 |
| N12 | Cloud-session entries (none separate this round beyond runner/mods) | — |

Tally: **PORT 12 (via 8 WPs) · STAGED 19 · N-A ~26** (some changelog entries bundle sub-behaviors; counts are per entry).

## 3. Work-package plan (parallel subagents, disjoint file clusters)

- **WP-A** retry-watchdog usage-limit budget — `src/services/api/withRetry.ts` (+ ledger type at `modelCallRetries.capacityWait`), new env parser `getRetryWatchdogMaxUsageLimitWaitMs()` mirroring the existing `getRetryWatchdogMaxWaitMs()` (digits-only int ≥1 descriptor). Official spec (byte-verified):
  - ledger gains `usageLimitSpentMs:0`;
  - in the watchdog 429 branch, when `retryAfter!==null && headers['anthropic-ratelimit-unified-status']==='rejected'`: `remaining = (MAX_USAGE_LIMIT_WAIT_MS ?? ∞) − usageLimitSpentMs`; if `retryAfterDelay > remaining`: read `overage-status` header → `usable = v==='allowed'||v==='allowed_warning'`; if `remaining<=0 || (!usable && headers['anthropic-ratelimit-unified-overage-disabled-reason']!=='fetch_error')` → log `api_request`/`api_request_usage_limit_wait_too_long` + throw CannotRetryError; else delay = `usable ? min(remaining, backoff(K,null,300000,rand)) : remaining`; mark usageLimitWait flag (official `Vr=cn`);
  - heartbeat-chunk accounting: `if (watchdogRetryable) { spentMs += chunk; if (usageLimitFlag) usageLimitSpentMs += chunk }`;
  - rewind_limit_question gate update (`nN()`): OCC has no rewind_limit_question surface (documented at withRetry.ts:1573) → that sub-site N-A.
- **WP-B** Grep/Glob failed-search error — `src/utils/ripgrep.ts`, `src/tools/GrepTool/`, `src/tools/GlobTool/`. Port `RipgrepOutputError` (unexpected exit, no results read → verbatim message above; telemetry "ripgrep unexpected exit with no results") and align the pattern-rejection message with `RipgrepAbnormalExitError` shape if binary-verified.
- **WP-C** OTEL tool_decision fields — `src/hooks/toolPermission/permissionLogging.ts`, `src/services/tools/toolExecution.ts`, `src/hooks/toolPermission/sdkPermissionTelemetry.ts`. Add `classifier_verdict`, `permission_mode`, `classifier_category` (last gated on `OTEL_LOG_TOOL_DETAILS=1`) per binary field-emission sites.
- **WP-D** vim cluster — `src/vim/*`, AskUserQuestion free-text field. `%` motion (+ operator combos d/c/y), Esc→NORMAL race fix, AskUserQuestion vim-NORMAL support.
- **WP-E** skill/command argument-name fill cap — 64 names × 64 chars + placeholder memory fix.
- **WP-F** FileReadTool binary-extension list — extract the full new dotted list from 301 and align OCC's list + message path.
- **WP-G** fable/best alias previous-model retry — `src/utils/model/`.
- **WP-H** terminal-escape hygiene — VTE <0.53 `>0q`/`>4m` suppression + iTerm2 `GOK` startup stray.

Discipline for every WP: byte-level evidence via `grep -aboF -a` + `dd` on `/tmp/cc-diff-301/v301/package/claude` (A/B against `v300/package/claude`); **never execute the official binary**; never invent — ambiguous sites flip to STAGED with rationale; unit tests per site (`bun test <own files>` only); immutable style; no cross-cluster file edits.

## 4. Verification plan

1. Per-WP unit tests green (`bun test` targeted files).
2. Full gate: repo test suite (sharded) — compare against pre-round baseline (git stash A/B on any failures).
3. `bun run build` green.
4. Live e2e: headless `-p` PONG smoke + tmux REPL round-trip (boot, prompt, model round-trip, `/status`, clean exit) per `repl-tmux-e2e-testing` skill.
5. Security self-check (no secrets, no telemetry payload leaks) before merge; formal review by 安全审查员 after merge per handoff discipline.

## 5. Result ledger (filled during implementation)

All 8 WPs ran as parallel subagents with disjoint file clusters; every PORT is byte-verified against the official 2.1.301 linux-x64 ELF (`grep -aboF -a` + `dd`, A/B vs 2.1.300). Port comments follow `CC 2.1.301 (occ160 WP-X): official <code> (@offset)`.

| WP | Verdict | Files | Tests | Notes |
|---|---|---|---|---|
| WP-A retry-watchdog usage-limit budget (P1) | **PORT-landed** | `src/services/api/withRetry.ts` (+231/−2) | new `retryWatchdogUsageLimit301.test.ts` 30 pass; regression 295Review+281 → 63 combined pass | Ledger gains `usageLimitSpentMs`; `getRetryWatchdogMaxUsageLimitWaitMs()` (digits-only ≥1, warn-once); new uncapped `getUnifiedResetDelayMsUncapped()` (byte mirror of official nKr @228707043; existing capped `getRateLimitResetDelayMs` untouched); throw telemetry `api_request_usage_limit_wait_too_long` + CannotRetryError. Evidence: core branch @228699313, ledger init @228688688, heartbeat @228701537, descriptor @216719044, pvn/mvn @228686263. N-A: nN() rewind gate @243133750 (no OCC surface), onQuotaWindowWait. Documented pre-existing deviation: OCC ledger is per-withRetry-call, not threaded via modelCallRetries |
| WP-B Grep/Glob failed-search error (P2) | **PORT-landed** | `src/utils/ripgrep.ts` (+133/−1) | new `ripgrepAbnormalExit301.test.ts` 14 pass; regression 118 pass | New `RipgrepAbnormalExitError` (FU @223101247, verbatim message), `EXTERNAL_KILL_SIGNALS` @223100653, `abortedSearchRejection` (IU @223100962), gate split @223117565. **Brief correction**: `RipgrepOutputError` was pre-existing in BOTH versions (string-table adjacency trap); `RipgrepUsageError` exit-2 path unchanged. Grep+Glob covered via shared handler. Bun parity note: signal-kills deliver `code: null` not `undefined` — ported byte-faithful, documented |
| WP-C OTEL tool_decision fields (P3+P4) | **PORT-landed** (all 3 fields) | new `classifierDecisionTelemetry.ts`; edited `permissionLogging.ts`, `PermissionContext.ts`, `handlers/interactiveHandler.ts`, `src/services/tools/toolExecution.ts` | new `toolDecisionOtelFields301.test.ts` 33 tests; 60 pass across 4 files | `buildClassifierToolDecisionFields` ≡ u9e @227797100; verdict domain per H3n @216936555; 79-entry category set ≡ Zfe/xAo @226411221; `permissionModeToExternal` ≡ Fl @217201653; classifier_category gated on OTEL_LOG_TOOL_DETAILS ≡ Tc @220028587; OVt mode-capture @248276644; recheck modeAtRecheck @248296194; fallback emit @228218908. STAGED residuals (out-of-cluster): `useCanUseTool.tsx:46/67` decisionReason; `classifierAllowed` stamping site → accept branch dormant; OCC's coarse 2.1.200 categories not in official set (taxonomy update = separate WP); I3n dormant |
| WP-D vim cluster (P5+P6+P7) | P5 **PORT-landed** · P6 **STAGED** · P7 **PORT-landed** | 10 modified + 2 new tests across `src/vim/*`, `useVimInput.ts`, `VimTextInput.tsx`, `CustomSelect/*`, `QuestionView.tsx`, `textInputTypes.ts` | 155 pass / 371 expect (vim 107, AskUserQuestion+CustomSelect 37); new `percentMotion301.test.ts` (22), `vimEditingEscape301.test.ts` (11) | P5: six official pieces — SIMPLE_MOTIONS+% @236316959, count guard, findMatchingBracket @236317723/@236317800 + pill-blanking @236281883, isInclusiveMotion `"eE$%"` @236318044, operator no-match guard @236318544, getOperatorRange backward-inclusive delta @236324215. P7: input swap @243843500, stopEscapePropagation @243848646, bare-escape check @243853550, footer `-- MODE --` pill; divergence documented (OCC keybinding handlers get no key event → `singleKeyEvent()` sub-check subsumed). P6 STAGED: official fix is a reader-side 50ms timing gate (`readLate` @231886037, discriminator `An`, re-feed `mb`/`cy` @231955481) living in `src/ink/parse-keypress.ts` (outside cluster); OCC race proven (`META_KEY_CODE_RE` parse-keypress.ts:12); 3-part port recipe recorded — dedicated parse-keypress WP owns it |
| WP-E arg-name fill cap (P8) | **PORT-landed** | `src/utils/argumentSubstitution.ts` | new `argumentSubstitutionCaps301.test.ts` 11 tests; cluster 111 pass; call-site regression (skills+plugins) 639 pass | `MAX_EXPANSION_TOTAL_CHARS=4e6` / `MAX_NAMED_ARGS=64` / `MAX_ARG_NAME_LENGTH=64` (@226103760 `var _pr=4e6,mSo=64,gSo=64`); filter+slice BEFORE longest-first sort (declaration order preserved); running budget throws `MalformedCommandError` ≡ nT @216473037 → tool_malformed_command @228188773, verbatim message @226104475. fn bNe @226104224 vs v300 MLe @225198782 (no caps). Hooks NOT N-A — `hookHelpers.ts addArgumentsToPrompt` shares the chokepoint |
| WP-F binary-extension list (P9) | **PORT-landed** | `src/constants/files.ts` (+51) | new `binaryExtensions301.test.ts` 15 pass (132 expect); full FileReadTool suite 132 pass | 27 new extensions at official-order positions; Set now byte-matches official 121 entries (v301 @224955508 vs v300 @224062630 = 94; diff 27 added / 0 removed). Gate shape + message unchanged (@229305917/@229305959 byte-identical 300↔301) → no FileReadTool.ts change; image/pdf exception fn @219232101 identical → `.heic` lands binary-refusal side, NOT image path |
| WP-G fable/best previous-model retry (P10) | **PORT-landed** | `src/utils/model/modelLadder.ts`; edited `modelLadder286.test.ts` (2 stale assertions) | new `modelLadder301.test.ts` 21 tests; `bun test src/utils/model/__tests__/` → 463 pass | `modelFamilyStem` ≡ Nm @224337624 (`e.replace(/\d+$/,"")`), `modelTier` via stem ≡ Lc @224337667, `olderSameTierFirstPartyIds` ≡ tks @224339603 (family-stem grouping over catalog order → fable51 → `['claude-fable-5']`; fixes v300 bug pa @223429745/dSs @223431739 → []). `previousModelOfSameTier` chain unchanged (Iyo @224340156). Caveat: live retry depends on `accessFallbackModel` producer wiring STAGED/DORMANT since the 2.1.286 port (pre-existing, out-of-cluster) — ladder computes correctly |
| WP-H terminal-escape hygiene (P11+P12) | P11 **PORT-landed** · P12 **N-A** | `src/ink/terminal.ts` (+121), `src/ink/components/App.tsx`, `src/ink/ink.tsx`, `src/ink/termio/guiEditorHandoff.ts`, `src/utils/gracefulShutdown.ts` | new `vteSequenceBug301.test.ts`; 37 pass / 127 expect (incl. osc52VteGuard296 + guiEditorHandoff regressions) | P11: `hasUnknownSequencePrintingBug` @220859789 (VTE_VERSION < 5300 ≡ VTE 0.53, @220859907), accessor b6() @224563183 (attach-caps override omitted — no OCC surface, OCC-113-style deviation noted); XTVERSION probe gate @231943057 + skip-log; extended-keys OFF seqs `lvt`/`o0e` @231683280 wired through mode-registry @231688928 + exit cleanup `vre()`; resolvers @231674646. Emitter-side gating only, no input filters. P12 N-A: root cause is the kitty-graphics probe `ESC_Gi=31,…` (iTerm2 replies `GOK`); OCC never sends that probe (terminal-querier.ts has no kittyGraphics builder; no `TerminalResponse` member) → nothing to fix; official 301 GOK change site not byte-located (sender-side, likely gated) — irrelevant to verdict |

**Roll-up**: 12 PORT changelog entries → 10 landed this round (P1–P5, P7–P11), P6 STAGED (parse-keypress reader-timing gate, recipe recorded), P12 N-A (OCC never sends the probe). Plus STAGED residuals noted in WP-C (classifierAllowed stamping, useCanUseTool decisionReason, category taxonomy) and WP-G (accessFallbackModel producer wiring, pre-existing since 2.1.286).

Integration gate (this round): full repo test suite + `bun run build` + headless PONG smoke + tmux REPL round-trip — results recorded in the round comment.
