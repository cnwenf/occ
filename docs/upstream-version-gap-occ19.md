# OCC vs. official Claude Code — version-gap report (2026-07-23, OCC-19)

> Gap-research deliverable for **OCC-19** ("OCC版本追齐官方Claude Code"), step 1:
> produce the gap report — versions, changelog, binary-verified code delta, and a
> prioritized alignment checklist. Methodology per the `upstream-tracking` +
> `aligning-with-official-binary` skills. Version truth from the npm registry
> (`@anthropic-ai/claude-code`) and the official Anthropic `CHANGELOG.md` on GitHub;
> code-level deltas verified by native-ELF string diff of the official `linux-x64`
> binaries (2.1.113+ ships as a native Bun-compiled ELF, no `cli.js`).

## TL;DR

| Item | Value |
|------|-------|
| OCC own release (latest on `main`) | `2.1.276` (`package.json`; `origin/main`) |
| OCC **actual** aligned Claude Code | **`2.1.215` fully aligned**; the `2.1.216`→`2.1.217` wave (OCC-15) is **partially landed** — Stages 1–4 + Follow-ups A/B done, Stages 5–6 pending |
| Official latest Claude Code (npm `latest` tag) | **`2.1.218`** (`npm view @anthropic-ai/claude-code version`; published 2026-07-22T19:55Z) |
| Gap | **YES — two layers**: (a) `2.1.218` entirely unported; (b) `2.1.216/2.1.217` Stages 5–6 + 🟡 assess items still pending |
| Last no-gap confirmation | OCC-13, 2026-07-20 (OCC was at `2.1.215` = official latest that day) |
| New upstream since OCC-15 report (2026-07-22) | `2.1.218` shipped 2026-07-22T19:55Z (the day before this run) |

**Conclusion: a real gap exists.** Official moved to `2.1.218`; OCC is at `2.1.215`
fully-aligned plus a partial `2.1.216/2.1.217` port. The path is **alignment**, not
self-acceptance: produce the prioritized checklist (§4) and start pushing portable
items to `main`. The `2.1.218` wave is dominated by bug-fixes + a few behavioral
changes (background `/code-review`, auto-mode classifier, `context: fork` skills,
frontmatter boolean tokens, agent-name `:` rejection, `/deep-research` manual-only).

---

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.218` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.218`, `next=2.1.218`, `stable=2.1.206` | `npm view ... dist-tags --json` |
| Official GitHub `CHANGELOG.md` top entry | `## 2.1.218` | `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` |
| OCC aligned version | `2.1.215` (full) + partial `2.1.216/2.1.217` | `CHANGELOG.md` §2.1.276; `CLAUDE.md` header; `docs/upstream-version-gap-occ15.md` |

Official version timeline (tail):

```
2.1.218 → 2026-07-22T19:55:32Z   ← official latest (GAP — unported)
2.1.217 → 2026-07-21T19:55:38Z   ← OCC-15 partial (Stages 1–4 + follow-ups landed; 5–6 pending)
2.1.216 → 2026-07-20T20:19:37Z   ← OCC-15 partial (same)
2.1.215 → 2026-07-19T00:53:37Z   ← OCC fully aligned here (release 2.1.276)
2.1.214 → 2026-07-18T00:13:41Z
…
```

`2.1.218` published 2026-07-22 — the day before this run (2026-07-23). No pre-release
newer than `2.1.218` on the registry (`versions` list tops out at `2.1.218`).

## 2. Binary verification — method

Per `aligning-with-official-binary`: pack the official `linux-x64` ELF at both ends of
the *new* gap (`2.1.217` → `2.1.218`), extract readable strings, and `comm` the
sorted-unique sets to surface added/removed identifiers.

```
npm pack @anthropic-ai/claude-code-linux-x64@2.1.217   # 268,573,680 bytes
npm pack @anthropic-ai/claude-code-linux-x64@2.1.218   # 273,177,584 bytes
strings -n 8 …/claude | sort -u > s217.txt   # 233,220 unique strings
strings -n 8 …/claude | sort -u > s218.txt   # 236,818 unique strings
comm -13 s217.txt s218.txt > added.txt        # 9,347 new/changed strings
comm -23 s217.txt s218.txt > removed.txt      # 5,749 removed/changed strings
```

**Binaries and temp artifacts were cleaned up after diffing** (`rm -rf /tmp/cc-diff-218`)
per the skill's resource-safety rule — no 250 MB ELFs left in `/tmp`.

## 3. Binary-verified new identifiers in 2.1.218 (high-signal deltas)

New env vars / settings present in `2.1.218` and absent in `2.1.217`:

| Identifier | Kind | Wave | Portability | Notes |
|------------|------|------|-----------|-------|
| `CLAUDE_CODE_AUTO_MODE_CLASSIFIER_QUEUE` | env var | 2.1.218 | 🟡 assess | Queue depth for the auto-mode classifier. Pairs with `classifierQueueDepth`/`queueDepth` settings. Relates to the 2.1.218 auto-mode behavioral change (dangerous-rm / bg-`&` / suspicious-Windows-path adjudicated by classifier, no permission dialog). OCC has `autoMode` + live `BASH_CLASSIFIER`. |
| `CLAUDE_CODE_DISABLE_MEMORY_MASS_DELETE_HOLD` | env var | 2.1.218 | 🟡 assess | Memory mass-delete hold. OCC has a memory subsystem; niche. |
| `CLAUDE_CODE_GORSE_PLOVER` | env var (codename) | 2.1.218 | ⛔ skip | Internal Anthropic feature-flag codename — not in changelog, gates an unreleased feature OCC has no counterpart for. |
| `CLAUDE_CODE_JUNIPER_SUNDIAL` | env var (codename) | 2.1.218 | ⛔ skip | Internal codename feature-flag — same as above. |
| `classifierQueueDepth` / `queueDepth` | setting | 2.1.218 | 🟡 assess | Auto-mode classifier queue; pairs with the env var above. |
| `fanoutDepth` | setting | 2.1.218 | ✅ (already covered) | Maps to the 2.1.217 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` already ported in OCC-15 Stage 2. |
| `fosterParentingEnabled` | setting (codename) | 2.1.218 | ⛔ skip | Internal feature flag, no OCC counterpart. |
| `isArtifactPrReviewComposeEnabled` | setting | 2.1.218 | 🟡 assess | Relates to the `/code-review`-as-background-subagent change (PR review compose). |
| `isWhiteboardEnabled` | setting (codename) | 2.1.218 | ⛔ skip | Internal whiteboard feature flag — OCC has no whiteboard. |
| `scriptingEnabled` | setting (codename) | 2.1.218 | ⛔ skip | Internal feature flag. |
| `setScheduledTasksEnabled` | setting | 2.1.218 | 🟡 assess | Scheduled-tasks gating; OCC has scheduled tasks — recon whether OCC's shape matches. |
| `/working` | slash command | 2.1.218 | 🟡 assess | New command; recon purpose before porting. |

> The codename flags (`GORSE_PLOVER`, `JUNIPER_SUNDIAL`, `fosterParentingEnabled`,
> `isWhiteboardEnabled`, `scriptingEnabled`) are internal Anthropic feature flags for
> unreleased/cloud features OCC has no counterpart for — **skip**, do not port.

## 4. Changelog — verbatim, with portability classification

Portability tags per `upstream-tracking` Step 2 ("only port features that don't depend on
the Anthropic backend; skip VSCode-only / no-op / platform-only"):
- ✅ **port** — portable to OCC (plain JS/TS logic, env-var/setting, Bash/REPL/CLI/skill/agent behavior).
- ⛔ **skip** — depends on Anthropic backend / cloud / Claude Desktop / Chrome / Remote Control / VSCode / Windows-only plumbing OCC has no counterpart for.
- 🟡 **assess** — has a portable core but touches a subsystem OCC may implement differently; needs a recon subagent before deciding.

### 4.1 Claude Code `2.1.218` (2026-07-22)

| # | Changelog entry | Tag | OCC-side note |
|---|-----------------|-----|---------------|
| 1 | Changed `/code-review` to run as a background subagent, so review work no longer fills your conversation and keeps stacked slash commands as its review target | 🟡 | OCC has `/code-review` (already manual-only per 2.1.215). Backgrounding it is a behavioral change; recon OCC's `/code-review` + background-subagent path. |
| 2 | Added screen-reader announcements of deleted text for word/line deletions in `--ax-screen-reader` mode | 🟡 | A11y / TUI; recon whether OCC has the ax-screen-reader surface. |
| 3 | Fixed Windows paths with `\u`-prefixed segments being corrupted into CJK characters in tool inputs | ⛔ | Windows-only. |
| 4 | Fixed the left arrow key discarding the conversation with no undo: presses right after editing now ask to confirm, and Esc in the agent view returns to the conversation it backgrounded | ✅ | REPL behavior; portable, tmux e2e. |
| 5 | Added HTTP status and error text to `claude mcp list` and `/mcp` when a server fails to connect, and a warning for MCP config values with hidden leading or trailing whitespace | ✅ | OCC has `mcp list` + `/mcp`; portable. |
| 6 | Fixed multi-line paste collapsing into one line with `j` in place of newlines in terminals that encode pasted newlines as Ctrl+J | ✅ | REPL paste handling; portable, tmux e2e. |
| 7 | Fixed `/context` reporting stale pre-compact token usage after compacting from the message picker | ✅ | OCC has `/context` + `/compact`; portable. |
| 8 | Fixed `/ultrareview` failing on descriptive arguments — they now run a review of your current branch with the text applied as a note | 🟡 | Recon whether OCC has `/ultrareview`. |
| 9 | Fixed `/code-review ultra` silently running a local review in non-interactive sessions — it now launches the cloud review | ⛔ | "cloud review" = Anthropic backend. |
| 10 | Fixed gateway spend metering to price Bedrock application-inference-profile ARNs at the configured model's rates | ⛔ | Bedrock/gateway billing only. |
| 11 | Fixed mojibake when a long IDE selection was truncated mid-emoji, and a case where a tool executor error could be silently dropped | ✅ | Tool-executor error-drop is portable; IDE-selection mojibake is IDE-only but the error-drop half is portable. |
| 12 | Fixed an engine teardown race that could start and abandon a phantom turn, and made input pushed after close consistently rejected | ✅ | Query-engine lifecycle; portable core. |
| 13 | Fixed spurious "[Request interrupted by user]" messages after interrupted tool calls, and an unpaired `tool_use` block left in the transcript when a tool aborted mid-response | ✅ | Transcript/tool-call cleanup; portable. |
| 14 | Fixed VoiceOver reading "new line" instead of echoing the typed space in `--ax-screen-reader` mode | 🟡 | A11y; recon. |
| 15 | Fixed plugin and settings panels not moving the terminal cursor to the focused row | 🟡 | TUI panel a11y; recon. |
| 16 | Fixed crashes (maximum call stack exceeded) when a deeply nested watched directory tree was deleted or moved, and when rendering deeply nested UI trees | ✅ | Stack-overflow guard; portable, DoS-relevant. |
| 17 | Fixed pull request events occasionally being lost when a session exited immediately after creating or linking a PR | 🟡 | PR-event lifecycle; recon OCC's PR integration. |
| 18 | Fixed the Bedrock setup wizard failing profile verification for assume-role profiles in partitioned AWS regions and on proxy-only networks | ⛔ | Bedrock wizard only. |
| 19 | Fixed rare negative or incorrect turn duration measurements after a system clock adjustment by timing turns with a monotonic clock | ✅ | Turn-timing; portable (use `performance.now()` / monotonic). |
| 20 | Fixed the "N MCP servers need authentication" startup notice over-counting claude.ai connectors that aren't connected in claude.ai | ⛔ | claude.ai connector only. |
| 21 | Fixed prompt history entries being dropped or duplicated when history writes raced or failed | ✅ | Prompt-history persistence; portable. |
| 22 | Fixed a retry loop that re-sent identical doomed requests after a context-overflow error with a large thinking budget; `Ctrl+B` backgrounding now applies the same background-shell caps as other paths | ✅ | Retry-loop + background-shell caps; portable. |
| 23 | Fixed agent frontmatter hooks running from untrusted folders: hooks now require the agent file's own folder to have accepted workspace trust | ✅ | Agent-hook trust gate; portable, **security-relevant**. |
| 24 | Fixed fork-session lineage being lost after compaction in headless and SDK sessions | ✅ | Fork/compaction lineage; portable. |
| 25 | Fixed a resumed session failing every turn, or crashing on resume, when its history held a malformed delta attachment | ✅ | Resume/attachment parsing; portable (extends 2.1.217 #10). |
| 26 | Improved `/ultrareview` error feedback so Claude can correct an invalid argument instead of retrying it unchanged | 🟡 | Recon `/ultrareview`. |
| 27 | Improved auto mode: dangerous-rm, background-`&`, and suspicious-Windows-path checks no longer open permission dialogs; the auto-mode classifier adjudicates them instead | ✅ | Auto-mode classifier; OCC has `autoMode` + live `BASH_CLASSIFIER`. Portable core (the "no dialog, classifier decides" behavior). |
| 28 | Improved sandbox command restrictions for IDE interactions | 🟡 | Sandbox/IDE; recon. |
| 29 | Improved trust dialogs to name the repository root the grant covers | ✅ | Trust-dialog wording; portable. |
| 30 | Changed `/deep-research` to start only when invoked manually; Claude no longer launches it on its own | ✅ | Skill auto-launch removal; OCC has `/deep-research`. Portable (mirrors the 2.1.215 `/verify`+`/code-review` manual-only change OCC already did). |
| 31 | Changed plan mode with auto to no longer prompt for Bash commands the static analyzer can't prove read-only; the auto-mode classifier judges them instead | ✅ | Plan-mode + auto classifier; OCC has plan mode + autoMode. Portable. |
| 32 | Added an announcement when fast mode changes as a result of switching models via `/config model=<x>` or Remote Control | 🟡 | Fast-mode announcement; recon OCC's fast-mode surface. |
| 33 | Changed server-managed settings so benign feature and cost toggles no longer trigger the settings-approval prompt | ⛔ | Server-managed settings = managed/policy layer tied to Anthropic backend. |
| 34 | Changed agent markdown files to reject agent names containing `:`, which is reserved for plugin namespacing | ✅ | Agent-name validation; portable, self-contained. |
| 35 | Changed skills with `context: fork` to run in the background by default; opt out per skill with `background: false` | ✅ | Skill execution context; OCC has `context: fork` parsing (`parseSkillFrontmatterFields`). Portable. |
| 36 | Added `yes`/`no`/`on`/`off`/`1`/`0` (case-insensitive) as accepted values for skill and plugin frontmatter booleans, alongside `true`/`false` | ✅ | Frontmatter boolean parsing; portable, self-contained. **Binary-verified feature intro in 2.1.218.** |
| 37 | Fixed remote sessions continuing to send heartbeats after their worker was replaced | ⛔ | Remote Control / cloud sessions only. |

### 4.2 Reconciled state of the 2.1.216/2.1.217 wave (OCC-15 plan)

The OCC-15 plan (`docs/upstream-version-gap-occ15.md`) staged the 2.1.216/2.1.217 port.
Current actual state (grep-verified against `src/`):

| OCC-15 stage | Status | Evidence |
|--------------|--------|----------|
| Stage 1 — schema/env knobs (`MAX_CONCURRENT_SUBAGENTS`, `MAX_SUBAGENT_SPAWN_DEPTH`, `emojiCompletionEnabled`, `sandbox.filesystem.disabled`) | ✅ landed | `src/utils/sessionLimits.ts`, `src/utils/settings/types.ts`, `src/utils/sandbox/sandbox-adapter.ts` |
| Stage 2 — subagent fan-out caps + budget | ✅ landed | `src/tools/AgentTool/runAgent.ts`, `src/utils/sessionLimits.ts` |
| Stage 3 — bash parsing #13/#21 regression tests | ✅ landed | `src/tools/BashTool/__tests__/bashSecurityCatchup.test.ts` |
| Stage 4 — worktree git-redirect guard (2.1.216 #8) | ✅ landed | `src/tools/BashTool/worktreeGitRedirectGuard.ts` |
| Follow-up A — ozg shell-wrapper obfuscation detection | ✅ landed | commit `b156fac` |
| Follow-up B — block shells reading scripts from non-REPL stdin | ✅ landed | commit `61a30fc` (OCC-16) |
| Stage 5 — smaller portable fixes (216 #6/#7/#15/#30/#35/#27/#28/#38, 217 #2/#3/#9/#16/#15/#17, etc.) | ⛔ **pending** | not yet ported (e.g. emoji autocomplete UI, `/fork` one-line, `/context` over-window warning, slash-menu hot-reload, MCP trunc memleak, managed-OTEL, login-expiry 3-day, footer hyperlinks — `FORCE_HYPERLINK` landed, others not confirmed) |
| Stage 6 — TUI/REPL features (emoji autocomplete, Esc-Esc rewind, screen-reader, transcript-preview gap, agent-list Ctrl+X, AskUserQuestion neutral, message-normalization quadratic) | ⛔ **pending** | emoji autocomplete UI not implemented (only the settings key exists); others not confirmed |
| 🟡 assess items (216 #3/#11/#16/#19/#32/#33/#34/#37, daemon lockfile, GUI editor, MCP re-auth, spend-limit, background `/mcp` park) | ⛔ **pending** | recon not done |

So OCC is **not** fully at `2.1.217` either — Stages 5–6 + the 🟡 assess items remain.

## 5. Recommended alignment order (prioritized checklist)

Sequenced by (risk × dependency × security-relevance). Each slice is independently
parallelizable across subagents where files don't overlap (per
`dispatching-parallel-agents` / `subagent-driven-development`). Per
`aligning-with-official-binary`, every portable item must be reverse-engineered from
the `2.1.218` ELF (not invented) and gated by behavioral e2e per
`behavior-driven-done` / `repl-tmux-e2e-testing`.

### P0 — Quick, self-contained, low-risk (do first, unblock trust)
1. **Frontmatter boolean tokens** (2.1.218 #36): accept `yes/no/on/off/1/0`
   (case-insensitive) in `parseBooleanFrontmatter` (`src/utils/frontmatterParser.ts`).
   Binary-verified. Unit tests + e2e.
2. **Agent markdown name rejects `:`** (2.1.218 #34): validation at agent-load.
   Self-contained.
3. **`/deep-research` manual-only** (2.1.218 #30): mirror the 2.1.215
   `/verify`+`/code-review` manual-only change OCC already did — grep-verify no
   auto-launch instruction, else remove it.

### P1 — Skill/agent execution + auto-mode behavioral (core, touches skill runner / autoMode)
4. **`context: fork` skills background by default; `background: false` opt-out**
   (2.1.218 #35): extend `parseSkillFrontmatterFields` + skill runner.
5. **Auto-mode classifier adjudicates dangerous-rm / bg-`&` / suspicious-Windows-path**
   (2.1.218 #27) + **plan-mode auto no longer prompts for unprovable Bash**
   (2.1.218 #31): OCC has `autoMode` + live `BASH_CLASSIFIER`. Behavioral.
6. **`/code-review` as background subagent** (2.1.218 #1): recon OCC's
   `/code-review` + background-subagent path first (🟡).
7. **Agent frontmatter hooks require folder workspace trust** (2.1.218 #23):
   security-relevant.

### P2 — Security/DoS/robustness fixes (security-relevant)
8. Deeply-nested watched-directory tree deletion → stack-overflow guard (2.1.218 #16).
9. Tool-executor error silently dropped (2.1.218 #11, error half).
10. Phantom-turn engine teardown race + reject input after close (2.1.218 #12).
11. Spurious "[Request interrupted by user]" + unpaired `tool_use` transcript (2.1.218 #13).
12. Context-overflow retry loop + `Ctrl+B` background-shell caps (2.1.218 #22).
13. Resumed session malformed-delta-attachment crash (2.1.218 #25, extends 2.1.217 #10).
14. Fork-session lineage lost after compaction in headless/SDK (2.1.218 #24).
15. Monotonic-clock turn timing (2.1.218 #19).
16. Prompt-history write race (2.1.218 #21).

### P3 — Remaining 2.1.216/2.1.217 Stage 5/6 (finish the OCC-15 wave)
17. Emoji shortcode autocomplete UI + `emojiCompletionEnabled` (2.1.217 #1) — tmux e2e.
18. `/context` over-window warning + failed `/compact` error (2.1.216 #35) + stale
    pre-compact token usage (2.1.218 #7).
19. `/fork` one-line confirmation (2.1.216 #30).
20. Slash-menu hot-reload of changed skills/commands (2.1.216 #27) + plugin-skill
    prefix (2.1.216 #28).
21. MCP truncated-output memory leak (2.1.217 #3) + `mcp list`/`/mcp` HTTP status +
    whitespace warning (2.1.218 #5).
22. Transcript-write-failure / session-saving-off warnings (2.1.217 #2).
23. Managed-settings `OTEL_EXPORTER_OTLP_ENDPOINT` governs all signals (2.1.217 #9) +
    Prometheus `# UNIT` (2.1.216 #26) + telemetry permission-denial misreport (2.1.216 #29).
24. `/rewind` symlink/hardlink skip (2.1.216 #36) + workflow `.claude` symlink (2.1.216 #18) +
    frontmatter brace-expansion OOM (2.1.217 #13) + background cwd canonicalization (2.1.217 #5).
25. Login-expiry 5→3 day nudge (2.1.217 #16, `FORCE_HYPERLINK` already landed) +
    frontend-design tip cap (2.1.217 #17).
26. AskUserQuestion free-text neutral wording (2.1.216 #4) + message-normalization
    quadratic fix (2.1.216 #2) + Esc-Esc rewind picker (2.1.216 #12) + agent-list
    Ctrl+X delete (2.1.216 #14) + resumed background agent restore (2.1.216 #7) +
    background subagent cancelled on high-priority message (2.1.216 #15) +
    background-shell impossible-to-stop (2.1.217 #12) + transcript-preview gap (2.1.217 #14) +
    screen-reader fixes (2.1.217 #8) + `--resume` malformed attachment (2.1.217 #10).
27. Dataviz bundled-skill content update (2.1.216 #38).

### P4 — 🟡 assess items (recon → port/skip decision)
28. `/ultrareview` descriptive args (2.1.218 #8/#26) — does OCC have `/ultrareview`?
29. `/code-review ultra` cloud review (2.1.218 #9) — likely ⛔ (cloud).
30. Fast-mode change announcement (2.1.218 #32) — recon OCC fast-mode surface.
31. Trust-dialog repo-root naming (2.1.218 #29).
32. MCP "needs authentication" over-count (2.1.218 #20) — claude.ai only, likely ⛔.
33. The 2.1.216 🟡 items carried forward: auto-mode 401 (#3), daemon lockfile (#11),
    GUI editor (#16), MCP re-auth (#19), spend-limit (#34), background `/mcp` park (#37).
34. `/working` command (2.1.218) — recon purpose.
35. `setScheduledTasksEnabled` / `classifierQueueDepth` settings — recon shape.

### Explicitly SKIPPED (do not port — no OCC counterpart / platform-only / codename)
- 2.1.218 #3 (Windows `\u` paths), #9 (cloud review), #10 (Bedrock billing), #18
  (Bedrock wizard), #20 (claude.ai connectors), #33 (server-managed settings),
  #37 (remote heartbeats); codename flags `GORSE_PLOVER`/`JUNIPER_SUNDIAL`,
  `fosterParentingEnabled`, `isWhiteboardEnabled`, `scriptingEnabled`.
- 2.1.216/2.1.217 already-skipped items per OCC-15 report (web/Chrome/Windows/
  PowerShell/VSCode/cloud/Bedrock-Opus/Claude Desktop/Remote Control).

## 6. Verification gate (implementer + acceptance reviewer)

- Every portable item must be **binary-verified** against the `2.1.218` ELF
  (`strings` + `grep -boF` + byte context), not invented — per
  `aligning-with-official-binary`. (The P0 boolean-token change is
  binary-verified: feature introduced in 2.1.218, absent in 2.1.217.)
- Behavioral e2e (not source-grep) per `behavior-driven-done`: `occ -p` for
  backend-touching items, tmux `capture-pane` for TUI items (P3 Stage 6).
  Hang-smoke (`occ -p "hi"`) after any feature-flag/allowlist change.
- Security review must cover the P2 DoS/race/trust items (#16 stack-overflow,
  #23 agent-hook trust, #22 retry-loop, #25 malformed-attachment, plus the
  carried-forward 2.1.216/217 symlink/brace items).
- Acceptance reviewer confirms: no skipped-portable item silently dropped, no
  invented cap/heuristic the official doesn't have, OCC-extra features stay OCC-specific.
- Release only after the full `git tag + npm publish + GitHub Release` three-step flow
  (per the issue's 发版流程) and `/releases` == `/tags` parity check.

## 7. Open questions for the next step

1. Does OCC implement `/ultrareview` and `/code-review ultra` tiers, or only base
   `/code-review`? (blocks 2.1.218 #8/#9/#26)
2. Does OCC have the `--ax-screen-reader` surface, fast-mode announcement surface,
   and `/working` command? (blocks 2.1.218 #2/#14/#32, /working)
3. OCC's auto-mode classifier + plan-mode-static-analyzer shape — does it share the
   official's "adjudicate dangerous-rm / bg-& / suspicious-path, no dialog" behavior
   already, or need the 2.1.218 change? (blocks P1 #5)
4. OCC's `/code-review` invocation path — can it run as a background subagent today?
   (blocks P1 #6)

These are recon questions, not blockers for the P0 headline work.

---

## 8. Status update — 2026-07-23 (post PR #199 / #200 / #203 / #204 / #206 / #207 / #208)

The §5 checklist has been substantially executed on `main`. This section supersedes
the "pending" markers above for the items listed. **Read this before porting anything
in §5 — duplicate avoidance.**

### Already landed on `main` (do NOT re-port)

**Via concurrent OCC-19 session PR #200 (commit `e9ee98c`):** 2.1.218 #34 (agent `:`-reject),
#36 (frontmatter bools), #35 (context:fork background), #19 (monotonic timing), #12
(engine teardown race), #13 (spurious `[Request interrupted]` + unpaired `tool_use`),
#27 (auto-mode dangerous-rm/bg-`&` auto-deny), #31 (plan+auto bash no-dialog), #29
(trust-dialog repo-root), #5 (mcp list HTTP status), #20 (MCP needs-auth over-count),
#3 (217 — MCP truncated-output memleak), #23 (agent frontmatter-hook folder trust),
#25 (malformed-delta attachment resume), #24 (fork-lineage after compaction); 2.1.216
#14 (Ctrl+X delete + no-resurrect), #18 (.claude symlink write-guard), #36 (/rewind
link/hardlink skip), 2.1.217 #13 (frontmatter brace-OOM), #5 (bg-session cwd
canonicalize), #4 (AskUserQuestion neutral), #2 (216 — message-normalization
quadratic), 2.1.217 #10 (--resume malformed attachment), #8 (216 — bg subagent
startup-window guard), #15 (216 — resumed bg agent restore), #12 (217 — bg-shell
stoppable), #16 (218 — fast-mode change announce), #7 (218 — /context stale
pre-compact). Deferred in #200: live-classifier gap (`CLAUDE_CODE_AUTO_MODE_CLASSIFIER_QUEUE`),
sandbox-IDE, `/code-review` background subagent.

**Via this session's PRs (all merged to `main`, squash):**
- PR #199 — P0: 2.1.218 #36 (frontmatter bools, superceded by #200's version on the
  overlapping hunks but consistent), #34 (agent `:` — #200's NFKC version is the one on
  main), #30 (`/deep-research` manual-only — no-op, grep-verified no auto-launch).
- PR #203 — 2.1.218 #21 (race-safe prompt-history writes: serialize + atomic, requeue
  on failure). **Unique — not in #200.**
- PR #204 — 2.1.218 #16 directory half (iterative guard for deeply-nested
  watched-directory tree traversal; BFS queue, injectable readdir, 50k-depth test).
  **Unique — not in #200.** (The "deeply nested UI trees" rendering half of #16 is
  still pending — TUI.)
- PR #206 — 2.1.217 #16 (login-expiry warning 5→3 days). **Unique.**
- PR #207 — 2.1.217 #2 (warn on transcript-write failure / session-saving-off, no
  silent loss). **Unique.**
- PR #208 — 2.1.218 #22 (no identical-retry on context-overflow + Ctrl+B background-shell
  caps). **Unique.**

**Closed as duplicates of #200 (do NOT resurrect):** PR #201 (monotonic timing),
PR #202 (context:fork background).

### Verification (per the sandbox-stall constraint)
- All merged slices verified by unit/integration TDD (RED→GREEN), `bunx biome lint`
  clean on changed files, `bun run build` succeeds (cli.js 28.74 MB, MACRO.VERSION
  injected). Post-merge fresh-`main` worktree: 696 pass / 0 fail on alignment dirs
  (`src/utils/__tests__`, `src/tools/AgentTool/__tests__`, `src/skills/__tests__`,
  `test/utils`, `test/tools`) + the 3 new test files. (1 pre-existing launcher test
  requires a built `dist/cli.js` — build-then-run order artifact, not a regression.)
- **tmux/REPL e2e NOT run on any slice this session** — the sandbox interactive-REPL
  stall (OCC-11, see CLAUDE.md) blocks it. Per the OCC-19 constraint, every slice
  above used an alternative verification: unit test (with mocked clock / mocked
  write failure / synthetic deep tree / threshold boundaries) + integration via the
  real parse/load path + binary diff (§3) for new-identifier confirmation. This is
  flagged for the acceptance reviewer to re-run under a non-sandbox REPL.

### Still pending (genuinely not yet on `main`)
- 2.1.218 #16 **UI-trees half** (deeply nested UI rendering stack guard) — TUI, tmux e2e.
- 2.1.218 #1 (`/code-review` as background subagent) — deferred in #200; recon OCC's
  `/code-review` + background path.
- 2.1.218 #2 (screen-reader deleted-text announce), #4 (left-arrow discard confirm),
  #6 (multi-line paste Ctrl+J — #200 touched `pasteNewlineDecoder`, verify if done),
  #14 (217 — transcript-preview one-line gap), #8 (217 — screen-reader fixes) — TUI/a11y, tmux.
- 2.1.216 #12 (Esc-Esc rewind picker in long sessions) — TUI, tmux.
- 2.1.216 #27 (slash-menu hot-reload of changed skills/commands), #28 (plugin-skill
  prefix in autocomplete), #30 (`/fork` one-line confirmation), #35 (216 — `/context`
  over-window warning + failed-`/compact` error; #200 did the stale-token half —
  verify the over-window + compact-error halves), #38 (dataviz bundled-skill content),
  #6 (@-mention attach after file-modifying hooks + statusline-twice-on-resume +
  resume-picker hang).
- 2.1.217 #9 (managed-OTEL governs all signals), #17 (frontend-design tip cap), #26
  (216 — Prometheus `# UNIT`), #29 (216 — telemetry permission-denial misreport).
- 🟡 assess items still open: 2.1.218 #8/#26 (`/ultrareview`), #17 (PR events lost),
  #28 (sandbox-IDE — deferred in #200), live-classifier gap (`classifierQueueDepth` /
  `CLAUDE_CODE_AUTO_MODE_CLASSIFIER_QUEUE` — deferred in #200), 2.1.216 #3 (auto-mode
  401), #11 (daemon lockfile `--any`), #16 (GUI editor mouse garbage), #19 (MCP
  re-auth), #34 (spend-limit), #37 (background `/mcp` park), #32/#33 (`/ultrareview` /
  `/code-review ultra`), `/working` command, `setScheduledTasksEnabled`.

### Release
A `2.1.277` release was cut (PR #205, `chore(release): 2.1.277`) on `main` (between
#204 and #206). The 发版 three-step (git tag + npm + GitHub Release) status should be
confirmed by the 验收员 before the final acceptance gate.

### §8.1 — Batch 2 landed (2026-07-23, PRs #210–#214): the "verifiable backend tail"

Per OCC Leader's batch-2 scope (telemetry cluster + `/context` #35 halves). All
**genuinely missing on main → ported**, TDD RED→GREEN, `bunx biome lint` clean,
`bun run build` green. Merged to `main` (squash) atop the 2.1.277 release. Remote
branches + worktrees cleaned.

| PR | Item | Verdict | Verification (sandbox-stall constraint) |
|----|------|---------|------------------------------------------|
| #210 | 2.1.217 #9 — managed `OTEL_EXPORTER_OTLP_ENDPOINT` governs all signals (lower-scope signal-specific overrides no longer redirect away) | ported | unit test, injected env/policyEnv (no network) |
| #211 | 2.1.216 #29 — telemetry: failed permission-prompt requests ≠ user rejections; user interrupts = aborts (not rejections) | ported | unit test, mock analytics sink + pure SDK-classification functions |
| #212 | 2.1.217 #17 — frontend-design suggestion tip capped at 3 lifetime impressions | ported | unit test, in-memory config seam |
| #213 | 2.1.216 #26 — Prometheus exporter no longer emits invalid `# UNIT` lines (OCC DOES have the surface: `@opentelemetry/exporter-prometheus`) | ported | unit test, `stripUnitLines` pure helper + serializer-patch factory |
| #214 | 2.1.216 #35 halves — `/context` explicit over-window warning + failed `/compact` renders as error (stale-token half was #200's 2.1.218 #7 — untouched) | ported | unit test, mock token-counter/compaction + render-logic; render flagged for 验收员 non-sandbox e2e |

Post-merge fresh-`main` worktree: 507 pass / 0 fail on the affected dirs
(`src/utils/telemetry`, `src/services/tips/__tests__`, `src/commands/context/__tests__`,
`src/commands/compact/__tests__`, `src/hooks/toolPermission/__tests__`,
`src/utils/__tests__`, `src/tools/AgentTool/__tests__`); `bun run build` green
(cli.js 28.75 MB). No tmux/REPL e2e this batch (OCC-11 sandbox stall) — every slice
unit-tested at the logic/render layer; flagged for 验收员 non-sandbox e2e.

**These move from §8 "Still pending" to "Already landed".** Remaining pending tail is
unchanged from §8 "Still pending" minus the five items above: TUI/a11y cluster
(218#16 UI half, #1, #2, #4, #6, #14; 217#8; 216#12/#27/#28/#30/#38/#6), the 🟡 assess
items, and the #200-deferred items (live-classifier gap, sandbox-IDE, `/code-review`
background).

### §8.2 — Assess batch (2026-07-24, PRs #216–#219): port/skip verdicts

The 🟡 assess items from §8 are now resolved. Recon-first per item; PORT only where
OCC has the affected surface and the fix wasn't already done. All PORTs TDD
RED→GREEN, `bunx biome lint` clean, `bun run build` green; merged to `main` (squash)
atop 2.1.277. Remote branches + worktrees cleaned.

| Item | Verdict | PR | Note |
|------|---------|----|------|
| 218#8 `/ultrareview` descriptive args → review note | PORT | #216 | text passed as `BUGHUNTER_REVIEW_NOTE` env (only OCC-controlled channel into cloud bughunter) |
| 218#26 `/ultrareview` correctable-error feedback | ALREADY DONE | #216 | recoverable errors already return `ContentBlockParam[]`; characterized |
| 216#32 `/ultrareview` diff-too-large error shows limits + size + largest files | PORT | #216 | surfaces bundle limit + `--shortstat` size + top-5 `--numstat` files |
| 216#33 `/code-review ultra` empty-diff names base ref | ALREADY DONE (base-ref) + SKIP (explicit-base) | #216 | OCC has no `/code-review ultra` command; suggesting a non-existent feature would mislead |
| 216#19 MCP re-auth revokes working creds before new sign-in | PORT | #217 | `reauthenticateWithSafeOrdering` — sign-in first, revoke old only on success |
| 216#19 bg reconnect needs-auth → unusable command | SKIP | #217 | OCC bg path emits generic `needs-auth` (no `/mcp` ref); `/mcp` suppressed in bg; bug absent |
| 216#37 bg `/mcp` + `/install-github-app` park needs-input | SKIP | #217 | both are `local-jsx` commands filtered out in headless; "no client attached" unreachable |
| 216#11 `daemon stop --any` stale-lockfile kills unrelated proc | ALREADY DONE | #218 | `displaceHolder()` validates PID via `getProcessStartMs`+start-time match before kill; characterized |
| 216#3 auto-mode 401 classifier error → denial | PORT | #218 | `isClassifierAuthError()` re-throws 401/403 as auth error (→ re-auth), not a command denial |
| 216#16 GUI editor mouse/focus garbage; `/memory` non-blocking | PORT | #219 | `guiEditorHandoff` disables mouse/focus/modifyOtherKeys around editor launch; `/memory` detached non-blocking |
| 218#28 sandbox-IDE command restrictions | SKIP | #219 | OCC's sandbox is BashTool fs/network egress; the IDE *connector* doesn't route commands through OCC's sandbox — not portable |

**Clear SKIPs (no OCC counterpart / internal feature flag — no PR needed):**
- live-classifier gap (`CLAUDE_CODE_AUTO_MODE_CLASSIFIER_QUEUE` / `classifierQueueDepth`) — #200-deferred internal classifier-queue flag; OCC's `BASH_CLASSIFIER` is a simpler stub; porting would invent the feature. SKIP.
- `setScheduledTasksEnabled` setting — internal feature flag for scheduled-tasks gating; OCC's cron is always-on infra, no gated surface. SKIP.
- 218#17 PR events lost on session exit — OCC has no PR-event lifecycle (`prEvent`/`linkPullRequest`/`createPullRequest` grep = 0). SKIP.
- 216#34 spend-limit adjustment shows server's reason — server-side spend-limit; OCC has no spend-limit surface (`spendLimit` grep = 0). SKIP.
- 218 `/working` command — OCC has no `/working` command; new official command OCC doesn't replicate. SKIP.

Post-merge fresh-`main` worktree: 843 pass / 0 fail on affected dirs
(`src/commands/review`, `src/cli/handlers`, `src/services/mcp`, `src/daemon`,
`src/utils/permissions`, `src/ink/termio`, `src/commands/memory`, `src/utils`);
`bun run build` green (cli.js 28.76 MB). No tmux/REPL e2e this batch (OCC-11 sandbox
stall) — PORTs unit-tested at the logic/helper layer; the GUI-editor handoff (#16)
and render-touching fixes are flagged for 验收员 non-sandbox e2e.

**Assess is now closed.** Remaining pending tail = TUI/a11y cluster only
(218#16 UI half, #1, #2, #4, #6, #14; 217#8; 216#12/#27/#28/#30/#38/#6) — the next
batch (recon-based port + alternative verification, OCC-11 e2e deferred per item).

### §8.3 — TUI/a11y batch (2026-07-24, PRs #221–#225): final alignment cluster

The last pending cluster (TUI/a11y, §8 "Still pending"). Recon-first per item;
PORT only where OCC has the surface and the fix wasn't already done. All PORTs
TDD RED→GREEN, `bunx biome lint` clean, `bun run build` green; merged to `main`
(squash) atop 2.1.277. Remote branches + worktrees cleaned.

| Item | Verdict | PR | Note |
|------|---------|----|------|
| 218#2 screen-reader deleted-text announce (word/line deletions) | PORT | #221 | `announceDeletedText` on kill-handlers (Ctrl+W/Cmd+Backspace/Ctrl+U/Option+Delete) in ax-screen-reader mode |
| 218#14 VoiceOver "new line" vs typed space | PORT | #221 | `srEchoTypedChar(' ')` returns `' '`; insert path echoes trailing space |
| 217#8 startup announce cut off + thinking-row re-render | PORT | #221 | startup announce routed through SR queue; thinking-row gated to on-change only + reduced-motion in SR mode |
| 218#6 multi-line paste Ctrl+J | ALREADY DONE | #222 | `decodePastedNewlines` already decodes kitty CSIu newline codepoints (incl. 106=`j`) to `\n`; characterized |
| 218#4 left-arrow discard confirm + Esc agent-view | ALREADY DONE | #222 | `messageActionsLeftArrowGate` already gates discard-after-edit; `exitTeammateView` already returns to backgrounded conversation; 9 new characterization tests |
| 216#27 slash-menu hot-reload | ALREADY DONE | #223 | chokidar → `clearSkillCaches`+`clearCommandsCache` → `skillsChanged` → `useSkillsChange` → `useTypeahead` already wired; characterized |
| 216#28 plugin-skill prefix in autocomplete | PORT | #223 | `pluginSkillUserFacingName` always returns plugin-qualified name (was dropping `plugin:` prefix when `name` frontmatter set) |
| 216#30 `/fork` one-line confirmation | PORT | #223 | `formatForkConfirmation(name, sessionId, sharesCheckout)` — one line with name + `claude attach` id + shares-checkout note |
| 218#16 UI-trees half (deeply-nested render stack guard) | PORT | #224 | Ink `renderNodeToOutput`↔`renderChildren` mutual recursion → iterative driver (heap stack of closures); 5 recursive walkers de-recursed; 10k/30k-level trees no longer overflow |
| 216#38 dataviz skill content | SKIP | #224 | OCC ships dataviz as a builtin `/dataviz` **command** (prompt), NOT the official dataviz **SKILL** with `references/palette.md` + four-series guidance — no palette/guidance to port; characterized |
| 216#6 @-mention empty after hooks + vim dot-repeat + statusline-twice + resume-picker hang | PORT (all 4 sub-bugs) | #225 | `hookReadFileStateGate` (#6a); vim `c`-operator dot-repeat + paste (#6b); `statusLineUpdateGate` (#6c); `resumeFailureGate` (#6d) |
| 216#12 Esc-Esc rewind picker in long sessions | ALREADY DONE | #225 | `escEscGate` already opens rewind on idle Esc-Esc with bg tasks; characterized |
| 218#1 `/code-review` as background subagent | PORT | #225 | wired `/code-review` to background-subagent dispatch (the #200-deferred item); 2 RED→GREEN |

Post-merge fresh-`main` worktree: 510 pass / 0 fail on TUI-affected dirs
(`src/components/PromptInput/__tests__`, `src/ink/__tests__`, `src/utils/__tests__`,
`src/commands/__tests__`, `src/services/tools/__tests__`, `src/vim/__tests__`,
`src/skills/__tests__`, `src/hooks`); `bun run build` green (cli.js 28.76 MB).

**Verification (OCC-11 sandbox-stall constraint — every item noted, no silent
skip):** no tmux/REPL e2e this batch. PORTs unit-tested at the logic/decision
layer (pure helpers + mock sinks + synthetic deep UI tree + content assertions).
Live-render / keystroke / SR-speech / paste-in-TTY behavior is **DEFERRED to
验收员 non-sandbox acceptance e2e** — specifically: 218#2/#14/217#8 SR render,
218#6 live paste, 218#4 live left-arrow/Esc, 216#27 live slash-menu, 216#30
live `/fork` row, 218#16 live TTY render, 216#6 live statusline/resume-picker/vim,
218#1 live `/code-review` background dispatch.

**TUI/a11y cluster is now CLOSED.** Combined with §8.1 (batch-2 verifiable backend
tail) + §8.2 (assess) + the earlier P0/P1/P2 slices, all of `2.1.218`/`2.1.216`/`2.1.217`
portable items are now on `main`. The ONLY remaining gate is the 验收员 non-sandbox
acceptance e2e (OCC-11 environment block, deferred-with-reason per the execution
discipline) + the final security scan + release.
