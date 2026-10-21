# FINAL DELIVERABLE — Gap research OCC 2.1.304 → 2.1.306 (items 1–3)

Method note: all byte evidence from `/tmp/cc-diff-306/v306/package/claude` (and v304/v305 for delta attribution), read-only via `grep -aboF` offsets + `dd`. Offsets are absolute decimal bytes. Minified names are v306-local.

---

## ITEM 1 — (2.1.305) Tool-search refuse-recovery broadened to Vertex/Bedrock/gateway + `--tools` allowlist

**Verdict: PORT** (large — the official v305 fully rewrote the 304 mechanism OCC currently ports; v306 adds a small delta on top, which is Item 2)

### What changed, version by version
- **v304 (what OCC has)**: gate `b6` = only `firstParty` behind a **custom** `ANTHROPIC_BASE_URL`; unclaimed 400/422 → single retry `withoutToolSearch:!0`; on success persist `toolSearchRefusedAt[sha256(baseUrl\0model)[:24]]=Date.now()` with a **1-day window** (`var h=86400000`) suppressing tool search on later requests.
- **v305 (rewrite, changelog: "Fixed every request failing on Vertex, Bedrock and other providers when the endpoint or a gateway rejects tool search, and behind gateways with ToolSearch disallowed or left out of `--tools` …")**:
  - **Removed** the 1-day persisted `toolSearchRefusedAt` window entirely. Replaced by two in-memory drop scopes: `bg` = conversation-scoped beta-drop set, `o9o` = process-per-model drop set.
  - **Removed** the `withoutToolSearch` request option; retry is now driven by a dedicated error class `UZ` @abs **249500797** carrying `{refusal, declaredToolSearch}`, thrown through wrapper `pgn` as option `toolSearchRefusal`.
  - **Two detectors** in the fatal-400 chain:
    - `Rse` = **named** beta-refusal detector (message names the beta header; infra `iSe`/`TQ`/`e5t`: marker scan for "Unexpected value(s)"-style beta rejections), wired **mid-chain** (after `Hgt` context-1m recovery, before `jgt`).
    - `N6` = **unclaimed** detector, wired **dead last** (`...??xse??F6??N6`). Covers the mechanism marker `Xo` = `"tool_search"` **OR** `"tool_addition"` — `tool_addition` is the `--tools`-allowlist case (gateway rejects because ToolSearch isn't in the allowlist and tools arrive undeferred).
  - **Enablement broadened** (`nkr` @abs **249125470**: reasons `B8e`, modes `Ryo:"held_off"`, `iBe:"refused"`): recovery now runs for **any provider** (Vertex/Bedrock/gateway included), not just custom-base-URL firstParty.
  - **Bedrock exclusion on the send side** (`tgn` setup @abs ~249520500–249529500): `Er=mo?z_t():null;if(Er&&ps!=="bedrock"){if(!pt.includes(Er))pt.push(Er)}` — the tool-search beta header is **never attached** for Bedrock.
  - **Success side** `hLe`: named refusal → drop beta for conversation **and** process-per-model, warn `"[betas] the API refused <header>; not sent again in this conversation, or by new ones on <model> in this process"`; unnamed → conversation drop, warn `"[ToolSearch] the endpoint answered the request sent without tool search, so this conversation goes on without it"`. Analytics changed to `tengu_beta_400_healed {beta, model, provider, status: refusal.status, unnamed: !named}` (no more `unclaimed:true` / persisted window).
  - `GVe`: **422→400 normalization** of the error before classification.
  - New retry warn text: `"sending the request again without deferred tools. ENABLE_TOOL_SEARCH=false avoids the refused request"`.
- **v306 delta** (byte-verified as the ONLY substantive changes in the tool-search region): see Item 2 — `Jmn()` extraction + `defer_loading` gate + thinking-display reuse.

### Key v306 verbatim evidence
`function Jmn()` @abs **249494785** (306-only; v305 had the inline expression):
```js
function Jmn(){try{return xe()==="firstParty"&&a.ANTHROPIC_UNIX_SOCKET===void 0&&vf()&&!sH()}catch(e){return l(U(e)),!1}}
```
Full `Ese` (unclaimed-eligibility predicate) @abs **249523776** (context confirmed again at 249523824 in the final filtered scan):
```js
Ese=(to)=>{let _r=GVe(to);return L6(to)&&(!Jmn()||/\bdefer_loading\b/.test(to.message))&&(to.status===400||to.status===422)&&to.type!=="billing_error"&&!Fw(_r)&&!UF(_r)}
```
(`L6` = request declared tool search; `Fw`/`UF` = prior-recovery-claimed checks.)

Thinking-display retry now reuses `Jmn()` @abs **249525818**: `...||!Yun()||Jmn())return; ... od="retrying","retry:thinking-display-updates-unclaimed"` (v305: inline `a.ANTHROPIC_UNIX_SOCKET===void 0&&vf()&&!sH()`).

All other v305 machinery (L6, EF, Rse, N6, hLe, bn, UZ, pgn, tgn, nkr, beta-drop infra) verified **byte-identical v305↔v306** → the rewrite landed in 305.

### OCC current state
- `src/services/api/claude.ts:2952–3044` — `retryToolSearchRefused`: v304 `b6`-style gate (`toolSearchHeader in lastRequestBetas` + `isToolSearchRefuseRecoveryEnabled()` + 400/422 + not `billing_error`, one-shot latch `toolSearchRecoveryDone`). Rebuilds undeferred schemas via `toolToAPISchema(..., deferLoading:false)`, strips beta, prepends critical_system_reminder (`:3026–3034`).
- `src/services/api/claude.ts:3052–3073` — `markToolSearchRefusedHealed`: calls `recordToolSearchRefused(model)` + logs `tengu_beta_400_healed {…, unclaimed:true}` (v304 shape).
- Wiring: `claude.ts:1203` (option type), `:1329`, `:3215`, `:3377`, `:4251`, `:4273`, `:4392`, `:4412`; `src/services/api/withRetry.ts:389` (option decl), `:1093–1099` (wired LAST in fatal-400 chain, `attempt--; continue`).
- `src/utils/toolSearch.ts:271` `TOOL_SEARCH_REFUSED_TTL_MS = 86_400_000`; `:286` `isToolSearchRefuseRecoveryEnabled()` (firstParty + custom base URL + no `ENABLE_TOOL_SEARCH` — **v304 scope only**); `:299` `toolSearchRefusedKey`; `:309` `isRefusedAtFresh`; `:317` `pruneRefusedEntries`; `:330` `isToolSearchRefused`; `:350` `recordToolSearchRefused` (persists `toolSearchRefusedAt` in global config).
- Tests: `src/services/api/__tests__/toolSearchRefuseRecovery304.test.ts`, `src/utils/__tests__/toolSearchRefusedWindow304.test.ts`.
- **Gaps**: no Vertex/Bedrock/gateway coverage; no named-refusal detector; no `tool_addition`/`--tools` case; persists the 1-day window official 305 deleted; no conversation/process beta-drop; no Bedrock header suppression; no 422→400 normalization; no `defer_loading` gate (Item 2 bug present).

### Implementation plan
Files:
1. **`src/utils/toolSearch.ts`** — delete `TOOL_SEARCH_REFUSED_TTL_MS`, `toolSearchRefusedKey`, `isRefusedAtFresh`, `pruneRefusedEntries`, `isToolSearchRefused`, `recordToolSearchRefused` and the `toolSearchRefusedAt` global-config key usage. Add (mirroring `bg`/`o9o`): module-level `conversationDroppedBetas: Set<string>` + `processDroppedByModel: Map<string, Set<string>>`; `dropToolSearchBetaForConversation(beta)`, `dropToolSearchBetaForProcess(beta, model)`, `isToolSearchBetaDropped(beta, model)`. Broaden the enablement predicate to all providers (keep `ENABLE_TOOL_SEARCH` override semantics; `nkr` reasons: `held_off` / `refused`).
2. **`src/services/api/claude.ts`** —
   - Add `isFirstPartyProdLike()` = official `Jmn`: `getAPIProvider()==='firstParty' && process.env.ANTHROPIC_UNIX_SOCKET===undefined && isFirstPartyAnthropicBaseUrl() && !isAnthropicOverUnixSocket/gateway-flag` (map `vf()`/`sH()` to OCC's existing first-party-URL and proxy/bedrock checks; verify mapping at implementation).
   - Replace `retryToolSearchRefused` with two detectors:
     - **Named** (`Rse`): error message matches the beta-refusal marker scan ("Unexpected value(s)"-style naming the tool-search beta header, or `Xo` mechanism marker `"tool_search"`/`"tool_addition"`); builds `ToolSearchRefusalError {refusal:{status}, declaredToolSearch:boolean}` (`UZ`/`pgn` analog).
     - **Unclaimed** (`N6`): gate `L6 && (!isFirstPartyProdLike() || /\bdefer_loading\b/.test(error.message)) && (status===400||status===422) && type!=='billing_error' && !claimedByOtherRecovery` (verbatim regex `/\bdefer_loading\b/`).
   - Success side (`hLe`): named → both drops + warn `"[betas] the API refused ${header}; not sent again in this conversation, or by new ones on ${model} in this process"`; unnamed → conversation drop + warn `"[ToolSearch] the endpoint answered the request sent without tool search, so this conversation goes on without it"`; `logEvent('tengu_beta_400_healed', {beta, model, provider, status: refusal.status, unnamed: !named})`. Retry warn: `"sending the request again without deferred tools. ENABLE_TOOL_SEARCH=false avoids the refused request"`.
   - Header attachment (`useToolSearch`/`toolSearchHeader` block ~`:1961`): skip when `isToolSearchBetaDropped(...)`; **never attach for Bedrock** (`provider !== 'bedrock'`, official `Er&&ps!=="bedrock"`).
   - Normalize 422→400 for classification before the chain (`GVe` analog).
3. **`src/services/api/withRetry.ts`** — keep unclaimed hook LAST (`:1093`); add the named-refusal hook **mid-chain** after the context-1m recovery (`:1000–1018` region) to mirror official ordering.
4. **Tests** — rewrite `toolSearchRefuseRecovery304.test.ts` → `…306.test.ts`: (a) named beta refusal at gateway → retry w/o header, both drops, `[betas]` warn, healed event `{unnamed:false}`; (b) first-party-prod unnamed 400 **with** `defer_loading` in message → retry; (c) first-party-prod unnamed 400 **without** `defer_loading` (e.g. MCP-schema error) → **no** retry (Item-2 regression); (d) Vertex/gateway unnamed 400 without `defer_loading` → retry (broadened scope); (e) Bedrock → beta never sent; (f) `tool_addition` (`--tools` allowlist) error → retry; (g) `billing_error` excluded; (h) one-shot per request; (i) subsequent requests in same conversation omit beta; new process omits for same model only after named refusal. **Delete** `toolSearchRefusedWindow304.test.ts` and any `toolSearchRefusedAt` config assertions.

---

## ITEM 2 — (2.1.306) "API error replaced by 'prompt is too long' + unneeded compaction in sessions with many MCP tools"

**Verdict: PORT** — same code as Item 1's v306 delta (fold into that implementation); **no changes needed** to OCC's `errors.ts` or compaction logic.

### Byte evidence (exhaustive)
Full resync-diff of **all** JS regions (214MiB→EOF; windows 214–232, 232–236, 236–250, 250–262, 262–278MiB) between v305 and v306 found only these substantive changes:
1. `Jmn()` extraction @abs **249494785**;
2. `(!Jmn()||/\bdefer_loading\b/.test(to.message))&&` inserted into `Ese` @abs **249523776**;
3. `Jmn()` reuse in thinking-display retry @abs **249525818**;
4. a UNC-path regex removal @abs 243269632 (WebFetch URL detection — unrelated);
5. cloud-session "Not logged in" fix (other 2.1.306 changelog entry) + version constants.

Every prompt-too-long / compaction site was compared byte-for-byte and is **identical v305↔v306**: classifiers `LRr`/`ORr`/`MRr`/`N6t`, sites b/c, `zD` cluster, `Omn`/`MQe`, reactive-compact executor `Par` (`if(hpe(Pe))return{ok:!1,reason:"prompt_too_long",tokenGap:k7t(Pe)}`, `l5t(Pe)` credits branch), classifier-overflow region @249321578 (`compact_classifier_overflow`), reactive-compact regions @249154963/249245541. (Earlier "Prompt is too long" hits @256161925 etc. = embedded changelog text, not code.)

### Root cause / mechanism (high confidence)
v305's unclaimed recovery (`Ese`/`N6`) fired on **any** unclaimed 400/422 in a first-party tool-search session. With many MCP tools, an unrelated 400 (e.g. an MCP tool schema validation error) hijacked the recovery → request retried **undeferred** with all full MCP tool schemas → genuinely-too-long request → the real API error surfaced as "Prompt is too long" and triggered an unneeded reactive compaction. v306's fix: on first-party production (`Jmn()` true), require the error message to contain `defer_loading` before treating it as a tool-search refusal; on Vertex/Bedrock/gateways (`Jmn()` false) recovery stays always-on (preserving the 305 regression fix).

### OCC current state
OCC's gate (`claude.ts:2985–2991`) is the v304 `b6` shape: no `defer_loading` requirement, no first-party-prod distinction — **OCC has the same hijack bug**. `src/services/api/errors.ts` and the compaction trigger need no changes (official classifier unchanged).

### Plan
Implemented by Item 1 step 2 (the `(!isFirstPartyProdLike() || /\bdefer_loading\b/.test(message))` clause) + regression test (c) above: many-MCP-tools session, first-party prod, unrelated 400 without `defer_loading` → error surfaces verbatim, no undeferred retry, no reactive compaction.

---

## ITEM 3 — (2.1.305) `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS`

**Verdict: PORT** — OCC has the `CLAUDE_CODE_RETRY_WATCHDOG` surface in `src/`; the var was added in **v305**; the region is byte-identical v305↔v306 (only name churn `Sfr`→`Cfr`, verified via 1-event diff of `i3_v306.bin`@249461885 vs `i3_v305.bin`@249462094).

### Byte evidence
Env export map @abs **237988422** (module K):
```js
CLAUDE_CODE_RETRY_WATCHDOG:()=>Ox,
CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS:()=>Lx,
CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS:()=>Tx,
CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS:()=>cx
```
429 usage-limit branch + recheck loop @abs **249461885+** (v306):
```js
if(on instanceof Ht&&on.status===429){if(sr=Kfr(on,h),sr!==null&&on.headers?.get?.("anthropic-ratelimit-unified-status")==="rejected"){
  let Vs=(a.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS??1/0)-K.usageLimitSpentMs;
  if(sr>Vs){let Rs=on.headers?.get(DUt),Qs=Rs==="allowed"||Rs==="allowed_warning";
    if(Vs<=0||!Qs&&on.headers?.get(pGe)!=="fetch_error")throw m("api_request","api_request_usage_limit_wait_too_long"),new Bc(on,y);
    sr=Qs?Math.min(Vs,xN(q,null,wmn,r.random)):Vs}
  ps=on}}
ns=Math.min(sr??xN(q,Jr,wmn,r.random),TQe),ns=Math.min(ns,Ys)
let Gr=Vo?M_o:ns,qr=co&&!Vo,
    fs=ps&&r.isUsageLimitLifted?a.CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS:void 0;
if(ps&&Se)Q++,Se=!1;
let Lo=fs===void 0?1/0:0,Ur=0,us=ns;
while(us>0){
  if(fs!==void 0&&Lo<=0)Lo=xN(1+Q,null,TQe/2,r.random,fs);   // jittered recheck interval, cap TQe/2
  if(Vo&&r.signal?.aborted)throw new yu;
  let Ys=RQe(on,y.model); /* …onRetryStatus + sV yield… */
  let sr=Math.min(us,Gr),Vs=Math.min(sr,Ur);Ur=0;
  let Rs=h.monotonicNow(),Qs=await Tmn(sr-Vs,r);              // sleep-with-wake (subscribeRetryWake)
  if(Ro){let ji=Qs?Math.min(sr,Vs+Math.round(h.monotonicNow()-Rs)):sr;
    if(K.spentMs+=ji,ps)K.usageLimitSpentMs+=ji}
  if(Qs)break;
  if(us-=sr,Lo-=sr,Lo<=0&&us>Gr&&ps&&r.isUsageLimitLifted){    // recheck gate
    let ji=!1,Ga=r.subscribeRetryWake?.(()=>{ji=!0}),Fa=h.monotonicNow(),cs=!1;
    try{cs=await r.isUsageLimitLifted(ps)}catch(jo){l(jo)}finally{Ga?.()}
    if(Se=cs,cs||ji)break;                                     // lifted or woken → retry now
    Ur=Math.max(0,Math.round(h.monotonicNow()-Fa))}            // recheck time credited to next chunk
}
```
New retry options threaded from callers — @abs **249490413–249490512**: `...subscribeRetryWake:n.subscribeRetryWake,...isUsageLimitLifted:n.isUsageLimitLifted,lowPriorityWait:n.lowPriorityWait`; @abs **249570971+**: `subscribeRetryWake:Q.subscribeRetryWake,...,isUsageLimitLifted:$F`.

Semantics: only when the pending wait was caused by a **429 unified-status "rejected"** error (`ps`) AND the caller supplied `isUsageLimitLifted`, the env var enables periodic rechecks; `Lo` counts down the recheck deadline (jittered, `xN`, capped at `TQe/2`); when it expires mid-wait, poll `isUsageLimitLifted(savedError)` (raced against a retry-wake subscription via `Tmn`'s nested AbortController); if lifted or woken, break out of the sleep and retry immediately; polling time is charged to `capacityWait.spentMs`/`usageLimitSpentMs` (still bounded by `MAX_USAGE_LIMIT_WAIT_MS`). Unset → `Lo=Infinity` → never rechecks (v304 behavior).

### OCC current state
`src/services/api/withRetry.ts` has the watchdog family but **not** this var (grep: zero hits for `RECHECK`, `isUsageLimitLifted`, `subscribeRetryWake` in `src/`):
- `:540–556` `capacityWait = { spentMs: 0, usageLimitSpentMs: 0 }` (+ doc comments quoting official offsets);
- `:1408` MAX_WAIT_MS cap; `:1439–1440` MAX_USAGE_LIMIT_WAIT_MS cap (`(a.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS??1/0)-V.usageLimitSpentMs` mirror);
- chunked wait loop `:1595–1611` (`await sleep(chunk, options.signal, {abortError})`, `capacityWait.spentMs += chunk` `:1609`, `usageLimitSpentMs += chunk` `:1611`);
- getters + digits-only validation + warn-once: `:1763–1830` (`MAX_WAIT_MS`, warn string `:1808`), `:1839–1895` (`MAX_USAGE_LIMIT_WAIT_MS`, warn `:1880`).

### Implementation plan
1. **`src/services/api/withRetry.ts`**:
   - Add digits-only getter `getRetryWatchdogUsageLimitRecheckMs()` beside `:1839–1895`, same warn-once pattern: `` `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS='${raw}' is not a digits-only value; ignoring it.` `` and add it to the validation/export map region (`:1763–1888`).
   - Extend `WithRetryOptions` (near `:389`): `isUsageLimitLifted?: (error: APIError) => Promise<boolean>`, `subscribeRetryWake?: (cb: () => void) => (() => void)`.
   - Track `usageLimitError` (official `ps`): set when the wait was computed from a 429 with `anthropic-ratelimit-unified-status === 'rejected'` (this branch already exists around `:1439–1478`).
   - In the chunked wait loop (`:1595–1611`): compute `recheckMs = usageLimitError && options.isUsageLimitLifted ? getRetryWatchdogUsageLimitRecheckMs() : undefined`; `recheckDeadline = recheckMs===undefined ? Infinity : 0`; each chunk decrement by chunk ms; when `recheckDeadline<=0 && remaining>chunkCap && usageLimitError && options.isUsageLimitLifted`: rearm with jittered interval (mirror `xN(1+attempt, null, TQe/2, random, recheckMs)` using OCC's existing jitter helper), then `const unsub = options.subscribeRetryWake?.(()=>{woken=true}); try { lifted = await options.isUsageLimitLifted(usageLimitError) } finally { unsub?.() }`; break the wait on `lifted || woken`; credit elapsed poll time to the next sleep chunk (official `Ur`) and to `capacityWait.spentMs`/`usageLimitSpentMs`.
   - Add sleep-with-wake helper (official `Tmn`): races the chunk sleep against the `subscribeRetryWake` callback via a nested AbortController.
2. **`src/services/api/claude.ts`**: thread `subscribeRetryWake` / `isUsageLimitLifted` from query options into `withRetry` calls (mirror official @249490413). If OCC has no usage-limit-lift signal source yet, keep both optional — the loop is inert without them (identical to current behavior), which is safe and matches official optionality.
3. **Tests** (`src/services/api/__tests__/`, fake timers): (a) var unset → no polling, unchanged waits; (b) set + 429-rejected wait → `isUsageLimitLifted` polled at jittered intervals within `[recheckMs .. TQe/2 cap]`; (c) lifted→true breaks wait and retries without consuming a retry slot; (d) wake callback breaks wait; (e) poll time charged to `usageLimitSpentMs` and still bounded by `MAX_USAGE_LIMIT_WAIT_MS` (wait-too-long error still thrown); (f) non-digits value → warn-once, ignored; (g) non-429 waits never poll.

---

## Background agents status (flag for orchestrator)
Per your wrap-up I converged without waiting on them. **WP-C** (`aece20ea61b134687`, model-settings/startup) and **WP-E** (`a96aeb181950c25cc`, UI/consent/workflow) were still running at handoff; their transcripts persist at `/root/.claude/projects/-root-multica-workspaces-cnwenf2-864814a3-7dbe-4ab8-99a4-86d3eee1a414-156f5788-workdir/e245e56e-6c70-41a7-b9ae-337f4e1e53b7/subagents/agent-<id>.jsonl` (symlinked under `/tmp/multica-task-1666585335/.../tasks/`). They cover task #5 items (screen reader, MCP consent, workflow journal, /usage, MCP precedence) — orthogonal to the three verdicts above; nothing in this deliverable depends on them.

**Summary of verdicts: Item 1 PORT · Item 2 PORT (same `Jmn`/`defer_loading` gate, folded into Item 1; errors.ts/compaction untouched) · Item 3 PORT.** Working tree unmodified — research only, no files edited, binary never executed.