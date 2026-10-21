> **⚠️ SUPERSEDED (OCC-125 reconciliation, 2026-10-22):** the work described in
> this report was implemented in this round but **DROPPED before commit** — the
> parallel OCC-165 round landed its own version of the same upstream item on
> origin/main first, and per the collision precedent main wins every overlapping
> implementation. The file/test names below refer to the pre-reconciliation WIP
> commit `dc40f769`, NOT to the committed tree. See
> `docs/upstream-version-gap-occ125-2026-10.md` §1b for the mapping to main's
> P1–P10 items. "LANDED" statements below are historical to the WIP branch only.

# Impl WP2 — R3 ITEM 1: fuzzy modelOverrides match (CC 2.1.305 `Qcn`→`yfn`)

Status: **LANDED** — research `docs/gap-research-306/research-R3-model-settings-startup.md` ITEM 1 only. No other files touched (per WP scope: `src/utils/model/**` + tests + this report).

## Files changed

| File | Change |
|------|--------|
| `src/utils/model/modelStrings.ts` | `resolveOverriddenModel` (~:155-177): strict `override === modelId` → `modelIdsEqualAnyContext(override, modelId)` (import added from `./modelDescriptors.js`); comment `// CC 2.1.305 (binary yfn, byte-verified)` |
| `src/utils/model/__tests__/modelOverridesFuzzyMatch305.test.ts` | NEW — 14 tests (9 unit on `resolveOverriddenModel`, 2 `getCanonicalName` integration, 1 extra ARN integration, 1 `getSettingsEffortCap` + 1 `resolveAutoCompactWindow` consumer integration) |
| `src/utils/model/__tests__/unrecognizedModelSignal233.test.ts` | Test-hygiene fix (OCC-97 leak class): its `mock.module('../modelStrings.js')` stub of `resolveOverriddenModel` was never restored and leaked into later files in the same worker — 9/14 of the new suite failed in the full `bun test src/utils/model` run while passing standalone. Added a pre-mock export snapshot + `afterAll` restore, mirroring the `anthropicDefaultModel236.test.ts` pattern. No production-code implication. |

## Binary evidence (v306, read-only `grep -aboF` + `dd`; offsets absolute decimal bytes)

- `yfn` (reverse override-value→canonical resolver, the OCC `resolveOverriddenModel` counterpart) @ **240710505**:
  `function yfn(e){let n;try{n=gt().modelOverrides}catch{return e}if(!n)return e;for(let[r,s]of Object.entries(n))if(CA(s,e))return r;return e}` — fuzzy compare fragment `if(CA(s,e))return r;return e` @ **240710594**; identical fragment in `KS` @ **240890170**.
- `CA` (fuzzy equality) @ **238261966**: `function CA(e,n){return Mt(e).toLowerCase()===Mt(n).toLowerCase()}`
- `Mt` (strip one trailing `[1m]`, case-insensitive) @ **238261919**: `function Mt(e){return e.replace(/\[1m\]$/i,"")}`
- OCC's `modelIdsEqualAnyContext` (`src/utils/model/modelDescriptors.ts:105`) is already the byte-equivalent of `CA`∘`Mt` — reused as-is (DRY).

## Sweep for other strict modelOverrides value comparisons (step 2)

Grepped every `modelOverrides` site in `src/utils/model/`. Verdict: **`resolveOverriddenModel` was the only strict value-comparison site** — confirmed, as the research predicted:

- `modelGovernance.ts:170` `resolveWithOverrideMap` — already fuzzy (`modelIdsEqualAnyContext`). ✔
- `modelGovernance.ts:215-224` `isModelDeniedByPolicy` override-map loop — already fuzzy (`modelIdsEqualAnyContext`). ✔
- `model.ts:125-132` `getEnforcedDefaultModel` — compares the override **KEY** (canonicalId, lowercased) against the requested model and returns the value; a key→value lookup, not a value-comparison site. Out of scope of the `Qcn`→`yfn` delta. ✔
- `modelAllowlist.ts:121-133` `resolveModelForAllowlist` — delegates to `resolveWithOverrideMap` / `resolveOverriddenModel`; inherits the fix automatically. ✔
- `modelOptions.ts` (5 call sites), `unrecognizedModelSignal.ts`, `services/tokenEstimation.ts` — all consume `resolveOverriddenModel`/`getCanonicalName`; inherit the fix. ✔

## Tests

Non-degeneracy: the integration assertions use override values whose canonical key is NOT substring-recoverable (custom deployment names) — `firstPartyNameToCanonical` lowercases + substring-matches, so a plain ARN would canonicalize identically even under the old strict compare. **A/B proof**: temporarily reverting the compare to strict `===` fails 8 of 14 new tests; restoring the fix → 14/14 pass. (The pass-under-both set is the no-op / non-match / `[2m]` / settings-throw regressions — correct by design under either behavior — plus the extra ARN `getCanonicalName` case, kept knowingly as substring-degenerate coverage.)

Coverage per task spec: case-differs Bedrock ARN → canonical ID; `[1m]` on override value vs bare query; bare value vs `[1m]` query (reverse); `[1M]` case-insensitive strip both sides; `[2m]` NOT stripped (official `Mt` semantics pinned); regressions — exact match still works, non-matching input returned unchanged, no-`modelOverrides` no-op, settings-read-throw catch path (official `yfn` try/catch); `getCanonicalName` integration through the fuzzy path; `getSettingsEffortCap` (`/effort` bug) and `aggregateAutoCompactWindow` + `resolveAutoCompactWindow` (`/autocompact` bug) with a case-shifted override launch model, through the real consumer functions.

## Verification results

| Suite | Result |
|-------|--------|
| `bun test src/utils/model/__tests__/modelOverridesFuzzyMatch305.test.ts` | 14 pass / 0 fail |
| `bun test src/utils/model` (24 files, incl. the leak-fix pair in both orders) | **489 pass / 0 fail** / 973 expect() |
| `bun test src/utils/effort` | 22 pass / 0 fail |
| `bun test src/utils/__tests__/{effort*,ai-agent-effort,autoCompactWindow*}.test.ts` (13 files) | **278 pass / 0 fail** / 649 expect() |
| tokenEstimation consumers (`allowLarge296`, `contextRoom296`) | 89 pass / 0 fail |
| `bunx biome lint` (3 touched files) | 0 errors |

## Deviations / notes

- One extra file beyond the research plan was touched: the `unrecognizedModelSignal233.test.ts` mock-leak restore (required for the new suite — and any future real-`resolveOverriddenModel` test — to survive full-directory runs; in-scope under "src/utils/model/** and its tests").
- No git commit, no `bun install`, no package.json/CHANGELOG changes, per WP rules.
