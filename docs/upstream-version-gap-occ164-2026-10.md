# Upstream Version Gap — OCC-164 Round (2026-10): claude-code 2.1.303 → 2.1.304 — SUPPLEMENT

> Status: **COMPLETE** — §1 baseline/collision · §2 reconciliation · §3 implementation · §4 tests · §5 release.
> Prior-round ledgers: [upstream-version-gap-occ163-2026-10.md](./upstream-version-gap-occ163-2026-10.md) (2.1.303 port), [upstream-version-gap-occ124-2026-10.md](./upstream-version-gap-occ124-2026-10.md) (the parallel full 2.1.304 round this supplement reconciles against).
> Skill discipline: `upstream-tracking` + `aligning-with-official-binary`. Official ELF **never executed** — `strings` / `grep -aboF` / bounded `dd` only.

## 1. Baseline — and the parallel-round collision

| Item | Value |
|---|---|
| Round | OCC-164 — started as an independent full 2.1.303→2.1.304 catch-up |
| Official latest at round start | **2.1.304** (published 2026-10-19, 76 changelog entries) |
| Official v303 ELF | md5 `c3d55e74e4008ec9cd21ff1991502cda`, 285,809,912 B |
| Official v304 ELF | md5 `0209fe8a78dc4551b61bffda1978fca9`, 288,730,480 B (+2,920,568) |
| Collision | Mid-round, the daily-autopilot **OCC-124** round landed its own complete 2.1.304 catch-up on origin/main: `e5c3d3b1` (101 files, +15,364/−616, 7 work packages covering all ten OCC-164 PORT items plus 14 more) + release `16daab66` (**v2.1.394**) |
| Conversion | Per the **OCC-123/OCC-163 supplement precedent** ("main wins every overlapping implementation — the supplement adds only what the prior round did not touch"; OCC-40: a no-op round cuts no release), this round converted to a **supplement round** |
| Prior work | Parked whole on `parked/occ164-wip` (36 files); agent branch `agent/occ-leader/a908574a` fast-forwarded to origin/main `16daab66` |
| Method this phase | **Independent function-by-function re-verification** of the OCC-124 port against fresh byte extractions from the official v303/v304 ELFs — not a review of their prose |

## 2. Reconciliation — all ten OCC-164 PORT items vs the OCC-124 landing

Item numbers are this round's original triage indices over the 76-entry official 2.1.304 changelog; WP/# references are the OCC-124 ledger's own numbering.

| # | Item (official 2.1.304) | OCC-124 coverage | Verdict | Evidence / note |
|---|---|---|---|---|
| #11 | Sandbox glob handling hardening | WP1 #9 | **NO GAP** | Official v304 carries BOTH the `uF`/`lae`/`cae` bracket-escape helper and the new AST glob engine (`TokenKind`, `ge` setRanges). Main backports AST-engine semantics (`spellsCharacterSet`); the parked `uF` mechanism is superseded. 19/19 after `bun install` re-applied `patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch` |
| #12 | `rm` guard for mounted drives | WP1 #10 | **NO GAP** | Official mounted-drive region @246327300 (`$o="tengu_bright_lake"`, `GX()`, `U0(e)` telemetry `tengu_bash_dangerous_rm_shape`, `KWt`/`VWt`/`YWt`, `G$o`, `yze`, `XG` walker); ask message @246331600 **byte-identical** to main's `pathValidation.ts:293`. Official `Ie` glob-fold omission documented. 32/32 |
| #19 | `getDisplayPath` NUL guard | WP6 #17 | **NO GAP** | Main's `src/utils/file.ts` guard matches the official byte evidence |
| #24 | Gateway: `context_management` 400 heal + tool-search refuse-recovery | WP4 (#22 + #58) | **NO GAP** | Fresh extraction of the official heal-map region @246856100 confirms main's classifier is byte-exact: `M6t=new Map([…,[dde,(e)=>e.includes("context_management: Extra inputs are not permitted")],…])`. v303/v304 counts prove the generic scanner is **pre-existing**: `Unexpected value(s)` 2=2, `capability_rejected: ` 3=3, `not sent again in this conversation` 2=2 — the ONLY 304 delta is the `dde` arm (`Extra inputs are not permitted` 6→8), which main ports. Tool-search side: `withoutToolSearch` v303=0→v304=3 confirms the mechanism is 304-new; main's gate (400‖422, `billing_error` excluded, armed-gate `zOe`, one-shot latch, chain-last position, official `tse` warn text byte-verified, full un-deferred rebuild + verbatim `critical_system_reminder`) matches `b6`/`tse`/`mZ`/`ugn`. Persisted refused-window (sha256 key, 24 h TTL, prune) matches official `h`/`c(e)`/`f`/`Cs`/`d`/`DUs`. WP4 tests 32/32 this run |
| #31 | Help-text alignments | WP-covered | **NO GAP** | Reconciled text-by-text |
| #32 | `claude --worktree` exit dialog: detached/another-branch HEAD could lose commits | WP7 (their 10 documented deviations) | **GAPS FIXED** | Supplement landed the byte-verified pieces WP7 could not recover: official `hh` full casefold (`foldBranchName`, resolving WP7 deviation #1 "unrecoverable" lowercase-only approximation) + `fve` display-unsafe guard (`isDisplayUnsafeBranchName` @243657174); 7 official-gap edits in `WorktreeExitDialog.tsx` — session-title gate `!wo`, another_branch silent-removal "Branch … is kept." message @269341114 with the `fve` fallback, detached "They may be lost" subtitle, `originalHeadCommit?"commits that could not be counted":"unpushed commits (commit baseline unavailable)"` conditional, kept-either-way suffix @269347664. Worktree sweep **230/230** |
| #33/#35 | Effort domain: sent-level, chip render, ultracode toggle | WP-covered | **GAPS FIXED** | Official `kWe` @240619154 / `Q0` normalizer / `f6t` showCurrentEffort / chip `EE(h,R,L){return L?void 0:kWe(R,h)}` @267850145 / ultracode `??\"auto\"` — supplement completed the domain. **161/161** across 8 suites |
| #37 | Copy-failure logging | WP1 #35 | **NO GAP** | Official tracker `Cwr` @248509996 (ENOSPC/EDQUOT → "Deleting it because the disk or quota is full." keep n; other → "Keeping it." n=void 0). OCC structurally immune to the underlying bug; main implements the optional logging recipe |
| #43 | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` k/M suffixes + warnings | WP5 #41 | **GAP FIXED** | Main's `j_e`/`T4t`/`E4t`/`XFe`/`ySs`/`yVe`/`wQt` ports all verified byte-equivalent against fresh @246816200/@246820099 extractions, wiring present (`main.tsx:57/1153/1440/4343`, `autocompact-noninteractive`). ONE genuine fidelity gap: the bare-number helper `qc`/`u3o` @236431990 — main had inferred a comma-only grouped layout with no length guard; official is `m=/^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/`, `E=/^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/` (consistent-separator backreference), `c` strip-set, 32-char guard, exponent→integer-or-NaN. Byte-verified implementation transplanted from park; 3 pinning tests added. Family **121/121** (env304 file now 35 tests). Behavioral fixes: `'1_000_000'` env now → 1M (was parseInt→1); 33+ char strings fall to parseInt per official guard |
| #60 | Tool search default-on behind custom gateway | WP4 #58 side | **NO GAP** | Gate flip covered by main's WP4 (default-on incl. behind `ANTHROPIC_BASE_URL`, `ENABLE_TOOL_SEARCH` ladder, kill-switch/force semantics) |

### #24 scope adjudication — the parked generalized detector

The parked branch's `betaRejectedRetry.ts` (+882-line test, +166/+339 tool-search suites) ported the official **generalized** beta-rejection machinery (`Bgt` handler, `BVe`/`HVe`/`uke`/`O6t` scanner, `rke` first-line extractor, `bM` capability-rejected marker, `jH`/`eM` exclusions, `Gn` per-rejection warn). Binary string counts (above) prove that machinery is **pre-existing in v303** — OCC never ported it, so it is a pre-existing alignment gap, NOT part of the 2.1.304 delta and out of scope for this catch-up round. The only 304 delta is the `dde` map arm + the tool-search recovery mechanism, both landed by WP4. **Staged follow-up candidate**: port the generalized `Bgt`/`BVe` detector (would also deliver conversation-scoped header suppression and unify the context1m/contextManagement bespoke latches).

### Deviations carried (from OCC-124, re-validated this round — not supplemented)

- Context-management heal uses a **request-scoped latch** (no per-model persisted spent registry) — same documented deviation as the accepted context1m 2.1.295 port. Official `Gn` warns "not sent again in this conversation"; main emits equivalent `[betas]` warn logs scoped to the request.
- Official `vgo` conversation-scoped tool-search hold-off ("Tool search disabled: this conversation…") not ported — verified no OCC surface; the persisted refused-window is the functional equivalent (WP4 documented deviation; the official text is v304-present, count 2).
- Chain order: main runs context1m before contextManagement; official runs `Bgt` before `Ugt`. **Not observable** — the classifiers are mutually exclusive string matches (`context_management: Extra inputs are not permitted` cannot co-occur with the 1M-beta rejection signatures in one 400 body).
- `unnamed:false` kept in `tengu_beta_400_healed` for shape consistency with the 295 mark; `resumeIncompleteThinking` guard trivially true (no OCC surface).

## 3. Implementation record (this supplement, on top of `16daab66`)

13 files (11 modified, 2 new):

- **Effort domain (#33/#35)** — `src/utils/effort.ts`, `src/commands/effort/effort.tsx`, `src/components/EffortIndicator.ts` + tests `effortSentLevel304.test.ts` (new), `effortIndicator304.test.ts`, `effortCap267.test.ts`.
- **Worktree dialog (#32)** — `src/utils/worktree.ts` (exports `foldBranchName` ≡ official `hh` @247137742, `isDisplayUnsafeBranchName` ≡ official `fve`), `src/components/WorktreeExitDialog.tsx` + tests `worktreeBranchSanitizer304.test.ts` (new), `worktreeExitDialogAtStake304.test.tsx` (9 scenarios incl. OCC-164 supplement cases), `worktreeExitDialogHook301.test.tsx` (assertion updated to the official v304 `originalHeadCommit` conditional copy).
- **autoCompactWindow (#43)** — `src/utils/autoCompactWindow.ts` (byte-verified `qc`/`u3o` bare-number helpers replacing the inferred block: `EXPONENT_NOTATION_RE`, `GROUPED_THOUSANDS_RE` with `[_,\u00A0\u202F ]` consistent-separator backreference, `THOUSANDS_SEPARATOR_RE`, `BARE_NUMBER_MAX_LENGTH=32`, `parseStructuredNumber`, `parseBareNumber`; docblock cites @236431990–236432800 verbatim) + `autoCompactWindowEnv304.test.ts` (3 supplement tests: exponent notation, grouped-thousands separators incl. NBSP/NNBSP and mixed-separator fallthrough, 32-char guard both arms).

No secrets, no new env surfaces, no permission-model changes. Immutability preserved (all list updates are filters/copies).

## 4. Test record (this run)

| Suite | Result |
|---|---|
| Worktree sweep (hook301 + atStake304 + branchSanitizer304 + head-state suites) | **230 pass / 0 fail** |
| Effort domain (8 suites incl. effortSentLevel304) | **161 pass / 0 fail** |
| autoCompactWindow family (autoCompactWindow + Env304 + AliasKey302 + AliasPins302 + PerModel288 + WarnGate300) | **121 pass / 0 fail / 275 expect()** |
| WP4 beta-heal + tool-search (contextManagementBetaHeal304 + toolSearchRefuseRecovery304 + toolSearchRefusedWindow304) | **32 pass / 0 fail** |
| pathValidation (#12) | 32/32 · sandbox patch (#11) 19/19 |
| biome lint (errors-only gate) | 0 errors (16 pre-existing suppression warnings) |
| e2e `occ-versioning` + `commands-alignment` | pass |
| `bun run build` | green, `dist/cli.js` ~30.34 MB |

Gate notes: repo-wide `bun test src` remains order-polluted at baseline (OCC-124 ledger §5) — per-suite isolated runs are the gate. `tsc` is not a gate (~1341 pre-existing errors). Fresh checkouts must `bun install` to re-apply the sandbox-runtime patch before running #11 tests.

## 5. Release

- Merged to main; `package.json` 2.1.394 → **2.1.395**; CHANGELOG `## 2.1.395 - 2026-10-21`; tag **v2.1.395**.
- npm publish expected **E404** — NPM_TOKEN expired ~2026-10-03 (OCC-151, human-only debt; npm `latest` stays 2.1.367).
- GitHub Release created manually per v2.1.392/393/394 precedent; releases==tags invariant re-verified.
- `parked/occ164-wip` retained until the merge is confirmed, then deleted (its byte-verified content is fully landed or documented-staged above).
