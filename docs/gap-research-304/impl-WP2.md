# impl-WP2 — hook deny-reason merge + image-read abort cluster (items #34, #32)

Agent: WP2. Source of truth: `docs/gap-research-304/research-R2-bash-perms.md` §#34/§#32 (byte-verified official 2.1.304 forensics + port recipes). Branch: `agent/occ-leader/3bdf2d90`. No git write commands were run; files only.

---

## Item #34 — PreToolUse deny reason replaced by SDK-callback-timeout error (PORT adapted, M) — DONE

### Files changed
- `src/utils/hooks.ts` — `callbackTimeout?: boolean` marker on `HookResult` + `AggregatedHookResult`; set on the 2.1.210 #9 callback-timeout swallow yield; propagated on BOTH per-result aggregated yields (the blockingError yield AND the permissionBehavior re-announcement yield @:4840 region)
- `src/services/tools/toolHooks.ts` — `lastDenyReason` tracker (the official `deniedBefore` analog) + `lastCallbackTimeoutDenyMessage` cache; merge logic in the blockingError branch, the permissionBehavior deny branch (re-announcement case), and the outer catch
- `src/services/tools/toolExecution.ts` — comment-only: verification note on the `case 'hookPermissionResult'` last-wins consumer (no logic change)
- NEW `src/services/tools/__tests__/hookDenyBeforeCallbackTimeout304.test.ts` — 11 tests (9 unit + 2 integration through the real pipeline)

### What was done
Official fix (v304 ELF @249269330–249269950): a `deniedBefore` recorder threaded through the aggregator/pipeline; the outer catch prepends it to the timeout stopReason — `$e=xe.deniedBefore?`${xe.deniedBefore}\n\n`:""` … `stopReason:Ee??$e+zVr`.

OCC has no fold-abort path — 2.1.210 #9 already swallows SDK-callback timeouts into a `blockingError` yield — but the same symptom occurs by **last-wins overwrite**: `toolExecution.ts` `case 'hookPermissionResult': hookPermissionResult = result.hookPermissionResult` keeps the LAST deny, so a fast real deny (reason R) was overwritten by a later timeout deny. Adapted port:

1. **Marker at the source (hooks.ts).** The #9 swallow yield now carries `callbackTimeout: true` (only set when `isPerHookCallbackTimeout` classified the abort as this callback's own timeout). Propagated onto the aggregated blockingError yield — that yield destructures per-field, so the marker would otherwise be dropped — AND onto the aggregated `permissionBehavior` yield (:4840 region), because the SAME timeout result also re-announces the (already-`deny`) aggregated behavior there with no reason of its own.
2. **Tracker + merge (toolHooks.ts).** `runPreToolUseHooks` tracks the last REAL deny message (`lastDenyReason`) from three sources: hook-input-validation denies (`check.deny.message`, the 2.1.300 #65 path), blockingError denies without the marker, and `permissionBehavior === 'deny'` denies without the marker. Callback-timeout denies are NEVER tracked (avoids stacking when several callbacks time out).
   - blockingError branch: `mergedMessage = result.callbackTimeout && lastDenyReason ? `${lastDenyReason}\n\n${denialMessage}` : denialMessage` — the official `$e+zVr` prepend form; also cached in `lastCallbackTimeoutDenyMessage`.
   - permissionBehavior deny branch: when the result carries `callbackTimeout`, the yield REPEATS `lastCallbackTimeoutDenyMessage` (defensive fallback: re-prepend `lastDenyReason` to the generic text if no cache) instead of emitting the generic `Hook PreToolUse:X denied this tool` fallback — under last-wins THIS is the final deny the consumer keeps, so it must stay in the merged form. Discovery: without this, the real pipeline's aggregated re-announcement clobbered the merged message with the generic fallback (integration-test caught it; see Test findings).
   - outer catch: `stopReason = `${denyPrefix}${PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE}`` with `denyPrefix = lastDenyReason ? `${lastDenyReason}\n\n` : ''` — the direct official analog, inside the existing `!abortController.signal.aborted` guard.
3. **Consumer verified (toolExecution.ts:954-955).** Last-wins is SAFE with this fix because the merged message is carried by the last (timeout) deny itself; verification comment added, no logic change.

### Verbatim vs adapted
| Piece | Decision |
|---|---|
| `PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE`, `hookCallbackTimeoutMessage` text, `tengu_sdk_hook_callback_timeout` event name | **Verbatim** (untouched, 2.1.210 #9 strings) |
| Prepend form `${R}\n\n${timeoutText}` (official `$e+zVr`) | **Verbatim shape** |
| `deniedBefore` fold-threading | **Adapted**: OCC's per-result yield pipeline has no fold; a per-run `lastDenyReason` variable in `runPreToolUseHooks` is the observable-equivalent tracker |
| Outer-catch prepend | **Direct port** of the official catch semantics |
| Re-announcement repeat (`lastCallbackTimeoutDenyMessage`) | **OCC-specific addition** required by the last-wins consumer + hooks.ts aggregated-yield design; documented in code comments |

### Tests (all green)
`src/services/tools/__tests__/hookDenyBeforeCallbackTimeout304.test.ts` — `11 pass, 0 fail, 41 expect() calls`:
- unit (mocked `executePreToolHooks` seam, hookPluginId301.test.ts pattern): permissionBehavior deny + timeout → merged `R\n\nPreToolUse:T hook error: <timeout text>` (+ `decisionReason.reason` mirrors); blockingError (exit-2 style) deny + timeout → merged; timeout alone → plain #9 message (no `\n\n`, no leading newline); two consecutive timeouts → only the LAST timeout text, each prefixed by R only (no stacking); aggregated re-announcement repeats the merged message (last-wins final, generic fallback must NOT appear); re-announcement without prior deny repeats the plain timeout message; defensive re-announcement path still prepends R; outer-catch: dispatch failure after a real deny → stopReason `R\n\n${PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE}` + final `stop`; dispatch failure with no deny → bare `PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE` (#9 regression guard).
- integration (REAL hooks.ts pipeline via a `useRealHooks` delegation flag in the same mock seam; `registerHookCallbacks` with hook A = official deny JSON `permissionDecisionReason`, hook B = idle callback, `timeout: 0.05` s, rejects on its per-hook abort): final deny === `${R}\n\nPreToolUse:T hook error: ${hookCallbackTimeoutMessage('PreToolUse:T', 50)}`; NO stopReason/stop yields; `tengu_sdk_hook_callback_timeout` fires exactly once (counted via the real `attachAnalyticsSink` seam — no analytics module mock); timeout-only control case → exactly one plain deny (no re-announcement: aggregated permissionBehavior stays `undefined`), telemetry once. Real timers (~50 ms), 15 s test timeouts.

### Test findings / decisions worth knowing
- **bun `mock.module` restore does not reliably rewire already-instantiated importers in one `bun test` process.** A first attempt kept unit + integration in two sibling files; in a combined run the integration file's `toolHooks` instance stayed bound to the unit file's mock (stale `preToolHookThrowAfter` → spurious stopReason, 0 denies). Fix: ONE file, mock dispatcher delegates to the captured real `executePreToolHooks` when `useRealHooks` is set; `afterAll` additionally leaves `useRealHooks = true` before restoring, so even a stale-bound later file would hit the REAL implementation, never stale mock state.
- **Pre-existing cross-file pollution observed (NOT WP2, not fixed — files outside cluster):** `hookUpdatedInputValidation300.test.ts` + `writeCoerceNote280.test.ts` in one run → the latter's 5 tests fail (its tool gets denied by the former's leaked `checkHookUpdatedInput` mock/registration; each passes standalone; also fails WITHOUT my file present — verified). Same pattern: `skillHooksBounds304.test.ts` (concurrent WP3 file) pollutes `mainThreadHookRegistration.test.ts` (2 fail in the full-dir run; 266/0 with it excluded). Candidate follow-up: adopt the delegation-flag pattern repo-wide or restore via fresh process isolation.

---

## Item #32 — interrupt not ending a Read waiting on an idle pipe/device named like an image (PORT, S) — DONE

### Files changed
- `src/tools/FileReadTool/imageRead.ts` — optional `signal?: AbortSignal` on `readNonRegularCapped` / `readImageBytesFromHandle` / `readImageBytesCapped`; local `raceAbort` helper = faithful port of official `$i` (@236274849, verbatim body quoted in the doc comment); top-of-loop `if (signal?.aborted) throw new AbortError()` (official `Mbn` loop head)
- `src/tools/FileReadTool/FileReadTool.ts` — `readImageWithTokenBudget(filePath, maxTokens, maxBytes?, signal?)` 4th param threaded to `readImageBytesCapped`; image-branch call site (~:1330) passes `context.abortController.signal` (official passes `pdfRenderSignal ?? signal` @248585955 — OCC has no `pdfRenderSignal` on this branch; noted in the branding comment)
- NEW `src/tools/FileReadTool/__tests__/imageReadAbort304.test.ts` — 7 tests

### What was done
Official-faithful threading: only the NON-REGULAR (pipe/FIFO/character-device) read loop is abortable — `readRegularFileBytes` stays unthreaded (official `Mbn` races only the non-regular reads). Each pending `handle.read` is wrapped `await (signal === undefined ? pendingRead : raceAbort(pendingRead, signal, () => new AbortError()))`, mirroring official `await(r===void 0?H:$i(H,r,()=>new Ye))`. `raceAbort` replicates `$i` exactly: pre-aborted fast path, `{once:true}` abort listener racing the read, source-rejection swallowing (`pending.catch(()=>{})`) so a late read rejection after abort can never surface as an unhandled rejection, `removeEventListener` in `finally`.

### Tests (all green)
`src/tools/FileReadTool/__tests__/imageReadAbort304.test.ts` — 7 tests, part of `26 pass, 0 fail` combined run with `imageReadCap302` + `imageReadSeam302`: pre-aborted signal → immediate AbortError, zero read calls; mid-read abort on an idle handle → AbortError; late source rejection after abort swallowed (a `process.on('unhandledRejection')` monitor stays empty across tick flushes); between-chunks abort (dribble handle, `queueMicrotask` abort) → AbortError with ≤1 read; no-signal path unchanged (idle handle still hangs until settled — official pre-fix behavior preserved); `readImageBytesCapped` end-to-end via the `setFsImplementation` seam → mid-read abort → AbortError + handle closed (`finally` intact); `readImageWithTokenBudget` pre-aborted → `isAbortError`, 0 reads, handle closed.

---

## Deviations & integration notes (both items)

1. **`src/utils/attachments.ts:2676` left unthreaded** (per task spec + official: the attachments/watch background path keeps calling `readImageBytesCapped` without a signal @248745435). attachments.ts NOT edited (outside cluster).
2. **`raceAbort` kept local to `imageRead.ts`**, not extracted to a shared `src/utils/` helper — `src/utils/` is outside the WP2 cluster (concurrent WPs). If a later round wants it shared, it's a pure lift-and-shift.
3. **Environment repair (no package.json change):** the isolated bun install materialized patched `@anthropic-ai/sandbox-runtime@0.0.44` top-level without sibling deps, so `FileReadTool.js` dynamic imports failed on `@pondwader/socks5-server`. Fixed with a node_modules symlink only: `ln -sfn ../.bun/node_modules/@pondwader/socks5-server node_modules/@pondwader/socks5-server`. Local-env artifact; pre-existing suites (imageReadCap302) were equally affected.
4. **Real timers** for the integration tests (50 ms hook timeout) instead of fake timers — avoids registration races with the per-hook `createCombinedAbortSignal` setTimeout.
5. **Verification runs:** `bun test src/services/tools/__tests__/hookDenyBeforeCallbackTimeout304.test.ts src/tools/FileReadTool/__tests__/imageReadAbort304.test.ts src/utils/hooks/__tests__/hookCallbackTimeout.test.ts` → `26 pass, 0 fail`; `bun test src/tools/FileReadTool/__tests__/` → `159 pass, 0 fail`; `bun test src/utils/hooks/__tests__/` minus WP3's concurrent file → `266 pass, 0 fail`; `bunx biome lint <7 changed/new files>` → 0 errors 0 warnings; `bunx tsc --noEmit` → no NEW errors in WP2 files (flagged lines are pre-existing classes at unedited locations; repo baseline ~1341, tsc is not the CI gate).
6. **Cluster discipline:** only `src/utils/hooks.ts`, `src/services/tools/toolHooks.ts`, `src/services/tools/toolExecution.ts` (comment-only), `src/tools/FileReadTool/**`, the two new test files, and this doc were touched. `registerSkillHooks.ts` / `sessionHooks.ts` / `attachments.ts` / CHANGELOG / package.json / gap docs untouched. No git write commands run.
