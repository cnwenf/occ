# Upstream version gap — OCC-37 (2026-07-29)

> Carryover from `docs/upstream-version-gap-occ36.md` §6. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry (`@anthropic-ai/claude-code`); feature truth cross-checked against
> OCC `src/` and the decompiled official native ELF
> (`@anthropic-ai/claude-code-linux-x64@2.1.220`, 238,160 unique strings).

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.288` (`2026-07-27`, OCC-35) | `package.json` |
| OCC aligned Claude Code (start of round) | `2.1.218` fully aligned + `2.1.219` **partial** (P0 + Opus 5 canonical foundation + 1a/1e/1j downstream ports) | `CLAUDE.md` header; OCC-36 §4 |
| Official latest Claude Code (npm `latest` = `next`) | **`2.1.220`** (published `2026-07-24T23:11:21Z`; **unchanged since OCC-34, ~5 days**) | `npm view @anthropic-ai/claude-code version` |
| Official GitHub latest release | **`v2.1.220`** (`published 2026-07-25T01:35:55Z`) | `gh release view --repo anthropics/claude-code` |
| Official GitHub `CHANGELOG.md` top entries | `## 2.1.220`, `## 2.1.219` | npm timeline |
| Version gap vs official latest | **YES — carryover** `2.1.219` P1–P4 (Opus 5 launch remaining sites + P1–P4; `2.1.220` = no-op, **re-confirmed this round**) | this doc §3 |

**Conclusion: a real version gap still exists — the carryover `2.1.219`
P1–P4 backlog staged by OCC-34/OCC-35/OCC-36.** Official `latest` is
**unchanged at `2.1.220`** since OCC-34 (npm `time` tail:
`2.1.220 → 2026-07-24T23:11:21Z`; no new official release in the last ~5
days). `2.1.220` remains the no-op reliability layer — **re-confirmed this
round via binary strings diff (§3.2)**: no version marker beyond `2.1.220`,
no new env-var/settings-key/hook-name/command surface (the 12 new
camelCase identifiers 220-only are minifier artifacts like `onRetryStatusT`,
not real surface).

**Path taken this round: gap exists → align.** This round advances the
remaining **Opus 5 launch P1 sites** (1b/1c/1d/1g/1h/1i) — the decoupled,
binary-verified, non-breaking subset of the keystone. Per the issue's
"non-coupled features use parallel subagents" directive, the sites are
partitioned into 5 disjoint file-clusters and ported in parallel.

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.220` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.220`, `next=2.1.220`, `stable=2.1.212` | `npm view … dist-tags --json` |
| Official GitHub latest release | `v2.1.220` (`ashwin-ant`, `2026-07-25T01:35:55Z`) | `gh release view --repo anthropics/claude-code` |
| Official GitHub `CHANGELOG.md` top entry | `## 2.1.220` → "Bug fixes and reliability improvements" | GitHub raw `CHANGELOG.md` |
| OCC aligned version (start of round) | `2.1.218` + `2.1.219` partial (P0 + Opus 5 canonical + 1a/1e/1j) | `CLAUDE.md` header; OCC-36 |

Official version timeline (tail, unchanged since OCC-34):

```
2.1.220 → 2026-07-24T23:11:21Z   ← official latest (no-op reliability; re-confirmed no-op this round, §3.2)
2.1.219 → 2026-07-24T16:11:49Z   ← substantive surface; P0 + Opus 5 canonical + 1a/1e/1j done; P1–P4 open
2.1.218 → 2026-07-22T19:55:32Z   ← OCC fully aligned (OCC-31)
…
```

## 2. Methodology (skills used)

1. **Version truth** — `npm view @anthropic-ai/claude-code version/dist-tags/time` + `gh release view`. Per `upstream-tracking` §"Version truth".
2. **Binary decompilation** — `npm pack @anthropic-ai/claude-code-linux-x64@2.1.219` + `@2.1.220`; `tar -xzf`; `strings -n 8 package/claude | sort -u` (219: 238,192; 220: 238,160). Per `upstream-tracking` §"Native Binary Notes (2.1.113+)".
3. **No-op confirmation** — `comm -13 s219.txt s220.txt` filtered for new named surface + version markers. Per `aligning-with-official-binary` (no invented/partial implementations).
4. **Per-site token verification** — `grep -F`, `grep -oE` windowing, and `grep -aboF` + `dd` byte-level windowing (carried out by per-cluster subagents, §4). Per `aligning-with-official-binary`.
5. **Source cross-check** — `grep -rn` OCC `src/` for each site to confirm the divergence and port faithfully.

All downloaded binaries cleaned from `/tmp` after the round (resource-safety rule; `rm -rf /tmp/cc-occ37`).

## 3. Official changelog + no-op re-confirmation

### 3.1 Official changelog — 2.1.220 + 2.1.219 (unchanged from OCC-34/35/36)

#### 2.1.220
- Bug fixes and reliability improvements

#### 2.1.219 (Opus 5 launch + the P1–P4 backlog — relevant items bolded; full text in OCC-35 §3 / GitHub `CHANGELOG.md`)
- **Added Claude Opus 5 (`claude-opus-5`), now the default Opus model — 1M context, fast mode at $10/$50 per Mtok**
- **Added `sandbox.network.strictAllowlist` setting to deny non-allowlisted hosts for sandboxed commands without prompting** (P1 item 2)
- Added `DirectoryAdded` hook (P0 — landed OCC-34)
- **Added `mcp_server_errors` to the headless stream-json init event** (P1 item 4)
- **Added the `workflowSizeGuideline` settings key** (P2 item 5)
- **Added nested subagent forwarding in stream-json at depth-2+ under `--forward-subagent-text`** (P2 item 6)
- **Fixed `claude -p` text output dropping the answer already produced when a turn dies on a mid-stream API error** (P2 item 7)
- **Added HTTP status and error text to `claude mcp list` and `/mcp` + MCP-config whitespace warning** (P2 item 8)
- Fixed Fable credits label for plans that include it (P4)
- **Fixed the `/model` picker showing the merged Opus row as plain "Opus" instead of "Opus (1M context)"** (P3 item 10/14)
- Fixed GNU screen copy-on-select base64 (P4)
- Fixed Remote Control stale fast-mode status (P4)
- Fixed `CLAUDE_CODE_GIT_BASH_PATH` on Windows (P4)
- **Fixed Vim mode: ← on empty prompt returns to agent view from NORMAL mode** (P3 item 14)
- **Fixed screen-reader mode rewriting the entire input line on every keystroke** (P3 item 15)
- Improved Remote Control error to name the setting (P4)
- Improved `claude --teleport` to name the repo (P4)
- **Changed dynamic workflows to default to a medium size guideline (<15 agents) + status line shows it** (P2 item 18/21)
- **Changed managed MCP allowlist/denylist `${VAR}` to resolve from startup env** (P2 item 19)
- **Changed the `/model` picker to highlight only the newest model's name** (P3 item 20 — 1i)
- **Removed Opus 4.7 from fast mode; `/fast` now applies to Opus 5 and Opus 4.8** (1d)

### 3.2 2.1.220 no-op re-confirmation (binary strings diff)

```
# 219 vs 220 ELF unique strings
238192 s219.txt   (2.1.219)
238160 s220.txt   (2.1.220)   ← 220 has FEWER unique strings (internal churn, no new surface)

# version marker beyond 2.1.220?
$ grep -aoE "2\.1\.(22[1-9]|[3-9][0-9])" s220.txt | sort -u
(none)

# 2.1.219 surface tokens present in 2.1.220 binary?
strictAllowlist          PRESENT
mcp_server_errors        PRESENT
workflowSizeGuideline    PRESENT
DirectoryAdded           PRESENT
claude-opus-5            PRESENT
forward-subagent-text    PRESENT

# new camelCase identifiers 220-only (potential new settings/hook names)?
$ comm -13 s219.txt s220.txt | grep -aE "^[a-z][a-zA-Z]{10,}$" | sort -u
abcdefghijkmnopqrstuvwxyz        ← char-class alphabet string (minifier)
fallbackStampTriggerF            ← minifier artifact (trailing F)
hasPendingActions                ← internal state, not a settings key
hasSuppressedDialogs
isEntitlementOverlayUnavailable
keepPartialMessageOnAbortD       ← minifier artifact (trailing D)
onHintClearedg                   ← minifier artifact (trailing g)
onInputOverlayActiveChange
onRetryStatusT                   ← minifier artifact (trailing T)
refusalFallbackCascadeHopH       ← minifier artifact (trailing H)
supportsHydrationy               ← minifier artifact (trailing y)
unhideTextInstanceN              ← minifier artifact (trailing N)
```

→ **No new named surface** (no new env-var, settings key, hook name, or
command) in 2.1.220 vs 2.1.219. The 12 new camelCase identifiers are
minifier-mangled property names (note the trailing single letters) or
internal state fields, not portable feature surface. `2.1.220` is a
no-op reliability layer — nothing to port.

## 4. Carryover status + this round's plan

### 4.1 Opus 5 launch (P1) — remaining sites (OCC-36 §6 carryover)

| # | Item | Site (file) | Decoupled? | This round |
|---|------|-------------|-----------|------------|
| 1b | `/model` picker Opus row → `Opus 5 with 1M context` + pricing suffix | `src/utils/model/modelOptions.ts` | cluster D (with 1i) | **port** |
| 1c | `MODEL_COSTS` pricing tier for opus-5 (base + fast $10/$50) | `src/utils/modelCost.ts` | cluster B | **port** |
| 1d | Fast-mode model-resolution + support set (Opus 5 + Opus 4.8; **remove 4.7**) | `src/utils/fastMode.ts` | cluster A | **port** |
| 1g | effort/thinking/betas/advisor allowlists for opus-5 + **per-provider Opus default table (Gap-1: foundry → `claude-opus-4-6`)** | `src/utils/{effort,thinking,betas,advisor}.ts`; `src/utils/model/model.ts` `getDefaultOpusModel` | cluster E | **port** |
| 1h | `claude-api` bundled skill default Opus 5 + migration from 4.8 | `src/skills/bundled/claudeApiContent.ts` | cluster C | **port** |
| 1i | `/model` picker "highlight newest only" (Opus 5) | `src/utils/model/modelOptions.ts` | cluster D (with 1b) | **port** |

**Current divergence (pre-port), e.g. 1d**: `src/utils/fastMode.ts:181`
`isFastModeSupportedByModel` returns true for `opus-4-6`/`opus-4-7`/bare
`opus` — but 2.1.219 removed 4.7 and applies `/fast` to Opus 5 + Opus 4.8.
`FAST_MODE_MODEL_DISPLAY` (line 144) is `Opus 4.8` (correct display), but
the support predicate is stale. Real gap.

### 4.2 Parallel cluster partition (disjoint files → safe parallel)

| Cluster | Items | Files | Subagent |
|---------|-------|-------|----------|
| A | 1d | `src/utils/fastMode.ts` | subagent-A |
| B | 1c | `src/utils/modelCost.ts` | subagent-B |
| C | 1h | `src/skills/bundled/claudeApiContent.ts` | subagent-C |
| D | 1b + 1i | `src/utils/model/modelOptions.ts` | subagent-D |
| E | 1g + Gap-1 | `src/utils/{effort,thinking,betas,advisor}.ts`; `src/utils/model/model.ts` | subagent-E |

Each subagent recovers the exact upstream logic verbatim from the
decompiled 2.1.220 ELF (`/tmp/cc-occ37/package/claude`) via
`strings`/`grep`/`grep -aboF`+`dd`, ports it faithfully into OCC `src/`,
adds an e2e block, and reports the diff + e2e result. No invented/partial
implementations (per `aligning-with-official-binary`).

### 4.3 Other 2.1.219 P1–P4 (unchanged from OCC-36 §6, restated)

| # | 2.1.219 item | Priority | Status |
|---|--------------|----------|--------|
| 2 | `sandbox.network.strictAllowlist` setting | P1 | staged (next round) |
| 4 | `mcp_server_errors` in stream-json init | P1 | staged (next round) |
| 5 | `workflowSizeGuideline` settings key + `/config` hide | P2 | staged (next round) |
| 6 | nested subagent forwarding (depth-2+) under `--forward-subagent-text` | P2 | staged (next round) |
| 7 | `claude -p` keep answer on mid-stream API error | P2 | staged (next round) |
| 8 | `claude mcp list` / `/mcp` HTTP errors + MCP-config whitespace warning | P2 | staged (next round) |
| 18/21 | dynamic workflows default medium (<15 agents) + status line | P2 | staged (next round) |
| 19 | managed MCP allowlist/denylist `${VAR}` from startup env | P2 | staged (next round) |
| 10/14/15/20 | `/model` Opus (1M) label, Vim ←, screen-reader echo, highlight-newest | P3 | 1b/1i this round; Vim/screen-reader staged |
| 9/11/12/13/16/17 | Fable credits label, GNU screen, Remote Control, Windows git-bash, teleport | P4 | skip/doc (niche → by-design divergence) |

These are decoupled from the Opus 5 launch and from each other; they stay
staged for dedicated per-site rounds. `2.1.220` being a no-op means no new
pressure — the carryover is the full remaining gap.

## 5. Ports landed this run — Opus 5 launch remaining sites (1b/1c/1d/1g/1h/1i)

All five clusters ported in parallel (disjoint files), each recovered verbatim
from the decompiled 2.1.220 ELF — no behavior guessed. Per the issue's
"non-coupled features → parallel subagents" directive.

### 5.1 Cluster A — 1d fast-mode support set (`src/utils/fastMode.ts`)

Binary-verified predicate `mv(e)` (= `isFastModeSupportedByModel`), recovered
via `grep -oE` on `s220.txt`:

```js
function mv(e){if(!vl())return!1;let t=e??Z$(),r=vi(t);
  if(M$(lo(r),"fast_mode"))return!0;        // capability path (see §5.6 staged)
  let n=r.toLowerCase();
  return n.includes("opus-4-7")||n.includes("opus-4-8")||n.includes("opus-5")}
```

| # | Item | Change | Binary-verified |
|---|------|--------|-----------------|
| 1d | `isFastModeSupportedByModel` string fallback | `opus-4-6 \|\| opus-4-7 \|\| === 'opus'` → `opus-4-7 \|\| opus-4-8 \|\| opus-5` | ✓ `mv(e)` predicate verbatim |

**Critical discrepancy (flagged, not silently "fixed")**: the 2.1.219
changelog prose says "Removed Opus 4.7 from fast mode", but the 2.1.220
**binary** retains `opus-4-7` in the string fallback. Per
`aligning-with-official-binary` (binary is canonical), OCC mirrors the binary
exactly — `opus-4-7` IS fast-supported. `opus-4-6` confirmed removed; bare
`opus` no longer special-cased. Documented in a src comment + an e2e test that
pins the binary behavior and records the changelog divergence.

### 5.2 Cluster B — 1c MODEL_COSTS opus-5 tier (`src/utils/modelCost.ts`)

Binary-verified cost objects (offsets in §5 of subagent report):

- Base tier = `tier_5_25` → **$5/$25** per Mtok (input:5, output:25,
  cache_write_5m:6.25, cache_read:0.5, web_search:0.01). opus-5 catalog entry
  carries `pricing:"tier_5_25"`.
- Fast tier = `a7n` → **$10/$50** per Mtok (confirmed vs 2.1.219 changelog
  "fast mode at $10/$50 per Mtok").
- `getModelCosts` fast branch (`Dji`): `if(speed==="fast"){
  if(r==="claude-opus-4-8"||r==="claude-opus-5")return a7n;
  if(r==="claude-opus-4-6"||r==="claude-opus-4-7")return UIc}` — ported verbatim.

| # | Item | Change | Binary-verified |
|---|------|--------|-----------------|
| 1c | `MODEL_COSTS["claude-opus-5"]` base + fast tier + `getModelCosts` fast branch | added `COST_TIER_10_50` (= `a7n`) + `getOpus5CostTier(fast)` + opus-5 entry (`COST_TIER_5_25`) + fast-mode branch | ✓ `a7n`/`UIc`/`Dji` verbatim |

**Staged (not guessed)**: the binary's `ModelCosts` shape has an extra
`promptCacheWrite1hTokens` field (base:10, fast:20) not in OCC's 5-field type.
OCC's type left unchanged; the 1h value omitted — staged for a type-shape round.

### 5.3 Cluster C — 1h `claude-api` skill (`src/skills/bundled/claudeApiContent.ts`)

Binary-verified skill model-var table (offset 243150700–243157312):

```
OPUS_ID=claude-opus-5  OPUS_NAME=Claude Opus 5
PREV_OPUS_ID=claude-opus-4-8  PREV_OPUS_NAME=Claude Opus 4.8
```

| # | Item | Change | Binary-verified |
|---|------|--------|-----------------|
| 1h | `SKILL_MODEL_VARS` Opus migration | `OPUS_ID 4-6→5`, `OPUS_NAME 4.6→5`, added `PREV_OPUS_ID/NAME=4-8` | ✓ skill var table verbatim |

### 5.4 Cluster D — 1b + 1i model picker (`src/utils/model/modelOptions.ts`)

Binary-verified picker builders: `UBc` (1M row, offset 249528600),
`PWi` (merged, 249530691), `XBc` (plain, 249527118), `_5r` (pricing suffix,
249352477). 1i mechanism = `$Yo` map (offset 262593244)
`.replaceAll("Opus 5", highlighted)` — not a boolean field; "highlight newest
only" reduces to: only opus-5 rows carry the literal "Opus 5" substring.

| # | Item | Change | Binary-verified |
|---|------|--------|-----------------|
| 1b | Opus row label `Opus (1M context)` + opus-5 pricing suffix | `getOpus5_1MOption`/`getMaxOpus5_1MOption`/`getMergedOpus1MOption` label `Opus (1M context)`, suffix reads opus-5 cost (`$5/$25` base, `(↯)$10/$50` fast) | ✓ `UBc`/`PWi` label + `_5r` suffix format verbatim |
| 1i | highlight-newest data layer | opus-5 rows carry literal "Opus 5"; legacy rows (4.1/4.6/4.7) do not | ✓ `$Yo` `.replaceAll("Opus 5", …)` mechanism |

**Staged**: the actual `.replaceAll("Opus 5", highlighted)` render lives in
`ModelPicker.tsx` (outside this cluster's file scope). The 1i port here is the
data layer the binary's mechanism reduces to. Wiring the picker-UI render is a
separate picker-UI task.

### 5.5 Cluster E — 1g allowlists + Gap-1 per_provider (`src/utils/{effort,thinking,betas,advisor}.ts` + `src/utils/model/model.ts`)

Binary-verified per_provider Opus alias table (offset 247207842):

```
aliases:{opus:{default:"claude-opus-5",
  per_provider:{bedrock:"claude-opus-5",vertex:"claude-opus-5",
    foundry:"claude-opus-4-6",            ← foundry lags one generation (Gap-1)
    mantle:"claude-opus-5",anthropic_aws:"claude-opus-5",
    gateway:"claude-opus-4-7"}}}
```

**Gap-1 reconciliation (closed this round)**: OCC-36 §4.1 listed
`foundry:"claude-opus-5"` in the table text but Gap-1 said the resolved
foundry value was `claude-opus-4-6`. The binary confirms the **table value
itself** is `claude-opus-4-6` (no separate lag table) — OCC-36 §4.1 had a
transcription error. OCC now ports the faithful per_provider branch: foundry →
`claude-opus-4-6`, gateway → `claude-opus-4-7`, everything else → `claude-opus-5`.

opus-5 capabilities array (recovered verbatim, region ~177163000):
`["effort","max_effort","xhigh_effort","adaptive_thinking","mid_conv_system",
"context_management","fast_mode","lean_prompt","refusal_fallback",
"opus_5_prompt_bundle"]`, `default_effort:"high"`, `advisor_rank:4`.
opus-5 mirrors opus-4-8 for effort/max/xhigh/adaptive/contextMgmt/advisor +
two opus-5-only caps.

| # | Item | Change | Binary-verified |
|---|------|--------|-----------------|
| 1g | `getDefaultOpusModel` per_provider branch (Gap-1) | flattened non-gateway return → per_provider: foundry→4-6, gateway→4-7, else→5 | ✓ per_provider table verbatim |
| 1g | effort/max_effort/xhigh_effort allowlists | added `opus-5` to each `modelSupports*` true-branch | ✓ caps "effort"/"max_effort"/"xhigh_effort" |
| 1g | adaptive_thinking / context_management allowlists | added `opus-5` to `modelSupportsAdaptiveThinking` + `modelSupportsContextManagement` 3P branch | ✓ caps "adaptive_thinking"/"context_management" |
| 1g | advisor allowlists | added `opus-5` to `modelSupportsAdvisor` + `isValidAdvisorModel` | ✓ `advisor_rank:4` |

**Staged (ambiguous → not guessed)**: `modelSupportsThinking` and
`modelSupportsISP` 3P branches for opus-5 left unchanged — `thinking`/ISP are
not model-registry capabilities (custom provider logic); the binary's exact 3P
verdict for opus-5 was ambiguous in the string dumps (bytecode near offset
~102185072 interleaves the ISP/thinking fn with the registry-map construction).
Per `aligning-with-official-binary` "STOP if ambiguous", not shipped. 1P/foundry
already return true for opus-5, so only the 3P path is affected — same class
of pre-existing divergence noted in the OCC-36 carryover.

### 5.6 Could not port (staged, not guessed) — summary

- **1d capability path** `M$(lo(r),"fast_mode")` — fully recovered but OCC's
  `modelCapabilities.ts` is ant-only/stubbed (no `capabilities` array). Porting
  needs a model-capability registry across multiple src files. String fallback
  (ported verbatim) is the load-bearing predicate for the listed Opus models.
- **1c `promptCacheWrite1hTokens` field** — binary's ModelCosts shape has it
  (base:10, fast:20); OCC's 5-field type left unchanged.
- **1i picker-UI render** — `.replaceAll("Opus 5", highlighted)` lives in
  `ModelPicker.tsx`; data layer ported, render wiring is a picker-UI task.
- **1g `modelSupportsThinking`/`modelSupportsISP` 3P branches for opus-5** —
  ambiguous in the binary; left unchanged (1P/foundry already cover opus-5).

## 6. Verification (this round)

- **Build**: `bun run build` green → `dist/cli.js` 28.84 MB, `MACRO.VERSION=2.1.289`, `MACRO.BINARY_NAME=occ`.
- **Ported-feature e2e**: `bun test ./test/e2e/version-2.1.219-opus5.e2e.test.ts ./test/e2e/version-2.1.197-models.e2e.test.ts` → **36 pass, 0 fail** (139 expect() calls). The `version-2.1.219-opus5` file now carries 7 describe blocks (2 pre-existing + 1a/1e/1j from OCC-36 + 5 new: 1b/1i, 1c, 1d, 1g, 1h).
- **Command-surface e2e (built artifact)**: `bun test ./test/e2e/occ-versioning.e2e.test.ts` → 1 pass (`occ --version` → `OCC 2.1.289`, no "Claude Code" leak); `./test/e2e/commands-alignment.e2e.test.ts` → 5 pass, 0 fail.
- **REPL smoke**: `bun dist/cli.js --version` → `OCC 2.1.289`; `--help` `--model` line byte-matches the binary (`(e.g. 'fable', 'opus', or 'sonnet') … (e.g. 'claude-fable-5')`). Live TUI/REPL acceptance e2e deferred to a non-sandbox environment per the OCC-11 sandbox-stall constraint (unchanged from OCC-36).
- **Lint**: `biome lint` on the 9 changed `src/` files → 0 errors (2 pre-existing unrelated `biome-ignore` warnings in `betas.ts`, not introduced this round).
- **Resource safety**: all downloaded binaries cleaned from `/tmp` after the round (`rm -rf /tmp/cc-occ37`).

## 7. Tracked-upstream pointer (end of round)

OCC is now caught up through `2.1.218` fully + `2.1.219` **partial** (P0 +
Opus 5 canonical foundation + the full Opus 5 launch downstream sites
1a/1b/1c/1d/1e/1f/1g/1h/1i/1j). The remaining gap is the rest of the
`2.1.219` P1–P4 backlog (items 2/4/5/6/7/8/18/19/21 + Vim/screen-reader P3 +
niche P4) — staged for dedicated per-site rounds. `2.1.220` remains a no-op
reliability layer (re-confirmed this round, §3.2).
