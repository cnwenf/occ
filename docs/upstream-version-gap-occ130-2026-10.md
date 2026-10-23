# Upstream Version Gap — OCC-130 Round (2026-10): claude-code 2.1.306 → 2.1.308

> Status: **IMPLEMENTED + VERIFIED** — §1 baseline · §2 triage · §3 implementation · §4 tests done · §5 release pending (gated on 安全审核员 → 验收员).
> Prior-round ledgers: [upstream-version-gap-occ165-2026-10.md](./upstream-version-gap-occ165-2026-10.md) (2.1.304→2.1.306, released v2.1.396), [upstream-version-gap-occ128.md](./upstream-version-gap-occ128.md) (2026-09 era, unrelated numbering).
> Skill discipline: `upstream-tracking` + `aligning-with-official-binary`. Official ELF **never executed** — `strings` / `grep -aboF` / bounded `dd` only.
> Note: an older `docs/upstream-version-gap-occ130.md` (2026-09-19, 2.1.274→2.1.276) predates the workspace renumbering — this file is the 2026-10 OCC-130 round.

## 1. Baseline

| Item | Value |
|---|---|
| Round | OCC-130 — daily autopilot catch-up, started 2026-10-23 01:00 Asia/Shanghai |
| Dedup check | No in-flight tracking round (OCC-125/126/128 done; only OCC-67 learn-ai in_progress, unrelated) → real round |
| OCC tracked official version before round | **2.1.306** (package `@cnwenf/occ` 2.1.400, main HEAD `d1768898`, README badge 2.1.306 partial) |
| Official latest at round start | **2.1.308** — npm dist-tags latest/next/stable all `2.1.308` (2.1.308 published 2026-10-22T04:19Z; 2.1.307 2026-10-21T20:47Z) |
| Official v306 ELF | md5 `69a7802bcefd854df2f16ecc9c08404d`, 290,532,720 B (matches OCC-165 ledger — baseline continuity) |
| Official v307 ELF | md5 `f76b1fb0bfbbb96dddc298fb0053e448`, 291,974,512 B; `VERSION:"2.1.307", BUILD_TIME:"2026-10-21T19:40:02Z", GIT_SHA:"b208bbbc…"` |
| Official v308 ELF | md5 `b6f2a180949e09189d748852a49535cd`, 292,232,560 B; `VERSION:"2.1.308", BUILD_TIME:"2026-10-22T03:28:37Z", GIT_SHA:"320f66eb…"` |
| Changelog delta | 44 entries (2.1.307: 43, 2.1.308: 1 = "Bug fixes and reliability improvements") |
| Strings delta | v306→v307: 19,490 new unique; v307→v308: 9,079 new unique (both dominated by re-minification churn) |
| Collision check | origin/main == branch base `d1768898` at round start; no parallel round landed |
| Method | Byte-level forensics on v306/v307/v308 ELFs; 2 parallel research passes (cluster A: API/model/telemetry/skills + v308 delta; cluster B: MCP/sessions/tools/agents/permissions/UI). Cluster B full report preserved as issue comment `b300acf8` |

### v308 delta verdict (A9) — **no-op rebuild**

2.1.308 carries no portable surface beyond 2.1.307. Evidence:

- Zero new env var names (`CLAUDE_CODE_*` / `ANTHROPIC_*` set-diff v307→v308 = 0).
- Zero new statsig flags (`tengu_*` set-diff = 0; v307 had added 39 vs v306 for contrast).
- Zero truly-new user-visible sentences: every ≥40-char sentence-like string in new308.txt also occurs in v307 strings (per-sentence `grep -F` filter — empty result).
- All v307 port-target regions byte-stable in v308: `h=Mt(r).trim()` 1/1, browser/computer-use budget clause 2/2, `assumesFirstPartyBaseUrl` 4/4, `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS` 10/10, `onlyConfigHeaders` 3/3, `safety_event` 3/3, `api-version-migration` 3/3, `e.status===403?` 4/4, `prompt-caching-scope` 2/2.
- The apparent `2026-10-21` count collapse is a BUILD_TIME artifact (v308 built 2026-10-22); SDK default `anthropic-version":"2023-06-01"` unchanged (32 hits both).

→ Catch-up target = **2.1.307 semantics**; all PORT specs below verified v308-stable.

## 2. Triage — all 44 delta entries

### PORT (15)

| # | Entry (official 2.1.307) | Cluster | Key official evidence (v307 ELF) | OCC target |
|---|---|---|---|---|
| P1 | `/claude-api api-version` → **see STAGED S1** | — | — | — |
| P2 | `claude_code.safety_event` OTel event per stopped/prompted/sent-back tool call | A2 | Emitter `Si("safety_event",…)` body `claude_code.${name}`; attrs `category,decision,decision_source,reason_type,reason_code,rule_source,grant_scope,circuit_breaker,classifier_category,tool_name(allowlist→other_tool),tool_use_id,tool_source,sandbox_violation_count,sandbox_enabled,permission_mode`; value regex `/^[A-Za-z][A-Za-z+:-]{0,199}$/`; categories `TYr` 9-value allowlist; decision_sources `EYr` 7-value; category derivation `CYr`/`HMn` prefix-map; skip when category undefined; gate `tengu_snoopy_creek` default true | NEW `src/hooks/toolPermission/safetyEvent.ts` + call in `permissionLogging.ts` after `tool_decision` emit |
| P3 | `CLAUDE_CODE_DISABLE_1M_CONTEXT` + `[1m]` alias model-not-found fix | A3 | Whole fix = alias resolver `h=s?Mt(r).trim():r` → `h=Mt(r).trim()` (unconditional suffix-strip before alias switch); v306 `Dt` @s306:312633 vs v307 `Lt` @s307:314090 byte-identical otherwise; failure mode: DISABLE_1M + `opus[1m]` → raw passthrough → API 404 | `src/utils/model/model.ts` `parseUserSpecifiedModel` (~:917-1010) one-line fix |
| P4 | `prompt-caching-scope` beta suppressed behind custom `ANTHROPIC_BASE_URL` / Foundry | A4 | v306 gate `{beta,when:e=>e.firstPartyOnlyBetas}` (firstParty∨aws∨googleCloud∨foundry) → v307 `D8()`: `Qy() ∧ Ni() ∧ provider∈{firstParty,anthropicAws}`; `Ni()` = assumes-first-party-base-url (env unset ∨ host==api.anthropic.com ∨ `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`); second site (global-cache push) unchanged | `src/utils/betas.ts:261` + push site :427-430 |
| P5 | WebSearch budget-exhausted notice + browser/computer-use clause | A7 | v307 builder inserts `by querying them in a browser or through a computer-use tool` into the do-not-work-around sentence; session-no-refill variant strings verbatim in spec | `src/tools/WebSearchTool/WebSearchTool.ts:270` (OCC still pre-refill-era message) |
| P6 | Web-search/API 403 reason shown (CCR/cloud sessions) | A8 | v307 CCR branch: `status===403 → ftr(e)` nested-body reason extractor (`error.error.message` → `error.message`, HTML→`<title>`), content `API Error: 403 <reason>` capped to 1000 (`MLe`), fallback generic `k6t`; gate `CLAUDE_CODE_REMOTE` | `src/services/api/errors.ts:1024-1029` (OCC = v306 behavior) |
| P7 | MCP macOS keychain-locked: say why + no re-sign-in after unlock | B1 | New `McpCredentialStoreUnavailableError` (`code=CREDENTIAL_STORE_UNAVAILABLE`), 2 modes (unreadable / read-too-late) with verbatim messages; per-server strict keychain probe `Are(e)` gated on backend=keychain ∧ 401-challenged ∧ no cached creds, `inaccessibleAs:"failure"`, 30s/1s caches; sentinel `gl` ≠ undefined; log `Credential store could not be read (the login keychain may be locked); not reporting credentials as absent` | `src/services/mcp/auth.ts:628` (plain read = official bug), new error class; strict-read primitives already exist (`transientRead.ts`) |
| P8 | MCP sleep-recovery: CONNECT_SUSPENDED redial, no sticky headless failure | B2 | `Hie="CONNECT_SUSPENDED"`; wall−awake gap > `aZs=1000`ms on CONNECT_TIMEOUT → message `MCP server "${name}" connection timed out. Your computer went to sleep or its clock changed while connecting.`; failure caching skipped for CONNECT_SUSPENDED (`if(le!==Hie)$o(…)`); redial ≤ `z=10` while cache entry current ∧ reconnect epoch unchanged; gate `tengu_mcp_connect_suspend_redial` default true; telemetry reason:"suspended" + counter `mcp_connect_suspended_${type}` | `src/services/mcp/client.ts:1750` timeout site, :2305-2343 failure path, memoized connect (failed results currently cached = same bug) |
| P9 | HTTP MCP tool calls: retry only read-only/idempotent on mid-call close | B3 | `McpSessionExpiredError` v306 (2 kinds, unconditional retry) → v307 `SO` 4 expiryKinds + `mayHaveRun` (true only `connection_closed_http`); retry gate `Qt<1 ∧ (!mayHaveRun ∨ isConcurrencySafe ∨ idempotentHint===true)`; send-tracking `rNn`/`oNn` (per-call watchdog by `_meta["claudecode/toolUseId"]`, ran-nothing codes `ECONNREFUSED/ConnectionRefused/ENOTFOUND/EAI_AGAIN/FailedToOpenSocket/ERR_PROXY_TUNNEL`); result-text renderer `z_` verbatim strings (em-dash) | `src/services/mcp/client.ts:190, :2824-2829, :4527-4540` (OCC = v306) |
| P10 | Turn starts with SDK MCP server's latest tools (background task case) | B4 | v307 pending predicate adds in-flight refresh counter `Ge`; beforeDrain waits with budget regardless of sync; new `sdkToolRelistJoin(e)` race-wait (`shouldQuery!==false ∧ !sdkMcpBackgroundRetry ∧ pending`) with budget `dWe()` = `MCP_CONNECT_TIMEOUT_MS`>0 ? min(env,2^31−1) : 5000; log `sdk_mcp_relist_wait {budget_ms,waited_ms,timed_out,tools_change_still_pending}`; wired `sdkMcpServersJoin:({command})=>uf.join(I)??fi.sdkToolRelistJoin(I)` | `src/cli/print.ts:1597 updateSdkMcp` (fire-and-forget at :2016/:3289 = the bug), `src/services/mcp/useManageMCPConnections.ts:652-700` |
| P11 | `/permissions` Recently denied shows the command; approve names command | B6 | Record site adds `command` (shell-family ∧ ¬mcpInfo) + `inputKey` (`uee`: shell → `{command}`); UI: focused-row command reveal `Command for row ${H+1}:`, maxRows 8, ctrl+o expand, gutter `… and ${n.toLocaleString("en-US")} more ${…} not shown; approving grants the whole command`, suffixes `" (retry)"`/`" (approved)"`; exit meta message `$n`: `Permission granted for: ${list}. You may now retry ${n===1?"this command":"these commands"} if you would like.` with full command when cutChars>0; `metaMessagesOrigin:{kind:"auto-continuation"}` new | `src/utils/autoModeDenials.ts:23-38`, `src/hooks/useCanUseTool.tsx:83`, `RecentDenialsTab.tsx`, `PermissionRuleList.tsx:813` (OCC = v306 display-based bug) |
| P12 | `/help` + `/` menu show short descriptions for bundled skills | B7 | v307 `p1e(e)`: prompt-type ∧ bundled-skill → `menuDescription ∥ description`; converter `Ri` carries `menuDescription` (skip function-valued); claude-api def `menuDescription:"Build and debug apps that use the Claude API"`; SDK tables keep raw description | `src/skills/bundled/claudeApi.ts:180-198`, `src/components/HelpV2/Commands.tsx:41`, `src/utils/suggestions/commandSuggestions.ts:284,293`; keep raw at `src/cli/print.ts:3344,4755` |
| P13 | Unparseable tool call retried up to 2× before ending turn | B12 | v306 boolean single-retry → v307 `cf=2; oi(e){return e<cf}` counter `malformedToolUseRetryCount`; trigger `stop_reason==="tool_use" ∧ 0 tool_use blocks ∧ ¬isApiErrorMessage`; retry: tombstone turn responses + meta user msg `The previous response failed to produce a valid tool call. Please retry the tool call now.` (`turnCompanion:!0`) + transition `{reason:"malformed_tool_use_retry"}`; exhausted: `createAssistantAPIErrorMessage("The model's tool call could not be parsed (retry also failed).")`; classifier `au` → `succeeded/malformed_again/gave_up/end_turn/other`; leaked-invoke regex `<antml:invoke\b`; telemetry `tengu_malformed_tool_use_response {will_retry,retry_count,model,text_has_leaked_invoke}` + `tengu_malformed_tool_use_retry_outcome {model,outcome}` | `src/query.ts` (OCC has NEITHER v306 boolean nor v307 counter — port v307 end state; sibling pattern `thinkingOnlyNudge.ts`) |
| P14 | Fork subagents launched together: each told which launch is its own | B13 | v306 uniform `Fork started — processing in background` → v307 `Kbo(e,n,r)`: own-id `y = blocks.length===1 ? blocks[0].id : r`; per block: other → `This is the parent's call, not yours. It may not have run yet, and its result goes to the parent.`; own ∧ fork-launcher → `Fork started — that fork is you.`; own ∧ other tool → `This call started a fork, and that fork is you. The call's other work and its result belong to the parent.` | `src/tools/AgentTool/forkSubagent.ts:279,:293,:327-343` (has TODO(smoosh) at exact site) |
| P15 | `axScreenReader` + `CLAUDE_AX_SCREEN_READER` env-block: user/managed/`--settings` only (since 2.1.305 — prior-round gap) | B14 | v306≡v307 (delta zero; introduced ≤2.1.305): settings branch reads `f8("axScreenReader")` over `["policySettings","flagSettings","userSettings"]` filtered by enabled sources (`en/Qt`); warning `U()` two variants: short `Screen reader mode is off: project settings can't turn it on. To turn it on, start Claude Code with --ax-screen-reader.` / long adds `, or add "axScreenReader": true to your own settings file at ${path} and restart.`; schema describe ends `Ignored in project and local settings.` | `src/utils/screenReader.ts:106` (reads MERGED settings = the bug), `src/main.tsx:1429`, `src/utils/settings/types.ts:1088-1092` |
| P16 | Browser sign-in success page before profile load | B15 | v306: exchange → await profile → redirect; v307: exchange → `handleSuccessRedirect` FIRST → profile fetch after; OAuth callback listener byte-identical | `src/services/oauth/index.ts:98-135` (OCC = v306 order; guard error-redirect after success-redirect sent) |

### STAGED — real OCC surface, deliberately deferred (2)

| # | Entry | Why staged |
|---|---|---|
| S1 | `/claude-api api-version` subcommand (A1) | Feature payload = skill `.md` content (`shared/api-version-migration.md`, 25,816 B extracted to `/tmp/cc-diff-308/v307_api-version-migration.md`; SKILL.md router row). OCC stubs bundled-skill `.md` files by design (OCC-44 trim policy; `prompt-audit` staged on same precedent). Porting router word without doc body = subcommand routing to a stub — worse than absent. Forensics recorded: subcommand list `L=[…,"api-version",…]`, migration 2023-06-01→2026-10-21, 4 BREAKS (temperature/top_p/top_k removal → 400; assistant document block → 400; user text block w/ non-empty citations → 400; Admin API field renames), guide `platform.claude.com/docs/en/api/migration-2026-10-21`. SDK default header unchanged (`2023-06-01` 32× both) — feature is migration guidance, not default bump |
| S2 | A3 companion window-math (`apiContextWindowWithoutOptIn`, `pSt=200000`, claude-mythos-preview `I0={window:1e6,native_1m:!0}`, compact-cap condition change) | OCC model-info/compact-cap structures differ; needs its own mapping pass. Core user-facing fix (P3) lands this round; forensics recorded in research report |

### N/A — no OCC surface / already aligned (27)

| Entry | Verdict basis |
|---|---|
| `/autocompact` cloud window persistence | Cloud sessions infra (unported) |
| `/clear` cloud/runner revival | Cloud sessions infra |
| `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS` in apps-gateway (A5) | Byte-watchdog + routed-provider gateway subsystem never ported (0 hits in src/); forensics recorded (`py()` gateway arm, `hi()` gate, clamp [1e4,18e5]) |
| `OTEL_EXPORTER_OTLP_HEADERS` apps-gateway relay (A6) | Gateway OTLP relay path (`onlyConfigHeaders`, session-ingress `worker/otlp` rewrite) unported; no host code to attach to |
| Autocompact thrashing large tool results (B5) | Fix = new gate on rapid-refill breaker (`tengu_sleepy_ripple`, `keepNoRound`, queued-command `Wft` guard); OCC has no rapid-refill breaker (STAGED since 2.1.286, `contextDropNotice.ts:23`) — bug cannot occur. Forward note: port v307 semantics (keepNoRound day one) when breaker lands |
| Subagent transcript placeholder usage (B8) | Already aligned: OCC mutates yielded assistant message in place on `message_delta` (`claude.ts:3721-3772`, 2.1.281 #021) + lazy serialization → structurally immune |
| SDK `setModel()` 5s→15s (B9) | Official probe deadline 5000→15000 (`vDn=15000`); OCC `set_model` handler (`print.ts:3134-3172`) applies without confirmation probe — unmappable until probe exists |
| Background command stopped notice (B10) | `source`/`outputFile` on stop notice targets connected-app (KAIROS/bridge) surface — disabled in OCC builds; unreachable |
| WebFetch 4xx normal result (B11) | Cowork-cloud-executor fix; OCC local `WebFetchTool.ts:295-317` already renders 4xx as normal result — already aligned |
| GitHub MCP desktop Code-tab form | Desktop app surface |
| Artifact tool connection reset (B16) | OCC `ReviewArtifactTool` = auto-generated stub; official fix inside unported subsystem; ECONNRESET marker counts equal v306/v307 |
| Self-hosted runner ×4 (git-proxy settings commit, checkout-hook orphans, checkout-hook 30-min timeout, cert filtering) | Runner product unported |
| VSCode ×7 (dictation notice, pinned-prompt cap, LaTeX paste, NODE_EXTRA_CA_CERTS dictation, still-open notice, dictation cert filter, extension cert filter) | VSCode extension surface |
| Cloud sessions ×2 (repo picker "Searching…", waiting-for-runner count-up) | Cloud web UI |
| Remote Control connect time (large pasted images) | Remote Control infra unported |
| Cloud first-reply when desktop MCP can't connect | Cloud sessions infra |
| `@claude review stop` (Code Review) | GitHub Action backend |
| 2.1.308 "Bug fixes and reliability improvements" | No-op rebuild — §1 evidence (A9) |

## 3. Implementation record

All 15 PORT items landed (P1 → STAGED S1). Executed as 9 parallel work packages (A-items in the orchestrator session; B-items via subagents). Official ELFs never executed — all payloads byte-recovered from the v307 text dump (`grep -aboF` + bounded `dd`).

| # | Package | Files (new ✦ / modified) | Tests | Notes & documented deviations |
|---|---|---|---|---|
| P2 | A2 safety_event OTel | ✦ `src/hooks/toolPermission/safetyEvent.ts` (923 lines: emitter, 9-value category allowlist `TYr`, 7-value decision_source `EYr`, `CYr`/`HMn` prefix-map, value regex, tool_name allowlist→`other_tool`, `tengu_snoopy_creek` gate default-true) + `permissionLogging.ts` call after `tool_decision` | 77 (safetyEvent307) | — |
| P3 | A3 `[1m]` alias fix | `src/utils/model/model.ts:~923` — unconditional suffix strip `normalizedModel.replace(/\[1m]$/i, '').trim()` before the alias switch (official `h=Mt(r).trim()`) | 13 (context1mAliasFix307) | Deviation: OCC keeps its raw-passthrough branch for unknown aliases (official shape differs); `opus[1m][1m]` double-suffix strips once, matching official single `.trim()`-pipeline pass |
| P4 | A4 prompt-caching-scope D8 gate | ✦ `shouldIncludePromptCachingScopeBeta()` in `src/utils/betas.ts` + push-site switch | 15 (promptCachingScopeBeta307) | Deviations (in-file docblock): faithful-D8 reduction instead of literal `Qy∧Ni∧arm` conjunction; hipaa arm of `L1` omitted (no OCC taint registry — same precedent as `shouldSendExtendedCacheTtlBeta`); anthropicGoogleCloud folded into firstParty (no separate OCC provider); claude.ts second push site verified UNCHANGED (source-guard test) |
| P5 | A7 WebSearch budget notice | `src/tools/WebSearchTool/WebSearchTool.ts:267-299` — session-no-refill variant, verbatim browser/computer-use + third-party-reader clauses, `plural()` + `BASH_TOOL_NAME` | 9 (webSearchBudgetNotice307) + 5 updated (webSearchCap) | Deviations: settings-hint tail unconditional (no `Por()` surface in OCC); turn-budget/refill machinery and `searchCount:0` data field not ported (OCC data shape = query/results/durationSeconds) |
| P6 | A8 CCR 403 reason | `src/services/api/errors.ts` — `CCR_AUTH_REASON_MAX_CONTENT_LENGTH=1000`, 4 extractor helpers after `isCCRMode` (~:299, `error.error.message`→`error.message`→HTML `<title>` chain), rewritten CCR branch (~:1110) | 12 (ccrForbiddenReason307) | Deviations: conservative `slice(0,budget)` for the unrecovered `Ot` truncation helper; second CCR site (x-api-key ~:1021) left unchanged (official v307 also unchanged there) |
| P7-P9 | B1+B2+B3 MCP trio | ✦ `src/utils/mcp/credentialStoreErrors.ts` (`McpCredentialStoreUnavailableError`, 2 verbatim modes), ✦ `src/services/mcp/sendTracking.ts` (175 lines: `rNn`/`oNn` per-call watchdog by `_meta["claudecode/toolUseId"]`, ran-nothing code set), ✦ `src/services/mcp/sessionRecoveryText.ts` (122 lines: `z_` renderer, em-dash verbatim), `src/services/mcp/auth.ts` (strict keychain probe `Are(e)`: backend=keychain ∧ 401-challenged ∧ no cached creds, `inaccessibleAs:"failure"`, 30s/1s caches), `src/services/mcp/client.ts` (CONNECT_SUSPENDED `Hie` + sleep-gap `aZs=1000`ms detection + failure-cache skip + redial ≤10 with epoch guard + `tengu_mcp_connect_suspend_redial`; `SessionExpiryKind` 4 kinds + `mayHaveRun` + `shouldRetryAfterSessionRecovery` gate `Qt<1 ∧ (!mayHaveRun ∨ isConcurrencySafe ∨ idempotentHint)`) | 39 new; MCP suite 576/0 | — |
| P10 | B4 SDK tool relist | ✦ `src/utils/mcp/sdkToolRelist.ts` (221 lines: `sdkToolRelistJoin` race-wait, budget `dWe()` = `MCP_CONNECT_TIMEOUT_MS`>0 ? min(env, 2^31−1) : 5000, `sdk_mcp_relist_wait` log fields), `src/cli/print.ts` (5 hunks incl. `sdkMcpServersJoin` wiring), `src/services/mcp/useManageMCPConnections.ts` (in-flight refresh counter `Ge` + beforeDrain budget wait) | 21 | 4 shared-process-leak failures in the package run triaged NOT-B4 (mock.module leakers; see §4) |
| P11 | B6 /permissions denials | ✦ `src/utils/permissions/denialDisplay.ts` (pure-logic layer: `inputKey` `uee`, reveal strings, gutter `… and N more`, `" (retry)"`/`" (approved)"` suffixes, `$n` exit-meta message, `metaMessagesOrigin:{kind:"auto-continuation"}`), `src/utils/autoModeDenials.ts` (+47: `command`/`inputKey` record), `src/hooks/useCanUseTool.tsx` (+67), `RecentDenialsTab.tsx` (358-line rewrite: focused-row command reveal, maxRows 8, ctrl+o expand), `PermissionRuleList.tsx` (+47) | autoModeDenials307 + denialDisplay307 (in 124-total below) | — |
| P12/P14/P16 | B7+B13+B15 | `src/skills/bundled/*.ts` (7 files: `menuDescription` on definitions incl. claude-api verbatim), `src/skills/bundledSkills.ts`, `src/components/HelpV2/Commands.tsx:41`, `src/utils/suggestions/commandSuggestions.ts:284,293` (`p1e` port; SDK tables in `print.ts:3344,4755` keep raw); `src/tools/AgentTool/forkSubagent.ts` (`Kbo` per-block own-launch identification, TODO(smoosh) site removed); `src/services/oauth/index.ts` (`handleSuccessRedirect` BEFORE profile fetch) | 40 new; targeted 378/0 (menuDescription307, forkOwnBlock307, successRedirectOrder307 + suites) | 2 pre-existing mock.module leakers triaged not-this-package (`fork.test.ts`, `reloadSkills299.test.ts`) |
| P13 | B12 malformed tool_use retry | ✦ `src/query/malformedToolUseRetry.ts` (`cf=2` counter state, tombstone + `turnCompanion` meta user msg verbatim, `{reason:"malformed_tool_use_retry"}` transition, exhausted message, `au` classifier → 5 outcomes, leaked-invoke regex `<antml:invoke\b`, both telemetry events), `src/query.ts` (trigger: `stop_reason==="tool_use" ∧ 0 tool_use blocks ∧ ¬isApiErrorMessage`) | malformedToolUseRetry307 (in 124-total below) | OCC had neither the v306 boolean nor v307 counter — v307 end state ported directly per triage |
| P15 | B14 axScreenReader env-block | `src/utils/screenReader.ts:106` (read restricted to `["policySettings","flagSettings","userSettings"]` ∩ enabled sources — no longer merged settings), `src/main.tsx` (warning `U()` short/long variants verbatim incl. `${path}`), `src/utils/settings/types.ts:1088-1092` (describe ends `Ignored in project and local settings.`) | screenReader307 (in 124-total below) | — |

Combined B6/B12/B14 targeted gate: **124 pass / 0 fail**. All A-item gates re-verified on the combined tree post-merge of packages.

## 4. Test record

### Full-suite A/B vs pristine main baseline

Method note: single-process `bun test src` **hangs identically on BOTH the worktree and the pristine baseline** (freezes after `src/utils/hooks/__tests__/agentHookTrust.test.ts` at a bare-clone fixture; every candidate file passes standalone — pre-existing context-dependent shared-process hang, not introduced this round). Workaround: partitioned per-directory-group sweep (G01–G09, `timeout 900 bun test` per group) on both trees. Baseline = `git archive HEAD` (`d1768898`) extracted pristine + symlinked node_modules.

| Group | Scope | Worktree pass/fail | Baseline pass/fail | Fail-name diff |
|---|---|---|---|---|
| G01 | bridge/cli/commands/constants/daemon/entrypoints/hooks/ink/keybindings/memdir/native-ts/query/screens/skills/state/tasks/__tests__/vim | 1857 / 12 | 1740 / 12 | identical |
| G02 | components | 484 / 0 | 426 / 0 | identical (0) |
| G03 | services | 1552 / 77 | 1441 / 77 | identical |
| G04 | tools | 2131 / 8 | 2108 / 10 | **−2**: two `2.1.206 #5 EnterWorktree out-of-tree confirmation` baseline failures now pass |
| G05 | utils/{hooks,mcp,model,permissions,bash,git} | 1381 / 3 | 1368 / 4 | **−1**: `2.1.285 execCommandHook stdio flags test-05` (timing-sensitive daemon/pipe test) passes this run |
| G06 | utils/{plugins,settings,suggestions,telemetry,processUserInput,sandbox} | 1188 / 0 | 1188 / 0 | identical (0) |
| G07 | remaining utils subdirs | 273 / 0 | 273 / 0 | identical (0) |
| G08 | utils/__tests__ | 3335 / 12 | 3271 / 12 | identical |
| G09 | top-level stray tests | 38 / 0 | 38 / 0 | identical (0) |
| **Total** | | **12239 / 112** | **11853 / 115** | |

**Verdict: zero regressions.** +386 pass (new round tests), net −3 fail, fail-name sets identical in 7/9 groups, **zero failures present only in the worktree**. Remaining 112 failures are pre-existing baseline failures (name-identical), incl. the known 2 mock.module leakers (`fork.test.ts`, `reloadSkills299.test.ts`) and the G03 services set.

### Build + e2e smoke (live API, 2026-10-23)

- `bun run build` green — `dist/cli.js` 30.46 MB, MACRO.VERSION 2.1.400.
- Headless: `echo "say PONG" | bun run dist/cli.js -p` → `PONG`, exit 0 (`unrecognized_model` gateway warning is pre-existing env noise).
- tmux REPL round-trip: boot → `say REPLPONG` → model reply `REPLPONG` rendered; status line shows globalVersion 2.1.400.
- Biome lint over all 58 changed/new source files: **0 errors**; 11 warnings all in `src/main.tsx` and byte-identical to the baseline file's warnings (pre-existing).

## 5. Release (record)

_(filled at release time, gated on 验收员 acceptance)_
