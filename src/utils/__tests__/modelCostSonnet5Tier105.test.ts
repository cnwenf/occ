import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearOAuthTokenCache } from 'src/utils/auth.js'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'
import {
  COST_TIER_2_10,
  COST_TIER_3_15,
  getModelCosts,
  getModelPricingString,
  MODEL_COSTS,
} from 'src/utils/modelCost.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import { getDefaultOptionForUser } from 'src/utils/model/modelOptions.js'
import { firstPartyNameToCanonical } from 'src/utils/model/model.js'
import { CLAUDE_SONNET_5_CONFIG } from 'src/utils/model/configs.js'

/**
 * Gap-105a — Sonnet 5 repricing (official 2.1.243): the model catalog entry
 * for `claude-sonnet-5` carries `pricing:"tier_2_10"` ($2/$10 per Mtok;
 * cache write 5m $2.50 / 1h $4, read $0.20). Byte-verified against the
 * official 2.1.241 and 2.1.245 linux-x64 binaries. The /model picker's
 * Default row shows the resolved default model's own tier pricing for
 * "tier"-attribution users (PAYG), and env-overridden defaults show the
 * ANTHROPIC_DEFAULT_MODEL attribution note instead of pricing.
 */

// Isolate auth/config state so isClaudeAISubscriber() and the default-model
// resolution see a clean firstParty PAYG environment regardless of the host.
let tmpConfigDir: string
const PREV_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'USER_TYPE',
]

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-sonnet5-tier-'))
  PREV_ENV.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  for (const key of ENV_KEYS) {
    PREV_ENV[key] = process.env[key]
    delete process.env[key]
  }
  // Under bun test (NODE_ENV=test), getAnthropicApiKeyWithSource throws unless
  // SOME credential is present. A dummy API key satisfies that guard AND keeps
  // isClaudeAISubscriber() false (external key disables claude.ai auth) — the
  // firstParty PAYG persona the Default-row tests target.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy'
  getClaudeConfigHomeDir.cache?.clear?.()
  clearOAuthTokenCache()
  resetSettingsCache()
})

afterAll(() => {
  if (PREV_ENV.CLAUDE_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else process.env.CLAUDE_CONFIG_DIR = PREV_ENV.CLAUDE_CONFIG_DIR
  for (const key of ENV_KEYS) {
    if (PREV_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = PREV_ENV[key]
  }
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

beforeEach(() => {
  delete process.env.ANTHROPIC_DEFAULT_MODEL
})

afterEach(() => {
  delete process.env.ANTHROPIC_DEFAULT_MODEL
})

describe('tier_2_10 constant (official pricing_tiers, byte-verified)', () => {
  test('carries the exact binary values', () => {
    expect(COST_TIER_2_10).toEqual({
      inputTokens: 2,
      outputTokens: 10,
      promptCacheWriteTokens: 2.5,
      promptCacheWrite1hTokens: 4,
      promptCacheReadTokens: 0.2,
      webSearchRequests: 0.01,
    })
  })
})

describe('MODEL_COSTS: sonnet-5 → tier_2_10', () => {
  test('claude-sonnet-5 maps to COST_TIER_2_10', () => {
    const key = firstPartyNameToCanonical(CLAUDE_SONNET_5_CONFIG.firstParty)
    expect(MODEL_COSTS[key]).toBe(COST_TIER_2_10)
  })

  test('getModelCosts resolves sonnet-5 to the $2/$10 tier', () => {
    const costs = getModelCosts('claude-sonnet-5', {} as never)
    expect(costs).toBe(COST_TIER_2_10)
  })

  test('getModelPricingString returns the post-promo standard price', () => {
    expect(getModelPricingString('claude-sonnet-5')).toBe('$2/$10 per Mtok')
  })

  test('sonnet 4.6 stays on tier_3_15 ($3/$15)', () => {
    expect(getModelPricingString('claude-sonnet-4-6')).toBe('$3/$15 per Mtok')
    expect(getModelCosts('claude-sonnet-4-6', {} as never)).toBe(COST_TIER_3_15)
  })

  test('unknown models still yield no pricing string', () => {
    expect(getModelPricingString('some-unknown-model-xyz')).toBeUndefined()
  })
})

describe('/model picker Default row (official Nci alignment)', () => {
  test('PAYG default shows the resolved default model tier pricing', () => {
    // firstParty PAYG (no subscriber, no ant, no env override): default
    // resolves to claude-sonnet-5 → tier_2_10 pricing suffix.
    const option = getDefaultOptionForUser()
    expect(option.value).toBeNull()
    expect(option.description).toContain('Use the default model (currently ')
    expect(option.description.endsWith(' · $2/$10 per Mtok')).toBe(true)
  })

  test('ANTHROPIC_DEFAULT_MODEL override shows attribution, not pricing', () => {
    process.env.ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-5'
    const option = getDefaultOptionForUser()
    expect(option.description.endsWith(' · Set by ANTHROPIC_DEFAULT_MODEL')).toBe(
      true,
    )
    expect(option.description).not.toContain('per Mtok')
  })

  test('unknown env default model still shows env attribution, no pricing', () => {
    // Official 2.1.245 Lx(): an unknown ANTHROPIC_DEFAULT_MODEL still yields
    // "env" attribution — the allowlist gate passes with no policy configured
    // and the availability probe only blocks fable/mythos/discovery-disabled
    // models. Env attribution shows the note INSTEAD of pricing (pricing is
    // "tier"-attribution only).
    process.env.ANTHROPIC_DEFAULT_MODEL = 'some-unknown-model-xyz'
    const option = getDefaultOptionForUser()
    expect(option.description).not.toContain('per Mtok')
    expect(option.description.endsWith(' · Set by ANTHROPIC_DEFAULT_MODEL')).toBe(
      true,
    )
  })
})
