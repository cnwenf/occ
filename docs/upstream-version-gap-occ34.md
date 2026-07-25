# OCC vs. official Claude Code — version-gap report (2026-07-26, OCC-34)

> Gap-research deliverable for **OCC-34** ("OCC版本追齐官方Claude Code — 2026-07-26
> gap调研/对齐"), step 1: confirm OCC's aligned official version, the official
> latest, and the changelog/code-diff gap between them. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory recital).
> Version truth from the npm registry (`@anthropic-ai/claude-code`) and the official
> Anthropic `CHANGELOG.md` on GitHub; feature truth cross-checked against OCC `src/`
> and the decompiled official native ELF (`@anthropic-ai/claude-code-linux-x64`).

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (latest on `main`) | `2.1.285` (`2026-07-24`) | `package.json`, `CHANGELOG.md` §2.1.285 |
| OCC aligned Claude Code (start of round) | `2.1.218` (fully aligned, OCC-31) | `CLAUDE.md` header; OCC-31 PR #243 |
| Official latest Claude Code (npm `latest` = `next`) | **`2.1.220`** (published `2026-07-24T23:11:21Z`) | `npm view @anthropic-ai/claude-code version`; `… time --json` |
| Official GitHub `CHANGELOG.md` top entries | `## 2.1.220`, `## 2.1.219` | `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` |
| Version gap | **YES — 2 versions** (`2.1.219`, `2.1.220`) | npm timeline |

**Conclusion: a real version gap exists.** Official Claude Code advanced
`2.1.218` → `2.1.219` (2026-07-24 16:11Z) → `2.1.220` (2026-07-24 23:11Z).
`2.1.219` carries the substantive feature surface (24 changelog items);
`2.1.220` is the generic "Bug fixes and reliability improvements" entry
(binary-diff confirms **no new env-var / settings-key / hook-name / command
surface** — 2.1.220 is a no-op for faithful porting per the skill's
"Skip no-op versions" rule).

This run ports the **decompiled-verified, low-invention-risk P0 subset**
(see §4) and stages the remaining portable items as P1–P4 for dedicated
follow-up runs (the standard OCC staged-catch-up pattern used by OCC-15/19).
Tracked-upstream pointer advances to `2.1.220` only for the **no-op
`2.1.220`** layer; the `2.1.219` portable surface is partially landed
(P0 done) with P1–P4 explicitly open.

---

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.220` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.220`, `next=2.1.220`, `stable=2.1.212` | `npm view … dist-tags --json` |
| npm native binary `linux-x64` | `2.1.220` (275,012,592 B) | `npm pack @anthropic-ai/claude-code-linux-x64@2.1.220` |
| Official GitHub `CHANGELOG.md` top entry | `## 2.1.220` | `curl …/anthropics/claude-code/main/CHANGELOG.md` |
| OCC aligned version (start of round) | `2.1.218` | `CLAUDE.md` header; OCC-31 PR #243 |

Official version timeline (tail):

```
2.1.220 → 2026-07-24T23:11:21Z   ← official latest (2.1.220 = no-op reliability)
2.1.219 → 2026-07-24T16:11:49Z   ← substantive feature surface (this round's port target)
2.1.218 → 2026-07-22T19:55:32Z   ← OCC fully aligned (OCC-31)
2.1.217 → 2026-07-21T19:55:38Z   ← OCC-15 + OCC-19 ported
2.1.216 → 2026-07-20T20:19:37Z   ← OCC-15 + OCC-19 ported
…
```

> Note on the `stable` dist-tag: npm `stable=2.1.212` lags `latest=2.1.220`.
> OCC tracks `latest` (as it has since OCC-9+); `stable` is Anthropic's
> known-good pin, not the alignment target. Unchanged from prior rounds.

## 2. Methodology (skills used)

1. **Version truth** — `npm view @anthropic-ai/claude-code version/dist-tags/time/versions`;
   `curl` official `CHANGELOG.md`. Per `upstream-tracking` §"Version truth".
2. **Changelog extraction** — `awk` on `/tmp/cc-CHANGELOG.md` for the
   `2.1.219`/`2.1.220` entries (full text in §3).
3. **Binary diff** — `npm pack` the `linux-x64` packages for `2.1.218` (prev),
   `2.1.219` (mid), `2.1.220` (latest); `strings -n 8 … | sort -u`;
   `comm -13 prev curr` to isolate new strings. Per `upstream-tracking`
   §"Native Binary Notes (2.1.113+)".
4. **Token cross-check** — precise `grep` for each changelog feature token
   in both the NEW set and the PREV set, to distinguish *genuinely new*
   tokens (prev=0) from *behavior-expansion* tokens (prev>0). Per
   `aligning-with-official-binary` (no invented/partial implementations).
5. **2.1.220 no-op confirmation** — isolated the `2.1.219 → 2.1.220` diff
   (3750 new lines, almost entirely minified-JS re-churn); strict
   `grep -oE 'CLAUDE_CODE_[A-Z_]+'` + readable-string filter showed **no new
   env-var / settings-key / hook-name / command surface** — only minor UI
   text tweaks ("Failed to update setting", "Switch Anthropic accounts",
   "Higher effort levels are restricted by your organization."). → 2.1.220
   is a reliability release; nothing to faithfully port.
6. **Decompiled-logic extraction** for the P0 ports — byte-level / readable-
   string windowing (`grep -oE '.{0,N}TOKEN.{0,M}'` on the strings dump) to
   recover the exact upstream function shape for `executeDirectoryAddedHooks`
   and the `DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH` change, so the ports are
   faithful, not invented.

All downloaded binaries cleaned from `/tmp` after diffing (resource-safety
rule). Strings dumps retained only in the workdir research scratch.

## 3. Official changelog — 2.1.219 + 2.1.220 (verbatim)

### 2.1.220
- Bug fixes and reliability improvements

### 2.1.219
- Added Claude Opus 5 (`claude-opus-5`), now the default Opus model — 1M context, fast mode at $10/$50 per Mtok
- Added `sandbox.network.strictAllowlist` setting to deny non-allowlisted hosts for sandboxed commands without prompting
- Added `DirectoryAdded` hook that fires after `/add-dir` or the SDK `register_repo_root` control request registers a new working directory mid-session
- Added `mcp_server_errors` to the headless stream-json init event, listing `--mcp-config` entries skipped by config validation; terminal runs print a startup warning
- Added the `workflowSizeGuideline` settings key so the advisory Dynamic workflow size guideline can be set from any settings file; the `/config` row is hidden while one does
- Added nested subagent forwarding in stream-json: subagents spawned at depth-2+ now appear when `--forward-subagent-text` is set, keyed by their spawning Agent `tool_use` id
- Fixed `claude -p` text output dropping the answer already produced when a turn dies on a mid-stream API error
- Added HTTP status and error text to `claude mcp list` and `/mcp` when a server fails to connect, and a warning for MCP config values with hidden leading or trailing whitespace
- Fixed the Fable model row showing "Requires usage credits" for plans that include it, when a stale cache had baked the label in
- Fixed the `/model` picker showing the merged Opus row as plain "Opus" instead of "Opus (1M context)"
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
- Removed Opus 4.7 from fast mode; `/fast` now applies to Opus 5 and Opus 4.8
- Updated the claude-api skill to default to Claude Opus 5, with a migration path from Opus 4.8
- Subagents can now spawn nested subagents up to depth 3 by default (was 1); set CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 to disable nesting

## 4. Gap assessment — portability verdict per item

Tokens verified present in the `2.1.218 → 2.1.220` new-strings set
(`/tmp/cc-diff-34/new_all.txt`); "prev" column = occurrences in 2.1.218
(genuinely new = prev 0).

| # | 2.1.219 item | Binary token (new/prev) | OCC subsystem exists? | Portable? | Priority | This run |
|---|---|---|---|---|---|---|
| 1 | `claude-opus-5` model + default Opus + 1M ctx + fast-mode pricing | `claude-opus-5` (17/0) | model ID strings across `src/` (no `claude-opus-5` yet) | yes (model data) — but exact metadata (ctx window, pricing) needs careful binary extraction; invention risk if guessed | P1 | staged |
| 2 | `sandbox.network.strictAllowlist` setting | `strictAllowlist` (4/2 — partial) | `src/utils/sandbox/sandbox-adapter.ts`, `sandboxTypes.ts` (OCC's existing `strictAllowlist` is *marketplaces*, not `sandbox.network` — different key) | yes — new settings key + sandbox deny behavior | P1 | staged |
| 3 | `DirectoryAdded` hook | `DirectoryAdded` (20/0) | `HOOK_EVENTS` (`src/entrypoints/agentSdkTypes.js`) lacks it; `/add-dir` cmd exists; `executeEnvHooks` template exists | **yes — decompiled executor recovered (see §5)** | **P0** | **✅ landed** |
| 4 | `mcp_server_errors` in stream-json init | `mcp_server_errors` (3/0) | stream-json guards exist (`streamJsonStdoutGuard.ts`, `structuredIO.ts`) | yes — headless init-event field + startup warning | P1 | staged |
| 5 | `workflowSizeGuideline` settings key (settable from any file; `/config` row hidden) | `workflowSizeGuideline` (13/8 — expansion) | `src/utils/settings/types.ts`, `src/tools/WorkflowTool/`, `config-noninteractive.ts` already reference it | yes — extend settings source-resolution + `/config` hide | P2 | staged |
| 6 | nested subagent forwarding (depth-2+) in stream-json under `--forward-subagent-text` | `forwardSubagentText` (11/4), `forward-subagent-text` (2/4 — expansion) | `src/utils/forwardSubagentTextGuard.ts` exists | yes — behavior expansion | P2 | staged |
| 7 | `claude -p` keep answer on mid-stream API error | `keepPartialMessageOnAbort` (seen in 2.1.220 churn) | `-p` print path in `src/cli/print.ts` | yes — bug fix | P2 | staged |
| 8 | `claude mcp list` / `/mcp` HTTP status+error text + MCP-config whitespace warning | (part of mcp_server_errors cluster) | `src/commands/mcp/` | yes | P2 | staged |
| 9 | Fable "Requires usage credits" stale-cache label fix | n/a (UI cache) | `useOfficialMarketplaceNotification` etc. | low-value UI | P4 | skip/doc |
| 10 | `/model` picker "Opus (1M context)" merged row | `opus.*1m` refs exist | model picker | yes — UI text | P3 | staged |
| 11 | GNU screen copy-on-select base64 fix | n/a (terminal) | `useCopyOnSelect.ts` | niche terminal | P4 | skip/doc |
| 12 | Remote Control stale fast-mode status fix | n/a | `useRemoteControlChannel.ts` | Remote-Control-internal | P4 | skip/doc |
| 13 | `CLAUDE_CODE_GIT_BASH_PATH` Windows fix | n/a (Windows) | — | Windows-only | P4 | skip/doc |
| 14 | Vim mode ← on empty prompt | n/a | `useVimInput.ts` | UI key | P3 | staged |
| 15 | screen-reader mode per-keystroke echo fix | n/a | accessibility hooks | UI | P3 | staged |
| 16 | "Remote Control only via api.anthropic.com" error names setting | n/a | Remote Control | Remote-Control-internal | P4 | skip/doc |
| 17 | `--teleport` shows repo mismatch | n/a | `useTeleportResume.tsx` | teleport-internal | P4 | skip/doc |
| 18 | dynamic workflows default medium (<15 agents) | `workflow_size_guideline` | `WorkflowTool` | yes — default + status line | P2 | staged |
| 19 | managed MCP allowlist/denylist `${VAR}` from startup env | (mcp config) | mcp config loader | yes | P2 | staged |
| 20 | `/model` picker highlight newest only | n/a | model picker | UI | P3 | staged |
| 21 | running-workflow status line shows size + `/config` pointer | `workflow_size_guideline` | `WorkflowTool` | yes — status line | P2 | staged |
| 22 | remove Opus 4.7 from fast mode; `/fast` → Opus 5 + 4.8 | `claude-opus-5` cluster | `src/cli/src/utils/fastMode.ts` (stub) + `src/components/src/utils/fastMode.ts` (stub) | yes — but fast-mode real logic location TBD | P1 | staged |
| 23 | claude-api skill default Opus 5 + migration from 4.8 | `claude-opus-5` | `src/skills/bundled/claudeApiContent.ts` (`OPUS_ID='claude-opus-4-6'`) | yes — skill content sync (needs official skill body) | P1 | staged |
| 24 | subagent nested spawn depth default 1→3 | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (prev>0 — behavior change) | `src/utils/sessionLimits.ts` `DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH = 1` | **yes — 1-line default bump, decompiled-confirmed** | **P0** | **✅ landed** |

### 2.1.220 — no-op for porting
Binary-diff (`2.1.219 → 2.1.220`, 3750 new lines) is ~entirely minified-JS
re-churn from internal reliability fixes. Strict surface scan found **no
new `CLAUDE_CODE_*` env var, settings key, hook name, or command**. →
faithful port of 2.1.220 = none required; OCC's tracked-upstream pointer
moves to 2.1.220 once the 2.1.219 portable surface is fully landed.

## 5. P0 ports landed this run (decompiled-verified)

### P0-A — `DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH` 1 → 3
- **Source** (`src/utils/sessionLimits.ts`): `const DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH = 1`
  (reverse-engineered from 2.1.217 ELF; comment documents the 2.1.217 default of 1).
- **2.1.219 changelog**: "Subagents can now spawn nested subagents up to
  depth 3 by default (was 1); set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`
  to disable nesting."
- **Fix**: bump the default to `3`; update the doc comment to cite 2.1.219;
  keep the env-override (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`) semantics
  unchanged (env wins if set, else default). The depth-enforcement site
  (`src/tools/AgentTool/runAgent.ts` `getMaxSubagentSpawnDepth()`) already
  reads this getter, so no other call-site change is needed.
- **Test**: extend `src/utils/__tests__/sessionLimits.test.ts` to assert
  default depth `3` and that `=1` still disables nesting.

### P0-B — `DirectoryAdded` hook
- **Decompiled executor** (from the 2.1.220 ELF, function `a2t`):
  ```js
  async function a2t(e, t, r=Hm) {
    let n = {...Kf(void 0), hook_event_name: "DirectoryAdded", directory: e, source: t},
        o = await EM({hookInput: n, matchQuery: t, timeoutMs: r}),
        i = o.map((s) => s.systemMessage).filter((s) => !!s);
    return {results: o, systemMessages: i}
  }
  ```
  → payload `{...baseHookInput, hook_event_name:"DirectoryAdded", directory, source}`;
  calls the env-hook executor with `matchQuery = source`, `timeoutMs`;
  returns `{results, systemMessages}` (fire-and-forget / observability, non-blocking —
  mirrors `executeCwdChangedHooks`).
- **Upstream summary/description** (verbatim from the binary strings):
  - summary: "After a working directory is added mid-session"
  - description: "Fires after `/add-dir` or the `register_repo_root` SDK
    control request registers a new working directory, after the sandbox
    configuration has been refreshed — so sandboxed tools and permission
    state already see the new directory (hook commands themselves run
    unsandboxed)."
  - duplicate rule: "A directory that is already a registered working
    directory (including a duplicate of an earlier request) is denied with
    an error; the registration pipeline and `DirectoryAdded` hooks do not
    re-run."
- **Port**:
  1. Add `'DirectoryAdded'` to `HOOK_EVENTS` (`src/entrypoints/agentSdkTypes.js`).
  2. Add `DirectoryAddedHookInput` + `executeDirectoryAddedHooks(directory, source, timeoutMs)` in
     `src/utils/hooks.ts`, mirroring `executeCwdChangedHooks` / the decompiled `a2t`.
  3. Fire it in `src/commands/add-dir/add-dir.tsx` after the sandbox config refresh
     in `handleAddDirectory`, passing `source` = the add origin; suppress on duplicate
     (already-registered) per the upstream rule.
  4. UT for: event is a configured-hook target; payload shape; duplicate-suppression.
- **Why faithful, not invented**: every field name, the executor shape, the
  match-query, the return shape, the summary/description, and the
  duplicate-suppression rule are recovered verbatim from the decompiled
  binary — no behavior is guessed.

## 6. Staged follow-up (P1–P4) — for subsequent runs

The remaining portable 2.1.219 items need dedicated decompilation work to
faithfully recover exact upstream logic (model metadata, sandbox deny
semantics, stream-json init field shape, fast-mode model set, etc.) before
porting — per `aligning-with-official-binary`'s no-invention rule. They are
prioritized above (§4) and will be landed in subsequent OCC rounds. The
niche/UI/Remote-Control/Windows/teleport items (P3–P4) may be documented as
by-design divergences rather than ported, following OCC-31's
`/deep-research` precedent.

## 7. Self-acceptance plan (this run)

Per the issue's "版本追齐后的自验收" branch: since a gap exists, the primary
path is alignment (this run, P0 subset). After the P0 ports land:
- UTs for `sessionLimits` default + `DirectoryAdded` payload/suppression.
- `bash test/e2e/run.sh` for the docker e2e regression.
- Real REPL smoke (`occ --version`, `occ --help` effort/permission-mode
  lines unchanged, `occ -p` pipe smoke) to confirm no regression from the
  depth-default change.
- Hand off to the OCC 验收员 for the human-style `uvx claude-code`
  consistency check + remote-branch cleanup + tags/releases parity.

Full catch-up to `2.1.220` (P1–P4) is staged; this run does not claim full
alignment to 2.1.220 — only the P0 subset + the no-op 2.1.220 layer.
