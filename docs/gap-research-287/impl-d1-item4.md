# impl-d1-item4 — 2.1.287 CL:18 Fable `/model` picker saves the alias, not the version id

**Status: DONE (port landed, byte-faithful).** One required follow-up outside my file lane
(8 stale assertions in an existing test file — exact diff supplied below).

Lane: `src/utils/model/modelOptions.ts` (modified) + `src/utils/model/__tests__/fablePickerAlias287.test.ts` (new).
No other file touched. Not committed (orchestrator commits).

## 1. What changed

### `src/utils/model/modelOptions.ts:1337` — the port (one behavior line)

`getFablePickerRow(model, fastMode)` (OCC's equivalent of official `U8` v286 → `U3` v287) now
returns the family **alias** instead of the passed-in concrete version id:

```diff
@@ -1319,6 +1319,13 @@ function getFablePricingSuffix(model: string, fastMode: boolean): string {
  * the picker's post-step. `cl` is the blurb; `Bc()` (usage-credits suffix)
  * is staged-empty (docs/upstream-version-gap-occ113.md); subscribers get no
  * pricing suffix (`ft()?"":In(e,n)`).
+ *
+ * 2.1.287 (CL:18, byte-verified): official `U8` (v286) → `U3` (v287) — the
+ * ONLY delta is `value:e` → `value:"fable"`, i.e. the row stores the family
+ * ALIAS instead of the passed-in concrete version id, so picking Fable saves
+ * a default that follows the newest Fable, exactly like the first-party Opus
+ * and Sonnet rows already store `'opus'`/`'sonnet'`. `name`/`description`/
+ * `descriptionForModel` stay computed from the concrete `model` (unchanged).
  */
 function getFablePickerRow(model: string, fastMode = false): ModelOption {
   const name = getFableMarketingName(model) ?? 'Fable 5.1'
@@ -1327,7 +1334,7 @@ function getFablePricingSuffix(model: string, fastMode: boolean): string {
     ? ''
     : getFablePricingSuffix(model, fastMode)
   return {
-    value: model,
+    value: 'fable',
     label: 'Fable',
     description: `${name} · ${blurb}${pricingSuffix}`,
     descriptionForModel: `${name} - most capable for your hardest and longest-running tasks`,
```

The **only** behavior change is `value: model` → `value: 'fable'` (line 1337). The 7 added lines
are a provenance doc comment, matching this file's established byte-verified-annotation
convention (see the neighbouring `VG`/`YG`/`Tv`/`yi("sonnet")` comments). `name`,
`description`, `descriptionForModel` still derive from the concrete `model` arg — unchanged,
exactly as the report specified and as official `U3` does (`bM(e)` still receives `e`).

### Explicitly NOT touched (verified correct as-is)

- **Tail-insert custom-pin path** `modelOptions.ts:1432–1442` (`isFableModelValue(customModel)`
  → `modelRowsValueEqual` family match → `options[matchIdx] = { ...options[matchIdx]!, value: customModel }`,
  else sorted-insert `getFableRowForValue(customModel)`). This is the official `YG`/`fi(E)`
  branch; a user who pinned a concrete Fable version still gets that row rewritten to the
  concrete id. Covered by test #6 below.
- **Fable post-step call site** `modelOptions.ts:1406–1418` — unchanged. Its dedup guard
  `!options.some(opt => typeof opt.value === 'string' && isFableModelValue(opt.value))` still
  holds because `isFableModelValue('fable') === true` (`modelOptions.ts:972`), so no duplicate
  Fable row can be inserted now that the row value is the alias.

### Alignment context confirmed (as the task asked)

- First-party Opus/Sonnet rows already store the alias: `getOpus55Option` → `value: is3P ? … : 'opus'`
  (`modelOptions.ts:373`), `getSonnet55Option` → `value: is3P ? … : 'sonnet'` (`modelOptions.ts:172`),
  plus `getOpus5Option` (`:355`) / `getSonnet5PreviousOption` etc. Fable was the odd one out.
- Extra corroboration found while verifying: OCC's `getCustomFableOption()` (custom-base-url
  case, binary `NBc`) **already** returned `value: 'fable'` (`modelOptions.ts:248`) — the stock
  post-step row was the last Fable builder still storing a concrete id.
- The alias resolves end-to-end: `parseUserSpecifiedModel`'s `case 'fable':` arm
  (`src/utils/model/model.ts:920–933`) → `getDefaultFableModel()` (`model.ts:252`, env →
  gateway `fable5` → else `fable51`). So saving `'fable'` genuinely follows the newest Fable,
  which is the changelog's user-visible promise. Confirmed by the pre-existing e2e
  `test/e2e/version-2.1.197-models.e2e.test.ts:161` ("fable alias resolves …"), which passes.

Note on minified names: the existing OCC comment above the function cites `VG` (@196267100,
recovered in the 2.1.280-round binary); the 287 report cites `U8`/`U3` (@203061451 /
@205079818). That is normal per-version minifier churn of the same builder — not a site
mismatch. The described site matched reality exactly, so no STOP was warranted.

## 2. Test file

`src/utils/model/__tests__/fablePickerAlias287.test.ts` (new, 6 tests, AAA structure, single
quotes, no unused imports, biome-lint clean).

The production builder `getFablePickerRow` is module-private, so the tests drive the real
production entry `getModelOptions()` (the only path that reaches it — the `ui(s,VG(OHe(),e))`
Fable post-step), with `mock.module` on `../../auth.js` / `../../settings/settings.js` /
`../../config.js` following the `modelOptionsTierWiring280.test.ts` convention (snapshot-before-mock
+ `afterAll` restore per the OCC-97 Gap-97b leak lesson). No `export` was added to the
production file to make it testable.

| # | Test | Pins |
|---|------|------|
| 1 | stores value `"fable"` for the clean-env default Fable (`claude-fable-5-1`) | requirement (1); also asserts `value !== 'claude-fable-5-1'` (the v286 bug) |
| 2 | stores value `"fable"` for every concrete id the resolver can return (`claude-fable-5-1`, `claude-fable-5`, `claude-fable-6`, `claude-mythos-5-1` via `ANTHROPIC_DEFAULT_FABLE_MODEL`) | requirement (1), id-independence |
| 3 | description/descriptionForModel still carry the marketing name from the model arg (`Fable 5.1 · …` / `Fable 5 · …` + `… - most capable for your hardest and longest-running tasks`) | requirement (2) |
| 4 | non-subscriber (API-key) login also stores `"fable"`; pricing suffix only affects the description tail | requirement (1) across the `ft()?"":In(e,n)` arm |
| 5 | consistency with the first-party Opus/Sonnet rows: picker values contain `fable`/`sonnet`/`haiku` and **no** `claude-fable-*` | alignment assertion the task asked for |
| 6 | tail-insert custom pin (`setInitialMainLoopModel('claude-fable-5-1')`) rewrites the family-matched row in place to the concrete id, label kept, exactly one Fable row | requirement (3) — `YG`/`fi(E)` path, tested without modifying it |

### RED/GREEN verification (A/B on the single ported line)

Flipped `modelOptions.ts:1337` back to `value: model` and re-ran: **4 fail / 2 pass**
(failures showed `Expected: "fable"` / `Received: "claude-fable-5-1"` and
`Received: [ "sonnet", "claude-fable-5-1", "haiku" ]`). Restored → **6 pass / 0 fail**.
Test 6 passes both ways by design (it is a guard that the untouched tail path still pins the
concrete id).

## 3. Test command + results

```
cd occ && bun test \
  src/utils/model/__tests__/fablePickerAlias287.test.ts \
  src/utils/model/__tests__/modelOptionsTierWiring280.test.ts \
  src/utils/model/__tests__/modelOptionsHelpers280.test.ts \
  src/utils/model/__tests__/opus55Launch280.test.ts \
  src/utils/model/__tests__/sonnet55Launch284.test.ts \
  src/utils/__tests__/modelCostSonnet5Tier105.test.ts \
  test/e2e/version-2.1.197-models.e2e.test.ts \
  test/utils/model/version-2.1.257-gap113.test.ts
```

(`rg -ln getModelOptions test src --glob '*.test.ts'` returns only the 4 modelOptions suites +
my new file; the two extra model e2e/config files were added to prove the saved `'fable'` alias
still resolves. Full suite NOT run, per instructions — other agents are editing this worktree.)

- New file alone: **6 pass / 0 fail / 24 expect()**.
- Combined 8 files (181 tests): **173 pass / 8 fail / 373 expect()**, 1.96 s.
- `bunx biome lint src/utils/model/modelOptions.ts src/utils/model/__tests__/fablePickerAlias287.test.ts`
  → "Checked 2 files … No fixes applied" (clean).

## 4. Deviations / required follow-up

**PARTIAL — 8 stale assertions in a file OUTSIDE my lane (mechanical, ready to apply).**
All 8 failures are in `src/utils/model/__tests__/modelOptionsTierWiring280.test.ts`
(2.1.280 #078 tier-wiring suite) and are *not* regressions: they pin the pre-fix v286 row value
inside `expect(options.map(o => o.value)).toEqual([...])` arrays. Every failure is the identical
single-element swap (verified: `grep -c '^-   "claude-fable-5-1",'` = 8, and each diff hunk is
`- Expected - 1 / + Received + 1` with `"sonnet"` / `"haiku"` neighbours unchanged):

```diff
    "sonnet",
-   "claude-fable-5-1",
+   "fable",
    "haiku",
```

Literal sites to change (the `toEqual` call sites are 3 lines above each):
`177, 200, 216, 232, 248, 278, 309, 327` → replace `'claude-fable-5-1'` with `'fable'`.
Affected tests: the 5 plan-tier-gate cases (Pro / Team / Max / TeamPremium / Enterprise),
2 extra-usage-1M-row cases (Pro, Max), and the 3P-sonnet-probe demotion case.
I did **not** edit that file — the lane allowed only `modelOptions.ts` + one new test file.
This is a blocker for a green commit/CI, so the orchestrator should either grant that lane or
apply the 8-token update (also worth appending a `// 2.1.287 CL:18: row value is the alias`
note there). No other test file in the repo references `getModelOptions`, and the remaining
`claude-fable-*` test hits (envInfo, maxTokens, modelGovernance, modelLadder,
unrecognizedModelSignal, the 2.1.197/2.1.257 model e2e) are model-id/resolution assertions
unaffected by this change — all pass.

No other deviations: nothing was invented, no adjacent refactor, no other file touched.
