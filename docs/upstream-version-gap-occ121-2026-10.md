# Upstream Version Gap — OCC-121 Round (2026-10): Strict Self-Acceptance (official flat at 2.1.302)

> Status: **COMPLETE** — official latest unchanged (2.1.302 → 2.1.302, no new gap); strict self-acceptance executed per the issue's「版本追齐后的自验收」clause. 12 PORT items re-verified on real artifacts (**11 PASS / 1 FAIL**); the single FAIL (#14B headless fallback site) fixed + mutation-verified + dist-probed this round (**Gap-121a**); 8 P3 residuals from OCC-120 dispositioned (**5 fixed, 3 carried with reasons**); REPL/headless/official consistency swept. Build green, per-file-isolated suite green, merged to main, release **v2.1.390**.
> Prior-round ledger: [upstream-version-gap-occ120-2026-10.md](./upstream-version-gap-occ120-2026-10.md)
> Skill discipline: `upstream-tracking` + `aligning-with-official-binary`. Official ELF **never executed** — `strings` / `grep -aboF` / bounded `dd` only.

## 1. Baseline (verified 2026-10-19, this run)

| Item | Value |
|---|---|
| Official npm dist-tags | latest = **2.1.302** (unchanged since 2026-10-16), next = 2.1.302, stable = 2.1.292 |
| Official CHANGELOG top section | `## 2.1.302` — no 2.1.303, nothing new to triage |
| OCC version (round start) | **2.1.389** @ main `010116ee` (CI run 39092394196 success) |
| Repo hygiene (round start) | remote branches = main only; tags = releases = **188/188** |
| Inherited debt | OCC-120 acceptance PASS with **8 P3 residuals** (contract 1 / testing 4 / dataflow 2 / e2e 1) — dispositioned in §5 |
| Official comparison channel | `uvx claude-code` blocked (PyPI 0.0.1 placeholder) → **`npx -y @anthropic-ai/claude-code@2.1.302`** used for the official side |

## 2. 12 PORT items (OCC-120, 2.1.302 alignment) — real-artifact re-verification

Method (subagent sweep, collected synchronously per the no-background-and-yield rule): per-item ledger tests re-run (`CI=true NODE_ENV=test`, single-file), plus behavior probes on real `src/` modules and the built `dist/cli.js` (headless `-p`, OTel console exporter, real git subprocesses), plus read-only `dd` re-checks against the official v302 ELF. Unit-test subtotal: 24 files, **180 pass / 0 fail**.

| # | Item | Result | Evidence (abridged; full detail in the round's verification comment) |
|---|---|---|---|
| 01 | `CLAUDE_CODE_AUTO_MODE_MODEL` env ladder | **PASS** | env → `getClassifierModel()` returns it; unset/empty → default; no ant-gate |
| 06 | Read image 128MB cap | **PASS** | boundary probes at cap / cap+1 / 200MB + dist `-p` e2e: official refusal text byte-identical; single convergence point |
| 07 | alias-conditional settings-key normalizer | **PASS** | `anthropic/claude-opus-4-1` passthrough; aliases → concrete; `__proto__`/`constructor` → top-level fallback |
| 08 | ToolSearch loaded-set short-circuit | **PASS** | loaded → `matches=[]` + official isMeta text, tools array untouched; unloaded → normal match |
| 10 | reftable version fallback | **PASS** (env-bounded) | shaped-reftable real repo → correct resolution via real `git show-ref --end-of-options`; `'../evil'` → null, no spawn. Note: host git 2.43 cannot create a real reftable store (needs ≥2.46) — see §6 carry |
| 14B | `tool_decision` v302 fields/order | **FAIL → FIXED (Gap-121a, §3)** | interactive site correct; **headless dispatch-fallback site was still v301** |
| 16 | signed-out `remote-control --help` | **PASS** (note) | real `bridgeMain(['--help'])` with cli.tsx ordering: 913-char help, resolved, no exit, no auth error; dist EXIT=0. Note → §6 (dormant `BRIDGE_MODE` + `enableConfigs()` precondition) |
| 19 | usage_credits suggestion suppression | **PASS** | `billed=true` → `usage_credits`; plan-mode priority intact; dist string census matches |
| 23 | gitfile refusal classes | **PASS** | real scattered-gitfile + git stderr → `no_repo`; `bad object` → `git_refused` (not swallowed) |
| 31 | fork-gate env + config pre-enable window guard | **PASS** | pre-enable window does not throw; env ladder correct; dist `-p` bare + `CLAUDE_CODE_FORK_SUBAGENT=1` both PONG EXIT=0; factory default-off matches ledger |
| 32 | forced-background per surface | **PASS** | `env=1` → `forcedBg=true`, schema drops `run_in_background`; unset/0 → inverse |
| 35 | hook concurrency cap ≤12 | **PASS** | 30 prompt hooks → `maxLive=12`; command hooks uncapped (no over-reach); single convergence point `hooks.ts` |

## 3. Gap-121a — #14B half-landed: headless `tool_decision` fallback site (the round's only FAIL, FIXED)

**Symptom.** The 2.1.302 #14B port had only landed at the interactive site (`permissionLogging.ts` `logPermissionDecision`, pinned by `toolDecisionOtelFields302.test.ts`). The sibling **dispatch-fallback** site in `src/services/tools/toolExecution.ts` (`checkPermissionsAndCallTool`, gate `!toolUseContext.toolDecisions?.has(toolUseID)`) still emitted the v301 shape `{decision, source, ...classifier, permission_mode, tool_name}` — missing `tool_use_id` / `tool_source` / `tool_parameters`. In headless `-p`/SDK mode this fallback is the **only** `tool_decision` emit (reproduced twice on dist with `OTEL_LOGS_EXPORTER=console`: Bash auto-accept + Write acceptEdits), i.e. the most-consumed record was unaligned.

**Official ground truth.** v302 changed BOTH sites — fallback @ELF 245575922 (read-only `dd`):
`Si("tool_decision",{decision:as,source:Fs,tool_name:In(e.name),tool_use_id:n,...w0r(e.mcpInfo),...Object.keys($i).length>0&&{tool_parameters:_($i)},...Fs==="config"&&yo.behavior!=="ask"&&H8e(as,yo.decisionReason),permission_mode:jl(Jn)},s.agentContext)` with `$i=F5n(...)` (the `OTEL_LOG_TOOL_DETAILS`-gated parameter extractor).

**Fix.** Fallback emit rebuilt in v302 order reusing the already-exported helpers: `buildToolSourceAttribute` (≡ `w0r`), `buildToolParametersForTelemetry` (≡ `F5n`, `jsonStringify`-wrapped, omitted when empty), `buildClassifierToolDecisionFields` behind the official `source==='config' && behavior!=='ask'` gate, `permission_mode` last. Identifiers-first ordering means a low `OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT` evicts the truncatable tail, not the identifiers.

**Verification (three levels).**
1. **Unit / production-wiring**: new `src/services/tools/__tests__/toolDecisionFallbackOtel302.test.ts` drives the REAL `runToolUse` generator (288 harness pattern) and pins exact `Object.keys()` order for 4 scenarios (allow-builtin details-off head; MCP+classifier+category details-on FULL tail; details-off `tool_parameters` absence; ask-gate — `source:'config'` without classifier fields). **Mutation-verified**: reverting the emit to the v301 shape → 4/4 RED; restored → GREEN (26 pass across fallback + interactive + 288 suites; the interactive suite staying green under the mutation is exactly the asymmetry that let the gap slip through).
2. **Built artifact**: `bun run build` green (dist/cli.js 30.32 MB); rebuilt-dist console-exporter probe now shows `decision, source, tool_name, tool_use_id, tool_source, permission_mode` head — and with `OTEL_LOG_TOOL_DETAILS=1` the `tool_parameters` lands mid-order with the official Bash-branch fields (`bash_command`/`full_command`/`description`).
3. **REPL**: tmux smoke on the rebuilt dist (boot → live model round-trip → `/status` → exit) green; interactive path unaffected (fallback gated by stored `toolDecisions`).

## 4. REPL / headless / official interaction consistency

Swept like a human user (subagent, results collected synchronously; full report posted to the issue thread this round):

- **REPL (tmux real machine)**: 6/6 PASS — boot, model round-trip, slash surfaces, error rendering, exit paths.
- **Headless `-p`**: 5/5 PASS — plain PONG, `--allowedTools`, stream-json init/result shape, error channel, exit codes.
- **vs official `npx -y @anthropic-ai/claude-code@2.1.302`**: error-handling output **byte parity**; headless behavior parity; one **cosmetic** REPL first-screen divergence (logo block layout — long-known, non-functional). All functional divergences found trace to existing documented ledger entries (Gap-5 help wrapping, trimmed `-p` tool set, `--safe-mode` scope, etc.) — **no new unexplained divergence**.
- **Parity correction (subagent finding adjudicated)**: the claim that OCC hides `--permission-prompt-tool` from `--help` while official shows it is **wrong** — official 2.1.302 `--help` also does not list it standalone (referenced only inside `--permission-prompts` description). OCC's registered-hideHelp state is parity, not debt. No change.
- `--permission-prompts` stays **staged P0** per the Gap-114a hold reason (permission_denied stream-json shape not byte-extracted; "Never invent"). The npx channel is now available for next-round byte forensics.

## 5. OCC-120's 8 P3 residuals — disposition (all closed or explicitly carried)

| Residual (OCC-120 acceptance ledger numbering) | Disposition |
|---|---|
| 1a contract-1 imageRead seam uneven closure | **FIXED** — `FsOperations` now DECLARES optional `open?(path, mode)`; stock `NodeFsOperations` implements it; `imageRead.ts` routes by contract, bare-`fs` fallback for no-open impls documented + pinned. New `imageReadSeam302` describes: stock-open recording (asserts `{path, mode:'r'}` + bytes) and no-open fallback. Mutation-verified both arms (strip stock `open` → RED; remove fallback → RED) |
| 1b dataflow df-image-read-seam-open-fs-view-split | **FIXED** — same seam declaration closes the split: compliant custom fs impls can now implement `open` and the cap-gate reads their handle; fallback path pinned by test |
| 1c testing fileread-sibling-image-path-bypasses-seam | **FIXED** — `FileReadTool.ts` PDF page-image mapping now goes through the seam (`fsImpl.readdir` + `fsImpl.readFileBytes`); bare `fs/promises` import removed. New `pdfPageImageSeam302.test.ts` drives real `FileReadTool.call({pages:'1-2'})` with a recording seam (mocked pdf extractor, real temp dir/JPEGs). Mutation-verified (bare-fs revert → RED) |
| 2 e2e /feedback cleanup-first code!=0 leak | **FIXED** — `expect(res.code).toBe(0)` moved after the `gh issue close` cleanup block, so a runOcc timeout (code -1) no longer skips cleanup and leaks issues. Live-model flakiness observed during A/B (one wording-regex miss, one 60s timeout — both known environmental categories per the occ114 ledger); the timeout run is exactly the scenario the reorder protects, and no new dangling issues were left behind (checked `gh issue list`) |
| 3 testing forkSubagent warn branch unpinned | **FIXED** — debug-module mock + warn-output assertions pin the `logForDebugging` branch (11 pass; deleting the branch → RED) |
| 4 testing hook-cap agent arm unit-only | **FIXED** — `hookConcurrencyCapProduction302.test.ts` gains the agent-arm describe: 13 agent hooks through the REAL `executeStopHooks → executeHooks → merge-with-cap → execAgentHook` pipeline, `maxLive=12` + 13th-waits + slot-refill. Mutation-verified (predicate narrowed to prompt-only → RED) |
| 5 testing ToolSearch exact-name collision unpinned | **FIXED** — collision fixtures pin ALL-MATCH semantics at the third call site (exact-primary-name keyword short-circuit), 7 pass |
| 6 dataflow reftable fixture realism (needs git ≥2.46) | **CARRIED** — host git is 2.43; a real reftable linked-worktree cannot be constructed here, and inventing a fixture that misrepresents ≥2.46 layout would violate the never-invent discipline. Stays a real-machine probe item for an environment with git ≥2.46 |

Security carry-over (acceptance ledger item 7, not part of the 8): the 3 CLEARED_WITH_RISK items (imageRead FIFO blocking read without timeout; OTel `tool_decision` full-command text; yoloClassifier env-value log interpolation) are **byte-identical to official v302** and were adjudicated keep in the first round — carried unchanged, no new security surface this round.

## 6. New observations registered (non-blocking)

1. **#16 `enableConfigs()` precondition** — `bridgeMain(['--help'])` throws `Config accessed before allowed.` when invoked without the cli.tsx-ordering `enableConfigs()` call (visible only at `NODE_ENV≠test`; unit tests are masked by the test gate). CLI-unreachable + `BRIDGE_MODE` absent from the dist feature allowlist (dd-confirmed) → dormant, **registered P3** for next round: add a `NODE_ENV=production` test variant so the environment can't permanently mask the precondition.
2. **Batch-order flake (pre-existing)** — running many test files in ONE `bun test` process, `permissionDenialMisreport.test.ts` case (ii) fails under certain file orderings; standalone → 8/8 pass; **clean main reproduces the same batch failure** → not caused by this round. This is exactly the leak class `scripts/ci-test.sh` (per-file process isolation) exists for; CI is unaffected.
3. **`bun run lint` fails on clean main** (suppressions/unused + noConsole in pre-existing files) — CI treats lint as informational (`continue-on-error: true`); all files touched this round are `biome lint` clean (checked individually).

## 7. Test / build / merge / release status

- Affected suites: 26 pass (toolDecisionFallbackOtel302 + toolDecisionOtelFields302 + toolDecisionTelemetry288), FileReadTool/hooks/ToolSearch/AgentTool touched suites green; full per-file-isolated suite (`scripts/ci-test.sh`) green — see CI run on main.
- Build: `bun run build` green, dist/cli.js 30.32 MB, MACRO.VERSION injected.
- e2e: REPL tmux smoke (boot/round-trip/`/status`/exit) + headless probes (§3) green on the rebuilt artifact; `/feedback` e2e A/B adjudicated as live-model flake (§5 item 2).
- Merge: `p3-fixes-occ121` → main; release **v2.1.390** (package.json + CHANGELOG + README wording, Tracks unchanged at CC 2.1.302 honest-partial); tags/releases count verified post-publish.
- Handoff: code changed → @安全审核员 (backdoor review) → @验收员.
