# Gap Research R3 — SESSION / COMPACTION / API / SUBAGENTS

Official Claude Code **2.1.303 → 2.1.304** alignment for OCC 2.1.393 (aligned official 2.1.303; HEAD `87974fd7`).
Static byte forensics only — no official binaries executed.

- vprev ELF: `/tmp/cc-diff-304/vprev/package/claude` (285,809,912 B)
- vver  ELF: `/tmp/cc-diff-304/vver/package/claude`  (288,730,480 B)
- new_strings: `/tmp/cc-diff-304/new_strings.txt` (27,042 lines)

Cluster items (changelog numbering): **#22, #27, #28, #41, #50, #52, #21, #11, #6**

---

## Verdict table

| # | Item | Verdict | Effort | Key evidence |
|---|------|---------|--------|--------------|
| 22 | `context_management: Extra inputs are not permitted` behind gateways → resend without field | **PORT** | M | new str 0→2 (@125375176, @246856307); `dde=C("context_management","context-management-2025-06-27")` @238526430; heal map `M6t` @246856307 (vprev `k2t` @244171868, 4→5 entries); resend `Bgt` @248096647 |
| 27 | "Context limit reached"/"Prompt is too long" after stopping turn while compacting an API-rejected-too-long conversation | **N-A** | – | reactive-compaction path; OCC `reactiveCompact.ts` = stub, `feature('REACTIVE_COMPACT')` ∉ allowlist; official abort-skip cascade @254342964 |
| 28 | Subagents forgetting most recent work when messaged/resumed right after finishing | **PORT** | S/M | OCC `resumeAgentBackground`→`getAgentTranscript` reads disk with no drain; write queue timer-drained (`FLUSH_INTERVAL_MS=100`); `flushSessionStorage()` exists, unused on resume |
| 41 | `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200k` silently 100K → k/M suffixes + warn | **PORT** | M | parser `j_e` @246816065, env reader `T4t` @246816476, warn `XFe`/`E4t`/`ySs` @246816655/@246817300; consts `gP=1e5,vN=1e6` @236987558; startup warn @255784526; OCC env branch uses `parseInt` (autoCompactWindow.ts ~285) |
| 50 | Resume of large compacted sessions (SDK/headless): first request sent sooner | **STAGED** | L | logic-only; `hydratePrefetch` count 12/12 unchanged; timing class `resumeHydratePrefetch` @~127227160; resume `S_o` @245746027; OCC resume architecture differs |
| 52 | Memory use when sending requests in long/resumed conversations | **STAGED / N-A** | – | vague, logic-only, no string signal; OCC does multiple full `messagesForAPI` copies (claude.ts:2022-2098) as plausible target |
| 21 | Model switches/messages/interrupts waiting behind a context usage check (SDK/desktop) | **STAGED** | L | logic-only; "context usage" 14/14 unchanged; `getContextUsage` @119403801, `contextUsageMirror` @119701504; OCC SDK control layer has no such blocking check surface |
| 11 | `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` dropping messages when disk filled mid-trim | **N-A** | – | OCC has NO transcript-local-GC feature (env only in a test list); official GC gate `fns` @272876679, `setLocalGcEnabled` @245663040 |
| 6 | Compaction summary (Ctrl+O) includes names of tools called earlier | **PORT** | M | new strs `tools-used-before-summary` 0→2, `toolNamesUsed` 0→5, `Tools called before this summary` 0→2; `HJ` @247678820, `Zan` @247679308, `GJ` compose @~247828853, `jEs`/`Bce` transcript render @266219291 |

**Summary: 4 PORT (#22, #28, #41, #6), 2 N-A (#27, #11), 3 STAGED (#50, #52, #21).**

---

## #22 — `context_management: Extra inputs are not permitted` behind LLM gateways → resend without field  → **PORT (M)**

### Official evidence (byte-verified)

**New string** `context_management: Extra inputs are not permitted`:
- vprev count = **0**; vver count = **2** (@125375176 string table, @246856307 in code).

**Beta-header catalog** (@238526430, vver) — the context_management beta object:
```js
vv =C("long_context",     "context-1m-2025-08-07"),
dde=C("context_management","context-management-2025-06-27"),
```
So `dde.name === "context_management"`, `dde.header === "context-management-2025-06-27"`.

**Heal map** — vprev `k2t` (@244171868, **4 entries**):
```js
var k2t=new Map([
  [Vht,null],
  [UJe,(e)=>e.includes("evict_on_complete")&&e.includes("beta")],
  [$te,(e)=>h2t.test(e)],                       // h2t=/thinking\.(adaptive|enabled)\.display: Input should be /
  [Nte,null]
])
```
vver `M6t` (@246856307, **5 entries** — new `dde` arm inserted 2nd):
```js
var M6t=new Map([
  [H_t,null],
  [dde,(e)=>e.includes("context_management: Extra inputs are not permitted")],   // ← NEW
  [d7e,(e)=>e.includes("evict_on_complete")&&e.includes("beta")],
  [yne,(e)=>x6t.test(e)],
  [JJ,null]
]),HVe=[...M6t.keys()];
```

**Filter + resend** (@246856307 & @248096647):
```js
function BVe(e,n){                               // e=error, n=betas sent
  if(!(e instanceof Ot)||jH(e)||eM(e))return[];
  let{message:r,status:s}=e;
  return HVe.filter((h)=>n.includes(h.header)&&(uke(e,h)||s===400&&Ev(r,h)))
}
function uke(e,n){                               // does this beta match the 400?
  if(!(e instanceof Ot)||n.header===null)return!1;
  return O6t(e,n.header)||M6t.get(n)?.(e.message)===!0
}
// Bgt = the fatal-400 heal handler (@248096647):
Bgt=(eo)=>{try{
  let Er=BVe(eo,_p);if(Er.length===0)return;      // _p = betas currently sent
  let zr=new Set(Er);
  mt=mt.filter((Qs)=>!zr.has(Qs));                // strip offending beta(s)
  for(let Qs of Er)
    Gn(Qs,uke(eo,Qs)),                            // mark spent for conversation
    i("tengu_beta_400_healed",{beta:tde([Qs.header]),model:Et(J.model),provider:gA(),status:eo instanceof Ot?eo.status:void 0});
  return `retry:beta-rejected:${Er.map((Qs)=>Qs.name).join(",")}`   // → "retry:beta-rejected:context_management"
}catch(Er){l(Er);return}}
```
Dropping the `context-management-2025-06-27` beta stops the gated `context_management` request field from being sent on the retry — the changelog's "resends the request without that field."

This is the **same generic beta-heal mechanism** already recovered for the 2.1.302 `diagnostics:` arm; 304 only adds the context_management arm.

### OCC cross-check

OCC does **not** port the generic named-beta scanner (comments call it official `EZe` and note OCC "collapsed" that slot). OCC ships **bespoke** heal handlers only:
- `src/services/api/claude.ts:2380-2440` — `retryContext1mBetaRefused` (context-1m `vv` heal), state machine idle→retrying/guessing→spent, logs `tengu_beta_400_healed`.
- `src/services/api/claude.ts:2445-2460` — `retryToolSchemaRefused` (MCP schema 400, 2.1.300).
- `retryAdvisorEntryRefused` (advisor 400/422, 2.1.276/280).
- `stripMediaBlock` (image 400, 2.1.157).
- No handler matches `context_management: Extra inputs are not permitted`; `evict_on_complete` and `thinking.display` heals are also absent.

OCC **does** send the beta + field, gated to firstParty/foundry:
- `src/utils/betas.ts:7` `CONTEXT_MANAGEMENT_BETA_HEADER='context-management-2025-06-27'`.
- `src/utils/betas.ts:383-384` pushes the header when `shouldIncludeFirstPartyOnlyBetas() && (antOptedIntoToolClearing || thinkingPreservationEnabled)`.
- **Key:** `src/services/api/claude.ts:2664-2668` — the field is already gated on the beta's presence:
  ```js
  ...(contextManagement && useBetas && betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
    context_management: contextManagement,
  }),
  ```
  So stripping the header from `betas` **automatically omits the field** on resend — exact official behavior, no separate field-gate change needed.
- A proxy gateway that reports `firstParty` (custom `ANTHROPIC_BASE_URL`) still receives the beta+field and can 400 with this message — the changelog's gateway scenario. OCC surfaces the raw 400 today.

### Recipe (PORT)

Mirror the existing `retryContext1mBetaRefused` shape (bespoke handler, one-shot latch):
1. **claude.ts** — add `retryContextManagementRefused(error)`:
   - Classifier: `error instanceof APIError && error.status===400 && error.message.includes('context_management: Extra inputs are not permitted')`.
   - Guard: only when `betas.includes(CONTEXT_MANAGEMENT_BETA_HEADER)`; one-shot per request (a second 400 returns false → error surfaces).
   - Heal: `betas = betas.filter(b => b !== CONTEXT_MANAGEMENT_BETA_HEADER)`; `logEvent('tengu_beta_400_healed', {beta: CONTEXT_MANAGEMENT_BETA_HEADER, model, provider, status:400, unnamed:false})`. (Field auto-drops via the existing gate at 2664-2668.)
   - Retry token equivalent to `retry:beta-rejected:context_management`.
2. **withRetry.ts** — add option `retryContextManagementRefused?: (e:APIError)=>boolean`, wired in the fatal-400 hook chain next to `retryContext1mBetaRefused` (`attempt--; continue`, no budget consumed).
3. Mark-healed on stream `message_start` / non-streaming success alongside `markContext1mBetaHealed`.
4. Test: 400 with the message → exactly one beta-stripped resend that omits `context_management` → succeeds; `tengu_beta_400_healed` once; second 400 surfaces. Model on `src/services/api/__tests__/context1mBetaHeal295Review.test.ts`.

Optional larger scope: port the full generic `M6t`/`BVe`/`Bgt` scanner (would also heal `evict_on_complete`, `thinking.display`, `block_binding`) — but the bespoke arm matches OCC's current architecture and is the minimal faithful port.

---

## #27 — Error after stopping a turn while compacting an API-rejected-too-long conversation → **N-A**

### Official evidence

The scenario is **reactive compaction** (API rejects request as too long → 413/400 → emergency compact). Official reactive-compact "after prompt too long" decision function (@254342964) has a skip-reason cascade:
```js
Le = n ? "prior_attempt"
   : p.abortController.signal.aborted ? "aborted"          // ← abort skip
   : !Jte(h)||p.agentId!==void 0 ? "not_main_thread"
   : r!=="not_needed" ? "decided_at_loop_top"
   : u ? "off_picked_model" : ae ? "unanswered_compaction"
   : oe>=Xp ? "repeated_refusals" : De ? "one_round"
   : Ye ? "relay_still_on" : ee ? "futile" : void 0;
if(Le!==void 0)
  return i("tengu_compact_after_prompt_too_long",{...te,outcome:b("skipped")}),{result:null};
```
When aborted mid-compaction, it returns `{result:null}` (skip) rather than leaving a dangling "Context limit reached"/"Prompt is too long" state. Telemetry anchors unchanged vprev→vver (`tengu_auto_compact_routed_reactive` 2/2, `tengu_compact_after_prompt_too_long` 5/5, `compact_prompt_too_long` 2/2) — logic-only fix inside the reactive path.

### OCC cross-check — feature not present

- `src/services/compact/reactiveCompact.ts` is an **auto-generated stub** (`export {}`); every function is a no-op: `isReactiveCompactEnabled:()=>false`, `tryReactiveCompact:async()=>null`, `reactiveCompactOnPromptTooLong:async()=>({ok:false})`.
- `src/query.ts:29` `const reactiveCompact = feature('REACTIVE_COMPACT') ? require(...) : null`; `src/utils/featureFlags.ts:65` `feature = name => FEATURE_ALLOWLIST.has(name)`.
- `src/query.ts:1336-1341` the reactive branch is explicitly commented **"DORMANT branch — `reactiveCompact` is always null in the shipped build (REACTIVE_COMPACT ∉ FEATURE_ALLOWLIST)"**; `autoCompact.ts:256/323` confirm "REACTIVE_COMPACT is ant-only / off".

The buggy path (abort during API-rejected-too-long reactive compaction) **cannot execute in OCC**. Verdict **N-A**.

Forward note: if OCC ever enables `REACTIVE_COMPACT`, port the official abort-skip cascade above (the dormant `tryReactiveCompact({..., aborted: signal.aborted})` call already threads `aborted`, so the structure is staged). The generic "stop turn while compacting" case (2.1.302) is already handled in OCC via the `!assistantMsg.isApiErrorMessage` guard in `compact.ts:1290-1298`.

---

## #28 — Subagents forgetting most recent work when messaged/resumed right after finishing → **PORT (S/M)**

### Mechanism

OCC transcript writes are **batched on a timer**, not synchronous:
- `src/utils/sessionStorage.ts:758` `FLUSH_INTERVAL_MS = 100`.
- `enqueueWrite` (811) pushes to `writeQueues`; `scheduleDrain` (830) sets a `setTimeout(…, 100)` before `drainWriteQueue` (866) actually appends to disk.
- A global `flush()` (1080) drains immediately; exported as `flushSessionStorage()` (1912) → `getProject().flush()`.

Resume reads **disk** with no drain:
- `src/tools/AgentTool/resumeAgent.ts:89-92` `resumeAgentBackground` → `getAgentTranscript(agentId)` (in `Promise.all`, no preceding flush).
- `src/utils/sessionStorage.ts:5177` `getAgentTranscript` → `loadTranscriptFile(agentFile)`, builds chain from the on-disk leaf message; returns whatever is persisted.

Trigger — SendMessage auto-resume of a **just-stopped** agent, with **no flush**:
- `src/tools/SendMessageTool/SendMessageTool.ts:822-829` "task exists but stopped — auto-resume" → `resumeAgentBackground({...})` (also 851 for the evicted-from-state path).
- Other caller: `src/screens/REPL.tsx:3829`.
- `flushSessionStorage()` is called in the main loop (`QueryEngine.ts:783,967,1235,1397,1440,1497`) but **never** in the resume/SendMessage path.

So if a subagent finished <100 ms ago, its tail entries are still queued; resume reads a stale transcript and rebuilds from an older leaf → "forgets most recent work." Matches the changelog exactly ("messaged or resumed right after finishing").

Official byte mechanism only partially recovered: the cloud/CCR resume `S_o` (@245746027) does a **tail-coherent refetch** (`endsOnLineBoundary`, `tail-incoherent` → re-read full) — a different architecture. The local-agent fix (flush-before-read) is inferred from OCC's own timer-drain design + the exact changelog wording; OCC already has the `flushSessionStorage()` primitive.

### Recipe (PORT)

Await a drain before reading the transcript on resume:
- In `resumeAgentBackground` (`resumeAgent.ts`, before the `Promise.all` at line 89): `await flushSessionStorage()` — covers both SendMessage and REPL callers. (`drainWriteQueue` iterates **all** queued files, so the agent's separate transcript file is flushed too.)
- Alternatively/additionally in `SendMessageTool.ts:824/851` before each `resumeAgentBackground`.
- Guard against double-flush cost (flush is idempotent; a 100 ms-window no-op when the queue is empty).
- Test: enqueue agent tail writes, resume within the flush interval without an intervening timer tick, assert the resumed transcript includes the latest messages.

---

## #41 — `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200k` silently 100K → k/M suffixes + warn → **PORT (M)**

### Official evidence (byte-verified)

Constants (@236987558): `gP=1e5` (100k min), `vN=1e6` (1M max).

**Core parser `j_e`** (@246816065):
```js
function j_e(e,{bareThousands:n}){
  let r=e.trim(), s=r.slice(-1).toLowerCase(),
      h=s==="m"?1e6:s==="k"?1000:void 0,             // k/M suffix multiplier
      y=h===void 0?qc(r):parseFloat(r)*h,            // suffix → parseFloat*mult; else int-parse
      w=n&&h===void 0&&y>=100&&y<=1000?y*1000:y;     // bareThousands: bare 100-1000 → *1000
  if(Number.isNaN(w)||w<1)return{kind:"unusable"};
  if(w<gP)return{kind:"below_minimum",tokens:Math.min(gP-1,Math.round(w))};
  if(w>vN)return{kind:"above_maximum"};
  return{kind:"in_range",tokens:Math.round(w),suffixed:h!==void 0}
}
```
**Env reader `T4t`** (@246816476) — clamps, ignores unusable; env uses `bareThousands:false` (`yVe(e)=j_e(e,{bareThousands:!1})`):
```js
function T4t(e){if(e===void 0)return;let n=yVe(e);switch(n.kind){
  case"in_range":return n.tokens; case"below_minimum":return gP;
  case"above_maximum":return vN;  case"unusable":return}}   // → undefined (ignored)
```
**`/autocompact` parser `wQt`** (@246820099) uses `bareThousands:true` (bare "200"→200000). **Resolver `Yb`** (@246820905) env branch: `let h=T4t(env); if(h!==void 0)return{window:Math.min(s,h),configured:h,source:"env"}`.

**Warning builder `E4t`** (@246817300), `v4t=32` sanitize cap:
```js
s=`CLAUDE_CODE_AUTO_COMPACT_WINDOW="${re(e,32).replace(/[^\w.,+ $%{}=;-]+/g,"?")}${e.length>32?"…":""}"`;
h=`${gP/1000}k` /*"100k"*/; y=`${vN/1e6}M` /*"1M"*/;
S=`Set it to a size from ${h} to ${y}, such as 200k or 200000, or unset it.`;
below_minimum → `${s} reads as ${tokens.toLocaleString("en-US")} ${I(tokens,"token")}, so Claude Code treats it as the ${h} minimum. ${S}`
above_maximum → `${s} is too large, so Claude Code treats it as the ${y} maximum. ${S}`
unusable      → `${s} isn't a usable size, so Claude Code ignores it. ${S}`
```
**Emitter `XFe`** (returns msg or null) + **`ySs`** (@246816655) logs telemetry `compact_window_env` (kind: below_minimum/above_maximum/unusable, plus `below_minimum_flag_accepts`) and surfaces interactively (`[autocompact] <msg>` warn) or headless. Startup call (@255784526): `if(!Qt)ySs(a.CLAUDE_CODE_AUTO_COMPACT_WINDOW,{interactive:!L,headless:(s)=>_ot(s,{key:"auto-compact-window-env",outputFormat:V,debugLine:`[autocompact] ${s}`})})`. `/config` also shows it: `p=XFe(...); if(p!==null)u.push(p)` (@260148727 region).

New strings all confirmed: `above_maximum` 0→6, `compact_window_env` 0→6, `isn't a usable size` 0→2, `treats it as the` 0→4 (vprev `below_minimum`=5 pre-existed for other uses).

**vprev contrast** (@244136592, resolver `Ob`): `if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let y=qje("CLAUDE_CODE_AUTO_COMPACT_WINDOW",env,rO,iF); if(y.status!=="invalid"){let S=Math.max(rO,y.effective); return{window:Math.min(s,S),configured:S,source:"env"}}}` — `qje` is parseInt-based (no suffix), `Math.max(rO,·)` clamps to min silently. `"200k"` → parseInt→200 → clamped to min (100K), no warning. Exactly the bug.

### OCC cross-check

- `src/utils/autoCompactWindow.ts:57-58` `AUTO_COMPACT_WINDOW_MIN=100_000`, `AUTO_COMPACT_WINDOW_MAX=1_000_000` (match `gP`/`vN`).
- `parseAutoCompactWindowInput` (161-190) is already suffix-aware (endsWith 'm'/'k', bare [100,1000]→×1000) — but this mirrors official **`wQt` (bareThousands:true)**, i.e. the `/autocompact` parser, and returns `undefined` on out-of-range (no clamp).
- **The env resolver is the bug:** `resolveAutoCompactWindow` env branch (autoCompactWindow.ts ~283-296):
  ```js
  const envRaw = process.env[ENV_WINDOW_KEY]
  if (envRaw) { const parsed = parseInt(envRaw, 10)
    if (!isNaN(parsed) && parsed > 0)
      return { window: Math.min(contextWindow, parsed), configured: parsed, source: 'env' } }
  ```
  Documented divergence at line ~259: *"env parsing keeps OCC's pre-existing `parseInt > 0` semantics."* `parseInt("200k")=200` → `window=min(ctx,200)`. No suffix, no clamp-to-min/max, no unusable-ignore, **no warning**.
- No `compact_window_env` telemetry, no warning emitter, no `/config` env-warning line.

### Recipe (PORT)

1. **autoCompactWindow.ts** — add env parser mirroring `j_e(e,{bareThousands:false})` returning `{kind, tokens?}`, and an env resolver mirroring `T4t` (in_range→tokens, below_minimum→MIN, above_maximum→MAX, unusable→undefined/ignore). Replace the `parseInt` branch in `resolveAutoCompactWindow` with it. (Reuse `parseBareNumber`/suffix logic but with `bareThousands:false` and clamp semantics — do **not** reuse `parseAutoCompactWindowInput` verbatim; it is the bareThousands:true `/autocompact` variant and returns undefined instead of clamping.)
2. Add `E4t`-equivalent warning builder (3 messages, sanitize value to 32 chars via the `[^\w.,+ $%{}=;-]`→`?` filter) + `XFe`/`ySs`-equivalent emitter logging `compact_window_env` and surfacing interactive (`[autocompact] …` warn) / headless.
3. Call the emitter at startup (mirror `if(!Qt)ySs(env,{interactive:!L,headless:…})`) and add the `XFe(env)` line to the `/config` auto-compact-window display (`src/commands/autocompact/autocompact-noninteractive.ts` already has the source-label map incl. `env:'from CLAUDE_CODE_AUTO_COMPACT_WINDOW'`).
4. Tests: `200k`→200000 (in range, no warn); `50`→clamp 100k + below_minimum warn; `5M`→clamp 1M + above_maximum warn; `abc`→ignored + unusable warn; `200000`→200000.

---

## #50 — Resume of large compacted sessions (SDK/headless): first request sent sooner → **STAGED (L)**

### Official evidence

Logic-only timing optimization — **no new strings**: `hydratePrefetch` count identical (vprev 12 / vver 12). The resume hydration is instrumented by a timing class (@~127227160):
```js
class p{phases={};phaseStarts={};warmSpareClaimed=!1;
  hydratePrefetchSettledAt=void 0; resumeHydratePrefetch=void 0;
  resumeHydrateOnDiskBytes=void 0; resumeHydrateCcrBytes=void 0;
  resumeHydrateCcrEvents=void 0; resumeHydrateDeltaEvents=void 0;
  resumeHydrateAnchorWalkback…}
```
Resume hydration fn `S_o` (@245746027) does CCR-event read + tail-coherence + `hydratePrefetch` (`.then(...)` parallel prefetch). "First request sent sooner" = the first model request is dispatched before full hydration settles (prefetch/parallel rather than eager-await). The exact reordering is embedded in minified async CCR/SDK code with no distinguishing byte signal.

### OCC cross-check

OCC resume architecture differs:
- `src/screens/REPL.tsx:1889` `resume()` → `deserializeMessages(log.messages)` synchronously; `provisionContentReplacementState` at 1616 is documented **O(messages × blocks)** for large resumed sessions (lazy via `useState` initializer, computed once).
- No `hydratePrefetch`/CCR-event prefetch abstraction; no eager-vs-lazy rehydration toggle to flip.

Verdict **STAGED**: conceptually OCC has the same cost center (large-resume reconstruction before first render/request), but the official's specific "send first request sooner" change is not byte-identifiable and a port would require restructuring OCC's resume→first-request pipeline (prefetch/parallelize `deserializeMessages` + `provisionContentReplacementState` off the first-request critical path). Recommend a dedicated OCC-side perf spike rather than a byte-port.

---

## #52 — Memory use when sending requests in long/resumed conversations → **STAGED / N-A**

### Official evidence

Changelog is vague; **no identifiable string signal** and logic-only. No new telemetry/labels tied to request-memory. Not byte-identifiable in this round.

### OCC cross-check

Plausible target: OCC builds `messagesForAPI` with **multiple full-array copies** per request:
- `src/services/api/claude.ts:2022` `normalizeMessagesForAPI(...)`; `2040` `.map(...)`; `2057` `ensureToolResultPairing`; `2061` `stripAdvisorBlocks`; `2068` `stripExcessMediaItems`; `2093-2098` spread rebuild. Each pass allocates a fresh array of the whole conversation — significant for long/resumed sessions.

Verdict **STAGED / N-A**: without a byte-identifiable official change (e.g., a specific in-place mutation, shared-buffer, or lazy-slice that reduced allocations), a faithful port can't be specified. If pursued, treat as an OCC-side optimization of the `messagesForAPI` pipeline (collapse passes / avoid redundant copies), not an official-alignment port.

---

## #21 — Model switches/messages/interrupts waiting behind a context usage check (SDK/desktop) → **STAGED (L)**

### Official evidence

Logic-only concurrency fix — **no new strings**: "context usage" count identical (vprev 14 / vver 14). Official has `getContextUsage` (@119403801), `context_usage`, `contextUsageMirror`/`tokenUsageMirror`/`reportInternalMetadata` (property-name table @119701504) — the SDK/desktop internal-metadata context-usage reporting. The changelog describes control operations (set_model @238884624, interrupt @238859487, messages) queued **behind** a context-usage check; the fix makes the check non-blocking / reorders the control-request queue. The specific change lives in minified async control-request handling with no distinguishing byte signal.

### OCC cross-check

- OCC SDK control layer: `src/entrypoints/sdk/controlSchemas.ts` (`initialize` @60, `can_use_tool` @109, `set_model` @140, `mcp_message` @377, `control_request` @582).
- **No** `getContextUsage` / `contextUsageMirror` / "context usage check" surface found in OCC (`rg contextUsage src/entrypoints/sdk/ src/QueryEngine.ts src/screens/REPL.tsx` → none). OCC does not appear to run a blocking per-turn context-usage check that serializes control ops.

Verdict **STAGED**: the official fix targets a context-usage-check serialization that OCC's SDK control loop does not obviously replicate (no matching surface identified). Not byte-identifiable from the diff; needs a focused review of OCC's SDK control-request dispatch ordering to determine whether an equivalent blocking check exists before any port. Likely low-priority / possibly N-A once OCC's control loop is confirmed non-blocking.

---

## #11 — `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` dropping messages when disk filled mid-trim → **N-A**

### Official evidence

`CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` count unchanged (vprev 10 / vver 10) — logic-only fix (ENOSPC handling in the GC trim/rewrite). GC gate:
```js
// @272876679
function fns(){return a.CLAUDE_CODE_TRANSCRIPT_LOCAL_GC ?? k("tengu_transcript_local_gc",!1)}
import{createWriteStream as ns,fstatSync as rs}from"fs"; import{PassThrough as ss}from"stream";
// @245663040  WZt(e){ sd().setLocalGcEnabled(e) }   // resume path calls WZt(fns())
```
The trim rewrites the transcript file via a write stream; the disk-full fix guards the rewrite so a mid-trim ENOSPC no longer drops messages. (Related prior changelog entries in-binary confirm this subsystem: "no longer rewritten when that would free under 10%", U+2028/U+2029 message-drop fix.)

### OCC cross-check — feature not present

- `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` appears **only** in `src/utils/__tests__/projectScopeDisableAttachments290.test.ts:19` (an env-name list to disable in a test) — **no production reader**.
- No transcript GC/trim implementation: `rg trimTranscript|transcriptGc|setLocalGcEnabled|localGc|TRANSCRIPT_SLIM` → nothing in `src/` production.
- OCC's only transcript write stream is append-mode (`src/bridge/sessionRunner.ts:276 createWriteStream(transcriptPath,{flags:'a'})`); OCC's `sessionStorage` rewrite/tombstone machinery is unrelated to the GC-trim feature.

Verdict **N-A**: OCC never ported the transcript-local-GC feature, so there is no trim/rewrite path for the disk-full bug to affect. (OCC's append path already has ENOSPC handling — `appendToFile` retry + `warnTranscriptWriteFailure`, sessionStorage.ts ~845-862, from 2.1.217.) Forward note: if the GC feature is ever ported, include the official ENOSPC guard on the trim rewrite.

---

## #6 — Compaction summary (Ctrl+O) includes names of tools called earlier → **PORT (M)**

### Official evidence (byte-verified)

New strings all confirmed **prev=0**: `tools-used-before-summary` 0→2, `toolNamesUsed` 0→5, `Tools called before this summary` 0→2.

**Summary composition change** — vprev (@~245905481):
```js
let dn=[Ce({...zZ(Ht,{suppressFollowUpQuestions:s,promptArm:ot,transcriptPath:Et,...!1,foreignArtifactContent:ult(e)}),isCompactSummary:!0,isVisibleInTranscriptOnly:!0})].map((yn)=>G6(yn,e))
```
vver (@~247828853) — adds `toolNamesUsed:HJ(e)`:
```js
let po=[Re({...GJ(Ut,{suppressFollowUpQuestions:s,promptArm:st,transcriptPath:wt,...!1,foreignArtifactContent:$dt(e),toolNamesUsed:HJ(e)}),isCompactSummary:!0,isVisibleInTranscriptOnly:!0})].map((on)=>C3(on,e))
```

**Tool-name extractor `HJ`** (@247678820):
```js
function HJ(e){let n=new Set;
  for(let r of e){
    if(r.type!=="user"&&r.type!=="assistant")continue;
    let s=r.message?.content,h=Array.isArray(s)?s:[{type:"text",text:s}];
    for(let y of h)
      if((y?.type==="tool_use"||y?.type==="server_tool_use")&&typeof y.name==="string")
        n.add(ac(y.name.trim()));                                   // ac = alias-normalize (MWr map)
      else if(r.type==="user"&&r.isCompactSummary&&y?.type==="text"&&typeof y.text==="string")
        (y.text.match(Xan)?.[2]??"").split(",").forEach((w)=>n.add(w.trim()))  // carry prior summary's tools
  }
  return [...n].filter((r)=>Mir.test(r)).sort()}
```
Constants/regex (@247678644-247678676):
```js
dve="tools-used-before-summary",
Mir=/^(?!.*\s{2})[^<>,\p{C}  ]{1,256}$/u,                 // valid tool-name filter
Van=`(?:${Dh}\n.*\n)?`,
Xan=new RegExp(`^(${Van}${Ma(eXe)}\n\n${Van})<${dve}>([^<]*)</${dve}>\n?`)   // extracts prior tag (group 2)
```
`ac(e)` (@236587529) `=w2o(MWr,e)=Object.hasOwn(MWr,e)?MWr[e]:e` — tool-name alias map.

**Tag renderer `Zan`** (@247679308): `function Zan(e=[]){return `<${dve}>${e.join(", ")}</${dve}>\n`}`.
**Summary builder `GJ`** injects it: `h=`${Uy(foreignArtifact,…)}${eXe}\n\n${Zan(n?.toolNamesUsed)}${r}`` where `r=$ir(e)` (analysis-stripped summary).

**Transcript-view display `jEs`** (@247679378 def; called @266219291):
```js
function jEs(e){return e.replace(Xan,(n,r,s)=>s?`${r}Tools called before this summary: ${s}\n`:r)}
function Bce(m,d){return m=jEs(m),m}
function si(m){…{message:d,screen:g}=m,f=g==="transcript";…M=Bce(Qy(d)||"",d.modelOnlyText)…}  // si = compact-summary render component
```
So the raw `<tools-used-before-summary>A, B</tools-used-before-summary>` tag stored in the summary is rewritten to the human line **"Tools called before this summary: A, B"** only in the transcript view (`screen==="transcript"`, Ctrl+O). The model sees the XML tag; the human sees the readable line.

### OCC cross-check

- Summary composer: `src/services/compact/prompt.ts:341` `getCompactUserSummaryMessage(summary, suppressFollowUpQuestions?, transcriptPath?)` — no `toolNamesUsed` param; header is OCC's own prose ("This session is being continued…"), not `eXe`. `formatCompactSummary` (313) already strips `<analysis>` / rewrites `<summary>` (mirrors official `$ir`).
- Compact flow: `src/services/compact/compact.ts:658,1104` set `boundaryMarker.compactMetadata.preCompactDiscoveredTools` (the **tool-search** carry from 2.1.302 — a different feature; not the summary tool-names line).
- Transcript render: `src/components/messages/CompactBoundaryMessage.tsx` (`findCompactSummaryInfo`, `compactBoundaryDetail`) — parses transcript path from the summary; **no** `jEs`-equivalent tag→readable transform.
- `toolNamesUsed`, `tools-used-before-summary`, `Tools called before this summary` — **absent** in OCC.

Verdict **PORT**.

### Recipe (PORT)

1. **Extractor** — add `getToolNamesUsed(messages)` mirroring `HJ`: collect `tool_use`/`server_tool_use` names from user/assistant messages, normalize via OCC's tool-name alias/normalizer, carry forward any prior summary's names by matching the `<tools-used-before-summary>` tag, filter to valid names (port `Mir`), sort+dedupe.
2. **Renderer + tag** — add `Zan`-equivalent producing `<tools-used-before-summary>a, b</tools-used-before-summary>\n` and the constant `tools-used-before-summary`; port the `Xan` regex.
3. **Composer** — extend `getCompactUserSummaryMessage` (prompt.ts:341) with a `toolNamesUsed?: string[]` param; inject the rendered tag right after the header line (before the formatted summary), matching official `GJ` placement. Wire the caller in `compact.ts` (and `sessionMemoryCompact.ts`) to pass `getToolNamesUsed(preCompactMessages)`.
4. **Transcript display** — add a `jEs`-equivalent transform applied when rendering the compact summary in transcript view (Ctrl+O), replacing the tag with `Tools called before this summary: …`. Hook into `CompactBoundaryMessage.tsx` / the transcript summary render component (OCC's `si` equivalent), gated on transcript screen.
5. Tests: summary text contains the tag with sorted tool names; prior-summary names carry across re-compaction; transcript render shows the readable line and hides the XML; invalid/dup names filtered.

---

## Cross-cluster notes

- **Generic beta-heal scanner (relevant to #22, and the API cluster):** OCC deliberately ships *bespoke* heal handlers (context-1m, tool-schema, advisor, media) and omits the official generic `M6t`/`BVe`/`Bgt` scanner. Official 304 adds a context_management arm to that generic scanner; the minimal faithful OCC port is a new bespoke handler. If future rounds keep adding arms (`evict_on_complete`, `thinking.display`, `block_binding` already exist officially), consider porting the generic scanner once to avoid N bespoke handlers. The API/gateway cluster should confirm no other 304 beta arms were added (only `dde`/context_management was new in `M6t`).
- **`tengu_beta_400_healed` shape (#22):** official logs `{beta, model, provider, status, unnamed?}`. OCC's `markContext1mBetaHealed` (claude.ts:2410-2435) already emits this exact shape — reuse for the context_management arm (`unnamed:false`).
- **Compaction summary composer (#6) vs preCompactDiscoveredTools (2.1.302, tool-search):** these are two *different* tool-name mechanisms. `preCompactDiscoveredTools` (compact.ts:658/1104, toolSearch.ts:617) seeds the tool-search loaded-set across the compaction boundary; #6's `toolNamesUsed` is a human/model-facing summary line. Do not conflate — #6 is additive.
- **Reactive compaction (#27) is a large dormant subsystem in OCC** (`reactiveCompact.ts` stub; `feature('REACTIVE_COMPACT')` off; `query.ts:1336` DORMANT branch already threads `aborted`). Any future enablement must port the official abort-skip cascade (@254342964) plus the whole reactive path — several upstream compaction fixes (2.1.302 "Prompt is too long" stop-turn, 2.1.304 #27) live there.
- **Resume/hydration perf (#50) and request-memory (#52)** both point at OCC's resume reconstruction cost (`provisionContentReplacementState` O(messages×blocks), REPL.tsx:1616) and the multi-copy `messagesForAPI` pipeline (claude.ts:2022-2098). Neither is a byte-portable official change this round, but both are genuine OCC-side optimization candidates — worth a combined perf spike.
- **SDK control-loop (#21):** OCC's SDK control schemas exist (controlSchemas.ts) but no blocking context-usage check was found. Before treating #21 as a gap, confirm OCC's control-request dispatch isn't serialized behind any per-turn token/context computation; if it isn't, #21 is effectively N-A for OCC.
- **Transcript GC (#11)** and **reactive compaction (#27)** are both whole features OCC has not ported — recurring pattern where an official bug-fix has no OCC surface. Track these as "feature absent" so future rounds don't re-investigate the fixes.
