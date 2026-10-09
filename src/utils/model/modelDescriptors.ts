/**
 * CC 2.1.283 — model-descriptor grammar shared by the `deniedModels` /
 * `availableModelsMatch` managed-settings ports.
 *
 * Byte-verified against the official v2.1.283 linux-x64 ELF (JS string region,
 * catalog chunk @196295780–196297700, message helpers @196736900–196738100,
 * `ub` @198783953). Official minified names are cited per function.
 *
 * Descriptor grammar: `claude-<family>-<major>[-<minor>]` (version-last) or
 * `claude-<major>[-<minor>]-<family>` (legacy version-first, e.g.
 * claude-3-5-sonnet), plus trailers (`-fast`, `-latest`, `-v<N>@<date>`,
 * `[-@]<YYYYMMDD>`) and provider spellings (`us.anthropic.…`, Bedrock ARN
 * paths, Vertex `/…/` paths).
 */

import { isModelFamilyAlias } from './aliases.js'

/**
 * Official `zJ` (@196175056): provider prefixes accepted on
 * `<prefix>.anthropic.<model>` IDs. Any other prefix → not a descriptor.
 */
export const PROVIDER_MODEL_PREFIXES = [
  'us',
  'eu',
  'apac',
  'jp',
  'au',
  'us-gov',
  'global',
] as const

/**
 * Official `mne` (@196295821): canonical model catalog, used to suggest the
 * latest model ID for a family in exact-match warnings (`Jl`).
 */
export const CANONICAL_MODEL_CATALOG: readonly string[] = [
  'claude-3-5-haiku',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-haiku-4-5',
  // 2.1.293 (OCC-111): the v293 catalog adds claude-haiku-5-5
  // (latest_per_family haiku → "claude-haiku-5-5", alias table @204789153).
  // Alphabetical order keeps the shorter/older prefix first;
  // latestCanonicalModelForFamily('haiku') now returns claude-haiku-5-5.
  'claude-haiku-5-5',
  'claude-mythos-5',
  'claude-mythos-5-1',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  // 2.1.284 (OCC-101): the v284 catalog adds claude-sonnet-5-5
  // (latest_per_family sonnet → "claude-sonnet-5-5"; first-party id list
  // `ere` ends …"claude-sonnet-5","claude-sonnet-5-5"). Alphabetical order
  // keeps the shorter prefix first; latestCanonicalModelForFamily('sonnet')
  // now returns claude-sonnet-5-5 (major 5 minor 5 > 5.0 via `N3n`).
  'claude-sonnet-5-5',
]

/**
 * A parsed model descriptor (official `Tf` result shape). `base` is the
 * matched `claude-…` prefix; exactly one of `trailer` (unnormalized suffix)
 * or `date` (normalized dated snapshot) may accompany it, or neither.
 */
export type ModelDescriptor = {
  readonly family: string
  readonly major: number
  readonly minor?: number
  readonly legacyVersionFirst: boolean
  readonly base: string
  readonly trailer?: string
  readonly date?: string
}

/** Official `d` intermediate: the `claude-…` core before trailer analysis. */
type DescriptorCore = {
  readonly family: string
  readonly major: number
  readonly minor?: number
  readonly legacyVersionFirst: boolean
  readonly base: string
}

/** Official `Mn`: strip every context-size tag (`[1m]`/`[2m]`, any case). */
export function stripContextSizeTags(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}

/** Official `Jt`: strip ONE trailing `[1m]` suffix (case-insensitive). */
export function strip1mSuffix(model: string): string {
  return model.replace(/\[1m\]$/i, '')
}

/** Official `$x`: equality ignoring `[1m]` suffixes and case. */
export function modelIdsEqualAnyContext(a: string, b: string): boolean {
  return strip1mSuffix(a).toLowerCase() === strip1mSuffix(b).toLowerCase()
}

/**
 * Official `LBr`: whether a trailer is a normalized release spelling
 * (`-fast`/`-latest`, dated `-v<N>@<YYYYMMDD>` / `[-@]<YYYYMMDD>`, `-v<N>[:M]`).
 */
export function isNormalizedTrailer(trailer: string): boolean {
  return /^(?:-fast|-latest)?(?:-v\d{1,3}@\d{8}|[-@]\d{8})?(?:-v\d{1,3}(?::\d{1,3})?)?$/.test(
    trailer,
  )
}

/** Official `d`: parse the `claude-…` core (version-last, then legacy version-first). */
function parseDescriptorCore(input: string): DescriptorCore | null {
  const versionLast = /^claude-([a-z]+)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/.exec(
    input,
  )
  if (versionLast) {
    const [, family = '', majorText = '', minorText] = versionLast
    return {
      family,
      major: Number(majorText),
      ...(minorText === undefined ? {} : { minor: Number(minorText) }),
      legacyVersionFirst: false,
      base: versionLast[0],
    }
  }
  const versionFirst = /^claude-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?-([a-z]+)/.exec(
    input,
  )
  if (versionFirst) {
    const [, majorText = '', minorText, family = ''] = versionFirst
    return {
      family,
      major: Number(majorText),
      ...(minorText === undefined ? {} : { minor: Number(minorText) }),
      legacyVersionFirst: true,
      base: versionFirst[0],
    }
  }
  return null
}

/**
 * Official `Tf` (@196296290 region): parse a model ID (any provider spelling)
 * into a descriptor, or null when the string is not a recognizable
 * `claude-…` model ID.
 */
export function parseModelDescriptor(input: string): ModelDescriptor | null {
  let normalized = input.trim().toLowerCase()
  if (normalized === '' || /\s/.test(normalized)) return null
  normalized = normalized.replace(/\[[12]m\]$/, '')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash !== -1) normalized = normalized.slice(lastSlash + 1)
  const providerMatch = /^(?:([a-z-]+)\.)?anthropic\.(claude-.*)$/.exec(normalized)
  if (providerMatch) {
    const [, prefix, modelId = ''] = providerMatch
    if (prefix !== undefined && !(PROVIDER_MODEL_PREFIXES as readonly string[]).includes(prefix)) {
      return null
    }
    normalized = modelId
  }
  const core = parseDescriptorCore(normalized)
  if (core === null) return null
  const trailerText = normalized.slice(core.base.length)
  if (trailerText !== '' && !/^[-@]/.test(trailerText)) return null
  const descriptor: ModelDescriptor = {
    family: core.family,
    major: core.major,
    ...(core.minor !== undefined ? { minor: core.minor } : {}),
    legacyVersionFirst: core.legacyVersionFirst,
    base: core.base,
  }
  if (!isNormalizedTrailer(trailerText)) {
    return { ...descriptor, trailer: trailerText }
  }
  const date = /(?:-v\d+@|[-@])(\d{8})/.exec(trailerText)?.[1]
  return date !== undefined ? { ...descriptor, date } : descriptor
}

/** Official `N3n`: version ordering — major first, then minor (absent = 0). */
export function compareDescriptorVersions(
  a: ModelDescriptor,
  b: ModelDescriptor,
): number {
  return a.major - b.major || (a.minor ?? 0) - (b.minor ?? 0)
}

/** Official `GYe`: same family, same spelling order, same major/minor. */
export function isSameDescriptorVersion(
  a: ModelDescriptor,
  b: ModelDescriptor,
): boolean {
  return (
    a.family === b.family &&
    a.legacyVersionFirst === b.legacyVersionFirst &&
    compareDescriptorVersions(a, b) === 0
  )
}

/**
 * Official `M5n`: whether any non-family entry names this family at a segment
 * boundary (e.g. "opus-4-5" narrows the "opus" family wildcard).
 */
export function familyNarrowedByEntries(
  family: string,
  normalizedEntries: readonly string[],
): boolean {
  for (const entry of normalizedEntries) {
    if (isModelFamilyAlias(entry)) continue
    const idx = entry.indexOf(family)
    if (idx === -1) continue
    const afterFamily = idx + family.length
    if (afterFamily === entry.length || entry[afterFamily] === '-') return true
  }
  return false
}

/**
 * Official `Jl`: newest canonical catalog ID for a family (version-last
 * spellings only), used for the "for example \"claude-opus-5-5\"" warning hints.
 */
export function latestCanonicalModelForFamily(family: string): string | undefined {
  let newest: ModelDescriptor | undefined
  for (const id of CANONICAL_MODEL_CATALOG) {
    const descriptor = parseModelDescriptor(id)
    if (
      descriptor !== null &&
      descriptor.family === family &&
      !descriptor.legacyVersionFirst &&
      (newest === undefined || compareDescriptorVersions(descriptor, newest) > 0)
    ) {
      newest = descriptor
    }
  }
  return newest?.base
}

/**
 * Official `we` (@196737933): control characters become "?", then cap at 128
 * characters with an ellipsis — used inside every governance warning.
 */
export function truncateModelNameForMessage(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char matcher (official 2.1.283 `we` binary-verbatim governance-warning sanitizer @196737933)
  const replaced = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
  return replaced.length > 128 ? `${replaced.slice(0, 128)}…` : replaced
}

/** Official `ub` (@198783953): sanitize a model name for a blocked message. */
export function sanitizeModelNameForMessage(value: string): string {
  const stripped = value.replace(/[^A-Za-z0-9._:/@[\]-]/g, '')
  if (stripped.length === 0) return '(unrecognized model name)'
  return stripped.length > 128 ? `${stripped.slice(0, 128)}…` : stripped
}

/** Official `Fn`/`Vh` (identical bodies in both chunks): capitalize-first. */
export function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Official `Kh` (@196737980): family list prose — "sonnet, opus, haiku or
 * fable" — built from the official `c6` order (MODEL_FAMILY_ALIASES).
 */
export function familyListForMessage(): string {
  const families = [...MODEL_FAMILY_LIST]
  const last = families.pop()
  return families.length === 0
    ? (last ?? '')
    : `${families.join(', ')} or ${last}`
}

/** Official `c6` (@196296290) — same list as OCC's MODEL_FAMILY_ALIASES. */
const MODEL_FAMILY_LIST: readonly string[] = ['sonnet', 'opus', 'haiku', 'fable']

/**
 * Official `_6` (@196737500 region): full Damerau-Levenshtein distance
 * (insert/delete/substitute/transposition), used for the one-typo family
 * suggestion in `Bh`.
 */
export function damerauLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  const aLen = a.length
  const bLen = b.length
  const matrix = Array.from({ length: aLen + 1 }, (_, row) =>
    Array.from({ length: bLen + 1 }, (__, col) =>
      row === 0 ? col : col === 0 ? row : 0,
    ),
  )
  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      )
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        matrix[i]![j] = Math.min(matrix[i]![j]!, matrix[i - 2]![j - 2]! + 1)
      }
    }
  }
  return matrix[aLen]![bLen]!
}
