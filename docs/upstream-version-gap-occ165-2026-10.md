# Upstream Version Gap — OCC-165 Round (2026-10): claude-code 2.1.304 → 2.1.306

> Status: **IN PROGRESS** — §1 baseline · §2 triage · §3 implementation · §4 tests · §5 release.
> Prior-round ledgers: [upstream-version-gap-occ164-2026-10.md](./upstream-version-gap-occ164-2026-10.md) (2.1.304 supplement, released v2.1.395), [upstream-version-gap-occ163-2026-10.md](./upstream-version-gap-occ163-2026-10.md).
> Skill discipline: `upstream-tracking` + `aligning-with-official-binary`. Official ELF **never executed** — `strings` / `grep -aboF` / bounded `dd` only.

## 1. Baseline

| Item | Value |
|---|---|
| Round | OCC-165 — daily autopilot catch-up, started 2026-10-22 01:00 Asia/Shanghai |
| Dedup check | No in-flight tracking round (OCC-164 done) → real round, not a no-op |
| OCC tracked official version before round | **2.1.304** (package `@cnwenf/occ` 2.1.395) |
| Official latest at round start | **2.1.306** — three-way verified: npm dist-tags, GitHub releases, ELF version-marker counts (v305 ELF: 2643×`2.1.305`/0×`2.1.306`; v306 ELF: 2643×`2.1.306`/0×`2.1.307`) |
| Official v304 ELF | md5 `0209fe8a78dc4551b61bffda1978fca9`, 288,730,480 B |
| Official v305 ELF | md5 `8d40bc6057e980d4ea7e3a031f46c0e7`, 290,532,720 B |
| Official v306 ELF | md5 `69a7802bcefd854df2f16ecc9c08404d`, 290,532,720 B |
| Changelog delta | 40 entries (2.1.305: 38, 2.1.306: 2) |
| Collision check | origin/main == branch base `23e1edb5` at round start; no parallel round landed |
| Method | Byte-level forensics on v304/v305/v306 ELFs (anchored Δ mapping), 2 parallel research passes (API/model cluster, session/tools cluster); full reports preserved as issue comments `71ae29cd` / `6056d037` |

## 2. Triage — all 40 delta entries

### PORT (10)

| # | Entry (official) | Cluster | Key official evidence | OCC target |
|---|---|---|---|---|
| P1 | Tool-search refuse-recovery rewritten (2.1.304 regression: every request failing on Vertex/Bedrock/gateways that reject tool search) — v306 final form | API | `UZ` error class, `EF` thrower (verbatim warn `[ToolSearch] HTTP …sending the request again without deferred tools…`), named path `Rse`, anonymous path `N6`+`Ese`, gate `L6` (no provider check), success-side `hLe` heal, `tengu_beta_400_healed {beta,model,provider,status,unnamed:!jr}` | `src/utils/toolSearch.ts`, `src/services/api/claude.ts`, `src/services/api/withRetry.ts` — remove OCC's v304-form `toolSearchRefusedAt` 1-day window + `withoutToolSearch:!0` |
| P2 | API error replaced by "prompt is too long" + unneeded compaction in sessions with many MCP tools (only true v305→v306 delta) | API | v306 `Ese` adds `(!Jmn()||/\bdefer_loading\b/.test(to.message))`; `Jmn` = firstParty ∧ no ANTHROPIC_UNIX_SOCKET ∧ vf() ∧ ¬sH(), @249494776 | merged into P1's classifier chain (`src/services/api/errors.ts` already byte-aligned) |
| P3 | `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` | API | constants @249448500 `Afr=60000,wmn=300000,TQe=21600000,M_o=30000`; recheck loop @249463400 (verbatim); backoff `xN` @240347850 | `src/services/api/withRetry.ts` — 301-round watchdog exists, recheck absent; optional deps `isUsageLimitLifted`/`subscribeRetryWake` (absent → current behavior) |
| P4 | `/effort` `/autocompact` modelOverrides case/`[1m]` fix | API | official `Ja` uses `CA(s,n)` (case-insensitive, `Mt` strips `/\[1m\]$/i`) | `src/utils/model/modelStrings.ts:166` `override === modelId` → `modelIdsEqualAnyContext(override, modelId)` (helper exists at `modelDescriptors.ts:105-107`) |
| P5 | Bash on full disk: raw `ENOSPC` path → "disk is full, nothing ran" | Session | v306@249973898 new catch branch (verbatim text) + @237500817 `FSn`/`O_e={ENOSPC,EDQUOT,ENFILE,EMFILE}` | `src/utils/Shell.ts:472-520` (isE2BIG exists; add disk-full branch after it) |
| P6 | cloud/SDK `setMcpServers` server replaced by same-named settings server | Session | official edit string-less (handler region byte-identical); semantics from changelog | `src/cli/print.ts:2027` `!(name in supportedConfigs)` is the bug — invert precedence |
| P7 | Claude naming wrong model after subagent fallback switch | Session | v306@255043817 `⚠ This agent switched to ${…} because its earlier model could not be used.\n` + `iu()` helper; structured `{type:"system",subtype:"model_fallback",…}` (both versions, v304@254434741) | `src/query.ts:1155-1159` (bare text message today), `src/tools/AgentTool/agentToolUtils.ts` finalize |
| P8 | Bare-repo worktrees starting from local HEAD + unchanged subagent worktrees not cleaned up | Session | v306@250451652 `yot()` exactRef (`show-ref --verify --hash`) + @250461524 unconditional `^{commit}` peel; cleanup region byte-identical → same root cause | `src/utils/worktree.ts:392-393/:431-436/:483/:527`; `AgentTool.tsx:755-792` headCommit-falsy cleanup skip |
| P9 | `allowedMcpServers` no longer filters managed-mcp stdio servers using `${VAR}` only in `env` | Session | schema describe delta v304@237187100 → v306@238433800 (`${VAR}` scan narrowed to command/args/url/headers); predicate string-less | `src/services/mcp/config.ts:435-526/:1189-1200` (OCC lacks even the v304 base exemption — port straight to v306 final state; relates to OCC-37 staged item 19), `src/utils/settings/types.ts:535-544` describe |
| P10 | Cloud/teammates compaction dropping oldest messages without telling Claude | Session | `repeatsCompactSummary` 14=14 (pre-existing flag); withholding predicate v304@254166900 verbatim; official edit string-less | OCC has **0** `repeatsCompactSummary` hits — mechanism-level port: `src/types/message.ts` + compact entrypoints + cloud/teammate paths |

### ALREADY-ALIGNED (1)

| # | Entry | Why |
|---|---|---|
| A1 | Workflow resume re-running completed `pipeline()`/`parallel()` agents | Official bug root cause = chained journal keys (prev-pointer); OCC `journal.ts:53-66` uses content-sha256 keys — structurally immune. Optional micro-hardening: warn on `appendResult` failure (primitives.ts:756-759 swallows) |

### STAGED — real OCC surface, deliberately deferred to a future round (7)

| # | Entry | Rationale |
|---|---|---|
| S1 | `sandbox.allowNestedUserNamespaces` | Key absent from OCC `SandboxSettingsSchema`; security-sensitive sandbox wiring (lets sandboxed commands escape file protections) — deserves dedicated forensics, not a tail-of-round rush |
| S2 | `/usage` rows cut off in narrow terminals | OCC `usageWarnings.ts` exists; official fix is layout-work inside the usage table render — needs its own SR/width matrix pass |
| S3 | `/usage` one-line fixes + `f` applies them (also VS Code/`/doctor`) | Larger UX feature (fix registry + apply action); out of this round's budget |
| S4 | Startup warnings → debug log; no-op permission rules as warning rows | Needs forensics on the official banner/warning reorder; cosmetic-risk but touches boot path |
| S5 | Screen-reader: search boxes say "Search:", highlighted prompt text spacing | OCC `SearchBox.tsx` renders `⌕` prefix even under SR (half of the bug present); second half (Ctrl+R/ultrathink intra-word spaces) spans highlight renderers — bundle both in one a11y pass |
| S6 | MCP consent dialog Enter guard | OCC `MCPServerApprovalDialog.tsx` exists; official mechanism string-less — needs behavioral forensics on input-focus timing |
| S7 | Plugins mounted by path lose `allowed-tools` under `allowManagedPermissionRulesOnly` | OCC has the managed-rules surface (QueryEngine/SkillTool/permissionOptions); Claude-Desktop-path-mount edge needs plugin-loader forensics |

### N/A — no OCC surface (22)

| Group | Entries | Why N/A |
|---|---|---|
| Cloud sessions (3) | `claude -p` "Not logged in" (v306); Cloud environments admin save; self-hosted environment delete dialog | OCC has no cloud-session product surface (only incidental mentions in mcp config/ListPeersTool) |
| Self-hosted runner (3) | TERM/EAGAIN start script; GIT_CONFIG credential access; spawn-runner hook timeout | `src/self-hosted-runner/main.ts` is a 3-line stub |
| Cowork (1) | Scheduled cloud sessions waiting on WebFetch URL approval | No Cowork surface |
| Remote Control (2) | Empty "(session)" `/resume` entries; spawn-mode messages | OCC carries only a startup-setting migration, no remote-control session surface |
| Mods (2) | `Image` in iTerm2 3.5 fullscreen; docked pane ≤45% width | No mods system |
| VSCode (3) | Start-up-hooks spinner; "Compacting…" truncation; session-start-timeout message | No VSCode extension |
| Claude Tag (5) | Slack channel search; access bundles; DM-thread routines ×2; admin pages in large orgs | No Slack/Tag product surface |
| Code Review (2) | Newest-commit on multi-push; re-review LGTM with open blockers | No cloud Code Review surface |
| /artifacts (1) | Delete confirmation 1/Enter/2/Esc | `grep artifacts src/commands` = 0 hits — no `/artifacts` command |

## 3. Implementation record

All ten PORT items landed via 2 parallel implementation passes (API/model cluster P1–P4; session/tools cluster P5–P10) on `agent/occ-leader/5431779b`. 30 files (21 modified, 9 new); +2,362/−768 lines. No secrets, no new network surfaces, telemetry only through the existing analytics path.

**API/model cluster:**

- **P4** `src/utils/model/modelStrings.ts` — `resolveOverriddenModel` strict `===` → `modelIdsEqualAnyContext` (official `Ja`/`CA` @240936093: case-insensitive + `[1m]`-tag-stripped); `applyModelOverrides`/`getEnforcedDefaultModel` untouched. + `modelOverridesNormalizedMatch305.test.ts` (6).
- **P3** `src/services/api/withRetry.ts` — `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` recheck loop ported from the verbatim @249463400 extraction: constants 60000/300000/21600000/30000 ms, env bounds `[60000, 10800000]` digits-gated, optional deps `isUsageLimitLifted`/`subscribeRetryWake` — absent deps ⇒ countdown `Infinity` ⇒ 2.1.301 watchdog behavior byte-preserved. + `retryWatchdogUsageLimitRecheck305.test.ts` (25).
- **P1+P2** `src/utils/toolSearch.ts` full v306 module (@249522800): `ToolSearchRefusedError`(UZ), `throwToolSearchRefused`(EF) with the verbatim `[ToolSearch] HTTP …` warn, `isToolSearchBetaRefusalNamed` (iSe/TQ/e5t/Mv/eOs/Nnn + GB/oM exclusions), `isAnonymousToolSearchRefuseRecoveryEligible` (Ese incl. the v306-only `(!Jmn()||/\bdefer_loading\b/.test(message))` guard), `isTrueFirstParty` (Jmn, fail-closed), `markToolSearchBetaHealed` (hLe + `tengu_beta_400_healed {beta,model,provider,status,unnamed}`). `src/services/api/claude.ts` handler rewritten: `L6` conjuncts, named-first then anonymous path, structural one-shot, heal at `message_start`, per-attempt `partialMessage` reset. **Removed** the v304-form persisted refused-window (`toolSearchRefusedAt` key deleted from `src/utils/config.ts` — v306 ELF: 0 hits vs v304: 6). Tests rewritten: `toolSearchRefusedWindow304` (43), `toolSearchRefuseRecovery304` (10).

**Session/tools cluster:**

- **P5** `src/utils/Shell.ts` — spawn-time ENOSPC/EDQUOT catch branch (official `FSn`/`O_e` @237500817) returning the verbatim v306 @249973898 "disk is full … Nothing ran." message, placed after the isE2BIG branch. + `shellDiskFullStart306.test.ts` (7).
- **P6** `src/cli/print.ts` — `mergeSupportedMcpConfigs`: SDK/`setMcpServers` entries now win name conflicts (settings/plugin merged first, SDK last, unconditional assign) — official fix string-less, semantics per changelog. + `mcpSdkSettingsNameConflict306.test.ts` (5).
- **P7** `src/query.ts` + `src/types/message.ts` + `src/utils/messages.ts` + `src/tools/AgentTool/agentToolUtils.ts` — structured `{type:"system",subtype:"model_fallback",trigger,originalModel,fallbackModel,level:"warning",isMeta:false}` (v304@254434741 shape) replacing the bare text; `findAgentModelFallbackMessage` ≡ official `iu()` reverse scan; agent finalize prepends the verbatim `⚠ This agent switched to … because its earlier model could not be used.` notice (v306@255043817). + `agentModelFallbackNotice306.test.ts` (16).
- **P8** `src/utils/worktree.ts` + new helpers in `src/utils/git/worktreeBaseResolve.ts` + `src/tools/AgentTool/AgentTool.tsx` — `resolveGitRef({base,kind,failure,cwd,root,exactRef})` ≡ official `yot()` @250451652 (`show-ref --verify --hash` for exactRef, `fatal: '<ref>' - not a valid ref` detection, verbatim `Failed to resolve base branch "<b>"`); fetch-success origin-default resolution now full-ref + exactRef; worktree-add start-point peel unconditional `${sha}^{commit}`; cleanup fallback `shouldRemoveUnchangedAgentWorktree` — headCommit-falsy no longer skips cleanup for ephemeral-pattern worktrees with clean `status --porcelain` (fail-closed on any git error). + `worktreeExactRefResolve306.test.ts` (19).
- **P9** `src/services/mcp/config.ts` + `src/utils/settings/types.ts` — `authoredConfigHasEnvVarInCheckedFields` (command/args/url/headers only, env excluded, pre-expansion authored values via `getMcpConfigsByScope('enterprise',{expandVars:false})` ≡ official `fu(scope,{expandVars:!1})`); exemption reachable ONLY from the enterprise-exclusive branch (all other callsites 2-arg); deniedMcpServers stays absolute; `.describe()` updated to the official v306 text @238433800 byte-exact minus the `managedMcpServers, and ` trim (no such OCC key). Delivers the v306 final state directly (OCC lacked even the v304 base exemption; closes part of OCC-37 staged item 19). + `mcpAllowedVarExemption306.test.ts` (12).
- **P10** `src/types/message.ts` (`repeatsCompactSummary?: boolean`, same JSONL field name) + `src/utils/messages.ts` (factory passthrough) + `src/services/compact/compact.ts` (exported `inputRepeatsCompactSummary` predicate; both summary sites set the flag when `ptlAttempts > 0 || input repeats`) + `sessionMemoryCompact.ts`. Official fix string-less; flag mechanism verbatim (14=14 ELF occurrences both versions). Deviation: the cloud/teammate `[harness: …]` carried-turn notice (recipe step ④) NOT wired — that notice structure has no OCC surface (0 hits in src) and inventing text is forbidden; flag+setters+passthrough only. + `repeatsCompactSummary306.test.ts` (9).

Deviation ledgers: API cluster 20 documented deviations (all in code comments; chiefly minified-subsystem absences — no `dt`/PO sticky-drop, no OIDC profile so `sH` approximated fail-closed, `h.monotonicNow()`→`performance.now()`); session cluster 6 (P5 guard shape, P8 DRY fold + exported cleanup predicate, P9 no `managedMcpServers` validator string, P10 step ④/⑤ N-A).

## 4. Test record (orchestrator gate, this run)

| Gate | Result |
|---|---|
| 10 new/rewritten suites, isolated per-suite | **152 pass / 0 fail** |
| Directory regressions: compact 67, AgentTool 273, model 481, api 680, mcp 483 | **1,984 pass / 0 fail** |
| Worktree family (7 suites incl. AtStake304/BranchSanitizer304/StartPoint300) | **104 pass / 0 fail** |
| Shell/cli-mcp/messages-consumer (11 suites) + queryFallbackRoom296 + toolSearch AutoHold/DeclaredLatch/HoldWiring | **118 pass / 0 fail** |
| biome check (all 29 changed .ts/.tsx) | 0 errors (6 warnings, pre-existing-suppression class only) |
| `bun run build` | green — `dist/cli.js` 30.35 MB |
| e2e `occ-versioning` + `commands-alignment` | 6/6 |
| e2e `repl-interactive` + `commands-behavior` | 19/19 |
| Live `-p` smoke (real gateway, fresh build) | `OK306` returned, no hang |
| Live tmux REPL acceptance (human-style) | boot banner clean (no raw warnings above logo), slash menu opens, real tool-use turn (Write → file content `OCC165-OK` verified on disk, token counter live), `/exit` clean session teardown |
| Security review (synchronous security-reviewer subagent, read-only + /tmp/sec165 probes) | **PASS-WITH-NOTES** — 0 CRITICAL/HIGH; backdoor scan CLEAN (no new network/eval/dynamic-code; sole new telemetry `tengu_beta_400_healed` sanitized: model → conforming-id or literal 'nonconforming'); P9 exemption structurally unreachable from attacker-writable scopes; ReDoS probes linear at 100k (defer_loading 0.2–1.0 ms, beta-refusal matcher 2.3 ms); reviewer's own suite re-run 181/181; 6 LOW/INFO notes (incl. pre-existing `ENV_VAR_PATTERN` quadratic on unclosed-`${` repeats in user/project expansion path — out of round scope, queued) |

Gate notes: repo-wide `bun test src` remains order-polluted at baseline — per-suite isolated runs are the gate; `tsc` not a gate (~1341 pre-existing errors).

## 5. Release

_(filled at release time — see follow-up docs commit)_
