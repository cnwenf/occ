/**
 * CC 2.1.283 — enforcement core for the `deniedModels` and
 * `availableModelsMatch:"exact"` managed model governance.
 *
 * Byte-verified against the official v2.1.283 linux-x64 ELF (enforcement
 * cluster @198789500–198793500):
 *   - `TO`  parse every deniedModels entry (cached)   @198789550 region
 *   - `m_`  policy governance view {entries, overrideMaps}
 *   - `Iqn` "any deny entries?" — fail-CLOSED (catch → true)
 *   - `f_`  descriptor of a model after override resolution
 *   - `qhe` isModelDeniedByPolicy (the deny oracle)
 *   - `xO`  policy availableModelsMatch === "exact"    @198790811
 *   - `p_`  alias/override step for the exact gate      @198791050 region
 *
 * All enforcement reads ONLY `policySettings` (managed sources) — both
 * settings are managed-only by construction (the `Ad` strip in
 * src/utils/settings/managedOnlyKeys.ts removes them from every other source).
 *
 * Forward-compat stubs (documented pattern, cf. `isSyncedSkillHolder` in
 * src/utils/skills/reservedNames.ts):
 *   - official `nBr()` (host-managed provider override map, third entry of
 *     `m_`'s overrideMaps): OCC has no host-managed provider surface →
 *     contributes no map.
 *   - official `QLt`/`Pu` (@198800308, model-picker alias registry inside
 *     `dn`): OCC has no dynamic picker-alias registry → picker aliases never
 *     occur (see availableModelsMatch.ts isAliasLike).
 *   - official `ss`/`ALr` (@198820372, resolveModelAliasEnvFree): OCC's
 *     default-model getters are env-aware; the env-free resolver returns null
 *     (official `??e` fallback then applies). Only used on the Default-model
 *     step-down paths.
 */

import { getSettingsForSource, getSettings_DEPRECATED } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { isModelAlias } from './aliases.js'
import {
  deniedEntryMatchesModel,
  parseDeniedModelEntry,
  type DeniedModelsEntry,
} from './deniedModels.js'
import { parseUserSpecifiedModel } from './model.js'
import { resolveOverriddenModel } from './modelStrings.js'
import {
  modelIdsEqualAnyContext,
  parseModelDescriptor,
  strip1mSuffix,
  stripContextSizeTags,
  type ModelDescriptor,
} from './modelDescriptors.js'

export type ModelOverrideMap = Readonly<Record<string, string>>

export type PolicyDeniedGovernance = {
  readonly entries: readonly DeniedModelsEntry[]
  readonly overrideMaps: readonly ModelOverrideMap[]
}

const NO_DENIED_GOVERNANCE: PolicyDeniedGovernance = {
  entries: [],
  overrideMaps: [],
}

/** Official `TO`: parse every deniedModels entry, dropping ignored ones. */
export function parseDeniedModelEntries(
  deniedModels: readonly string[],
): readonly DeniedModelsEntry[] {
  return deniedModels.flatMap(rawEntry => {
    const { entry } = parseDeniedModelEntry(rawEntry)
    return entry ? [entry] : []
  })
}

// Session-level memo for the entry parse, matching the official `TO`
// "(cached)" contract (@198789550 region) — `getPolicyDeniedGovernance()` sits
// on the `isModelAllowed()` hot path (allowlist checks, family-alias candidate
// loops, ModelPicker per-row renders), so re-parsing every call was O(entries)
// per render/judgment. Keyed on the RAW array identity: a settings reload
// produces a fresh policySettings object (new array reference) → automatic
// miss → re-parse; same array ⇒ same parse result, so the memo can never go
// stale within a session. (OCC-98 acceptance finding #5 / dataflow d111.)
let deniedEntriesMemo: {
  readonly source: readonly string[]
  readonly entries: readonly DeniedModelsEntry[]
} | null = null

function parseDeniedModelEntriesCached(
  deniedModels: readonly string[],
): readonly DeniedModelsEntry[] {
  if (deniedEntriesMemo !== null && deniedEntriesMemo.source === deniedModels) {
    return deniedEntriesMemo.entries
  }
  const entries = parseDeniedModelEntries(deniedModels)
  deniedEntriesMemo = { source: deniedModels, entries }
  return entries
}

/** Test/reset hook for the parse memo (identity-keyed; see above). */
export function resetDeniedEntriesMemoForTest(): void {
  deniedEntriesMemo = null
}

/**
 * Official `m_`: the governance view of the winning policy source — parsed
 * deny entries plus the override maps used to resolve provider spellings
 * (policy `modelOverrides`, then the merged-settings map ≡ official `une()`/
 * `ys()`; the official third map `nBr()` is stubbed absent — see header).
 * Entry parse is session-cached (official `TO` "cached"; see memo above).
 */
export function getPolicyDeniedGovernance(): PolicyDeniedGovernance {
  const policy = getSettingsForSource('policySettings') as SettingsJson | null
  const deniedModels = policy?.deniedModels
  if (deniedModels === undefined || deniedModels.length === 0) {
    return NO_DENIED_GOVERNANCE
  }
  const mergedOverrides = getMergedModelOverrides()
  const overrideMaps = [
    ...(policy?.modelOverrides !== undefined ? [policy.modelOverrides] : []),
    ...(mergedOverrides !== undefined ? [mergedOverrides] : []),
  ]
  return { entries: parseDeniedModelEntriesCached(deniedModels), overrideMaps }
}

function getMergedModelOverrides(): ModelOverrideMap | undefined {
  // Official `ys(){try{return Je().modelOverrides}catch{}}` — the MERGED
  // settings map (OCC `Je()` ≡ getSettings_DEPRECATED).
  try {
    return getSettings_DEPRECATED()?.modelOverrides
  } catch {
    return undefined
  }
}

/**
 * Official `Iqn`: whether the policy has any effective deny entries.
 * Fail-CLOSED: a settings-read error means "assume something is denied"
 * (the official catch returns true; callers then surface the managed-settings
 * failure instead of silently allowing).
 */
export function hasDeniedModelsPolicy(): boolean {
  try {
    return getPolicyDeniedGovernance().entries.length > 0
  } catch {
    return true
  }
}

/** Official `d_`: resolve a provider spelling back through one override map. */
export function resolveWithOverrideMap(
  model: string,
  overridesMap: ModelOverrideMap,
): string {
  for (const [canonicalId, override] of Object.entries(overridesMap)) {
    if (modelIdsEqualAnyContext(override, model)) return canonicalId
  }
  return model
}

/**
 * Official `f_`: descriptor of a model after override resolution — with the
 * merged overrides (official `Be(e,{identity:!0})` ≡ OCC
 * resolveOverriddenModel) or one explicit map. Never throws (catch → null).
 */
export function resolveDescriptorForGovernance(
  model: string,
  overridesMap?: ModelOverrideMap,
): ModelDescriptor | null {
  try {
    const resolved =
      overridesMap === undefined
        ? resolveOverriddenModel(model)
        : resolveWithOverrideMap(model, overridesMap)
    return parseModelDescriptor(resolved)
  } catch {
    return null
  }
}

/**
 * Official `qhe` (@198790400 region): THE deny oracle. A model is denied when
 * any parsed entry matches any of its spellings — the raw spelling, the
 * display-alias resolution, and (for provider spellings that are override
 * VALUES) the override-resolved canonical key.
 */
export function isModelDeniedByPolicy(model: string): boolean {
  const { entries, overrideMaps } = getPolicyDeniedGovernance()
  if (entries.length === 0) return false
  const rawStripped = stripContextSizeTags(model.trim())
  const displayResolved = stripContextSizeTags(
    parseUserSpecifiedModel(rawStripped).trim(),
  )
  const candidates = new Set([
    rawStripped.toLowerCase(),
    displayResolved.toLowerCase(),
  ])
  // Provider spellings: an override VALUE that equals a candidate pulls its
  // canonical KEY into the candidate set (official loop over overrideMaps).
  for (const overridesMap of overrideMaps) {
    for (const [canonicalId, override] of Object.entries(overridesMap)) {
      if (
        parseModelDescriptor(override) === null &&
        [...candidates].some(candidate =>
          modelIdsEqualAnyContext(override, candidate),
        )
      ) {
        candidates.add(strip1mSuffix(canonicalId.trim().toLowerCase()))
      }
    }
  }
  const mergedMap: ModelOverrideMap = Object.assign({}, ...overrideMaps)
  const matchesAny = (
    normalizedModel: string,
    descriptor: ModelDescriptor | null,
  ): boolean =>
    entries.some(entry =>
      deniedEntryMatchesModel(entry, normalizedModel, descriptor),
    )
  const matchesWithOverrides = (
    spelling: string,
    normalizedModel: string,
  ): boolean =>
    matchesAny(
      normalizedModel,
      resolveDescriptorForGovernance(spelling),
    ) ||
    matchesAny(
      normalizedModel,
      resolveDescriptorForGovernance(spelling, mergedMap),
    )
  for (const candidate of candidates) {
    const descriptor = parseModelDescriptor(candidate)
    if (
      descriptor !== null
        ? matchesAny(candidate, descriptor)
        : matchesAny(candidate, null) ||
          matchesWithOverrides(candidate, candidate)
    ) {
      return true
    }
  }
  for (const spelling of new Set([rawStripped, displayResolved])) {
    const lowered = spelling.toLowerCase()
    if (parseModelDescriptor(lowered) === null && matchesWithOverrides(spelling, lowered)) {
      return true
    }
  }
  return false
}

/** Official `xO` (@198790811): policy requests exact availableModels matching. */
export function isExactAvailableModelsMatch(): boolean {
  const policy = getSettingsForSource('policySettings') as SettingsJson | null
  return policy?.availableModelsMatch === 'exact'
}

/**
 * Official `p_` (@198791050 region): under exact matching, a NON-alias input
 * that the display resolver maps to a different name (legacy remap, override
 * spelling) must have its resolved target allowed too. Null = no step.
 * `envFreeAliasResolution` uses the stubbed env-free resolver (see header).
 */
export function stepAliasForExactMatch(
  normalizedModel: string,
  envFreeAliasResolution?: boolean,
): string | null {
  if (isModelAlias(normalizedModel)) return null
  const resolved = envFreeAliasResolution
    ? resolveModelAliasEnvFreeStub(normalizedModel)
    : parseUserSpecifiedModel(normalizedModel).trim().toLowerCase()
  if (resolved === null) return null
  const stripped = strip1mSuffix(resolved)
  return stripped === normalizedModel ? null : stripped
}

/**
 * Official `ss`/`ALr` (@198820372, resolveModelAliasEnvFree) — STRUCTURAL
 * STUB: OCC's default-model getters are env-aware and OCC has no env-free
 * builtin-default table keyed by alias, so this returns null; the official
 * `??e` / `!==null` guards then take the raw-string fallback exactly as when
 * the official resolver finds no alias.
 */
export function resolveModelAliasEnvFreeStub(
  _model: string,
): string | null {
  return null
}

/**
 * Official `dn` (alias check incl. the picker-alias half `QLt`, stubbed —
 * see header): exported for the allowlist exact-gate wiring.
 */
export function isGovernanceAlias(model: string): boolean {
  return isModelAlias(model)
}
