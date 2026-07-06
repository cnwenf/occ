import { describe, expect, test } from 'bun:test'
import { REPO_ROOT } from './helpers'

/**
 * F3 (2.1.174): wheelScrollAccelerationEnabled. Schema-only before — must
 * gate the scroll-speed runtime: when false, each wheel event scrolls exactly
 * `base` rows (1) with no ramp/decay curve.
 *
 * Source-grep e2e: verifies the setting is read into the wheel accel state
 * (accelEnabled) and gates all three compute branches (native trackpad ramp,
 * wheel-mode decay, xterm.js decay) — matching the official `K7l`/`xZf`.
 */

describe('wheelScrollAccelerationEnabled runtime (2.1.174)', () => {
  test('WheelAccelState carries accelEnabled + initWheelAccel threads it through', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/components/ScrollKeybindingHandler.tsx`).text()
    expect(src).toContain('accelEnabled: boolean')
    expect(src).toMatch(/export function initWheelAccel\([^)]*accelEnabled = true/)
    expect(src).toContain('accelEnabled')
  })

  test('initAndLogWheelAccel reads the setting (default true) + logs accelDisabled', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/components/ScrollKeybindingHandler.tsx`).text()
    // Read lazily from merged settings (official bc("wheelScrollAccelerationEnabled",!0)).
    expect(src).toContain("getInitialSettings().wheelScrollAccelerationEnabled ?? true")
    // Debug log appends " · accelDisabled" when off (official K7l log).
    expect(src).toContain("' · accelDisabled'")
  })

  test('computeWheelStep gates all three acceleration branches on accelEnabled', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/components/ScrollKeybindingHandler.tsx`).text()
    // Native trackpad ramp: skip when disabled (official: a>W7l||!e.accelEnabled).
    expect(src).toContain('gap > WHEEL_ACCEL_WINDOW_MS || !state.accelEnabled')
    // Wheel-mode decay curve: only when accelEnabled (official: e.wheelMode&&e.accelEnabled).
    expect(src).toContain('state.wheelMode && state.accelEnabled')
    // xterm.js decay: early-return base when disabled (official: if(!e.accelEnabled)return max(1,floor(base))).
    expect(src).toContain('if (!state.accelEnabled) return Math.max(1, Math.floor(state.base))')
  })
})
