# Upstream version gap — OCC-132 round (official claude-code 2.1.309 → 2.1.310)

Round date: 2026-10-25 (OCC-132 autopilot, 01:00 Asia/Shanghai). Repo head at round start: `4b08a123` (v2.1.403, Tracks 2.1.309 partial).

## §1 Baseline

- OCC version at round start: **2.1.403** (own release line), tracking official **2.1.309 (partial)**.
- Official latest (三方 verified): npm `latest` = `next` = **2.1.310** (published 2026-10-23), `stable` = 2.1.308; GitHub release `v2.1.310`; fresh ELF download.
- Forensic binaries (READ-ONLY — never executed, per `aligning-with-official-binary`):
  - `BIN310=/tmp/cc-diff-310/bin310/package/claude` — md5 `3dccf6b9559010b289974593943ce748`, 291,638,640 bytes; version census: `2.1.310`×2852 / `2.1.309`×1 / `2.1.311`×0.
  - `BIN309=/tmp/cc-diff-310/bin309/package/claude` — md5 `f7ab0febdb48bc73f98c89867ce81d26`, 293,469,552 bytes.
- Changelog 2.1.309→2.1.310: **26 items** (`docs/gap-research-310/changelog-309-310-items.txt`).
- New-strings diff: 27,851 new unique strings (mostly minifier churn); 1 verified new portable env surface (`CLAUDE_CODE_RETRY_WATCHDOG_SCOPE`, BIN310 hits 3 / BIN309 0).

## §2 Triage — all 26 items

Detailed per-item evidence (verdict + OCC surface + official byte offsets + `grep -aboF`/`dd` excerpts): `docs/gap-research-310/README.md`, `triage-T1.md` (items 1–6), `triage-T2.md` (items 7–12), `triage-T3-sweep.md` (items 13–26 + env/settings/hook/command/tool sweep).

| Verdict | Count | Items |
|---|---|---|
| **PORT** | 6 + 1 env sweep find | 2 (effort-beta / mid-conversation-system rejection heal), 3 (`cleanupPeriodDays` NaN cutoff guard), 5 (symlink target in read prompts), 6 (record interaction after external-editor close), 11 (AppArmor userns sandbox diagnostic), 12 (MCP elicitation-timeout error arms) + B-1 (`CLAUDE_CODE_RETRY_WATCHDOG_SCOPE=capacity` watchdog-gate parity) |
| **STAGED** | 4 | 4 (PTL reactive-compact ratio seeding — OCC reactive-compact dormant stub; 310 mechanism byte-pinned for future build), 7 (Windows Git-Bash-missing hook fail-open — lives in unported default-shell→PowerShell fallback routing), 8 (auto-mode outside-reads prompt wording — `auto_mode_outside_reads` dialog absent in OCC), 9 (non-interactive compaction memory — no distinguishing string delta; not byte-pinnable → STOP per skill) |
| **N-A** | 16 | 1 (official removed a Statsig gate OCC never had — OCC already matches the 310 end state), 10 (no mods/terminal-image subsystem), 13–26 (VSCode extension / Cloud-sessions web UI / Claude Tag Slack / Code Review cloud admin — surfaces absent in OCC, no CLI-side string leak) |
| **Total** | **26** | |

Security-relevant this round: item 3 (fail-safe cleanup — prevents deletion of recent files on absurd `cleanupPeriodDays`), item 5 (symlink disclosure in read prompts — user-facing transparency), item 11 (sandbox diagnostic — read-only probe, adds an error message only), item 12 (MCP timeout error classification — no user data in `errorClass`), B-1 (retry watchdog scope gate).

## §3 Implementation

All 7 PORT items landed via 6 parallel work packages (subagents, no sub-issues per round discipline), each TDD red→green with byte-verification against BIN310/BIN309. 13 source files, +769/−62 (excluding tests/docs).

| WP | Items | Files | Notes / documented deviations |
|---|---|---|---|
| WP-api | 2 + B-1 | `src/services/api/claude.ts` (+276), `src/services/api/withRetry.ts` (+61) | `isEffortRefusedError` = full official `$K` detector (@248256506) — superset of the two changelog-named triggers (documented deviation: faithful to the binary, not the prose). `retryEffortRefused` heal: per-model latch keyed on both `options.model` and `normalizeModelStringForAPI(options.model)`, byte-verbatim warn log, `tengu_effort_unsupported_retry` telemetry, one-shot `effortHealState`. `configureEffortParams` consults the latch delete-first. Private `wt` telemetry-sanitizer copy (official pattern). Watchdog gate now `isEnvTruthy(CLAUDE_CODE_RETRY_WATCHDOG) && CLAUDE_CODE_RETRY_WATCHDOG_SCOPE !== 'capacity'`. |
| WP-cleanup | 3 | `src/utils/cleanup.ts` (+92), `src/utils/worktree.ts` | `cutoffDateFromDays` mirrors official `_e` @258251237 (NaN→null). `getCutoffDate` mirrors `kS` @258251302 **including the `0 → null` short-circuit** (byte-verified; the first-draft triage missed it — erratum recorded in gap-research README). All 7 sweeps early-return an empty `CleanupResult` on null; orchestrator wraps paste/worktree cleanup + `tengu_worktree_cleanup` in one `if (cutoffDate !== null)` block (@258283561). `cleanupStaleAgentWorktrees(cutoffDate: Date | null)`: null→0, NaN→0, fail-safe `!(mtimeMs < cutoffMs)` comparison (skips on any doubt). |
| WP-symlink | 5 | `src/components/permissions/FilePermissionDialog/FilePermissionDialog.tsx`, `src/components/ShowInIDEPrompt.tsx` | Official `St`/`Qjt` resolver ported returning `{target, unchecked}`; verb split `operationType === 'read' ? 'read' : 'modify'` in "This will ${verb} ${target} (outside working directory) via a symlink"; unchecked branch "Could not check where this path leads on disk" (BIN310 hits 2 / BIN309 0). Deviation: official 310 has ONE unified dialog site (`Xo` @274085299 renders the warning even when `showingDiffInIDE`); OCC keeps the historical split component, so `ShowInIDEPrompt` gained the same `symlinkTarget`/`symlinkUnchecked`/`operationType` props and identical literals (byte-verified equivalence, split-render documented). |
| WP-question | 6 | `src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx` | `updateLastInteractionTime(true)` immediately after `await editPromptInEditor(...)` (official `if(Iq(!0),` placement: BIN310 2 hits / BIN309 0). Micro-port. |
| WP-sandbox | 11 | `src/utils/sandbox/apparmorUsernsCheck.ts` (NEW, 210 lines), `src/utils/sandbox/sandbox-adapter.ts` (+33/−1) | `d

`-style FFI probe + injector `{readRestrictionSwitch, resolveBubblewrap, tryBubblewrap}`; switch path `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`; trial argv `["--unshare-user","--unshare-net","--dev-bind","/","/","/bin/true"]` via execaSync (cwd `/`, fixed env, `extendEnv:false`, timeout 2000); stderr matcher `/setting up uid map: Permission denied|Failed RTM_NEWADDR/`; message sanitizer (lone-surrogate strip → stripVT → Cc/Cf regex); resolver via `whichSync('bwrap')` only (never user-supplied paths). `checkDependencies` gains a memoized pass-through gate `(linux‖wsl) && errors.length===0 && initializationPromise===undefined` → probe; on hit appends the verbatim user message to `errors`. Deviation: OCC's adapter has no `runtimeInitialized` field; `initializationPromise===undefined` is the byte-equivalent mapping (declared at site). |
| WP-mcp | 12 | `src/services/mcp/sendTracking.ts`, `src/services/mcp/client.ts`, `src/services/mcp/elicitationHandler.ts`, `src/services/mcp/useManageMCPConnections.ts`, `src/cli/print.ts` | `ToolCallWatchdog.openQuestions?: number` (@275511304). Exported `MCP_QUESTION_UNANSWERED_MSG`/`MCP_OUTCOME_UNKNOWN_MSG` + `buildMcpToolTimeoutRejection(name, tool, timeoutMs, watchdog)` per official @278877100: message composition `[...dt?[o8s]:[],...Bt?[cWr]:[]]`, `errorClass = hasInFlight ? "mcp_call_unanswered" : openQuestion ? "mcp_question_unanswered" : undefined` via `Object.assign` onto `TelemetrySafeError`, `mcpErrorSource:"downstream_unreachable"`. Elicitation handler increments the counter only when `activeCallWatchdogs.length === 1` (official `$n.length===1` attribution guard), decrements in `finally` as `(w.openQuestions ?? 1) - 1`. Deviation: OCC has no per-watchdog in-flight-sends map (unported 309-era answer-tracking); faithful analog `hasInFlight = ownSends.started > ownSends.ranNothing` from the 2.1.307 B3 send tracking (declared at site). Callers wired in `useManageMCPConnections` (~:371) and `cli/print.ts` (~:1584). |

## §4 Tests

**8 new test files, 89 tests, 228 expect(), all green standalone and in-suite:**

| File | Covers |
|---|---|
| `src/services/api/__tests__/effortBetaHeal310.test.ts` (14) | item 2 heal: detector matrix, strip-and-retry VCR, latch one-shot semantics, telemetry capture |
| `src/services/api/__tests__/retryWatchdogScope310.test.ts` | B-1 gate: SCOPE=capacity disables watchdog; unset/other values keep prior behavior |
| `src/utils/__tests__/cleanupCutoffNaN310.test.ts` (11) | item 3: `_e`/`kS` parity incl. 0→null, absurd-day counts, orchestrator null-skip (paste/worktree spies) |
| `src/utils/__tests__/worktreeSweepCutoff310.test.ts` | item 3: fail-safe mtime comparison, null/NaN cutoff → 0 deletions |
| `src/components/permissions/FilePermissionDialog/__tests__/symlinkReadPrompt310.test.tsx` (13) | item 5: real symlinks (live/dangling/dir/absent-tail), verb split, unchecked literal, blockedPath short-circuit, ShowInIDEPrompt mirror |
| `src/components/permissions/AskUserQuestionPermissionRequest/__tests__/questionEditorInteraction310.test.ts` | item 6: interaction-time refresh after editor close |
| `src/utils/sandbox/__tests__/apparmorUsernsCheck310.test.ts` (29) | item 11: verbatim constants, probe/injector behavior, sanitizer, resolver, checkDependencies gate |
| `src/services/mcp/__tests__/elicitationTimeoutArms310.test.ts` (12) | item 12: verbatim constants, composition matrix (question/in-flight/both/neither/ran-nothing), counter attribution guards |

**Full-suite A/B (`bun test src`, single-process shared-module semantics):**

| Run | pass | fail | Notes |
|---|---|---|---|
| Clean HEAD `4b08a123` baseline | 12415 | 271 | `/tmp/occ132-srctest-head.log` |
| With changes, pre-pollution-fix | 12449 | 326 | +55 delta isolated to 6 victim files — all pass 100% standalone → `mock.module` cross-file pollution, not regressions |
| Final (all fixes in) | **12513** | **262** | per-file failure tally vs baseline: **every file ≤ baseline**, net **−9** (excludedCommandsScoping282 9→0 — collateral repair); zero files worse; no new test file fails in-suite |

**Pollution root-causes found & fixed (all pre-existing patterns except where noted; fixes are test-only):**

1. `cleanupCutoffNaN310` (own): lazy `...realModule` spreads in restore factories re-pinned MOCKED exports (bun patches the captured namespace in place) + temp `CLAUDE_CONFIG_DIR` cache priming → victims otelHeadersHelperFailure275 (+11), apiKeyHelper-retry (+5). Fix: eager spread copies before mocking + re-mock restores + `resetSettingsCache()` in afterAll.
2. `symlinkReadPrompt310` (own): `mock.restore()` does NOT undo `mock.module` overrides (proven: `Select: () => null` leaked) → victims recentDenialsTab307 (+6), confirmSafety281 (+3). Fix: explicit re-mock restores from eager copies before `mock.restore()`.
3. `elicitationTimeoutArms310` (own, latent): lazy hooks namespace ref → preventive eager copy.
4. `effortBetaHeal310` (own, victim-hardening): 48 pre-existing files mock analytics without effective restore, starving `attachAnalyticsSink` capture. Fix: flag-gated analytics passthrough capture mock (mirrors the file's VCR pattern) — immune to any earlier mocker.
5. `permissionDenialMisreport.test.ts` (pre-existing polluter): zero-restore partial sandbox-adapter mock → apparmorUsernsCheck310 +29 in-suite. Fix: eager copy + spread + afterAll re-mock restore.
6. `safetyEvent307` / `toolDecisionOtelFields301` / `toolDecisionOtelFields302` (pre-existing polluters, found by pairwise bisect after fix 5): partial `SANDBOX_SPEC` factory (`SandboxManager: { isSandboxingEnabled }` only — dropping `reset`, `SandboxPolicyRefusalError`, …) with NO restore. Fix: same eager-copy + spread + afterAll restore pattern.

Pairwise repro combos after fixes (each 0 fail): cleanup+otel+apiKeyHelper (34), symlink+recentDenials+confirmSafety (28), permissionDenial+apparmor (37), safetyEvent307+apparmor (95), otelFields301+apparmor (62), otelFields302+apparmor (44), 48-analytics-mockers batch+effortBetaHeal310 (766 pass / 1 fail = hookConcurrencyCapProduction302, which fails identically in the HEAD baseline log — pre-existing).

**Lint / build:** `bun run lint` → 17 errors, byte-identical file set to the pre-existing HEAD baseline (bridgeMain.ts / exit.ts / purgeRename288.test.ts suppressions+noTemplateCurlyInString); zero diagnostics in any changed file. `bun run build` green: `dist/cli.js` 30.50 MB.

**Targeted e2e:** `occ-versioning` + `commands-alignment` + all 6 `version-2.1.219-*` files → **55 pass / 0 fail / 195 expect()**.

## §5 Acceptance

- Live headless: `echo "say PONG" | bun run dist/cli.js -p` → `PONG`, exit 0 (real model round-trip through the configured gateway; the `[claude-code:unrecognized_model] {"model":"glm-5.2"}` stderr line is pre-existing gateway-proxy telemetry noise, present in prior rounds).
- `--version` → `OCC 2.1.403` (pre-bump build).
- tmux REPL smoke (120×40): boot renders the v2.1.403 banner + model row; prompt round-trip `say PONG only` → `● PONG`; `/status` renders Version 2.1.403 / session / auth / base URL; session killed cleanly.
- 验收员 role: independent-like verification performed via the acceptance pass above + per-item byte re-verification of the ported literals against BIN310 (counts recorded in triage docs: symlinkUnchecked 3/0, AppArmor message 6/0, mcp_question_unanswered 2/0, RETRY_WATCHDOG_SCOPE 3/0, "no answer came before the time limit" 2/0).
- 安全审查员 role: independent security review of the full changeset — **verdict PASS** (no backdoors, no exfiltration, no security regressions; zero CRITICAL/HIGH findings). Verified: no new network calls in the diff (telemetry `{model}` sanitized via a byte-identical copy of the pre-existing `sanitizeModelForBetaHealTelemetry` regexes → `'nonconforming'`); apparmor probe spawn uses a fixed argv constant, no shell, fixed minimal env (`extendEnv:false`), 2 s timeout, resolver exclusively `whichSync('bwrap')` (no user-supplied path can reach the spawn), no FS writes; sandbox-adapter probe is strictly additive/fail-closed (converts pass→fail with remedy message, never removes errors); cleanup null/NaN guards are deletion-reducing (fail-safe); effort heal is one-shot per request + per-model latch (retry loop structurally impossible); watchdog gate change strictly more restrictive; MCP errorClass fixed literals only; no secrets/eval/obfuscation; official binaries never executed (read-only forensics).
  - LOW-1 (`FilePermissionDialog` symlink target rendered without the 2.1.291 G#9 control-char escaper — display spoofing via a locally-crafted `\n`-bearing symlink name): **fixed this round** — `escapeControlCharsAsEntities` applied at both interpolation branches, parity with `ShowInIDEPrompt` (identity for ordinary paths; documented security-positive deviation).
  - LOW-2 (apparmor probe writes raw trimmed bwrap stderr to the local debug log before the sanitized copy is displayed): **accepted as-is** — mirrors official behavior; debug sink is local-only.

## §6 Release record

(To be appended in the release commit: version bump 2.1.403 → 2.1.404, tag, CI status, GitHub Release.)
