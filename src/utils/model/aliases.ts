export const MODEL_ALIASES = [
  'sonnet',
  'opus',
  'haiku',
  'best',
  'fable',
  'sonnet[1m]',
  'opus[1m]',
  'opusplan',
  // 2.1.265 (Gap-120c): official added the opusplan[1m] alias — binary-verbatim
  // (2.1.266 `lin`): `t.trim()==="opusplan[1m]"` is an accepted alias form, and
  // `v9("opusplan[1m]")` → "opus" / `XC("opusplan[1m]")` → true confirm it is
  // treated as a mode-dependent alias, not a literal model name.
  'opusplan[1m]',
] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  return MODEL_ALIASES.includes(modelInput as ModelAlias)
}

/**
 * Bare model family aliases that act as wildcards in the availableModels allowlist.
 * When "opus" is in the allowlist, ANY opus model is allowed (opus 4.5, 4.6, etc.).
 * When a specific model ID is in the allowlist, only that exact version is allowed.
 */
export const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const

export function isModelFamilyAlias(model: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(model)
}
