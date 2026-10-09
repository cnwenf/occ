import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_SRC = join(import.meta.dir, '..', '..', '..')

// Hermetic for credential-less environments (CI runners): under CI=true /
// NODE_ENV=test the auth guard (src/utils/auth.ts) demands ANTHROPIC_API_KEY
// or CLAUDE_CODE_OAUTH_TOKEN before credential resolution. This suite is
// offline model-resolution logic; seed a dummy key when none is present.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * 2.1.293 (OCC-111): Claude Haiku 5.5 launch (`claude-haiku-5-5`).
 *
 * All expectations are byte-verified against the official Claude Code 2.1.293
 * linux-x64 binary (v293 ELF offsets cited per block; see
 * /tmp/occ111-research/haiku55-extracts.md for the full forensics). Key
 * evidence sites:
 *   - baked catalog entry `claude-haiku-5-5` @204773604: pricing `haiku_55`,
 *     default_effort "medium", max_output_tokens {128000,128000},
 *     knowledge_cutoff June 2026, context {window:1e6,native_1m:true,
 *     supports_1m_beta:true}, fallback_3p "claude-haiku-4-5",
 *     advisor_rank 4, vertex_region_env_var VERTEX_REGION_CLAUDE_HAIKU_5_5,
 *     provider_ids {first_party/vertex/foundry/anthropic_aws/
 *     anthropic_google_cloud: "claude-haiku-5-5", bedrock:
 *     "us.anthropic.claude-haiku-5-5", mantle: "anthropic.claude-haiku-5-5"}
 *     — NO date suffix on any provider id (unlike haiku 4.5 `-20251001`)
 *   - pricing `haiku_55` @204772202 incl. the NEW `long_prompt` tier
 *     (above_prompt_tokens 1e5)
 *   - alias flip @204789153: haiku default "claude-haiku-5-5"; per_provider
 *     lag table keeps ALL 3P (bedrock/vertex/foundry/mantle/anthropic_aws/
 *     anthropic_google_cloud/gateway) at "claude-haiku-4-5"
 *   - latest_per_family.haiku → "claude-haiku-5-5"
 *   - early-stopping guidance gate `ULo` @214379050: capability
 *     `haiku_5_5_early_stopping_guidance` AND growthbook
 *     `tengu_idempotent_wolf` (default true) → HLo text (@214376484)
 *
 * Mock-module discipline follows sonnet55Launch284.test.ts (OCC-101) /
 * opus55Launch280.test.ts (OCC-97 Gap-97b lesson: snapshot real exports
 * BEFORE mocking, restore in afterAll).
 */
const subState = {
  max: false,
  pro: false,
  team: false,
  teamPremium: false,
  claudeAi: false,
  type: null as string | null,
}

let mockedSettings: Record<string, unknown> = {}

// Deferred mock registration (OCC-101 P3-8): snapshot real exports inside
// beforeAll so this file never freezes another file's still-active mock as
// "actual". The bedrock.js stub prevents the REAL memoized ~2s AWS profile
// fetch from firing and corrupting session-global STATE mid-run.
let actualAuthExports: Record<string, unknown> = {}
let actualSettingsExports: Record<string, unknown> = {}
let actualBedrockExports: Record<string, unknown> = {}
let actualGrowthbookExports: Record<string, unknown> = {}

beforeAll(async () => {
  actualAuthExports = { ...((await import('../../auth.js')) as object) }
  actualSettingsExports = {
    ...((await import('../../settings/settings.js')) as object),
  }
  actualBedrockExports = { ...((await import('../bedrock.js')) as object) }
  actualGrowthbookExports = {
    ...((await import('../../../services/analytics/growthbook.js')) as object),
  }
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
  mock.module('../bedrock.js', () => ({
    ...actualBedrockExports,
    getBedrockInferenceProfiles: async () => [],
  }))
})

afterAll(() => {
  mock.module('../../auth.js', () => ({ ...actualAuthExports }))
  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
  mock.module('../bedrock.js', () => ({ ...actualBedrockExports }))
  mock.module('../../../services/analytics/growthbook.js', () => ({
    ...actualGrowthbookExports,
  }))
})

const {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultHaikuModel,
  getSmallFastModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
  resolveSkillModelOverride,
} = await import('../model.js')
const { getModelOptions, getHaiku55Option } = await import('../modelOptions.js')
const { ALL_MODEL_CONFIGS, CLAUDE_HAIKU_5_5_CONFIG } = await import('../configs.js')
const {
  CANONICAL_MODEL_CATALOG,
  latestCanonicalModelForFamily,
} = await import('../modelDescriptors.js')
const { isModelRecognized } = await import('../unrecognizedModelSignal.js')
const {
  COST_HAIKU_45,
  COST_HAIKU_55,
  formatModelPricing,
  getModelCosts,
} = await import('../../modelCost.js')
const {
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
} = await import('../../effort.js')
const { getModelMaxOutputTokens, modelSupports1M } = await import('../../context.js')
const { modelSupportsContextManagement } = await import('../../betas.js')
const { modelSupportsAdaptiveThinking } = await import('../../thinking.js')
const {
  modelHasLeanPrompt,
  shouldUseFullSystemPrompt,
} = await import('../../effort/leanPrompt.js')
const { modelSupportsAdvisor, isValidAdvisorModel } = await import('../../advisor.js')
const { sanitizeModelName } = await import('../../commitAttribution.js')
const { getVertexRegionForModel } = await import('../../envUtils.js')
const {
  EARLY_STOPPING_GUIDANCE_FLAG,
  HAIKU_5_5_EARLY_STOPPING_GUIDANCE,
  getEarlyStoppingGuidanceSection,
  isEarlyStoppingGuidanceEnabled,
} = await import('../../../constants/earlyStoppingGuidance.js')
const { computeSimpleEnvInfo } = await import('../../../constants/prompts.js')
const { resetModelStringsForTestingOnly } = await import('../../../bootstrap/state.js')

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
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_MANTLE',
    'CLAUDE_CODE_DISABLE_1M_CONTEXT',
    'VERTEX_REGION_CLAUDE_HAIKU_5_5',
    'VERTEX_REGION_CLAUDE_HAIKU_4_5',
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

describe('2.1.293: catalog provider ids (baked catalog @204773604)', () => {
  test('CLAUDE_HAIKU_5_5_CONFIG matches the official provider_ids table', () => {
    // Verbatim from the v293 catalog entry. NO date suffix on any provider id
    // (unlike haiku 4.5 `-20251001`); vertex id is bare (no @date); gateway
    // is NOT in the official provider_ids — OCC's ModelConfig type requires
    // the slot, filled per the OCC convention (gateway = bare first-party
    // id; the official gateway alias lag lives in getDefaultHaikuModel).
    expect(CLAUDE_HAIKU_5_5_CONFIG).toEqual({
      firstParty: 'claude-haiku-5-5',
      bedrock: 'us.anthropic.claude-haiku-5-5',
      vertex: 'claude-haiku-5-5',
      foundry: 'claude-haiku-5-5',
      anthropic_aws: 'claude-haiku-5-5',
      mantle: 'anthropic.claude-haiku-5-5',
      gateway: 'claude-haiku-5-5',
    })
  })

  test('ALL_MODEL_CONFIGS registers haiku55', () => {
    expect(ALL_MODEL_CONFIGS.haiku55).toBe(CLAUDE_HAIKU_5_5_CONFIG)
  })

  test("latest_per_family.haiku → 'claude-haiku-5-5' (alias table @204789153)", () => {
    expect(latestCanonicalModelForFamily('haiku')).toBe('claude-haiku-5-5')
    // alphabetical catalog: haiku-4-5 precedes haiku-5-5
    expect(CANONICAL_MODEL_CATALOG.indexOf('claude-haiku-4-5')).toBeLessThan(
      CANONICAL_MODEL_CATALOG.indexOf('claude-haiku-5-5'),
    )
  })

  test('isModelRecognized accepts both haiku generations', () => {
    expect(isModelRecognized('claude-haiku-5-5')).toBe(true)
    expect(isModelRecognized('claude-haiku-4-5-20251001')).toBe(true)
  })
})

describe('2.1.293: canonicalization — haiku-5-5 arm before haiku-4-5', () => {
  test('claude-haiku-5-5 canonicalizes to itself across provider prefixes', () => {
    expect(firstPartyNameToCanonical('claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(firstPartyNameToCanonical('us.anthropic.claude-haiku-5-5')).toBe(
      'claude-haiku-5-5',
    )
    expect(getCanonicalName('anthropic.claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(getCanonicalName('claude-haiku-5-5[1m]')).toBe('claude-haiku-5-5')
  })

  test('claude-haiku-4-5 still canonicalizes to claude-haiku-4-5', () => {
    expect(firstPartyNameToCanonical('claude-haiku-4-5')).toBe('claude-haiku-4-5')
    expect(
      firstPartyNameToCanonical('us.anthropic.claude-haiku-4-5-20251001-v1:0'),
    ).toBe('claude-haiku-4-5')
  })
})

describe('2.1.293: default Haiku flips to claude-haiku-5-5 (alias table @204789153)', () => {
  function haikuDefaultWith(env: Record<string, string>): string {
    // getModelStrings caches provider-derived strings in session-global
    // state — reset before each provider switch.
    resetModelStringsForTestingOnly()
    let result = ''
    withEnv(env, () => {
      result = getDefaultHaikuModel()
    })
    return result
  }

  test('firstParty getDefaultHaikuModel → claude-haiku-5-5', () => {
    expect(getDefaultHaikuModel()).toBe('claude-haiku-5-5')
  })

  test('getSmallFastModel follows the haiku default (firstParty)', () => {
    expect(getSmallFastModel()).toBe('claude-haiku-5-5')
    withEnv({ ANTHROPIC_SMALL_FAST_MODEL: 'my-fast-pin' }, () => {
      expect(getSmallFastModel()).toBe('my-fast-pin')
    })
  })

  // EXACT per-provider default pins — the official alias table keeps ALL 3P
  // providers (bedrock/vertex/foundry/mantle/anthropic_aws/
  // anthropic_google_cloud/gateway) at "claude-haiku-4-5" in v293:
  //   haiku:{default:"claude-haiku-5-5",per_provider:{bedrock:"claude-haiku-4-5",
  //     vertex:"claude-haiku-4-5",foundry:"claude-haiku-4-5",mantle:"claude-haiku-4-5",
  //     anthropic_aws:"claude-haiku-4-5",anthropic_google_cloud:"claude-haiku-4-5",
  //     gateway:"claude-haiku-4-5"}}
  // resolved through each provider's CONFIG string (configs.ts).
  test('vertex → claude-haiku-4-5@20251001', () => {
    expect(haikuDefaultWith({ CLAUDE_CODE_USE_VERTEX: '1' })).toBe(
      'claude-haiku-4-5@20251001',
    )
  })

  test('foundry → claude-haiku-4-5', () => {
    expect(haikuDefaultWith({ CLAUDE_CODE_USE_FOUNDRY: '1' })).toBe(
      'claude-haiku-4-5',
    )
  })

  test('mantle → anthropic.claude-haiku-4-5', () => {
    expect(haikuDefaultWith({ CLAUDE_CODE_USE_MANTLE: '1' })).toBe(
      'anthropic.claude-haiku-4-5',
    )
  })

  test('anthropic_aws → claude-haiku-4-5', () => {
    expect(haikuDefaultWith({ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' })).toBe(
      'claude-haiku-4-5',
    )
  })

  test('ANTHROPIC_DEFAULT_HAIKU_MODEL wins over every provider branch', () => {
    for (const env of [
      {},
      { CLAUDE_CODE_USE_VERTEX: '1' },
      { CLAUDE_CODE_USE_FOUNDRY: '1' },
      { CLAUDE_CODE_USE_MANTLE: '1' },
      { CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' },
    ]) {
      expect(
        haikuDefaultWith({ ...env, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku-pin' }),
      ).toBe('custom-haiku-pin')
    }
  })

  test("bedrock → us.anthropic.claude-haiku-4-5-20251001-v1:0 (LAST: profile-fetch stub)", () => {
    expect(haikuDefaultWith({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    )
  })
})

describe('2.1.293: alias resolution (parseUserSpecifiedModel)', () => {
  test("'haiku' alias resolves to claude-haiku-5-5 (+[1m] suffix)", () => {
    expect(parseUserSpecifiedModel('haiku')).toBe('claude-haiku-5-5')
    expect(parseUserSpecifiedModel('haiku[1m]')).toBe('claude-haiku-5-5[1m]')
    expect(parseUserSpecifiedModel('claude-haiku-5-5[1m]')).toBe(
      'claude-haiku-5-5[1m]',
    )
  })

  test("'claude-haiku-4-5' is NOT upgraded to 5.5", () => {
    expect(parseUserSpecifiedModel('claude-haiku-4-5')).toBe('claude-haiku-4-5')
  })

  test("skill override 'haiku' inherits [1m] from a 1M main-loop model", () => {
    // resolveSkillModelOverride preserves the raw alias and appends '[1m]'
    // when the resolved model supports 1M. Post-launch 'haiku' →
    // claude-haiku-5-5 (native_1m + supports_1m_beta) so the inheritance arm
    // now fires and returns 'haiku[1m]'; pre-launch it resolved to haiku-4-5
    // (no 1M) and returned bare 'haiku'. The exact '[1m]' suffix is the flip.
    expect(
      resolveSkillModelOverride('haiku', 'claude-sonnet-5-5[1m]'),
    ).toBe('haiku[1m]')
  })
})

describe('2.1.293: display + marketing names (catalog display_name "Haiku 5.5")', () => {
  test("getPublicModelDisplayName: 'Haiku 5.5' / 'Haiku 5.5 (1M context)'", () => {
    expect(getPublicModelDisplayName('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(getPublicModelDisplayName('claude-haiku-5-5[1m]')).toBe(
      'Haiku 5.5 (1M context)',
    )
  })

  test("getMarketingNameForModel: 'Haiku 5.5' / 'Haiku 5.5 (1M context)'", () => {
    expect(getMarketingNameForModel('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(getMarketingNameForModel('claude-haiku-5-5[1m]')).toBe(
      'Haiku 5.5 (1M context)',
    )
    expect(getMarketingNameForModel('us.anthropic.claude-haiku-5-5')).toBe(
      'Haiku 5.5',
    )
  })

  test("haiku 4.5 display names unchanged", () => {
    // getPublicModelDisplayName switches on exact provider strings — the
    // firstParty haiku-4-5 string keeps its date suffix in v293.
    expect(getPublicModelDisplayName('claude-haiku-4-5-20251001')).toBe(
      'Haiku 4.5',
    )
    expect(getMarketingNameForModel('claude-haiku-4-5')).toBe('Haiku 4.5')
  })
})

describe('2.1.293: pricing haiku_55 (@204772202) incl. long_prompt tier', () => {
  const baseUsage: Usage = {} as Usage

  test('base numbers verbatim from the official table', () => {
    expect(COST_HAIKU_55.inputTokens).toBe(0.1)
    expect(COST_HAIKU_55.outputTokens).toBe(0.5)
    expect(COST_HAIKU_55.promptCacheWriteTokens).toBe(0.125)
    expect(COST_HAIKU_55.promptCacheWrite1hTokens).toBe(0.2)
    expect(COST_HAIKU_55.promptCacheReadTokens).toBe(0.01)
    expect(COST_HAIKU_55.webSearchRequests).toBe(0.01)
  })

  test('long_prompt tier verbatim (NEW shape — above_prompt_tokens 1e5)', () => {
    expect(COST_HAIKU_55.longPrompt).toEqual({
      abovePromptTokens: 100_000,
      inputTokens: 0.5,
      outputTokens: 2.5,
      promptCacheWriteTokens: 0.625,
      promptCacheWrite1hTokens: 1,
      promptCacheReadTokens: 0.05,
    })
  })

  test('haiku 4.5 pricing unchanged and has NO long_prompt tier', () => {
    expect(COST_HAIKU_45.inputTokens).toBe(1)
    expect(COST_HAIKU_45.outputTokens).toBe(5)
    expect(COST_HAIKU_45.longPrompt).toBeUndefined()
  })

  test('formatModelPricing renders $0.10/$0.50 per Mtok', () => {
    expect(formatModelPricing(COST_HAIKU_55)).toBe('$0.10/$0.50 per Mtok')
  })

  test('getModelCosts resolves haiku-5-5 (provider prefixes too)', () => {
    for (const id of [
      'claude-haiku-5-5',
      'us.anthropic.claude-haiku-5-5',
      'anthropic.claude-haiku-5-5',
      'claude-haiku-5-5[1m]',
    ]) {
      const costs = getModelCosts(id, baseUsage)
      expect(costs.inputTokens).toBe(0.1)
      expect(costs.outputTokens).toBe(0.5)
    }
    // haiku 4.5 keeps its own tier
    expect(getModelCosts('claude-haiku-4-5', baseUsage).inputTokens).toBe(1)
  })
})

describe('2.1.293: context window / 1M support (native_1m + supports_1m_beta)', () => {
  test('modelSupports1M covers haiku-5-5 (not haiku-4-5)', () => {
    expect(modelSupports1M('claude-haiku-5-5')).toBe(true)
    expect(modelSupports1M('claude-haiku-5-5[1m]')).toBe(true)
    expect(modelSupports1M('us.anthropic.claude-haiku-5-5')).toBe(true)
    expect(modelSupports1M('claude-haiku-4-5')).toBe(false)
  })
})

describe('2.1.293: max output tokens {default:128000, upper:128000}', () => {
  test('haiku-5-5 → 128000/128000', () => {
    expect(getModelMaxOutputTokens('claude-haiku-5-5')).toEqual({
      default: 128_000,
      upperLimit: 128_000,
    })
    expect(getModelMaxOutputTokens('claude-haiku-5-5[1m]')).toEqual({
      default: 128_000,
      upperLimit: 128_000,
    })
  })

  test('haiku-4-5 stays 32000/64000 (unchanged)', () => {
    expect(getModelMaxOutputTokens('claude-haiku-4-5')).toEqual({
      default: 32_000,
      upperLimit: 64_000,
    })
  })
})

describe('2.1.293: effort capabilities (effort/max_effort/xhigh_effort + default_effort medium)', () => {
  test('modelSupportsEffort / Max / Xhigh cover haiku-5-5', () => {
    expect(modelSupportsEffort('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsMaxEffort('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsXhighEffort('claude-haiku-5-5')).toBe(true)
  })

  test('haiku-4-5 stays effort-less', () => {
    expect(modelSupportsEffort('claude-haiku-4-5')).toBe(false)
  })

  test("getDefaultEffortForModel('claude-haiku-5-5') → 'medium' (catalog default_effort)", () => {
    expect(getDefaultEffortForModel('claude-haiku-5-5')).toBe('medium')
  })
})

describe('2.1.293: adaptive thinking + lean prompt capabilities', () => {
  test('modelSupportsAdaptiveThinking covers haiku-5-5 only', () => {
    expect(modelSupportsAdaptiveThinking('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-haiku-4-5')).toBe(false)
  })

  test('modelHasLeanPrompt covers haiku-5-5; full-prompt path bypassed', () => {
    expect(modelHasLeanPrompt('claude-haiku-5-5')).toBe(true)
    expect(shouldUseFullSystemPrompt('claude-haiku-5-5')).toBe(false)
    // haiku-4-5 keeps the full prompt (haiku full-prompt arm unchanged)
    expect(modelHasLeanPrompt('claude-haiku-4-5')).toBe(false)
    expect(shouldUseFullSystemPrompt('claude-haiku-4-5')).toBe(true)
  })
})

describe('2.1.293: context_management capability on 3P (betas)', () => {
  test('modelSupportsContextManagement covers haiku-5-5', () => {
    expect(modelSupportsContextManagement('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsContextManagement('us.anthropic.claude-haiku-5-5')).toBe(
      true,
    )
  })
})

describe('2.1.293: advisor_rank 4 (advisor allowlists)', () => {
  test('modelSupportsAdvisor / isValidAdvisorModel cover haiku-5-5', () => {
    expect(modelSupportsAdvisor('claude-haiku-5-5')).toBe(true)
    expect(isValidAdvisorModel('claude-haiku-5-5')).toBe(true)
  })

  test('haiku-4-5 stays advisor-ineligible', () => {
    expect(modelSupportsAdvisor('claude-haiku-4-5')).toBe(false)
    expect(isValidAdvisorModel('claude-haiku-4-5')).toBe(false)
  })
})

describe('2.1.293: commit attribution sanitize + vertex region env var', () => {
  test("sanitizeModelName maps haiku 5.5 → 'claude-haiku-5-5' (4.5 unchanged)", () => {
    expect(sanitizeModelName('claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(sanitizeModelName('us.anthropic.claude-haiku-5-5')).toBe(
      'claude-haiku-5-5',
    )
    expect(sanitizeModelName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
  })

  test('catalog vertex_region_env_var VERTEX_REGION_CLAUDE_HAIKU_5_5', () => {
    // getVertexRegionForModel reads process.env[<mapped var>] and returns its
    // VALUE (falling back to the default region). Seed distinct values to prove
    // each haiku generation maps to its own catalog vertex_region_env_var.
    process.env.VERTEX_REGION_CLAUDE_HAIKU_5_5 = 'haiku55-region'
    process.env.VERTEX_REGION_CLAUDE_HAIKU_4_5 = 'haiku45-region'
    try {
      expect(getVertexRegionForModel('claude-haiku-5-5')).toBe(
        'haiku55-region',
      )
      // haiku 4.5 keeps its own var (dated provider id too)
      expect(getVertexRegionForModel('claude-haiku-4-5-20251001')).toBe(
        'haiku45-region',
      )
    } finally {
      delete process.env.VERTEX_REGION_CLAUDE_HAIKU_5_5
      delete process.env.VERTEX_REGION_CLAUDE_HAIKU_4_5
    }
  })
})

describe('2.1.293: knowledge cutoff June 2026 + env-info model IDs', () => {
  test("computeSimpleEnvInfo('claude-haiku-5-5') carries the June 2026 cutoff", async () => {
    const info = await computeSimpleEnvInfo('claude-haiku-5-5')
    expect(info).toContain('Assistant knowledge cutoff is June 2026.')
    expect(info).toContain('Haiku 5.5')
  })

  test('latest-model-IDs sentence renders Haiku 5.5', async () => {
    const info = await computeSimpleEnvInfo('claude-haiku-5-5')
    expect(info).toContain("Haiku 5.5: 'claude-haiku-5-5'")
  })

  test('haiku 4.5 cutoff stays February 2025', async () => {
    const info = await computeSimpleEnvInfo('claude-haiku-4-5-20251001')
    expect(info).toContain('Assistant knowledge cutoff is February 2025.')
  })
})

describe('2.1.293: heron_brook early-stopping guidance (ULo gate @214379050)', () => {
  test('flag + capability constants match the official strings', () => {
    expect(EARLY_STOPPING_GUIDANCE_FLAG).toBe('tengu_idempotent_wolf')
    // HLo verbatim anchors (first + last sentence of the 5-paragraph literal)
    expect(
      HAIKU_5_5_EARLY_STOPPING_GUIDANCE.startsWith(
        'The reasoning effort setting changes how much you think before you act.',
      ),
    ).toBe(true)
    expect(
      HAIKU_5_5_EARLY_STOPPING_GUIDANCE.endsWith(
        'A question at the end of finished work costs the user one reply, the same as a question asked before any work.',
      ),
    ).toBe(true)
  })

  test('haiku-5-5 → section present (capability gate, flag default true)', () => {
    expect(isEarlyStoppingGuidanceEnabled('claude-haiku-5-5')).toBe(true)
    expect(getEarlyStoppingGuidanceSection('claude-haiku-5-5')).toBe(
      HAIKU_5_5_EARLY_STOPPING_GUIDANCE,
    )
    // provider-prefixed ids resolve through canonicalization
    expect(
      getEarlyStoppingGuidanceSection('us.anthropic.claude-haiku-5-5'),
    ).toBe(HAIKU_5_5_EARLY_STOPPING_GUIDANCE)
    expect(getEarlyStoppingGuidanceSection('claude-haiku-5-5[1m]')).toBe(
      HAIKU_5_5_EARLY_STOPPING_GUIDANCE,
    )
  })

  test('other models → absent (capability gate false)', () => {
    for (const model of [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-fable-5-1',
    ]) {
      expect(isEarlyStoppingGuidanceEnabled(model)).toBe(false)
      expect(getEarlyStoppingGuidanceSection(model)).toBeNull()
    }
  })

  test('tengu_idempotent_wolf=false → absent (growthbook arm of ULo)', () => {
    mock.module('../../../services/analytics/growthbook.js', () => ({
      ...actualGrowthbookExports,
      getFeatureValue_CACHED_MAY_BE_STALE: (
        _feature: string,
        defaultValue: unknown,
      ) =>
        _feature === EARLY_STOPPING_GUIDANCE_FLAG ? false : defaultValue,
    }))
    try {
      expect(isEarlyStoppingGuidanceEnabled('claude-haiku-5-5')).toBe(false)
      expect(getEarlyStoppingGuidanceSection('claude-haiku-5-5')).toBeNull()
    } finally {
      mock.module('../../../services/analytics/growthbook.js', () => ({
        ...actualGrowthbookExports,
      }))
    }
    // restored
    expect(getEarlyStoppingGuidanceSection('claude-haiku-5-5')).not.toBeNull()
  })

  test("prompts.ts registers the 'heron_brook' dynamic section (source anchor)", () => {
    const src = readFileSync(join(REPO_SRC, 'constants/prompts.ts'), 'utf-8')
    expect(src).toContain("systemPromptSection('heron_brook'")
  })
})

describe('2.1.293: /model picker rows', () => {
  test('getHaiku55Option (1P): Haiku 5.5 label + pricing suffix', () => {
    const option = getHaiku55Option()
    expect(option.value).toBe('haiku')
    expect(option.label).toBe('Haiku')
    expect(option.description).toBe(
      'Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok',
    )
    expect(option.descriptionForModel).toBe(
      'Haiku 5.5 - fastest for quick answers. Lower cost but less capable than Sonnet 5.5.',
    )
  })

  test('1P stock picker lists the Haiku 5.5 row', () => {
    const options = getModelOptions()
    const haikuRow = options.find(o => o.value === 'haiku')
    expect(haikuRow).toBeDefined()
    expect(haikuRow?.description).toContain('Haiku 5.5 · Fastest for quick answers')
    expect(haikuRow?.description).toContain('$0.10/$0.50 per Mtok')
  })

  test('subscriber (Max) picker lists Haiku 5.5 without pricing suffix', () => {
    subState.max = true
    subState.claudeAi = true
    subState.type = 'max'
    const options = getModelOptions()
    const haikuRow = options.find(o => o.value === 'haiku')
    expect(haikuRow).toBeDefined()
    expect(haikuRow?.description).toBe('Haiku 5.5 · Fastest for quick answers')
  })
})

// ── Bedrock-provider tests LAST (session-global STATE hygiene; the
// getBedrockInferenceProfiles stub is registered in beforeAll above).
describe('2.1.293: 3P picker keeps Haiku 4.5 (per_provider lag table)', () => {
  test('bedrock picker haiku row still says Haiku 4.5', () => {
    let description = ''
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      const options = getModelOptions()
      const haikuRow = options.find(o => o.value === 'haiku')
      description = haikuRow?.description ?? ''
    })
    expect(description).toContain('Haiku 4.5 · Fastest for quick answers')
    // no pricing suffix on 3P rows (existing OCC convention)
    expect(description).not.toContain('per Mtok')
  })
})
