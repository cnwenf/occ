/**
 * CC 2.1.302 changelog #07 — autocompact settings-key derivation with
 * alias-conditional normalization (official `dFt` before `Ke`).
 *
 * Fixed: "/autocompact and /effort saving to the wrong model when a gateway
 * names Opus 4 or 4.1 with a prefix, such as anthropic/claude-opus-4-1".
 *
 * v302 key derivation = canonicalize(normalize(specifier)) where normalize
 * resolves ONLY bare aliases:
 * - 'anthropic/claude-opus-4-1' → canonical 'claude-opus-4-1' (NEVER the
 *   remapped default Opus, never the raw prefixed string).
 * - bare 'opus' → the canonical resolved default Opus (NEVER the literal
 *   'opus' — OCC's pre-302 leak where the alias became the settings key).
 * - resolved concrete models round-trip unchanged (normalize is identity).
 *
 * Mock plumbing mirrors autoCompactWindowPerModel288.test.ts: settings
 * sources are mocked BEFORE the modules under test are imported, with a
 * `mockActive` leak guard and an afterAll re-pin.
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
// Mock plumbing (pattern: autoCompactWindowPerModel288.test.ts)
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
  buildAutoCompactWindowPatch,
  setSessionAutoCompactWindow,
} = await import('../autoCompactWindow.js')
const { getCanonicalName, parseUserSpecifiedModel } = await import(
  '../model/model.js'
)
const { call: autocompactCall } = await import(
  '../../commands/autocompact/autocompact-noninteractive.js'
)
import type { ToolUseContext } from '../../Tool.js'

// ---------------------------------------------------------------------------
// Env hygiene + fixtures
// ---------------------------------------------------------------------------

const ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const GATEWAY_OPUS_41 = 'anthropic/claude-opus-4-1'
const SONNET = 'claude-sonnet-4-6'

/** The canonical key a bare 'opus' specifier must resolve to. */
function resolvedOpusKey(): string {
  return getCanonicalName(parseUserSpecifiedModel('opus') as never)
}

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
// buildAutoCompactWindowPatch (official Mqr writer, dFt-normalized key)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #07 — buildAutoCompactWindowPatch key derivation', () => {
  test('a gateway-prefixed Opus 4.1 specifier stores under canonical claude-opus-4-1', () => {
    // Act
    const patch = buildAutoCompactWindowPatch(GATEWAY_OPUS_41, 500_000, 500_000)

    // Assert: the key derives from the gateway name itself — NOT the
    // remapped default Opus (the v301 official bug) and NOT the raw
    // prefixed string.
    expect(patch).toEqual({
      modelSettings: { 'claude-opus-4-1': { autoCompactWindow: 500_000 } },
    })
    const modelSettings = (patch as { modelSettings: Record<string, unknown> })
      .modelSettings
    expect(Object.hasOwn(modelSettings, resolvedOpusKey())).toBe(false)
    expect(Object.hasOwn(modelSettings, GATEWAY_OPUS_41)).toBe(false)
  })

  test("a bare 'opus' specifier stores under the canonical resolved Opus, not literal 'opus'", () => {
    // Act
    const patch = buildAutoCompactWindowPatch('opus', 500_000, 500_000)

    // Assert: the pre-302 OCC leak stored this under the literal alias key
    // 'opus' (getCanonicalName('opus') === 'opus').
    expect(patch).toEqual({
      modelSettings: { [resolvedOpusKey()]: { autoCompactWindow: 500_000 } },
    })
    const modelSettings = (patch as { modelSettings: Record<string, unknown> })
      .modelSettings
    expect(Object.hasOwn(modelSettings, 'opus')).toBe(false)
    expect(resolvedOpusKey()).not.toBe('opus')
  })

  test('an already-resolved concrete model round-trips unchanged (normalize is identity)', () => {
    // Regression: the fix must not perturb the resolved-input path.
    expect(buildAutoCompactWindowPatch(SONNET, 300_000, 300_000)).toEqual({
      modelSettings: { [SONNET]: { autoCompactWindow: 300_000 } },
    })
    expect(
      buildAutoCompactWindowPatch('claude-opus-4-5-20251101', 500_000, 500_000),
    ).toEqual({
      modelSettings: { 'claude-opus-4-5': { autoCompactWindow: 500_000 } },
    })
  })
})

// ---------------------------------------------------------------------------
// aggregateAutoCompactWindow (official WIt, dFt-normalized keys)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #07 — aggregateAutoCompactWindow key derivation', () => {
  test("a settings file keyed by bare 'opus' aggregates under the resolved canonical Opus", () => {
    // Arrange
    settingsBySource.userSettings = {
      modelSettings: { opus: { autoCompactWindow: 400_000 } },
    }

    // Act
    const aggregate = aggregateAutoCompactWindow()

    // Assert
    expect(Object.hasOwn(aggregate.byModel, 'opus')).toBe(false)
    expect(aggregate.byModel[resolvedOpusKey()]).toBe(400_000)
  })

  test('a gateway-prefixed settings key aggregates under its own canonical name', () => {
    // Arrange
    settingsBySource.userSettings = {
      modelSettings: { [GATEWAY_OPUS_41]: { autoCompactWindow: 400_000 } },
    }

    // Act
    const aggregate = aggregateAutoCompactWindow()

    // Assert: keyed by the gateway model's canonical name, never the
    // remapped default Opus.
    expect(aggregate.byModel['claude-opus-4-1']).toBe(400_000)
    expect(Object.hasOwn(aggregate.byModel, resolvedOpusKey())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// /autocompact command setter (official nPt via Mqr, dFt-normalized key)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #07 — /autocompact command key derivation', () => {
  test('setter with a gateway-prefixed specifier saves under canonical claude-opus-4-1', async () => {
    // Act
    await autocompactCall('500k', makeContext(GATEWAY_OPUS_41))

    // Assert
    expect(settingsWrites.length).toBe(1)
    expect(settingsWrites[0].source).toBe('userSettings')
    expect(settingsWrites[0].settings).toEqual({
      modelSettings: { 'claude-opus-4-1': { autoCompactWindow: 500_000 } },
    })
  })

  test("setter with bare 'opus' saves under the resolved canonical Opus, not literal 'opus'", async () => {
    // Act
    const { value } = await autocompactCall('500k', makeContext('opus'))

    // Assert
    expect(settingsWrites.length).toBe(1)
    expect(settingsWrites[0].settings).toEqual({
      modelSettings: { [resolvedOpusKey()]: { autoCompactWindow: 500_000 } },
    })
    // The user-facing describe line names the resolved key, not the alias.
    expect(value).toContain(`Auto-compact window for ${resolvedOpusKey()}`)
    expect(value).not.toContain('Auto-compact window for opus')
  })

  test('setter with an already-resolved model round-trips unchanged', async () => {
    // Regression: resolved concrete models behave exactly as pre-302.
    await autocompactCall('150k', makeContext(SONNET))

    expect(settingsWrites.length).toBe(1)
    expect(settingsWrites[0].settings).toEqual({
      modelSettings: { [SONNET]: { autoCompactWindow: 150_000 } },
    })
  })
})
