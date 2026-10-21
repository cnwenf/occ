> **⚠️ PARTIALLY SUPERSEDED (OCC-125 reconciliation, 2026-10-22):** **Task A**
> (Shell ENOSPC pre-spawn guard) below was implemented in this round but
> **DROPPED before commit** — the parallel OCC-165 round landed its own version
> (main's P5, `shellDiskFullStart306`) on origin/main first, and per the
> collision precedent main wins every overlapping implementation. Task A's
> file/test names refer to the pre-reconciliation WIP commit `dc40f769`, NOT to
> the committed tree. **Task B** (compaction headTruncated notice) is a KEEPER —
> main's P10 (`repeatsCompactSummary`) is a different mechanism; Task B landed
> as described. See `docs/upstream-version-gap-occ125-2026-10.md` §1.

# WP4 Implementation Report — CC 2.1.305 ports (Task A + Task B)

Agent: WP4 implementation agent (branch `agent/occ/156f5788`, shared worktree).
Binary of record: `/tmp/cc-diff-306/v306/package/claude` (READ-ONLY forensics, never executed).
All strings byte-verified via `grep -aboF` + `dd` windows and re-verified programmatically against the landed sources with `bun -e` (fragment-by-fragment, `binary: true / source: true`).

---

## Task A — Bash ENOSPC pre-spawn guard

Research source: `docs/gap-research-306/research-R4-worktree-enospc.md` Item 2.

### Official evidence (v306)

- catch-block branch @249973940 (string pool @126106520):
  `if(Fa===void 0&&FSn(cs))return Ok(\`The command was not started: this computer's disk is full (${E(cs)}), so the file that captures command output could not be created. Nothing ran. If this is the user's own computer, tell them before deleting anything to make room.\`)`
  — placed AFTER the E2BIG branch (`Ok(Fr,"e2big")`) and BEFORE the generic fallback (`Ok(d(cs))`); `Fa===void 0` = child never spawned.
- classifier `FSn` @237500817:
  `function FSn(n){let e=E(n);return e==="ENOSPC"||e==="EDQUOT"}`

### Landed changes

- `src/utils/errors.ts` — new `isDiskFullError(e: unknown): boolean` mirroring `FSn`: code-based only via existing `getErrnoCode` (`ENOSPC || EDQUOT`), no message-substring fallback (deliberate — see Deviations).
- `src/utils/Shell.ts` —
  1. moved the task-output `mkdir` + `open` INSIDE the guarded `try` (previously outside → raw ENOSPC path leak, 1:1 with official pre-fix state);
  2. added `childSpawned` flag, set `true` immediately after `spawn()` succeeds (official `Fa===void 0` equivalent);
  3. new catch branch after E2BIG / before generic fallback: `if (!childSpawned && isDiskFullError(error))` → `createAbortedCommand(undefined, { code: 126, stderr: <byte-exact official message with `(${getErrnoCode(error)})` interpolated> })`.
- Bash + PowerShell share `Shell.exec` (confirmed: `BashTool.tsx:1165`, `PowerShellTool.tsx:783`) — one guard covers both tools.

### Tests — `src/utils/__tests__/shellEnospcPreSpawn305.test.ts` (NEW, 6 tests)

| Test | Asserts |
|---|---|
| ENOSPC pre-spawn | spawn never called, code 126, stderr byte-equals official message `(ENOSPC)`, no raw errno/path leak |
| EDQUOT variant | same message with `(EDQUOT)` |
| EACCES | unchanged generic code-126 fallback (raw message surfaced, no friendly rewrite) |
| E2BIG ordering | open OK + spawn throws E2BIG → E2BIG message wins (branch order preserved) |
| pipe mode (`onStdout`) | guard inert: open never called, spawn runs with `['pipe','pipe','pipe']` |
| `isDiskFullError` unit | ENOSPC/EDQUOT true; EACCES/E2BIG/message-only/string/undefined/null false |

Mocking: load-time `REAL_FS`/`REAL_CP` snapshots + `mock.module`, restored in `afterEach` (diskOutputDrainGuard247 pattern — bun test shares one process). Spawn fakes THROW so no real process can ever start.

---

## Task B — compaction headTruncated notice

Research source: `docs/gap-research-306/research-R6-skip-triage.md` item 2.

### Official evidence (v306)

- composer `EZ` @~249154251, note @249154327:
  `if(n?.headTruncated)h+=\`\n\nNote: the earliest part of the conversation was too large to include and is NOT covered by this summary${n.transcriptPath&&!ee()?" (the full transcript mentioned above still has it)":""}. If the task turns out to depend on something from that part, say so plainly rather than guessing at it.\``
  — appended AFTER the transcriptPath line, BEFORE the suppressFollowUpQuestions continuation.
- call sites pass `headTruncated:Wt>0` (Wt = PTL head-truncation retry count).

### Landed changes

- `src/services/compact/prompt.ts` — `getCompactUserSummaryMessage` gains 5th param `headTruncated?: boolean`; note appended in official position. OCC has no RC-withheld-summary gate (`ee()`), so the parenthetical condition reduces to `transcriptPath` — the same guard that gates the transcript line above ("mentioned above" stays accurate).
- `src/services/compact/compact.ts` — BOTH `getCompactUserSummaryMessage` call sites (full path in `compactConversation`, partial path in `partialCompactConversation`) now pass `ptlAttempts > 0` (official `Wt>0` equivalent).
- `src/services/compact/sessionMemoryCompact.ts` — intentionally UNTOUCHED: no PTL head truncation occurs there; `headTruncated` stays `undefined` → no note (see Deviations).

### Tests — `src/services/compact/__tests__/compactionHeadTruncated305.test.ts` (NEW, 7 tests)

| Test | Asserts |
|---|---|
| true + transcriptPath | byte-exact note WITH parenthetical; follows the transcript line |
| true, no transcriptPath | byte-exact note WITHOUT parenthetical |
| false / undefined | no note (all transcriptPath combos) |
| official ordering | transcript line → note → "Continue the conversation…" continuation |
| toolNamesUsed interplay | 2.1.304 #6 tag placement unaffected by 5th param |
| grep: compact.ts threading | exactly 2 call sites, both ending in `ptlAttempts > 0`; no unthreaded call site |
| grep: prompt.ts gate | `headTruncated?: boolean` param + `if (headTruncated)` gate + note body present |

### Existing-test adjustment

- `src/services/compact/__tests__/compactionRecentNote293.test.ts` — `.length` assertion 4→5 (signature gained the 5th param); test renamed accordingly. No behavioral change to that suite's other tests.

---

## Verification summary

| Gate | Result |
|---|---|
| New Task A suite | 6 pass / 0 fail / 28 expect |
| Shell regression (shellEnospcPreSpawn305 + shellCommandPreAbort285 + task/diskOutputDrainGuard247) | 23 pass / 0 fail (re-verified post-compaction); earlier 9-file sweep: 87 pass / 0 fail / 201 expect |
| New Task B suite + compactionRecentNote293 | 20 pass / 0 fail / 101 expect |
| Full `src/services/compact/__tests__/` | 65 pass / 0 fail / 165 expect (7 files) |
| `bunx biome lint` (Task A: errors.ts, Shell.ts, shellEnospcPreSpawn305.test.ts; Task B: prompt.ts, compact.ts, both test files) | 0 errors |
| Byte-verify Task A message vs binary @249973940 | all fragments `true` (bun -e comparison) |
| Byte-verify Task B note vs binary @249154327 | all fragments `true`, `if(n?.headTruncated)` gate present in binary window |
| Repo-wide `bun test` | NOT run (per WP rules) |
| `git commit` / `bun install` | NOT run (per WP rules) |

## Files touched (all within allowed scope)

- `src/utils/errors.ts`
- `src/utils/Shell.ts`
- `src/utils/__tests__/shellEnospcPreSpawn305.test.ts` (new)
- `src/services/compact/prompt.ts`
- `src/services/compact/compact.ts`
- `src/services/compact/__tests__/compactionHeadTruncated305.test.ts` (new)
- `src/services/compact/__tests__/compactionRecentNote293.test.ts` (assertion 4→5)
- `docs/gap-research-306/impl-WP4.md` (this report)

## Deviations & judgment calls

1. **`isDiskFullError` is code-based only** — the research plan floated an optional message-substring fallback (like `auth.ts`'s `isDiskFullOAuthRefreshError`). Rejected: official `FSn` reads ONLY the errno code (`E(n)`), and the companion message interpolates `${E(cs)}` — a codeless match would render `(undefined)`. Documented in the JSDoc.
2. **`sessionMemoryCompact.ts` untouched** — the task listed it as optional ("optionally sessionMemoryCompact.ts:468"). Session-memory compaction has no PTL head-truncation retry loop, so `Wt` would always be 0; passing a hardcoded `false` adds noise. `undefined` → falsy → no note, identical observable behavior.
3. **293 test signature assertion updated 4→5** — required by the new param; the file is in `src/services/compact/**` (allowed scope). Its grep-level test asserting compact.ts does NOT contain `appendPreservedMessagesNote`/`applyPreservedMessagesNote` remains satisfied (my compact.ts edits add neither).
4. **Official `!ee()` RC-withheld gate dropped** — OCC has no Remote-Control withheld-summary concept; parenthetical reduces to the `transcriptPath` guard, matching the official when `ee()` is false (the only OCC-reachable state). Documented in the prompt.ts comment.

## Blockers

None.
