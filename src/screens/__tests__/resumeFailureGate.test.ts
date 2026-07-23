import { test, expect, describe } from 'bun:test'
import {
  shouldRethrowResumeError,
  shouldResetResumingOnError,
} from '../resumeFailureGate.js'

// CC 2.1.216 #6 (d): resume-picker hangs on failure. The CLI-entry resume
// picker's `onSelect` re-throws without resetting `setResuming(false)`.
// `LogSelector` calls `onSelect` fire-and-forget, so the rejection is
// unhandled and `resuming` stays `true` forever — the spinner hangs.

describe('shouldRethrowResumeError', () => {
  test('returns false for fire-and-forget caller (LogSelector)', () => {
    // LogSelector calls onSelect(log) without await — re-throwing creates an
    // unhandled rejection and leaves the UI stuck.
    expect(shouldRethrowResumeError(false)).toBe(false)
  })

  test('returns true for awaited caller (can observe rejection)', () => {
    // An awaited caller can catch the rejection, so re-throwing is safe.
    expect(shouldRethrowResumeError(true)).toBe(true)
  })
})

describe('shouldResetResumingOnError', () => {
  test('returns true for any error (UI must fall back to selector)', () => {
    expect(shouldResetResumingOnError(new Error('Failed to load'))).toBe(true)
  })

  test('returns true for network errors', () => {
    expect(shouldResetResumingOnError(new Error('Network error'))).toBe(true)
  })

  test('returns true for parse errors', () => {
    expect(
      shouldResetResumingOnError(new Error('Invalid JSON in session file')),
    ).toBe(true)
  })

  test('the bug: without reset, resuming stays true forever (hang)', () => {
    // The old code re-threw without setResuming(false). The fix resets state.
    const shouldReset = shouldResetResumingOnError(new Error('any'))
    expect(shouldReset).toBe(true) // must reset → no hang
  })
})
