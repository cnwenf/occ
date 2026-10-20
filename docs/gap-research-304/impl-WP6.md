# impl-WP6 — CLI UX cluster (research-R5-cli-ux.md + R1 small items)

Work-package WP6 of the 2.1.304 catch-up round. All official strings below were
taken verbatim from `docs/gap-research-304/research-R5-cli-ux.md` /
`research-R1-auto-mode.md` (byte-verified against the official 2.1.304 binary).
Branch: `agent/occ-leader/3bdf2d90`. No git commands were run (edit-only per
hard rules). Sole-owner files (`src/main.tsx`, `src/components/Settings/Config.tsx`)
received only the listed-anchor edits.

## Item 1 — #29 help texts ×6 (`src/main.tsx` only)

**Files changed:** `src/main.tsx` (6 surgical string edits, listed anchors only).

**Verbatim 304 strings applied:**
| Flag | Old (303) | New (304, verbatim) |
|---|---|---|
| `-d, --debug [filter]` | `…(e.g., "api,hooks" or "!1p,!file")` | `Enable debug mode with optional category filtering (e.g., --debug=hooks,mcp or --debug='!hooks,!mcp')` |
| `--json-schema <schema>` | `JSON Schema for structured output validation. ` | `JSON Schema for structured output validation (only works with --print). ` |
| `--tools <tools...>` | `"default" to use all tools` | `Use "" to disable all tools, "default" to use the default set, or specify tool names (e.g. "Bash,Edit,Read").` |
| `-r, --resume [value]` | `Resume a conversation by session ID, or open…` | `Resume a conversation by session ID or name, or open interactive picker with optional search term` |
| `--disable-slash-commands` | `Disable all skills` | `Disable all skills and commands` |
| `update`/`upgrade` description | `Check for updates and install if available` | `Check for updates and install if available; package-manager installs update through the package manager` |

**Tests:** pure help-text changes — covered by existing
`test/e2e/commands-alignment.e2e.test.ts` (not re-run here; needs live CLI).
**Deviations:** none — strings copied verbatim.

## Item 2 — R1 small items

**Files changed:**
- `src/utils/permissions/permissionSetup.ts` — stale comment fix ONLY (no code
  change): the `AUTO_MODE_ENABLED_DEFAULT` comment cited an official 2.1.200
  `'opt-in'` parse-default; the byte-verified 303/304 parse-default is
  `"enabled"` (@251169230/@253857395). Comment now records the correction and
  documents OCC's deliberate `'opt-in'` local divergence (product posture, per
  research-R1 §5(d)+§6). The constant value is unchanged.
- `src/main.tsx:2665-2706` — LOW-1 (research-R1 §5e): the automated-session
  auto-mode default-nudge block is now wrapped in try/catch; failures log via
  `logForDebugging` and startup continues with the current permission mode.

**Tests:** existing `src/utils/permissions/__tests__/autoDefaultNudge296.test.ts`,
`autoDefaultNudge296Merge.test.ts`, `autoModeReevaluate295.test.ts`,
`src/cli/__tests__/setModelAutoMode299.test.ts` — all green (see Verification).
**Deviations:** none.

## Item 3 — #17 path display (`getDisplayPath` + NUL guard)

**Files changed:**
- `src/utils/file.ts` — `getDisplayPath` (official `Fo`) gained the NUL guard
  FIRST (before any path resolution): `if (filePath.includes('\0')) return
  'Path hidden (unsupported characters)'`. The literal exists verbatim in both
  303 and 304 binaries; 304 adds its usage in `Fo`.
- Display sites switched from `relative(getCwd(), p)` to `getDisplayPath(p)`
  (out-of-cwd files now render `~/…` or the full path instead of `../../…`):
  - `src/tools/FileWriteTool/UI.tsx` (2 sites: created-message + `Wrote N lines to` result line; import already present for the other 2 call sites)
  - `src/components/FileEditToolUseRejectedMessage.tsx` (1 site)
  - `src/components/NotebookEditToolUseRejectedMessage.tsx` (1 site)
  - `src/components/permissions/NotebookEditPermissionRequest/NotebookEditToolDiff.tsx` (1 site; incidental: the compiler-generated `bb2:` labeled-break was simplified to plain `break` while editing the same switch — behavior-identical)

**Tests:** `src/utils/__tests__/getDisplayPath304.test.ts` (NEW, 4 tests):
- `path inside cwd renders as a relative path (no ../../)`
- `path under $HOME but outside cwd renders with ~/… notation`
- `path outside cwd and home renders as the full absolute path`
- `path containing a NUL byte renders as the hidden placeholder`

`bun test src/utils/__tests__/getDisplayPath304.test.ts` → **4 pass / 0 fail / 6 expect()**.

**Deviations:** site selection — only the 5 non-verbose `relative(getCwd(),…)`
display sites in the cluster were converted; `verbose` branches keep the raw
absolute path (matches official shape `verbose ? p : Fo(p)`).
**Integration notes:** `getDisplayPath` is also used by pre-existing call sites
(FileWriteTool lines 163/181) — the NUL guard now protects those too.

## Item 4 — #33 /effort auto-without-guessing

**Files changed:**
- `src/utils/effort.ts` — `getDisplayedEffortLevel` (official `kWe`) now returns
  `string | undefined`: `resolveConfiguredEffort` short-circuits to `undefined`
  when env is `auto`/unset before any settings/cap read. Request-path resolver
  `resolveAppliedEffort` untouched.
- `src/commands/effort/effort.tsx` — `showCurrentEffort` (official `f6t`) auto
  branch: bare `Effort level: auto` when nothing resolves;
  `Effort level: auto (currently ${level}${orgSuffix})${suffix}` otherwise.
  `enableUltracode`: `Effort stays auto.` appended when the display resolver
  returns undefined under `CLAUDE_CODE_EFFORT_LEVEL=auto`.
- `src/components/EffortIndicator.ts` — chip (official `EE`) HIDES
  (`getEffortNotificationText` → undefined) instead of rendering a guessed level.

**Verbatim strings:** `Effort level: auto` · `Effort level: auto (currently ${level}${orgSuffix})${suffix}` · ` · Ultracode on` · `, set by your organization` · `Effort stays auto.`

**Tests:**
- `src/utils/__tests__/effortCap267.test.ts` — new describe J
  `#33 auto-without-guessing display (CC 2.1.304 — official kWe/f6t)` (5 tests:
  bare-auto, `(currently xhigh)` form, env-auto hides resolver output,
  ultracode ` · Ultracode on` suffix on both auto forms, explicit session level
  keeps `Current effort level:` form) + prior-session describe-I display-cap tests.
- `src/components/__tests__/effortIndicator304.test.ts` (NEW, 4 tests):
  chip undefined under env=auto; positive control defined + `endsWith('· /effort')`
  (shape-only to survive real settings caps); explicit `medium` arg still hidden
  under env=auto (hide driven by the RESOLVER); pre-#33 model gate.
- `src/utils/__tests__/effortGap97.test.ts` — updated to the new texts.

`bun test effortIndicator304 + effortCap267 + effortGap97` → **107 pass / 0 fail / 244 expect()**.

**Deviations:**
- `orgSuffix` is always `''` — OCC has no org-policy registry
  (docs/upstream-version-gap-occ82.md §5.1/§5.5, `Stt ≡ N`); template shape kept faithful.
- `${ULTRACODE_ACTIVATION_MESSAGE} Effort stays auto.` space-join is OCC
  composition (research pins only the literal + its trigger).
- `e4` ≡ identity; raw level strings rendered as-is (existing OCC behavior).
**Integration notes:** env `auto`/unset → envOverride `null` → resolver
short-circuits BEFORE settings reads, so chip-hide is deterministic without
settings mocks (used by effortIndicator304's mock-free harness).

## Item 5 — #36 AskUserQuestion notes input

**Files changed:** `src/components/permissions/AskUserQuestionPermissionRequest/PreviewQuestionView.tsx`
- `notesInputColumns = Math.max(1, previewMaxWidth - stringWidth('Notes:') - 1)`
  (official `Ar=Math.max(1,rr-ae("Notes:")-1)`; `stringWidth` from
  `../../../ink/stringWidth.js`), replacing the old fixed `columns={60}`.
- Notes `TextInput`: `maxVisibleLines={5}` (official `maxVisibleLines:5`),
  `disableEscapeDoublePress={true}` (official `!0`).
- `Notes:` label wrapped in `<Box flexShrink={0}>` (official label wrapper —
  prevents label squeeze at narrow widths; anthropics/claude-code#82768).

**Tests:** no existing tests touch PreviewQuestionView; display-only layout
change (no behavior strings). Biome lint clean.
**Deviations:** none.

## Item 6 — #43 /usage rate-limit end time

**Files changed:**
- `src/services/api/usage.ts`:
  - `FetchUtilizationResult.heldUntilMs?: number` (official rate-limit memory store field).
  - `computeRateLimitHeldUntilMs(retryAfterHeader)` — official
    `untilMs = Date.now() + Math.min(retryAfterMs>0 ? retryAfterMs : Ft, Ke)`;
    `parseRetryAfterMs` handles delta-seconds + HTTP-date; `extractRetryAfterHeader`
    handles plain objects and `AxiosHeaders.get()`.
  - `formatRateLimitedText(heldUntilMs)` — official `fo`: undefined →
    `rate limited — try again in a moment`; else
    `rate limited until ${formatResetTime(Math.ceil(ms/60000)*60)}`
    (OCC `formatResetTime(epochSeconds)` ≡ official `vA`).
  - Catch path: `heldUntilMs` recorded on 429 OR 403 and returned on all three
    catch exits (seeded-persisted / seeded-headers / unavailable);
    `isRateLimited`/`rateLimitedVia` keep pre-304 429-only semantics.
- `src/components/Settings/Usage.tsx` (3 sites): persisted-seed line
  `Showing last-known usage${asOf} (${formatRateLimitedText(…)})`; headers-seed
  line `Per-model breakdown unavailable (${formatRateLimitedText(…)})`;
  error line `Usage endpoint is ${formatRateLimitedText(…)}.`

**Verbatim strings:** `rate limited — try again in a moment` · `rate limited until ` · `Usage endpoint is `

**Tests:** `src/services/api/__tests__/usageHeldUntil304.test.ts` (NEW, 12 tests,
leak-guarded mock harness — pre-captured refs + `mockActive` flag + afterAll
re-pin, per the effortCap267 pattern):
- formatter: undefined → verbatim vague text; fixed epoch → exact `rate limited until ${formatResetTime(ceil)}`; ceil-to-minute boundary behavior.
- hold computation: RA `'120'` → +120s; absent → default; `'0'`/`'-5'`/`'soon-ish'` → default; `'999999999'` → capped; HTTP-date +300s honored.
- integration (axios-reject harness): 429+RA → flags + hold; 403+RA → hold only
  (flags stay 429-only); 429 no RA → default hold; 500 → no hold.

`bun test src/services/api/__tests__/usageHeldUntil304.test.ts` → **12 pass / 0 fail / 32 expect()**.

**Deviations:**
- `Ft` (default hold) = 60s and `Ke` (cap) = 24h — official VALUES not
  byte-pinned by the research; chosen conservatively, flagged in code comments.
- `Usage endpoint is ${fo}.` trailing period is OCC composition (official
  concatenation site keeps the 303-era trailing `.`).
- Integration tests don't assert `result.status` — module-level
  `seededUtilization` is shared across bun's single test process; only #43
  fields are asserted (identical on both catch sub-paths).
**Integration notes:** `getGlobalConfig` mock returns `{}` deliberately (a real
config could carry a fresh on-disk `cachedUsageUtilization` and divert into the
persisted-seed path).

## Item 7 — #49 invalid-settings warning

**Files changed:** `src/utils/invalidSettingsReport.ts`
- Grouping (official `JC`): `notLoadedEntries = reportable.filter(e =>
  e.severity !== 'warning')` — the did-not-load block now lists ONLY the
  blocking entries themselves (303 listed ALL entries of failed files);
  `notLoadedFiles = new Set(notLoadedEntries.map(e => e.file))`;
  `skippedEntries = reportable.filter(e => !notLoadedFiles.has(e.file))`.
- Formatter (official `YC`): entries grouped BY FILE (manual
  `Map<string, ValidationError[]>` keyed by the rendered label, first-seen
  order preserved — NOT `Map.groupBy`, ES2024), per-file cap
  `MAX_REPORTED_ENTRIES_PER_GROUP`(=10, official `Zh`), overflow line
  `  … and ${n} more in ${fileLabel}` (303: whole-group cap + `  … and ${n} more`).
- Skipped header shortened to the verbatim 304 string
  `These settings entries were skipped; the rest of each file is in effect:`.
- Unchanged: did-not-load header, telemetry
  (`tengu_own_settings_validation_errors`, not_loaded_file_count/skipped_entry_count),
  per-entry debug log, json/stream-json stderr suppression, inline-JSON label
  `--settings (inline JSON)`, `Ks` sanitizer.

**Tests:** `src/utils/__tests__/invalidSettingsReport076.test.ts` updated +
extended (21 tests total): overflow line now `  … and 3 more in /f.json`;
NEW per-file grouping tests (two overflowing files → own overflow lines,
order/no-interleaving; at-cap → no overflow line; inline-JSON label in
overflow); skipped-header test updated to the short verbatim string; mixed
severities test rewritten — not-loaded block contains ONLY the hard entry,
the same file's warning entry is in NEITHER block (304 semantics).

`bun test src/utils/__tests__/invalidSettingsReport076.test.ts` → **21 pass / 0 fail / 43 expect()**.

**Deviations:** grouping by RENDERED label instead of raw `e.file` — label ≡
file 1:1 (only the single `--settings` flag path maps to the inline label), so
grouping is equivalent and the overflow `in <file>` matches entry-line labels.
**Integration notes:** warning entries of did-not-load files still reach the
debug log + are counted in `not_loaded_file_count` via their file; they are
simply not rendered (official behavior). Sole caller `src/main.tsx` unchanged
(signature stable).

## Item 8 — #8 org-policy refresh on custom-API-key approval

**Files changed:**
- `src/components/ApproveApiKey.tsx` — `'yes'` branch: after the config save,
  `void refreshRemoteManagedSettings()` (import
  `../services/remoteManagedSettings/index.js`). Approving a custom key changes
  the applicable org policy → refetch (official approval branch refreshes
  post-save). `'no'` branch untouched.
- `src/components/Settings/Config.tsx` — apiKey toggle `onChange` (~:1072-1108,
  sole-owner surgical edit): after `setGlobalConfig(getGlobalConfig())`,
  `void refreshRemoteManagedSettings()` — fires on BOTH on and off, matching
  official `DB()`. Import added after the analytics import (line 19).
- Official `tFo` settings watcher deliberately SKIPPED per recipe (OCC has no
  equivalent watcher site; the two write paths above cover the toggle surface).

**Tests:** no behavior strings; fire-and-forget refresh. Existing
`src/utils/__tests__/customApiKeyResponses278.test.ts` (covers the write-path
normalizer at both sites) → **19 pass / 0 fail / 41 expect()**. Biome lint: the
1 Config.tsx warning (`suppressions/incorrect` at line 2) is pre-existing
(HEAD shows the identical 13-warning count across main.tsx + Config.tsx).
**Deviations:** tFo watcher skipped (per recipe).

## Verification

- `bun test` (12 files: effortCap267, effortGap97, effortCliFlag283,
  effortWrap293, effort-xhigh, ai-agent-effort, effortIndicator304,
  agentEffortParam292, usageHeldUntil304, invalidSettingsReport076,
  getDisplayPath304, customApiKeyResponses278) → **207 pass / 0 fail / 478 expect()**.
- `bun test` (13 files: existing tests of all other changed files —
  setModelAutoMode299, autoDefaultNudge296{,Merge}, autoModeReevaluate295,
  allowedToolsStripped304, startupRuleWarnings282, nonUtf8Refusal296 ×3
  (FileEdit/FileWrite/NotebookEdit), nestedMemoryTrigger288, staleReadRecovery,
  bomPreservation299, exitPlanModeScreenReader288) → **110 pass / 0 fail / 264 expect()**.
- `bunx biome lint` on all 22 cluster files → 13 warnings, ALL pre-existing
  `suppressions/*` markers (byte-identical count when linting the HEAD versions
  of main.tsx + Config.tsx). Zero new.
- `bunx tsc --noEmit` (full repo) → 979 total errors; every error line inside
  the WP6 cluster sits OUTSIDE this round's diff hunks (verified per file:
  effort.tsx:54 vs hunks@105/191; EffortIndicator.ts:45 vs hunk@49;
  effort.ts:243 vs hunks@438/456; Config.tsx:802/829 vs hunks@19/1103;
  effortCap267:81/95/841-933 vs hunks@168/681/1165) → all pre-existing
  (repo baseline ~1341, tsc not in CI per repo CLAUDE.md).
- No git commit/add/checkout/merge/branch commands were run.
