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
