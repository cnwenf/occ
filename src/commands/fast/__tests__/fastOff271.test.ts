import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../../types/command.js'

/**
 * CC 2.1.271/2.1.272 (fast mode fixes): `/fast off` must turn fast mode off
 * even when the org has disabled fast mode. Official 2.1.270 refused BOTH
 * directions:
 *   `let M=Qj(); if(M) return {kind:"refused", refusal:\`Fast mode
 *    unavailable: ${M}\`}`
 * (Qj = getFastModeUnavailableReason), so `/fast off` answered "Fast mode
 * unavailable: ..." and the user could not turn it off. 2.1.272 gates the
 * refusal on the enable argument:
 *   `let d=Sz(void 0,{sessionOptIn:...}); if(d&&e) return {kind:"refused",...}`
 * — enabling is refused, disabling always succeeds.
 *
 * Red-test baseline: with an org-disabled reason, `/fast off` previously
 * returned "Fast mode unavailable: ..." via onDone instead of "Fast mode
 * OFF", and never applied the toggle.
 */

// --- Mocks -------------------------------------------------------------------

// fastMode mock: spread the REAL module (fast.tsx also imports
// isFastModeEnabled, applyFastMode's helpers, etc.) and override only the
// two org-state entry points so the test is hermetic (no prefetch network,
// no module-level orgStatus dependence).
const realFastMode = await import('../../../utils/fastMode.js')
let unavailableReason: string | null = null
mock.module('../../../utils/fastMode.js', () => ({
  ...realFastMode,
  getFastModeUnavailableReason: () => unavailableReason,
  prefetchFastModeStatus: async () => {},
}))

// Settings mock: record writes instead of touching disk.
const realSettings = await import('../../../utils/settings/settings.js')
const settingsWrites: [string, unknown][] = []
mock.module('../../../utils/settings/settings.js', () => ({
  ...realSettings,
  updateSettingsForSource: (source: string, patch: unknown) => {
    settingsWrites.push([source, patch])
  },
}))

// Load the command AFTER mocks are registered.
const { call } = await import('../fast.js')

// --- Helpers -----------------------------------------------------------------

const ORG_DISABLED = 'Fast mode has been disabled by your organization'

function makeContext(): {
  context: LocalJSXCommandContext
  onDone: LocalJSXCommandOnDone
  doneMessages: string[]
  stateUpdaters: ((prev: { fastMode?: boolean }) => { fastMode?: boolean })[]
} {
  const doneMessages: string[] = []
  const stateUpdaters: ((prev: {
    fastMode?: boolean
  }) => { fastMode?: boolean })[] = []
  const onDone: LocalJSXCommandOnDone = (msg: string) => {
    doneMessages.push(msg)
  }
  const context = {
    getAppState: () => ({ mainLoopModel: 'opus', fastMode: true }),
    setAppState: (f: unknown) => {
      stateUpdaters.push(
        f as (prev: { fastMode?: boolean }) => { fastMode?: boolean },
      )
    },
  } as unknown as LocalJSXCommandContext
  return { context, onDone, doneMessages, stateUpdaters }
}

beforeEach(() => {
  unavailableReason = null
  settingsWrites.length = 0
  delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
})

// --- Tests -------------------------------------------------------------------

describe('2.1.271/272: /fast off works when the org disabled fast mode', () => {
  test('"/fast off" with an org-disabled reason turns fast mode OFF (not "unavailable")', async () => {
    // Arrange — org disabled fast mode; user still has it on locally.
    unavailableReason = ORG_DISABLED
    const { context, onDone, doneMessages, stateUpdaters } = makeContext()

    // Act
    const rendered = await call(onDone, context, 'off')

    // Assert — red before the fix: onDone got
    // "Fast mode unavailable: Fast mode has been disabled by your
    // organization" and no state/settings were applied.
    expect(rendered).toBeNull()
    expect(doneMessages).toEqual(['Fast mode OFF'])
    expect(stateUpdaters.length).toBe(1)
    expect(stateUpdaters[0]({ fastMode: true })).toEqual({ fastMode: false })
    expect(settingsWrites).toEqual([['userSettings', { fastMode: undefined }]])
  })

  test('"/fast on" with an org-disabled reason is still refused (enable gate kept)', async () => {
    // Arrange — the official 2.1.272 fix only unblocks disabling; enabling
    // must still refuse with the exact official message shape.
    unavailableReason = ORG_DISABLED
    const { context, onDone, doneMessages, stateUpdaters } = makeContext()

    // Act
    const rendered = await call(onDone, context, 'on')

    // Assert
    expect(rendered).toBeNull()
    expect(doneMessages).toEqual([`Fast mode unavailable: ${ORG_DISABLED}`])
    expect(stateUpdaters.length).toBe(0)
    expect(settingsWrites).toEqual([])
  })

  test('"/fast off" with fast mode available still turns it off (no regression)', async () => {
    // Arrange
    const { context, onDone, doneMessages, stateUpdaters } = makeContext()

    // Act
    await call(onDone, context, 'off')

    // Assert
    expect(doneMessages).toEqual(['Fast mode OFF'])
    expect(stateUpdaters.length).toBe(1)
    expect(settingsWrites).toEqual([['userSettings', { fastMode: undefined }]])
  })
})
