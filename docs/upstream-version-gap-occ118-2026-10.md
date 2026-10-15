# Upstream Gap Ledger — OCC-118 Round (2026-10-16)

**Baseline:** official Claude Code latest = **2.1.300** (npm dist-tags: `latest` 2.1.300 published 2026-10-14T14:27:26Z — was `next` pre-release last round, now promoted; `next` 2.1.301 published 2026-10-15T14:34:23Z, pre-release channel only, **no 2.1.301 CHANGELOG section** → pre-triage archive only, NOT aligned per OCC-95 convention; `stable` = **2.1.292**, advanced from 2.1.287). Official **2.1.300 CHANGELOG section = 88 entries** (8 Added + 41 Fixed + 1 Self-hosted runner + 4 Improved + 11 Changed + 1 Removed + 12 `[VSCode]` + 2 `[Cloud sessions]` + 1 `[Remote Control]` + 5 `[Claude Tag]` + 2 `[Code Review]`). OCC main HEAD = `b5e0591` (docs-only, after tag **v2.1.383**); package.json `2.1.383`; main CI green. OCC README Tracks (4 sites) = **2.1.299 (partial)** at round start.

**Gap verdict:** OCC aligned through 2.1.299; official latest = 2.1.300 → **this round aligns 2.1.299 → 2.1.300** (88 entries triaged below).

**Forensic artifacts (this round):** `@anthropic-ai/claude-code-linux-x64@2.1.299` ELF md5 `fee7941c357b984808a5e87abab47d5c` (matches occ158 record — chain-of-custody intact) and `@2.1.300` ELF md5 `db0f0a5dc2fd7f82584283d4817b61a1` (266,972,344 bytes; v299 = 265,342,136). Strings diff (`strings -n 8 | sort -u`, comm): **19233 new / 17294 removed** strings (s299=323791, s300=325730). **Discipline: the official ELF is NEVER executed** — `strings` / `grep -aboF` / bounded `dd` only (occ115/occ158 precedent). Behavioral A/B uses runnable channels only (`uvx claude-code` / npm JS package) per Leader ruling.

**Never invent.** Every PORT/STAGED disposition carries binary evidence (string/offset/dd excerpt) or a reproducible OCC-side run. Unevidenced items are marked CAND.

---

## 1. STAGED carryover re-adjudication (occ158 §7 authoritative entry)

**Trigger check — NOT fired.** occ158 §7 carries the STAGED set whose re-adjudication trigger is "official `stable` dist-tag ≥ 2.1.296". Verified this round via `npm view @anthropic-ai/claude-code dist-tags --json`: `latest` = 2.1.300, `next` = 2.1.301, **`stable` = 2.1.292**. 2.1.292 < 2.1.296 → trigger did NOT fire; the occ158 STAGED set carries over **as-is** (incl. #106/#108 sandbox-runtime symlink bypass, #107 glob brace divergence, #109 worktree awk acceptance, #150 workflow VM depth-guard behavioral probe, #073 resume double-run inheritance check, E-cluster #002/#003 idle-compaction, #009 FleetView slash input, #019 gateway compaction limit, #066 oversized-image reattach, #104 MCP reconnect lifecycle, #140 PDF bytes, #061/#063/#083/#084 render family).

**New-evidence scan in the 2.1.300 strings delta:** carried-STAGED gate vocabulary counted in `new_strings.txt` vs `removed_strings.txt`: `gate_off` 28/28, `auto_default_nudge` 7/7, `idleCompaction` 2/2, `IDLE_COMPACT` 4/4, `strictAllowlist` 7/7, `mcp_server_errors` 2/2, `workflowSizeGuideline` 12/12, `getOfferedWidth` 2/2, `CellSegmenter` 1/1, `nesting` 18/18 — **every family shows new==removed (minifier-rename signature, same as occ158's 296→299 scan)**. #150 anchor strings `nesting deeper than 28000/100000 levels is not supported` persist in s300 (2 hits each, count unchanged). No carryover item gains new porting evidence this round; none is re-adjudicated.

**occ158 §7 fix-forward candidates** (non-blocking, ranked) carry into this round's backlog: WP8 #152(b) cross-origin `beforeRedirect` OAuth-revocation check; WP8 #152(a) plain-user-http ≤5-hop redirect rule; §3 follow-ups 1–7.

## 2. Changelog triage — 88 entries (cluster files T1–T4)

Cluster assignment: **T1** = mods/OTel/cloud/Cowork/Slack/CodeReview/RC-diff/runner/desktop (33), **T2** = hooks/daemon/background/worktree/reftable/gateway (15), **T3** = session/resume/compaction/MCP/transcript/auth/network (14), **T4** = advisor/agents-view/tasks/UI/IDE/dim-text/skills + 12 VSCode (26). Total 88. Dispositions: **PORT / STAGED / N-A / ALREADY-ALIGNED**. Full per-cluster tables with binary evidence: `docs/gap-research-300/triage-T{1,2,3,4}.md`.

<!-- TRIAGE_TABLES -->

### Disposition summary — 88 entries

**PORT (21):** #2 #5 #10 #18 #19 #22 #24 #28 #29 #31 #33 #34 #36 #41 #43 #47 #55 #59 #63 #65 #66(dormant)
**STAGED (11):** #6 #15 #17 #30 #37 #40 #42 #46 #53 #61 #62
**ALREADY-ALIGNED (6):** #11 #23 #25 #38 #44 #56
**N-A (50):** all remaining (VSCode ×12, Claude Tag ×5, Code Review ×2, Cloud ×2, RC ×1, mods ×4, Cowork/Desktop/gateway/runner/misc)

### T1 — mods/OTel/cloud/Cowork/Slack/CodeReview/RC/runner/desktop (33) — `triage-T1.md`

| # | Disposition | One-line evidence |
|---|---|---|
| 2 | **PORT** ✅ landed | v300 api_request builder @227727872 adds cache_creation_5m/1h_tokens; v299 @226508395 zero hits |
| 6 | STAGED | gen_ai.* span attrs — module-wide span rework, beyond round budget |
| 25 | ALREADY-ALIGNED | OCC spawns `git rev-parse` per event — reftable-safe by construction |
| rest (30) | N-A | mods `$.ui` 0 hits; bridge dead behind BRIDGE_MODE; environment-runner + ReviewArtifactTool 3-line stubs; no Slack/Cowork/CodeReview-app surfaces |

Advisory (T1): OCC's fs-only `isInTransientGitState` (gitDiff.ts:308, commitAttribution.ts:869) shares entry #20's reftable blind-spot class — fix-forward candidate.

### T2 — hooks/daemon/background/worktree/reftable/gateway (15) — `triage-T2.md`

| # | Disposition | One-line evidence |
|---|---|---|
| 11 | ALREADY-ALIGNED | OCC gracefulShutdown.ts:476→:503 runs SessionEnd after bounded bg-kill; skip-path structurally absent |
| 12 | N-A | OCC has no `--restricted` flag (main.tsx grep 0; gap-research-291 precedent) |
| 24 | **PORT** | v300 gates worktree create behind `BHn()` hook dispatch @226762623; OCC setup.ts:233 creates worktree BEFORE loadPluginHooks :324-326 |
| 28 | **PORT** | NEW `was refused, running the agent hook on` @227967610; alias-resolve + caller-model fallback; OCC execAgentHook.ts:129 raw `hook.model`, fail-open |
| 29 | **PORT** | v300 `H=${K}^{commit}` pinned start-point + `--no-track -B`; OCC worktree.ts:422 passes branch NAME; watcher pinned pre-chdir |
| 30 | STAGED | NEW `tables.list` @217071395 — OCC gitFilesystem.ts has zero reftable read support; needs read-layer subsystem |
| 33 | **PORT** | v300 fetch-fail fallback resolves HEAD from `fromCwd` (current checkout) not main repo root; OCC worktree.ts:378→:390-393 uses bare/main root |
| 41 | **PORT** | v300 anti-poll clauses @228323540/@225820817; OCC BashTool.tsx:750/:752/:765 lack both |
| 43 | **PORT** | NEW `force-killing it (SIGKILL)`/`daemon_stop_still_running`; OCC lockfile.ts:260 unconditional `displaced:true`, daemon.ts:88-90 always exit 0 |
| 44 | ALREADY-ALIGNED | OCC daemon.ts:88-102 bare console.*, zero telemetry gating |
| 56 | ALREADY-ALIGNED | OCC ShellCommand.ts:363-368 immediate treeKill SIGKILL — strictly stronger than 1.5s wind-down |
| 58 | N-A | OCC has no `gateway` command (main.tsx:1524 comment-only) |
| 61 | STAGED | no handoff-file mechanism in OCC; carried-workflow flow needs decompilation first |
| 65 | **PORT** | `The tool input from the model was valid` 1→5 sites; OCC consumes raw updatedInput at toolHooks.ts:435/permissions.ts:492/toolExecution.ts:1273 |
| 66 | **PORT** (dormant) | NEW hint @109346400; OCC bridgeMain.ts:1866-1889 still accepts flags (BRIDGE_MODE dead code) — bundle with next bridge touch |

### T3 — session/resume/compaction/MCP/auth/network (14) — `triage-T3.md`

| # | Disposition | One-line evidence |
|---|---|---|
| 10 | **PORT** | v300 `TAn` warn-gate @239117077; OCC autocompact-noninteractive.ts:99-103 warns unconditionally |
| 18 | **PORT** | v300 `auto_held` latch (299:0→300:2) @227142599; OCC toolSearch.ts:728-772 recomputes per-request |
| 19 | **PORT** | v300 validates org UUID first, restores cred snapshot on `refused` @242589299; OCC auth.ts:1443-1459 saves unconditionally |
| 22 | **PORT** | v300 `sealTornTailOnNextAppend` @224821077; OCC sessionStorage.ts:846/:3334 blind-append onto torn tail |
| 23 | ALREADY-ALIGNED | OCC branch.ts:129 byte-`\n` split + projectPurge.ts directory-based — immune to U+2028/2029 |
| 36 | **PORT** | v300 classifier `/\btools\.(\d+)\.(?:custom\.)?input_schema\b/` @2929387 + `{type:"object"}` resend; OCC withRetry.ts:302-345 no hook |
| 37 | STAGED | logic-only delta (markers balanced); OCC leaf selection timestamp-only — no max_tokens detection |
| 38 | ALREADY-ALIGNED | OCC compact.ts:613-635 re-announces post-compaction + stateless per-turn diff |
| 40 | STAGED | same balanced-marker class as #37 — group together |
| 42 | STAGED | OS-cert TLS mechanism not string-recoverable; OCC growthbook.ts:554 surface real |
| 46 | STAGED | `loadedNames` mechanism recovered but OCC toolSearch.ts:124-151 name-memo only — no ledger to attach |
| 55 | **PORT** | v300 strip set @216531261 (9 proxy + 14 CA-bundle vars + git TLS/config regexes); OCC managedEnvConstants.ts:14-67 provider-routing only |
| 59 | **PORT** | v300 gzip default-on (`vMt`: min 4096, env opt-out, bad-json latch); OCC zero gzip hits, client.ts:532-575 passthrough |
| 62 | STAGED | gate flip recovered but whole new transcript-record subsystem |

### T4 — advisor/agents-view/tasks/UI/IDE/dim-text/skills + VSCode (26) — `triage-T4.md`

| # | Disposition | One-line evidence |
|---|---|---|
| 5 | **PORT** | v300 gate `_It`@222993478 = firstParty‖anthropicAws‖anthropicGoogleCloud; OCC advisor.ts:145 strict firstParty |
| 13 | N-A | `occ agents` dashboard zero PR surface |
| 15 | STAGED | OCC has pre-fix behavior (isBackgroundTask drops finished); official retention rule not string-recoverable |
| 16 | N-A | no hierarchical breadcrumb in OCC (flat Viewing @name) |
| 17 | STAGED | FleetView nav real but official burst-discrimination has no marker string |
| 21 | N-A | ReviewArtifactTool empty stub; REVIEW_ARTIFACT ∉ allowlist |
| 31 | **PORT** | v300-only scratchpad sentence @224570825; OCC prompts.ts:849-871 lacks it |
| 32 | N-A | cloud RC bridge dead (BRIDGE_MODE ∉ allowlist) |
| 34 | **PORT** | v300 `O6r`@228445620 single launch + `previouslyInstalled`; OCC ide.ts:1307-1308 double-launches |
| 39 | N-A | same dead cloud bridge |
| 47 | **PORT** | v300 auto-faintInk wrapper @235309900 + applicator `!backgroundColor&&!inverse` @219912500; OCC faintInk 0 hits |
| 53 | STAGED | PDF note text recovered but `modelReadsByPage` capability mapping unrecoverable |
| 60 | N-A | bundled skill .mds intentional 1-byte stubs (OCC-44) |
| 63 | **PORT** | v300 `"Sandbox commands…"` @257304200 ('Sandbox BashTool' v300=0); OCC SandboxSettings.tsx:62/:74 v299 wording |
| 67–78 | N-A ×12 | OCC ships no VSCode extension |

### 2.1.301 (next channel) — pre-triage archive only

`next` 2.1.301 published 2026-10-15; **no 2.1.301 CHANGELOG section** → not aligned this round per OCC-95 convention.

## 3. PORT implementation record

**All 21 PORT entries landed** on branch `agent/occ/8045b9c7` (12 commits, `a935bb3`…`06752f8`, each pushed). Commit map: `a935bb3` #2 · `1a6f0d6` #5/#31/#63 · `2f522c8` #43 · `e23dd27` #34 · `3efc5a8` #47 · `879f13e` #10/#18-util/#22 · `f36d50d` #36/#59 · `527db54` #41/#66 · `9d5217c` #18-wiring (+ #36 /clear fold-in) · `703833a` #28/#65 · `d052571` #24/#29/#33 · `06752f8` #19/#55. Per-item records with binary evidence and documented deviations follow (numeric order).

### #2 — OTel `api_request` cache-write lifetime split ✅ LANDED (commit `a935bb3`)

- **Evidence:** v300 ELF `api_request` builder @227727872 (`dd` excerpt): `...cache_creation_tokens:w.cache_creation_input_tokens,cache_creation_5m_tokens:w.cache_creation?.ephemeral_5m_input_tokens??0,cache_creation_1h_tokens:w.cache_creation?.ephemeral_1h_input_tokens??0,...`; v299 builder @226508395 has zero `cache_creation_5m/1h` hits. Field names also in v300 OTel attribute table @107102784.
- **Change:** `src/services/api/logging.ts` `logAPISuccessAndDuration` emit site — added `cache_creation_5m_tokens: String(usage.cache_creation?.ephemeral_5m_input_tokens ?? 0)` and `cache_creation_1h_tokens: String(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0)` after `cache_creation_tokens`, preserving OCC's String()-wrapped attribute convention (value semantics identical to official `??0`).
- **Tests:** `src/utils/__tests__/apiRequestCacheSplit300.test.ts` (TDD: RED 0/3 → GREEN 3/3) — full split, missing `cache_creation` → "0"/"0", partial 5m-only → 1h "0"; pre-existing attrs untouched. OTel-adjacent regression files (atMentionOtelCap293, doctorOtelHeaders275, otelHeadersHelperFailure275) all pass.

### #5 — advisor enabled on AWS provider ✅ LANDED (commit `1a6f0d6`)

- **Evidence:** official gate `_It` @222993478 = `firstParty||wD`, `wD` @216213859 = `anthropicAws||anthropicGoogleCloud`.
- **Change:** `src/utils/advisor.ts` `isAdvisorEnabled` — strict firstParty gate widened to `firstParty||anthropic_aws`.
- **Deviation:** OCC folds googleCloud into firstParty per `providers.ts` (no separate anthropicGoogleCloud provider surface) — the official `wD` arm is fully covered by the union.
- **Tests:** advisorAws300 (7).

### #10 — `/autocompact` warn gate ✅ LANDED (commit `879f13e`)

- **Evidence:** v300 `TAn` = `chosenWindowExceedsAutoWindow` @239116220; warn call site `cCt(u)&&TAn(r,s)` @239116094. v299 gate was source-only (`cCt` @225878936).
- **Change:** NEW `src/utils/autoCompactWindow.ts` `chosenWindowExceedsAutoWindow`; autocompact-noninteractive high-token-usage warning now fires only when the chosen window exceeds the auto window — smaller-than-auto overrides no longer warn.
- **Deviation:** official source-gate `cCt` is env-aware; OCC mirror uses the existing env check (documented in-code as the `Hno` analog).
- **Tests:** autoCompactWindowWarnGate300 (8), 1 pre-existing assertion flipped to the new behavior (288 suite green).

### #18 — tool-search auto hold (conversation latch) ✅ LANDED (commits `879f13e` util + `9d5217c` wiring)

- **Evidence:** `Lfr` (= `isToolSearchEnabled`) grows 7th param `S=!1` @227142200; `auto_held` reason token v299:0 → v300:2 (@107850108, @227142599); debug line `Auto tool search enabled: this conversation already declared ToolSearch` @227142517 (no `[source:]` suffix); query caller passes `Q.recordedToolDescriptions?.has(Ci)` @227824350 with `Ci="ToolSearch"` @219935042; recording via `H1t` @227828656 region + lazy-names latch variant @227825300; conversation reset `w3n` @239179269.
- **Change:** (a) `toolSearch.ts` — `autoHeld` 6th OCC param; `tst-auto` short-circuits with reason `auto_held` before the threshold recompute. (b) `claude.ts` query path passes `isToolSearchDeclared()`; `noteToolSearchDeclared()` armed when the filtered-tools branch sends ToolSearch's description on the wire. (c) `commands/clear/caches.ts` — `resetToolSearchDeclared()` wired into `clearSessionCaches` (/clear + resume) per `w3n`.
- **Deviations:** module-level boolean latch instead of a `recordedToolDescriptions` ledger (#46 STAGED — per-process ≈ conversation lifetime, same class as #36's module map); the initially-sketched `extractDiscoveredToolNames(messages).has(TOOL_SEARCH_TOOL_NAME)` source was REJECTED (OCC's extractor only collects tool_reference names → the hold would never arm); compact caller keeps 6 args (official 6-arg compact site — no hold).
- **Tests:** toolSearchAutoHold300 (8), toolSearchDeclaredLatch300 (5 — latch semantics + behavioral clearSessionCaches reset incl. #36's map returning to identity-apply).

### #19 — org-pin login refusal BEFORE persist ✅ LANDED (commit `06752f8`)

- **Evidence:** v300 validates the org pin before persisting credentials and restores the snapshot on `refused` @242589299; v299 persisted-then-validated (OCC `auth.ts` saved unconditionally).
- **Change:** `src/utils/auth.ts` — `checkOrgPinForTokenSave` (sync check against on-token org info: `profile.organization.uuid ?? tokenAccount.organizationUuid ?? cached oauth account`); `saveOAuthTokensIfNeeded` refuses the write on definitive mismatch (prior credentials survive untouched) and records the refusal in the `pendingOrgPinRefusal` latch; `validateForceLoginOrg` consumes the latch once AFTER providerGate but BEFORE the unix-socket/auth-enabled/org-pin/`!tokens` branches — a refused login surfaces the real org-pin error instead of a false `{valid:true}`; mismatch message byte-shared between sync refusal and the async network-verified path.
- **Deviations:** official is an async outcome-typed validator (refused/permitted{verified}/not_checked) with snapshot-restore; OCC's `saveOAuthTokensIfNeeded` is SYNC → sync check defers (`not_checked`) when the token carries no org info, leaving the async network validator authoritative; refusal telemetry STAGED (no invented event name).
- **Tests:** orgPinLoginRefusal300 (7); 8 regression suites 0 fail (saveOAuthTokensTransient281, oauthLoginExpiry, oauthUnusableTokenRecheck286, oauthEnvToken401Precedence, authPinLocalPrecedence299, …).

### #22 — resume torn-tail seal ✅ LANDED (commit `879f13e`)

- **Evidence:** `sealTornTailOnNextAppend` @224821077; official tail guard `gdo` `h!==""&&!h.endsWith("\n")`.
- **Change:** `sessionStorage.ts` — `reAppendSessionMetadata(skipTitleRefresh, sealTornTail)` + `sealTornTailSync`; `adoptResumedSessionFile` passes the flag so a crash-truncated last transcript line is sealed before the first post-resume blind append.
- **Deviations (in-code):** eager-seal at adopt time (official seals on next append); `xa()` guard not ported (OCC append path differs structurally).
- **Tests:** sessionStorageTornTailSeal300 (3).

### #24 — plugin WorktreeCreate hooks run with `--worktree` ✅ LANDED (commit `d052571`)

- **Evidence:** v300 gates worktree create behind `BHn()` hook dispatch @226762623; OCC created the worktree BEFORE `loadPluginHooks()`.
- **Change:** `setup.ts` — awaits `loadPluginHooks()` + `setupPluginHookHotReload()` BEFORE `hasWorktreeCreateHook()`/`createWorktreeForSession()`; `skipPluginPrefetch` hoisted above the worktree block; idempotent with the late prefetch (lodash-memoize + hotReloadSubscribed).
- **Deviation:** `--tmux` startup path NOT covered — matches official scope.
- **Tests:** setupWorktreeHooks300 (1).

### #28 — agent-hook model refusal fallback ✅ LANDED (commit `703833a`)

- **Evidence:** executor head @227965350; retry block @227967400; log string `was refused, running the agent hook on` @107695561/@227967610; `AIr` alias-resolve @219020138; `ORe` refusal detector @229228103 (`isApiErrorMessage` + `apiErrorStatus∈[400,403,404]` + `!resendCannotCure`); fallback env gate `kG` @219010844.
- **Change:** `execAgentHook.ts` — `resolveAgentHookModel` (alias check on normalized string, parse on ORIGINAL value; only when `hook.model` explicit); refusal captured from the FIRST assistant message only; retry on callerModel BEFORE the max-turns branch, gated by `!signal.aborted` and `CLAUDE_CODE_NO_MODEL_FALLBACK`; returns `{...inner, hook}` preserving original hook identity.
- **Deviations:** OCC assistant messages lack `apiErrorStatus`/`resendCannotCure` → dual-path detector falls back to SDK error category (`invalid_request`/`authentication_failed`); official `UIe` deniedModels redirect never existed in OCC; `execPromptHook.ts` NOT changed — v300 judge @227953260 identical to v299 (AIr has zero judge occurrences).
- **Tests:** agentHookModelRefusalFallback300 (13); hookJudgment294 32, hooksFailClosed288 22, permissionRequestAgentHook280 3 green.

### #29 — peeled worktree start-point + watcher reset ✅ LANDED (commit `d052571`)

- **Evidence:** v300 add-argv `Q.push("--no-track","-B",h,s,H)` with `H=${K}^{commit}` @226752420; `Hen` HEAD resolver @226745624.
- **Change:** `worktree.ts` start-point is the PEELED base SHA (`${baseSha}^{commit}`), never the ref name — DWIM can no longer pick a same-named tag/branch object; `rev-parse --verify --quiet HEAD` (cwd = fromCwd ?? repoRoot, `LC_ALL:'C'`). `setup.ts` calls `resetGitFileWatcher()` after the worktree chdir/`setProjectRoot` so the session's first git status names the new branch (gitFilesystem.ts doc updated — first production caller).
- **Deviation:** `--no-track` itself stays unported — pre-existing OCC add-argv divergence, out of #29 scope.
- **Tests:** worktreeStartPoint300 (3), setupWorktreeBranchReset300 (1); worktreeCreateErrors299 29/29, worktreeReftable299 7 green.

### #31 — scratchpad absolute-path sentence ✅ LANDED (commit `1a6f0d6`)

- **Evidence:** v300-only sentence @224570825 (277 bytes, md5-verified byte-for-byte; v299 zero hits).
- **Change:** `prompts.ts` `getScratchpadInstructions` appends the sentence verbatim.
- **Tests:** scratchpadAbsPath300 (2).

### #33 — `--worktree` inside a bare-repo worktree, fetch-fail HEAD from cwd ✅ LANDED (commit `d052571`)

- **Evidence:** fetch-fail fallback resolves HEAD from the CURRENT checkout (`Hen` @226745624, cwd = fromCwd); byte-exact warn string @226752150 (em-dash U+2014): `[worktree] fetch of origin/${defaultBranch} failed — basing worktree on local HEAD`.
- **Change:** `worktree.ts` options widened `{prNumber?, fromCwd?}`; fetch-fail branch bases on `HEAD` with the fromCwd resolver; `setup.ts` captures the launch dir pre-chdir (`worktreeFromCwd`) and forwards it. Unresolvable HEAD falls through to the shared repoRoot rev-parse, preserving the 2.1.299 #146 head_fallback catalog.
- **Deviation:** EnterWorktreeTool.ts:171 (only other caller) stays on the old signature — backward-compatible by optional param.
- **Tests:** covered by worktreeStartPoint300 + setupWorktreeHooks300; regressions contextWorktree035 5, ultrareviewLaunch 4, clear-cost-reset 3 green.

### #34 — single editor-CLI launch for IDE extension check ✅ LANDED (commit `e23dd27`)

- **Evidence:** official `O6r` @228445620 returns `{installedVersion, previouslyInstalled}`; single-launch call site `Eio` @228451039; `WAYLAND_DISPLAY:''` env @228446120.
- **Change:** `ide.ts` — `installIDEExtension` returns the official shape; `initializeIdeIntegration` drops the `isIDEExtensionInstalled` pre-check wrapper (one launch, not two); onboarding gated `installed && !previouslyInstalled && !dialogShown` (official order); `getInstallationEnv` gains `WAYLAND_DISPLAY:''` (closes a pre-existing divergence).
- **Deviation:** JetBrains branch unchanged (official ant-branch surface not present in OCC).
- **Tests:** ideExtensionSingleLaunch300 (5 — fake code/cursor/windsurf shims on PATH counting spawns).

### #36 — MCP tool-schema 400 heal ✅ LANDED (commit `f36d50d` + `9d5217c` /clear wiring)

- **Evidence:** classifier regex `/\btools\.(\d+)\.(?:custom\.)?input_schema\b/` @2929387/@107537522; `AGe`/`W1t` @225850721 (cap `lFo`=8); mcp gate `Kg` @222761037; resolver wiring @227866518; conversation reset `w3n` @239179269.
- **Change:** NEW `src/services/api/refusedToolSchemas.ts` — conversation-scoped map, `hashInputSchema` (j1t), `isMcpToolRefForSchemaRefusal` (Kg), `applyRefusedToolSchemas` (W1t, identity-apply when empty), `createToolSchemaRefusedResolver` (AGe, cap 8), `clearRefusedToolSchemas` (w3n); `errorUtils.ts` `extractRefusedToolSchemaIndex`; `withRetry.ts` 4th no-budget heal hook after retryContext1mBetaRefused; `claude.ts` surgical wiring (3 retry sites + executeNonStreamingRequest). Refused MCP tool re-sent as `{type:"object"}` for the rest of the conversation. `/clear`+resume reset wired via `clearSessionCaches` (commit `9d5217c`).
- **Deviations:** module-level map (no Gte context object); official persisted 7-day latch NOT ported (config schema outside cluster); `custom_ca` handling simplified.
- **Tests:** toolSchemaRefused300 (24); all 39 pre-existing src/services/api suites green; toolSearchDeclaredLatch300 covers the /clear wiring.

### #41 — background bash anti-poll prompt clauses ✅ LANDED (commit `527db54`)

- **Evidence:** official gate `Vbr` @223329653; `qpr` assembly `[H,V,be].filter(Boolean).join(' ')` with K-gate @228323847; strings byte-verified @228323540/@225820817 (`do not poll` v299:9 → v300:11).
- **Change:** BashTool `prompt.ts` — `backgroundCompletionNoticeEnabled()` gate + gated anti-poll clauses in the background Bash prompt/description; `BashTool.tsx` qpr-style assembly.
- **Deviations:** OCC gate mirror = `!getIsNonInteractiveSession()` (official `we()` unresolvable in binary — documented); official s/h/S K-arms STAGED (no OCC counterpart).
- **Tests:** backgroundAntiPoll300 (9); bashPromptPlainLanguage288 25, bashTimeoutBackgroundInfo 6 green.

### #43 — daemon `stop --any` honest force-kill reporting ✅ LANDED (commit `2f522c8`)

- **Evidence:** official flow @111238330–@111240268 (SIGTERM → wait → SIGKILL → re-check); NEW strings `force-killing it (SIGKILL)`, `daemon_stop_still_running`.
- **Change:** `lockfile.ts` `displaceHolder` returns immutable `{displaced, survived, unverified, eperm, isInit, holder}` after SIGTERM-grace → SIGKILL → settle → liveness recheck; pid-1 guard (never signals init); lockfile kept in every failure case; unverifiable holder never signalled (fail-safe). `daemon.ts` `stop --any` routes through `reportStopAnyResult` — survived/unverified/EPERM/pid-1 each print the byte-verified official message and exit 1 with analytics keys `daemon_stop_still_running` / `_holder_unverified` / `_holder_is_init` / `daemon_stop_failed`; success prunes dead pids from daemon-status.json (#44 fold-in).
- **Deviations (8, documented in-code):** OCC's analytics stub receives the official key names without the official metadata envelope; settle window and grace timings use OCC constants where the official minified values were unresolvable; pid-1 check added as OCC hardening (official re-check implies it); remaining deltas annotated at each branch in lockfile.ts/daemon.ts.
- **Tests:** displaceHolderLiveness300 (9), displaceHolderRealProc300 (2 — real SIGTERM-trapping bash holders), daemonStopAny300 (7); displaceHolderStaleLockfile updated (1 pinned expectation was the exact pre-300 behavior this entry fixes) 5/5.

### #47 — dim text faint under dark ANSI theme / 16-color terminals ✅ LANDED (commit `3efc5a8`)

- **Evidence:** v300 applicator `h6e` @219912500 (`chalk.dim` when `faintInk===color && !bold && !dim && !backgroundColor && !inverse`); `WhitishColorDetector` singleton @219913150 (memoized, revalidated on chalk.level); auto-faintInk wrapper @235309900 (`A&&!W?D:void 0`); `Dc` spread order @231403881.
- **Change:** `styles.ts` `TextStyles.faintInk` (additive); `colorize.ts` WhitishColorDetector + faintInk branch in `applyTextStyles`; `Text.tsx` prop threading with official spread order; `ThemedText.tsx` auto-computes faintInk for dimColor spans.
- **Triage correction (byte-verified):** official `W` = message-row hover context (`Wet=Kt(!1)` @235309263, provider `pE` @245282095), NOT a whitish-theme flag — OCC maps `!W` to `isHoverOverride` (hover recolor not overriding).
- **Tests:** faintInkDim300 (14 — full guard matrix + cache revalidation + threading), themedTextFaintInk300 (6 — dark-ansi level-1: dim span SGR-2+37 vs normal SGR-97, the changelog bug); ansiBoldDim295 4, tabsNoColorCursor281 5, stdoutBackpressure275 32, textNormalization289 63 green.

### #55 — host-managed TLS/proxy env strip ✅ LANDED (commit `06752f8`)

- **Evidence:** official filter `b(e,n,r,i)` @219874600; strip set @216531261; warn emitter `L` @219874060; component lists — `Tl` proxy @216530205 (9 vars), `Ky` mTLS/auth base @216530140 (6), `Pl` = dedup(`pte` CA-bundles ∪ `Gme` native-TLS ∪ `CYn` tool-proxy @216520764 ∪ `vl` ∪ `pJ∖fQe` git-config @216276040) dropping NODE_EXTRA_CA_CERTS/JAVA_TOOL_OPTIONS/Tl-members; regex arms `l5n` `/^GIT_(?:SSL|PROXY)_/i`, `mQe` `/^GIT_CONFIG_(KEY|VALUE)_\d+$/i`.
- **Change:** `managedEnvConstants.ts` — full byte-verified `HOST_MANAGED_*` catalog + `isHostManagedTlsOrProxyVar` (git repo-location vars `fQe` intentionally KEPT). `managedEnv.ts` — `withoutHostManagedTlsProxyVars` wired into `filterSettingsEnv` (gate `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`; order: project blocklist → SSH-tunnel → host-managed-provider → **host-managed TLS/proxy** → host spawn-env); one-time-per-(source,key) byte-exact warnings (desktop/plain arms).
- **Deviation:** desktop host narrows the strip to PROJECT-scoped settings only (official `oJe(n)` arm). Initially gated on the narrow literal `CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'`; **FIXED in finalize segment** (commit `e36ee2d5` — see §7.8) to the official 3-entry `bu()` set @216265665: `{claude-desktop, claude-desktop-3p, local-agent}` (`desktopHost = bu()` confirmed @219865955; step-6 clause @219874632 re-verified byte-exact this segment).
- **Tests:** managedHostTlsProxyStrip300 (15, 86 expects — incl. 3 new: `claude-desktop-3p`/`local-agent` desktop narrowing + unknown-entrypoint full strip); managedEnv281 9, managedReadDenial285 24, allowedProviders285 38 green.

### #59 — gzip request bodies (default-on) ✅ LANDED (commit `f36d50d`)

- **Evidence:** host allowlist `vMt` @216214637/@219895347 region (min 4096B); padding `bNt` @219216120; flags `tengu_gzip_request_bodies`/`tengu_atomic_ocean` REMOVED in v300 → default-on.
- **Change:** NEW `src/services/api/gzipRequestBody.ts` — tri-state `CLAUDE_CODE_GZIP_REQUEST_BODIES` (0 opt-out), bad-json rejection latch, `classifyGzipRejection` (400/403/415 + anthropic/bad-json sniff), `padRequestBodyForGzip` (bNt); `client.ts` `buildFetch` gzips large string bodies to allowlisted hosts and re-sends the identity body once on rejection (latch off process-wide).
- **Deviation:** Bun's gzip API exposes no compress-level knob (official level unrecoverable) — default level used.
- **Tests:** gzipRequestBody300 (16).

### #63 — SandboxSettings option labels ✅ LANDED (commit `1a6f0d6`)

- **Evidence:** v300 builder @257304200 — labels `Sandbox commands, with auto-allow` / `Sandbox commands, with regular permissions`; `Sandbox BashTool` = 0 hits in v300.
- **Change:** `SandboxSettings.tsx` option labels updated to the v300 wording (both sites :62/:74).
- **Deviation:** official `isAutoAllowSupported` sub-gate not ported — OCC's sandbox surface has no auto-allow capability flag; labels mirror the official strings unconditionally (matches observable output on OCC's surface).
- **Tests:** sandboxSettingsLabels300 (4).

### #65 — hook `updatedInput` validated like the model's own input ✅ LANDED (commit `703833a`)

- **Evidence:** `aHe` @225233300, `ykr` @227296608, `cEe` @218734593, chokepoint deny block @227310550, `tengu_hook_rewrite_checked` @225233892 (NEW in v300), `zfr` loop head @227259000, `xCt` permission-request variant caller @228137483; `The tool input from the model was valid` 1→5 sites.
- **Change:** NEW `src/utils/permissions/hookUpdatedInputValidation.ts` (faithful port: deep unknown-key strip, schema-issue finder with unrecognized_keys ignored, shown-key merge/exemption, `__artifact` reserved-key deny, xCt variant); `toolHooks.ts` runPreToolUseHooks loop head validates `result.updatedInput` via `tool.validateInput` (deny → yield+continue; abort → yield stop; allow/ask/passthrough carry the CLEANED input); `permissions.ts` allow branch runs `checkPermissionRequestUpdatedInput` (`runPermissionRequestHooksForHeadlessAgent` exported as test seam); `toolExecution.ts` chokepoint @:1277 follows the BINARY (ykr tolerates unknown keys — strip lives at hook sites): real schema issues deny with the official message (em-dash included), OTel `tool_permission_updated_input_invalid`, `tengu_tool_use_error` PERMISSION_UPDATED_INPUT, `<tool_use_error>` tool_result.
- **Deviations (documented in-code):** `HOOK_REWRITE_ENFORCED=true` constant (official gate defaults on via `tengu_glimmering_newt {safe:!0}`); interactive PermissionRequest site covered by the chokepoint backstop instead of a dedicated inline check; `UIe` deniedModels redirect never existed in OCC; gateway branch dead.
- **Tests:** hookUpdatedInputValidation300 (27), permissionRequestUpdatedInput300 (8), permissionUpdatedInputChokepoint300 (5); autoModeHookAllowStripped299 9 green.

### #66 — remote-control `--sandbox/--no-sandbox` removal (dormant) ✅ LANDED (commit `527db54`)

- **Evidence:** dedicated error branch @241543023 (`is not supported … The flag had no effect and was removed.` + settings hint @222586160); NEW hint string @109346400.
- **Change:** `bridgeMain.ts` — flags now rejected with the official error text; `sessionRunner.ts` — dead `CLAUDE_CODE_FORCE_SANDBOX` env wiring removed (zero remaining consumers).
- **Deviations:** parse-level alignment only (BRIDGE_MODE ∉ allowlist — dormant surface, bundled with this round's bridge touch per triage plan); error text occ-branded per existing precedent.
- **Tests:** remoteControlSandboxFlags300 (6); bridgePolicyRefusal286 23 green.

## 4. e2e / A/B acceptance

**Run date:** 2026-10-16, on `agent/occ/8045b9c7` @ `62d4d78` (all 21 PORT items + ledger).

- **Build:** `bun run build` green — `dist/cli.js` 30.24 MB (31,709,403 bytes), MACRO.VERSION=2.1.383 injected.
- **Full suite (`bash scripts/ci-test.sh`, per-file process isolation):** **12205 pass / 1 fail / 12 skip · 1090 files.** Baseline (pristine main + dist) = 11990/1/12 · 1063 files → **+215 pass / +27 files = this round's new tests, zero new failures.** Sole fail = pre-existing allowed `test/e2e/commands-behavior.e2e.test.ts` → `/feedback (no args)` GitHub-issue creation external dependency (identical to baseline; not touched this round).
- **Live `-p` smoke (real API):** `dist/cli.js --version` → `OCC 2.1.383`; `echo … | dist/cli.js -p` → `PONG`, exit 0 (glm-5.2 custom endpoint; `unrecognized_model` line = pre-existing env noise).
- **Real REPL (tmux, Architecture A per repl-tmux-e2e-testing):** boot → ready in ~2s; live in-REPL model round-trip (`❯ Reply with exactly: REPL300-PONG` → `● REPL300-PONG`, 43,158 tokens consumed); `/status` renders full panel (Version 2.1.383 / Session ID / cwd / Auth token / API key / base URL / Model / `MCP servers: 2 connected, 1 failed` / Setting sources); `Shift+Tab` cycles `bypass permissions on` → `auto mode on`; `/exit` clean exit, session killed, scratch dir removed — no leak. Bundled `repl-interactive.e2e.test.ts` 3/3 in-suite.
- **Artifact behavioral probes:** `dist/cli.js daemon stop --any` (no daemon) → `No background sessions found.` exit 0 (#43 no-op path; force-kill/displace path unit-covered with REAL SIGTERM-trapping processes in displaceHolderRealProc300). Presence-only dist checks (not the done-gate): #18 `this conversation already declared ToolSearch` ×1, #29 `basing worktree on local HEAD` ×1, #43 `force-killing it (SIGKILL)` ×1, #63 `Sandbox commands, with auto-allow` ×1.
- **behavior-driven-done checklist:** (1) no stubs — the 4 new files are 289/393/505/401 real lines; (2) visual items verified at render level (#47 SGR-2+37 vs SGR-97 at chalk level 1; #63 labels); (3) no new feature-flag enablements (BRIDGE_MODE stays dead — #66 parse-level only); (4) behavioral e2e above, not source-grep; (5) no regression vs baseline; (6) every binary claim self-verified via strings/grep -aboF/dd — **official ELF never executed** (Leader forensic discipline held all round).
- **Official A/B:** not executed this round beyond strings forensics — the official linux-x64 binary is never run (discipline); behavioral parity evidence = byte-verified strings + the unit/e2e gates above. #55's warn surfaces via `logForDiagnosticsNoPII` (diagnostics log, not stderr) → unit-seam covered (managedHostTlsProxyStrip300 12/12).

## 5. npm publish debt re-check (owner-side, report-only)

Re-verified 2026-10-16: npm `@cnwenf/occ` dist-tags `latest` = **2.1.367** (unchanged); repo tags through **v2.1.383** → 2.1.368–2.1.383 (15 versions; v2.1.371 never tagged) still unpublished. `publish.yml` runs for v2.1.381/v2.1.382/v2.1.383 all `failure` (E404 `PUT /@cnwenf%2focc` — `NPM_TOKEN` lacks write scope). **Owner-side; not agent-fixable. Carried, not blocking** — tag + GitHub Release continue to publish normally per Leader ruling.

## 6. Delivery

<!-- DELIVERY -->

**Release commit:** `chore(release): 2.1.384 — official 2.1.299→2.1.300 alignment (OCC-118)` at the tip of branch `agent/occ/8045b9c7` (implementation chain `a935bb3`…`698b4d3` + this release commit; 4-file release pattern per `e798433` precedent: README 4 Tracks sites, CHANGELOG header prepend + new `## 2.1.384` section, package.json `2.1.383`→`2.1.384`, this ledger §6/§7).

**Merge method — ff-push to origin/main.** Local `main` is checked out by another runtime's worktree (`…/285d630e/workdir/occ`, stale at `e9dc9f2` = 2.1.354) → `git checkout main` fails with "already used by worktree". `origin/main` = `b5e0591` = merge-base with this branch (branch strictly ahead) → delivered via `git push origin agent/occ/8045b9c7:main` (fast-forward), matching origin/main's linear branch-push history (occ158 precedent `b5e0591`/`d51297b`). Verified post-push via `git ls-remote origin main`.

**NO tag this round.** Tag `v2.1.384` + GitHub Release (publish.yml) fire ONLY after 验收员 acceptance notification, in a later run — per Leader instruction.

**Residual branch cleanup:** `agent/occ156-selfaccept` verified already deleted on origin — no-op.

**npm publish debt:** unchanged from §5 (latest published = 2.1.367; 2.1.368–2.1.383 unpublished — NPM_TOKEN lacks write scope; owner-side, record-only, not blocking the release flow).

**Resource safety:** `/tmp/cc-diff-300` forensic artifacts (both official ELFs + strings dumps) deleted at round end; the official binaries were never executed.

## 7. Final adjudication & carryover (authoritative entry for next round)

<!-- ADJUDICATION -->

**Authoritative entry for the next round (OCC-118 §7):**

1. **Aligned-through state:** OCC is aligned through official **2.1.300** (honest-partial). Final tally: **PORT 21 (all landed) · STAGED 11 · N-A 50 · ALREADY-ALIGNED 6**. Release `2.1.384` merged to `origin/main`; tag + GitHub Release pending 验收员 acceptance. Next round starts from npm dist-tags re-check; **2.1.301** (`next` channel, published 2026-10-15, no CHANGELOG section) is pre-triage archive only — NOT aligned (OCC-95 convention).

2. **occ158 §7 carryover — UNCHANGED.** Re-adjudication trigger ("official `stable` ≥ 2.1.296") did NOT fire this round (`stable` = 2.1.292 < 2.1.296; `latest` = 2.1.300, `next` = 2.1.301). The whole occ158 STAGED set carries as-is (incl. #106/#108 sandbox-runtime symlink bypass, #107 glob brace divergence, #109 worktree awk acceptance, #150 workflow VM depth-guard probe, #073 resume double-run inheritance check, E-cluster #002/#003/#009/#019/#066/#104/#140, render family #061/#063/#083/#084). Next-round trigger re-check: `npm view @anthropic-ai/claude-code dist-tags --json` → fire iff `stable` ≥ 2.1.296. New-evidence scan this round showed all gate-vocabulary families count-balanced (minifier-rename noise) — no carryover item gained porting evidence.

3. **This round's STAGED 11 (carry with rationale):** #6 (gen_ai.* span attrs — module-wide OTel span rework), #15 (background-task retention rule not string-recoverable), #17 (FleetView burst-discrimination — no marker string), #30 (`tables.list` reftable read — OCC gitFilesystem has zero reftable read support), #37/#40 (balanced-marker logic-only deltas — no leaf max_tokens detection in OCC), #42 (OS-cert TLS mechanism not string-recoverable), #46 (`loadedNames` recovered but OCC has no recordedToolDescriptions ledger to attach — see #18 deviation), #53 (PDF `modelReadsByPage` capability mapping unrecoverable), #61 (no handoff-file mechanism in OCC), #62 (whole new transcript-record subsystem). Re-adjudication trigger: new binary evidence in a future strings delta, or subsystem landing in OCC.

4. **Key deviation carry-list (documented in §3, verify before "fixing"):** #36 persisted 7-day refusal latch NOT ported (conversation-scoped module map only — official persistence layer out of scope); #19 org-pin telemetry STAGED (refusal behavior landed); #41 K-arms prompt sections staged (anti-poll clauses landed); #59 gzip compression level = default (official level not recoverable from binary); #43 `daemon_stop_still_running` telemetry envelope approximated; #29 `--no-track` NOT ported (OCC passes branch name — documented deviation); #18 conversation latch mirrors official `recordedToolDescriptions.has("ToolSearch")` with a module-level boolean (no ledger subsystem — #46 STAGED dependency); #66 dormant parse-level only (BRIDGE_MODE dead code — bundle with next bridge touch).

5. **Fix-forward candidates (non-blocking, ranked):** occ158 §7 list carries (WP8 #152(b) cross-origin `beforeRedirect` OAuth-revocation check; WP8 #152(a) plain-user-http ≤5-hop redirect rule; occ158 §3 follow-ups 1–7) + NEW this round: T1 advisory — OCC's fs-only `isInTransientGitState` (`src/utils/gitDiff.ts:308`, `src/utils/commitAttribution.ts:869`) shares entry #20's reftable blind-spot class; #30 reftable read layer would close both.

6. **Test baseline for next round:** `bash scripts/ci-test.sh` → **12205 pass / 1 fail / 12 skip · 1090 files** (this round, post-merge state). Sole allowed fail: `test/e2e/commands-behavior.e2e.test.ts` → `/feedback (no args)` (external dependency; pre-existing since occ158 baseline 11990/1/12). e2e requires `bun run build` first; build artifact `dist/cli.js` 31,709,403 bytes at this round's HEAD. **Post-#55-fix baseline (§7.8 commit `e36ee2d5`):** 12207 pass / 2 fail / 12 skip — +3 new managedHostTlsProxyStrip300 cases (15/86); both fails are `/feedback` live-model family (commands-behavior external dep as before; feedback-ai.e2e confirmed flaky-green on isolated re-run 6/6 in 30s — live LLM `glm-5.2` nondeterminism, not code). Effective standing = 12208-pass potential / 1 allowed fail. ci-test.sh does NOT run `bun run build` itself — a fresh worktree without `dist/cli.js` mass-fails e2e (126 fails observed); always build first. dist/cli.js at fix HEAD = 31,709,609 bytes, `--version` → `OCC 2.1.384`.

7. **npm publish debt:** carried, owner-side (see §5) — `@cnwenf/occ` npm latest = 2.1.367; 2.1.368–2.1.383 unpublished (NPM_TOKEN lacks write scope); E404 on `npm view @cnwenf/occ@<ver>` for those versions is EXPECTED and must not block future rounds. Tag + GitHub Release publish normally regardless.

8. **run2 parallel-line adjudication (finalize segment, post-release-merge).** A second agent line (`agent/occ/occ159-run2`, 5 commits: `81e60143` #22, `dfaa746a` #55, `8895c6a4` #19 + 2 ledger-note commits `0276972b`/`bc8008b7`) raced the merged line. Per-item verdicts vs main's landed versions:
   - **#22 DROPPED.** run2 used an eager-seal design (`tornTail.ts` fileHasTornTail/sealTornTailSync + adoptResumedSessionFile seal, 14 tests). Main's canonical `879f13e` implements the official `reAppendSessionMetadata(skipTitleRefresh, sealTornTail)` flag shape + sessionStorageTornTailSeal300 tests — closer to the official call signature. Collision note: run2's #22 work overlapped main's same-day landing; no unique behavior lost.
   - **#19 DROPPED (2 fix-forward candidates recorded).** run2 used validate-then-persist (outcome-typed `validateNewTokenOrgPin`≡`O1e`, snapshot/restore≡`Ju`/`ECo` with accountUuid+isDeepStrictEqual guard, verbatim single-use note "The refresh token … cannot be used again; issue a new one to retry.", OrgPinRefusedError, 38 tests). Main's `06752f8` uses a sync-latch design (checkOrgPinForTokenSave + pendingOrgPinRefusal consumed by validateForceLoginOrg) — already CI-green + e2e-recorded (§4); not replaced pre-release. **Fix-forward candidates for next round:** (a) verbatim single-use-note message fidelity (0 grep hits in main), (b) refusal-reason tagging + `ECo`-style snapshot/restore with isDeepStrictEqual account guard.
   - **#55 PARTIALLY ADOPTED — the one strictly-superior delta merged as an independent commit.** run2's desktop-host gate matched the official 3-entry `bu()` set while main had the narrow `'claude-desktop'` literal. Forensics re-verified from the official ELF (never executed): `grep -aboF 'claude-desktop-3p'` @216264724–216266013; bounded `dd` @216265500 → verbatim `var r=new Set(["claude-desktop","claude-desktop-3p","local-agent"]);function bu(){let e=a.CLAUDE_CODE_ENTRYPOINT;return e!==void 0&&r.has(e)}`; @219865750 → `I()` with `desktopHost:n=bu()`; @219874400 → step-6 clause `if(r.managedByHostFlag&&(!r.desktopHost||oJe(n))&&(Vln(s)||iJe(s)))`. Fix landed TDD (RED 2 → GREEN): `managedEnv.ts` `DESKTOP_HOST_ENTRYPOINTS` frozen 3-entry set replaces the literal in `withoutHostManagedTlsProxyVars` only (`:924` ccdSpawnEnvKeys capture is a different 2.1.281-era feature — intentionally untouched). Out of scope noted: official `b()` also has coworkCloud/`EHo`, `Gln`/`JBs`, ANTHROPIC_CUSTOM_HEADERS clauses — OCC has no Cowork; stay surgical.
   - **Branch cleanup:** remote `agent/occ/occ159-run2` + `agent/occ/8045b9c7` deleted after adjudication; `git ls-remote --heads origin` → only `main`.
