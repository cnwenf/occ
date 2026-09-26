import { getSettings_DEPRECATED, getSettingsForSource } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { isModelAlias, isModelFamilyAlias } from './aliases.js'
import {
  classifyAvailableModelsEntry,
  prefixEntryAllowsModelExact,
} from './availableModelsMatch.js'
import { parseUserSpecifiedModel } from './model.js'
import { resolveOverriddenModel } from './modelStrings.js'
import { strip1mSuffix } from './modelDescriptors.js'
import {
  isExactAvailableModelsMatch,
  isModelDeniedByPolicy,
  resolveModelAliasEnvFreeStub,
  resolveWithOverrideMap,
  stepAliasForExactMatch,
} from './modelGovernance.js'

/**
 * Check if a model belongs to a given family by checking if its name
 * (or resolved name) contains the family identifier.
 */
function modelBelongsToFamily(model: string, family: string): boolean {
  if (model.includes(family)) {
    return true
  }
  // Resolve aliases like "best" → "claude-opus-4-6" to check family membership
  if (isModelAlias(model)) {
    const resolved = parseUserSpecifiedModel(model).toLowerCase()
    return resolved.includes(family)
  }
  return false
}

/**
 * Check if a model name starts with a prefix at a segment boundary.
 * The prefix must match up to the end of the name or a "-" separator.
 * e.g. "claude-opus-4-5" matches "claude-opus-4-5-20251101" but not "claude-opus-4-50".
 */
function prefixMatchesModel(modelName: string, prefix: string): boolean {
  if (!modelName.startsWith(prefix)) {
    return false
  }
  return modelName.length === prefix.length || modelName[prefix.length] === '-'
}

/**
 * Check if a model matches a version-prefix entry in the allowlist.
 * Supports shorthand like "opus-4-5" (mapped to "claude-opus-4-5") and
 * full prefixes like "claude-opus-4-5". Resolves input aliases before matching.
 */
function modelMatchesVersionPrefix(model: string, entry: string): boolean {
  // Resolve the input model to a full name if it's an alias
  const resolvedModel = isModelAlias(model)
    ? parseUserSpecifiedModel(model).toLowerCase()
    : model

  // Try the entry as-is (e.g. "claude-opus-4-5")
  if (prefixMatchesModel(resolvedModel, entry)) {
    return true
  }
  // Try with "claude-" prefix (e.g. "opus-4-5" → "claude-opus-4-5")
  if (
    !entry.startsWith('claude-') &&
    prefixMatchesModel(resolvedModel, `claude-${entry}`)
  ) {
    return true
  }
  return false
}

/**
 * Check if a family alias is narrowed by more specific entries in the allowlist.
 * When the allowlist contains both "opus" and "opus-4-5", the specific entry
 * takes precedence — "opus" alone would be a wildcard, but "opus-4-5" narrows
 * it to only that version.
 */
function familyHasSpecificEntries(
  family: string,
  allowlist: string[],
): boolean {
  for (const entry of allowlist) {
    if (isModelFamilyAlias(entry)) {
      continue
    }
    // Check if entry is a version-qualified variant of this family
    // e.g., "opus-4-5" or "claude-opus-4-5-20251101" for the "opus" family
    // Must match at a segment boundary (followed by '-' or end) to avoid
    // false positives like "opusplan" matching "opus"
    const idx = entry.indexOf(family)
    if (idx === -1) {
      continue
    }
    const afterFamily = idx + family.length
    if (afterFamily === entry.length || entry[afterFamily] === '-') {
      return true
    }
  }
  return false
}

/**
 * CC 2.1.283: official `Vr` options subset. `allowlist` overrides the merged
 * settings' availableModels (the official `__` exact-block check calls
 * `Vr(e,{allowlist:[...]})` with the POLICY allowlist). The official also has
 * `skipEntitlementDenyOverlay`/`envFreeAliasResolution`/`overridesMap`/
 * `ignoreModelOverrides` — OCC has no entitlement-deny overlay (`X$`/`J$`) or
 * env-free alias resolution (`ALr`, stubbed in modelGovernance.ts), so those
 * options are not surfaced.
 */
export type ModelAllowlistOptions = {
  readonly allowlist?: readonly string[]
}

/**
 * Official `Vr`'s override-resolution branch (`E`): when the policy has an
 * availableModels list, the model spelling is resolved back through the policy
 * `modelOverrides` (falling back to the merged map); otherwise through the
 * merged overrides. Null = the policy read failed (official catch → block).
 */
function resolveModelForAllowlist(model: string): string | null {
  try {
    const policy = getSettingsForSource('policySettings') as SettingsJson | null
    if (policy?.availableModels !== undefined) {
      const overridesMap =
        policy.modelOverrides ?? getSettings_DEPRECATED()?.modelOverrides ?? {}
      return resolveWithOverrideMap(model, overridesMap)
    }
  } catch {
    return null
  }
  return resolveOverriddenModel(model)
}

/**
 * Check if a model is allowed by the availableModels allowlist in settings.
 * If availableModels is not set, all models are allowed.
 *
 * CC 2.1.283 (official `Vr` @198792435): a `deniedModels` policy gate runs
 * FIRST (fail-closed — a governance read error blocks), and under
 * `availableModelsMatch:"exact"` "ignored" entries drop out of the effective
 * allowlist (empty-after-filter blocks everything), non-alias inputs whose
 * display resolution differs must have the resolved target allowed too, and
 * version-prefix matches additionally require exact-descriptor agreement.
 *
 * Matching tiers:
 * 1. Family aliases ("opus", "sonnet", "haiku") — wildcard for the entire family,
 *    UNLESS more specific entries for that family also exist (e.g., "opus-4-5").
 *    In that case, the family wildcard is ignored and only the specific entries apply.
 * 2. Version prefixes ("opus-4-5", "claude-opus-4-5") — any build of that version
 * 3. Full model IDs ("claude-opus-4-5-20251101") — exact match only
 */
export function isModelAllowed(
  model: string,
  options?: ModelAllowlistOptions,
): boolean {
  // Official `Vr` prologue: deniedModels beats every allow tier; a governance
  // read failure blocks (catch → false).
  try {
    if (isModelDeniedByPolicy(model)) {
      return false
    }
  } catch {
    return false
  }

  const settings = getSettings_DEPRECATED() || {}
  const availableModels = options?.allowlist ?? settings.availableModels
  if (!availableModels) {
    return true // No restrictions
  }
  if (availableModels.length === 0) {
    return false // Empty allowlist blocks all user-specified models
  }

  // Official `g=xO()` with catch → block: an unreadable governance flag is
  // treated as "not allowed" rather than silently falling back to prefix mode.
  let exactMatch: boolean
  try {
    exactMatch = isExactAvailableModelsMatch()
  } catch {
    return false
  }

  // Official `h`: under exact matching, ignored entries (empty, release-
  // dependent aliases) drop out; an empty effective list blocks everything.
  const effectiveEntries = exactMatch
    ? availableModels.filter(
        entry => classifyAvailableModelsEntry(entry).kind !== 'ignored',
      )
    : availableModels
  const normalizedAllowlist = effectiveEntries.map(m =>
    strip1mSuffix(m.trim().toLowerCase()),
  )
  if (normalizedAllowlist.length === 0) {
    return false
  }

  // Official raw-spelling direct tier (`h.includes(S)&&!O_(S)`): the input as
  // written is listed, so it is allowed regardless of override resolution.
  const rawNormalized = strip1mSuffix(model.trim().toLowerCase())
  if (
    normalizedAllowlist.includes(rawNormalized) &&
    !isModelFamilyAlias(rawNormalized)
  ) {
    return true
  }

  // Official exact-mode alias/override step gate (`p_`): a non-alias input
  // whose display resolution differs (legacy remap, override spelling) must
  // have the RESOLVED target allowed too — recursively.
  if (exactMatch) {
    const stepped = stepAliasForExactMatch(rawNormalized)
    if (
      stepped !== null &&
      (stepAliasForExactMatch(stepped) !== null ||
        !isModelAllowed(stepped, options))
    ) {
      return false
    }
  }

  const resolvedModel = resolveModelForAllowlist(model)
  if (resolvedModel === null) {
    return false // Policy read failed — official catch → block.
  }
  const normalizedModel = strip1mSuffix(resolvedModel.trim().toLowerCase())

  // Direct match (alias-to-alias or full-name-to-full-name)
  // Skip family aliases that have been narrowed by specific entries —
  // e.g., "opus" in ["opus", "opus-4-5"] should NOT directly match,
  // because the admin intends to restrict to opus 4.5 only.
  if (normalizedAllowlist.includes(normalizedModel)) {
    if (
      !isModelFamilyAlias(normalizedModel) ||
      !familyHasSpecificEntries(normalizedModel, normalizedAllowlist)
    ) {
      return true
    }
  }

  // Family-level aliases in the allowlist match any model in that family,
  // but only if no more specific entries exist for that family.
  // e.g., ["opus"] allows all opus, but ["opus", "opus-4-5"] only allows opus 4.5.
  for (const entry of normalizedAllowlist) {
    if (
      isModelFamilyAlias(entry) &&
      !familyHasSpecificEntries(entry, normalizedAllowlist) &&
      modelBelongsToFamily(normalizedModel, entry)
    ) {
      return true
    }
  }

  // For non-family entries, do bidirectional alias resolution
  // If model is an alias, resolve it and check if the resolved name is in the list
  if (isModelAlias(normalizedModel)) {
    const resolved = parseUserSpecifiedModel(normalizedModel).toLowerCase()
    if (normalizedAllowlist.includes(strip1mSuffix(resolved))) {
      return true
    }
  }

  // If any non-family alias in the allowlist resolves to the input model
  for (const entry of normalizedAllowlist) {
    if (!isModelFamilyAlias(entry) && isModelAlias(entry)) {
      const resolved = parseUserSpecifiedModel(entry).toLowerCase()
      if (strip1mSuffix(resolved) === normalizedModel) {
        return true
      }
    }
  }

  // Version-prefix matching: "opus-4-5" or "claude-opus-4-5" matches
  // "claude-opus-4-5-20251101" at a segment boundary. Under exact matching the
  // official adds the `PO` gate: the prefix hit only counts when the entry and
  // the model are the SAME version with a compatible trailer (a `-latest`
  // model needs a `-latest` entry; family entries always pass).
  for (const entry of normalizedAllowlist) {
    if (!isModelFamilyAlias(entry) && !isModelAlias(entry)) {
      if (
        modelMatchesVersionPrefix(normalizedModel, entry) &&
        (!exactMatch ||
          prefixEntryAllowsModelExact(
            normalizedModel,
            entry,
            parseUserSpecifiedModel,
            resolveModelAliasEnvFreeStub,
          ))
      ) {
        return true
      }
    }
  }

  return false
}
