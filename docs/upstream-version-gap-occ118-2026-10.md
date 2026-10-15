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

<!-- PORT_RECORD -->

### #2 — OTel `api_request` cache-write lifetime split ✅ LANDED (commit `a935bb3`)

- **Evidence:** v300 ELF `api_request` builder @227727872 (`dd` excerpt): `...cache_creation_tokens:w.cache_creation_input_tokens,cache_creation_5m_tokens:w.cache_creation?.ephemeral_5m_input_tokens??0,cache_creation_1h_tokens:w.cache_creation?.ephemeral_1h_input_tokens??0,...`; v299 builder @226508395 has zero `cache_creation_5m/1h` hits. Field names also in v300 OTel attribute table @107102784.
- **Change:** `src/services/api/logging.ts` `logAPISuccessAndDuration` emit site — added `cache_creation_5m_tokens: String(usage.cache_creation?.ephemeral_5m_input_tokens ?? 0)` and `cache_creation_1h_tokens: String(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0)` after `cache_creation_tokens`, preserving OCC's String()-wrapped attribute convention (value semantics identical to official `??0`).
- **Tests:** `src/utils/__tests__/apiRequestCacheSplit300.test.ts` (TDD: RED 0/3 → GREEN 3/3) — full split, missing `cache_creation` → "0"/"0", partial 5m-only → 1h "0"; pre-existing attrs untouched. OTel-adjacent regression files (atMentionOtelCap293, doctorOtelHeaders275, otelHeadersHelperFailure275) all pass.

## 4. e2e / A/B acceptance

<!-- E2E -->

## 5. npm publish debt re-check (owner-side, report-only)

Re-verified 2026-10-16: npm `@cnwenf/occ` dist-tags `latest` = **2.1.367** (unchanged); repo tags through **v2.1.383** → 2.1.368–2.1.383 (15 versions; v2.1.371 never tagged) still unpublished. `publish.yml` runs for v2.1.381/v2.1.382/v2.1.383 all `failure` (E404 `PUT /@cnwenf%2focc` — `NPM_TOKEN` lacks write scope). **Owner-side; not agent-fixable. Carried, not blocking** — tag + GitHub Release continue to publish normally per Leader ruling.

## 6. Delivery

<!-- DELIVERY -->

## 7. Final adjudication & carryover (authoritative entry for next round)

<!-- ADJUDICATION -->
