# Upstream Version Gap — OCC-135 Round (2026-09-24)

**Round type:** official `next`-only release **2.1.281** triage-and-stage + strict self-acceptance vs official `latest` **2.1.280** (already aligned per occ134). **Docs-only round → no release** (occ88 precedent).

## §1 Version facts (three-way verified, 2026-09-24 ~01:00–02:00 Asia/Shanghai)

| Source | Value | Note |
|---|---|---|
| npm `@anthropic-ai/claude-code` dist-tags | `latest` = **2.1.280**, `next` = **2.1.281**, `stable` = 2.1.267 | 2.1.281 published **2026-09-23T17:01:17Z** — ~2 minutes before this issue's autopilot trigger (01:00 Asia/Shanghai = 17:00 UTC) |
| GitHub releases/tags (anthropics/claude-code) | head = v2.1.280 | **no v2.1.281 release or tag**; no CHANGELOG entry for 2.1.281 |
| Binary evidence | `npm pack @anthropic-ai/claude-code-linux-x64@{2.1.280,2.1.281}` | see §2. First pack attempt 404'd (CDN propagation, tarball ~2 min old); background retry loop succeeded on attempt 2; `cc-281.tgz` sha1 `7415b40ab4c360eda62336810665920d8cb4ef9c` matches registry metadata |
| OCC | `package.json` **2.1.350**, `src/entrypoints/cli.tsx:15` tracked-upstream marker `VERSION: "2.1.280"` | occ134 closed 2.1.280 alignment incl. §9 acceptance-fix round (v2.1.350, reviewer re-check PASSED) |

**Early-exit clause check (issue body):** "如果当前有正在运行的Issue在追版本则直接结束" — verified **not applicable**: all prior version-chase issues (OCC-5…OCC-134) are `done`; this is the only active one. Full round proceeded.

**Round discipline:** per occ85/occ88 precedent, OCC ports only from **promoted** releases (npm `latest` + GitHub release + CHANGELOG). 2.1.281 is `next`-only with zero published changelog → **triage + STAGE**, do not rush a port. Since `latest` (2.1.280) is already fully aligned, this round runs the issue's **strict self-acceptance** clause (§6).

## §2 Binary diff evidence (2.1.280 → 2.1.281, linux-x64)

| Metric | 2.1.280 | 2.1.281 |
|---|---|---|
| ELF size | 233,709,640 B (md5 `31162c871610fc8111e7f08ca1be8218`) | 237,375,560 B (md5 `d00df59384be94d0b5cac74849540075`) — **+3,665,920 B** |
| `// Version:` module markers | 1975 × `2.1.280` | 2027 × `2.1.281` (0 old-version markers remain) |
| Bundled chunks | 1971 | 2023 |
| Unique strings | 292,479 | 296,462 (**+19,520 new / −15,537 removed** — minifier churn dominates) |

Registries stable: slash-command registry byte-identical (100 → 100 commands), tools registry unchanged. No version marker beyond `2.1.281`. Methodology: Python `re.finditer` byte-level marker counts with context windows; strings-level `comm` used for **discovery only**; every ledger item below re-verified with exact-name counts (a first-pass env-var "removal" list was traced to minifier char-mangling onto adjacent names — clean re-count showed all candidates still present; the only genuine reduction is `CLAUDE_CODE_REPL\b` 4→1).

## §3 v280→v281 triage ledger — all items **STAGE** (next-only release)

### S1 — dangerous-rm **command-substitution-target** guard (SECURITY; top priority on promotion)
New deny path when the rm target **is the output of** `$(…)`/backticks (complementary to OCC's existing `findCatastrophicSubstitutionBlock`, which guards rm **inside** substitution bodies — `src/tools/BashTool/destructiveCommandWarning.ts:523`, ported at 2.1.208). Byte evidence (v280 → v281 counts):
- Deny text (v280: 0 hits): "Dangerous rm operation detected: the target is the output of a command substitution (`$(...)` or backticks) and cannot be checked before the command runs. This requires explicit approval and cannot be auto-allowed by permission rules.\n\nRun the substitution on its own first, then remove the literal paths it prints."
- Verdict kinds `wholeSubstitution` / `literalTarget` / `emptyExpansion` / `emptyVariable`; `__CMDSUB__` placeholder; `tooManySubstitutions` 0→2 (>64-substitution variant: "too many to analyze for catastrophic removals")
- Env gates: `CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT` 0→5; `CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT` 0→5
- GrowthBook `tengu_iridescent_boot` 0→2, default-true with payload-source opt-out; telemetry `tengu_bash_dangerous_rm_too_complex`, `tengu_bash_dangerous_rm_shape`
- `Dangerous rm operation` 0→2; `dangerousRemoval` 3→4

### S2 — auto-mode safety-dialog **auto-deny / cap**
`autoDenyWindow` 0→20; `maxDialogTimeouts` cap → telemetry `tengu_safety_check_dialog_capped`; timeout auto-deny → `tengu_safety_check_dialog_auto_denied` (2→4). Extends the 2.1.280 ten-in-a-row backoff fix OCC already ported. OCC surface: `grep maxDialogTimeouts|autoDenyWindow src/` = 0 hits. `denialLimitFallback` 23→25.

### S3 — MCP Apps host
`CLAUDE_CODE_MCP_APPS_HOST===!0` gate (0→10); `offer:io.modelcontextprotocol/ui` (0 in v280); `text/html;profile=mcp-app` (0 in v280); "MCP Apps" markers 13→15. No OCC surface.

### S4 — 14 genuinely-new env vars (0 → N occurrences)
`CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT`(5), `CLAUDE_CODE_MCP_APPS_HOST`(10), `CLAUDE_BG_WORKSPACE_TRUSTED`(12), `…HOST_GATEWAY_LINEAGE`(14; spawned alongside `CLAUDECODE=1&` + `EXPERIMENTAL_AGENT_TEAMS=1`), `CLAUDE_RELAUNCH_SESSION_ADD_DIRS`(8; near `repository_trust`/`auto_mode_availability_changed`), `CLAUDE_CODE_DISABLE_STARTUP_WORK_GATE`(3; `awaitEntry`/`handedOff` + Zi string "prompt.submit: the prompt did not enter the session"), `…COMMIT_BETWEEN_KEYS`(4), `…MCP_QUESTION_GRACE_MS`(2; CCR chunk), `…CCR_EARLY_REMOTE_CONNECT`(5), `…ARTIFACT_INHERITED_TYPE_GRANT`(2), `…ARTIFACT_TEXT_VARIANT`(3), `CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS`(3), `…COORDINATOR_SKILL_GUIDANCE`(3; "Workers have access to … tools, plus MCP tools…"), `CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT`(5).

### S5 — telemetry / experiments churn
~60 new events incl. `tengu_advisor_strip_replayed` (advisorStripPlan replay on resume — OCC `advisorRetry.ts` exists but has no advisorStripPlan), `tengu_resume_split_response_regrouped` (Bqe regrouping: regrouped_responses/moved_rows/early_results), `tengu_web_fetch_dedup_shadow` (cacheHit/repeat/priorAgeSeconds/samePrompt/sameAgent — no OCC surface), `tengu_context_announcement`, `tengu_binary_balloon` (prompt_snapshot_tool_build_skip_flag / sendsFromRecord / skippedTools), `tengu_insights_auto_mode_recommendation`, `tengu_mcp_url_elicitation`(+legacy+server_denylist), `tengu_mcp_step_up_auth_dialog`, `tengu_spatial_focus_nav`, `tengu_reminder_fold_recorded/replayed`, 7× `tengu_dir_sync_git_*`. Removed: `dir_sync_upload_start/complete`, `magical_pixel_startup`, etc. ~20 codename experiments (`bright_lake` = dangerous-rm gate, `iridescent_boot`, `velvet_panda`, …).

### S6 — stable markers (no drift)
`bashCommandClamp` 40→40, `tengu_goal_proposed` 2→2, `CLAUDE_CODE_ENABLE_NARRATION` 3→3, `AUTO_BACKGROUND_TASKS` 8→8, chrome tools stable. Churned (context only): opus-5-5 44→54, `Opus 5.5` 17→24, refusal 719→754, observer 309→318, coordinator 243→259, sandbox 2022→2083, bubblewrap 20→24.

**PORT count this round: 0** — by discipline, not by absence of candidates. S1 (security) is the designated first port once 2.1.281 promotes to `latest` with a changelog.

## §4 occ134 STAGE carryover — unchanged

The 22 staged items from occ134 §7 (incl. #009 dialog double-Ctrl+C, #079 legacyUserEffort, #002+#023 wheel plumbing, #010 window-activation click swallowing, #012 text-field keybinding precedence) remain staged; nothing promoted this round. occ134 §9 tails (#042-tail resolved; #032/#064 host-disable gate resolved; #004 spill producer; `/btw` `isTurnInProgress` by-construction limit) unchanged.

## §5 CI gate (this round, main + zero code changes)

- **Build:** `bun run build` → BUILD_EXIT=0; `dist/cli.js` 30,733,689 B; MACRO.VERSION=2.1.350 injected.
- **`scripts/ci-test.sh`** (per-file process isolation): **597 files — 5835 pass / 6 fail / 12 skip.** The 6 failures are exactly the known env-drift baseline files, unchanged from occ134: `commands-behavior`(1), `feedback-ai`(1), `repl-interactive`(1, pre-existing since OCC-44), `version-2.1.208-screen-reader`(1), `version-2.1.210-plan-approval`(2). **Zero regressions.** (occ134 baseline: 5755 pass — pass count grew with test additions; fail set identical.)

## §6 Strict self-acceptance battery (live, real gateway; issue's 自验收 clause)

Environment: dashscope gateway (`ANTHROPIC_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic`, model alias qwen3.8-max). Expected gateway noise: `[claude-code:unrecognized_model]` on stderr; banner model line shows the gateway-resolved alias (`deepseek-v4-flash-0731`) — gateway-specific, not an OCC defect. Isolated `HOME=/tmp/occ-acc135-home`, project `/tmp/occ-acc135-proj` with `AGENTS.md` sentinel ("begin every reply with SENTINEL135-OK"). Official-channel note: the issue text's `uvx claude-code` is **not** a valid official channel (PyPI placeholder) — alignment ground truth is the official npm linux-x64 binary 2.1.280, as in every prior round.

| # | Check | Result |
|---|---|---|
| 1 | Headless `-p` probe: `echo … \| bun dist/cli.js -p` → `PONG`, exit 0 | **PASS** |
| 2 | Banner `OCC v2.1.350` + cwd + billing line + tips pane | **PASS** |
| 3 | Onboarding order: theme (Dark ✔) → API-key approval → Security notes → folder trust ("Yes, I trust this folder") | **PASS** (official first-run API-key flow) |
| 4 | REPL round-trip `Reply with exactly: PONG` → `● SENTINEL135-OK PONG` | **PASS** |
| 5 | AGENTS.md sentinel honored on every reply (PONG / PONG2 / PONG3 / echo test) | **PASS** |
| 6 | `/status`: Version 2.1.350, Session ID, cwd, Auth token, API key, base URL, Model, Setting sources, Auto-mode server | **PASS** |
| 7 | Invisible-char strip: typed `ZW​SP‎MARK` (U+200B + U+200E via `send-keys -l`) — pane line `od -c` shows plain ASCII only; transcript JSONL user message `'echo ZWSPMARK test'`, `has U+200B: False, has U+200E: False` | **PASS** (byte-verified twice) |
| 8 | Shift+Tab ring: manual → accept-edits → plan → auto → manual (4 modes) | **PASS** — bypass excluded because `isBypassPermissionsModeAvailable=false` in this launch (no `--dangerously-skip-permissions`/ack); ring logic code-verified in `src/utils/permissions/getNextPermissionMode.ts` (plan → bypass → auto → default when available). occ133's 5-mode observation ran with bypass available. Consistent with official gating. |
| 9 | `/exit`: goodbye in transcript (`Goodbye!` / `Catch you later!`), post-unmount hint `Resume this session with:\nocc --resume 3134e86b-1406-465b-b611-88e025450871` (matches `gracefulShutdown.ts:180`; hint correctly suppressed for a zero-message session per `sessionIdExists` gate) | **PASS** |
| 10 | Second launch on same HOME: no onboarding re-prompt, straight to REPL | **PASS** |

**Environment cross-talk note (not an OCC defect):** the shared tmux server on this host carries two *other* live acceptance sessions from a concurrent run (`cc-repl`, `occ-repl`). Mid-battery, text appeared in the input box (`SENTINEL135-OK Just PONG2, no prefix`) that (a) never appears in the app's own pty typescript, (b) was never submitted (transcript clean), (c) was cleared by the external writer before my next keystroke. Remaining checks were re-run on an **isolated tmux socket** (`tmux -L`) — all green. OCC behaved safely throughout (unsolicited input stayed un-submitted in the input box).

**Self-acceptance verdict: no inconsistencies vs official 2.1.280 found → zero gaps recorded, zero fixes needed.**

## §7 Release/parity state & disposition

- `gh api repos/cnwenf/occ/releases` vs `/tags`: **150 = 150**, `comm -23` empty (head v2.1.350 both sides). Remote branches: **main only** (no residuals).
- npm `@cnwenf/occ` dist-tag `latest` = 2.1.350 (occ134 release, unchanged).
- **Disposition: docs-only round → no release, no version bump** (occ88 precedent: a no-op bump would pollute `/releases`). This doc merges to `main` via PR; tracked-upstream pointer stays "aligned through official latest **2.1.280**; **2.1.281** triaged + staged".
- Next round top priority when 2.1.281 promotes: **S1** dangerous-rm substitution-target guard (security), then S2 safety-dialog cap, then S4 env gates as surfaces exist.
