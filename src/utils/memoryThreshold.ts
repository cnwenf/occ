/**
 * "Too long" character threshold for CLAUDE.md / memory files.
 *
 * Extracted from claudemd.ts so the pure scaling logic can be unit-tested
 * without loading the heavy CLAUDE.md loader module (marked, picomatch, …).
 */

// Floor for the threshold (chars). Small context windows never drop below this,
// preserving the historical 40k cap as the minimum "too long" trigger.
export const MIN_MEMORY_CHARACTER_COUNT = 40000

// 2.1.169: the threshold scales with the active model's context window —
// 5% of the context window expressed in characters
// (tokens * ratio * chars-per-token), floored at MIN_MEMORY_CHARACTER_COUNT.
// Larger context windows get a proportionally larger threshold.
export const MAX_CLAUDE_MD_TOKEN_CONTEXT_RATIO = 0.05

// Standard chars-per-token estimate used to convert the token-context ratio
// into a character threshold (matches the official default for non-ant models).
const CLAUDE_MD_CHARS_PER_TOKEN = 4

/**
 * Returns the per-character "too long" threshold for CLAUDE.md / memory files,
 * scaled to the active model's context window. A 200k-token context yields the
 * historical 40k floor; a 1M-token context yields 200k. Falls back to the floor
 * for invalid / non-positive inputs.
 */
export function getMemoryCharThreshold(
  contextWindowTokens: number,
): number {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return MIN_MEMORY_CHARACTER_COUNT
  }
  return Math.max(
    MIN_MEMORY_CHARACTER_COUNT,
    Math.round(
      contextWindowTokens *
        MAX_CLAUDE_MD_TOKEN_CONTEXT_RATIO *
        CLAUDE_MD_CHARS_PER_TOKEN,
    ),
  )
}
