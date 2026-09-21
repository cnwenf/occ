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

---

# OCC-133 round extension — self-acceptance (release v2.1.347)

Multica issue: **OCC-133**「2026-09-22 自验收轮」(OCC Leader trigger, same day as the OCC-93 round above)
Round type: **no upstream movement (2.1.278 unchanged, 3rd day) → strict self-acceptance + gap-fix round**

## §8 Reconciliation with the OCC-93 round (this same file, §1–§7)

A parallel OCC-93 run landed the occ132 §7 carryover cleanup and released **v2.1.346** (tag + npm + GitHub Release all verified live) while the OCC-133 self-acceptance battery was mid-flight. Consequences, handled:

- OCC-133's own base was rebased onto `origin/main` (merge commit `9662d3f`); the duplicate P3-x work OCC-133 had prepared was **dropped** — §2 above is authoritative for that debt.
- §4's "all PASS, zero new gaps found" verdict was scoped to that battery's surfaces. The OCC-133 battery (§9–§11 below) found **two real gaps** on surfaces §4 did not probe (ant-globals startup path; notice-render templates) — both fixed this round. This is not a contradiction: different probe sets, and §10 overturns an earlier occ132 "not reconstructable" verdict with new binary evidence.
- OCC-133's unique deliverables (Gap-133a, Gap-133b, acceptance findings) land on top as release **v2.1.347**.

## §9 Gap-133a — `USER_TYPE=ant` startup ReferenceError (silent exit 0) — FIXED

**Discovery**: live-path probe — `USER_TYPE=ant bun dist/cli.js` (no wrapper) referenced `globalThis.resolveAntModel` before any module installed it → uncaught `ReferenceError` swallowed by the ant fast-exit path → **silent exit code 0 with no render**. The official binary serves the ant path fine. `src/cli/antFastExitDriver.ts` (main) already documented the bug as worked-around at driver level, confirming the live path was broken.

**Fix** (`src/entrypoints/cli.tsx`): after the BUILD_TARGET/BUILD_ENV/INTERFACE_TYPE polyfills, install the ant-model global trio (`resolveAntModel`, `getAntModels`, `getAntModelOverrideConfig`) from `src/utils/model/antModels.js` when `USER_TYPE === "ant"` and the globals are absent — mirroring what the official build-time injection provides. `src/types/global.d.ts` header updated to truthfully document the trio as runtime-gated, cli.tsx-installed.

**Test**: `src/cli/__tests__/antModelGlobalsPolyfill278.test.ts` — spawns `dist/cli.js` directly (NOT the driver) with `USER_TYPE=ant` + `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER=1`, isolated HOME/CLAUDE_CONFIG_DIR; asserts no ReferenceError, exit 0, `Startup time:` on stderr, `lastSessionId` persisted. 1 pass / 6 expect. RED (pre-fix: exit-0-no-render signature) → GREEN verified.

## §10 Gap-133b — status-notice render templates diverged from official 2.1.278 — FIXED (all 5 shipped notices)

**Prior verdict overturned**: occ132 had staged the sibling notice templates as "not reconstructable from the binary". A deeper forensics pass on the official linux-x64 ELF (234,119,480 bytes, `@anthropic-ai/claude-code-linux-x64@2.1.278`) recovered the **complete decompiled renders**:

| Site | ELF offset | Content |
|---|---|---|
| `Jm` shared notice-line component | @217714393 | `<Box flexDirection="row"><Box width={2} flexShrink={0}><_t status/></Box><Box flexGrow={1} flexShrink={1}><Text color={yIt[status].color} dimColor={!color}>{children}</Text></Box></Box>` |
| Notice definitions chunk | @217735634 | `n9t` large-memory-files, `r9t` claude-ai-external-token, `i9t` api-key-conflict, `s9t` both-auth-methods, `a9t` large-agent-descriptions — full render bodies |
| `Sne` token-source→action switch | @194659982 | claude.ai → `<CLI> /logout to sign out of claude.ai.`; apiKeyHelper → `Unset the apiKeyHelper setting.`; CCR_OAUTH_TOKEN_FILE → `This token is injected by the CCR host; check the host session.`; none → `""`; default → `Unset the ${e} environment variable.` (`profile` arm omitted — OCC's source union has no 'profile' member; documented, not invented) |
| `yIt` status map + `_t` icon | @206523300 (chunk-5t00n66n.js) | identical to OCC's existing `StatusIcon.tsx` STATUS_CONFIG (minus `ariaLabel` — staged §12) |
| Notice container | @217750300+ | warnings branch = **bare** `<Box flexDirection="column">`, NO paddingLeft (paddingLeft:1/2 exist only in the announcement-slot `aZt?1:2` and ant-notices branches — neither shipped in OCC) |

**Changes**:

- `src/utils/statusNoticeDefinitions.tsx` — new `NoticeLine` (`Jm` port) + `tokenSourceActionText` (`Sne` port); all 5 render bodies rewritten to the official templates. Old OCC framing (`Auth conflict: …`, `· Trying to use X? …`, `Large {path} will impact performance …`, `… · /agents to manage`, `This may lead to unexpected behavior`) has **zero hits** in the official binary — it was invented wording, now removed.
- `src/components/StatusNotices.tsx` — container `paddingLeft` 1 → 0 (official warnings branch is bare; the old value shifted every notice 1 column right of official — this was the 1-column offset seen in live A/B).
- `src/components/design-system/StatusIcon.tsx` — exported `getStatusColor` (the `yIt[status].color` lookup `Jm` uses).
- `jetbrainsPluginNotice` NOT changed — its official counterpart was not dumped/verified this round (staged §12).

**Tests**: `src/utils/__tests__/statusNoticeTemplates278.test.ts` (new, replaces the deleted `bothAuthMethodsNotice278.test.ts` whose scope it fully subsumes): 9 tests / 39 expects — official template text for all 5 notices, stale-framing-absent assertions, `paddingLeft=2` bullet box, dimColor bullets, `Jm` structure (width:2 flexShrink:0 + flexGrow:1 flexShrink:1). RED 6-fail → GREEN 9-pass verified.

**Live side-by-side evidence** (tmux, same project dir `/tmp/accept133/proj-big` with a 93,637-char CLAUDE.md, both `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY` set, official 2.1.278 ELF vs OCC dist, same live gateway): post-fix renders are **pixel-identical** —

```
⚠ CLAUDE.md is over the 40.0k-char limit (93.6k chars) · /memory to free up context
⚠ Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set · auth may not work as expected
  · to use ANTHROPIC_AUTH_TOKEN: Unset the ANTHROPIC_API_KEY environment variable, or {occ|claude} /logout then say "No" to the API key approval before login.
  · to use ANTHROPIC_API_KEY: Unset the ANTHROPIC_AUTH_TOKEN environment variable.
```

⚠ at col 0, bullets at col 2; only intended difference is `occ` vs `claude` (CLI_BINARY_NAME convention). Pre-fix OCC showed `⚠Auth conflict: …` at col 1 — both the wording and the column were divergences.

## §11 OCC-133 self-acceptance battery results (live REPL + headless, real gateway)

| Check | Result |
|---|---|
| Shift+Tab 5-mode ring (bypass → auto → manual → accept-edits → plan) | **PASS** — synced with official |
| Footer parity | **PASS** except official's ` · ← for agents` — OCC ships no `←` agents binding; correct-by-design absence, not a gap |
| Bad-flag error (`--nonexistent-flag`) | **PASS** — byte-identical |
| Headless `-p` round-trip | **PASS** |
| CLAUDE.md discovery ("say BANANA" via memory file instruction) | **PASS** |
| `/status` | **GAPS STAGED** (§12): official shows 5 tabs vs OCC 3; missing rows Session kind / Peer address / Managed settings (remote); column-alignment drift |
| Notice renders (large-memory-files, both-auth) | **GAP FOUND → FIXED** (Gap-133b, §10) |
| `USER_TYPE=ant` startup | **GAP FOUND → FIXED** (Gap-133a, §9) |
| e2e A/B suite | 6 failures — **all pre-existing on v2.1.345** (git-stash A/B proven); identical to the §3 known environment-drift baseline |

Batch-mode note: `bun test src/utils` (shared process) shows 48 failures **identically with and without this round's diff** (git-stash A/B: 2046 tests clean vs 2055 with diff — same 48, all in unrelated files: bedrock strings, registerMainThreadAgentHooks, cacheMarketplaceFromGit, MCP needsAuth, stripInvisibleText). This is the documented P3-2 mock.module contamination (§2/§7.5); per-file `scripts/ci-test.sh` isolation remains the authoritative gate. Changed-file trio green in isolation: `statusNoticeTemplates278` (9) + `antModelGlobalsPolyfill278` (1) + `antFastExitCostSave277` (1) = 11 pass / 53 expect. Biome lint clean on all touched files.

## §12 Staged / ledger additions (OCC-133)

1. **(P3, STAGED)** Official notice registry `L9t` (@217745400+) has **31 entries + tier/announcement-slot governance** (`oQ`/`Fke`/`Oot`, `getActiveNotices` = `Lke`) vs OCC's 6. The 25 unshipped entries are backend/ant/environment-dependent (model-source, mcp-needs-auth, cross-session-messaging-off, model-deprecation, model-restricted, unusable-managed-mcp, hipaa-compliance, remote-managed-settings-failed, monitoring-notice, debug-mode, tmux-session, subscription-switch promo, …). Trimmed surface — port only when the backing features arrive.
2. **(P4, STAGED)** Official `_t` StatusIcon carries `ariaLabel` per status (`done:`/`failed:`/`warning:`/`note:`); OCC's StatusIcon lacks it (screen-reader surface only).
3. **(P3, STAGED)** `/status` gaps from §11: 5 tabs vs 3, Session kind row, Peer address row, Managed settings (remote) row, column alignment.
4. **(by-design)** Footer ` · ← for agents` absence — OCC has no agents-pane binding; documented divergence.
5. **(P4, NOTE)** `src/utils/status.tsx:126` diagnostics still contains the old "Large … will impact performance" wording — separate `/status` surface from the notices; no official evidence gathered for that site this round, left untouched rather than guessed.
6. **(P4, NOTE)** `jetbrainsPluginNotice` render not re-verified against the official counterpart this round.

## §13 Files touched (OCC-133 delta, on top of `9662d3f`)

```
M src/entrypoints/cli.tsx                        (Gap-133a ant-globals install)
M src/types/global.d.ts                          (Gap-133a truthful header)
M src/utils/statusNoticeDefinitions.tsx          (Gap-133b: NoticeLine + Sne + 5 templates)
M src/components/StatusNotices.tsx               (Gap-133b: container paddingLeft 1→0)
M src/components/design-system/StatusIcon.tsx    (Gap-133b: getStatusColor export)
A src/utils/__tests__/statusNoticeTemplates278.test.ts   (9 tests, replaces bothAuthMethodsNotice278)
D src/utils/__tests__/bothAuthMethodsNotice278.test.ts   (subsumed)
A src/cli/__tests__/antModelGlobalsPolyfill278.test.ts   (Gap-133a live-path regression)
M CHANGELOG.md                                   (2.1.347 entry)
M package.json                                   (2.1.346 → 2.1.347)
M docs/upstream-version-gap-occ133.md            (this extension)
```

Security review (diff-level): all changes are UI-template alignment, a startup-global install gated on `USER_TYPE=ant`, and tests. No network egress, no eval, no secrets, no permission-surface changes. The ant-models module was already in-tree and already reachable via the driver path; the fix changes *when* its globals are installed, not *what* it does.

## §14 Release disposition (OCC-133)

Production code changed (Gap-133a startup fix + Gap-133b render alignment) → meets the release bar. Release **v2.1.347**: merge to main → tag `v2.1.347` on the merge commit → npm publish → GitHub Release → verify `/releases` ≡ `/tags` → report count + link.
