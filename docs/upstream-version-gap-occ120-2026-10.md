# Upstream Version Gap — OCC-120 Round (2026-10): claude-code 2.1.301 → 2.1.302

> Status: **COMPLETE** — all 12 PORT items landed, 137 new tests green (CI=true), build green, live `-p` + tmux REPL e2e green, release `2.1.388`, merged to main. §5 implementation · §6 e2e · §7 merge/release.
> Prior-round ledger: [upstream-version-gap-occ119-2026-10.md](./upstream-version-gap-occ119-2026-10.md)
> Skill discipline: `upstream-tracking` + `aligning-with-official-binary`. Official ELF **never executed** — `strings` / `grep -aboF` / bounded `dd` only.

## 1. Baseline (verified 2026-10-18, this run)

| Item | Value |
|---|---|
| OCC internal version (pre-round) | 2.1.387 (tracks official 2.1.301) |
| Official `latest` / `next` | **2.1.302** / 2.1.302 |
| Official `stable` | 2.1.292 (< 2.1.296 → **STAGED trigger NOT fired**; STAGED set carries as-is) |
| Changelog entries in ## 2.1.302 | **63** (numbered #01–#63 in `docs/gap-research-302/entries-63.txt`) |
| v301 tarball | `anthropic-ai-claude-code-linux-x64-2.1.301.tgz` — 119,872,477 bytes |
| v301 ELF | `package/claude` — 267,955,384 bytes — md5 `7f52c3d8eda2796a6002cb7380aabfb9` |
| v302 tarball | `anthropic-ai-claude-code-linux-x64-2.1.302.tgz` — 129,008,778 bytes |
| v302 ELF | `package/claude` — 285,793,528 bytes — md5 `39885c1377a0f0d922b73bf8653a6c3f` |
| `strings -n 8 \| sort -u` | v301: **326,698** · v302: **335,837** |
| `comm -13` (new in v302) | **27,669** |
| `comm -23` (removed from v301) | **18,530** |
| npm `@cnwenf/occ` published | 2.1.367 (E404 debt 2.1.368–2.1.387, owner-side, report-only) |

All md5s / tarball sizes / marker counts re-verified this run against the Leader's kickoff baseline — exact match.

## 2. Inherited CI debt — ROOT-CAUSED + FIX FORWARDED (this run)

**Symptom (inherited from OCC-118/119):** `src/services/api/__tests__/toolSearchHoldWiring300.test.ts` red **only on GitHub runners** (bun 1.4.2, `CI=true`); every local repro attempt passed.

**Root cause (verified this run):** the test's `mock.module` for `src/services/vcr.ts` mocked `withVCR`/`withStreamingVCR` but **not** `withTokenCountVCR`. The control test's `count_tokens` probe routes `checkAutoThreshold → getDeferredToolTokenCount → countMessagesTokensWithAPI → withTokenCountVCR → withFixture`, and `withFixture` (`src/services/vcr.ts:39`) has a **CI-only throw branch**: `if ((env.isCI || process.env.CI) && !VCR_RECORD) throw "Fixture missing"` (fixture root = per-test tmpdir, never committed). Locally (`CI` unset) the same call RECORDS instead → passed everywhere except runners. On CI: throw → `getDeferredToolTokenCount` catch → `null` → char-threshold/haiku fallback path consumed the single queued SSE fetch-mock responder → main query's fetch threw "unexpected fetch call" → retry/backoff → bun test timeout. Exact runner-only failure profile.

**Repro (local, deterministic):** `CI=true NODE_ENV=test ANTHROPIC_API_KEY=sk-ant.test-dummy bun test src/services/api/__tests__/toolSearchHoldWiring300.test.ts` → control case timeout @5000ms (2 pass / 1 fail — the CI profile).

**Fix (landed this round):** added a `withTokenCountVCR` **pass-through** to the test's existing `mock.module` block — `(_messages, _tools, f) => f()` — making the wrapper env-independent so the probe reaches the fetch mock on every env. Verified: `CI=true` → **3 pass / 0 fail** (1212ms); local (CI unset) → 3 pass (1243ms). Also verified the only other `withTokenCountVCR` consumer (`src/tools/FileReadTool/__tests__/allowLarge296.test.ts`, which replays the **committed** fixture `fixtures/token-count-09e10c60250c.json`) → 54 pass under `CI=true` — no other test harbors the latent CI-only fixture-throw pattern.

**Adjudication:** fix-forward (not a test skip, not a product change — test-harness mock gap only). Expect CI green after merge.

## 3. Triage — 63 entries

Cluster files (per-entry evidence, byte offsets, dd dumps, landing points):

- T1 (API/model/compaction/OTel): `docs/gap-research-302/triage-T1.md` — entries #01 #04 #05 #07 #08 #14 #19 #28 #29 #36
- T2 (tools/plugins/hooks/permissions): `docs/gap-research-302/triage-T2.md` — entries #06 #09 #10 #11 #18 #21 #23 #25 #26 #27 #30 #31 #32 #35
- T3 (UI/render/surfaces + batch N-A): `docs/gap-research-302/triage-T3.md` — entries #02 #03 #12 #13 #15 #16 #17 #20 #22 #24 #33 #34 + batch N-A #37–#63

### Disposition summary

Adjudicated 2026-10-18. T2 (14 entries) + T3 (12 + batch 27) complete and **personally binary-re-verified** by the lead (marker counts + JS-region dd dumps below); T1 (10 entries) filled from `triage-T1.md`.

| # | Entry (short) | Disposition | Cplx | Landing point / rationale |
|---|---|---|---|---|
| 01 | `CLAUDE_CODE_AUTO_MODE_MODEL` env | **PORT** | M | `yoloClassifier.ts:1516-1520` — drop ant-gate + invert precedence to official `HYe` ladder (config → env w/ warn-once `env:shadowed` → probe → default) |
| 02 | Idle-compaction `/config` row | STAGED | L | whole idle-compaction subsystem absent (0 hits `idleCompaction`); blocked on porting the v2.1.290 feature |
| 03 | `/design-sync` closing notice | N-A | — | no design commands in OCC |
| 04 | "Prompt is too long" on stop-during-compact | CAND | — | delta is rename-only (minifier shuffle; reactive-compact loop v301 `O0n` ≡ v302 `eNn` byte-identical modulo renames); not isolatable → recorded, not guessed |
| 05 | Vertex/Bedrock mid-session `diagnostics` 400 | N-A | — | OCC never sends `diagnostics.previous_message_id` (cache-diagnosis beta is GrowthBook-gated; sticky-flag mechanism absent) |
| 06 | Read-tool image unbounded slurp → 128 MB refusal | **PORT (security)** | M | `FileReadTool.ts:1326` + `fsOperations.ts:918` + `attachments.ts:2676`; cap 134217728, chunks 65536 |
| 07 | `/autocompact`·`/effort` gateway-prefixed Opus model save | **PORT** + STAGED sibling | S | alias-conditional normalizer (`dFt` verbatim @237166167) at `autoCompactWindow.ts:227,291,624,649` + `autocompact-noninteractive.ts:75,118`; `/effort` per-model persistence = STAGED sibling (not bundled) |
| 08 | prompt-cache miss, mid-session tool re-load | **PORT** | M | `ToolSearchTool.ts:194-204/:358-410` loaded-set short-circuit (official `Kt`/`Yt` @244203400, isMeta text verbatim); `buildSearchResult` gains newMessages (`Tool.ts:412`) |
| 09 | plugin subcommands exit before write drain | ALREADY-ALIGNED | — | OCC writes synchronous (`file.ts:362`, `config.ts:1218`); no async queue |
| 10 | reftable: marketplace re-clone + version "unknown" | **PORT (version half)** / STAGED (marketplace half) | S | `gitFilesystem.ts:600/:221` reftable fallback (`refs/heads/.invalid` sentinel → `git show-ref --verify --hash --end-of-options`); marketplace probe chain byte-identical v301↔v302 → STAGED |
| 11 | pwsh plugin `bin/` PATH + Select-Object | STAGED | — | plugin-bin-PATH mechanism absent in OCC; Select-Object half zero string delta |
| 12 | desktop-app MCP authorize pointer | N-A | — | OCC is CLI, not Electron desktop |
| 13 | artifact publish empty-edits/retry | N-A | — | `ReviewArtifactTool.ts` stub; no publish pipeline |
| 14 | OTel `classifier_category` + attribute push-out | **PORT (B)** / N-A (A) | M | B: `permissionLogging.ts:320-326` emit v302 attribute set in v302 order (dd-verified v301@227800703 vs v302@245156620) + add never-emitted `tool_use_id`/`tool_source`/`tool_parameters`; A (server-side classifier category): N-A — client-side category already produced (`toolExecution.ts:1355`) |
| 15 | agents-view blank rows | N-A | — | OCC lists non-virtualized (`AgentsList.tsx`), structurally immune |
| 16 | `remote-control --help` signed-out exit | **PORT** | S | `cli.tsx` bridge fast-path help delegation before auth gate — **LANDED** (+4 tests) |
| 17 | `/design consent` cloud-session msg | N-A | — | no design commands (batch with #03) |
| 18 | MCP 2026-07-28 resultType/ttlMs/cacheScope | N-A (advisory) | — | SDK 1.29.0 never negotiates 2026-07-28; revisit on SDK upgrade |
| 19 | prompt suggestions credits skip | **PORT** | M | 3 layers: `overageInUse` header parse (`claudeAiLimits.ts`) → `queryTracking.billedToUsageCredits` (`query.ts` response sites) → `"usage_credits"` reason in `promptSuggestion.ts:107-119` (official v302 gate `x(e,n)`) |
| 20 | backtick URL clickable first row only | ALREADY-ALIGNED | — | per-row OSC-8 + `id=` grouping correct (`render-node-to-output.ts:685-701`); adjacent CAND: codespan linkify `markdown.ts:316-319` |
| 21 | `plugin details <name>@builtin` message | N-A | — | no `plugin details` subcommand (`main.tsx:4797`) |
| 22 | emoji-at-link-start wraps 1 col too wide | CAND | M | `stringWidth.ts:106-127` + `sliceAnsi.ts:45-46`; needs repro first |
| 23 | worktree refusal, stray gitfile (git ≥2.56) | **PORT** | S | `worktreeBaseResolve.ts:136` add `/gitfile does not point to a valid repository/i` to no-repo class |
| 24 | cloud-session cost zeroes on resume | N-A | — | no cloud-session cost tracking |
| 25 | runner reftable "bad object refs/heads" | N-A | — | `self-hosted-runner/main.ts` dead stub (flag not allowlisted) |
| 26 | Windows exFAT/FAT32 writes refused | N-A | — | no fs-type permission surface; markers 0/0 both ELFs |
| 27 | plugin startup fs-call reduction | STAGED | — | mechanism unrecoverable (pure refactor); new withFileTypes code = dev-mods watcher |
| 28 | auto mode server-side classifier compaction | N-A | — | server-side classifier surface absent in OCC (client-side auto mode only); delta lives in the server-path unavailable-result constructor (`r0t`→`cHt`) |
| 29 | bg session no-gateway message | N-A | — | `CLAUDE_BG_GATEWAY_WITHHELD` bg-session/respawn mechanism absent in OCC (daemon path is OCC-specific) |
| 30 | -p/SDK no-mode → `default` on 3P/fresh | ALREADY-ALIGNED | — | OCC always starts `default` in -p/SDK (`permissionSetup.ts:911-913`); `--permission-mode auto` honored |
| 31 | fork subagents default-on in -p/SDK | **PORT** | M | `forkSubagent.ts:40-47` drop non-interactive exclusion; official `qcn()` precedence + new `forkSubagentDisabled` config |
| 32 | forced-background subagents per surface | **PORT (coupled #31)** | S | `AgentTool.tsx:135-137/:610` swap fork predicate to `vat()` analogue |
| 33 | `← for agents` hint hides after 10s | STAGED | M | OCC renders neither hint nor waiting counter (OCC-108 divergence); prerequisite work first |
| 34 | Chrome instructions moved for prompt cache | ALREADY-ALIGNED | — | Chrome text already cache-stable tail (`claude.ts:2073`, `systemPrompt.ts:126`) |
| 35 | ≤12 concurrent prompt/agent hooks | **PORT** | S | `hooks.ts:4560` partition + capped merge via `generators.ts:31` `all(...,12)` (official `ant=12`/`Iee`/`ZRn`) |
| 36 | `/feedback` policy-off message → GitHub issues | N-A | — | org-policy gate surface absent in OCC's `/feedback`; v302 wording recovered verbatim in `triage-T1.md` for any future alignment |
| 37–63 | VSCode ×3 · Cloud ×8 · Remote Control ×1 · Claude Tag ×14 · Code Review ×1 | N-A ×27 | — | no extension (`from 'vscode'`=0), no web UI, `remoteControlServer/index.js`=`export default {}`, no Slack bot/admin |

**Net (all 63 entries):** PORT ×12 (#01 #06 #07 #08 #10(version half) #14(B) #16 #19 #23 #31 #32 #35) · ALREADY-ALIGNED ×4 (#09 #20 #30 #34) · STAGED ×4 entries + 2 partials (#02 #11 #27 #33; #10 marketplace half; #07 `/effort` per-model sibling) · CAND ×2 (#04 #22) · N-A ×41 entries + 1 partial (#05 #28 #29 #36 #03 #12 #13 #15 #17 #18 #21 #24 #25 #26 + batch #37–#63 ×27; #14 part A). Counts: 12+4+4+2+41 = 63 ✓ (#10/#07/#14 each counted once in their primary bucket).

### PORT items — evidence & landing points

All evidence personally re-verified this run against `/tmp/cc-diff-302/{v301,v302}/package/claude` (strings + `grep -aboF` + bounded `dd`; official binary NEVER executed). JS-region threshold: v301 ≥ ~216M, v302 ≥ ~233M (string-table region below that produces false positives — occ119 methodology fix).

- **#06 image read cap** — refusal-message markers v301=**0** → v302=**2** (`File is too large to read as an image (the limit is`, `is a pipe or a device, not a regular file, and it sent more than`); constants `134217728` (`cB`/`S_o`) + `65536` (`zXr` chunk) recovered from v302 JS region; v301 image read was unbounded `DW(e.handle,1/0,"stream")`. OCC landing: `FileReadTool.ts:1326` image branch → `readImageWithTokenBudget` (no byte cap), `fsOperations.ts:918` `readFileBytes` uncapped fallthrough, `attachments.ts:2676`. Reasons: "File over the image read limit" / "Image stream over the read limit".
- **#10 reftable version detection** — `git show-ref --verify --hash --end-of-options` v301=9 → v302=**10** (new consumer); sentinel `ref: refs/heads/.invalid` 2/2 both versions (pre-existing reftable awareness); official resolver `M4` recovered verbatim (reftable check first → show-ref; else loose → packed-refs → commondir; null on every failure). Marketplace half STAGED: probe chain + `Skipping refresh for marketplace` 2/2 byte-identical. OCC landing: `gitFilesystem.ts` `getHeadForDir(:600)`/`resolveRefInDir(:221)` pure-fs only → plugin version "unknown" under reftable.
- **#16 remote-control --help** — v302 @117867900 dd-verified: Commander help machinery (`helpOption` `argParser` `hideHelp`) co-located with auth codes (`auth_failed` `stale_tunnel_credential`), help path FIRST; `remote-control` marker 134→135. OCC bug pattern identical (auth gate before bridgeMain's own pre-auth help print). **LANDED**: `cli.tsx:182-204` delegates `--help`/`-h` to `bridgeMain` via bridgeMain's OWN `parseArgs` (so `--name --help` keeps value semantics — no gate bypass); +4 tests `remoteControlHelp302.test.ts` green local & CI=true.
- **#23 gitfile classification** — `gitfile does not point to a valid repository` v301=**0** → v302=**2**; official classifier `GWt`→`pGt` gained the second regex (v301 @226603811 vs v302 @243939195, dd-verified). No git-version check — stderr text is the signal. OCC landing: `worktreeBaseResolve.ts:136-161` `classifyRevParseCause` only matches `/not a git repository/i`.
- **#31+#32 fork gate flip** — `forkSubagentDisabled` v301=**0** → v302=**3**; `CLAUDE_CODE_FORK_SUBAGENT` 4→**6**; "forced into the background" 0→**2** (describe-text update). Official `qcn()` precedence recovered: coordinator/mcp-serve → config `forkSubagentDisabled` → env=false → stored source → (kill-switch `tengu_federated_ullman` default OFF ⇒ enabled — N/A in OCC, GrowthBook stubbed; skipping = byte-equivalent default) → env=true?'env':'default' (non-interactive now DEFAULTS ON). `vat()=mse()&&(qcn()==="env"||!uL())` drives schema-omit + forceAsync. OCC landing: `forkSubagent.ts:40-47` (exact v301 shape incl. `getIsNonInteractiveSession()` exclusion), `AgentTool.tsx:135-137/:610`. FORK_SUBAGENT flag NOT allowlisted → env var stays the live switch; flag check unchanged.
- **#35 hook cap 12** — `hook-dispatch-hold` first hits are string-table region (v301@106739476 / v302@123339360 — false-positive trap); JS-region hits differ: v301@228890289 goes straight from HTTP-hook code to `var EEn="hook-dispatch-hold"`; v302@246249141 has **NEW** `var ant=12;function Iee(e){return e.type==="prompt"||e.type==="agent"}function ZRn...` inserted before, with keepalive wave budget `K=Math.max(1,Math.ceil(H/ant))`, `s=Math.min(w*K+60000,1200000)`. OCC landing: `hooks.ts:4560` uncapped merge; `generators.ts:31` `all(gens, cap)` is the `oJt` analogue.
- **#01 auto-mode model env** — `CLAUDE_CODE_AUTO_MODE_MODEL` consumers v301=**4** → v302=**9**; official resolver `HYe` recovered @244374771 (dd-verified): ladder = config `modelByMainModel` (wildcard `RYt` match) → env (warn-once `"env:shadowed"` via `loggedPolicySkips` Set when config shadows it) → `externalSonnet5Probe` → default; org-policy `a_e` can veto. OCC pre-fix `yoloClassifier.ts:1516-1520` read the env **ant-gated AND ranked over config** — inverted on both axes. Zero `modelByMainModel`/`loggedPolicySkips`/`externalSonnet5Probe`/arbiter hits in OCC (GrowthBook stubbed) → config slot = OCC's local config source; no server-side path added (part of #28 N-A).
- **#07 alias-conditional model key** — v301 ran the full user-specifier parser `xt` UNCONDITIONALLY inside the settings-key builder (@220815700/@219688663); v302 wraps it: `function dFt(e){return Xge(e.toLowerCase().trim())?Ot(e):e}` — dd-verified VERBATIM @237166050, `Xge` = membership in alias set `sU` (fable/opusplan/sonnet/haiku/opus/best). A gateway-prefixed concrete model (`anthropic/claude-opus-4-1`) now passes through untouched to canonicalization instead of being remapped to the default Opus before becoming the key. OCC leak confirmed: `getCanonicalName("opus")==="opus"` literal-key. STAGED sibling: `/effort` per-model persistence migration (top-level `effortLevel` → `modelSettings`) — deliberately NOT bundled.
- **#08 ToolSearch loaded-set short-circuit** — markers `Already available in this conversation` v301=**0** → v302=**2**, `no search is needed` 0→**2**; helpers `Kt`/`Yt` recovered @244203400-244206600 (absent in v301): all-requested-loaded → empty matches + isMeta note `Already available in this conversation: ${names.join(", ")}. Call ${names.length===1?"it":"them"} directly; no search is needed.`, tools array NOT mutated (the mutation was the cache-miss). OCC bug identical: both re-emission paths (`ToolSearchTool.ts:194-204` keyword, `:358-410` select) re-added already-loaded tools ("harmless no-op" comment was wrong).
- **#14B tool_decision attribute order** — emit site dd-dumped in BOTH ELFs this run: v301 @227800703 `{decision,source,...be,permission_mode,tool_name,tool_use_id,...PDr(mcpInfo),...tool_parameters}` vs v302 @245156620 `{decision,source,tool_name,tool_use_id,...w0r(mcpInfo),...tool_parameters,...be,permission_mode}` — identifiers FIRST, truncatable tail LAST (the fix for low `OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT`). `w0r`≡`PDr` = `{tool_source}` builtin/sdk_host_builtin_mcp/mcp. `classifier_category` marker 2→3. OCC `permissionLogging.ts:320-326` emitted the v301 ORDER and never emitted `tool_use_id`/`tool_source`/`tool_parameters` at all — both gaps closed. Part A (server-side classifier category) N-A: OCC's client-side classifier already produces `category` (`toolExecution.ts:1355`).
- **#19 usage-credits suggestion skip** — markers `billedToUsageCredits` v301=**0** → v302=**4**, `overageInUse` 8→**11**, `usage_credits` 6→**8**. Official v302 gate `x(e,n)`: after the v301 rate_limit check adds `if((n??o===!0)&&!(N0()||zU()||Cte()&&TLr()===null&&GE()===null))return"usage_credits"` where `o`=limits-state `overageInUse`, `n`=`queryTracking?.billedToUsageCredits` (per-turn recorded at BOTH response sites — non-streaming @246083313, streaming @246195727 — via `ePo` header parse). The five exemption predicates were NOT resolvable from the binary → NOT invented; ported conservatively behind OCC's existing internal-user checks. OCC `promptSuggestion.ts:107-119` was the exact v301 gate; all three layers (header parse → per-turn record → reason) landed.

## 4. Carryover from occ119 §7 (authoritative)

- STAGED #22 (vim read-loop), #23 (React-Compiler memo — resolved by OCC-160 WP-D), #30 (render leg), #31 (reftable advisory): carry as-is (trigger not fired).
- CAND ×8: unchanged unless this round's triage promotes/demotes one.
- Test floor (occ119 combined tree, local bun 1.3.14): **12570 pass / 2 fail / 12 skip · 1115 files**; both fails adjudicated non-regressions (argumentSubstitutionCaps301 = bun-version-specific, passes on CI's 1.4.2; dist-hljs-injection.e2e = load flake).
- Collision addendum: see occ119 ledger.

## 5. Implementation record

**All 12 PORT items landed** (#01 #06 #07 #08 #10-version-half #14B #16 #19 #23 #31+#32 #35), plus the §2 inherited-CI-debt fix-forward. Developed via lead + 3 parallel subagent work packages (#16+#10, #06, #19); lead-implemented cluster: #01/#07/#08/#14B/#23/#31/#32/#35.

**Modified source (21):** `src/Tool.ts` (buildSearchResult newMessages #08), `src/commands/autocompact/autocompact-noninteractive.ts` (#07), `src/entrypoints/cli.tsx` (#16), `src/hooks/toolPermission/permissionLogging.ts` (#14B), `src/services/PromptSuggestion/promptSuggestion.ts` (#19), `src/services/PromptSuggestion/speculation.ts` (#19), `src/services/api/claude.ts` (#19 billing record), `src/services/claudeAiLimits.ts` (#19 `overageInUse`), `src/tools/AgentTool/AgentTool.tsx` (#32 schema-omit + forceAsync swap to `isSubagentsForcedBackground()`), `src/tools/AgentTool/forkSubagent.ts` (#31 `qcn()` port + pre-enable guard), `src/tools/FileReadTool/FileReadTool.ts` + `limits.ts` (#06), `src/tools/ToolSearchTool/ToolSearchTool.ts` (#08), `src/utils/autoCompactWindow.ts` (#07 `dFt`), `src/utils/config.ts` (`isConfigReadingAllowed()` export — bug-2 fix below), `src/utils/git/gitFilesystem.ts` (#10), `src/utils/git/worktreeBaseResolve.ts` (#23), `src/utils/hooks.ts` (#35), `src/utils/model/model.ts` (#07), `src/utils/permissions/yoloClassifier.ts` (#01), `src/utils/worktree.ts` (#23), `src/services/api/__tests__/toolSearchHoldWiring300.test.ts` (§2 fix).

**New source (2):** `src/tools/FileReadTool/imageRead.ts` (official `qXr`/`oOn` capped reader — stat-first regular path + 64 KiB chunked pipe/device path, both refusal messages verbatim), `src/utils/hooks/promptAgentConcurrencyCap302.ts` (official `Iee` partition + capped merge, `ant=12`, keepalive wave budget).

**New tests: 15 files / 137 tests / 337 expects — all green under `CI=true` (combined run, 1.65 s):** remoteControlHelp302 · toolDecisionOtelFields302 · usageCreditsSuppress302 · claudeAiLimitsOverageInUse302 · usageCreditsRecording302 · forkSubagentGate302 · **forkSubagentPreEnableConfig302** (bug-2 regression pin) · imageReadCap302 · alreadyLoadedShortCircuit302 · autoCompactWindowAliasKey302 · worktreeGitfile302 · reftableFallback302 · hookConcurrencyCap302 · normalizeModelSpecifier302 · autoModeModelEnv302.

**Two bugs found during verification — both fixed:**

1. **(test-only) FIFO `close` race — `imageReadCap302.test.ts`:** the writer's close/error listeners were attached AFTER `await readImageBytesCapped()`; by then the writer had already exited and `close` had fired → the promise never resolved → 15 s timeout, but only when the file shared a worker with slower suites (order-independent, isolated green — observed vs `allowLarge296.test.ts`). Diagnosed via pair-bisection → instrumented copy (`DBG read returned 5000` — read fine; hang was post-read). Fix: attach the close/error promise immediately after spawn, before any await. Culprit pair 65/65 in 1.1 s. All scratch repro files deleted.
2. **(production, CRITICAL) `-p` startup crash `error: Config accessed before allowed.` (exit 1):** #31's `getForkSubagentSource()` read `getGlobalConfig()` unconditionally, but the resolver is reachable at MODULE-EVAL time — `buildTool()`'s `...def` spread (`src/Tool.ts:955-963`) invokes AgentTool's `get inputSchema()` getter, whose effort-describe (`AgentTool.tsx:99`, inside `lazySchema`) calls `isForkSubagentEnabled()` while tool modules initialize, and the `-p` path evaluates that graph BEFORE `enableConfigs()`. Every unit test missed it: `getConfig()` doesn't throw under `NODE_ENV=test`. Found only by the live headless e2e (§6) — the behavior-driven-done-gate doctrine vindicated. Fix: exported `isConfigReadingAllowed()` from `config.ts` (`configReadingAllowed || NODE_ENV==='test'` — same predicate as the gate) and guarded the read: `const config = isConfigReadingAllowed() ? getGlobalConfig() : undefined` + optional chaining on config terms 2/4 (pre-enable window treats them as unset; env/coordinator/flag terms still decide — matches pre-302 module-eval behavior). Documented as an OCC-specific divergence (upstream config is always readable). Regression pin: `forkSubagentPreEnableConfig302.test.ts` (3 tests — mocked config gate closed + `NODE_ENV=production` + throwing `getGlobalConfig`; asserts no-throw `'disabled'` env-unset, `'env'` with env=1, forced-background no-throw interactive). Verified no other round diff adds module-eval config reads. Re-verified: `-p` PONG EXIT=0 bare + fork-env (§6).

**Regression batches (all green):** tools dirs 395/395 (incl. culprit pair) · hooks+permissions+git+model+autocompact 1155/0 · PromptSuggestion+api+bridge 717/0 · services/__tests__ 9/0 · AgentTool+FileReadTool final 385/385. **Biome:** exit 0 on every changed file (9 warnings = pre-existing noise).

**Pre-existing failures attributed (NOT fixed — outside round scope):** `src/utils/__tests__` directory-mode run shows 12 failures on BOTH this tree and a pristine-HEAD baseline worktree (`git worktree add` @ b2aafe61 + symlinked node_modules; worktree removed after) — including `argumentSubstitutionCaps301` "budget covers named-arg values too" which fails isolated too (known bun-1.3.14-specific item, passes on CI's 1.4.2 — occ119 §7 adjudication). This round's tree adds +18 net passes in that directory (3073 vs 3055). Cross-file `mock.module` leakage (`rateLimitMessages299` vs `nonstreamingTimeoutRetries285/288` in one invocation) likewise pre-existing; `ci-test.sh` per-file isolation is the gate.

## 6. e2e record

Live-model environment (ANTHROPIC_BASE_URL gateway, model `glm-5.2`; the `[claude-code:unrecognized_model]` stderr warning is pre-existing env noise, non-blocking — round-trips succeed).

| Check | Command | Result |
|---|---|---|
| Build | `bun run build` | green — `dist/cli.js` 30.29 MB, MACRO.VERSION injected |
| Headless `-p` (the exact command that crashed pre-fix) | `echo "say PONG and nothing else" \| timeout 120 bun dist/cli.js -p` | `PONG`, **EXIT=0** (pre-fix: `error: Config accessed before allowed.`, EXIT=1) |
| Headless `-p` + fork env | same with `CLAUDE_CODE_FORK_SUBAGENT=1` | `PONG`, EXIT=0 |
| Version | `bun dist/cli.js --version` | `OCC 2.1.388` (post-bump rebuild) |
| REPL boot (tmux 200×50) | `bun dist/cli.js` | banner + model line (`glm-5.2 · xhigh effort · API Usage Billing`) + project line render |
| REPL model round-trip | `say PONG and nothing else` | `● PONG` |
| REPL `/status` | `/status` | panel renders: Version 2.1.388, Session ID, cwd, auth, base URL, model, MCP 2 connected/1 failed |
| REPL exit | `/exit` | session exited cleanly (tmux session gone) |
| occ-versioning + commands-alignment e2e | `bun test test/e2e/occ-versioning… commands-alignment…` | green (see §7 for post-bump run) |
| New-test combined run | 15 files | 137 pass / 0 fail / 337 expect |

## 7. Merge / release record

- **Release:** OCC `2.1.388` (package.json 2.1.387→2.1.388; CHANGELOG.md new `## 2.1.388 - 2026-10-18` section + header "Now tracking" chain updated; README 4 Tracks sites → `2.1.302 (partial)` — badge, What-is-OCC paragraph, Capability-parity table row, Status section). **Tag: NONE** (unchanged policy — post security-review/acceptance).
- **Branch/commit:** `agent/occ/e7e15363` — triage commit `b2aafe61` (docs) + implementation commit `feat(2.1.302): OCC-120 round …` → merged `--no-ff` to `main`, pushed origin.
- **CI:** <!-- FILL after push: run id + totals -->
