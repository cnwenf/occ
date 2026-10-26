# Upstream version gap — OCC-134 round (official claude-code 2.1.310 — held; strict self-acceptance)

Round date: 2026-10-27 (OCC-134 autopilot, 01:00 Asia/Shanghai). Repo head at round start AND end: `e8716e9f` (v2.1.404, Tracks 2.1.310 partial) — **no code change this round** (OCC-40 no-op precedent: a no-op version bump would pollute `/releases`; docs-only commit).

## §1 Baseline (three-way verified, programmer 实测复核 — matches Leader's dispatch numbers)

| Item | Value |
|---|---|
| Official npm dist-tags | `latest` = `next` = **2.1.310** (published 2026-10-23T21:20:46Z per `npm view time`), `stable` = **2.1.308** |
| Official GitHub releases | `v2.1.310` newest, `prerelease=false`; **no v2.1.311, no prerelease** |
| Official CHANGELOG.md | top section `## 2.1.310` (raw.githubusercontent fetch) — **no 2.1.311 section** → gap research has no new object |
| OCC main | package.json **2.1.404**, main tip `e8716e9f`; CI last 3 main runs (docs-133 ledger / v2.1.404 release / 310 alignment feat) **all success** |
| Repo hygiene | remote branches = **main only** ✅; GitHub releases = tags = **203 / 203** parity ✅, `comm -23 tags releases` = **empty** ✅ |
| Forensic binaries | `/tmp/cc-diff-310/bin310|bin309/package/claude` still on disk from OCC-132 (BIN310 **291,638,640 bytes** — size re-verified) — re-used READ-ONLY, **never executed** (per `aligning-with-official-binary`) |
| Workspace scan | `multica issue list --status in_progress` → only OCC-134 itself; **no competing version-tracking round running** → the「已有轮在跑则直接关单」clause does NOT fire |

Conclusion: official version did not advance since OCC-132/133 (2.1.310 → 2.1.310). Per the issue's「版本追齐后的自验收」clause this is a **strict self-acceptance round**, prioritizing the newest landed features (OCC-132's 2.1.310 PORT set — 8 new test files), then core trunk.

Note on "与官方 uvx claude-code 一致性": PyPI `claude-code` is a 0.0.1 placeholder with no executable (official distribution is npm `@anthropic-ai/claude-code`), and the skill discipline forbids executing the official binary. Consistency is verified the established way: read-only byte-forensics against BIN310 + behavioral e2e asserting official shapes + live REPL/headless acceptance on the real build product.

## §2 Self-acceptance results (all on the real build product `dist/cli.js`)

Build: `bun install` (1323 pkgs, Bun 1.3.14) + `bun run build` green — `dist/cli.js` **30.50 MB** (31,984,645 bytes), `MACRO.VERSION=2.1.404` injected.

| # | Check | Result |
|---|---|---|
| 1 | `dist/cli.js --version` | `OCC 2.1.404`, exit 0 ✅ |
| 2 | Live headless: `dist/cli.js -p "Reply with exactly one word: PONG"` | `PONG`, exit 0 ✅ (real model round-trip via configured gateway; `[claude-code:unrecognized_model] {"model":"glm-5.2"}` stderr line = pre-existing gateway-proxy telemetry noise, present since prior rounds) |
| 3 | tmux REPL (200×50) boot | trust dialog rendered + arrow-key/Enter acceptance works; v2.1.404 banner + `MODEL glm-5.2 with xhigh effort` + auth-conflict warning + "Opus now defaults to 1M context" notice render ✅ |
| 4 | REPL tool-use round-trip (human-style) | "Create a file named occ134-probe.txt containing exactly HELLO-OCC-134, then read it back" → `● Write(…occ134-probe.txt)` + `● Read(…)` → `⎿ Read 1 line` → final text quotes contents; on-disk `cat` = `HELLO-OCC-134` ✅ (Write+Read agentic loop under bypass permissions, official behavior); probe file cleaned up after |
| 5 | `/status` dialog | Version 2.1.404 / Session name+ID / cwd / Auth token + API key / base URL / Model glm-5.2 / MCP 3-server summary / Setting sources / Auto mode server / tabs Status·Config·Usage ✅; `Esc` dismisses cleanly ✅ |
| 6 | `/exit` | clean exit, tmux session fully gone (`tmux has-session` → no server) ✅ |
| 7 | Error handling parity | `--badflag` → `error: unknown option '--badflag'` (Commander parity) ✅; unrecognized positional `badsubcommand` flows to the model as a prompt (official behavior) ✅; `--model nonexistent-model-xyz -p` → `API Error: 400 … Model not exist.` surfaced from gateway, no crash ✅ |
| 8 | OCC-132's 8 new 310 test files standalone | **89 pass / 0 fail / 228 expect()** ✅ — exact match to OCC-132/133 recorded numbers (questionEditorInteraction310, symlinkReadPrompt310, effortBetaHeal310, retryWatchdogScope310, elicitationTimeoutArms310, cleanupCutoffNaN310, worktreeSweepCutoff310, apparmorUsernsCheck310) |
| 9 | Alignment e2e (`occ-versioning` + `commands-alignment`) | **6 pass / 0 fail / 12 expect()** ✅ |
| 10 | REPL e2e suites (`repl-interactive` + `repl-welcome-visual`) | **11 pass / 0 fail / 48 expect()** ✅ |
| 11 | Full suite `bun test src` | **12776 tests: 12515 pass / 260 fail / 1 skip, 33454 expect()** — **identical to the OCC-133 baseline (12515/260) on the identical HEAD: zero new failures** ✅ (260 = known pre-existing `mock.module` cross-file pollution noise, e.g. nativeInstaller downloadStream 400-vs-checksum; CI on this exact commit is green) |
| 12 | BIN310 byte re-verification (read-only, `grep -aboF \| wc -l`) | All 5 literal families match OCC-132/133 recorded counts: `Could not check where this path leads on disk` **2** · `mcp_question_unanswered` **2** · `CLAUDE_CODE_RETRY_WATCHDOG_SCOPE` **3** · `no answer came before the time limit` **2** · `apparmor_restrict_unprivileged_userns` **6** ✅ |

## §3 STAGED carry-over re-check (OCC-132's 4 items — all still correctly staged, no trigger fired)

| Item | Trigger status this round |
|---|---|
| #4 PTL reactive-compact ratio seeding | OCC reactive-compact still a **dormant stub** (`src/query.ts:22` stub-module comment intact, re-grepped); 310 mechanism remains byte-pinned for a future build → no trigger |
| #7 Windows Git-Bash-missing hook fail-open | lives in the **unported** default-shell→PowerShell fallback routing (`src/utils/hooks.ts` Git-Bash comments + `resolveDefaultShell.ts` unchanged); Windows-only path, not triggerable on this Linux host → no trigger |
| #8 auto-mode outside-reads prompt wording | `auto_mode_outside_reads` = **0 hits** in `src/` (re-grepped; dialog still absent in OCC) → no trigger |
| #9 non-interactive compaction memory | no distinguishing string delta; not byte-pinnable → STOP per skill, unchanged |

## §4 npm E404 debt re-check (carry-over, unchanged — re-verify only, no new action per dispatch)

- `@cnwenf/occ` on npm: still **2.1.367** (`dist-tags.latest`, re-queried this round). Debt range **2.1.368–2.1.404** (37 versions unpublished).
- publish.yml runs for v2.1.404 (40137705833) and v2.1.403 (40075933004) both **failure** — same registry-permission E404 debt, not a new failure mode.
- Ownership: **OCC-127 / OCC-129 remain blocked** awaiting admin rotation of `NPM_TOKEN` / scope permission. Nothing OCC-side can clear it.
- GitHub Release side is NOT blocked by the npm debt: v2.1.404 Release exists; releases = tags = 203/203 with empty comm delta.

## §5 Verdict

- **Zero new gaps found** this round: newest features (310 PORT set) re-verified on the real build via the 89-test standalone suite + BIN310 byte re-verification; core trunk verified via live headless `-p` + tmux REPL human-style usage (trust dialog / banner / Write+Read tool round-trip / `/status` / `/exit` / error-handling parity); full-suite A/B shows **zero regressions** vs the OCC-133 record (identical 12515/260 on identical HEAD).
- No code change → **no release cut** (per OCC-40 precedent). This ledger is the round's only main-branch artifact (docs-only commit).
- Handoff: security reviewer (backdoor audit — trivially scoped: docs-only diff) → acceptance reviewer (functional/design alignment + main-branch hygiene + branch cleanup check).
