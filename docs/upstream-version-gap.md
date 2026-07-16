# OCC vs. official Claude Code — version-gap report (2026-07-16)

> **CLOSED — resolved (2026-07-16).** OCC is now caught up to official Claude Code
> `2.1.211` (= official latest as of 2026-07-15). The 2.1.210→2.1.211 gap documented
> below was closed by OCC releases `2.1.269` (→2.1.210) and `2.1.270`/`2.1.271` (→2.1.211;
> re-published as `2.1.271` because the `2.1.270` npm tag had fallen behind `main`).
> See `docs/upstream-version-gap-occ7.md` (OCC-7) for the parity confirmation. The body
> below is retained for historical recon.

> Gap-research deliverable for OCC-5. Methodology: `upstream-tracking` + `aligning-with-official-binary` skills (no memory recital). Version truth from the npm registry (`@anthropic-ai/claude-code`) and the official Anthropic `CHANGELOG.md` on GitHub; feature truth binary-verified against the decompiled native ELF (`strings -n 8 | sort -u`, `comm -13`).

## 1. Version truth

| Item | Value | Source |
|------|-------|--------|
| OCC own release (latest) | `2.1.269` (2026-07-15) | `package.json`, `CHANGELOG.md` |
| OCC **actual** aligned Claude Code | **`2.1.210`** | `CHANGELOG.md` §2.1.269: "Catch up to Claude Code `2.1.210`"; 25 upstream-feature clusters ported, each binary-verified |
| OCC **documented** aligned Claude Code | `2.1.204` (STALE) | `README.md` badge + `CLAUDE.md` ("currently tracks … `2.1.204`") + `CHANGELOG.md` header baseline note |
| Official latest Claude Code | **`2.1.211`** (published 2026-07-15T19:24Z) | `npm view @anthropic-ai/claude-code version`; `npm view … time --json` |
| Official version timeline (recent) | 2.1.211→07-15, 2.1.210→07-14, 2.1.209→07-14, 2.1.208→07-13, 2.1.207→07-10, 2.1.206→07-09, 2.1.205→07-08, 2.1.204→07-08 | `npm view … time --json` |

### Two gaps found

1. **Doc drift (internal).** `README.md`, `README.zh-CN.md`, and `CLAUDE.md` still advertise the `2.1.204` baseline even though the 2.1.269 release already caught OCC up to **2.1.210**. The README badge (`Tracks-Claude%20Code%202.1.204`) and the `CLAUDE.md` line "It currently tracks Claude Code `2.1.204`" are behind the code. Low-effort fix; should be updated whenever the 2.1.211 port lands (bump the displayed track to 2.1.211).
2. **Feature gap (one upstream version).** OCC is at **2.1.210**; official latest is **2.1.211**. The gap to close is exactly the 2.1.211 wave. (`2.1.204→2.1.210` was already ported in OCC 2.1.269 — see that CHANGELOG entry; this file does **not** re-dump it.)

## 2. Methodology (skills used)

- `upstream-tracking` — per-version workflow: research → implement → e2e → accept → security → commit. Version selection rules (skip unpublished / no-op / VSCode-only).
- `aligning-with-official-binary` — do not trust the changelog alone; binary-verify each claimed-new identifier against the decompiled native ELF.
- Binary-diff procedure (run, then cleaned up): `npm pack @anthropic-ai/claude-code-linux-x64@2.1.210` + `@2.1.211` → extract → `strings -n 8 … | sort -u` → `comm -13 s210 s211` → grep for `CLAUDE_CODE_*` / flags / settings. (Heavy ~262MB-per-binary scratch left in `/tmp`; the hourly `/tmp` prune cron at :07/:37 reclaims it — `rm -rf` was blocked by the harness fact-forcing gate.)

### Binary verification of the 2.1.211 headline feature

Targeted counts (authoritative, not minified-string-boundary noise):

| Identifier | in 2.1.210 binary | in 2.1.211 binary | verdict |
|---|---|---|---|
| `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` | 0 | 3 | genuinely new in 2.1.211 ✓ |
| `--forward-subagent-text` (flag) | 0 | 4 | genuinely new ✓ |
| `FORWARD_SUBAGENT` | 0 | 3 | genuinely new ✓ |

New-string scan also surfaced the guard: `Error: --forward-subagent-text requires --print and --output-format=stream-json.` — i.e. the flag is only valid in print + stream-json mode.

OCC source cross-check: `grep -rn "FORWARD_SUBAGENT|forward-subagent-text|CLAUDE_CODE_FORWARD_SUBAGENT" src/` → **0 hits**. Confirms the 2.1.211 headline feature is not yet ported → real gap.

> Caveat on the broad `CLAUDE_CODE_*` strings diff: minified JS shifts string boundaries between versions, so a raw `comm -13` over `CLAUDE_CODE_*` produces many false-positive "new" env vars. The authoritative behavioral source is the official `CHANGELOG.md`; the binary diff's job is to *verify specific changelog claims*, which it does for the headline item above.

## 3. The 2.1.211 wave — behavioral diffs (gap to close)

Source: official `CHANGELOG.md` §2.1.211. Items grouped by **OCC porting disposition**. This is behavioral (what changes for the user / the model), not a line-by-line dump.

### 3.1 New feature — port required

| # | Change (behavioral) | OCC impact | Notes |
|---|---|---|---|
| 1 | **`--forward-subagent-text` flag + `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` env**: include subagent text + thinking in `stream-json` output. Guard: requires `--print` + `--output-format=stream-json`. | **Port.** OCC has subagents + pipe/stream-json mode. | Binary-verified new (table above). The only net-new *feature* in 2.1.211; everything else is fixes/hardening/tweaks. |

### 3.2 Fixes/hardening likely applicable to OCC (port candidate)

These touch subsystems OCC keeps live (subagents, permissions, Bedrock/Vertex, memory, vim, REPL, pipe mode). Each needs a per-item binary recon before porting (per `aligning-with-official-binary`); listed here as the work-list, not pre-verified.

- **Subagent model-override revert** — subagents spawned with an explicit model override reverted to the parent's model when resumed / sent a follow-up. (Agent tool; OCC has model override.)
- **Auto mode vs. PreToolUse hook `ask`** — auto mode was overriding a PreToolUse hook's `ask` decision for unsandboxed Bash; a hook `ask` now floors the decision at a prompt. (Permission model + hooks + auto mode — all live in OCC.)
- **Bedrock/Vertex spurious Opus fallback notice** — at startup, attempted the default Opus model and printed a spurious fallback notice when a model was explicitly configured. (OCC supports Bedrock/Vertex.)
- **Prompt-caching regression on Bedrock/Vertex/Mantle/Foundry** — the trailing system-context block was billed as fresh input tokens on every request. (OCC supports Bedrock/Vertex/Foundry; high-value cost fix.)
- **Parallel-session logout-on-wake** — many sessions sharing one credential store all logged out simultaneously after wake-from-sleep. (OCC has shared-credential paths.)
- **Nested `.claude/rules/*.md` exclusion** — nested `.claude/rules/*.md` loaded even when setting sources exclude project settings. (OCC has CLAUDE.md/rules loading.)
- **`?`-input swallow + shortcuts-panel toggle** — edits leaving the input as `?` were silently swallowed and toggled the shortcuts panel. (REPL input.)
- **300ms async-content reveal delay** — Settings tabs, Stats, diff views, other loading states had a 300ms delay revealing async content. (REPL render.)
- **Reopen just-stopped background session** — from the agents view, reopening a just-stopped background session started a blank conversation under the same session id. (Background agents — OCC keeps.)
- **Background agent result reporting** — Claude now reports the status of still-running agents and waits for real completion instead of fabricating results. (Background agents.)
- **Background agents killed by user auto-respawn** — killed background agents auto-respawned; revived agents re-ran stale prompts from old sessions. (Background agents.)
- **Background session title refusal leak** — titles showed the naming model's refusal text when the prompt contained a link. (Background agents.)
- **`claude agents` worktree-stale delete** — jobs became permanently undeletable when git no longer recognized their worktree; the row now shows why the delete was refused. (Agents + worktree — both live.)
- **`/clear` cost counter** — `/clear` didn't reset the session cost counter; statusline cost now starts at $0 after `/clear`. (REPL statusline.)
- **Screen-reader terminal bell** — screen-reader users lost the audible terminal bell after `/terminal-setup` or onboarding terminal setup. (a11y — OCC ported screen-reader mode in 2.1.210; follow-up fix.)
- **Pipe/headless stdin on Windows** — headless print-mode sessions on Windows crashed/silently exited when stdin was unreadable. (OCC has `-p` pipe mode.)
- **Background-job "Not logged in" on LLM-gateway auth** — jobs on `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` came back "Not logged in" after the daemon respawned them. (Daemon — OCC has a daemon subsystem; verify live.)
- **Integer env-var parsing generalization** — integer env vars (timeouts, token budgets, retry counts) now accept scientific notation + digit-separator spellings (`1e6`, `64_000`). (Config parse — note OCC already ported the `CLAUDE_CODE_MAX_OUTPUT_TOKENS` sci-notation case in 2.1.210 #11; 2.1.211 generalizes it to all int env vars.)
- **Memory over-limit warning refinement** — measures only loaded content, excluding frontmatter + HTML comments. (Memory — OCC ported the 2.1.210 #29 write-over-limit guard; this is its measurement refinement.)
- **"always allow" permission rules → repo root** — approvals granted in a git worktree now persist across sessions/worktrees by saving at the repository root. (Permissions + worktree — both live.)
- **Vim `s`/`S` substitute in NORMAL mode** — now work in NORMAL mode, matching vim. (OCC has vim mode; also recently ported `vimInsertModeRemaps` in 2.1.210.)
- **Permission-preview bidi/zero-width/look-alike-quote neutralization** — tool inputs cannot visually alter the approval message relayed to chat channels. (Security hardening — port if OCC relays permission previews to chat channels; verify live.)
- **Terminal layout + render perf** — general improvement. (REPL.)
- **Docs links** — updated to current docs sites. (Docs.)

### 3.3 N/A for OCC (trimmed subsystems — skip, document honestly)

- **Claude in Chrome** items (file-upload DOS-device/`.prn` + trailing-dot + multi-hard-link refusal; remote/CLI uploads; startup hang when extension enabled but Chrome not running; Windows setup-page open; file-upload path hardening; `save_to_disk` screenshot writes image + returns path). OCC has no Claude-in-Chrome surface → skip.
- **Plugin MCP reconnect after idle web wake** — OCC trims plugins/marketplace → skip.
- **`/usage-credits` confirmation before org-admin request** — OCC trims usage-credits/org-admin billing → skip.
- **Routines with no schedule reporting year-1 next-run** — OCC trims scheduled routines → skip.
- **`/loop` hiding session from `/resume`** — `/loop` in OCC is a skill-layer construct, not the upstream command; verify before porting, likely skip.
- **[VSCode] Remote Control banner copy** — VSCode-only → skip.
- **CCR web fetch/search proxies after `/clear`** — CCR-specific; verify, likely skip.

> Per the `aligning-with-official-binary` skill: items with no string delta 210→211 that are already-aligned or trimmed must be marked honestly deferred/skipped (no invention). The N/A list above is that honest accounting.

## 4. Recommended next steps (for the follow-on plan, not this research step)

1. **Close doc drift first** (quick win): bump `README.md`/`README.zh-CN.md` badge + `CLAUDE.md` "tracks" line + `CHANGELOG.md` header baseline from `2.1.204` → `2.1.210` now (or straight to `2.1.211` once the port lands).
2. **Port the 2.1.211 headline feature** (`--forward-subagent-text` / `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`) — it is the only net-new capability and is binary-verified absent from OCC. Print + stream-json guard must be replicated.
3. **Port the §3.2 work-list** in priority order, prioritizing the high-value cost fix (Bedrock/Vertex prompt-caching regression) and the permission/hook fix (auto-mode vs. PreToolUse `ask`), since both affect correctness/safety, not just polish.
4. **Per item**: run the `aligning-with-official-binary` recon (strings + byte-context) before implementing, then TDD + real e2e (incl. REPL via `repl-tmux-e2e-testing`) + `security-reviewer` before merge — same done-gate the 2.1.269 wave used.
5. After the 2.1.211 wave lands green, hand to operations for the X version-highlight (per the OCC-5 ops track).

## 5. Reproduction

```bash
# version truth
npm view @anthropic-ai/claude-code version            # → 2.1.211
npm view @anthropic-ai/claude-code time --json       # timeline

# changelog
curl -sL https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md

# binary verification (heavy ~262MB/binary; clean up after)
mkdir -p /tmp/cc211 && cd /tmp/cc211
npm pack @anthropic-ai/claude-code-linux-x64@2.1.210
npm pack @anthropic-ai/claude-code-linux-x64@2.1.211
tar -xzf *2.1.210.tgz && mv package v210
tar -xzf *2.1.211.tgz && mv package v211
strings -n 8 v210/claude | sort -u > s210.txt
strings -n 8 v211/claude | sort -u > s211.txt
grep -c CLAUDE_CODE_FORWARD_SUBAGENT_TEXT s210.txt   # → 0
grep -c CLAUDE_CODE_FORWARD_SUBAGENT_TEXT s211.txt   # → 3

# OCC source cross-check
grep -rn "FORWARD_SUBAGENT\|forward-subagent-text" src/   # → 0 hits (gap confirmed)
```
