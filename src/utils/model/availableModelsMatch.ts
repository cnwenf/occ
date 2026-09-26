/**
 * CC 2.1.283 — `availableModelsMatch` managed-setting entry classification and
 * exact-match semantics (pure).
 *
 * Byte-verified against the official v2.1.283 linux-x64 ELF:
 *   - `FUt` (classifyAvailableModelsEntry) @196740264
 *   - `Wh`  (entryTrailerOfSpelling)        follows FUt
 *   - `X1r` (isLatestSpellingEntry)        follows Wh
 *   - `T$o` (entryMatchesDescriptorExact)  ~@196741100
 *   - `ql`  (exactMatchEntryWarning)       ~@196741509
 *   - `Yh`  (literalAllowEntryWarning)     follows ql (~@196741900)
 *   - `PO`  (prefixEntryAllowsModelExact)  @198791100 region (enforcement chunk)
 *
 * Semantics (official describe @196611997): "prefix" (default) lets an entry
 * allow any model ID that extends it; "exact" keeps that matching but stops a
 * model-ID entry from allowing OTHER VERSIONS — "claude-opus-5" allows Opus 5
 * and its dated/-fast IDs but not Opus 5.5, and a `-latest` ID needs a
 * `-latest` entry. Family aliases still allow the whole family;
 * release-dependent aliases (best/opusplan/default) are ignored.
 */

import { isModelAlias, isModelFamilyAlias } from './aliases.js'
import {
  capitalizeFirst,
  familyNarrowedByEntries,
  isSameDescriptorVersion,
  latestCanonicalModelForFamily,
  parseModelDescriptor,
  strip1mSuffix,
  truncateModelNameForMessage,
  type ModelDescriptor,
} from './modelDescriptors.js'

/** Official `FUt` result shapes. */
export type AvailableModelsEntryClassification =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'family'; readonly family: string }
  | {
      readonly kind: 'model'
      readonly id: ModelDescriptor
      readonly latest: boolean
      readonly spelling: string
    }
  | { readonly kind: 'literal'; readonly value: string }

/**
 * Official `FUt` (@196740264): classify one `availableModels` entry.
 * "ignored" entries (empty, release-dependent aliases, `claude-`-prefixed
 * family aliases resolve to family) are dropped from the effective allowlist
 * under exact matching.
 */
export function classifyAvailableModelsEntry(
  rawEntry: string,
): AvailableModelsEntryClassification {
  const normalized = strip1mSuffix(rawEntry.trim().toLowerCase())
  if (normalized === '') return { kind: 'ignored' }
  if (isModelFamilyAlias(normalized)) return { kind: 'family', family: normalized }
  const withoutPrefix = normalized.startsWith('claude-') ? normalized.slice(7) : ''
  if (isModelFamilyAlias(withoutPrefix)) {
    return { kind: 'family', family: withoutPrefix }
  }
  if (isModelAlias(normalized) || normalized === 'default') {
    return { kind: 'ignored' }
  }
  const spelling =
    parseModelDescriptor(normalized) !== null || normalized.startsWith('claude-')
      ? normalized
      : `claude-${normalized}`
  const descriptor = parseModelDescriptor(spelling)
  return descriptor !== null
    ? {
        kind: 'model',
        id: descriptor,
        latest: isLatestSpellingEntry(spelling, descriptor),
        spelling,
      }
    : { kind: 'literal', value: normalized }
}

/** Official `Wh`: trailer text of one spelling relative to its descriptor base. */
export function entryTrailerOfSpelling(
  spelling: string,
  descriptor: ModelDescriptor,
): string {
  const lowered = spelling.toLowerCase()
  const idx = lowered.lastIndexOf(descriptor.base)
  return idx === -1 ? '' : lowered.slice(idx + descriptor.base.length)
}

/** Official `X1r`: entry is a bare base whose spelling continues with `-latest`. */
export function isLatestSpellingEntry(
  spelling: string,
  descriptor: ModelDescriptor,
): boolean {
  return (
    descriptor.trailer === undefined &&
    entryTrailerOfSpelling(spelling, descriptor).startsWith('-latest')
  )
}

/**
 * Official `T$o` (~@196741100): exact-match between an allowlist model entry
 * and a target descriptor — same version, identical trailer text, and a
 * `-latest` target only when the entry itself is a `-latest` spelling.
 */
export function entryMatchesDescriptorExact(
  entry: Extract<
    AvailableModelsEntryClassification,
    { readonly kind: 'model' }
  >,
  target: ModelDescriptor,
  targetIsLatest: boolean,
): boolean {
  return (
    isSameDescriptorVersion(entry.id, target) &&
    (entry.id.trailer ?? '') === (target.trailer ?? '') &&
    (!targetIsLatest || entry.latest)
  )
}

/**
 * Official `PO` (@198791100 region): under exact matching, whether a
 * prefix-style allowlist entry still allows a resolved model string. Family
 * entries always allow; model entries allow only the same version with a
 * compatible trailer; literal/ignored entries never allow via prefix match.
 *
 * `resolveAliasEnvFree` mirrors the official `ss`/`ALr` (@198820372,
 * resolveModelAliasEnvFree) — see modelGovernance.ts for the OCC stub; when it
 * yields null the official falls back to the raw string (`ss(e)??e`).
 */
export function prefixEntryAllowsModelExact(
  model: string,
  entry: string,
  resolveAlias: (value: string) => string,
  resolveAliasEnvFree: (value: string) => string | null,
  envFreeAliasResolution?: boolean,
): boolean {
  const classification = classifyAvailableModelsEntry(entry)
  if (classification.kind === 'family') return true
  if (classification.kind !== 'model') return false
  const resolved = isAliasLike(model)
    ? envFreeAliasResolution
      ? (resolveAliasEnvFree(model) ?? model)
      : strip1mSuffix(resolveAlias(model).toLowerCase())
    : model
  const descriptor = parseModelDescriptor(resolved)
  return (
    descriptor !== null &&
    entryMatchesDescriptorExact(
      classification,
      descriptor,
      isLatestSpellingEntry(resolved, descriptor),
    )
  )
}

/**
 * Official `dn` minus the picker-alias half (`QLt` @198800308 reads the model
 * picker's alias registry `Pu`, which OCC has no equivalent of — structural
 * stub: picker aliases never occur, matching OCC's fixed MODEL_ALIASES set).
 */
function isAliasLike(model: string): boolean {
  return isModelAlias(model)
}

/**
 * Official `ql` (~@196741509): warning for one availableModels entry when
 * `availableModelsMatch` is "exact". Undefined = no warning (model entries and
 * narrowed family aliases are fine).
 */
export function exactMatchEntryWarning(
  rawEntry: string,
  allEntries: readonly string[],
): string | undefined {
  const classification = classifyAvailableModelsEntry(rawEntry)
  switch (classification.kind) {
    case 'ignored': {
      if (rawEntry.trim() === '') {
        return 'An empty availableModels entry was ignored.'
      }
      const opusExample = latestCanonicalModelForFamily('opus')
      return `"${truncateModelNameForMessage(rawEntry)}" in availableModels was ignored, because "availableModelsMatch" is "exact" and this name means a different model depending on the release and settings. List the model IDs you want to allow instead${opusExample === undefined ? '' : `, for example "${opusExample}"`}.`
    }
    case 'family': {
      const effectiveEntries = allEntries
        .filter(entry => classifyAvailableModelsEntry(entry).kind !== 'ignored')
        .map(entry => strip1mSuffix(entry.trim().toLowerCase()))
      if (
        isModelFamilyAlias(rawEntry.trim().toLowerCase()) &&
        familyNarrowedByEntries(classification.family, effectiveEntries)
      ) {
        return undefined
      }
      const familyExample = latestCanonicalModelForFamily(classification.family)
      return `"${truncateModelNameForMessage(rawEntry)}" in availableModels allows every ${capitalizeFirst(classification.family)} model, including future releases, even though "availableModelsMatch" is "exact". To allow only some versions, list their model IDs instead${familyExample === undefined ? '' : `, for example "${familyExample}"`}.`
    }
    case 'model':
      return undefined
    case 'literal':
      return literalAllowEntryWarning(rawEntry, classification.value)
  }
}

/**
 * Official `Yh` (~@196741900): warning for a literal (exact-name-only)
 * availableModels entry, with a fix hint for version-like or family-prose
 * spellings.
 */
export function literalAllowEntryWarning(
  rawEntry: string,
  normalized: string,
): string | undefined {
  const base = `"${truncateModelNameForMessage(rawEntry)}" in availableModels allows only a model named exactly "${truncateModelNameForMessage(normalized)}".`
  const hyphenated = normalized.replace(/(\d)\.(\d)/g, '$1-$2')
  if (hyphenated !== normalized) {
    const candidate = hyphenated.startsWith('claude-')
      ? hyphenated
      : `claude-${hyphenated}`
    if (parseModelDescriptor(candidate) !== null) {
      return `${base} To allow a version, write it with a hyphen: "${truncateModelNameForMessage(candidate)}".`
    }
  }
  const familyProse = /^(sonnet|opus|haiku|fable)\s+(\d+)(?:\.(\d+))?$/.exec(normalized)
  if (familyProse) {
    const [, family, major, minor] = familyProse
    return `${base} To allow a version, write its model ID, for example "claude-${family}-${major}${minor !== undefined ? `-${minor}` : ''}".`
  }
  return undefined
}
