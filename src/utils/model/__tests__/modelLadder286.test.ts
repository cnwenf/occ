import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.286 (item-B): previous-model-of-same-tier fallback ladder — binary
 * `oPr` (@199362534-region), `CCo`/`gNe`/`Bu`/`Dm` (catalog walk, `fo`/`Hu`
 * @197605159), `GBn` chain guard, `zRe` env-default check, `GYn` user-explicit
 * check (@199418005), `OI` subagent check (@199417435), `hNe`/`ere` skip
 * (@199394813), `d9e` (@199387813). All byte-verified in the v286 ELF.
 *
 * "Fixed every turn failing when the Anthropic API refuses the model your
 * default or a model alias resolves to: Claude Code now retries once on the
 * previous model of the same tier."
 */

process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const GROWTHBOOK_PATH = 'src/services/analytics/growthbook.js'
const PROVIDERS_PATH = '../providers.js'
const MODEL_PATH = '../model.js'
const ALLOWLIST_PATH = '../modelAllowlist.js'
const DEPRECATION_PATH = '../deprecation.js'

// Mutable mock state.
let niftyFinchEnabled = true
let userSetting: string | null | undefined = null
const deniedModels = new Set<string>()
const deprecatedModels = new Set<string>()

let realGrowthbook: Record<string, unknown> = {}
let realProviders: Record<string, unknown> = {}
let realModel: Record<string, unknown> = {}
let realAllowlist: Record<string, unknown> = {}
let realDeprecation: Record<string, unknown> = {}

beforeAll(async () => {
  realGrowthbook = { ...((await import(GROWTHBOOK_PATH)) as object) }
  realProviders = { ...((await import(PROVIDERS_PATH)) as object) }
  realModel = { ...((await import(MODEL_PATH)) as object) }
  realAllowlist = { ...((await import(ALLOWLIST_PATH)) as object) }
  realDeprecation = { ...((await import(DEPRECATION_PATH)) as object) }

  mock.module(GROWTHBOOK_PATH, () => ({
    ...realGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: <T,>(key: string, defaultValue: T): T =>
      key === 'tengu_nifty_finch' ? (niftyFinchEnabled as unknown as T) : defaultValue,
  }))
  mock.module(PROVIDERS_PATH, () => ({
    ...realProviders,
    // xa() = firstParty provider + 1P base URL; the provider arm is env-driven
    // (cleared per test), the base-URL arm is pinned true here.
    isFirstPartyAnthropicBaseUrl: () => true,
  }))
  mock.module(MODEL_PATH, () => ({
    ...realModel,
    getUserSpecifiedModelSetting: () => userSetting,
  }))
  mock.module(ALLOWLIST_PATH, () => ({
    ...realAllowlist,
    isModelAllowed: (model: string) => !deniedModels.has(model),
  }))
  mock.module(DEPRECATION_PATH, () => ({
    ...realDeprecation,
    isModelDeprecated: (model: string) => deprecatedModels.has(model),
  }))
})

afterAll(() => {
  mock.restore()
})

const {
  accessFallbackForChain,
  catalogKeyForModel,
  isModelFallbackDisabled,
  isModelFromEnvDefault,
  isModelUserExplicit,
  modelTier,
  olderSameTierFirstPartyIds,
  previousModelOfSameTier,
} = require('../modelLadder.js') as typeof import('../modelLadder.js')

const ENV_KEYS = [
  'CLAUDE_CODE_NO_MODEL_FALLBACK',
  'CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  niftyFinchEnabled = true
  userSetting = null
  deniedModels.clear()
  deprecatedModels.clear()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('2.1.286 item-B — catalog walk (binary Bu/Dm/CCo)', () => {
  test('modelTier by catalog-key prefix', () => {
    expect(modelTier('opus5')).toBe('opus')
    expect(modelTier('sonnet45')).toBe('sonnet')
    expect(modelTier('haiku45')).toBe('haiku')
    expect(modelTier('fable51')).toBeUndefined()
  })

  test('catalogKeyForModel resolves ids and dated ids', () => {
    expect(catalogKeyForModel('claude-opus-5')).toBe('opus5')
    expect(catalogKeyForModel('claude-sonnet-4-5-20250929')).toBe('sonnet45')
    expect(catalogKeyForModel('claude-sonnet-4-5[1m]')).toBe('sonnet45')
    expect(catalogKeyForModel('not-a-model')).toBeUndefined()
  })

  test('olderSameTierFirstPartyIds walks BACKWARDS (nearest-older first)', () => {
    expect(olderSameTierFirstPartyIds('claude-opus-5')).toEqual([
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-opus-4-1-20250805',
      'claude-opus-4-20250514',
    ])
    expect(olderSameTierFirstPartyIds('claude-opus-4-20250514')).toEqual([])
    expect(olderSameTierFirstPartyIds('claude-fable-5-1')).toEqual([])
  })
})

describe('2.1.286 item-B — previousModelOfSameTier (binary oPr)', () => {
  test('opus-5 → opus-4-8 (same tier, nearest older)', () => {
    expect(previousModelOfSameTier('claude-opus-5')).toBe('claude-opus-4-8')
  })

  test('sonnet-5 → sonnet-4-6', () => {
    expect(previousModelOfSameTier('claude-sonnet-5')).toBe('claude-sonnet-4-6')
  })

  test('haiku-4-5 → 3-5-haiku', () => {
    expect(previousModelOfSameTier('claude-haiku-4-5-20251001')).toBe(
      'claude-3-5-haiku-20241022',
    )
  })

  test('the [1m] suffix is preserved (binary `g+r`)', () => {
    expect(previousModelOfSameTier('claude-sonnet-5[1m]')).toBe(
      'claude-sonnet-4-6[1m]',
    )
  })

  test('fable tier has no ladder (Bu → undefined)', () => {
    expect(previousModelOfSameTier('claude-fable-5-1')).toBeUndefined()
  })

  test('the oldest model of a tier has no previous', () => {
    expect(previousModelOfSameTier('claude-opus-4-20250514')).toBeUndefined()
  })

  test('gate: tengu_nifty_finch off → undefined', () => {
    niftyFinchEnabled = false
    expect(previousModelOfSameTier('claude-opus-5')).toBeUndefined()
  })

  test('gate: CLAUDE_CODE_NO_MODEL_FALLBACK → undefined (binary d9e)', () => {
    process.env.CLAUDE_CODE_NO_MODEL_FALLBACK = '1'
    expect(isModelFallbackDisabled()).toBe(true)
    expect(previousModelOfSameTier('claude-opus-5')).toBeUndefined()
  })

  test('gate: CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK → undefined', () => {
    process.env.CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK = 'true'
    expect(previousModelOfSameTier('claude-opus-5')).toBeUndefined()
  })

  test('deprecated cut: a deprecated NEAREST candidate drops the whole tail', () => {
    // Binary `h=s.findIndex(d7||Wgn); (h<0?s:s.slice(0,h))` — candidates at or
    // after the first deprecated entry are cut, NOT skipped over.
    deprecatedModels.add('claude-opus-4-8')
    expect(previousModelOfSameTier('claude-opus-5')).toBeUndefined()
  })

  test('deprecated cut: a later deprecated candidate keeps earlier ones', () => {
    deprecatedModels.add('claude-opus-4-7')
    expect(previousModelOfSameTier('claude-opus-5')).toBe('claude-opus-4-8')
  })

  test('disallowed candidate is skipped (binary hNe arm 1: !Hr(e+r))', () => {
    deniedModels.add('claude-opus-4-8')
    expect(previousModelOfSameTier('claude-opus-5')).toBe('claude-opus-4-7')
  })

  test('a [1m] candidate must support 1M (binary `r===""||cj(S)`)', () => {
    // haiku does not support 1M → the suffixed ladder finds nothing.
    expect(previousModelOfSameTier('claude-haiku-4-5-20251001[1m]')).toBeUndefined()
  })
})

describe('2.1.286 item-B — user-explicit / env-default gates (binary GYn/zRe/OI)', () => {
  test('no user setting → not explicit', () => {
    expect(isModelUserExplicit('claude-opus-5')).toBe(false)
  })

  test('explicit settings model → user-explicit (exact suffix-insensitive compare)', () => {
    userSetting = 'claude-opus-5'
    expect(isModelUserExplicit('claude-opus-5')).toBe(true)
    expect(isModelUserExplicit('claude-opus-5[1m]')).toBe(true) // kt both sides
    expect(isModelUserExplicit('claude-sonnet-5')).toBe(false)
  })

  test('alias or "default" setting → NOT user-explicit (binary oIe arm)', () => {
    userSetting = 'opus'
    expect(isModelUserExplicit('claude-opus-5')).toBe(false)
    userSetting = 'default'
    expect(isModelUserExplicit('claude-opus-5')).toBe(false)
  })

  test('CLAUDE_CODE_SUBAGENT_MODEL pinning the model → user-explicit (binary OI)', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-opus-5'
    expect(isModelUserExplicit('claude-opus-5')).toBe(true)
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherit'
    expect(isModelUserExplicit('claude-opus-5')).toBe(false)
  })

  test('raw ANTHROPIC_DEFAULT_*_MODEL env → env-default (binary zRe, cI compare)', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5'
    expect(isModelFromEnvDefault('claude-opus-5')).toBe(true)
    expect(isModelFromEnvDefault('CLAUDE-OPUS-5[1m]')).toBe(true) // suffix+case insensitive
    expect(isModelFromEnvDefault('claude-sonnet-5')).toBe(false)
  })
})

describe('2.1.286 item-B — accessFallbackForChain (binary GBn, one retry then give up)', () => {
  test('single-model chain at the tail → the ladder result', () => {
    expect(accessFallbackForChain(['claude-opus-5'], 0, 'claude-opus-5')).toBe(
      'claude-opus-4-8',
    )
  })

  test('ONE RETRY THEN GIVE UP: the chain already hopped via the ladder → undefined', () => {
    // chain = [opus-5, opus-4-8] where opus-4-8 IS oPr(opus-5): refusing the
    // fallback model must not ladder again.
    expect(
      accessFallbackForChain(
        ['claude-opus-5', 'claude-opus-4-8'],
        1,
        'claude-opus-4-8',
      ),
    ).toBeUndefined()
  })

  test('not the chain tail → undefined', () => {
    expect(
      accessFallbackForChain(['claude-opus-5', 'claude-sonnet-5'], 0, 'claude-opus-5'),
    ).toBeUndefined()
  })

  test('current model disagrees with the chain step → undefined', () => {
    expect(
      accessFallbackForChain(['claude-opus-5'], 0, 'claude-sonnet-5'),
    ).toBeUndefined()
  })

  test("the candidate's family already in the chain → undefined", () => {
    // chain = [opus-4-8, opus-5]; oPr(opus-4-8)=opus-4-7 ≠ current, so the
    // hop guard does not fire — but oPr(opus-5)=opus-4-8 is already in the
    // chain (family match), so no fallback.
    expect(
      accessFallbackForChain(
        ['claude-opus-4-8', 'claude-opus-5'],
        1,
        'claude-opus-5',
      ),
    ).toBeUndefined()
  })

  test('user-explicit current model → undefined', () => {
    userSetting = 'claude-opus-5'
    expect(
      accessFallbackForChain(['claude-opus-5'], 0, 'claude-opus-5'),
    ).toBeUndefined()
  })

  test('env-default current model → undefined', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5'
    expect(
      accessFallbackForChain(['claude-opus-5'], 0, 'claude-opus-5'),
    ).toBeUndefined()
  })
})
