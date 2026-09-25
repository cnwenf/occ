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

beforeAll(async () => {
  actualStateModule = await import('../../../bootstrap/state.js')
  mock.module('../../../bootstrap/state.js', () => ({
    ...actualStateModule,
    getFlagSettingSourcesRaw: () => settingSourcesRaw,
    getFlagSettingsPath: () => settingsPath,
    getChromeFlagOverride: () => undefined,
    getInlinePlugins: () => [],
    getMainLoopModelOverride: () => undefined,
    getSessionBypassPermissionsMode: () => false,
    getSessionId: () => 'test-session-id',
  }))
  spawnModule = await import('../spawnMultiAgent.js')
})

afterAll(() => {
  mock.module('../../../bootstrap/state.js', () => actualStateModule)
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
