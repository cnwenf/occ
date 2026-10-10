/**
 * Tests for the CC 2.1.296 plugin-secrets fix (changelog: "Fixed plugin
 * secrets named `constructor` or `prototype` being deleted by the next save";
 * evidence: /tmp/cc296/ev-secrets296.txt — official save shape
 * `L = S ? Av(S, (b,P) => !h.has(P)) : void 0`, merge `{...L, ...d}`, log
 * "saveMcpServerUserConfig: scrubbed N stale non-sensitive key(s) from
 * secureStorage for K").
 *
 * FINDING (documented deviation): OCC's pluginOptionsStorage.ts and
 * mcpbHandler.ts ALREADY matched the 296 shape before this round — the
 * secureStorage merge is `{...secureScrubbed, ...sensitive}` with the scrub
 * set built from THIS save's non-sensitive keys only, and the write is skipped
 * when there is nothing sensitive and nothing to scrub. These tests pin that
 * behavior as regression coverage: no source change was needed for Item 3.
 *
 * Scaffolding: the 295 in-memory settings/secureStorage/log mocks
 * (OCC-97/OCC-103 delegation pattern) plus a '../../debug.js'
 * logForDebugging capture for the official scrub-log assertion.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

type SettingsLike = Record<string, any>

const jsonClone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value ?? null)) as T

let mockActive = false
let settingsStore: SettingsLike = {}
let secureStore: Record<string, any> = {}
let loggedErrors: unknown[] = []
let debugLogs: string[] = []

let actualSettingsMod: Record<string, unknown>
let actualSecureMod: Record<string, unknown>
let actualLogMod: Record<string, unknown>
let actualDebugMod: Record<string, unknown>
let realGetSettings: () => SettingsLike
let realUpdateSettings: (source: string, settings: SettingsLike) => unknown
let realGetSecureStorage: () => unknown
let realLogError: (error: unknown) => void
let realLogForDebugging: (message: string, options?: unknown) => void

let storage: typeof import('../pluginOptionsStorage.js')
let mcpb: typeof import('../mcpbHandler.js')
let safety: typeof import('../optionKeySafety.js')

beforeAll(async () => {
  actualSettingsMod = await import('../../settings/settings.js')
  actualSecureMod = await import('../../secureStorage/index.js')
  actualLogMod = await import('../../log.js')
  actualDebugMod = await import('../../debug.js')
  const actualSettings = actualSettingsMod as any
  const actualSecure = actualSecureMod as any
  const actualLog = actualLogMod as any
  const actualDebug = actualDebugMod as any
  realGetSettings = actualSettings.getSettings_DEPRECATED
  realUpdateSettings = actualSettings.updateSettingsForSource
  realGetSecureStorage = actualSecure.getSecureStorage
  realLogError = actualLog.logError
  realLogForDebugging = actualDebug.logForDebugging

  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsMod,
    getSettings_DEPRECATED: () =>
      mockActive ? jsonClone(settingsStore) : realGetSettings(),
    updateSettingsForSource: (source: string, settings: SettingsLike) => {
      if (!mockActive) return realUpdateSettings(source, settings)
      settingsStore = jsonClone(settings)
      return {}
    },
  }))
  mock.module('../../secureStorage/index.js', () => ({
    ...actualSecureMod,
    getSecureStorage: () =>
      mockActive
        ? {
            read: () => jsonClone(secureStore),
            update: (data: Record<string, any>) => {
              secureStore = jsonClone(data)
              return { success: true }
            },
          }
        : realGetSecureStorage(),
  }))
  mock.module('../../log.js', () => ({
    ...actualLogMod,
    logError: (error: unknown) => {
      if (mockActive) {
        loggedErrors.push(error)
        return
      }
      realLogError(error)
    },
  }))
  mock.module('../../debug.js', () => ({
    ...actualDebugMod,
    logForDebugging: (message: string, options?: unknown) => {
      if (mockActive) {
        debugLogs.push(message)
        return
      }
      realLogForDebugging(message, options)
    },
  }))

  mockActive = true
  // Import AFTER the mocks are installed so the storage modules bind them.
  storage = await import('../pluginOptionsStorage.js')
  mcpb = await import('../mcpbHandler.js')
  safety = await import('../optionKeySafety.js')
})

afterAll(() => {
  mockActive = false
})

beforeEach(() => {
  settingsStore = {}
  secureStore = {}
  loggedErrors = []
  debugLogs = []
  storage.clearPluginOptionsCache()
})

// ---------------------------------------------------------------------------
// savePluginOptions / loadPluginOptions — secrets named constructor/prototype
// ---------------------------------------------------------------------------
describe('savePluginOptions — prototype-named secrets survive later saves (2.1.296)', () => {
  test('a secret named `constructor` survives a subsequent partial save that does not mention it', () => {
    // Arrange — first save stores two sensitive values, one named
    // `constructor` (the changelog bug: the NEXT save deleted it).
    storage.savePluginOptions(
      'p@mp',
      { constructor: 'ctor-secret', token: 't1' },
      {
        constructor: { type: 'string', sensitive: true },
        token: { type: 'string', sensitive: true },
      },
    )
    expect(secureStore.pluginSecrets['p@mp']).toEqual({
      constructor: 'ctor-secret',
      token: 't1',
    })

    // Act — a later save re-enters only `token`.
    storage.savePluginOptions(
      'p@mp',
      { token: 't2' },
      { token: { type: 'string', sensitive: true } },
    )

    // Assert — official merge `{...L, ...d}`: untouched keys preserved,
    // re-entered key updated.
    expect(secureStore.pluginSecrets['p@mp']).toEqual({
      constructor: 'ctor-secret',
      token: 't2',
    })
    const loaded = storage.loadPluginOptions('p@mp')
    expect(safety.readOwnOption(loaded, 'constructor')).toBe('ctor-secret')
    expect(safety.readOwnOption(loaded, 'token')).toBe('t2')
  })

  test('a secret named `prototype` survives a subsequent non-sensitive save', () => {
    // Arrange
    storage.savePluginOptions(
      'p@mp',
      { prototype: 'proto-secret' },
      { prototype: { type: 'string', sensitive: true } },
    )
    expect(secureStore.pluginSecrets['p@mp']).toEqual({
      prototype: 'proto-secret',
    })

    // Act — next save carries ONLY a non-sensitive key. The scrub set is
    // built from this save's non-sensitive keys (`!h.has(P)`), so
    // `prototype` is not a candidate and the secret must survive.
    storage.savePluginOptions(
      'p@mp',
      { theme: 'dark' },
      { theme: { type: 'string' } },
    )

    // Assert
    expect(secureStore.pluginSecrets['p@mp']).toEqual({
      prototype: 'proto-secret',
    })
    expect(settingsStore.pluginConfigs['p@mp'].options.theme).toBe('dark')
    const loaded = storage.loadPluginOptions('p@mp')
    expect(safety.readOwnOption(loaded, 'prototype')).toBe('proto-secret')
    expect(loaded.theme).toBe('dark')
  })

  test('all-non-sensitive save with an existing `constructor` secret SKIPS the secureStorage write entirely', () => {
    // Arrange — hand-seeded keychain state: a secret named `constructor`
    // (this is the exact shape the pre-296 bug deleted on the next save:
    // the inherited-member read made the merge/scrub logic drop it).
    secureStore = { pluginSecrets: { 'p@mp': { constructor: 'sec' } } }

    // Act
    storage.savePluginOptions(
      'p@mp',
      { theme: 'dark' },
      { theme: { type: 'string' } },
    )

    // Assert — nothing sensitive and nothing to scrub (official skip when
    // `Object.keys(d).length === 0 && w === 0`) → secureStorage untouched.
    expect(secureStore.pluginSecrets['p@mp']).toEqual({ constructor: 'sec' })
    expect(settingsStore.pluginConfigs['p@mp'].options.theme).toBe('dark')
  })

  test('a stale NON-SENSITIVE key is still scrubbed from secureStorage while the `constructor` secret is retained', () => {
    // Arrange — schema flip: `legacy` used to be sensitive (still sits in
    // secureStorage) and is now non-sensitive; `constructor` stays sensitive.
    secureStore = {
      pluginSecrets: { 'p@mp': { legacy: 'old-secret', constructor: 'sec' } },
    }

    // Act
    storage.savePluginOptions(
      'p@mp',
      { legacy: 'plain-now' },
      { legacy: { type: 'string' } },
    )

    // Assert — official `Av(S, (b,P) => !h.has(P))`: only keys re-written as
    // non-sensitive in THIS save are scrubbed; the constructor secret stays.
    expect(secureStore.pluginSecrets['p@mp']).toEqual({ constructor: 'sec' })
    expect(settingsStore.pluginConfigs['p@mp'].options.legacy).toBe(
      'plain-now',
    )
  })
})

// ---------------------------------------------------------------------------
// saveMcpServerUserConfig — same shape under the "pluginId/server" key + the
// official scrub log line
// ---------------------------------------------------------------------------
describe('saveMcpServerUserConfig — prototype-named secrets + official scrub log (2.1.296)', () => {
  test('scrubs a stale non-sensitive key, RETAINS the constructor secret, and logs the official line', () => {
    // Arrange
    secureStore = {
      pluginSecrets: { 'p@mp/srv': { legacy: 'x', constructor: 'sec' } },
    }

    // Act
    mcpb.saveMcpServerUserConfig(
      'p@mp',
      'srv',
      { legacy: 'plain', constructor: 'sec2' },
      {
        legacy: { type: 'string' },
        constructor: { type: 'string', sensitive: true },
      },
    )

    // Assert — legacy scrubbed (moved to settings), constructor retained and
    // updated by the `{...L, ...d}` merge.
    expect(secureStore.pluginSecrets['p@mp/srv']).toEqual({
      constructor: 'sec2',
    })
    expect(
      settingsStore.pluginConfigs['p@mp'].mcpServers.srv.legacy,
    ).toBe('plain')
    // Official log line, byte-for-byte (evidence ev-secrets296.txt).
    expect(debugLogs).toContain(
      'saveMcpServerUserConfig: scrubbed 1 stale non-sensitive key(s) from secureStorage for p@mp/srv',
    )
  })

  test('a constructor secret survives a partial server save with NO scrub log and NO secureStorage rewrite', () => {
    // Arrange — first save stores the secret.
    mcpb.saveMcpServerUserConfig(
      'p@mp',
      'srv',
      { constructor: 'sec' },
      { constructor: { type: 'string', sensitive: true } },
    )
    expect(secureStore.pluginSecrets['p@mp/srv']).toEqual({
      constructor: 'sec',
    })
    debugLogs = []

    // Act — later save mentions only a non-sensitive key.
    mcpb.saveMcpServerUserConfig(
      'p@mp',
      'srv',
      { other: 'v' },
      { other: { type: 'string' } },
    )

    // Assert — skip-write path: secret intact, no scrub happened, so the
    // official log (which fires iff scrub-count > 0) is absent.
    expect(secureStore.pluginSecrets['p@mp/srv']).toEqual({
      constructor: 'sec',
    })
    expect(
      debugLogs.some(m => m.includes('stale non-sensitive key')),
    ).toBe(false)
  })
})
