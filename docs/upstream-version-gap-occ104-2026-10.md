# OCC-104 Upstream Version Gap Ledger — Claude Code 2.1.285 → 2.1.286 (2026-10)

**Round**: OCC-104 (issue `078982c8-89a9-4c8f-b071-718d2b1cb71c`), executed 2026-10-01/02 by OCC 程序员.
**Tracked-upstream pointer**: 2.1.285 → **2.1.286** (this round). OCC release: **2.1.365** (renumbered from 2.1.364 — the parallel OCC-143 round shipped 2.1.364 first; see §5).
**Official channel state at round time** (npm `dist-tags`, fact-checked 2026-10-02): `stable=2.1.285`, `latest=next=2.1.287`. Publish times: 2.1.285 → 2026-09-29, 2.1.286 → 2026-09-30, 2.1.287 → 2026-10-01.
**Per directive**: 2.1.287 gets **pre-triage STAGE only** (§8) — no forced alignment this round.

## Method

- Binaries: `@anthropic-ai/claude-code-linux-x64@2.1.285` (240,327,864 B) and `@2.1.286` (241,667,256 B), unpacked to `/tmp/cc-diff-286/{v285,v286}/package/claude`. **Never executed** — analysis used only `strings -n 8`, `grep -aobF` offsets + `dd bs=1 skip=N count=M`, `comm` on sorted string dumps (`s285.txt`/`s286.txt`/`new286.txt` [17,425 new lines]/`del286.txt`). Code region = offsets > 195 MB; the ~92–103 MB region is string-table/bytecode blob. v285→v286 offsets drift ~+1.1 MB in plugin regions. Temp artifacts removed after the round (`rm -rf /tmp/cc-diff-286`).
- Changelog: 88 bullets for 2.1.286 (numbered **#3–#90** below, matching the line numbers used by the four research reports in the round workspace `gap-research-286/`: `triage-remaining.md` [71 items], `redaction-cluster.md` [#19–#23], `plugin-remotecontrol.md` [#12/#39/#40/#60], `auth-model-retry.md` [#5/#10/#11/#13/#15/#16/#56/#57]).
- Porting rule (`aligning-with-official-binary`): port only byte-verified official code; STAGED-with-rationale is success, invented code is failure. Security ports additionally verified by **A/B needle harnesses** running extracted official code vs the OCC port (all-SAME required).
- Statuses: **PORTED** (landed this round, tests green) · **PORTED(partial)** (core landed; named sub-pieces STAGED) · **STAGED** (real surface or real gap, but needs decompilation/decision/subsystem OCC lacks — recovered code recorded, nothing invented) · **NO-OP** (PLATFORM = other-product surface; NO-SURFACE = feature absent from OCC; ALREADY-ALIGNED).

## Summary counts (88 entries)

| Status | Count |
|---|---|
| PORTED / PORTED(partial) | 17 |
| STAGED | 33 |
| NO-OP (PLATFORM) | 24 |
| NO-OP (NO-SURFACE) | 13 |
| NO-OP (ALREADY-ALIGNED) | 1 |

Security items (#10 #12 #19 #20 #23-adjacent #60) all landed or honestly dispositioned; see §2.

## 1. Per-entry ledger (#3–#90)

### Data-loss / correctness cluster

| # | Changelog (abridged) | Status | Rationale + byte evidence |
|---|---|---|---|
| 6 | `--resume`/`--continue` losing every turn after a parallel-tool-call batch when the earlier session crashed | **PORTED(partial)** | `src/utils/sessionStorage.ts` `recoverOrphanedParallelToolResults` replaced with the full official `Bmr` (v285@207144795 ≡ v286@208294542 canonical-identical — the real 286 delta is the parser leaf-selection `Aan`/`Pan`/`Qt`, which operates on the official streaming-parser tree OCC does not have → that sub-piece STAGED, structurally impossible in OCC). Landed: dangling-TR partition (`zp()`→const true), call-id→assistant map (null on ambiguity), re-link via `sourceToolAssistantUUID` gated same-sidechain/same-agentId, re-anchor `Math.max(filePos, groupMaxPos + 0.5)`, tail recovery (`Xie`/`Qie`, IO-traversable only), position-map ordering (`yB`/`NS`), telemetry `tengu_chain_parallel_tr_recovered` + `recovered_tail_count` + `tengu_chain_tool_result_recovered_by_call_id`. 7 new tests (47 file-total). |
| 7 | API 400 after a tool/hook returned object/number/boolean instead of text (incl. resumed sessions) | **PORTED** | Non-string text-block drop guards at both official sites: `mergeAssistantMessages` warn `"mergeAssistantMessages: text block with non-string .text (id=…) — dropped"` (v286 `rze` @208036567) in `src/utils/messages.ts`; `deserializeMessages` warn `"deserializeMessages: dropped non-string text block(s) from ${N} message(s) — interrupted-stream artifact"` (@207008961) in `src/utils/conversationRecovery.ts`, drop BEFORE the `site:"resume"` sanitize. 13 new tests + 164 regression. |
| 34 | Background jobs showing done while waiting for approval | STAGED | OCC `taskStatusUtils.tsx:60–70` precedence already checks `awaitingApproval` before `completed` — likely no-op, but the official fix may live in a different status source (job-level vs task-level); verify against official delta before touching. |
| 35 | Commit-attribution reminder re-sent inside tool output on 1-turn fallback | NO-OP (NO-SURFACE) | No attribution-reminder injection mechanism in OCC `src/` (grep 0 hits). |

### Security cluster (top priority per kickoff)

| # | Changelog (abridged) | Status | Rationale + byte evidence |
|---|---|---|---|
| 19 | MCP error messages showing a credential's value when "Bearer"/"Basic" came before its key name | **PORTED** | Full `rzn` rewrite of `src/services/mcp/displaySanitize.ts` from v286 @203208152–203209061: `KEY_NAME_PATTERN` (`yd`@203208152), `NEXT_KEY_PATTERN` (`a7`), `SECRET_VALUE_PATTERN` (`S0`: lazy-stop `+?(?=${NEXT_KEY})` ∣ greedy `{8,}`), `BEARER_RULE` (`l7` — negative lookahead blocks Bearer-before-key-name), `KV_RULE` (`c7`), 5-arg `redactionReplacer` (`_0`@203208929: bail if no `[0-9._~+/=%-]` in secret; trailing space when next char is `\w`). **A/B needle harness: 21/21 SAME** (extracted official v285/v286 code vs OCC port under bun; harness deleted after use). Ground-truth pins incl. `'Error: Bearer access_token: sk-ant-SECRET123 rejected'` → `'Error: Bearer access_token [redacted] rejected'`. |
| 20 | Percent-encoded Bearer tokens only partly masked | **PORTED** | Same `rzn` rewrite (function is total: `e.replace(l7,_0).replace(c7,_0)`). Per `redaction-cluster.md` §2.3: the exact upstream repro string is **not uniquely recoverable from the binary** (12-input percent-encoded battery all-SAME except the embedded-key split `api_key=SECRET1+token=SECRET22` → `api_key [redacted] token [redacted]`); precise-repro claim STAGED, port unaffected. Pin: `'token=Bearer%20eyJhbGciOiJIUzI1NiJ9'` → `'token [redacted]'`. |
| 21 | Redacted logs/transcripts showing a secret whose key name contains an invisible char (zero-width space) | STAGED (NOT-AFFECTED) | Fix lives in the official log/transcript secret engine (NEW `$Se`/`ape`/`jje`/`h4o` @196530855–196531159 + rules `Fe`/`Pe`/`xt`/`de`) — a whole module OCC has never had (pre-existing gap, bigger than the 286 delta). Bug cannot manifest in OCC. When the engine is ported, port the **v286 shape directly** (code recovered in `redaction-cluster.md` §3.1). |
| 22 | Logs/transcripts showing part of a URL password with punctuation / second `@` / bracketed host | STAGED (NOT-AFFECTED) | Same engine absence (NEW URL-span detector + tracked replacement @196541805–196559935, recovered in §4.1 of the report). OCC's ported URL family (`redactUrl.ts` ← `j6e`/`Nbn`) was **verified byte-unchanged v285→v286** → already matches official. |
| 23 | `/feedback` zip transcript containing invalid JSON lines after secret redaction | STAGED (NOT-AFFECTED; reference design recovered) | OCC `/feedback` has **no bundle path** (post/telemetry only; `submitTranscriptShare.ts` serializes once with quote-safe value classes — structurally cannot produce the bug). Official v286 fix (`hkn`@212236834 mode gate → `vkn`@212249915: parse→redact-object→re-serialize per line, never regex-redact serialized JSONL; `jt` credential-property state machine; `Nt` api-request hex scrub; `uOe` normalization) recovered verbatim in `redaction-cluster.md` §5.2 for the future bundle-mode port. |
| 60 | Plugin installs refuse npm sources that are git repos or folders; dependencies only from registry packages | **PORTED (validation half)** / NO-OP (dependency-install half — OCC has no plugin-dependency installer) | NEW `src/utils/plugins/npmSpecValidation.ts` + mods `npmPluginFetch.ts`/`schemas.ts`, all byte-verified: `validateNpmSpecUrl` (`HWe`@207632383), `validateRegistryOverride` (`Z8t`@207633872), `getDefaultRegistryOrigin` (`vue`@207633680), `npmArgv` with `--git=<workDir>/git-is-disabled` prepend (`dY`@207633550), `GIT_HOST_BLOCKLIST` (`krr`@207630990), `isValidNpmPackageName`/`buildInvalidPackageNameMessage` (`bRr`@207631214, NEW in v286), `buildRegistryRefusalMessage` (`Mrr`@207635951). `buildFallbackRefusalMessage` (`Krr`@207643337) built+tested but **UNWIRED** (no non-marketplace npm lane in OCC — STAGED). `schemas.ts`: added the registry `fJe` refine (present in BOTH official versions; was missing in OCC). Spec step-5 (describe-text change) **DISPROVEN** — byte-identical v285↔v286 @197052281/@196067740; not altered. 108 tests. |
| 12 | Remote Control sessions staying connected after org policy turns RC off → disconnect with notice | **PORTED(partial)** | NEW `src/bridge/bridgePolicyRefusal.ts` + mods `policyLimits/index.ts`/`bridgeMain.ts`/`initReplBridge.ts`: `connectedBridgePolicyRefusal` (`WAe`@202356353; tri-state cache: undefined→cache_miss / null→route_missing / `{allowed:false}`→org_denied; **never disconnect on unknown**), byte-exact notices ("Remote Control was turned off by your organization's policy." / "Session mirroring was turned off by your organization's policy (allow_remote_sessions)."), `onPolicyLimitsChange` (`D0` verdictChanged@200064192; fires only on JSON.stringify diff), standalone lane in `runBridgeLoop` (`[bridge:policy] …shutting down` + telemetry `tengu_bridge_policy_teardown` lane:standalone + policyShutdown latch), REPL lane `attachBridgePolicyWatcher` (`[bridge:repl] …disconnected`), auth-mode gate `getBridgePolicyAuthMode` (scope set {prosumer_oauth, third_party_provider, custom_base_url}, official `jne`/`I3n`/`T`@200064675–200064850). v285 has ZERO hits for the notice strings / `Lb`@200084227 / the teardown event (newness proven). STAGED: SDK-host lane (@222650000+, outside this round's allowlist), AppState-clear, live transcript-append wiring, `'latched'` arm, `$3n` fetch. 37 tests. Acceptance G4/G6 fix (2026-10-02): reconnect blind spot closed — `attachBridgePolicyWatcher` accepts `registerStateHook`, fed from `initReplBridge`'s `trackedOnStateChange`, re-running `checkBridgePolicy()` on transition-to-connected (official effect deps `[ready]` re-execution analog; connected-gate + policyShutdown latch ⇒ fires at most once, never disconnects on unknown); `runBridgeLoop`'s refusal return now consumed by both callers (interactive: `consumeBridgePolicyRefusal` distinct status line — official caller exit shape unrecoverable from the binary, so exit(0) kept and the distinction is an OCC decision; headless: return type widened, zero in-repo callers today); refusal cleanup also runs `stopBackgroundPolling()` — marked OCC addition (official `Dt(),Wt(),s.clearStatus(...)` triple has no polling-stop identity). Tests: watcher suite 6 incl. reconnect contract (RED-before 5/1) + hermetic `bridgePolicyRefusalShutdown286.test.ts` 3 (RED-before 0/3), both mutation-verified. |

### Auth cluster

| # | Changelog (abridged) | Status | Rationale + byte evidence |
|---|---|---|---|
| 5 | Several processes/IDE extensions each opening a login browser when gcpAuthRefresh/awsAuthRefresh credentials expire | STAGED | Official fix = cross-process refresh lock (pid-liveness subsystem + takeover dialog + single-flight lock classes; recovered in `auth-model-retry.md` item 1). Partial locking without the full subsystem risks **deadlock** (stale lock never released) — worse than the bug. Also note OCC lags the v285 baseline here too (two-state vs three-state GCP probe) — needs a dedicated round. |
| 10 | macOS "Not logged in"/"Login expired" after `/login` succeeds elsewhere with leftover `~/.claude/.credentials.json` | **PORTED** | `ik()` recheck @199703297: `UNUSABLE_TOKEN_RECHECK_THROTTLE_MS=30_000`, `deadOAuthRefreshTokens`, `isOAuthTokenUnusable` (**refreshToken-based per actual bytes**, not the report's initial accessToken claim — corrected during port), `peekCachedOAuthTokens`, `recheckOAuthTokenIfUnusable` with firstParty gate. In `src/utils/auth.ts`. Tests in `oauthUnusableTokenRecheck286.test.ts`. |
| 15 | `claude auth status` reporting a Console sign-in's stored API key as `claude.ai` → now `api_key` | **PORTED** | v286@220312704 one-liner: `else if(c==="ANTHROPIC_API_KEY"||h||c==="/login managed key")p="api_key"` in `src/cli/handlers/auth.ts`. Documented side-effect (official-identical): managed-key JSON drops email/orgId/orgName/subscriptionType. `authStatusManagedKey286.test.ts`. |
| 16 | `/status` listing an Anthropic profile beside an API key as if both in effect | NO-OP | Strict v285→v286 delta lands on the Console-profile row, which OCC does not have (`auth-model-retry.md` item 6; catch-up note on the v285-baseline marker recorded there). |

### Model / retry / fallback cluster

| # | Changelog (abridged) | Status | Rationale + byte evidence |
|---|---|---|---|
| 11 | Every turn failing when the API refuses the resolved model → retry once on previous model of same tier | **PORTED(partial)** | NEW `src/utils/model/modelLadder.ts`: catalog `fo`/`Hu`@197605159, ladder `oPr`@199362534 (`hNe`/`ere`@199394813, `d9e`@199387813, `OI`@199417435, `GYn`@199418005), trigger rewrite `Kn`/`Pn`/4-arg `Tx` in `withRetry.ts`, `+isModelDeprecated`. Fixed an OCC quirk en route: server_error trigger no longer fires under watchdog. STAGED: dispatch call sites @212168274/@212172692/@205984812 (query-engine wiring outside this round's file allowlist; recovered code in file headers). |
| 13 | Refusal/`--fallback-model` retries failing when the fallback can't run fast → standard speed + one-time notice | **PORTED(partial)** | NEW `src/utils/model/fastRejection.ts`: per-model fast-rejection store `Ll`@199318400 + branch-1/loop-head coercion in `withRetry.ts`. STAGED: one-time notice plugin `qot`/`efo`@226000442 (id `fast-mode-fallback-model-rejected`, text "Using standard speed on ${bs(v)} · fast mode wasn't available"; wiring point `onFallbackModelFastRejected` — recovered, ready). |
| 52 | Fallback notice + autocompact-thrashing error saying when context dropped 1M→200K | **PORTED(partial)** | NEW `src/utils/model/contextDropNotice.ts`: exact strings ` · context window 1M → 200K tokens` and `(to keep 1M, use X[1m] for this entry in your fallback model list)`. STAGED: call sites @212193507/@212156257/@212198514 — OCC has no autocompact-thrashing breaker to attach to. |
| 56 | Failed-request retries: one limit per model call → at most 14 requests with defaults | **PORTED(partial)** | NEW `src/services/api/modelCallRetries.ts`: shared ledger `FFt` engine @206134260-region (`VMo`=2, `LK`=3; 14 = 11(1+10) + 1 hop + 2 renewals; live-W/shadow-K split; `triedWithoutStreaming` restore quirk; `takeApiAttempt`/`outOfApiAttempts`/`takeCredentialRenewal`/`reportHttpFailure`/`isCredentialRenewalError`≡`SFt`@206111780) + `withRetry.ts` integration. STAGED: QueryModel dispatch @206191201, stream classifier `$Ft`/`XMo`, `no_api_attempts_left` kind. 102 new tests; 127 withRetry regression. |

### Mode / UX behavior cluster

| # | Changelog (abridged) | Status | Rationale + byte evidence |
|---|---|---|---|
| 48 | Ctrl+G: editors that take a line number open on the prompt cursor's line | **PORTED** | `editorFileArgv` `R`@214204398 (`-g file:line` code/cursor/windsurf/codium; `file:line` subl; PLUS_N `/\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/` → `+N file`); `kZ(n,e)`@214205691 vs v285 `jQ(n)`@213022642; `L$` 4th param; cursor line = `1+zt(d,"\n")+zt(expandedPrefix,"\n")`. `editPromptInEditor`/`editFileInEditor` gained optional `line` param. 38 tests; 2 e2e source pins updated (`version-2.1.200-uirest`, `workflow-permission-dialog-ctrl-g` — reviewed, legitimate signature pins). |
| 53 | SDK/`-p` responsiveness when a host re-sends MCP enable for an already-connected server | **PORTED** | `Xe`@222648472 short-circuit in `src/cli/print.ts` (already enabled + live client → return existing status; reconnect only on real disabled→enabled transition). 8 tests. |
| 55 | Prompts sent while nothing is running/queued show normal color right away (not gray) | **PORTED(full)** | `src/state/promptsAwaitingModel.ts`: gate `L&&mt`@225818516, `mt` = run's NEW 15th param @225815961, fed by dispatcher `xZe` as `ht=Ge==="queued"`@225767067 (`inputSource:"typed"` = 0 hits in v285 — TRUE-NEW); attachment branch byte-identical v285@224558227/v286@225813406. 63 tests. WIRED (acceptance G3 fix, 2026-10-02): REPL `onQuery` gains 9th param `isQueuedDispatch?: boolean` (REPL.tsx:3059); turn-append calls `awaitModelForMessages(newMessages, isQueuedDispatch === true)` (:3106); the queued drain tags its dispatch via `makeQueuedDispatchOnQuery` (messageQueueManager.ts, executeQueuedInput :4104) — structural analog of the official dispatcher appending `ht` as run's final arg (`await gt(...,so,ht)`@225772771); typed/initial/speculation callers keep the raw callback → flag undefined → normal color. +6 dispatch-chain tests (`queuedDrainGray286.test.ts`). |
| 57 | `--bare`: only CLI-named MCP servers, no system reminders, no background tasks; shell timeout stops instead of backgrounding | **PORTED(partial)** | `areBackgroundTasksDisabled()` in `envUtils.ts` (`yl`@202370763 adds `||Rr()`), 9 consumer sites switched; `isBareFilteredAttachment()` (`Nen`@204280727) in `attachments.ts`; `stopHooks.ts` gates only `collectedAdditionalContexts.push` (@212100178); MCP auto-discovery skip already satisfied (main.tsx:2120). STAGED: `Imn`/"Background tasks are disabled in this session." + SDK control rejection @202391061, `Nen` consumers @208088367/@208081215; plugin `$.tool.register` refusal unreachable in OCC (documented). |
| 59 | WebFetch rate-limited domain safety check tells Claude not to retry in a loop | **PORTED** | `ERATELIMIT_PREFLIGHT` 429 classification in `src/tools/WebFetchTool/utils.ts` (`jxe`@205466878) with the verbatim do-not-retry message ("Do not retry WebFetch in a loop or sleep to wait it out; … A single later attempt is fine; if that is rate-limited too, stop."); `httpStatus` added to the `check_failed` variant. NOT ported (separate delta, noted): v286 User-Agent header on the domain_info request. `rateLimitedPreflight286.test.ts`. |

### Remaining entries — STAGED (real surface, needs dedicated decompilation/decision)

| # | Changelog (abridged) | STAGE reason (batch) |
|---|---|---|
| 3 | "2 of 5" count on stacked permission prompts | Permission-prompt UI batch (with 45/46); render site not yet extracted. |
| 4 | Mouse support for "N more" overflow rows (click/hover/pressed) | Mouse/list UI batch (with 36/37/47/61/62/63); shared overflow-row renderer `rt(E,Y)` in new286. |
| 18 | RC message arriving during exit stays queued (not acked-and-lost) | RC shutdown ack-ordering; official shutdown-path implementation not yet extracted. |
| 24 | MCP connectors listing no tools for up to a day after server dropped old handshake | Needs BOTH new protocol `XRt="2025-11-25"` (285 lacked it) AND the stale-tools cache-invalidation half; string-only port insufficient. |
| 25 | Repeat MCP sign-in reuses pending link | **Reverses a documented OCC hardening** (`docs/upstream-version-gap-occ128.md`: OCC deliberately cancels predecessor flows) — needs explicit decision, not a silent port. |
| 28 | Message typed into running subagent shown twice | Subagent/agent-teams cluster (gated surfaces); official site not extracted. |
| 29 | Subagent hand-back shows raw task id instead of name | Same cluster; OCC's handback header is generic today (bug doesn't reproduce) — must use official name-fallback when named display lands. |
| 30 | Foreground subagents missing Task*/TodoWrite tools | Same cluster; needs official tool-filter delta. |
| 31 | Worktree-isolated subagents loading CLAUDE.md twice | Same cluster; repro condition exists in OCC (`runAgent.ts:638–645` + path-based dedupe) — needs official normalization approach + concrete repro test. |
| 32 | Workflow subagents restarted from original prompt on stalled connection | Same cluster; deep query-layer resume-not-restart change. |
| 36 | Click between words of collapsed row highlights without expanding | Mouse/list UI batch. |
| 37 | Row with no details pushes other rows' details right | List-layout batch (with 61). |
| 39 | Marketplace load-refusal errors say why + how to fix | STAGED: fires only on `registrationHidden`/`registrationHiddenReason` from the official **marketplace admission validator**, never ported to OCC; OCC messages match the official v285 base case. All v286 strings recovered in `plugin-remotecontrol.md` item 3 for the future admission-validator port. |
| 43 | Background-agent replies no longer open with a recap | Prompt-side; official prompt delta needs extraction; OCC bg structure differs. |
| 45 | fetch/skill/file-read/sandbox-network/Chrome/workflow/notebook prompts match file-edit look | Permission-prompt UI batch (large Ink component delta). |
| 46 | Bash/PowerShell/Monitor prompts show command between dashed lines | Same batch (OCC lacks the look entirely). |
| 47 | Fullscreen list scrollbars: stable bar + clickable ↑/↓ arrows | Mouse/list UI batch. |
| 49 | Slash-suggestion responsiveness; descriptions match by word prefix | OCC matcher is Fuse-based; official word-prefix matcher must be extracted wholesale (scoring consistency). |
| 50 | Output-style picker: opens on current style, description under name, no number keys | Picker batch (with 64). |
| 58 | ctrl+enter moves a skill's own shell command to background instead of ending it | Needs official sendNow target-classification delta. |
| 61 | List screens always line up details in one column | List-layout batch. |
| 62 | Overflow rows read "↑ N more"/"↓ N more" | Mouse/list batch — faithful port = introduce the shared component ("more above" has 8 hits in BOTH v285/v286; OCC's sites are per-component). |
| 63 | `/hooks` opens on one grouped list (one Enter instead of three) | UI rework; OCC `/hooks` is a narrower read-only surface. |
| 64 | Theme picker: scrolling list, no number keys | Picker batch. |
| 65 | `/exit` Remove-worktree runs after servers/shells stopped | Ordering audit needed; Windows-centric, low priority for OCC's Linux-first target. |

### Remaining entries — NO-OP

| # | Changelog (abridged) | NO-OP class + reason |
|---|---|---|
| 8 | Cloud sessions with huge histories never waking | PLATFORM — claude.ai container orchestration. |
| 9 | Claude apps gateway spend-meter pricing (1h cache writes; streamed-turn input tokens) | PLATFORM — server-side gateway billing. |
| 14 | Headless repeating "MCP servers require authentication" after re-auth (discovery cache) | NO-SURFACE — `MCP_DISCOVERY_CACHE` env family: 0 hits in OCC; OCC's notice is interactive-only; OCC's auth cache invalidates correctly (2.1.280 #048 port). |
| 17 | RC attachment non-arrival notification + 10s last-try download | NO-SURFACE — OCC RC accepts text prompts only (no attachment/download machinery). |
| 26 | `/usage` not crediting MCP server mid-connect | NO-SURFACE — no MCP usage-attribution mechanism in OCC (already listed staged/absent in CLAUDE.md OCC-46). |
| 27 | claude.ai-enabled plugins going missing after transient server error | NO-SURFACE — no claude.ai plugin-config sync in OCC (local-config only). |
| 33 | `/compact`//`/clear`//`/rewind` mis-targeting while viewing bg/teammate transcript | NO-SURFACE — no in-REPL bg-agent transcript view (BG_SESSIONS off; `occ attach` is its own REPL). |
| 38 | Very long file names not reaching a cloud session | PLATFORM. |
| 40 | `/plugin` Discover "Checking …" quoting | NO-SURFACE — no Discover-refresh lane in OCC; spec recorded in `plugin-remotecontrol.md` item 4. |
| 41 | `verify` skill commit guidance | NO-SURFACE — no pr-prep suggestion mechanism (`pr_prep`/`includeCodeReviewSuggestion` 0 hits); official v286 strings recovered in triage report for a future port. |
| 42 | send-now in a subagent's view moves its command to background | NO-SURFACE — no subagent transcript viewer. |
| 44 | WebFetch asks Artifact-tool questions on claude.ai artifact links | NO-SURFACE — no Artifact tool in OCC (trimmed). |
| 51 | `/hooks` detail closing line says "this hook" | ALREADY-ALIGNED — `ViewHookMode.tsx:136` already reads exactly that. |
| 54 | Gateway `/protocol` page wording | PLATFORM. |
| 66 | `claude-api` skill Managed Agents examples → limited networking | NO-SURFACE — OCC skill .md files are intentional stubs; 0 "Managed Agents" hits. |
| 67 | Browser link removed from `/ultrareview` output | NO-SURFACE — command gated off (GrowthBook stub → cfg null → hidden). |
| 68 | Windows `--bg`/agents-view trust case-sensitivity | PLATFORM — Windows-only + `--bg` surface OCC replaces with the daemon supervisor. |
| 69–78 | [VSCode] ×10 (bookmarks, Questions row, option previews, context rows, duplicate tab, 1MB settings-save, teleport spinner, Manage-plugins dialog, Stop/Escape scope, status-bar item) | PLATFORM — OCC ships no VSCode extension (teleport stubbed `isEnabled:()=>false`). |
| 79–84 | [Cloud sessions] ×6 (idle question-card reply, org setup-script clearing, Runner actions menu, routine-run status, Outputs media playback, "Due" label) | PLATFORM — no cloud-session surface. |
| 85–90 | [Claude Tag] ×6 (Add-channel button, memory recall w/o Sonnet, Enterprise Grid channel move, Slack-thread restart, raw Slack IDs, session titles) | PLATFORM — no Slack/Claude-Tag surface. |

## 2. Security disposition summary (kickoff priority list)

| Kickoff priority | Disposition |
|---|---|
| Redaction cluster (#19–#23) | #19/#20 **PORTED** (A/B 21/21 SAME); #21/#22/#23 honestly **NOT-AFFECTED → STAGED** (the official log/transcript engine and /feedback bundle mode do not exist in OCC; v286-shape code recovered in `redaction-cluster.md` §3.1/§4.1/§5.2 so a future port lands the fixed shape directly, never v285-then-refix). No inflation: nothing was "ported" into modules OCC doesn't have. |
| `/feedback` JSON lines (#23) | See above — NOT-AFFECTED + reference design recovered. |
| Remote Control policy disconnect (#12) | **PORTED** (standalone + REPL lanes wired; never-disconnect-on-unknown; byte-exact notices; teardown telemetry). SDK-host lane + transcript-append wiring STAGED with recovered code. |
| Plugin supply-chain hardening (#60) | **PORTED** (validation half; git-host blocklist, registry-origin validation, `--git=` disabled prepend, package-name validation with v286-new refusal messages, `fJe` registry refine). Dependency-install half NO-OP (no installer in OCC). `Krr` fallback-refusal built+tested, unwired (no lane). |

## 3. Verification (real e2e per kickoff)

- **Unit**: `bun test src --isolate` → **6811 pass / 1 skip / 0 fail / 0 errors** (16,916+ expect() calls, 540 files, ~410s). Note: the combined (non-isolate) run has known cross-file `mock.module` contamination under bun 1.3.14 — `--isolate` is the repo's correct full-suite mode.
- **A/B needles**: displaySanitize `rzn` harness 21/21 SAME (official extracted code vs OCC port); percent-encoded battery per `redaction-cluster.md` §7. Mutation self-verification for pins performed by each porting subagent (recorded in their reports).
- **tsc**: no new type errors vs the 679-error pre-existing baseline under `strict:false` (final count 645; 4 new-file narrowing sites fixed with explicit casts — discriminant-union narrowing fails under strict:false).
- **Lint**: biome (repo gate) green on touched files.
- **Build**: `bun run build` green — `dist/cli.js` 29.68 MB.
- **Live host smoke**: `occ --version` → OCC 2.1.363→**2.1.364** (after bump), re-smoked **2.1.365** after the OCC-143 merge (build 29.71 MB, MACRO.VERSION=2.1.365); `echo "say PONG" | occ -p` → PONG, exit 0 (both pre- and post-merge); tmux REPL: boot OK, model round-trip REPLPONG OK, `/status` renders (Model/MCP/setting-sources rows + bypass-permissions footer).
- **Post-merge full unit suite** (merged tree, both rounds combined): `bun test src --isolate` → **6835 pass / 1 skip / 0 fail** across 541 files (= this round's 6811 + OCC-143's 24 secretRedaction tests, exactly additive — zero cross-round interference).
- **Docker e2e** (`test/e2e` in `occ-e2e:latest`, non-root runner, model creds forwarded): 711 pass / 1 skip / 20 fail (13 unique) — every unique fail classified via a clean-baseline (main @793b605) A/B in the same container: 12 pre-existing, 1 stale-pin artifact re-pinned to the byte-verified v286 shape and green. Full table in §7.

## 4. STAGED backlog carried to future rounds (priority order)

1. **Log/transcript secret-redaction engine** at v286 shape (#21/#22 — pre-existing whole-module gap; security-positive). **LANDED via the parallel OCC-143 round** (2026-10-02, `src/utils/secretRedaction/` byte-faithful whole-v286 engine rewrite — merged into main alongside this round; ledger `docs/upstream-version-gap-occ143-2026-10.md`). Closed here for bookkeeping.
2. **Auth refresh cross-process lock** (#5 — needs pid-liveness + takeover dialog + single-flight; also close the v285-baseline GCP three-state probe gap in the same round).
3. **Model/retry call-site wiring** (#11 dispatch sites, #13 notice plugin, #52 thrashing-breaker + call sites, #56 QueryModel dispatch + stream classifier) — engines all landed and tested; wiring points recovered in file headers.
4. **REPL queued-drain gray-flag wiring** (#55) — **LANDED in the acceptance-fix round** (2026-10-02; `makeQueuedDispatchOnQuery` wrapper + `onQuery` 9th param + turn-append threading; closed here for bookkeeping).
5. **RC SDK-host lane + transcript-append** (#12); **RC shutdown ack ordering** (#18).
6. **MCP protocol 2025-11-25 + connector stale-tools cache** (#24); **pending-link reuse decision** (#25 — reverses documented OCC hardening, needs owner decision).
7. **UI batches**: mouse/list (4/36/37/47/61/62/63), permission-prompt (3/45/46), pickers (50/64), /hooks rework (63), suggestions matcher (49), sendNow skill-shell (58).
8. **Subagent/agent-teams cluster** (28/29/30/31/32/43 — gated surfaces).
9. **/feedback bundle mode** at v286 shape (#23 reference design) and **marketplace admission validator** (#39 strings recovered).
10. **Exit worktree ordering audit** (#65, low priority).

## 5. Version bumps (this round)

- `README.md`: 4 places (L8 badge, L16 body, L65 table, L160 footer) 2.1.285 → **2.1.286** (OCC-101 P2-1 lesson: all four).
- `src/entrypoints/cli.tsx`: `MACRO.VERSION` "2.1.285" → **"2.1.286"** (dev polyfill).
- `package.json`: 2.1.363 → 2.1.364 → **2.1.365** (OCC release version; tag/publish happens after 验收 acceptance — not this round). **Renumber note**: the parallel OCC-143 round (`f40c4ed`) landed on main mid-run and claimed 2.1.364, so this round's release ships as **2.1.365** (same precedent as OCC-103's 2.1.362→2.1.363 renumber). The two rounds were combined with a real `git merge` (conflicts only in `README.md` + `CHANGELOG.md`, resolved by chaining both rounds' text; both 2.1.286 catch-up rounds triaged the same 88-entry changelog independently and their ports are disjoint — this round STAGED #21/#22 redaction exactly where OCC-143 landed it, see §4 item 1).
- `CHANGELOG.md`: `## 2.1.365 - 2026-10-02 (official 2.1.286 alignment — OCC-104 round)` entry added, above OCC-143's `## 2.1.364` section.

## 6. Files touched (this round)

New: `src/bridge/bridgePolicyRefusal.ts`, `src/utils/plugins/npmSpecValidation.ts`, `src/utils/model/{fastRejection,modelLadder,contextDropNotice}.ts`, `src/services/api/modelCallRetries.ts` + 13 new test files (`*286.test.ts`).
Modified: `src/services/mcp/displaySanitize.ts`, `src/utils/sessionStorage.ts`, `src/utils/messages.ts`, `src/utils/conversationRecovery.ts`, `src/tools/WebFetchTool/utils.ts`, `src/cli/handlers/auth.ts`, `src/utils/auth.ts`, `src/services/api/withRetry.ts`, `src/utils/model/deprecation.ts`, `src/cli/print.ts`, `src/state/promptsAwaitingModel.ts`, `src/utils/promptEditor.ts`, `src/components/PromptInput/PromptInput.tsx`, `src/utils/envUtils.ts`, `src/utils/attachments.ts`, `src/query/stopHooks.ts`, 9 tool-consumer files (--bare), `src/bridge/{bridgeMain,initReplBridge}.ts`, `src/services/policyLimits/index.ts`, `src/utils/plugins/{npmPluginFetch,schemas}.ts`, 3 e2e pins (`version-2.1.200-uirest`, `workflow-permission-dialog-ctrl-g`, `version-2.1.152-198-model-retry-fallback` A16 — re-pinned to the byte-verified v286 trigger shape, see §7), + version files (§5).

## 7. Docker e2e results

Full containerized suite (`occ-e2e-runner`, image `occ-e2e:latest`, non-root, model creds forwarded; current round's src + dist + test/e2e synced in): **711 pass / 1 skip / 20 fail across 732 tests, 155 files** (1130s). The 20 fail lines are 13 unique tests (bun prints each twice: inline + summary).

**Classification — baseline A/B (decisive).** A clean baseline of `main` @793b605 (no round changes) was built in a host worktree, swapped into the container (src + test/e2e + dist), and the same files re-run standalone:

| Failing test (file) | New code | Baseline 793b605 | Verdict |
|---|---|---|---|
| Shift+Tab auto-mode opt-in dialog (repl-interactive) | fail | fail | **pre-existing** (documented since OCC-44) |
| effort-cap ⑤ runtime-3 clamped display (version-2.1.329) | fail (30s `waitForText('shift+tab')` timeout) | fail (identical) | **pre-existing** |
| effort-cap ⑥ ModelPicker capped note (version-2.1.329) | fail (identical timeout) | fail (identical) | **pre-existing** |
| screen-reader flat-render (version-2.1.208) | fail | fail | **pre-existing** |
| prompt-cache TTL env vars (version-2.1.108) | fail (`ANTHROPIC_API_KEY … required` thrown from `getAnthropicApiKeyWithSource` in the test's sanitized `bun -e` env; round's auth.ts diff touches none of `isAnthropicAuthEnabled`/`isClaudeAISubscriber`/the throw site) | fail | **pre-existing** (env-dependent) |
| resume PTY `occ --resume` (resume-command-name) | fail | fail | **pre-existing** (PTY in this container) |
| plan-approval labels ×2 (version-2.1.210) | fail (~122s real-model timeouts) | fail | **pre-existing** (container model-backend) |
| /feedback GitHub issue (commands-behavior, real model) | fail (60s) | fail | **pre-existing** |
| --append-system-prompt (real-coding, real model) | fail | fail | **pre-existing** |
| A16 fallback model-not-found pins (version-2.1.152-198-model-retry-fallback) | fail (stale pins) | pass (old pins + old code) | **pin staleness — FIXED this round** (see below) |
| occ update argv ×2 (occ-update-argv) | combined-run fail (0.3ms, `Cannot find module '../../src/…'` from the RO `/test/e2e` mount) | — | **invocation artifact** — passes 2/2 standalone from `/occ/test/e2e` |

**A16 re-pin (the only round-caused failure).** The v286 item-B trigger rewrite (byte-verified: `Kn=NJe||LJe`, `Pn=r.fallbackModel??(Kn&&firstParty?iOe(r):void 0)`, unconditional `tengu_api_model_not_found_fallback_triggered` with a `reason` field, `Tx` carrying the original error) legitimately replaced the v285-era text the test pinned (`fallbackTriggerReason !== null`, the `API model not found:` debug log — v286 dropped that log). Pins updated to the v286 shape (`isRefusalTrigger` + `resolveAccessFallbackModel` + `reason:` telemetry); file green **4 pass / 0 fail** on the new code. All other v285 markers the file pins (`isModelNotFoundError`, `"type":"not_found_error"`, `getFallbackTriggerReason`, `public readonly trigger`, …) still present — verified by grep before re-pinning.

**Conclusion: zero regressions attributable to the 2.1.286 round.** 12/13 unique fails reproduce identically at baseline; 1 was the pin-staleness above (fixed); the occ-update-argv pair is a launch-path artifact of running the suite from the RO mount.


## 8. 2.1.287 pre-triage (STAGE only — no alignment this round, per directive)

2.1.287 published 2026-10-01 (`latest`/`next`; `stable` remains 2.1.285), ~110 changelog entries. **No binary downloaded, no forensics performed this round** — recorded for the next round's kickoff:

**Security-relevant (next-round top priority):**
- Dangerous `rm` (on `/` or `$HOME`) losing its always-ask safeguard when the same command redirects to a `~`/wildcard path — permission-integrity fix; OCC has the bash AST/legacy permission chain (2.1.223 parity) → likely OCC-AFFECTED; verify against OCC's redirect handling.
- Org per-tool permission ceilings silently dropped for an MCP tool named `__proto__` — prototype-pollution-class bug; check OCC's permission-map construction.
- Shell write through a repo-committed symlink onto a sensitive file / out of the working tree → name the target and wait for a human (now also `~` targets).
- Whole-tool `Bash` allow rules / allowing hooks must prompt (not run) for shell writes to files the file tools refuse outright (profile store, host credentials file).
- Sandboxed Bash on Linux inheriting an open handle on the Claude Code executable.
- `/feedback`+`/bug` pre-filled GitHub issue no longer includes recent error messages (data-exposure trim).
- `plugin marketplace add --sparse` / `git-subdir` failing with "transport 'http' not allowed" — interacts with OCC's git-disabled npm lane (#60 port) and the 2.1.280 credential-helper divergence.
- Revoked claude.ai login showing generic `API Error: 401` → "OAuth token revoked" (`-p`: "Failed to authenticate" prefix).

**Likely large surfaces (need dedicated rounds):** Claude Mods ("plugins may now modify deeper behavior") + built-in `cc-plugin-you-should-know` mod; MCP 2025-11-25 URL prompts / `bareElicitationCapability`; Opus 4.7+/Fable 1M-context default on Bedrock/Vertex/Foundry/gateway; `alwaysLoad:false` tool-search deferral; large-MCP-result memory/stream rework; screen-reader batch (~8 entries); agents-view `n:` filter + queued-reply semantics; oldest-first permission prompt ordering; ~30 [VSCode]/[Cloud]/[Claude Tag]/[Code Review] PLATFORM entries (expect NO-OP).

**Interactions with this round's STAGED backlog:** #24's protocol `2025-11-25` gains a second consumer (URL prompts); the MCP connector double-call fix ("server changed which protocol version it supports") pairs with #24's cache-invalidation half; "model fallback repeating on every later message after a mid-reply switch" (`-p`/SDK) touches the #11/#56 wiring; "folder CLAUDE.md attached twice after resume/compaction" pairs with #31.
