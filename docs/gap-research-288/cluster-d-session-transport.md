# Cluster D — Session / Transport / Headless / Lifecycle (2.1.287 → 2.1.288)

Research round: official Claude Code v2.1.287 → v2.1.288 catch-up.
Binaries: `/tmp/cc-diff-288/v287/package/claude`, `/tmp/cc-diff-288/v288/package/claude` (Bun-compiled ELF; **never executed** — `strings` / `grep -aobF` / `dd` windows only, plus an identifier-normalized token differ `ndiff.py` that is immune to minifier renames). OCC source at `src/`. All offsets are byte offsets into the ELF; JS code region ≈ >150M, string pools ≈ <105M.

**Verdict summary**

| # | Entry (abridged) | Verdict |
|---|---|---|
| 8 | Mid-response API timeouts failed the turn; non-interactive/subagents continue from partial, thinking-only retried | PORT-CANDIDATE |
| 34 | Retry-watchdog sessions retried for hours after a long stream failed; now streams again, gives up after 3 timeouts | PORT-CANDIDATE |
| 36 | Stop during Bedrock credential lookup sometimes moved the session to a fallback model | STAGED |
| 58 | First request in fresh env / after model switch used built-in output limit + auto-compact window, not the server's | NO-OP{PLATFORM} |
| 14 | Session titles/memory recall/prompt hooks failed on Mantle/gateways rejecting structured outputs; `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS` added | PORT-CANDIDATE |
| 39 | Headless sessions occasionally ignored SIGTERM when a supervisor sends SIGCONT alongside | STAGED |
| 75 | Background command time limit now applies only in unattended sessions | PORT-CANDIDATE (regression-risk: 勿回退 OCC-102 reap) |
| 30 | Cross-session message falsely reported delivered when the target session held it | NO-OP{NO-SURFACE} |
| 56 | `idle_prompt` notification hooks fired while background agents still running | PORT-CANDIDATE |
| 17 | Cloud sessions restarted on a newly picked model replied with it after the server refused | NO-OP{NO-SURFACE} |
| 40 | Restarted cloud sessions restored a model the org enforced list refuses | NO-OP{NO-SURFACE} |
| 48 | Stall launching an agent whose `tools:` lists very many `Agent(...)` entries | NO-OP{ALREADY-ALIGNED} |
| 62 | Agent tool in `claude mcp serve` reported no agents and rejected every subagent_type | PORT-CANDIDATE |

---

## Transport / retry engine

### #8 — mid-response API timeouts failing the turn — **PORT-CANDIDATE**

**Changelog:** Fixed mid-response API timeouts failing the turn: non-interactive sessions and subagents now continue from the partial response, and thinking-only responses are retried.

**Official forensics.** The stream-failure retry decision engine was reworked. v287 chain `VLo/RLe/kU/IV/lae/QLo/pUt` → v288 `TWo/T$e/kH/rH/Yle/xWo/Uzt`. Exhaustive normalized comparison of the whole transport area shows the ONLY deltas are the #8/#34 pair:

1. **`timeout_error` joins the isServerError builder** (v288 @209389300 region, `sb288.txt`):
   - v287: `bm=TB($s)||wLe($s)||$s instanceof xt&&$s.type==="api_error"`
   - v288: `Hf=GB(Ys)||S$e(Ys)||Ys instanceof xt&&(Ys.type==="api_error"||Ys.type==="timeout_error")`
2. **`timedOut` stream-fail cause added to the classifier** (`xWo`):
   `if(e.isServerError)return e.error instanceof xt&&e.error.type==="timeout_error"?"timedOut":"serverError"`
3. **thinking-only decision arm** now retries on `timedOut`:
   `case"serverError":case"timedOut":if(r)return w;if(h.hasFallbackModel&&!h.persistent)return{decision:"useFallbackModel",counts:g};return rH("afterThinkingOnly",e==="timedOut"?1:2,g,h,w)`
4. **full-output arm**: `case"serverError":return s&&!r&&n!=="partialOutput"?rH("afterThinkingOnly",2,g,h,H):H; case"timedOut":case"malformed":case"badRequest":case"unknown":return H` — a timed-out stream with real partial output is NOT retried away; it continues from the partial (`continue from the partial response`).
5. **fallback trigger widened**: v287 `if(Fl==="useFallbackModel"&&kf?.cause==="serverError"&&G.fallbackModel)` → v288 `if(Nl==="useFallbackModel"&&(uu?.cause==="serverError"||uu?.cause==="timedOut")&&V.fallbackModel)`.
6. New field on the classified failure: `outlastedNonStreamingTimeout:he.monotonicNow()-Ih>=nqt()` where `nqt()` = API_TIMEOUT_MS→min(e,Hu), else REMOTE?120000:300000.

**OCC state.**
- `src/services/api/modelCallRetries.ts` (587 lines) is the port of the official decision engine (`createModelCallRetries` = official `FFt`). `StreamFailCause` union at :93-102 **lacks `'timedOut'`**; `ClassifiedFailure` at :116-121 **lacks `outlastedNonStreamingTimeout`**; `decideStreamFailed` at :262-346 matches the v287 arms (thinking-only `serverError` only, no timedOut).
- `src/services/api/claude.ts` streamFailed builder follows the v287 shape (`api_error`-only isServerError widening absent).
- `src/services/api/withRetry.ts` consumes the decisions (`useFallbackModel` paths :83,:216,:225,:250,:305,:536).

**PORT details.** Add `'timedOut'` to `StreamFailCause`; classify SDK `APITimeoutError`/`type==="timeout_error"` server errors as `timedOut` in the classifier (official `xWo`); extend `decideStreamFailed` thinking-only arm with `case 'timedOut'` (retry count 1 vs 2 per `e==="timedOut"?1:2`); keep full-output `timedOut` → no-retry (continue from partial); widen the fallback-model trigger to `cause==='serverError'||cause==='timedOut'`; add `outlastedNonStreamingTimeout` to the classified failure (needed by #34). Snippets above are byte-level from the v288 ELF; the decision-tail functions (`T$e/kH/rH/Yle`) are otherwise identical to v287 — no other engine change.

### #34 — retry watchdog retrying for hours after a very long stream failed — **PORT-CANDIDATE**

**Changelog:** Fixed unattended sessions (`CLAUDE_CODE_RETRY_WATCHDOG`) retrying for hours after a very long response stream failed; Claude Code now streams again, and gives up after three timeouts.

**Official forensics.** Same engine rework as #8. The watchdog retry cap in v288:
```js
let fn=a.CLAUDE_CODE_NON_STREAMING_TIMEOUT_RETRIES??(dY()&&r.failedStreamOutlastedTimeout?Vjo:void 0)
```
with `Vjo=2` (→ three timeouts total: initial + 2 retries) and stream-health factor `Wjo=0.9`. **v287 had `!C6()` (watchdog-enabled) in the cap condition; v288 REMOVED it** — the cap now applies to all sessions when the failed stream outlasted the non-streaming timeout, and "streams again" comes from the `outlastedNonStreamingTimeout` threading: `zo=Hf&&(uu?.outlastedNonStreamingTimeout??!1)` → `jWo` → non-streaming builder decision.

**OCC state.**
- `src/services/api/withRetry.ts`: `isRetryWatchdogEnabled` :98, `getNonstreamingTimeoutRetryCap` :141; the cap check ~:990 ends with `!isRetryWatchdogEnabled()` — the **exact v287 `!C6()` shape** (the bug).
- `modelCallRetries.ts` has no `failedStreamOutlastedTimeout` input (needs the #8 `outlastedNonStreamingTimeout` field first).

**PORT details.** Land together with #8 (single engine rework): drop the watchdog-only gate from the cap condition, add `CLAUDE_CODE_NON_STREAMING_TIMEOUT_RETRIES` env override (default cap 2 when the failed stream outlasted the non-streaming timeout), thread `outlastedNonStreamingTimeout` from the classified failure into the retry-cap decision, and apply the 0.9 stream-health factor per `Wjo`. Note: OCC's `getNonstreamingTimeoutRetryCap` currently returns the v287 semantics — after the port, interactive sessions ALSO get the 3-timeout give-up (that is the official v288 behavior; `!C6()` removal verified byte-level).

### #36 — Stop during Bedrock credential lookup moving the session to a fallback model — **STAGED**

**Changelog:** Fixed a Stop during Bedrock credential lookup sometimes moving the session to a fallback model instead of ending the request.

**Official forensics (exhaustive, this round).** Every Bedrock-adjacent module was dumped from both binaries and compared with the normalized token differ — **ALL identical v287↔v288 modulo minifier renames**:
- 3p-model-memory verdict chain: v287 `zen`@215814134 / `ye` / `Se` = v288 `znn`@217044603 / `Ee` / `he` (`zen287b`/`znn288b` dumps); exports `{nle,Wen,awo,FKe,UKe,Vke,qke,zen,Gen}` = `{Zle,Wnn,dTo,f3e,m3e,tAe,nAe,znn,Gnn}`.
- Error classifier `fut`@205171311 = `vft`@206243633 (constants `UnrecognizedClientException/ExpiredTokenException/InvalidSignatureException/RequestTimeTooSkewed/TokenRefreshRequired/CredentialsProviderError`, `bedrock:InvokeModel` regex — all identical) (`f1_*` dumps).
- AWS credential waiter `z2/RV` + SingleFlight `qSn/gEn` (`sf_*`), chain-resolve timeout `CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS??60000`, abort wrapper v287 `nd`@205145126 = v288 `ud`@206242816 (`if(n?.aborted)throw new Md/Hd`), prewarm `bLo/cWo` incl. aborted guard (`aw_*` dumps).
- Client factory bedrock branch `Qt=!Wt&&!qe&&!Ot?await ud(RV(H,de),H):null` = v287 `sn=...await nd(z2(H,fe),H)...`; `userTurn` computation identical (`ca_*`/`cb_*`).
- Model-access tier module `Tut/Mft` + background tier check `hdn/efn` — identical over a 30KB window (`ma_*`).
- Abort error classes (`Md/Hd` = `APIUserAbortError extends xt/APIError`, "Request was aborted.") and the `at/nt` abort classifier @198421705/199296345 — identical.
- Streaming-loop catch: `Gn instanceof SP)throw D_.reportHttpFailure(Gn.originalError,"useFallbackModel",{fallbackModelCouldHelp:Gn.reason!=="overloaded"})` and `if(ji instanceof Md){Jp?.settle({kind:"aborted"},...),Hb();return}` — identical (`fc_*`).
- The withRetry decision engine region's ONLY deltas are exactly #8/#34 (plus unrelated new v288 features: web-search-strip retry `api_request_web_search_stripped`, `tengu_sharded_beacon` gate gaining `!0` arg, extra classifier `q0`).

**Conclusion:** #36 has NO independent byte-level delta. Its behavior change is carried by the #8/#34 engine rework: in v287 a Stop during credential lookup could surface as `cause==="serverError"` and trip the `useFallbackModel` path; v288's `timedOut` split + `outlastedNonStreamingTimeout` + the abort-first classification change that decision surface. (Or the fix is a rename-invisible one-liner inside the identical-looking regions — not recoverable by static diff; nothing was invented.)

**OCC state.** `withRetry.ts:70` `abortError = () => new APIUserAbortError()`; :431-432 and :1168 `if(options.signal?.aborted) throw new APIUserAbortError()` — abort throws BEFORE any fallback classification. `modelCallRetries.ts` has no abort-specific classification (grep: only doc comments :420-433). OCC's exposure is exactly the v287 engine behavior that the #8/#34 port replaces.

**Verdict:** STAGED — no separate port; covered transitively when the #8/#34 engine rework lands. Re-verify abort-vs-fallback ordering then.

### #58 — first request used built-in output limit / auto-compact window, not the server's — **NO-OP{PLATFORM}**

**Changelog:** Fixed the first request in a fresh environment or after a model switch using the built-in output limit and auto-compact window, not the server's; that request may now wait up to 1.5 seconds.

**Official forensics.** The whole resolution chain is byte-identical v287↔v288: output-limit resolver v287 `GQ`@201383390 = v288 `PZ`@202192082 (runtime Oy → built-in Da → claude-3 legacy 4096/8192 → defaults, clamp, `max_tokens≥4096` override); env wrapper `JGt` (CLAUDE_CODE_MAX_OUTPUT_TOKENS); descriptor builder `Vu`@207133361 = `ju`@208248299 (v288 adds only `settingsKey:iV(e)` — that is #79, cluster C); window resolver v288 `Dw`@208253889 (env→settings byModel/default→clientdata→experiment, capped by contextWindow). Bootstrap/gateway/clientdata/boot-phase modules identical; all marker counts flat (clientdata 8=8, max_output_tokens 15=15, Promise.race 160=160). The 1.5s first-request wait was not byte-localized (likely a constant inside an identical-looking race window — not invented).

**OCC state.** `src/services/api/bootstrap.ts` parses only `client_data` + `{model,name,description}` — NO runtime `max_output_tokens`/`auto_compact_windows` consumption; `src/utils/autoCompactWindow.ts:22-27` documents the server-driven sources as deliberately unported; `claude.ts:2257-2260` uses the built-in table only.

**Verdict:** NO-OP{PLATFORM}. OCC deliberately does not consume the server-driven runtime limits (documented divergence); there is no "first request" delta to port until that platform surface is adopted. Revisit with the clientdata runtime-limits port if ever scheduled.

---

## Structured outputs / gateways

### #14 — structured outputs failing on Mantle/gateways; `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS` — **PORT-CANDIDATE**

**Changelog:** Fixed session titles, memory recall and prompt hooks failing on Mantle or behind gateways that reject structured outputs; added `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS` to turn structured outputs off.

**Official forensics.** v287 gate `FSn`@201390036 (2 arms) → v288 gate `aEn`@202198805 (3 arms):
```js
// v288
function aEn(e){let n=Be(e),r=uc(e);if(!rF(r))return!1;if(O3())return!1;
  if(a.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS)return!1;   // ← NEW third arm
  return!sr(n,"claude-opus-4-1")}
```
`CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS` string sites in v288: 94851532, 199612605, 202198805, 212352579, 213670299, 232015967 (env registry + gate + docs/settings surface). The format writer `NWo`: `if(!e||"format"in n||!aEn(s)||dae(s))return!1;if(n.format=e,!r.includes(WZ))r.push(WZ)` with `WZ="structured-outputs-2025-12-15"`.

**OCC state.** `src/utils/betas.ts:160-190` `modelSupportsStructuredOutputs()` — already carries the v287 `FSn` port with the `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` arm at :179 (OCC-105). The new env var is INDEPENDENT of that one (official: separate arm; either disables). `src/utils/managedEnvConstants.ts:141` lists `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` — the new var must be registered alongside. Callers: `claude.ts:2237-2241`, `sideQuery.ts:145,:210`; test `structuredOutputsFormatGate287.test.ts` exists (extend, don't replace). Note: OCC's tail model check is an allowlist (sonnet-4-x/opus-4-x/haiku-4-5) where official v288 returns `!sr(n,"claude-opus-4-1")` — a pre-existing OCC divergence; do not silently change it in this port.

**PORT details.** Add, after the DISABLE_EXPERIMENTAL_BETAS arm in `modelSupportsStructuredOutputs` (betas.ts:179-181):
```ts
if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS)) {
  return false
}
```
Register `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS` in `managedEnvConstants.ts` next to :141; update the header comment (v287 `FSn` → v288 `aEn` 3-arm shape with offsets above); extend the gate test with the new var. Both env vars independently disable — semantics verified byte-level.

---

## Signals / lifecycle

### #39 — headless sessions ignoring SIGTERM when SIGCONT arrives alongside — **STAGED**

**Changelog:** Fixed headless (`-p`/SDK) sessions occasionally ignoring SIGTERM when a supervisor such as `timeout` or systemd sends SIGCONT alongside it.

**Official forensics.** install()/shutdown() signal registration is byte-identical v287@206234202 = v288@207316237 (`h287/h288.txt` windows). The ONLY new SIGCONT-related code in v288 is `attributeSigcont` stall telemetry (0→3 string hits) — instrumentation, not behavior. The actual fix is not statically recoverable as a delta (likely Bun-runtime-level signal-delivery ordering; the changelog pairs it with the telemetry).

**OCC state.** `src/utils/gracefulShutdown.ts`: SIGTERM handler :273-276, Bun `onExit` pin :243-259, SIGINT print-mode skip :261-272, SIGHUP + orphan handling :277-302; `print.ts:1161-1165`; `main.tsx:4517-4518`. OCC registers SIGTERM directly and does not gate on process state that SIGCONT could race.

**Verdict:** STAGED — no portable byte-delta recovered; OCC's registration shape already matches the official (identical in both versions). Optionally port the `attributeSigcont` telemetry later; no behavior change to make now.

### #75 — background command time limit only in unattended sessions — **PORT-CANDIDATE (regression-risk: 勿回退)**

**Changelog:** Changed the background command time limit to apply only in unattended sessions (`-p`, Agent SDK, CI, cloud); terminal, desktop app and VS Code sessions have no limit.

**Official forensics.** The gate function changed shape:
- v287 @205351546: `function Cdn(){return!CC().backgroundDeadlineDisabled}`
- v288 @206424302: `function ufn(){return Fz()&&!XE().backgroundDeadlineDisabled}`

`Fz` decoded (v288 @199660938) — the unattended predicate:
```js
function ke(){return!n().host.launchOptions.isInteractive()}
function _(){let e=mv();return e!==void 0&&r.has(e)}
var r=new Set(["claude-desktop","claude-desktop-3p","local-agent"])
function Yu(){return _()&&!n().childSession}          // desktop-app host
function gv(){let e=n();return e.entrypoint==="claude-vscode"&&!e.childSession&&!e.claudecode}
function Fz(e=ke()){let t=Yu()&&!n().claudecode;return e&&!t&&!gv()}
```
i.e. deadline applies only when non-interactive AND not a desktop-app host session AND not a VS Code session — exactly the changelog.

**OCC state.** `src/tasks/LocalShellTask/backgroundDeadline.ts` (181 lines, re-read this round) is the OCC-102 (#85/2.1.285) reap port and still has the **v287 gate**: `isBackgroundDeadlineCapable()` :105 `return !backgroundDeadlineDisabled`; `isBackgroundDeadlineEnabled()` :114; calculator `computeBackgroundDeadlineMs` :146; description/usage-note fns :165/:176; constants `BACKGROUND_DEADLINE_DEFAULT_MS=1_800_000` :59, cap floor `7_200_000` :65, `MAX_TIMER_DELAY_MS` :62, X9/Q9 tables :74-89. **OCC currently reaps background shells in interactive terminal sessions — the exact bug #75 fixes.** OCC predicates available for the gate: `getIsNonInteractiveSession()` (`src/bootstrap/state.ts:1083`), `STATE.clientType` (:88, default `'cli'` :325, `setClientType` :1111); precedent for this composition: `preferThirdPartyAuthentication` :1285. Consumers of the deadline fns: `LocalShellTask.tsx:142,:196`, `BashTool.tsx:254`, `BashTool/prompt.ts:60`.

**PORT details (keep the OCC-102 reap machinery — 勿回退; only add the gate).** Introduce an OCC `isUnattendedSession()` mirroring `Fz()`: `getIsNonInteractiveSession() && !(desktop-host clientType) && !(vscode clientType)` — OCC's clientType values map: `'cli'`/`'sdk'`/CI → unattended when non-interactive; desktop/VS Code clientTypes exempt even if non-interactive. Change `isBackgroundDeadlineEnabled()` (:114) to `return isUnattendedSession() && isBackgroundDeadlineCapable()` (official `ufn()` shape). **Keep `runInBackgroundDescription()`/`backgroundTimeoutUsageNote()` on the CAPABILITY check** (`isBackgroundDeadlineCapable`) vs enabled check per official: in the official, the description fns consult the same gate — verify against `ufn` call sites during implementation; the deadline must stop arming in interactive sessions (calculator returns undefined → no timer). Update the OCC-102 header comment to record the v288 gate change (offsets above). Tests: interactive session → `computeBackgroundDeadlineMs()` returns undefined; `-p` session → 30-min default still applies (reap NOT regressed).

---

## Session messaging / notifications

### #30 — cross-session message falsely reported as delivered — **NO-OP{NO-SURFACE}**

**Changelog:** Fixed Claude reporting a message to another session as delivered when that session held it: the notice now says it wasn't delivered and names the session, and in SDK sessions Claude can now learn of it mid-turn.

**Official forensics.** v288 adds a delivery-status system: `rur`@228087401 with statuses `held/denied/expired/delivered/refused+dropped`, transcript warning + `isMeta` mid-turn enqueue, debounce 500 / cap 200.

**OCC state.** `src/tools/SendMessageTool.ts:818` posts a simple queued message with no delivery-status handshake; the KAIROS/UDS_INBOX transport that would carry statuses is disabled by the feature-flag allowlist (dead code per CLAUDE.md). No surface to fix.

**Verdict:** NO-OP{NO-SURFACE}. Revisit only if the SendMessage delivery-status transport is ever enabled.

### #56 — `idle_prompt` hooks firing while background agents run — **PORT-CANDIDATE**

**Changelog:** Fixed `idle_prompt` notification hooks firing while background agents are still running (anthropics/claude-code#93672).

**Official forensics.** v288 constructor @229798414 adds to the idle-notifier `new Jj({...})`:
```js
backgroundAgents:{subscribe:Wn.subscribe,getSnapshot:()=>iGr(Wn.getState().tasks)}
```
Predicate module @205138548:
```js
var l=new Set(["local_agent","remote_agent","in_process_teammate","local_workflow"]);
function bi(e){return e==="completed"||e==="failed"||e==="killed"}
function iGr(e){return Object.values(e).some((t)=>Tyn(t)&&t.status!=="paused"
  &&!(t.type==="in_process_teammate"&&t.identity?.resumableAgentId===void 0)
  &&!(t.type==="remote_agent"&&(t.ultraplanPhase==="needs_input"||t.ultraplanPhase==="plan_ready"
    ||t.isUltraplan&&t.restoredOnResume)))}
function Tyn(e){return l.has(e.type)&&!bi(e.status)&&!(e.type==="in_process_teammate"&&e.isIdle)
  &&!(e.type==="remote_agent"&&e.isLongRunning)}
```
Notifier timer `Jj.#g()`: `if(this.#e.backgroundAgents.getSnapshot()){this.#s=RM([this.#e.backgroundAgents],()=>[...],(X)=>{if(!X)this.#g()});return}` — while any qualifying background agent runs, the idle timer disarms and re-arms via subscription when the snapshot flips to false.

**OCC state.** `src/screens/REPL.tsx:4203-4223` — the idle timer calls `sendNotification({...notificationType:'idle_prompt'})` at :4216-4218 with **NO background-agent check**. OCC has the task registry (`src/state/AppStateStore.ts` tasks; LocalShellTask/RemoteAgentTask/in-process teammates) to build the same snapshot.

**PORT details.** Port `iGr/Tyn/bi` as a `hasActiveBackgroundAgents(tasks)` util (verbatim semantics incl. the paused/needs_input/plan_ready/restoredOnResume/isIdle/isLongRunning exemptions and the 4-type set). In the REPL idle path, before scheduling/firing `idle_prompt`, check the snapshot; if active, defer and re-check on task-store change (OCC equivalent of `RM` subscription — AppStateStore subscribe). Guard both the hook firing and the desktop notification at :4216.

### #17 — cloud session restarted on a newly picked model replying with it after server refusal — **NO-OP{NO-SURFACE}**

**Changelog:** Fixed cloud sessions that restarted on a newly picked model replying with that model after the server refused it.

**Forensics / OCC state.** This is the claude.ai-hosted cloud-session restart path: server refuses the picked model, client must fall back to the server-negotiated model instead of continuing on the refused one. OCC has no cloud-session hosting backend: `grep restoreModel/restoredModel/sessionModel src` → no hits; `RemoteAgentTask` has no model-restore/restart negotiation (grep 'restart|relaunch' × model → none); session storage does not restore a model. OCC's only model-refusal surface is the advisor refusal-scope classifier (`src/utils/errorUtils.ts:398`, a v280 port) and `model_refusal_fallback` notification — different mechanism, unaffected.

**Verdict:** NO-OP{NO-SURFACE}.

### #40 — restarted cloud sessions restoring a model the org enforced list refuses — **NO-OP{NO-SURFACE}**

**Changelog:** Fixed restarted cloud sessions restoring a model that the organization's enforced model list refuses.

**Forensics / OCC state.** Same cloud-session restart surface as #17: on restore, the saved model must pass `enforceAvailableModels`/`availableModels` arbitration. OCC HAS the enforcement primitive — `getEnforcedDefaultModel()` (`src/utils/model/model.ts:112`, official `zFn` port; allowlist + `modelOverrides` precedence, documented at :103/:345; governance messages `src/utils/model/modelGovernanceMessages.ts:123`) — and it is already applied on the default-model resolution path (`main.tsx:2483` comment; `useMainLoopModelWiring280.test.tsx:70`). But OCC has no cloud-session restore path that could bypass it (no session-model persistence/restore — see #17).

**Verdict:** NO-OP{NO-SURFACE}. If OCC ever adds session-model restore (`--resume` picking up the transcript's model), route it through `getEnforcedDefaultModel` first — record as a constraint, not a port.

---

## Agent tooling

### #48 — stall launching an agent whose `tools:` lists very many `Agent(...)` entries — **NO-OP{ALREADY-ALIGNED}**

**Changelog:** Fixed a stall when launching an agent whose `tools:` lists very many `Agent(...)` entries.

**Official forensics (this round).** The agent-launch validation path is byte-identical v287↔v288 modulo renames (ndiff over the `allowedAgentTypes` regions @207506800/208609700 shows only edge-alignment opcodes): `ene`@207507491 = `jne`@208610408 (allowedAgentTypes builder from `tools:` specs — `n.push(...g.split(",").map(trim).filter(Boolean))`), `rCo` = `oln`, `FUe` = `QBe`, deny-set filter `rjo` = `C2o` (**already Set-based in v287**: `let s=new Set;for(let g of Su(n))...return e.filter((g)=>!s.has(g.agentType))`), offer-hook pipeline `JWn/Xlt/OWn/kVt` = `H2n/qne/f2n/c3t`.

The real delta is in the deferred-tools announcement module (window @209483500/210639300, ndiff 5 opcodes):
- **NEW v288 factory `mfr`** (marker `causeKindOf`: 0 hits in v287 → 3 in v288):
```js
function mfr(e){let n;return{causeKindOf:(r)=>{try{return n??=de(e),
  jUe(r,e.options.mcpClients,n).kind}catch(s){return IFt(s),moe}},
  holdWhileConnecting:DJe()}}
```
`n??=de(e)` memoizes the expensive tool-permission-context build **once**; the caller loops `for(let Wn of rn)Un.set(Wn,K.causeKindOf(Wn))` over every announced tool name (@208762050). In v287 there was no memoized provider — the per-tool revoked-cause computation (`A7t`/`j6e` with `pe(n)` context) re-derived the context per pass, and the delta-builder function signature grew from 10 → 11 parameters in v288 (the threaded provider `K`). With `tools:` listing very many `Agent(...)` entries, each entry multiplied the recomputation → the launch stall.
- Unrelated to the stall but in the same window: the v288 teammate path adds plugin-definition loading (`gdt`, `subagent_plugin_load_failed`) — that is #38, another cluster.

**OCC state.** OCC has the `agent_listing_delta`/`deferred_tools_delta` attachment surface (`src/utils/attachments.ts:731,:737,:934,:1584-1627`) but NOT the per-tool revoked-cause machinery: OCC's `deferred_tools_delta` is the simpler `{addedNames, addedLines, removedNames}` shape (:731-735) — no `revoked`, no `causeKindOf`, no `removedByBlock`, no `nameOnlyAnnouncements` (grep: zero hits). OCC reads `toolPermissionContext` ONCE from appState (:1594) and never per tool. OCC's launch-time tool resolution `resolveAgentTools` (`src/tools/AgentTool/agentToolUtils.ts:124-219`) is already linear: `disallowedToolSet = new Set(...)`, `availableToolMap = new Map(...)`, `resolvedToolsSet = new Set(...)`; `filterToolsForAgent` (:72-118) is a single `.filter`. The only `.includes` in the path is `allowedAgentTypes.includes(a.agentType)` (attachments.ts:1601) over the small activeAgents list — no quadratic pattern anywhere.

**Verdict:** NO-OP{ALREADY-ALIGNED}. The official stall lived in the per-tool permission-context recomputation that OCC's trimmed deferred-tools path never had; OCC's agent tool resolution is already Set/Map-linear. No port; record `mfr`'s memoization pattern if OCC ever adopts the full revoked-cause announcement machinery.

### #62 — Agent tool in `claude mcp serve` reporting no agents — **PORT-CANDIDATE**

**Changelog:** Fixed the Agent tool in `claude mcp serve` always reporting no available agents and rejecting every subagent_type.

**Official forensics.** v288 mcp-serve entrypoint @240458756 loads agent definitions asynchronously at startup and threads them into the tool context:
```js
let N={activeAgents:[],allAgents:[]},
    L=_?Promise.resolve():pC(oe(),s).then((o)=>{
      N=Une(o,o.allAgents.filter((T)=>{if(zce(T))return!0;
        return Gye(T,"subagent","definition"),!1}))}).catch(...)
```
`pC` = the memoized agent-definitions loader (`so().agentDefinitions` cache, @208730764 region); ListTools awaits `L` then builds tools with `ie(d,{agentDefinitions:N})`; the Agent tool description interpolates `agents:g.activeAgents`. v287 @239047744 shipped the bug: hardcoded `agents:[]` and `agentDefinitions:{activeAgents:[],allAgents:[]}`.

**OCC state.** `src/entrypoints/mcp.ts` (196 lines) replicates the v287 bug pattern exactly: :88 `agents: []`, :124 `agentDefinitions: { activeAgents: [], allAgents: [] }`. Downstream, `AgentTool.tsx` reads `activeAgents` at :305/:365/:368 — so every `subagent_type` is rejected under `occ mcp serve`. The loader OCC needs already exists: `getAgentDefinitionsWithOverrides` (`src/utils/loadAgentsDir.ts:447`; usage precedent `print.ts:790`). Same empties also in `src/daemon/workflowWorker.ts:90`.

**PORT details.** In `mcp.ts`, before building the tool context: await `getAgentDefinitionsWithOverrides(...)` (mirror the official's startup-promise pattern — kick off the load, await before ListTools/tool construction), filter definitions the same way the official does (enabled/visible definitions only; official `zce` check = definition-usable predicate), then pass the loaded `{activeAgents, allAgents}` at :124 and the activeAgents-derived list at :88. Fix `workflowWorker.ts:90` identically if it feeds the Agent tool. Add an e2e: `occ mcp serve` → ListTools shows Agent tool with non-empty agents; CallTool with a real `subagent_type` is accepted.

---

## PORT-CANDIDATEs ranked

1. **#75** — smallest diff, fixes a LIVE OCC bug (interactive sessions reaping background shells at 30 min); official delta fully recovered (`Fz()` predicate + `ufn()` gate). Regression-risk flagged by Leader: keep the OCC-102 reap for unattended sessions — the port ADDS the gate, never removes the machinery.
2. **#8 + #34 (single port)** — one coupled engine rework in `modelCallRetries.ts` + `withRetry.ts` + the claude.ts streamFailed builder; mid-response timeouts failing turns is the most user-visible transport bug; all byte-level snippets recovered. Largest effort of the five. Landing it also transitively closes #36 (STAGED).
3. **#14** — one new env-var arm in `betas.ts` + registry entry; fixes real-world gateway/Mantle compatibility (session titles, memory recall, prompt hooks failing). Independent of the OCC-105 DISABLE_EXPERIMENTAL_BETAS arm.
4. **#62** — `occ mcp serve` Agent tool is fully broken today (rejects every subagent_type); loader already exists in-tree; contained change in `mcp.ts` (+`workflowWorker.ts`).
5. **#56** — idle_prompt firing during running background agents is user-visible noise; port is a self-contained predicate module + a REPL timer guard, but needs the AppStateStore subscription wiring.

STAGED (no action now): #36 (subsumed by #8/#34), #39 (no recoverable delta; OCC registration already matches).
NO-OP: #58{PLATFORM}, #30/#17/#40 {NO-SURFACE}, #48 {ALREADY-ALIGNED}.
