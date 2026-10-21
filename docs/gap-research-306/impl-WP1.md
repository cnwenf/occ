> **⚠️ SUPERSEDED (OCC-125 reconciliation, 2026-10-22):** the work described in
> this report was implemented in this round but **DROPPED before commit** — the
> parallel OCC-165 round landed its own version of the same upstream item on
> origin/main first, and per the collision precedent main wins every overlapping
> implementation. The file/test names below refer to the pre-reconciliation WIP
> commit `dc40f769`, NOT to the committed tree. See
> `docs/upstream-version-gap-occ125-2026-10.md` §1b for the mapping to main's
> P1–P10 items. "LANDED" statements below are historical to the WIP branch only.

# Impl WP1 — R2 API layer: tool-search refuse-recovery rewrite (CC 2.1.305/306) + retry-watchdog usage-limit recheck (CC 2.1.305)

Status: **LANDED** — research `docs/gap-research-306/research-R2-api-layer.md` Items 1/2 (Task A) and Item 3 (Task B). Scope kept to `src/services/api/**`, `src/utils/toolSearch.ts`, `src/utils/config.ts` (toolSearchRefusedAt key only), the two deleted 304 test files, and this report. No package.json / CHANGELOG / other-agent files touched.

---

## TASK A — tool-search refuse-recovery rewrite (official 2.1.305 shape, 2.1.306 gate)

Replaced OCC's v304-era mechanism (persisted 1-day `toolSearchRefusedAt` config window) with the official v305/v306 in-memory drop-scope design: a **conversation** scope and a **process-per-model** scope, both dropped on API refusal, plus the two fatal-400 detectors (named beta-refusal and unclaimed refusal) and the success-side heal with `tengu_beta_400_healed` telemetry.

### Files changed

| File | Change |
|------|--------|
| `src/utils/toolSearch.ts` | Removed persisted-window machinery; added in-memory `conversationRefusedBetas: Set<string>` + `processRefusedBetasByModel: Map<string, Set<string>>`; new exports `dropToolSearchBetaForConversation`, `dropToolSearchBetaForProcess(normalizedModel, header)`, `isToolSearchBetaRefused(model)`, `resetToolSearchRefusedForTesting`; refused-gate in `isToolSearchEnabled` (plain `logForDebugging` + modeDecision `'refused'` + `return false` — official `nkr` runs BEFORE the mode switch, so `ENABLE_TOOL_SEARCH=true` does NOT override a recorded refusal); `resetToolSearchDeclared` also clears the conversation set (official `w3n` @239179269 — `/clear` resets the conversation scope, the process latch survives); `modelSupportsToolReference` returns true after the pattern loop (v305); enablement broadened to ALL providers (official `nkr`; `ENABLE_TOOL_SEARCH` override kept) |
| `src/utils/config.ts` | Removed the `toolSearchRefusedAt?: Record<string, number>` config key + comment block (only that key) |
| `src/services/api/toolSearchRefusal.ts` | NEW — the refusal classifier module: `hasCapabilityRejectedMarker`, `firstLineOfApiErrorMessage`, `normalize422ToBadRequest` (GVe), `isUnexpectedBetaValuesError` (TQ→e5t collapse), `isBetaSpecificallyRefused`, `isConversationBindingError`, `isThinkingSignatureError`, `errorNamesToolSearchBeta`, `isFirstPartyProductionLike` (Jmn), `isPromptTooLongApiError`, `isMaxTokensContextOverflowApiError`, `isFastModeNotEnabledApiError`, `isContentFilteredApiError`, `isClaimedByAnotherRecovery`, `isUnclaimedToolSearchRefusalError` (Ese). File header documents every deviation + byte offset |
| `src/services/api/withRetry.ts` | Fatal-400 chain: NAMED detector hook (`retryToolSearchBetaRefused`) wired **after** `retryAdvisorEntryRefused` and **before** `retryContext1mBetaRefused` (binary order `…Hgt(cc);Rse(cc);let nS=jgt(cc);…??F6(cc)??N6(cc)` @249571500-249571820 sync / @249582654 stream); UNCLAIMED detector hook (`retryToolSearchRefused`) wired LAST with the v306 `(status===400||status===422)` gate; both `attempt--; continue` on heal |
| `src/services/api/claude.ts` | Handler block: `requestDeclaredToolSearchActive` (L6 mapping), `rebuildWithoutToolSearch` (EF warn verbatim, `level:'warn'`, v304 rebuild: undeferred tools inline, `useToolSearch=false`, betas filter, `critical_system_reminder` prepend), `retryToolSearchBetaRefused` / `retryToolSearchRefused` option implementations, `markToolSearchRefusedHealed` (one-shot `hLe`: named → conversation + process-per-model drops when TQ-specific + `bn` warn; unnamed → conversation drop + plain warn, NO level; `tengu_beta_400_healed {beta, model, provider, status, unnamed}`); wired on streaming, non-streaming interface, and passthrough paths; Bedrock tool-search attach exclusion unchanged |
| `src/utils/__tests__/toolSearchRefusedWindow304.test.ts` | DELETED (mechanism removed; harness preserved at `/tmp/tsr304.test.ts`) |
| `src/services/api/__tests__/toolSearchRefuseRecovery304.test.ts` | DELETED (superseded) |
| `src/services/api/__tests__/toolSearchRefuseRecovery306.test.ts` | NEW — 14 e2e/unit tests through the real `queryModelWithStreaming` HTTP layer (fetch-mocked), incl. a real AWS event-stream encoder for the Bedrock case |

### Binary evidence (v306, read-only `grep -aboF` + `dd`; absolute decimal byte offsets)

- `nkr` refused branch @ **249126550**: `t("Tool search is off for this conversation: the endpoint refused it earlier in this process."),q(!1,Q,"refused")` — plain `t()`, BEFORE the mode switch.
- `bn` (drop + warn) @ **249503710**: `let bn=(to,_r)=>{bg(dt,to);let jr="in this conversation";if(_r&&Vt!==void 0)o9o(Vt,to),jr+=`, or by new ones on ${Vt} in this process`;t(`[betas] the API refused ${to.header}; not sent again ${jr}`,{level:"warn"})}`.
- EF warn @ **249523903**: `[ToolSearch] HTTP ${to.status} ${jr}${_r?` (${_r.header})`:""}; sending the request again without deferred tools. ENABLE_TOOL_SEARCH=false avoids the refused request`; `throw new UZ(to,mo)` @ **249500797**.
- `Rse` (named detector) @ **249524246**; `N6` (unclaimed detector) @ **249524340**; `Ese` gate @ **249523776**: `L6(to)&&(!Jmn()||/\bdefer_loading\b/.test(to.message))&&(to.status===400||to.status===422)&&to.type!=="billing_error"&&!Fw(_r)&&!UF(_r)` (after GVe 422→400 normalization); `L6` @ **249523652**: `Xo!==void 0&&Xp===void 0&&to instanceof Ht&&!Q.resumeIncompleteThinking`.
- `hLe` success heal @ **249524459** (one-shot `Cse`; named → `bn(to,TQ(to,header))`; unnamed → `bg` + plain `t("[ToolSearch] the endpoint answered the request sent without tool search, so this conversation goes on without it")`; then `i("tengu_beta_400_healed",{beta,model,provider,status:to.status,unnamed:!jr})`).
- Chain call sites: sync @ **249571500-249571820**, stream @ **249582654** — `…Hgt(cc);Rse(cc);let nS=jgt(cc);…??F6(cc)??N6(cc)`; `jgt` IS context-1m @ **249560325**.
- Classifiers (`toolSearchRefusal.ts` counterparts): `nSe` @ **248309267**, `GVe` @ **248309415**, `iSe` @ **248312563**, `TQ` @ **248312664** (collapses to `e5t`), `e5t` @ **248312782**, `Mv`/`eOs`/`Nnn`, `MM`/`ch` @ **245259315-245259380**, `GB` @ **248317740**, `oM`/`_Eo` @ **248318719**/@ **245260463**, `zD`/`ORr` @ **248300377**/@ **245259680**, `BB`/`yEo` @ **248300481**/@ **245259792**, `nM`/`M4o` @ **248300638**, `TEe` @ **249465974**-region, `Omn`/`MQe` @ **249451075**; `Jmn` @ **249494785**: `xe()==="firstParty"&&ANTHROPIC_UNIX_SOCKET===void 0&&vf()&&!sH()` (`vf` @ **238694176**, `sH` @ **240979910**); `dt` controller @ **237564136**; latches `mEt`/`o9o` @ **237662196**; `iBe` @ **249125365**; `z_t` @ **240960142**; `w3n` @ **239179269**.

### Verbatim vs adapted strings

| String | Status |
|--------|--------|
| `Tool search is off for this conversation: the endpoint refused it earlier in this process.` | VERBATIM (nkr @249126550) |
| `` `[betas] the API refused ${header}; not sent again in this conversation` `` (+ `` `, or by new ones on ${model} in this process` `` when TQ-specific) | VERBATIM (bn @249503710), `level:'warn'` |
| `` `[ToolSearch] HTTP ${status} ${reason}${refusal?` (${header})`:''}; sending the request again without deferred tools. ENABLE_TOOL_SEARCH=false avoids the refused request` `` | VERBATIM prefix/suffix (EF @249523903); `level:'warn'`. ADAPTED: the official PO (production-only) suffix is omitted — OCC has no PO analog |
| `The API refused the tool search beta; this conversation continues without it.` — NOT used; unnamed success warn is VERBATIM: `[ToolSearch] the endpoint answered the request sent without tool search, so this conversation goes on without it` (hLe @249524459), plain (no level) |
| Refusal reasons `refusing the tool search beta (${header})` / `that no other recovery took, on a request that declared deferred tools (${header})` | ADAPTED into the EF `${jr}` slot exactly as the binary interpolates them (verified against binary warn texts) |
| Analytics `tengu_beta_400_healed {beta, model, provider, status, unnamed}` | VERBATIM keys/values (hLe @249524459) |

### Deviations from official (justified)

1. **Chain position correction vs the research doc** — `research-R2-api-layer.md` labels the named hook as mid-chain AFTER context-1m. The binary says otherwise: `Rse(cc)` runs BEFORE `jgt` (context-1m) in both sync (@249571500-249571820) and stream (@249582654) call sites. **Followed the binary** (skill rule: binary is source of truth).
2. **`held_off` mode not implementable** — the official `q(!1,…,"held_off")` decision path depends on server-side hold state OCC has no surface for; documented, not invented.
3. **`Jmn` (first-party-production-like) approximation** — official `!sH()` leg (sH @240979910 = OAuth-session check) is approximated by `getAnthropicApiKey() !== null`; documented in `toolSearchRefusal.ts` header.
4. **`TQ` collapse** — official `TQ` (@248312664) collapses to `e5t` for the header-matching OCC needs; single function `isBetaSpecificallyRefused`, documented.
5. **422 normalization** — GVe ported as `normalize422ToBadRequest` producing `new APIError(400, error.error, message.replace(/^422 /,''), headers)`; original status preserved for the `tengu_beta_400_healed.status` field (test d′ pins healed `status: 422`).
6. **Process-latch key** — official latches per model string `Vt`; OCC normalizes via `normalizeModelStringForAPI(model)` (same canonicalization the API request path uses) so `[1m]`-suffixed and bare aliases share the latch.

### Task A tests — `toolSearchRefuseRecovery306.test.ts` (14/14 pass, 115 expect)

Through the real streaming client with a mocked fetch: (a) named TQ 400 at a gateway → 2 sends, retry without the 1P beta, undeferred MCP tools inline + `critical_system_reminder`, EF warn verbatim, healed `{beta,model,status:400,unnamed:false}`, conversation + process latches, bn warn with the process clause; named-loose (Mv-only) variant → conversation drop only, bn warn WITHOUT the process clause, cleared by `resetToolSearchDeclared`. (b) first-party-prod + `defer_loading` in the message → unnamed heal: EF warn `that no other recovery took…`, plain-level success warn, healed `{unnamed:true}`, no process latch. (c) first-party-prod WITHOUT `defer_loading` → 1 send, error surfaces, healed 0 (Ese gate). (d) gateway without `defer_loading` → retry (broadened all-provider scope). (d′) 422 → normalized, healed status 422. (d″) Vertex unit-level classifier checks. (e) Bedrock e2e with a real `application/vnd.amazon.eventstream` response (CRC32-framed, base64 PayloadPart-wrapped Anthropic events) → success, no tool-search beta on any Bedrock request. (f) `tool_addition`-shaped message classifier matrix. (g) `billing_error` excluded → 1 send. (h) two error400s → exactly 2 sends, healed 0, no refusal recorded (the error was not tool-search-related). (i) conversation scope persists across queries in the same conversation (3rd send: no beta, inline tools, modeDecision `refused`); process latch: same-model query omits the beta after `resetToolSearchDeclared`, OTHER-model query still sends it; `ENABLE_TOOL_SEARCH=true` does NOT override a recorded refusal (nkr gate precedes the switch).

---

## TASK B — `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` (official 2.1.305)

While an unattended (watchdog) session waits out a usage-limit rejection (429 + `anthropic-ratelimit-unified-status: rejected`), the chunked wait now periodically rechecks whether the limit has lifted and retries EARLY when it has — instead of blindly sleeping to the unified-reset timestamp.

### Files changed

| File | Change |
|------|--------|
| `src/services/api/withRetry.ts` | `RetryOptions` += `isUsageLimitLifted?: (error: APIError) => Promise<boolean>` + `subscribeRetryWake?: (onWake: () => void) => () => void` (both STAGED — no production caller yet, feature inert until the query-engine producer wires them, same staging pattern as `modelCallRetries`); generator-scope `usageLimitRecheckCount`/`usageLimitLifted` (official `Q`/`Se`); chunked-wait rewrite: recheck arming (`fs`), loop-top countdown rearm `getRetryDelay(1+usageLimitRecheckCount, null, PERSISTENT_RESET_CAP_MS/2, recheckMs)` (official `Lo=xN(1+Q,null,TQe/2,r.random,fs)`), poll-credit chunk shortening (`Ur`), wake-aware ledger accounting (`ji=Qs?Math.min(sr,Vs+elapsed):sr`), wake break, poll gate `countdown<=0 && remaining>HEARTBEAT_INTERVAL_MS && usageLimitWait && isUsageLimitLifted` with wake subscription around the poll and `usageLimitLifted`/`pollCreditMs` update; tail `if (persistent \|\| waitBrokeEarly) attempt--`; NEW `sleepWithWake` helper (complete `Tmn` port); NEW `getRetryWatchdogUsageLimitRecheckMs` getter (digits-only, [60000, 10800000], warn-once + `resetIgnoredRetryWatchdogUsageLimitRecheckWarnedForTesting`) |
| `src/services/api/__tests__/retryWatchdogUsageLimitRecheck305.test.ts` | NEW — 26 tests covering spec items (a)-(g) |

### Binary evidence (v306 @249461100-249466200, byte-verified verbatim)

- Preamble @ **249461100**: `let Jr=xQe(on),ns,Vo=Ro,ps=null;if(Ro){…q++;let sr=null;if(on instanceof Ht&&on.status===429){if(sr=Kfr(on,h),sr!==null&&on.headers?.get?.("anthropic-ratelimit-unified-status")==="rejected"){…` (`Ro` ≡ watchdogRetryable, `ps` ≡ the usage-limit error, `K` ≡ capacityWait).
- Arming @ **249463829** region: `fs=ps&&r.isUsageLimitLifted?a.CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS:void 0;if(ps&&Se)Q++,Se=!1;let Lo=fs===void 0?1/0:0,Ur=0,us=ns`.
- Loop @ **249464200** region: `while(us>0){if(fs!==void 0&&Lo<=0)Lo=xN(1+Q,null,TQe/2,r.random,fs);if(Vo&&r.signal?.aborted)throw new yu;…let sr=Math.min(us,Gr),Vs=Math.min(sr,Ur);Ur=0;let Rs=h.monotonicNow(),Qs=await Tmn(sr-Vs,r);if(Ro){let ji=Qs?Math.min(sr,Vs+Math.round(h.monotonicNow()-Rs)):sr;if(K.spentMs+=ji,ps)K.usageLimitSpentMs+=ji}if(Qs)break;if(us-=sr,Lo-=sr,Lo<=0&&us>Gr&&ps&&r.isUsageLimitLifted){let ji=!1,Ga=r.subscribeRetryWake?.(()=>{ji=!0}),Fa=h.monotonicNow(),cs=!1;try{cs=await r.isUsageLimitLifted(ps)}catch(jo){l(jo)}finally{Ga?.()}if(Se=cs,cs||ji)break;Ur=Math.max(0,Math.round(h.monotonicNow()-Fa))}}if(Ro||kr)dn--`.
- `Tmn` @ **249465974** (complete — quoted verbatim in the `sleepWithWake` comment block in withRetry.ts).
- `Gr=Vo?M_o:ns` (`M_o`=30000 ≡ HEARTBEAT_INTERVAL_MS); `TQe`=21600000 @ **249448981** ≡ PERSISTENT_RESET_CAP_MS.
- Env descriptor @ **238022067**: `cx=H.int({min:60000,max:10800000,digitsOnly:!0})`; var-name string @ **249463885**.
- `xN` @ **240347909** = jittered exp backoff (0.25 proportional jitter) ≡ OCC `getRetryDelay`.
- Sync options preamble threads `subscribeRetryWake:Q.subscribeRetryWake,…,isUsageLimitLifted:$F`.

### Deviations from official (justified)

1. **`Date.now()` instead of `h.monotonicNow()` / injected clock** — withRetry has no clock-injection surface (pre-existing shape); poll credit and woken-chunk accounting use wall time. Documented at both sites.
2. **`getRetryDelay` has no `random` param** — official `xN(…,r.random,…)`; OCC's port uses internal `Math.random` (pre-existing signature). Tests stub `Math.random` for determinism.
3. **Warn-once on invalid env values** — the official env registry validates silently; OCC follows its established `dataflow-007` convention (same as the two `MAX_*_WAIT_MS` getters): digits-only fail-open UNCHANGED, but a non-empty unhonorable value warns once per distinct value via `logForDebugging(…, {level:'warn'})`.
4. **Attempt-refund tail** — official `if(Ro||kr)dn--` refunds the attempt for EVERY watchdog-capacity wait; OCC's pre-existing 281 shape refunds only persistent waits (pinned by withRetryIntegration286 / retryWatchdogUsageLimit301). Minimal deviation: refund added for the early-break paths only (`persistent || waitBrokeEarly`) — exactly where the official's lift/wake "retry without consuming a slot" semantics live — leaving full-duration watchdog waits on OCC's established, test-pinned accounting.
5. **`ps` (error object) vs `usageLimitWait` (boolean)** — OCC keeps the existing per-attempt boolean and passes `error` at poll time; safe by construction because the boolean is only set when `error` is that 429 `APIError` (the official `ps=on` / v301 `Vr=cn` site).
6. **`onRetryStatus`/`qr`/`St` machinery** (official retry-status callbacks around the loop) — no OCC surface, N/A.
7. **Recheck confined to the chunked (heartbeat) wait** — official's `Gr=Vo?M_o:ns` also runs single-chunk non-watchdog waits through the same loop, but the poll gate `us>Gr` can never fire there; OCC's non-heartbeat `else` branch keeps its plain `sleep`. Behaviorally equivalent.

### Task B tests — `retryWatchdogUsageLimitRecheck305.test.ts` (26/26 pass, 126 expect)

Spec mapping: **(a)** RECHECK unset → 200000ms fetch_error wait chunks `[30000×6, 20000]` unchanged, `isUsageLimitLifted` wired but never called; getter unit: unset → undefined, no warn. **(b)** RECHECK=60000, `Math.random` stubbed 0 → polls exactly at 60000 and 120000 slept (jitter window `[fs, 1.25·fs]`, `us>Gr` gate skips the final 20000ms stretch); random≈1 → first poll moves to the 90000 boundary, asserted within `[recheckMs, 1.25·recheckMs + chunk]`; poll receives the 429-rejected error itself (official `r.isUsageLimitLifted(ps)`); max boundary === TQe/2 pinned. **(c)** lifted at poll 1 breaks a 400000ms wait after 2 chunks; the NEXT wait polls only after 4 chunks (`if(ps&&Se)Q++` → `xN(2,…)` backs the base off to 120000); lifted break refunds the attempt — a following NON-watchdog 500 still fits in `maxRetries=1` (3 op calls, success); a throwing poll is logged, treated as not-lifted, wait runs the full schedule. **(d)** wake fired during the first chunk abandons a 200000ms wait after 1 chunk (subscribe + unsubscribe counted); wake fired DURING a poll breaks even when the poll answers false (`cs||ji`), and `Se=false` skips the `Q++` backoff (next wait polls again at 60000); pre-aborted signal → `APIUserAbortError`, zero sleeps. **(e)** a ~30ms real-time poll shortens the next chunk below 30000 (Ur credit) while chunks still charge IN FULL to `usageLimitSpentMs` — the following rejected 429 sees `hr=0` and throws `api_request_usage_limit_wait_too_long` (MAX_USAGE_LIMIT_WAIT bound holds). **(f)** getter: boundary values 60000/10800000 honored; `5s`/`60,000`/`60_000`/`1e5`/`60000.5`/`59999`/`10800001`/`0`/`-60000` → undefined + exactly one warning each (warn-once per distinct value); empty string silent; reset-for-testing re-warns. **(g)** 529-overloaded 200000ms wait and plain 429 (no unified-status) → full unchanged chunk schedules, zero polls (wake subscription still wraps every chunk — 7 subscribes on the 529 case — but never fires).

---

## Verification results

| Suite | Result |
|-------|--------|
| `toolSearchRefuseRecovery306.test.ts` (NEW) | **14 pass / 0 fail** (115 expect) |
| `retryWatchdogUsageLimitRecheck305.test.ts` (NEW) | **26 pass / 0 fail** (126 expect) |
| Both new files together | 40 pass / 0 fail (241 expect) |
| Existing regression battery (11 files): `contextManagementBetaHeal304`, `withRetryIntegration286`, `fastModeWatchdogRetry271`, `nonstreamingTimeoutRetries285`, `nonstreamingCapProduction288`, `nonstreamingCutShort299`, `overloadedRetryMaxDelay296`, `overloadedRetryBaseDelay292`, `retryWatchdog295Review`, `retryWatchdogRetryAfter281`, `retryWatchdogUsageLimit301` | **150 pass / 0 fail** (1627 expect) |
| toolSearch suites (toolSearch.ts changed): `toolSearchAutoHold300`, `toolSearchDeclaredLatch300`, `toolSearchHoldWiring300` | **16 pass / 0 fail** (59 expect) |
| `bunx biome lint` on all 7 touched files | **0 errors** (3 pre-existing suppression-comment warnings in `claude.ts` @1277/@3263-region — not this WP's lines) |

Total: **206 pass / 0 fail** across 16 files. No git commit made (per task rules). Repo-wide `bun test src` deliberately NOT run (order-polluted baseline, per task rules).

## Not landed / staged (for the ledger)

- `isUsageLimitLifted` / `subscribeRetryWake` have **no production caller** — the official producer is the query-engine dispatch (`isUsageLimitLifted:$F`, `subscribeRetryWake` threading); until wired, Task B is inert in production (env var alone changes nothing), mirroring OCC's established staging pattern (`modelCallRetries`, `failedStreamOutlastedTimeout`).
- Tool-search `held_off` mode — no OCC surface (see Task A deviation 2).
- EF warn's PO (production-only) suffix — no OCC analog.
