import { describe, expect, mock, test } from 'bun:test'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.300 (#31) — "Fixed Claude naming files in the session scratchpad
 * by a bare filename or relative path instead of their full path".
 *
 * Official binary evidence (docs/gap-research-300/triage-T4.md §31):
 *   v300-only sentence @224570825 (dd-verified this round, MD5 of the exact
 *   277-byte sentence = eb4a84cc21d7d9679acd7aa9fa783882; 0 hits in v299):
 *     "Whenever you name a file in it to the user, write the file's complete
 *      absolute path in one piece, not a bare filename, a path that starts at
 *      the scratchpad folder, or the directory followed by filenames: a
 *      shortened path is read against the working directory and leads nowhere."
 *   Official placement (`agt` builder dd @224570100): appended at the END of
 *   the scratchpad instruction block, right after the "Only use `/tmp` if the
 *   user explicitly asks." sentence. v299 builder @223389400 is byte-identical
 *   minus that sentence — the fix is a pure prompt-text append.
 *
 * OCC's surrounding scratchpad phrasing is its own divergence (the official
 * "Scratchpad directory: ${e} — always use it…" one-liner has zero hits in
 * OCC); per the triage sketch only the new sentence is portable byte-exact,
 * and OCC's surrounding format is NOT reformatted this round.
 */

// The scratchpad block is gated on the tengu_scratch statsig gate
// (src/utils/permissions/filesystem.ts isScratchpadEnabled). Spread the real
// growthbook module so the prompts.ts transitive import chain keeps every
// other export (getFeatureValue_CACHED_WITH_REFRESH, …).
const actualGrowthbook = await import('../../services/analytics/growthbook.js')
mock.module('../../services/analytics/growthbook.js', () => ({
  ...actualGrowthbook,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: (gate: string) =>
    gate === 'tengu_scratch',
}))

// The v300 sentence, byte-exact (ASCII apostrophe in "file's").
const V300_SENTENCE =
  "Whenever you name a file in it to the user, write the file's complete absolute path in one piece, not a bare filename, a path that starts at the scratchpad folder, or the directory followed by filenames: a shortened path is read against the working directory and leads nowhere."

describe('2.1.300 #31 — scratchpad instructions carry the absolute-path sentence', () => {
  test('getScratchpadInstructions() contains the v300 sentence byte-exact', async () => {
    const { getScratchpadInstructions } = await import('../prompts.js')
    const instructions = getScratchpadInstructions()
    expect(instructions).not.toBeNull()
    expect(instructions ?? '').toContain(V300_SENTENCE)
  })

  test('the sentence sits at the end of the instruction block (official placement)', async () => {
    const { getScratchpadInstructions } = await import('../prompts.js')
    const instructions = getScratchpadInstructions() ?? ''
    expect(instructions.trimEnd().endsWith(V300_SENTENCE)).toBe(true)
  })
})
