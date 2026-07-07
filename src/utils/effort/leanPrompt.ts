/**
 * K1 (2.1.154): lean system prompt.
 *
 * Models that carry the `lean_prompt` capability receive the lean (shorter)
 * system prompt by default — the expanded/full prompt sections are omitted
 * unless the user opts in via a higher effort level (xhigh / max / ultracode).
 * Older models without the capability always get the full prompt.
 *
 * Mirrors the official 2.1.200 binary: the minified `eqd(e)` helper returns
 * `false` for `lean_prompt`-capable models (and `claude-mythos-5`), `true` for
 * claude-3-x, haiku, sonnet, opus-4-0 through 4-7, and `!isInternal()` otherwise.
 * The `lean_prompt` capability appears in the model-registry capability arrays
 * for the newest launches (opus 4.8, sonnet 5, fable 5, mythos 5).
 *
 * Self-contained (no import from ../effort.ts) so it cannot enter a TDZ or
 * module-init cycle with the effort module.
 */

// Capability key, as it appears in the model-registry capability arrays.
export const LEAN_PROMPT_CAPABILITY = 'lean_prompt'

// Effort levels that opt into the FULL (expanded) prompt even on lean-capable
// models. Matches the binary: the full prompt is "opt-in or for higher effort".
export const FULL_PROMPT_EFFORT_LEVELS = new Set(['xhigh', 'max'])

export type LeanEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Models whose registry capability array includes `lean_prompt`. These get the
// lean prompt by default. (claude-mythos-5 is treated as lean even though its
// capability array omits the key — the binary's eqd() special-cases it.)
const LEAN_PROMPT_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-mythos-5',
]

/**
 * Does this model carry the `lean_prompt` capability? Case-insensitive,
 * longest-id match (so a display name like "claude-sonnet-5-2025..." still
 * matches).
 */
export function modelHasLeanPrompt(model: string): boolean {
  const m = model.toLowerCase()
  return LEAN_PROMPT_MODELS.some(id => m === id || m.includes(id))
}

/**
 * `eqd(model)` from the official binary: should the FULL/expanded system prompt
 * be used for this model? Returns `false` for lean_prompt models (they get the
 * lean prompt), `true` for older models (claude-3-*, haiku, sonnet,
 * opus-4-0/4-1/4-5/4-6/4-7) which never supported the lean variant, and
 * `!isInternal()` for everything else (external users get the full prompt for
 * unrecognized models).
 */
export function shouldUseFullSystemPrompt(model: string): boolean {
  const m = model.toLowerCase()
  // lean_prompt-capable models (and mythos-5) get the LEAN prompt, not full.
  if (modelHasLeanPrompt(m) || m === 'claude-mythos-5') {
    return false
  }
  // Older models never carried the lean_prompt capability → full prompt.
  if (
    m.includes('claude-3-') ||
    m.includes('haiku') ||
    m.includes('sonnet') ||
    m === 'claude-opus-4-0' ||
    m === 'claude-opus-4-1' ||
    m === 'claude-opus-4-5' ||
    m === 'claude-opus-4-6' ||
    m === 'claude-opus-4-7'
  ) {
    return true
  }
  // Default mirrors `!isInternal()` from the binary: external builds (the only
  // kind OCC ships) get the full prompt for unknown models.
  return !isInternalUser()
}

/**
 * Should the LEAN system prompt be used for this model at the given effort?
 *
 * Lean is the DEFAULT for lean_prompt-capable models. The full prompt is
 * opt-in via higher effort (xhigh / max), which is how `ultracode` (xhigh +
 * dynamic workflows) and `/effort max` surface the expanded sections.
 *
 * Models without the lean_prompt capability never use the lean prompt.
 */
export function shouldUseLeanPrompt(
  model: string,
  effort?: LeanEffortLevel | string,
): boolean {
  if (!modelHasLeanPrompt(model)) {
    return false
  }
  // Full prompt is opt-in at higher effort.
  if (effort !== undefined && FULL_PROMPT_EFFORT_LEVELS.has(String(effort))) {
    return false
  }
  return true
}

// Internal to Anthropic (USER_TYPE === 'ant'). External OCC builds never are.
function isInternalUser(): boolean {
  return process.env.USER_TYPE === 'ant'
}
