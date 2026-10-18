# Upstream Version Gap — OCC-122 (2026-10-19)

> Round type: **P3 carryover repair round** (OCC-121 acceptance APPROVED_WITH_RISK
> → this issue clears the 3 priority fixes, 3 evaluation items, and registers the
> 不修 set). No upstream port work: official Claude Code is **flat at 2.1.302**
> (re-verified at round start — npm dist-tags `latest=2.1.302` / `next=2.1.302` /
> `stable=2.1.292`; no 2.1.303 published). Prior-round ledger:
> `docs/upstream-version-gap-occ121-2026-10.md`.
>
> NOTE: `docs/upstream-version-gap-occ122.md` (no `-2026-10` suffix) is an
> UNRELATED older round (2026-09-12 autopilot, official 2.1.267→2.1.268). This
> file is the OCC-122 issue ledger, named per the `-YYYY-MM` convention.

## 0. Baseline

| Item | Value |
|---|---|
| OCC version | 2.1.390 (`package.json`, unchanged this round) |
| Official latest | 2.1.302 (flat; verified 2026-10-19 via npm dist-tags) |
| main at round start | `3105abad` (issue cited `8a11d02e`; delta = OCC-162 docs-only commits — `git diff --stat 8a11d02e..3105abad` touches only `docs/upstream-version-gap-occ162-2026-10.md`, so all issue line anchors re-verified against `3105abad`) |
| tags/releases | 189/189 at round start (no release this round — see §7) |
| Live model env | ANTHROPIC_BASE_URL=dashscope anthropic-compat, ANTHROPIC_MODEL=qwen3.8-max |

## 1. P3-1 — tool_result DRY duplicate + stale anchor (FIXED)

**Problem.** `src/services/tools/toolExecution.ts` had TWO copies of the
OTEL_LOG_TOOL_DETAILS-gated parameter extractor:
- the fallback `tool_decision` emit (already refactored in OCC-121 Gap-121a to
  call the exported `buildToolParametersForTelemetry` ≡ official `F5n`), and
- the `tool_result` emit (was :1406-1441) which still INLINED a byte-identical
  copy of the Bash/MCP/skill parameter block.

`src/hooks/toolPermission/permissionLogging.ts:~277` carried a DRY comment with
a stale anchor ("the tool_result extractor at toolExecution.ts:1386-1420 …
toolExecution.ts still INLINES its own copy") — both the line range and the
"still inlines" claim were outdated by this fix.

**Fix.**
- `toolExecution.ts`: the inline block is replaced by
  `const toolParameters = buildToolParametersForTelemetry(tool, processedInput)`
  — ONE implementation now feeds the fallback `tool_decision`, the interactive
  `tool_decision` (logPermissionDecision), and both `tool_result` emits
  (success + error path; the error path at :~2004 consumes the same binding).
  The binding is `const` but the OBJECT stays mutable — the post-call git
  enrichment (`toolParameters.git_commit_id` / `.git_branch`, CC 2.1.296 #044)
  writes into it before the success emit; `otelGitCommitId296.test.ts` pins
  that path and stays green.
  - Behavioral-delta review: the helper's Bash branch adds a
    `typeof input === 'object' && input !== null` guard the inline copy lacked
    — equivalent at this site (`processedInput` is a parsed object there); the
    helper's `mcp_tool_name` value source (`mcpDetails.mcpToolName`) matches
    the inline copy's. No wire-format change: key insertion order inside the
    built object is identical (bash_command, full_command, timeout,
    description, dangerouslyDisableSandbox, mcp_server_name, mcp_tool_name,
    skill_name), and `jsonStringify` preserves it.
  - Now-unused imports `extractMcpToolDetails` / `extractSkillName` removed
    from toolExecution.ts (Biome noUnusedImports clean).
- `permissionLogging.ts`: the stale DRY paragraph is rewritten — no line-number
  anchors (they rot; this was the second rot incident on the same comment),
  sites named by function instead, and the mutation contract ("fresh mutable
  object per call; tool_result enriches it post-call") documented.

**Mutation verification.** Breaking the shared Bash branch
(`full_command = bashInput.command` → `= bashCommand` in
`buildToolParametersForTelemetry`) turns **3 tests RED**: the two new
details-ON Bash fixtures in `toolDecisionFallbackOtel302.test.ts` (Section C)
AND the interactive-site Bash fixture in `toolDecisionOtelFields302.test.ts` —
proving both emit sites now hang off the ONE implementation. Restored → 40
pass / 0 fail across the three OTel suites + `otelGitCommitId296`.

**Live wire probe.** `CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=console
OTEL_LOG_TOOL_DETAILS=1 dist/cli.js -p "<Bash echo probe>"` — console exporter
shows `tool_decision` AND `tool_result` both carrying
`bash_command:"echo"` / `full_command:"echo OTel_PROBE_42"` (identical
parameter JSON on both events), exit 0. The refactored path is verified on the
real headless dispatch, not just under mocks.

## 2. P3-2 — FileReadTool stale/exaggerated seam comment (FIXED, comment-only)

**Problem.** The OCC-121 seam-evenness comment in
`src/tools/FileReadTool/FileReadTool.ts` (was :1429-1435) claimed the page-image
mapping now uses "the getFsImplementation() seam **every other read path in this
file** uses (stat at :1302, **readFileBytes at :1471**, …)". Both specifics were
wrong at HEAD: the seam `readFileBytes` call is at :1445 (not :1471), and the
**main text read path is NOT seam-routed** — it goes through `readFileInRange`
(:1679), which uses bare `fs`/`fs/promises` (`createReadStream`/`fstat`/`stat`/
`readFile`, `src/utils/readFileInRange.ts:50-51`).

**Fix.** Comment rewritten truthfully (anchors replaced by function names):
seam-routed = the PDF page-image mapping (readdir + readFileBytes), the two
`stat` calls, and image reads via `readImageBytesCapped` (which opens through
the seam's optional `open?` member, `imageRead.ts:195`); NOT seam-routed = the
main-text `readFileInRange` path. The comment now says so explicitly and points
at this ledger.

**Seam-evenness evaluation (issue asked: should main-text also route through the
seam?). Verdict: NO — deliberate, documented limit.**
- `readFileInRange` does offset/stream reads (`createReadStream` with
  start/end + `fstat` on the open handle + incremental `StringDecoder`); the
  `FsOperations` contract exposes no stream/range primitives (stat, lstat,
  readdir, readFileBytes, optional open — `src/utils/fsOperations.ts:24-135`).
- It is SHARED with `src/utils/attachments.ts` (:2843) — widening the contract
  and rewiring both callers is a substantive cross-file change, not a comment
  fix, and carries regression risk on the hottest read path in the tool.
- Consequence (accepted): custom/test fs implementations affect PDF page-image,
  stat, and image-byte reads but not main-text extraction. Registered here as a
  known limit; a future round may widen the seam contract if a real consumer
  (test harness or VFS feature) needs it — no current consumer does.

`src/tools/FileReadTool/` suite: 152 pass / 0 fail (comment-only change).

## 3. P3-3 — fallback OTel test lacked a Bash fixture (FIXED)

**Problem.** `toolDecisionFallbackOtel302.test.ts` drove only builtin-Grep and
MCP personas through the real `runToolUse` generator; the Bash branch of the
details-gated extractor (the branch carrying the most sensitive fields —
`bash_command`, `full_command`, `timeout`, `description`,
`dangerouslyDisableSandbox`) had no fallback-site pin. The harness also
hardcoded `input: {}` and a `z.object({})` schema that STRIPS unknown keys, so
a Bash input could not survive parsing.

**Fix.** Harness parameterized (`makeFakeTool({inputSchema?})`,
`drive(..., input = {})`) and Section C added — 3 tests, details ON unless
stated:
1. **Bash tool_decision pin**: input
   `{command:'git status --short', timeout:30000, description:'check working tree'}`
   → `tool_parameters` = `{bash_command:'git', full_command:'git status
   --short', timeout:30000, description:'check working tree'}`; no MCP/skill
   key leakage; `dangerouslyDisableSandbox` absent (not in input); v302
   identifiers-first key order holds (tool_parameters after tool_source,
   permission_mode last).
2. **tool_result DRY pin (P3-1 regression guard)**: same drive → the
   `tool_result` event carries Bash fields and
   `expect(resultParams).toEqual(decisionParams)` — a re-inlined drifting copy
   in toolExecution.ts fails this.
3. **details OFF**: neither event carries `tool_parameters` (shared F5n gate).

Safety notes: the fake `canUseTool` bypasses the real permission machinery; the
speculative Bash classifier early-returns (`isClassifierPermissionsEnabled()`
is hardcoded `false`, `src/utils/permissions/bashClassifier.ts:24-26`);
`git status` is not a git-commit shape so `isOtelGitCommitToolCall` skips the
HEAD-state read. No live process/network from the fixture.

**Mutation verification.** See §1 — the shared-helper Bash-branch mutation
turns fixtures 1+2 RED (plus the interactive-site Bash fixture); restore → 7
pass / 0 fail in this file.

## 4. P3-4 — /feedback cleanup-first had no CI backstop (FIXED via extraction)

**Problem.** The cleanup-first ordering (close the created GitHub issue BEFORE
any assertion can throw) lived inside the `/feedback <text>` e2e test body in
`test/e2e/commands-behavior.e2e.test.ts` — a file gated
`describe.skipIf(!!process.env.CI)`. A refactor moving the close after the
assertions (reintroducing the dangling-issue leak) would ship CI-green.

**Evaluation of the two options named in the issue.**
- *non-live-model CI variant of /feedback*: rejected — issue creation requires
  the live model agent loop (`getPromptForCommand` returns a prompt; the model
  calls `gh issue create`). A mocked variant would test nothing real.
- *extract cleanup-order logic into a CI-testable pure function*: **adopted**.

**Fix.**
- `test/e2e/helpers.ts`: new `FEEDBACK_ISSUE_URL_RE` +
  `extractAndCloseFeedbackIssue(stdout, closeFn = ghCloseFeedbackIssue)` —
  closes (best-effort, errors swallowed) BEFORE returning the URL match, so
  callers physically cannot assert before cleanup. Default closeFn = the real
  `gh issue close --repo cnwenf/occ` (15s timeout), injectable for tests.
- `commands-behavior.e2e.test.ts`: test body now calls the helper (ordering
  enforced structurally, not by comment discipline).
- NEW `test/e2e/helpersFeedbackCleanup.test.ts` — CI-runnable (NOT skipIf-gated;
  `scripts/ci-test.sh` globs `find src test -name '*.test.ts'`, so it runs in
  CI with an injected closeFn — no gh, no model, no spawned CLI). 5 tests:
  close-before-return ordering (event log `['close:4242','returned']`), throw
  swallowed + match still returned, no-URL → no close, regex scoped to
  cnwenf/occ only, first-URL-wins single close.

**Mutation verification.** (A) removing the try/catch → 1 fail (throw test
RED); (B) skipping the closeFn call → 3 fail (ordering + throw + first-URL
tests RED); restore → 5 pass / 0 fail.

## 5. P3-5 — /feedback non-zero-exit leak window (EVALUATED, partial fix)

**Residual risk as stated in the issue:** cleanup-first is already in place
(OCC-121); what remains is the timeout case — runOcc SIGKILLs at its budget,
the issue was created but its URL never reached stdout, `urlMatch` is null and
there is nothing to close.

**Actions taken.**
- **Timeout budget (adopted)**: runOcc budget for this test raised 60s → 75s
  (test timeout 90s unchanged) — ≥15s margin for close + assertions, shrinking
  the window where a slow model round-trip + `gh issue create` lands after the
  kill. Live run this round completed in ~50s wall (issue #537 created
  21:02:12Z, auto-closed 21:02:21Z, state CLOSED verified via `gh issue
  view`) — the budget is not the binding constraint on a healthy run.
- **Snapshot-diff sweep (rejected)**: snapshotting open cnwenf/occ issues
  before the run and closing "any new issue" afterwards would close the leak
  completely, BUT cnwenf/occ receives genuine user /feedback traffic (129 open
  issues at round start) and the created issue's title/body are
  model-generated from the feedback text — no reliable marker distinguishes a
  test-created issue from a real one filed concurrently inside the ~90s window.
  Auto-closing a real user's feedback is a worse failure than leaking a
  visible, manually-closable test issue. Registered as accepted residual risk:
  on timeout-before-URL-print, one open issue labeled by its model-generated
  title may remain on cnwenf/occ for manual close.
- **`finally` placement (rejected as insufficient)**: moving the close into
  `finally` does not help this window — the URL is unknown in the failure
  case, so there is nothing to reference; the sweep above is the only
  complete fix and was rejected on safety grounds.

## 6. P3-6 — OTEL_LOG_TOOL_DETAILS full_command semantics (DOCUMENTED, no code change)

**Security-note documentation (issue text: keep behavior unchanged):**

Setting `OTEL_LOG_TOOL_DETAILS=1` (boolean-parsed via `isEnvTruthy`) makes OCC
include a `tool_parameters` attribute on OTel `tool_decision` events (BOTH the
interactive site — `logPermissionDecision`, permissionLogging.ts — and the
headless dispatch-fallback site in toolExecution.ts) and on `tool_result`
events (success AND error paths). For Bash tool calls this attribute carries:
- `bash_command` — first whitespace-delimited token of the command, and
- **`full_command` — the ENTIRE command text, verbatim and unredacted**, plus
  `timeout` / `description` / `dangerouslyDisableSandbox` when present.

Operators enabling this flag must treat the configured OTLP/console telemetry
backend as receiving full shell-command text: commands can embed secrets
(`curl -H "Authorization: …"`, `mysql -p…`, env-var prefixes), tokens, and
private paths. The flag is **default-off** precisely for this reason, and the
gate returns `{}` (key omitted from the wire) when off.

**Alignment status: byte-identical to official and intentionally unchanged.**
The extractor is OCC's `buildToolParametersForTelemetry` ≡ official `F5n`
(v302 ELF @245575922 fallback / @245156620 interactive; dd-verified read-only
in the OCC-121 round, official binary never executed) — the official ships the
same `full_command` semantics under the same default-off gate. Redacting or
truncating `full_command` in OCC would DIVERGE from the official wire format
that the 302 port pins; the correct mitigation surface is the flag staying
opt-in. No code change this round — documentation only (this section).

## 7. Release decision

**No release cut this round.** Changes are behavior-preserving: one DRY
refactor with identical wire output (probe-verified §1), two comment rewrites,
test/harness additions, and an e2e timeout budget bump. `package.json` stays
2.1.390; no tag pushed; tags/releases baseline stays **189/189** (re-verified
at round end). This follows the OCC-40/41/42 precedent (no-op version bumps
pollute /releases); the next behavioral round cuts the release.

## 8. 不修 register (carried from OCC-121 acceptance, unchanged)

- **Blocked DF3** — fallback `tool_use_id` undefined crash: no reachable path
  (dispatch always assigns a tool_use id before the fallback emit); blocked on
  upstream evidence, registered not fixed.
- **5 falsified items** from the OCC-121 self-acceptance sweep: dispositions
  recorded in `docs/upstream-version-gap-occ121-2026-10.md`; nothing revived
  this round.

## 9. Verification log (all synchronous, single run)

| Check | Result |
|---|---|
| OTel suites (fallback302 + fields302 + fields301 + gitCommitId296 + telemetry288 + mcpOtel283 + helpersFeedbackCleanup) | 102 pass / 0 fail, 280 expect() |
| `src/tools/FileReadTool/` suite | 152 pass / 0 fail, 491 expect() |
| Mutation A/B — shared Bash branch (§1) | 3 RED → restore → green |
| Mutation A/B — cleanup helper try/catch + close-skip (§4) | 1 RED / 3 RED → restore → 5 green |
| Biome lint (7 touched files, individually) | clean |
| `bun run build` | green — dist/cli.js 30.29 MB, MACRO.VERSION=2.1.390 |
| Live `-p` smoke (rebuilt dist) | `SMOKE_OK`, exit 0 |
| OTel console probe (live `-p` + Bash tool, details ON) | tool_decision + tool_result both carry identical bash_command/full_command |
| REPL tmux smoke (rebuilt dist) | boot green (2.1.390 banner), Bash-tool round-trip `REPL_SMOKE_122` green, /exit clean |
| Live /feedback e2e (touched test) | 1 pass (50.26s); issue cnwenf/occ#537 created + auto-closed by the extracted helper (gh state CLOSED verified) |
| Official version re-check | 2.1.302 flat — no port work |

## 10. Files touched

- `src/services/tools/toolExecution.ts` — P3-1 refactor (inline block →
  shared helper; 2 unused imports dropped)
- `src/hooks/toolPermission/permissionLogging.ts` — P3-1 anchor comment rewrite
- `src/tools/FileReadTool/FileReadTool.ts` — P3-2 comment rewrite (comment-only)
- `src/services/tools/__tests__/toolDecisionFallbackOtel302.test.ts` — P3-3
  harness parameterization + Section C (3 tests)
- `test/e2e/helpers.ts` — P3-4 `extractAndCloseFeedbackIssue` + regex export
- `test/e2e/helpersFeedbackCleanup.test.ts` — P3-4 CI backstop (NEW, 5 tests)
- `test/e2e/commands-behavior.e2e.test.ts` — P3-4 helper adoption + P3-5
  timeout budget 60s→75s
- `docs/upstream-version-gap-occ122-2026-10.md` — this ledger (P3-6 §6)
