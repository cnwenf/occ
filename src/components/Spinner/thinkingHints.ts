/**
 * claude-code 2.1.109: rotating progress hints shown beneath the
 * "Thinking" indicator during extended thinking. Each hint has an `afterMs`
 * threshold; the hint with the largest `afterMs <= elapsed` is shown.
 *
 * Mirrors v109's `QgK` array + the per-hint setTimeout scheduling in `dgK`.
 */
export interface ThinkingHint {
  afterMs: number
  text: string
}

export const THINKING_HINTS: readonly ThinkingHint[] = [
  { afterMs: 1_000, text: 'Hmm…' },
  { afterMs: 6_000, text: 'This one needs a moment…' },
  { afterMs: 12_000, text: 'Working through it…' },
  { afterMs: 20_000, text: 'Untangling some thoughts…' },
  { afterMs: 28_000, text: 'Weighing a few approaches…' },
  { afterMs: 36_000, text: 'Consulting the rubber duck…' },
  { afterMs: 48_000, text: 'Cross-referencing seventeen theories…' },
  { afterMs: 60_000, text: 'Double-checking the double-checks…' },
  { afterMs: 80_000, text: 'Almost there…' },
  { afterMs: 108_000, text: 'Pacing in small circles…' },
  { afterMs: 120_000, text: 'Reticulating splines…' },
  { afterMs: 135_000, text: 'Hmm…?' },
  { afterMs: 150_000, text: 'Staring thoughtfully into the middle distance…' },
  { afterMs: 165_000, text: 'Still here, still at it…' },
] as const

/**
 * Returns the hint text to display after `elapsedMs` of thinking, or null if
 * the first threshold hasn't been reached. Mirrors v109's per-hint setTimeout
 * scheduling (the last hint whose afterMs <= elapsed).
 */
export function getThinkingHint(elapsedMs: number): string | null {
  if (elapsedMs < THINKING_HINTS[0]!.afterMs) {
    return null
  }
  // findLast: largest afterMs <= elapsed
  for (let i = THINKING_HINTS.length - 1; i >= 0; i--) {
    if (THINKING_HINTS[i]!.afterMs <= elapsedMs) {
      return THINKING_HINTS[i]!.text
    }
  }
  return null
}
