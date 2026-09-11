/**
 * OCC-82 (official 2.1.266 → 2.1.267): settings-side effort cap.
 *
 * Official 2.1.267 adds `maxEffortLevel` (top-level) and
 * `modelSettings.<model>.maxEffortLevel` (per-model). All strings asserted
 * here were byte-verified against the official 2.1.267 linux-x64 binary
 * (/tmp/cc267/s267.txt): schema `.describe()` texts, the `U` clamp message,
 * the `E(t)` valid-options builder, the `txr` argumentHint builder, the
 * `Jdt` help text, the `O` ultracode cap rejection, and the `Eur` startup
 * warning. Symbol map (official → OCC): Mu=EFFORT_LEVELS, N=getSettingsEffortCap,
 * Stt=getEffectiveEffortCap, Uhe=isEffortLevelAllowed, S9=getAllowedEffortLevels,
 * lF=clampEffortToCap, E=effortLevelIndex, vur=hasEffortLevelsAboveCap,
 * Eur=getEffortCapWarning, K=modelSupportsEffortLevel, dF=official dF (inline),
 * kE=resolveAppliedEffort, zS=isUltracodeAvailableForModel (reduced: OCC has
 * no dynamic-workflows gate — WORKFLOW_SCRIPTS is always live).
 *
 * Spec test points covered: ① /effort clamp + argumentHint + no-persist,
 * ② per-model canonical-name matching (dated/[1m]/Bedrock/Vertex),
 * ③ per-model "max" exemption, ④ cross-file lowest-wins,
 * ⑥ env CLAUDE_CODE_EFFORT_LEVEL clamped + startup Eur→Zf warning,
 * ⑦ EXTRA_BODY effort NOT clamped, ⑩ /effort auto deletes the settings key.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

// ---------------------------------------------------------------------------
// Mock plumbing (pattern: projectScopeEnvBlocklist251.test.ts) — installed
// BEFORE the modules under test are imported so their live bindings resolve
// to the mocked settings sources / main-loop model.
// ---------------------------------------------------------------------------

const actualSettingsModule = await import('../settings/settings.js')
const actualConstantsModule = await import('../settings/constants.js')
const actualModelModule = await import('../model/model.js')

let settingsBySource: Record<string, Record<string, unknown> | null> = {}
let enabledSources: string[] = ['userSettings', 'projectSettings']
let currentModel = 'claude-opus-4-7'
const settingsWrites: Array<{
  source: string
  settings: Record<string, unknown>
}> = []

// Leak guard: bun runs all test files in ONE process, and bun's mock.module
// LIVE-PATCHES the captured namespace — after mocking, `actualXModule.fn` IS
// the mock, so (a) restoring via `() => actualModule` re-installs the mock
// (the original cross-file leak: prompt-cache-ttl/outputLimits261/BashTool
// spec saw empty settings) and (b) delegating through the namespace recurses.
// Function references captured BEFORE mock.module stay real; every mocked
// closure delegates through them once `mockActive` flips false, so later
// files see genuine behavior even through cached mocked bindings.
const actualGetSettingsForSource = actualSettingsModule.getSettingsForSource
const actualGetInitialSettings = actualSettingsModule.getInitialSettings
const actualUpdateSettingsForSource =
  actualSettingsModule.updateSettingsForSource
const actualGetEnabledSettingSources =
  actualConstantsModule.getEnabledSettingSources
const actualGetMainLoopModel = actualModelModule.getMainLoopModel

let mockActive = true

mock.module('../settings/settings.js', () => ({
  ...actualSettingsModule,
  getSettingsForSource: (source: string) =>
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
    source: string,
    settings: Record<string, unknown>,
  ) => {
    if (!mockActive) {
      return actualUpdateSettingsForSource(source, settings)
    }
    settingsWrites.push({ source, settings })
    return { error: null }
  },
}))

mock.module('../settings/constants.js', () => ({
  ...actualConstantsModule,
  getEnabledSettingSources: () =>
    mockActive ? [...enabledSources] : actualGetEnabledSettingSources(),
}))

mock.module('../model/model.js', () => ({
  ...actualModelModule,
  getMainLoopModel: () =>
    mockActive ? currentModel : actualGetMainLoopModel(),
}))

afterAll(() => {
  mockActive = false
  // Re-pin the real functions over the live-patched namespace too, for
  // consumers that import AFTER this file finishes.
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
  mock.module('../model/model.js', () => ({
    ...actualModelModule,
    getMainLoopModel: actualGetMainLoopModel,
  }))
})

// Modules under test — imported AFTER mocks.
const { SettingsSchema: settingsSchemaFactory } = await import(
  '../settings/types.js'
)
// lazySchema returns a memoized factory — instantiate once for the tests.
const SettingsSchema = settingsSchemaFactory()
const { resolveAppliedEffort, getEffortLevelDescription } = await import(
  '../effort.js'
)
const { executeEffort, call: callEffort } = await import(
  '../../commands/effort/effort.js'
)
const effortCommand = (await import('../../commands/effort/index.js')).default
const { isUltracodeEnabled, resetUltracode } = await import(
  '../effort/ultracode.js'
)

// The new cap module (official N/Stt/Uhe/S9/lF/E/K/vur/Eur cluster). It does
// not exist yet (RED); the guarded import keeps the failure an assertion in
// each cap test rather than a file-level import error.
let capModule: typeof import('../effort/cap.js') | null = null
try {
  capModule = await import('../effort/cap.js')
} catch {
  capModule = null
}

// claude.ts is heavy; guard the import so a top-level failure doesn't take
// down the whole file. configureEffortParams is expected to become exported.
let claudeModule: Record<string, unknown> | null = null
try {
  claudeModule = (await import('../../services/api/claude.js')) as unknown as Record<
    string,
    unknown
  >
} catch {
  claudeModule = null
}

// ---------------------------------------------------------------------------
// Env hygiene
// ---------------------------------------------------------------------------

const SAVED_ENV_KEYS = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_EXTRA_BODY',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_ULTRACODE',
  'USER_TYPE',
]
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key]
})

afterAll(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key] as string
  }
})

beforeEach(() => {
  for (const key of SAVED_ENV_KEYS) delete process.env[key]
  settingsBySource = {}
  enabledSources = ['userSettings', 'projectSettings']
  currentModel = 'claude-opus-4-7'
  settingsWrites.length = 0
  resetUltracode()
})

// ---------------------------------------------------------------------------
// Byte-verified official 2.1.267 strings (from /tmp/cc267/s267.txt)
// ---------------------------------------------------------------------------

const TOP_LEVEL_DESCRIBE =
  "Maximum effort level. Anything above it (an /effort or /model pick, --effort, CLAUDE_CODE_EFFORT_LEVEL, a model default) is clamped to it, on every provider including Bedrock, Vertex and Foundry. Combines with an organization's per-model effort cap by taking the lower of the two; across settings files the lowest value wins, and modelSettings.<model>.maxEffortLevel replaces it per model. Enforced client-side: an effort supplied through CLAUDE_CODE_EXTRA_BODY is not clamped."
const MODEL_SETTINGS_DESCRIBE = 'Per-model settings keyed by canonical model name.'
const PER_MODEL_EFFORT_LEVEL_DESCRIBE = 'Persisted effort level for this model.'
const PER_MODEL_MAX_DESCRIBE =
  'Maximum effort level for this model. Within one settings file it replaces the top-level maxEffortLevel for the model ("max" exempts it); across settings files the lowest applicable value wins. Keyed like effortLevel: the canonical model name also matches its dated, [1m], Bedrock and Vertex spellings.'

/** zod v4 unwrapper: catch → optional → pipe.out → record.valueType. */
function unwrapZod(schema: unknown): any {
  let s: any = schema
  while (s?._zod?.def) {
    const def = s._zod.def
    if (def.innerType) {
      s = def.innerType
      continue
    }
    if (def.out) {
      s = def.out
      continue
    }
    break
  }
  return s
}

// ---------------------------------------------------------------------------
// A. Schema (checklist step 1: describe 原文照抄)
// ---------------------------------------------------------------------------

describe('settings schema: maxEffortLevel (official 2.1.267, byte-verified describes)', () => {
  test('declares top-level maxEffortLevel with the official describe text', () => {
    const shape = SettingsSchema.shape as Record<string, any>
    expect(shape.maxEffortLevel?.description).toBe(TOP_LEVEL_DESCRIBE)
  })

  test('top-level maxEffortLevel accepts the five official levels and drops invalid values via catch(undefined)', () => {
    const parsed = SettingsSchema.parse({ maxEffortLevel: 'high' }) as any
    expect(parsed.maxEffortLevel).toBe('high')
    const invalid = SettingsSchema.parse({ maxEffortLevel: 'bogus' }) as any
    expect(invalid.maxEffortLevel).toBeUndefined()
  })

  test('declares modelSettings with the official outer describe text', () => {
    const shape = SettingsSchema.shape as Record<string, any>
    expect(shape.modelSettings?.description).toBe(MODEL_SETTINGS_DESCRIBE)
  })

  test('per-model entries declare effortLevel + maxEffortLevel with the official describes', () => {
    const shape = SettingsSchema.shape as Record<string, any>
    const entrySchema = unwrapZod(
      unwrapZod(shape.modelSettings)?._zod?.def?.valueType,
    )
    expect(entrySchema?.shape?.effortLevel?.description).toBe(
      PER_MODEL_EFFORT_LEVEL_DESCRIBE,
    )
    expect(entrySchema?.shape?.maxEffortLevel?.description).toBe(
      PER_MODEL_MAX_DESCRIBE,
    )
  })

  test('per-model maxEffortLevel drops invalid values via catch(undefined)', () => {
    const parsed = SettingsSchema.parse({
      modelSettings: { 'claude-opus-4-5': { maxEffortLevel: 'bogus' } },
    }) as any
    expect(parsed.modelSettings?.['claude-opus-4-5']?.maxEffortLevel).toBeUndefined()
  })

  test('per-model effortLevel/maxEffortLevel parse valid values', () => {
    const parsed = SettingsSchema.parse({
      modelSettings: {
        'claude-opus-4-5': { effortLevel: 'xhigh', maxEffortLevel: 'max' },
      },
    }) as any
    expect(parsed.modelSettings?.['claude-opus-4-5']).toEqual({
      effortLevel: 'xhigh',
      maxEffortLevel: 'max',
    })
  })

  test('modelSettings prototype-key guard: Object.prototype own keys are dropped, prototype not polluted', () => {
    const hostile = JSON.parse(
      '{"constructor":{"effortLevel":"low"},"claude-opus-5":{"maxEffortLevel":"high"}}',
    )
    const parsed = SettingsSchema.parse({ modelSettings: hostile }) as any
    expect(
      Object.hasOwn(parsed.modelSettings ?? {}, 'constructor'),
    ).toBe(false)
    expect(parsed.modelSettings?.['claude-opus-5']?.maxEffortLevel).toBe('high')
    expect((Object.prototype as any).effortLevel).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// B. Cap resolver + helpers (checklist step 2: N(e)/Stt(e) semantics)
// ---------------------------------------------------------------------------

describe('getSettingsEffortCap — official N(e) (settings-side cap resolver)', () => {
  test('returns null when no settings define a cap', () => {
    expect(capModule).not.toBeNull()
    expect(capModule!.getSettingsEffortCap('claude-opus-4-7')).toBeNull()
  })

  test('reads the top-level cap from a single file', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    expect(capModule!.getSettingsEffortCap('claude-opus-4-7')).toBe('high')
  })

  test('④ across files the lowest value wins (user high, project medium → medium)', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    settingsBySource.projectSettings = { maxEffortLevel: 'medium' }
    expect(capModule!.getSettingsEffortCap('claude-opus-4-7')).toBe('medium')
  })

  test('across files lowest wins regardless of source order (project xhigh, user medium → medium)', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'medium' }
    settingsBySource.projectSettings = { maxEffortLevel: 'xhigh' }
    expect(capModule!.getSettingsEffortCap('claude-opus-4-7')).toBe('medium')
  })

  test('top-level "max" means no cap (null)', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'max' }
    expect(capModule!.getSettingsEffortCap('claude-opus-4-7')).toBeNull()
  })

  test('per-model entry replaces the top-level value within one file (even upward)', () => {
    settingsBySource.userSettings = {
      maxEffortLevel: 'low',
      modelSettings: { 'claude-opus-4-5': { maxEffortLevel: 'high' } },
    }
    expect(capModule!.getSettingsEffortCap('claude-opus-4-5')).toBe('high')
    expect(capModule!.getSettingsEffortCap('claude-opus-4-7')).toBe('low')
  })

  test('③ per-model "max" exempts the model from that file top-level cap', () => {
    settingsBySource.userSettings = {
      maxEffortLevel: 'high',
      modelSettings: { 'claude-opus-4-5': { maxEffortLevel: 'max' } },
    }
    expect(capModule!.getSettingsEffortCap('claude-opus-4-5')).toBeNull()
    expect(capModule!.getSettingsEffortCap('claude-opus-4-7')).toBe('high')
  })

  test('per-file exemption does not leak across files: user per-model max, project top-level medium → medium', () => {
    settingsBySource.userSettings = {
      modelSettings: { 'claude-opus-4-5': { maxEffortLevel: 'max' } },
    }
    settingsBySource.projectSettings = { maxEffortLevel: 'medium' }
    expect(capModule!.getSettingsEffortCap('claude-opus-4-5')).toBe('medium')
  })

  test('② canonical key "claude-opus-4-5[1m]" matches dated, Bedrock and Vertex spellings', () => {
    settingsBySource.userSettings = {
      modelSettings: { 'claude-opus-4-5[1m]': { maxEffortLevel: 'high' } },
    }
    expect(capModule!.getSettingsEffortCap('claude-opus-4-5')).toBe('high')
    expect(capModule!.getSettingsEffortCap('claude-opus-4-5-20251101')).toBe('high')
    expect(
      capModule!.getSettingsEffortCap('us.anthropic.claude-opus-4-5-v1:0'),
    ).toBe('high')
    expect(
      capModule!.getSettingsEffortCap(
        'projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-5@20251101',
      ),
    ).toBe('high')
    expect(capModule!.getSettingsEffortCap('claude-opus-4-7')).toBeNull()
  })

  test('multiple matching per-model keys within one file: lowest wins', () => {
    settingsBySource.userSettings = {
      modelSettings: {
        'claude-opus-4-5': { maxEffortLevel: 'high' },
        'claude-opus-4-5[1m]': { maxEffortLevel: 'medium' },
      },
    }
    expect(capModule!.getSettingsEffortCap('claude-opus-4-5-20251101')).toBe('medium')
  })

  test('per-model entries without maxEffortLevel do not replace the top-level cap', () => {
    settingsBySource.userSettings = {
      maxEffortLevel: 'high',
      modelSettings: { 'claude-opus-4-5': { effortLevel: 'low' } },
    }
    expect(capModule!.getSettingsEffortCap('claude-opus-4-5')).toBe('high')
  })
})

describe('cap helpers — official Stt/Uhe/S9/lF/E/K/vur (byte-verified bodies)', () => {
  test('getEffectiveEffortCap reduces to the settings cap (OCC has no org registry)', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    expect(capModule!.getEffectiveEffortCap('claude-opus-4-7')).toBe('high')
    settingsBySource.userSettings = {}
    expect(capModule!.getEffectiveEffortCap('claude-opus-4-7')).toBeNull()
  })

  test('effortLevelIndex mirrors official E = Mu.indexOf', () => {
    expect(capModule!.effortLevelIndex('low')).toBe(0)
    expect(capModule!.effortLevelIndex('medium')).toBe(1)
    expect(capModule!.effortLevelIndex('high')).toBe(2)
    expect(capModule!.effortLevelIndex('xhigh')).toBe(3)
    expect(capModule!.effortLevelIndex('max')).toBe(4)
  })

  test('isEffortLevelAllowed (Uhe): levels at or below the cap are allowed', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    expect(capModule!.isEffortLevelAllowed('low', 'claude-opus-4-7')).toBe(true)
    expect(capModule!.isEffortLevelAllowed('high', 'claude-opus-4-7')).toBe(true)
    expect(capModule!.isEffortLevelAllowed('xhigh', 'claude-opus-4-7')).toBe(false)
    expect(capModule!.isEffortLevelAllowed('max', 'claude-opus-4-7')).toBe(false)
  })

  test('isEffortLevelAllowed: no cap allows everything', () => {
    expect(capModule!.isEffortLevelAllowed('max', 'claude-opus-4-7')).toBe(true)
  })

  test('getAllowedEffortLevels (S9) filters Mu by the cap', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'medium' }
    expect(capModule!.getAllowedEffortLevels('claude-opus-4-7')).toEqual([
      'low',
      'medium',
    ])
    settingsBySource.userSettings = {}
    expect(capModule!.getAllowedEffortLevels('claude-opus-4-7')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  test('clampEffortToCap (lF) clamps string levels above the cap and passes everything else through', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    expect(capModule!.clampEffortToCap('xhigh', 'claude-opus-4-7')).toBe('high')
    expect(capModule!.clampEffortToCap('max', 'claude-opus-4-7')).toBe('high')
    expect(capModule!.clampEffortToCap('medium', 'claude-opus-4-7')).toBe('medium')
    // official lF only touches string levels — numerics pass through
    expect(capModule!.clampEffortToCap(30, 'claude-opus-4-7')).toBe(30)
    settingsBySource.userSettings = {}
    expect(capModule!.clampEffortToCap('xhigh', 'claude-opus-4-7')).toBe('xhigh')
  })

  test('hasEffortLevelsAboveCap (vur) respects model capabilities via K', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    // opus-4-7 supports max → there IS a supported level above the cap
    expect(capModule!.hasEffortLevelsAboveCap('claude-opus-4-7')).toBe(true)
    // haiku supports neither xhigh nor max → no supported level above the cap
    expect(capModule!.hasEffortLevelsAboveCap('claude-haiku-4-5')).toBe(false)
    settingsBySource.userSettings = {}
    expect(capModule!.hasEffortLevelsAboveCap('claude-opus-4-7')).toBe(false)
  })

  test('getEffortCapWarning (Eur) — byte-verified startup warning', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    expect(capModule!.getEffortCapWarning('xhigh', 'claude-opus-4-7')).toBe(
      "Effort 'xhigh' exceeds the cap for claude-opus-4-7 set by your settings or organization; using 'high'.",
    )
    expect(capModule!.getEffortCapWarning('high', 'claude-opus-4-7')).toBeNull()
    expect(capModule!.getEffortCapWarning(undefined, 'claude-opus-4-7')).toBeNull()
    expect(capModule!.getEffortCapWarning('bogus', 'claude-opus-4-7')).toBeNull()
    settingsBySource.userSettings = {}
    expect(capModule!.getEffortCapWarning('xhigh', 'claude-opus-4-7')).toBeNull()
  })

  test('isUltracodeAvailableForModel (zS reduced): xhigh-capable and allowed', () => {
    expect(capModule!.isUltracodeAvailableForModel('claude-opus-4-7')).toBe(true)
    expect(capModule!.isUltracodeAvailableForModel('claude-haiku-4-5')).toBe(false)
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    expect(capModule!.isUltracodeAvailableForModel('claude-opus-4-7')).toBe(false)
  })

  test('valid-options text (official E(t)) and argumentHint (txr)', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    expect(capModule!.formatEffortValidOptions('claude-opus-4-7')).toBe(
      'low, medium, high, auto',
    )
    expect(capModule!.buildEffortArgumentHint('[', ']', 'claude-opus-4-7')).toBe(
      '[low|medium|high|auto]',
    )
    settingsBySource.userSettings = {}
    expect(capModule!.formatEffortValidOptions('claude-opus-4-7')).toBe(
      'low, medium, high, xhigh, max, ultracode, auto',
    )
    expect(capModule!.buildEffortArgumentHint('[', ']', 'claude-opus-4-7')).toBe(
      '[low|medium|high|xhigh|max|ultracode|auto]',
    )
  })
})

// ---------------------------------------------------------------------------
// C. resolveAppliedEffort — official kE(267) + P clamp pipeline
// ---------------------------------------------------------------------------

describe('resolveAppliedEffort under a settings cap (official kE 2.1.267)', () => {
  test('clamps a session effort value above the cap', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    expect(resolveAppliedEffort('claude-opus-4-7', 'xhigh')).toBe('high')
    expect(resolveAppliedEffort('claude-opus-4-7', 'medium')).toBe('medium')
  })

  test('⑥ clamps the CLAUDE_CODE_EFFORT_LEVEL env value', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'xhigh'
    expect(resolveAppliedEffort('claude-opus-4-7', undefined)).toBe('high')
  })

  test('env=auto materializes the clamped model default when a cap exists (267 kE change)', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    // opus-4-7 model default is xhigh → clamped to high, sent explicitly
    expect(resolveAppliedEffort('claude-opus-4-7', undefined)).toBe('high')
    settingsBySource.userSettings = { maxEffortLevel: 'low' }
    expect(resolveAppliedEffort('claude-opus-4-7', 'medium')).toBe('low')
  })

  test('env=auto without a cap still sends no explicit effort (unchanged)', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    expect(resolveAppliedEffort('claude-opus-4-7', 'xhigh')).toBeUndefined()
  })

  test('numeric env effort under a cap normalizes to "high" via the official dF branch (review P2-2)', () => {
    // Review P2-2 correction: the dF numeric branch IS reachable in this test
    // env — CLAUDE_CODE_EFFORT_LEVEL parses to a NUMBER via parseEffortValue
    // (any integer, isValidNumericEffort), so getEffortEnvOverride() returns
    // numeric 50 and resolveAppliedEffort hits
    // `typeof resolved === 'number' && hasSettingsCap` → official dF:
    // `function dF(e){if(typeof e==="string")return CT(e)?e:"high";return"high"}`
    // — any numeric effort normalizes to 'high'.
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    process.env.CLAUDE_CODE_EFFORT_LEVEL = '50'
    expect(resolveAppliedEffort('claude-opus-4-7', undefined)).toBe('high')
    // dF fires BEFORE the cap clamp: cap=low clamps the normalized 'high' → 'low'.
    settingsBySource.userSettings = { maxEffortLevel: 'low' }
    expect(resolveAppliedEffort('claude-opus-4-7', undefined)).toBe('low')
    // A numeric value passed straight to the clamp helper is untouched by the
    // cap (official lF only clamps known string levels) — the dF normalization
    // that converts it to 'high' lives in resolveAppliedEffort, not in lF.
    expect(capModule!.clampEffortToCap(30, 'claude-opus-4-7')).toBe(30)
  })

  test('capability downgrades still apply with no cap (regression guard)', () => {
    expect(resolveAppliedEffort('claude-opus-4-7', 'xhigh')).toBe('xhigh')
    expect(resolveAppliedEffort('claude-haiku-4-5', 'max')).toBe('high')
    expect(resolveAppliedEffort('claude-haiku-4-5', 'xhigh')).toBe('high')
  })

  test('clamp happens before capability downgrade (official P order: lF first)', () => {
    // opus-4-6 supports max but not xhigh; cap xhigh keeps max→(lF)xhigh→(cap)high
    settingsBySource.userSettings = { maxEffortLevel: 'xhigh' }
    expect(resolveAppliedEffort('claude-opus-4-6', 'max')).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// D. /effort command — official U/O/R/E/txr/Jdt ports
// ---------------------------------------------------------------------------

describe('/effort command under a settings cap', () => {
  test('① argumentHint is cap-aware: [low|medium|high|auto] under cap=high', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    expect(effortCommand.argumentHint).toBe('[low|medium|high|auto]')
  })

  test('argumentHint without a cap keeps the full official list', () => {
    expect(effortCommand.argumentHint).toBe(
      '[low|medium|high|xhigh|max|ultracode|auto]',
    )
  })

  test('① /effort xhigh under cap=high: byte-verified clamp message, session-only, NO settings write', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    const result = executeEffort('xhigh')
    expect(result.message).toBe(
      `Effort 'xhigh' exceeds the cap for claude-opus-4-7 set by your settings or organization; set to 'high' instead (this session only): ${getEffortLevelDescription('high')}`,
    )
    expect(result.effortUpdate?.value).toBe('high')
    expect(settingsWrites).toEqual([])
  })

  test('/effort high under cap=high (not exceeding): normal success + persisted', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    const result = executeEffort('high')
    expect(result.message).toBe(
      `Set effort level to high (saved as your default for new sessions): ${getEffortLevelDescription('high')}`,
    )
    expect(result.effortUpdate?.value).toBe('high')
    expect(settingsWrites).toEqual([
      { source: 'userSettings', settings: { effortLevel: 'high' } },
    ])
  })

  test('⑩ /effort auto deletes the effortLevel key (writes undefined, never null)', () => {
    settingsBySource.userSettings = {
      effortLevel: 'high',
      maxEffortLevel: 'high',
    }
    const result = executeEffort('auto')
    expect(result.message).toBe('Effort level set to auto')
    expect(settingsWrites).toEqual([
      { source: 'userSettings', settings: { effortLevel: undefined } },
    ])
  })

  test('/effort max under cap=high clamps to high (non-persistable target stays session-only)', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    const result = executeEffort('max')
    expect(result.message).toBe(
      `Effort 'max' exceeds the cap for claude-opus-4-7 set by your settings or organization; set to 'high' instead (this session only): ${getEffortLevelDescription('high')}`,
    )
    expect(settingsWrites).toEqual([])
  })

  test('invalid argument lists cap-filtered options (official E(t))', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    expect(executeEffort('bogus').message).toBe(
      'Invalid argument: bogus. Valid options are: low, medium, high, auto',
    )
  })

  test('invalid argument without a cap keeps the existing full list', () => {
    expect(executeEffort('bogus').message).toBe(
      'Invalid argument: bogus. Valid options are: low, medium, high, xhigh, max, ultracode, auto',
    )
  })

  test('ultracode under cap=high: byte-verified cap rejection, not enabled', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    const result = executeEffort('ultracode')
    expect(result.message).toBe(
      'Ultracode runs at xhigh effort, which is above the effort cap for claude-opus-4-7 set by your settings or organization. Valid options are: low, medium, high, auto',
    )
    expect(result.effortUpdate).toBeUndefined()
    expect(isUltracodeEnabled()).toBe(false)
  })

  test('ultracode on a non-xhigh-capable model: byte-verified support rejection', () => {
    currentModel = 'claude-haiku-4-5'
    const result = executeEffort('ultracode')
    // Official O support gate: E(haiku) has no cap → S9 lists all five levels,
    // but zS(haiku)=false (no xhigh) → no ", ultracode" segment.
    expect(result.message).toBe(
      "Ultracode runs at xhigh effort, which claude-haiku-4-5 doesn't support — switch to an xhigh-capable model (Fable 5, Opus 4.7+, Sonnet 5). Valid options are: low, medium, high, xhigh, max, auto",
    )
    expect(isUltracodeEnabled()).toBe(false)
  })

  test('ultracode without a cap on an xhigh-capable model still activates (regression guard)', () => {
    const result = executeEffort('ultracode')
    expect(result.effortUpdate?.value).toBe('xhigh')
    expect(isUltracodeEnabled()).toBe(true)
  })

  test('help text is cap-aware (official Jdt): allowed levels only, no ultracode line', async () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    let helpText = ''
    await callEffort(
      (message: string) => {
        helpText = message
      },
      {},
      'help',
    )
    expect(helpText).toBe(
      'Usage: /effort [low|medium|high|auto]\n' +
        '- low: Quick, straightforward implementation\n' +
        '- medium: Balanced approach with standard testing\n' +
        '- high: Comprehensive implementation with extensive testing\n' +
        '- auto: Use the default effort level for your model',
    )
  })

  test('help text without a cap keeps the full official table', async () => {
    let helpText = ''
    await callEffort(
      (message: string) => {
        helpText = message
      },
      {},
      'help',
    )
    expect(helpText).toBe(
      'Usage: /effort [low|medium|high|xhigh|max|ultracode|auto]\n' +
        '- low: Quick, straightforward implementation\n' +
        '- medium: Balanced approach with standard testing\n' +
        '- high: Comprehensive implementation with extensive testing\n' +
        '- xhigh: Extended reasoning with thorough analysis (Fable 5, Opus 4.7+, Sonnet 5)\n' +
        '- max: Maximum capability with deepest reasoning (Fable 5, Opus 4.6+, Sonnet 4.6+)\n' +
        '- ultracode: xhigh + dynamic workflow orchestration (this session only)\n' +
        '- auto: Use the default effort level for your model',
    )
  })
})

// ---------------------------------------------------------------------------
// E. API layer — ⑦ EXTRA_BODY-supplied effort is NOT clamped
// ---------------------------------------------------------------------------

describe('configureEffortParams — EXTRA_BODY effort wins unclamped (official JCs)', () => {
  test('⑦ an effort already present in output_config (from CLAUDE_CODE_EXTRA_BODY) is respected, not clamped', () => {
    settingsBySource.userSettings = { maxEffortLevel: 'high' }
    const configureEffortParams = claudeModule?.configureEffortParams as
      | ((
          effortValue: unknown,
          outputConfig: Record<string, unknown>,
          extraBodyParams: Record<string, unknown>,
          betas: string[],
          model: string,
        ) => void)
      | undefined
    expect(typeof configureEffortParams).toBe('function')
    const outputConfig: Record<string, unknown> = { effort: 'xhigh' }
    const betas: string[] = []
    // resolveAppliedEffort clamps the session value to 'high' ...
    const applied = resolveAppliedEffort('claude-opus-4-7', 'xhigh')
    expect(applied).toBe('high')
    // ... but the EXTRA_BODY-supplied output_config.effort stays 'xhigh'.
    configureEffortParams!(applied, outputConfig, {}, betas, 'claude-opus-4-7')
    expect(outputConfig.effort).toBe('xhigh')
  })

  // Review P2-1: the official JCs is a DELETE-FIRST two-gate structure —
  // `if(!Nh(d)){delete n.effort;return}` THEN `if("effort"in n)return`.
  test('P2-1: an effort-UNSUPPORTED model DELETES an EXTRA_BODY-injected effort (official JCs delete-first gate)', () => {
    const configureEffortParams = claudeModule?.configureEffortParams as
      | ((
          effortValue: unknown,
          outputConfig: Record<string, unknown>,
          extraBodyParams: Record<string, unknown>,
          betas: string[],
          model: string,
        ) => void)
      | undefined
    expect(typeof configureEffortParams).toBe('function')
    // CLAUDE_CODE_EXTRA_BODY injected output_config.effort + a model that
    // does NOT support effort (haiku): the official deletes the injected
    // effort so the request goes out clean (an effort param would 400).
    const outputConfig: Record<string, unknown> = { effort: 'xhigh' }
    const betas: string[] = []
    configureEffortParams!('high', outputConfig, {}, betas, 'claude-haiku-4-5')
    expect('effort' in outputConfig).toBe(false)
    expect(betas).toEqual([])
  })

  test('P2-1: official 2.1.267 JCs has NO numeric ant branch — extraBodyParams (r) is unused', () => {
    // Official JCs(e,n,r,o,d) body has no numeric branch at all:
    // `if(e===void 0)o.push(lnt);else if(typeof e==="string")n.effort=e,o.push(lnt)`
    // — `r` (extraBodyParams) is never read and `effort_override` has 0 hits
    // in the 2.1.267 ELF strings dump. A numeric effortValue sends nothing,
    // even for USER_TYPE=ant (OCC's legacy branch removed in the P2-1 fix).
    process.env.USER_TYPE = 'ant'
    const configureEffortParams = claudeModule?.configureEffortParams as
      | ((
          effortValue: unknown,
          outputConfig: Record<string, unknown>,
          extraBodyParams: Record<string, unknown>,
          betas: string[],
          model: string,
        ) => void)
      | undefined
    expect(typeof configureEffortParams).toBe('function')
    const outputConfig: Record<string, unknown> = {}
    const extraBodyParams: Record<string, unknown> = {}
    const betas: string[] = []
    configureEffortParams!(50, outputConfig, extraBodyParams, betas, 'claude-opus-4-7')
    expect(outputConfig).toEqual({})
    expect(betas).toEqual([])
    expect(extraBodyParams).toEqual({}) // no anthropic_internal.effort_override
  })
})

// ---------------------------------------------------------------------------
// F. applySettingsChange — official oRt clamp when settings sync into state
// ---------------------------------------------------------------------------

describe('applySettingsChange effort clamp (official oRt)', () => {
  test('a settings effortLevel above the cap is clamped when synced into AppState', async () => {
    settingsBySource.userSettings = {
      maxEffortLevel: 'high',
      effortLevel: 'xhigh',
    }
    const { applySettingsChange } = await import(
      '../settings/applySettingsChange.js'
    )
    let captured: { effortValue?: unknown } | undefined
    const prev = {
      settings: { effortLevel: undefined },
      toolPermissionContext: {
        mode: 'default',
        allowRules: new Set(),
        denyRules: new Set(),
        askRules: new Set(),
        alwaysAllowRules: new Set(),
      },
    }
    applySettingsChange(
      'userSettings',
      (f: (p: unknown) => unknown) => {
        captured = f(prev) as { effortValue?: unknown }
        return captured
      },
    )
    expect(captured?.effortValue).toBe('high')
  })

  test('an effortLevel within the cap syncs through unchanged', async () => {
    settingsBySource.userSettings = {
      maxEffortLevel: 'high',
      effortLevel: 'medium',
    }
    const { applySettingsChange } = await import(
      '../settings/applySettingsChange.js'
    )
    let captured: { effortValue?: unknown } | undefined
    const prev = {
      settings: { effortLevel: 'low' },
      toolPermissionContext: {
        mode: 'default',
        allowRules: new Set(),
        denyRules: new Set(),
        askRules: new Set(),
        alwaysAllowRules: new Set(),
      },
    }
    applySettingsChange(
      'userSettings',
      (f: (p: unknown) => unknown) => {
        captured = f(prev) as { effortValue?: unknown }
        return captured
      },
    )
    expect(captured?.effortValue).toBe('medium')
  })

  // Review P3 (official oRt leading gates):
  // `function oRt(e,n){if(!Nh(e)||DP()!==void 0)return;...}` — when the model
  // does NOT support effort, or a CLAUDE_CODE_EFFORT_LEVEL override is set,
  // the settings sync must NOT write effortValue at all (the env/resolve
  // path owns the effective value; a written AppState value could diverge
  // from it and leak to SDK/AppState subscribers).
  test('P3/oRt: env override set → settings sync does NOT write effortValue', async () => {
    settingsBySource.userSettings = {
      maxEffortLevel: 'high',
      effortLevel: 'xhigh',
    }
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
    const { applySettingsChange } = await import(
      '../settings/applySettingsChange.js'
    )
    let captured: Record<string, unknown> | undefined
    const prev = {
      settings: { effortLevel: undefined },
      toolPermissionContext: {
        mode: 'default',
        allowRules: new Set(),
        denyRules: new Set(),
        askRules: new Set(),
        alwaysAllowRules: new Set(),
      },
    }
    applySettingsChange(
      'userSettings',
      (f: (p: unknown) => unknown) => {
        captured = f(prev) as Record<string, unknown>
        return captured
      },
    )
    expect(captured).not.toHaveProperty('effortValue')
  })

  test('P3/oRt: effort-unsupported model → settings sync does NOT write effortValue', async () => {
    currentModel = 'claude-haiku-4-5'
    settingsBySource.userSettings = { effortLevel: 'high' }
    const { applySettingsChange } = await import(
      '../settings/applySettingsChange.js'
    )
    let captured: Record<string, unknown> | undefined
    const prev = {
      settings: { effortLevel: undefined },
      toolPermissionContext: {
        mode: 'default',
        allowRules: new Set(),
        denyRules: new Set(),
        askRules: new Set(),
        alwaysAllowRules: new Set(),
      },
    }
    applySettingsChange(
      'userSettings',
      (f: (p: unknown) => unknown) => {
        captured = f(prev) as Record<string, unknown>
        return captured
      },
    )
    expect(captured).not.toHaveProperty('effortValue')
  })
})

// ---------------------------------------------------------------------------
// G. ModelPicker cycle — official dt() ladder sliced to the cap
// ---------------------------------------------------------------------------

describe('cycleEffortLevel under a cap (official dt ladder slice)', () => {
  test('cap=high removes xhigh/max from the cycle for a capable model', async () => {
    const { cycleEffortLevel } = await import('../../components/ModelPicker.js')
    // opus-4-7 supports max+xhigh, but the cap slices the ladder to
    // [low, medium, high] — official Sr(Mu.indexOf(cap)+1).
    expect(cycleEffortLevel('medium', 'right', true, true, 'high')).toBe('high')
    expect(cycleEffortLevel('high', 'right', true, true, 'high')).toBe('low')
    expect(cycleEffortLevel('low', 'left', true, true, 'high')).toBe('high')
  })

  test('cap=medium slices the ladder to [low, medium]', async () => {
    const { cycleEffortLevel } = await import('../../components/ModelPicker.js')
    expect(cycleEffortLevel('low', 'right', true, true, 'medium')).toBe(
      'medium',
    )
    expect(cycleEffortLevel('medium', 'right', true, true, 'medium')).toBe(
      'low',
    )
  })

  test('an over-cap current level resumes from the last ladder entry', async () => {
    const { cycleEffortLevel } = await import('../../components/ModelPicker.js')
    // 'xhigh' is not in the [low, medium] ladder → resume at 'medium', then
    // step right → wraps to 'low'.
    expect(cycleEffortLevel('xhigh', 'right', true, true, 'medium')).toBe(
      'low',
    )
  })

  test('without a cap argument the cycle behavior is unchanged (regression guard)', async () => {
    const { cycleEffortLevel } = await import('../../components/ModelPicker.js')
    expect(cycleEffortLevel('high', 'right', true, true)).toBe('xhigh')
    expect(cycleEffortLevel('high', 'right', false, false)).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// H. ⑥ startup warning emitter — official `Zf(Eur(Oe,xo),{key:"model-effort-cap"})`
//    (byte-verified @4997267 / @6248479): non-json → yellow console warning;
//    json/stream-json/bg → debug line only (the official stream-json
//    `notification` system event has no OCC emitter — documented reduction).
// ---------------------------------------------------------------------------

describe('H. startup effort-cap warning emitter (⑥ Eur → Zf)', () => {
  test('emitStartupEffortCapWarning exists', () => {
    expect(typeof capModule?.emitStartupEffortCapWarning).toBe('function')
  })

  test('warns once when the configured effort exceeds the cap', () => {
    settingsBySource = { userSettings: { maxEffortLevel: 'high' } }
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      capModule?.emitStartupEffortCapWarning?.('xhigh', 'claude-opus-4-7', undefined)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const msg = String(warnSpy.mock.calls[0]?.[0])
      expect(msg).toContain(
        "Effort 'xhigh' exceeds the cap for claude-opus-4-7 set by your settings or organization; using 'high'.",
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('silent when the configured effort is within the cap or unset', () => {
    settingsBySource = { userSettings: { maxEffortLevel: 'high' } }
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      capModule?.emitStartupEffortCapWarning?.('high', 'claude-opus-4-7', undefined)
      capModule?.emitStartupEffortCapWarning?.(undefined, 'claude-opus-4-7', undefined)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('json / stream-json output formats suppress the console warning', () => {
    settingsBySource = { userSettings: { maxEffortLevel: 'high' } }
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      capModule?.emitStartupEffortCapWarning?.('xhigh', 'claude-opus-4-7', 'json')
      capModule?.emitStartupEffortCapWarning?.('xhigh', 'claude-opus-4-7', 'stream-json')
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
