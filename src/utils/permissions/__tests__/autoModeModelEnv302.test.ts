/**
 * CC 2.1.302 #01 — `CLAUDE_CODE_AUTO_MODE_MODEL` chooses the client-side
 * auto-mode classifier model for ALL users (no ant gate), ranked BELOW the
 * server-config model. When the config supplies a model, the env value is
 * shadowed and a warn-once ("env:shadowed", official `loggedPolicySkips` Set)
 * is logged.
 *
 * Official binary evidence (v302 resolver `HYe` @244374771, recovered
 * byte-verbatim from the 2.1.302 linux-x64 ELF; docs/gap-research-302/
 * triage-T1.md §#01):
 *
 *   function HYe(){
 *     let r = RYt(n?.modelByMainModel,{vet:...}) ?? a_e(n?.model,"model");
 *     if(r){
 *       if(a.CLAUDE_CODE_AUTO_MODE_MODEL){
 *         let{loggedPolicySkips:s}=_S();
 *         if(!s.has("env:shadowed")) s.add("env:shadowed"),
 *           t(`Auto mode classifier: ignoring CLAUDE_CODE_AUTO_MODE_MODEL=${...}
 *              because a server-configured classifier model (${r}) takes
 *              priority; using that model instead`,{level:"warn"}) }
 *       return{value:r,src:"gb"} }
 *     { let s=a_e(a.CLAUDE_CODE_AUTO_MODE_MODEL,"env"); if(s)return{value:s,src:"env"} }
 *     ... externalSonnet5Probe → default ...
 *   }
 *
 * OCC divergence: GrowthBook is stubbed (no remote server config), so the
 * config slot is OCC's local `tengu_auto_mode_config` feature-value source;
 * OCC has no `modelByMainModel` table, no `externalSonnet5Probe`, and no
 * org-policy vetting/arbiter (`a_e`/`wte`/`WMo`) — the existing Sonnet-5
 * default / subagent / main-loop tail is asserted unchanged.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as debug from '../../debug.js'
import { resetModelStringsForTestingOnly } from 'src/bootstrap/state.js'

// Mutable config-model slot driven through the growthbook module mock —
// mirrors the mock.module convention in test/utils/permissions/
// classifierOverflowPermissions288.test.ts.
let configModel: string | undefined

const actualGrowthbook = await import('src/services/analytics/growthbook.js')
// Capture the ORIGINAL function reference BEFORE mock.module: Bun's
// mock.module patches the live ESM bindings, so calling
// `actualGrowthbook.getFeatureValue_CACHED_MAY_BE_STALE` from inside the mock
// factory would re-enter the mock itself (infinite recursion → test hang).
const actualGetFeatureValue =
  actualGrowthbook.getFeatureValue_CACHED_MAY_BE_STALE

mock.module('src/services/analytics/growthbook.js', () => ({
  ...actualGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: <T>(
    featureName: string,
    defaultValue: T,
  ): T =>
    featureName === 'tengu_auto_mode_config' && configModel !== undefined
      ? ({ ...(defaultValue as object), model: configModel } as T)
      : actualGetFeatureValue(featureName, defaultValue),
}))

afterAll(() => {
  mock.module('src/services/analytics/growthbook.js', () => ({
    ...actualGrowthbook,
  }))
})

const {
  getClassifierModel,
  getClassifierSonnet5Default,
  _resetClassifierSonnet5DefaultCache,
  _resetClassifierPolicySkipLogs,
} = await import('../yoloClassifier.js')

// Env keys getClassifierModel() / getAPIProvider() consult — snapshotted and
// restored so the test never leaks provider state into sibling files.
const MANAGED_ENV_KEYS = [
  'USER_TYPE',
  'CLAUDE_CODE_AUTO_MODE_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const

let savedEnv: Record<string, string | undefined> = {}
let debugSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  savedEnv = {}
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  configModel = undefined
  resetModelStringsForTestingOnly()
  _resetClassifierSonnet5DefaultCache()
  _resetClassifierPolicySkipLogs()
  debugSpy = spyOn(debug, 'logForDebugging').mockImplementation(() => {})
})

afterEach(() => {
  debugSpy.mockRestore()
  for (const key of MANAGED_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  configModel = undefined
  resetModelStringsForTestingOnly()
  _resetClassifierSonnet5DefaultCache()
  _resetClassifierPolicySkipLogs()
})

function shadowWarnings(): string[] {
  return debugSpy.mock.calls
    .map(call => String(call[0]))
    .filter(message => message.includes('takes priority; using that model'))
}

describe('CC 2.1.302 #01: CLAUDE_CODE_AUTO_MODE_MODEL ladder (config > env > default)', () => {
  test('env set + no config model → env model used, no ant gate (USER_TYPE unset)', () => {
    // Arrange — USER_TYPE deliberately unset (external user). v301 OCC
    // required USER_TYPE==='ant'; official v302 has no gate.
    process.env.CLAUDE_CODE_AUTO_MODE_MODEL = 'claude-haiku-4-5'

    // Act
    const model = getClassifierModel()

    // Assert
    expect(model).toBe('claude-haiku-4-5')
    expect(shadowWarnings()).toHaveLength(0)
  })

  test('env set + no config model → env model used for an external (non-firstParty) session too', () => {
    // Arrange
    process.env.CLAUDE_CODE_AUTO_MODE_MODEL = 'claude-haiku-4-5'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    // Act
    const model = getClassifierModel()

    // Assert — env outranks the external Sonnet-5 default tail.
    expect(model).toBe('claude-haiku-4-5')
    expect(shadowWarnings()).toHaveLength(0)
  })

  test('config model + env set → config wins, env shadowed, warn logged exactly ONCE across two resolutions', () => {
    // Arrange
    configModel = 'config-classifier-model'
    process.env.CLAUDE_CODE_AUTO_MODE_MODEL = 'claude-haiku-4-5'

    // Act
    const first = getClassifierModel()
    const second = getClassifierModel()

    // Assert
    expect(first).toBe('config-classifier-model')
    expect(second).toBe('config-classifier-model')
    const warnings = shadowWarnings()
    expect(warnings).toHaveLength(1)
    // Exact official v302 `HYe` message with env + config values substituted.
    expect(warnings[0]).toBe(
      'Auto mode classifier: ignoring CLAUDE_CODE_AUTO_MODE_MODEL=claude-haiku-4-5 because a server-configured classifier model (config-classifier-model) takes priority; using that model instead',
    )
  })

  test('config model + env unset → config model, no shadow warning', () => {
    // Arrange
    configModel = 'config-classifier-model'

    // Act
    const model = getClassifierModel()

    // Assert
    expect(model).toBe('config-classifier-model')
    expect(shadowWarnings()).toHaveLength(0)
  })

  test('neither config nor env → existing external Sonnet 5 default tail unchanged', () => {
    // Arrange — external provider, no env override.
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    // Act
    const model = getClassifierModel()

    // Assert
    expect(model).toBe(getClassifierSonnet5Default())
    expect(shadowWarnings()).toHaveLength(0)
  })

  test('neither config nor env → existing firstParty subagent/main-loop fallback unchanged', () => {
    // Arrange — firstParty provider (no bedrock/vertex env), subagent model set.
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-haiku-4-5'

    // Act
    const model = getClassifierModel()

    // Assert
    expect(model).toBe('claude-haiku-4-5')
    expect(shadowWarnings()).toHaveLength(0)
  })
})
