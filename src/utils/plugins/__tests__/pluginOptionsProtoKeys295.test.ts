/**
 * Tests for the CC 2.1.295 security port (changelog: "Fixed plugin options
 * named `constructor` or `prototype` always reading as their default and
 * never reloading the plugin when edited").
 *
 * Covers:
 *  - `optionKeySafety.ts` helpers (official `pge(e){return e!=="__proto__"}`
 *    reject + own-property reads).
 *  - `validateUserConfig` (mcpbHandler.ts) treating a `constructor` schema
 *    field as absent unless an own value was saved.
 *  - `savePluginOptions`/`loadPluginOptions` round-trip for options named
 *    `constructor` (non-sensitive + sensitive), reload-after-edit via the
 *    memoize cache clear, and `__proto__` rejection on save / filtering on
 *    load (prototype-pollution guard — asserts `({}).polluted` stays
 *    undefined).
 *  - `${user_config.KEY}` substitution own-property reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// ---------------------------------------------------------------------------
// In-memory settings + secureStorage + log mocks, installed with the
// OCC-97/OCC-103 delegation pattern: the mock factory stays installed for the
// whole worker, but every getter delegates back to the real implementation
// once `mockActive` flips false in afterAll — no leak into later test files.
// ---------------------------------------------------------------------------

type SettingsLike = Record<string, any>

const jsonClone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value ?? null)) as T

let mockActive = false
let settingsStore: SettingsLike = {}
let secureStore: Record<string, any> = {}
let loggedErrors: unknown[] = []

let actualSettingsMod: Record<string, unknown>
let actualSecureMod: Record<string, unknown>
let actualLogMod: Record<string, unknown>
let realGetSettings: () => SettingsLike
let realUpdateSettings: (source: string, settings: SettingsLike) => unknown
let realGetSecureStorage: () => unknown
let realLogError: (error: unknown) => void

let storage: typeof import('../pluginOptionsStorage.js')
let mcpb: typeof import('../mcpbHandler.js')
let safety: typeof import('../optionKeySafety.js')

beforeAll(async () => {
  actualSettingsMod = await import('../../settings/settings.js')
  actualSecureMod = await import('../../secureStorage/index.js')
  actualLogMod = await import('../../log.js')
  const actualSettings = actualSettingsMod as any
  const actualSecure = actualSecureMod as any
  const actualLog = actualLogMod as any
  realGetSettings = actualSettings.getSettings_DEPRECATED
  realUpdateSettings = actualSettings.updateSettingsForSource
  realGetSecureStorage = actualSecure.getSecureStorage
  realLogError = actualLog.logError

  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsMod,
    getSettings_DEPRECATED: () =>
      mockActive ? jsonClone(settingsStore) : realGetSettings(),
    updateSettingsForSource: (source: string, settings: SettingsLike) => {
      if (!mockActive) return realUpdateSettings(source, settings)
      // Simulate the disk round-trip: undefined-valued keys (mergeWith
      // deletion markers) drop, `__proto__` own data keys survive JSON.
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

  mockActive = true
  // Import AFTER the mocks are installed so pluginOptionsStorage binds them.
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
  storage.clearPluginOptionsCache()
})

// ---------------------------------------------------------------------------

describe('optionKeySafety helpers (official pge + own-property reads)', () => {
  test('isStorableOptionKey rejects only __proto__', () => {
    expect(safety.isStorableOptionKey('__proto__')).toBe(false)
    expect(safety.isStorableOptionKey('constructor')).toBe(true)
    expect(safety.isStorableOptionKey('prototype')).toBe(true)
  })

  test('readOwnOption never returns an inherited Object.prototype member', () => {
    const table = {} as Record<string, unknown>
    expect(safety.readOwnOption(table, 'constructor')).toBeUndefined()
    expect(safety.readOwnOption(table, 'prototype')).toBeUndefined()
    expect(safety.readOwnOption(table, 'toString')).toBeUndefined()
    expect(safety.readOwnOption({ constructor: 'real' }, 'constructor')).toBe(
      'real',
    )
    expect(safety.readOwnOption(null, 'constructor')).toBeUndefined()
    expect(safety.readOwnOption(undefined, 'constructor')).toBeUndefined()
  })

  test('withoutUnsafeOptionKeys drops a stored __proto__ own key', () => {
    // Arrange — JSON.parse creates `__proto__` as an own data property
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "ok": "v"}')
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true)

    // Act
    const filtered = safety.withoutUnsafeOptionKeys(parsed)

    // Assert
    expect(Object.hasOwn(filtered, '__proto__')).toBe(false)
    expect(filtered.ok).toBe('v')
  })
})

describe('validateUserConfig — constructor/prototype schema fields (2.1.295)', () => {
  test('reports a required "constructor" option as missing when unsaved', () => {
    // Before the fix, values['constructor'] read Object.prototype.constructor
    // (a function) and the required check passed with a bogus value.
    const result = mcpb.validateUserConfig(
      {},
      { constructor: { type: 'string', required: true, title: 'Constructor' } },
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      'Constructor is required but not provided',
    ])
  })

  test('validates the saved own value of a "constructor" option', () => {
    const result = mcpb.validateUserConfig(
      { constructor: 'real-value' },
      { constructor: { type: 'string', required: true } },
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('validates a saved own value of a "prototype" option', () => {
    const result = mcpb.validateUserConfig(
      { prototype: 'p' },
      { prototype: { type: 'string', required: true } },
    )

    expect(result.valid).toBe(true)
  })

  test('type-checks a saved "constructor" value instead of the inherited function', () => {
    // Own value present but wrong type → the normal type error, not a pass.
    const result = mcpb.validateUserConfig(
      { constructor: 42 },
      { constructor: { type: 'string', title: 'Constructor' } },
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(['Constructor must be a string'])
  })
})

describe('savePluginOptions/loadPluginOptions — constructor option (2.1.295)', () => {
  test('stores and reads back the real value of a "constructor" option', () => {
    // Arrange
    const schema = { constructor: { type: 'string' } }

    // Act
    storage.savePluginOptions('p@mp', { constructor: 'v1' }, schema)

    // Assert — written to settings.json (non-sensitive branch)
    const written = settingsStore.pluginConfigs['p@mp'].options
    expect(Object.hasOwn(written, 'constructor')).toBe(true)
    expect(safety.readOwnOption(written, 'constructor')).toBe('v1')
    // Real Object.prototype untouched
    expect({}.constructor).toBe(Object)

    const loaded = storage.loadPluginOptions('p@mp')
    expect(Object.hasOwn(loaded, 'constructor')).toBe(true)
    expect(safety.readOwnOption(loaded, 'constructor')).toBe('v1')
  })

  test('routes a sensitive "constructor" option to secureStorage by its own schema entry', () => {
    // Arrange
    const schema = { constructor: { type: 'string', sensitive: true } }

    // Act
    storage.savePluginOptions('p@mp', { constructor: 'secret' }, schema)

    // Assert
    expect(secureStore.pluginSecrets['p@mp'].constructor).toBe('secret')
    const loaded = storage.loadPluginOptions('p@mp')
    expect(safety.readOwnOption(loaded, 'constructor')).toBe('secret')
  })

  test('editing a "constructor" option triggers reload (memoize cache cleared)', () => {
    // Arrange
    const schema = { constructor: { type: 'string' } }
    storage.savePluginOptions('p@mp', { constructor: 'v1' }, schema)
    expect(
      safety.readOwnOption(storage.loadPluginOptions('p@mp'), 'constructor'),
    ).toBe('v1')

    // Act — edit; savePluginOptions must clear the load cache so the next
    // loadPluginOptions sees the new value (the official "never reloading the
    // plugin when edited" half of the bug).
    storage.savePluginOptions('p@mp', { constructor: 'v2' }, schema)

    // Assert
    expect(
      safety.readOwnOption(storage.loadPluginOptions('p@mp'), 'constructor'),
    ).toBe('v2')
  })
})

describe('__proto__ rejection (official pge)', () => {
  test('save drops a __proto__ key instead of writing/polluting with it', () => {
    // Arrange — JSON.parse gives an own `__proto__` data property
    const values = JSON.parse('{"__proto__": {"polluted": true}, "ok": "v"}')
    const schema = { ok: { type: 'string' } }

    // Act
    storage.savePluginOptions('p@mp', values, schema)

    // Assert
    expect(({} as any).polluted).toBeUndefined()
    const written = settingsStore.pluginConfigs['p@mp'].options
    expect(Object.hasOwn(written, '__proto__')).toBe(false)
    expect(written.ok).toBe('v')
    expect(Object.getPrototypeOf(written)).toBe(Object.prototype)
  })

  test('load ignores a __proto__ key present in stored settings JSON', () => {
    // Arrange — simulate a hand-edited settings.json with a poisoned entry
    settingsStore = {
      pluginConfigs: {
        'p@mp': {
          options: JSON.parse('{"__proto__": {"polluted": true}, "ok": "v"}'),
        },
      },
    }
    storage.clearPluginOptionsCache()

    // Act
    const loaded = storage.loadPluginOptions('p@mp')

    // Assert
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.hasOwn(loaded, '__proto__')).toBe(false)
    expect(loaded.ok).toBe('v')
  })

  test('load ignores a __proto__ key present in secureStorage', () => {
    // Arrange
    secureStore = {
      pluginSecrets: {
        'p@mp': JSON.parse('{"__proto__": {"polluted": true}, "tok": "s"}'),
      },
    }
    storage.clearPluginOptionsCache()

    // Act
    const loaded = storage.loadPluginOptions('p@mp')

    // Assert
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.hasOwn(loaded, '__proto__')).toBe(false)
    expect(loaded.tok).toBe('s')
  })
})

describe('getUnconfiguredOptions — own-property saved reads', () => {
  test('lists a "constructor" option as unconfigured until a real value is saved', () => {
    // Arrange
    const plugin = {
      source: 'p@mp',
      manifest: {
        userConfig: { constructor: { type: 'string', required: true } },
      },
    } as any

    // Act & Assert — nothing saved → unconfigured (before the fix, the
    // inherited Object constructor made validation pass with a bogus value)
    expect(Object.keys(storage.getUnconfiguredOptions(plugin))).toEqual([
      'constructor',
    ])

    storage.savePluginOptions(
      'p@mp',
      { constructor: 'real' },
      plugin.manifest.userConfig,
    )
    expect(storage.getUnconfiguredOptions(plugin)).toEqual({})
  })
})

describe('user_config substitution — own-property reads (2.1.295)', () => {
  test('substitutes the saved own value of a "constructor" option', () => {
    expect(
      storage.substituteUserConfigVariables(
        'run --ctor ${user_config.constructor}',
        { constructor: 'real' },
      ),
    ).toBe('run --ctor real')
  })

  test('throws Missing for ${user_config.constructor} with no own value', () => {
    expect(() =>
      storage.substituteUserConfigVariables('${user_config.constructor}', {}),
    ).toThrow('Missing required user configuration value: constructor')
  })

  test('throws Missing for ${user_config.__proto__} instead of touching the prototype', () => {
    expect(() =>
      storage.substituteUserConfigVariables('${user_config.__proto__}', {}),
    ).toThrow('Missing required user configuration value: __proto__')
    expect(({} as any).polluted).toBeUndefined()
  })

  test('content variant masks a sensitive "constructor" via its own schema entry', () => {
    expect(
      storage.substituteUserConfigInContent(
        'use ${user_config.constructor} now',
        { constructor: 'secret' },
        { constructor: { type: 'string', sensitive: true } },
      ),
    ).toBe(
      "use [sensitive option 'constructor' not available in skill content] now",
    )
  })

  test('content variant leaves unknown/inherited keys literal', () => {
    expect(
      storage.substituteUserConfigInContent(
        '${user_config.toString} and ${user_config.constructor}',
        {},
        {},
      ),
    ).toBe('${user_config.toString} and ${user_config.constructor}')
  })
})
