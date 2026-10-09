import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_SRC = join(import.meta.dir, '..', '..', '..')

// Hermetic for credential-less environments (CI runners) — same discipline as
// sonnet55Launch284.test.ts (see its header comment).
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * 2.1.293 (OCC-150): Claude Haiku 5.5 launch (`claude-haiku-5-5`).
 *
 * All expectations are byte-verified against the official Claude Code 2.1.293
 * linux-x64 binary (v293 ELF offsets cited per block; full forensics in
 * docs/upstream-version-gap-occ150-2026-10.md §2). Key evidence sites:
 *   - baked catalog entry `claude-haiku-5-5` @13883100: display_name
 *     "Haiku 5.5", knowledge_cutoff "June 2026", pricing "haiku_55"
 *     ($0.10/$0.50 per Mtok), default_effort "medium", advisor_rank 4,
 *     max_output_tokens {128000,128000}, context {window:1e6, native_1m,
 *     supports_1m_beta}, fallback_3p "claude-haiku-4-5",
 *     vertex_region_env_var VERTEX_REGION_CLAUDE_HAIKU_5_5, capabilities incl.
 *     effort/max_effort/xhigh_effort/adaptive_thinking/context_management/
 *     per_turn_effort/lean_prompt/haiku_5_5_early_stopping_guidance
 *     (@13883929)
 *   - default-haiku switch: `latest_per_family.haiku:"claude-haiku-5-5"`
 *     @13899000; n2() @16246831 (env override → catalog → provider default)
 *   - dynamic picker rows: MM() @20387050 (PAYG) / DM() @20388485 region
 *     (subscriber) — both driven by the default-haiku display name; the static
 *     "Haiku 4.5 …" / "Haiku 3.5 …" rows are GONE from the v293 binary
 *   - TLo latest-models prose @23471900; heron_brook section
 *     `ap("heron_brook",()=>BLo()??ULo(h,s))` @23511036 with HLo text @23480542
 *   - skill model vars (HAIKU_ID/HAIKU_NAME only — no PREV_HAIKU_*) @48793569
 *
 * Mock-module discipline follows sonnet55Launch284.test.ts (deferred
 * registration in beforeAll, restore in afterAll, bedrock fetch stub).
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
  // Hermetic bedrock: stub the ~2s AWS inference-profile fetch (see the
  // sonnet55Launch284 P3-8 root-fix comment).
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
  getDefaultHaikuModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
} = await import('../model.js')
const { getModelOptions, getHaikuOption, getMaxHaikuOption } = await import(
  '../modelOptions.js'
)
const { CANONICAL_MODEL_CATALOG } = await import('../modelDescriptors.js')
const { COST_HAIKU_45, COST_HAIKU_55, formatModelPricing, getModelCosts } =
  await import('../../modelCost.js')
const {
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
} = await import('../../effort.js')
const { getModelMaxOutputTokens, modelSupports1M } = await import(
  '../../context.js'
)
const { modelSupportsContextManagement, modelSupportsStructuredOutputs } =
  await import('../../betas.js')
const { modelSupportsAdaptiveThinking } = await import('../../thinking.js')
const { modelSupportsAdvisor, isValidAdvisorModel } = await import(
  '../../advisor.js'
)
const { sanitizeModelName } = await import('../../commitAttribution.js')
const { getVertexRegionForModel } = await import('../../envUtils.js')
const { isModelRecognized } = await import('../unrecognizedModelSignal.js')
const { modelHasLeanPrompt, shouldUseFullSystemPrompt, shouldUseLeanPrompt } =
  await import('../../effort/leanPrompt.js')
// NOTE: claudeApiContent.ts cannot be imported under `bun test` — its 28
// `.md` skill files are intentional 1-byte stubs and the text-loader default
// import fails at test time (build-time inlining works). The skill-var pins
// below are therefore source-anchored via readFileSync, same convention as
// the heron_brook pins.
const { resetModelStringsForTestingOnly } = await import(
  '../../../bootstrap/state.js'
)

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
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_MANTLE',
    'VERTEX_REGION_CLAUDE_HAIKU_5_5',
    'VERTEX_REGION_CLAUDE_HAIKU_4_5',
    'USER_TYPE',
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  resetModelStringsForTestingOnly()
})

describe('2.1.293: canonicalization + catalog registration', () => {
  test('claude-haiku-5-5 canonicalizes to itself (provider-prefixed forms too)', () => {
    expect(firstPartyNameToCanonical('claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(firstPartyNameToCanonical('us.anthropic.claude-haiku-5-5')).toBe(
      'claude-haiku-5-5',
    )
    expect(getCanonicalName('anthropic.claude-haiku-5-5')).toBe('claude-haiku-5-5')
  })

  test('claude-haiku-4-5 still canonicalizes to claude-haiku-4-5', () => {
    expect(firstPartyNameToCanonical('claude-haiku-4-5')).toBe('claude-haiku-4-5')
    expect(firstPartyNameToCanonical('claude-haiku-4-5-20251001')).toBe(
      'claude-haiku-4-5',
    )
  })

  test("Rce catalog parity: CANONICAL_MODEL_CATALOG registers 'claude-haiku-5-5' (@13774884)", () => {
    expect(CANONICAL_MODEL_CATALOG).toContain('claude-haiku-5-5')
  })

  test('isModelRecognized covers haiku-5-5 — no [claude-code:unrecognized_model] for the new default', () => {
    expect(isModelRecognized('claude-haiku-5-5')).toBe(true)
    expect(isModelRecognized('us.anthropic.claude-haiku-5-5')).toBe(true)
  })
})

describe('2.1.293: default Haiku flips to claude-haiku-5-5 (latest_per_family @13899000)', () => {
  test('firstParty getDefaultHaikuModel → claude-haiku-5-5', () => {
    expect(getDefaultHaikuModel()).toBe('claude-haiku-5-5')
  })

  test("'haiku' alias resolves to claude-haiku-5-5 (+[1m] suffix)", () => {
    expect(parseUserSpecifiedModel('haiku')).toBe('claude-haiku-5-5')
    expect(parseUserSpecifiedModel('haiku[1m]')).toBe('claude-haiku-5-5[1m]')
  })

  test("'claude-haiku-4-5' is NOT upgraded to 5.5", () => {
    expect(parseUserSpecifiedModel('claude-haiku-4-5')).toBe('claude-haiku-4-5')
  })

  test('3P providers lag at haiku-4-5 (per_provider table: bedrock/vertex/foundry/mantle)', () => {
    function haikuDefaultWith(env: Record<string, string>): string {
      resetModelStringsForTestingOnly()
      let result = ''
      withEnv(env, () => {
        result = getDefaultHaikuModel()
      })
      return result
    }
    expect(haikuDefaultWith({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    )
    expect(haikuDefaultWith({ CLAUDE_CODE_USE_VERTEX: '1' })).toBe(
      'claude-haiku-4-5@20251001',
    )
    expect(haikuDefaultWith({ CLAUDE_CODE_USE_FOUNDRY: '1' })).toBe(
      'claude-haiku-4-5',
    )
    expect(haikuDefaultWith({ CLAUDE_CODE_USE_MANTLE: '1' })).toBe(
      'anthropic.claude-haiku-4-5',
    )
    // bedrock LAST discipline doesn't apply (fetch stubbed), but keep the
    // firstParty re-check last so later describes start from the default.
    resetModelStringsForTestingOnly()
    expect(haikuDefaultWith({})).toBe('claude-haiku-5-5')
  })

  test('ANTHROPIC_DEFAULT_HAIKU_MODEL wins over every provider branch (n2() @16246831)', () => {
    for (const env of [{}, { CLAUDE_CODE_USE_BEDROCK: '1' }]) {
      resetModelStringsForTestingOnly()
      withEnv({ ...env, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku-pin' }, () => {
        expect(getDefaultHaikuModel()).toBe('custom-haiku-pin')
      })
    }
  })
})

describe('2.1.293: display + marketing names (catalog display_name "Haiku 5.5")', () => {
  test("getPublicModelDisplayName: 'Haiku 5.5' / 'Haiku 5.5 (1M context)' (sE @16268082)", () => {
    expect(getPublicModelDisplayName('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(getPublicModelDisplayName('claude-haiku-5-5[1m]')).toBe(
      'Haiku 5.5 (1M context)',
    )
    // untouched neighbor — the haiku45 model string is the DATED first-party
    // name ('claude-haiku-4-5-20251001'), so the bare canonical is null here
    expect(getPublicModelDisplayName('claude-haiku-4-5-20251001')).toBe(
      'Haiku 4.5',
    )
  })

  test('getMarketingNameForModel: Haiku 5.5 before Haiku 4.5 (descending-version order)', () => {
    expect(getMarketingNameForModel('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(getMarketingNameForModel('claude-haiku-5-5[1m]')).toBe(
      'Haiku 5.5 (1M context)',
    )
    expect(getMarketingNameForModel('claude-haiku-4-5')).toBe('Haiku 4.5')
  })
})

describe('2.1.293: cost tier (catalog pricing "haiku_55" — $0.10/$0.50)', () => {
  test('getModelCosts dispatches claude-haiku-5-5 to COST_HAIKU_55', () => {
    expect(getModelCosts('claude-haiku-5-5', {} as Usage)).toEqual(COST_HAIKU_55)
    expect(getModelCosts('us.anthropic.claude-haiku-5-5', {} as Usage)).toEqual(
      COST_HAIKU_55,
    )
    expect(COST_HAIKU_55.inputTokens).toBe(0.1)
    expect(COST_HAIKU_55.outputTokens).toBe(0.5)
    // haiku-4-5 keeps its own tier — the dispatch must not shadow it
    expect(getModelCosts('claude-haiku-4-5', {} as Usage)).toEqual(COST_HAIKU_45)
  })
})

describe('2.1.293: effort (catalog default_effort "medium"; effort/max_effort/xhigh_effort capabilities)', () => {
  test('getDefaultEffortForModel(claude-haiku-5-5) → medium', () => {
    expect(getDefaultEffortForModel('claude-haiku-5-5')).toBe('medium')
    expect(getDefaultEffortForModel('us.anthropic.claude-haiku-5-5')).toBe(
      'medium',
    )
  })

  test('effort capability gates cover haiku-5-5 (FIRST haiku with effort support)', () => {
    expect(modelSupportsEffort('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsMaxEffort('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsXhighEffort('claude-haiku-5-5')).toBe(true)
    // haiku-4-5 has only context_management in its capabilities array
    expect(modelSupportsEffort('claude-haiku-4-5')).toBe(false)
  })
})

describe('2.1.293: context (window 1e6 native_1m + supports_1m_beta; max_output_tokens 128k/128k)', () => {
  test('getModelMaxOutputTokens: haiku-5-5 → 128000/128000', () => {
    expect(getModelMaxOutputTokens('claude-haiku-5-5')).toEqual({
      default: 128_000,
      upperLimit: 128_000,
    })
  })

  test('modelSupports1M covers claude-haiku-5-5; haiku-4-5 stays 200k', () => {
    expect(modelSupports1M('claude-haiku-5-5')).toBe(true)
    expect(modelSupports1M('claude-haiku-4-5')).toBe(false)
  })
})

describe('2.1.293: betas + thinking (context_management / structured outputs / adaptive_thinking)', () => {
  test('modelSupportsContextManagement covers haiku-5-5 on 3P', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      expect(modelSupportsContextManagement('us.anthropic.claude-haiku-5-5')).toBe(
        true,
      )
      // haiku-4-5 also declares context_management (untouched neighbor)
      expect(modelSupportsContextManagement('us.anthropic.claude-haiku-4-5')).toBe(
        true,
      )
    })
  })

  test('modelSupportsStructuredOutputs allowlist covers haiku-5-5', () => {
    expect(modelSupportsStructuredOutputs('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsStructuredOutputs('claude-haiku-4-5')).toBe(true)
  })

  test('modelSupportsAdaptiveThinking covers haiku-5-5 (first haiku with it)', () => {
    expect(modelSupportsAdaptiveThinking('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-haiku-4-5')).toBe(false)
  })
})

describe('2.1.293: advisor (catalog advisor_rank:4 — first haiku with an advisor rank)', () => {
  test('modelSupportsAdvisor / isValidAdvisorModel cover haiku-5-5', () => {
    expect(modelSupportsAdvisor('claude-haiku-5-5')).toBe(true)
    expect(isValidAdvisorModel('claude-haiku-5-5')).toBe(true)
    expect(modelSupportsAdvisor('claude-haiku-4-5')).toBe(false)
  })
})

describe('2.1.293: lean prompt (capabilities array carries "lean_prompt" @13883234)', () => {
  test('haiku-5-5 gets the LEAN prompt; haiku-4-5 keeps the full prompt', () => {
    expect(modelHasLeanPrompt('claude-haiku-5-5')).toBe(true)
    expect(shouldUseLeanPrompt('claude-haiku-5-5')).toBe(true)
    expect(shouldUseFullSystemPrompt('claude-haiku-5-5')).toBe(false)
    // the legacy `m.includes('haiku')` arm must NOT win over the lean check
    expect(modelHasLeanPrompt('claude-haiku-4-5')).toBe(false)
    expect(shouldUseFullSystemPrompt('claude-haiku-4-5')).toBe(true)
  })

  test('xhigh/max effort opts into the full prompt even on lean-capable haiku-5-5', () => {
    expect(shouldUseLeanPrompt('claude-haiku-5-5', 'xhigh')).toBe(false)
    expect(shouldUseLeanPrompt('claude-haiku-5-5', 'max')).toBe(false)
    expect(shouldUseLeanPrompt('claude-haiku-5-5', 'high')).toBe(true)
  })
})

describe('2.1.293: commit attribution + vertex region', () => {
  test('sanitizeModelName: haiku-5-5 arm precedes haiku-4-5 (official @16264434 order)', () => {
    expect(sanitizeModelName('claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(sanitizeModelName('us.anthropic.claude-haiku-5-5')).toBe(
      'claude-haiku-5-5',
    )
    expect(sanitizeModelName('claude-haiku-4-5')).toBe('claude-haiku-4-5')
  })

  test('claude-haiku-5-5 reads VERTEX_REGION_CLAUDE_HAIKU_5_5 (not the 4_5 var)', () => {
    withEnv(
      {
        VERTEX_REGION_CLAUDE_HAIKU_5_5: 'asia-southeast1',
        VERTEX_REGION_CLAUDE_HAIKU_4_5: 'europe-west1',
      },
      () => {
        expect(getVertexRegionForModel('claude-haiku-5-5')).toBe('asia-southeast1')
        expect(getVertexRegionForModel('claude-haiku-4-5')).toBe('europe-west1')
      },
    )
  })
})

describe('2.1.293: dynamic picker rows (MM @20387050 / DM @20388485)', () => {
  const haiku55Price = formatModelPricing(COST_HAIKU_55)

  test('MM port — firstParty: display name + slogan + pricing + descriptionForModel', () => {
    expect(getHaikuOption()).toEqual({
      value: 'haiku',
      label: 'Haiku',
      description: `Haiku 5.5 · Fastest for quick answers · ${haiku55Price}`,
      descriptionForModel:
        'Haiku 5.5 - fastest for quick answers. Lower cost but less capable than Sonnet.',
    })
  })

  test('MM port — 3P default (haiku-4-5) renders through the SAME dynamic row, no pricing', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      const opt = getHaikuOption()
      expect(opt.value).toBe('haiku')
      expect(opt.description).toBe('Haiku 4.5 · Fastest for quick answers')
    })
  })

  test('DM port — subscriber rows carry no pricing suffix and no descriptionForModel', () => {
    expect(getMaxHaikuOption()).toEqual({
      value: 'haiku',
      label: 'Haiku',
      description: 'Haiku 5.5 · Fastest for quick answers',
    })
  })

  test('stock PAYG-1P picker carries the dynamic Haiku 5.5 row', () => {
    const options = getModelOptions()
    const row = options.find(o => o.value === 'haiku')
    expect(row?.description).toBe(
      `Haiku 5.5 · Fastest for quick answers · ${haiku55Price}`,
    )
  })

  test('subscriber (Max) picker haiku row follows the default-haiku display name', () => {
    subState.max = true
    subState.claudeAi = true
    subState.type = 'max'
    const options = getModelOptions()
    const haikuRow = options.find(o => o.value === 'haiku')
    expect(haikuRow?.description).toBe('Haiku 5.5 · Fastest for quick answers')
  })

  test('the v292 static rows are gone: no "Haiku 3.5 for simple tasks" / "less capable than Sonnet 4.6" anywhere in modelOptions.ts', () => {
    const src = readFileSync(join(REPO_SRC, 'utils/model/modelOptions.ts'), 'utf-8')
    // (comment references aside, no live row may carry the deleted strings)
    const code = src
      .split('\n')
      .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')
    expect(code).not.toContain('Haiku 3.5 for simple tasks')
    expect(code).not.toContain('less capable than Sonnet 4.6')
    expect(code).not.toContain("description: 'Haiku 4.5")
  })
})

describe('2.1.293: claude-api skill model vars (@48793569 — HAIKU_ID/HAIKU_NAME only, source-anchored)', () => {
  test('SKILL_MODEL_VARS carries the Haiku 5.5 vars; no PREV_HAIKU_* officially', () => {
    const src = readFileSync(
      join(REPO_SRC, 'skills/bundled/claudeApiContent.ts'),
      'utf-8',
    )
    expect(src).toContain("HAIKU_ID: 'claude-haiku-5-5'")
    expect(src).toContain("HAIKU_NAME: 'Claude Haiku 5.5'")
    expect(src).not.toContain('PREV_HAIKU_ID')
    expect(src).not.toContain('PREV_HAIKU_NAME')
    // stale-generation pin must be gone
    expect(src).not.toContain("HAIKU_ID: 'claude-haiku-4-5")
  })
})

describe('2.1.293: heron_brook system-prompt section (ULo/HLo @23480542-23483450, source-anchored)', () => {
  // The section lives inside getSystemPrompt's dynamic list (React-free but
  // heavy to invoke hermetically); source anchors pin the wiring + gate +
  // verbatim text ends, same pattern as the 2.1.284 P3-2 picker anchor.
  test('prompts.ts wires heron_brook with the haiku-5-5 capability gate', () => {
    const src = readFileSync(join(REPO_SRC, 'constants/prompts.ts'), 'utf-8')
    expect(src).toContain("systemPromptSection('heron_brook'")
    expect(src).toContain('getHeronBrookSection(model)')
    // DN("haiku_5_5_early_stopping_guidance",…) — only claude-haiku-5-5
    // carries the capability in the v293 catalog (@13883929)
    expect(src).toContain("canonical.includes('claude-haiku-5-5')")
    expect(src).toContain('haiku_5_5_early_stopping_guidance')
  })

  test('HLo text is verbatim (head + tail pins, @23480542 / @23483257)', () => {
    const src = readFileSync(join(REPO_SRC, 'constants/prompts.ts'), 'utf-8')
    expect(src).toContain(
      'The reasoning effort setting changes how much you think before you act. It does not change how much of the request you are expected to finish.',
    )
    expect(src).toContain(
      'A question at the end of finished work costs the user one reply, the same as a question asked before any work.',
    )
    expect(src).toContain(
      'Words that only set an order, such as "plan, then build", are not a stopping point.',
    )
  })

  test('latest-models prose pins (TLo @23471900 — Claude 5 family, Haiku 5.5 id)', () => {
    const src = readFileSync(join(REPO_SRC, 'constants/prompts.ts'), 'utf-8')
    expect(src).toContain(
      'The most recent Claude models are the Claude 5 family. Model IDs',
    )
    expect(src).toContain("haiku: 'claude-haiku-5-5'")
  })
})
