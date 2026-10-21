# impl-WP8 — /usage one-line fixes naming their source + `f` applies fixes + narrow-terminal row cutoff (CC 2.1.305)

Status: **LOGIC HALF LANDED · UI/DOCTOR/VS-CODE HALVES STAGED** (no commit, per instructions). Branch `agent/occ/156f5788`.

Changelog items covered (official 2.1.305):
1. "`/usage`: each warning is now a one-line fix that names its source, and `f` applies the fixes; the same fixes appear in VS Code and `/doctor`"
2. "Fixed `/usage` rows being cut off in narrow terminals"

Read-only forensics sources: `/tmp/cc-diff-306/v304/package/claude` + `v306/package/claude` (official ELF binaries, never executed); strings dumps `/tmp/cc-diff-306/{s304,s305,s306,new305,new306}.txt`. All offsets below are byte offsets into `package/claude`.

---

## 1. PHASE 1 — extraction findings (offsets + verbatim snippets)

### 1.1 The v305 recommendation/fix catalog module — @256635621

v306 adds a module exporting `{kRt, oOn, wYe, P$e, vYe, D3t, iso, EYe}` (absent from v304):

| Mangled | Recovered role |
|---|---|
| `kRt` | `createEvidenceWindow()` — per-window evidence accumulator |
| `oOn` | statsig gate `tengu_tidy_abacus` (default **true**) gating the fixes UI |
| `wYe` | window orchestrator (scan projects dir → day/week windows + recommendations) |
| `P$e` | `10` — behavior pct threshold (rows ≥10% render) |
| `vYe` | `10` — recommendations cap constant group |
| `D3t` | `buildUsageFix(window)` — assembles the composite fix message |
| `iso` | `applyUsageFix(fix, enqueue)` — enqueues fix messages as queued prompts |
| `EYe` | `buildUsageRecommendations(...)` — final recommendation map (sort + cap 5) |

Recovered constants (verbatim from the binary):
- `MAX_RECOMMENDATIONS = 5`; top-list cap `y = 8`; `BYTES_PER_TOKEN = 2.5` (attachment tokens = `lineBytes / 4`, large-result gate `$3t(e) = e/2.5 > 1e4` @256617914).
- Tool-use evidence map cap `z = 64` (FIFO eviction); large-result candidate cap `K = 100`; attachment parse cap `D = 1e6`.
- `ALWAYS_ON_MIN_TOKENS = 40_000`; dominance gate `dominantTokens < start.tokens / 4 → fallback`.
- `Y0t = 'workflow-subagent'` @246371997 (excluded from subagent attribution); `es` = `shortenHomePath` @238718577; `Zr` = `parseMcpToolName` @237834294; `uso` @256622127.

Verbatim recommendation strings (all recovered byte-exact, now in `usageRecommendations.ts`):
- `'Save max effort for hard tasks'`, `'Save workflows for big tasks'`, `'Compact before you step away'`, `'Start fresh when you switch tasks'`, `'Stop sessions you no longer need'`, `'Turn off ultracode'`, `'See what fills your context'`, `'Trim the CLAUDE.md files in ${top}'`, `` `Trim ${shortenHomePath(path)}` ``, `` `Read ${tool} ${detail} in parts` ``, `'1 agent ran, mostly in ${proj}'` / `'${n} agents ran, mostly in ${proj}'`.
- Fix prompt preamble (`D3t`): multiple prompts are numbered `` `${FIX_PROMPT_PREAMBLE}\n1. ...\n2. ...` ``; a single prompt is unnumbered.
- `EYe` final map: command actions → `detail = \`run ${command}\``; switch actions → `detail = command` (e.g. `/effort ultracode off`).
- `iso` applier enqueues `{value, mode:'prompt', priority:'later', origin:{kind:'auto-continuation'}}`; the `/effort`-prefix message is exempt from `skipAttachments`/`skipSlashCommands`.

### 1.2 Evidence attribution (official `te` → `attributeWindowEvidence`)

- Per record: skip `ts < sinceMs` or seen-uuid.
- `alwaysOnStarts` updated only when `!previous || previous.ts < record.ts` (ties keep the FIRST snapshot — reproduced in the e2e test ordering).
- `largeResults` keyed `` `${project}\u0000${tool}\u0000${detail}` ``; tokens = max; count++; cost weighted by attributedTokens × hitCounts.
- Request state machine (`applyRequestRecord`): `startTokens = firstRecord.contextTokens − round(firstPromptBytes / 2.5)`; `alwaysOnTokens` stamped when `startTokens > 40k && !isSubagent`; large-tool-result accrual `grown = min(contextTokens − carriedTokens, pendingToolResultBytes / 2.5)` when `> 10k`.

### 1.3 Text formatter — @261447620

v306 `{G as call, S as formatBehaviors, v as formatRateLimits}` with `h` = formatWindow and `m` = formatTopList (cap 8). Row shape verbatim: `` `  ${String(pct).padStart(2)}%  ${title}${detail ? ` · ${detail}` : ''}` ``. New disclaimer: `'Approximate · sessions on this machine only · shares overlap'` (the long v299 disclaimer and the v299 `BEHAVIOR_WARNING_TEMPLATES` strings — ">100k-token cache miss" etc., 3 hits in v304, 0 in v306 — are officially deleted; recommendation rows replace them).

### 1.4 Telemetry

`usage_fix` event: s304 → 0 hits, s305 → 3 hits (new in 2.1.305). Metadata keys are numbers-only in OCC's logEvent → logged as `{message_count, key_count}`.

### 1.5 Interactive `f` surface (v306 UI chunk @279807309–279826636)

- `Fs` loader @279808930: `'Scanning local sessions…'` (v304 `Rs` @278296782 / `Ms` @278296130 baseline).
- `Ws` empty state: `'Nothing over 10% in this period — try the other window.'`
- `Oa` hints: `'fix N of M'` / `'fix this'` / `'fix both'` / `'fix all N'`.
- Default bindings @245032886: Settings `{r:"settings:retry", d:"settings:periodDay", w:"settings:periodWeek", f:"settings:fixUsage", t:"settings:sortByTokens"}`.
- Remote-Control gate: `'Nothing was sent. Turn off Remote Control to use fixes.'`

### 1.6 Narrow-terminal cutoff fix

Official delta is in the scan-UI component: v304 `Ms` @278296130 renders rows with `width: u` → v306 `Fs` @279808930 renders with `maxWidth: u` (Ink `<Text>` truncation → wrap). No other layout delta found for the /usage rows.

---

## 2. PHASE 2 — verdicts per sub-item

### 2.1 "Each warning is a one-line fix that names its source" — **IMPLEMENTED** (logic + non-interactive text path)

New pure catalog `src/commands/usage/usageRecommendations.ts` (~600 lines, zero local runtime imports): all behavior/attribution builders (`ae` behavior switch, `le` always_on with memory-dominance + `Trim <file>` naming, `ue` large_tool_results with `Read <tool> <detail> in parts` naming), `EYe` final map (sort, cap 5, `run <command>` details, `workflow-subagent` exclusion, name sanitizers), `D3t` composite-fix builder (numbered-prompt preamble), `iso` applier (enqueue shapes + `/effort` exemption). Verbatim strings throughout; unrecoverable internals documented as evidence-commented divergences (BYTES_PER_TOKEN 2.5 for the `eps` divisor; attachment field names accepted as `path ?? filePath` / `content ?? text`; official `YG`/`Kh` sanitizers omitted fail-safe).

`usageScan.ts` gained the evidence machinery: `FileEvidenceCollector` (tool-use FIFO-64 map, attachment memory/parts routing, >25KB large-result candidates with raw-marker cut, K=100 cap), `attributeWindowEvidence` / `attributeFileEvidence` (official tie-keep ordering), and the new `computeUsageWindows(effortState, now?, projectsDir?)` orchestrator (official `wYe`: day/week cutoffs, per-file collector fan-out, `!sawAny → null`) returning `{pcts, recommendations}` per window. `computeUsageBehaviors` unchanged.

`usageWarnings.ts` rewritten to the v306 shape: `BEHAVIORS_DISCLAIMER` verbatim, `BehaviorWindowPcts.recommendations?`, `formatWindow` renders the official `  NN%  title · detail` rows (pct `padStart(2)`), nulls only when recs AND top-lists are both empty; v299 warning templates deleted per the binary.

`usage-noninteractive.ts` (`/usage -p` path) now computes windows via `computeUsageEffortState()` and feeds `recommendations` into `formatBehaviors` — so the non-interactive surface already shows the source-naming one-line fixes.

`usageEffortState.ts` (new): official effort-state inputs (`getInitialEffortSetting`, `getEffortEnvOverride`, `isUltracodeEnabled`) mapped to `{isEffortBelowMaxSaved, effortBelowMax, isEffortSwitchFree, isUltracodeOn}`.

`usageFixEnqueue.ts` (new): `enqueueUsageFix(fix)` = `applyUsageFix(fix, enqueue-adapter)` + `logEvent('usage_fix', {message_count, key_count})`. The `QueuedCommand.origin` field is string-typed in OCC but object-consumed by the official shape → documented `as unknown as MessageOrigin` cast.

### 2.2 "`f` applies the fixes" (interactive REPL) — **STAGED**

The applier (`iso`/`applyUsageFix`) and enqueue adapter are landed and unit-tested, but wiring the interactive `f` key requires files outside this WP's touch list: `src/screens/Usage.tsx` (scan section + `settings:fixUsage` binding + hints `'fix N of M'`/`'fix this'`/`'fix both'`/`'fix all N'` + the Remote-Control gate string) and the keybindings provider registration (`Tn`). Blueprint captured in §1.5 for the UI WP; all verbatim strings are already exported from `usageRecommendations.ts`/documented here.

### 2.3 "The same fixes appear in … `/doctor`" — **STAGED** (divergence note)

OCC's `Doctor.tsx:548` renders `` `Fix: ${warning.fix}` `` as **strings only** — there is no fix-application surface in OCC doctor to share appliers with (official doctor reuses the same fix objects behind an interactive apply action). Per the task rule ("share appliers with /doctor only if OCC doctor has a compatible fix surface") this is a documented divergence, not wired. The appliers are exported from `usageFixEnqueue.ts`/`usageRecommendations.ts` so a future doctor WP can import them without touching usage internals.

### 2.4 "…and in VS Code" — **SKIP** (no OCC VS Code extension; per task instruction).

### 2.5 "Fixed `/usage` rows being cut off in narrow terminals" — **NO GAP**

The official fix is `width: u` → `maxWidth: u` in the interactive scan UI component (`Ms`@278296130 → `Fs`@279808930). OCC has no corresponding scan UI component (it is part of the STAGED §2.2 surface), and OCC's existing `/usage` renderer (`LimitBar`) already matches the official `Mt` verbatim — nothing truncates rows in OCC today. Blueprint recorded: when the scan UI lands, use `maxWidth` (wrap) not `width` (truncate). The non-interactive text rows are plain strings and wrap naturally.

---

## 3. Files changed

New:
- `src/commands/usage/usageRecommendations.ts` — v305 recommendation/fix catalog (pure).
- `src/commands/usage/usageEffortState.ts` — effort-state inputs for `computeUsageWindows`.
- `src/commands/usage/usageFixEnqueue.ts` — `applyUsageFix` enqueue adapter + `usage_fix` telemetry.
- `src/commands/usage/__tests__/usageRecommendations306.test.ts` — catalog unit tests (verbatim strings, all builder branches, EYe/D3t/iso).
- `src/commands/usage/__tests__/usageScanEvidence306.test.ts` — evidence collector, attribution, and `computeUsageWindows` e2e tests (temp-dir fixtures).

Edited:
- `src/commands/usage/usageScan.ts` — evidence machinery + `computeUsageWindows` orchestrator.
- `src/commands/usage/usageWarnings.ts` — v306 formatter shape (rows, disclaimer, null rules).
- `src/commands/usage/usage-noninteractive.ts` — recommendations wired into the `-p` output.
- `src/commands/usage/__tests__/usageScan299.test.ts` — orchestrator assertions updated to the v306 output shape.
- `src/commands/usage/__tests__/usageWarnings299.test.ts` — rewritten for the v306 formatter.
- `src/commands/usage/__tests__/usageNoninteractive299.test.ts` — cross-file mock-leak hardening (below).
- `src/commands/usage-credits/__tests__/usageCreditsMessage288.test.ts` — **test-only leak fix** (see §4); no production change.

Not touched (per rules): `package.json`, `CHANGELOG.md`, `docs/` except this report, `src/commands/doctor/**` (no compatible fix surface — §2.3).

---

## 4. Cross-file mock-leak fix (usageCreditsMessage288.test.ts)

`bun test src/commands/usage` path-substring-matches `src/commands/usage-credits/__tests__/usageCreditsMessage288.test.ts` too (6 files). That file registered **narrow** full-replacement module mocks (auth.js → `{getSubscriptionType}` only, plus config/log/billing/browser/usage/adminRequests/overageCreditGrant) and relied on `mock.restore()` in `afterAll` — which does **not** unregister module mocks in Bun. When it ran first in the worker, the noninteractive test's fresh evaluation of the real auth/claudeAiLimits chain link-failed with `SyntaxError: Export named 'isClaudeAISubscriber' not found in module '.../src/utils/auth.ts'` (claudeAiLimits.ts:5 imports it at link time; the leaked stub lacked it).

Fix (the repo-established OCC-97 pattern, same as usageNoninteractive299): capture the real modules before mocking, re-register real supersets in `afterAll`. The noninteractive test additionally hardens its real-module capture with cache-busting `?wp8Real` suffixes and re-registers the real auth superset **before** evaluating `claudeAiLimits?wp8Real`, so link order can't regress regardless of file ordering.

---

## 5. Verification

- `bun test src/commands/usage` → **129 pass / 0 fail / 271 expect() across 6 files** (includes the usage-credits file the filter matches).
- `bun test src/commands/usage-credits` → 2 pass / 0 fail (unchanged behavior).
- `bunx biome lint src/commands/usage src/commands/usage-credits/__tests__/usageCreditsMessage288.test.ts` → **exit 0, 0 errors** (14 files checked).
- NUL-byte scan over all touched files: clean (earlier literal-`\x00` emissions from the Write tool in the `\u0000` key separators were replaced with escapes — runtime-equivalent).
- No commit made (per instructions).

## 6. Known divergences / unrecovered details (evidence-commented in code)

1. `eps` token divisor not recoverable from the binary → `BYTES_PER_TOKEN = 2.5` (matches `$3t` @256617914 gate arithmetic).
2. Attachment file field names not recoverable → accepts `path ?? filePath`, `content ?? text`.
3. Official `YG`/`Kh` name-sanitizer internals not fully recoverable → conservative fail-safe sanitizers (reject camel-density, unsafe chars) with test coverage.
4. `usage_fix` telemetry metadata reduced to `{message_count, key_count}` (OCC `logEvent` accepts numbers only).
5. `QueuedCommand.origin` documented cast (§2.1).
