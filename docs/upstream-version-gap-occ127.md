# Upstream Version Gap — OCC-127 (official 2.1.272 → 2.1.273)

Round: OCC-88 version catch-up (2026-09-17). Baseline: OCC tracked upstream `2.1.272`
(package version 2.1.337 at round start; this round's release tag is **v2.1.338**).
Official npm `@anthropic-ai/claude-code` latest re-verified live this round:
**`2.1.273`** (published 2026-09-15).

Methodology per `upstream-tracking` + `aligning-with-official-binary` skills: binary
forensics on the official linux-x64 ELFs (`npm pack @anthropic-ai/claude-code-linux-x64@<ver>`),
`strings -n 8 | sort -u` + `comm -13` diff, python byte-mode `re.finditer` context
extraction for verbatim minified-JS recovery. **Never invent** — every landed behavior
below is backed by byte-verbatim binary evidence; anything ambiguous stays STAGED with
rationale. Minified symbol homonyms (multiple functions sharing a short mangled name)
were disambiguated by region proximity + signature + behavior content throughout.

Forensic artifacts (this round, `/tmp/cc-diff-273`, deleted after acceptance per skill):

| Artifact | Value |
|---|---|
| 2.1.272 ELF (`vprev/package/claude`) | 227,115,320 bytes |
| 2.1.273 ELF (`vver/package/claude`) | 228,663,608 bytes (+1.55 MB) |
| strings(2.1.272) `s1s.txt` | 282,164 lines |
| strings(2.1.273) `s2s.txt` | 283,707 lines |
| new-in-2.1.273 strings (`comm -13`) | 13,202 lines |
| Official changelog 2.1.273 | ~65 entries (substantive) |

OCC has no Statsig — gated code collapses to its default — so gate-flip items are
triaged on their default-OFF behavior unless the binary shows otherwise.

## 0. Verdict summary

| # | Official item (2.1.273) | Verdict | Where |
|---|---|---|---|
| 1 | Gateway hint request headers (`x-claude-code-request-class` etc., `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`) | **LAND** | §1 Gap-127a |
| 2 | Spinner doubled ellipsis ("Running PreCompact hooks……") | **LAND** | §2 Gap-127b |
| 3 | Main prompt dropping `!` typed at start while already in shell mode | **LAND** | §3 Gap-127c |
| 4 | Subshell hiding a dangerous `rm` skipping the prompt in bypass mode | **LAND** (byte-verified full mechanism; §4 Gap-127d — this round's security keystone) | §4 |
| 5 | `blockReadsOutsideWorkingDirectories` unanalyzable-command prompt fix + all companion permission-path changes | **NO-OP** (OCC has no `blockReadsOutsideWorkingDirectories` surface; companion changes catalogued §4.6) | §4.6 |
| 6 | Revert of the 2.1.268 deny-rules-on-unanalyzable-Bash-lines change | **NO-OP** (OCC never landed the 268 change; binary confirms `denyRulesUnjudged` entry removed from the 273 classification map — §4.6) | §4.6 |
| 7 | MCP server disconnect notification when auto-reconnect gives up | **STAGED** (OCC has `MCPConnectionManager` reconnect logic; needs official trigger-point + text forensics) | §5 |
| 8 | `OTEL_LOG_TOOL_DETAILS=1` adds real agent/skill/plugin/MCP names to cost+token metrics | **STAGED** (OCC has the env gate in `src/services/analytics/metadata.ts`; needs per-attribute forensics of which names land on which metrics) | §5 |
| 9 | macOS Read refusing files the system reports under a second path ("symlink resolution changed…") | **STAGED** (OCC has the exact deny message in `src/utils/permissions/symlinkResolutionStash.ts`; official fix mechanism — likely inode/dual-path tolerance — needs forensics; must not weaken the concurrency guard by guessing) | §5 |
| 10 | Managed MCP settings keys ignored when server-managed settings present | **STAGED** (OCC has `allowManagedMcpServersOnly`/`deniedMcpServers` + a `remoteManagedSettings` sync cache; needs official merge-precedence forensics) | §5 |
| 11 | 401/403 on Bedrock/Vertex/Foundry + gateway 403 → message names the credential to refresh | **STAGED** (needs verbatim error-text forensics per provider) | §5 |
| 12 | MCP sign-in expiry mid-session message points at `/mcp` | **STAGED** (OCC MCP OAuth is simplified; needs surface check + text forensics) | §5 |
| 13 | Subagents/background agents reported failed when final streamed reply omits usage or model id | **STAGED** (no obvious OCC fail-path found by grep; needs targeted forensics of the official result-delivery guard + an empirical OCC repro before porting) | §5 |
| 14 | SDK/`stream-json` dropping a subagent's remaining messages after mid-run backgrounding (`CLAUDE_AUTO_BACKGROUND_TASKS`) | **STAGED** (OCC has the env var; needs forensics of the official stream-replay fix) | §5 |
| 15 | Scheduled tasks running in the wrong session after `.claude/scheduled_tasks.json` copied to another folder/worktree | **STAGED** (OCC persists to the same file with a watcher — surface exists; needs forensics of how official keys tasks to a workspace/session) | §5 |
| 16 | `/login`, `/upgrade`, `/extra-usage` discarding earlier thinking (prompt-cache rewrite) | **STAGED** (OCC has pre-fix behavior on `/login`; `/upgrade`+`/extra-usage` absent; needs thinking-block preservation forensics) | §5 |
| 17 | Hook progress / sub-agent activity re-processing the whole conversation (long-session responsiveness) | **STAGED** (architectural perf work; needs forensics of the official incremental-update mechanism) | §5 |
| 18 | Remote-control session forking from the Claude app | **NO-OP** (no Remote Control surface in OCC) | §6 |
| 19 | claude.ai-synced skills → recoverable trash when org disables Skills | **NO-OP** (no claude.ai skill sync; `disableClaudeAiConnectors` absent in OCC — re-confirmed) | §6 |
| 20 | Auto mode stopping for Artifact upload approval | **NO-OP** (no Artifact tool in OCC) | §6 |
| 21 | Long-running session recreating stub `.git/info/exclude` after `.git` removed | **NO-OP** (OCC only READS `.git/info/exclude` — `src/utils/git/gitignore.ts`; no stub-creation writer exists, grep-verified) | §6 |
| 22 | Context meter/auto-compact counting advisor-tool turns at 2× | **NO-OP** (no AdvisorTool registered in OCC's tool set — the official double-count has no OCC counterpart) | §6 |
| 23 | `/tui` refusing restart because of a finished agent-team teammate | **NO-OP** (OCC `/tui` has no agent-team teammate lifecycle — grep-verified no `teammate`/`agentTeam` references) | §6 |
| 24 | `/install-github-app` SAML message; Remote Control context-window usage; cloud-session creation/auth errors; Artifact tool improvements (×4); cloud-session GitHub error causes; `/autofix-pr` (×2); `/web-setup` errors | **NO-OP** (trimmed surfaces: no install-github-app/Remote Control/cloud sessions/Artifact/autofix-pr/web-setup in OCC) | §6 |
| 25 | In-session SSL/proxy errors naming the error code + `NODE_EXTRA_CA_CERTS` | **STAGED** (OCC has generic transport errors; needs verbatim message forensics — candidate next round) | §5 |
| 26 | Auto mode on Bedrock/Vertex/Foundry defaults to local classifier; `CLAUDE_CODE_AUTO_MODE_SERVER=1` | **NO-OP** (OCC has no server-side classifier integration — auto mode already local-only; the env var is new in 273 and gates a surface OCC lacks) | §6 |
| 27 | Sign-in with Claude account also requests claude.ai plugins access | **STAGED** (OAuth scope change — needs scope-string forensics; low priority, plugin marketplace is trimmed in OCC) | §5 |
| 28 | `/bug` + `/feedback` reports include only model-behavior params (omit request metadata + `CLAUDE_CODE_EXTRA_BODY`) | **STAGED-verify** (privacy-positive; OCC's `/bug` is a minimal `index.js`, `/feedback` a small tsx — likely little/no metadata is sent today; verify what OCC includes before porting) | §5 |
| 29 | Frontend-design spinner tip false positive after Artifact read/publish | **NO-OP** (OCC's `frontend-design-plugin` tip triggers on html/css FILE PATHS via `isMarketplacePluginRelevant` — the official Artifact-based false-positive trigger doesn't exist in OCC) | §6 |
| 30 | VSCode (×2), Windows UNC, Claude Code on the web (×6), Claude Tag (×10), Code Review cloud (×6) | **NO-OP** (per skill: VSCode-only/web/Tag/cloud-review items skipped; OCC has none of these surfaces) | §6 |

## 1. Gap-127a — Gateway hint request headers (LAND)

Official 2.1.273 adds five request headers for LLM gateways, gated by the
tri-bool `CLAUDE_CODE_GATEWAY_HINT_HEADERS` env override (default on for the
first-party gateway; see the `Tle` chain below):
`x-claude-code-request-class`, `x-claude-code-agent-type`,
`x-claude-code-prev-tool-durations`, `x-claude-code-compaction`,
`x-claude-code-context-compacted`.

**Byte-verified official subsystem** (recovered verbatim from the 2.1.273 ELF):
7 headers total in the builder (the 5 changelog-named + 2 companions), value limits
32 entries / 4096 chars, workflow agent prefix `agent:builtin:`, gate `Tle`
(env triBool → `fl()` firstParty check → Statsig default **false**), request-class
classifier `MLr`, agent-type classifier `DLr`, prev-tool-durations builder `gkt`.

**OCC port**: new `src/services/api/gatewayHints.ts` (419 lines) + wiring in
`client.ts`/`claude.ts`/`query.ts`/`StreamingToolExecutor.ts`/`toolOrchestration.ts`/
`toolExecution.ts`/`compact.ts`/`forkedAgent.ts`/`autoCompact.ts`. The gate
mirrors the official `Tle` chain: tri-bool `CLAUDE_CODE_GATEWAY_HINT_HEADERS`
env override → `fl()` firstParty+default-base-URL check (OCC's existing
`isFirstPartyAnthropicGateway` predicate — the same one used for
client-request-id injection) → the official Statsig branch evaluates **false**
in OCC. Net: default ON for a first-party api.anthropic.com endpoint, default
OFF for third-party/custom endpoints (the common OCC deployment). ~55 unit
tests in
`src/services/api/__tests__/gatewayHints273.test.ts` (all A–H sections).

**Decision — workflow `querySource` dormancy**: OCC keeps `querySource:'workflow' as never`
on the workflow query path and wraps execution in `runWithAgentContext` (ALS) only.
The official `MLr` 'workflow' request-class branch therefore stays DORMANT in OCC
(the ALS context isn't consulted by the classifier port). Rationale: activating it
would require porting the full agent-context propagation contract, which touches
the workflow engine's vm sandbox boundary — out of scope for this round and not
guessable from the binary. Documented here so a future round picks it up
deliberately.

## 2. Gap-127b — Spinner doubled-ellipsis guard (LAND)

Official 2.1.273: "Fixed the spinner showing a doubled ellipsis ('……') on
compaction status lines such as 'Running PreCompact hooks…'".

**Byte-verified**: the official ellipsis appender gained a trailing-ellipsis
check — verbs already ending in `…` or `...` are returned unchanged.

**OCC port**: `SPINNER_ELLIPSIS_RE` + `appendSpinnerEllipsis` in
`src/components/Spinner/utils.ts`, used by `Spinner.tsx`. Tests in
`src/components/Spinner/__tests__/ellipsis273.test.ts` (incl. idempotence and
the two-ASCII-dots edge).

## 3. Gap-127c — Shell-mode `!` insert guard (LAND)

Official 2.1.273: "Fixed the main prompt dropping a `!` typed at the start
while already in shell mode, so negated commands like `! grep …` can be typed".

**Byte-verified official guard**: `pe!==void 0&&y.offset===D.length&&lBe(A)&&pe()!==hg(A)`
— the mode-switch path fires only when the current mode DIFFERS from the mode
the typed char maps to. 2.1.272 lacked the last clause, so `!` at start while
already in bash mode was swallowed as a redundant mode switch.

**OCC port**: pure predicate `shouldTriggerModeSwitch(keystroke, isAtStart,
currentMode)` in `src/components/PromptInput/inputModes.ts`; `useTextInput.ts`
gained a `getInputMode` prop and the dispatch guard (insert + cursor-left on
true, plain insert on false); `PromptInput.tsx`/`TextInput.tsx`/
`textInputTypes.ts` plumb the getter. Tests in
`src/components/PromptInput/__tests__/modeSwitch273.test.ts`.

## 4. Gap-127d — Subshell-hidden dangerous `rm` bypassing the prompt (LAND — security keystone)

Official 2.1.273 changelog: "Fixed Bash commands the permission checker cannot
fully analyze skipping the prompt under `permissions.blockReadsOutsideWorkingDirectories`,
**and a subshell hiding a dangerous `rm` in bypass mode**." This section covers
the second half (the first half and all companion permission-path changes are
§4.6 — NO-OP for OCC).

### 4.1 The official 2.1.272 bug (byte-verified, complete mechanism)

Empirical repro (official 2.1.272, bypassPermissions mode): `echo hi && (rm -rf /)`
executes **without any prompt**. Mechanism, all recovered verbatim from the
2.1.272 ELF:

1. Entry function `S5o` (offset 194636385): parses the command to a full
   tree-sitter AST (`nKe`), classifies it (`Ywe`). For `echo hi && (rm -rf /)`
   the classification is kind **simple** (a plain `&&` compound of two simple
   commands) — NOT `too-complex`.
2. The dangerous-rm walker `_5o` (offset 194631993) — which would flag
   `rm -rf /` with the `dangerousRemoval` circuitBreaker — is called **only
   from the `kind==="too-complex"` branch**. On the simple path it never runs.
3. Instead the compound check `BAn`→`R6o` sees `hasSubshell` and returns a
   plain ask: `{type:"other", bashMissKind:"shell-operators"}`.
4. Top-level bypass gate (offset 194998579): an ask survives bypassPermissions
   only if its `decisionReason` maps to `bypassImmune:!0` in the classification
   map `en` (`nNe(e)=co(e).some(n=>en[n]?.bypassImmune===!0)`). The
   shell-operators ask has no such mapping → bypass mode **auto-allows** it.
5. The classification map DOES contain
   `dangerousRemoval:{bypassImmune:!0,classifierRouted:!0,...}` — so had the
   walker run, the verdict would have prompted even in bypass mode.

### 4.2 The official 2.1.273 fix (byte-verified)

In `Mzo` (273's entry function, offset 195603600), the shell-operators branch
gained a walker call before falling through to the plain ask:

```js
if(ve.behavior==="ask"&&…bashMissKind==="shell-operators"){
  if(blockReads…)return KO("a subshell cannot be checked against the read block");
  if(d&&d!==kz){let Pn=await rxn(d,te(),s);if(Pn!==null)return Pn}
}
```

`rxn` (273's walker, offset 195598418) is functionally identical to 272's
`_5o`: it splits every body on shell operators via `Fp` (tree-sitter splitter,
offset 194771799, skip-set `&&`,`||`,`|`,`;`,`&`,`|&`,newline; recurse-set
`program`,`list`,`pipeline`), strips one `{…;}`/`(…)` wrapper per segment, and
runs the rm/rmdir target checks (`dX`→critical-path/workspace/glob checks).
For `echo hi && (rm -rf /)` the segment `(rm -rf /)` strips to `rm -rf /` →
`dX` critical-path hit → `YL` ask with `circuitBreaker:"dangerousRemoval"` →
**bypassImmune** → bypass mode now prompts. The top-level bypass gate itself is
byte-identical between 272 and 273 (offsets 194998579 / 195968871) — the entire
fix is routing the walker into the shell-operators branch.

### 4.3 The OCC gap (empirical, pre-fix)

OCC's counterpart of the always-on dangerous-rm guard is
`findCatastrophicSubstitutionBlock` (`src/tools/BashTool/destructiveCommandWarning.ts`),
called first in `bashToolHasPermission` and deliberately **not** gated by
bypassPermissions (returns `behavior:'deny'` — inherently bypass-immune; the
2.1.208 #41 design: "the substitution form must match the plain form"). But its
body loop analyzed each body **as a whole string** only:

- `extractCommandSubstitutions` deliberately does NOT match bare `( … )`
  groupings (only `$(…)`, backticks, `<(…)`, `>(…)`, `${ |…}`) — correct per
  the official `GRg` walker it ports;
- the single wrapper-strip applies to the WHOLE body, and
  `RM_ROOT_HOME_PATTERN`'s `/` follow-set `(?:\s|$|[;&|\n])` doesn't match `/)`.

Empirical pre-fix probe: `echo hi && (rm -rf /)` → substitution guard: no
match; `findDestructiveCommandBlock` (plain-form `rm_root_home` pattern):
skipped in bypassPermissions by design → **allow in bypass mode**. Same bug
class as official 272, same repro.

### 4.4 The OCC port (this round)

`findCatastrophicSubstitutionBlock` now analyzes each `splitCommandForRm`
(alias of the quote-aware `splitCommand_DEPRECATED`) **segment** of every body
in addition to the whole body (strict superset — no existing detection can
regress; all 20 pre-existing `bashSecurityCatchup.test.ts` cases stay green).
The splitter surfaces `(rm -rf /)` as a bare `rm -rf /` segment
(`["echo hi","(","rm -rf /",")"]` — probe-verified), and being quote-aware it
keeps `echo "a && rm -rf /"` as ONE segment (no false positive). Per segment:
the existing wrapper-strip + `findCatastrophicRmInCommand` (var-path targets) +
`RM_ROOT_HOME_PATTERN` (literal root/home) checks run unchanged, keeping OCC's
established categories (`rm_substitution_root_home`, `rm_substitution_var_path`)
and deny style. No call-site change needed — the guard already runs in ALL
modes and returns bypass-immune deny.

Scope notes:
- Bare `rmdir /` (no `-rf` flags) is NOT caught — OCC's patterns are flag-based
  and the official `dX` simple-rmdir target table wasn't forensically recovered
  this round; not invented (STAGED observation).
- `{ rm -rf ~; }` whole-body detection preserved (regression-tested).

New tests: `src/tools/BashTool/__tests__/subshellRm273.test.ts` (14 tests:
7 positive per-segment forms incl. the changelog repro across `&&`/newline/
pipe/semicolon/brace-group, 4 false-positive negatives, 2 pre-existing
whole-body regressions, 3 `bashToolHasPermission` integration tests —
bypass-mode DENY on the repro, bypass-mode no-deny on a safe subshell
compound, default-mode deny). BashTool dir: 456 pass / 0 fail.

### 4.5 Observation — `bash -c "rm -rf ~"` (out of scope, NOT invented)

The official 273 walker does **not** recurse into eval-string arguments
(`bash -c "…"` stays a simple `bash` command to `rxn`'s segment checks; the
official eval-flag map `T8e` serves other paths). OCC likewise doesn't block
it via this guard. Since this is not part of the official 2.1.273 fix, no
change was made — documented so a future round can forensically trace how
official handles eval-string opacity end-to-end before touching it.

### 4.6 Companion 2.1.273 permission-path changes — catalogue (all NO-OP/doc-only for OCC)

The same changelog line's first half and neighboring binary changes were fully
catalogued; each was verified against OCC's surface:

| Official change (byte-verified) | OCC verdict |
|---|---|
| `Czo` 4th callback param: `blockReads…` check moved BEFORE dangerous-rm/AST checks (`let h=s?.();if(h)return h;`) | **NO-OP** — gates on `blockReadsOutsideWorkingDirectories`, a setting OCC does not implement |
| Semantics-miss branch reordered (`KO(O.reason)` before walker result; removed `c5o/sgt` try/catch + `Xn` flag) | **NO-OP** — same setting dependency |
| New `Rzo` bashMissKind escalation map + `Pzo` (escalates `too-complex`/`semantics`/`multi-cd`/`shell-operators`/`cd-git-compound`/`process-substitution` asks to `KO` under blockReads) | **NO-OP** — same |
| New `Izo` git-after-directory-change reason + `ge()` callback passed as 7th arg to `BEn`; git-compound reason reworded ("…can pick up untrusted hooks or repository configuration from the target directory. Approve only if you trust it.") | **STAGED-text-only** — the reworded message pairs with the blockReads callback plumbing; OCC's cd-git compound path has its own message set; adopting just the string without the mechanism would diverge from the official decision flow |
| `Zmt` two-pass → `pX(e,n=!1)` single-pass with `bAe`/`Nme` (bypassImmune + classifierRouted) subcommand precedence | **NO-OP** — refactor of the classifier-routed precedence helper; OCC's deny-style guard needs no classifier routing |
| New `jZe` subshell detector wired into `Nae` (read-only decomposition bails when a subshell hides under a command/variable_assignment, incl. redirect children) | **STAGED-observation** — `Nae`'s read-only decomposition has no direct OCC counterpart (OCC's read-only fast-path uses different gating); no OCC bypass found empirically (the §4.4 deny fires first in all modes) |
| Classification map `en`→`Zt`: `denyRulesUnjudged` entry REMOVED | **NO-OP confirmation** — this IS the changelog's "Reverted a 2.1.268 change…" item; OCC never landed the 268 deny-rules-on-unanalyzable-lines behavior, so the revert restores parity (OCC's `time -p make build`-style commands prompt, not deny — matches post-revert official) |
| `dangerousRemoval` map entry unchanged: `{bypassImmune:!0,classifierRouted:!0,hostPersonOnly:!1,localProjectionOnly:!1}` | Reference — confirms the §4.2 immunity mechanism |

## 5. STAGED items (need per-site forensics next round — priority order)

1. **macOS dual-path Read refusal (#9)** — user-visible false deny on macOS;
   OCC has the exact message site (`symlinkResolutionStash.ts:168`). Needs the
   official fix mechanism (inode identity? `/private` prefix tolerance?) before
   touching the concurrency guard.
2. **Subagent final-reply usage/model-id failure (#13)** — result-delivery
   correctness; find the official guard (`reported as failed… result never
   delivered`) and an empirical OCC repro first.
3. **MCP disconnect notification (#7)** — small, self-contained once the
   official trigger point (reconnect give-up) + notification text are recovered.
4. **SDK/stream-json mid-run backgrounding replay (#14)** — OCC has
   `CLAUDE_AUTO_BACKGROUND_TASKS`; needs stream-replay forensics.
5. **Scheduled-tasks wrong-session keying (#15)** — OCC persists to the same
   `.claude/scheduled_tasks.json`; needs the official workspace-key mechanism.
6. **`OTEL_LOG_TOOL_DETAILS` names (#8)**, **401/403 credential messages (#11)**,
   **SSL/proxy error codes + `NODE_EXTRA_CA_CERTS` (#25)**, **MCP sign-in expiry
   message (#12)** — error/telemetry text ports; each needs verbatim recovery.
7. **Managed MCP settings precedence (#10)** — needs official merge-order
   forensics across policySettings vs remoteManagedSettings sync cache.
8. **`/login` thinking preservation (#16)** — prompt-cache efficiency; needs
   the official message-rewrite forensics.
9. **Hook-progress responsiveness (#17)** — architectural perf work.
10. **claude.ai plugins OAuth scope (#27)**, **`/bug`+`/feedback` payload trim
    (#28, verify-first)** — low priority.
11. **Gap-127a follow-up**: workflow `querySource` classifier activation (§1).
12. **§4.5/§4.6 observations**: eval-string opacity end-to-end trace; `jZe`
    read-only-decomposition counterpart check; bare-`rmdir /` target table.
13. **Carried from occ126 acceptance backlog** (folded into occ127 by the
    OCC-126 round): `/config` panel fullscreen mouse support (PORTABLE-LARGE),
    spinner status ladder "deep in thought"/"picking the thought back up"
    (STAGED), Monitor event-delivery consumer (PORTABLE-LARGE — the E2E-1
    divergence banner), pre-existing sandbox per-command `allowed_domains`
    gap, TaskStop→monitor production wiring, `streamWs` registration window,
    inputSchema `description` describe-banner coverage. None of these are
    2.1.273 delta items; they remain backlog for a dedicated round (each is
    PORTABLE-LARGE or needs its own forensics — out of scope for this
    single-version catch-up per the round's execution discipline).

## 6. NO-OP items (verified absent surfaces)

#5/#6 (§4.6), #18–#24, #26, #29, #30 per the verdict table. Verification
method: grep of OCC source for each surface (Remote Control, Artifact,
claude.ai skill sync, `disableClaudeAiConnectors`, `.git/info/exclude` writer,
AdvisorTool, `/tui` teammate lifecycle, install-github-app, autofix-pr,
web-setup, server-side auto-mode classifier, VSCode/web/Tag/Code-Review-cloud)
— all absent or read-only, as noted per row.

## 7. Test & build status this round

- New/updated unit tests: `gatewayHints273.test.ts` (~55), `ellipsis273.test.ts`
  (8), `modeSwitch273.test.ts` (7), `subshellRm273.test.ts` (14) — all pass.
- Directory runs (the practical gate — full `bun test src/` has a PRE-EXISTING
  hang on clean main, A/B stash-verified in an earlier round): BashTool 456/0,
  api+hooks 150/0, PromptInput+Spinner 63/0, WorkflowTool+compact 70/0.
- Pre-existing failures unchanged and unrelated: `src/utils` 23 fails,
  `src/commands` 1 fail (present on clean main); repo-wide Biome: 21 errors
  all in untouched files; touched files lint-clean (1 pre-existing regex-format
  warning in `destructiveCommandWarning.ts`).
- Build green: `dist/cli.js` 29.07 MB, `MACRO.VERSION=2.1.337` (bumped to
  2.1.338 at release).
- e2e: `bash test/e2e/run.sh` (Docker) + tmux REPL acceptance — see round
  ledger comment on the issue.
