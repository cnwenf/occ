import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.300 (#5) — "`/advisor` on Claude Platform on AWS".
 *
 * Official binary evidence (docs/gap-research-300/triage-T4.md §5):
 *   v299 gate `bxt()` @221830809:
 *     if(a.CLAUDE_CODE_DISABLE_ADVISOR_TOOL||TA())return!1;
 *     return Oe()==="firstParty"&&Kh()
 *   v300 gate `_It()` @222993478 (dd-verified this round):
 *     if(a.CLAUDE_CODE_DISABLE_ADVISOR_TOOL||bP())return!1;
 *     let e=Ie();return(e==="firstParty"||wD(e))&&ny()
 *   v300 helper `wD` @216213859 (dd-verified this round):
 *     function wD(e=Ie()){return e==="anthropicAws"||e==="anthropicGoogleCloud"}
 *
 * The only v300 delta is the widened provider arm: firstParty →
 * firstParty || wD. OCC folds the official `anthropicGoogleCloud` provider
 * into firstParty (src/utils/model/providers.ts), so the wD arm reduces to
 * OCC's `'anthropic_aws'` (official `anthropicAws`). The v300 statsig
 * default `{enabled:wD(Ie())}` is analytics-only (stubbed in OCC).
 *
 * Kill-switch order must stay intact: CLAUDE_CODE_DISABLE_ADVISOR_TOOL and
 * the org-refused latch still win BEFORE the provider check; bedrock /
 * vertex / foundry / mantle stay excluded.
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
]

let savedEnv: Record<string, string | undefined> = {}
let gbFeatures: Record<string, unknown> = {}

mock.module('../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (key: string, def: unknown) =>
    key in gbFeatures ? gbFeatures[key] : def,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
}))

beforeEach(() => {
  savedEnv = {}
  for (const k of ADVISOR_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  gbFeatures = {}
})

afterEach(() => {
  for (const k of ADVISOR_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

async function loadAdvisor() {
  return await import('../advisor.js')
}

describe('2.1.300 #5 — advisor gate widened to Claude Platform on AWS', () => {
  test('anthropicAws provider + experiment enabled → advisor enabled', async () => {
    process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1'
    gbFeatures = { tengu_sage_compass2: { enabled: true } }
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(true)
  })

  test('anthropicAws provider + ENABLE env override → advisor enabled', async () => {
    process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1'
    process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(true)
  })

  test('anthropicAws provider without configuration → disabled (no advisor until picked)', async () => {
    process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1'
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(false)
  })

  test('CLAUDE_CODE_DISABLE_ADVISOR_TOOL kill-switch still wins on AWS', async () => {
    process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1'
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
    gbFeatures = { tengu_sage_compass2: { enabled: true } }
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(false)
  })

  test('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS still wins on AWS', async () => {
    process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1'
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    gbFeatures = { tengu_sage_compass2: { enabled: true } }
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(false)
  })

  test('firstParty behavior unchanged (regression guard)', async () => {
    gbFeatures = { tengu_sage_compass2: { enabled: true } }
    const { isAdvisorEnabled } = await loadAdvisor()
    expect(isAdvisorEnabled()).toBe(true)
  })

  test('bedrock / vertex / foundry / mantle stay excluded', async () => {
    const { isAdvisorEnabled } = await loadAdvisor()
    for (const envKey of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_MANTLE',
    ]) {
      process.env[envKey] = '1'
      gbFeatures = { tengu_sage_compass2: { enabled: true } }
      expect(isAdvisorEnabled()).toBe(false)
      delete process.env[envKey]
    }
  })
})
