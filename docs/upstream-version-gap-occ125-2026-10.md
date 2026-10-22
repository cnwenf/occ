# Upstream version gap — OCC-125 round (2.1.304 → 2.1.306 SUPPLEMENT), 2026-10-22

## 0. Round shape: collision with OCC-165 → supplement round

This round started as a full 2.1.304→2.1.306 catch-up (official latest at round
start: **2.1.306**; OCC aligned at **2.1.304**, OCC release line 2.1.395).
Research (R1–R6) and implementation (WP1–WP8) completed against that base —
see `docs/gap-research-306/`.

Mid-round, the parallel daily-autopilot round **OCC-165** landed the same
catch-up on `origin/main`:

- `d1f53314` feat(align): official 2.1.304→2.1.306 catch-up — 10 PORT items (P1–P10)
- `0cf5e125` chore(release): 2.1.396
- `34d1d793` docs(ledger): OCC-165 §5 release record
- ledger: `docs/upstream-version-gap-occ165-2026-10.md`

Per the OCC-164/OCC-123 collision precedent (**main wins every overlapping
implementation — the supplement adds only what the prior round did not
touch**), this round converted to a **supplement round**: branch reset to
`origin/main` (34d1d793), and only the keeper set was restored from the WIP
commit `dc40f769` (full pre-reconciliation work, 8 WPs).

## 1. Reconciliation table

### 1a. KEEPERS (this supplement lands them — OCC-165 staged or didn't touch)

| Item | OCC-165 status | This round's content |
|------|----------------|----------------------|
| S1 sandbox `allowNestedUserNamespaces` | **STAGED** (their §4 S1) | WP5: schema key (byte-verbatim 896-char describe @238321756), policyLocks, settings validNestedKeys, sandbox-adapter `falseStickyTrustedSandboxBoolean`, sandbox-runtime@0.0.44 patch regen (SRT_ALLOW_NESTED_USERNS env prefix, `--unsetenv`, memoized bwrap `--help` probe, `--disable-userns` default block), 28 tests |
| S2/S3 `/usage` narrow-terminal + one-line fixes/`f` action | **STAGED** (their S2/S3) | WP8: `usageRecommendations.ts` (NEW, v305 catalog @256635621), `usageEffortState.ts` (NEW), `usageFixEnqueue.ts` (NEW), usageScan/usageWarnings (v306 formatter)/usage-noninteractive updates, tests usageRecommendations306 + usageScanEvidence306 (NEW) + 4 updated suites |
| S4 startup warnings → debug log + banner warning rows | **STAGED** (their S4) | WP3: validator `securityNotice?: string` (3 notice builders, deny/ask only), `startupSecurityWarnings.ts` (NEW — `sanitizeWarningText`≡fd, `formatSecurityWarningRow`≡Zo, `writeWarningToStderr`≡UB, `routeStartupPermissionWarnings`), permissionSetup `securityWarnings: string[]` channel, main.tsx 3-mode routing (interactive→debug log, print-text→stderr, json/stream-json/bg→`[permissions]` debug), REPL banner rows via `createSystemMessage(w,'warning')`, 55 tests (securityNotice305/securityWarnings305/startupWarningRouting305) |
| S5 screen-reader SearchBox "Search:" | **STAGED** (their S5, part) | WP7 part: SearchBox SR label + caret, PromptInput highlights undefined under SR, tests promptInputScreenReader305 + searchBoxScreenReader287 update |
| Compaction `headTruncated` notice | main's P10 = **different mechanism** (`repeatsCompactSummary`); headTruncated not landed | WP4 Task B: `prompt.ts` 5th param + byte-exact note (binary v306 @249154327), `compact.ts` threading re-applied onto main's P10 version (+7 lines, `ptlAttempts > 0` at both call sites), tests compactionHeadTruncated305 (NEW) + compactionRecentNote293 update |
| Workflow journal appendResult warn | main's A1 called it "optional micro-hardening" (not landed) | WP7 part: `primitives.ts` warn on journal save failure, test journalSaveWarn305 |
| Bridge spawn-mode saved-folder messages | not touched by OCC-165 | WP7 part: `bridgeMain.ts` w-toggle + spawn-mode messages, test spawnModeSavedFolder305 |
| e2e container-structural fix | pre-existing baseline failure in Docker | `test/e2e/occ-versioning.e2e.test.ts`: `require("../../package.json")` → `REPO_ROOT`-based (occ-update-argv / OCC-124 precedent). Was failing identically at baseline inside the container; now passes host + container |
| Research/impl records | — | `docs/gap-research-306/` (15 files: R1–R6, impl-WP1–WP8, changelog extract) |
| Test hygiene | — | `unrecognizedModelSignal233.test.ts` mock-leak fix |

### 1b. DROPPED (main's OCC-165 versions win — removed from this tree)

| My WP | Content | Main's counterpart |
|-------|---------|--------------------|
| WP1 | tool-search refuse-recovery rewrite + retry watchdog env var | P1/P2/P3 |
| WP2 | `resolveOverriddenModel` fuzzy match (CC 2.1.305 `yfn`) | P4 |
| WP4 Task A | Bash ENOSPC pre-spawn guard (Shell.ts) | P5 |
| WP6 | MCP allowedMcpServers trusted-scope bypass + `expandedFromEnv` | P9 (landed v306 final state) |

Dropped files confirmed absent from the tree; no stale imports (verified: only
main's own `Q.toolSearchRefusal` comment references remain in claude.ts).
Dropped test files: toolSearchRefuseRecovery306, shellEnospcPreSpawn305,
mcpAllowlistTrustedScope306, modelOverridesFuzzyMatch305.

## 2. Method / skill compliance

- Official ELF **never executed** — byte evidence via `strings -n 8`,
  `grep -aboF`, `dd` only (per `upstream-tracking` skill).
- Novelty proved via s304/s305/s306 sorted-string counts; minified-name
  equivalences byte-verified per version.
- `/tmp/cc-diff-306` cleaned up at round end (skill resource-safety rule).

## 3. Test record (reconciled tree)

### Unit/component gates (isolated-suite discipline — repo-wide runs are order-polluted)

| Suite group | Result |
|-------------|--------|
| permissions + settings + sandbox | 1094 pass / 0 fail |
| usage + workflow + bridge + compact + model | 809 pass / 0 fail |
| PromptInput + SearchBox | 83 pass / 0 fail |
| screens (REPL) | 18 pass / 0 fail |
| services/api | 680 pass / 0 fail |
| biome lint (40 touched files) | 0 errors / 32 warnings |
| `bun run build` | green — dist/cli.js 30.39 MB, MACRO.VERSION=2.1.396 |

### Known baseline failure (NOT a regression)

`argumentSubstitutionCaps301` "expansion budget covers named-arg values" fails
**isolated on pristine origin/main** (stash-verified twice, incl. on the
reconciled tree). Environment/baseline-attributed; recorded here per ledger
discipline. Whole-dir `bun test src/utils/__tests__` shows 12 fails → 11 pass
isolated (order pollution: ideExtensionSingleLaunch300, statusNoticeTemplates278,
invisibleUnicode, drainStdout, etc.) + this 1 baseline failure.

### e2e (Docker, `test/e2e/runner.sh` persistent container `occ-e2e-runner`, --user occ)

- Targeted: `occ-versioning` 1/1 pass (after REPO_ROOT fix; failed identically
  at container baseline before it), `commands-alignment` 5/5 pass.
- Full suite (reconciled image, 926s): **732 pass / 1 skip / 6 fail / 6 errors
  / 2651 expect() across 745 tests (159 files)** — all 6 fails match the
  pre-existing container/env classes documented in the OCC-124/OCC-165 ledgers
  (OCC-82 effort-cap ⑤⑥ tmux, 2.1.108 prompt-cache TTL [needs
  ANTHROPIC_API_KEY-class auth env], resume-command PTY, /feedback GitHub
  round-trip, --append-system-prompt real-model), and the 6 errors are the
  known container-structural module-path class (`../../src/...` /
  `../../package.json` requires that resolve outside the RO `/test/e2e`
  mount). The pre-reconciliation full run was 731/13/7; the occ-versioning
  error is now fixed (this round) and the remaining set is baseline-identical.
  **Zero new failures attributable to the supplement.**

### Live REPL acceptance (tmux, real gateway: dashscope qwen3.8-max)

Verified pre-reconciliation on the full WP tree; re-verified post-reconcile on
the 2.1.396-based build:

- Boot chain: trust dialog → theme → API key → security notes → bypass-permissions dialog
- Live model round-trip (REPL_PONG_OK), `/status`, `/effort`, `/usage` panel
- Headless `-p` + `/usage` non-interactive
- WP3 securityWarnings all 3 routing modes: interactive banner warning rows
  (`Glob(path:/secret/*)` never-matches + `TotallyUnknownTool(x)` matches-no-tool),
  `-p` → stderr, `--output-format json` → silent stderr + `[permissions]` debug line
- modelOverrides case-shifted `/status` display (main's P4 path)

## 4. Release record

- Version: **2.1.397** (bump from 2.1.396; CHANGELOG `## 2.1.397 - 2026-10-22`)
- Commits: supplement `ddb0cdbb` + release `604a47ab`, pushed to main
  (fast-forward `34d1d793..604a47ab`).
- Tag `v2.1.397` pushed → publish.yml run 39694300404 **failed with npm E404
  as expected** (NPM_TOKEN expired ~2026-10-03, OCC-151 human-only debt; npm
  `latest` stays 2.1.367).
- GitHub Release created manually per v2.1.392–396 precedent:
  https://github.com/cnwenf/occ/releases/tag/v2.1.397
- releases==tags invariant verified via `gh api repos/cnwenf/occ/releases`:
  **196==196**.

## 5. Review record (code-reviewer + security-reviewer subagents)

Both verdicts: **APPROVE** (no CRITICAL/HIGH).

Fixed before commit:
- code-reviewer M1: resume-chooser REPL mount (`launchResumeChooser` →
  `ResumeConversation`) dropped `securityWarnings` — now threaded
  (`ResumeConversationProps.securityWarnings` → `<REPL>`), so `--resume`
  interactive sessions render the same banner rows as both `launchRepl` sites.
- code-reviewer M2: `impl-WP1/WP2/WP4/WP6` claimed "LANDED" for dropped work —
  superseded banners added (WP4 banner is partial: Task A dropped, Task B kept).
- code-reviewer L3: stale `modelOverridesFuzzyMatch305` comment reference in
  `unrecognizedModelSignal233.test.ts` → `modelOverridesNormalizedMatch305`.

Tracked (not fixed this round):
- **security-reviewer M1**: the nested-userns default-block is not enforced on
  the seccomp-helper path — `--disable-userns` is only added when no seccomp
  filter is in use, and sandbox-runtime 0.0.44's applier ignores the
  `SRT_ALLOW_NESTED_USERNS=0` env prefix (forward-compat only; official v306's
  *newer vendored applier* enforces natively). Not a regression (pre-patch
  there was no block at all) and structurally faithful to official v306, but
  the "default false = blocked" guarantee is unfulfilled on the seccomp path in
  OCC until the runtime dependency is bumped. Follow-up: extend the
  `--disable-userns` leg to the seccomp path when the bwrap prober reports
  support, or bump sandbox-runtime.
- code-reviewer L4–L7 (dead export `computeUsageBehaviors`, staged
  `usageFixEnqueue` callers, double JSON.parse in `noteAssistantEvidence`,
  duplicate `pluralize`) — recorded for a future cleanup round.

## 6. Staged / follow-ups (next rounds)

- OCC-165's S6/S7 staged items remain staged (not in this round's scope).
- security-reviewer M1 (§5): enforce nested-userns default-block on the
  seccomp-helper path (extend `--disable-userns` leg or bump sandbox-runtime).
- `argumentSubstitutionCaps301` baseline failure — investigate independently.
- Whole-dir test order pollution (11 suites) — long-standing; isolated-suite
  gating remains the discipline.
- npm publish blocked on OCC-151 (human: rotate NPM_TOKEN).

## 7. Acceptance record — independent review (2026-10-22, post-release)

OCC 验收员 re-ran code-reviewer + security-reviewer independently on the shipped
delta (`git diff ddb0cdbb^..ddb0cdbb`, 59 files +7732/−191). Both verdicts:
**WARN, no CRITICAL/HIGH.** No secrets, no injection, no new attack surface.

Independent-confirmed clean: startup 3-mode warning routing, sanitizeWarningText
(Cc/Cf strip — no ESSeq/terminal-injection bypass), permissionValidation
securityNotice gating, compaction headTruncated threading, workflow journal warn,
occ-versioning REPO_ROOT fix, sandbox tier-merge
(`falseStickyTrustedSandboxBoolean`). Byte-verified via the vendored
apply-seccomp binaries (0.0.44 has 0× SRT_ALLOW_NESTED_USERNS, 0.0.81 does).

**NEW MEDIUM (not in the round's own review): REPL securityWarnings seeded as
persistent transcript system messages, not the official banner-registry entry.**
`src/screens/REPL.tsx:1281-1295` prepends `createSystemMessage(w,'warning')` into
the messages lazy initializer; `isLoggableMessage` passes system msgs
(`sessionStorage.ts:5338`) so the rows persist to the transcript; resume sites
(`src/main.tsx:4291/4340`) re-seed fresh `securityWarnings` on top → stale rows
re-render after a rule is fixed, doubled once persisted+re-seeded. Official uses
an ephemeral `{id:"security-warnings",tier:"warning",isActive:…}` banner-registry
entry (impl-WP3.md:67 admits the "per task, YAGNI" deviation). Impact limited to
display (`normalizeMessagesForAPI` strips system msgs → never reaches model).
FIX filed as OCC-126 to the programmer: implement a non-transcript banner state
(or dedupe-on-seed / exclude from recordTranscript).

security-reviewer's HIGH is the known security-M1 (§5/§6): forward-compat gap,
**not a regression** (pre-diff exposure unchanged on the helper path; diff strictly
adds the `--disable-userns` leg). Release record corrected by acceptance:
releases==tags is **197==197** after the v2.1.398 README-badge fix-forward
(§4's 196==196 was captured before it), symmetric set diff empty.
