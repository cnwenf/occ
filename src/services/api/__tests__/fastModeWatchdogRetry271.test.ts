import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import {
  clearFastModeCooldown,
  isFastModeCooldown,
} from '../../../utils/fastMode.js'

/**
 * CC 2.1.271/2.1.272 (fast mode fixes): fast mode under
 * CLAUDE_CODE_RETRY_WATCHDOG must fall back to standard speed instead of
 * failing the turn on a usage-credits (overage) rejection or retrying
 * overload forever at fast speed.
 *
 * Official 2.1.270 gated the whole fast block on `!VM()` (watchdog OFF), so
 * under the watchdog the block never ran. 2.1.272 removed that gate,
 * captured `let Yn=sM()` (watchdog) before the block, and added:
 *   - `if(Jn&&!Yn)` — the silent short-retry sleep only when NOT under the
 *     watchdog; under the watchdog a short retry-after falls through to the
 *     normal visible retry path (fast mode stays on, user sees the retry);
 *   - `if(!Jn){...}` — cooldown only for long/unknown retry-after;
 *   - `if(Yn&&pt>=s)pt=s` — attempt clamps in the overage / cooldown /
 *     400-not-enabled paths so a fallback at budget exhaustion still gets
 *     its standard-speed retry instead of ending the for-loop.
 *
 * Red-test baseline (OCC before this change):
 *   - overage/cooldown at maxRetries=0 under the watchdog threw
 *     CannotRetryError after 1 attempt (loop exhausted, no standard retry);
 *   - short retry-after under the watchdog slept silently with zero yields
 *     (hidden fast-speed retry loop).
 */

const { withRetry, CannotRetryError } =
  require('../withRetry.js') as typeof import('../withRetry.js')

const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_DISABLE_FAST_MODE',
  'CLAUDE_CODE_UNATTENDED_RETRY',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'FALLBACK_FOR_ALL_PRIMARY_MODELS',
  'USER_TYPE',
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  clearFastModeCooldown()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  clearFastModeCooldown()
})

function apiError(
  status: number,
  message: string,
  headers?: Record<string, string>,
): APIError {
  return new APIError(
    status,
    { message },
    message,
    headers ? new Headers(headers) : undefined,
  )
}

/** 529 the SDK way — message carries the overloaded_error type marker. */
function overloadedError(headers?: Record<string, string>): APIError {
  return apiError(529, '{"type":"overloaded_error"}', headers)
}

type RunResult = {
  ok: boolean
  opCalls: number
  fastModeByAttempt: (boolean | undefined)[]
  yields: unknown[]
  threw: unknown
}

/**
 * Drain the withRetry generator. The operation succeeds after
 * `failuresBeforeSuccess` failing attempts; each attempt records
 * context.fastMode so tests can assert the fallback to standard speed.
 */
async function run(
  makeError: () => Error,
  opts: { maxRetries: number; failuresBeforeSuccess: number },
): Promise<RunResult> {
  let opCalls = 0
  const fastModeByAttempt: (boolean | undefined)[] = []
  const yields: unknown[] = []
  const gen = withRetry(
    async () => ({}) as never, // dummy client — operation never uses it
    async (_client, _attempt, context) => {
      opCalls++
      fastModeByAttempt.push(context.fastMode)
      if (opCalls <= opts.failuresBeforeSuccess) {
        throw makeError()
      }
      return { ok: true }
    },
    {
      maxRetries: opts.maxRetries,
      model: 'test-model',
      thinkingConfig: { type: 'disabled' as const },
      fastMode: true,
    },
  )
  try {
    while (true) {
      const next = await gen.next()
      if (next.done) break
      yields.push(next.value)
    }
    return { ok: true, opCalls, fastModeByAttempt, yields, threw: null }
  } catch (e) {
    return { ok: false, opCalls, fastModeByAttempt, yields, threw: e }
  }
}

describe('2.1.271/272: fast mode under CLAUDE_CODE_RETRY_WATCHDOG', () => {
  test(
    'overage (usage-credits) rejection falls back to standard speed instead of failing the turn at budget exhaustion',
    async () => {
      // Arrange — watchdog ON, maxRetries=0 (single-attempt budget). The
      // overage 429 must disable fast mode AND clamp the attempt counter so
      // the standard-speed retry still runs. 'out_of_credits' is used as the
      // overage reason because it skips the settings/global-config writes in
      // handleFastModeOverageRejection (keeps the test hermetic).
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      const overage429 = () =>
        apiError(429, 'rate limited', {
          'anthropic-ratelimit-unified-overage-disabled-reason':
            'out_of_credits',
        })

      // Act
      const result = await run(overage429, {
        maxRetries: 0,
        failuresBeforeSuccess: 1,
      })

      // Assert — red before the fix: the loop ended after the fast-path
      // continue (attempt 2 > maxRetries+1) and threw CannotRetryError.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(result.fastModeByAttempt).toEqual([true, false])
    },
    15000,
  )

  test(
    'overload (529, no retry-after) triggers cooldown fallback and clamps the attempt counter under the watchdog',
    async () => {
      // Arrange — watchdog ON, maxRetries=0. A long/unknown retry-after must
      // enter cooldown (standard speed) and still get its retry.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'

      // Act
      const result = await run(overloadedError, {
        maxRetries: 0,
        failuresBeforeSuccess: 1,
      })

      // Assert — red before the fix: CannotRetryError after 1 attempt.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(result.fastModeByAttempt).toEqual([true, false])
      expect(isFastModeCooldown()).toBe(true)
    },
    15000,
  )

  test(
    'short retry-after under the watchdog falls through to the visible normal retry path (no silent fast-speed loop)',
    async () => {
      // Arrange — watchdog ON, 529 with retry-after 1s (< 20s short-retry
      // threshold). Official 2.1.272 `if(Jn&&!Yn)` skips the silent sleep
      // under the watchdog: the error must surface as a yielded
      // SystemAPIErrorMessage and fast mode stays active for the retry
      // (short delays never trigger cooldown).
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'

      // Act
      const result = await run(() => overloadedError({ 'retry-after': '1' }), {
        maxRetries: 5,
        failuresBeforeSuccess: 1,
      })

      // Assert — red before the fix: the fast block slept silently (0
      // yields) and retried at fast speed in the background.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(result.yields.length).toBe(1)
      expect(result.fastModeByAttempt).toEqual([true, true])
      expect(isFastModeCooldown()).toBe(false)
    },
    15000,
  )

  test(
    'short retry-after WITHOUT the watchdog is visible and backoff-floored (2.1.281 #023)',
    async () => {
      // Arrange — watchdog OFF. 2.1.281 changed this path: v272's silent raw
      // header sleep (`await ee(jn,...)`) became a budget-gated, floored,
      // VISIBLE retry — official `if(gt<=s){let Do=Math.min(uU(gt,xRe(It),vRe),
      // vRe),...;yield r$(kr,Do,gt,s,"request_retry");await qPt(Do,r)}`.
      // retry-after '1' → max(1000ms, attempt-1 backoff ≤625ms) = 1000ms,
      // fast mode preserved. See retryWatchdogRetryAfter281.test.ts for the
      // Retry-After:0 floor / 20s cap / budget-gate coverage.
      // Act
      const result = await run(() => overloadedError({ 'retry-after': '1' }), {
        maxRetries: 5,
        failuresBeforeSuccess: 1,
      })

      // Assert — v281: the retry surfaces as a yielded SystemAPIErrorMessage
      // (v272 behavior was 0 yields; red against the raw-silent sleep).
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(result.yields.length).toBe(1)
      expect(result.fastModeByAttempt).toEqual([true, true])
      expect(isFastModeCooldown()).toBe(false)
    },
    15000,
  )

  test('without fast mode the overage 429 keeps the pre-existing watchdog behavior', async () => {
    // Arrange — fast mode inactive (no fastMode option): the fast block must
    // not run; the 429 goes through the normal watchdog-retryable path.
    // maxRetries=0 → exhaustion throws CannotRetryError as before.
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
    let opCalls = 0
    const gen = withRetry(
      async () => ({}) as never,
      async () => {
        opCalls++
        throw apiError(429, 'rate limited', {
          'anthropic-ratelimit-unified-overage-disabled-reason':
            'out_of_credits',
        })
      },
      {
        maxRetries: 0,
        model: 'test-model',
        thinkingConfig: { type: 'disabled' as const },
      },
    )
    let threw: unknown = null
    try {
      while (true) {
        const next = await gen.next()
        if (next.done) break
      }
    } catch (e) {
      threw = e
    }

    // Assert — non-fast path untouched: exhausted budget still throws.
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(opCalls).toBe(1)
  }, 15000)
})
