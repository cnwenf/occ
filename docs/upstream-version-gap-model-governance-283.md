# Upstream gap: CC 2.1.283 managed model governance (`availableModelsMatch` + `deniedModels`)

Round: OCC catch-up to official Claude Code **2.1.283** (v282 baseline: 0 occurrences of both keys; v283: 22 `availableModelsMatch` / 58 `deniedModels`).
Source of truth: official v2.1.283 linux-x64 ELF (`workdir/forensics/v283/claude`, byte forensics only — never executed). Baseline comparison: `../v282/claude`.

## 1. Byte-verified official surfaces

| Official (minified) | Offset | Role |
|---|---|---|
| `Vr` | @198792435 | The allow oracle (`isModelAllowed`): denied prologue (`qhe` catch→block), entitlement overlay branch, allowlist normalization (`Jt`), exact-mode ignored-entry filter (`xO`+`FUt`), exact alias-step gate (`p_`), override resolution (`d_`/`he("policySettings")`/`$Lt`), family narrowing (`M5n`), literal/alias/prefix tiers (`CO`+`PO` under exact) |
| `qhe` | (in `Vr` prologue region) | `isModelDeniedByPolicy` — parses `policySettings.deniedModels` via `TO`, matches via `OO`, catch→**false** inside `Vr` (blocks, fail-closed) |
| `Iqn` | — | `hasDeniedModelsPolicy` — catch→**true** (fail-closed) |
| `H5n` | @196738112 | `parseDeniedModelEntry` — model/family/literal/ignored classification; NO claude-prefixed family retry (asymmetric vs `FUt`); normalized trailers (`-fast`/dates) fold into the descriptor → warning notes the ignored trailer |
| `TO` / `OO` / `E$o` | @196740030 (`E$o`) | deny-entry list parse / match / descriptor-blocks-model (minor-exact; no-minor blocks later minors; trailer-undefined blocks all; unnormalized trailer + `-` extensions) |
| `$h` | @196738974 | denied-descriptor prose ("every Opus 5.x model" / "Opus 5.5 in every spelling and snapshot") |
| `Bh` | — | literal deny-entry warning + hints (hyphen / model-ID / DL-1 typo family / family-list fallback) |
| `dr` | @198788643 | family-name boundary scan in provider spellings (ANY occurrence boundary-clean matches; `opusplan` does not match `opus`) |
| `FUt` | @196740264 | `classifyAvailableModelsEntry` — family/model(+latest flag)/literal/ignored; claude- prefix retry; `[1m]` strip |
| `T$o` | @196741164 | `entryMatchesDescriptorExact` — same version + identical unnormalized trailer (+ latest gate) |
| `PO` | — | `prefixEntryAllowsModelExact` — exact-tier prefix check with injected alias resolvers |
| `ql` | @196741614 | `exactMatchEntryWarning` — per-entry warnings under exact |
| `Yh` | @196742485 | `literalAllowEntryWarning` — ends with bare `return`: plain literals under exact are SILENT (unlike `Bh`) |
| `xO` / `p_` / `d_` / `f_` | — | exact-mode read / alias step / override-map resolve / descriptor-for-governance (catch→null) |
| `M5n` / `Jl` | — | family narrowed by other entries / latest canonical for family |
| `__` / `h_` | — | `isBlockedByExactAvailableModels` / `isModelBlockedByGovernance` (= denied OR exact-blocked) |
| `TH` | @198791411 | block-message builder; catch branch: null at start, retry message on switch |
| `TH` call site | @212235442 | startup gate: `Bn=TH(je)` → print + `Az({reason:"managed_settings_invalid"})` + exit |
| `z5n` / `V5n` / `Xi` | @196788635 / @196788836 / @197184017 | deny warnings / exact allow warnings / merged collector ("Managed settings notices") |
| `Ko` deniedModels wrapper | @196677430 region | strict-policy parse: per-entry non-string drop (type-based message); whole-field catch→**undefined** = field-level fail-OPEN ("blocks no models until it is fixed") |
| `Qe` lock entry | @196433200–196436000 | `availableModelsMatch` restrictive substitution → `"exact"` |
| base schema describes | @196611500–196613800 | verbatim `.describe()` texts for both keys |
| `xy` / `dgn` / `Ad` | @196774265 region | managed-only key strip (+`Gye` non-policy file call site, `Dy` SDK-inline @~196776900) |
| `we` / `ub` | @196737933 / @198783953 | message sanitizers (control-char → `?`, 128 cap / charset strip) |

## 2. OCC implementation map

New modules (dependency order): `src/utils/model/modelDescriptors.ts` (pure catalog+grammar: `Tf`/`Jt`/`Mn`/`N3n`/`GYe`/`M5n`/`Jl`/`we`/`ub`/`Vh`/`Kh`/`_6`) ← `deniedModels.ts` (`H5n`/`$h`/`Bh`/`E$o`/`OO`/`dr`) + `availableModelsMatch.ts` (`FUt`/`T$o`/`PO`/`ql`/`Yh`, resolvers injected) ← `modelGovernance.ts` (`qhe`/`Iqn`/`xO`/`p_`/`d_`/`f_`/`m_`, reads `getSettingsForSource('policySettings')`) ← `modelAllowlist.ts` (extended `isModelAllowed` = `Vr` tier order) ← `modelGovernanceMessages.ts` (`__`/`h_`/`TH`). `modelGovernanceWarnings.ts` (`z5n`/`V5n`/`Xi`, parameterized by policy object — no settings import, cycle-free). `src/utils/settings/managedOnlyKeys.ts` (`Ad`/`xy` subset).

Edits: `settings/types.ts` (both keys + verbatim describes), `settings/policyLocks.ts` (`availableModelsMatch`→`exact` restrictive entry), `settings/policyStrictSchema.ts` (`deniedModels` Ko wrapper), `settings/settings.ts` (strip on non-policy file + SDK-inline sources; policy-branch governance warnings), `model/modelAllowlist.ts` (Vr port).

Tests (4 new files, 99 tests): `deniedModels283`, `availableModelsMatch283`, `modelGovernance283`, `managedOnlyKeys283`.

## 3. Key decisions & documented deviations

1. **Field-level fail-open for malformed `deniedModels`** (official `Ko`: catch→undefined, "blocks no models until it is fixed") vs **fail-closed enforcement** on unreadable settings (`Iqn` catch→true, `Vr`/`xO`/`f_` catches→block). Both are official behaviors, ported as-is.
2. Warnings routed through OCC's `policyErrors` ValidationError channel — OCC has no separate "Managed settings notices" surface (`Xi` output merged at load).
3. `Ad` strip is an OCC 2-key subset (`deniedModels`, `availableModelsMatch`); OCC schema has no `managedMcpServers`/`isolation`. Immutable return (official deletes in-place on a clone); `preserveOnWrite` omitted (no consuming rewrite path).
4. `TH` startup-exit gate — **wired at OCC-98 acceptance #10, `$i` flush leg added in the P3 round** (call site re-extracted @212235442: `Bn=TH(je);if(Bn!==null)return hx(Bn),await Az({…reason:"managed_settings_invalid"}),$i();`). `enforceManagedModelGovernanceStartupGate` (modelGovernanceMessages.ts, async) is called from src/main.tsx on the resolved initial model: red message on stderr (`hx`), then `$i`'s analytics-flush half-leg — a capped (500ms, gracefulShutdown budget) `Promise.race([Promise.all([shutdown1PEventLogging(), shutdownDatadog()]), sleep(500)])` delivering events queued before the gate (Bun skips beforeExit flush handlers on `process.exit`) — then exit(1). Only the `Az({reason:"managed_settings_invalid"})` exit-reason EVENT leg stays **staged**: OCC's analytics surface is real and wired (`src/services/analytics/` — `initializeAnalyticsSink` routes to Datadog + 1P; `initSinks()` runs in main.tsx preAction, before the gate), so the blocker is NOT "nowhere to land" — it is that the official event name/shape was never byte-extracted and must not be invented (risk-registry RR-002). Message builder itself is byte-verbatim and wired for `start`/`switch`.
5. `xye()`/`X$`/`J$` entitlement overlay not ported (only reachable in the `allowlist===undefined` branch; no OCC entitlement surface).
6. `is(S,n)` picker-known check stubbed permissive (matches pre-existing OCC raw-alias allow behavior); `nBr()` third override map stubbed absent; `ss`/`ALr` env-free alias resolution stubbed →null. All stubs cite official minified name + offset per the `isSyncedSkillHolder` pattern.
7. **Bun mock-leak fix (OCC-97 class)**: `validateModel281.test.ts`'s top-level `isModelAllowed:()=>true` mock leaks into later-loaded files (runner may load sibling top-levels in any order; `mock.restore()` does not undo `mock.module`). Fixed at the source (explicit real-export re-registration in its `afterAll`) AND defensively in `modelGovernance283.test.ts` (query-specifier fresh import + re-register before importing modules under test).

## 4. Verification

- My 4 suites isolated: 99 pass / 0 fail (234 expects).
- `bun test src/utils/model` → 236 pass / 0 fail. `src/utils/model` + `src/utils/settings` → 477 pass / 12 fail — all 12 in `policySandbox283.test.ts`. **Mid-round snapshot — reconciled at acceptance (OCC-98)**: those 12 fails were recorded while the parallel OCC-138 P1a sandbox workstream was still in flight; `policySandbox283.test.ts` (+343 lines) IS part of the merged PR diff, not an untouched bystander. On the shipped HEAD the suite passes 14/14 (exit 0) under the same per-file isolation gate, and the authoritative post-merge rerun is fully green — see `upstream-version-gap-occ98-2026-09.md` §9.1 (6870 pass / 0 fail / 115 skip across 668 files).
- Pinned `policyStrictParse282.test.ts` regression: 34 pass / 0 fail (read-only).
- `bunx tsc --noEmit`: zero errors from this round's files (codebase-wide pre-existing errors unchanged). Biome lint clean on all touched files.

## 5. Staged follow-ups (next rounds)

- `managed_settings_invalid` exit-reason telemetry (`Az`) — the gate's print+exit(1) leg is wired (OCC-98 #10); only the telemetry leg remains (RR-002).
- `TH('switch')` picker wiring for the `/model`-switch flow (message contract already byte-ported).
- Entitlement deny overlay (`xye`/`X$`/`J$`) if/when OCC gains an entitlement surface.
- `nBr()` managed-settings-env override map (third map in `m_`), `ss`/`ALr` env-free alias resolution when picker-alias infra lands.
- Official `xy` full set (`managedMcpServers`, `isolation` + `MRe` inert-notice suppression) when those keys exist in OCC's schema.
