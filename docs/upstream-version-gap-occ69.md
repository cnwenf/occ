# Upstream Version Gap — OCC-69 (2.1.224 → 2.1.225 → 2.1.226)

**Round:** OCC-69, 2026-08-09
**OCC entering state:** `2.1.297` (npm `@cnwenf/occ` latest; fully aligned through official **2.1.224** per OCC-65, PR #269)
**Official targets this round:** `2.1.225` (published 2026-08-07) and `2.1.226` (published 2026-08-08).

Method per `aligning-with-official-binary`: `npm pack @anthropic-ai/claude-code-linux-x64@{2.1.224,2.1.225,2.1.226}`, full `strings` dumps + extracted embedded-JS chunks (`awk 'length>500'`), sorted set-diffs (`comm`), clean-boundary surface extraction, targeted `grep -oaE` / `grep -oaF`. Every surface claim below is binary-verified.

**Verified three ways (npm + GitHub + fresh ELF download):**
| | ELF bytes | JS payload bytes | JS chunks | build stamp |
|---|---|---|---|---|
| 2.1.224 | 295,676,936 | 26,044,929 | 2,940 | — (aligned in OCC-65) |
| 2.1.225 | 297,831,432 (+2,154,496) | 26,345,516 (+300,587) | 2,958 (+18) | 2026-08-07T19:37:58Z |
| 2.1.226 | 297,831,432 (= 225) | 26,345,517 (+1) | 2,958 (=) | 2026-08-08T00:42:40Z |

---

## 1. 2.1.226 — VERIFIED NO-OP (no portable surface)

Changelog is only *"Bug fixes and reliability improvements"*. Binary surface diff 225↔226:

- **Slash-command surface: IDENTICAL.** 117 `type:"(local-jsx|local|prompt)",name:"…"` entries in both; `diff` empty.
- **`CLAUDE_CODE_*` env-var surface: IDENTICAL.** 443 clean-boundary names in both; `diff` empty. (The naive string diff shows spurious `…IDI/…P/…0` deltas — those are trailing string-table bytes that shift on rebuild, not real names.)
- **`ANTHROPIC_*` env-var surface: IDENTICAL.** 61 clean-boundary names in both; `diff` empty.
- **Embedded JS payload: +1 byte** vs 225 (26,345,517 vs 26,345,516), same chunk count. The scattered full-line diffs are minified-identifier renumbering artifacts, not new features.
- Genuinely-new message strings are a handful of internal/deprecation notices (`MCP lazy dial timed out connecting`, `The 'parsed' property on 'text' blocks is deprecated, please use 'parsed_output' instead`, `Schema is missing a method literal`, `Unknown system error`) — none map to an OCC surface (`grep` of `src/` returns no lazy-dial / `parsed_output` hits; the "Push when Claude decides" hit is an unrelated OCC settings label).

**Verdict: 2.1.226 introduces no portable surface. No action.** (Same class as the 2.1.220 no-op rounds.)

## 2. 2.1.225 — triage (no cleanly-portable item for OCC)

2.1.225 is a substantive release (~14 changelog entries). Full triage against both the 2.1.225 ELF and the OCC source:

| # | 2.1.225 item | Verdict | Rationale (binary + OCC source) |
|---|---|---|---|
| 1 | Gateway spend-limit usage warning (names cap, reset time, operator message; "requires the gateway on 2.1.225") | **N/A** | Gateway-team billing surface. Strings `spend limit`/`spend_limit`/`operator` present in the ELF, but OCC does not bundle the Anthropic gateway this warning rides on; OCC's `rateLimitMessages`/`withRetry` are the API-rate-limit path, a different subsystem. |
| 2 | Workspace trust prompt added to `claude agents` for untrusted directories | **N/A (surface mismatch)** | The official `agents` CLI command in the ELF is `description:"(removed) Ask Claude to create/manage subagents, or edit .claude/agents/"` — a subagent-management surface. OCC's `occ agents` (`src/cli/handlers/agents.ts`) is OCC's **self-built daemon background-sessions dashboard** (CLAUDE.md "daemon supervisor subcommands"), not a mirror of that official command; the official change does not map onto it. The interactive REPL already enforces the TrustDialog via `showSetupScreens` (`src/interactiveHelpers.tsx`). |
| 3 | Fix transient 401 replacing a long-lived `CLAUDE_CODE_OAUTH_TOKEN` with a stored login's short-lived token (breaks headless until restart) | **Staged** | Auth-critical token-refresh precedence race. OCC reads `CLAUDE_CODE_OAUTH_TOKEN` (`src/utils/auth.ts` `getAuthTokenSource`), but localizing the official fix site and porting it byte-faithfully requires a dedicated decompilation round of the refresh/precedence path — not guessed per `aligning-with-official-binary` (auth bugs risk breaking users' sessions). |
| 4 | Fix MCP OAuth servers on macOS intermittently failing with a burst of 401s after a keychain read timed out | **N/A** | macOS-keychain-specific. OCC's MCP OAuth is simplified and has no macOS keychain-read path. |
| 5 | Fix auto mode counting a safety-filter refusal of its own permission check toward the consecutive-block limit | **N/A (surface absent)** | Targets auto-mode's consecutive-block-limit mechanism. OCC has auto-mode denials (`src/utils/autoModeDenials.ts`, `autoModeState.ts`) but **no consecutive-block-limit counter** (grep of `src/` for consecutive/repeated-block/`move on` in the auto-mode path returns nothing) — the mechanism the fix adjusts does not exist in OCC. |
| 6 | Fix cross-session messages staying parked without notice/expiry in headless + startup | **N/A** | Cross-session `SendMessage` is `KAIROS`-flagged, dormant in the OCC build (re-enabling hangs — documented). |
| 7 | Fix conversation history breaking on Remote Control resume after very large compactions | **N/A** | Remote Control subsystem trimmed/dormant in OCC. |
| 8 | Fix hovering over a session in another project changing the next agent's start directory | **N/A (surface absent)** | OCC's `occ agents` dashboard is non-interactive plain `console.log` table output (`renderSessionTable`) — no TUI hover. |
| 9 | Fix `claude self-hosted-runner` registering then failing every session when `--base-dir` can't be created; now exits at startup with a clear error | **N/A** | `self-hosted-runner` subsystem not in OCC (staged since the 2.1.224 triage). |
| 10 | Fix web sessions misreported as stuck, re-sending a growing event backlog on reconnect | **N/A** | Web-session transport subsystem not in OCC. |
| 11 | Improved Remote Control: photos from the Claude app shown to Claude directly | **N/A** | Remote Control subsystem. |
| 12 | [VSCode] Focus view folding fixes | **N/A** | OCC ships no VS Code extension. |
| 13 | `SendMessage` can start a conversation with Remote Control sessions by name | **N/A** | Cross-session SendMessage + Remote Control, dormant. |
| 14 | `SendMessage`: confirmed Remote Control recipient never swapped for same-named local session | **N/A** | Cross-session SendMessage + Remote Control, dormant. |

**Summary: 0 landed, 1 staged (#3, auth-critical refresh race), 13 N/A.** No cleanly-portable, binary-verified item this round.

## 3. Consequence — self-acceptance round (per issue "版本追齐后的自验收")

With no portable gap to land, this round is a strict self-acceptance pass on the current `main` (`e9a7ed7`, OCC 2.1.297), run like a human user on a real API key:

- **Build green:** `bun run build` → `dist/cli.js` 30,274,133 bytes, injected `MACRO.VERSION=2.1.297`, `BINARY_NAME=occ`.
- **Version:** `occ --version` → `OCC 2.1.297`.
- **Headless `-p` (live model):** `echo "…PONG" | occ -p` → `PONG`, exit 0.
- **REPL (tmux, real model endpoint):** boots with the Signal Chevron logo + `OCC v2.1.297 · Open C Code` header; model round-trip (`REPLPONG`); `/status` renders (Version 2.1.297, model, base URL, `MCP servers: 3 connected`); real Read-tool use (returned `2.1.297` from `package.json`); clean `/exit`.
- **Core alignment e2e:** `occ-versioning` + `commands-alignment` → **6 pass / 0 fail / 12 expect()**.
- **Recent version e2e:** the seven `version-2.1.219-*` + `resume-interrupted-turn-221` suites → **50 pass / 0 fail / 182 expect()**.

(The `repl-interactive` "auto-mode opt-in dialog" tmux e2e remains a known pre-existing environment failure — identical WITH and WITHOUT this round's (zero) code changes, PTY-sandbox/timing; recorded since OCC-44. Not a regression.)

## 4. Tracked-upstream pointer

OCC remains **fully aligned through official 2.1.224**. **2.1.225 and 2.1.226 introduce no portable surface to land** — 2.1.225's items are all N/A (platform-specific, trimmed/dormant subsystems, or absent OCC surfaces) except one staged auth-critical item (#3, deferred for a dedicated decompilation round, not guessed), and 2.1.226 is a verified no-op reliability release. **No new OCC release is cut this round** (no code change — consistent with the OCC-40/41/42 no-op discipline of not polluting `/releases` without a landed change).
