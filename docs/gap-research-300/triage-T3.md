# Triage T3 — OCC round 2026-10-16 (official Claude Code 2.1.299 → 2.1.300)

Cluster **T3**, 14 entries: 10, 18, 19, 22, 23, 36, 37, 38, 40, 42, 46, 55, 59, 62.

Evidence conventions: `v299@<off>` / `v300@<off>` = byte offset into `package/claude` ELF, read with bounded `dd` (binaries never executed). `new@<off>` = offset into `new_strings.txt`. `299:N→300:M` = `grep -c` on the sorted-unique `strings -n 8` sets. OCC file:line evidence gathered via three read-only Explore subagents (A: resume/compaction/tool-search/MCP-schema; B: auth/gzip/growthbook/managedEnv; C: transcript-writer/branch/purge/autocompact).

Disposition tally: **PORT 7** (10, 18, 19, 22, 36, 55, 59) · **STAGED 5** (37, 40, 42, 46, 62) · **ALREADY-ALIGNED 2** (23, 38) · **N-A 0**.

---

## 10 — PORT: `/autocompact` high-token-usage warning fires when choosing a *smaller* window

**Official delta.** Warning text is byte-identical in both versions (`Overriding auto may result in high token usage, especially when resuming long sessions.`). The gate around it changed:

- v299@237780760: `if(dTt(t))e.push("Overriding auto may result in high token usage…")` — warns on *any* override.
- v300@239117077: `if(cCt(u)&&TAn(r,s))a.push(…)` — a **new** helper gates the warning:
  ```
  function TAn(e,o){return Math.min(e.contextWindow,o)>Hno(e).window}
  ```
  i.e. warn only when the chosen (capped) window **exceeds** the auto window `Hno(e)`. Choosing a *smaller* window no longer trips the warning.
- Telemetry additions (v300-only): `window_model`, `previous_tokens`, `previous_origin`, `resulting_tokens`, `overridden`, `route`. `previous_origin` 299:0→300:2; `resulting_tokens` 299:0→300:2.

**OCC evidence (Agent C).** The bug is present verbatim: `src/utils/autocompact-noninteractive.ts:99-103` — `if (source === 'env' || source === 'settings')` unconditionally pushes the "Overriding auto may result in high token usage…" string with **no** smaller-vs-larger comparison. Window resolution is already ported: `src/utils/autoCompactWindow.ts:153` / `:248`; consumed at `src/main.tsx:4322`. The interactive `/autocompact` just opens the Config tab (`src/commands/autocompact.tsx:15`, `src/components/Config.tsx:269`), so the non-interactive path is the one that warns. Token-warning render path is separate and correct (`src/components/TokenWarning.tsx:169`, `src/utils/autoCompact.ts:128` / `:50`).

**Sketch:**
1. In `autocompact-noninteractive.ts`, add a helper mirroring `TAn`: given the resolved chosen window (`min(contextWindow, chosenWindow)`) and the auto window (`autoCompactWindow.ts` resolver), return `true` only when `chosen > auto`.
2. Gate the warning push at `:99-103` behind that helper (keep the existing `source === 'env' || 'settings'` condition, add `&& chosenWindowExceedsAuto`).
3. Do not change the TokenWarning UI path — it is unaffected.
4. **Test idea:** e2e — set `autoCompactWindow` smaller than the model default via settings, run a non-interactive turn, assert the high-token warning is *absent*; set it larger, assert the warning *is* present. Unit-test the helper at the `min(contextWindow, chosen) > auto.window` boundary.

---

## 18 — PORT: auto tool search (`ENABLE_TOOL_SEARCH=auto`) turns off mid-conversation (e.g. MCP reconnect after resume)

**Official delta.** The mode-parse module is identical modulo minified renames (v299 `MSe`/`gy` = v300 `$we`/`Ty`; regions v299@219839087-1500 / v300@220981917-1500). The change is in the threshold-decision fn:

- v299: `async function scr(e,n,r,s,h,y)`
- v300: `async function Lfr(e,n,r,s,h,y,S=!1)` — a new 7th param `S`. In `case"tst-auto"` (v300@227142599):
  ```
  if(S)return t("Auto tool search enabled: this conversation already declared ToolSearch"),
         H(!0,V,"auto_held"),!0;
  ```
  placed **before** the `Blr(...)` threshold re-check. `auto_held` 299:0→300:2 (string + telemetry reason).
- Caller (query pipeline) v300@227824350: `Kt=!w$(Q.querySource)&&await Lfr(qt,s,Q.getToolPermissionContext,Q.agents,"query",Q.credentials,Q.recordedToolDescriptions?.has(Ci))` — the hold flag `S` = "this conversation's recorded tool descriptions already contain ToolSearch (`Ci`)". Once held, later threshold recomputes (e.g. after MCP servers reconnect and the tool count momentarily drops) cannot flip auto back off. Compact-path caller v300@227627826 passes only 6 args (no hold). Telemetry event `tengu_tool_search_mode_decision` carries the `reason`.

**OCC evidence (Agent A).** Mode parse exists: `src/utils/toolSearch.ts:172-198`; per-request auto threshold: `:460-483` → `checkAutoThreshold` `:728-772`. But there is **no hold latch** — the name memo at `:124-151` is per-request only. Decision site `src/services/api/claude.ts:1788-1796`; the existing `hasPendingMcpServers` guard `:1806-1818` covers the *pending* case but does **not** cover a below-threshold flip once MCP servers have reconnected and the count recomputes low. Discovered-tool filter `:1824-1837`; `extractDiscoveredToolNames` `toolSearch.ts:561-608` (boundary carry `:569-575`); compact carries `preCompactDiscoveredTools` `compact.ts:653-660` / `:1102-1104`.

**Sketch:**
1. Add a per-conversation "auto held" latch. The conversation already records discovered tool descriptions (`extractDiscoveredToolNames`); when that set contains the ToolSearch tool name, set `autoHeld = true` on the query context.
2. Thread a `heldAlready` boolean into the auto-threshold decision (`toolSearch.ts:728-772` / `claude.ts:1788-1796`): if `mode === 'auto' && heldAlready`, return enabled immediately with reason `auto_held`, skipping the threshold recompute — mirroring `Lfr`'s early return.
3. Keep the compact path passing `false` (no hold) to match the official 6-arg compact caller.
4. **Test idea:** e2e — start a session with `ENABLE_TOOL_SEARCH=auto`, drive tool count above threshold so ToolSearch is declared, then simulate an MCP reconnect that drops the visible tool count below threshold mid-conversation; assert auto stays ON (`auto_held`) and does not flip off. Unit-test the decision fn's early-return branch.

---

## 19 — PORT: `forceLoginOrgUUID`-refused login leaves the refused org's token stored / live after `/login`

**Official delta.** Root cause is persist-then-validate ordering; v300 reorders to validate-then-persist and adds credential-snapshot restore.

- v299 CLI refresh-token login @241266854: `let o=await vwe(v,{scopes:s,…}); await _ze(o,{storageV5:h,credentials:a}); let p=await oU(a); if(!p.valid)await H(p);` — token **persisted** (`_ze`) before the org-pin validity check → a refused token stays stored.
- v300 @242589299: snapshot prior creds `let a=Ju()`, obtain token `p=await bee(E,{…})`, **validate first** `let h=await O1e(p)`; on `h.outcome==="refused"`: restore snapshot `if(a)await ECo(a,m)` and throw with an appended message (`The refresh token in CLAUDE_CODE_OAUTH_REFRESH_TOKEN was used for this attempt and cannot be used again; issue a new one to retry.`); only on success persist `await FGe(p,{…})`. Browser path @242590718 has the same order.
- `ConsoleOAuthFlow` @242199737: `let W=await O1e(fe); if(W.outcome==="refused")throw new x(W.rejection.message,"ConsoleOAuthFlow: org pin refused the new token")` (string v300-only @102679790). SDK @252217567: validate → `throw Qt=!0,m("sdk_claude_authenticate","org_pin_refused"),new Mr(XM)` before `FGe`; also `mre({clearOnboarding:!1,preserveNonAnthropicAuth:!0,…})` on invalid.
- New validators @219127148-219130254: `ZE(r)`→kinds `host_managed|unix_socket|auth_disabled|no_pin|empty_pin|required{requiredOrgUuids}`; `tOr(scopes)`→`{outcome:not_checked|refused|required}`; `O1e(e)`→ `refused{valid:!1,reason:"org_pin_mismatch"|"org_verify_failed"|"managed_settings_invalid"}` or `permitted{verified:{accessToken,organizationUuid}}`; secondary validator receives the verified org via `MU(c, h.outcome==="permitted"?h.verified:void 0)`.
- Counts: `requiredOrgUuids` 299:0→300:7; `org_pin_mismatch` 299:6→300:9.

**OCC evidence (Agent B).** Same bug shape: `src/utils/auth.ts:2577` `validateForceOrgUUID` (also `:2647`, `:2684`) does **no clearing** of a refused token; `saveOAuthTokensIfNeeded` `auth.ts:1443-1459` persists **unconditionally** (before/independent of the org-pin verdict); `installOAuthTokens` `src/cli/handlers/auth.ts:153`/`:157`/`:184`. Bug site: `auth.ts:361` → `:298-304` runs install → validate → `exit(1)` (token already installed). Interactive: `ConsoleOAuthFlow.tsx:307`/`:349`; `main.tsx:2758` + `interactiveHelpers.tsx:52`.

**Sketch:**
1. Reorder `saveOAuthTokensIfNeeded` (`auth.ts:1443-1459`) so it persists **only after** `validateForceOrgUUID` returns permitted. Introduce an outcome-typed validator (`{outcome:'refused'|'permitted'|'not_checked', verified?}`) mirroring `O1e`.
2. Snapshot prior credentials before the login attempt (analog of `Ju()`); on `refused`, restore the snapshot (analog of `ECo`) so the refused org's token is neither stored nor left live, then surface the rejection message + the "cannot be used again; issue a new one" note.
3. Apply the same validate-then-persist order to all three paths: CLI refresh-token (`auth.ts:361`/`:298-304`), interactive `ConsoleOAuthFlow.tsx:307`/`:349`, and SDK authenticate.
4. **Test idea:** e2e — set `forceLoginOrgUUID` to an org that the issued token does not match; run `/login`; assert (a) login is refused with `org_pin_mismatch`, (b) the credential store does **not** contain the refused org's token afterward, (c) a previously-valid credential is restored, and (d) the refresh-token error text mentions issuing a new token.

---

## 22 — PORT: first transcript entry after resume lost when a crash cut the transcript's last line short

**Official delta.** `reAppendSessionMetadata` gained a 4th param that seals a torn tail before the next append:

- v299@223633467: `reAppendSessionMetadata(e,n,r)` — 3 params, blind re-append.
- v300@224821077: 4-param; body adds:
  ```
  let h=gdo(this.sessionFile);
  if(s&&h!==""&&!h.endsWith("\n"))this.sealTornTailOnNextAppend(this.sessionFile)
  ```
  i.e. when the 4th arg `s` is set, the file is non-empty, and its last byte is not `\n` (torn tail from a crash), schedule a seal so the next append starts on a fresh line instead of concatenating onto the truncated fragment (which the JSONL reader would then drop, taking the new entry with it).
- 4-arg caller (new@41699708): `reAppendSessionMetadataAsync(!0,!1,r,z()&&r!==void 0)`. `sealTornTailSync` and the prepend-if-pending machinery exist in **both** versions — the fix is the new call site + the `endsWith("\n")` guard, not new primitives.

**OCC evidence (Agent C).** Torn-tail repair is **absent**: appends are blind — `src/utils/sessionStorage.ts:846` (`appendToFile` via `fsAppendFile` `'a'` flag at `:120`) and `:3334` (`appendEntryToFile`); line built at `:877`/`:3335`. `adoptResumedSessionFile` `:1842` calls `reAppendSessionMetadata(true)` which appends directly onto the (possibly torn) fragment. Reader `src/utils/json.ts:182` `parseJSONL` silently skips malformed lines (`:146-150`) → the concatenated line is dropped, losing the first post-resume entry. Resume read side is otherwise tolerant (`sessionStorage.ts:4234`, `:4314`, `:3975-3983` "Final incomplete line", `:4395`, `:4413`).

**Sketch:**
1. Add a `gdo`-equivalent helper that reads the last byte of the session file (cheap: `fs.statSync` + a 1-byte `read`, or read the tail buffer).
2. In `adoptResumedSessionFile` (`sessionStorage.ts:1842`) before the `reAppendSessionMetadata(true)` re-append, check: if the file is non-empty and its last byte is not `\n`, write a single `\n` to seal the torn tail (or set a "seal on next append" flag consumed by `appendToFile`/`appendEntryToFile` at `:846`/`:3334`).
3. Prefer sealing eagerly at adopt time so both blind-append paths are protected.
4. **Test idea:** e2e — write a transcript file whose last line is truncated (no trailing `\n`, invalid JSON), resume the session, emit one new entry, then re-read: assert the new entry is present as its own parseable line and the torn fragment was not concatenated with it. Unit-test the "last byte is `\n`?" guard.

---

## 23 — ALREADY-ALIGNED: `/branch` dropping messages / `purge` skipping subfolder projects on U+2028/U+2029

**Official delta is logic-only (no new string surface).** The `[\u2028\u2029\u0085]` escaper is present **identically in both versions**: v299@224888072 `var HOo=/[\u2028\u2029\u0085]/g; function LF(e){return e.replace(HOo,(n)=>"\\u"+…padStart(4,"0"))}` = v300@226081074 `var JUo=/[\u2028\u2029\u0085]/g; function l$(e){…}`. Regex `[\u2028\u2029\u0085]` count: **299:8 → 300:8** (offsets enumerated). Escaped-text `\u2028` total in ELF: **242 = 242**. Meta-writer serializer is unchanged modulo rename (v299 `hGe`/`Gpt`/`Cx` = v300 `oqe`/`Tht`/`Qx`; call sites v299@224930877 = v300@226123961, same `repoVisibility`/`gitStatus` push). `/branch` 299:13→300:13, `Branched` 299:3→300:3, `forkedFrom` 299:5→300:5, `leafUuid` 299:11→300:11, `purge` 299:68→300:68, `Purged` 299:6→300:6 — all balanced. The fix is therefore inside existing branch-copy / purge-scan logic (making them treat raw U+2028/2029 as ordinary bytes), not a new serializer.

**OCC evidence (Agent C).** OCC is **structurally immune** on both surfaces:
- `/branch`: `src/commands/branch.ts:129` / `:139` parse via `parseJSONL` which splits on the byte `\n` only; `:193` / `:212` re-emit with `lines.join('\n')+'\n'` through raw `JSON.stringify` (`src/utils/slowOperations.ts:187`). Bun's `JSONL.parseChunk` tolerates raw U+2028/U+2029 inside a line (empirically verified). So a message containing U+2028/2029 is neither split nor dropped. `ndjsonSafeStringify` (`src/cli/ndjsonSafeStringify.ts:30`, escapes `\u2028|\u2029`) exists but is wired only to stdout transports (`remoteIO.ts:239`, `structuredIO.ts:487`) — not needed for the file branch path since byte-`\n` splitting is already safe.
- `purge`: `src/utils/projectPurge.ts:71`/`:95`/`:104`/`:131` operate directory-based via `fs.rm` recursive — no per-line parse, so no subfolder project can be "skipped" due to a separator char. Precedent: `docs/upstream-version-gap-occ113-2026-10.md:105` marked the analogous purge entry N-A on the same directory-based reasoning.

**Conclusion.** OCC already behaves like the fixed official on both named surfaces; no change warranted. (Recorded as ALREADY-ALIGNED rather than N-A because OCC genuinely has both `/branch` and `purge`, and the file:line proof shows the safe behavior.)

---

## 36 — PORT: conversation 400s every turn when the API rejects an MCP tool's input schema

**Official delta (new@2929387-2930900).** A 400-classifier + per-tool schema suppression loop:
- `lFo=8` cap; `U1t={type:"object"}` replacement schema; `W1t` performs the schema replacement.
- `AGe.resolve` classifies the 400 with `/\btools\.(\d+)\.(?:custom\.)?input_schema\b/` to find the offending tool index.
- Gated by `tengu_calm_crescent`; offending tools tracked in a `refusedToolSchemas` Map; MCP gate `Kg` @9415577 `e.name?.startsWith("mcp__")||e.isMcp===!0`.
- Retry token `retry:tool-schema-refused-N`; on refusal the tool is re-sent **without parameters** (empty `{type:"object"}` schema) for the rest of the conversation, plus an MCP server note explaining the tool was sent schema-less.

**OCC evidence (Agent A).** No schema-400 handling: `src/services/mcp/client.ts:2630` passes the MCP tool schema through raw; API layer `src/services/api/api.ts:119`/`:183-204`/`:243-252`; `src/services/api/withRetry.ts:302-345` has three heal hooks (`stripMediaBlock`, `retryAdvisorEntryRefused`, `retryContext1mBetaRefused`) but **no** input_schema classifier; `src/utils/errorUtils.ts:405` only matches the advisor `tools\.\d+\.model` pattern. Hook site confirmed: `claude.ts:1623` `queryModel`, `:1637` `filterMcpToolsForApi`, `:1905-1916` `toolSchemas`, `:2059-2073` `let allTools`, `paramsFromContext` `:2350`→`tools` `:2543`; `setTools` mutation precedent `:2676-2691`.

**Sketch:**
1. Add a 400-classifier in `errorUtils.ts` matching `/\btools\.(\d+)\.(?:custom\.)?input_schema\b/` → extract the tool index.
2. Add a 4th heal hook in `withRetry.ts:302-345`: on input_schema 400, mark the offending tool (by index → name) in a per-conversation `refusedToolSchemas` set, then retry with token `retry:tool-schema-refused-N`.
3. In the tool-schema build path (`claude.ts:1905-1916` / `filterMcpToolsForApi:1637`), for any MCP tool (`name.startsWith('mcp__')||isMcp`) in the refused set, substitute `{type:'object'}` (send without parameters) for the rest of the conversation; cap the number of schema-less substitutions (mirror `lFo=8`) and attach an MCP server note.
4. **Test idea:** e2e — register an MCP tool whose input schema the API rejects (e.g. an unsupported `$ref`/keyword); assert the first turn 400s, the hook fires, the conversation continues (no per-turn 400 loop), and the tool is subsequently sent with an empty object schema + the note appears.

---

## 37 — STAGED: headless/SDK resume loses compaction-kept messages when compaction followed a reply cut at the output-token limit

**Official delta is logic-only.** All boundary markers are balanced 1:1 (299→300): `runningTurnSends`, `keptRowsNotLoaded`, `compactAwaitingSummary` 4:4, `sessionLastBoundaryUuid` 4:4, `preservedMessages` 24:24, `atis-latch` 8:8, `cutOffTurn` 6:6, `lastReplyStopReason`, `tailRows`, `callsWithoutResult`, `rateLimitRowSteppedOver`, `applyEndedByModelOnResume` 2:2. `applyEndedByModelOnResume` is byte-identical across versions (v299 `E3t`@223713994 = v300 `F9t`@224900702). The `ended_turn_copy` region (new@1958192-1965000) is `a.CLAUDE_CODE_REMOTE`-gated cloud machinery present in **both** versions (`sv` reads the last compact boundary's `compactMetadata.runningTurnSends{uuids,summarisedOnly,openerUuid}`; stop-set `oO=[reply,reply_then_reminder,stop_marker,terminal_api_error,terminal_tool_result,deliberate_stop_result,max_turns]`) — not the fix. The changelog scopes it to "compactions from this version on," implying a resume-side interpretation change not recoverable from balanced strings.

**OCC evidence (Agent A).** Headless resume+compaction is PARTIAL: `loadConversationForResume` (`src/utils/conversationRecovery.ts:1024`, called `src/cli/print.ts:5242-5247`/`:5367-5416`); trailing unresolved `tool_use` trim `:274-291`; trailing assistant treated as complete `:444-451` (**no** `max_tokens`/output-limit detection); boundary relink `parentUuid:null`+`logicalParentUuid` `src/utils/sessionStorage.ts:1262-1277`; `applyPreservedSegmentRelinks` `:2162-2263` (invoked `:4526`); **leaf selection is timestamp-only** (`findLatestMessage` `:2369-2384` at `:3079-3088`/`:3750-3761`, `leafUuids` `:4550-4608`); `SKIP_PRECOMPACT_THRESHOLD` 5MB `sessionStoragePortable.ts:678`.

**Why STAGED, not PORT.** The official fix is logic-only (no new strings to anchor an exact behavior), and OCC's leaf-selection is timestamp-only with no output-token-limit awareness — a faithful port needs deeper resume-path forensics + a runtime reproduction. **Next-round probe:** reproduce a headless session that (a) replies cut at the output-token limit, (b) compacts, (c) resumes; capture whether OCC's `findLatestMessage` timestamp leaf drops the compaction-kept tail. Then locate the official resume-side change by diffing the `preservedMessages`/`tailRows` consumers around the compact-boundary read (offsets balanced, so trace the call graph rather than the strings). Check whether OCC needs a `lastReplyStopReason==='max_tokens'` signal preserved across the boundary.

---

## 38 — ALREADY-ALIGNED: Claude not told about an MCP server's tools/instructions until next tool call when the server connects after a compaction

**Official delta is logic-only.** All markers balanced: `mcp_instructions_delta` 299:12→300:12, `WaitForMcpServers` 299:6→300:6 (description string @4166830). No new instruction-announcement surface → the fix reorders/re-triggers existing logic.

**OCC evidence (Agent A).** OCC already re-announces after compaction: `src/services/mcp/mcpInstructionsDelta.ts:56-111` computes a **stateless per-turn** diff of MCP instructions; attachments `src/utils/attachments.ts:1020-1029`/`:1721-1747`; prompts fallback `src/utils/prompts.ts:506-516`; and crucially `src/utils/compact.ts:613-635` performs an **explicit post-compaction re-announce** of MCP tools/instructions (plus partial at `:1034-1054`). Client `src/services/mcp/client.ts:436-447`/`:1855`/`:2295`; query hook `src/services/api/claude.ts:855-858`. Because the diff is stateless per turn and compaction force-re-announces, a server that finished connecting after a compaction is surfaced on the next turn without waiting for a tool call.

**Conclusion.** OCC behaves like the fixed official (per-turn stateless delta + explicit post-compaction re-announce). Binary evidence (balanced markers = logic-only official change) + OCC file:line proof above. No change warranted.

---

## 40 — STAGED: headless/SDK resume loses compaction summary or restores pre-compaction history when compaction followed a retried/unfinished reply in the same turn

**Official delta is logic-only.** Same balanced marker set as entry 37 (`compactAwaitingSummary` 4:4, `sessionLastBoundaryUuid` 4:4, `preservedMessages` 24:24, `cutOffTurn` 6:6, `callsWithoutResult`, `rateLimitRowSteppedOver`, `applyEndedByModelOnResume` 2:2 identical). The retried/unfinished-reply case turns on turn-boundary bookkeeping that produces no new strings.

**OCC evidence (Agent A).** Same resume path as entry 37: `loadConversationForResume` (`conversationRecovery.ts:1024`); trailing assistant treated complete `:444-451` with no retry/unfinished detection; `applyPreservedSegmentRelinks` `sessionStorage.ts:2162-2263`; timestamp-only leaf `findLatestMessage:2369-2384`. OCC does not currently model "a retried/unfinished reply in the same turn" when choosing which side of the compact boundary to keep.

**Why STAGED.** Logic-only official delta + OCC lacks the retried-reply turn model; needs runtime reproduction. **Next-round probe:** reproduce headless: reply starts → API retry (or output cut) leaves the turn unfinished → compaction runs mid-turn → resume; check whether OCC restores the pre-compaction history or loses the summary. Trace the official `cutOffTurn`/`callsWithoutResult`/`rateLimitRowSteppedOver` consumers (offsets balanced) to see how it decides which side of the boundary a retried turn lands on, then decide whether OCC needs a per-turn "unfinished/retried" flag carried across the compact boundary. Group with entry 37 (same resume-leaf subsystem).

---

## 42 — STAGED: feature flags / staged rollouts stale behind a TLS-inspecting proxy whose cert is trusted only via the OS cert store

**Official delta (partial).** New GrowthBook startup code @924650: `startup_flag_fetch_wait`, `growthbook_init_ms`, decision `Rks({nonInteractive,budgetMs,settingsEnvPending,cacheEmpty,relaunches,autoModeKillSwitchOnDisk,warmWakeEarlyFetch})==="gb-before-mode"`, `tengu_auto_mode_config` killswitch (`Ps.source==="disk"&&Ps.value?.enabled==="disabled"`), killswitch recheck `growthbook_killswitch_recheck_ms`. This confirms a new early flag-fetch/wait path, but the **exact TLS/OS-cert-store mechanism is not pinned** — no new CA/TLS string localizes how the flag fetch now honors the OS cert store (the general CA module is identical across versions).

**OCC evidence (Agent B).** GrowthBook is **live** in OCC: `src/services/analytics/growthbook.ts:1`/`:554`/`:503-506` (`apiHost` = `https://api.anthropic.com/`), but its fetch has **no custom TLS/cert handling**. Unprotected fetches: `src/services/gatewayModelDiscovery.ts:150`, `src/services/settingsSync/index.ts:266`/`:368`, `src/utils/releaseNotes.ts:93`. By contrast the API client *is* protected: `src/services/api/client.ts:222` → `getTLSFetchOptions` (`src/utils/mtls.ts:117`) → `getCACertificates` (`src/utils/caCerts.ts:62`, stores `['bundled','system']` at `:29`, `resolveCertStores` `:37-60`); `NODE_EXTRA_CA_CERTS` at `src/utils/init.ts:79` via `caCertsConfig.ts:34`/`:59`. So OCC has the same bug shape: the GrowthBook/settings/discovery fetches don't reuse `getTLSFetchOptions`+system store the way the API client does.

**Why STAGED.** OCC surface is real and the fix direction is clear (route the flag/settings fetches through the same TLS-options path that already loads the system cert store), but the official mechanism isn't recoverable from strings, so a faithful port can't be pinned this round. **Next-round probe:** confirm whether OCC's GrowthBook fetch behind an OS-cert-trusted TLS proxy actually fails (runtime test with a mitm cert in the OS store only). Independently, evaluate wiring `growthbook.ts`/`settingsSync`/`gatewayModelDiscovery`/`releaseNotes` fetches through `getTLSFetchOptions` (`mtls.ts:117`) + `getCACertificates` system store (`caCerts.ts:62`) — this is likely the OCC-side fix regardless of the exact official mechanism; verify it doesn't double-apply CA bundles.

---

## 46 — STAGED: Claude searches deferred tools already loaded earlier when resuming a history that never listed them

**Official delta (mechanism recovered).** History scanner is unchanged: `CQ`(v299)@225937384 = `k7`(v300)@227142949 (scans compact_boundary `preCompactDiscoveredTools`, `deferred_tools_delta.surfacedNames`, user `tool_reference` blocks). The change is in the deferred-tools **ledger** fn `Dss`(299)/`rcs`(300): v300 adds
```
ye=Q?new Set:Khs(n)                       // seed loaded-set from history when recorded state H is undefined (= resume)
er=new Set(Ji(Uo.attachment.loadedNames)) // per-attachment loadedNames
```
`loadedNames` 299:0→300:2. Seeder `Khs`@224037788:
```
function Khs(e){let n=Cz(),o=e.findLastIndex((r)=>r.type==="system"&&r.subtype==="compact_boundary");
 return new Set(Y5e(e.slice(o+1)).filter((r)=>n.get(r)?.kind!=="stripped").map((r)=>r.toolName))}
```
= tool_reference entries after the last compact boundary, minus `stripped`. On resume with no recorded ledger, the loaded-set is seeded from history so already-loaded deferred tools aren't re-searched.

**OCC evidence (Agent A).** `src/utils/toolSearch.ts:124-151` is a **name-memo only, with no persistent loaded-ledger / no latch**; `extractDiscoveredToolNames:561-608` (boundary carry `:569-575`); compact carries `preCompactDiscoveredTools` `compact.ts:653-660`/`:1102-1104`. OCC's deferred-tool tracking does not currently model a per-turn `loadedNames` ledger that survives resume, so the official seed-from-history mechanism has no direct OCC analog to attach to.

**Why STAGED.** Official mechanism is recovered, but OCC's deferred-tools ledger is structurally simpler (name-memo, no `loadedNames`/`stripped` state) — a faithful port needs mapping OCC's actual resume path against `Khs` first. **Next-round probe:** determine whether OCC records per-turn `loadedNames` on its deferred-tools delta attachment and whether resume drops them (grep the `deferred_tools_delta`/`tool_reference` write path). If OCC has no ledger, decide whether to (a) add a resume-time seed from `extractDiscoveredToolNames` after the last `compact_boundary` minus stripped entries (a `Khs` analog), or (b) treat as a by-design simpler model. Reproduce: resume a history that used a deferred MCP tool but never listed it in a delta; assert OCC does/doesn't re-search it.

---

## 55 — PORT: `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` sessions must ignore CA-bundle / tool-proxy / git-TLS / git-config vars in settings

**Official delta.** v299 had a small strip set: `Uf=new Set(["HTTP_PROXY","HTTPS_PROXY","NO_PROXY"])` (`hKn`) and `zf=new Set(["CLAUDE_CODE_CLIENT_CERT","CLAUDE_CODE_CLIENT_KEY","CLAUDE_CODE_CLIENT_KEY_PASSPHRASE","NODE_EXTRA_CA_CERTS","NODE_TLS_REJECT_UNAUTHORIZED","CLAUDE_CODE_OAUTH_SCOPES"])` (`kmt`) @215341054. v300 @216531261 expands it substantially:
- `vl=["SSL_CERT_FILE","SSL_CERT_DIR","ALL_PROXY"]`; `zy=["NPM_CONFIG_HTTPS_PROXY","NPM_CONFIG_HTTP_PROXY","NPM_CONFIG_PROXY"]`.
- `Tl=new Set(["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","CLAUDE_CODE_HTTP_PROXY","CLAUDE_CODE_HTTPS_PROXY","NPM_CONFIG_PROXY","NPM_CONFIG_HTTP_PROXY","NPM_CONFIG_HTTPS_PROXY"])`; predicate `Vln(e)=Tl.has(upper)`.
- `Pl=D([...pte,...Object.keys(Gme),...CYn.map(upper),...vl,...pJ.filter((e)=>!Hy.has(e))]).filter(e=>e!=="NODE_EXTRA_CA_CERTS"&&e!=="JAVA_TOOL_OPTIONS"&&!Tl.has(e))`; `vDr(e)=Pl.includes(upper)||l5n.test(e)||mQe.test(e)`.
- `Ky=new Set([...6 mTLS/auth vars,...Pl])`; `iJe(e)=Ky.has(upper)||vDr(e)`.
- `ir=["HTTPS_PROXY","HTTP_PROXY","NO_PROXY",...vl,...zy,"NODE_EXTRA_CA_CERTS","CLAUDE_CODE_CERT_STORE","CLAUDE_CODE_CLIENT_CERT","CLAUDE_CODE_CLIENT_KEY","CLAUDE_CODE_CLIENT_KEY_PASSPHRASE","NODE_TLS_REJECT_UNAUTHORIZED"]`; `EHo(e)=Vln(e)||iJe(e)||ir.includes(upper)` (used for the `r.coworkCloud` branch).
- Filter fn @219874632 `function b(e,n,r,i)`: key clause
  ```
  if(r.managedByHostFlag&&(!r.desktopHost||oJe(n))&&(Vln(s)||iJe(s))){L(i,s,n,r.desktopHost);continue}
  ```
  → under a host-managed session, strip these vars; when `desktopHost`, only strip from project settings (`oJe(n)` = project-scope test). Desktop warning text: `Ignoring X from <source> — repo-committed settings can't re-point the TLS/proxy channel of a session whose credential comes from the host. Set it in ~/.claude/settings.json or managed settings instead.`
- Regex/list defs @216276487: `mQe=/^GIT_CONFIG_(KEY|VALUE)_\d+$/i`; `l5n=/^GIT_(?:SSL|PROXY)_/i`; `pJ=[...fQe,"GIT_CONFIG_COUNT","GIT_CONFIG_PARAMETERS","GIT_CONFIG_GLOBAL","GIT_CONFIG_SYSTEM","GIT_CONFIG"]`; `fQe=["GIT_DIR","GIT_WORK_TREE","GIT_COMMON_DIR","GIT_INDEX_FILE","GIT_CEILING_DIRECTORIES","GIT_DISCOVERY_ACROSS_FILESYSTEM","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES","GIT_SHALLOW_FILE","GIT_NAMESPACE","GIT_IMPLICIT_WORK_TREE","GIT_REFERENCE_BACKEND"]`; `Hy=new Set(fQe)` (so git *repo-location* vars are kept, git *TLS/config* vars stripped).
- CA lists (new@7167978): `TYn=["SSL_CERT_FILE","NODE_EXTRA_CA_CERTS","REQUESTS_CA_BUNDLE","CURL_CA_BUNDLE","CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE","HTTPLIB2_CA_CERTS"]`; `AYn=["AWS_CA_BUNDLE","DENO_CERT","CARGO_HTTP_CAINFO","PIP_CERT","GIT_SSL_CAINFO","GRPC_DEFAULT_SSL_ROOTS_FILE_PATH","NIX_SSL_CERT_FILE","HEX_CACERTS_PATH"]`; `pte=[...TYn,...AYn]`; `Gme={UV_NATIVE_TLS:"true",DENO_TLS_CA_STORE:"system,mozilla"}`. Counts: `NPM_CONFIG_HTTPS_PROXY` 299:2→300:3; `SSL_CERT_FILE` 299:14→300:17.

**OCC evidence (Agent B).** `src/utils/managedEnvConstants.ts:16`/`:14-64`/`:67` (`isProviderManagedEnvVar` currently covers provider-routing vars + `VERTEX_REGION_CLAUDE_` **only**); `src/utils/managedEnv.ts:52`/`:550-576` (`filterSettingsEnv`). **0 hits** for `SSL_CERT_FILE`/`CA_BUNDLE`/`GIT_SSL`/`http.proxy` in the managedEnv files → the official expanded strip set is **absent**.

**Sketch:**
1. Extend `managedEnvConstants.ts` with the CA-bundle list (`TYn`+`AYn`), the proxy list (`Tl`: HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY/CLAUDE_CODE_HTTP(S)_PROXY/NPM_CONFIG_*PROXY), the git-TLS/config regexes (`/^GIT_(?:SSL|PROXY)_/i`, `/^GIT_CONFIG_(KEY|VALUE)_\d+$/i`), `vl` (SSL_CERT_FILE/SSL_CERT_DIR/ALL_PROXY), and the mTLS/auth set (CLAUDE_CODE_CLIENT_CERT/KEY/PASSPHRASE, NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED, CLAUDE_CODE_CERT_STORE). Keep the git *repo-location* allowlist (`fQe`) so those are NOT stripped.
2. Add a predicate `isProviderManagedTlsOrProxyVar(name)` = proxy ∪ CA ∪ gitTLS/config ∪ mTLS/auth, and wire it into `filterSettingsEnv` (`managedEnv.ts:550-576`) so that when the session is host-managed (`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`), these vars from settings are dropped.
3. Mirror the desktop scoping: if a desktop host is present, strip these only from **project** settings (not user/managed). Emit the "Ignoring X … can't re-point the TLS/proxy channel" warning when dropping.
4. **Test idea:** unit — set `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` + a project setting `SSL_CERT_FILE=/evil`; assert `filterSettingsEnv` drops it and warns, while a git-location var (`GIT_DIR`) survives. Cover each list (proxy, CA-bundle, git-TLS regex, git-config regex). e2e — host-managed session ignores a repo-committed `HTTPS_PROXY` in project settings.

---

## 59 — PORT: large api.anthropic.com requests use gzip even when telemetry is disabled (`CLAUDE_CODE_GZIP_REQUEST_BODIES=0` opts out)

**Official delta.** v299's gate `Q(e)` was controlled by `tengu_atomic_ocean` / `tengu_gzip_request_bodies` GrowthBook flags — both **REMOVED** in v300 (removed_strings), leaving only the ccr_worker flag check → gzip is now **default-on** for the api path. Decision fn `vMt`(v300)/`hIt`(v299): `env_off` when `CLAUDE_CODE_GZIP_REQUEST_BODIES===false`; min body size 4096 (api) / 1024 (ccr); skips `unix_socket`/proxy/mtls/custom_ca transports; a bad-json 400 latch `rejectedThisProcess` disables gzip after a rejection; compression level `CLAUDE_CODE_GZIP_REQUEST_BODY_LEVEL ?? k("tengu_golden_popcorn",0)`.

**OCC evidence (Agent B).** **Zero** gzip hits in OCC: `grep -rn 'gzip\|GZIP\|CLAUDE_CODE_GZIP' src/` → 0. `src/services/api/client.ts:1`/`:226`/`:532-575` `buildFetch` passes the request body through uncompressed; `src/services/api/claude.ts:2774` is the create call. So OCC does not gzip request bodies at all.

**Sketch:**
1. Add a decision helper mirroring `vMt`: gzip iff target host is `api.anthropic.com`, transport is not unix_socket/proxy/mtls/custom_ca, body ≥ 4096 bytes, `CLAUDE_CODE_GZIP_REQUEST_BODIES !== '0'/'false'`, and the bad-json latch is not set. Level from `CLAUDE_CODE_GZIP_REQUEST_BODY_LEVEL ?? 0`.
2. In `client.ts` `buildFetch` (`:532-575`), when the helper says gzip: `Content-Encoding: gzip` header + `Bun.gzipSync(body)` (or `zlib.gzipSync`) the serialized JSON body. Set `Content-Length` accordingly.
3. Add the process-wide `rejectedThisProcess` latch: on a 400 whose message indicates a bad/gzip-decode failure, disable gzip for the rest of the process and retry uncompressed once.
4. Honor `CLAUDE_CODE_GZIP_REQUEST_BODIES=0` to fully disable (matches changelog).
5. **Test idea:** e2e — with a >4096-byte request body to api.anthropic.com, assert the outgoing request has `Content-Encoding: gzip` and a gzip payload; set `CLAUDE_CODE_GZIP_REQUEST_BODIES=0` and assert it's plain. Unit-test the decision fn's size threshold, transport skips, env opt-out, and the bad-json latch.

---

## 62 — STAGED: local session transcripts also record each API request's system prompt, tools and parameters

**Official delta (record schema fully recovered).** Gated by a GrowthBook **flag-default flip**: v299 `function zV(){let e=a.CLAUDE_CODE_ELEGANT_MEADOW;if(e!==void 0)return e;return Rr("tengu_elegant_meadow",!1)}` @223499625 → v300 `function $4(){…return vr("tengu_elegant_meadow",!0)}` (default false→**true**). Capture fn `ukt`(300)/`qht`(299) gated on `querySource` main/subagent, `N4.canRecord()`, `e.storageV5===void 0`, `$4()`. Writer (new@1727400-1730960): `appendRequestReplayRecords(e)` → skip reasons `no_transcript`/`shape_too_large`; `api-request-shape` record `{type,sessionId,agentId?,shapeHash,timestamp,version,shape:aN(e.shape)}` capped at `veo` bytes (oversize → `oversizeReplayShapes.add`); `api-request-blob` records `{type,sessionId,agentId?,hash:w,message:H}` deduped via a replay index (`h.has(w)`/`h.noteLine(K)`); appended via `Promise.all([...S,r].map((w)=>this.appendEntry(w,…)))`. Request record (new@42196300): `{type:"api-request",sessionId,agentId?,id,timestamp,version:WQn,querySource,shapeHash,params,withheld?,base?,keep,tail,cacheControl,requestDigest}` or `{cut,cutRequestDigest}`; chain Map capped `GQn=64`; telemetry `transcript_request_replay`; replay index class `L4` with `noteLine`. All markers balanced (appendRequestReplayRecords 3:3, transcript_request_replay 3:3, api-request-shape 5:5, api-request-blob 6:6, requestDigest 2:2) — the subsystem exists in both; only the **gate default flipped**.

**OCC evidence (Agent C).** No API-request transcript records: `src/types/logs.ts:297` Entry union has **no** such record type; `src/utils/dumpPrompts.ts` is ant-only (`USER_TYPE==='ant'` at `:49`/`:100`/`:174`) writing a **separate** file `~/.claude/dump-prompts/<sessionId>.jsonl` (`:59`) — not part of the session transcript; `src/utils/logging.ts:719` is telemetry only. So OCC has no in-transcript request-replay subsystem.

**Why STAGED.** The record schema and gate are fully recovered, but this is a sizeable new subsystem (in-transcript `api-request`/`api-request-shape`/`api-request-blob` records, shape hashing with size caps, blob dedup via a replay index, a 64-entry chain Map) wired into OCC's transcript writer — well beyond a single-round sketch, and it interacts with OCC's transcript format/reader and privacy posture. **Next-round probe:** decide whether OCC wants request-replay records in the main transcript at all (privacy: they capture full system prompt + tools + params). If yes: (1) add the three Entry variants to `types/logs.ts:297`; (2) implement `appendRequestReplayRecords` in the transcript writer with a shape-hash cache, oversize skip, and blob dedup index (`L4.noteLine` analog); (3) gate behind a new `feature()` flag (respecting OCC's 6-flag allowlist — would need a 7th) or an env var; (4) ensure the resume reader (`parseJSONL`) tolerates the new record types. Confirm the official `a`-level cap (`veo`) value and `GQn=64` chain cap from strings before implementing.

---

### Cross-cutting notes for the port round

- Entries **37 + 40** share the same headless/SDK resume-leaf subsystem (timestamp-only `findLatestMessage`) — port together.
- Entries **42 + 55 + 59** all touch the TLS/proxy/cert surface (`mtls.ts`/`caCerts.ts`/`managedEnv*`); coordinate to avoid double-applying CA bundles.
- Entries **18 + 46** both concern the tool-search / deferred-tools ledger resume behavior; if 46 gets a ledger, 18's `auto_held` latch and 46's `loadedNames` seed can share it.
- All 7 PORTs have fully recovered official mechanisms (byte offsets + code excerpts above) and concrete OCC file:line sites; they are independent and parallelizable across subagents.
