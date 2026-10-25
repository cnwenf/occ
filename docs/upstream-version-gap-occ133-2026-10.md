# Upstream version gap — OCC-133 round (official claude-code 2.1.310 — held; strict self-acceptance)

Round date: 2026-10-26 (OCC-133 autopilot, 01:00 Asia/Shanghai). Repo head at round start AND end: `5b2bb316` (v2.1.404, Tracks 2.1.310 partial) — **no code change this round** (OCC-40 no-op precedent: a no-op version bump would pollute `/releases`; docs-only commit).

## §1 Baseline (three-way verified, Leader 实测)

| Item | Value |
|---|---|
| Official npm dist-tags | `latest` = `next` = **2.1.310** (published 2026-10-23T23:39Z, unchanged since OCC-132), `stable` = **2.1.308** |
| Official GitHub releases | `v2.1.310` Latest; **no v2.1.311, no prerelease** |
| Official CHANGELOG.md | top section `## 2.1.310` — **no 2.1.311 section** → gap research has no new object |
| OCC main | package.json **2.1.404**, README Tracks badge **2.1.310 (partial)**, main tip `5b2bb316`; CI run 40137704127 (main, v2.1.404) **success** |
| Repo hygiene | remote branches = **main only** ✅; GitHub releases = tags = **30 / 30** parity ✅ (v2.1.404 tag + Release both present) |
| Forensic binaries | `/tmp/cc-diff-310/bin310|bin309/package/claude` still on disk from OCC-132 (BIN310 291,638,640 bytes) — re-used READ-ONLY, **never executed** (per `aligning-with-official-binary`) |

Conclusion: official version did not advance since OCC-132 (2.1.310 → 2.1.310). Per the issue's「版本追齐后的自验收」clause this is a **strict self-acceptance round**, prioritizing the newest landed features (OCC-132's 6+1 PORT items for 2.1.310), then core trunk.

Note on "与官方 uvx claude-code 一致性": PyPI `claude-code` is a 0.0.1 placeholder with no executable (official distribution is npm `@anthropic-ai/claude-code`), and the skill discipline forbids executing the official binary. Consistency is therefore verified the established way: byte-forensics against BIN310/BIN309 + behavioral e2e asserting official shapes + live REPL/headless acceptance.

## §2 Self-acceptance results (all on the real build product)

Build: `bun install` (1323 pkgs) + `bun run build` green — `dist/cli.js` **30.50 MB**, `MACRO.VERSION=2.1.404`.

| # | Check | Result |
|---|---|---|
| 1 | `dist/cli.js --version` | `OCC 2.1.404` ✅ |
| 2 | Live headless: `echo "say PONG only" \| dist/cli.js -p` | `PONG`, exit 0 ✅ (real model round-trip via configured gateway; `[claude-code:unrecognized_model] {"model":"glm-5.2"}` stderr line = pre-existing gateway-proxy telemetry noise, present since prior rounds) |
| 3 | tmux REPL (120×40) boot | v2.1.404 banner + `MODEL glm-5.2 with xhigh effort` + auth-conflict warning render ✅ |
| 4 | REPL model round-trip | `say PONG only` → `● PONG` ✅; status bar auto-mode + token counter live |
| 5 | REPL tool-use round-trip | `Run … echo occ133-tool-ok` → `● Bash(echo occ133-tool-ok)` → `● occ133-tool-ok` ✅ (auto mode executes without prompt, official behavior) |
| 6 | `/status` dialog | Version 2.1.404 / Session ID / cwd / Auth token+API key / base URL / Model glm-5.2 / MCP 3-server summary / Setting sources / tabs Status·Config·Usage ✅; `Esc` dismisses cleanly ("Status dialog dismissed") ✅ |
| 7 | `/exit` | clean exit + official `Resume this session with: occ --resume <id>` hint ✅ |
| 8 | Error handling | `--badflag` → `error: unknown option '--badflag'` (Commander parity) ✅; unrecognized positional `bogus-cmd` flows to the model as a prompt (official behavior) ✅; empty stdin `-p` exits 0 ✅ |
| 9 | OCC-132's 8 new 310 test files standalone | **89 pass / 0 fail / 228 expect()** ✅ — exact match to ledger §4 (effortBetaHeal310 14, retryWatchdogScope310, cleanupCutoffNaN310 11, worktreeSweepCutoff310, symlinkReadPrompt310 13, questionEditorInteraction310, apparmorUsernsCheck310 29, elicitationTimeoutArms310 12) |
| 10 | Targeted alignment e2e (`occ-versioning` + `commands-alignment` + 6× `version-2.1.219-*`) | **55 pass / 0 fail / 195 expect()** ✅ |
| 11 | Full suite `bun test src` (single-process) | **12776 tests: 12515 pass / 260 fail / 1 skip, 33454 expect()** — vs OCC-132 final record 12513/262 on the identical HEAD: **+2 pass / −2 fail, zero new failures** (single-process run includes known pre-existing `mock.module` cross-file pollution noise; CI on this exact commit is green) ✅ |
| 12 | BIN310/BIN309 byte re-verification (read-only) | 5 literal families re-counted via `grep -aboF \| wc -l`, all match OCC-132 recorded counts: `Could not check where this path leads on disk` 2/0 · `mcp_question_unanswered` 2/0 · `CLAUDE_CODE_RETRY_WATCHDOG_SCOPE` 3/0 · `no answer came before the time limit` 2/0 · `apparmor_restrict_unprivileged_userns` 6/0 ✅ |

## §3 STAGED carry-over re-check (OCC-132's 4 items — all still correctly staged, no trigger fired)

| Item | Trigger status this round |
|---|---|
| #4 PTL reactive-compact ratio seeding | OCC reactive-compact still a **dormant stub** (`src/query.ts:22` stub-module comment intact); 310 mechanism remains byte-pinned for a future build → no trigger |
| #7 Windows Git-Bash-missing hook fail-open | lives in the **unported** default-shell→PowerShell fallback routing; Windows-only path, not triggerable on this host → no trigger |
| #8 auto-mode outside-reads prompt wording | `auto_mode_outside_reads` = **0 hits** in `src/` (dialog still absent in OCC) → no trigger |
| #9 non-interactive compaction memory | no distinguishing string delta; not byte-pinnable → STOP per skill, unchanged |

Environment note: this host has `/proc/sys/kernel/apparmor_restrict_unprivileged_userns = 1` (Ubuntu restriction ON) — the OCC-132 item-11 diagnostic probe path is live-relevant here; the REPL boots without a spurious sandbox error (probe only fires on actual bubblewrap failure), and the 29-test apparmorUsernsCheck310 suite is green.

## §4 npm E404 debt re-check (carry-over, unchanged)

- `@cnwenf/occ` on npm: still **2.1.367** (dist-tag `latest`). Debt range now **2.1.368–2.1.404** (37 versions unpublished).
- v2.1.404 publish workflow run **40137705833 = failure**, log re-verified this round: `npm error code E404 — 404 Not Found - PUT https://registry.npmjs.org/@cnwenf%2focc` — same registry-permission debt, **not** a new failure mode.
- Ownership: **OCC-127 / OCC-129 remain blocked** awaiting admin rotation of `NPM_TOKEN` / scope permission. Nothing OCC-side can clear it; re-verified and carried, not dropped.
- GitHub Release side is NOT blocked by the npm debt: v2.1.404 Release exists (created manually per OCC-129 precedent); releases = tags = 30/30.

## §5 Verdict

- **Zero new gaps found** this round: newest features (310 PORT set) verified on the real build via 89-test standalone suite + byte re-verification; core trunk verified via live headless + tmux REPL human-style usage (boot / round-trip / tool-use / `/status` / `/exit` / error handling); full-suite A/B shows zero regressions vs the OCC-132 shipped record.
- No code change → **no release cut** (per OCC-40 precedent). This ledger is the round's only main-branch artifact (docs-only commit).
- Security-reviewer role: nothing new to review (no diff); prior-round PASS (OCC-132 §5, zero CRITICAL/HIGH, LOW-1 fixed in-round) stands on the identical HEAD.
- Acceptance-reviewer role: covered by §2 rows 1–12 (real-product behavioral acceptance) + §3 + §4.
