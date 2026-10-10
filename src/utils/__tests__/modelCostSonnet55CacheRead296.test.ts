import { describe, expect, test } from 'bun:test'

/**
 * CC 2.1.296 (#059): Sonnet 5.5 cache-read repricing $0.20 → $0.10.
 *
 * Official 2.1.296 baked model catalog (ev-pricing296.txt):
 *   - NEW pricing tier constant `tier_2_10_cache_read_0_10`:
 *     {input:2, output:10, cache_write_5m:2.5, cache_write_1h:4,
 *      cache_read:0.1, web_search:0.01}
 *   - the `claude-sonnet-5-5` catalog entry now carries
 *     `pricing:"tier_2_10_cache_read_0_10"` (was `tier_2_10`, cache_read
 *     $0.20, in 2.1.284–2.1.295).
 *   - `claude-sonnet-5` STAYS on `tier_2_10` (cache_read $0.20) — the
 *     repricing is Sonnet-5.5-only.
 *
 * OCC mapping: COST_TIER_2_10_CACHE_READ_0_10 (modelCost.ts) ≡ the official
 * tier constant; MODEL_COSTS is keyed by firstPartyNameToCanonical(config
 * .firstParty), and getModelCosts canonicalizes provider-prefixed IDs
 * (e.g. bedrock `us.anthropic.claude-sonnet-5-5`) through getCanonicalName
 * before lookup.
 */

// Hermetic for credential-less environments (CI): same dummy-key seed as
// sonnet55Launch284.test.ts.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

import { CLAUDE_SONNET_5_5_CONFIG, CLAUDE_SONNET_5_CONFIG } from 'src/utils/model/configs.js'
import { firstPartyNameToCanonical } from 'src/utils/model/model.js'
import {
  COST_TIER_2_10,
  COST_TIER_2_10_CACHE_READ_0_10,
  getModelCosts,
  MODEL_COSTS,
} from 'src/utils/modelCost.js'

const USAGE = {} as Parameters<typeof getModelCosts>[1]

describe('2.1.296 #059 — COST_TIER_2_10_CACHE_READ_0_10 (official tier constant)', () => {
  test('tier values match the official catalog verbatim', () => {
    // Arrange / Act
    const tier = COST_TIER_2_10_CACHE_READ_0_10

    // Assert — {input:2, output:10, cache_write_5m:2.5, cache_write_1h:4,
    //            cache_read:0.1, web_search:0.01}
    expect(tier.inputTokens).toBe(2)
    expect(tier.outputTokens).toBe(10)
    expect(tier.promptCacheWriteTokens).toBe(2.5)
    expect(tier.promptCacheWrite1hTokens).toBe(4)
    expect(tier.promptCacheReadTokens).toBe(0.1)
    expect(tier.webSearchRequests).toBe(0.01)
  })

  test('differs from tier_2_10 ONLY in the cache-read figure (0.1 vs 0.2)', () => {
    // Arrange / Act / Assert
    expect(COST_TIER_2_10.promptCacheReadTokens).toBe(0.2)
    expect({
      ...COST_TIER_2_10_CACHE_READ_0_10,
      promptCacheReadTokens: COST_TIER_2_10.promptCacheReadTokens,
    }).toEqual({ ...COST_TIER_2_10 })
  })
})

describe('2.1.296 #059 — MODEL_COSTS mapping', () => {
  test('claude-sonnet-5-5 → tier_2_10_cache_read_0_10', () => {
    // Arrange
    const key = firstPartyNameToCanonical(CLAUDE_SONNET_5_5_CONFIG.firstParty)

    // Act / Assert
    expect(MODEL_COSTS[key]).toEqual(COST_TIER_2_10_CACHE_READ_0_10)
  })

  test('claude-sonnet-5 STAYS on tier_2_10 (cache_read $0.20)', () => {
    // Arrange
    const key = firstPartyNameToCanonical(CLAUDE_SONNET_5_CONFIG.firstParty)

    // Act / Assert
    expect(MODEL_COSTS[key]).toEqual(COST_TIER_2_10)
    expect(MODEL_COSTS[key]?.promptCacheReadTokens).toBe(0.2)
  })
})

describe('2.1.296 #059 — getModelCosts canonical lookup', () => {
  test('first-party claude-sonnet-5-5 resolves to the repriced tier', () => {
    // Arrange / Act
    const costs = getModelCosts('claude-sonnet-5-5', USAGE)

    // Assert
    expect(costs).toEqual(COST_TIER_2_10_CACHE_READ_0_10)
    expect(costs.promptCacheReadTokens).toBe(0.1)
  })

  test('bedrock-prefixed us.anthropic.claude-sonnet-5-5 resolves to the same tier', () => {
    // Arrange / Act
    const costs = getModelCosts('us.anthropic.claude-sonnet-5-5', USAGE)

    // Assert
    expect(costs).toEqual(COST_TIER_2_10_CACHE_READ_0_10)
  })

  test('claude-sonnet-5 keeps the $0.20 cache-read tier', () => {
    // Arrange / Act
    const costs = getModelCosts('claude-sonnet-5', USAGE)

    // Assert
    expect(costs).toEqual(COST_TIER_2_10)
    expect(costs.promptCacheReadTokens).toBe(0.2)
  })
})
