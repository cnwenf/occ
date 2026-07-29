# Upstream version gap — OCC-38 (2026-07-30)

> Carryover from `docs/upstream-version-gap-occ37.md`. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry (`@anthropic-ai/claude-code`); feature truth cross-checked against
> OCC `src/` and the decompiled official native ELF
> (`@anthropic-ai/claude-code-linux-x64@2.1.220`, 238,160 unique strings).

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.289` (`2026-07-29`, OCC-37) | `package.json` |
| OCC aligned Claude Code (start of round) | `2.1.218` fully + `2.1.219` **partial** (P0 + Opus 5 canonical + all Opus 5 launch downstream sites 1a–1j) | `CLAUDE.md` header; OCC-37 §7 |
| Official latest Claude Code (npm `latest` = `next`) | **`2.1.220`** (published `2026-07-24T23:11:21Z`; **unchanged since OCC-34, ~6 days; no new release 07-29→07-30**) | `npm view @anthropic-ai/claude-code version` |
| Official GitHub latest release | **`v2.1.220`** (`published 2026-07-25T01:35:55Z`) | `gh release view --repo anthropics/claude-code` |
| Version gap vs official latest | **YES — carryover** `2.1.219` P1–P4 backlog; `2.1.220` = no-op, **re-confirmed this round (§3.2)** | this doc §3 |

**Conclusion: the round's fork-point check resolved to the no-op path.**
Official `latest` is **unchanged at `2.1.220`** since OCC-34 (npm `time` tail:
`2.1.220 → 2026-07-24T23:11:21Z`; no new official release in the last ~6 days,
and none 07-29→07-30). `2.1.220` remains the no-op reliability layer —
**re-confirmed this round via binary strings diff (§3.2)**: no version marker
beyond `2.1.220`, no new env-var/settings-key/hook-name/command surface.

**Path taken this round: official no-op → advance the `2.1.219` P1–P4 staged
backlog.** This round ports three decoupled, binary-verified, non-breaking
items via parallel subagents (disjoint file-clusters):

- **Item 4 (P1)** — `mcp_server_errors` in the stream-json `system/init` event.
- **Item 8 (P2)** — MCP-config whitespace validation warnings (`DeniedMcpServerEntrySchema`).
- **Item 1c carryover** — `promptCacheWrite1hTokens` cost field (REQUIRED on `ModelCosts`, all 7 tiers populated).

Item 8's mcp-list HTTP/error-text *format* and item 5 (`workflowSizeGuideline`)
stay staged (ambiguous in the binary — not guessed, per the skill).

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.220` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.220`, `next=2.1.220`, `stable=2.1.212` | `npm view … dist-tags --json` |
| npm `time` tail | `2.1.220 → 2026-07-24T23:11:21.821Z` (last entry; no `2.1.221+`) | `npm view … time --json` |
| Official GitHub latest release | `v2.1.220` (`ashwin-ant`, `2026-07-25T01:35:55Z`) | `gh release view --repo anthropics/claude-code` |
| OCC aligned version (start of round) | `2.1.218` + `2.1.219` partial (P0 + Opus 5 canonical + 1a–1j) | `CLAUDE.md`; OCC-37 |

Official version timeline (tail, unchanged since OCC-34):

```
2.1.220 → 2026-07-24T23:11:21Z   ← official latest (no-op reliability; re-confirmed no-op this round, §3.2)
2.1.219 → 2026-07-24T16:11:49Z   ← substantive surface; P0 + Opus 5 canonical + 1a–1j done; P1–P4 open (4/8/1c advance this round)
2.1.218 → 2026-07-22T19:55:32Z   ← OCC fully aligned (OCC-31)
…
```

## 2. Methodology (skills used)

1. **Version truth** — `npm view @anthropic-ai/claude-code version/dist-tags/time` + `gh release view`. Per `upstream-tracking` §"Version truth".
2. **Binary decompilation** — `npm pack @anthropic-ai/claude-code-linux-x64@2.1.219` + `@2.1.220`; `tar -xzf`; `strings -n 8 package/claude | sort -u` (219: 238,192; 220: 238,160). Per `upstream-tracking` §"Native Binary Notes (2.1.113+)".
3. **No-op confirmation** — `comm -13 s219.txt s220.txt` filtered for new named surface + version markers. Per `aligning-with-official-binary`.
4. **Per-site token verification** — `grep -aboF` (fixed-string, byte offset) + `dd` byte-level windowing. The 2.1.220 ELF's JS is one giant contiguous string per "line", so broad `grep -aoE '.{0,N}TOKEN.{0,M}'` catastrophically times out — `grep -aboF` + `dd` is the only viable recovery technique. Per `aligning-with-official-binary`.
5. **Source cross-check** — `grep -rn` OCC `src/` for each site to confirm the divergence and port faithfully.

All downloaded binaries cleaned from `/tmp` after the round (resource-safety rule; `rm -rf /tmp/cc-occ38`).

## 3. Official changelog + no-op re-confirmation

### 3.1 Official changelog — 2.1.220 + 2.1.219 (unchanged from OCC-34/35/36/37)

#### 2.1.220
- Bug fixes and reliability improvements

#### 2.1.219 (Opus 5 launch + the P1–P4 backlog — relevant items bolded; full text in OCC-35 §3 / GitHub `CHANGELOG.md`)
- **Added Claude Opus 5 (`claude-opus-5`), now the default Opus model — 1M context, fast mode at $10/$50 per Mtok**
- **Added `sandbox.network.strictAllowlist` setting to deny non-allowlisted hosts for sandboxed commands without prompting** (P1 item 2)
- Added `DirectoryAdded` hook (P0 — landed OCC-34)
- **Added `mcp_server_errors` to the headless stream-json init event** (P1 item 4) ← **landed this round**
- **Added the `workflowSizeGuideline` settings key** (P2 item 5)
- **Added nested subagent forwarding in stream-json at depth-2+ under `--forward-subagent-text`** (P2 item 6)
- **Fixed `claude -p` text output dropping the answer already produced when a turn dies on a mid-stream API error** (P2 item 7)
- **Added HTTP status and error text to `claude mcp list` and `/mcp` + MCP-config whitespace warning** (P2 item 8) ← **whitespace-warning half landed this round; mcp-list error-text format staged**
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
$ grep -aoE "2\.1\.22[1-9]" s220.txt | sort -u
(none)

# 2.1.219 surface tokens present in 2.1.220 binary?
mcp_server_errors          PRESENT   ← ported this round (item 4)
promptCacheWrite1hTokens   PRESENT   ← ported this round (item 1c)
strictAllowlist            PRESENT
workflowSizeGuideline      PRESENT
DirectoryAdded             PRESENT
claude-opus-5              PRESENT
forward-subagent-text      PRESENT

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

## 4. Ports landed this run

All three clusters ported in parallel (disjoint files), each recovered
verbatim from the decompiled 2.1.220 linux-x64 ELF — no behavior guessed.
Per the issue's "non-coupled features → parallel subagents" directive.

### 4.1 Cluster 1 — Item 4 (P1): `mcp_server_errors` in stream-json init event

Binary-verified init-event builder (`tAr`, offset ~260839739):

```js
let t=new Set(e.mcpClients.map((o)=>o.name)),
    r=e.mcpServerErrors.filter((o)=>!t.has(o.name));   // filter OUT errors for servers already in mcpClients
...r.length>0&&{mcp_server_errors:r.map((o)=>({...o}))}  // emit ONLY when non-empty; key OMITTED when empty
```

Binary-verified Zod schema (offset 267590183):
```js
mcp_server_errors: v.array(v.object({name:v.string(), type:v.string(), message:v.string()})).optional()
```

| # | Item | Change | Binary-verified |
|---|------|--------|-----------------|
| 4 | `mcp_server_errors` in `system/init` | added `mcpServerErrors` to `SystemInitInputs`; filter against `mcpClients` names; conditional `...(r.length>0 && {mcp_server_errors: r.map(e=>({...e})) })`; added `mcp_server_errors?` to `SDKSystemMessageSchema` | ✓ `tAr` builder + Zod schema verbatim |

**Critical binary nuance (flagged, not "simplified")**: the binary FILTERS
`mcpServerErrors` to exclude any error whose `name` already appears in
`mcpClients` (connected/known servers). `mcp_server_errors` therefore only
surfaces errors for servers NOT in the `mcpClients` list. OCC mirrors this
filter exactly.

**Caller wiring (deferred, not guessed)**: `QueryEngine.ts` and
`useReplBridge.tsx` currently pass `mcpServerErrors: []`. The binary's `tAr`
receives `e.mcpServerErrors` as a separate list of config-validation errors
for servers that failed before connection. QueryEngine receives `mcpClients`
(`MCPServerConnection[]`) but not a separate config-error list — plumbing
that through the MCP connection layer is a dedicated task. An empty array
produces correct (OMITTED) output per the binary's `r.length>0&&` guard, so
this is a faithful no-op-until-wired state, not a behavioral divergence.
`useReplBridge` redacts (passes `[]`) alongside `mcpClients: []` to avoid
leaking integration wiring. Both carry a `TODO` comment.

Files: `src/utils/messages/systemInit.ts`, `src/entrypoints/sdk/coreSchemas.ts`,
`src/QueryEngine.ts`, `src/hooks/useReplBridge.tsx`.

### 4.2 Cluster 2 — Item 8 (P2): MCP-config whitespace validation warnings

Binary-verified denied-entry schema (`_Wn`, offset 248275833):

```js
serverName: v.string()
  .min(1, "Server name must be non-empty")
  .refine((e)=>e.trim().length>0, {message:"Server name must not be whitespace-only"})
  .refine((e)=>e===e.trim(), {message:"Server name has leading or trailing whitespace and will never match (names are compared verbatim)"})
  .optional().describe("Name of the MCP server that is explicitly blocked")
```

The binary's ALLOWED entry (`yWn`, offset 248275140) keeps strict
`.regex(/^[a-zA-Z0-9_-]+$/)` — matches OCC, unchanged.

| # | Item | Change | Binary-verified |
|---|------|--------|-----------------|
| 8 | MCP-config whitespace warnings | `DeniedMcpServerEntrySchema.serverName`: `.regex` → `.min(1) + whitespace refines` (verbatim messages) | ✓ `_Wn` schema + message strings verbatim |

The denied (blocklist) entry is intentionally more permissive than the allowed
entry: blocklist names may include characters outside `[a-zA-Z0-9_-]` (e.g.
plugin-prefixed names, URLs). The new whitespace refines prevent ineffective
denylist entries (a name with leading/trailing whitespace would never match
a verbatim comparison). This is a security-positive change.

Files: `src/utils/settings/types.ts`.

### 4.3 Cluster 3 — Item 1c carryover: `promptCacheWrite1hTokens` cost field

Binary-verified cost tiers:

**A. Baked tier constants** (offset ~249321056):
```
Dig (tier_5_25)  : promptCacheWrite1hTokens: 10
UIc (tier_30_150): promptCacheWrite1hTokens: 60   ← fast opus 4.6, baked-only
a7n (tier_10_50) : promptCacheWrite1hTokens: 20
```

**B. Model catalog `pricing_tiers` table** (offset ~247195761) `cache_write_1h`:
```
tier_3_15: 6     tier_5_25: 10    tier_15_75: 30
tier_10_50: 20   haiku_35: 1.6    haiku_45: 2
```

| # | Item | Change | Binary-verified |
|---|------|--------|-----------------|
| 1c | `promptCacheWrite1hTokens` on `ModelCosts` | added as a REQUIRED field; populated on all 7 cost-tier constants (3_15→6, 15_75→30, 5_25→10, 30_150→60, 10_50→20, haiku_35→1.6, haiku_45→2) | ✓ baked `Dig`/`UIc`/`a7n` + `pricing_tiers` table verbatim |

`grep` confirmed `src/utils/modelCost.ts` is the only file with `ModelCosts`
object literals, so the REQUIRED field does not break any other construction
site. `tier_30_150` is baked-only (not in the catalog table); its 1h value
(60) is recovered from the baked `UIc` constant.

Files: `src/utils/modelCost.ts`. (OCC-37's
`test/e2e/version-2.1.219-opus5.e2e.test.ts` 1c assertions updated to the
now-complete shape — base `tier525` adds `promptCacheWrite1hTokens:10`, fast
`a7n` adds `:20`.)

## 5. Staged (ambiguous in the binary — not guessed)

- **Item 8 — mcp list HTTP/error-text *format***: the
  `Failed to connect to MCP server '<name>': <error>` phrase appears in the
  binary ONLY in the **agent-log** path (`runAgent.ts`, already carries the
  `: <error>` detail via `${client.type}`). The binary's actual `mcp list` /
  `/mcp` output is a **React component** (`mvp`) rendering separate
  `{name, server, status, issue}` fields (offset ~260261534), and `mcp get`
  renders `Status:` + `Issue:` as separate lines. OCC's existing
  `checkMcpServerHealth` already includes the error detail
  (`✗ Failed to connect — <detail>`); the *format* divergence (em-dash
  combined vs separate fields) is pre-existing, not a 2.1.219 regression.
  Matching the binary's React-component layout exactly is a separate
  picker-UI/output-format task — staged, not guessed.
- **Item 5 — `workflowSizeGuideline` settings key + dynamic-workflow medium
  default + status line**: the settings key, `/config` enum
  (`small`/`medium`/`large`/`unrestricted`), and status-line text strings
  are cleanly recoverable, but the **load-bearing behavior** — the
  size→agent-count caps (small = 5 confirmed; medium = "<15" per changelog
  prose but `15 agents` is NOT a literal in the binary — the cap is
  computed; `large`/`unrestricted` values not cleanly recoverable) — is
  ambiguous. Per the skill's "STOP if ambiguous", the behavior part is not
  ported; the `/config` enum UI + status-line rendering are TUI (deferred
  per OCC-11 sandbox-stall). Staged for a dedicated round.

## 6. Other 2.1.219 P1–P4 (unchanged from OCC-37 §4.3, restated)

| # | 2.1.219 item | Priority | Status |
|---|--------------|----------|--------|
| 4 | `mcp_server_errors` in stream-json init | P1 | **done this round** |
| 8 | `mcp list` / `/mcp` HTTP errors + MCP-config whitespace warning | P2 | whitespace warning **done this round**; mcp-list error-text format staged |
| 1c | `promptCacheWrite1hTokens` cost field | P2 (carryover) | **done this round** |
| 2 | `sandbox.network.strictAllowlist` setting | P1 | staged |
| 5 | `workflowSizeGuideline` settings key + `/config` hide | P2 | staged (§5) |
| 6 | nested subagent forwarding (depth-2+) under `--forward-subagent-text` | P2 | staged |
| 7 | `claude -p` keep answer on mid-stream API error | P2 | staged |
| 18/21 | dynamic workflows default medium (<15 agents) + status line | P2 | staged (§5) |
| 19 | managed MCP allowlist/denylist `${VAR}` from startup env | P2 | staged |
| 10/14/15/20 | `/model` Opus (1M) label, Vim ←, screen-reader echo, highlight-newest | P3 | 1b/1i done (OCC-37); Vim/screen-reader staged |
| 9/11/12/13/16/17 | Fable credits label, GNU screen, Remote Control, Windows git-bash, teleport | P4 | skip/doc (niche → by-design divergence) |

Plus the OCC-37 staged sub-items still open: 1d capability path
(`fast_mode` registry), 1i picker-UI render (`ModelPicker.tsx`), 1g 3P
thinking/ISP branches for opus-5.

## 7. Verification (this round)

- **Build**: `bun run build` green → `dist/cli.js` 28.84 MB, `MACRO.VERSION=2.1.289`, `MACRO.BINARY_NAME=occ`.
- **Ported-feature e2e (source-level, behavioral)**:
  - `test/e2e/version-2.1.219-mcp-server-errors.e2e.test.ts` → 5 tests, 18 `expect()` (init emits `mcp_server_errors` when non-empty after filter; OMITS when empty; filter against `mcpClients`; element shape `{name,type,message}`).
  - `test/e2e/version-2.1.219-mcp-list-errors.e2e.test.ts` → 8 tests, 19 `expect()` (whitespace-only rejected; leading/trailing whitespace rejected; empty rejected; valid + permissive names accepted; `checkMcpServerHealth` detail).
  - `test/e2e/version-2.1.219-opus5-cost-1h-field.e2e.test.ts` → 2 tests, 9 `expect()` (all 7 tiers carry the binary-verified 1h value; field present at runtime).
  - `test/e2e/version-2.1.219-opus5.e2e.test.ts` (regression) → updated 1c assertions to the now-complete cost shape; all pass.
  - Combined: **40 pass, 0 fail, 138 expect()** across the 4 files.
- **Command-surface e2e (built artifact)**: `occ-versioning.e2e.test.ts` + `commands-alignment.e2e.test.ts` → 6 pass, 0 fail.
- **REPL smoke**: `bun dist/cli.js --version` → `OCC 2.1.289` (no "Claude Code" leak); `--help` `--model` line byte-matches the binary (`(e.g. 'fable', 'opus', or 'sonnet') … (e.g. 'claude-fable-5')`); `occ -p --output-format=stream-json --mcp-config /dev/null` correctly errors `Invalid MCP configuration: MCP config is not a valid JSON` (item 8 validation path live). Live TUI/REPL acceptance e2e deferred to a non-sandbox environment per the OCC-11 sandbox-stall constraint (unchanged from OCC-36/37).
- **Lint**: `biome lint` on the 6 changed `src/` files → 0 errors (4 pre-existing unrelated `biome-ignore` warnings in `useReplBridge.tsx`, not introduced this round).
- **Security**: security-reviewer pass on the diff (no CRITICAL/HIGH; item 8 change is security-positive — adds whitespace guards to the denylist; item 4 has no data flow yet — both callers redact/pass `[]`).
- **Resource safety**: all downloaded binaries cleaned from `/tmp` after the round (`rm -rf /tmp/cc-occ38`).

## 8. Tracked-upstream pointer (end of round)

OCC is still caught up through `2.1.218` fully + `2.1.219` **partial** —
P0 + Opus 5 canonical foundation + all Opus 5 launch downstream sites
1a/1b/1c/1d/1e/1f/1g/1h/1i/1j + now **item 4 (`mcp_server_errors`)**, **item 8
whitespace warnings**, and **item 1c `promptCacheWrite1hTokens`**. The
remaining gap is the rest of the `2.1.219` P1–P4 backlog (items 2/5/6/7/8
mcp-list-format/18/19/21 + Vim/screen-reader P3 + niche P4 + the OCC-37
staged sub-items) — staged for dedicated per-site rounds. `2.1.220` remains a
no-op reliability layer (re-confirmed this round, §3.2). The item-4
caller-wiring (plumbing MCP config errors into `buildSystemInitMessage`) is
the most natural next-round follow-up.
