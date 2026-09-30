import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Hermetic for credential-less environments (CI runners): under CI=true /
// NODE_ENV=test the auth guard (src/utils/auth.ts) demands ANTHROPIC_API_KEY
// or CLAUDE_CODE_OAUTH_TOKEN before credential resolution. This suite is
// offline model-resolution logic; seed a dummy key when none is present.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * 2.1.284 (OCC-101): Claude Sonnet 5.5 launch (`claude-sonnet-5-5`).
 *
 * All expectations are byte-verified against the official Claude Code 2.1.284
 * linux-x64 binary (v284 ELF offsets cited per block; see
 * docs/upstream-version-gap-occ101-2026-09.md §3 for the full forensics).
 * Key evidence sites:
 *   - baked catalog entry `claude-sonnet-5-5` @198712738 (S8n): pricing
 *     tier_2_10, default_effort "medium", max_output_tokens {128000,128000},
 *     knowledge_cutoff June 2026, fallback_3p "claude-sonnet-5",
 *     advisor_rank 3, capabilities incl. context_management,
 *     vertex_region_env_var VERTEX_REGION_CLAUDE_5_5_SONNET,
 *     provider_ids {bedrock: "us.anthropic.claude-sonnet-5-5", mantle:
 *     "anthropic.claude-sonnet-5-5", rest "claude-sonnet-5-5"}
 *   - canonicalization chain @200499405-200500100 (sonnet-5-5 BEFORE sonnet-5
 *     — substring hazard)
 *   - picker builders: yi("sonnet") @~203843935, ST() @203844509,
 *     wT() @203844326, fy() @203847312, MT() @203850393
 *
 * Mock-module discipline follows opus55Launch280.test.ts (OCC-97 Gap-97b
 * lesson: snapshot real exports BEFORE mocking, restore in afterAll).
 */
const actualAuthModule = await import('../../auth.js')
const actualAuthExports = { ...actualAuthModule }
const actualSettingsModule = await import('../../settings/settings.js')
const actualSettingsExports = { ...actualSettingsModule }
// Test-hygiene (OCC-141): the bedrock withEnv blocks below resolve
// getModelStrings() with null bootstrap state → initModelStrings() takes the
// bedrock branch → `void updateBedrockModelStrings()` fires a REAL (memoized)
// ListInferenceProfiles fetch. In an offline/shared test process its credential
// resolution hangs, occupying the module-level `sequential` queue and starving
// bedrockRegionPrefix.test.ts's beforeEach drain (4 × 5s timeouts in
// shared-process directory sweeps; invisible under ci-test.sh's per-file
// process isolation). Mock the fetch file-wide — same snapshot/restore
// discipline as auth/settings above.
const actualBedrockModule = await import('../bedrock.js')
const actualBedrockExports = { ...actualBedrockModule }

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

// Offline-safe bedrock inference-profile fetch (see hygiene note above).
mock.module('../bedrock.js', () => ({
  ...actualBedrockExports,
  getBedrockInferenceProfiles: async () => [],
}))

afterAll(() => {
  mock.module('../../auth.js', () => ({ ...actualAuthExports }))
  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
  mock.module('../bedrock.js', () => ({ ...actualBedrockExports }))
})

const {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultSonnetModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
} = await import('../model.js')
const {
  getModelOptions,
  getSonnet55Option,
  getSonnet5PreviousOption,
  getSonnet5_1MOption,
  getMaxSonnet5_1MOption,
} = await import('../modelOptions.js')
const {
  COST_TIER_2_10,
  formatModelPricing,
  getModelCosts,
} = await import('../../modelCost.js')
const { getDefaultEffortForModel } = await import('../../effort.js')
const { getModelMaxOutputTokens, modelSupports1M } = await import('../../context.js')
const { modelSupportsContextManagement } = await import('../../betas.js')
const { modelSupportsAdvisor, isValidAdvisorModel } = await import('../../advisor.js')
const { sanitizeModelName } = await import('../../commitAttribution.js')
const { getVertexRegionForModel } = await import('../../envUtils.js')
const { resetModelStringsForTestingOnly } = await import('src/bootstrap/state.js')

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
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_DISABLE_1M_CONTEXT',
    'VERTEX_REGION_CLAUDE_5_5_SONNET',
    'VERTEX_REGION_CLAUDE_5_SONNET',
    'USER_TYPE',
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  // getModelStrings()/initModelStrings caches provider-derived strings in the
  // session-global bootstrap/state singleton — reset so per-provider env in
  // one test can't leak into the next.
  resetModelStringsForTestingOnly()
})

describe('2.1.284: canonicalization — sonnet-5-5 before sonnet-5 (chain @200499405)', () => {
  test('claude-sonnet-5-5 canonicalizes to itself, not to claude-sonnet-5', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(firstPartyNameToCanonical('us.anthropic.claude-sonnet-5-5')).toBe(
      'claude-sonnet-5-5',
    )
    expect(getCanonicalName('anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
  })

  test('claude-sonnet-5 still canonicalizes to claude-sonnet-5', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(firstPartyNameToCanonical('us.anthropic.claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    )
  })
})

describe('2.1.284: default Sonnet flips to claude-sonnet-5-5 (alias table @198.71M region)', () => {
  test('firstParty getDefaultSonnetModel → claude-sonnet-5-5', () => {
    expect(getDefaultSonnetModel()).toBe('claude-sonnet-5-5')
  })

  test("'sonnet' alias resolves to claude-sonnet-5-5 (+[1m] suffix)", () => {
    expect(parseUserSpecifiedModel('sonnet')).toBe('claude-sonnet-5-5')
    expect(parseUserSpecifiedModel('sonnet[1m]')).toBe('claude-sonnet-5-5[1m]')
    expect(parseUserSpecifiedModel('claude-sonnet-5-5[1m]')).toBe(
      'claude-sonnet-5-5[1m]',
    )
  })

  test("'claude-sonnet-5' is NOT upgraded to 5.5", () => {
    expect(parseUserSpecifiedModel('claude-sonnet-5')).toBe('claude-sonnet-5')
  })

  test('bedrock default Sonnet uses the provider string (us.anthropic.* lag table unchanged)', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      // 3P default table is a separate per-provider lag (anthropic_aws/
      // gateway → 4-6, other 3P → 4-5) — untouched by the 5.5 launch except
      // that the 3P sonnet55 provider string exists for picker rows.
      expect(getDefaultSonnetModel()).toContain('claude-sonnet-4-5')
    })
  })
})

describe('2.1.284: display + marketing names (catalog display_name "Sonnet 5.5")', () => {
  test("getPublicModelDisplayName: 'Sonnet 5.5' / 'Sonnet 5.5 (1M context)'", () => {
    expect(getPublicModelDisplayName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(getPublicModelDisplayName('claude-sonnet-5-5[1m]')).toBe(
      'Sonnet 5.5 (1M context)',
    )
  })

  test('getMarketingNameForModel: Sonnet 5.5 before Sonnet 5 (substring order)', () => {
    expect(getMarketingNameForModel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(getMarketingNameForModel('claude-sonnet-5-5[1m]')).toBe(
      'Sonnet 5.5 (1M context)',
    )
    expect(getMarketingNameForModel('claude-sonnet-5')).toBe('Sonnet 5')
  })
})

describe('2.1.284: cost tier (catalog pricing "tier_2_10" @198712738)', () => {
  test('getModelCosts dispatches claude-sonnet-5-5 to tier_2_10', () => {
    expect(getModelCosts('claude-sonnet-5-5', {} as Usage)).toEqual(COST_TIER_2_10)
    expect(getModelCosts('us.anthropic.claude-sonnet-5-5', {} as Usage)).toEqual(
      COST_TIER_2_10,
    )
    // claude-sonnet-5 keeps the same 2/10 tier (2.1.243 repricing) — the
    // dispatch must not shadow it
    expect(getModelCosts('claude-sonnet-5', {} as Usage)).toEqual(COST_TIER_2_10)
  })
})

describe('2.1.284: effort + context (catalog default_effort "medium", max_output_tokens 128k/128k)', () => {
  test('getDefaultEffortForModel(claude-sonnet-5-5) → medium', () => {
    expect(getDefaultEffortForModel('claude-sonnet-5-5')).toBe('medium')
    expect(getDefaultEffortForModel('us.anthropic.claude-sonnet-5-5')).toBe(
      'medium',
    )
  })

  test('claude-sonnet-5 default effort stays NOT medium (catalog "high" → API fallback)', () => {
    expect(getDefaultEffortForModel('claude-sonnet-5')).not.toBe('medium')
  })

  test('getModelMaxOutputTokens: sonnet-5-5 → 128000/128000; sonnet-5 → 64000/128000', () => {
    expect(getModelMaxOutputTokens('claude-sonnet-5-5')).toEqual({
      default: 128_000,
      upperLimit: 128_000,
    })
    expect(getModelMaxOutputTokens('claude-sonnet-5')).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    })
  })

  test('modelSupports1M covers claude-sonnet-5-5 (catalog supports_1m_beta)', () => {
    expect(modelSupports1M('claude-sonnet-5-5')).toBe(true)
  })

  test('modelSupportsContextManagement covers sonnet-5/sonnet-5-5 on 3P (catalog capability)', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      expect(modelSupportsContextManagement('us.anthropic.claude-sonnet-5-5')).toBe(
        true,
      )
      expect(modelSupportsContextManagement('us.anthropic.claude-sonnet-5')).toBe(
        true,
      )
      // 3.x models remain excluded on 3P (prefix arms are all 4/5-generation)
      expect(modelSupportsContextManagement('claude-3-5-haiku')).toBe(false)
    })
  })
})

describe('2.1.284: advisor (catalog advisor_rank:3 on sonnet-5 AND sonnet-5-5)', () => {
  test('modelSupportsAdvisor / isValidAdvisorModel cover sonnet-5-5 and sonnet-5', () => {
    expect(modelSupportsAdvisor('claude-sonnet-5-5')).toBe(true)
    expect(modelSupportsAdvisor('claude-sonnet-5')).toBe(true)
    expect(isValidAdvisorModel('claude-sonnet-5-5')).toBe(true)
    expect(isValidAdvisorModel('claude-sonnet-5')).toBe(true)
    // untouched neighbor
    expect(modelSupportsAdvisor('claude-haiku-4-5')).toBe(false)
  })
})

describe('2.1.284: commit attribution sanitize chain (official @200499405 order)', () => {
  test('sonnet-5-5 → claude-sonnet-5-5; sonnet-5 → claude-sonnet-5', () => {
    expect(sanitizeModelName('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(sanitizeModelName('claude-sonnet-5')).toBe('claude-sonnet-5')
  })

  test('opus-5-5 drift fix: no longer mislabeled claude-opus-5', () => {
    expect(sanitizeModelName('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(sanitizeModelName('claude-opus-5')).toBe('claude-opus-5')
  })
})

describe('2.1.284: Vertex region override (catalog vertex_region_env_var)', () => {
  test('claude-sonnet-5-5 reads VERTEX_REGION_CLAUDE_5_5_SONNET (not the -5 var)', () => {
    withEnv(
      {
        VERTEX_REGION_CLAUDE_5_5_SONNET: 'asia-southeast1',
        VERTEX_REGION_CLAUDE_5_SONNET: 'europe-west1',
      },
      () => {
        expect(getVertexRegionForModel('claude-sonnet-5-5')).toBe('asia-southeast1')
        expect(getVertexRegionForModel('claude-sonnet-5')).toBe('europe-west1')
      },
    )
  })
})

describe('2.1.284: picker rows (yi @~203843935 / ST @203844509 / wT @203844326 / fy @203847312 / MT @203850393)', () => {
  const sonnet55Price = formatModelPricing(COST_TIER_2_10)

  test('getSonnet55Option (yi render) — firstParty', () => {
    expect(getSonnet55Option()).toEqual({
      value: 'sonnet',
      label: 'Sonnet',
      description: `Sonnet 5.5 · Efficient for routine tasks · ${sonnet55Price}`,
      descriptionForModel:
        'Sonnet 5.5 - efficient for routine tasks. Generally recommended for most coding tasks',
    })
  })

  test('getSonnet55Option — 3P uses the provider string, no pricing suffix', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      const opt = getSonnet55Option()
      expect(opt.value).toBe('us.anthropic.claude-sonnet-5-5')
      expect(opt.description).toBe('Sonnet 5.5 · Efficient for routine tasks')
    })
  })

  test('getSonnet5PreviousOption (ST, NEW in v284) — firstParty', () => {
    expect(getSonnet5PreviousOption()).toEqual({
      value: 'claude-sonnet-5',
      label: 'Sonnet 5',
      description: 'Sonnet 5 · Previous Sonnet version',
      descriptionForModel: 'Sonnet 5 - previous Sonnet version',
    })
  })

  test('getSonnet5PreviousOption — 3P uses the provider string', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      expect(getSonnet5PreviousOption().value).toBe('us.anthropic.claude-sonnet-5')
    })
  })

  test('getSonnet5_1MOption (fy non-subscriber branch) — firstParty', () => {
    expect(getSonnet5_1MOption()).toEqual({
      value: 'sonnet[1m]',
      label: 'Sonnet 5.5 (1M context)',
      description: `Sonnet 5.5 for long sessions · ${sonnet55Price}`,
      descriptionForModel:
        'Sonnet 5.5 with 1M context window - for long sessions with large codebases',
    })
  })

  test('getMaxSonnet5_1MOption (fy ut() subscriber branch) — no billing/pricing line', () => {
    expect(getMaxSonnet5_1MOption()).toEqual({
      value: 'sonnet[1m]',
      label: 'Sonnet 5.5 (1M context)',
      description: 'Sonnet 5.5 for long sessions',
      descriptionForModel:
        'Sonnet 5.5 with 1M context window - for long sessions with large codebases',
    })
  })

  test('PAYG-3P assembly: ST() row lands before the Legacy 4.6 row (v284 delta)', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      const options = getModelOptions()
      const prevIdx = options.findIndex(
        o => o.description === 'Sonnet 5 · Previous Sonnet version',
      )
      const legacyIdx = options.findIndex(o => o.description === 'Sonnet 4.6 · Legacy')
      expect(prevIdx).toBeGreaterThan(-1)
      expect(legacyIdx).toBeGreaterThan(-1)
      expect(prevIdx).toBeLessThan(legacyIdx)
    })
  })

  test('stock PAYG-1P picker carries the Sonnet 5.5 1M row', () => {
    const options = getModelOptions()
    const row = options.find(o => o.value === 'sonnet[1m]')
    expect(row?.label).toBe('Sonnet 5.5 (1M context)')
    expect(row?.description).toBe(`Sonnet 5.5 for long sessions · ${sonnet55Price}`)
  })

  test('subscriber default row wording follows the catalog-latest sonnet (MT render)', () => {
    subState.max = true
    subState.claudeAi = true
    subState.type = 'max'
    const options = getModelOptions()
    const sonnetRow = options.find(o => o.value === 'sonnet')
    expect(sonnetRow?.description).toBe('Sonnet 5.5 · Efficient for routine tasks')
  })
})
