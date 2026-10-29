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

## §8 Re-acceptance round (2026-10-30, 验收员 verdict 打回 on PR #561)

验收员 verdict (comment `3b294ea1`): PR #561 merged state verified (diff 4 files/198+/2−, help-text
byte-aligned, e2e 2/2, README badge 4-spot consistent, code review no P1) but **打回 NEEDS_FIXES**
for 2 gaps. Both fixed this round:

### §8.1 Gap-137b (HIGH, security) — `mcp add` confirm output leaked header values in plaintext

Official 2.1.312 prints `Headers: ${JSON.stringify(uxn(w),null,2)}` in the `mcp add` sse/http
confirm path, where `uxn` is a **name-only, display-only** redactor. OCC printed
`jsonStringify(headers, null, 2)` raw at `src/commands/mcp/addCommand.ts` (sse + http branches) —
`Authorization: Bearer sk-…` echoed to stdout/terminal history/CI logs.

**Byte-verified official mechanism** (re-extracted from the 2.1.312 ELF this round — `grep -aboF`
offsets: `uxn` @239000754; `pt` @127878240/@270488163; `O6e`/`Nlt`/`lBe`/`tto` module windows
@238880000/@238960000):

- `uxn(e)` — builds a NEW null-prototype record; for each entry, value → `"[REDACTED]"` when
  `pt.test(name)`, else verbatim. Never mutates; never inspects values.
- `pt` — `new RegExp(O6e(String.raw` + alternation + `),"i")`, **UNANCHORED** (substring match):
  `api[_-]?key|secret|token|password|passwd|credential|bearer|authorization|auth[_-]?header|memory[_-]?request[_-]?mac|cookie|session[_-]?(?:id|key)|connection[_-]?string|(?:private|ssh|encryption|signing|access|deploy|master|license)[_-]?key|client[_-]?secret`
- `O6e` — invisible-char hardener: inserts `Nlt` between adjacent pattern letters and rewrites
  every `[_-]?` into `(?:[_-]Nlt)?`, so zero-width evasion (`to​ken`) still matches.
- `Nlt` = `[${lBe}${tto}\\ufeff]*` — invisible/default-ignorable/surrogate + Arabic-prefix ranges.

**Note on the verdict's regex citation**: the anchored regex at the cited strings line
(`^(?:authorization|proxy-authorization|cookie|…|x-honeycomb-team)(?:-?v?\d+)?$|…`) is the binary's
`Iae` — it belongs to the separate `credentialHeaderEntry` WARNING module ("Header … looks like a
credential"), not to the confirm-output redactor. The redactor actually used at the `Headers:`
print site is the unanchored `pt` above. Observable difference: `My-Secret-Header` is redacted by
`pt` but not matched by `Iae`; `x-honeycomb-team` is flagged by `Iae` but NOT redacted by `pt`.
The fix ports `uxn`/`pt` (the print-site mechanism) — unit tests pin both discriminating cases.

**Fix**: new `src/services/mcp/headerRedaction.ts` (`redactHeadersForDisplay` = `uxn` verbatim;
existing `redaction.ts`/`displaySanitize.ts` are different mechanisms — `${VAR}`-expansion and
value-scanning respectively — so no reuse was possible). Both confirm prints in `addCommand.ts`
now redact for display only; the config write path (`addMcpConfig`) keeps plaintext, matching the
official (verified: official writes the raw value to `.claude.json`). `mcp add-json` prints no
headers — unaffected.

Tests: `src/services/mcp/__tests__/headerRedaction312.test.ts` (10 tests / 56 expect — reviewer
repro, name-only semantics, case-insensitivity, unanchored substring, full `pt` alternation
coverage, bare-`key` negative, invisible-char evasion ×5, non-mutation + null prototype, empty
record) + `test/e2e/mcp-add-header-redaction-312.e2e.test.ts` (2 e2e — http + sse on the BUILT
artifact with isolated temp HOME: stdout shows `"Authorization": "[REDACTED]"` +
`"X-Custom": "plainvalue"`, never contains the secret, and the stored `.claude.json` keeps the
plaintext value). MCP suites: **627 pass / 0 fail / 1989 expect** (617 baseline + 10 new); MCP
e2e **5 pass** (help-transport 2 + connection-nonblocking 1 + new redaction 2). Manual reviewer
repro on the built artifact reproduces the official output shape exactly.

### §8.2 Gap-137c (P2, docs) — stale "(stdio or SSE)" in `docs/en/cli-reference.md:133`

`occ mcp add-json <name> <json> [-s scope]  # add a server (stdio or SSE)` →
`# add a server from a JSON string` (transport-neutral, consistent with zh cli-reference "从 JSON
添加" and docs/en/mcp.md). Repo-wide grep: the only remaining "(stdio or SSE)" hits are historical
quotes inside this ledger (§4.3) — correct to keep.

### §8.3 NEW divergences found while byte-verifying the `mcp add` action — STAGED (out of verdict scope)

Located the official `mcp add` action (@271705467) to confirm the redaction call site; three
further OCC divergences surfaced. The verdict scoped this round to Gap 1 + Gap 2, so these are
staged with evidence rather than smuggled in:

1. **`--callback-port` integer validation** — official rejects non-integer/out-of-range values with
   byte-exact `Error: --callback-port must be an integer in [1, 65535]`; OCC `parseInt`s silently
   (`NaN`/out-of-range flows into the stored oauth config). Small, safe, security-adjacent —
   natural next-round item.
2. **URL sanitizer in the `Added …` line** — official prints the URL via `eS(n)` (credential-bearing
   URLs → `"[redacted URL]"`, cf. `VC="[redacted URL]"` + `Bn` percent-decode helper @same window);
   OCC prints the raw URL. `https://user:pass@host/mcp` would leak the userinfo secret in the
   confirm line. P1-candidate — `eS`/`Bn` form a small self-contained module, but porting it needs
   its own byte-verification pass (percent-decode + scheme branches).
3. **sse/http branch merge** — official handles sse+http in ONE branch with
   `Added ${m} MCP server …` (m = "SSE"/"HTTP"); OCC duplicates the two branches. Cosmetic
   structural refactor, no observable difference today.

### §8.4 Diff landed this round

```
src/services/mcp/headerRedaction.ts                        | new (uxn/pt/O6e/Nlt/lBe/tto byte-verbatim port)
src/services/mcp/__tests__/headerRedaction312.test.ts      | new (10 unit tests)
src/commands/mcp/addCommand.ts                             | 2 confirm prints → redactHeadersForDisplay
test/e2e/mcp-add-header-redaction-312.e2e.test.ts          | new (2 behavioral e2e, built artifact)
docs/en/cli-reference.md                                   | :133 transport-neutral add-json comment
docs/upstream-version-gap-occ137-2026-10.md                | this section
```

Build GREEN post-fix (`dist/cli.js` 30.58 MB). Release remains gated on 验收员 re-acceptance
(tag → publish.yml → npm → GitHub Release → releases==tags check) per the verdict.
