import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Hermetic for credential-less environments (CI runners): under CI=true /
// NODE_ENV=test the auth guard (src/utils/auth.ts) demands ANTHROPIC_API_KEY
// or CLAUDE_CODE_OAUTH_TOKEN before credential resolution. This suite is
// offline model-resolution logic; seed a dummy key when none is present.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * 2.1.280 #001 (Claude Opus 5.5 launch) + #078 (Pro & Team Standard default
 * model Sonnet → Opus).
 *
 * All expectations are byte-verified against the official Claude Code 2.1.280
 * linux-x64 binary (see comments per assertion).
 *
 * OCC-97 (Gap-97b) lesson: Bun mock.module registrations leak across test
 * files in the same worker — snapshot the real module exports BEFORE mocking
 * and restore them in afterAll.
 */
const actualAuthModule = await import('../../auth.js')
const actualAuthExports = { ...actualAuthModule }
const actualSettingsModule = await import('../../settings/settings.js')
const actualSettingsExports = { ...actualSettingsModule }

const subState = {
  max: false,
  pro: false,
  team: false,
  teamPremium: false,
  claudeAi: false,
  type: null as string | null,
}

let mockedSettings: Record<string, unknown> = {}

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

afterAll(() => {
  mock.module('../../auth.js', () => ({ ...actualAuthExports }))
  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
})

const {
  firstPartyNameToCanonical,
  getCanonicalName,
  getClaudeAiUserDefaultModelDescription,
  getDefaultMainLoopModelSetting,
  getDefaultOpusModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  isOpus1mMergeEnabled,
  isOpusDefaultTier,
  getOpus55PricingSuffix,
  parseUserSpecifiedModel,
} = await import('../model.js')
const { getModelOptions, getOpus55Option, getOpus55_1MOption, getMaxOpus55_1MOption } =
  await import('../modelOptions.js')
const {
  COST_TIER_4_20_CACHE_READ_0_20,
  COST_TIER_8_40,
  formatModelPricing,
  getModelCosts,
  getOpus55CostTier,
} = await import('../../modelCost.js')
const { getDefaultEffortForModel, modelSupportsEffort, modelSupportsMaxEffort } =
  await import('../../effort.js')
const { modelSupports1M } = await import('../../context.js')
const { resetModelStringsForTestingOnly } = await import('src/bootstrap/state.js')
const { LIGHTNING_BOLT } = await import('../../../constants/figures.js')

type Usage = Parameters<typeof getModelCosts>[1]

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
  for (const k of [
    'ANTHROPIC_DEFAULT_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT',
    'CLAUDE_CODE_3P_PROBE_WROTE_OPUS_DEFAULT',
    'CLAUDE_CODE_DISABLE_1M_CONTEXT',
    'CLAUDE_CODE_DISABLE_FAST_MODE',
    'USER_TYPE',
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  // getModelStrings()/initModelStrings caches provider-derived strings in the
  // session-global bootstrap/state singleton — reset so per-provider env in
  // one test can't leak into the next (same seam as model-defaults-207).
  resetModelStringsForTestingOnly()
})

// ---------------------------------------------------------------------------
// TASK 1 — #001: Claude Opus 5.5 launch
// ---------------------------------------------------------------------------

describe('2.1.280 #001: opus-5-5 cost tiers (binary @191977421 / Uh @193258260)', () => {
  test('base tier = tier_4_20_cache_read_0_20 {4,20,5,8,0.2,0.01}', () => {
    expect(COST_TIER_4_20_CACHE_READ_0_20).toEqual({
      inputTokens: 4,
      outputTokens: 20,
      promptCacheWriteTokens: 5,
      promptCacheWrite1hTokens: 8,
      promptCacheReadTokens: 0.2,
      webSearchRequests: 0.01,
    })
  })

  test('fast tier = Uh {8,40,10,16,0.4,0.01}', () => {
    expect(COST_TIER_8_40).toEqual({
      inputTokens: 8,
      outputTokens: 40,
      promptCacheWriteTokens: 10,
      promptCacheWrite1hTokens: 16,
      promptCacheReadTokens: 0.4,
      webSearchRequests: 0.01,
    })
  })

  test('getOpus55CostTier: base by default, fast tier when fast mode enabled', () => {
    expect(getOpus55CostTier(false)).toEqual(COST_TIER_4_20_CACHE_READ_0_20)
    expect(getOpus55CostTier(true)).toEqual(COST_TIER_8_40)
    // CLAUDE_CODE_DISABLE_FAST_MODE=1 forces the base tier even for fast
    withEnv({ CLAUDE_CODE_DISABLE_FAST_MODE: '1' }, () => {
      expect(getOpus55CostTier(true)).toEqual(COST_TIER_4_20_CACHE_READ_0_20)
    })
  })

  test('getModelCosts dispatches claude-opus-5-5 to the opus-5-5 tiers (Tze order)', () => {
    const fast = getModelCosts('claude-opus-5-5', { speed: 'fast' } as Usage)
    expect(fast).toEqual(COST_TIER_8_40)
    const base = getModelCosts('claude-opus-5-5', {} as Usage)
    expect(base).toEqual(COST_TIER_4_20_CACHE_READ_0_20)
    // Bedrock/Vertex IDs canonicalize into the same dispatch
    expect(getModelCosts('us.anthropic.claude-opus-5-5', {} as Usage)).toEqual(
      COST_TIER_4_20_CACHE_READ_0_20,
    )
    // The opus-5 branch is untouched and NOT shadowed
    const opus5 = getModelCosts('claude-opus-5', {} as Usage)
    expect(opus5.inputTokens).toBe(5)
    expect(opus5.outputTokens).toBe(25)
  })
})

describe('2.1.280 #001: canonicalization — opus-5-5 before opus-5 (substring hazard)', () => {
  test('claude-opus-5-5 canonicalizes to itself, not to claude-opus-5', () => {
    expect(firstPartyNameToCanonical('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(firstPartyNameToCanonical('us.anthropic.claude-opus-5-5')).toBe(
      'claude-opus-5-5',
    )
    expect(getCanonicalName('anthropic.claude-opus-5-5')).toBe('claude-opus-5-5')
  })

  test('claude-opus-5 still canonicalizes to claude-opus-5', () => {
    expect(firstPartyNameToCanonical('claude-opus-5')).toBe('claude-opus-5')
    expect(firstPartyNameToCanonical('us.anthropic.claude-opus-5')).toBe(
      'claude-opus-5',
    )
  })
})

describe('2.1.280 #001: getDefaultOpusModel per provider (alias table @191992378)', () => {
  test('firstParty → claude-opus-5-5', () => {
    expect(getDefaultOpusModel()).toBe('claude-opus-5-5')
  })

  test('bedrock → us.anthropic.claude-opus-5-5', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      expect(getDefaultOpusModel()).toContain('claude-opus-5-5')
    })
  })

  test('vertex → claude-opus-5-5', () => {
    withEnv({ CLAUDE_CODE_USE_VERTEX: '1' }, () => {
      expect(getDefaultOpusModel()).toBe('claude-opus-5-5')
    })
  })

  test('anthropic_aws → claude-opus-5-5', () => {
    withEnv({ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }, () => {
      expect(getDefaultOpusModel()).toBe('claude-opus-5-5')
    })
  })

  test('foundry lags at claude-opus-4-6 (per_provider.foundry)', () => {
    withEnv({ CLAUDE_CODE_USE_FOUNDRY: '1' }, () => {
      expect(getDefaultOpusModel()).toBe('claude-opus-4-6')
    })
  })
})

describe('2.1.280 #001: alias + [1m] suffix parsing', () => {
  test("'opus' resolves to claude-opus-5-5 on firstParty", () => {
    expect(parseUserSpecifiedModel('opus')).toBe('claude-opus-5-5')
  })

  test("'opus[1m]' resolves to claude-opus-5-5[1m]", () => {
    expect(parseUserSpecifiedModel('opus[1m]')).toBe('claude-opus-5-5[1m]')
  })

  test("'claude-opus-5-5[1m]' round-trips unchanged", () => {
    expect(parseUserSpecifiedModel('claude-opus-5-5[1m]')).toBe(
      'claude-opus-5-5[1m]',
    )
  })

  test("'claude-opus-5' is NOT upgraded to 5.5", () => {
    expect(parseUserSpecifiedModel('claude-opus-5')).toBe('claude-opus-5')
  })

  test('modelSupports1M covers claude-opus-5-5 (catalog supports_1m_suffix)', () => {
    expect(modelSupports1M('claude-opus-5-5')).toBe(true)
  })
})

describe('2.1.280 #001: display + marketing names', () => {
  test("getPublicModelDisplayName: 'Opus 5.5' / 'Opus 5.5 (1M context)'", () => {
    expect(getPublicModelDisplayName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(getPublicModelDisplayName('claude-opus-5-5[1m]')).toBe(
      'Opus 5.5 (1M context)',
    )
  })

  test('getMarketingNameForModel: Opus 5.5 before Opus 5 (substring order)', () => {
    expect(getMarketingNameForModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(getMarketingNameForModel('claude-opus-5-5[1m]')).toBe(
      'Opus 5.5 (1M context)',
    )
    // Opus 5 keeps its pre-existing OCC '(with 1M context)' divergence
    expect(getMarketingNameForModel('claude-opus-5')).toBe('Opus 5')
  })
})

describe('2.1.280 #001: picker option strings (Tv/_v/kv/Pg, byte-verified)', () => {
  const basePrice = formatModelPricing(COST_TIER_4_20_CACHE_READ_0_20)
  const fastPrice = formatModelPricing(COST_TIER_8_40)

  test('getOpus55Option (Tv) — value/label/description/descriptionForModel', () => {
    expect(getOpus55Option()).toEqual({
      value: 'opus',
      label: 'Opus',
      description: `Opus 5.5 · Best for everyday, complex tasks · ${basePrice}`,
      descriptionForModel: 'Opus 5.5 - best for everyday, complex tasks',
    })
    // fast-mode variant carries the (↯) indicator + fast pricing
    expect(getOpus55Option(true).description).toBe(
      `Opus 5.5 · Best for everyday, complex tasks · (${LIGHTNING_BOLT}) ${fastPrice}`,
    )
  })

  test('getOpus55_1MOption (_v) — value/label/description/descriptionForModel', () => {
    expect(getOpus55_1MOption()).toEqual({
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: `Opus 5.5 for long sessions · ${basePrice}`,
      descriptionForModel:
        'Opus 5.5 with 1M context window - for long sessions with large codebases',
    })
  })

  test('getMaxOpus55_1MOption (kv) — value/label/description', () => {
    expect(getMaxOpus55_1MOption()).toEqual({
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: `Opus 5.5 with 1M context · ${basePrice}`,
    })
  })

  test('getOpus55PricingSuffix mirrors hCt format (firstParty gate)', () => {
    expect(getOpus55PricingSuffix(false)).toBe(` · ${basePrice}`)
    expect(getOpus55PricingSuffix(true)).toBe(
      ` · (${LIGHTNING_BOLT}) ${fastPrice}`,
    )
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      expect(getOpus55PricingSuffix(false)).toBe('')
    })
  })

  test('merged 1M row (Pg) is the PAYG-1P picker Opus row', () => {
    // Non-subscriber firstParty: isOpus1mMergeEnabled() is true (jk mirror),
    // so the stock picker shows the merged row.
    expect(isOpus1mMergeEnabled()).toBe(true)
    const options = getModelOptions(false)
    const merged = options.find(
      o =>
        o.descriptionForModel ===
        'Opus 5.5 with 1M context - best for everyday, complex tasks',
    )
    expect(merged).toBeDefined()
    expect(merged?.value).toBe('opus[1m]')
    expect(merged?.label).toBe('Opus (1M context)')
    expect(merged?.description).toBe(
      'Opus 5.5 with 1M context · Best for everyday, complex tasks',
    )
    // Legacy Opus 5 rows must NOT appear as the newest pick (no plain
    // 'Opus 5 - best...' row in the stock 1P list)
    expect(
      options.some(
        o => o.descriptionForModel === 'Opus 5 - best for everyday, complex tasks',
      ),
    ).toBe(false)
  })
})

describe('2.1.280 #001: effort defaults (catalog default_effort:"medium" @191988119)', () => {
  test('getDefaultEffortForModel(claude-opus-5-5) → medium', () => {
    expect(getDefaultEffortForModel('claude-opus-5-5')).toBe('medium')
    // provider-suffixed IDs match too (includes-based)
    expect(getDefaultEffortForModel('us.anthropic.claude-opus-5-5')).toBe(
      'medium',
    )
  })

  test('effort/max_effort capabilities auto-match via the opus-5 substring', () => {
    expect(modelSupportsEffort('claude-opus-5-5')).toBe(true)
    expect(modelSupportsMaxEffort('claude-opus-5-5')).toBe(true)
  })

  test('opus-5 default effort is untouched (high fallback, no explicit branch)', () => {
    expect(getDefaultEffortForModel('claude-opus-5')).not.toBe('medium')
  })
})

// ---------------------------------------------------------------------------
// TASK 2 — #078: Pro & Team Standard default model Sonnet → Opus
// ---------------------------------------------------------------------------

describe('2.1.280 #078: isOpusDefaultTier (K7t port)', () => {
  test('Max and Team Premium → true (unconditional K7t head)', () => {
    subState.max = true
    subState.claudeAi = true
    subState.type = 'max'
    expect(isOpusDefaultTier()).toBe(true)
    resetSubs()
    subState.teamPremium = true
    subState.claudeAi = true
    subState.type = 'team_premium'
    expect(isOpusDefaultTier()).toBe(true)
  })

  test('Pro and Team Standard → true (the #078 delta; v278 I6t lacked these rows)', () => {
    subState.pro = true
    subState.claudeAi = true
    subState.type = 'pro'
    expect(isOpusDefaultTier()).toBe(true)
    resetSubs()
    subState.team = true
    subState.claudeAi = true
    subState.type = 'team'
    expect(isOpusDefaultTier()).toBe(true)
  })

  test('non-subscriber (PAYG) → false', () => {
    expect(isOpusDefaultTier()).toBe(false)
  })

  test('tv pin: 3P-probe sonnet default (sonnet env set, opus env unset) demotes Pro/Team', () => {
    subState.pro = true
    subState.claudeAi = true
    subState.type = 'pro'
    withEnv({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5' }, () => {
      expect(isOpusDefaultTier()).toBe(false)
    })
    // Marker equality (probe wrote the value itself) → NOT a user default → tier holds
    withEnv(
      {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'probe-marker',
        CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT: 'probe-marker',
      },
      () => {
        expect(isOpusDefaultTier()).toBe(true)
      },
    )
    // Both envs set → opusProbe true → tv false → tier holds
    withEnv(
      {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
      },
      () => {
        expect(isOpusDefaultTier()).toBe(true)
      },
    )
    // Max is immune to tv (K7t head is unconditional)
    resetSubs()
    subState.max = true
    subState.claudeAi = true
    subState.type = 'max'
    withEnv({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5' }, () => {
      expect(isOpusDefaultTier()).toBe(true)
    })
  })

  test('enforceAvailableModels suppresses tv (the `n` term)', () => {
    subState.pro = true
    subState.claudeAi = true
    subState.type = 'pro'
    mockedSettings = { enforceAvailableModels: true }
    withEnv({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5' }, () => {
      expect(isOpusDefaultTier()).toBe(true)
    })
  })
})

describe('2.1.280 #078: getDefaultMainLoopModelSetting per tier', () => {
  test('Pro → claude-opus-5-5 WITHOUT [1m] (jk excludes Pro, byte-verified)', () => {
    subState.pro = true
    subState.claudeAi = true
    subState.type = 'pro'
    expect(isOpus1mMergeEnabled()).toBe(false)
    expect(getDefaultMainLoopModelSetting()).toBe('claude-opus-5-5')
  })

  test('Team Standard → claude-opus-5-5[1m] when the 1M merge is enabled', () => {
    subState.team = true
    subState.claudeAi = true
    subState.type = 'team'
    expect(isOpus1mMergeEnabled()).toBe(true)
    expect(getDefaultMainLoopModelSetting()).toBe('claude-opus-5-5[1m]')
    // merge disabled (CLAUDE_CODE_DISABLE_1M_CONTEXT) → plain opus-5-5
    withEnv({ CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' }, () => {
      expect(getDefaultMainLoopModelSetting()).toBe('claude-opus-5-5')
    })
  })

  test('Max unchanged → claude-opus-5-5[1m]', () => {
    subState.max = true
    subState.claudeAi = true
    subState.type = 'max'
    expect(getDefaultMainLoopModelSetting()).toBe('claude-opus-5-5[1m]')
  })

  test('Team Premium unchanged → claude-opus-5-5[1m]', () => {
    subState.teamPremium = true
    subState.claudeAi = true
    subState.type = 'team_premium'
    expect(getDefaultMainLoopModelSetting()).toBe('claude-opus-5-5[1m]')
  })

  test('PAYG non-subscriber unchanged → Sonnet default', () => {
    const setting = getDefaultMainLoopModelSetting()
    expect(setting).toContain('claude-sonnet')
    expect(setting).not.toContain('opus')
  })

  test('tv-pinned Pro falls back to the Sonnet default', () => {
    subState.pro = true
    subState.claudeAi = true
    subState.type = 'pro'
    withEnv({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5' }, () => {
      const setting = getDefaultMainLoopModelSetting()
      expect(setting).not.toContain('opus')
    })
  })

  test('unknown subscription type fails closed on the merge (Team → plain opus)', () => {
    subState.team = true
    subState.claudeAi = true
    subState.type = null
    expect(isOpus1mMergeEnabled()).toBe(false)
    expect(getDefaultMainLoopModelSetting()).toBe('claude-opus-5-5')
  })
})

describe('2.1.280 #078: getClaudeAiUserDefaultModelDescription (_Mn port)', () => {
  test('Opus tier (Max, merge on) — 1M wording + optional fast pricing suffix', () => {
    subState.max = true
    subState.claudeAi = true
    subState.type = 'max'
    expect(getClaudeAiUserDefaultModelDescription()).toBe(
      'Opus 5.5 with 1M context · Best for everyday, complex tasks',
    )
    expect(getClaudeAiUserDefaultModelDescription(true)).toBe(
      `Opus 5.5 with 1M context · Best for everyday, complex tasks · (${LIGHTNING_BOLT}) ${formatModelPricing(COST_TIER_8_40)}`,
    )
  })

  test('Pro tier — no 1M wording (merge disabled for Pro)', () => {
    subState.pro = true
    subState.claudeAi = true
    subState.type = 'pro'
    expect(getClaudeAiUserDefaultModelDescription()).toBe(
      'Opus 5.5 · Best for everyday, complex tasks',
    )
  })

  test('non-subscriber → Sonnet wording', () => {
    expect(getClaudeAiUserDefaultModelDescription()).toBe(
      'Sonnet 5 · Efficient for routine tasks',
    )
  })
})
