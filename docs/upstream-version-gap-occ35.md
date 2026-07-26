# OCC vs. official Claude Code — version-gap report (2026-07-27, OCC-35)

> Gap-research deliverable for **OCC-35** ("OCC版本追齐官方Claude Code — 2026-07-27
> gap调研/对齐"), step 1: confirm OCC's aligned official version, the official
> latest, and the changelog/code-diff gap between them. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory recital).
> Version truth from the npm registry (`@anthropic-ai/claude-code`) and the
> official Anthropic `CHANGELOG.md` on GitHub; feature truth cross-checked
> against OCC `src/` and the decompiled official native ELF
> (`@anthropic-ai/claude-code-linux-x64@2.1.220`).

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (latest on `main`, start of round) | `2.1.286` (`2026-07-26`) | `package.json`, `CHANGELOG.md` §2.1.286 |
| OCC aligned Claude Code (start of round) | `2.1.218` fully aligned (OCC-31) + `2.1.219` **P0 partial** (OCC-34) | `CLAUDE.md` header; OCC-34 |
| Official latest Claude Code (npm `latest` = `next`) | **`2.1.220`** (published `2026-07-24T23:11:21Z`; unchanged since OCC-34) | `npm view @anthropic-ai/claude-code version` |
| Official GitHub `CHANGELOG.md` top entries | `## 2.1.220`, `## 2.1.219` | npm timeline |
| Version gap vs official latest | **YES — carryover** `2.1.219` P1–P4 (P0 done in OCC-34; `2.1.220` = no-op) | OCC-34 §4 |

**Conclusion: a real version gap still exists — the carryover `2.1.219` P1–P4
backlog staged by OCC-34.** The official `latest` dist-tag is **unchanged at
`2.1.220`** since OCC-34's report (no new official release in the last ~24h;
npm `time` tail shows `2.1.220 → 2026-07-24T23:11:21Z`, `modified →
2026-07-25T01:34:52Z`). `2.1.220` is the no-op reliability layer OCC-34 already
binary-confirmed (no new env-var / settings-key / hook-name / command surface).
The substantive gap is the `2.1.219` feature surface whose **P0 subset landed
in OCC-34** (subagent spawn-depth 1→3; `DirectoryAdded` hook) and whose
**P1–P4 items remain open**.

This round advances the keystone P1 item — **`claude-opus-5` model launch** —
by landing the **decompiled-verified canonical-registration foundation** (see
§4) and staging the remaining Opus 5 launch sites (§5) for dedicated
follow-up runs, following OCC's standard staged-catch-up pattern (OCC-15/19/34).

---

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.220` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.220`, `next=2.1.220`, `stable=2.1.212` | `npm view … dist-tags --json` |
| Official GitHub `CHANGELOG.md` top entry | `## 2.1.220` | npm timeline (unchanged from OCC-34) |
| OCC aligned version (start of round) | `2.1.218` + `2.1.219` P0 | `CLAUDE.md` header; OCC-34 |

Official version timeline (tail, unchanged since OCC-34):

```
2.1.220 → 2026-07-24T23:11:21Z   ← official latest (no-op reliability; OCC-34 confirmed nothing to port)
2.1.219 → 2026-07-24T16:11:49Z   ← substantive surface; P0 landed (OCC-34); P1–P4 open (this round advances P1)
2.1.218 → 2026-07-22T19:55:32Z   ← OCC fully aligned (OCC-31)
…
```

## 2. Methodology (skills used)

1. **Version truth** — `npm view @anthropic-ai/claude-code version/dist-tags/time`. Per `upstream-tracking` §"Version truth".
2. **Binary decompilation** — `npm pack @anthropic-ai/claude-code-linux-x64@2.1.220`; `tar -xzf`; `strings -n 8 package/claude > s220.txt` (429,558 lines). Per `upstream-tracking` §"Native Binary Notes (2.1.113+)".
3. **Token verification** — `grep -c`, `grep -oE`, and `grep -aboF` + `dd` byte-level windowing to recover exact provider IDs, display names, and pricing strings for `claude-opus-5`. Per `aligning-with-official-binary` (no invented/partial implementations).
4. **Source cross-check** — `grep -rn "claude-opus-5" src/` (0 hits at start of round) confirmed OCC had no Opus 5 recognition; the `@[MODEL LAUNCH]` markers (25 files) identified the faithful launch surface.

All downloaded binaries cleaned from `/tmp` after diffing (resource-safety rule).

## 3. Official changelog — 2.1.219 + 2.1.220 (unchanged from OCC-34)

### 2.1.220
- Bug fixes and reliability improvements

### 2.1.219 (Opus 5 — relevant items bolded)
- **Added Claude Opus 5 (`claude-opus-5`), now the default Opus model — 1M context, fast mode at $10/$50 per Mtok**
- Added `sandbox.network.strictAllowlist` setting to deny non-allowlisted hosts for sandboxed commands without prompting
- Added `DirectoryAdded` hook that fires after `/add-dir` or the SDK `register_repo_root` control request registers a new working directory mid-session
- Added `mcp_server_errors` to the headless stream-json init event, listing `--mcp-config` entries skipped by config validation; terminal runs print a startup warning
- Added the `workflowSizeGuideline` settings key so the advisory Dynamic workflow size guideline can be set from any settings file; the `/config` row is hidden while one does
- Added nested subagent forwarding in stream-json: subagents spawned at depth-2+ now appear when `--forward-subagent-text` is set, keyed by their spawning Agent `tool_use` id
- Fixed `claude -p` text output dropping the answer already produced when a turn dies on a mid-stream API error
- Added HTTP status and error text to `claude mcp list` and `/mcp` when a server fails to connect, and a warning for MCP config values with hidden leading or trailing whitespace
- Fixed the Fable model row showing "Requires usage credits" for plans that include it, when a stale cache had baked the label in
- **Fixed the `/model` picker showing the merged Opus row as plain "Opus" instead of "Opus (1M context)"**
- Fixed copy-on-select inside GNU screen printing base64 into the terminal instead of copying the selection
- Fixed Remote Control clients keeping a stale fast-mode status after a model switch, reconnect, or failed org check
- Fixed `CLAUDE_CODE_GIT_BASH_PATH` on Windows exiting or being used as bash when the path isn't a bash/sh binary; it's now ignored with a warning
- Fixed Vim mode: pressing ← on an empty prompt now returns to the agent view from NORMAL mode, not just INSERT
- Fixed screen-reader mode rewriting the entire input line on every keystroke instead of echoing only the typed character
- Improved the "Remote Control is only available via api.anthropic.com" error to name the specific setting that caused it
- Improved `claude --teleport` to show which repo your current checkout points at when it doesn't match the session's repo
- Changed dynamic workflows to default to a medium size guideline (aim for fewer than 15 agents); pick another size or unrestricted with Dynamic workflow size in `/config`
- Changed managed MCP allowlist/denylist `${VAR}` entries to resolve from the startup environment and managed-settings env instead of settings-file env
- Changed the `/model` picker to highlight only the newest model's name, so the highlight marks the new release rather than an arbitrary subset of the list
- Added the current default workflow size to the running-workflow status line, with a pointer to `/config` for changing it
- **Removed Opus 4.7 from fast mode; `/fast` now applies to Opus 5 and Opus 4.8**
- Updated the claude-api skill to default to Claude Opus 5, with a migration path from Opus 4.8
- Subagents can now spawn nested subagents up to depth 3 by default (was 1); set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` to disable nesting

## 4. P1 keystone port landed this run — `claude-opus-5` canonical registration (decompiled-verified)

The `claude-opus-5` introduction is the keystone of the 2.1.219 surface: the
`/model` picker Opus row, default-Opus switch, fast-mode set, `claude-api`
skill, and `/model` highlight-newest all depend on the model being a
recognized canonical ID first. This round lands that faithful foundation.

### Binary-verified truth (official 2.1.220 linux-x64 ELF strings dump)
- `claude-opus-5` — 74 occurrences (firstParty/vertex/foundry/anthropic_aws/gateway).
- `us.anthropic.claude-opus-5` — bedrock ID (2 occurrences).
- `anthropic.claude-opus-5` — mantle ID (2 occurrences).
- `Opus 5 with 1M context` — the merged `/model` picker row label (4 occurrences).
- `Opus 5 - best for everyday, complex tasks` — picker row description (2 occurrences).
- `$10/$50` — fast-mode pricing per Mtok (2 occurrences).
- `1M context` — 71 occurrences (Opus 5 carries the 1M context window).

### Ports (all `@[MODEL LAUNCH]` "register config + canonical mapping + names" sites)

| Site | File | Change | Binary-verified |
|------|------|--------|-----------------|
| Config object | `src/utils/model/configs.ts` | `CLAUDE_OPUS_5_CONFIG` (firstParty/vertex/foundry/anthropic_aws/gateway = `claude-opus-5`; bedrock = `us.anthropic.claude-opus-5`; mantle = `anthropic.claude-opus-5`) + `opus5` key in `ALL_MODEL_CONFIGS` | ✓ provider IDs |
| Canonical mapping | `src/utils/model/model.ts` `firstPartyNameToCanonical` | `if (name.includes('claude-opus-5')) return 'claude-opus-5'` (top of opus group, before `claude-opus-4-8`) | ✓ canonical ID |
| Display name | `src/utils/model/model.ts` `getPublicModelDisplayName` | `opus5` → `'Opus 5'`; `opus5 + '[1m]'` → `'Opus 5 (1M context)'` | ✓ "Opus 5" |
| Marketing name | `src/utils/model/model.ts` `getMarketingNameForModel` | `claude-opus-5` → `'Opus 5'` / `'Opus 5 (with 1M context)'` | ✓ "Opus 5", "Opus 5 with 1M context" |
| Commit attribution | `src/utils/commitAttribution.ts` `sanitizeModelName` | `if (shortName.includes('opus-5')) return 'claude-opus-5'` (before the `opus-4` fallthrough) | ✓ public name `claude-opus-5` |

**Why faithful, not invented**: every provider ID, the canonical ID, and the
display/marketing names are recovered verbatim from the decompiled binary —
no behavior is guessed. The foundation is non-breaking: it adds a new
canonical model ID and does not alter any existing model's resolution
(opus-4-8/4-7/4-6 mappings unchanged — asserted by the new e2e test). Missing
`MODEL_COSTS` entries fall back to `DEFAULT_UNKNOWN_MODEL_COST` via the existing
`getModelCosts` `!costs` branch (same as opus-4-7/4-8 already do), so no
runtime breakage.

### Tests
- New e2e `test/e2e/version-2.1.219-opus5.e2e.test.ts` (7 tests, mirroring the
  OCC 2.1.197-models pattern): `CANONICAL_MODEL_IDS` contains `claude-opus-5`;
  `CANONICAL_ID_TO_KEY['claude-opus-5'] === 'opus5'`; binary-confirmed provider
  IDs; `firstPartyNameToCanonical` maps `claude-opus-5` + bedrock/suffix/fast
  variants and does **not** regress opus-4-x; `getMarketingNameForModel` →
  `Opus 5` / `Opus 5 (with 1M context)`; `sanitizeModelName` → `claude-opus-5`
  with no false capture of opus-4-x.

### Verification
- `bun test test/e2e/version-2.1.219-opus5.e2e.test.ts` → 7 pass, 0 fail.
- `bun test test/e2e/version-2.1.197-models.e2e.test.ts` (regression) → 11 pass, 0 fail.
- `bun test test/utils/model/` (bedrockVertexFallback + subagentModelOverride) → 13 pass, 0 fail.
- `bun test src/utils/__tests__/model-defaults-207.test.ts src/utils/model/__tests__/` → 26 pass, 0 fail.
- biome lint clean on all 4 changed files.
- `bun run build` green (`dist/cli.js` 28.84 MB, `MACRO.VERSION=2.1.286`, `MACRO.BINARY_NAME=occ`).
- REPL smoke (built artifact): `occ --version` → `OCC 2.1.286`; `occ --model claude-opus-5 --version` accepts the new model ID (no "unknown model" rejection); `echo "say PONG" | occ -p` → `PONG` (no regression).
- Direct resolver round-trip: `firstPartyNameToCanonical` / `getCanonicalName` / `CANONICAL_ID_TO_KEY` / `getMarketingNameForModel` / `getPublicModelDisplayName` / `sanitizeModelName` all return the binary-verified values for `claude-opus-5`.

## 5. Staged follow-up (remaining Opus 5 + 2.1.219 P1–P4) — for subsequent runs

Each remaining item needs dedicated decompilation per site to faithfully
recover exact upstream logic before porting (no invented/partial
implementations, per `aligning-with-official-binary`).

### Opus 5 launch (P1) — downstream of this round's foundation
| # | Item | Site | Status |
|---|------|------|--------|
| 1a | Default-Opus switch (`getDefaultOpusModel` 1P → `claude-opus-5`) | `src/utils/model/model.ts:163` | staged (3P providers may lag — keep 3P default unchanged, switch 1P) |
| 1b | `/model` picker Opus row → Opus 5, label `Opus 5 with 1M context` | `src/utils/model/modelOptions.ts` | staged (needs exact picker row shape + pricing suffix) |
| 1c | `MODEL_COSTS` pricing tier for opus-5 | `src/utils/modelCost.ts:101` | staged (fast-mode $10/$50 confirmed; base tier needs careful binary extraction — do NOT guess) |
| 1d | Fast-mode model set: Opus 5 + Opus 4.8 (remove 4.7) | `src/utils/fastMode.ts:143` | staged |
| 1e | `modelSupports1M` covers Opus 5 | `src/utils/context.ts:63` | staged |
| 1f | `checkOpus1mAccess` for Opus 5 | `src/utils/model/check1mAccess.ts:45` | staged |
| 1g | effort/thinking/betas/advisor allowlists for opus-5 | `src/utils/{effort,thinking,betas,advisor}.ts` | staged (mirror opus-4-8 per binary) |
| 1h | `claude-api` bundled skill default Opus 5 + migration from 4.8 | `src/skills/bundled/claudeApiContent.ts:31` | staged (skill content sync) |
| 1i | `/model` picker "highlight newest only" (Opus 5) | model picker | staged (UI) |
| 1j | `--model` help-text example ID | `src/main.tsx:1079` | staged |

### Other 2.1.219 P1–P4 (unchanged from OCC-34 §4, restated for completeness)
| # | 2.1.219 item | Priority | Status |
|---|---|---|---|
| 2 | `sandbox.network.strictAllowlist` setting | P1 | staged |
| 4 | `mcp_server_errors` in stream-json init | P1 | staged |
| 5 | `workflowSizeGuideline` settings key + `/config` hide | P2 | staged |
| 6 | nested subagent forwarding (depth-2+) under `--forward-subagent-text` | P2 | staged |
| 7 | `claude -p` keep answer on mid-stream API error | P2 | staged |
| 8 | `claude mcp list` / `/mcp` HTTP errors + MCP-config whitespace warning | P2 | staged |
| 18/21 | dynamic workflows default medium (<15 agents) + status line | P2 | staged |
| 19 | managed MCP allowlist/denylist `${VAR}` from startup env | P2 | staged |
| 10/14/15/20 | `/model` Opus (1M) label, Vim ←, screen-reader echo, highlight-newest | P3 | staged |
| 9/11/12/13/16/17 | Fable credits label, GNU screen, Remote Control, Windows git-bash, teleport | P4 | skip/doc (niche → by-design divergence) |

Full catch-up to `2.1.220` lands when the above close. Tracked-upstream pointer
advances to `2.1.219` **partial** (P0 + this round's Opus 5 canonical foundation
done) until the remaining Opus 5 launch sites + P1–P4 close; `2.1.220` remains
a no-op.
