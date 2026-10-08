# OCC-111 upstream gap ledger — official Claude Code 2.1.292 → 2.1.293 (2026-10 round)

Round owner: OCC 程序员 (Multica issue OCC-111). Prior round: OCC-149 (2.1.292, ledger
`docs/upstream-version-gap-occ149-2026-10.md`, main HEAD `5a3299f` == tag v2.1.374).

## 0. Version state at round start

- OCC tracking state: 2.1.292 (partial — see OCC-149 ledger §7 staged items).
- Official latest (三方 verified: npm `latest`, GitHub releases, fresh ELF download): **2.1.293**
  (linux-x64 ELF md5 `33a00cad155f5ef8e70b65d01adf4b7d`). 2.1.294 exists on the **next**
  channel only — out of scope this round (pre-triage留档 in §6).
- Changelog 2.1.293: 56 entries (`/tmp/cc-CHANGELOG.md` lines 8-66 at research time).
- Forensics method: `strings -n 8 | sort -u` + `comm -13` (17,721 new / 16,106 removed
  strings), `grep -aboF` → offset → `dd` verbatim extraction. Official binaries NEVER executed.
- Research artifacts (this repo): `docs/gap-research-293/triage-293.md` (master 56-entry
  table), `security-cluster-292.md`, `webfetch-018-forensics.md`, `cluster-c-h-carryover.md`.

## 1. 2.1.293 changelog triage (56 entries)

Verdicts: **14 PORT / 3 STAGED / 39 N-A** (absence proofs per entry in `triage-293.md`).

### 1.1 PORT (landed this round)

| # | Entry | OCC landing | Status |
|---|-------|-------------|--------|
| 1 | Haiku 5.5 launch (model catalog, pricing `haiku_55`, alias flip, `haiku_5_5_early_stopping_guidance` HLo prompt via heron_brook `??ULo(h,s)` fallback, `tengu_idempotent_wolf` default-true) | configs.ts / modelDescriptors.ts / model.ts / modelCost.ts / context.ts / betas.ts / effort.ts / thinking.ts / advisor.ts / modelOptions.ts / envUtils.ts / prompts.ts / claudeApiContent.ts + NEW constants/earlyStoppingGuidance.ts — mirrors Sonnet 5.5 launch commit `192697f` | **LANDED** (21 files) — catalog/pricing/alias-flip byte-verbatim per /tmp/occ111-research/haiku55-extracts.md; default-haiku flip firstParty→5.5 / all 3P→4.5 (env precedence kept); HLo 5-paragraph guidance verbatim + ULo double gate (capability + `tengu_idempotent_wolf` default true); 50 new tests (launch suite 50/0/122), model domain 427/0, adjacent haiku suites 223/0, cost 12/0, model e2e 43/0. Deviations reasoned: env-info lead-in prose, `getHaiku55Option.descriptionForModel` wording, PREV_HAIKU_* skill vars (v293 surfaces not byte-extracted); `anthropic_google_cloud` folds into firstParty (standing divergence); helpers280 haiku-1M premise flipped (native_1m now). STAGED: `long_prompt` consumption wiring (data ported, no official consumption site extracted), BLo client-data arm (N/A), 5 capabilities w/o OCC consumers |
| 4 | Compaction recent-note fix | src/services/compact/prompt.ts + sessionMemoryCompact.ts | **LANDED** — `PRESERVED_RECENT_MESSAGES_NOTE` byte-equal to official `iJt` (221B, od-verified); `appendPreservedMessagesNote` ≡ `gJt`; gate ≡ `vt` (`messagesToKeep.length>0`); dead 292 4th-param branch deleted; 13 new tests, compact suite 34/0 |
| 7 | `/model` effort ←/→ no longer wraps (modulo → clamp `Math.min(Ie+1,he.length-1)` / `Math.max(Ie-1,0)`, vver `$0e`) | src/components/ModelPicker.tsx `cycleEffortLevel` | **LANDED** — clamps at both ends (vprev `zFe` vs vver `$0e` byte-verified); 9 new tests (effortWrap293) + 9 stale 292 wrap assertions updated (effortGap97/effortCap267); effort+picker family 144/0 |
| 9 | SendMessage continue gating | AgentTool prompt.ts/AgentTool.tsx/agentToolUtils.ts | **LANDED** — `getPrompt` 4th param `continueAvailable` + `continueBullet` fallback ≡ `H6o @215972233`; `Dw` gate (`tools.some(toolMatchesName(SEND_MESSAGE_TOOL_NAME))`); `canContinueAgent` in asyncOutputSchema + agentToolResultSchema; footer/trailer gated verbatim (@220374706/@220376291); 9 tests |
| 14 | Worker naming (UI.tsx:769-770 + AsyncAgentDetailDialog.tsx:102) | AgentTool UI.tsx / Tool.ts / GroupedToolUseContent.tsx / AsyncAgentDetailDialog.tsx | **LANDED** — `resolveAgentDisplayName` ≡ `dOr @220331500`, `userFacingName` ≡ `G2n`, dialog fallback `?? agent.agentType` ≡ `k.selectedAgent?.agentType ?? k.agentType @234080600`; activeAgents threaded reactively via GroupedToolUseContent (deviation: avoids React-Compiler memo-cache edits); 16 tests; combined regression 178/0. Known gap: lone (non-grouped) render path AssistantToolUseMessage.tsx:77 still collapses custom worker → "Agent" (compiled-component constraint, documented) |
| 19 | Remote-control history re-upload dedup (remoteBridgeCore.ts:575) | src/bridge/remoteBridgeCore.ts | **LANDED** — promise-settle tracking (recovery no longer re-sends settled initial history), `firstHistoryFlush` handle semantics; new test file 2/0; bridge family 53/0 |
| 29 | Bash single-file nested-memory triggers — full official `TBr` condition set + `_Rn` recorder where already-recorded paths STILL fire `cRn(h,z)` (the core bug) + `AH` read-deny gate | NEW src/tools/BashTool/bashReadCommands.ts (~440L, verbatim `TBr`/`FBr`/`_Rn`/`cRn` port w/ name map) + BashTool.tsx call site (loose `J4` extractor removed; parser tightening + trigger wiring in same change) | **LANDED** — 45 new tests (6 groups incl. core-bug + read-deny), BashTool suite 1019/0/2407; FileEditTool read-before-edit consumers 21 pass; binary-fidelity catch: bare `:` NOT benign (official `vBr` trailing `\b` quirk byte-verified @216611199); seams wired w/o Tool.ts change (permissions thunk ≡ `e.permissions()`); deviations: `Ih` sanitizer not ported (collision-ambiguous → STOP not invent), `contentNotInModelContext` threaded-not-persisted (no FileState field), Set vs array `MH` |
| 33 | Project purge exit code 1 | src/cli/handlers/projectPurge.ts | **LANDED** — `${N} item(s) failed:` + still-on-disk sentence verbatim + `process.exit(1)`; success `Deleted ${N} item(s).`; 2 tests. Deviation: official `Tt` anti-hang analytics not ported (OCC deleteItem non-interactive — event unreachable) |
| 34 | Keybindings: space key validation (validate.ts) | src/keybindings/validate.ts | **LANDED** — lone `" "` accepted as space key; `g=/\s\+\|\+\s/` check + official message/suggestion verbatim; 80-char surrogate-safe `… [+N chars]` truncation; 8 tests; misspelledModifier283 regression green |
| 35 | Vim `>>`/`<<` cursor on all-whitespace lines | src/vim/operators.ts | **LANDED** — grapheme-walk `$t` verbatim (replaces 292 `/^\s*/` at executeIndent + executeVisualIndent); 5 tests |
| 36 | Vim `V`+`d` cursor first-nonblank + dot repeat | src/vim/operators.ts | **LANDED** — first-nonblank placement + dot-replay guard byte-faithful; 7 tests; vim+keybindings+cli aggregate 186/0/542. Deferred: `getVisualSpan`→`On` alignment (pre-existing divergence, separate issue recommended) |
| 38 | **REVERT** of the 2.1.281 auto-mode outcome guidance (official removed it in 2.1.293; OCC had ported the 281 text → mandatory revert: autoModeOutcomeGuidance.ts deleted, messages.ts denial region reverted) | permissions | **LANDED** — autoModeOutcomeGuidance.ts + 281 test deleted; all 4 guidance sentences 0-hit in vver (grep -aboF); post-revert template byte-identical (`fnr`/`UUr`/`CXe` dd-verified); dangerous-rm tests migrated (dangerousRmAutoDeny281.test.ts); 26 new/migrated tests, permissions suite 343/0. Note: triage §38's "try to to" was a report typo — binary has single "to" |
| 46 | ASCII-first sort comparator `ZCe` (verbatim: `/^[\x00-\x7f]*$/` test → ASCII before non-ASCII, `localeCompare` within ASCII, codepoint within non-ASCII) at 4 sites | NEW src/utils/asciiFirstCompare.ts (`compareNamesAsciiFirst` ≡ `ZCe` @204175795) + agentDisplay.ts / loadAgentsDir.ts (@214472660) / mcpInstructionsDelta.ts (@214429076, `added` only) / attachments.ts (@216012902, `added` only) | **LANDED** — 17 unit + 2 e2e tests; wire-level proof (Agent tool description offsets 294<799<880<967 for alpha/zeta/Ünicorn/日本語-agent); `removed.sort()` sites deliberately untouched per official; deviation: `sensitivity:'base'` dropped (binary fidelity) |
| 47 | OTEL `at_mention` cap `q5e=100` + `Ix`/`Xfn` verbatim (attachments.ts at_mention emit region, 8 emit pairs) | telemetry | **LANDED** — `var q5e=100` + `Ix` (index gate `>=100` → no emit, gates statsig AND OTEL together) + `Xfn` (`tengu_at_mention_unreported` once per resolver, `count=length-100`) byte-verified @~216024405; all 8 emit pairs routed through `emitAtMention` (2 agent + 6 mcp_resource) + 2 overflow calls; file/directory `logAtMentionOtel` sites intentionally uncapped per official; 15 new tests, at_mention family 27/0, OTEL sweep 56/0 |

### 1.2 STAGED (not landed — per-site rationale in triage-293.md)

| # | Entry | Reason staged |
|---|-------|---------------|
| 6 | ←backgrounding | needs dedicated per-site decompilation of the input-box keybinding chain; behavior ambiguous without it |
| 40 | managed-settings prefetch | OCC has no managed-settings source (trimmed surface) |
| 43 | bash edit-diff wording | wording seam not byte-locatable in the ELF this round |

### 1.3 N-A (39 entries)

Backend-only / VSCode-only / Windows-only / Growthbook-server-side / features OCC trims by
design. Each carries an absence proof (OCC file:line or strings-diff evidence) in
`docs/gap-research-293/triage-293.md` — not reproduced here.

## 2. Carry-over items (Leader kickoff §二)

### 2.2 OCC-149 ledger §7 security cluster (4 items) → `security-cluster-292.md`

1. **UNC path read gate — VULNERABLE → PORTED.** Step A: reclassify `decisionReason.type`
   `'other'`→`'safetyCheck'` (filesystem.ts:1915-1929) so asks are bypass-immune across
   hook-allow/auto-mode/bypassPermissions lanes; Step B: anywhere-match via existing
   `containsVulnerableUncPath` (pathValidation.ts:399); Step C: pre-I/O gate in
   FileReadTool (official reason string `read_file: untrusted UNC path rejected before
   filesystem access`). KISS option (ii): reject ALL UNC — no `trustedNetworkDirectories`
   in OCC. **LANDED** — Step A: filesystem.ts UNC read decision `'other'`→`'safetyCheck'`
   + `classifierApprovable:false` (behavior stays `ask`, message byte-unchanged; all three
   immunity floors already honor `safetyCheck` — permissions.ts needed NO change, lane tests
   #2/#3/#4 prove it); Step B: anywhere-match via `containsVulnerableUncPath` alongside
   platform-independent `\\`/`//` prefix checks; Step C: FileReadTool hard pre-I/O reject
   (errorCode 1, official reason verbatim — validateInput reject can't be short-circuited
   by hook-allow/auto/bypass). 27 new tests (RED 24-fail → GREEN 30/0); permissions 343/0,
   FileReadTool 58/0, adjacent tools 1036/0; `'other'`/`'safetyCheck'` consumer-neutral
   (grep-verified). Deviations documented: rejects ALL UNC (option ii), prefix checks kept
   (helper is Windows-gated), POSIX runtime doesn't gate windows-shaped paths (regression-
   tested).
2. `/ultrareview` seed-admin — **IMMUNE-N-A** (OCC has no /ultrareview; file:line proof in report).
3. Sandbox read-deny mid-session — **IMMUNE-N-A** (proof in report).
4. Tampered settings cache — **IMMUNE-N-A** (proof in report).

### 2.3 #018 WebFetch offset helper-set + call-site gate → `webfetch-018-forensics.md`

- Gate RESOLVED: verbatim reader `LLo` lives only inside the built-in `web-fetch` subagent,
  env `CLAUDE_CODE_WEB_FETCH_AGENT` ?? `tengu_clever_orbit` (default false) → subagent chain
  stays out of OCC.
- **#018a PORTED**: offset param schema+coercion, surrogate-safe slicers, `past_end`,
  contentLead + coverage note + `M2t` continuation string (verbatim
  ` — to read on, call ${dr} again with the same url and offset: ${e}`), redirect offset
  echo, maxResultSizeChars 50k fix, localhost bullet. New modules:
  src/tools/WebFetchTool/{coerceInput,offsetParam,textSlice}.ts. **LANDED** — new
  textSlice.ts (≡ `ne`/`Xl`/`f`), offsetParam.ts (OFFSET_DESCRIBE/XMe/past_end/M2t/
  contentLead/coverage note verbatim), coerceInput.ts (≡ `zKt`/`tLo` 3-stray dropper);
  WebFetchTool.ts (offset schema, 100k→50k, official branch order past_end→raw_markdown→
  secondary_model, redirect `- offset: N` echo), utils.ts contentLead 6th param, prompt.ts
  localhost bullet; RED 29-fail → GREEN 67/0 new, WebFetchTool dir 126/0, referrers 27/0.
  Deviations: local `coerceNumericString` (semanticNumber.ts diverges from XMe),
  `skipAggregateToolResultBudget` absent from OCC Tool type, `T4`+dedup telemetry not ported.
- **#018b STAGED**: LLo+ZK+subagent chain (depends on built-in web-fetch subagent OCC
  doesn't ship).

### 2.4 OCC-110 Cluster C residual (not covered by OCC-149) → `cluster-c-h-carryover.md`

- **C1 PORT**: ripgrep fd-3 unreadable-file lane (ripgrep.ts:901-910 ≡ `zB` @208906460).
  **LANDED** — `RipgrepTargetUnreadableError` (`zB`) + errno constants + shell-hint +
  `RG_FD3_PIN_TARGET` const; official dispatch order XB→zB→uf→JB→rir→resolve; glob.ts
  threads `rejectOnInputError`; real-rg 14.1.0 probe as `nobody` (chmod-000 → exit 2,
  os error 13); 19 tests. **fd-3 pin lane STAGED** (no inheritFd/4th-stdio-slot in OCC —
  const+message arm ported for taxonomy parity, unreachable).
- **C3 PORT (residual)**: guard trio @215048836 (extensionless/image/plan-file exclusions),
  `displayPath`, null-drop for blocked oversize, logEvent pre-guard. **LANDED** (atMentionGuard292,
  5 tests).
- **C4 PORT**: escaper family (`AT` two-stage `escapeSystemReminderContent`, `Bbe=Ol∘AT`
  `wrapInSystemReminderEscaped`) + 6 hook sites + residual async bodies (jyt/tqr/nqr/rzt:
  Stop/TeammateIdle/TaskCreated/TaskCompleted). **LANDED** — base 6 sites (35 tests) +
  residual wiring: hooks.ts:3315/3326/3337/3348 builders, :1247/:1269 handleAsyncRewakeExit2
  (`Ol`→`Bbe`), query.ts:1601 Stop-hook additional-context (`Ol`→`Bbe`); stopHooks.ts needed
  no edit (builder-level fix); residual tests RED 9-fail → GREEN 14/0; touched-file suites
  227/0. Not wired (consumers outside scope, reported): `getPreToolHookBlockingMessage`,
  `getUserPromptSubmitHookBlockingMessage`.
- **C5 PORT (residual)**: Read `_7n` drops `description`; Grep `cEt` `file_path`→`path`
  coercion; WebFetch `zKt` drops `text_content_token_limit`/`html_extraction_method`/
  `web_fetch_pdf_extract_text`; WebSearch mode-dropper; `drop_command_create`.
  **Grep LANDED** (`coerceGrepInput` ≡ `cEt` behind `pH` gate, 16 tests; 139/0 across 11
  affected suites). **Read LANDED** (`coerceReadInput` ≡ `_7n` @214910800 —
  offset_array/limit_array/offset_neg/limit_dropped/length/drop_description — wired direct
  per official @214918706, 13 tests). **WebFetch LANDED** (coerceInput.ts ≡ `zKt`/`tLo`,
  pH-gated). WebSearch mode-dropper + drop_command_create: N-A in OCC (no WebSearch
  dropper seam / no command-create tool).
- **C6 PORT**: frontmatter/agents-dir name length cap `iY=256` (`M4t`/`BFo`/`EXn` verbatim:
  warn `Frontmatter "name" of <label> is over 256 characters - ignoring it`, error
  `Invalid "name": names must be at most 256 characters`, length check BEFORE `:` reject).
- **C10 PORT**: CLAUDE.md freshness session store — 4 REASONS incl. `unjudged`, caps
  200/20, `withheld_memory`. **LANDED** — new `src/utils/withheldMemory.ts` (≡ official `rfe`,
  KEPT_MOST=200/SHOWN_MOST=20/PATH_MARK, full API + AsyncLocalStorage per-pass collector);
  claudemd.ts `kbt` judge (denied/unjudged) rewired through `safelyReadMemoryFileAsync`;
  attachments.ts WithheldMemoryAttachment + Kun/Vun producers; messages.ts `withheld_memory`
  arm; AttachmentMessage.tsx UI arm (cap-20 rows + overflow line); 26 tests. Deviations
  documented in code headers (AX `ve()` gate omitted — subsystem absent; ALS collector
  instead of threaded Map). STAGED leftovers: unexamined too-large producers beyond
  @-mention, literal `onTooLarge` callback + sizeProbe lane, `/cd` memory-cache reset.

### 2.5 Cluster H final verdicts (L26/L28/L69)

- **L26 PORT (partial)**: sidechain-via-writer + shutdown nuance + compact-pair taint
  (sessionStorage.ts:1421-1458 ≡ @215946500). **LANDED** — persist guard + seal machinery
  in sessionStorage.ts; new test file 6/0; sessionStorage family 55/0; N-A guards
  source-pinned (`/teleport` skip `jZn`, compact-pair taint `Tve`/`foreignWithheldEntryUuids`/
  `yk`, `preservedEventIds` delta); handoff: ccrClient seal-wiring.
- **L28 PORT Phase 1 / STAGED Phases 2-4**: `deliverWithoutCancel?` on SendNowFlushDeps
  (≡ `Irt/Ert/Drt`), `tengu_velvet_panda`-equivalent flag default true, existing flush core
  kept as `Drt` fallback, telemetry `input_send_now_key` + `fell_back_to_cancel` verbatim.
  Phases 2-3 (queue priorities, tool-detach registry) staged — larger subsystem rework;
  Phase 4 N/A (CCR send_now absent in OCC). **Phase 1 LANDED** — `deliverWithoutCancel?` on
  SendNowFlushDeps, `isSendNowFlushable` ≡ `Tst/Ert`, `flushQueuedMessagesCore` refactored
  to `_st`/Drt fallback form, `sendQueuedNow` ≡ `Cst` with gate param default true
  (`SEND_NOW_DELIVER_WITHOUT_CANCEL_GATE='tengu_velvet_panda'`, ≡ `NSn(){return T("tengu_velvet_panda",!0)}`
  @214600349), REPL call-site injects `getFeatureValue_CACHED_MAY_BE_STALE(GATE,true)`,
  telemetry `input_send_now_key`+`fell_back_to_cancel` verbatim; 17 new tests + 1 stale
  sendNow275 assertion updated; sendNow family 101/0. Deviation: `deliverWithoutCancel`
  optional w/ undefined-guard (OCC has no lowLatency `EIt` engine until Phase 2+ → flushes
  take fallback + log `fell_back_to_cancel`, semantically identical).
- **L69 N/A** with proof (cluster-c-h-carryover.md).

## 3. Implementation & test results

14 parallel implementation agents (disjoint file ownership, single worktree), every port
TDD RED→GREEN. Per-entry detail lives in the §1.1 PORT table and §2.x carry-over rows;
aggregate green numbers:

| Suite family | pass/fail |
|---|---|
| BashTool dir (incl. NEW bashReadCommands.ts ≡ TBr/FBr/_Rn/cRn + rewired BashTool.tsx) | 1019/0 (2407 expects) |
| Model domain (Haiku 5.5 launch: 21 files, catalog/pricing/alias-flip/HLo guidance) | 427/0; launch suite 50/0/122, adjacent 223/0, cost 12/0, model e2e 43/0 |
| Permissions/filesystem (safetyCheck reclass + FileReadTool UNC/coerceInput ≡ _7n) | 343/0 |
| WebFetchTool dir (NEW textSlice/offsetParam/coerceInput + 50k cap, branch order) | 126/0 |
| vim + keybindings + cli handlers (#33–36, purge-exit) | 186/0 (542 expects) |
| effort family (#7 ModelPicker clamps + effortWrap293) | 144/0 |
| sendNow family (L28-P1 `tengu_velvet_panda` gate) | 101/0 |
| C4 residual escaper sites (hooks.ts ×6 + query.ts:1601, Ol→Bbe) | 227/0 touched-file; residual wiring 14/0 (RED 9-fail first) |
| asciiFirstSort293 (#46 `compareNamesAsciiFirst` ≡ ZCe + attachments.ts agent-listing sort) | 17/0 |
| ALL 13 new `*293*` unit/integration test files, isolated run | 201/0 (530 expects) |

New this round: ~47 files (44 new test files + NEW src modules `bashReadCommands.ts`,
`asciiFirstCompare.ts`, `earlyStoppingGuidance.ts`, `withheldMemory.ts`, `nameSafety.ts`,
`sendNow.ts` additions, WebFetchTool `textSlice/offsetParam/coerceInput`,
`remoteBridgeCoreHistoryReflush293` etc.), 1 deletion pair (#38 revert:
`autoModeOutcomeGuidance.ts` + its 281 test), plus removal of the dead
`src/services/compact/src/` stub tree (10 files, zero references — same pattern as the
OCC-90 `api/src/` cleanup).

Deviation register (reasoned, all in §1.1/§2 rows): growthbook gates stubbed per OCC
convention (`tengu_idempotent_wolf` default-true, `tengu_velvet_panda`,
`SEND_NOW_DELIVER_WITHOUT_CANCEL_GATE`); `deliverWithoutCancel` optional w/
undefined-guard (no lowLatency engine in OCC → fallback path, semantically identical);
`anthropic_google_cloud` folds into firstParty (standing divergence); C4 consumers
`getPreToolHookBlockingMessage`/`getUserPromptSubmitHookBlockingMessage` not wired
(out of scope, reported); Haiku `long_prompt` pricing data ported but consumption
wiring STAGED (no official consumption site extracted).

## 4. Full-suite & e2e verification

**Build**: green — `dist/cli.js` 29.93 MB, `MACRO.VERSION=2.1.374` injected from
package.json, `BINARY_NAME=occ`.

**Lint**: Biome clean on all 105 touched files (2 ineffective `noConsole`
suppressions removed from `src/utils/betas.ts` along the way).

**Unit full-suite git-stash A/B (zero-regression discipline)**:
- Changed tree: 690 files / 8670 tests → **8566 pass / 103 fail**.
- `git stash -u` → clean HEAD (`5a3299f`, v2.1.374): 657 files / 8242 pass / **105 fail**
  (pre-existing env/order-pollution failures — the suite's standing flake set).
- `git stash pop`, failure-SET diff (sorted, timing-stripped): **4 new − 6 fixed**.
  - The 4 new: `bashReadCommands293.integration` only — real-shell-spawning tests that
    flake under 690-file parallel load; **pass 4/4 isolated (1175 ms)**.
  - The 6 gone: baseline `modelOptionsHelpers280 getModelOptions` failures FIXED this
    round (test updated for the Haiku 5.5 alias flip, #078 plan-tier family).
  - Pollution suspects (`anthropicDefaultModel236`, `disableWebFetch285`,
    `allowWebFetchPolicy285`, `envBearerFallback285`, `mcpOAuthFlowWiring274`) fail
    identically at baseline and pass isolated (73/0). **Zero real regressions.**
- All 13 new `*293*` test files, isolated run: **201/0** (530 expects).

**Docker e2e (`bash test/e2e/run.sh`, ubuntu:24.04 + bun 1.3.14) git-stash A/B**:
- Round 1: changed tree 657 pass / **76 fail** vs baseline image **73 fail**; set diff =
  exactly 3 new, 0 gone:
  1. `version-2.1.122-env-fcluster` F15 — source-contract assertions still expected the
     pre-#47 shape; **FIXED** by updating to the new `Ix`-compliant `emitAtMention`
     wrapper contract (verified green, 1 pass / 8 expects).
  2. `version-2.1.293-ascii-first-agent-listing` ×2 — **root-caused to the image, not
     the port**: the e2e image had no `rg` binary, and OCC's markdown-config
     enumeration (`loadMarkdownFiles`, `src/utils/markdownConfigLoader.ts`) spawns
     `rg --files --hidden --follow --no-ignore --glob *.md` by default; every
     resolution lane (embedded → vendor → system rg → `grep -rn` last resort) fails
     in-container, and the `isFsInaccessible` catch silently returns `[]` → project
     agents load empty. Same host-built dist works on host (system rg present) and
     fails in container → environmental. **FIX**: `ripgrep` added to the Dockerfile
     apt layer (aligns container with host/real-user environments); manual
     in-container `apt-get install ripgrep` + rerun → **2/2 pass (4.08 s)**.
- Round 2 (rebuilt image with ripgrep, full suite): **660 pass / 73 fail / 1 skip**
  (734 tests, 156 files, 983 s). Failure SET (whitespace-normalized, deduped → 66
  unique) is **byte-for-byte IDENTICAL to the clean-HEAD baseline set** — F15 and both
  ascii-first tests now green in-container; zero regressions from the round AND zero
  behavior shift from adding ripgrep to the image.

**REPL tmux e2e** (persistent runner container, `--user occ` non-root, real model
endpoint, tmux 3.4): `repl-interactive.e2e.test.ts` **2/3 pass** — "Shift+Tab cycles
through permission modes" ✅, "/goal panel opens and Escape dismisses it" ✅; the one
failure ("Shift+Tab shows the auto-mode opt-in dialog") is the documented pre-existing
failure — present in the clean-HEAD baseline set and A/B-verified as failing identically
with and without round changes since OCC-44. Live interactive REPL boots, mode-cycles,
and panel-dismisses correctly on the built artifact.


## 5. Release disposition

Per issue discipline: no release this round — tag/publish/GitHub-Release flow happens only
after 验收员 acceptance (and npm E404 does not block tag + GitHub Release when it does run).

## 6. 2.1.294 (next channel) pre-triage留档

Observed on the `next` channel at research time (out of scope this round; 2 entries):

1. Fixed `prompt` and `agent` hooks written as instructions (such as "Block commands
   that...") allowing what they should block — **likely PORT next round** (OCC has prompt/
   agent hooks; classifier-judgment seam in hooks pipeline).
2. Improved how `prompt` hooks on Stop and SubagentStop written as instructions (such as
   "Carry on if the build is broken") are judged, so Claude is less likely to stop early —
   same seam; triage together with #1 when 2.1.294 hits `latest`.

Next-round entry point: re-run 三方 verification (npm latest / GitHub release / fresh ELF),
binary-diff 2.1.293↔2.1.294, then triage these 2 + anything new.
