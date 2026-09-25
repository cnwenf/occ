import { describe, expect, test } from 'bun:test'
import { isNonRetryableClientError } from '../errors.js'

/**
 * PORT #103 (CC 2.1.281): isNonRetryableClientError predicate.
 *
 * Official v281 @193033439 (new in 281, absent from the v280 binary):
 *   `function c$e(n){return n!==void 0&&n>=400&&n<500&&n!==408&&n!==409&&n!==429}`
 * exported as isNonRetryableClientError. A 4xx status that is NOT one of the
 * transient trio (408 Request Timeout, 409 Conflict, 429 Too Many Requests)
 * will never succeed on retry.
 */
describe('isNonRetryableClientError (2.1.281 #103)', () => {
  test('returns true for non-retryable 4xx client errors', () => {
    expect(isNonRetryableClientError(400)).toBe(true)
    expect(isNonRetryableClientError(403)).toBe(true)
    expect(isNonRetryableClientError(404)).toBe(true)
    expect(isNonRetryableClientError(422)).toBe(true)
    expect(isNonRetryableClientError(499)).toBe(true)
  })

  test('returns false for the transient 4xx trio (408/409/429)', () => {
    expect(isNonRetryableClientError(408)).toBe(false)
    expect(isNonRetryableClientError(409)).toBe(false)
    expect(isNonRetryableClientError(429)).toBe(false)
  })

  test('returns false for non-4xx statuses and for undefined', () => {
    expect(isNonRetryableClientError(200)).toBe(false)
    expect(isNonRetryableClientError(301)).toBe(false)
    expect(isNonRetryableClientError(399)).toBe(false)
    expect(isNonRetryableClientError(500)).toBe(false)
    expect(isNonRetryableClientError(503)).toBe(false)
    expect(isNonRetryableClientError(undefined)).toBe(false)
  })

  test('treats both 4xx boundaries as inclusive (400 lowest, 499 highest)', () => {
    expect(isNonRetryableClientError(400)).toBe(true)
    expect(isNonRetryableClientError(499)).toBe(true)
  })
})
