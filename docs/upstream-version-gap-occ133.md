# Upstream version gap ledger — OCC-93 round (occ133)

Multica issue: **OCC-93**「OCC版本追齐官方Claude Code」(autopilot trigger 2026-09-22 01:00 Asia/Shanghai)
Date: 2026-09-22
Round type: **no upstream movement → strict self-acceptance + carryover-debt cleanup round**
Predecessor: `docs/upstream-version-gap-occ132.md` (v2.1.345, 2.1.278-parity round)

## §1 Version facts (three-way verified, 2026-09-22)

| Source | Official Claude Code | OCC |
|---|---|---|
| npm dist-tags `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.278**, `stable` = 2.1.267 | `@cnwenf/occ` latest = 2.1.345 (pre-round) |
| GitHub releases `anthropics/claude-code` | newest **v2.1.278** (2026-09-19) | `cnwenf/occ` newest v2.1.345 |
| CHANGELOG head | 2.1.278 | OCC tracks **2.1.278** (byte-verified through occ132) |

Official has not moved since the occ132 round (v2.1.278, published 2026-09-19). OCC main = v2.1.345 is fully caught up to 2.1.278 → **no version gap this round**. The early-exit clause (another issue already chasing versions) was checked and does NOT apply — no other active issue in the occ project. Per the issue's 「无 gap 时自验收」clause this round is: (a) clear the occ132 §7 carryover debt, (b) run a strict live self-acceptance battery, (c) release **v2.1.346**.

Official-consistency spot-check note: `uvx claude-code` is NOT a valid official channel (PyPI `claude-code` is a 0.0.1 placeholder; the official npm package is a 27 KB wrapper around a ~311 MB native ELF). Since the official is unchanged since yesterday's full byte-verified alignment (occ132) and this round's delta is purely OCC-side hardening/docs/tests, the official cross-check was scoped to the existing binary evidence rather than a fresh ELF diff.

## §2 Carryover debt disposition (occ132 §7: P2×2 + P3×7)

| Item | Disposition | Detail |
|---|---|---|
| **P2-1** policySourceSanitizer doc overclaim | **FIXED (doc-only, landed)** | Header rewritten to state truthfully: OCC coverage is NARROWER than official `Qn` breadth — three per-entry sanitizer families (permission rules / security allowlists / marketplace policy) match the official observable contract byte-identically; all OTHER SettingsJson fields still reject the WHOLE source at `settings.ts` `parseSettingsFileUncached` (~278) and `mdm/settings.ts` `parseCommandOutputAsSettings` (~202). Residual remote-raw surface: `syncCacheState` disk-cache fallback (`~/.claude/remote-settings.json` read raw by `getRemoteManagedSettingsSyncFromCache`). Full `Qn` per-field `.catch()` breadth **STAGED** (§7). |
| **P2-2** ant fast-exit cost save untested on live path | **FIXED (landed)** | New `src/cli/__tests__/antFastExitCostSave277.test.ts` + `antFastExitDriver.ts`: real subprocess bun runs `runHeadless` (isolated HOME/CLAUDE_CONFIG_DIR, `USER_TYPE=ant`, `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER=1`, no `NODE_ENV=test`, dummy key without BASE_URL); driver pre-seeds 1.75 cost; asserts exit 0 + `Startup time:` on stderr + `.claude.json` `projects[cwd].lastCost === 1.75` + non-empty `lastSessionId`. 1 pass / 8 expect. |
| **P3-1** dropped sanitize warnings on forced policy re-read | **FIXED (landed)** | `settings.ts` `getSettingsForSourceUncached` policySettings branch (~406) now routes `sanitizePolicySourceData` warnings to `logForDebugging` instead of discarding them. |
| **P3-2** shared-process mock.module interference (29 residuals) | **ACCEPTED-AS-IS** | Per-file CI isolation (`scripts/ci-test.sh`) is the gate; shared-process bleed is a documented bun limitation (`mock.module()` is permanent per-process, verified 1.3.14 + 1.4.2; `mock.restore()` does not undo it). occ132 already recorded the root cause + `afterAll` restores on the four worst files. No further action this round — the tradeoff stands documented. |
| **P3-3** stale worktree fallback in memoized `getSkillDirCommands` | **STAGED (rationale recorded)** | No minimal+safe fix exists without per-site decompilation of the official memo-key/worktree-invalidation logic; parity coverage already exists (`skillsWorktreeFallback278`); the memo key is stable by anchored-skills design, so the stale-fallback window is not reachable in the live configuration. Paste-ready staged rationale preserved in the occ132 round report. |
| **P3-4** ant-path cost overwrite on first-render exit | **RESOLVED as documentation-class (landed)** | Consistency verified: `registerHeadlessCostSaveOnExit` (registered first in `runHeadless`) + `useCostSummary` exit-save are BOTH last-session-wins by design; `restoreCostStateForSession` only restores when `lastSessionId` matches. The ant fast-exit overwrite is consistent-by-design, not a bug. Explanatory comment block landed at `src/cli/print.ts` ~525-535 (+11 lines). |
| **P3-5** CWE-117 log injection via policy-controlled warning text | **FIXED (landed)** | New `src/utils/settings/sanitizeWarningText.ts` (`sanitizeForWarningText`: strips all C0 control chars U+0000 through U+001F). Applied at ALL policy-controlled interpolation sites: `marketplacePolicySanitizer.ts` (entry/plugin/marketplace notices), `sanitizeAllowlists.ts` (legacy `plugin@marketplace` notice + per-entry invalid detail), `validation.ts` (rule/error/suggestion). Tests: `policyWarningLogInjection132.test.ts` (new, 7 pass / 21 expect — helper unit, CRLF permission rule, legacy plugin@marketplace, full-pipeline composition, benign byte-identical). |
| **P3-6** agents-MD seam reset untested (`claudemd.ts:1339`) | **FIXED (landed)** | `src/utils/__tests__/agentsMdDiscovery277.test.ts` +37 lines: seeds real notice/deprecation → `resetGetMemoryFilesCache()` → asserts seam getters back to undefined. **Mutation-verified**: deleting `claudemd.ts:1339-1340` fails exactly the 2 new tests. 12 pass total. |
| **P3-7** file-path clone-before-sanitize re-parse untested | **FIXED (landed)** | `policySourceSanitize278.test.ts` +43 lines: real temp policy file parsed twice (with `resetSettingsCache` between) → asserts warnings re-emitted identically AND the shared `safeParseJSON` cache object was not mutated. **Mutation-verified**. 8 pass total. |

Summary: 6 landed (P2-1, P2-2, P3-1, P3-4, P3-5, P3-6, P3-7 — P3-4 landed as comment-class), 1 staged (P3-3), 1 accepted-as-is (P3-2).

## §3 CI gate (scripts/ci-test.sh, full run, this round's tree)

```
Total: 5327 pass / 6 fail / 12 skip
Files: 556 checked, 5 failed
```

vs yesterday's occ132 baseline 5307 / 6 / 12 (553 files): **+20 pass (new tests), fail count identical, zero new failures**. The 6 fails are the known live-e2e environment-drift baseline (files: `commands-behavior` [/feedback gh issue], `feedback-ai`, `repl-interactive` [auto-mode opt-in dialog — pre-existing since OCC-44, git-stash A/B proven], `version-2.1.208-screen-reader`, `version-2.1.210-plan-approval` ×2) — none touched by this round's delta (src/utils/settings + src/cli comment + new test files).

New/extended test files all green in the gate: `antFastExitCostSave277` (1), `policyWarningLogInjection132` (7), `agentsMdDiscovery277` (12), `policySourceSanitize278` (8).

## §4 Live tmux/REPL self-acceptance battery (real model, dist build v2.1.346)

Environment: tmux session `occ93`, 200×50 pane, isolated `HOME=/root/occ-accept-93/home`, project dir with `AGENTS.md` (sentinel `ACCEPT93-SENTINEL`) + `notes.txt` + git init; live gateway (dashscope, `qwen3.8-max`); poll-until-text (no blind sleeps). Launch: `bun dist/cli.js --dangerously-skip-permissions` (env-scrubbed).

| # | Check | Result |
|---|---|---|
| 1 | Welcome banner `OCC v2.1.346` | **PASS** |
| 2 | Onboarding dialogs: theme (Dark) → API-key approval → folder trust → bypass-permissions accept | **PASS** (official-order flow) |
| 3 | Live model round-trip: "Reply with exactly PONG" → `● PONG` | **PASS** |
| 4 | AGENTS.md memory discovery: "Follow the instructions in AGENTS.md" → `● ACCEPT93-SENTINEL` | **PASS** |
| 5 | `/status`: `Version: 2.1.346`, `Auto mode server: Disabled`, model `qwen3.8-max`, base URL dashscope, session ID shown | **PASS** |
| 6 | Invisible-char stripping: typed U+200B inside message; input line rendered clean; **byte-level** transcript verification (`od -c` on session jsonl: `exactly OK` single space, no `e2 80 8b`); model round-trip `● OK` | **PASS** |
| 7 | Shift+Tab mode cycle: bypass → auto → manual → accept edits → plan (5-mode ring) | **PASS** |
| 8 | `/exit`: "See ya!" + `Resume this session with: occ --resume <id>` hint, clean shell return | **PASS** |
| 9 | `--continue`: full history redisplayed; **context live** — model correctly recalled `ACCEPT93-SENTINEL` from before exit | **PASS** |
| 10 | Headless `-p`: "Reply with exactly PONG" → `PONG`, exit 0; `--version` → `OCC 2.1.346` | **PASS** |

Auth-conflict warning (both `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY` set) rendered as designed — faithful warning behavior, environment artifact not a defect.

**Result: all PASS, zero new gaps found.** No inconsistency vs the official interaction contract was observed in this battery; nothing to feed back as a new gap item.

## §5 Release disposition

Production-relevant code changed this round (policy warning hardening P3-5, settings warning surfacing P3-1, doc-truth P2-1) → meets the release bar. Release **v2.1.346** follows the fixed flow: merge to main → tag `v2.1.346` → publish.yml (build → set version → npm publish → GitHub Release) → verify tags == releases counts + `comm -23` zero-diff → report. `package.json` bumped to 2.1.346 and `dist/cli.js` rebuilt (30,673,646 bytes) in-tree before the gate so the `occ-versioning` e2e saw a consistent pair. README Tracks wording (4 places, 2.1.278) unchanged — no upstream movement.

Pre-release repo health (verified this round): tags 145 == releases 145, `comm -23` empty, remote branches = main only, no open PRs, no other running tasks.

## §6 Files touched this round

```
M CHANGELOG.md                          (2.1.346 entry)
M package.json                          (version 2.1.345 → 2.1.346)
M src/cli/print.ts                      (P3-4 comment block, +11)
M src/utils/settings/policySourceSanitizer.ts   (P2-1 truthful header)
M src/utils/settings/settings.ts        (P3-1 warning surfacing)
M src/utils/settings/marketplacePolicySanitizer.ts (P3-5 sanitize calls)
M src/utils/settings/sanitizeAllowlists.ts      (P3-5 sanitize calls)
M src/utils/settings/validation.ts      (P3-5 sanitize calls)
A src/utils/settings/sanitizeWarningText.ts     (P3-5 helper)
M src/utils/__tests__/agentsMdDiscovery277.test.ts      (P3-6, +37)
M src/utils/settings/__tests__/policySourceSanitize278.test.ts (P3-7, +43)
A src/utils/settings/__tests__/policyWarningLogInjection132.test.ts (P3-5 tests, 7)
A src/cli/__tests__/antFastExitCostSave277.test.ts      (P2-2)
A src/cli/__tests__/antFastExitDriver.ts                (P2-2 subprocess driver)
A docs/upstream-version-gap-occ133.md   (this ledger)
```

Security review (diff-level, this round): all changes are hardening / documentation / tests — no network egress, no eval, no secrets, no suspicious code; the P2-2 test driver uses a dummy key and isolated HOME.

## §7 Carryover to next round

1. **(P2, STAGED)** Full official `Qn` per-field `.catch()` breadth for the remaining SettingsJson fields (everything outside the three sanitized families) — needs per-site decompilation; uncovered malformed fields still reject the whole policy source (fail-closed at file level, but coarser than official).
2. **(P3, STAGED)** `syncCacheState` disk-cache fallback: `~/.claude/remote-settings.json` is read raw by `getRemoteManagedSettingsSyncFromCache`; consumers outside the two sanitized settings.ts sites see raw JSON.
3. **(P3, STAGED)** P3-3 stale-worktree fallback in memoized `getSkillDirCommands` (rationale in §2; unreachable in live anchored-skills config).
4. **(baseline)** Live-e2e environment-drift failures (6): `/feedback` gh pair, repl-interactive auto-mode dialog, screen-reader, plan-approval ×2 — long-standing environment artifacts, re-verify only when the surfaces change.
5. **(accepted)** P3-2 shared-process mock interference — documented bun limitation, per-file CI isolation is the gate.
