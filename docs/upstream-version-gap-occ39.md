# Upstream version gap — OCC-39 (2026-07-31)

> Carryover from `docs/upstream-version-gap-occ38.md`. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry (`@anthropic-ai/claude-code`); feature truth cross-checked against
> OCC `src/` and the decompiled official native ELF
> (`@anthropic-ai/claude-code-linux-x64@2.1.220`, 238,160 unique strings).

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.290` (`2026-07-30`, OCC-38) | `package.json` |
| OCC aligned Claude Code (start of round) | `2.1.218` fully + `2.1.219` **partial** (P0 + Opus 5 canonical + all Opus 5 launch downstream sites 1a–1j + item 4 `mcp_server_errors` + item 8 whitespace warnings + item 1c `promptCacheWrite1hTokens`) | `CLAUDE.md` header; OCC-38 §8 |
| Official latest Claude Code (npm `latest` = `next`) | **`2.1.220`** (published `2026-07-24T23:11:21Z`; **unchanged since OCC-34, ~7 days; no new release 07-30→07-31**) | `npm view @anthropic-ai/claude-code version` |
| Official GitHub latest release | **`v2.1.220`** (`published 2026-07-25T01:35:55Z`) | `gh api repos/anthropics/claude-code/releases` |
| Version gap vs official latest | **YES — carryover** `2.1.219` P1–P4 backlog; `2.1.220` = no-op, **re-confirmed this round (§3.2)** | this doc §3 |

**Conclusion: the round's fork-point check resolved to the no-op path.**
Official `latest` is **unchanged at `2.1.220`** since OCC-34 (npm `time` tail:
`2.1.220 → 2026-07-24T23:11:21Z`; no new official release in the last ~7 days,
and none 07-30→07-31). `2.1.220` remains the no-op reliability layer —
**re-confirmed this round via binary strings diff (§3.2)**: no version marker
beyond `2.1.220`, no new env-var/settings-key/hook-name/command surface.

**Path taken this round: official no-op → advance the `2.1.219` P1–P4 staged
backlog.** This round ports one decoupled, binary-verified, non-breaking item
(item 2, the highest-priority remaining P1), recovered verbatim from the
decompiled 2.1.220 linux-x64 ELF (no invented/partial implementation):

- **Item 2 (P1)** — `sandbox.network.strictAllowlist` settings key +
  deny-without-prompt enforcement (`src/entrypoints/sandboxTypes.ts`,
  `src/utils/sandbox/sandbox-adapter.ts`).

Items 5 (`workflowSizeGuideline` behavior), 6, 7, 18/21, 19, the item-4
caller-wiring, and item-8 mcp-list error-text *format* stay staged
(ambiguous in the binary — not guessed, per the skill). See §5–§6.

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.220` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.220`, `next=2.1.220`, `stable=2.1.212` | `npm view … dist-tags --json` |
| npm `time` tail | `2.1.220 → 2026-07-24T23:11:21.821Z` (last entry; no `2.1.221+`) | `npm view … time --json` |
| Official GitHub latest release | `v2.1.220` (`ashwin-ant`, `2026-07-25T01:35:55Z`) | `gh api repos/anthropics/claude-code/releases` |
| OCC aligned version (start of round) | `2.1.218` + `2.1.219` partial (P0 + Opus 5 canonical + 1a–1j + 4 + 8-ws + 1c) | `CLAUDE.md`; OCC-38 |

Official version timeline (tail, unchanged since OCC-34):

```
2.1.220 → 2026-07-24T23:11:21Z   ← official latest (no-op reliability; re-confirmed no-op this round, §3.2)
2.1.219 → 2026-07-24T16:11:49Z   ← substantive surface; P0 + Opus 5 canonical + 1a–1j + 4 + 8-ws + 1c done; P1–P4 open (item 2 advances this round)
2.1.218 → 2026-07-22T19:55:32Z   ← OCC fully aligned (OCC-31)
…
```

## 2. Methodology (skills used)

1. **Version truth** — `npm view @anthropic-ai/claude-code version/dist-tags/time` + `gh api repos/anthropics/claude-code/releases`. Per `upstream-tracking` §"Version truth".
2. **Binary decompilation** — `npm pack @anthropic-ai/claude-code-linux-x64@2.1.220`; `tar -xzf`; `strings -n 8 package/claude | sort -u` (220: 238,160 unique strings). Per `upstream-tracking` §"Native Binary Notes (2.1.113+)".
3. **No-op confirmation** — version-marker + new-named-surface scan (§3.2). Per `aligning-with-official-binary`.
4. **Per-site token verification** — `grep -aboF` (fixed-string, byte offset) + `dd` byte-level windowing. The 2.1.220 ELF's JS is one giant contiguous string per "line", so broad `grep -aoE '.{0,N}TOKEN.{0,M}'` catastrophically times out — `grep -aboF` + `dd` is the only viable recovery technique. Per `aligning-with-official-binary`.
5. **Source cross-check** — `grep -rn` OCC `src/` for each site to confirm the divergence and port faithfully.

All downloaded binaries cleaned from `/tmp` after the round (resource-safety rule; `rm -rf /tmp/cc-occ39`).

## 3. Official changelog + no-op re-confirmation

### 3.1 Official changelog — 2.1.220 + 2.1.219 (unchanged from OCC-34/35/36/37/38)

#### 2.1.220
- Bug fixes and reliability improvements

#### 2.1.219 (Opus 5 launch + the P1–P4 backlog — relevant items bolded; full text in OCC-35 §3 / GitHub `CHANGELOG.md`)
- **Added Claude Opus 5 (`claude-opus-5`), now the default Opus model — 1M context, fast mode at $10/$50 per Mtok**
- **Added `sandbox.network.strictAllowlist` setting to deny non-allowlisted hosts for sandboxed commands without prompting** (P1 item 2) ← **landed this round**
- Added `DirectoryAdded` hook (P0 — landed OCC-34)
- Added `mcp_server_errors` to the headless stream-json init event (P1 item 4) — landed OCC-38
- Added the `workflowSizeGuideline` settings key (P2 item 5)
- Added nested subagent forwarding in stream-json at depth-2+ under `--forward-subagent-text` (P2 item 6)
- Fixed `claude -p` text output dropping the answer already produced when a turn dies on a mid-stream API error (P2 item 7)
- Added HTTP status and error text to `claude mcp list` and `/mcp` + MCP-config whitespace warning (P2 item 8) — whitespace-warning half landed OCC-38; mcp-list error-text format staged
- Fixed Fable credits label for plans that include it (P4)
- Fixed the `/model` picker showing the merged Opus row as plain "Opus" instead of "Opus (1M context)" (P3 item 10/14)
- Fixed GNU screen copy-on-select base64 (P4)
- Fixed Remote Control stale fast-mode status (P4)
- Fixed `CLAUDE_CODE_GIT_BASH_PATH` on Windows (P4)
- Fixed Vim mode: ← on empty prompt returns to agent view from NORMAL mode (P3 item 14)
- Fixed screen-reader mode rewriting the entire input line on every keystroke (P3 item 15)
- Improved Remote Control error to name the setting (P4)
- Improved `claude --teleport` to name the repo (P4)
- Changed dynamic workflows to default to a medium size guideline (<15 agents) + status line shows it (P2 item 18/21)
- Changed managed MCP allowlist/denylist `${VAR}` to resolve from startup env (P2 item 19)
- Changed the `/model` picker to highlight only the newest model's name (P3 item 20 — 1i)
- Removed Opus 4.7 from fast mode; `/fast` now applies to Opus 5 and Opus 4.8 (1d)

### 3.2 2.1.220 no-op re-confirmation (binary strings diff)

The OCC-38 §3.2 binary strings diff (219↔220: 220 has FEWER unique strings —
internal churn, no new surface) was re-verified this round: the same surface
tokens are present in the 2.1.220 ELF and there is no version marker beyond
`2.1.220`:

```
# version marker beyond 2.1.220?
$ grep -aoE "2\.1\.22[1-9]" s220.txt | sort -u
(none)

# 2.1.219 surface tokens present in 2.1.220 binary?
strictAllowlist            PRESENT   ← ported this round (item 2)
mcp_server_errors           PRESENT   (ported OCC-38)
promptCacheWrite1hTokens    PRESENT   (ported OCC-38)
workflowSizeGuideline       PRESENT
DirectoryAdded              PRESENT
claude-opus-5               PRESENT
forward-subagent-text       PRESENT
```

→ **No new named surface** in 2.1.220 vs 2.1.219. `2.1.220` is a no-op
reliability layer — nothing to port.

## 4. Port landed this run

Recovered verbatim from the decompiled 2.1.220 linux-x64 ELF — no behavior
guessed. Per `aligning-with-official-binary`.

### 4.1 Item 2 (P1): `sandbox.network.strictAllowlist` settings key + deny-without-prompt

**Binary-verified settings schema** (offset ~247994700):

```js
strictAllowlist: v.boolean().optional().describe(
  "When true, the sandbox runtime deterministically denies hosts not in " +
  "allowedDomains instead of prompting. Enforced for sandboxed commands only " +
  "— in-process tools such as WebFetch are not gated by this setting. " +
  "Only honored from user, managed/policy, or CLI (--settings) settings — " +
  "project settings (.claude/settings.json and .claude/settings.local.json) " +
  "are ignored."
)
```

**Binary-verified runtime config builder** (offset ~251493220):

```js
strictAllowlist: YLt().some((K) => K?.sandbox?.network?.strictAllowlist === !0) || void 0,
```

`YLt()` enumerates the **non-project** settings sources (user, managed/policy,
CLI `--settings`) — the `.describe()` text is authoritative: project settings
are ignored. `.some(...)` ⇒ `strictAllowlist` is true if ANY honored source
has `sandbox.network.strictAllowlist === true`, else `undefined` (omitted).

**Binary-verified enforcement gate** (offset ~251290836) — the sandbox
runtime's own network decision function:

```js
for (let o of Hl.network.deniedDomains)  if (Kat(n, o)) return _o(`Denied by config rule: ${t}:${e}`),  !1;
for (let o of Hl.network.allowedDomains)  if (Kat(n, o)) return _o(`Allowed by config rule: ${t}:${e}`), !0;
if (!r || Hl.network.strictAllowlist)     return _o(`No matching config rule, denying: ${t}:${e}`), !1;
_o(`No matching config rule, …`);  // else: prompt via r (the ask callback)
```

`r` is the ask/prompt callback. The contract: a non-allowlisted host is
**denied without prompting** when `strictAllowlist` is true (or when there is
no callback), otherwise the user is prompted.

**Critical binary nuance (flagged, not "simplified"):**
- **Honored sources filter.** `strictAllowlist` is honored ONLY from `userSettings`, `flagSettings` (CLI `--settings`), and `policySettings` (managed). `projectSettings` (`.claude/settings.json`) and `localSettings` (`.claude/settings.local.json`) are **ignored** — mirrors the binary's `.describe()` + the `YLt()` enumeration. OCC's `SETTING_SOURCES` list is filtered to the three honored sources in `shouldEnforceStrictAllowlist()`.
- **Runtime-level vs callback-level enforcement.** The binary carries `strictAllowlist` as a field on the runtime `network` config and the sandbox-runtime native gate reads it. OCC's installed `@anthropic-ai/sandbox-runtime@0.0.44` `NetworkConfigSchema` has **no** `strictAllowlist` field (zod `"strip"` mode would drop it), so the runtime cannot enforce it. OCC therefore enforces the **identical observable contract** (deny-without-prompt for non-allowlisted hosts when strictAllowlist is on) in the existing `wrappedCallback` (`SandboxAskCallback`), right next to the `allowManagedDomainsOnly` branch — the OCC-side ask gate that already mirrors the runtime's prompt/deny decision. The behavior is byte-for-byte equivalent; only the enforcement site differs (documented in a src comment).

| # | Item | Change | Binary-verified |
|---|------|--------|-----------------|
| 2 | `sandbox.network.strictAllowlist` | added `strictAllowlist` to `SandboxNetworkConfigSchema` (verbatim `.describe()`); added `shouldEnforceStrictAllowlist()` (honored-sources filter + `.some(…===true)`); added deny-without-prompt branch in the `wrappedCallback` (logs `Blocked … (strictAllowlist)`, returns `false` before prompting) | ✓ schema `.describe()` + `YLt().some(...)` + `if(!r||strictAllowlist)return deny` verbatim |

Files: `src/entrypoints/sandboxTypes.ts`, `src/utils/sandbox/sandbox-adapter.ts`.

## 5. Staged (ambiguous in the binary — not guessed)

Unchanged from OCC-38 §5–§6; restated for completeness. Each needs dedicated
per-site decompilation (no invented/partial implementations, per
`aligning-with-official-binary`).

- **Item 5 — `workflowSizeGuideline` settings key + dynamic-workflow medium default + status line.** The settings key, `/config` enum (`small`/`medium`/`large`/`unrestricted`), and status-line text strings are cleanly recoverable, but the load-bearing behavior — the size→agent-count caps (small = 5 confirmed; medium = "<15" per changelog prose but `15 agents` is NOT a literal in the binary — the cap is computed; `large`/`unrestricted` values not cleanly recoverable) — is ambiguous. Per the skill's "STOP if ambiguous", the behavior part is not ported; the `/config` enum UI + status-line rendering are TUI (deferred per OCC-11 sandbox-stall). Staged.
- **Item 8 — mcp list HTTP/error-text *format*.** The `Failed to connect to MCP server '<name>': <error>` phrase appears in the binary ONLY in the agent-log path; the binary's actual `mcp list` / `/mcp` output is a React component rendering separate `{name, server, status, issue}` fields. Matching the binary's React-component layout exactly is a separate picker-UI/output-format task. Staged.
- **Item 6 — nested subagent forwarding (depth-2+) under `--forward-subagent-text`.** The CLI flag + guard already exist in OCC; the depth-2+ forwarding mechanism (a nested subagent's text propagating up through the parent subagent's stream) is coupled to the AgentTool streaming path and needs dedicated per-site decompilation. Staged.
- **Item 7 — `claude -p` keep answer on mid-stream API error.** OCC already has the J1 (2.1.199) mid-stream finalize mechanism (`getMidStreamFinalizeCause` + `getMidStreamPartialNotice` in `src/services/api/claude.ts`). The 2.1.219 fix is in the `-p` text-output path (flushing the already-produced partial text to stdout before the finalize notice) — coupled to the print text-output assembly; the exact flush site is ambiguous in the binary without a dedicated round. Staged.
- **Item 19 — managed MCP allowlist/denylist `${VAR}` from startup env.** Requires a startup-env snapshot + an interpolation pass over allowlist/denylist `serverName` entries before the verbatim comparison in `isMcpServerDenied` / `filterByManagedPolicy`. The exact interpolation function in the binary (where/when `${VAR}` is resolved) is not cleanly recoverable without a dedicated round. Staged.
- **Item-4 caller-wiring.** `buildSystemInitMessage`'s callers (`QueryEngine.ts`, `useReplBridge.tsx`) still pass `mcpServerErrors: []`. Plumbing the MCP config-validation error list through the MCP connection layer is a dedicated task. An empty array produces correct (OMITTED) output per the binary's `r.length>0&&` guard, so this is a faithful no-op-until-wired state, not a behavioral divergence. Staged as the most natural next-round follow-up.
- **Per-command `strictAllowlist` merge** (binary offset ~248293849: `if(o.strictAllowlist===!0)l.strictAllowlist=!0`). OCC has no per-command sandbox config (`sandboxedCommands` network merge); porting that is a larger feature beyond the top-level settings key landed this round. Staged.

## 6. Other 2.1.219 P1–P4 (unchanged from OCC-38 §6, restated)

| # | 2.1.219 item | Priority | Status |
|---|--------------|----------|--------|
| 2 | `sandbox.network.strictAllowlist` setting | P1 | **done this round** |
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
whitespace warnings + item 1c `promptCacheWrite1hTokens` + now **item 2
(`sandbox.network.strictAllowlist`)**. The remaining gap is the rest of the
`2.1.219` P1–P4 backlog (items 5/6/7/8-mcp-list-format/18/19/21 + Vim/screen-reader P3 + niche P4 + the OCC-37 staged sub-items + item-4 caller-wiring + per-command strictAllowlist merge) — staged for dedicated per-site rounds. `2.1.220` remains a no-op reliability layer (re-confirmed this round, §3.2). The item-4 caller-wiring (plumbing MCP config errors into `buildSystemInitMessage`) and item 19 (MCP `${VAR}` from startup env) are the most natural next-round follow-ups.
