# Upstream Version Gap — OCC-123 (official 2.1.268 → 2.1.269)

- **Round:** OCC-123 (autopilot 版本追齐, 2026-09-13)
- **OCC aligned-at (round start):** official Claude Code `2.1.268` — OCC release `2.1.331`
- **Official latest (round start):** `2.1.269` (binary `BUILD_TIME` `2026-09-11T17:33:46Z`, `GIT_SHA` `d0733697ad641a564c7cfcb19a6eb1eb9d61357e`)
- **Method:** `npm pack @anthropic-ai/claude-code-linux-x64@{2.1.268,2.1.269}` → `strings -n 8 | sort -u` → `comm` diff → fixed-substring window extraction on the minified JS (`win.py`) + raw-ELF python byte extraction for chunk-boundary-truncated / bytecode-adjacent content → byte-verify → LAND / STAGED / NO-OP verdicts.
- **Binary sha256:**
  - v268: `9691a2b7bd796712ca8cffb8e32e54ff7fc45b662540233171a16a94a0425653` (matches OCC-122 ledger)
  - v269: `25e44883f54419569a3d739f38cbbdaebe83b09895da0f343e1b003710a4775b`
- **Strings diff:** v268 278,874 / v269 279,836 unique strings; 17,798 added / 16,836 removed.
- **Official 2.1.269 changelog:** 98 bullet entries (E1–E98 in changelog order, `entries.txt`).

**Bun-binary layout note (this round):** text JS chunks live in the ~183–198 MB ELF region, string tables ~95–101 MB. Bytecode-only chunks (`// @bun @bytecode`) carry **no** textual function bodies; chunk `import{...}from"/$bunfs/root/chunk-XXXX.js"` statements are textual, so an identifier whose exporting chunk is bytecode-only cannot be recovered — that is the blocker for every STAGED-because-bytecode item below (E2 `nN`/`Jw`, E4 `mU`/`hne`/`lE`/`zkr`/`_in`, E31 `Mtn`/`nt`/`pc`).

**Verdict summary:** 8 LAND (E5, E6, E7, E15, E29, E39, E40, E43 — all byte-verified against the v269 ELF), 30 STAGED (delta isolated but mechanism bytecode-opaque or subsystem-sized), 60 NO-OP (surface absent from OCC by design, or different product surface — VSCode/web/Tag).

---

## 1. Landed this round (byte-verified official implementations)

### E5 — `CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS` (gateway `/v1/models` discovery timeout; default 5000 → 3000)

Official v269 (env var count: v268=0, v269=3):

```js
var Lie=3000;
// ...
let n=a.CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS??Lie;
// ...
let D=`${r.replace(/\/+$/,"")}/v1/models?limit=1000`,
    L=await fetch(D,{method:"GET",headers:O,redirect:"error",signal:AbortSignal.timeout(n),...Fs({url:D})});
```

OCC surface: `src/utils/model/gatewayModelDiscovery.ts` — `fetchAndCacheGatewayModels()` hardcodes `signal: AbortSignal.timeout(5000)`. **Delta port:** default `3000` + env override `CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS` (raw `??` fallback, byte-equivalent: any set value — including `0` — wins; official does no clamping here). Update the file-header doc comment.

**Landed:** `src/utils/model/gatewayModelDiscovery.ts` — default `3000` + `CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS` env override with the raw `??` fallback semantics; header comment updated.

### E6 — `/focus` spinner tip

Official v269 tip-registry entry (new in v269):

```js
{id:"focus-view",providerAgnostic:!0,
 content:async()=>"Use /focus to see just your prompt, a one-line summary of the work, and the response",
 cooldownSessions:15,advertisedCommand:"focus",
 isRelevant:async()=>Xa()&&Ge().viewMode===void 0&&!Qee()}
// Xa() = fullscreen renderer active; Ge().viewMode = settings viewMode;
function Qee(){let e=Ge().viewMode;return e?e==="focus":oe().briefTranscript??!1}
```

OCC surface: `src/services/tips/tipRegistry.ts` `externalTips` (`{id, content, cooldownSessions, isRelevant}` entries) + `src/commands/focus/focus.ts` (module-level focus-view flag `isFocusViewEnabled()`, local `isFullscreenActive()` = settings-tui check then env). **Delta port:** new tip entry `focus-view` with the official content string, `cooldownSessions: 15`, and `isRelevant` = fullscreen active AND settings `viewMode` undefined (`src/utils/settings/types.ts:897`) AND focus view not currently active (settings `viewMode === 'focus'` or the runtime flag from `/focus`). OCC's tip type has no `providerAgnostic`/`advertisedCommand` consumers — fields omitted per existing registry shape (no behavioral surface). The no-flicker tip exists in **both** versions — not a delta.

**Landed:** `src/services/tips/tipRegistry.ts` — `focus-view` tip appended to `externalTips` with the official content string, `cooldownSessions: 15`, `isRelevant: isFullscreenActive() && getSettings_DEPRECATED().viewMode === undefined && !isFocusViewEnabled()`; `src/commands/focus/focus.ts` — `isFullscreenActive()` exported (was module-local). Mapping of the official predicates: `Xa()` (fullscreen renderer active) → `isFullscreenActive()` — the same predicate `/focus` itself gates on, so the tip appears exactly when `/focus` will work; `Ge().viewMode===undefined` → persisted startup view mode unset; `!Qee()` → `!isFocusViewEnabled()`. `providerAgnostic`/`advertisedCommand` omitted — no consumer in OCC's Tip shape.

### E7 — `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` (1–256, digits-only) + core-derived default

Official v269 (env-getter chunk, added.txt @28850 exports map):

```js
Kt=a.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS??ur;
if(a.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS!==void 0)
  t(`workflow: concurrent agent gate = ${Kt} (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS)`);
let Yt=Ls(Kt,bo);
// schema: rn=P.int({min:1,max:256,digitsOnly:!0})
// parser:
if(n?.digitsOnly&&!/^[+-]?\d+$/.test(e.trim()))return;
let i=_l(e);if(!Number.isFinite(i))return;
if(n?.min!==void 0&&i<n.min)return;
if(n?.max!==void 0&&i>n.max)return;
return i;
// default: ur=lr(ir()); lr(e)=Math.min(16,Math.max(2,e-2)); ir=os.availableParallelism
```

OCC surface: `src/tools/WorkflowTool/primitives.ts:58` — fixed concurrency `10`. **Delta port:** digits-only int parse (`/^[+-]?\d+$/` on trimmed value; reject non-finite / <1 / >256 → fall back to default), default `Math.min(16, Math.max(2, os.availableParallelism() - 2))`, debug log line when env set (byte-identical message), replace the fixed 10.

**Landed:** `src/tools/WorkflowTool/primitives.ts` — `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` digits-only int parse (`/^[+-]?\d+$/`, reject non-finite / <1 / >256 → default), default `Math.min(16, Math.max(2, os.availableParallelism() - 2))`, fixed `10` removed.

### E15 — post-compaction git status is the *current* status

Official v269 delta: per-conversation **take-once git-status prefetch** + context-refresh recomputation (v268 `gitStatusPrefetch` count = 0):

```js
x4=new Bt(()=>({byId:new Map,builds:$e()}));
function V7(e){let n=x4.of(e).byId,r=n.get(e.id);
  if(!r)r={gitStatusPrefetch:void 0,userContext:void 0,userContextMemoryFiles:void 0,
    userContextInstructionFiles:void 0,refreshReason:"session_start",systemContextByPhrase:new Map},
    n.set(e.id,r);return r}
function iat(){return!a.CLAUDE_CODE_REMOTE&&q7()}
function jCe(e){if(iat())V7(e).gitStatusPrefetch??=ADe().catch((n)=>(g(n),null))}   // ADe() = git-status collector
function wyn(e){return V7(e).gitStatusPrefetch}
function Tyn(e){let n=V7(e),r=n.gitStatusPrefetch;return n.gitStatusPrefetch=void 0,r}  // take-once
async function GXn(e,n,r,s){let{gitStatus:d,...m}=n.announced;
  try{let _=s?Tyn(r.session):void 0;
    if(!n.carriesContext||n.bare)return n;
    let E,A=e3e(e);
    if(A!==void 0)E=A.gitStatus;
    else if(!r.options.omitGitStatus&&iat())E=await(_??ADe())??void 0;   // fresh recompute on refresh
    return{...n,announced:E===void 0?m:{...m,gitStatus:E}}}
  catch(_){return g(_),{...n,announced:m}}}
```

Semantics: on a context **refresh** (compaction / re-announcement), the announced `gitStatus` is re-collected (`ADe()`) — or taken from the once-only prefetch — instead of replaying the session-start snapshot.

OCC surface: `src/services/compact/postCompactCleanup.ts` — OCC caches the assembled system context (`getSystemContext` memo); after a main-thread compaction the stale session-start git status is re-injected. **Delta port (OCC-adapted):** in the `isMainThreadCompact` branch, clear the system-context memo (`getSystemContext.cache.clear?.()`) so the post-compact turn re-collects current git status. OCC has no per-conversation prefetch store; the take-once prefetch (`jCe`/`Tyn`) is a latency optimization on top of the same freshness fix and is not ported (no behavioral delta).

**Landed:** `src/services/compact/postCompactCleanup.ts` — `isMainThreadCompact` branch now clears the memoized system context (`getSystemContext.cache.clear?.()`) and the cached git status (`getGitStatus.cache.clear?.()`) so the post-compact turn re-collects current git status.

### E29 — path-scoped Read/Edit/Write denies recorded to `permission_denials` (stream-json)

Official v269 delta: a `deniedByPermissionRule` flag on the path-deny validation results + a consumer that records the denial. The deny **messages** already exist in v268 (`Mot`/`UDn` constants) — only the flag + consumer are new:

```js
// Read validateInput:
if(zi(_,s.permissions(),"read","deny")!==null)
  return{result:!1,message:Iit,errorCode:1,deniedByPermissionRule:!0};
// Write validateInput:
if(zi(_,s.permissions(),"edit","deny")!==null)
  return{result:!1,message:Iit,errorCode:1,deniedByPermissionRule:!0};
if(RWe(_,s.permissions()))
  return{result:!1,message:HFn,errorCode:13,deniedByPermissionRule:!0};
// Edit validateInput:
if(zi(A,s.permissions(),"edit","deny")!==null)
  return{result:!1,behavior:"ask",message:Iit,errorCode:2,deniedByPermissionRule:!0};
if(RWe(A,s.permissions()))
  return{result:!1,behavior:"ask",message:PFn,errorCode:13,deniedByPermissionRule:!0};
// consumer (after the tengu_tool_use_error logEvent, before the tool_result return):
we.deniedByPermissionRule){let $n={..._e.data};
  e.backfillObservableInput?.($n),s.onPermissionDenial?.(e,n,$n)}
// constants (v268: Mot/UDn — unchanged text):
Iit="File is in a directory that is denied by your permission settings."
PFn="File is covered by a Read deny rule in your permission settings and cannot be edited."
HFn="File is covered by a Read deny rule in your permission settings and cannot be written."
// RWe = "covered by a Read deny rule" check:
function RWe(e,n){
  if(Ei(n,dS,Yp(n).filter((s)=>!uh.has(s.source)))!==null)return!0;
  if(Zr(n,"read","deny").size===0)return!1;
  return vr(e).some((s)=>zi(s,n,"read","deny")!==null)}
```

OCC surface:
- `src/Tool.ts:95` `ValidationResult` — add optional `deniedByPermissionRule?: true`.
- Deny-message sites to flag: `src/tools/FileReadTool/FileReadTool.ts:560` (read-deny), `FileWriteTool.ts:226` (edit-deny + Read-deny-rule write), `FileEditTool.ts:207` (edit-deny + Read-deny-rule edit), `src/utils/permissions/fileStateGuard.ts:88/92` (RWe equivalents).
- Consumer: `src/services/tools/toolExecution.ts:633` validateInput failure branch — between the `tengu_tool_use_error` logEvent and the `<tool_use_error>` return, when `isValidCall.deniedByPermissionRule`, record the denial via a recorder plumbed from `src/QueryEngine.ts` (`permissionDenials: SDKPermissionDenial[]`, pushed at 6 sites today; wrappedCanUseTool shape `{type:'permission_denial', tool_name: sdkCompatToolName(tool.name), tool_use_id, tool_input}`). OCC has no `onPermissionDenial` hook — the recorder callback rides on `ToolUseContext` (optional), invoked with `{...input}` after `backfillObservableInput?.()` (exists at `src/Tool.ts:503`).

**Landed (7 edit sites):**
- `src/Tool.ts` — `ValidationResult` false-variant gained `deniedByPermissionRule?: true`; `ToolUseContext` gained the optional `onPermissionDenial?: (tool, toolUseId, input) => void` recorder.
- Tool flags (5 returns, messages/errorCodes unchanged, byte-verified against v269): `FileReadTool.ts` read-deny (`errorCode 1`), `FileWriteTool.ts` edit-deny (`1`) + read-deny-covers-write (`13`), `FileEditTool.ts` edit-deny (`behavior:'ask'`, `2`) + read-deny-covers-edit (`behavior:'ask'`, `13`).
- Consumer: `src/services/tools/toolExecution.ts` validateInput failure branch — between the `tengu_tool_use_error` logEvent and the `<tool_use_error>` return, copies the parsed input, runs `tool.backfillObservableInput?.()`, calls `toolUseContext.onPermissionDenial?.()` (binary `$n={..._e.data}` order preserved).
- Recorder: `src/QueryEngine.ts` `processUserInputContext` wires `onPermissionDenial` to push `{type:'permission_denial', tool_name: sdkCompatToolName(tool.name), tool_use_id, tool_input}` into `permissionDenials` — same shape as the existing `wrappedCanUseTool` recorder.
- **Ordering note (why this is a real fix, not a duplicate):** in OCC's `checkPermissionsAndCallTool`, `validateInput` (line ~633) runs BEFORE `canUseTool` (~line 900) and the failure branch returns early — pre-E29 these denies never reached `permission_denials`; `onPermissionDenial` is the sole recorder for this path (no double-recording with `wrappedCanUseTool`).
- **OCC divergence:** wired only into the QueryEngine SDK path — OCC's only `permission_denials` surface. The interactive REPL has no denial store (official's recorder feeds the SDK result the same way), so REPL behavior is unchanged.
- **Test:** `src/services/tools/__tests__/permissionDenialFlag269.test.ts` (8 tests) — tool-level flag contract for all 5 deny returns under real deny-rule `ToolPermissionContext`s (cwd-scoped via `runWithCwdOverride`, no global mutation) + controls, and consumer-level `runToolUse` drive asserting `onPermissionDenial` fires once with the backfilled input COPY before the `<tool_use_error>` result, never for unflagged failures, and that `canUseTool` is not reached.

### E39 — `/btw` answers with made-up tool calls are flagged as not executed

Official v269 delta (side-question prompt + sanitizer):

```text
Prompt bullet (CRITICAL CONSTRAINTS section, byte-exact from v269 strings):
- Do NOT write tool calls or tool output as text (for example invoke or function_calls XML blocks) - nothing you write here is executed; if answering would need reading files, running commands, or searching, say that can't be checked from a side question and suggest asking in the main conversation

Detector:
<(?:antml:)?(?:function_calls>|invoke name=)|</(?:antml:)?(?:function_calls|invoke)>

Live disclaimer appended to a flagged answer:
_/btw can't run tools: any tool calls or tool output shown above were not executed and may not reflect your actual files or data. Ask in the main conversation to check._

History omission (when the side-answer re-enters main history):
(That answer wrote tool calls as text. Nothing was executed, so it is omitted here.)
```

OCC surface: `src/utils/sideQuestion.ts` (prompt builder + answer post-processing) and `src/commands/btw/btw.tsx` (display path, ~line 91). **Delta port:** add the constraints bullet to the side-question prompt; run the detector regex on the answer; when matched, append the disclaimer for display and substitute the omission note when the answer is folded into conversation history.

**Landed:** `src/utils/sideQuestion.ts` — byte-exact constraints bullet added to the CRITICAL CONSTRAINTS block; `containsFakeToolCalls()` (binary `xTn`, detector regex verbatim incl. the optional `antml:` prefix); `BTW_TOOLCALL_DISCLAIMER` appended to a flagged live answer as `${text}\n\n${disclaimer}` (binary `k(l)` shape); `BTW_HISTORY_OMISSION` exported. **OCC divergence:** the official substitutes the omission note while replaying `session.btwHistory.exchanges` into the side-question history; OCC's `runSideQuestion` sends only the wrapped question (no session-level btw history store), so the substitution has no replay surface yet — kept exported for the display path / future history folding.

### E40 — `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` max-age (default 6 h) + `..._MAX_AGE_MS`

Official v269:

```js
// env override parser:
function sHn(){let e=a.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS;
  if(!e)return;                     // unset → undefined (use default)
  let n=Number(e);
  if(n===0)return 0;                // 0 disables the age check
  return Number.isFinite(n)&&n>0?n:3600000}   // garbage → 1 h
// default (statsig gate trimmed → constant): W6o() = 21600000 (6 h)
// staleness check at resume:
!Number.isFinite(r)||Math.abs(Date.now()-r)>=n     // r = interrupted turn timestamp
// suppressed resume logs: tengu_resume_stale_turn_suppressed
```

OCC surface: `src/cli/print.ts` (~line 1238) — the existing `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` resume path replays the interrupted turn with **no age check**. **Delta port:** timestamp-age gate before re-running the interrupted turn: `maxAge = sHn() ?? 21_600_000`; skip when `0`… (0 disables the check → always resume), skip resume when timestamp missing/non-finite or `|now - ts| >= maxAge`; analytics stubbed per OCC convention (no statsig/telemetry event emitted beyond the existing debug log).

**Landed:** `src/utils/conversationRecovery.ts` (the interruption-detection resume path the SDK/print resume consumers call — `deserializeMessagesWithInterruptDetection`, not `print.ts` directly) — `applyResumeStalenessGates()` applies the official `De`/`et` suppression (`if(Ze||De||et)mt={kind:"none"}`): `De` = env-gated tail staleness (`qUn`), `et` = skipped api-error tail row vs the `W6o` bound. Env parser mirrors binary `sHn` exactly (unset → undefined; `0` → disables `De`; finite >0 → that value; garbage → `3_600_000`). `W6o`'s truthy `if(e)` fall-through is preserved — **env=0 leaves the `et` bound at the 6 h default** (byte-verified: `if(e)return{maxAgeMs:e,source:"env"}`; 0 is falsy). Default `RESUME_DEFAULT_MAX_AGE_MS = 21_600_000` (statsig `tengu_shimmering_cherny` source trimmed per OCC convention). Documented divergences (impl doc-comment): `WZ` context-append skip omitted (gated on `CLAUDE_CODE_RESUME_TOLERATES_CONTEXT_APPENDS`, absent from OCC → always-false no-op); `Ze` guard has no OCC input → false branch; official's `Pe`/`Q6o` re-detection path stays STAGED (needs the `nye` dropSiblingBlocks machinery). Note: v268 already had an inline env-only tail gate (`wqn`); the v269 delta is the refactor (`sHn`/`qUn`/`W6o`/`G6o`) + the default-bound api-error `et` gate. Tests: `src/utils/__tests__/resumeStaleness269.test.ts` (10 tests — De gate: unset/0/small/fresh/garbage-1h both sides; et gate: 7 h suppressed / 1 h kept / env=0 falls through to 6 h / garbage-1h bound) + existing `test/e2e/resume-interrupted-turn-221.e2e.test.ts` still passing.

### E43 — Bash `tee` gets write-path classification (security)

Official v269 (all absent from v268: `tee:"write"` count v268=0):

```js
var vHo=new Set(["/dev/null","/dev/stdout","/dev/stderr","/dev/tty"]);
function EHo(e){return e.filter((n)=>!vHo.has(n))}
// WN (path extractors):  tee:(e)=>EHo(py(e))       // py = flag-filter (same helper as cat/head/tail)
// Z2 (operation types):  tee:"write"
// ACTION_VERBS:          tee:"write to files in"
// command basename canonicalization:
var LHo=new Set(["rm","rmdir","tee"]);
function jU(e){if(!e)return e;let n=e.replace(/^.*[\\/]/,"");
  if(LHo.has(n))return n;
  return n.toLowerCase().replace(/\.exe$/,"")==="tee"?"tee":e}
// path-validation entry:
function OHo(e,n,r,s,d,m,_){let E=WN[e],A=E(n),P=m??Z2[e];
  if(e==="tee"&&A.length===0)
    return{behavior:"passthrough",message:"Path validation passed for tee command"};
  ...}
```

Effect: `Edit()` deny rules and the working-directory write-path check now apply to `tee` destinations (device paths excepted); a `Bash(tee:*)` allow rule no longer covers writes outside the working directories; `/usr/bin/tee` and `tee.exe` canonicalize to `tee`.

OCC surface: `src/tools/BashTool/pathValidation.ts` — `PathCommand` union, `PATH_EXTRACTORS`, `ACTION_VERBS`, `COMMAND_OPERATION_TYPE`. **Delta port:** add `'tee'` to the union; `tee: args => filterOutFlags(args).filter(p => !TEE_DEVICE_PATHS.has(p))` with `TEE_DEVICE_PATHS = new Set(['/dev/null','/dev/stdout','/dev/stderr','/dev/tty'])`; `tee: 'write to files in'`; `tee: 'write'`; the empty-path passthrough message byte-identical; extend OCC's basename canonicalization with the rm/rmdir/tee set + `.exe` handling if absent. **Do NOT** add `tee` to `NON_CREATING_WRITE_COMMANDS` in `readOnlyValidation.ts` (official keeps tee out of that set — `tee` creates files).

**Landed:** `src/tools/BashTool/pathValidation.ts` — `'tee'` added to the `PathCommand` union; `TEE_DEVICE_PATHS` Set (byte-identical to `vHo`); `filterTeeDevicePaths` (binary `EHo`); `PATH_EXTRACTORS.tee = args => filterTeeDevicePaths(filterOutFlags(args))`; `ACTION_VERBS.tee = 'write to files in'`; `COMMAND_OPERATION_TYPE.tee = 'write'`; exported `canonicalizePathCommandName` (binary `jU` — `CANONICAL_PATH_COMMAND_BASENAMES = Set('rm','rmdir','tee')` + `.exe`/case handling), wired at BOTH path-command lookup sites (`validateSinglePathCommand` + `validateSinglePathCommandArgv`). The binary's tee-specific `OHo` passthrough string is produced byte-identically by OCC's generic empty-paths template `` `Path validation passed for ${command} command` ``. `src/tools/BashTool/readOnlyValidation.ts` — `extractWritePathsFromSubcommand` now strips quotes then canonicalizes the command token (binary `jU(n[0]?.replace(/[\\'"]/g,""))`), so tee destinations count as creating writes; `NON_CREATING_WRITE_COMMANDS` untouched (tee stays out, per official). Tests: `src/tools/BashTool/__tests__/teeWritePath269.test.ts` (10 tests — canonicalization table, device-sink filtering incl. lookalikes, write classification: default mode `tee <file>` → ask, acceptEdits in-workdir → passthrough, outside-workdir → ask with the official `write to files in` verb, `tee /dev/null` + `/usr/bin/tee /dev/null` → passthrough). Full `src/tools/BashTool/` suite 400 pass / 0 fail after the change.

---

## 2. Staged (delta isolated; mechanism bytecode-opaque or subsystem-sized)

### E37 — `/goal` retry-with-backoff / pause-with-reason subsystem

Added-string markers: `goalInterruptionStreak`, `goal_check_timeout`, `goal_check_capped`, `goal_checkin`, `goal_restored_on_resume`, `goal_status`, `goal_interruption`, `goalNet`/`goal_net`, `goal_pass`/`goalPass`. A full lifecycle subsystem (interruption streaks, backoff scheduling, usage-limit-reset-aware pause, resume restoration) spanning the Stop-hook goal path. Subsystem-sized — needs dedicated per-site decompilation against OCC's `/goal` Stop-hook implementation; not guessable from markers alone.

### E2 — `/output-style` local command (full impl recovered; allowlists bytecode-blocked)

Recovered verbatim from v269 text chunks: command def (`type:"local"`, `name:"output-style"`, `argumentHint:"[style]"`, `isEnabled:()=>ke()||!E9()` where `ke()`=thin-client and `E9()`=statsig `tengu_maple_sundial` — OCC trims statsig so the gate collapses to enabled), the hidden `"${n} moved to /config"` stub `kNr`, and the complete `call` (function `P`): style loading `qD(Z(),o.storageV5)`, off-box gate `Oee(o)` filtering via `jJe(e){return e===null||e?.source==="built-in"}`, current style `Gse(){return Cn()?.outputStyle||nA}`, off-box suffix `pEt`, case-insensitive arg match, unknown-style message, list branch (`Output style: ...\n\nAvailable styles:\n...` + `Usage: /output-style <style>`), already-active short-circuit, `localSettings` write gate `fEt`, save-failure messages `C` (off-box) / `Could not save output style: ...`, success analytics + `Output style set to ...`. Exported constants: `g="a custom style"`, `pEt="Custom output styles can't be selected over Remote Control or from a relayed message..."`, `fEt="Output styles are saved to local settings (.claude/settings.local.json)..."`.
**Blocker:** the arg-less list-match allowlists `nN`/`Jw` (used in `if(r&&!nN.includes(a)&&!Jw.includes(a))`) live in bytecode-only `chunk-h19j7w1q` (its own text region @99712560 is string-table; many chunks import `Jw,nN`). Without them the unknown-style branch cannot be byte-faithfully gated. Built-in styles visible: Proactive/Concise/Explanatory/Learning.

### E4 — `OTEL_METRICS_INCLUDE_REPOSITORY` (`vcs.*` attributes)

Recovered verbatim: defaults map `H` (6 `OTEL_METRICS_INCLUDE_*` keys incl. new `RESOURCE_ATTRIBUTES:!0`, `REPOSITORY:!1`), attribute-name constants `S/h/A/O/V/Y/J` = `vcs.repository.url.full`/`vcs.repository.name`/`vcs.owner.name`/`vcs.provider.name`/`vcs.ref.head.revision`/`vcs.ref.head.name`/`vcs.ref.head.type`, merge group `q=[S,A,h,O]`, env reader `E(e)`, metrics merge block `_2e()`, commit-event builder `Jpr({commitId,branch})`, startup settle gate `Qpr()`, and the full remote-URL parser `te(e)` (query/fragment credential guard, IPv6-host guard, provider classify via `lE(c)` + canonical-host map `zkr`, gitea special case `Q="gitea.com"`, bitbucket `scm` segment removal, ssh:7999 → `https://host/projects/P/repos/R` rewrite).
**Blockers:** (a) helper chain `mU`/`hne`/`lE`/`zkr`/`_in` (URL parse, host normalize, provider classify, canonical-host map, git-remote reader) is bytecode-only; (b) OCC's `src/utils/telemetryAttributes.ts` base lacks the `OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES` subsystem that `_2e()`'s merge loop reads (`c[S]`) — porting REPOSITORY alone would be a partial/invented surface.

### E31 — `/insights` session-model fallback (Bedrock/Vertex/Foundry/gateway)

Delta isolated: v268 `function $e(){return Vl()}function Le(){return Vl()}` → v269 `function fe(){return Mtn()?pc():nt()}` (session model when the account can't reach default Opus), consumed at the insights query sites `options:{model:fe(),querySource:"insights",...,maxOutputTokensOverride:500/4096/e.maxTokens}`. Import is textual — `import{Mtn,nt,pc,Ca}from"/$bunfs/root/chunk-5cs6j3p3.js"` — but that chunk is bytecode-only, so `Mtn` (can't-reach-Opus predicate), `nt` (session model) and `pc` (fallback) bodies are unrecoverable. Predicate semantics not guessable → STOP per aligning-with-official-binary.

### E3 — `bashEditDiffEnabled` (Bash-handled file-edit diff in tool result)

Setting key + diff-render surface new in v269; the diff assembly reads the file-history snapshot subsystem. OCC has the snapshot store but not the Bash-edit detection site; mechanism spread across bytecode helpers. Needs per-site decompilation.

### Terminal / UI rendering items — E10, E12, E13, E23, E24, E28, E35, E44–E50, E53

Keyboard-protocol fixes (kitty/rxvt-unicode/WezTerm/st/GNOME/Konsole), DA-reply stray-text at startup, fullscreen resize blanking, native-cursor text fields, `/fork` receipt double-click backgrounding, synchronized-output detection, prompt-box border splitting on wide/newline agent names, rxvt cursor-block residue, external-editor double-draw, SSH kitty-query Shift+Enter. All are escape-sequence/timing fixes inside the official's own terminal layer; the strings diff shows no portable contract (fix sites are renderer-internal). Each needs per-site decompilation against OCC's Ink fork — staged as a group.

### Other CLI-surface items — E8, E9, E17, E18, E27/E51, E34, E36, E54, E57

- **E8/E9** prompt-cache invalidation around output-limit auto-resume / mid-thought interrupt resume — cache-key assembly is request-builder-internal; no string-visible contract.
- **E17** resumed headless sessions losing replies on mid-turn model switch/retry — reply-routing state machine; needs dedicated decompilation.
- **E18** background-task on-disk record sanitization (escape codes/line breaks/oversized text → task list & notifications) — OCC's daemon supervisor record format differs; port target ambiguous.
- **E27/E51** prompt-suggestion CJK/mixed-script filtering — classifier-adjacent heuristics in bytecode; OCC suggestion surface differs.
- **E34** MCP reconnect on query-param-order-only config change — config-diff canonicalization site not string-visible.
- **E36** auto-compaction stuck on "Prompt is too long" with no complete exchange — compaction-selection edge case; selection loop opaque.
- **E54** transcript collapsed-tool-use summary incremental re-processing — renderer memoization internals.
- **E57** artifact-database scratchpad saves skipping working-folder approval — artifact DB is an OCC-absent subsystem (`@ant` stubs).

---

## 3. No-op (surface absent from OCC by design, or different product surface)

- **E1** `claude plugin eval` — plugin subsystem removed from OCC.
- **E11** remote/headless "waiting for your input" vs bg tasks (`CLAUDE_CODE_BG_TASKS_REPORT_RUNNING`) — env var absent from OCC; remote-session status reporting is an official-cloud surface (OCC uses its daemon supervisor).
- **E14** `!`-prefixed deny/ask rule source-scoping — OCC's permission-rule parser has no `!` negation surface (verified: no rule-negation handling in `src/utils/permissions/`).
- **E16** synced-plugin MCP reconnect on remote resume — plugins removed.
- **E19** CMYK JPEG attach/convert — OCC image pipeline has no CMYK decode path (verified: no CMYK handling in `src/`).
- **E20** managed-settings dialog naming gRPC telemetry collector — OCC telemetry is stubbed (empty implementations).
- **E21/E22** plugin consent-prompt URL display / `[redacted URL]` Windows path — plugins removed.
- **E25** plugin LSP `shutdown`→`exit` — plugins/LSP removed.
- **E26** attribution reminder vs CLAUDE.md rule override — attribution-reminder surface not in OCC's trimmed build.
- **E30** SDK/Desktop sessions unknown status in agent list — Claude Desktop integration absent.
- **E32/E33** org-policy login-refresh race / Desktop turn-end notification text — org-policy + Desktop surfaces absent.
- **E38** cloud-session first-request server-config wait — cloud-only prompt-cache path.
- **E41/E42** org plugins in headless/Desktop / plugin-archive permissions — plugins removed.
- **E52** Skill "Unknown skill" plugin-skill full name — plugin skills removed.
- **E55** telemetry-disabled first-party `alwaysLoad` MCP mid-connect usability — official first-party telemetry gating path; OCC telemetry is stubbed so the gated branch does not exist.
- **E56** `/ultrareview --post` direct PR comment — cloud-session orchestration surface.
- **E58** claude.ai-synced skills `anthropic-skills:` prefix in cloud sessions — cloud sessions absent.
- **E59–E81** `[VSCode]` extension items — different product surface (not the CLI binary).
- **E82–E88** `[Claude Code on the web]` items — cloud/web product surface.
- **E89–E98** `[Claude Tag]` (Slack) items — different product surface.

---

## 4. Verification

**New deterministic tests (this round):**

| Suite | Coverage | Result |
|---|---|---|
| `src/services/tools/__tests__/permissionDenialFlag269.test.ts` | E29 — 6 validateInput contract tests (FileRead errorCode 1, FileWrite 1/13, FileEdit ask+2/13, unflagged negative) + 2 runToolUse consumer tests (flagged → onPermissionDenial with backfilled input copy, canUseTool NOT reached, `<tool_use_error>` result; unflagged → no callback) | 8/8 pass |
| `src/utils/__tests__/resumeStaleness269.test.ts` | E40 — De gate (env unset inert, env=0 disables, env=1000 stale/fresh, garbage→1 h bound both sides) + et gate (6 h default suppresses 7 h api-error tail, 1 h fresh survives, env=0 falls through to the 6 h default per binary `W6o` truthy `if(e)`, env=abc → 1 h env bound) | 10/10 pass |
| `src/tools/BashTool/__tests__/teeWritePath269.test.ts` | E43 — `canonicalizePathCommandName` table (path prefix, `.exe`/case, unchanged non-canonicals, undefined), `PATH_EXTRACTORS.tee` device filtering incl. lookalikes, `COMMAND_OPERATION_TYPE.tee === 'write'`, checkPathConstraints: `tee /dev/null` passthrough, default-mode write → ask, acceptEdits in-workdir → passthrough, outside-workdir → ask with official `write to files in` verb, `/usr/bin/tee` canonicalization wired | 10/10 pass (3 consecutive runs — stable) |

**Regression sweep (per-directory `bun test src/...` runs with timeout):** ~2785 unit pass; the 24 fails are pre-existing (git-stash A/B identical on the clean tree): 23 in `src/utils` + 1 in `src/commands` (`lineage.compact.test.ts` — `SyntaxError: Export named 'extractForkLineage' not found in module src/commands/fork/pointer.ts`). Post-change targeted re-runs: `src/tools/BashTool/` 400 pass / 0 fail; `src/services/tools` + `src/services/tips` 17 pass / 0 fail.

**Structural e2e (`test/e2e/`, unmodified this round):** `occ-versioning`, `commands-alignment`, `resume-interrupted-turn-221` pass. Pre-existing (A/B identical): `autocompact` 6 pass / 3 fail, `repl-interactive` 2 pass / 1 fail (auto-mode opt-in dialog — known since OCC-44).

**Live smoke (real API key, `ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic`):** `echo "say PONG" | bun dist/cli.js -p` → `PONG`, exit 0; tmux REPL boot + model round-trip green; `bun run build` green (`dist/cli.js` 29.03 MB); `bun dist/cli.js --version` → `OCC 2.1.331` (pre-bump); Biome lint clean for every file edited this round (37 pre-existing errors elsewhere untouched).

**Release 2.1.332:** merge to `main` → CHANGELOG + `package.json` bump → tag `v2.1.332` → `publish.yml` (build → npm publish → GitHub Release). Verification results (npm dist-tag, releases/tags parity) recorded in the OCC-123 issue comment and appended below after publish.

