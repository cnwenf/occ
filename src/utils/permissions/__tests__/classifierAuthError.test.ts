/**
 * CC 2.1.216 #3 — auto mode must NOT deny commands on HTTP 401 classifier
 * errors (OAuth token expired/rotated mid-session).
 *
 * The classifier API call (sideQuery → withRetry) attempts a token refresh on
 * 401; if the refresh fails the 401 propagates to the classifier's catch block.
 * Previously that catch swallowed ALL errors as "classifier unavailable" →
 * with iron-gate-closed (default) the command was DENIED — the user saw a
 * permission denial when the real problem was an expired auth token.
 *
 * Fix: detect auth errors (HTTP 401/403) and re-throw so they surface as an
 * authentication failure (main loop prompts re-auth), not a bash-command
 * denial.
 *
 * This test covers the pure detection helper `isClassifierAuthError` — the
 * load-bearing gate that decides whether to re-throw vs. swallow. The helper
 * checks structurally (Error + numeric status 401/403), matching the shape of
 * the Anthropic SDK's APIError/AuthenticationError subclasses that sideQuery
 * throws. Mock errors are constructed to match that shape without importing
 * the SDK (avoids loading the SDK value module in the shared bun test
 * process, which changes init order and trips a pre-existing envUtils cycle).
 */
import { describe, expect, test } from 'bun:test'

const { isClassifierAuthError } = await import('../yoloClassifier.js')

/** Build a mock error that structurally matches an Anthropic SDK APIError. */
function makeAPIError(status: number, message: string): Error {
  const e = new Error(message)
  Object.defineProperty(e, 'status', { value: status, enumerable: true })
  return e
}

describe('CC 2.1.216 #3 — isClassifierAuthError (401 ≠ denial)', () => {
  test('HTTP 401 is an auth error', () => {
    expect(isClassifierAuthError(makeAPIError(401, 'invalid api key'))).toBe(true)
  })

  test('HTTP 403 (token revoked) is an auth error', () => {
    expect(isClassifierAuthError(makeAPIError(403, 'token revoked'))).toBe(true)
  })

  test('HTTP 429 (rate limit) is NOT an auth error', () => {
    expect(isClassifierAuthError(makeAPIError(429, 'slow down'))).toBe(false)
  })

  test('HTTP 500 (server error) is NOT an auth error', () => {
    expect(isClassifierAuthError(makeAPIError(500, 'internal error'))).toBe(false)
  })

  test('HTTP 400 (bad request) is NOT an auth error', () => {
    expect(isClassifierAuthError(makeAPIError(400, 'bad prompt'))).toBe(false)
  })

  test('generic Error without status is NOT an auth error', () => {
    expect(isClassifierAuthError(new Error('something broke'))).toBe(false)
  })

  test('null / undefined / string are NOT auth errors', () => {
    expect(isClassifierAuthError(null)).toBe(false)
    expect(isClassifierAuthError(undefined)).toBe(false)
    expect(isClassifierAuthError('401 unauthorized')).toBe(false)
  })

  test('object with status but not an Error instance is NOT an auth error', () => {
    // Structural guard: must be an Error instance, not a plain object.
    expect(isClassifierAuthError({ status: 401, message: 'fake' })).toBe(false)
  })
})
