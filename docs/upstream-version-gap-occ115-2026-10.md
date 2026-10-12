# Upstream Gap Ledger — OCC-115 Round (2026-10-13)

**Baseline:** official Claude Code latest = **2.1.296**; OCC tracks 2.1.296 (no version gap). Round start: main @ `3b9ec3a`, CI 38178958699 green, latest GitHub release v2.1.380, parity ledger 179=179.

**Round directive (OCC Leader):** strict self-acceptance of OCC's REPL on real tasks vs official behavior (tmux real-machine round-trips), prioritize OCC-114's new test surfaces, re-review the 19 STAGED items of `docs/upstream-version-gap-occ113-2026-10.md`, record any inconsistency as a gap → fix + real e2e verify → merge to main. Plus: residual branch disposal and npm E404 debt re-check (report-only).

Official-binary discipline this round: **forensics only** — `strings` / `grep -aboF` / bounded `dd` against `/tmp/cc296/lx/package/claude` (ELF 257,068,216 bytes, md5 `3c8749470f70a26efadf982b587e1548`). The official binary was never executed.

---

## 1. Self-acceptance results (real tmux REPL round-trips)

### OCC-114 surfaces

| Surface | Test | Result |
|---|---|---|
| `twoPhaseAssign296` (TaskList two-phase assign) | unit + e2e suite | PASS |
| `nonUtf8Refusal296` (non-UTF8 read refusal) | unit + e2e suite | PASS |
| Screen-reader held-announce | e2e | PASS |
| Plan-approval transcript persistence | e2e | **CORRECTED** — originally recorded PASS in error; see §8 |

> **Correction (2026-10-13, acceptance F-fix):** the Plan-approval row above
> was falsely reported as PASS in the first version of this ledger. The
> plan-approval e2e was last run BEFORE the Gap B nudge port landed and was
> never re-run after it, so the self-acceptance claim "OCC-114 四个新测试面
> 4/4 PASS" was overstated (3/4 actually re-verified at the time). 验收员
> acceptance caught the regression: the nudge gate (`aMr`) fires on this
> test's seeded home (onboarding complete + userSettings `permissions.
> defaultMode:"plan"` + no `hasSeenAutoDefaultNudge`) and the modal swallowed
> the first prompt → 0/2 with 120s `waitForPlanDialog` timeouts. Fixed by
> seeding `hasSeenAutoDefaultNudge:true` in `freshSeededHome()`; clean rerun
> **2/2 PASS** (§8).

### Core mainline REPL (tmux, built `dist/cli.js`, 200×50)

- Full permission-mode carousel verified against official indicator chips: `bypass permissions on → auto mode on → manual mode on → accept edits on → plan mode on → (wrap)`.
- Auto-mode entry emits the official description banner; legacy opt-in dialog absent (matches official 2.1.296 removal).
- `/goal` panel open + Escape dismiss: PASS.

## 2. Gap A — stale `repl-interactive` e2e contract (FIXED)

`test/e2e/repl-interactive.e2e.test.ts` still asserted pre-2.1.296 behavior (old 2-step Shift+Tab cycle, legacy "Enable auto mode?" opt-in dialog). Rewritten to the official contract:

- New helpers `currentModeChip()` (bottom-up footer-chip scan; `capture-pane -S -` scrollback means older frames still hold stale chips) and `waitForChip(label)` (200ms poll).
- Test 1: full 5-mode carousel with official chip labels (`permissionModeIndicator` parity).
- Test 2: auto entry shows the official banner text and asserts the legacy dialog strings are NOT rendered.
- Result: **3 pass / 0 fail / 11 expects**.

## 3. Gap B — auto-default nudge entirely missing from OCC (PORTED)

Official 2.1.296 ships a one-shot startup nudge offering to persist auto mode as the default permission mode. Before this round OCC had **zero traces** of `hasSeenAutoDefaultNudge` / `auto_default_nudge` / `tengu_maple_pier` → genuine untriaged gap (absent from ALL ledger docs, incl. the OCC-113 STAGED ledger).

### Official surfaces (byte-verified in the official linux-x64 binary)

| Official | Offset region | Semantics |
|---|---|---|
| gate `aMr` | @232914800 | onboarding complete ∧ ¬`hasSeenAutoDefaultNudge` ∧ `k("tengu_maple_pier", true)` ∧ userSettings `permissions.defaultMode` **explicitly set** ∧ ≠ `"auto"` ∧ no other layer (project/local/flag/policy) pins defaultMode ∧ auto available (`kj`) → return pinned mode |
| dialog `qhe` | @239278500 | title "Make auto mode your default permission mode?"; body "Auto mode lets Claude handle permission prompts automatically. Claude checks each tool call for risky actions and prompt injection before executing, runs the ones it assesses as lower-risk, and blocks the rest."; options "Yes, set auto mode as my default permission mode" / `` `No, keep ${BF(mode)}` ``; `hideIndexes:true`; Esc/cancel → decline; mount logs `tengu_auto_default_nudge_shown{current_mode}` |
| resolver `ZIe`/`Ckt`/`Tkt` | @238434800 | cancelled → no writes/events; accept ∧ gate ok → live-switch to auto + persist userSettings `{permissions:{defaultMode:"auto"}}` + set config flag + toast `[auto mode on]` → `"switched"`; accept ∧ gate off → warning notification (`auto-default-nudge-unavailable`) → `"gate_off"` **without** setting the flag (nudge can reappear); decline → flag set → `"declined"`; non-gate_off logs `tengu_auto_default_nudge_resolved{choice,outcome,current_mode}` (terminal surface: no `surface` field) |

### OCC implementation (this round)

| File | Change |
|---|---|
| `src/utils/permissions/autoDefaultNudge.ts` | NEW — `shouldShowAutoDefaultNudge()` (`aMr` port) + `resolveAutoDefaultNudge()` (`Ckt`/`Tkt` port) |
| `src/components/AutoDefaultNudgeDialog.tsx` | NEW — `qhe` port, all four user-facing strings verbatim |
| `src/dialogLaunchers.tsx` | NEW `launchAutoDefaultNudgeDialog()` (JSX-free main.tsx convention) |
| `src/main.tsx` | nudge block after `setInitialMainLoopModel` (so `modelSupportsAutoMode` sees the resolved model); on `switched`: `transitionPermissionMode(mode,'auto',ctx)` + `{...ctx, mode:'auto'}` + `permissionMode='auto'` + `setSessionBypassPermissionsMode(false)`; `permissionMode` destructure `const`→`let` |
| `src/utils/config.ts` | `hasSeenAutoDefaultNudge?: boolean` on GlobalConfig (official key name) |
| `src/utils/featureFlags.ts` | `'tengu_maple_pier'` added to FEATURE_ALLOWLIST (official `k(...,!0)` default-true; OCC GrowthBook is an empty stub, so allowlist membership reproduces default-true) |

### Documented divergences (pre-REPL dialog slot vs official in-REPL placement)

1. No first-turn-activity wait (official `HKt`) — OCC shows the nudge in the startup dialog sequence.
2. No `[auto mode on]` toast on switch — the REPL footer chip shows the new mode after mount.
3. `gate_off` degrades to a debug log — no notification host exists pre-REPL (official posts a warning notification).
4. No `refusedWithin` cooldown (official dialog-queue infra); Esc = decline, matching official `onCancel`.
5. Auto availability re-checks `isAutoModeGateEnabled()` synchronously instead of consulting a live `ToolPermissionContext` (none exists pre-REPL).

### Verification

- Unit `src/utils/permissions/__tests__/autoDefaultNudge296.test.ts`: **20 pass** (gate matrix: onboarding/flag/pin/other-layer/auto-pin/gate-disabled/model-unsupported; resolver: accept→switched+writes, decline→flag-only, cancelled→no-ops, gate-off→no flag, write-error→gate_off, idempotent flag).
- E2E `test/e2e/version-2.1.296-auto-default-nudge.e2e.test.ts` (real tmux REPL, built bundle): **3 pass** — (a) dialog renders official verbatim strings, Esc declines, `hasSeenAutoDefaultNudge=true` persisted, settings untouched, dialog suppressed on relaunch; (b) Enter accepts → settings `defaultMode:"auto"` persisted, session live-switches (footer chip `auto mode on`), relaunch (no bypass flag) boots straight into auto with no dialog; (c) no explicit userSettings pin → no dialog, no flag write.

## 4. STAGED ledger re-review (OCC-113 doc) — 19/19 CONFIRMED

Subagent re-verified all 19 STAGED items of `docs/upstream-version-gap-occ113-2026-10.md` §3 with byte-exact offset re-checks: **19/19 CONFIRMED-STAGED-OK**. Flags for next rounds:

- **#006 `allow_large`** — most mature; recommended next-round priority.
- **#057 `--debug` hook format strings** — now located (`pre_tool_hook_duration_ms` @217881032).
- Bookkeeping drift: §1 says "STAGED（20）" but the §3 table lists 19 — cite the §3 table as authoritative.
- The auto-default nudge (Gap B above) was absent from every ledger doc — it was the real untriaged gap this round and is now closed.

## 5. Branch hygiene

- `agent/occ/2db3a4dc`: verified fully merged (`git log origin/main..origin/agent/occ/2db3a4dc` = empty), then deleted on GitHub. **Only `main` remains.**

## 6. npm E404 debt (owner-side, report-only)

- Latest publish.yml runs (v2.1.378 ×2, v2.1.379, v2.1.380 ×2) all still fail at the `npm publish` step with `npm error code E404 — 404 Not Found - PUT https://registry.npmjs.org/@cnwenf%2focc`. A 404 on a scoped PUT is the npm registry's response to an **invalid/revoked auth token** — the workflow itself (checkout → build → publish step) executes correctly, so this is **not a process regression**.
- npm `latest` remains **2.1.367**; versions **2.1.368–2.1.380 (13)** unpublished.
- Owner action required: rotate `NPM_TOKEN` secret, then re-run publish.yml for each missing tag.

## 7. Round test status

> Numbers below are the FINAL post-F-fix state (§8). The first ledger version
> falsely listed plan-approval e2e as PASS — see the §1 correction box.

- Nudge unit `autoDefaultNudge296.test.ts`: **20/20 pass** (gate_off outcomes now assert NO `tengu_auto_default_nudge_resolved` event, matching the official non-gate_off-only logging — §8 P3-1).
- Nudge merge-semantics unit `autoDefaultNudge296Merge.test.ts` (NEW, §8 P3-4): **3/3 pass** — real `updateSettingsForSource` against a temp `CLAUDE_CONFIG_DIR`; the accept write flips only `permissions.defaultMode` and preserves sibling `permissions.*` fields + unrelated top-level keys.
- Nudge e2e `version-2.1.296-auto-default-nudge.e2e.test.ts`: **3/3 pass** (real tmux REPL).
- Plan-approval e2e `version-2.1.210-plan-approval.e2e.test.ts`: **2/2 pass** after the §8 P1 seed fix (was 0/2 — falsely recorded PASS before).
- `repl-interactive` e2e: 3/3 pass.
- Canonical full suite (`CI=1 bash scripts/ci-test.sh`, per-file process isolation): **11038 pass / 0 fail / 119 skip across 985 test files, 0 failed** + all 3 same-worker mock-leak regression pairs OK (pre-F-fix run; tmux e2e files are `describe.skipIf(CI)` there — which is exactly why the P1 regression escaped it). Post-F-fix rerun: **11041 pass / 0 fail / 119 skip across 986 files, 0 failed** + all 3 leak pairs OK (§8).

## 8. Acceptance F-fix round (2026-10-13, 验收员 REJECT → fixes)

验收员 rejected the first handoff: **P1** plan-approval e2e regression (0/2) + false records in this ledger. Fixes:

| Item | Fix |
|---|---|
| **P1** plan-approval e2e 0/2 | `freshSeededHome()` now seeds `hasSeenAutoDefaultNudge:true` in `.claude.json`. Root cause: the seeded home (onboarding complete + userSettings `permissions.defaultMode:"plan"` + flag absent) is exactly the nudge gate `aMr` trigger state, so the Gap B startup modal blocked the REPL and swallowed the first prompt. The test verifies plan-approval labels/no-clobber, not the nudge (which has its own e2e). Clean rerun: **2/2 pass**. CI could not catch it — tmux e2e is `describe.skipIf(!!process.env.CI)`. |
| **Records** §1 false PASS | §1 row corrected + correction box added; the "OCC-114 四个新测试面 4/4 PASS" claim is retracted (was 3/4 re-verified; plan-approval was stale pre-nudge-port output). §7 rewritten. |
| **P3-1** gate_off telemetry doc/code conflict | Code aligned to the official binary + docblock + §3 row: `resolveAutoDefaultNudge` now logs `tengu_auto_default_nudge_resolved` ONLY for non-gate_off outcomes (guard moved around `logEvent`, mirroring official `Ckt`'s `if(H!=="gate_off")` block). Two unit assertions flipped to `expect(resolvedEvent()).toBeUndefined()`; the gate-disabled variant also pins no-event. |
| **P3-2** main.tsx accept-path silent gate_off degradation | CONFIRMED intentional — documented divergence #3 (§3): pre-REPL there is no notification host, so gate_off degrades to a debug log; the nudge stays re-appearable because the one-shot flag is NOT set on gate_off (official-faithful). |
| **P3-3** `markNudgeSeen` swallows config-write errors | CONFIRMED intentional fail-soft (mirrors official `Ae` best-effort write): a failed flag write only means the nudge may reappear next launch — benign, and the debug log records it. |
| **P3-4** missing merge-clobber unit test | NEW `autoDefaultNudge296Merge.test.ts` (3 tests) exercises the REAL settings module against a temp `CLAUDE_CONFIG_DIR` and pins that the accept write merges (lodash `mergeWith`) without clobbering sibling `permissions.allow/deny/ask/additionalDirectories` or unrelated top-level keys — including across a second accept after the user re-pins a mode. |

F-fix verification (real model creds, built `dist/cli.js`, tmux):

- plan-approval e2e: **2/2 pass** (46.05s clean rerun).
- nudge e2e: **3/3 pass** (21 expects) after the P3-1 code change.
- nudge units: 20/20 + new merge file 3/3.
- Full suite `CI=1 bash scripts/ci-test.sh`: **11041 pass / 0 fail / 119 skip across 986 test files, 0 failed** + all 3 same-worker mock-leak regression pairs OK.

No tag / release cut in this round — 验收员 re-acceptance is required first.
