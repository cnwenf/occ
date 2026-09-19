import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 2.1.276 alignment: advisor gating end-state.
 *
 * Official binary evidence (linux-x64 2.1.274 / 2.1.275 / 2.1.276):
 *   - GrowthBook key is `tengu_sage_compass2` in ALL three versions
 *     (2 occurrences each; the bare `tengu_sage_compass` OCC used before
 *     this round appears 0 times).
 *   - v274 TA(): DISABLE env → false; He()!=="firstParty"||!sy() → false;
 *     ENABLE_EXPERIMENTAL env → true; else growthbook.enabled ?? false.
 *   - v276 yct()/Bb(): same end-state (strict firstParty, env override,
 *     tengu_sage_compass2).
 *   - v276 module #489 resolver: `if(!Ia()||!Bb()||!lL(e))return;` where
 *     `Ia(){return He()==="firstParty"&&es()}` and es() is the
 *     ANTHROPIC_BASE_URL allowlist (_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
 *     || unset || host === api.anthropic.com). This is the 2.1.276 fix for
 *     the 2.1.275 regression "every request failing with 400 … Input tag
 *     'advisor_20260301'" behind proxies.
 */

const ADVISOR_ENV = [
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'ANTHROPIC_BASE_URL',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'USER_TYPE',
]

let savedEnv: Record<string, string | undefined> = {}

// GrowthBook feature values captured per test
let gbFeatures: Record<string, unknown> = {}
let gbRequestedKeys: string[] = []

mock.module('../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (key: string, def: unknown) => {
    gbRequestedKeys.push(key)
    return key in gbFeatures ? gbFeatures[key] : def
  },
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
}))

beforeEach(() => {
  savedEnv = {}
  for (const k of ADVISOR_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  gbFeatures = {}
  gbRequestedKeys = []
})

afterEach(() => {
  for (const k of ADVISOR_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

async function loadAdvisor() {
  // fresh module registry per test so env/provider reads are not memoized
  return await import('../advisor.js')
}

describe('2.1.276: advisor GrowthBook key', () => {
  test('reads tengu_sage_compass2 (official 274-276), not the stale bare key', async () => {
    const { isAdvisorEnabled } = await loadAdvisor()
    isAdvisorEnabled()
    expect(gbRequestedKeys).toContain('tengu_sage_compass2')
    expect(gbRequestedKeys).not.toContain('tengu_sage_compass')
  })

  test('enabled:true from the experiment enables advisor', async () => {
    gbFeatures = { tengu_sage_compass2: { enabled: true } }
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(true)
  })

  test('empty config (default) leaves advisor disabled', async () => {
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(false)
  })
})

describe('2.1.276: advisor provider/env gate (official yct()/Bb())', () => {
  test('CLAUDE_CODE_DISABLE_ADVISOR_TOOL wins over everything', async () => {
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
    process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(false)
  })

  test('CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL enables without growthbook', async () => {
    process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(true)
    // env override short-circuits before the growthbook read (official Bb())
    expect(gbRequestedKeys).not.toContain('tengu_sage_compass2')
  })

  test('bedrock provider is excluded', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(false)
  })

  test('vertex provider is excluded', async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    gbFeatures = { tengu_sage_compass2: { enabled: true } }
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(false)
  })

  test('foundry provider is excluded (official yct() requires He()==="firstParty" strictly)', async () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
    process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(false)
  })

  test('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS disables (official p9() arm)', async () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(false)
  })
})
