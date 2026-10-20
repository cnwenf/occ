# OCC-124 upstream catch-up ledger — official Claude Code 2.1.304 (2026-10-21)

Round: daily autopilot OCC-124 (triggered 2026-10-21 01:00 Asia/Shanghai).
OCC was aligned to official **2.1.303** (OCC release v2.1.393). Official latest
at round start: **2.1.304** (published 2026-10-19, 76 changelog entries).
This round ports the byte-verified portable subset and releases **v2.1.394**.

Research artifacts: `docs/gap-research-304/` (research-R1…R6 + changelog-entry-304.txt).
Per-WP implementation reports: `docs/gap-research-304/impl-WP1.md … impl-WP7.md`
(each records files changed, verbatim-vs-adapted strings, tests, deviations).
Method: static byte forensics only (`grep -aboF` + `dd` against the official
linux-x64 ELFs); official binaries never executed and deleted after diffing.

## 1. LANDED (PORT) — 7 work packages, disjoint file clusters

| WP | Official items | Surface |
|----|----------------|---------|
| WP1 | #10 mounted-drive `rm -r` safety prompt; #9 sandbox denyRead glob-bracket crash (patch backport onto `@anthropic-ai/sandbox-runtime@0.0.44` — no dep bump); #35 copy-failure logging | BashTool pathValidation / destructiveCommandWarning / managedEnv (118→119) / patches/ |
| WP2 | #34 PreToolUse deny reason no longer replaced by SDK-callback-timeout error (`${denyReason}\n\n${timeoutText}` merge); #32 interrupt ends a Read waiting on an idle pipe/device named like an image (AbortSignal race) | hooks.ts / toolHooks.ts / FileReadTool |
| WP3 | #59+#31 skill-listing history-scan digest dedupe (names+digests; the 301-era rewind/resync machinery DELETED); #60 skill hooks bounds ledger (1024/16384); #61 allowed-tools stripped when hooks kept out (verbatim `kt` isMeta notice); #39 once-hook removal scoped to skillRoot | attachments.ts / registerSkillHooks.ts / sessionHooks.ts / processSlashCommand.tsx |
| WP4 | #22 `context-management-2025-06-27` beta 400 heal (retry without the beta); #58 tool search ON by default behind a custom `ANTHROPIC_BASE_URL` + refuse-recovery window (optimistic-disable branch dropped per official shape) | claude.ts / withRetry.ts / toolSearch.ts / config.ts |
| WP5 | #41 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` k/M suffixes + below-minimum/above-maximum warnings + `compact_window_env` telemetry (MIN=100_000, MAX=1_000_000); #6 compaction summary includes tool-names-used section (`TOOLS_USED_BEFORE_SUMMARY_TAG`, verbatim `Mir` regex); #28 subagent resume flushes pending transcript writes before reading | autoCompactWindow.ts / summaryHeader.ts (NEW) / toolNamesUsed.ts (NEW) / prompt.ts / compact.ts / sessionMemoryCompact.ts / CompactSummary.tsx / resumeAgent.ts |
| WP6 | #29 help texts ×6 verbatim (debug filter / json-schema / --tools / --resume / --disable-slash-commands / update); #17 `getDisplayPath` NUL guard + display-site switches; #33 /effort auto-without-guessing (chip hides, `Effort stays auto.`); #36 AskUserQuestion notes input width/maxVisibleLines/label wrapper; #43 /usage rate-limit end time (`heldUntilMs`, `rate limited until <clock>`); #49 invalid-settings per-file grouping + cap 10 + short skipped header; #8 org-policy refresh on custom-API-key approval (ApproveApiKey + Config toggle) | main.tsx / file.ts / FileWriteTool UI / FileEdit+NotebookEdit rejected messages / effort.ts(x) / EffortIndicator / PreviewQuestionView / usage.ts / Usage.tsx / invalidSettingsReport.ts / ApproveApiKey / Config.tsx |
| WP7 | #27 grove hardening (errorStatus, shape validation verbatim messages, finally-clear, re-stamp); #28 /privacy-settings both-fetch gate; #30 worktree exit at-stake guard (detached/moved-off HEAD — classifier + rev-list counter + official phrases; `tengu_wary_ladle` hardcoded ON per `bright_lake` precedent); #38 SendMessage shutdown-approval guard (verbatim refusal — main session can no longer kill itself) | grove.ts / privacy-settings.tsx / worktree.ts / WorktreeExitDialog.tsx / ExitWorktreeTool.ts / SendMessageTool.ts |

Leader integration (cross-WP anchors): `src/main.tsx` startup emitter for #41 —
`warnAutoCompactWindowEnv(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, {
interactive: !print, headless: stderr })` after the SR-announce block.

~150 new/updated unit tests; all WP suites green in isolation.

## 2. N-A (no OCC surface / not portable)

- **Config.tsx `/config` warning line for #41**: official wires the same
  warning into the /config dialog's warnings list; OCC's Config.tsx has no
  generic warnings-list builder (no anchor) → the startup emitter above is the
  only OCC site. N-A.
- R1 auto-mode cluster small items (#27-R1/#11 numbering internal to R1) and
  the bulk N-A tables in R5/R6 (Windows-only, Cowork/cloud/remote-control,
  diffuse-perf #51/#52-byte-checks, #54 Windows git launcher, etc.) — see the
  research reports for per-item byte-count evidence.
- **occ156-03 adjudication**: KEEP STAGED / stay MANUAL — zero boot-default
  changes 303→304; OCC's manual opt-in posture for auto-mode onboarding
  unchanged. Changelog #4 (`/auto-mode-setup` wizard via `envOnboarding:!0`
  fallback default) folds into this: OCC has no `/auto-mode-setup` surface
  (`rg auto-mode-setup src/` = 0) → STAGED.

## 3. STAGED (with rationale, for future rounds)

| Item | Why staged |
|------|-----------|
| #50 resume of large compacted sessions sends first request sooner (L) | cost center exists in OCC but the official change is not byte-identifiable; needs a dedicated OCC-side perf spike, not a byte-port |
| #52 memory use in long/resumed conversations | diffuse perf; all byte-counters unchanged (`structuredClone` 33=33 etc.); no discrete port target |
| #21 model switches waiting behind context usage check (SDK/desktop) (L) | no blocking context-usage check found in OCC's SDK control loop; effectively N-A until proven otherwise |
| #23 OTel server-managed settings ignored for whole session after sign-in | **flagged LIVE surface** — OCC OTel + remoteManagedSettings are real; `telemetryInitialized` is one-shot and login-refresh doesn't re-init. Official fix mechanism not byte-identifiable; needs first-run timing trace + targeted decompilation |

## 4. Deviations worth carrying forward

- **#43 `Ft`/`Ke` values** (default hold 60s / cap 24h): official VALUES not
  byte-pinned by research; chosen conservatively, flagged in code comments.
- WP7's 10 recorded deviations (hh normalizer, telemetry field omission,
  confirm-tail composition, etc.) — see impl-WP7.md.
- WP1 chose a bun **patch backport** onto sandbox-runtime 0.0.44 instead of
  bumping to 0.0.80 (smaller blast radius).
- WP7 fixed a PRE-EXISTING mock-module leak in
  `worktreeExitDialogHook301.test.tsx` (OCC-97 snapshot/restore retro-fit):
  `bun test worktree` 178/7 → **220/0**.

## 5. Test-gate verdicts

- **Unit**: repo-wide mega-run (`bun test src`) is order-polluted at BASELINE
  (236 pre-existing fails at origin/main via mock.module/spyOn cross-file
  leaks — measured in a clean baseline worktree). Gate = per-suite isolated
  runs: the 14 delta fails vs baseline all pass isolated; 5 baseline fails
  vanished in the after-run (order flakiness). Build green (`dist/cli.js`
  30.34 MB).
- **e2e (Docker, `runner.sh --user occ`)**: full-suite numbers recorded below.
  NOTE: `run.sh` (root) structurally fails every `--dangerously-skip-permissions`
  test (root refusal in setup.ts) — the runner.sh flow is the correct gate.
- e2e expectation updates this round (official 304 string moves, not product
  regressions):
  - `version-2.1.200-cost` E26 seeded-case: the rate-limit tail moved from a
    Usage.tsx literal into the official `fo` formatter (`formatRateLimitedText`
    in usage.ts); assertions now pin the template seam + verbatim formatter
    strings.
  - `occ-update-argv`: fixed container-structural import path
    (`../../src/...` → `REPO_ROOT`-based) — failed identically at baseline
    inside Docker; passes host + container after the fix.
- Pre-existing container-env failures (verified IDENTICAL on a baseline
  origin/main image `occ-e2e:baseline`): `version-2.1.108` prompt-cache TTL
  (child `bun -e` hits `isClaudeAISubscriber` throw with only AUTH_TOKEN set),
  `resume-command-name` (chmod EPERM on root-owned symlink target),
  `version-2.1.329-effort-cap` ⑤⑥ (REPL boot stall vs mock endpoint),
  `/feedback` live-gh issue test (environment). real-coding timeouts under
  full-suite load pass standalone (live-model latency flakes).
- Live smoke (host): `echo "say PONG" | ./dist/cli.js -p` → `PONG`, exit 0
  (benign `[claude-code:unrecognized_model]` stderr for glm-5.2).

E2E full-suite result (runner.sh flow, `--user occ`, image rebuilt from this
branch): **728 pass / 1 skip / 16 fail / 7 errors** across 745 tests (1422s).
Triage of every fail/error — **zero regressions attributable to the 304 port**:

- Pre-existing container-env failures, verified IDENTICAL on a baseline
  origin/main image: effort-cap ⑤⑥ (REPL boot stall vs mock endpoint),
  2.1.108 prompt-cache TTL, resume-command-name (chmod EPERM), /feedback ×2
  (image has no `gh`/GITHUB token), and all 7 file-level `Cannot find module
  '../../src/…'` errors (tests written for host layout; occ-versioning
  spot-checked on baseline → same error).
- Live-model latency/compliance flakes: `--autocompact 500k` (120s timeout in
  suite → passes standalone, file 9/9 green), `/verify` (180s → passes
  standalone 21.8s), `/context` (60s → passes standalone), real-coding
  FileWrite/multi-file/Agent (pass standalone 11/13; the 2 remaining are
  model-latency timeouts), `--append-system-prompt` (glm-5.2 ignores the
  injected token — manual probe behaves IDENTICALLY on current and baseline
  images).
- Fixed this round: `occ-update-argv` (REPO_ROOT path fix, 2/2 green host +
  container) and cost-E26 (304 string relocation, 5/5 green).

Host tmux REPL smoke (live API, glm-5.2): boot ✓ (v2.1.393 banner, effort
chip `◉ xhigh · /effort`), interactive round-trip ✓ (`REPL_PONG_OK`),
`/autocompact` status dialog ✓ (opens/dismisses), `/effort` ✓ (`Current
effort level: xhigh (…)` — #33 display path), clean `/exit` ✓.

## 6. Release

- Merged to main; `package.json` 2.1.393 → **2.1.394**; CHANGELOG
  `## 2.1.394 - 2026-10-21`; tag **v2.1.394** pushed.
- publish.yml npm step expected **E404** — NPM_TOKEN expired ~2026-10-03
  (OCC-151, human-only debt); npm `latest` stays 2.1.367.
- GitHub Release created manually per v2.1.392/393 precedent; releases==tags
  invariant verified (193==193, `comm -23` empty).
