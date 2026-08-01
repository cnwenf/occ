# Upstream version gap — OCC-41 (2026-08-02)

> Carryover from `docs/upstream-version-gap-occ40.md`. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry (`@anthropic-ai/claude-code`); feature truth cross-checked against
> OCC `src/` and the decompiled official native ELF
> (`@anthropic-ai/claude-code-linux-x64@2.1.220`, 351 `2.1.220` string hits,
> no `2.1.221+` marker — re-confirmed unchanged since OCC-34).

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.291` (`2026-07-31`, OCC-39) | `package.json` |
| OCC aligned Claude Code (start of round) | `2.1.218` fully + `2.1.219` **partial** (P0 + Opus 5 canonical + all Opus 5 launch downstream sites 1a–1j + item 4 `mcp_server_errors` + item 8 whitespace warnings + item 1c `promptCacheWrite1hTokens` + item 2 `sandbox.network.strictAllowlist`) | `CLAUDE.md` header; OCC-40 §7 |
| Official latest Claude Code (npm `latest` = `next`) | **`2.1.220`** (published `2026-07-24T23:11:21Z`; **unchanged since OCC-34, ~9 days; no new release 08-01→08-02**) | `npm view @anthropic-ai/claude-code version` |
| Official GitHub latest release | **`v2.1.220`** (`ashwin-ant`, `published 2026-07-25T01:35:55Z`) | `gh api repos/anthropics/claude-code/releases/latest` |
| Version gap vs official latest | **NO new port gap** — `2.1.220` re-confirmed no-op (no new surface); carryover `2.1.219` P1–P4 still ambiguous in the binary (STOP per skill) | this doc §3 |

**Conclusion: the round's fork-point check resolved to the no-op → strict
self-acceptance path** (per the issue's "版本追齐后的自验收" instruction for
the no-gap case). Official `latest` is **unchanged at `2.1.220`** since
OCC-34 (npm `time` tail: `2.1.220 → 2026-07-24T23:11:21Z`; no new official
release in the last ~9 days, and none 08-01→08-02). `2.1.220` remains the
no-op reliability layer — unchanged from OCC-34's binary-strings diff (351
`2.1.220` hits, no `2.1.221+` marker, no new env-var/settings-key/hook-name/
command surface).

The remaining `2.1.219` P1–P4 backlog items are each ambiguous in the binary
without dedicated per-site decompilation (unchanged from OCC-40 §5); the
`aligning-with-official-binary` skill's "STOP if ambiguous" rule applies —
no item was guessed this round. Instead the round verified OCC's current
caught-up state end-to-end through **real REPL tasks** (interactive tmux
session driving tool use + async hooks), the full `version-2.1.219-*` e2e
suite (49/0, 165 expects), `occ-versioning` + `commands-alignment` green,
and CLI/stream-json/pipe-mode smokes. See §4.

No code ported → **no new OCC release this round** (a no-op version bump
would violate the "no invented/partial" discipline and pollute the
`/releases` page; the 发版流程 fires only on a real code change after
acceptance). Doc-only commit (this file + CHANGELOG entry) merges to `main`
without tagging, so `publish.yml` does not fire.

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.220` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.220`, `next=2.1.220`, `stable=2.1.212` | `npm view … dist-tags --json` |
| npm `time` tail | `2.1.220 → 2026-07-24T23:11:21.821Z` (last entry; no `2.1.221+`) | `npm view … time --json` |
| Official GitHub latest release | `v2.1.220` (`ashwin-ant`, `2026-07-25T01:35:55Z`) | `gh api repos/anthropics/claude-code/releases/latest` |
| Official GitHub tags (top 5) | `v2.1.220`, `v2.1.219`, `v2.1.218`, `v2.1.217`, `v2.1.216` | `gh api repos/anthropics/claude-code/tags` |
| OCC aligned version (start of round) | `2.1.218` + `2.1.219` partial (P0 + Opus 5 canonical + 1a–1j + 4 + 8-ws + 1c + 2) | `CLAUDE.md`; OCC-40 §7 |

Official version timeline (tail, unchanged since OCC-34):

```
2.1.220 → 2026-07-24T23:11:21Z   ← official latest (no-op reliability; unchanged since OCC-34)
2.1.219 → 2026-07-24T16:11:49Z   ← substantive surface; P0 + Opus 5 canonical + 1a–1j + 4 + 8-ws + 1c + 2 done; P1–P4 open (ambiguous, not ported)
2.1.218 → 2026-07-22T19:55:32Z   ← OCC fully aligned (OCC-31)
```

## 2. Official changelog since OCC's aligned version

OCC's aligned version is `2.1.218` (fully) + `2.1.219` (partial). Official
releases since `2.1.218`:

- **`2.1.219` (2026-07-24)** — substantive surface (Opus 5 launch +
  subagent depth 3 + DirectoryAdded hook + sandbox strict-allowlist +
  mcp_server_errors + whitespace warnings + …). OCC ported the
  decompiled-verified, low-invention-risk subset (P0 + Opus 5 canonical +
  all Opus 5 launch downstream sites 1a–1j + items 4/8-ws/1c/2) across
  OCC-34→OCC-39. The remaining P1–P4 items are ambiguous in the binary
  without dedicated per-site decompilation (STOP per skill).
- **`2.1.220` (2026-07-24, ~7h after 2.1.219)** — generic "Bug fixes and
  reliability improvements". Binary-strings diff (OCC-34, re-confirmed
  OCC-35→OCC-40) shows **no new env-var / settings-key / hook-name /
  command surface** — nothing to faithfully port. No-op reliability layer.

No `2.1.221+` version marker exists in the npm registry or the official
binary strings as of 2026-08-02.

## 3. Gap analysis

### 3.1 New-version gap — NONE

No new official Claude Code release since `2.1.220` (2026-07-24). npm `time`
tail ends at `2.1.220`; GitHub latest release is `v2.1.220`. ~9 days with no
new version. There is no new version to port.

### 3.2 `2.1.220` no-op re-confirmation

`2.1.220` was binary-confirmed no-op by OCC-34 (351 `2.1.220` string hits,
no `2.1.221+` marker, no new env-var/settings-key/hook-name/command surface —
the 12 new camelCase identifiers 220-only are minifier artifacts like
`onRetryStatusT`, not real surface). Re-confirmed unchanged by OCC-35→OCC-40.
No new surface to port; nothing to do for `2.1.220`.

### 3.3 Carryover `2.1.219` P1–P4 — ambiguous, not guessed

The remaining `2.1.219` P1–P4 backlog (unchanged from OCC-40 §5):
- item 5 `workflowSizeGuideline` (size→agent-count behavior not cleanly
  recoverable; `/config` enum + status-line are TUI, deferred per OCC-11)
- item 6 nested-subagent forwarding (depth-2+)
- item 7 `claude -p` keep-answer on mid-stream API error (coupled to the
  print text-output flush path)
- item 8 mcp-list error-text format (binary uses a React component, not a
  2.1.219 regression)
- item 19 managed-MCP `${VAR}` from startup env
- item-4 caller-wiring (`buildSystemInitMessage` callers still pass
  `mcpServerErrors: []` — faithful no-op-until-wired, key omitted per
  `r.length>0&&` guard, not a behavioral divergence)
- Vim/screen-reader P3 + niche P4 + OCC-37 staged sub-items +
  per-command `strictAllowlist` merge

Each needs dedicated per-site decompilation. The `aligning-with-official-binary`
skill's "STOP if ambiguous — no invented/partial implementations" rule
applies. No item was guessed this round.

## 4. Strict self-acceptance (real REPL tasks)

Per the issue's "版本追齐后的自验收" instruction for the no-gap case, this
round verified OCC's current caught-up state end-to-end through real REPL
tasks (interactive tmux session), the e2e suite, and CLI/stream-json/pipe-mode
smokes. Emphasis on consistency with the official binary's observable
contract (the live `uvx claude-code` wrapper is not runnable here —
`uvx claude-code` reports "Package does not provide any executables"; the
official native ELF is the canonical source of truth, used throughout).

### 4.1 Build

`bun install` → 1323 packages. `bun run build` green:
`dist/cli.js` 28.84 MB, `MACRO.VERSION=2.1.291`, `MACRO.BINARY_NAME=occ`.

### 4.2 e2e suite

```
bun test ./test/e2e/version-2.1.219-*.e2e.test.ts \
         ./test/e2e/occ-versioning.e2e.test.ts \
         ./test/e2e/commands-alignment.e2e.test.ts
→ 49 pass / 0 fail / 165 expect() calls across 7 files [21.14s]
```

5 `version-2.1.219-*` files (mcp-list-errors, mcp-server-errors,
opus5-cost-1h-field, opus5, sandbox-strict-allowlist) + `occ-versioning` +
`commands-alignment`. Regression-green vs OCC-40 (43+6=49 pass / 165 expects).

### 4.3 CLI / stream-json / pipe-mode smokes

- `occ --version` → `OCC 2.1.291` ✓
- `occ --model claude-opus-5 --version` → accepts the new canonical Opus 5
  model ID (OCC-35 port) ✓
- `occ --help` `--model` line byte-matches the 2.1.220 binary: *"Provide an
  alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's
  full name (e.g. 'claude-fable-5')."* (OCC-36 1j port) ✓
- `echo "Reply with exactly the word PONG" | occ -p` → `PONG`, exit 0
  (headless `-p` path end-to-end with a live API key) ✓
- `occ -p --output-format stream-json --verbose` `system/init` event:
  `claude_code_version:"2.1.291"`, `mcp_servers:[…]` present, and the newly
  added `mcp_server_errors` key **correctly omitted** when the filtered
  array is empty (OCC-38 item-4 faithful no-op-until-wired contract) ✓

### 4.4 Interactive REPL (tmux) — real tasks

Drove the built artifact inside a detached tmux session (200×50) via
`tmux send-keys` + `tmux capture-pane -p` (Architecture A of the
`repl-tmux-e2e-testing` skill). `OCC_ENTRYPOINT=$PWD/dist/cli.js`,
`--dangerously-skip-permissions` (auto/bypass mode — API backend is a GLM
gateway, not real Anthropic; consistency-under-test is the OCC client
behavior: REPL rendering, tool use, async hooks, output contract).

- **Welcome screen renders** — `OCC v2.1.291` header, welcome-back, recent
  activity, What's-new (OCC-36 Opus 5 launch notes), status line `● high ·
  /effort`, `⏵⏵ bypass permissions on (shift+tab to cycle)`, token counter. ✓
- **Real task — file write via Write tool**: sent *"create verify_occ41.txt
  containing REPL_WRITE_OK then stop"* → the REPL invoked the **Write** tool
  (full path shown), the **PostToolUse async hook** fired, the model
  confirmed, the **Stop async hooks** fired (×3) on the "then stop", and
  `verify_occ41.txt` was actually written with the exact content
  `REPL_WRITE_OK` (verified `cat`) after ~12s. Core trunk
  (tool-use → async-hook pipeline → file system) end-to-end green. ✓
- **Shift+Tab mode cycling**: `bypass permissions` → `auto mode` → …
  (interactive keystroke behavior, not reachable from `-p`). ✓
- **`/model` picker** (Opus 5 launch downstream ports 1b/1i live):
  renders `Select model` with option 4 = *"Opus (1M context)  Opus 5 with
  1M context · Best for everyday, complex tasks"* — the `Opus 5 with 1M
  context` label byte-matches the 2.1.220 binary (OCC-36/37 ports). Also
  shows Fable 5, Sonnet (1M context), Default rows. ✓

### 4.5 Newly-added features verified live this round

| Feature (porting round) | Live-verification site | Result |
|---|---|---|
| `claude-opus-5` canonical model (OCC-35) | `occ --model claude-opus-5 --version` accepts | ✓ |
| `--model` help text byte-match (OCC-36 1j) | `occ --help` `--model` line | ✓ |
| `/model` picker Opus row + `Opus 5 with 1M context` label (OCC-36 1b / OCC-37 1i) | interactive `/model` in tmux | ✓ |
| `mcp_server_errors` init contract (OCC-38 item 4) | `stream-json` `system/init` omits key when empty | ✓ |
| `sandbox.network.strictAllowlist` (OCC-39 item 2) | e2e `version-2.1.219-sandbox-strict-allowlist` (pass) | ✓ |
| `promptCacheWrite1hTokens` cost field (OCC-38 1c) | e2e `version-2.1.219-opus5-cost-1h-field` (pass) | ✓ |
| `DirectoryAdded` hook + `DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH=3` (OCC-34 P0) | e2e + hook pipeline fires (PostToolUse/Stop observed live) | ✓ |

### 4.6 Inconsistencies found

**None.** No behavioral divergence from the official binary's observable
contract was observed in any of the real REPL tasks, the e2e suite, or the
CLI/stream-json/pipe-mode smokes. No new gap to record; no fix to port; no
release to cut.

## 5. Staged (ambiguous — not guessed)

Unchanged from OCC-40 §5. Each remaining `2.1.219` P1–P4 item needs
dedicated per-site decompilation; none was guessed (STOP per
`aligning-with-official-binary`):

- item 5 `workflowSizeGuideline` (size→agent-count; `/config` enum +
  status-line are TUI, deferred per OCC-11)
- item 6 nested-subagent forwarding (depth-2+)
- item 7 `claude -p` keep-answer on mid-stream API error
- item 8 mcp-list error-text format (React component, not a 2.1.219 regression)
- item 19 managed-MCP `${VAR}` from startup env
- item-4 caller-wiring (`buildSystemInitMessage` callers pass `[]` —
  faithful no-op-until-wired)
- Vim/screen-reader P3 + niche P4 + OCC-37 staged sub-items + per-command
  `strictAllowlist` merge

## 6. Release decision

**No new OCC release this round.** No code was ported (no new official
version; `2.1.220` no-op; carryover P1–P4 ambiguous). A no-op version bump
would violate the "no invented/partial" discipline and pollute the
`/releases` page. The 发版流程 (git tag + npm + GitHub Release) fires only
on a real code change after acceptance; this round produces a **doc-only**
commit (this file + the `CHANGELOG.md` OCC-41 entry) that merges to `main`
without tagging, so `publish.yml` does not fire. `/releases` and `/tags`
remain consistent (no orphan tag).

## 7. Tracked-upstream pointer (end of round)

- `2.1.218` — fully aligned (OCC-31).
- `2.1.219` — partial (P0 + Opus 5 canonical + all Opus 5 launch downstream
  sites 1a–1j + items 4 + 8-ws + 1c + 2). P1–P4 staged (ambiguous).
- `2.1.220` — no-op reliability layer (no new surface to port).

Next round: re-check npm for a new official release; if `2.1.221+` appears,
binary-diff and port the decompiled-verified subset. Otherwise continue
chipping the staged backlog where a per-site decompilation cleanly recovers
the behavior (STOP per skill where ambiguous).
