import { describe, expect, test } from 'bun:test'

import {
  computeHistoryEdited,
  computeSuppressSuggestions,
} from '../historyEdited.js'

/**
 * CC 2.1.268 E26: @ file and / command suggestions reappear after recalling a
 * previous prompt with the up arrow and editing it.
 *
 * Official 2.1.268 (byte-verified from the binary):
 *   - hook return: `historyEdited:xe>0&&we!==no.current`
 *     (xe = historyIndex state, we = current input, no = recalled-value ref)
 *   - consumer gate: 2.1.267 `const Jvt=Xm||rLe>0;`
 *                   → 2.1.268 `const Rwt=ip||$Le>0&&!WLe;`
 *     fed to `suppressSuggestions`.
 */

describe('2.1.268 E26 computeHistoryEdited (official xe>0&&we!==no.current)', () => {
  test('no recall (historyIndex 0) → false regardless of input', () => {
    expect(computeHistoryEdited(0, 'typed text', null)).toBe(false)
    expect(computeHistoryEdited(0, '', null)).toBe(false)
  })

  test('recalled and unedited → false (input matches recalled value)', () => {
    expect(computeHistoryEdited(1, 'fix the bug', 'fix the bug')).toBe(false)
    expect(computeHistoryEdited(3, 'fix the bug', 'fix the bug')).toBe(false)
  })

  test('recalled then edited → true', () => {
    expect(computeHistoryEdited(1, 'fix the bug!', 'fix the bug')).toBe(true)
    expect(computeHistoryEdited(2, '', 'previous prompt')).toBe(true)
  })

  test('recalled with null recalled-value (post-reset) at index>0 → true', () => {
    expect(computeHistoryEdited(1, 'anything', null)).toBe(true)
  })
})

describe('2.1.268 E26 computeSuppressSuggestions (official ip||$Le>0&&!WLe)', () => {
  test('searching history always suppresses', () => {
    expect(computeSuppressSuggestions(true, 0, false)).toBe(true)
    expect(computeSuppressSuggestions(true, 2, true)).toBe(true)
  })

  test('no recall → suggestions allowed', () => {
    expect(computeSuppressSuggestions(false, 0, false)).toBe(false)
  })

  test('recalled unedited prompt → suppressed (2.1.267 behavior kept)', () => {
    expect(computeSuppressSuggestions(false, 1, false)).toBe(true)
    expect(computeSuppressSuggestions(false, 5, false)).toBe(true)
  })

  test('recalled then EDITED prompt → suggestions reappear (the E26 fix)', () => {
    expect(computeSuppressSuggestions(false, 1, true)).toBe(false)
    expect(computeSuppressSuggestions(false, 4, true)).toBe(false)
  })
})

describe('2.1.268 E26 end-to-end recall→edit sequence', () => {
  test('suppress flips to false exactly when the recalled value diverges', () => {
    // Up arrow recalls "run tests" at index 1; input now equals recalled.
    let input = 'run tests'
    let recalled: string | null = 'run tests'
    let index = 1
    expect(
      computeSuppressSuggestions(false, index, computeHistoryEdited(index, input, recalled)),
    ).toBe(true)
    // User types one character → suggestions reappear.
    input = 'run tests please'
    expect(
      computeSuppressSuggestions(false, index, computeHistoryEdited(index, input, recalled)),
    ).toBe(false)
    // Submit → resetHistory clears index and recalled value.
    index = 0
    recalled = null
    input = ''
    expect(
      computeSuppressSuggestions(false, index, computeHistoryEdited(index, input, recalled)),
    ).toBe(false)
    // Down-arrow back to draft: index 0 → never suppressed by the history gate.
    input = 'partial @fi'
    expect(
      computeSuppressSuggestions(false, index, computeHistoryEdited(index, input, recalled)),
    ).toBe(false)
  })
})
