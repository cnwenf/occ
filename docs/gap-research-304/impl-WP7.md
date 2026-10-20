# impl-WP7 — CC 2.1.304 gap items #27 / #28 / #30 / #38

Work package WP7 of the 2.1.304 catch-up round. Sources: `docs/gap-research-304/research-R5-cli-ux.md` §#27/#28, `docs/gap-research-304/research-R6-env-misc.md` §#30/#38 (byte-verified official 2.1.304 code). Branch `agent/occ-leader/3bdf2d90`. All 4 items landed; all suites green; Biome lint clean (0 new warnings); `bunx tsc --noEmit` reports 0 errors in WP7 files.

---

## Item #27 — Grove hardening (`src/services/api/grove.ts`)

### Files changed
- `src/services/api/grove.ts` (production)
- `src/services/api/__tests__/grove304.test.ts` (new — no pre-existing grove tests existed)

### What landed
- **`errorStatus` propagation**: `getGroveNoticeConfig()` failure path now returns `{ success: false, errorStatus }` where `errorStatus = err.response?.status` (official `v` HTTP-status error class; detected via `axios.isAxiosError`). Failures clear the lodash `memoize` cache before returning (`.cache.clear?.()`), so a transient outage is never memoized for the session.
- **Shape validation with official verbatim messages**:
  - notice config answer without `typeof grove_enabled === 'boolean'` → `'Grove notice config answer has no boolean grove_enabled'` (debug-logged).
  - settings answer without boolean-or-null `grove_enabled` → `'Grove settings answer has no boolean or null grove_enabled'` (logError'd). `null` is accepted (choice not yet made).
- **`finally`-clear**: `markGroveNoticeViewed()` (POST) and `updateGroveSettings()` (PATCH) moved the settings-cache invalidation into `finally` — a failed write may still have landed server-side, so the memo must not survive it.
- **`fetchAndStoreGroveConfig` re-stamp**: server-error answer (`errorStatus !== undefined && errorStatus !== 401`) with an existing `groveConfigCache` entry → write a fresh timestamp while keeping the last known-good `grove_enabled` (prevents an hourly refetch storm against a broken backend). 401 answers do NOT re-stamp (that's a re-auth signal, not a server error). No existing entry + server error → store nothing.

### Tests (`bun test src/services/api/__tests__/grove304.test.ts` → **11 pass / 0 fail / 24 expect()**)
1. getGroveNoticeConfig returns errorStatus from the axios response and does not memoize the failure
2. getGroveNoticeConfig failure without an HTTP response returns plain {success:false}
3. getGroveNoticeConfig rejects a config answer without boolean grove_enabled (official message)
4. getGroveSettings rejects an answer without boolean-or-null grove_enabled (official message)
5. getGroveSettings accepts null grove_enabled (choice not yet made)
6. getGroveSettings failure is not memoized (transient outage must not lock the session)
7. markGroveNoticeViewed clears the settings cache even when the POST fails
8. updateGroveSettings clears the settings cache even when the PATCH fails
9. stale cache + server-error answer (non-401): re-stamps timestamp, keeps last known-good grove_enabled
10. 401 answers do NOT re-stamp the cache (re-auth, not a server error)
11. server-error answer with no existing cache entry stores nothing

---

## Item #28 — `/privacy-settings` both-fetch gate

### Files changed
- `src/commands/privacy-settings/privacy-settings.tsx` (production — one gate)
- `src/commands/privacy-settings/__tests__/privacySettingsGate304.test.ts` (new — no pre-existing tests)

### What landed
Official fix: BOTH parallel fetches must succeed before the dialog renders —
`if (!settingsResult.success || !configResult.success)` → `onDone(FALLBACK_MESSAGE); return null`.
Pre-304, a failed **config** fetch fell through and rendered `PrivacySettingsDialog` with `domainExcluded` unknown. `FALLBACK_MESSAGE` string unchanged: `'Review and manage your privacy settings at https://claude.ai/settings/data-privacy-controls'`.

### Tests (`bun test src/commands/privacy-settings/…/privacySettingsGate304.test.ts` → **4 pass / 0 fail / 8 expect()**)
1. config fetch fails while settings succeeds → FALLBACK_MESSAGE, dialog hidden (the #28 fix)
2. settings fetch fails while config succeeds → FALLBACK_MESSAGE, dialog hidden
3. both fetches succeed + grove_enabled decided → PrivacySettingsDialog renders (no fallback)
4. not qualified for grove → FALLBACK_MESSAGE (pre-existing behavior unchanged)

---

## Item #30 — Worktree exit at-stake guard (detached / moved-off HEAD)

Official: "Fixed `claude --worktree` removing the worktree and its branch without asking at exit when HEAD was detached or on another branch, which could lose commits." Byte-recovered symbols: `wV` (rev-list counter), `QEn` (branch-missing probe), `G$r` (HEAD classifier), `nOt` (at-stake computer), `tOt` (phrase formatter), `Ww` (telemetry).

### Files changed
- `src/utils/worktree.ts` — new at-stake subsystem (~lines 1760–2021): `countCommitsOnRefs` (official `wV`: `rev-list --count <positive refs> <negative refs> --`), `branchMissing` (official `QEn`: `for-each-ref --count=1 --format=%(refname) refs/heads/<b>`, empty stdout+stderr+code 0 → missing), `classifyWorktreeHead` (official `G$r`: `symbolic-ref -q HEAD` → detached = exit 1 with empty stdout AND stderr; its_branch / another_branch / like_its_branch (normalized-equal name) / detached / unreadable), `computeWorktreeExitAtStake` (official `nOt`: not_read fallback counts HEAD vs baseline; onKeptBranch refinement when another_branch && commits===0 && kept-branch count !== 0; fail-closed → commits null), `formatAtStakePhrase` (official `tOt` verbatim phrases), telemetry helper (`Ww` — `tengu_worktree_kept`/`tengu_worktree_removed` field names verbatim). `tengu_wary_ladle` hardcoded ON (featureFlags.ts deliberately untouched).
- `src/components/WorktreeExitDialog.tsx` — silent-removal fast path now additionally requires `!('onKeptBranch' in stake)` alongside `changeLines.length===0 && (commitCount===0 || hookForcedAsk)`; subtitles use the official `tOt` phrases (`You have N commits on <branch> that <other> doesn't have.` / `… or at the detached HEAD.`); unreadable HEAD keeps the v301 baseline-unavailable copy.
- `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts` — removal gate counts on `refs/heads/<worktreeBranch>` via the classifier (not HEAD); onKeptBranch → refusal (`result:false`, errorCode 2) with the official verbatim sentence; unreadable → fail-closed errorCode 3; `discard_changes:true` bypasses.
- New tests: `src/utils/__tests__/worktreeAtStake304.test.ts`, `src/components/__tests__/worktreeExitDialogAtStake304.test.tsx`, `src/tools/ExitWorktreeTool/__tests__/exitWorktreeAtStake304.test.ts`; existing `src/components/__tests__/worktreeExitDialogHook301.test.tsx` updated (304 classifier seam + OCC-97 restores + stdin-harness type fix).

### Verbatim strings applied
- `on ${branchName} that ${otherBranchName} doesn't have`
- `on ${branchName} or at the detached HEAD`
- `on ${branchName}` (plain case)
- onKeptBranch refusal: `The worktree is now on another branch, which has ${n} commits that this session's starting commit lacks. Removing the worktree keeps that branch, so no commit is lost, but the user may still be working there.`
- Telemetry event/field names: `tengu_worktree_kept`, `tengu_worktree_removed`.

### Tests
`bun test src/utils/__tests__/worktreeAtStake304.test.ts` → **30 pass / 0 fail / 51 expect()**
(countCommitsOnRefs argv shape + fail-closed ×3; branchMissing ×3; classifyWorktreeHead ×10 incl. hookBased no-call, no-branch, its_branch ±baseline, another_branch deleted-vs-exists, detached incl. HEAD-only fallback, like_its_branch case-variant with zero rev-list calls, unreadable ×2; computeWorktreeExitAtStake ×6 incl. not_read fallback, onKeptBranch refinement + fail-closed + kept-clean; formatAtStakePhrase ×4.)

`bun test src/components/__tests__/worktreeExitDialogAtStake304.test.tsx` → **5 pass / 0 fail / 14 expect()**
1. detached HEAD holding branch commits: ASKS with the official tOt detached phrase (pre-304: silent removal)
2. HEAD on another branch holding branch commits: ASKS with the "that <other> doesn't have" phrase
3. onKeptBranch refinement: own branch clean but kept branch holds commits → ASKS (never silent removal)
4. its_branch clean: silent removal unchanged
5. unreadable HEAD: ASKS with the baseline-unavailable copy (fail-closed)

`bun test src/tools/ExitWorktreeTool/__tests__/exitWorktreeAtStake304.test.ts` → **6 pass / 0 fail / 14 expect()**
1. detached HEAD holding branch commits → refuses with errorCode 2 (pre-304: HEAD count 0 → allowed)
2. HEAD on another branch holding branch commits → refuses with errorCode 2
3. onKeptBranch refinement → official verbatim refusal
4. its_branch clean → removal allowed
5. unreadable HEAD → fail-closed with errorCode 3
6. discard_changes: true bypasses the at-stake gate

`bun test src/components/__tests__/worktreeExitDialogHook301.test.tsx` → **7 pass / 0 fail / 19 expect()** (pre-existing v301 suite, still green against the 304 classifier).

Scenario matrix required by the task (#30d) is fully covered: detached-with-branch-commits → asks; another-branch-with-commits → asks; onKeptBranch → refuses; its_branch clean → auto-removes; unreadable → asks (fail-closed).

---

## Item #38 — SendMessage shutdown-approval guard

### Files changed
- `src/tools/SendMessageTool/SendMessageTool.ts` — guard at the top of `handleShutdownApproval` (`~:316`): official condition `teammateContext === undefined && !isTeammate()` → throw.
- `src/tools/SendMessageTool/__tests__/sendMessageShutdownGuard304.test.ts` (new — no pre-existing SendMessageTool tests).

### Verbatim string applied (byte-identical to official 2.1.304)
`Only a teammate can approve a shutdown request, and this session is not running as one. Nothing was sent. To shut down a teammate, send that teammate a shutdown_request message. The teammate is the one that approves it.`

Pre-fix, a main-session (or team-lead) model sending a structured `shutdown_response` with `approve:true` fell through to `gracefulShutdown` and killed the LEAD session itself.

### Tests (`bun test src/tools/SendMessageTool/…/sendMessageShutdownGuard304.test.ts` → **4 pass / 0 fail / 12 expect()**)
1. main session approving a shutdown_request throws the official verbatim message and does NOT shut down (0 mailbox writes, 0 gracefulShutdown calls)
2. team-lead session (isTeammate false, no context) is also refused — pre-fix it killed the lead
3. teammate approval still works: mailbox confirmation (`writeToMailbox('team-lead', …)`) + graceful self-exit (`gracefulShutdown(0, 'other')` via setImmediate)
4. in-process teammate (teammateContext present, isTeammate false) passes the guard

---

## Deviations from the official binary (10)

1. **`hh()` branch-name normalizer** — the official minified normalizer is unrecoverable byte-for-byte; ported as a case-insensitive lowercase comparison for `like_its_branch` detection. Fail-closed direction (a false "like" match sets commits null → asks, never silently removes).
2. **No pre-existing test suites** for grove / SendMessageTool / ExitWorktreeTool / privacy-settings — new test files created instead of extending existing ones.
3. **`worktrees_inside` telemetry field omitted** — OCC has no multi-inside-worktree bookkeeping to source it from; remaining `tengu_worktree_kept`/`tengu_worktree_removed` field names kept verbatim.
4. **`tengu_wary_ladle` hardcoded ON** (official gates the at-stake subsystem behind this flag) — follows the repo's `bright_lake` precedent; `src/utils/featureFlags.ts` deliberately NOT touched (outside cluster, and a new allowlist flag would activate nothing else).
5. **Official `${f} ${Dt}` confirm-tail placeholders** in the ExitWorktreeTool refusal message replaced with OCC's existing confirm guidance tail (`Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" …`) — the official interpolants are unrecoverable UI fragments; the verbatim at-stake SENTENCE is byte-identical.
6. **Dialog `Cn` special-case simplified** — official has a lazy-read branch; OCC's dialog always calls `computeWorktreeExitAtStake` up front (single code path, same observable outcomes across the full scenario matrix).
7. **`errorStatus` propagation scoped to `getGroveNoticeConfig` only** — that's the only grove call whose failure feeds `fetchAndStoreGroveConfig`'s re-stamp decision in the official code; settings failures return plain `{success:false}`.
8. **`like_its_branch` otherBranchName fallback `'the current HEAD'`** — unreachable in practice (like_its_branch implies a known other name); defensive only.
9. **OCC-97 snapshot/restore pattern added to all 6 new test files AND retro-fitted into `worktreeExitDialogHook301.test.tsx`** — discovery during this WP: Bun's `mock.module` crosses test-file boundaries in the same worker, and `mock.restore()` in afterEach does NOT undo module mocks. The pre-existing dialog301 file was already leaking (proof: `bun test worktree` failed 7 real-git tests at HEAD without any WP7 file present). All WP7 mock-owning files now snapshot real exports pre-mock and re-register them in `afterAll`, matching the repo-sanctioned pattern from `worktreeStartPoint300.test.ts`. Result: `bun test worktree` went from 178 pass/7 fail (HEAD baseline) → **220 pass/0 fail**.
10. **`formatAtStakePhrase` parameter typed as the full `WorktreeExitAtStake` union** (not `Pick<…,'head'>`) — the official `tOt` receives the whole at-stake object; the Pick form tripped excess-property checks for callers/tests constructing realistic literals. Runtime behavior identical (function reads only `.head`). Also fixed the dialog-test stdin harness cast (`Record<string, unknown>` stub) that carried 3 pre-existing TS2322s.

---

## Integration notes

- `src/utils/worktree.ts` is now ~2021 lines; the at-stake subsystem is self-contained (5 exported functions + telemetry) and consumed by exactly two sites: `WorktreeExitDialog.tsx` (interactive quit path) and `ExitWorktreeTool.ts` (agentic path). Both derive `commitCount` from `computeWorktreeExitAtStake` — no duplicated rev-list logic remains.
- The dialog's silent-removal guard and the tool's validateInput gate share the same classification → identical decisions for identical git states (verified by mirrored scenario tests in both suites).
- `grove.ts` `ApiResult` gained an optional `errorStatus?: number` — additive; all existing consumers (`privacy-settings.tsx`, grove dialog components) are unaffected. `usage.ts`/`claude.ts`/`withRetry.ts` were NOT touched (owned by another WP).
- **Known unrelated failures at hand-off** (verified NOT caused by WP7): `bun test src/utils/__tests__/` shows 13 fails identical with and without WP7 files present (drainStdout ×3, ideExtensionSingleLaunch300 ×3, statusNoticeTemplates278 ×4, argumentSubstitutionCaps301, invisibleUnicode, invalidSettingsReport076 — pre-existing / concurrent-WP territory). `bun test src/commands/` shows 2 unhandled-import errors (`extractForkLineage` in fork/pointer.ts, `refreshOverageCreditGrantCache` in overageCreditGrant.ts) — mid-edit state of concurrent WP5/WP6 files, outside this cluster.
- Verification runs at hand-off: WP7 battery (10 files incl. the 3 real-git worktree suites) → **109 pass / 0 fail**; `bun test worktree` → **220/0**; `src/components/__tests__/` → **166/0**; `src/services/api/__tests__/` → **641/0**; ExitWorktreeTool+SendMessageTool → **10/0**; Biome lint on all WP7 files → 0 errors, 3 warnings (all pre-existing `suppressions/unused` in worktree.ts at HEAD); `bunx tsc --noEmit` → 979 repo-wide (pre-existing, not a CI gate), **0 in WP7 files**.
