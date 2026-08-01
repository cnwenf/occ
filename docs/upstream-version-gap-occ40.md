# Upstream version gap — OCC-40 (2026-08-01)

> Carryover from `docs/upstream-version-gap-occ39.md`. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry (`@anthropic-ai/claude-code`); feature truth cross-checked against
> OCC `src/` and the decompiled official native ELF
> (`@anthropic-ai/claude-code-linux-x64@2.1.220`, 351 `2.1.220` string hits,
> no `2.1.221+` marker).

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.291` (`2026-07-31`, OCC-39) | `package.json` |
| OCC aligned Claude Code (start of round) | `2.1.218` fully + `2.1.219` **partial** (P0 + Opus 5 canonical + all Opus 5 launch downstream sites 1a–1j + item 4 `mcp_server_errors` + item 8 whitespace warnings + item 1c `promptCacheWrite1hTokens` + item 2 `sandbox.network.strictAllowlist`) | `CLAUDE.md` header; OCC-39 §7 |
| Official latest Claude Code (npm `latest` = `next`) | **`2.1.220`** (published `2026-07-24T23:11:21Z`; **unchanged since OCC-34, ~8 days; no new release 07-31→08-01**) | `npm view @anthropic-ai/claude-code version` |
| Official GitHub latest release | **`v2.1.220`** (`ashwin-ant`, `published 2026-07-25T01:35:55Z`) | `gh api repos/anthropics/claude-code/releases/latest` |
| Version gap vs official latest | **YES — carryover** `2.1.219` P1–P4 backlog; `2.1.220` = no-op, **re-confirmed this round (§3.2)** | this doc §3 |

**Conclusion: the round's fork-point check resolved to the no-op path.**
Official `latest` is **unchanged at `2.1.220`** since OCC-34 (npm `time` tail:
`2.1.220 → 2026-07-24T23:11:21Z`; no new official release in the last ~8 days,
and none 07-31→08-01). `2.1.220` remains the no-op reliability layer —
**re-confirmed this round via binary strings diff (§3.2)**: 351 `2.1.220`
string hits, **no `2.1.221+` version marker**, no new env-var/settings-key/
hook-name/command surface.

**Path taken this round: official no-op → strict self-acceptance** (per the
issue's "版本追齐后的自验收" instruction for the no-gap case). The remaining
`2.1.219` P1–P4 backlog items are each ambiguous in the binary without
dedicated per-site decompilation (unchanged from OCC-39 §5); the
`aligning-with-official-binary` skill's "STOP if ambiguous" rule applies — no
item was guessed this round. Instead the round verified OCC's current
caught-up state end-to-end: build green, the full `version-2.1.219-*` e2e
suite green (43/0, 153 expects), `occ-versioning` + `commands-alignment`
green (6/0, 12 expects), and a REPL smoke green (`occ --version` →
`OCC 2.1.291`; `echo "say PONG" | occ -p` → `PONG`). See §4.

No code ported → **no new OCC release this round** (a no-op version bump
would violate the "no invented/partial" discipline and pollute the
`/releases` page; the 发版流程 fires only on a real code change after
acceptance).

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.220` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.220`, `next=2.1.220`, `stable=2.1.212` | `npm view … dist-tags --json` |
| npm `time` tail | `2.1.220 → 2026-07-24T23:11:21.821Z` (last entry; no `2.1.221+`) | `npm view … time --json` |
| Official GitHub latest release | `v2.1.220` (`ashwin-ant`, `2026-07-25T01:35:55Z`) | `gh api repos/anthropics/claude-code/releases/latest` |
| OCC aligned version (start of round) | `2.1.218` + `2.1.219` partial (P0 + Opus 5 canonical + 1a–1j + 4 + 8-ws + 1c + 2) | `CLAUDE.md`; OCC-39 §7 |

Official version timeline (tail, unchanged since OCC-34):

```
2.1.220 → 2026-07-24T23:11:21Z   ← official latest (no-op reliability; re-confirmed no-op this round, §3.2)
2.1.219 → 2026-07-24T16:11:49Z   ← substantive surface; P0 + Opus 5 canonical + 1a–1j + 4 + 8-ws + 1c + 2 done; P1–P4 open (no port this round — all remaining ambiguous)
2.1.218 → 2026-07-22T19:55:32Z   ← OCC fully aligned (OCC-31)
…
```

## 2. Methodology (skills used)

`upstream-tracking` (fork-point check: npm + GitHub release + binary strings
diff) + `aligning-with-official-binary` (no invented/partial implementations;
binary-verbatim recovery; STOP if ambiguous). Version truth from the npm
registry; feature truth cross-checked against OCC `src/` and the decompiled
official native ELF (`@anthropic-ai/claude-code-linux-x64@2.1.220`).

## 3. Official changelog + no-op re-confirmation

### 3.1 Official changelog — 2.1.220 + 2.1.219 (unchanged from OCC-34/35/36/37/38/39)

#### 2.1.220

No public changelog entry beyond the `2.1.220` version marker — a no-op
reliability layer (re-confirmed via binary strings diff, §3.2).

#### 2.1.219 (Opus 5 launch + the P1–P4 backlog — relevant items bolded; full text in OCC-35 §3 / GitHub `CHANGELOG.md`)

- Added `sandbox.network.strictAllowlist` setting to deny non-allowlisted hosts for sandboxed commands without prompting (P1 item 2) — landed OCC-39
- Added `mcp_server_errors` to the headless stream-json init event (P1 item 4) — landed OCC-38; caller-wiring staged
- Added the `workflowSizeGuideline` settings key (P2 item 5) — staged
- Added nested subagent forwarding in stream-json at depth-2+ under `--forward-subagent-text` (P2 item 6) — staged
- Fixed `claude -p` text output dropping the answer already produced when a turn dies on a mid-stream API error (P2 item 7) — staged
- Added HTTP status and error text to `claude mcp list` and `/mcp` + MCP-config whitespace warning (P2 item 8) — whitespace-warning half landed OCC-38; mcp-list error-text format staged
- Fixed the `/model` picker showing the merged Opus row as plain "Opus" instead of "Opus (1M context)" (P3 item 10/14) — 1b done OCC-37
- Fixed Vim mode: ← on empty prompt returns to agent view from NORMAL mode (P3 item 14) — staged
- Fixed screen-reader mode rewriting the entire input line on every keystroke (P3 item 15) — staged
- Changed dynamic workflows to default to a medium size guideline (<15 agents) + status line shows it (P2 item 18/21) — staged
- Changed managed MCP allowlist/denylist `${VAR}` to resolve from startup env (P2 item 19) — staged
- Changed the `/model` picker to highlight only the newest model's name (P3 item 20 — 1i) — done OCC-37

### 3.2 2.1.220 no-op re-confirmation (binary strings diff)

The OCC-39 §3.2 binary strings diff (219↔220: 220 has fewer unique strings —
internal churn, no new surface) was re-verified this round: the same surface
tokens are present in the 2.1.220 ELF and there is **no version marker beyond
`2.1.220`**:

```
# version marker beyond 2.1.220?
$ strings package/claude | grep -aoE "2\.1\.22[0-9]" | sort | uniq -c
    351 2.1.220        ← only 2.1.220; no 2.1.221+

# 2.1.219 surface tokens present in 2.1.220 binary?
strictAllowlist            PRESENT   (ported OCC-39)
mcp_server_errors           PRESENT  (ported OCC-38)
promptCacheWrite1hTokens    PRESENT  (ported OCC-38)
workflowSizeGuideline       PRESENT  (staged — behavior ambiguous)
DirectoryAdded              PRESENT  (ported OCC-34)
claude-opus-5               PRESENT  (ported OCC-35)
forward-subagent-text       PRESENT  (flag + guard exist; depth-2+ forwarding staged)
```

→ **No new named surface** in 2.1.220 vs 2.1.219. `2.1.220` is a no-op
reliability layer — nothing to port.

## 4. Self-acceptance run this round (no-gap path)

Per the issue's "版本追齐后的自验收" instruction: when the official is
unchanged (no gap to close), run OCC's REPL like a human user and verify
consistency. No code ported this round (every remaining staged item is
ambiguous in the binary without dedicated per-site decompilation → STOP per
the skill); the round instead verified OCC's current caught-up state
end-to-end.

| Check | Command | Result |
|-------|---------|--------|
| Build | `bun run build` | green — `cli.js` 28.84 MB, `injected MACRO.VERSION=2.1.291`, `MACRO.BINARY_NAME=occ` |
| Version-2.1.219 e2e (5 files) | `bun test test/e2e/version-2.1.219-*.e2e.test.ts` | **43 pass / 0 fail / 153 `expect()`** (sandbox-strict-allowlist + opus5 + mcp-list-errors + opus5-cost-1h-field + mcp-server-errors) |
| Versioning + commands alignment | `bun test test/e2e/occ-versioning.e2e.test.ts test/e2e/commands-alignment.e2e.test.ts` | **6 pass / 0 fail / 12 `expect()`** |
| REPL smoke — version | `node bin/occ.cjs --version` | `OCC 2.1.291` |
| REPL smoke — print mode | `echo "say PONG" \| node bin/occ.cjs -p` | `PONG` (exit 0) — headless `-p` path end-to-end with a live API key |

Acceptance: OCC `2.1.291` is consistent with the official `2.1.220` surface it
has ported; the unported remainder is the documented `2.1.219` P1–P4 backlog
(§5–§6), each item staged as ambiguous — not a behavioral divergence in the
ported surface. Pending the OCC 验收员's independent binary re-verification
(separate role).

## 5. Staged (ambiguous in the binary — not guessed)

Unchanged from OCC-39 §5; restated for completeness. Each needs dedicated
per-site decompilation (no invented/partial implementations, per
`aligning-with-official-binary`).

- **Item 5 — `workflowSizeGuideline` settings key + dynamic-workflow medium default + status line.** The settings key, `/config` enum (`small`/`medium`/`large`/`unrestricted`), and status-line text strings are cleanly recoverable, but the load-bearing behavior — the size→agent-count caps (small = 5 confirmed; medium = "<15" per changelog prose but `15 agents` is NOT a literal in the binary — the cap is computed; `large`/`unrestricted` values not cleanly recoverable) — is ambiguous. Per the skill's "STOP if ambiguous", the behavior part is not ported; the `/config` enum UI + status-line rendering are TUI (deferred per OCC-11 sandbox-stall). Staged.
- **Item 8 — mcp list HTTP/error-text *format*.** The `Failed to connect to MCP server '<name>': <error>` phrase appears in the binary ONLY in the agent-log path; the binary's actual `mcp list` / `/mcp` output is a React component rendering separate `{name, server, status, issue}` fields. Matching the binary's React-component layout exactly is a separate picker-UI/output-format task. Staged.
- **Item 6 — nested subagent forwarding (depth-2+) under `--forward-subagent-text`.** The CLI flag + guard already exist in OCC; the depth-2+ forwarding mechanism (a nested subagent's text propagating up through the parent subagent's stream) is coupled to the AgentTool streaming path and needs dedicated per-site decompilation. Staged.
- **Item 7 — `claude -p` keep answer on mid-stream API error.** OCC already has the J1 (2.1.199) mid-stream finalize mechanism (`getMidStreamFinalizeCause` + `getMidStreamPartialNotice` in `src/services/api/claude.ts`). The 2.1.219 fix is in the `-p` text-output path (flushing the already-produced partial text to stdout before the finalize notice) — coupled to the print text-output assembly; the exact flush site is ambiguous in the binary without a dedicated round. Staged.
- **Item 19 — managed MCP allowlist/denylist `${VAR}` from startup env.** Requires a startup-env snapshot + an interpolation pass over allowlist/denylist `serverName` entries before the verbatim comparison in `isMcpServerDenied` / `filterByManagedPolicy`. The exact interpolation function in the binary (where/when `${VAR}` is resolved) is not cleanly recoverable without a dedicated round. Staged.
- **Item-4 caller-wiring.** `buildSystemInitMessage`'s callers (`QueryEngine.ts`, `useReplBridge.tsx`) still pass `mcpServerErrors: []`. The binary's `tAr` builder receives `e.mcpServerErrors` as a SEPARATE list of `{name,type,message}` for servers that failed config validation BEFORE connection (not derivable from `mcpClients`/`MCPServerConnection`). Plumbing that separate list through the MCP connection layer (mapping the binary's exact `type` values + qualifying error states) is a dedicated task — not guessed this round. An empty array produces correct (OMITTED) output per the binary's `r.length>0&&` guard, so this is a faithful no-op-until-wired state, not a behavioral divergence. The useReplBridge site intentionally redacts `mcpServerErrors` (MCP server error names leak integration wiring) — only the QueryEngine site would wire. Staged as the most natural next-round follow-up.
- **Per-command `strictAllowlist` merge** (binary offset ~248293849: `if(o.strictAllowlist===!0)l.strictAllowlist=!0`). OCC has no per-command sandbox config (`sandboxedCommands` network merge); porting that is a larger feature beyond the top-level settings key landed OCC-39. Staged.

## 6. Other 2.1.219 P1–P4 (unchanged from OCC-39 §6, restated)

| # | 2.1.219 item | Priority | Status |
|---|--------------|----------|--------|
| 2 | `sandbox.network.strictAllowlist` setting | P1 | done (OCC-39) |
| 4 | `mcp_server_errors` in stream-json init | P1 | done (OCC-38; caller-wiring staged) |
| 8 | `mcp list` / `/mcp` HTTP errors + MCP-config whitespace warning | P2 | whitespace warning done (OCC-38); mcp-list error-text format staged |
| 1c | `promptCacheWrite1hTokens` cost field | P2 (carryover) | done (OCC-38) |
| 5 | `workflowSizeGuideline` settings key + `/config` hide | P2 | staged (§5) |
| 6 | nested subagent forwarding (depth-2+) under `--forward-subagent-text` | P2 | staged (§5) |
| 7 | `claude -p` keep answer on mid-stream API error | P2 | staged (§5) |
| 18/21 | dynamic workflows default medium (<15 agents) + status line | P2 | staged (§5) |
| 19 | managed MCP allowlist/denylist `${VAR}` from startup env | P2 | staged (§5) |
| 10/14/15/20 | `/model` Opus (1M) label, Vim ←, screen-reader echo, highlight-newest | P3 | 1b/1i done (OCC-37); Vim/screen-reader staged |
| 9/11/12/13/16/17 | Fable credits label, GNU screen, Remote Control, Windows git-bash, teleport | P4 | skip/doc (niche → by-design divergence) |

Plus the OCC-37 staged sub-items still open: 1d capability path
(`fast_mode` registry), 1i picker-UI render (`ModelPicker.tsx`), 1g 3P
thinking/ISP branches for opus-5.

## 7. Tracked-upstream pointer (end of round)

OCC is still caught up through `2.1.218` fully + `2.1.219` **partial** —
P0 + Opus 5 canonical foundation + all Opus 5 launch downstream sites
1a/1b/1c/1d/1e/1f/1g/1h/1i/1j + item 4 (`mcp_server_errors`) + item 8
whitespace warnings + item 1c `promptCacheWrite1hTokens` + item 2
(`sandbox.network.strictAllowlist`). The remaining gap is the rest of the
`2.1.219` P1–P4 backlog (items 5/6/7/8-mcp-list-format/18/19/21 + Vim/screen-reader P3 + niche P4 + the OCC-37 staged sub-items + item-4 caller-wiring + per-command strictAllowlist merge) — staged for dedicated per-site rounds; each ambiguous in the binary, not guessed this round. `2.1.220` remains a no-op reliability layer (re-confirmed this round, §3.2). The item-4 caller-wiring (plumbing MCP config errors into `buildSystemInitMessage`) and item 19 (MCP `${VAR}` from startup env) remain the most natural next-round follow-ups.
