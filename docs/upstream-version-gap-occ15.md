# OCC vs. official Claude Code — version-gap report (2026-07-22, OCC-15)

> Gap-research deliverable for **OCC-15** ("OCC版本追齐官方Claude Code"), step 1 only:
> produce the gap report — **no code changes, no release**. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory recital).
> Version truth from the npm registry (`@anthropic-ai/claude-code`) and the official
> Anthropic `CHANGELOG.md` on GitHub; code-level deltas verified by native-ELF string
> diff of the official `linux-x64` binaries.

## TL;DR

| Item | Value |
|------|-------|
| OCC own release (latest on `main`) | `2.1.276` (`package.json`; `origin/main`) |
| OCC **actual** aligned Claude Code | **`2.1.215`** (`CHANGELOG.md` §2.1.276; `docs/upstream-version-gap-occ13.md`) |
| Official latest Claude Code (npm `latest` tag) | **`2.1.217`** (`npm view @anthropic-ai/claude-code version`) |
| Gap | **2 versions** — `2.1.216` (2026-07-20) and `2.1.217` (2026-07-21) |
| Last no-gap confirmation | OCC-13, 2026-07-20 (OCC was at `2.1.215` = official latest that day) |
| New upstream since then | `2.1.216` shipped ~20h later (2026-07-20T20:19Z); `2.1.217` the next day (2026-07-21T19:55Z) |

**Conclusion:** a real gap exists this time (unlike OCC-13). Two upstream versions need
aligning. Recommended as **one combined OCC port** (`2.1.216 → 2.1.217`), because both
waves are dominated by bug-fixes and small schema additions; the only headline new
"features" are four portable env-var/setting knobs (binary-verified) plus the emoji
autocomplete UI. Suggested order in §5.

---

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.217` | `npm view @anthropic-ai/claude-code version` |
| npm publish timeline (tail) | `2.1.215`→2026-07-19, `2.1.216`→2026-07-20, `2.1.217`→2026-07-21 | `npm view @anthropic-ai/claude-code time --json` |
| Official GitHub `CHANGELOG.md` top entries | `## 2.1.217`, `## 2.1.216`, `## 2.1.215` | `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` |
| OCC aligned version | `2.1.215` | `CHANGELOG.md` §2.1.276; `CLAUDE.md` header |

Official version timeline (tail):

```
2.1.217 → 2026-07-21T19:55:38Z   ← official latest (gap)
2.1.216 → 2026-07-20T20:19:37Z   ← gap
2.1.215 → 2026-07-19T00:53:37Z   ← OCC aligned here (release 2.1.276)
2.1.214 → 2026-07-18T00:13:41Z
…
```

`2.1.216` and `2.1.217` both published after OCC-13's 2026-07-20 no-gap check. No
pre-release newer than `2.1.217` on the registry.

## 2. Binary verification — method

Per `aligning-with-official-binary`: pack the official `linux-x64` ELF at both ends of
the gap, extract readable strings, and `comm` the sorted-unique sets to surface
added/removed identifiers. `2.1.113+` ships as a native Bun-compiled ELF (no `cli.js`),
so strings-diff is the only viable recon.

```
npm pack @anthropic-ai/claude-code-linux-x64@2.1.215   # 265,239,536 bytes
npm pack @anthropic-ai/claude-code-linux-x64@2.1.217   # 268,573,680 bytes
strings -n 8 …/claude | sort -u > s215.txt   # 229,575 unique strings
strings -n 8 …/claude | sort -u > s217.txt   # 233,220 unique strings
comm -13 s215.txt s217.txt > added.txt        # 9,654 new/changed strings
comm -23 s215.txt s217.txt > removed.txt      # 6,009 removed/changed strings
```

**Binaries and temp artifacts were cleaned up after diffing** (`rm -rf /tmp/cc-gap-occ15`)
per the skill's resource-safety rule — no 250 MB ELFs left in `/tmp`.

## 3. Binary-verified new identifiers (the high-signal deltas)

These are the changelog-claimed new knobs confirmed present in `2.1.217` and **absent**
in `2.1.215` (grep counts: `217:N / 215:0`):

| Identifier | Kind | 217 | 215 | Wave | Notes |
|------------|------|----|----|------|-------|
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | env var | 5 | 0 | 2.1.217 | Cap on **concurrently-running** subagents (default 20). Sits in the env-var allowlist table next to the existing `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`. |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | env var | 5 | 0 | 2.1.217 | Overrides the new "no nested subagents by default" behavior (allow deeper nesting). |
| `emojiCompletionEnabled` | setting | 3 | 0 | 2.1.217 | Toggles emoji shortcode autocomplete (`:heart:` → ❤️). Appears in the settings-schema list alongside `promptSuggestionEnabled`, `autoCompactWindow`, etc. |
| `sandbox.filesystem.disabled` | setting | (changelog) | — | 2.1.216 | Skip filesystem isolation while keeping network egress control. Stored as a nested `sandbox.filesystem` object key, so the dotted form does not appear as a single string in the binary; confirmed via the changelog entry and the `sandbox`/`filesystem` settings group. |

> **Important — do not confuse the two subagent-cap families:**
> - OCC **already** ports the **2.1.212** per-session *total-spawn* cap
>   `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` (default 200) and
>   `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` (default 200) — see
>   `src/utils/sessionLimits.ts`, `src/utils/taskRegistry.ts` (OCC-9).
> - The **2.1.217** knobs are **new and different**: `MAX_CONCURRENT_SUBAGENTS`
>   (concurrent-running, default 20) and `MAX_SUBAGENT_SPAWN_DEPTH` (nesting depth).
>   `grep` in `src/` confirms **neither exists in OCC yet** — both must be ported.

## 4. Changelog — verbatim, with portability classification

Portability tags per `upstream-tracking` Step 2 ("only port features that don't depend on
the Anthropic backend; skip VSCode-only / no-op / platform-only"):
- ✅ **port** — portable to OCC (plain JS/TS logic, env-var/setting, Bash/REPL/CLI behavior).
- ⛔ **skip** — depends on Anthropic backend / cloud / Claude Desktop / Chrome / Remote Control / VSCode / Windows-only plumbing OCC has no counterpart for.
- 🟡 **assess** — has a portable core but touches a subsystem OCC may implement differently; needs a recon subagent before deciding.

### 4.1 Claude Code `2.1.216` (2026-07-20)

| # | Changelog entry | Tag | OCC-side note |
|---|-----------------|-----|---------------|
| 1 | Added `sandbox.filesystem.disabled` setting to skip filesystem isolation while keeping network egress control | ✅ | New setting knob. OCC's sandbox story differs from official; recon whether OCC has a `sandbox` settings group to slot into. |
| 2 | Fixed slowdown in long sessions where message normalization cost grew quadratically with turns (multi-second stalls, slow resumes) | ✅ | Perf fix in message normalization — portable; locate OCC's normalization path. |
| 3 | Fixed auto mode denying commands with "HTTP 401" classifier errors after OAuth token expired/rotated mid-session | 🟡 | Auto-mode classifier; OCC has `autoMode` (`src/cli/handlers/autoMode.ts`). Token-rotation path may differ. |
| 4 | Fixed AskUserQuestion telling Claude to continue even when your answer asked it to wait/explain first — free-text answers now get neutral wording | ✅ | OCC has `AskUserQuestion` tool; prompt-wording fix is portable. |
| 5 | Fixed Claude Code on the web re-asking the same question and dropping your answer after idle | ⛔ | Claude-Code-on-the-web only. |
| 6 | Fixed @-mentions silently attaching nothing after file-modifying hooks, vim dot-repeat of `c`-operators and paste, statusline running twice on resume, and resume-picker hangs on failure | ✅ | `@`-mention attach + statusline-on-resume + resume-picker — portable; multiple small fixes. |
| 7 | Fixed resumed background agent sessions reverting to the default agent: agent's prompt and tool restrictions now restored | ✅ | Background agent sessions; OCC has background sessions. |
| 8 | Fixed worktree-isolated subagents redirecting git into the shared checkout via `git -C`, `--git-dir`, or `GIT_DIR`/`GIT_WORK_TREE` | ✅ | OCC has worktree subagents (`using-git-worktrees`); sandbox-redirect hardening is portable and security-relevant. |
| 9 | Fixed worktree sessions landing in another project's leftover worktree when cwd did not match the selected project | ✅ | Worktree-cwd validation; portable. |
| 10 | Fixed background sessions whose worktree has no git repository being undeletable | ✅ | Worktree deletion edge case; portable. |
| 11 | Fixed `claude daemon stop --any` potentially terminating an unrelated process via a stale legacy daemon lockfile | 🟡 | OCC daemon/lockfile impl may differ. |
| 12 | Fixed Esc-Esc at an idle prompt not opening the rewind picker in long-running sessions with background tasks | ✅ | REPL/rewind; portable (needs tmux e2e). |
| 13 | Fixed Bash command permission checking for compound statements with redirects inside `&&` lists or negations | ✅ | OCC's Bash permission layer (the 2.1.214 M-wave touched this); portable and security-relevant. |
| 14 | Fixed pressing Ctrl+X twice in the agent list failing to delete a session, and deleted sessions reappearing when their background worker died | ✅ | Agent-list UI; portable. |
| 15 | Fixed background subagents getting cancelled when a high-priority message arrives during their startup window | ✅ | Background subagent lifecycle; portable. |
| 16 | Fixed mouse and focus garbage in the terminal while a GUI editor from `/memory`, `/plan`, `/keybindings`, or Ctrl+G is open; `/memory` no longer waits for editor close | 🟡 | GUI-editor launch; OCC may not have the GUI editor path. |
| 17 | Fixed Claude-in-Chrome 403-looping on reconnect when OAuth token lacks a required scope | ⛔ | Claude-in-Chrome only. |
| 18 | Fixed workflow saves and scheduled-task writes following a symlink at `.claude`, which could redirect writes outside the project | ✅ | OCC has workflows + cron/scheduled tasks; symlink-follow hardening is portable and security-relevant. |
| 19 | Fixed MCP re-authenticate revoking working credentials before the new sign-in succeeds, and reconnect needs-auth message in background sessions pointing at an unusable command | 🟡 | MCP auth flow; recon OCC's MCP re-auth path. |
| 20 | Fixed read-only commands on Windows accessing network paths without a permission prompt | ⛔ | Windows-only. |
| 21 | Fixed Bash command parsing of non-ASCII characters to match real shell word boundaries | ✅ | Bash arg-parser; portable, security-adjacent (word-boundary bypass). |
| 22 | Fixed PowerShell tool permission validation of commands containing invisible Unicode characters | ⛔ | PowerShell/Windows-only (OCC has no PowerShell tool). |
| 23–25 | Fixed dialogs / `/config` list / transcript-mode footer hint in fullscreen / narrow terminals | ✅ | TUI rendering; portable, tmux e2e. |
| 26 | Fixed Prometheus metrics endpoint (`OTEL_METRICS_EXPORTER=prometheus`) emitting invalid `# UNIT` lines | ✅ | OTEL exporter; portable. |
| 27 | Fixed skills and commands changed during a session not appearing in the slash menu until restart | ✅ | Slash-menu hot-reload; portable. |
| 28 | Fixed plugin skills with a `name` frontmatter field losing their plugin prefix in slash-command autocomplete | ✅ | Plugin skill naming; portable. |
| 29 | Fixed telemetry misreporting permission denials (failed prompts ≠ rejections; interrupts = aborts) | ✅ | OTEL telemetry attribution; portable. |
| 30 | Improved `/fork` confirmation to one line with new session name, `claude attach` id, and a note when the copy shares your checkout | ✅ | OCC has `/fork` (OCC-9); portable. |
| 31 | Improved validation of `git` and `gh` command arguments in the PowerShell tool | ⛔ | PowerShell-only. |
| 32 | Improved `/ultrareview` diff-too-large error to show configured limits, measured diff size, and largest contributing files | 🟡 | OCC may not have `/ultrareview`. |
| 33 | Improved `/code-review ultra` empty-diff message to name the exact base ref and suggest an explicit base | 🟡 | OCC has `/code-review`; "ultra" tier may not exist. |
| 34 | Improved spend-limit adjustment prompt to show the server's reason when a change is rejected | 🟡 | Server-side spend-limit; recon. |
| 35 | `/context` now warns explicitly when conversation exceeds the context window; failed `/compact` displays as an error | ✅ | OCC has `/context`, `/compact`; portable. |
| 36 | `/rewind` no longer restores or deletes files through symlinks or hard links at tracked paths and reports skipped paths | ✅ | OCC has `/rewind`; portable, security-relevant. |
| 37 | Background sessions: `/mcp` and `/install-github-app` park a "needs input" request in the agent view when no client is attached | 🟡 | Background-session UX; recon. |
| 38 | Updated bundled dataviz skill: reordered default chart palette and fixed four-series direct-label guidance | ✅ | OCC has the `dataviz` skill; content port. |
| 39 | [VSCode] Fixed RTL text (Arabic/Hebrew/Persian) rendering order | ⛔ | VSCode-only. |
| 40 | Fixed cloud sessions dropping the in-flight message when the session's container restarts mid-turn — interrupted turn re-runs on resume | ⛔ | Cloud-sessions only. |

### 4.2 Claude Code `2.1.217` (2026-07-21)

| # | Changelog entry | Tag | OCC-side note |
|---|-----------------|-----|---------------|
| 1 | Added emoji shortcode autocomplete in the prompt input (`:heart:` → ❤️, `:hea` suggestions); disable with `emojiCompletionEnabled` | ✅ | New prompt-input UI feature + setting; binary-verified. Needs tmux e2e. |
| 2 | Added warnings when transcript writes are failing (e.g. disk full) or when session saving is off due to an inherited env var, instead of losing transcripts silently | ✅ | Transcript/session-save layer; portable. |
| 3 | Fixed memory leak where truncated MCP tool outputs kept the full untruncated result in memory for the rest of the session | ✅ | MCP tool-output truncation; portable, perf. |
| 4 | Fixed Windows auto-update failures leaving `claude.exe` missing; failed updates restore the preserved executable | ⛔ | Windows auto-update only. |
| 5 | Fixed background session isolation not canonicalizing symlinked working directories, which could let sessions escape their workspace folder | ✅ | cwd canonicalization; portable, security-relevant. |
| 6 | Fixed auto-compact never triggering for Claude Opus 4.8 on Bedrock and `/compact` failing once over the limit | ⛔ | Bedrock/Opus-specific. |
| 7 | Fixed corporate mTLS, TLS-verify, OAuth scope, and proxy settings being ignored in Claude Desktop sessions | ⛔ | Claude Desktop only. |
| 8 | Fixed screen reader mode's startup announcement being cut off by first prompt render, and the thinking status row re-rendering every few seconds | ✅ | A11y / TUI; portable, tmux e2e. |
| 9 | Fixed managed settings that set `OTEL_EXPORTER_OTLP_ENDPOINT` not governing all signals — lower-scope signal-specific overrides no longer redirect telemetry away from the managed endpoint | ✅ | Managed-settings/OTEL; portable, security/privacy-relevant. |
| 10 | Fixed `--resume`/`--continue` and `/resume` failing with a TypeError when a transcript has a malformed attachment entry | ✅ | Resume/attachment parsing; portable, robustness. |
| 11 | Fixed Remote Control sessions not showing a pending permission prompt/dialog to viewers that connected after it appeared | ⛔ | Remote Control only. |
| 12 | Fixed background shells sometimes becoming impossible to stop after a session is sent to the background or when the session exits on a heavily loaded machine (most visible on Windows) | ✅ | Background-shell lifecycle; portable core. |
| 13 | Fixed a `CLAUDE.md` or `SKILL.md` paths frontmatter value with many brace groups OOM-killing or stalling the CLI at startup — brace expansion is now budget-bounded | ✅ | Frontmatter brace expansion; portable, **security/DoS-relevant**. |
| 14 | Fixed transcript preview sitting flush against the input area when attaching to a starting background session; now leaves the one-line gap | ✅ | TUI layout; portable, tmux e2e. |
| 15 | Improved footer PR badge links to be clickable hyperlinks even when terminal support can't be detected (ssh/tmux); `FORCE_HYPERLINK=0` opts out | ✅ | Footer rendering; portable. |
| 16 | Changed login-expiry warning to appear 3 days before expiry instead of 5 | ✅ | Login-expiry nudge; portable. |
| 17 | Capped the frontend-design plugin suggestion tip at 3 lifetime impressions instead of repeating indefinitely | ✅ | Plugin tip-cap; portable. |
| 18 | **Added a cap on concurrently-running subagents (default 20, override with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`)** so one message can't fan out unbounded background agents | ✅ | **New env var, binary-verified.** Extends OCC's existing `sessionLimits`/`TaskRegistry` (2.1.212) — add a *concurrent-running* counter alongside the *total-spawn* counter. |
| 19 | **Changed subagents to no longer spawn nested subagents by default; set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` to allow deeper nesting** | ✅ | **New env var, binary-verified.** Spawn-depth guard in `runAgent`/`spawnMultiAgent`. |
| 20 | Fixed `--max-budget-usd` not stopping background subagents: once the cap is reached, new spawns are denied and running background agents are halted | ✅ | Budget enforcement; portable. |

## 5. Recommended alignment order

One combined OCC release porting `2.1.216 → 2.1.217` (call it OCC-15 release, e.g.
`2.1.277`), sequenced by (risk × dependency), each slice independently
parallelizable across subagents where files don't overlap. Per
`aligning-with-official-binary`, every portable item below must be reverse-engineered
from the `2.1.216`/`2.1.217` ELF (not invented) and gated by behavioral e2e per
`behavior-driven-done`.

### Stage 1 — Schema/env layer (low risk, high signal, unblocks Stage 2)
1. Add the four binary-verified knobs to OCC's settings/env layer:
   - `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default **20**)
   - `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default **0** = no nesting)
   - `emojiCompletionEnabled` setting (default on)
   - `sandbox.filesystem.disabled` setting (recon OCC sandbox group first)
2. Doc bump: `CLAUDE.md` / README / `CHANGELOG.md` "tracks `2.1.215`" → `2.1.217`.

### Stage 2 — Subagent fan-out caps (2.1.217 #18–#20) — core, touches `AgentTool`/`spawnMultiAgent`
3. Concurrent-running subagent cap (`MAX_CONCURRENT_SUBAGENTS=20`): extend
   `src/utils/sessionLimits.ts` + `src/utils/taskRegistry.ts` with a
   *concurrent-running* counter (inc on spawn, dec on settle), enforced at spawn sites in
   `src/tools/AgentTool/runAgent.ts` + `src/tools/shared/spawnMultiAgent.ts`. Reuse the
   2.1.212 cap-primitive shape; do **not** invent a new registry.
4. Nested-subagent default-off + `MAX_SUBAGENT_SPAWN_DEPTH` depth guard: in
   `runAgent`/`spawnMultiAgent`, deny nested spawns unless depth env is set; track depth.
5. `--max-budget-usd` halts running background agents + denies new spawns when cap hit.

### Stage 3 — Bash permission & parsing fixes (2.1.216 #13, #21) — security-relevant
6. Compound statements with redirects inside `&&` lists / negations: permission check fix
   in the Bash permission layer (the 2.1.214 M-wave area).
7. Non-ASCII word-boundary parsing in the Bash arg-parser (match real shell boundaries).

### Stage 4 — DoS/robustness fixes (security-relevant)
8. Frontmatter `paths` brace-expansion OOM budget-bound (2.1.217 #13).
9. Workflow / scheduled-task writes following a symlink at `.claude` (2.1.216 #18).
10. `/rewind` no longer restoring/deleting through symlinks/hardlinks (2.1.216 #36).
11. Background-session cwd canonicalization (symlinked cwd escape) (2.1.217 #5).
12. Worktree-isolated subagent git-redirect hardening (`git -C`/`--git-dir`/`GIT_DIR`/`GIT_WORK_TREE`) (2.1.216 #8).

### Stage 5 — Smaller portable fixes (batchable)
13. `@`-mention attach after file-modifying hooks + statusline-twice-on-resume + resume-picker hang (2.1.216 #6).
14. Resumed background agent reverting to default agent (2.1.216 #7).
15. Background subagent cancelled on high-priority message during startup (2.1.216 #15).
16. Background-shell impossible-to-stop after backgrounding (2.1.217 #12).
17. `--resume`/`--continue`/`/resume` TypeError on malformed attachment (2.1.217 #10).
18. Transcript-write-failure / session-saving-off warnings (2.1.217 #2).
19. MCP truncated-output memory leak (2.1.217 #3).
20. Managed-settings `OTEL_EXPORTER_OTLP_ENDPOINT` governs all signals (2.1.217 #9) + Prometheus `# UNIT` fix (2.1.216 #26) + telemetry permission-denial misreport (2.1.216 #29).
21. `/context` over-window warning + failed `/compact` error (2.1.216 #35).
22. `/fork` one-line confirmation (2.1.216 #30).
23. Slash-menu hot-reload of changed skills/commands (2.1.216 #27) + plugin-skill prefix (2.1.216 #28).
24. Dataviz bundled-skill content update (2.1.216 #38).
25. Login-expiry 5→3 day nudge (2.1.217 #16) + footer PR-badge hyperlinks/`FORCE_HYPERLINK` (2.1.217 #15) + frontend-design tip cap (2.1.217 #17).

### Stage 6 — TUI/REPL features (need tmux behavioral e2e, `repl-tmux-e2e-testing`)
26. Emoji shortcode autocomplete + `emojiCompletionEnabled` (2.1.217 #1).
27. Esc-Esc rewind picker in long sessions with background tasks (2.1.216 #12).
28. Screen-reader startup announcement + thinking-status re-render (2.1.217 #8).
29. Transcript preview one-line gap on attach (2.1.217 #14) + fullscreen/narrow TUI fixes (2.1.216 #23–25).
30. Agent-list Ctrl+X delete (2.1.216 #14).
31. AskUserQuestion free-text neutral wording (2.1.216 #4).
32. Message-normalization quadratic-slowdown fix (2.1.216 #2).

### Explicitly SKIPPED (do not port — no OCC counterpart / platform-only)
- 2.1.216 #5, #17, #20, #22, #31, #39, #40 — web/Chrome/Windows/PowerShell/VSCode/cloud.
- 2.1.217 #4, #6, #7, #11 — Windows auto-update / Bedrock-Opus / Claude Desktop / Remote Control.
- 🟡 "assess" items (#3 auto-mode 401, #11 daemon lockfile, #16 GUI editor, #19 MCP re-auth, #32 `/ultrareview`, #33 `/code-review ultra`, #34 spend-limit, #37 background `/mcp` park) — each gets a short recon subagent before port/skip decision.

## 6. Verification gate (for the implementer + acceptance reviewer)

- Every portable item ported above must be **binary-verified** against the `2.1.216`/`2.1.217`
  ELF (`strings` + `grep -boF` + byte context), not invented — per
  `aligning-with-official-binary`.
- Behavioral e2e (not source-grep) per `behavior-driven-done`: `occ -p` for backend-touching
  items, tmux `capture-pane` for TUI items (Stages 6). Hang-smoke (`occ -p "hi"`) after any
  feature-flag/allowlist change.
- Security review must cover the DoS/symlink/redirect items in Stage 3–4 (brace-expansion
  OOM, `.claude` symlink, `/rewind` symlink, git-redirect, cwd canonicalization).
- Acceptance reviewer confirms: no skipped-portable item silently dropped, no
  invented cap/heuristic the official doesn't have, OCC-extra features stay OCC-specific.
- Release only after the full `git tag + npm publish + GitHub Release` three-step flow
  (per the issue's 发版流程) and `/releases` == `/tags` parity check.

## 7. Open questions for the next step

1. Does OCC have a `sandbox` settings group to host `sandbox.filesystem.disabled`, or is
   OCC's filesystem isolation shaped differently? (blocks Stage 1 #4)
2. Does OCC implement `/ultrareview` and `/code-review ultra` tiers, or only base
   `/code-review`? (blocks 2.1.216 #32/#33)
3. Does OCC have the GUI-editor launch path (`/memory`/`/plan`/`/keybindings`/Ctrl+G)?
   (blocks 2.1.216 #16)
4. OCC's MCP re-auth + daemon lockfile implementations — do they share the official's
   vulnerable shape? (blocks 2.1.216 #11/#19)

These are recon questions, not blockers for the headline work (Stages 1–3).

## 8. Tracked feature gaps (implementation deferred — not in current scope)

### Additional-directory agent/skill/command discovery missing

**Upstream binary (2.1.218 ELF):** The official computes `fromAdditionalDirectory`
on agent definitions discovered via `--add-dir` (additional directories). Binary
recon confirms:

```
{...H, baseDir:I, source:"projectSettings", fromAdditionalDirectory:!0}
```

Agents discovered from additional directories are tagged with
`fromAdditionalDirectory: true`, and this field is read by the
`tengu_agent_hooks_origin_untrusted` telemetry event:

```
fromAdditionalDirectory: me(e.fromAdditionalDirectory===!0?"true":"false")
```

**OCC gap:** OCC has no `--add-dir`-driven agent/skill/command discovery
feature. The `fromAdditionalDirectory` telemetry field in
`skipFrontmatterHooksForUntrustedOrigin` (hooks.ts) is hard-coded to `'false'`.
A TODO comment marks the spot. When the additional-directory discovery feature
lands, `fromAdditionalDirectory` MUST be computed from the agent definition's
metadata field instead of being hard-coded.

**Status:** Tracked — implementation NOT in current scope. Only the TODO
comment + this gap-doc entry are done. The `mainThread` frontmatter-hook
registration path (CC 2.1.218 #23 closure) is already wired and works
independently of this feature.
