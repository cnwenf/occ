# Triage T1 — 2.1.310 items 1–6

Evidence base: BIN310 = `/tmp/cc-diff-310/bin310/package/claude`, BIN309 = `/tmp/cc-diff-310/bin309/package/claude` (never executed; inspected read-only via `grep -caboF` hit counts on both binaries and `dd` verbatim extraction). OCC repo = `workdir/occ` (read-only). Skill discipline applied: every claim about the official is byte-pinned; anything not byte-pinnable is STAGED, not guessed.

## Verdict tally

| # | Changelog (short) | Verdict | One-line reason |
|---|---|---|---|
| 1 | Monitor on Bedrock/Vertex/Foundry; sleep blocked there too | **N-A** | Official removed a Statsig gate OCC never had |
| 2 | Retry without `effort-2025-11-24` beta / mid-conv system | **PORT** | OCC sends effort beta with no rejection heal |
| 3 | cleanupPeriodDays huge value deletes recent files | **PORT** | OCC lacks NaN cutoff guard; worktree sweep deletes |
| 4 | Post-"Prompt is too long" compaction keeps too much | **STAGED** | Fix lives in reactive-compact loop OCC stubs out |
| 5 | Read permission prompts don't show symlink target | **PORT** | OCC has the exact 309 read-skip bug |
| 6 | Auto-continue timeout fires after external editor close | **PORT** (micro) | One-call fix; OCC opener matches 309 shape |

Tally: **PORT 4** (items 2, 3, 5, 6) · **STAGED 1** (item 4) · **N-A 1** (item 1)

---

## Item 1 — Monitor tool on Bedrock/Vertex/Foundry + telemetry/nonessential-disabled; long foreground sleeps blocked there too

> Added the Monitor tool and plugin monitors on Bedrock, Vertex, and Foundry, and when telemetry or nonessential traffic is disabled; long foreground sleeps are now blocked there too

**Verdict: N-A**

**OCC surface:**
- `src/tools.ts:44-45,241` — Monitor registration
- `src/utils/featureFlags.ts:13-17` — static allowlist
- `src/tools/BashTool/BashTool.tsx:619-628` — foreground sleep block
- `src/utils/envUtils.ts:83-88` — `areBackgroundTasksDisabled()`

**Current OCC behavior:**
```ts
// src/tools.ts:44
const MonitorTool = feature('MONITOR_TOOL') ? require('./tools/MonitorTool/MonitorTool.js').MonitorTool : null
// src/utils/featureFlags.ts — FEATURE_ALLOWLIST includes 'MONITOR_TOOL' (static, no remote gate)
// src/tools/BashTool/BashTool.tsx:619-628
if (feature('MONITOR_TOOL') && !isBackgroundTasksDisabled && !input.run_in_background) {
  const sleepPattern = detectBlockedSleepPattern(input.command);
  if (sleepPattern !== null) {
    return { result: false, message: `Blocked: ${sleepPattern}. Run blocking commands in the background with run_in_background: true — ...`, errorCode: 10 };
  }
}
```

**Official evidence — the 309→310 change is gate REMOVAL, not behavior addition:**

`tengu_amber_sentinel` (the Statsig gate that kept Monitor off on Bedrock/Vertex/Foundry and when telemetry/nonessential traffic disabled): strings s309 = **2 hits**, s310 = **0 hits**. BIN309 JS offsets 248593453/248593459; BIN310 = none.

BIN309 Monitor `isEnabled` (@~256990000, gate present):
```js
isEnabled(){return Q3()&&hd()}
// function Q3(){return k("tengu_amber_sentinel",!1)}   @248593429
// function hd(){if(M()!=="windows")return!0;return _Z()!==null}  @245051944
```
BIN310 Monitor `isEnabled` (@~254843972, gate gone):
```js
isEnabled(){return vd()}
// function vd(){if(O()!=="windows")return!0;return nee()!==null}  @242652870
```

Sleep-block gate — BIN309 @~253981516 has `Q3()` (amber-sentinel) as the first conjunct; BIN310 @~251677853 drops it:
```js
// 309: if(Q3()&&!ep()&&tne()&&s.remoteCall?.constraints.background!=="forbidden"&&!n.run_in_background&&s.shellWallCapMs===void 0)
// 310: if(!ap()&&zne()&&s.remoteCall?.constraints.background!=="forbidden"&&!n.run_in_background&&s.shellWallCapMs===void 0)
// 310 helpers @244783062 / @245564584:
// function ap(){return vf().backgroundTasksDisabled||__e()}
// function __e(){return i.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS||wr()}
// function zne(){return!vf().backgroundCompletionNoticeDisabled}
```
Blocked-sleep message anchor `To wait for a condition, use Monitor`: BIN310 @120399074/251677853/262896722; BIN309 @126678738/253981516/265527582 — text identical in both binaries.

**Action — N-A immunity argument:** The official 310 change *relaxes* gating: Monitor and the sleep block are no longer conditioned on the `tengu_amber_sentinel` remote Statsig flag (which is what kept them off on Bedrock/Vertex/Foundry and under telemetry/nonessential-off settings). OCC has no remote gate layer at all — `feature('MONITOR_TOOL')` is a static allowlist entry (`src/utils/featureFlags.ts`), and Monitor is therefore already unconditionally enabled in OCC, exactly matching 310's end state. The sleep block's remaining official conditions (`backgroundTasksDisabled`, `backgroundCompletionNoticeDisabled`, remote-call constraints, `shellWallCapMs`) map onto OCC's `!isBackgroundTasksDisabled && !input.run_in_background` guard; OCC's Bedrock/Vertex/Foundry provider paths (`src/utils/model/provider.ts` et al.) never consult a gate, so there is no provider-conditional suppression to remove. Structurally immune — nothing to port.

*Secondary note (not this item's fix):* OCC's block message text (`` `Blocked: ${sleepPattern}. Run blocking commands in the background with run_in_background: true — ...` ``) diverges from the official text, which is identical in both binaries: `` `Blocked: ${D}. To wait for a condition, use Monitor with an until-loop (e.g. \`until <check>; do sleep 2; done\`). To wait for a command you started, use run_in_background: true. Do not chain shorter sleeps to work around this block.` `` (BIN310 JS @251677853, errorCode 10). A pre-existing copy drift, tracked separately from 310 alignment.

---

## Item 2 — Requests failing behind gateways rejecting `effort-2025-11-24` beta / mid-conversation system messages

> Fixed requests failing behind some gateways and compatible servers that reject the `effort-2025-11-24` beta value or mid-conversation system messages; Claude Code now retries without them

**Verdict: PORT** (effort-beta half; mid-conv-system half is immune — see action)

**OCC surface:**
- `src/constants/betas.ts:15` — `EFFORT_BETA_HEADER`
- `src/services/api/claude.ts:655-677` — `configureEffortParams()` (sends the beta)
- `src/services/api/withRetry.ts` (~options 340-410) — existing heal-hook pattern
- `src/utils/model/harnessReminderRole.ts:47-56` — mid-conv system half (immune)

**Current OCC behavior:**
```ts
// src/constants/betas.ts:15
export const EFFORT_BETA_HEADER = 'effort-2025-11-24'
// src/services/api/claude.ts:655-677 (configureEffortParams)
if (!modelSupportsEffort(model)) { delete outputConfig.effort; return }
if ('effort' in outputConfig) return
if (effortValue === undefined) { betas.push(EFFORT_BETA_HEADER) }        // line 671
else { outputConfig.effort = effortValue; betas.push(EFFORT_BETA_HEADER) } // line 675
```
No rejection heal anywhere: `grep -rn "effort_unsupported\|markEffortUnsupported\|retry:effort" src/` → zero non-test hits. OCC already has the same heal-hook architecture for other betas in `src/services/api/withRetry.ts` (`retryContext1mBetaRefused`, `retryContextManagementRefused`, `retryToolSchemaRefused`, `retryToolSearchRefused`) — the effort arm is simply missing.

Mid-conv-system half: `src/utils/model/harnessReminderRole.ts:47-56` `shouldUseSystemRoleForHarnessReminders(model)` returns `false` always; `grep -rn "role: 'system'" src/` → 0 hits. OCC never emits mid-conversation system turns, so the second half of this changelog cannot affect it.

**Official evidence — 310 adds a generic beta-reject matcher to the effort-unsupported detector:**

BIN309 @250568316 (message-only detection):
```js
function Xq(e){...return mH(e.message,"effort_unsupported")}
```
BIN310 @248256506 (adds header-400 matcher):
```js
function $K(e){...return ID(e.message,"effort_unsupported")||FK(e,tbe)}
```
New-in-310 matcher BIN310 @248251842:
```js
function FK(e,n){if(!(e instanceof Dt)||n.header===null)return!1;return b8t(e,n.header)||S8t.get(n)?.(e.message)===!0}
function b8t(e,n){return/^Unexpected value\(s\) ((?:`[^`]+`(?:, )?)+) for the `anthropic[-_]beta`/.exec(jbe(e))?.[1]?.includes(`\`${n}\``)===!0||ID(e.message,`beta_header:${n}`)}
```
Header constant @239560533: `tbe=k("effort","effort-2025-11-24")`. `effort-2025-11-24` literal: **2 hits in each binary** (310 @116969208/239560549; 309 @128582448/241871022) — the header existed in 309 too; the *matcher* is new.

Heal arm — BIN310 `x_t`:
```js
x_t=(Qn)=>{if(!$K(Qn))return null;...t(`[effort] the server refused effort for model ${Q.model} (the output_config.effort field or the anthropic-beta value ${tbe.header}). Sending the request again without either; this Claude Code process will not send either to this model again.`,{level:"warn"}),a("tengu_effort_unsupported_retry",{model:wt(Q.model)}),"retry:effort-unsupported"}
```
vs BIN309 `r_t`: `` `[effort] model ${Q.model} rejected output_config.effort; latching unsupported and retrying without it.` `` — 310's heal now covers the *beta header* rejection too (drop both `output_config.effort` and the beta).

Per-model latch — identical in both binaries (310 @237334254, 309 @239667877):
```js
effortUnsupportedModels(){return this.#o}markEffortUnsupported(e){this.#o.add(e)}
```
readers 310 @237383327 / 309 @239716442. Mid-conv-system heal machinery (`[mid-conv-system]` 8 hits each; `systemMessagesAcceptedBy` 8 hits each) structurally unchanged 309→310.

**Action — PORT:** Add an effort-beta-refused heal arm to `src/services/api/withRetry.ts` following the existing `retryContext1mBetaRefused` pattern:
1. Detector: a request-level error is effort-refused when its message contains `effort_unsupported` **or** (new in 310) it is a 400 whose message matches `/^Unexpected value\(s\) ((?:`[^`]+`(?:, )?)+) for the `anthropic[-_]beta`/` with a captured list including `` `effort-2025-11-24` ``, **or** contains `beta_header:effort-2025-11-24`.
2. Heal: strip `outputConfig.effort` (if set) **and** remove `EFFORT_BETA_HEADER` from the betas array, retry once.
3. Latch: per-model set (mirror official `effortUnsupportedModels()`/`markEffortUnsupported`) consulted in `configureEffortParams` (`src/services/api/claude.ts:655`) so the process never sends either to that model again — matching official semantics exactly, no invented TTL.
4. Log text (official verbatim, 310): `[effort] the server refused effort for model ${model} (the output_config.effort field or the anthropic-beta value effort-2025-11-24). Sending the request again without either; this Claude Code process will not send either to this model again.` (warn level).
5. Mid-conv-system half: **no action** — OCC never sends mid-conversation system turns (`harnessReminderRole.ts:52` returns `false` unconditionally), so it is immune.

---

## Item 3 — cleanupPeriodDays very large deletes recent files

> Fixed background cleanup deleting some recent files, such as pasted images, when `cleanupPeriodDays` is set to a very large value

**Verdict: PORT**

**OCC surface:**
- `src/utils/cleanup.ts:23-31` — `getCutoffDate()` (no NaN guard)
- `src/utils/cleanup.ts:625-626` — `cleanupOldPastes(getCutoffDate())`, `cleanupStaleAgentWorktrees(getCutoffDate())`
- `src/utils/worktree.ts:1508-1546` — the delete-direction-vulnerable consumer
- `src/utils/settings/types.ts:376-384` — zod schema lets huge values through

**Current OCC behavior:**
```ts
// src/utils/cleanup.ts:23-31
const DEFAULT_CLEANUP_PERIOD_DAYS = 30;
function getCutoffDate(): Date {
  const settings = getSettings_DEPRECATED() || {};
  const cleanupPeriodDays = settings.cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS;
  const cleanupPeriodMs = cleanupPeriodDays * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - cleanupPeriodMs)   // no NaN/Infinity guard
}
```
```ts
// src/utils/worktree.ts:1523,1543 — INVERTED comparison: NaN cutoffMs → falls through to deletion
const cutoffMs = cutoffDate.getTime()
...
if (mtimeMs >= cutoffMs) { continue }   // NaN >= x is false → never continues → deletes everything
```
Failure mode: `cleanupPeriodDays` at a very large value (schema `z.number().int().positive()` passes e.g. `1e300`; `types.ts:376-384`) → `cleanupPeriodMs` overflows to `Infinity` → `new Date(Date.now() - Infinity)` → Invalid Date → `getTime()` = NaN → in `worktree.ts` the `mtimeMs >= NaN` guard never fires and **recent** worktree dirs get deleted. Other OCC consumers fail safe (`src/utils/pasteStore.ts:96` `stats.mtimeMs < cutoffTime`; `cleanup.ts:140/329/373` `stats.mtime < cutoffDate` — NaN comparisons false → no delete), so worktree.ts is the live bug; pasted-image deletion (the changelog's example) is prevented in OCC only by pasteStore's safe comparison direction.

**Official evidence — 310 factors the Date math into a NaN-guarded helper returning null:**

BIN309 @~260440559 (single unguarded function):
```js
function _S(e){let s=(pr()||{}).cleanupPeriodDays??QUt;if(s===0)return null;if(e!==void 0&&e<s)s=e;let n=s*24*60*60*1000;return new Date(Date.now()-n)}
```
BIN310 @~258251302 (new `_e` NaN guard; `kS` delegates):
```js
function _e(e){let r=new Date(Date.now()-e*24*60*60*1000);return Number.isNaN(r.getTime())?null:r}
function kS(e){let s=(pr()||{}).cleanupPeriodDays??m1t;if(s===0)return null;if(e!==void 0&&e<s)s=e;return _e(s)}
```
Callers now skip the sweep on null cutoff (BIN310 @~258253022 and @~258255708):
```js
let r=kS();if(r===null)return E();
let r=kS(),s=E();if(r===null)return s;
```
Anchors: `cleanupPeriodDays??` 1 hit each binary; `Use a large value for long retention` 2 hits each — settings text unchanged, the fix is purely the null-cutoff mechanism.

**Action — PORT:** In `src/utils/cleanup.ts`, mirror the official split exactly:
1. Extract the Date math into a guarded helper: `function cutoffDateFromDays(days: number): Date | null { const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000); return Number.isNaN(d.getTime()) ? null : d }`
2. Change `getCutoffDate()` return type to `Date | null`, keeping the `cleanupPeriodDays === 0 → null` short-circuit and the `Math.min`-equivalent cap logic already present, delegating the final math to the guarded helper.
3. Update every caller that currently assumes a `Date` (lines 95, 156, 271, 306, 351, 397, 436, 625, 626) to skip its sweep when the cutoff is `null` — same shape as official `if(r===null)return E();`.
4. Independently of the guard, fix `src/utils/worktree.ts:1543`'s inverted comparison (`if (mtimeMs >= cutoffMs) continue`) so a NaN/invalid cutoff can never fall through to deletion — defense in depth consistent with the official's null-means-skip semantics. No invented clamps or max-value caps: the official has none.

---

## Item 4 — Post-"Prompt is too long" compaction keeps too much dense text

> Fixed compaction after a "Prompt is too long" error keeping too much of a conversation with dense text, such as base64 or SVG, so the next request could fail again

**Verdict: STAGED**

**OCC surface:**
- `src/services/compact/reactiveCompact.ts` (22 lines) — **auto-generated stub**, all functions no-op
- `src/query.ts:20-31` — documented-dormant wiring (`REACTIVE_COMPACT` ∉ FEATURE_ALLOWLIST)
- `src/services/api/errors.ts:69-124` — PTL parser (exists, matches official regex)
- `src/services/compact/compact.ts:257-322` — `truncateHeadForPTLRetry` (OCC's live PTL fallback)

**Current OCC behavior:**
```ts
// src/services/compact/reactiveCompact.ts — entire file is a stub
export const isReactiveOnlyMode = () => false;
export const reactiveCompactOnPromptTooLong = async () => ({ ok: false });
export const isReactiveCompactEnabled = () => false;
export const tryReactiveCompact = async () => null;
// src/query.ts:20-31 comment: "REACTIVE_COMPACT is NOT in src/utils/featureFlags.ts
// FEATURE_ALLOWLIST → feature() returns false → reactiveCompact is always null here…"
```
The official fix lives entirely inside the reactive-compaction round loop that OCC has deliberately left dormant — there is no live code path to attach the fix to.

**Official evidence — 310 replaces raw-gap seeding with ratio-scaled seeding:**

`serverTokensPerEstimate`: BIN309/s309 = **0 hits**; BIN310 = **2 hits** (124138536 data, 249120329 JS) — new-in-310 concept, byte-pinned.

BIN310 round-ladder seeding @~249120329:
```js
if(r?.promptTooLong!==void 0&&w>3){let{gap:kt,actual:dt}=r.promptTooLong;xe=s.map((zt)=>Zg(zt));let St=xe.reduce((zt,Jt)=>zt+Jt,0),mt=Kd(n.systemPrompt.join(` `));Ee=St>0?Math.max(1,(dt-mt)/St):1;let Ct=Kd(dee(r.customInstructions,fee(),gee(n.toolUseContext)!==void 0)),Gt=kt/Ee+Ct-(xe[w-1]??0);if(Gt>0){let zt=Vcn(xe,w-1,Gt);be=1+zt,Te={mode:"seeded",step:zt,tokenGap:kt}}}
```
BIN309 seeding (same region @~251425715):
```js
if(r?.initialTokenGap!==void 0&&w>3){ve=s.map((kt)=>jg(kt));let ft=r.initialTokenGap-(ve[w-1]??0);if(ft>0){let kt=Fcn(ve,w-1,ft);Se=1+kt,we={mode:"seeded",step:kt,tokenGap:r.initialTokenGap}}}
```
The bug and fix, exactly: 309 seeds the raw server-reported token gap (`initialTokenGap`) directly against **local** per-message estimates (`jg`). Dense text (base64/SVG) is undercounted by local estimators, so the ladder keeps too many messages → next request fails again. 310 passes `{gap, actual}` server tokens and computes `Ee = serverTokensPerEstimate = Math.max(1, (actual − systemPromptEst) / conversationEst)`, then scales the gap by `kt/Ee` before seeding — i.e., converts server tokens into local-estimate units.

Supporting anchors (identical both binaries): PTL regex parser — 310 near @248237557: `var _1="Prompt is too long"; function CXe(e){let n=e.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i);...}` with `Dko` producing `{gap:s,actual:n}`; `Prompt is too long` 7 hits each; `automatic compaction failed` 4 hits each. Telemetry `tengu_reactive_compact_attempt` gains `serverTokensPerEstimate:Ee` in 310.

OCC's parser already matches the official regex (`src/services/api/errors.ts:82` — `/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i`), so the `{gap, actual}` inputs are available when the loop is built.

**Action — STAGED.** Record, don't guess. The official fix mechanism is fully byte-pinned (above), but OCC's reactive-compact subsystem is a dormant stub, so there is no port target today. **Unblock precondition:** when OCC implements the reactive-compaction round loop (promote `REACTIVE_COMPACT` into FEATURE_ALLOWLIST and replace the stub), it must seed the round ladder from the **310** mechanism — carry `{gap, actual}` from the PTL response (not a raw gap), compute `serverTokensPerEstimate = Math.max(1, (actual − systemPromptEstimate) / conversationEstimate)`, and seed with `gap / serverTokensPerEstimate + customInstructionsEst − cumulativeEstimate[step−1]` — never 309's raw `initialTokenGap` seeding.

*Secondary observation (OCC-specific, not part of this changelog item):* OCC's live fallback `truncateHeadForPTLRetry` (`src/services/compact/compact.ts:257-322`) exhibits the same estimate-unit-mismatch class — it drops oldest groups until locally-estimated `acc >= tokenGap` where `tokenGap` is in server tokens. For dense-text conversations it may likewise under-truncate and re-fail. Worth a follow-up issue independent of the reactive-compact build.

---

## Item 5 — File read permission prompts don't show symlink target

> Fixed file read permission prompts not showing where a symbolic link leads

**Verdict: PORT**

**OCC surface:**
- `src/components/permissions/FilePermissionDialog/FilePermissionDialog.tsx:75-90` — resolver (has the exact 309 read-skip)
- `src/components/permissions/FilePermissionDialog/FilePermissionDialog.tsx:162-166` — warning render (hardcoded "modify", no unchecked branch)
- `src/components/ShowInIDEPrompt.tsx:17,52-57` — second copy of the hardcoded pattern
- `src/components/permissions/FilesystemPermissionRequest/FilesystemPermissionRequest.tsx:96` — read asks flow through `FilePermissionDialog` with `operationType={t5}`

**Current OCC behavior:**
```tsx
// FilePermissionDialog.tsx:75-90 — read-skip identical to official 309
const symlinkTarget = useMemo(() => {
  if (!path || operationType === 'read') {   // ← reads never resolve the symlink
    return null;
  }
  const expandedPath = expandPath(path);
  const fs = getFsImplementation();
  const { resolvedPath, isSymlink } = safeResolvePath(fs, expandedPath);
  if (isSymlink) { return resolvedPath; }
  return null;
}, [path, operationType]);
// FilePermissionDialog.tsx:162-166 — hardcoded "modify", startsWith("..") check, no unchecked branch
const isSymlinkOutsideCwd = symlinkTarget != null && relative(getCwd(), symlinkTarget).startsWith('..');
...{isSymlinkOutsideCwd ? `This will modify ${symlinkTarget} (outside working directory) via a symlink` : `Symlink target: ${symlinkTarget}`}
```

**Official evidence — three coordinated changes (resolver, producer, UI):**

Resolver — BIN309 @272958140 (read-skip present):
```js
function St(e,r,n,s){if(r==="read"||n)return null;if(s!==void 0)return s;try{return N1t(la(ut(e)))}catch{return null}}
```
Literal `if(r==="read"||n)return null`: BIN309 = **1 hit**, BIN310 = **0 hits** — the read-skip is gone in 310. BIN310 resolver (@270881164 region):
```js
function St(e,r,n){if(r)return{target:null,unchecked:!1};if(n!==void 0)return{target:n,unchecked:!1};try{let s=Ui(ut(e));if(s.unresolved)return{target:null,unchecked:!0};return{target:Qjt(s),unchecked:!1}}catch{return{target:null,unchecked:!0}}}
```
(`r` = remoteWorkspace flag; resolution now happens for **all** operation types; failures yield `{target:null,unchecked:true}` instead of silent null.)

Producer — BIN309 @272963875 (`buildFilePermissionDescriptor`):
```js
S=St(e.filePath,y,s,e.permissionResult.blockedPath) ... operationType:y,symlinkTarget:S
```
BIN310 @270886868:
```js
S=St(e.filePath,s,e.permissionResult.blockedPath) ... operationType:y,symlinkTarget:S.target,...S.unchecked&&{symlinkUnchecked:!0}
```

UI — BIN309 @~276147324 (hardcoded "modify"):
```js
In=h.symlinkTarget?e(s,{paddingX:1,...children:UEo(h.workingDir??fe(),h.symlinkTarget).startsWith("..")?`This will modify ${nre(h.symlinkTarget)} (outside working directory) via a symlink`:`Symlink target: ${nre(h.symlinkTarget)}`})}):null
```
BIN310 @~274085420 (verb follows operation type + new unchecked branch):
```js
Xo=h.symlinkTarget?e(s,{paddingX:Ce,...children:!Q3(X2n(fft(h.symlinkTarget)),X2n(fft(h.workingDir??fe())),!1)?`This will ${h.operationType==="read"?"read":"modify"} ${o7(h.symlinkTarget)} (outside working directory) via a symlink`:`Symlink target: ${o7(h.symlinkTarget)}`}):h.symlinkUnchecked?e(s,{paddingX:1,...children:"Could not check where this path leads on disk"})}):null
```
New-literal counts: `symlinkUnchecked` BIN310 = **3**, BIN309 = **0**; `Could not check where this path leads on disk` BIN310 = **2**, BIN309 = **0**. Unchanged surfaces: `symlinkTarget` 6 = 6; `(symlink` 12 = 12; `is a symlink` 117 = 117. (`: resolves to ` shows 4 vs 2, but the 2 extra low-offset 310 hits @2854528/2854532 are Bun-installer strings — "refusing to patch …: resolves to …" — not claude JS; excluded.)

**Action — PORT:** Mirror all three layers:
1. `FilePermissionDialog.tsx:75-90`: drop the `operationType === 'read'` early-return so reads resolve symlinks too; make the memo return `{ target: string | null; unchecked: boolean }` — on resolver throw or unresolved path return `{target: null, unchecked: true}`; keep the blockedPath short-circuit as `{target: blockedPath, unchecked: false}` and remote-workspace as `{target: null, unchecked: false}`.
2. Permission-descriptor builder: emit `symlinkTarget: result.target` plus `symlinkUnchecked: true` only when `result.unchecked`.
3. UI (`FilePermissionDialog.tsx:162-166`): replace hardcoded "modify" with `operationType === 'read' ? 'read' : 'modify'` in the outside-working-directory message, and add the `symlinkUnchecked` branch rendering exactly `"Could not check where this path leads on disk"`.
4. `ShowInIDEPrompt.tsx:52-57` carries the same hardcoded text — apply the same verb split there for consistency (verify against its official counterpart's shape before editing).

---

## Item 6 — Auto-continue timeout fires right after external editor closes

> Fixed a question's auto-continue timeout firing the moment the external editor closed after a long edit

**Verdict: PORT** (micro — one call; headline symptom N-A in OCC today, see action)

**OCC surface:**
- `src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx:186-211` — `handleOpenEditor` (matches 309 shape, no recording); `editPromptInEditor` call at line 196
- `src/bootstrap/state.ts:~689` — `updateLastInteractionTime(immediate?)` primitive (exists)
- No AFK countdown in OCC: `grep -rn "afk\|autoContinue\|countdown\|CLAUDE_AFK" src/components/permissions/AskUserQuestionPermissionRequest/` → zero; `askUserQuestionTimeout` appears only in `src/commands/config/config-noninteractive.ts:22` and `src/utils/settings/policyLocks.ts:157,166` (comments)

**Current OCC behavior:**
```tsx
// QuestionView.tsx:186-211 (t8 = handleOpenEditor) — 309 shape, no interaction recording
t8 = async (currentValue, setValue) => {
  const result = await editPromptInEditor(currentValue);   // line 196
  if (result.content !== null && result.content !== currentValue) {
    setValue(result.content);
    onUpdateQuestionState(questionText, { textInputValue: result.content }, question.multiSelect ?? false);
  }
};
```
```ts
// src/bootstrap/state.ts:~689 — the primitive the official Iq(!0) maps to
let interactionTimeDirty = false
export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) { flushInteractionTime_inner() } else { interactionTimeDirty = true }
}
```

**Official evidence — the fix is exactly one call added after the editor await:**

BIN310 question-UI editor opener @273989600 (`W9(` @273988154):
```js
Yn=async(er,nr)=>{if(!x()){return}let rr=await sK(er);if(Iq(!0),rr.content!==null&&rr.content!==er){if(!x()){return}nr(rr.content),je(In,{textInputValue:rr.content},D.multiSelect??!1)}}
```
BIN309 opener @276053850 (`j9(` @276052405) — no `Iq`:
```js
ir=async(nr,or)=>{if(!x()){return}let Kn=await R2(nr);if(Kn.content!==null&&Kn.content!==nr){if(!x()){return}or(Kn.content),We(Nn,{textInputValue:Kn.content},D.multiSelect??!1)}}
```
Literal proof: `if(Iq(!0),` BIN310 = **2 hits**, BIN309 = **0**; `await sK(er);if(Iq(!0),` BIN310 = **1**, BIN309 = **0**. `Iq` is the userPresence facade — BIN310 @~237346288: `function Iq(e){n().userPresence.recordInteraction(e)}` (309 twin `Zbe` @~239679911); `recordInteraction` 3 hits each, `lastInteractionTime` 6 each, `terminalFocus` 34 each.

Everything else on this path is byte-identical 309→310: the AFK countdown hook (310 `yxe({enabled,timeoutMs,countdownThresholdMs,onTimeout})` @273997967 vs 309 `rxe` @276062222 — same `CLAUDE_AFK_TIMEOUT_MS`/`CLAUDE_AFK_COUNTDOWN_MS` handling, same `elapsed = now − Math.max(lastInteractionTime(), anchor)` tick); the question dialog component (310 @~274012531 vs 309 @~276076833 — same enabled memo, same onTimeout guard `if(flushIfDirty(),lastInteractionTime()>=gd||terminalFocus()===!0){...return}`). Bug mechanism: the countdown measures elapsed time since last recorded interaction; a long external-editor session doesn't update it, so on editor close the elapsed clock is already past the timeout and auto-continue fires immediately. The fix records an interaction (immediate flush) the moment the editor returns. Identical-surface anchors ruled out as the fix locus: `'auto-continue'` 7 = 7; `'autoselect'` 12 = 12; `'external editor'` 4 = 4; `ExternalEditor` 3 = 3; "Save and close editor to continue..." components unchanged; nano 262 = 262; notepad 9 = 9.

**Action — PORT (micro):** In `src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx` `handleOpenEditor`, immediately after `const result = await editPromptInEditor(currentValue);` (line 196), add:
```ts
updateLastInteractionTime(true);
```
(import from `src/bootstrap/state.ts`; `immediate = true` matches official `Iq(!0)` → `recordInteraction(true)` and the primitive's own doc comment about post-render/idle-dialog callers.) Apply unconditionally after the await, before the `result.content !== null` check — exactly the official placement.

Scope note: OCC has no question AFK auto-continue countdown at all, so the headline symptom ("timeout fires the moment the editor closes") cannot manifest in OCC today — that half is N-A. The ported call is still correct and useful now: it aligns OCC's existing `getLastInteractionTime()` consumers (`src/hooks/useNotifyAfterTimeout.ts:12`, `src/utils/backgroundHousekeeping.ts:48,65` idle checks, `REPL.tsx:4318`, `usePrStatus.ts:52`) with official 310 semantics — a long external edit counts as interaction at editor close, not at the stale pre-edit timestamp. If/when OCC ports the question AFK countdown, this call is a hard prerequisite for it to behave per official.
