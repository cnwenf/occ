import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { computeSimpleEnvInfo } from '../prompts.js'

/**
 * P3-3 + P3-5 (OCC-101 review, CC 2.1.284 Sonnet 5.5 launch): pins on the
 * Environment-section output built by computeSimpleEnvInfo.
 *
 * P3-3 — getKnowledgeCutoff (prompts.ts, @[MODEL LAUNCH] site): the -5-5
 * rows MUST precede their plain -5 substring rows (occurs-check hazard),
 * byte-verified against the v284 ELF catalog `display_name/knowledge_cutoff`
 * pairs: Opus 5.5 AND Sonnet 5.5 → "June 2026"; the explicit opus-5-5 row
 * fixes the 2.1.280-round drift where the 'claude-opus-5' substring gave
 * Opus 5.5 "May 2026".
 *
 * P3-5 — the model-IDs sentence carries the 5.5-generation IDs
 * (CLAUDE_LATEST_MODEL_IDS) and the fast-mode sentence ends at
 * "…toggled with /fast." — the 2.1.206-era "available on Opus" tail was
 * REMOVED in this round (v284 @206557862 / v283 @204691709: no
 * "available on Opus" fragment exists in either binary).
 *
 * Mutation self-verification (review protocol): deleting the sonnet-5-5
 * cutoff row (falls through to the sonnet-5 substring → "January 2026"),
 * reordering opus-5-5 after opus-5 (→ "May 2026"), or re-appending the
 * fast-mode availability tail MUST each turn the corresponding pin red.
 */

let savedUserType: string | undefined

beforeEach(() => {
  // USER_TYPE=ant + undercover would suppress the model/cutoff lines.
  savedUserType = process.env.USER_TYPE
  delete process.env.USER_TYPE
})

afterEach(() => {
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
})

describe('2.1.284: knowledge cutoffs — the -5-5 rows precede the -5 substring rows', () => {
  test.each([
    ['claude-opus-5-5', 'June 2026'],
    ['claude-sonnet-5-5', 'June 2026'],
    ['claude-opus-5', 'May 2026'],
    ['claude-sonnet-5', 'January 2026'],
  ])('%s cutoff is %s', async (modelId, cutoff) => {
    const info = await computeSimpleEnvInfo(modelId)
    expect(info).toContain(`Assistant knowledge cutoff is ${cutoff}.`)
  })
})

describe('2.1.284: Environment output — latest-model IDs + fast-mode tail removal', () => {
  test('the model-IDs sentence carries the 5.5-generation catalog IDs', async () => {
    const info = await computeSimpleEnvInfo('claude-sonnet-5-5')
    // 2.1.293 (OCC-111, Haiku 5.5 launch): the lead-in prose and the haiku
    // Model-ID entry follow the v293 latest_per_family flip
    // (haiku → "claude-haiku-5-5"). Lead-in bump is a reasoned inference —
    // see the deviation note in prompts.ts. Pins UPDATED, not weakened.
    expect(info).toContain(
      'The most recent Claude models are the Claude 5 family and Haiku 5.5.',
    )
    expect(info).toContain("Fable 5.1: 'claude-fable-5-1'")
    expect(info).toContain("Opus 5.5: 'claude-opus-5-5'")
    expect(info).toContain("Sonnet 5.5: 'claude-sonnet-5-5'")
    expect(info).toContain("Haiku 5.5: 'claude-haiku-5-5'")
  })

  test('fast-mode sentence ends at /fast. — no availability tail (v284 @206557862)', async () => {
    const info = await computeSimpleEnvInfo('claude-sonnet-5-5')
    expect(info).toContain(
      'Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast.',
    )
    expect(info).not.toContain('available on Opus')
  })
})
