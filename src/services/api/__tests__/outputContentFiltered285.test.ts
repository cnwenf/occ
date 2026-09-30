import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { isOutputContentFilteredError } from '../errorUtils.js'
import { classifyAPIError } from '../errors.js'

/**
 * CC 2.1.285 (item-B3): "Fixed responses blocked by the API's output content
 * filter being re-sent and retried, sometimes for minutes, instead of showing
 * the filter's error right away."
 *
 * The official v285 binary extracted a shared predicate `g0` (@203962444):
 *   `var QYn="Output blocked by content filtering policy";
 *    function g0(e){if(!(e instanceof Error)||!e.message.includes(QYn))return!1;
 *      let n="originalError"in e&&e.originalError instanceof Error?e.originalError:e,
 *          r=n instanceof Rt?k9n(n):void 0;
 *      return r===void 0||r===400}`
 * where `Rt` ≡ APIError and `k9n` (@197932304) resolves the effective status
 * (numeric .status → overloaded shape 529 → rate-limit shape 429 → undefined).
 *
 * g0 is wired into THREE sites, all mirrored here:
 *   1. the retry loop catch (withRetry.ts) — fatal CannotRetryError on attempt 1;
 *   2. the streaming→non-streaming fallback (claude.ts) — rethrow, no fallback;
 *   3. classifyAPIError (errors.ts) — 'output_content_filtered'.
 *
 * v284 only had the inline classifier string; OCC previously had NEITHER the
 * predicate nor the fatal retry/fallback branches, so a filtered response was
 * retried like any other error. These tests pin the v285 behavior.
 */

const FILTER = 'Output blocked by content filtering policy'

const { withRetry, CannotRetryError } =
  require('../withRetry.js') as typeof import('../withRetry.js')

/**
 * Build an APIError carrying the filter message. `.message` is derived by the
 * SDK's makeMessage from `error.message` (the body), so the filter string is
 * placed in the body to guarantee `error.message.includes(FILTER)`.
 */
function filterAPIError(
  status: number | undefined,
  opts?: { headerRetry?: boolean; bodySuffix?: string },
): APIError {
  const bodyMessage = `${FILTER}${opts?.bodySuffix ?? ''}`
  const headers = opts?.headerRetry
    ? new Headers({ 'x-should-retry': 'true' })
    : undefined
  return new APIError(status, { message: bodyMessage }, bodyMessage, headers)
}

/** Drain the withRetry generator; return how many operation attempts ran. */
async function runUntilThrow(
  failWith: () => Error,
  maxRetries = 10,
): Promise<{ attempts: number; threw: unknown }> {
  let attempts = 0
  const gen = withRetry(
    async () => ({}) as never, // dummy client — operation throws before use
    async () => {
      attempts++
      throw failWith()
    },
    {
      maxRetries,
      model: 'test-model',
      thinkingConfig: { type: 'disabled' as const },
    },
  )
  try {
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
    return { attempts, threw: null }
  } catch (e) {
    return { attempts, threw: e }
  }
}

describe('CC 2.1.285 item-B3: isOutputContentFilteredError (g0 predicate)', () => {
  test('400 + filter message → true (bare filter rejection is fatal)', () => {
    expect(isOutputContentFilteredError(filterAPIError(400))).toBe(true)
  })

  test('undefined status + filter message → true (non-HTTP rejection is fatal)', () => {
    expect(isOutputContentFilteredError(filterAPIError(undefined))).toBe(true)
  })

  test('429 + filter message → false (rate-limit status wins, stays retryable)', () => {
    expect(isOutputContentFilteredError(filterAPIError(429))).toBe(false)
  })

  test('529 + filter message → false (overloaded status wins)', () => {
    expect(isOutputContentFilteredError(filterAPIError(529))).toBe(false)
  })

  test('undefined status but overloaded_error message shape → false (k9n resolves 529)', () => {
    const e = filterAPIError(undefined, {
      bodySuffix: ' "type":"overloaded_error"',
    })
    expect(isOutputContentFilteredError(e)).toBe(false)
  })

  test('undefined status but rate_limit_error message shape → false (k9n resolves 429)', () => {
    const e = filterAPIError(undefined, {
      bodySuffix: ' "type":"rate_limit_error"',
    })
    expect(isOutputContentFilteredError(e)).toBe(false)
  })

  test('unwraps originalError: wrapper (filter msg) + originalError=APIError 400 → true', () => {
    const outer = new Error(`transport wrapped: ${FILTER}`)
    ;(outer as { originalError?: unknown }).originalError = filterAPIError(400)
    expect(isOutputContentFilteredError(outer)).toBe(true)
  })

  test('unwraps originalError: wrapper (filter msg) + originalError=APIError 429 → false', () => {
    // The outer message alone carries the filter string, but g0 consults the
    // unwrapped originalError's status (429) — proving the unwrap decides.
    const outer = new Error(`transport wrapped: ${FILTER}`)
    ;(outer as { originalError?: unknown }).originalError = filterAPIError(429)
    expect(isOutputContentFilteredError(outer)).toBe(false)
  })

  test('plain Error with filter message and no originalError → true (undefined status)', () => {
    expect(isOutputContentFilteredError(new Error(FILTER))).toBe(true)
  })

  test('non-Error input → false', () => {
    expect(isOutputContentFilteredError(FILTER)).toBe(false)
    expect(isOutputContentFilteredError(null)).toBe(false)
    expect(isOutputContentFilteredError(undefined)).toBe(false)
    expect(isOutputContentFilteredError({ message: FILTER })).toBe(false)
  })

  test('Error without the filter message → false', () => {
    expect(isOutputContentFilteredError(new Error('some other failure'))).toBe(
      false,
    )
    expect(
      isOutputContentFilteredError(
        new APIError(400, { message: 'bad request' }, 'bad request', undefined),
      ),
    ).toBe(false)
  })
})

describe('CC 2.1.285 item-B3: classifyAPIError → output_content_filtered', () => {
  test('400 filter error classifies as output_content_filtered', () => {
    expect(classifyAPIError(filterAPIError(400))).toBe('output_content_filtered')
  })

  test('undefined-status filter error classifies as output_content_filtered', () => {
    expect(classifyAPIError(filterAPIError(undefined))).toBe(
      'output_content_filtered',
    )
  })

  test('429 filter error does NOT classify as output_content_filtered (transport status wins)', () => {
    expect(classifyAPIError(filterAPIError(429))).not.toBe(
      'output_content_filtered',
    )
  })

  test('529 filter error does NOT classify as output_content_filtered', () => {
    expect(classifyAPIError(filterAPIError(529))).not.toBe(
      'output_content_filtered',
    )
  })
})

describe('CC 2.1.285 item-B3: withRetry surfaces the filter error immediately', () => {
  test('400 filter error throws CannotRetryError on the first attempt (no retry storm)', async () => {
    const { attempts, threw } = await runUntilThrow(() => filterAPIError(400))
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })

  test('filter error with x-should-retry:true still throws on attempt 1 (g0 precedes shouldRetry)', async () => {
    // Without the g0 fatal branch, shouldRetry honors x-should-retry:true (no
    // claude.ai subscriber in the test env) and re-sends up to maxRetries;
    // g0 is checked first in the catch, so the filtered response surfaces at
    // once. This is the exact "retried for minutes" bug the changelog fixes.
    const { attempts, threw } = await runUntilThrow(() =>
      filterAPIError(400, { headerRetry: true }),
    )
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })

  test('undefined-status filter error is fatal too (would otherwise be non-retryable, but g0 owns it)', async () => {
    const { attempts, threw } = await runUntilThrow(() =>
      filterAPIError(undefined),
    )
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })

  test('CannotRetryError preserves the original filter error for downstream display', async () => {
    const { threw } = await runUntilThrow(() => filterAPIError(400))
    expect(threw).toBeInstanceOf(CannotRetryError)
    const cre = threw as InstanceType<typeof CannotRetryError>
    expect(isOutputContentFilteredError(cre.originalError)).toBe(true)
  })

  test('non-filter 500 keeps the normal retry budget (no regression)', async () => {
    // A generic retryable server error must still exhaust maxRetries+1, so the
    // g0 branch is not accidentally catching everything.
    const make500 = () =>
      new APIError(500, { message: 'Internal server error' }, 'boom', undefined)
    const { attempts, threw } = await runUntilThrow(make500, 2)
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(3)
  }, 30000)
})
