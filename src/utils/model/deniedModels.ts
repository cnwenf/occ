/**
 * CC 2.1.283 — `deniedModels` managed-setting entry parsing (pure).
 *
 * Byte-verified against the official v2.1.283 linux-x64 ELF:
 *   - `H5n` (parseDeniedModelEntry)      @196738121
 *   - `$h`  (describeDeniedDescriptor)   @196738974
 *   - `Bh`  (literalDeniedEntryWarning)  follows `$h` (~@196739150)
 *   - `E$o` (deniedDescriptorBlocksModel) follows `Bh` (~@196740100)
 *
 * Entry kinds (official): a bare family alias blocks the whole family; a
 * recognizable model ID blocks that version in every spelling (dates, `-fast`
 * and provider prefixes ignored); an ID without a minor also blocks later
 * minors; release-dependent aliases (best/opusplan/default) are IGNORED with a
 * warning; anything else blocks only the exact literal name.
 */

import { isModelAlias, isModelFamilyAlias } from './aliases.js'
import {
  capitalizeFirst,
  damerauLevenshteinDistance,
  familyListForMessage,
  parseModelDescriptor,
  stripContextSizeTags,
  truncateModelNameForMessage,
  type ModelDescriptor,
} from './modelDescriptors.js'

/** A parsed `deniedModels` entry (official `H5n` result `entry` shapes). */
export type DeniedModelsEntry =
  | { readonly kind: 'family'; readonly family: string }
  | { readonly kind: 'model'; readonly id: ModelDescriptor }
  | { readonly kind: 'literal'; readonly value: string }

export type DeniedEntryParseResult = {
  /** null when the entry was ignored (empty or release-dependent alias). */
  readonly entry: DeniedModelsEntry | null
  readonly warning?: string
}

/**
 * Official `H5n` (@196738121): parse one `deniedModels` entry into a blocking
 * rule plus an optional admin-facing warning. Never throws.
 */
export function parseDeniedModelEntry(rawEntry: string): DeniedEntryParseResult {
  const lowered = rawEntry.trim().toLowerCase()
  const stripped = stripContextSizeTags(lowered).trim()
  const contextNote =
    stripped !== lowered
      ? ' Context-size tags such as [1m] are ignored: the entry blocks the model at every context size.'
      : ''
  if (stripped === '') {
    return { entry: null, warning: 'An empty deniedModels entry was ignored.' }
  }
  if (isModelFamilyAlias(stripped)) {
    return {
      entry: { kind: 'family', family: stripped },
      ...(contextNote !== '' && {
        warning: `"${truncateModelNameForMessage(rawEntry)}" blocks every ${capitalizeFirst(stripped)} model.${contextNote}`,
      }),
    }
  }
  if (isModelAlias(stripped) || stripped === 'default') {
    return {
      entry: null,
      warning: `"${truncateModelNameForMessage(rawEntry)}" was ignored: it names a different model depending on the release and settings. Name the model instead, for example "claude-opus-5-5".`,
    }
  }
  const directDescriptor = parseModelDescriptor(stripped)
  const claudePrefixed =
    directDescriptor !== null || stripped.startsWith('claude-')
      ? stripped
      : `claude-${stripped}`
  const descriptor =
    directDescriptor ??
    (claudePrefixed !== stripped ? parseModelDescriptor(claudePrefixed) : null)
  if (descriptor) {
    const baseIdx = claudePrefixed.lastIndexOf(descriptor.base)
    const trailing = baseIdx === -1 ? '' : claudePrefixed.slice(baseIdx + descriptor.base.length)
    const ignoredTrailerNote =
      descriptor.trailer === undefined && trailing !== ''
        ? ` "${truncateModelNameForMessage(trailing)}" is ignored.`
        : ''
    return {
      entry: { kind: 'model', id: descriptor },
      ...(contextNote !== '' || ignoredTrailerNote !== '' ? {
        warning: `"${truncateModelNameForMessage(rawEntry)}" blocks ${describeDeniedDescriptor(descriptor)}.${ignoredTrailerNote}${contextNote}`,
      } : {}),
    }
  }
  return {
    entry: { kind: 'literal', value: stripped },
    warning: literalDeniedEntryWarning(rawEntry, stripped),
  }
}

/**
 * Official `$h` (@196738974): what a model-descriptor deny rule blocks, in
 * prose ("every Opus 5.x model" / "Opus 5.5 in every spelling and snapshot").
 */
export function describeDeniedDescriptor(descriptor: ModelDescriptor): string {
  const family = capitalizeFirst(descriptor.family)
  return descriptor.minor === undefined
    ? `every ${family} ${descriptor.major}.x model`
    : `${family} ${descriptor.major}.${descriptor.minor} in every spelling and snapshot`
}

/**
 * Official `Bh` (~@196739150): warning for a literal (exact-name-only) deny
 * entry, with a fix hint when the name looks like a mistyped version, family
 * prose ("opus 5"), or a one-typo family alias.
 */
export function literalDeniedEntryWarning(
  rawEntry: string,
  normalized: string,
): string {
  const base = `"${truncateModelNameForMessage(rawEntry)}" blocks only the exact model name "${truncateModelNameForMessage(normalized)}"; other spellings of the same model are not blocked.`
  const hyphenated = normalized.replace(/(\d)\.(\d)/g, '$1-$2')
  if (hyphenated !== normalized) {
    const candidate = hyphenated.startsWith('claude-')
      ? hyphenated
      : `claude-${hyphenated}`
    if (parseModelDescriptor(candidate) !== null) {
      return `${base} To block a version, write it with a hyphen: "${truncateModelNameForMessage(candidate)}".`
    }
  }
  const familyProse = /^(sonnet|opus|haiku|fable)\s+(\d+)(?:\.(\d+))?$/.exec(normalized)
  if (familyProse) {
    const [, family, major, minor] = familyProse
    if (minor !== undefined) {
      return `${base} To block a version, write its model ID, for example "claude-${family}-${major}-${minor}".`
    }
    return `${base} To block only version ${major}, write "claude-${family}-${major}-0"; "claude-${family}-${major}" blocks every ${capitalizeFirst(family!)} ${major}.x model.`
  }
  if (/^[a-z]+$/.test(normalized)) {
    const nearFamily = (['sonnet', 'opus', 'haiku', 'fable'] as const).find(
      family => damerauLevenshteinDistance(normalized, family) === 1,
    )
    return nearFamily !== undefined
      ? `${base} If you meant the ${capitalizeFirst(nearFamily)} family, write "${nearFamily}".`
      : `${base} To block a model family other than ${familyListForMessage()}, list its versioned IDs.`
  }
  return base
}

/**
 * Official `E$o` (~@196740100): whether a denied model-descriptor rule blocks
 * a target descriptor. Same family + major; a rule minor must match exactly
 * (target minor absent counts as 0); a rule with no trailer blocks every
 * trailer; a rule trailer must match exactly or as a `-`-extended prefix.
 */
export function deniedDescriptorBlocksModel(
  rule: ModelDescriptor,
  target: ModelDescriptor,
): boolean {
  if (rule.family !== target.family || rule.major !== target.major) return false
  if (rule.minor !== undefined && (target.minor ?? 0) !== rule.minor) return false
  if (rule.trailer === undefined) return true
  const targetTrailer = target.trailer ?? ''
  return (
    targetTrailer === rule.trailer ||
    targetTrailer.startsWith(`${rule.trailer}-`)
  )
}

/**
 * Official `OO` (@198790300 region): whether one parsed deny entry blocks a
 * candidate model. `normalizedModel` is the context-tag-stripped lowercase
 * spelling; `descriptor` is its parsed descriptor (null when unparseable).
 * Family rules also match via the word-boundary substring rule (official `dr`)
 * that OCC's allowlist already implements as family containment.
 */
export function deniedEntryMatchesModel(
  entry: DeniedModelsEntry,
  normalizedModel: string,
  descriptor: ModelDescriptor | null,
): boolean {
  switch (entry.kind) {
    case 'literal':
      return normalizedModel === entry.value
    case 'family':
      return (
        descriptor?.family === entry.family ||
        familyMatchesByName(normalizedModel, entry.family)
      )
    case 'model':
      return descriptor !== null && deniedDescriptorBlocksModel(entry.id, descriptor)
  }
}

/**
 * Official `dr` (@198788643): true when ANY occurrence of `family` in `model`
 * sits at `[a-z0-9]`-free boundaries (case-insensitive) — so "opus" matches
 * "claude-opus-5-20260101" and "us.anthropic.claude-opus-5" but not "opusplan".
 */
export function familyMatchesByName(model: string, family: string): boolean {
  for (
    let idx = model.indexOf(family);
    idx !== -1;
    idx = model.indexOf(family, idx + 1)
  ) {
    const startOk = idx === 0 || !/[a-z0-9]/i.test(model[idx - 1]!)
    const endIdx = idx + family.length
    const endOk = endIdx === model.length || !/[a-z0-9]/i.test(model[endIdx]!)
    if (startOk && endOk) return true
  }
  return false
}
