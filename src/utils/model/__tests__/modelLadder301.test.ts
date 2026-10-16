import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * CC 2.1.301 (occ160 WP-G): fable/best alias previous-Fable retry.
 *
 * Official changelog: "Fixed the `fable` (and `best`) model alias erroring on
 * the Anthropic API when the newest Fable model is not available to your
 * organization: Claude Code now retries once on the previous Fable model."
 *
 * Binary references (v301 ELF, byte-verified; v300 for the delta):
 *   - `Nm(e){return e.replace(/\d+$/,"")}` @224337624 — family stem.
 *   - `Lc(e)` @224337667 — tier via stem (≡ v300 `pa` @223429745 behavior).
 *   - `tks(e)` @224339603 — older same-FAMILY ids (v300 `dSs` @223431739
 *     grouped by tier only → fable had NO predecessor → alias errored).
 *   - `Iyo(e)` @224340156 — previousModelOfSameTier, structurally ≡ v300
 *     `mmo` (tengu_nifty_finch gate @224340193); unchanged by the fix.
 *   - `GBn` chain guard — unchanged (one retry then give up).
 *
 * Alias resolution itself (`kt` fable arm → getDefaultFableModel →
 * claude-fable-5-1 on stock first-party) is UNCHANGED in 301 — asserted here
 * as the normal-path regression guard.
 */

process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const GROWTHBOOK_PATH = 'src/services/analytics/growthbook.js'
const PROVIDERS_PATH = '../providers.js'
const MODEL_PATH = '../model.js'
const ALLOWLIST_PATH = '../modelAllowlist.js'
const DEPRECATION_PATH = '../deprecation.js'

// Mutable mock state (same scaffolding as modelLadder286.test.ts).
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
    // Stock first-party: provider arm is env-driven (cleared per test), the
    // base-URL arm is pinned true here.
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
  isModelFromEnvDefault,
  isModelUserExplicit,
  modelFamilyStem,
  modelTier,
  olderSameTierFirstPartyIds,
  previousModelOfSameTier,
} = require('../modelLadder.js') as typeof import('../modelLadder.js')

const { parseUserSpecifiedModel } = require('../model.js') as typeof import('../model.js')

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

describe('CC 2.1.301 — fable/best alias normal path UNCHANGED (binary kt fable arm)', () => {
  test('alias "fable" resolves to the newest Fable model (claude-fable-5-1)', () => {
    expect(parseUserSpecifiedModel('fable')).toBe('claude-fable-5-1')
  })

  test('alias "best" resolves through the default Fable model (claude-fable-5-1)', () => {
    expect(parseUserSpecifiedModel('best')).toBe('claude-fable-5-1')
  })

  test('ANTHROPIC_DEFAULT_FABLE_MODEL env overrides the alias target', () => {
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'claude-fable-5'
    expect(parseUserSpecifiedModel('fable')).toBe('claude-fable-5')
  })
})

describe('CC 2.1.301 — family-stem grouping (binary Nm @224337624 / Lc @224337667)', () => {
  test('modelFamilyStem strips trailing digits', () => {
    expect(modelFamilyStem('fable51')).toBe('fable')
    expect(modelFamilyStem('fable5')).toBe('fable')
    expect(modelFamilyStem('sonnet55')).toBe('sonnet')
    expect(modelFamilyStem('opus5')).toBe('opus')
    expect(modelFamilyStem('haiku45')).toBe('haiku')
  })

  test('modelTier (Lc) keeps sonnet/opus/haiku and still rejects fable', () => {
    expect(modelTier('sonnet55')).toBe('sonnet')
    expect(modelTier('opus5')).toBe('opus')
    expect(modelTier('haiku45')).toBe('haiku')
    expect(modelTier('fable51')).toBeUndefined()
    expect(modelTier('fable5')).toBeUndefined()
  })
})

describe('CC 2.1.301 — olderSameTierFirstPartyIds regroups by stem (binary tks @224339603)', () => {
  test('fable-5-1 → [fable-5] (was [] under v300 tier grouping)', () => {
    expect(olderSameTierFirstPartyIds('claude-fable-5-1')).toEqual([
      'claude-fable-5',
    ])
  })

  test('oldest fable has no older family member', () => {
    expect(olderSameTierFirstPartyIds('claude-fable-5')).toEqual([])
  })

  test('unknown model still short-circuits to [] (tks `if(!n)return[]`)', () => {
    expect(olderSameTierFirstPartyIds('not-a-model')).toEqual([])
  })

  test('REGRESSION: opus/sonnet/haiku results are byte-identical to v300', () => {
    expect(olderSameTierFirstPartyIds('claude-opus-5')).toEqual([
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-opus-4-1-20250805',
      'claude-opus-4-20250514',
    ])
    expect(olderSameTierFirstPartyIds('claude-sonnet-5')).toEqual([
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
    ])
    expect(olderSameTierFirstPartyIds('claude-haiku-4-5-20251001')).toEqual([
      'claude-3-5-haiku-20241022',
    ])
  })
})

describe('CC 2.1.301 — previousModelOfSameTier for fable (binary Iyo @224340156, unchanged body)', () => {
  test('THE FIX: claude-fable-5-1 → claude-fable-5 (retry once on previous Fable)', () => {
    expect(previousModelOfSameTier('claude-fable-5-1')).toBe('claude-fable-5')
  })

  test('oldest fable → undefined (nothing to retry on)', () => {
    expect(previousModelOfSameTier('claude-fable-5')).toBeUndefined()
  })

  test('REGRESSION: opus-5 → opus-4-8 unchanged', () => {
    expect(previousModelOfSameTier('claude-opus-5')).toBe('claude-opus-4-8')
  })

  test('gate: tengu_nifty_finch off → undefined for fable too', () => {
    niftyFinchEnabled = false
    expect(previousModelOfSameTier('claude-fable-5-1')).toBeUndefined()
  })

  test('gate: CLAUDE_CODE_NO_MODEL_FALLBACK → undefined for fable', () => {
    process.env.CLAUDE_CODE_NO_MODEL_FALLBACK = '1'
    expect(previousModelOfSameTier('claude-fable-5-1')).toBeUndefined()
  })

  test('gate: CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK → undefined for fable', () => {
    process.env.CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK = 'true'
    expect(previousModelOfSameTier('claude-fable-5-1')).toBeUndefined()
  })

  test('denied claude-fable-5 is skipped → undefined (binary hNe arm 1)', () => {
    deniedModels.add('claude-fable-5')
    expect(previousModelOfSameTier('claude-fable-5-1')).toBeUndefined()
  })

  test('deprecated claude-fable-5 cuts the ladder → undefined (binary d7 cut)', () => {
    deprecatedModels.add('claude-fable-5')
    expect(previousModelOfSameTier('claude-fable-5-1')).toBeUndefined()
  })
})

describe('CC 2.1.301 — accessFallbackForChain for fable (binary GBn, one retry then give up)', () => {
  test('single-model fable chain at the tail → claude-fable-5', () => {
    expect(
      accessFallbackForChain(['claude-fable-5-1'], 0, 'claude-fable-5-1'),
    ).toBe('claude-fable-5')
  })

  test('ONE RETRY THEN GIVE UP: refusing claude-fable-5 does not ladder again', () => {
    // chain = [fable-5-1, fable-5] where fable-5 IS Iyo(fable-5-1): the
    // fallback model itself being refused must not produce another retry
    // (hop guard `oPr(s)===r`), and fable-5 has no older sibling anyway.
    expect(
      accessFallbackForChain(
        ['claude-fable-5-1', 'claude-fable-5'],
        1,
        'claude-fable-5',
      ),
    ).toBeUndefined()
  })

  test('candidate already in the chain → undefined (family guard)', () => {
    expect(
      accessFallbackForChain(
        ['claude-fable-5', 'claude-fable-5-1'],
        1,
        'claude-fable-5-1',
      ),
    ).toBeUndefined()
  })

  test('user-explicit fable pin → undefined (binary GYn)', () => {
    userSetting = 'claude-fable-5-1'
    expect(isModelUserExplicit('claude-fable-5-1')).toBe(true)
    expect(
      accessFallbackForChain(['claude-fable-5-1'], 0, 'claude-fable-5-1'),
    ).toBeUndefined()
  })

  test('alias "fable" user setting → NOT explicit, fallback still applies', () => {
    // The changelog scenario: the user chose the ALIAS, not the concrete id,
    // so GYn's oIe alias arm keeps the ladder armed.
    userSetting = 'fable'
    expect(isModelUserExplicit('claude-fable-5-1')).toBe(false)
    expect(
      accessFallbackForChain(['claude-fable-5-1'], 0, 'claude-fable-5-1'),
    ).toBe('claude-fable-5')
  })

  test('raw ANTHROPIC_DEFAULT_FABLE_MODEL pin → undefined (binary zRe)', () => {
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'claude-fable-5-1'
    expect(isModelFromEnvDefault('claude-fable-5-1')).toBe(true)
    expect(
      accessFallbackForChain(['claude-fable-5-1'], 0, 'claude-fable-5-1'),
    ).toBeUndefined()
  })
})
