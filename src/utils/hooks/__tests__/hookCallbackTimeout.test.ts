import { describe, expect, test } from 'bun:test'
import {
  PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE,
  hookCallbackTimeoutMessage,
  isPerHookCallbackTimeout,
} from '../../hooks.js'

/**
 * #9 (2.1.210): "Fixed a hook callback timeout being misreported to the model
 * as a user rejection, which made unattended sessions stop and wait."
 *
 * When a PreToolUse hook callback times out, the harness must:
 * 1. Swallow the timeout rejection (not propagate it as a bare stop).
 * 2. Yield a blockingError with outcome:'blocking' (not a bare {type:'stop'}).
 * 3. If the error reaches the outer catch, yield a stopReason (not undefined).
 *
 * The official 2.1.210 binary string `aVg`:
 * "PreToolUse hook did not respond before its timeout (host client may be
 * unreachable). The tool call was not executed; other configured hooks may
 * not have completed."
 */

describe('PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE (#9 — callback timeout not misreported as user rejection)', () => {
  test('matches the official 2.1.210 binary string exactly', () => {
    // Arrange
    const expected =
      'PreToolUse hook did not respond before its timeout (host client may be unreachable). ' +
      'The tool call was not executed; other configured hooks may not have completed.'

    // Assert
    expect(PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE).toBe(expected)
  })

  test('is a non-empty string with the key phrase "host client may be unreachable"', () => {
    // Assert — this phrase distinguishes a timeout from a user rejection.
    // "user rejection" would say "denied" or "rejected"; a timeout says
    // "host client may be unreachable" — telling the model the hook
    // timed out, not that the user said no.
    expect(PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE).toContain('host client may be unreachable')
    expect(PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE).not.toContain('rejected')
    expect(PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE).not.toContain('denied')
  })

  test('mentions "not executed" so the model knows the tool call did not run', () => {
    // Assert — the model needs to know the tool was NOT executed (so it
    // can retry), rather than thinking the user rejected it (which would
    // make it stop and wait).
    expect(PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE).toContain('not executed')
  })
})

/**
 * Behavioral coverage for the #9 fix's core decision: a per-hook callback
 * TIMEOUT is swallowed (→ blockingError the model can act on) while a
 * user-CANCEL or a non-timeout error is rethrown. This is the actual
 * behavior change — before #9 the timeout propagated as a bare stop and
 * unattended sessions read "Error: undefined" as a user rejection and
 * halted.
 */
describe('isPerHookCallbackTimeout (#9 — swallow timeout, rethrow cancel)', () => {
  test('swallows when the per-hook abort fired and the parent signal is still live', () => {
    // Arrange: per-hook combined signal aborted (timeout), parent not aborted
    // Assert: classify as a swallowable per-hook timeout
    expect(isPerHookCallbackTimeout(true, false)).toBe(true)
  })

  test('rethrows when the parent signal aborted (user-initiated cancel)', () => {
    // Arrange: both combined + parent aborted (Ctrl+C / Esc)
    // Assert: NOT a swallowable timeout — a real cancel must propagate
    expect(isPerHookCallbackTimeout(true, true)).toBe(false)
  })

  test('rethrows when the combined signal did not abort (non-timeout error)', () => {
    // Arrange: a plain hook error, no timeout involved
    // Assert: NOT a swallowable timeout — genuine errors must surface
    expect(isPerHookCallbackTimeout(false, false)).toBe(false)
  })
})

describe('hookCallbackTimeoutMessage (#9 — model-facing timeout text)', () => {
  test('builds the official blockingError text with the hook name and timeout', () => {
    // Assert — matches the official 2.1.210 `hook callback timed out after ${ue}ms`.
    // The model sees this and knows it was a timeout (not a user rejection),
    // so an unattended session does not halt waiting for nonexistent user input.
    expect(hookCallbackTimeoutMessage('PreToolUse:Read', 5000)).toBe(
      'PreToolUse:Read hook callback timed out after 5000ms',
    )
  })

  test('never contains "rejected" or "denied" — a timeout, not a user rejection', () => {
    expect(hookCallbackTimeoutMessage('PreToolUse:Bash', 15000)).not.toContain(
      'rejected',
    )
    expect(hookCallbackTimeoutMessage('PreToolUse:Bash', 15000)).not.toContain(
      'denied',
    )
  })
})
