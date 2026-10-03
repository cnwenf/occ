/**
 * Gap-288 #79 — per-model auto-compact window (official v2.1.288).
 *
 * Official v288 stores `autoCompactWindow` under `modelSettings[canonicalKey]`
 * (writer `Mqr` with an Object.prototype-pollution guard + top-level
 * fallback; key normalizer `iV`), aggregates it per settings file with
 * whole-contribution replacement (`WIt`), and resolves it with `Dw`
 * (env → settings(byModel → default, skipping "auto") → … → auto).
 *
 * Symbol map (official → OCC):
 *   WIt = aggregateAutoCompactWindow     iV  = getCanonicalName
 *   Dw  = resolveAutoCompactWindow       Mqr = buildAutoCompactWindowPatch
 *   XEo = resolveAutoCompactWindowOverride   gr = formatTokens
 *
 * Mock plumbing mirrors effortCap267.test.ts: settings sources are mocked
 * BEFORE the module under test is imported, with a `mockActive` leak guard and
 * an afterAll re-pin so the shared bun process stays clean for other files.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// ---------------------------------------------------------------------------
// Mock plumbing (pattern: effortCap267.test.ts)
// ---------------------------------------------------------------------------

const actualSettingsModule = await import('../settings/settings.js')
const actualConstantsModule = await import('../settings/constants.js')

let settingsBySource: Record<string, Record<string, unknown> | null> = {}
let enabledSources: string[] = ['userSettings', 'projectSettings']
const settingsWrites: Array<{
  source: string
  settings: Record<string, unknown>
}> = []

const actualGetSettingsForSource = actualSettingsModule.getSettingsForSource
const actualGetInitialSettings = actualSettingsModule.getInitialSettings
const actualUpdateSettingsForSource =
  actualSettingsModule.updateSettingsForSource
const actualGetEnabledSettingSources =
  actualConstantsModule.getEnabledSettingSources

let mockActive = true

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Mirrors settings.ts mergeWith: deep-merge, `undefined` deletes the key. */
function deepMergeSettings(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete out[key]
      continue
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMergeSettings(out[key] as Record<string, unknown>, value)
    } else {
      out[key] = value
    }
  }
  return out
}

mock.module('../settings/settings.js', () => ({
  ...actualSettingsModule,
  getSettingsForSource: (
    source: Parameters<typeof actualGetSettingsForSource>[0],
  ) =>
    mockActive
      ? (settingsBySource[source] ?? null)
      : actualGetSettingsForSource(source),
  getInitialSettings: () => {
    if (!mockActive) return actualGetInitialSettings()
    let merged: Record<string, unknown> = {}
    for (const source of enabledSources) {
      merged = { ...merged, ...(settingsBySource[source] ?? {}) }
    }
    return merged
  },
  updateSettingsForSource: (
    source: Parameters<typeof actualUpdateSettingsForSource>[0],
    settings: Parameters<typeof actualUpdateSettingsForSource>[1],
  ) => {
    if (!mockActive) {
      return actualUpdateSettingsForSource(source, settings)
    }
    settingsWrites.push({
      source,
      settings: settings as Record<string, unknown>,
    })
    // Apply the merge so post-write reloads (aggregateAutoCompactWindow) see it.
    settingsBySource[source] = deepMergeSettings(
      settingsBySource[source] ?? {},
      settings as Record<string, unknown>,
    )
    return { error: null }
  },
}))

mock.module('../settings/constants.js', () => ({
  ...actualConstantsModule,
  getEnabledSettingSources: () =>
    mockActive ? [...enabledSources] : actualGetEnabledSettingSources(),
}))

afterAll(() => {
  mockActive = false
  mock.module('../settings/settings.js', () => ({
    ...actualSettingsModule,
    getSettingsForSource: actualGetSettingsForSource,
    getInitialSettings: actualGetInitialSettings,
    updateSettingsForSource: actualUpdateSettingsForSource,
  }))
  mock.module('../settings/constants.js', () => ({
    ...actualConstantsModule,
    getEnabledSettingSources: actualGetEnabledSettingSources,
  }))
})

// Modules under test — imported AFTER mocks.
const {
  aggregateAutoCompactWindow,
  resolveAutoCompactWindow,
  buildAutoCompactWindowPatch,
  resolveAutoCompactWindowOverride,
  setSessionAutoCompactWindow,
  getSessionAutoCompactWindow,
} = await import('../autoCompactWindow.js')
const { formatTokens } = await import('../format.js')
const { getCanonicalName } = await import('../model/model.js')
const { SettingsSchema: settingsSchemaFactory } = await import(
  '../settings/types.js'
)
const SettingsSchema = settingsSchemaFactory()
const { call: autocompactCall } = await import(
  '../../commands/autocompact/autocompact-noninteractive.js'
)
import type { ToolUseContext } from '../../Tool.js'

// ---------------------------------------------------------------------------
// Env hygiene + fixtures
// ---------------------------------------------------------------------------

const ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const SONNET = 'claude-sonnet-4-6'
const OPUS = 'claude-opus-4-7'
const BIG_WINDOW = 1_000_000

function makeContext(model: string): ToolUseContext {
  return { options: { mainLoopModel: model } } as unknown as ToolUseContext
}

beforeEach(() => {
  settingsBySource = {}
  enabledSources = ['userSettings', 'projectSettings']
  settingsWrites.length = 0
  setSessionAutoCompactWindow(undefined)
  delete process.env[ENV_KEY]
})

afterEach(() => {
  setSessionAutoCompactWindow(undefined)
  delete process.env[ENV_KEY]
})

// ---------------------------------------------------------------------------
// aggregateAutoCompactWindow (official WIt)
// ---------------------------------------------------------------------------

describe('Gap-288 #79 — aggregateAutoCompactWindow (official WIt)', () => {
  test('a per-model window affects only that model; others use the default', () => {
    // Arrange
    settingsBySource.userSettings = {
      autoCompactWindow: 200_000,
      modelSettings: { [SONNET]: { autoCompactWindow: 300_000 } },
    }

    // Act
    const aggregate = aggregateAutoCompactWindow()

    // Assert
    expect(aggregate.default).toBe(200_000)
    expect(aggregate.byModel[SONNET]).toBe(300_000)
    expect(
      resolveAutoCompactWindow(SONNET, BIG_WINDOW, aggregate).configured,
    ).toBe(300_000)
    expect(
      resolveAutoCompactWindow(OPUS, BIG_WINDOW, aggregate).configured,
    ).toBe(200_000)
  })

  test('canonical-key collapse: dated / [1m] / Bedrock / Vertex spellings fold to one key', () => {
    // Arrange: written under the [1m] spelling.
    settingsBySource.userSettings = {
      modelSettings: { 'claude-opus-4-5[1m]': { autoCompactWindow: 400_000 } },
    }

    // Act
    const aggregate = aggregateAutoCompactWindow()

    // Assert: the canonical key is claude-opus-4-5, and every spelling of that
    // model resolves to the same per-model value.
    expect(aggregate.byModel['claude-opus-4-5']).toBe(400_000)
    for (const spelling of [
      'claude-opus-4-5',
      'claude-opus-4-5-20251101',
      'us.anthropic.claude-opus-4-5-v1:0',
      'claude-opus-4-5@20251101',
    ]) {
      expect(getCanonicalName(spelling as never)).toBe('claude-opus-4-5')
      expect(
        resolveAutoCompactWindow(spelling, BIG_WINDOW, aggregate).configured,
      ).toBe(400_000)
    }
  })

  test('a file WITH a top-level window replaces the whole contribution', () => {
    // Arrange: userSettings has a per-model entry + top-level; projectSettings
    // (higher priority) has a top-level scalar and NO per-model entries.
    enabledSources = ['userSettings', 'projectSettings']
    settingsBySource.userSettings = {
      autoCompactWindow: 200_000,
      modelSettings: { [SONNET]: { autoCompactWindow: 300_000 } },
    }
    settingsBySource.projectSettings = {
      autoCompactWindow: 250_000,
    }

    // Act
    const aggregate = aggregateAutoCompactWindow()

    // Assert: projectSettings replaced the accumulation — its (empty) byModel
    // wins, and default is projectSettings' scalar.
    expect(aggregate.default).toBe(250_000)
    expect(aggregate.byModel[SONNET]).toBeUndefined()
  })

  test('a file WITHOUT a top-level window merges byModel and keeps default', () => {
    // Arrange
    enabledSources = ['userSettings', 'projectSettings']
    settingsBySource.userSettings = {
      autoCompactWindow: 200_000,
      modelSettings: { [SONNET]: { autoCompactWindow: 300_000 } },
    }
    settingsBySource.projectSettings = {
      modelSettings: { [OPUS]: { autoCompactWindow: 400_000 } },
    }

    // Act
    const aggregate = aggregateAutoCompactWindow()

    // Assert: default kept from userSettings; byModel merged across both.
    expect(aggregate.default).toBe(200_000)
    expect(aggregate.byModel[SONNET]).toBe(300_000)
    expect(aggregate.byModel[OPUS]).toBe(400_000)
  })

  test('undefined per-model windows are skipped; "auto" values are kept', () => {
    // Arrange
    settingsBySource.userSettings = {
      modelSettings: {
        [SONNET]: { autoCompactWindow: undefined },
        [OPUS]: { autoCompactWindow: 'auto' },
      },
    }

    // Act
    const aggregate = aggregateAutoCompactWindow()

    // Assert
    expect(Object.hasOwn(aggregate.byModel, SONNET)).toBe(false)
    expect(aggregate.byModel[OPUS]).toBe('auto')
  })

  test('prototype-pollution keys in modelSettings do not pollute Object.prototype', () => {
    // Arrange: an own "__proto__" key smuggled via defineProperty (the schema
    // preprocess strips these in production; the aggregator must be safe too).
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, '__proto__', {
      value: { autoCompactWindow: 999_999 },
      enumerable: true,
      configurable: true,
      writable: true,
    })
    settingsBySource.userSettings = { modelSettings: hostile }

    // Act
    const aggregate = aggregateAutoCompactWindow()

    // Assert: no "__proto__" own key landed in byModel, and Object.prototype
    // is untouched.
    expect(Object.hasOwn(aggregate.byModel, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).autoCompactWindow).toBeUndefined()
  })

  test('the legacy top-level scalar still resolves as the default', () => {
    // Arrange: no modelSettings at all — the pre-#79 shape.
    settingsBySource.userSettings = { autoCompactWindow: 200_000 }

    // Act
    const aggregate = aggregateAutoCompactWindow()

    // Assert
    expect(aggregate.default).toBe(200_000)
    expect(Object.keys(aggregate.byModel).length).toBe(0)
    expect(
      resolveAutoCompactWindow(SONNET, BIG_WINDOW, aggregate).configured,
    ).toBe(200_000)
  })
})

// ---------------------------------------------------------------------------
// resolveAutoCompactWindow (official Dw — env / settings / auto branches)
// ---------------------------------------------------------------------------

describe('Gap-288 #79 — resolveAutoCompactWindow (official Dw)', () => {
  test('env takes precedence over byModel and default', () => {
    // Arrange
    process.env[ENV_KEY] = '150000'
    const aggregate = { default: 200_000, byModel: { [SONNET]: 300_000 } }

    // Act
    const resolved = resolveAutoCompactWindow(SONNET, BIG_WINDOW, aggregate)

    // Assert
    expect(resolved.source).toBe('env')
    expect(resolved.configured).toBe(150_000)
    expect(resolved.window).toBe(150_000)
  })

  test('byModel wins over default (settings source)', () => {
    // Arrange
    const aggregate = { default: 200_000, byModel: { [SONNET]: 300_000 } }

    // Act
    const sonnet = resolveAutoCompactWindow(SONNET, BIG_WINDOW, aggregate)
    const opus = resolveAutoCompactWindow(OPUS, BIG_WINDOW, aggregate)

    // Assert
    expect(sonnet.source).toBe('settings')
    expect(sonnet.configured).toBe(300_000)
    expect(opus.source).toBe('settings')
    expect(opus.configured).toBe(200_000)
  })

  test('an explicit per-model "auto" blocks fallback to the default', () => {
    // Arrange: byModel has "auto" for SONNET; default is a real number.
    const aggregate = { default: 200_000, byModel: { [SONNET]: 'auto' as const } }

    // Act
    const resolved = resolveAutoCompactWindow(SONNET, BIG_WINDOW, aggregate)

    // Assert: "auto" skips the settings branch → resolves to the model window.
    expect(resolved.source).toBe('auto')
    expect(resolved.window).toBe(BIG_WINDOW)
    expect(resolved.configured).toBe(BIG_WINDOW)
  })

  test('a numeric session override resolves as settings', () => {
    // Act: XEo turns a numeric CLI flag into a bare number override.
    const resolved = resolveAutoCompactWindow(SONNET, BIG_WINDOW, 500_000)

    // Assert
    expect(resolved.source).toBe('settings')
    expect(resolved.configured).toBe(500_000)
    expect(resolved.window).toBe(500_000)
  })

  test('the window is capped to the model context window', () => {
    // Arrange: configured above the model window.
    const aggregate = { default: undefined, byModel: { [SONNET]: 900_000 } }

    // Act
    const resolved = resolveAutoCompactWindow(SONNET, 200_000, aggregate)

    // Assert
    expect(resolved.configured).toBe(900_000)
    expect(resolved.window).toBe(200_000)
  })

  test('no override and no env resolves to auto (configured = context window)', () => {
    // Act
    const resolved = resolveAutoCompactWindow(SONNET, BIG_WINDOW, undefined)

    // Assert
    expect(resolved.source).toBe('auto')
    expect(resolved.window).toBe(BIG_WINDOW)
    expect(resolved.configured).toBe(BIG_WINDOW)
  })
})

// ---------------------------------------------------------------------------
// resolveAutoCompactWindowOverride (official XEo)
// ---------------------------------------------------------------------------

describe('Gap-288 #79 — resolveAutoCompactWindowOverride (official XEo)', () => {
  test('undefined CLI value returns the settings aggregate', () => {
    // Arrange
    settingsBySource.userSettings = {
      autoCompactWindow: 200_000,
      modelSettings: { [SONNET]: { autoCompactWindow: 300_000 } },
    }

    // Act
    const override = resolveAutoCompactWindowOverride(undefined)

    // Assert: an aggregate object (not a bare scalar) so per-model wins.
    expect(typeof override).toBe('object')
    expect(override).not.toBe('auto')
    const aggregate = override as { default?: number; byModel: Record<string, unknown> }
    expect(aggregate.default).toBe(200_000)
    expect(aggregate.byModel[SONNET]).toBe(300_000)
  })

  test('"auto" clears the override to undefined', () => {
    expect(resolveAutoCompactWindowOverride('auto')).toBeUndefined()
  })

  test('a numeric flag passes through', () => {
    expect(resolveAutoCompactWindowOverride(500_000)).toBe(500_000)
  })
})

// ---------------------------------------------------------------------------
// buildAutoCompactWindowPatch (official Mqr — proto-pollution guard)
// ---------------------------------------------------------------------------

describe('Gap-288 #79 — buildAutoCompactWindowPatch (official Mqr)', () => {
  test('a normal model writes under modelSettings[canonicalKey]', () => {
    // Act
    const patch = buildAutoCompactWindowPatch(
      'claude-opus-4-5-20251101',
      500_000,
      500_000,
    )

    // Assert: canonical key, per-model shape.
    expect(patch).toEqual({
      modelSettings: { 'claude-opus-4-5': { autoCompactWindow: 500_000 } },
    })
  })

  test('a prototype-key model falls back to the top-level patch', () => {
    // Arrange: getCanonicalName passes these through unchanged.
    expect(getCanonicalName('__proto__' as never)).toBe('__proto__')
    expect(getCanonicalName('constructor' as never)).toBe('constructor')

    // Act
    const protoPatch = buildAutoCompactWindowPatch('__proto__', 500_000, 500_000)
    const ctorPatch = buildAutoCompactWindowPatch('constructor', 500_000, 500_000)

    // Assert: top-level fallback, never modelSettings[__proto__].
    expect(protoPatch).toEqual({ autoCompactWindow: 500_000 })
    expect(ctorPatch).toEqual({ autoCompactWindow: 500_000 })
    expect(({} as Record<string, unknown>).autoCompactWindow).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Settings schema — per-model autoCompactWindow
// ---------------------------------------------------------------------------

describe('Gap-288 #79 — modelSettings.autoCompactWindow schema', () => {
  test('accepts "auto" and in-range integers per model', () => {
    expect(
      SettingsSchema.safeParse({
        modelSettings: { [SONNET]: { autoCompactWindow: 'auto' } },
      }).success,
    ).toBe(true)
    expect(
      SettingsSchema.safeParse({
        modelSettings: { [SONNET]: { autoCompactWindow: 300_000 } },
      }).success,
    ).toBe(true)
  })

  test('out-of-range and invalid per-model values catch to undefined', () => {
    const low = SettingsSchema.safeParse({
      modelSettings: { [SONNET]: { autoCompactWindow: 99_999 } },
    })
    expect(low.success).toBe(true)
    if (low.success) {
      expect(
        (low.data.modelSettings?.[SONNET] as { autoCompactWindow?: unknown })
          .autoCompactWindow,
      ).toBeUndefined()
    }
    const bad = SettingsSchema.safeParse({
      modelSettings: { [SONNET]: { autoCompactWindow: 'big' } },
    })
    expect(bad.success).toBe(true)
    if (bad.success) {
      expect(
        (bad.data.modelSettings?.[SONNET] as { autoCompactWindow?: unknown })
          .autoCompactWindow,
      ).toBeUndefined()
    }
  })

  test('the per-model describe text is byte-exact from the official schema', () => {
    // Walk the wrapped chain (ZodCatch → ZodOptional → ZodPipe(preprocess) →
    // ZodRecord → value object → field) tolerating both zod v3 `_def` and v4
    // `def` internal shapes.
    function def(node: unknown): Record<string, unknown> | undefined {
      const n = node as Record<string, unknown>
      return (n?._def ?? n?.def) as Record<string, unknown> | undefined
    }
    function findAutoCompactWindowField(node: unknown, depth = 0): unknown {
      if (!node || depth > 8) return null
      const shape = (node as { shape?: Record<string, unknown> }).shape
      if (shape?.autoCompactWindow) return shape.autoCompactWindow
      const d = def(node) ?? {}
      for (const key of [
        'schema',
        'innerType',
        'valueType',
        'out',
        'in',
      ] as const) {
        const found = findAutoCompactWindowField(d[key], depth + 1)
        if (found) return found
      }
      return null
    }
    const field = findAutoCompactWindowField(
      SettingsSchema.shape.modelSettings,
    ) as { description?: string } | null
    expect(field).not.toBeNull()
    expect(field?.description).toBe(
      'Auto-compact window for this model, in tokens (100000 to 1000000), or "auto" for the window tuned for the model. Within one settings file it replaces the top-level autoCompactWindow for the model. /autocompact saves here. The canonical model name as key also matches its dated, [1m], Bedrock and Vertex spellings.',
    )
  })
})

// ---------------------------------------------------------------------------
// /autocompact command (official Kcs → w describe + nPt setter)
// ---------------------------------------------------------------------------

describe('Gap-288 #79 — /autocompact command', () => {
  test('the setter saves under modelSettings[canonicalKey] for a numeric value', async () => {
    // Act
    await autocompactCall('500k', makeContext(SONNET))

    // Assert
    expect(settingsWrites.length).toBe(1)
    expect(settingsWrites[0].source).toBe('userSettings')
    expect(settingsWrites[0].settings).toEqual({
      modelSettings: { [SONNET]: { autoCompactWindow: 500_000 } },
    })
  })

  test('the setter reports the model settingsKey and the saved token count', async () => {
    // Act
    const { value } = await autocompactCall('150k', makeContext(SONNET))

    // Assert
    expect(value).toContain(`Auto-compact window for ${SONNET}`)
    expect(value).toContain(`set to ${formatTokens(150_000)} tokens`)
  })

  test('reset/unset/default save a per-model "auto" and report "set to auto"', async () => {
    // Act
    const { value } = await autocompactCall('reset', makeContext(SONNET))

    // Assert
    expect(settingsWrites[0].settings).toEqual({
      modelSettings: { [SONNET]: { autoCompactWindow: 'auto' } },
    })
    expect(value).toContain(`Auto-compact window for ${SONNET} set to auto`)
  })

  test('the env var blocks the setter with the precedence message', async () => {
    // Arrange
    process.env[ENV_KEY] = '150000'

    // Act
    const { value } = await autocompactCall('500k', makeContext(SONNET))

    // Assert
    expect(value).toBe(
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset it to change this setting.',
    )
    expect(settingsWrites.length).toBe(0)
  })

  test('an unparseable value reports the parse error (byte-exact, en-dash)', async () => {
    // Act
    const { value } = await autocompactCall('abc', makeContext(SONNET))

    // Assert
    expect(value).toBe(
      "Couldn't parse 'abc'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)",
    )
    expect(settingsWrites.length).toBe(0)
  })

  test('after a numeric save, the effective window for that model reflects it', async () => {
    // Arrange
    enabledSources = ['userSettings']

    // Act
    await autocompactCall('150k', makeContext(SONNET))

    // Assert: the session override was refreshed to the fresh aggregate, so a
    // resolver read against the session now yields the saved per-model value.
    const session = getSessionAutoCompactWindow()
    expect(typeof session).toBe('object')
    const resolved = resolveAutoCompactWindow(
      SONNET,
      BIG_WINDOW,
      session as never,
    )
    expect(resolved.configured).toBe(150_000)
  })

  test('describe (no args) names the model settingsKey and the source', async () => {
    // Arrange: a per-model window, session override set to the aggregate.
    enabledSources = ['userSettings']
    settingsBySource.userSettings = {
      modelSettings: { [SONNET]: { autoCompactWindow: 150_000 } },
    }
    setSessionAutoCompactWindow(aggregateAutoCompactWindow())

    // Act
    const { value } = await autocompactCall('', makeContext(SONNET))

    // Assert
    expect(value).toContain(`Auto-compact window for ${SONNET}:`)
    expect(value).toContain(`${formatTokens(150_000)} tokens (from settings)`)
    expect(value).toContain(
      'Auto-compact summarizes the conversation when context usage approaches this limit.',
    )
    expect(value).toContain(
      'The auto setting picks a window tuned for your model and is strongly recommended for the best cost and performance.',
    )
    // env/settings source → the override warning line is present.
    expect(value).toContain(
      'Overriding auto may result in high token usage, especially when resuming long sessions.',
    )
  })
})
