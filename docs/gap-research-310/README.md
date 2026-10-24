# Gap research — OCC 2.1.309 → official claude-code 2.1.310

Round date: 2026-10-25 (OCC-132 autopilot). Repo head at round start: `4b08a123` (v2.1.403, Tracks 2.1.309 partial).

Official 2.1.310 published 2026-10-23 (npm `latest`=`next`=2.1.310, `stable`=2.1.308). Changelog: 26 items (`changelog-309-310-items.txt`).

Forensics: official ELF `BIN310=/tmp/cc-diff-310/bin310/package/claude` (+ `BIN309` prev) inspected **read-only** via `strings` / `grep -aboF` byte offsets / bounded `dd` / new-strings diff (27851 new unique strings, mostly minifier churn; 1 verified new portable env surface). Official binaries were **never executed**. OCC source read-only during triage. Leader independently re-verified the key literal hit-counts (symlinkUnchecked 3/0, AppArmor 6/0, mcp_question_unanswered 2/0, RETRY_WATCHDOG_SCOPE 3/0, "no answer came before the time limit" 2/0, "The outcome is unknown…" 2/2 pre-existing baseline).

Detailed per-item triage (verdict + OCC surface + current behavior + official byte-offset evidence + action):
- `triage-T1.md` (items 1–6)
- `triage-T2.md` (items 7–12)
- `triage-T3-sweep.md` (items 13–26 N-A formalization + env/settings/hook/command/tool new-surface sweep)

## Tally

| Verdict | Count | Items |
|---|---|---|
| **PORT** | 6 + 1 sweep find | 2 (effort-beta rejection heal), 3 (cleanupPeriodDays NaN cutoff guard), 5 (symlink target in read prompts), 6 (record interaction after external-editor close — micro), 11 (AppArmor userns sandbox diagnostic), 12 (MCP elicitation-timeout error arms incl. 309-baseline in-flight arm) + B-1 (`CLAUDE_CODE_RETRY_WATCHDOG_SCOPE=capacity` gate parity) |
| **STAGED** | 4 | 4 (PTL reactive-compact ratio seeding — OCC reactive-compact is a dormant stub; 310 mechanism fully byte-pinned for the future build), 7 (Windows hooks Git-Bash-missing fail-open — lives in unported default-shell→PowerShell fallback routing), 8 (auto-mode outside-reads prompt wording — `auto_mode_outside_reads` dialog absent in OCC), 9 (non-interactive compaction memory — no distinguishing string delta; not byte-pinnable) |
| **N-A** | 16 | 1 (official removed a Statsig gate OCC never had — OCC already matches 310 end state), 10 (no mods/terminal-image subsystem), 13–26 (VSCode extension / Cloud-sessions web UI / Claude Tag Slack / Code Review cloud admin — surfaces absent; no CLI-side string leak) |
| **Total** | **26** | |

## PORT work packages (subsystem-disjoint, parallel subagents)

| WP | Items | Files | Gap |
|---|---|---|---|
| WP-api | 2 + B-1 | `services/api/withRetry.ts`, `services/api/claude.ts`, `constants/betas.ts` | No effort-beta rejection heal (400 `Unexpected value(s) … anthropic[-_]beta` / `beta_header:` matcher + per-model latch + strip-and-retry); watchdog-enable gate lacks the 310 `SCOPE!=="capacity"` clause |
| WP-cleanup | 3 | `utils/cleanup.ts`, `utils/worktree.ts` | `getCutoffDate()` has no NaN/Invalid-Date guard → huge `cleanupPeriodDays` → NaN cutoff → worktree sweep deletes recent dirs (inverted comparison); official splits into NaN-guarded helper returning null, callers skip sweep |
| WP-symlink | 5 | `components/permissions/FilePermissionDialog/*`, `components/ShowInIDEPrompt.tsx`, descriptor builder | Read prompts skip symlink resolution (`operationType === 'read'` early return); no `symlinkUnchecked` state, no "Could not check where this path leads on disk" branch, hardcoded "modify" verb |
| WP-question | 6 | `components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx` | Missing `updateLastInteractionTime(true)` immediately after `editPromptInEditor` await (official `Iq(!0)` placement) |
| WP-sandbox | 11 | `utils/sandbox/sandbox-adapter.ts` + new `utils/sandbox/apparmorUsernsCheck.ts` | Zero AppArmor handling; official adds a bubblewrap-trial probe (switch file, 2s trial, stderr matcher, verbatim user message + warn logs) wired into `checkDependencies` for linux/wsl |
| WP-mcp | 12 | `services/mcp/client.ts`, `services/mcp/sendTracking.ts`, `services/mcp/elicitationHandler.ts` | Timeout rejection is the plain message — missing BOTH the 309-baseline in-flight-sends arm (`mcp_call_unanswered` + "The outcome is unknown…") and the new 310 open-elicitation arm (`mcp_question_unanswered` + "…no answer came before the time limit…"), missing `openQuestions` counter on the watchdog, missing `mcpErrorSource` |

## Next steps

1. Implement the 7 PORT items via parallel subagents (WPs above are file-disjoint). TDD red→green; strings byte-verbatim from triage evidence.
2. Re-verify each PORT against BIN310 byte evidence before/after (no invented behavior).
3. Full test suite + build + real e2e incl. REPL smoke.
4. Security review (no backdoors) + acceptance vs official.
5. Merge to main, tag release, run publish flow (npm E404 debt tracked in OCC-127/OCC-129 — GitHub Release must still land; manual release per OCC-129 workaround if CI npm step fails).
6. Update `docs/upstream-version-gap-occ132-2026-10.md` ledger + README Tracks badge → 2.1.310.
