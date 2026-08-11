# Upstream Version Gap — OCC-88 (2.1.227 promoted to `latest`; changelog reconciled, zero portable items)

**Round:** OCC-88, 2026-08-12
**OCC entering state:** `2.1.298` (npm `@cnwenf/occ` latest; fully aligned through official **2.1.224** per OCC-65/OCC-69; 2.1.225/2.1.226 verified no-op; 2.1.227 triaged & staged while still `next`-only in OCC-85, with three portable candidates staged: `bashCommandClamp` (priority), fleet-nudge widget (C2), goal proposal).
**Official target this round:** re-verify latest + reconcile the now-published 2.1.227 changelog against OCC's surface.

## 1. Official latest — three-way verification (promotion round)

| Source | Result |
|---|---|
| npm registry | `latest` = **2.1.227** (promoted — was 2.1.226 during OCC-85), `next` = 2.1.227, `stable` = 2.1.220 |
| GitHub | release/tag `v2.1.227` published **2026-08-10T22:56:53Z** (~26 h before this round); official `CHANGELOG.md` on `main` now carries the 2.1.227 entry (it was missing during OCC-85's triage) |
| Fresh ELFs | 2.1.227 linux-x64: 304,282,632 bytes — same artifact as the OCC-85 triage; string sets re-verified unchanged (`/tmp/s226.txt` 226 markers vs `/tmp/s227.txt` 227 markers, diff sets intact) |

So the OCC-85 triage (done when 2.1.227 was a 4-hour-old `next`-only release without a changelog) now converts into a **published-changelog reconciliation**: every changelog item gets a per-item verdict against OCC's surface below. No new official release exists beyond 2.1.227 (`next` == `latest` == 2.1.227).

## 2. Published 2.1.227 changelog — five items, reconciled against OCC

Official entry (verbatim from `CHANGELOG.md` on `main`):

1. *"Fixed feature flags being evaluated without the user's subscription tier when a session started with an expired login token, which could wrongly prompt Max plan users to enable usage credits for Fable"*
2. *"Fixed every Bash command failing under `claude-code-action` with `allowed_non_write_users` on GitHub-hosted runners"*
3. *"Fixed `/tui` bringing back a conversation that had been rewound to before its first message"*
4. *"Improved slash-command menu: blue now marks only the selected row, matched characters are bolded instead of recolored, and emoji or accented names keep their glyphs"*
5. *"Improved performance: fewer event-loop stalls on file-not-found suggestions and at-mention size checks"*

Per-item verdicts:

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Feature flags vs subscription tier on expired login token | **N/A** | Subscription-tier / plan-prompt logic is hosted Anthropic auth stack (login-token expiry + Max-plan upsell), which OCC trims by design. OCC's API-billing path has no subscription-tier evaluation to mis-fire. |
| 2 | Bash failing under `claude-code-action` + `allowed_non_write_users` | **N/A** | GitHub-hosted-runner fix inside the `claude-code-action` environment. OCC's subprocess-env surface (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, `src/utils/subprocessEnv.ts:103`) is a distinct mechanism; the failing path never exists outside that Action's runner setup. |
| 3 | `/tui` reviving a rewound-to-empty conversation | **N/A by construction** | OCC's `/tui` (`src/commands/tui/tui.ts`) is settings-only: it saves the `tui` setting and applies it on next session start — no live renderer hot-swap, no conversation reload. The buggy "bring back a rewound conversation" path structurally does not exist in OCC (verified by reading the command source). |
| 4 | Slash-command menu visuals | **Cosmetic — queued** | Palette-styling polish (selected-row blue, bold matched chars, glyph preservation). No functional gap. A token-level check of the official render site + OCC menu styling comparison is queued for the next round; not ported this round per no-op discipline (a styling port without recovering the exact render rules would violate the never-invent rule). |
| 5 | Perf — fewer event-loop stalls (file-not-found suggestions, at-mention size checks) | **Perf — staged** | No functional surface change; no related stall exhibited in this round's walkthrough (§4). Porting requires recovering the actual mechanism from the binary first — staged as a low-priority perf candidate, never guessed. |

**Round verdict: zero portable behavior changes for OCC out of the now-promoted 2.1.227** — items 1–3 are N/A (hosted stack / Action runner / structurally absent), items 4–5 are cosmetic/perf queued with explicit next-round steps.

## 3. Staged candidates — status updates

- **`bashCommandClamp` (2.1.227, OCC-85 §2.3, priority) — substrate blocker re-verified in source.** OCC's Workflow `agent()` opts (`AgentOpts`, `src/tools/WorkflowTool/primitives.ts:69-76`) are exactly `label/phase/schema/model/effort/isolation`; `grep -r` for `bashCommandClamp` / `toolAliases` / `disallowedTools` across `src/` returns zero hits. All three of the clamp's fail-closed guards (toolAlias-remap refusal, no-Bash-in-resolved-pool refusal, permission-check-crash denial) bind to surfaces OCC's trimmed workflow engine does not expose. A faithful port is still not achievable without inventing the missing tool-pool/alias machinery — forbidden by the alignment skill. Stays staged; a dedicated round must first decide whether the tool-pool/`disallowedTools` surface itself is ported or trimmed.
- **Fleet-nudge widget (C2, OCC-78/OCC-85 §3)** — full anatomy recovered (poller + badge + dim `← for agents` hint + timing constants); the advertised affordance (`leftArrowOpensAgents`) already exists in OCC's FleetView. Staged, dedicated porting round.
- **Goal proposal dialog (OCC-85 §2.4)** — new interactive surface atop the existing `/goal` Stop-hook mechanism; gating/transport unrecovered. Staged, dedicated round.
- **2.1.227 hosted stack** (OCC-85 §2.1/§2.5: artifact-comment pipeline, memory API, device bash/dir-sync/trusted-device, codename experiments) — N/A unchanged.

## 4. Strict self-acceptance (current `main` @ e6477c7, run like a human user)

This round has **zero `src/` diff** (docs only), so every outcome below is, by construction, the pre-existing state of the aligned build — recorded per the round's "record any inconsistency as a gap" mandate.

### 4.1 Build & version

- `bun run build` green — `dist/cli.js` **28.87 MB**; `occ --version` → `OCC 2.1.298` (matches `package.json` / npm `@cnwenf/occ` latest).

### 4.2 Headless parity probe

- `echo "reply PONG only" | occ -p` → `PONG`, exit 0 — headless path end-to-end through the gateway.

### 4.3 Unit suite

`bun test src` — **1848 pass / 0 fail / 4375 expect() / 199 files**.

### 4.4 Interactive REPL acceptance (like a human user, tmux, fresh HOME, scrubbed env)

- **Onboarding:** welcome box "Welcome to OCC v2.1.298" with Signal Chevron mark → theme selection (Dark mode) → security notes → workspace trust dialog with official wording ("Accessing workspace: … 1. Yes, I trust this folder / 2. No, exit"). All steps advanced cleanly.
- **Prompt surface:** input renders with `● high · /effort` status chip and mode footer `⏸ manual on (shift+tab to cycle)`; marketplace-install note in the status bar.
- **Interactive model round-trip:** asked the model to read a seeded `seed.txt` and reply with only its content → tool line `Searched for 1 pattern, read 1 file (ctrl+o to expand)` followed by exactly `seed-content-occ88` — Read tool executed, model followed the constraint.
- **`/status`:** renders the Status / Config / Usage tabs — Version 2.1.298, Session name/ID, cwd, auth token, base URL, model.
- **`/tui` (bare):** `Current renderer: default. Usage: /tui <default|fullscreen>` — official wording.
- **`/exit`:** clean shutdown — process exit code **0**, empty stderr.

### 4.5 Gap candidates

None new this round. The OCC-85 §4.5 list (auto-mode opt-in dialog carried from OCC-44; footer mode-part vs `? for shortcuts` binary check; NO_COLOR pty-capture test fix; test-hygiene cluster) carries over unchanged — none is an OCC-vs-official product regression.

## 5. Consequence — tracked-upstream pointer & release discipline

- Tracked-upstream pointer: **fully aligned through official 2.1.224**; **2.1.225/2.1.226 remain no-op**; **2.1.227 now promoted to `latest` — published changelog reconciled, zero portable items this round** (§2); `bashCommandClamp` (substrate-blocked), fleet-nudge (C2), goal proposal remain staged with recovered anatomy (§3); slash-menu cosmetic check + perf-stall mechanism queued for next round.
- This round lands **docs only** (zero `src/` behavior change) → **no new OCC release** (OCC-40/41/42/69/78/85 no-op discipline — `/releases` is not polluted without a landed behavior change).
- Security review: the diff is this ledger only — no secrets, no new runtime surface, no backdoor vector.

**Summary: official 2.1.227 promoted `next`→`latest` (GitHub release v2.1.227, changelog published) → all five changelog items reconciled against OCC: 3 N/A (hosted subscription-tier auth, `claude-code-action` runner fix, `/tui` rewind revival structurally absent from OCC's settings-only `/tui`), 1 cosmetic queued (slash-menu styling), 1 perf staged (event-loop stalls); staged candidates re-verified (`bashCommandClamp` substrate blocker confirmed at `primitives.ts:69-76`, zero `toolAliases`/`disallowedTools` in `src/`). Strict self-acceptance green: build 28.87 MB, `--version` 2.1.298, `-p` PONG probe, `bun test src` 1848/0, full interactive REPL walkthrough (onboarding → trust dialog → tool round-trip → `/status` → `/tui` → `/exit` exit 0). Docs-only round → no release.**
