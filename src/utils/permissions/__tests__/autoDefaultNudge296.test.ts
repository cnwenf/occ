import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.296 — auto-default nudge (Gap B port).
 *
 * Official evidence (byte-verified in the official linux-x64 binary):
 * - gate `aMr`: onboarding complete + !hasSeenAutoDefaultNudge +
 *   k("tengu_maple_pier", true) + userSettings.permissions.defaultMode
 *   explicitly set and !== "auto" + no other layer pins defaultMode +
 *   auto available (kj) → return that mode; otherwise null.
 * - resolver `Ckt`/`Tkt`: cancelled → no writes/events; accept + gate ok →
 *   userSettings write {permissions:{defaultMode:"auto"}} + config flag +
 *   tengu_auto_default_nudge_resolved{choice,outcome:"switched",current_mode};
 *   accept + gate off → "gate_off" WITHOUT setting the flag AND WITHOUT the
 *   resolved event (official logs it only for non-gate_off outcomes);
 *   decline → flag + outcome "declined".
 *
 * Mock pattern: delegation + `mockActive` (settingSourcesPropagation281 /
 * attachBridgePolicyWatcher286 precedent — OCC-97/OCC-103). The real
 * functions are captured BY VALUE before any mock.module install; every
 * mocked export delegates to the real one once `mockActive` flips false in
 * afterAll. Do NOT restore via a namespace re-spread: bun live-patches the
 * captured namespace, so an afterAll re-spread re-installs the shims and
 * leaks them into every later file in the same worker — the old plain-spread
 * restore here leaked the settings/config shims into
 * autoDefaultNudge296Merge.test.ts (OCC115-FIX-001; the pair is guarded in
 * scripts/ci-test.sh LEAK_PAIRS).
 */

// MACRO polyfill (permissionSetup import graph reads MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const actualConfig = await import('../../config.js')
const actualSettings = await import('../../settings/settings.js')
const actualBetas = await import('../../betas.js')
const actualModel = await import('../../model/model.js')
const actualAnalytics = await import('../../../services/analytics/index.js')

// BY-VALUE capture of the real functions BEFORE any mock.module install.
// The namespace objects above get live-patched by bun once mocked, so only
// pre-mock function references are trustworthy (OCC115-FIX-001 — see the
// header comment; load-bearing, do not "simplify" back to a re-spread).
const realFns = {
  getGlobalConfig: actualConfig.getGlobalConfig as () => Record<string, unknown>,
  saveGlobalConfig: actualConfig.saveGlobalConfig as unknown as (
    updater: (current: Record<string, unknown>) => Record<string, unknown>,
  ) => void,
  getSettingsForSource: actualSettings.getSettingsForSource as unknown as (
    source: string,
  ) => Record<string, unknown> | null,
  updateSettingsForSource:
    actualSettings.updateSettingsForSource as unknown as (
      source: string,
      settings: Record<string, unknown>,
    ) => { error: Error | null },
  getSettings_DEPRECATED: actualSettings.getSettings_DEPRECATED as () => Record<
    string,
    unknown
  >,
  modelSupportsAutoMode: actualBetas.modelSupportsAutoMode as (
    model?: string,
  ) => boolean,
  getMainLoopModel: actualModel.getMainLoopModel as () => string,
  logEvent: actualAnalytics.logEvent as (
    name: string,
    metadata?: Record<string, unknown>,
  ) => void,
}

/** Flipped false in afterAll — the permanent mocks then pass through. */
let mockActive = true

const mockState: {
  config: Record<string, unknown>
  settingsBySource: Record<string, Record<string, unknown> | null>
  mergedSettings: Record<string, unknown>
  supportsAutoMode: boolean
  settingsWriteError: Error | null
  settingsWrites: Array<{ source: string; settings: Record<string, unknown> }>
  events: Array<{ name: string; metadata: Record<string, unknown> }>
} = {
  config: {},
  settingsBySource: {},
  mergedSettings: {},
  supportsAutoMode: true,
  settingsWriteError: null,
  settingsWrites: [],
  events: [],
}

mock.module('../../config.js', () => ({
  ...actualConfig,
  getGlobalConfig: () =>
    mockActive ? mockState.config : realFns.getGlobalConfig(),
  saveGlobalConfig: (
    updater: (current: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    if (mockActive) {
      mockState.config = updater(mockState.config)
      return
    }
    realFns.saveGlobalConfig(updater)
  },
}))
mock.module('../../settings/settings.js', () => ({
  ...actualSettings,
  getSettingsForSource: (source: string) =>
    mockActive
      ? (mockState.settingsBySource[source] ?? null)
      : realFns.getSettingsForSource(source),
  updateSettingsForSource: (
    source: string,
    settings: Record<string, unknown>,
  ) => {
    if (!mockActive) {
      return realFns.updateSettingsForSource(source, settings)
    }
    if (mockState.settingsWriteError) {
      return { error: mockState.settingsWriteError }
    }
    mockState.settingsWrites.push({ source, settings })
    return { error: null }
  },
  getSettings_DEPRECATED: () =>
    mockActive ? mockState.mergedSettings : realFns.getSettings_DEPRECATED(),
}))
mock.module('../../betas.js', () => ({
  ...actualBetas,
  modelSupportsAutoMode: (model?: string) =>
    mockActive ? mockState.supportsAutoMode : realFns.modelSupportsAutoMode(model),
}))
mock.module('../../model/model.js', () => ({
  ...actualModel,
  getMainLoopModel: () =>
    mockActive ? 'claude-test' : realFns.getMainLoopModel(),
}))
mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    if (mockActive) {
      mockState.events.push({ name, metadata: metadata ?? {} })
      return
    }
    realFns.logEvent(name, metadata)
  },
}))

const { resolveAutoDefaultNudge, shouldShowAutoDefaultNudge } = await import(
  '../autoDefaultNudge.js'
)
const { _resetForTesting: resetAutoModeState } = await import(
  '../autoModeState.js'
)

afterAll(() => {
  // Flip every mock into pass-through mode — do NOT re-spread the captured
  // namespaces (bun live-patched them; a re-spread would re-install the
  // shims — the OCC115-FIX-001 leak). The permanent mocks now behave exactly
  // like the real modules for every subsequent file in this worker.
  mockActive = false
})

/** Baseline: onboarding done, nudge unanswered, user pinned defaultMode. */
function seedEligibleState(defaultMode = 'default'): void {
  mockState.config = { hasCompletedOnboarding: true }
  mockState.settingsBySource = {
    userSettings: { permissions: { defaultMode } },
  }
}

function resolvedEvent(): { name: string; metadata: Record<string, unknown> } | undefined {
  return mockState.events.find(
    e => e.name === 'tengu_auto_default_nudge_resolved',
  )
}

beforeEach(() => {
  mockState.config = {}
  mockState.settingsBySource = {}
  mockState.mergedSettings = {}
  mockState.supportsAutoMode = true
  mockState.settingsWriteError = null
  mockState.settingsWrites = []
  mockState.events = []
  resetAutoModeState()
})

describe('CC 2.1.296 — shouldShowAutoDefaultNudge (official gate aMr)', () => {
  test('returns the pinned mode when all gate conditions hold', () => {
    seedEligibleState('default')
    expect(shouldShowAutoDefaultNudge()).toBe('default')
  })

  test('returns plan mode when the user pinned plan', () => {
    seedEligibleState('plan')
    expect(shouldShowAutoDefaultNudge()).toBe('plan')
  })

  test('null when onboarding is not complete', () => {
    seedEligibleState('default')
    mockState.config = {}
    expect(shouldShowAutoDefaultNudge()).toBeNull()
  })

  test('requireOnboarding:false bypasses the onboarding check', () => {
    seedEligibleState('default')
    mockState.config = {}
    expect(shouldShowAutoDefaultNudge({ requireOnboarding: false })).toBe(
      'default',
    )
  })

  test('null when the one-shot flag is already set', () => {
    seedEligibleState('default')
    mockState.config = {
      hasCompletedOnboarding: true,
      hasSeenAutoDefaultNudge: true,
    }
    expect(shouldShowAutoDefaultNudge()).toBeNull()
  })

  test('null when userSettings does not explicitly pin defaultMode', () => {
    mockState.config = { hasCompletedOnboarding: true }
    mockState.settingsBySource = { userSettings: {} }
    expect(shouldShowAutoDefaultNudge()).toBeNull()
  })

  test('null when the pinned defaultMode is already auto', () => {
    seedEligibleState('auto')
    expect(shouldShowAutoDefaultNudge()).toBeNull()
  })

  test.each([
    'projectSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ])('null when %s also pins defaultMode', source => {
    seedEligibleState('default')
    mockState.settingsBySource[source] = {
      permissions: { defaultMode: 'plan' },
    }
    expect(shouldShowAutoDefaultNudge()).toBeNull()
  })

  test('null when the auto gate is disabled via settings', () => {
    seedEligibleState('default')
    mockState.mergedSettings = { permissions: { disableAutoMode: 'disable' } }
    expect(shouldShowAutoDefaultNudge()).toBeNull()
  })

  test('null when the model does not support auto mode', () => {
    seedEligibleState('default')
    mockState.supportsAutoMode = false
    expect(shouldShowAutoDefaultNudge()).toBeNull()
  })
})

describe('CC 2.1.296 — resolveAutoDefaultNudge (official resolver Ckt/Tkt)', () => {
  test('accept: persists defaultMode auto, sets the flag, logs switched', async () => {
    seedEligibleState('default')
    const outcome = await resolveAutoDefaultNudge('accept', 'default')
    expect(outcome).toBe('switched')
    expect(mockState.settingsWrites).toEqual([
      { source: 'userSettings', settings: { permissions: { defaultMode: 'auto' } } },
    ])
    expect(mockState.config.hasSeenAutoDefaultNudge).toBe(true)
    expect(resolvedEvent()?.metadata).toEqual({
      choice: 'accept',
      outcome: 'switched',
      current_mode: 'default',
    })
  })

  test('decline: sets the flag only, no settings write, logs declined', async () => {
    seedEligibleState('default')
    const outcome = await resolveAutoDefaultNudge('decline', 'default')
    expect(outcome).toBe('declined')
    expect(mockState.settingsWrites).toEqual([])
    expect(mockState.config.hasSeenAutoDefaultNudge).toBe(true)
    expect(resolvedEvent()?.metadata).toEqual({
      choice: 'decline',
      outcome: 'declined',
      current_mode: 'default',
    })
  })

  test('cancelled: no writes, no events, returns null (official ZIe early return)', async () => {
    seedEligibleState('default')
    const outcome = await resolveAutoDefaultNudge('cancelled', 'default')
    expect(outcome).toBeNull()
    expect(mockState.settingsWrites).toEqual([])
    expect(mockState.config.hasSeenAutoDefaultNudge).toBeUndefined()
    expect(resolvedEvent()).toBeUndefined()
  })

  test('accept while the gate went off: gate_off WITHOUT setting the flag', async () => {
    seedEligibleState('default')
    mockState.supportsAutoMode = false
    const outcome = await resolveAutoDefaultNudge('accept', 'default')
    expect(outcome).toBe('gate_off')
    expect(mockState.settingsWrites).toEqual([])
    // Official Ckt: `if(H!=="gate_off")` guards the flag write — gate_off must
    // leave the one-shot flag unset so the nudge can reappear after recovery.
    expect(mockState.config.hasSeenAutoDefaultNudge).toBeUndefined()
    // Official logs tengu_auto_default_nudge_resolved only for non-gate_off
    // outcomes (gate_off is transient — nothing is "resolved" yet).
    expect(resolvedEvent()).toBeUndefined()
  })

  test('accept while the gate is disabled via settings: gate_off', async () => {
    seedEligibleState('default')
    mockState.mergedSettings = { permissions: { disableAutoMode: 'disable' } }
    const outcome = await resolveAutoDefaultNudge('accept', 'default')
    expect(outcome).toBe('gate_off')
    expect(mockState.config.hasSeenAutoDefaultNudge).toBeUndefined()
    expect(resolvedEvent()).toBeUndefined()
  })

  test('accept when the settings write fails: gate_off, flag not set, no event', async () => {
    seedEligibleState('default')
    mockState.settingsWriteError = new Error('EACCES')
    const outcome = await resolveAutoDefaultNudge('accept', 'default')
    expect(outcome).toBe('gate_off')
    expect(mockState.config.hasSeenAutoDefaultNudge).toBeUndefined()
    expect(resolvedEvent()).toBeUndefined()
  })

  test('flag write is idempotent (official Ae guard: hasSeenAutoDefaultNudge ? c : {...c,...})', async () => {
    seedEligibleState('default')
    const existing = { hasCompletedOnboarding: true, hasSeenAutoDefaultNudge: true }
    mockState.config = existing
    await resolveAutoDefaultNudge('decline', 'default')
    // Same object reference kept when the flag was already set.
    expect(mockState.config).toBe(existing)
  })
})
