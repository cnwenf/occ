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
const subState = {
  max: false,
  pro: false,
  team: false,
  teamPremium: false,
  claudeAi: false,
  type: null as string | null,
}

let mockedSettings: Record<string, unknown> = {}

// P3-8 (OCC-101 review): mock registration is DEFERRED to beforeAll and
// restored in afterAll, and the real exports are captured inside beforeAll
// (not at module scope) so this file never snapshots another file's
// still-active mock as "actual" (OCC-97 in-place-mutation hazard).
// mock.module mutates already-imported namespaces in place, so the
// top-level `await import`s below still observe the mocked exports once
// beforeAll has run. The shared-process regression itself (bedrockRegion
// Prefix 267/3 vs the 243/0 base) was NOT the registration timing — it was
// this file's bedrock-env tests firing the REAL, memoized ~2s AWS profile
// fetch, whose late resolution corrupts session-global STATE mid-run for
// later files. See the bedrock.js stub in beforeAll below (root fix).
let actualAuthExports: Record<string, unknown> = {}
let actualSettingsExports: Record<string, unknown> = {}
let actualBedrockExports: Record<string, unknown> = {}

beforeAll(async () => {
  actualAuthExports = { ...((await import('../../auth.js')) as object) }
  actualSettingsExports = {
    ...((await import('../../settings/settings.js')) as object),
  }
  actualBedrockExports = { ...((await import('../bedrock.js')) as object) }
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
  // P3-8 root fix: the bedrock-env tests below (getDefaultSonnetModel /
  // picker rows under CLAUDE_CODE_USE_BEDROCK=1) initialize modelStrings,
  // which fires the REAL getBedrockInferenceProfiles — an actual ~2s AWS
  // fetch. That promise is memoized in bedrock.js and stays in flight in
  // the shared sequential queue after this file ends; when it resolves
  // mid-run it writes real profile strings into the session-global
  // STATE.modelStrings, corrupting bedrockRegionPrefix.test.ts (the
  // 267/3-vs-243/0 shared-process regression). Stub it to an immediate
  // empty list: hermetic, no network, no in-flight leftovers.
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
  COST_TIER_2_10_CACHE_READ_0_10,
  formatModelPricing,
  getModelCosts,
} = await import('../../modelCost.js')
const { getDefaultEffortForModel } = await import('../../effort.js')
const { getModelMaxOutputTokens, modelSupports1M } = await import('../../context.js')
const { modelSupportsContextManagement } = await import('../../betas.js')
const { modelSupportsAdvisor, isValidAdvisorModel } = await import('../../advisor.js')
const { sanitizeModelName } = await import('../../commitAttribution.js')
const { getVertexRegionForModel } = await import('../../envUtils.js')
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
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_MANTLE',
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

// P3-1 (OCC-101 review): EXACT per-provider default pins. The fuzzy
// toContain('claude-sonnet-4-5') above cannot catch a wrong provider table
// (e.g. bedrock returning the vertex or firstParty string). These pins
// assert the full per-provider lag table from the v284 baked catalog `S8n`
// @198712738: sonnet alias per_provider {bedrock/vertex/foundry/mantle →
// "claude-sonnet-4-5", anthropic_aws/gateway → "claude-sonnet-4-6"},
// default (firstParty) → "claude-sonnet-5-5" — resolved through each
// provider's CONFIG string (configs.ts). The env override must win over ALL
// provider branches (getDefaultSonnetModel checks it FIRST).
describe('2.1.284 P3-1: exact per-provider default Sonnet table', () => {
  function sonnetDefaultWith(env: Record<string, string>): string {
    // getModelStrings caches provider-derived strings in session-global
    // state — reset before each provider switch.
    resetModelStringsForTestingOnly()
    let result = ''
    withEnv(env, () => {
      result = getDefaultSonnetModel()
    })
    return result
  }

  test('firstParty → claude-sonnet-5-5', () => {
    expect(sonnetDefaultWith({})).toBe('claude-sonnet-5-5')
  })

  test('anthropic_aws → sonnet46 string (claude-sonnet-4-6)', () => {
    expect(sonnetDefaultWith({ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' })).toBe(
      'claude-sonnet-4-6',
    )
  })

  test('vertex → claude-sonnet-4-5@20250929', () => {
    expect(sonnetDefaultWith({ CLAUDE_CODE_USE_VERTEX: '1' })).toBe(
      'claude-sonnet-4-5@20250929',
    )
  })

  test('foundry → claude-sonnet-4-5', () => {
    expect(sonnetDefaultWith({ CLAUDE_CODE_USE_FOUNDRY: '1' })).toBe(
      'claude-sonnet-4-5',
    )
  })

  test('mantle → anthropic.claude-sonnet-4-5', () => {
    expect(sonnetDefaultWith({ CLAUDE_CODE_USE_MANTLE: '1' })).toBe(
      'anthropic.claude-sonnet-4-5',
    )
  })

  test('bedrock → us.anthropic.claude-sonnet-4-5-20250929-v1:0', () => {
    // bedrock LAST: its modelStrings init fires an (in this file stubbed)
    // async profile fetch — no network, no in-flight leftovers.
    expect(sonnetDefaultWith({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    )
  })

  test('ANTHROPIC_DEFAULT_SONNET_MODEL wins over every provider branch', () => {
    for (const env of [
      {},
      { CLAUDE_CODE_USE_BEDROCK: '1' },
      { CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' },
      { CLAUDE_CODE_USE_VERTEX: '1' },
    ]) {
      expect(
        sonnetDefaultWith({ ...env, ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet-pin' }),
      ).toBe('custom-sonnet-pin')
    }
  })
})

// P3-2 (OCC-101 review): the /model picker's 1M-access disjunct list must
// carry the sonnet-5-5[1m] row. The official v284 predicate (pdr/Dfr) is
// generic over the [1m] suffix; OCC approximates it with an explicit
// disjunct list, so a missing 'sonnet-5-5[1m]' row would silently hide the
// 1M row for the NEW default sonnet. Source-anchored (the predicate lives
// inside a React-compiled .tsx closure — runtime reach needs the full
// picker; the anchor pins the disjunct itself).
describe('2.1.284 P3-2: /model picker 1M disjunct list (source-anchored)', () => {
  test("model.tsx checkSonnet1mAccess gate lists sonnet-5-5[1m]", () => {
    const src = readFileSync(
      join(REPO_SRC, 'commands/model/model.tsx'),
      'utf-8',
    )
    expect(src).toContain("m.includes('sonnet-5-5[1m]')")
    // the full disjunct chain stays intact (regression guard for the
    // surrounding rows the OCC approximation relies on)
    expect(src).toContain("m.includes('sonnet[1m]')")
    expect(src).toContain("m.includes('sonnet-4-6[1m]')")
    expect(src).toContain("m.includes('sonnet-5[1m]')")
    expect(src).toContain("m.trim() === 'opusplan[1m]'")
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

describe('2.1.296: cost tier (catalog pricing "tier_2_10_cache_read_0_10")', () => {
  test('getModelCosts dispatches claude-sonnet-5-5 to tier_2_10_cache_read_0_10', () => {
    // CC 2.1.296 (#059): cache-read repricing $0.20 → $0.10 — the catalog
    // entry for claude-sonnet-5-5 now carries pricing:"tier_2_10_cache_read_0_10".
    expect(getModelCosts('claude-sonnet-5-5', {} as Usage)).toEqual(
      COST_TIER_2_10_CACHE_READ_0_10,
    )
    expect(getModelCosts('us.anthropic.claude-sonnet-5-5', {} as Usage)).toEqual(
      COST_TIER_2_10_CACHE_READ_0_10,
    )
    // claude-sonnet-5 keeps the 2/10 tier with cache_read $0.20 (2.1.243
    // repricing, unchanged in 296) — the dispatch must not shadow it
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
  const sonnet55Price = formatModelPricing(COST_TIER_2_10_CACHE_READ_0_10)

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
