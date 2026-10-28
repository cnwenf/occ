# Triage — N-A + STAGED items (official claude-code 2.1.312, OCC-136 round)

Companion to `triage-port.md`. Same evidence conventions (byte offsets in the v311/v312 ELFs,
md5s in `README.md`). "N-A" = not applicable to OCC (surface absent / stubbed / official-cloud);
"STAGED" = applicable in principle but deliberately not ported this round, with a revisit trigger.

## STAGED (1 item + 1 sub-part)

### Item 18 — shorter system prompt for unrecognized Bedrock/Vertex/Foundry/Mantle model names — STAGED

> Changed Bedrock, Vertex, Foundry and Mantle to use the shorter system prompt for model names Claude Code doesn't recognize… set `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0` to keep the full prompt

- Contested per round discipline (Leader's 2026-10-29 order lists it among the STAGED contested
  items, alongside `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS` from the earlier backlog).
  The change flips the DEFAULT prompt shape for every unrecognized provider model name — a broad
  behavioral change to the system-prompt leg that needs its own dedicated round (prompt-diff
  forensics on the `simple` vs full prompt builder + OCC's provider-name recognition table), not a
  patrol-round side port.
- Revisit trigger: a round where prompt-builder forensics are in scope, or an OCC user report of
  broken custom deployment names / inference-profile ARNs on Bedrock/Vertex.

### Item 4 sub-part — `tengu_velvet_possum` top-level CLAUDE.md cut — STAGED

- Official @257559298: top-level CLAUDE.md head-cut behind gate `tengu_velvet_possum`, default
  **false** upstream; companion telemetry `announced_file_cut`.
- The ported main part of item 4 (nested memory/@-include cut, gate `tengu_quizzical_mango`,
  default **true**) is live — see `triage-port.md` item 4. The velvet_possum sub-part ships behind
  a default-off experiment upstream; porting it would activate a contested surface OCC doesn't have.
- Revisit trigger: gate flips default-true upstream (watch `tengu_velvet_possum` in later ELFs), or
  the `announced_file_cut` telemetry becomes part of a pinned flow OCC adopts.

## N-A — unbracketed items (13)

| # | Item (abridged) | Rationale |
|---|---|---|
| 1 | `oidc.user_id_claim` for the Claude apps gateway | Anthropic-backend gateway feature (identify users by an id_token claim other than `sub`). OCC ships no Claude-apps gateway leg — auth is API-key/OAuth passthrough. No OCC surface. |
| 3 | Managed settings/org policy not fetched after signing in from the VS Code extension | VS Code extension ↔ CLI sign-in handshake. OCC has no VSCode extension; managed-settings fetch is session-start only. No OCC surface. |
| 6 | Rare first-reply-after-resume missing on next resume | **Unpinnable + no reproducible surface.** No new/removed string isolates the delta (transcript-persistence timing fix); string-diff method is structurally blind to it. OCC's resume writes the full transcript through the same persistence path on every turn (no separate first-reply leg found). Honest position: "no verifiable bytes", not "verified absent" — same standard as items 10/11 below. |
| 7 | Invalid command name stopping all commands from loading | Official delta fully pinned (listing-loop typeof guard `x$t` @~249377300, new-in-312 `Command not listed`), but OCC has no listing-time display-name derivation loop: names are filesystem-derived strings, frontmatter names validated/coerced at parse time (`nameSafety.ts`), and every loader already try/catch-skips per entry — one bad command cannot stop the others. Porting `x$t` verbatim would require inventing a loop OCC doesn't have. Optional LOW hardening noted (defensive `typeof` filter in `getCommands`) — not official-alignment, not done this round. |
| 10 | `/model` `/effort` cache-warning timing | **Official delta not isolated.** Every literal changelog phrase absent from both binaries; the only `formatCacheWarningText` (@262387321/@262830963) is byte-identical 311→312 and scoped to `/reload-plugins`. Likely a non-string logic tweak the string-diff cannot see. OCC side conclusive: no cache-warning surface on `/model` or `/effort` at all (grep zero hits). Nothing to attach a fix to; porting would mean inventing strings. |
| 11 | Sessions falsely showing "waiting on you" | **Official delta not isolated.** The plausible locus (LLM tail-classifier prompt @283793300) is byte-identical 311→312 (difflib over 14 KB windows: 0 non-equal opcodes); `mid-sentence` absent from both. OCC side conclusive: OCC implements no text-derived waiting classifier — statuses are structured booleans (`awaitingApproval`, `awaitingPlanApproval`), so the mid-sentence false positive is structurally impossible. |
| 12 | Agent view restoring input text after Ctrl+C before exit | Official standalone agent view absent in OCC — OCC's FleetView is an inline panel with no persisted draft-restore-across-launch leg. No OCC surface. |
| 13 | Agent view reopening in shell mode after Ctrl+D from empty `!` | Same surface as 12 (agent view ↔ shell-mode handoff). No OCC surface. |
| 17 | WebFetch unresolved-host error mentioning allowed network domains (cloud sessions) | Cloud-sessions-gated message (network-domain allowlist is a cloud sandbox property). OCC's WebFetch runs locally with no domain allowlist; the "possibly outside the allowed network domains" explanation would be wrong there. |
| 19 | Refusal-fallback model switches covering unrecognized names | OCC never ported the automatic post-refusal model-switch subsystem (`CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` has zero setters; `fastRejection.ts` dormant — documented since the 2.1.28x rounds). Extending a surface OCC deliberately doesn't ship. |
| 21 | Cloud sessions started from CLI get names/branch names from the server | Cloud-sessions control plane. OCC has no cloud-session creation leg. |
| 24 | OTel `mcp_server.name` real name for marketplace-plugin fixed-URL servers | OCC's OpenTelemetry is a stub (analytics/OTel empty implementations — CLAUDE.md "Stubbed/Deleted Modules"); `mcp_server.name` attribute never emitted. Also depends on the official-Anthropic-marketplace plugin recognition OCC trims. |
| 25 | Stop sending `claude_code.safety_event` OTel event | Same as 24 — OTel stubbed; OCC never sent `claude_code.safety_event`. Removal is a no-op here. |

## N-A — bracketed surface-specific items (14)

All bracketed items target surfaces OCC does not ship; each is N-A by surface:

- **[VSCode] ×2** — bare-exit-code session end with Retry/Sign-in UI; usage-limit reset clock time +
  "5-hour limit" wording in the VSCode panel. (The CLI-side "5-hour limit" rename IS ported —
  item 20; the VSCode panel leg has no OCC counterpart.)
- **[Cloud sessions] ×6** — routine model-picker effort level; setup-script Bash editor; repository-add
  step table; failed-send double-run fix; env-creation error inside dialog; routine Edit dialog routing.
- **[Remote Control] ×1** — unarchived session showing working until reconnect.
- **[Claude Tag] ×4** — Slack retry notice naming the model; channel on/off + agent settings after
  private→public channel ID change; no-reply when environment network access = None; file posted in
  wrong thread.
- **[Code Review] ×1** — GitHub push-event delivered late → review current PR commit.

## N-A — env sweep (2 new, 1 removed)

- `CLAUDE_CODE_HOST_GUARDS_ARTIFACTS_MCP` (registry @239090454) — gates the artifacts-MCP host
  guard; surface absent (same family as item 17's cloud host).
- `CLAUDE_CODE_REMOTE_TOOLS_HOST_IDLE_RELEASE_MINUTES` (registry @239092149) — remote-tools host
  idle release; Remote Control host leg absent.
- `CLAUDE_CODE_MCP_HANDED_LISTINGS` (removed in v312) — was occ135-round STAGED, never ported →
  removal is a no-op for OCC.

## Honesty notes (method limits)

1. Items 6, 10, 11: the official code delta was **not isolated** — the string-diff method cannot
   see logic-only changes that add/remove no strings. For these the N-A verdict rests on the
   OCC-side conclusiveness (surface absent/structurally immune), recorded as "no verifiable
   bytes", NOT "verified absent upstream".
2. Item 7's N-A rests on OCC's loader structure being per-entry resilient; the MCP-prompt→Command
   construction path was not exhaustively audited for non-string names (it passes MCP protocol zod
   schemas) — hence the optional-hardening note rather than an absolute claim.
3. Bracketed-item verdicts are surface-level (no VSCode extension / cloud sessions / Remote Control
   / Claude Tag / Code Review app in OCC); no per-item binary diffing was done for them, matching
   the convention of every prior round ledger.
