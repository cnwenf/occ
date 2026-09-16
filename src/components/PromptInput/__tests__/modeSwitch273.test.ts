import { describe, expect, test } from 'bun:test'

import { shouldTriggerModeSwitch } from '../inputModes.js'

/**
 * Official 2.1.273 keypress-dispatch guard (byte-verified:
 * `pe!==void 0&&y.offset===D.length&&lBe(A)&&pe()!==hg(A)`), extracted as the
 * pure predicate shouldTriggerModeSwitch.
 *
 * The 2.1.273 fix is the LAST clause: v2.1.272 ran the mode-switch path for
 * any `!` typed at the start of the input — even while already in shell mode —
 * swallowing the character and making negated commands like `! grep -v x`
 * untypable in bash mode.
 */

describe('2.1.273 shouldTriggerModeSwitch', () => {
  test('! at start in prompt mode → mode switch (enter shell mode)', () => {
    expect(shouldTriggerModeSwitch('!', true, 'prompt')).toBe(true)
  })

  test('! at start while ALREADY in bash mode → plain insert (the 2.1.273 fix)', () => {
    // 2.1.272 returned true here, eating the `!` — `! grep -v x` untypable.
    expect(shouldTriggerModeSwitch('!', true, 'bash')).toBe(false)
  })

  test('! not at cursor start → plain insert', () => {
    expect(shouldTriggerModeSwitch('!', false, 'prompt')).toBe(false)
  })

  test('non-mode characters never trigger a switch', () => {
    expect(shouldTriggerModeSwitch('x', true, 'prompt')).toBe(false)
    expect(shouldTriggerModeSwitch('/', true, 'prompt')).toBe(false)
    expect(shouldTriggerModeSwitch('@', true, 'prompt')).toBe(false)
    expect(shouldTriggerModeSwitch('', true, 'prompt')).toBe(false)
  })

  test('no current-mode getter (undefined) → plain insert', () => {
    expect(shouldTriggerModeSwitch('!', true, undefined)).toBe(false)
  })

  test('other modes differ from bash → ! still switches (insert + cursor-left)', () => {
    expect(shouldTriggerModeSwitch('!', true, 'orphaned-permission')).toBe(true)
    expect(shouldTriggerModeSwitch('!', true, 'task-notification')).toBe(true)
  })
})
