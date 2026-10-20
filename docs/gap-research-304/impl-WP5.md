# impl-WP5 — auto-compact window env warnings + compaction tool-names + subagent resume flush (items #41, #6, #28)

Agent: WP5. Source of truth: `docs/gap-research-304/research-R3-session-api.md` §#41/§#6/§#28 (byte-verified official 2.1.304 forensics + port recipes). Branch: `agent/occ-leader/3bdf2d90`. No git write commands were run; files only.

> **Integration wiring needed:** item #41's startup warning + `/config` line live in `src/main.tsx` and `src/components/Settings/Config.tsx`, which are owned by another WP. The functions are implemented + exported here; the exact one-liners for the Leader are in **§Integration wiring needed** at the bottom.

---

## Item #41 — `CLAUDE_CODE_AUTO_COMPACT_WINDOW` k/M suffixes + warnings (PORT M) — DONE

### Files changed
- `src/utils/autoCompactWindow.ts` — full port of the official window-size parser + warning emitter family. New/updated exports:
  - constants `AUTO_COMPACT_WINDOW_MIN = 100_000` (official `gP=1e5`), `AUTO_COMPACT_WINDOW_MAX = 1_000_000` (official `vN=1e6`), `ENV_WINDOW_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'`, `ENV_WARNING_SANITIZE_MAX = 32` (official `v4t`)
  - `parseAutoCompactWindowSize(raw, { bareThousands })` (official `j_e`) — `k`/`K`×1000 + `m`/`M`×1e6 suffixes, bare-number fallback (thousands-shorthand gated on `bareThousands`), classification into `in_range` / `below_minimum` / `above_maximum` / `unusable`
  - `parseAutoCompactWindowEnv(raw)` (official `yVe`) — env entry: `bareThousands:false`
  - `parseAutoCompactWindowInput(raw)` — `/autocompact` FLAG entry: `bareThousands:true` (drives the `below_minimum_flag_accepts` telemetry distinction)
  - `resolveAutoCompactWindowEnvTokens(...)` (official `T4t`) — clamps to min/max, returns `undefined` for unusable/unset
  - `buildAutoCompactWindowEnvMessage(raw, parsed)` (official `E4t`) — verbatim warning strings (below)
  - `buildAutoCompactWindowEnvWarning(raw): string | null` (official `XFe`) — msg-or-null convenience wrapper
  - `warnAutoCompactWindowEnv(raw, { interactive?, headless? })` (official `ySs`) — startup emitter: logs `compact_window_env` telemetry, then interactive → `[autocompact] <msg>` on stderr / headless → callback
- `src/commands/autocompact/autocompact-noninteractive.ts` — the `/autocompact` non-interactive describe builder now appends `buildAutoCompactWindowEnvWarning(process.env[ENV_WINDOW_KEY])` (:125) after the window prose, matching the official `_n(...)` describe output
- NEW `src/utils/__tests__/autoCompactWindowEnv304.test.ts` — 32 tests

### What was done
Official 2.1.304 added k/M suffix parsing to `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and a three-kind warning (below-minimum / above-maximum / unusable) surfaced at startup, in `/config`, and in `/autocompact describe`. Before this port OCC parsed the env with a bare `parseInt` (so `"200k"` resolved to `200`, not `200000`) and emitted no warning. The port is a faithful reproduction of the official `j_e`/`T4t`/`E4t`/`XFe`/`ySs`/`yVe` family at the byte level (parse kinds, clamp bounds, sanitize/ellipsis rules, telemetry shape, verbatim message text).

### Verbatim vs adapted
| Piece | Decision |
|---|---|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env key | **Verbatim** |
| `AUTO_COMPACT_WINDOW_MIN`=100000 (`gP`), `AUTO_COMPACT_WINDOW_MAX`=1000000 (`vN`), sanitize cap 32 (`v4t`) | **Verbatim** |
| Telemetry event name `compact_window_env` + `kind` field + `below_minimum_flag_accepts` field | **Verbatim** |
| Warning strings (below), incl. `'Claude Code'` verbatim | **Verbatim** |
| `[autocompact] <msg>` stderr prefix (interactive branch) | **Verbatim** (official `debugLine`) |
| Sanitize filter `[^\w.,+ $%{}=;-]+` → `?`, 32-char pre-truncate, `…` ellipsis | **Verbatim** |
| Startup emitter wiring (`main.tsx`) + `/config` display (`Config.tsx`) | **Adapted → deferred to Leader** (files owned by another WP; see §Integration wiring needed) |

Verbatim warning strings (`buildAutoCompactWindowEnvMessage`), where `value = CLAUDE_CODE_AUTO_COMPACT_WINDOW="<sanitized><ellipsis>"`, `minLabel = 100k`, `maxLabel = 1M`, `advice = "Set it to a size from 100k to 1M, such as 200k or 200000, or unset it."`:
- `below_minimum`: `${value} reads as ${parsed.tokens.toLocaleString('en-US')} ${pluralizeWindowToken(parsed.tokens,'token')}, so Claude Code treats it as the ${minLabel} minimum. ${advice}`
- `above_maximum`: `${value} is too large, so Claude Code treats it as the ${maxLabel} maximum. ${advice}`
- `unusable`: `${value} isn't a usable size, so Claude Code ignores it. ${advice}`

### Tests (all green)
`src/utils/__tests__/autoCompactWindowEnv304.test.ts` — `32 pass, 0 fail, 57 expect() calls [277.00ms]`. Covers both changed item-41 files:
- `parseAutoCompactWindowSize` (`j_e`): `k`×1000 / `m`×1e6 case-insensitive; bare env value gets NO thousands shorthand (`bareThousands:false`); `below_minimum` clamps reported tokens; `unusable` for garbage/empty/sub-1; boundary values `in_range`.
- `resolveAutoCompactWindowEnvTokens` (`T4t`): in_range passthrough; below_minimum clamps UP to 100k; above_maximum clamps DOWN to 1M; unusable/unset → undefined.
- `resolveAutoCompactWindow` env branch (`Yb`): `"200k"` → 200000 (was parseInt→200); below-minimum → 100k with source `env`; above-maximum → 1M capped by context window; unusable → falls through to auto.
- `buildAutoCompactWindowEnvWarning` (`XFe`/`E4t`): in-range/unset → no warning; below_minimum/above_maximum/unusable messages byte-verbatim; single-token pluralization; en-US thousands separators; disallowed-char collapse to `?`; >32-char truncation + ellipsis.
- `warnAutoCompactWindowEnv` (`ySs`): unset no-op (no telemetry, no surfacing); in-range silent; below_minimum logs `compact_window_env` + `flag_accepts` and surfaces headless; `flag_accepts:false` when the flag also rejects; above_maximum/unusable log `kind` only; interactive surfaces `[autocompact] <msg>` on stderr and skips headless.
- `/autocompact describe` (via `autocompact-noninteractive.ts` `call`): below-minimum env appends the verbatim warning after the prose; in-range/unset add no warning line.

---

## Item #6 — compaction summary includes tool names (PORT M) — DONE

### Files changed
- NEW `src/services/compact/summaryHeader.ts` — `COMPACT_SUMMARY_HEADER` (the verbatim "This session is being continued…" header), extracted into its own module to avoid a `prompt.ts` ↔ `toolNamesUsed.ts` import cycle
- NEW `src/services/compact/toolNamesUsed.ts` — the official symbol family:
  - `TOOLS_USED_BEFORE_SUMMARY_TAG = 'tools-used-before-summary'` (official `dve`)
  - `VALID_TOOL_NAME_RE = /^(?!.*\s{2})[^<>,\p{C}\u2028\u2029]{1,256}$/u` (official `Mir`)
  - `TOOLS_USED_TAG_RE` (official `Xan`, adapted — see deviations)
  - `renderToolsUsedBeforeSummary(toolNamesUsed = [])` (official `Zan`) — `<tools-used-before-summary>name, name</tools-used-before-summary>\n`
  - `getToolNamesUsed(messages)` (official `HJ`) — extract from `tool_use`/`server_tool_use` blocks + carry forward names from a prior compact-summary tag; Set-dedupe + lexicographic sort
  - `stripToolsUsedTagForTranscript(text)` (official `jEs`) — rewrite the XML tag into the readable transcript line `Tools called before this summary: <names>` (empty tag collapses away)
- `src/services/compact/prompt.ts` — `getCompactUserSummaryMessage(summary, suppressFollowUpQuestions?, transcriptPath?, toolNamesUsed?)` gains the 4th param (official `GJ` composer): injects `renderToolsUsedBeforeSummary(toolNamesUsed)` between the header and the summary body
- `src/services/compact/compact.ts` — both the full-compaction and partial-compaction call sites now pass `getToolNamesUsed(...)` as the 4th arg
- `src/services/compact/sessionMemoryCompact.ts` — the session-memory-commit call site (~:468) passes `getToolNamesUsed(messages)` (the pre-compact messages this commit summarizes away)
- `src/components/CompactSummary.tsx` — transcript view (`isTranscriptMode`) runs `stripToolsUsedTagForTranscript(...)` (:34) so the raw XML tag never shows in the rendered transcript
- EDITED `src/services/compact/__tests__/compactionRecentNote293.test.ts` — updated the `getCompactUserSummaryMessage.length` assertion `.toBe(3)` → `.toBe(4)` and the combos fixture type to allow the new optional 4th `string[]` arg
- NEW `src/services/compact/__tests__/toolNamesUsed304.test.ts` — 24 tests

### What was done
Official 2.1.304 #6 embeds the names of tools called before a compaction summary into the summary itself (a `<tools-used-before-summary>` tag), so a resumed/compacted session retains awareness of which tools were in play. The tag is composed into the summary (`GJ`), extracted+carried-forward on the next compaction (`HJ`), and rewritten to a human-readable line for transcript display (`jEs`). Ported faithfully at the byte level (tag name, valid-name regex, header, transcript line prefix).

### Verbatim vs adapted
| Piece | Decision |
|---|---|
| Tag name `tools-used-before-summary` (`dve`) | **Verbatim** |
| Transcript line prefix `Tools called before this summary: ` | **Verbatim** |
| `COMPACT_SUMMARY_HEADER` text | **Verbatim** |
| `VALID_TOOL_NAME_RE` (`Mir`) — `[^\w…]{1,256}`, no double-space, no `<>,`, no control/`\u2028\u2029` | **Verbatim** (written with `\u2028`/`\u2029` escapes — editor-safe, functionally identical) |
| `renderToolsUsedBeforeSummary` output shape (`Zan`) | **Verbatim** |
| `getToolNamesUsed` extract/dedupe/sort + carry-forward (`HJ`) | **Direct port**; **adapted** on tool-name normalization (see deviations — no OCC alias map) |
| `stripToolsUsedTagForTranscript` (`jEs`) | **Direct port** |
| `TOOLS_USED_TAG_RE` (`Xan`) | **Adapted** — anchored on OCC's `COMPACT_SUMMARY_HEADER`; group1 = header prefix, group2 = comma-joined names (official's `Van`/foreignArtifact alternation groups not present in OCC) |
| `GJ` composer placement (`header\n\n<tag>\nsummary`) | **Verbatim shape** |

### Tests (all green)
`src/services/compact/__tests__/toolNamesUsed304.test.ts` — `24 pass, 0 fail, 38 expect() calls [69.00ms]`:
- `Zan`: comma-space join; empty-by-default `[]`; empty array; verbatim tag name.
- `Mir`: accepts ordinary/namespaced/single-space; rejects comma/angle-brackets/empty/double-space; rejects control + `\u2028`/`\u2029`; enforces the 1–256 bound.
- `HJ`: extract+dedupe+sort `tool_use`; includes `server_tool_use`; trims whitespace; filters invalid names but keeps valid siblings; skips non-user/non-assistant messages; string content contributes nothing; carries forward names from a prior compact-summary tag; does NOT read the tag from a non-compact-summary user message.
- `jEs`: rewrites the tag into the readable line (no raw XML left); hides an empty tag; leaves untagged text unchanged.
- `Xan`: group1 = header prefix, group2 = comma-joined names.
- `GJ`: injects the tag between header and summary; empty tag when no names; round-trips (composer output read back by the extractor); transcript rewrite of a composed summary is readable.

Combined dependent run (`toolNamesUsed304` + `compactionRecentNote293` + full `src/services/compact/` dir + `forkPermissionModeWiring285` + `sendMessageShutdownGuard304` + `autoCompactWindowEnv304`) → `99 pass, 0 fail, 222 expect() calls [911.00ms]`.

### Test findings / decisions worth knowing
- **Import cycle avoidance.** `getToolNamesUsed` needs `COMPACT_SUMMARY_HEADER` (to detect a prior summary tag), and `prompt.ts` (the `GJ` composer) needs both `renderToolsUsedBeforeSummary` and the header. Putting the header in `prompt.ts` and importing it from `toolNamesUsed.ts` (which `prompt.ts` also imports) creates a cycle; extracted `COMPACT_SUMMARY_HEADER` into `summaryHeader.ts` (a leaf module) to break it.
- **`compactionRecentNote293.test.ts` arity assertion.** That pre-existing test pins `getCompactUserSummaryMessage.length`; adding the optional 4th param bumped the function's `.length` to 4, so the assertion + the combos fixture tuple type were updated (the only edits to that file). Its remaining tsc-flagged lines (66/83/99/120/135/138/184) are pre-existing `makeUserMessage` fixture `role: string` widening, outside my edited region (144–170).

---

## Item #28 — subagent resume flushes pending transcript writes (PORT S) — DONE

### Files changed
- `src/tools/AgentTool/resumeAgent.ts` — `resumeAgentBackground` now `await flushSessionStorage()` (imported from `../../utils/sessionStorage.js`) BEFORE the `Promise.all([getAgentTranscript(asAgentId(agentId)), readAgentMetadata(asAgentId(agentId))])` read (:96, ahead of :98)
- NEW `src/tools/AgentTool/__tests__/resumeAgentFlush304.test.ts` — 4 tests

### What was done
Official 2.1.304 #28: a running subagent persists its sidechain transcript through the session-storage write queue — `enqueueWrite` pushes the row onto a per-file queue and schedules a periodic drain (`FLUSH_INTERVAL_MS = 100`); the enqueue is fire-and-forget (`void this.enqueueWrite(...)`), so the newest tail rows sit in memory until the timer ticks. `resumeAgentBackground` reloads the conversation with `getAgentTranscript(agentId)` — a plain disk read. Pre-fix, a resume firing INSIDE the 100ms window read a stale transcript off disk and silently dropped the agent's latest messages. The fix awaits `flushSessionStorage()` first: `flush()` clears the pending timer, waits for any in-flight drain, then drains every queued file (including the agent sidechain file), so the reloaded transcript is complete.

### Verbatim vs adapted
| Piece | Decision |
|---|---|
| `flushSessionStorage()` call + ordering (before the transcript read) | **Direct port** of the official fix |
| No user-facing strings introduced | — |

### Tests (all green)
`src/tools/AgentTool/__tests__/resumeAgentFlush304.test.ts` — `4 pass, 0 fail, 18 expect() calls [1157.00ms]`. Two-level deterministic strategy (no reliance on a 100ms race):
- **Behavioral** (reproduces the exact queue/read contract the fix depends on): a sidechain tail enqueued inside the flush window is invisible to a `getAgentTranscript` read until `flushSessionStorage()` is awaited — stale read returns 2 messages (`[m1,m2]`), post-flush read returns 3 (`[m1,m2,m3]`) with the tail content `TAIL-MESSAGE-28`; and the raw agent file (`getAgentTranscriptPath`) lacks the queued row's uuid before the flush and contains it after.
- **Wiring** (source-order lock on `resumeAgent.ts`): the file imports `flushSessionStorage` from `../../utils/sessionStorage.js`; and `await flushSessionStorage()` occurs BEFORE both `getAgentTranscript(asAgentId(agentId))` and the surrounding `await Promise.all([` — so the ordering can never silently regress.

### Test findings / decisions worth knowing
- **Session must be materialized before enqueue.** `appendEntry` buffers into `pendingEntries` while `sessionFile === null` (sessionStorage.ts:1398), so sidechain rows would never reach the agent file. The test writes an empty main transcript + calls `adoptResumedSessionFile()` (`materializeSession()`) first — the proven `sessionStorageTornTailSeal300.test.ts` pattern.
- **Bypassed `recordSidechainTranscript` / `cleanMessagesForLogging`.** Those apply `isLoggableMessage` + `transformMessagesForExternalTranscript` (non-`ant` user), which could drop/mutate minimal fixtures. Hand-crafted full sidechain `TranscriptMessage` rows go through `appendEntryForTesting` (the raw test seam), matching `insertMessageChain`'s field shape; content is `string` or `[{type:'text',text}]` so the load-time admission validator (`classifyMessagePayload`) keeps them.
- **Timer-race safety.** Unique `agentId`s per test + an async `afterEach` that `await flushSessionStorage()` (cancels the timer + drains) before `resetProjectForTesting()`, so a stray 100ms drain can never write into a later test's agent file.

---

## Integration wiring needed (Leader applies — files owned by another WP)

Item #41's two user-facing surfaces live in files WP5 must not touch. The functions are implemented + exported; the Leader applies these one-liners.

**1. `src/main.tsx` — startup warning emitter** (official `ySs` wiring @255784526). Import and call in the startup sequence alongside the other stderr startup warnings, after env/config init. `print` is the `--print`/`-p` headless flag already in scope:
```ts
import { warnAutoCompactWindowEnv } from './utils/autoCompactWindow.js'

warnAutoCompactWindowEnv(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, {
  interactive: !print,
  headless: (msg) => process.stderr.write(`[autocompact] ${msg}\n`),
})
```
Official reference: `if(!Qt)ySs(a.CLAUDE_CODE_AUTO_COMPACT_WINDOW,{interactive:!L,headless:(s)=>_ot(s,{key:"auto-compact-window-env",outputFormat:V,debugLine:\`[autocompact] ${s}\`})})`. The Leader may route the headless branch through OCC's output-format helper (the official `_ot`) instead of raw stderr; the `interactive` branch already writes `[autocompact] <msg>` to stderr itself.

**2. `src/components/Settings/Config.tsx` — `/config` display line** (official `XFe` caller @260148727: `p=XFe(...);if(p!==null)u.push(p)`). In the `/config` warning-list builder:
```ts
import { buildAutoCompactWindowEnvWarning } from '../../utils/autoCompactWindow.js'

const autoCompactWindowWarning = buildAutoCompactWindowEnvWarning(
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
)
if (autoCompactWindowWarning !== null) {
  warnings.push(autoCompactWindowWarning) // or the config list's push/render target
}
```
Both files are being actively edited by another WP, so the Leader should place each call at the current anchor (the existing startup-warning emitter in `main.tsx`; the config warning-list builder in `Config.tsx`).

---

## Deviations & integration notes (all three items)

1. **`getToolNamesUsed` tool-name normalization (`HJ`).** The official extractor maps each raw tool name through a global alias map (`ac(x)`). OCC has no such map on this branch, so the port uses the raw **trimmed** name (`ac(x)` → `x`). Observable behavior is identical for canonical names; if OCC later adds an alias map, this is a one-line hook-in.
2. **`TOOLS_USED_TAG_RE` (`Xan`) adapted.** The official regex carries `Van`/foreignArtifact alternation groups that don't exist in OCC. OCC's version is anchored on `COMPACT_SUMMARY_HEADER`: group1 = the header prefix, group2 = the comma-joined names — the contract `stripToolsUsedTagForTranscript` and `getToolNamesUsed` rely on, verified by the `Xan` test.
3. **`\u2028`/`\u2029` written as escapes** in `VALID_TOOL_NAME_RE` (not literal chars) — editor/terminal-safe; functionally byte-identical to the official `Mir`.
4. **`main.tsx` / `Config.tsx` not edited** (owned by another WP) — wiring deferred to the Leader via §Integration wiring needed. `warnAutoCompactWindowEnv` + `buildAutoCompactWindowEnvWarning` are exported and unit-tested in isolation.
5. **Pre-existing tsc errors are NOT WP5's.** `bunx tsc --noEmit` exits 2 against a repo baseline of ~967 errors. Errors flagged in cluster-adjacent files — `sessionMemoryCompact.ts` (488/503/506/513/514, the 2.1.293 `applyPreservedMessagesNote` `SummaryMessageLike[]` vs `UserMessage[]`/`Message[]` block), `resumeAgent.ts` (:235, `model: isResumedFork ? undefined : meta?.model` string-vs-model-union), `compactionRecentNote293.test.ts` (66/83/99/120/135/138/184, fixture `role: string` widening) — all lie OUTSIDE my diff hunks (confirmed by read-only `git diff`: my only edits are the `getToolNamesUsed` import + 4th-arg call in `sessionMemoryCompact.ts`, the `flushSessionStorage` import + await in `resumeAgent.ts`, and the `.length`/combos update in the test). My NEW files (`toolNamesUsed.ts`, `summaryHeader.ts`, all three new test files) produce ZERO tsc errors. Verdict: **WP5 introduces no new tsc errors**; tsc is not the CI gate.
6. **Verification runs.** `bun test resumeAgentFlush304.test.ts` → `4 pass, 0 fail, 18 expect() calls [1157.00ms]`; combined dependent run (9 files: `toolNamesUsed304`, `compactionRecentNote293`, full `src/services/compact/`, `forkPermissionModeWiring285`, `sendMessageShutdownGuard304`, `autoCompactWindowEnv304`) → `99 pass, 0 fail, 222 expect() calls [911.00ms]`; item-41 sweep (9 files: `autoCompactWindow.test`, `AliasPins302`, `AliasKey302`, `WarnGate300`, `PerModel288`, `Env304`, `agentAutoCompactWindow296`, `autoCompactWindowSubagent296`, `compactSummaryDollar268`) → `167 pass, 0 fail, 344 expect() calls [886.00ms]`; `bunx biome lint` on all changed/new files → `Checked 12 files in 16ms. No fixes applied.` + `Checked 1 file in 4ms. No fixes applied.` (autocompact-noninteractive.ts) — 0 errors, 0 warnings; `bunx tsc --noEmit` → exit 2 / ~967 baseline / zero new in WP5 files.
7. **Cluster discipline.** Only the WP5 cluster was touched: `src/utils/autoCompactWindow.ts`, `src/commands/autocompact/autocompact-noninteractive.ts`, `src/services/compact/**` (`summaryHeader.ts`, `toolNamesUsed.ts`, `prompt.ts`, `compact.ts`, `sessionMemoryCompact.ts`, `__tests__/toolNamesUsed304.test.ts`, `__tests__/compactionRecentNote293.test.ts`), `src/components/CompactSummary.tsx`, `src/tools/AgentTool/resumeAgent.ts`, `src/tools/AgentTool/__tests__/resumeAgentFlush304.test.ts`, `src/utils/__tests__/autoCompactWindowEnv304.test.ts`, and this doc. `src/main.tsx` / `src/components/Settings/Config.tsx` (another WP), `src/services/api/claude.ts` / `src/utils/attachments.ts` (another WP), `src/utils/sessionStorage.ts` (read-only reference), package.json version, CHANGELOG.md, and `docs/upstream-version-gap-*.md` were NOT edited. No git write commands were run.
