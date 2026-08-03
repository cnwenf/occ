# Upstream version gap — OCC-43 (2026-08-04)

> Carryover from `docs/upstream-version-gap-occ42.md`. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry (`@anthropic-ai/claude-code`), the official GitHub releases, AND a
> fresh download of the official native ELF this round
> (`@anthropic-ai/claude-code-linux-x64@2.1.220`, 275,012,592 bytes —
> re-verified unchanged: 351 `2.1.220` string hits, no `2.1.221+` marker,
> same artifact OCC-34→OCC-42 diffed). Behavioral truth cross-checked by
> driving the built OCC artifact (`dist/cli.js`, `OCC 2.1.291`) and the
> official 2.1.220 binary side by side (tmux REPL + `-p` stream-json).

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.291` (`2026-07-31`, OCC-39) | `package.json` |
| OCC aligned Claude Code (start of round) | `2.1.218` fully + `2.1.219` **partial** (P0 + Opus 5 canonical + all Opus 5 launch downstream sites 1a–1j + item 4 builder + item 8 whitespace + item 1c `promptCacheWrite1hTokens` + item 2 `strictAllowlist`) | `CLAUDE.md` header; OCC-42 §1 |
| Official latest Claude Code (npm `latest` = `next`) | **`2.1.220`** (published `2026-07-24T23:11:21Z`; **unchanged since OCC-34, ~11 days; no new release 08-03→08-04**) | `npm view @anthropic-ai/claude-code version` |
| Official GitHub latest release | **`v2.1.220`** (`ashwin-ant`, `published 2026-07-25T01:35:55Z`) | `gh api repos/anthropics/claude-code/releases/latest` |
| Binary marker (fresh download this round) | **351 × `2.1.220`, zero `2.1.221+`** | `strings package/claude \| grep -aoE "2\.1\.22[0-9]" \| sort \| uniq -c` |
| Version gap vs official latest | **NO new port gap** — `2.1.220` re-confirmed no-op; carryover `2.1.219` P1–P4 chipped: **item-4 caller-wiring landed this round** | this doc §2 |

**Conclusion: no new official version (三方确认 — npm + GitHub + binary
marker all re-verified independently this round, including a fresh ELF
download). The round therefore followed the issue's "版本追齐后的自验收 +
继续啃 backlog" path and LANDED REAL CODE: the `2.1.219` item-4
`mcp_server_errors` **caller-wiring** (the most natural follow-up flagged by
OCC-41/42) plus a self-acceptance-discovered `/model` picker gate fix. A new
OCC release is prepared but fires only after 验收员 acceptance (发版流程).**

## 1. Version truth (re-confirmed independently this round — 三方)

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.220` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.220`, `next=2.1.220`, `stable=2.1.212` | `npm view … dist-tags --json` |
| npm `time` tail | `2.1.218 → 2026-07-22T19:55:32Z`, `2.1.219 → 2026-07-24T16:11:49Z`, `2.1.220 → 2026-07-24T23:11:21Z` (last version entry; `modified 2026-07-25T01:34:52Z`; no `2.1.221+`) | `npm view … time --json` |
| Official GitHub latest release | `v2.1.220` (`ashwin-ant`, `2026-07-25T01:35:55Z`) | `gh api repos/anthropics/claude-code/releases/latest` |
| Official GitHub tags (top 5) | `v2.1.220`, `v2.1.219`, `v2.1.218`, `v2.1.217`, `v2.1.216` | `gh api repos/anthropics/claude-code/tags` |
| Binary marker (fresh) | 351 × `2.1.220`; `grep -aoE "2\.1\.(22[1-9]\|2[3-9][0-9])"` → **0 hits** | `npm pack @anthropic-ai/claude-code-linux-x64@2.1.220` + `strings` |
| OCC aligned version (start of round) | `2.1.218` + `2.1.219` partial (P0 + Opus 5 canonical + 1a–1j + 4-builder + 8-ws + 1c + 2) | `CLAUDE.md`; OCC-42 §1 |

Official version timeline (tail, unchanged since OCC-34):

```
2.1.220 → 2026-07-24T23:11:21Z   ← official latest (no-op reliability; unchanged since OCC-34)
2.1.219 → 2026-07-24T16:11:49Z   ← substantive surface; item-4 caller-wiring landed THIS round
```

## 2. Landed this round (binary-verbatim, live-verified)

### 2a. `2.1.219` item 4 — `mcp_server_errors` **caller-wiring** (the staged "most natural next-round follow-up" from OCC-41/42)

OCC-38 ported the init-event **builder** (`buildSystemInitMessage` filters +
emits `mcp_server_errors` when non-empty) but both callers passed `[]`
(faithful no-op-until-wired). This round completed the chain, every link
recovered verbatim from the 2.1.220 ELF and **live-verified against the
official binary**:

1. **Per-entry `--mcp-config` validation — `parseDynamicMcpConfig`
   (`src/services/mcp/config.ts`), port of binary `Ilr` (~253245xxx).**
   Invalid entries are SKIPPED with a `skipReason` warning while valid
   entries load (previously OCC rejected the whole config — a real error-handling
   divergence). Skip categories (byte-identical messages, live-verified):
   - `unknown_type` — `Skipped — unknown MCP server type "<t>" for server "<n>"`
     + suggestion `Valid types are: stdio, sse, http (or streamable-http), ws, sdk`
   - `url_missing_type` — `Skipped — MCP server "<n>" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry`
   - `invalid_config` — `Skipped — invalid MCP server config for "<n>": <path>: <issue>; …`
     (issues joined `"; "`, `Invalid input: ` prefix stripped — zod v4
     messages match the official byte-for-byte, verified via live probe)
   - `reserved_name` — `"<n>" is a reserved MCP server name and was not loaded`
     (binary `UIt`: `claude-in-chrome` / `computer-use` / Claude Preview /
     Claude Browser / `workspace`; `type:"sdk"` exempt; replaces OCC's old
     FATAL reserved-name exit — the binary skips, it does not exit)
   - `__proto__` guard, whitespace warnings (item-8 dynamic surface), and
     `${VAR}` expansion with `Missing environment variables:` warnings, all
     per `Ilr`; `urlExpandedToEmpty` → `configError`/`configErrorReason:
     "url_invalid"` on the expanded config (present since ≤2.1.218, never
     ported — included for a verbatim `Ilr`).
   - Fatal top-level shape failures keep the binary's exact messages:
     `Missing "mcpServers" — found "servers" instead…` (+ rename suggestion)
     or the raw zod issue (`mcpServers: Invalid input: expected record,
     received undefined`) → `Error: Invalid MCP configuration:` + exit 1
     (all three fatal paths live-verified byte-identical).
   - Also fixed en passant (live-probe): the http schema accepts
     `type: "streamable-http"` and normalizes to `http` — binary
     `v.enum(["http","streamable-http"]).transform(()=>"http")`; OCC
     previously rejected it.
2. **Skipped-errors store — `src/services/mcp/skippedMcpServerErrors.ts`**,
   port of binary module `tgl` (`TEm`/`CEm`/`wEm`): CLI entry pushes the
   de-duplicated skip list, init builder reads it.
3. **CLI entry `--mcp-config` block (`src/main.tsx`)**, port of the binary
   CLI-entry block (~267411149): warn-log `--mcp-config: N entry
   warning(s): …`, collect `skipReason` errors as `{name, type, message}`,
   keep only servers actually absent from the merged config (a later valid
   entry with the same name clears the skip), Map-dedup (last wins per
   binary), TTY-gated stderr warning `Warning: N MCP server(s) skipped due
   to invalid config:\n  - <ANSI-stripped, control-char-sanitized message>`
   (non-TTY: silent — both live-verified).
4. **QueryEngine init builder (`src/QueryEngine.ts`)**: `mcpServerErrors:
   getSkippedMcpServerErrors()` — binary `mcpServerErrors:CEm()`
   (~267738589). `useReplBridge` keeps `[]` (binary offset ~264053443).

**Live verification (official 2.1.220 vs OCC, same env, same
`/tmp/mcptest.json` with `bogus`/`nourl`/`good` entries):** the
`system/init` events are **byte-identical** on `mcp_server_errors`
(`bogus`→`unknown_type`, `nourl`→`url_missing_type`, exact em-dash
messages) and `mcp_servers` (`good` present/failed, skipped entries absent);
the remaining init-key diffs (`agents`/`skills`/`tools`/`plugins`/
official-only `analytics_disabled`/`capabilities`/`memory_paths`…) are the
pre-existing OCC-24 documented divergences, unrelated to item 4.

**Tests:** 14 new unit tests (`src/services/mcp/__tests__/dynamicMcpConfig.test.ts`)
+ 6 new live-API e2e (`test/e2e/version-2.1.219-mcp-server-errors-wiring.e2e.test.ts`,
CI-gated like `real-coding`).

### 2b. `/model` picker custom-model gate — self-acceptance discovery (Gap-43b)

Strict self-acceptance (§3) caught a real interaction divergence: with a
firstParty provider behind a custom `ANTHROPIC_BASE_URL` (the GLM-style
proxy setup), the official `/model` picker shows `Custom Opus/Sonnet/Haiku
model` rows while OCC showed the stock rows. Root cause (binary `Fug`/`xJn`,
~249523655): the official gates custom rows on `xJn() = !rm()||iW()||!Yd()`
(provider NOT Anthropic-owned, OR anthropicAws/GoogleCloud, OR base URL ≠
api.anthropic.com) — OCC gated on provider alone. Fixes (all binary-verbatim,
live-verified against the official picker):
- `shouldUseCustomModelOptions()` mirrors `xJn` (`src/utils/model/modelOptions.ts`).
- The firstParty PAYG branch now consults the custom options (binary `rm()`
  branch shape: Default → Opus → [Fable] → Sonnet → Haiku order for the
  custom case).
- Stock Fable row removed from the custom case (binary: firstParty gets
  Fable only via `ANTHROPIC_DEFAULT_FABLE_MODEL` — live-verified: no Fable
  row otherwise).

**Staged residuals (documented, not forced — need dedicated decompilation):**
the picker still diverges on (a) the extra `Custom model` row for the
current `ANTHROPIC_MODEL` value + ✔-checkmark placement (official folds the
current model into the matching custom row's checkmark — needs the binary's
current-model↔option matching recovered); (b) Default-row suffix
(`(currently glm-5.2[1m])` vs OCC's pricing suffix); (c) footer text
(`Enter to set as default · s to use this session only · Esc to cancel` vs
OCC's older wording); (d) stock firstParty layout order (binary `rm()` puts
Opus before Sonnet even without custom envs — changing the stock layout is a
bigger, separately-verified change); (e) stock Fable row in the pure
firstParty stock path (binary shows none — needs a genuine 1P-API probe to
confirm before removing).

### 2c. Stale test fix — `model-defaults-207` foundry expectation

`src/utils/__tests__/model-defaults-207.test.ts` asserted foundry →
`claude-opus-5`, contradicting the OCC-37 Gap-1 implementation (binary
per-provider table: foundry lags at `claude-opus-4-6` — verbatim in
`getDefaultOpusModel` with the recovered binary offset). The test predated
the Gap-1 fix and made the whole src suite red. Updated the assertion to the
binary-verified behavior (`claude-opus-4-6`). Suite: 1707 pass / 0 fail.

## 3. Strict self-acceptance (OCC REPL vs official, per issue's 自验收 instruction)

Priority order per the issue: recently-added features first, then core trunk.

| Surface | OCC | Official | Consistent? |
|----------|-----|----------|-------------|
| `mcp_server_errors` init event (item-4 wiring, **new this round**) | `bogus`/`nourl` skipped + byte-identical messages; `good` loads | captured from the 2.1.220 binary | ✅ byte-identical |
| Fatal `--mcp-config` paths (`{"servers":…}`, `{}`, non-JSON file) | exact stderr + exit 1 | captured | ✅ byte-identical |
| Non-TTY stderr silence for skips | no warning | no warning | ✅ |
| `/model` picker under proxy env (**Gap-43b fixed**) | Custom Opus/Sonnet/Haiku rows, official order | same | ✅ (residuals staged, §2b) |
| `-p` pipe: `echo "Reply with exactly the word PONG" \| occ -p` | `PONG`, exit 0 | same | ✅ |
| Invalid flag `--nonexistent-flag-xyz` | `error: unknown option '--nonexistent-flag-xyz'` | same | ✅ |
| `--version` | `OCC 2.1.291` | `2.1.220 (Claude Code)` / uvx `2.1.218` | ✅ branded by design |
| Interactive REPL (tmux, live API): welcome | `OCC v2.1.291` + logo + `glm-5.2 · API Usage Billing` + cwd + `↑ Opus now defaults to 1M context` + `● high · /effort` | `Claude Code v2.1.220` + logo + What's-new feed + same model/cwd/effort | ✅ functional parity (branded/cosmetic diffs by design) |
| Trust dialog → welcome | shown for fresh dir, Enter proceeds | same | ✅ |
| Shift+Tab cycling | bypass → auto → manual → … (`⏵⏵ auto mode on (shift+tab to cycle)`) | same | ✅ |
| Real interactive task | "Create a file named occ43-acceptance.txt…" → Write tool + PostToolUse async hook, exact content on disk, back to prompt | n/a (OCC task execution) | ✅ core trunk green |
| `/goal` panel | `Goal / No goal set / /goal <condition> to set one · [esc] dismiss` | aligned contract | ✅ |
| Opus 5 surfaces (1b picker row `Opus (1M context)` / welcome notice) | render | render | ✅ |

**Formal e2e + unit gates this round:** `version-2.1.219-*` 6 files **49
pass / 0 fail / 178 expect()** (incl. the 6 new wiring e2e); MCP e2e
(`mcp-connection-nonblocking`, 2.1.132/139/144/200/200-readmcpresourcedir)
**17 pass / 0 fail**; `occ-versioning` + `commands-alignment` **11 pass / 0
fail / 31 expect()** (batched run); full `src/` unit suite **1707 pass / 0
fail / 3751 expect()** (was 1706/1 before the §2c stale-test fix); biome lint
clean on all changed files; build green (`dist/cli.js` 28.85 MB,
`OCC 2.1.291`).

## 4. Staged backlog (end of round)

- **Closed this round:** item-4 caller-wiring (was the flagship staged item
  since OCC-38); Gap-43b picker custom-model gate; `streamable-http` alias.
- **Still staged (unchanged from OCC-41/42 §5, each needs dedicated per-site
  decompilation — STOP per skill):** item 5 `workflowSizeGuideline`
  (size→agent-count; `/config` enum + status-line are TUI, deferred per
  OCC-11); item 6 nested-subagent forwarding (depth-2+); item 7 `claude -p`
  keep-answer on mid-stream API error; item 8 mcp-list error-text format
  (React component, not a 2.1.219 regression); item 19 managed-MCP `${VAR}`
  from startup env (the `--mcp-config`-side `${VAR}` expansion IS now ported
  via `Ilr`; the managed allowlist/denylist side remains); Vim/screen-reader
  P3 + niche P4 + OCC-37 staged sub-items + per-command `strictAllowlist`
  merge; plus the §2b picker residuals (a)–(e).

## 5. Release decision

**Real code landed → new OCC release `2.1.292` prepared, gated on 验收员
acceptance** (issue 发版流程: 验收通过后打 tag → `publish.yml` → npm +
GitHub Release). Until acceptance: code merges to `main` without tagging, so
`publish.yml` does not fire and `/releases` stays consistent. CHANGELOG
records this round under `[Unreleased]` until the release-prep rename.

## 6. Tracked-upstream pointer (end of round)

- `2.1.218` — fully aligned (OCC-31).
- `2.1.219` — partial (P0 + Opus 5 canonical + all Opus 5 launch downstream
  sites 1a–1j + items 4 [builder **and caller-wiring**] + 8-ws + 1c + 2).
  Remaining P1–P4 staged (§4).
- `2.1.220` — no-op reliability layer (no new surface to port).

Next round: re-check npm for a new official release; if `2.1.221+` appears,
binary-diff and port the decompiled-verified subset. Otherwise continue
chipping the staged backlog (§4) where a per-site decompilation cleanly
recovers the behavior, and the §2b picker residuals once the current-model
matching is recovered.
