/**
 * 2.1.281 PORT #039 tests: teammate spawn propagates `--setting-sources`
 * only when the parent explicitly set the flag (raw value stored at
 * eager-parse time via setFlagSettingSourcesRaw).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'
import { quote } from '../../../utils/bash/shellQuote.js'

let settingSourcesRaw: string | undefined
let settingsPath: string | undefined

let spawnModule: typeof import('../spawnMultiAgent.js')
let actualStateModule: Record<string, unknown>

// OCC-97 leak repair (OCC-103 R3): this file's original afterAll "restore"
// (`mock.module(..., () => actualStateModule)`) is defeated by bun's live
// binding patching — the namespace captured before install comes back with
// the MOCKED functions, so the hardcoded `getInlinePlugins: () => []` stub
// leaked into every later file in the single test worker and starved the
// real inline-plugin load (5 victims in mcpGetDynamicScope285: the 3
// pre-existing E2E-001 failures + 2 OCC-103 R3 C1 pins). Proven otel275 /
// mcpAuthStubTools274 delegation pattern: capture the real functions BY
// VALUE before installing the mock; each mocked getter delegates to the
// real one once `mockActive` flips false in afterAll (no re-spread, no
// re-install). The surviving mock then behaves exactly like the real module
// for every subsequent file.
let mockActive = true
let realGetters: {
  getFlagSettingSourcesRaw: () => string | undefined
  getFlagSettingsPath: () => string | undefined
  getChromeFlagOverride: () => string | undefined
  getInlinePlugins: () => unknown[]
  getMainLoopModelOverride: () => string | undefined
  getSessionBypassPermissionsMode: () => boolean
  getSessionId: () => string
}

beforeAll(async () => {
  actualStateModule = await import('../../../bootstrap/state.js')
  const actual = actualStateModule as unknown as typeof realGetters
  realGetters = {
    getFlagSettingSourcesRaw: actual.getFlagSettingSourcesRaw,
    getFlagSettingsPath: actual.getFlagSettingsPath,
    getChromeFlagOverride: actual.getChromeFlagOverride,
    getInlinePlugins: actual.getInlinePlugins,
    getMainLoopModelOverride: actual.getMainLoopModelOverride,
    getSessionBypassPermissionsMode: actual.getSessionBypassPermissionsMode,
    getSessionId: actual.getSessionId,
  }
  mock.module('../../../bootstrap/state.js', () => ({
    ...actualStateModule,
    getFlagSettingSourcesRaw: () =>
      mockActive ? settingSourcesRaw : realGetters.getFlagSettingSourcesRaw(),
    getFlagSettingsPath: () =>
      mockActive ? settingsPath : realGetters.getFlagSettingsPath(),
    getChromeFlagOverride: () =>
      mockActive ? undefined : realGetters.getChromeFlagOverride(),
    getInlinePlugins: () =>
      mockActive ? [] : realGetters.getInlinePlugins(),
    getMainLoopModelOverride: () =>
      mockActive ? undefined : realGetters.getMainLoopModelOverride(),
    getSessionBypassPermissionsMode: () =>
      mockActive ? false : realGetters.getSessionBypassPermissionsMode(),
    getSessionId: () =>
      mockActive ? 'test-session-id' : realGetters.getSessionId(),
  }))
  spawnModule = await import('../spawnMultiAgent.js')
})

afterAll(() => {
  // Flip the state.js mock into pass-through mode — do NOT re-spread
  // actualStateModule, which would re-install the leak (see above).
  mockActive = false
})

describe('2.1.281 #039: buildInheritedCliFlags --setting-sources propagation', () => {
  test('omits --setting-sources when the parent never set the flag', () => {
    settingSourcesRaw = undefined
    settingsPath = undefined
    const flags = spawnModule.buildInheritedCliFlags()
    expect(flags).not.toContain('--setting-sources')
  })

  test('propagates the raw --setting-sources value when the parent set it', () => {
    settingSourcesRaw = 'user,project'
    settingsPath = undefined
    const flags = spawnModule.buildInheritedCliFlags()
    // quote() is OCC's shell-safe serializer (`=`/`,` become `\=`/`\,`);
    // compare against the same quote() the implementation uses.
    expect(flags).toContain(quote(['--setting-sources=user,project']))
  })

  test('propagates an empty raw value verbatim (explicit --setting-sources=)', () => {
    settingSourcesRaw = ''
    const flags = spawnModule.buildInheritedCliFlags()
    expect(flags).toContain(quote(['--setting-sources=']))
  })

  test('coexists with the existing --settings propagation', () => {
    settingSourcesRaw = 'user'
    settingsPath = '/tmp/settings.json'
    const flags = spawnModule.buildInheritedCliFlags()
    expect(flags).toContain('--settings /tmp/settings.json')
    expect(flags).toContain(quote(['--setting-sources=user']))
  })

  test('quotes raw values containing shell metacharacters', () => {
    settingSourcesRaw = 'user project'
    const flags = spawnModule.buildInheritedCliFlags()
    const quoted = quote(['--setting-sources=user project'])
    expect(flags).toContain(quoted)
    // The space must not survive unquoted (would split into two argv entries)
    expect(quoted !== '--setting-sources=user project').toBe(true)
  })
})
