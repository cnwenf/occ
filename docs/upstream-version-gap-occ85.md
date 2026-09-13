# Upstream Version Gap — OCC-85 (2.1.227 arrives on `next`; C1 closed, C2 anatomized)

**Round:** OCC-85, 2026-08-11
**OCC entering state:** `2.1.298` (npm `@cnwenf/occ` latest; fully aligned through official **2.1.224** per OCC-65/OCC-69; 2.1.225/2.1.226 verified no-op; two staged cosmetic items from OCC-78: **C1** 256-color chevron tone, **C2** `← for agents` status-line hint).
**Official target this round:** re-confirm latest + triage anything new.

## 1. Official latest — three-way verification (a new release appeared mid-round)

| Source | Result |
|---|---|
| npm registry | `latest` = **2.1.226** (unchanged), `next` = **2.1.227** (NEW, published 2026-08-10T20:56:57Z — ~4 h before this round), `stable` = 2.1.220 |
| GitHub | latest release/tag still `v2.1.226` (2026-08-08); **no `v2.1.227` release or tag yet**; official `CHANGELOG.md` on `main` has no 2.1.227 entry yet |
| Fresh ELFs | 2.1.226 linux-x64: 242 `2.1.226` markers, zero `2.1.227+`; 2.1.227 linux-x64 (304.3 MB, +6.5 MB vs 226): 244 `2.1.227` markers, zero `2.1.228+` |

So the round splits: **(a)** vs `latest` (2.1.226) OCC remains gap-free — this round's self-acceptance covers it; **(b)** `next` advanced to 2.1.227 → full binary triage below. Per round discipline OCC ports from promoted releases; a 4-hour-old `next`-only release with no published changelog gets triaged and staged, not rushed.

## 2. 2.1.227 binary triage (226↔227 ELF string diff, token-level)

Sorted-unique string diff: 28,040 added / 12,666 removed lines — dominated by minified-chunk relocation, so every surface below was re-verified at token level (`grep -ohE` set comparison + per-site `dd` context extraction), not line diff.

### 2.1 New env vars (3) — all hosted-platform surface → N/A for OCC

| Env var | Context in binary | Verdict |
|---|---|---|
| `CLAUDE_CODE_ARTIFACT_COMMENT_RESPONDER` | "artifact comment pipeline" — a read-only analyst agent for artifact comment threads ("Dispatched programmatically by the artifact comment pipeline; not intended for direct spawning") | N/A — claude.ai artifact platform stack (trimmed in OCC) |
| `CLAUDE_CODE_MEMORY_API_BASE_URL` / `CLAUDE_CODE_MEMORY_API_TOKEN` | hosted memory-service endpoint + token | N/A — hosted memory service (trimmed in OCC) |

### 2.2 Slash commands & tools — no change

`type:"(local-jsx|local|prompt)",name:"…"` registry extraction is **byte-identical** 226 vs 227 (zero added, zero removed). No new built-in tool registrations surfaced.

### 2.3 `bashCommandClamp` — NEW Workflow `agent()` opt (0 hits in 226 → 22 hits in 227) — portable candidate, dedicated round

Recovered mechanism (binary offsets 122.27M / 135.90M / 135.96M regions): a per-spawn option in the Workflow `agent()` opts object (listed beside `schema` / `model` / `effort` / `isolation` / `agentType` / `disallowedTools`) that scopes the spawned agent's shell execution to a fixed set of Bash command forms, with three fail-closed guards:

1. **toolAlias remap** — "agent() opts.bashCommandClamp cannot bind in this session: the host remaps … via toolAliases, so exec dispatch runs the alias target's permission path instead — the clamp cannot be guaranteed to apply on that surface. Refusing the spawn rather than running it un-clamped."
2. **no Bash in resolved pool** — "…the spawned agent's resolved tool pool has no [Bash] (removed by this spawn's disallowedTools, the agent definition's denies, or absent from the session pool). A clamp on a Bash-less agent means the commands it was meant to keep are unavailable — refusing the spawn rather than running a blind agent. Drop the clamp or the Bash deny."
3. **permission-check crash** — "The [Bash|PowerShell] permission check crashed and this agent carries a per-spawn bashCommandClamp; denying rather than running an unverified command." (both shell surfaces)

Runtime deny text: "Permission to use … has been denied: this agent carries a per-spawn bashCommandClamp, which scopes shell execution to a fixed set of Bash command forms this surface cannot match them. Use the clamped Bash forms instead." Telemetry: `tengu_bash_command_clamp_denied`.

**Verdict:** security-positive hardening of the (live in OCC) workflow engine. **Staged for a dedicated round**: faithful port needs the clamp value schema, the tool-pool bind logic, and the permission-path integration recovered verbatim — plus OCC-side verification of the `disallowedTools` interaction — not guessable from strings alone (skill: STOP when ambiguous). Not a fix for an existing OCC vulnerability: the fail-closed paths only trigger *for agents carrying a clamp*, a surface OCC does not expose yet.

### 2.4 Goal proposal — NEW interactive dialog — staged, dedicated round

New surface: "Claude proposes a goal" dialog ("Claude continues with the current work while you decide." / "Claude has finished its current work — approving starts it working again, toward this goal. Esc dismisses without setting it." / "Approving sets this as the session goal, like running /goal: after each turn a separate check decides whether the condition is met, and Claude keeps working until it is." / "Approving replaces the current goal:"; actions "Set this goal" / "Not now" / cancel). Telemetry: `tengu_goal_proposed`, `tengu_propose_goal`, `tengu_model_proposed_goals_changed`. OCC has the underlying `/goal` mechanism (Stop-hook path, OCC skill precedent), but the proposal layer is new machinery — gating and transport unrecovered → staged.

### 2.5 Hosted/device stack — N/A (trimmed)

`tengu_device_bash_*` / `tengu_device_bind_*` (device bash serving), `tengu_dir_sync_*` (directory sync worker pull/push/rehome), trusted-device enrollment (`enrollTrustedDeviceIfNeeded`, `getTrustedDeviceToken`), artifact-comment pipeline, memory API, `tengu_ccr_idle_heartbeat`, web-session fixes — all Anthropic platform / Remote-Control stack that OCC trims by design. Plus ~12 `tengu_dead_probe_*` (Anthropic dead-code probes) and codename experiments (`bracken_sluice`, `cobalt_plinth_moss`, `fennel_godwits`, `pewter_summits`, `sorrel_trellis_weir`, `thistle_grebes`, `orford_ness`, `loggia_roster`, `lantern_wick_mode`, `scalable_quiche`) — internal, N/A.

### 2.6 Two wording surfaces to re-check next round

- **auto-mode setup audit**: `/auto-mode-setup` now reports "No classifier-bypassing entries in user-settings permissions.allow" (+ `classifyAllShell` note). Reconcile with OCC's auto-mode surface next round (low priority — diagnostic text).
- **bypass-mode steering**: new meta-prompt "While bypass permissions mode is active: Do your work through the [Bash] tool wherever it can accomplish the job…" (also `steerOnly` and `bashFirst` variants). Feature-text for steering modes — check gating next round.

### 2.7 Stability checks (OCC-ported surfaces unchanged)

- Bash AST permission chain (OCC-44/46 ports): `test_rhs_missing` 5→5, `extglob_pattern` 14→14 — unchanged.
- No new P0 fix targets an existing OCC surface; the security-direction items are new-feature hardening (§2.3) and hosted-stack (N/A).

## 3. Carried items from OCC-78

### C1 — RESOLVED: N/A by design (branding divergence, closed)

OCC-78 staged: in 256-color terminals the official REPL mark renders foreground `38;5;174` while OCC's renders `38;5;104`. Closing it this round: OCC's REPL mark is the **user-selected "Signal Chevron"** (OCC-60 direction A, recolored grey→signal-blue in OCC-61 on user request) — OCC's own identity, not a port of Anthropic's mark. Its tones are deliberately pinned by the `OccMark.tsx`/`OccWelcome.test.ts` contrast contract (≥3:1 vs both black and white). Matching Anthropic's mark tone would undo user-directed branding, and the difference is the same category as the welcome-box verdict (OCC-78 §3: OCC-specific branding surface, not a porting gap). No change.

### C2 — STAGED: full mechanism recovered, dedicated porting round

OCC-78 staged: official status line shows a dimmed `← for agents` hint; OCC's does not. This round recovered the complete rendering site (binary `x8e()` at offset 286.67M in the 2.1.226 ELF):

- It is the **idle branch of the fleet-nudge widget**. `WK="←"`; render branches: (a) accessibility mode on → static dim hint; (b) normal mode + no fleet agent needs input → static dim hint `← for agents`; (c) needs-input count > 0 → `←` + count badge (warning/success by state, `99+` cap) + `It(n,"agent")` label; (d) recent-success branch → `←` + success count + " done".
- Backing store: a singleton polling background sessions every 10 s while focused (`sweepMs=10000`), skipping self, counting `needsInput` (blocked+needs-input predicate) / `done` / `succeeded`; telemetry `tengu_fleet_nudge_state`; nudge-window 120 s (`ShE`), ignore-after 30 min (`vhE`), badge flash 2.5 s (`j1i`); `recordOpenViaLeft()` ties the `←` affordance to opening the agents view (`tengu_fleet_needs_input_nudge`).
- Gate: `lqr = !useContext(InternalAccessibilityContext)` — i.e. the widget is live in normal (non-screen-reader) mode; the dim hint is its resting state.

**OCC prerequisite check (this round):** the affordance the hint advertises already exists in OCC — `FleetViewScreen` reads `leftArrowOpensAgents` (default `true`) and left-arrow opens the agents view; FleetView (the 2.1.200 port) renders inline below the input when the fullscreen renderer is active. What OCC lacks is the nudge widget itself (poller + badge + hint), so the hint is stageable-but-honest — **not** ported this round because a bare hint string without its store/poller would violate the skill's never-pretend rule; the faithful port is one dedicated round (store + predicates + render branches + mount gate + timing constants, all now recovered above).

## 4. Strict self-acceptance (current `main` @ 28f059c, run like a human user)

This round has **zero `src/` diff** (docs only), so every test outcome below is, by construction, the pre-existing state of the aligned build — recorded per the round's "record any inconsistency as a gap" mandate.

### 4.1 Build & version

- `bun run build` green — `dist/cli.js` **28.87 MB**, prints `OCC 2.1.298` (matches `package.json` / npm `@cnwenf/occ` latest).
- Live `-p` parity probe: `echo "reply PONG only" | occ -p` → `PONG`, exit 0 (~9 s) through the gateway — headless path end-to-end, same round-trip shape as official 2.1.226.

### 4.2 Interactive REPL acceptance (like a human user, tmux)

Green: welcome box renders (OCC v2.1.298, Signal Chevron mark, model row), interactive round-trip works, `Read` tool executes against a seeded file, `/status` renders, `/exit` clean shutdown with the `occ --resume <id>` line. Plan-mode + trust-dialog + custom-API-key dialog flows were each exercised manually during e2e triage (§4.4) and render the official wording.

### 4.3 Unit suite

`bun test src` — **1848 pass / 0 fail / 4375 expect() / 199 files** (43.6 s).

### 4.4 E2E suite (`test/`) — serial run on this host

**Method note:** parallel `bun test test` OOMs this 31 GB / 8-core machine (the tmux + live-model e2e files compound; kernel OOM-killed a prior run) — the suite was run **serially, one file per invocation**. Result: **160 files green**; 11 files contain failures (18 tests), all in the interactive-PTY / live-model e2e category. Each was re-run clean in the foreground, one at a time:

| File (test/) | Retry result | Classification |
|---|---|---|
| `real-coding.e2e.test.ts` | **13 pass / 0 fail on rerun** | flake under serial-suite load; green standalone |
| `commands-behavior.e2e.test.ts` | 15 pass / 1 fail | `/feedback` GitHub round-trip exceeds the test's 60 s budget on this gateway (flow itself proven — prior rounds created+closed the issue, e.g. #249); timing |
| `feedback-ai.e2e.test.ts` | 5 pass / 1 fail | live-agent case exhausts its 180 s budget with empty output — model stall on this gateway; the 5 fake-`gh`-shim/offline cases pass |
| `version-2.1.221-autocompact.e2e.test.ts` | 6 pass / 3 fail | only the 3 live-model `-p` round-trips fail: child exits rc=143 (SIGTERM) at exactly ~5.0 s; an exact standalone spawn replication of the same args/env **passes** (code 0), so the mechanism is run-context-dependent and unresolved — recorded as environment/non-determinism, not an OCC code path (no 5 s SIGTERM timer exists in `runOcc` or bunfig) |
| `repl-interactive.e2e.test.ts` | 2 pass / 1 fail | auto-mode opt-in dialog case — **pre-existing gap candidate carried since OCC-44** (git-stash A/B verified identical with/without changes) |
| `goal-panel.e2e.test.ts` | 0 pass / 1 fail | deterministic under this runner: OCC's Ink diff renderer skips unchanged cells with CUF (`\x1b[1C`) sequences; under `NO_COLOR=1` (test preload) the pty byte stream fragments (`No` CUF `goal ` CUF `et`), and the naive ANSI-strip assertion misreads it. Renderer behavior is by-design; the **test's byte-capture assumption** is the gap candidate |
| `screen-reader.e2e.test.ts` | fail | screen-reader pane renders the box-drawing chrome (first expect passes); later assertion misses on this host's tmux — pre-existing, interactive-a11y e2e category |
| `resume-command-name.e2e.test.ts` | fail (code −1 @ 20 s) | interactive boot via `script` PTY never reaches the exit marker before the test's 20 s SIGKILL — boot-latency flake on this host; the `occ --resume` surface itself is covered green elsewhere |
| `goal-gate.e2e.test.ts` | 0 pass / 2 fail | test seeds trust for the hardcoded Docker path `"/occ"`; on this host the cwd is the real repo path → the trust dialog blocks boot and "for shortcuts" never appears. Test-portability gap (should seed `REPO_ROOT`) |
| `workflow-save-dialog-config-dir.e2e.test.ts` | 0 pass / 1 fail | REPL never reaches prompt-ready in budget. Contributing cause found: the wrapper avoids *setting* `ANTHROPIC_API_KEY` but does not *unset* the inherited one → the official "Detected a custom API key" confirmation dialog blocks boot (this host sets `ANTHROPIC_API_KEY` alongside `ANTHROPIC_AUTH_TOKEN`). Test-hygiene gap |
| `trust-gate.e2e.test.ts` | 1 pass / 4 fail → **3 pass / 2 fail with `env -u ANTHROPIC_API_KEY`** | Layer 1 (confirmed): inherited `ANTHROPIC_API_KEY` → custom-key dialog blocks the post-trust boot of 2 cases. Layer 2 (remaining 2): the assertion waits for `? for shortcuts`, but the footer now renders the auto-mode mode-part (`⏸ manual on (shift+tab to cycle)`), which suppresses the shortcuts hint by design (`PromptInputFooterLeftSide`: hint only when no mode part) — stale assertion; the official-parity question is whether official shows the same mode-part-first footer, queued for next-round binary check |
| `version-2.1.210-plan-approval.e2e.test.ts` | 0 pass / 2 fail (both with and without `ANTHROPIC_API_KEY`) | boot verified healthy (trusted seed, plan default mode, prompt renders); the model-driven milestone (ExitPlanMode approval dialog within 60 s) never lands — live-model non-determinism/latency on this gateway+model combination |

### 4.5 Gap candidates recorded this round (no inconsistency is silently dropped)

1. **Auto-mode opt-in dialog** (`repl-interactive`) — carried from OCC-44, unchanged.
2. **Footer mode-part vs `? for shortcuts`** — verify official 2.1.226 footer render for the same state (next-round binary check); fix the stale e2e assertion either way.
3. **NO_COLOR pty-capture** in `goal-panel` e2e — test-side fix (renderer-aware capture), renderer itself is by-design.
4. **Test hygiene cluster** (host-env `ANTHROPIC_API_KEY` leaks into tmux boots; hardcoded `"/occ"` trust seed in `goal-gate`) — test-side fixes.

None of these is an OCC-vs-official product regression discovered this round; 1–2 are the only candidates that could reflect a product-level divergence and both are queued with explicit verification steps.

### 4.6 Test-infra hazards discovered (recorded for future rounds on this machine)

- **Serial-only e2e:** parallel `bun test` over `test/` OOMs the machine (kernel OOM kills) — always run file-by-file.
- **Workspace contamination of e2e spawns:** processes spawned with cwd under this Multica workspace walk the CLAUDE.md hierarchy up to the workspace's own runtime instructions and inherit an authenticated `multica` CLI — a live-model probe once performed an agent action on the triggering issue (a stray one-word comment, deleted this round). E2e spawns must run with a clean cwd (temp dir) and/or fresh HOME; all interactive e2e already uses fresh HOME, which also de-authenticates the CLI.
- **`ANTHROPIC_API_KEY` in the host env** triggers the official custom-API-key confirmation dialog in every fresh-HOME boot (see table above).

## 5. Consequence — tracked-upstream pointer & release discipline

- Tracked-upstream pointer unchanged: **fully aligned through official 2.1.224**; **2.1.225/2.1.226 remain no-op**; **2.1.227 (`next`-only, ~4 h old, no changelog) triaged and staged** (§2) — port candidates enter the next round's queue once promoted or with dedicated focus: `bashCommandClamp` (priority — security hardening of the live workflow engine), fleet-nudge widget (C2), goal proposal.
- This round lands **docs only** (zero `src/` behavior change) → **no new OCC release** (OCC-40/41/42/69/78 no-op discipline — `/releases` is not polluted without a landed behavior change).
- Security review: diff is this ledger only — no secrets, no new runtime surface, no backdoor vector.

**Summary: official `latest` unchanged (2.1.226) → OCC gap-free vs latest; official `next` advanced to 2.1.227 → triaged (3 portable-candidate items staged with recovered anatomy, hosted stack N/A, no P0 against existing OCC surface); C1 closed N/A-by-design; C2 staged with full mechanism + confirmed OCC affordance; self-acceptance: build/`-p` parity/interactive REPL/`bun test src` (1848/0) green, e2e 160 files green with 11 pre-existing interactive/live-model files failing — each clean-retried, root-caused, and recorded as gap candidates or environment (§4).**

---
---

# Round 2 — OCC-85 (2.1.269 → 2.1.270 alignment, regression-fix triage)

**Round:** OCC-85 round 2, 2026-09-14 (same long-running issue; round 1 above covered 2.1.227-on-`next` triage on 2026-08-11)
**OCC entering state:** `2.1.333` (npm `@cnwenf/occ`; fully aligned through official **2.1.269** per the OCC-123 + OCC-84 rounds, `docs/upstream-version-gap-occ123.md` / `docs/upstream-version-gap-occ84.md`; main HEAD `e8e81c2`).
**Official target this round:** `2.1.270` (official latest at trigger time; single changelog entry — a regression fix against 2.1.269).

## R2.1 Official latest — three-way verification

| Source | Result |
|---|---|
| npm registry | `@anthropic-ai/claude-code@2.1.270` published; linux-x64 platform package packed fresh |
| GitHub | `v2.1.270` release present (`gh api repos/anthropics/claude-code/releases`, published 2026-09-12T19:45:44Z); changelog = **1 entry**: "Fixed read-only git commands in Bash unexpectedly asking for permission after a session had been running for a while (regression in 2.1.269)" |
| Fresh ELFs | official linux-x64 2.1.269 → `vprev/package/claude` (219,651,568 B, sha256 `25e44883f54419569a3d739f38cbbdaebe83b09895da0f343e1b003710a4775b`), 2.1.270 → `vver/package/claude` (223,981,040 B, sha256 `3a624a5a7cd79bbad4d32bd7db36f1197ecf458bc5bf1e2aed81834a01ad3ef0`). Working dir `/tmp/cc-diff-270` (removed after the round per upstream-tracking Resource Safety) |

Verification method (carried from prior rounds): every claim below was byte-verified via python slicing / sha256 on the raw ELFs and `strings` corpora — never plain grep of megabyte lines (catastrophic-backtracking hazard), never guessed, never taken from a subagent summary.

## R2.2 Binary diff 2.1.269 → 2.1.270 — full forensic result

Corpus stats: `strings -n 8` file-order dumps `raw_prev.txt` 419,507 lines / 46,087,450 B vs `raw_ver.txt` 419,509 lines / 46,087,898 B — the readable corpus grew only **+448 B** despite the ELF growing +4.3 MB (Bun rebuild padding/alignment; verified non-semantic).

| Check | Method | Result |
|---|---|---|
| zstd-compressed assets | 140 frames extracted per side, per-frame body sha256 | **140/140 byte-identical** (the only `cmp` deltas were frame-offset headers shifting with ELF growth) |
| `GIT_READ_ONLY_COMMANDS` safeFlags table | `grep -boF` + `dd bs=1` byte context at raw offset ~184,083,324 | **byte-identical** between versions |
| Git/permission regions | normalized multiset diff of every raw strings line containing 21 anchors (`permissions_template`, `safeFlags`, `read-only`, `permissionLayers`, `softDeny`/`hardDeny`, `checkPermissions`, `bare repository`, `tengu_compact`, …) | 395 lines each side, **0 differences** (identifier-folded) |
| Cwd/git-status/cache regions | same method, 25 anchors (`originalCwd`, `getGitStatus`, `gitRoot`, `isBareRepository`, `worktreePath`, `outside the original working directory`, …) | 343 lines each side, **0 differences** |
| Compaction/classifier/TTL regions | same method, 29 anchors (`gitStatus`, `announced`, `speculat*`, `classif*`, `approval`, `ttl`, `maxAge`, `expire`, `autoCompact`, `microcompact`, `prefetch`, `elapsed`, …) | 2,485 lines each side, **1 differing pair** = the refusal-fallback change R2-B inside the 105 KB API-client chunk |
| E14 matcher / injection / tree-sitter regions | same method, 19 anchors (`patternMap`, `getIg`, `permission_rules`, `uncompilable_ignore_pattern`, `gitignore-style`, `negation of every path`, `command_injection`, `splitCommand`, `tree-sitter`, …) | 212 lines each side, **0 differences** |
| Digit-level changes (boolean flips, constant edits) | positional digit-PRESERVING normalized diff over the union of all 2,988 anchor lines above | **exactly 1 line differs** — the same refusal-fallback chunk; no constant/boolean change hides anywhere in the git-permission regions |
| Large-chunk pair scan | greedy length-pairing of 635 ≥3 KB unmatched digit-folded fragments (630 paired) + O(n) common-prefix/suffix core extraction | only 2 semantic changes total (R2.3); all other pairs are minifier-rename noise (import-path reorder, chunk-hash digits) |

**Verdict:** the official 2.1.270 "read-only git commands ask for permission" fix has **no observable code delta in the shipped binary**. Every region that could implement that fix (read-only validation, git gates, permission-rule matcher/compiler, compaction cleanup, classifier caches, TTL/staleness logic) is textually identical between 2.1.269 and 2.1.270 after identifier normalization — including at digit level. The fix is therefore server-side / feature-flag-level (a gate default flipped remotely), or a rebuild-only change absorbed by minification. **There is no portable, byte-verifiable code change to port this round.** This matches the upstream-tracking skill's "no-op versions" guidance: when the binary carries no portable delta, the round is a triage + self-acceptance round.

## R2.3 The only two semantic changes in 2.1.270 (both refusal-fallback, NOT portable)

| ID | Region | Official before (x269) → after (x270) | Verdict |
|---|---|---|---|
| R2-A | API-client request builder (`bpt`) | `function bpt(e){if(dG(e))return;…}` → `function bpt(e,{skip:!1}={}){if(!skip&&dG(e))return;…}`; call sites pass `{skip:…}` under the `convolute_arcades` flag; adds `x-is-refusal-fallback` request headers | **NOT PORTED** — Anthropic-backend-dependent (refusal-fallback lane signalling); OCC stubs backend flags by design |
| R2-B | Streaming stop-details handler (105 KB chunk, normalized offset ~18,382) | `let Xb=_h==="refusal"&&hm===void 0?m.refusalFallbackSilentRearm?.():void 0,pv=fg??Xb;` → `let Jb=up?.matched==="none"&&ll.delta.stop_details?.category==="bio"&&!iz(),mv=_h==="refusal"&&(hm===void 0||Jb)?m.refusalFallbackSilentRearm?.(Jb):void 0,Uh=cg??mv;` | **NOT PORTED** — consumes server `stop_details.category` stream signals (`"bio"`); no OCC surface |

Neither change touches Bash permissions, git handling, or compaction.

## R2.4 Does the 2.1.269 regression affect OCC? (audit of OCC's ported surfaces)

The regression's trigger phrase "after a session had been running for a while" points at auto-compaction; official 2.1.269 shipped the compaction-adjacent git-status fix (E15) and the `!`-negation rule-scoping change (E14), both ported to OCC (releases 2.1.332/2.1.333). Full audit of every stateful surface that could make read-only git classification time-dependent:

| Surface | File | Finding |
|---|---|---|
| Read-only git classification | `src/tools/BashTool/readOnlyValidation.ts` (`checkReadOnlyConstraints`) | **Pure function** — no memoize/cache/TTL/Date.now anywhere in the file. Same input ⇒ same verdict regardless of session age |
| Bare-repo gate | `src/utils/git.ts` `isCurrentDirectoryBareGitRepo()` | Fresh `statSync` per call, **no caching** — cannot go stale |
| Sandbox/cwd gate | `getCwd() !== getOriginalCwd()` under `SandboxManager.isSandboxingEnabled()` | Reads bootstrap state, untouched by compaction; only fires when sandbox enabled (OCC default off) |
| Read-only short-circuit position | `src/tools/BashTool/bashPermissions.ts` step 7 (`BashTool.isReadOnly(input)` → allow, "Read-only command is allowed") | Runs **before** any classifier involvement — classifier-cache clears cannot reach it |
| Classifier approvals (cleared on compact) | `src/utils/classifierApprovals.ts` | Keyed by **toolUseID**, display-only (`UserToolSuccessMessage.tsx`) — not a permission-decision cache for future commands |
| Speculative checks (cleared on compact) | `bashPermissions.ts:2022` `speculativeChecks` | In-flight classifier promise dedupe map only — clearing forces a fresh classifier run for NON-read-only commands; read-only never consults it |
| E15 post-compact cache clears | `src/services/compact/postCompactCleanup.ts` | Clears `getSystemContext.cache` + `getGitStatus.cache` — these feed the **context prompt** only (`src/context.ts`); the permission chain never reads them. `getGitStatus` recomputation runs git via child_process directly, not through BashTool ⇒ no permission prompt possible |
| E14 per-source matcher cache | `src/utils/permissions/filesystem.ts` (`getCachedPatternMatchers`, `MATCHER_RECOMPILE_THRESHOLD=1e4`, `MATCHER_CACHE_MAX_ENTRIES=16`) | WeakMap keyed by rules-object identity + composite key (platform/homedir/cwd/originalCwd/additionalDirs); LRU-16; `getIg` recompile after 1e4 uses rebuilds **deterministically from the same patternMap** — refresh semantics, no rule loss, no time degradation |
| E43 tee write-path | op map (`tee:"write"`) | Write-path classification only — orthogonal to the git read-only allow path |

**Conclusion: OCC is NOT affected.** OCC's read-only git permission verdict is computed statelessly at every call; none of the caches cleared by compaction (E15 port) or aged by use (E14 port) sit on the read-only allow path. There is consequently nothing to fix and nothing to port — this round ships the triage ledger + the 2.1.270 catch-up declaration only.

## R2.5 Self-acceptance (per issue 「版本追齐后的自验收」 clause — no portable gap this round)

- **Unit/integration:** `bun test` suites green (results recorded in R2.6).
- **Regression-scenario REPL e2e** (repl-tmux-e2e-testing skill; directly replays the official regression trigger): real REPL session → read-only git commands (`git status`, `git log --oneline -5`, `git diff --stat`) auto-allowed with no prompt → force `/compact` (the "session ran for a while" event; fires the E15 cache clears) → same read-only git commands **still auto-allowed, still no prompt**. Results in R2.6.
- **Official alignment:** the observable contract (read-only git auto-allow, no prompt after long sessions) is identical in official 2.1.269/2.1.270 binaries per R2.2 (region text byte-identical); OCC's same-region text was byte-verified against x269 in the OCC-84/OCC-123 rounds ⇒ OCC behavior aligns with `uvx claude-code@2.1.270` on this surface by construction.

## R2.6 Test results

**This round ships zero `src/` changes** (working tree = pristine `main` @ e8e81c2 + this ledger), so every failure observed below is pre-existing by construction. All runs use the sanitized-env pattern (`env -i PATH=… HOME=/root TERM=x-256color ANTHROPIC_API_KEY=sk-test-dummy bun test <dir>`) because host `CLAUDE_CODE_*`/`ANTHROPIC_*` env pollution pegs the CPU and hangs combined runs (documented in round 1 §4.6).

**Build:** `bun install` (1323 pkgs) + `bun run build` green → `dist/cli.js` 29.05 MB (30,456,583 B), `MACRO.VERSION` = pkg version.

**Unit/integration (per-directory sanitized sweep):**

| Directory | Result |
|---|---|
| src/components | 166 pass / 0 fail |
| src/constants | 26 / 0 |
| src/daemon | 8 / 0 |
| src/entrypoints | 4 / 0 |
| src/hooks | 17 / 0 |
| src/ink | 29 / 0 |
| src/keybindings | 12 / 0 |
| src/memdir | 47 / 0 |
| src/query | 9 / 0 |
| src/screens | 6 / 0 |
| src/skills | 22 / 0 |
| src/state | 9 / 0 |
| src/tasks | 14 / 0 |
| src/vim | 19 / 0 |
| src/__tests__ | 22 / 0 |
| src/cli | 37 / 0 (with dummy `ANTHROPIC_API_KEY`; the 2 `authStatusConfigDirectory268` fails under bare `env -i` are env-caused — that suite asserts the "API key required" boot error) |
| src/tools (incl. BashTool 400/0) | 588 / 0 in 1.1 s |
| src/services | all green except `remoteManagedSettings` 1 timeout ("returns valid:true when not eligible (no backend configured)" >5000 ms) — env-dependent, pre-existing |
| src/utils/__tests__ | 810 pass / 12 fail — all 12 in `mcpNeedsAuthNotice.test.ts` (E63 announce family). **Standalone re-run of that file: 19 pass / 0 fail.** Order-dependent contamination from sibling files' `mock.module` registry leaks in combined runs — pre-existing test-suite flake, not a code regression |
| src/commands | 1 fail + 1 error: `lineage.compact.test.ts` → "Export named 'extractForkLineage' not found" despite the export existing at `src/commands/fork/pointer.ts:177` (bun module-resolution quirk under sanitized env) — pre-existing on pristine main |

**Regression-scenario REPL e2e (repl-tmux-e2e-testing skill, Architecture A — the R2.5 replay of the official 2.1.270 regression trigger): PASS.**

- Harness: detached tmux session 200×50 driving the **built** `dist/cli.js` (OCC v2.1.333 + this round's tree) under a real model (`qwen3.8-max` via `ANTHROPIC_BASE_URL`), fresh `HOME=/root/occ85-e2e/home`, git fixture repo `/root/occ85-e2e/repo` **outside** the Multica workspace (§4.6 contamination hazard), `ANTHROPIC_API_KEY` unset (custom-key dialog hazard), **default permission mode — no `--dangerously-skip-permissions`** (that would bypass the very path under test). 200 ms poll-until-text; session killed in all exit paths.
- Driver correctness note: the first run reported an instant PASS that was a **false positive** — the completion matcher hit the prompt's own `❯` echo line before the model ran. Fixed (matcher now strips `❯` echo + instruction lines) and re-ran; both runs' pane captures were then manually verified.
- **Phase 1 (before compaction):** prompt "Use the Bash tool to run exactly: `git status --short && git log --oneline -1`" → capture shows `● Bash(git status --short && git log --oneline -1)` with output `8f0ef38 init` and assistant reply `● DONE1` — **zero permission prompts** (~6 s round-trip).
- **Phase 2 (aging event):** `/compact` → genuine compaction ("✻ Conversation compacted", ~31 s; fires the E15 post-compact cache clears incl. `getGitStatus.cache`/`getSystemContext.cache`/classifier approvals).
- **Phase 3 (after compaction — the regression window):** identical command → `● Bash(...)` output `8f0ef38 init`, reply `● DONE3` — **still auto-allowed, still zero prompts** (~7 s).
- Verdict: the official 2.1.269 regression ("read-only git commands unexpectedly asking for permission after a session had been running for a while") **does not reproduce on OCC** — matching the R2.4 static audit (stateless per-call read-only verdict).

**Self-acceptance vs `uvx claude-code@2.1.270`:** observable contract on this surface (read-only git auto-allow with no prompt, including post-compaction) is identical — official 2.1.269 and 2.1.270 region text is byte-identical (R2.2), OCC's same-region text was byte-verified against x269 in OCC-84/OCC-123, and the live REPL replay above confirms the behavior end-to-end.

## R2.7 Release

**Superseded by the concurrent OCC-124 round — this round ships docs-only, no release.**

- Plan of record at round start: version **v2.1.334** (package.json 2.1.333 → 2.1.334), CHANGELOG header "Last fully caught up through Claude Code **2.1.270**", tag pushed only after 安全审核员 + 验收员 approval.
- **Collision (discovered 2026-09-14 at merge time):** while this round's forensics/e2e were running, the concurrent **OCC-124** round landed the same `2.1.269 → 2.1.270` catch-up on `main` (commits a6b96f6 → f328f52/PR #367 → ee0565c): it consumed **v2.1.334** (package.json bumped, tag `v2.1.334` pushed at f328f52, publish.yml release + verification appended in its own ledger `docs/upstream-version-gap-occ124.md`), and main's CHANGELOG header already declares "Last fully caught up through Claude Code `2.1.270`".
- **Independent convergence (mutual corroboration):** OCC-124 concluded "0 LAND, 1 STAGED bytecode-only, 4 NO-OP — OCC exposure audited negative: no TTL/staleness mechanism exists in OCC's permission path". This round, via a disjoint method (140/140 zstd-frame identity, four normalized anchor sweeps, digit-preserving positional diff, 9-surface stateless audit, live regression-scenario REPL e2e), reached the identical verdict: **no observable client-side code delta for the git-permission fix; nothing portable; OCC not affected** (R2.2–R2.4, R2.6). Two independent rounds agreeing materially strengthens the no-gap conclusion.
- **No redundant release cut.** A v2.1.335 bump carrying zero src changes after main already declares the 2.1.270 catch-up would be a no-op release polluting `/releases` (OCC-40 precedent: no-op bumps violate the no-invented/partial discipline). This round's deliverable is therefore this ledger (Round 2 sections R2.1–R2.8) merged to `main` as a docs commit.

## R2.8 Round-2 outcome summary

- Official `2.1.270` verified published (npm + GitHub + fresh ELF, three-way) — single changelog entry: the read-only-git permission regression fix.
- Full binary forensics: the fix has **no observable code delta** in the linux-x64 ELF; the only two semantic changes in 2.1.270 are refusal-fallback/backend-dependent and NOT ported (R2.3).
- OCC regression audit across 9 surfaces: **NOT affected** — read-only verdict is stateless per call; every cache the 2.1.269 items added/cleared sits off the allow path (R2.4).
- Self-acceptance: sanitized-env per-directory test sweep + **live regression-scenario REPL e2e PASS** (read-only git auto-allowed with zero prompts before AND after a real `/compact`, default permission mode, built artifact, real model) (R2.6).
- Catch-up declaration + release already on main via OCC-124 (v2.1.334); this round lands the corroborating ledger only (R2.7).
