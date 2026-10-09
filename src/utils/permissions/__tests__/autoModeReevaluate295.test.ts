import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolPermissionContext } from '../../../Tool.js'

/**
 * CC 2.1.295 — auto mode must be restorable WITHOUT a restart after
 * `disableAutoMode` is removed from settings.
 *
 * Official evidence (s295.txt :398/:429): the availability gate
 * `l_r(e)=!Y(e)&&!ae()` is computed FRESH on each check, and the
 * settings-change mapper `Tc` (s295.txt :17852/:18053/:18099) treats
 * `disableAutoMode` as permission-affecting — so a settings change
 * re-evaluates availability. OCC instead CACHED the flag at startup
 * (`isAutoModeAvailable: isAutoModeGateEnabled()` once) and
 * `canCycleToAuto` required `ctx.isAutoModeAvailable && gate()` — so once
 * the auto-mode opt-in decline stuck the flag to false, removing
 * `disableAutoMode` from settings never restored auto mode until restart.
 *
 * Fix under test: `reevaluateAutoModeAvailability` recomputes the fresh gate
 * and immutably clears/restores the sticky flag; it is hooked into
 * `transitionPlanAutoMode`, which applySettingsChange (interactive +
 * headless) and Config.tsx call on every settings change.
 *
 * Mock pattern: readDeny291.test.ts (spread-actual + afterAll restore,
 * dynamic import of the target AFTER mocks — Bun mock.module leak OCC-97).
 */

// MACRO polyfill (permissionSetup import graph reads MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const actualSettings = await import('../../settings/settings.js')
const actualBetas = await import('../../betas.js')
const actualModel = await import('../../model/model.js')

const mockState: {
  settings: Record<string, unknown>
  supportsAutoMode: boolean
} = {
  settings: {},
  supportsAutoMode: true,
}

mock.module('../../settings/settings.js', () => ({
  ...actualSettings,
  getSettings_DEPRECATED: () => mockState.settings,
}))
mock.module('../../betas.js', () => ({
  ...actualBetas,
  modelSupportsAutoMode: () => mockState.supportsAutoMode,
}))
mock.module('../../model/model.js', () => ({
  ...actualModel,
  getMainLoopModel: () => 'claude-test',
}))

const { reevaluateAutoModeAvailability, transitionPlanAutoMode } =
  await import('../permissionSetup.js')
const { _resetForTesting: resetAutoModeState } = await import(
  '../autoModeState.js'
)

afterAll(() => {
  // Restore real modules (OCC-97: Bun mock.module leaks across files).
  mock.module('../../settings/settings.js', () => ({ ...actualSettings }))
  mock.module('../../betas.js', () => ({ ...actualBetas }))
  mock.module('../../model/model.js', () => ({ ...actualModel }))
})

beforeEach(() => {
  mockState.settings = {}
  mockState.supportsAutoMode = true
  resetAutoModeState()
})

/** Sticky-false context: what the opt-in decline leaves behind. */
function stickyFalseContext(): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    isAutoModeAvailable: false,
  }
}

describe('CC 2.1.295 — reevaluateAutoModeAvailability clears sticky flag', () => {
  test('sticky-false is cleared when the fresh gate is enabled (disableAutoMode removed)', () => {
    const ctx = stickyFalseContext()
    const next = reevaluateAutoModeAvailability(ctx)
    expect(next.isAutoModeAvailable).toBe(true)
    // Immutable: original untouched, new object returned.
    expect(ctx.isAutoModeAvailable).toBe(false)
    expect(next).not.toBe(ctx)
  })

  test('gate disabled via permissions.disableAutoMode keeps availability false', () => {
    mockState.settings = { permissions: { disableAutoMode: 'disable' } }
    const ctx: ToolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      isAutoModeAvailable: true,
    }
    const next = reevaluateAutoModeAvailability(ctx)
    expect(next.isAutoModeAvailable).toBe(false)
    expect(ctx.isAutoModeAvailable).toBe(true)
  })

  test('gate disabled via top-level disableAutoMode keeps availability false', () => {
    mockState.settings = { disableAutoMode: 'disable' }
    const ctx: ToolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      isAutoModeAvailable: true,
    }
    const next = reevaluateAutoModeAvailability(ctx)
    expect(next.isAutoModeAvailable).toBe(false)
  })

  test('unsupported model keeps availability false', () => {
    mockState.supportsAutoMode = false
    const ctx: ToolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      isAutoModeAvailable: true,
    }
    const next = reevaluateAutoModeAvailability(ctx)
    expect(next.isAutoModeAvailable).toBe(false)
  })

  test('returns the SAME reference when nothing changes (no churn)', () => {
    const ctx: ToolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      isAutoModeAvailable: true,
    }
    expect(reevaluateAutoModeAvailability(ctx)).toBe(ctx)
    const staleFalse = stickyFalseContext()
    mockState.settings = { permissions: { disableAutoMode: 'disable' } }
    expect(reevaluateAutoModeAvailability(staleFalse)).toBe(staleFalse)
  })
})

describe('CC 2.1.295 — transitionPlanAutoMode hooks the re-evaluation', () => {
  test('non-plan mode still re-evaluates the sticky flag (settings-change path)', () => {
    const ctx = stickyFalseContext()
    const next = transitionPlanAutoMode(ctx)
    expect(next.mode).toBe('default')
    expect(next.isAutoModeAvailable).toBe(true)
  })

  test('plan mode with prePlanMode=bypassPermissions re-evaluates then returns early', () => {
    const ctx: ToolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      mode: 'plan',
      prePlanMode: 'bypassPermissions',
      isAutoModeAvailable: false,
    }
    const next = transitionPlanAutoMode(ctx)
    expect(next.isAutoModeAvailable).toBe(true)
    expect(next.mode).toBe('plan')
  })
})
