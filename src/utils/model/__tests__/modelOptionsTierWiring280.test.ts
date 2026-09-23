import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Hermetic for credential-less environments (CI runners): under CI=true /
// NODE_ENV=test the auth guard (src/utils/auth.ts) demands ANTHROPIC_API_KEY
// or CLAUDE_CODE_OAUTH_TOKEN before credential resolution. This suite is
// offline model-resolution logic; seed a dummy key when none is present.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * P3-7 acceptance follow-up (2.1.280 #001 Opus 5.5 launch + #078 Pro/Team
 * default-model promotion): PRODUCTION-ENTRY wiring test for the /model
 * picker plan-tier gating.
 *
 * The tier gate lives in `getModelOptionsBase` (src/utils/model/
 * modelOptions.ts) — the module-private builder behind the exported
 * `getModelOptions`, which is the exact function the production consumers
 * call (ModelPicker.tsx:79, ConfigTool supportedSettings/prompt,
 * cli/print.ts). opus55Launch280.test.ts pins the pure tier predicates and
 * row builders in isolation; nothing pinned the base builder's branch that
 * routes Max/TeamPremium/Pro/Team (isOpusDefaultTier) to the Opus-default
 * premium list vs. other subscribers to the Sonnet-default standard list.
 * Flattening that branch (e.g. `if (false && isOpusDefaultTier())`) kept the
 * suite green — these tests fail when it is removed.
 *
 * Row shapes are asserted as concrete values recovered from the same
 * byte-verified builders pinned in opus55Launch280.test.ts (Tv/_v/kv/Pg +
 * MaxSonnet5Option/MaxHaiku45Option), with the extra-usage 1M rows toggled
 * deterministically via a mocked getGlobalConfig
 * (cachedExtraUsageDisabledReason drives checkOpus1mAccess/checkSonnet1mAccess).
 *
 * OCC-97 (Gap-97b) lesson: Bun mock.module registrations leak across test
 * files in the same worker — snapshot the real module exports BEFORE mocking
 * and restore them in afterAll.
 */
const actualAuthModule = await import('../../auth.js')
const actualAuthExports = { ...actualAuthModule }
const actualSettingsModule = await import('../../settings/settings.js')
const actualSettingsExports = { ...actualSettingsModule }
const actualConfigModule = await import('../../config.js')
const actualConfigExports = { ...actualConfigModule }

const subState = {
  max: false,
  pro: false,
  team: false,
  teamPremium: false,
  claudeAi: false,
  type: null as string | null,
}

let mockedSettings: Record<string, unknown> = {}
let mockedGlobalConfig: Record<string, unknown> = {}

mock.module('../../auth.js', () => ({
  ...actualAuthExports,
  isMaxSubscriber: () => subState.max,
  isProSubscriber: () => subState.pro,
  isTeamSubscriber: () => subState.team,
  isTeamPremiumSubscriber: () => subState.teamPremium,
  isClaudeAISubscriber: () => subState.claudeAi,
  getSubscriptionType: () => subState.type,
}))

mock.module('../../settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettings_DEPRECATED: () => mockedSettings,
  getInitialSettings: () => mockedSettings,
  getEnforceAvailableModels: () =>
    Boolean(mockedSettings.enforceAvailableModels),
}))

mock.module('../../config.js', () => ({
  ...actualConfigExports,
  getGlobalConfig: () => mockedGlobalConfig,
}))

afterAll(() => {
  mock.module('../../auth.js', () => ({ ...actualAuthExports }))
  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
  mock.module('../../config.js', () => ({ ...actualConfigExports }))
})

// Import the PRODUCTION module under test AFTER the mocks are registered.
const { getModelOptions } = await import('../modelOptions.js')
const {
  COST_TIER_2_10,
  COST_TIER_4_20_CACHE_READ_0_20,
  formatModelPricing,
} = await import('../../modelCost.js')
const { resetModelStringsForTestingOnly, setMainLoopModelOverride, setInitialMainLoopModel } =
  await import('src/bootstrap/state.js')

const OPUS55_BASE_PRICE = formatModelPricing(COST_TIER_4_20_CACHE_READ_0_20)
const SONNET5_PRICE = formatModelPricing(COST_TIER_2_10)

function withEnv(
  env: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function resetSubs(): void {
  subState.max = false
  subState.pro = false
  subState.team = false
  subState.teamPremium = false
  subState.claudeAi = false
  subState.type = null
}

beforeEach(() => {
  resetSubs()
  mockedSettings = {}
  // cachedExtraUsageDisabledReason undefined → isExtraUsageEnabled() false →
  // subscribers get NO 1M rows by default (deterministic regardless of the
  // real ~/.claude.json on the runner). Tests opt in with null.
  mockedGlobalConfig = {}
  // getModelOptions consults the session-global override/initial model for
  // the trailing "custom model" row — pin both to their pristine defaults so
  // no row leaks in from another test's bootstrap state.
  setMainLoopModelOverride(undefined)
  setInitialMainLoopModel(null)
  for (const k of [
    'ANTHROPIC_DEFAULT_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_CUSTOM_MODEL_OPTION',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT',
    'CLAUDE_CODE_3P_PROBE_WROTE_OPUS_DEFAULT',
    'CLAUDE_CODE_DISABLE_1M_CONTEXT',
    'CLAUDE_CODE_DISABLE_FAST_MODE',
    'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'USER_TYPE',
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  resetModelStringsForTestingOnly()
})

describe('getModelOptions wiring — 2.1.280 #078 plan-tier gate (getModelOptionsBase premium branch)', () => {
  test('Pro gets the Opus-default premium list: Default(Opus 5.5, no 1M wording) + Sonnet + Haiku', () => {
    subState.pro = true
    subState.claudeAi = true
    subState.type = 'pro'
    const options = getModelOptions()
    expect(options.map(o => o.value)).toEqual([null, 'sonnet', 'haiku'])
    expect(options[0]).toEqual({
      value: null,
      label: 'Default (recommended)',
      // #078: Pro's default row now advertises Opus 5.5 (jk excludes Pro
      // from the [1m] merge, so no "with 1M context" wording).
      description: 'Opus 5.5 · Best for everyday, complex tasks',
    })
    // The premium branch shows Sonnet as the ALTERNATIVE row; no explicit
    // 'opus'-valued row exists (Opus is the default itself).
    expect(options.some(o => o.value === 'opus')).toBe(false)
  })

  test('Team Standard gets the same #078 promotion (Opus-default premium list, 1M merge wording)', () => {
    subState.team = true
    subState.claudeAi = true
    subState.type = 'team'
    const options = getModelOptions()
    expect(options.map(o => o.value)).toEqual([null, 'sonnet', 'haiku'])
    expect(options[0]?.description).toBe(
      'Opus 5.5 with 1M context · Best for everyday, complex tasks',
    )
  })

  test('Max keeps the premium list (unconditional tier head) with 1M merge wording', () => {
    subState.max = true
    subState.claudeAi = true
    subState.type = 'max'
    const options = getModelOptions()
    expect(options.map(o => o.value)).toEqual([null, 'sonnet', 'haiku'])
    expect(options[0]?.description).toBe(
      'Opus 5.5 with 1M context · Best for everyday, complex tasks',
    )
  })

  test('TeamPremium keeps the premium list with 1M merge wording', () => {
    subState.teamPremium = true
    subState.claudeAi = true
    subState.type = 'team_premium'
    const options = getModelOptions()
    expect(options.map(o => o.value)).toEqual([null, 'sonnet', 'haiku'])
    expect(options[0]?.description).toBe(
      'Opus 5.5 with 1M context · Best for everyday, complex tasks',
    )
  })

  test('non-Opus-tier subscriber (Enterprise) stays on the standard list: Sonnet default + merged Opus 5.5 1M alternative', () => {
    // The gate boundary: claudeAi subscriber but isOpusDefaultTier() false.
    subState.claudeAi = true
    subState.type = 'enterprise'
    const options = getModelOptions()
    expect(options.map(o => o.value)).toEqual([null, 'opus[1m]', 'haiku'])
    expect(options[0]?.description).toBe('Sonnet 5 · Efficient for routine tasks')
    expect(options[1]).toEqual({
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description:
        'Opus 5.5 with 1M context · Best for everyday, complex tasks',
      descriptionForModel:
        'Opus 5.5 with 1M context - best for everyday, complex tasks',
    })
  })
})

describe('getModelOptions wiring — extra-usage 1M rows per tier (kv / getMaxSonnet5_1MOption)', () => {
  beforeEach(() => {
    // null = "no disabled reason from API" → isExtraUsageEnabled() true →
    // checkOpus1mAccess()/checkSonnet1mAccess() true for subscribers.
    mockedGlobalConfig = { cachedExtraUsageDisabledReason: null }
  })

  test('Pro (merge disabled): separate Opus 5.5 1M row + Sonnet 1M row, billed as extra usage', () => {
    subState.pro = true
    subState.claudeAi = true
    subState.type = 'pro'
    const options = getModelOptions()
    expect(options.map(o => o.value)).toEqual([
      null,
      'opus[1m]',
      'sonnet',
      'sonnet[1m]',
      'haiku',
    ])
    expect(options[1]).toEqual({
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: `Opus 5.5 with 1M context · Billed as extra usage · ${OPUS55_BASE_PRICE}`,
    })
    expect(options[3]).toEqual({
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: `Sonnet 5 with 1M context · Billed as extra usage · ${SONNET5_PRICE}`,
    })
  })

  test('Max (merge enabled): NO separate Opus 1M row, Sonnet 1M row present', () => {
    subState.max = true
    subState.claudeAi = true
    subState.type = 'max'
    const options = getModelOptions()
    expect(options.map(o => o.value)).toEqual([
      null,
      'sonnet',
      'sonnet[1m]',
      'haiku',
    ])
    expect(options.some(o => o.value === 'opus[1m]')).toBe(false)
  })
})

describe('getModelOptions wiring — 3P-sonnet-probe demotion (tv) flips Pro off the premium branch', () => {
  test('Pro under an active 3P sonnet probe lands on the standard (Sonnet-default) list', () => {
    subState.pro = true
    subState.claudeAi = true
    subState.type = 'pro'
    withEnv({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5' }, () => {
      const options = getModelOptions()
      // Standard branch, Pro → merge disabled → getMaxOpusOption row.
      expect(options.map(o => o.value)).toEqual([null, 'opus', 'haiku'])
      expect(options[0]?.description).toBe(
        // The probe env IS the 3P sonnet default → getDefaultSonnetModel()
        // resolves 'claude-sonnet-4-5' → Sonnet 4.5 wording.
        'Sonnet 4.5 · Efficient for routine tasks',
      )
      expect(options[1]).toEqual({
        value: 'opus',
        label: 'Opus',
        description: 'Opus 5.5 · Best for everyday, complex tasks',
      })
    })
  })
})
