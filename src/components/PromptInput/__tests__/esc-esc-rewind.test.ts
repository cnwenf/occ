import { test, expect, describe } from 'bun:test'
import { shouldOpenRewindOnEscEsc } from '../escEscGate.js'

// CC 2.1.216 #12: Esc-Esc at an idle prompt opens the rewind picker in
// long-running sessions with background tasks. The gate must key off the
// MAIN query loop (isQueryActive), NOT the composite isLoading (which is
// also true for background/external loading). When a background task is
// running but the main loop is idle, Esc-Esc must still open the picker.

describe('shouldOpenRewindOnEscEsc', () => {
  test('returns true when input is empty, messages exist, and main query is idle', () => {
    expect(shouldOpenRewindOnEscEsc('', 3, false)).toBe(true)
  })

  test('returns true even when background loading is active, as long as main query is idle', () => {
    // The regression: background tasks made isLoading=true, blocking the picker.
    // isQueryActive=false (main loop idle) => picker should open.
    expect(shouldOpenRewindOnEscEsc('', 3, false)).toBe(true)
  })

  test('returns false when the main query loop is active (Esc should cancel the request)', () => {
    expect(shouldOpenRewindOnEscEsc('', 3, true)).toBe(false)
  })

  test('returns false when input is non-empty (Esc clears input instead)', () => {
    expect(shouldOpenRewindOnEscEsc('some text', 3, false)).toBe(false)
  })

  test('returns false when there are no messages (nothing to rewind to)', () => {
    expect(shouldOpenRewindOnEscEsc('', 0, false)).toBe(false)
  })

  test('returns false when input is non-empty even if query is active', () => {
    expect(shouldOpenRewindOnEscEsc('text', 3, true)).toBe(false)
  })

  test('returns false for empty input and no messages even if query is active', () => {
    expect(shouldOpenRewindOnEscEsc('', 0, true)).toBe(false)
  })
})
