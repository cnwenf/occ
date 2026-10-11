import { describe, expect, test } from 'bun:test'
import { firstPartyNameToCanonical } from 'src/utils/model/model.js'
import { CLAUDE_SONNET_5_5_CONFIG } from 'src/utils/model/configs.js'
import {
  COST_TIER_2_10,
  COST_TIER_2_10_CACHE_READ_0_10,
  calculateUSDCost,
  getModelCosts,
  getModelPricingString,
  MODEL_COSTS,
} from 'src/utils/modelCost.js'

/**
 * CC 2.1.296 #059 (changelog line 59): "Updated `/cost`, the status line,
 * `--max-budget-usd` and the SDK's cost figures to price Sonnet 5.5 cache
 * reads at $0.10 per million tokens (was $0.20)".
 *
 * Binary-verified against the official 2.1.296 linux-x64 ELF (md5
 * 3c8749470f70a26efadf982b587e1548):
 * - v296 model-catalog `pricing_tiers` table (@207704167) gains
 *   `tier_2_10_cache_read_0_10:{input:2,output:10,cache_write_5m:2.5,
 *   cache_write_1h:4,cache_read:0.1,web_search:0.01}` — absent from v295.
 * - The `claude-sonnet-5-5` catalog entry (@207711856) changes
 *   `pricing:"tier_2_10"` → `pricing:"tier_2_10_cache_read_0_10"`.
 * - `claude-sonnet-5` KEEPS `pricing:"tier_2_10"` (@207710980) — the full
 *   v295→v296 model→tier map diff shows sonnet-5-5 as the ONLY reassignment.
 */

describe('2.1.296 #059: tier_2_10_cache_read_0_10 constant (catalog @207704167)', () => {
  test('carries the exact binary values (tier_2_10 with cache_read 0.1)', () => {
    expect(COST_TIER_2_10_CACHE_READ_0_10).toEqual({
      inputTokens: 2,
      outputTokens: 10,
      promptCacheWriteTokens: 2.5,
      promptCacheWrite1hTokens: 4,
      promptCacheReadTokens: 0.1,
      webSearchRequests: 0.01,
    })
  })

  test('base COST_TIER_2_10 is unchanged (cache_read stays $0.20)', () => {
    expect(COST_TIER_2_10.promptCacheReadTokens).toBe(0.2)
  })
})

describe('2.1.296 #059: MODEL_COSTS remap (catalog entry @207711856)', () => {
  test('claude-sonnet-5-5 maps to COST_TIER_2_10_CACHE_READ_0_10', () => {
    const key = firstPartyNameToCanonical(CLAUDE_SONNET_5_5_CONFIG.firstParty)
    expect(MODEL_COSTS[key]).toBe(COST_TIER_2_10_CACHE_READ_0_10)
  })

  test('getModelCosts resolves sonnet-5-5 (firstParty + bedrock form)', () => {
    expect(getModelCosts('claude-sonnet-5-5', {} as never)).toBe(
      COST_TIER_2_10_CACHE_READ_0_10,
    )
    expect(getModelCosts('us.anthropic.claude-sonnet-5-5', {} as never)).toBe(
      COST_TIER_2_10_CACHE_READ_0_10,
    )
  })

  test('claude-sonnet-5 keeps tier_2_10 (untouched neighbor)', () => {
    expect(getModelCosts('claude-sonnet-5', {} as never)).toBe(COST_TIER_2_10)
  })
})

describe('2.1.296 #059: cost figures (/cost, status line, --max-budget-usd, SDK)', () => {
  test('1M cache-read tokens on sonnet-5-5 cost $0.10 (was $0.20)', () => {
    const cost = calculateUSDCost('claude-sonnet-5-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    } as never)
    expect(cost).toBeCloseTo(0.1, 10)
  })

  test('1M cache-read tokens on sonnet-5 still cost $0.20', () => {
    const cost = calculateUSDCost('claude-sonnet-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    } as never)
    expect(cost).toBeCloseTo(0.2, 10)
  })

  test('picker pricing suffix unchanged: input/output stay $2/$10', () => {
    expect(getModelPricingString('claude-sonnet-5-5')).toBe('$2/$10 per Mtok')
  })
})
