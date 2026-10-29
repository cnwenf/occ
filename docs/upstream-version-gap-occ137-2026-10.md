# Upstream version gap — OCC-137 round (official claude-code 2.1.312 — no-op fork-point self-acceptance)

Date: 2026-10-30 · Trigger: OCC Leader first-baton order (comment `8f04e4b2`) · Issue: OCC-137

## §1 Version facts (three-way verified, 2026-10-30)

| Source | Value |
|---|---|
| npm dist-tags `@anthropic-ai/claude-code` | `latest` = `next` = **2.1.312** (published 2026-10-27T18:36:10Z); `stable` = 2.1.308 |
| Official GitHub tags `anthropics/claude-code` | newest = **v2.1.312** |
| OCC pre-round | package.json **2.1.406**, tracks **2.1.312** (OCC-136 round, merge `624c5adf`) |
| v312 linux-x64 ELF | 293,592,432 B (re-downloaded this round for byte verification) |

**Verdict: NO version gap.** Official latest (2.1.312) == OCC tracked upstream (2.1.312). Per the
issue's "版本追齐后的自验收" branch, this round is a strict self-acceptance + interaction-consistency
round against the official `2.1.312` binary — not a port round.

## §2 Method

- Built OCC (`bun run build` → `dist/cli.js` 30.58 MB, `OCC 2.1.406`).
- Downloaded the official 2.1.312 linux-x64 ELF (`npm pack`, read-only `strings`/`--help` — never
  executed as a model backend) for byte-exact comparison.
- Drove the OCC REPL via tmux (Architecture A per `repl-tmux-e2e-testing`) with real coding tasks.
- Compared the CLI/REPL interaction surface (help text, flags, slash commands, error handling,
  tool round-trips) OCC vs official.

## §3 Self-acceptance evidence (all GREEN)

Unit / component:
- 312-round unit tests: **107 pass / 0 fail / 276 expect()** (effortSuffix, sendNowHintClick,
  gjGkRowsRunOut, hookSessionSlots, hookTimeoutFloor, startOnlyGuard, skillCdRediscovery,
  verifyMenuDescription, rateLimitMessages, cleanupFreshToolResults).
- MCP suites (`src/commands/mcp` + `src/services/mcp`): **617 pass / 0 fail / 1933 expect()**.

e2e (built `dist/cli.js`):
- `occ-versioning` + `commands-alignment` + `verify-reachability`: **7 pass**.
- `repl-interactive` (Shift+Tab mode cycling + panel dismiss): **3 pass**.
- `mcp-connection-nonblocking` + new `mcp-help-transport-312`: **10 pass** combined regression.

Headless `-p` (live glm-5.2 endpoint; `[claude-code:unrecognized_model]` warning expected/benign):
- `echo "Reply with exactly one word: PONG" | bun dist/cli.js -p` → `PONG`, exit 0.

Real REPL tasks (tmux 200×50, built artifact, poll-until-text — like a human user):
- **Boot**: ready in ~2 s — welcome panel, `glm-5.2 with xhigh effort`, cwd, dual-auth warning
  (both `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY` set), effort indicator `● high · /effort`
  (item 9/16 semantics), `⏵⏵ auto mode on (shift+tab to cycle)`, token counter, version footer.
- **Task 1** (Write+Bash): "create fib.py with fib(n), run fib(10)" → `● Write(fib.py)` (auto-mode
  approved) → loaded ecc python rules → `● Bash(python3 fib.py)` → `Output: 55`. File verified:
  type hints + docstring + `ValueError` guard; `python3 fib.py` → `55`. ✓
- **Task 2** (multi-step): "add type hints and a test for fib" → `● Write(fib.py)` +
  `● Write(test_fib.py)` + `● Bash(pytest …)` → "All 2 tests pass". test_fib.py verified: AAA
  pattern, fib(0,1,2,10,20) + negative-input `pytest.raises`. ✓
- **Task 3** (post-fix build): "21 times 2?" → `42` round-trip. ✓
- **Shift+Tab mode cycling**: auto → manual (`⏸ manual mode on · ? for shortcuts`) → acceptEdits
  (`⏵⏵ accept edits on`). ✓
- **Invalid slash command**: `/notarealcommand` → `Unknown command: /notarealcommand` (clean). ✓
- **Slash palette**: typing `/status` renders the autocomplete menu with descriptions; Enter runs
  `/status` → full status panel (Status/Config/Usage tabs: Version 2.1.406, Session ID, cwd, auth,
  base URL, Model glm-5.2, MCP servers, setting sources). ✓
- **Clean exit**: Esc → Ctrl-C ×2; tmux session killed, no leaks. ✓

## §4 Interaction-consistency vs official 2.1.312

### §4.1 Top-level `--help` flag surface — consistent (modulo documented trims)

Token-level diff of all long flags (official 71 / OCC 64). Every official-only flag is a
**documented, forensically-justified** trim or stage — no new undocumented gap:

| Official-only flag | Status | Source |
|---|---|---|
| `--cloud` / `--environment` / `--desktop` / `--teleport` | backend/cloud/desktop surfaces — N-A trim | occ110/111; occ136 §3 |
| `--restricted` | STAGED (large cross-cutting security mode; dedicated round) | occ107/108 §6 |
| `--permission-prompts` | STAGED P0 (awaiting `permission_denied` stream-shape forensics) | occ114 Gap-114a |
| `--system-prompt-snapshot` | STAGED (depends on rollout-gated system-prompt-recording base OCC lacks; flag-only port = fake surface) | occ117 §5.5 |
| `--all` | tied to official `respawn` bg-session subcommand — OCC uses `daemon`/`agents` subcommands | CLAUDE.md OCC-21 |

OCC-only flags `--dangerously-skip-protected-paths` / `--definitions` are OCC-specific (not
force-aligned). `--permission-prompt-tool` and `--teleport` are registered in OCC (hideHelp) —
verified: OCC accepts `--permission-prompt-tool` (resolves the MCP tool) rather than rejecting it.
This **reproduces the occ117 §5 self-acceptance flag audit exactly** — the surface has not drifted.

### §4.2 Subcommand `--help` — `mcp` / `mcp add` byte-identical (modulo binary name + wrap)

`mcp --help` and `mcp add --help` match official byte-for-byte after `claude`→`occ` normalization
(leaf-subcommand help is pinned to `helpWidth: 80`, per CLAUDE.md Gap-5). One content divergence
found and **fixed this round** (§4.3).

### §4.3 GAP FOUND + FIXED — MCP help-text transport strings (LOW, documented-since-occ108)

Two MCP help strings had drifted from official 2.1.312. First noted in
`docs/upstream-version-gap-occ108.md` §5 ("`mcp add --header` / `add-json` 帮助文本写错
transport", categorized 帮助文本/小) and carried (结转) through occ109 — never fixed until now.

Both replacements are **byte-exact from the official 2.1.312 ELF** (`strings -n 8 package/claude`),
and OCC's real functionality matches them (verified live, not assumed):

| Site | OCC (before) | Official 2.1.312 (= OCC after) |
|---|---|---|
| `mcp add-json` description (`src/main.tsx:4557`) | `Add an MCP server (stdio or SSE) with a JSON string` | `Add an MCP server (stdio, SSE, HTTP, or WebSocket) with a JSON string` |
| `mcp add -H/--header` description (`src/commands/mcp/addCommand.ts:63`) | `Set WebSocket headers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")` | `Set headers for HTTP/SSE servers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")` |

Functional truthfulness check (per `aligning-with-official-binary` — don't port text that overstates
capability):
- `add-json` accepts **stdio / sse / http (streamable-http alias) / ws** — `McpServerConfigSchema`
  enum (`src/services/mcp/types.ts:26`). Verified live: `occ mcp add-json` stored all four and
  `occ mcp list` rendered them as `(HTTP)` / `(SSE)` / `(WS)`. So "(stdio, SSE, HTTP, or
  WebSocket)" is truthful; the old "(stdio or SSE)" **understated** OCC.
- `-H/--header` sets headers for HTTP/SSE servers (the sibling `--client-id` already reads "OAuth
  client ID for HTTP/SSE servers"); "Set WebSocket headers" was simply **wrong**.

TDD: new behavioral e2e `test/e2e/mcp-help-transport-312.e2e.test.ts` (2 tests) asserts the
official strings on the built CLI's `--help` render (whitespace-normalized for wrap) + the absence
of the stale strings. RED before the fix, GREEN after.

### §4.4 `--version` — by-design divergence (unchanged)

Official: `2.1.312 (Claude Code)`. OCC: `OCC 2.1.406`. OCC brands itself and versions its own
releases above the 2.1.214 baseline (CLAUDE.md). Not a gap.

## §5 Diff landed this round

```
src/commands/mcp/addCommand.ts | 2 +-   (-H/--header description → HTTP/SSE)
src/main.tsx                   | 2 +-   (add-json description → stdio, SSE, HTTP, or WebSocket)
test/e2e/mcp-help-transport-312.e2e.test.ts | new (2 behavioral e2e)
```

Build GREEN post-fix (`dist/cli.js` 30.58 MB, `OCC 2.1.406`); headless `-p` PONG + tmux REPL real
task (21×2=42) re-verified on the post-fix build.

## §6 STAGED follow-ups (unchanged — no new stage this round)

Item 18 (simple-system-prompt for unrecognized provider model names), item 4 velvet_possum
top-level-cut sub-part, `--restricted`, `--permission-prompts none`, `--system-prompt-snapshot`,
`CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS`, and the occ135/occ136 §6 backlog all remain
staged with their existing per-site forensics. The occ138 F5 candidate (`mcp add/add-json/remove`
config-write failure still reports success — security-adjacent silent-failure) is noted for a
future round; not in scope here (this round is help-text only).

## §7 Release

No OCC version bump this round beyond the fix landing on `main`. Per the OCC-40 no-op-fork-point
precedent, a round that ports no new upstream version does not cut a fresh tracking release; the
§4.3 help-text fix rides the next release cut (验收员 → 发版流程). CHANGELOG entry deferred to the
release step so `/releases` is not polluted with a no-op tracking bump.
