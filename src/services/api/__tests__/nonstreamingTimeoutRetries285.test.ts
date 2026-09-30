import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk'

/**
 * CC 2.1.285 (item-B2): CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES + the shared
 * retry budget for the non-streaming fallback.
 *
 * Changelog: "Fixed a failing API request being retried up to 21 times when
 * streaming kept failing … the non-streaming fallback now shares the request's
 * retry budget instead of getting a fresh set of retries."
 *
 * Official v285 retry-loop catch (evidence
 * /tmp/cc-diff-285/evidence/nonstreaming_retries.txt):
 *   `let Xn,vn=a.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES;
 *    if(vn!==void 0&&r.nonStreamingTimeoutMs!==void 0&&Ft instanceof gI&&
 *       Date.now()-Et>=r.nonStreamingTimeoutMs*bIo&&!XW()){
 *      if(K>=vn)throw m("api_request","api_request_nonstreaming_timeout_exhausted"),
 *        new ic(Ft,h);
 *      K++,Xn=vn-K}`
 *
 * Mapping: gI ≡ APIConnectionTimeoutError (SDK "Request timed out."), Et ≡
 * per-attempt start time, bIo ≡ 0.9 elapsed ratio, XW() ≡ retry watchdog, K ≡
 * counter, ic ≡ CannotRetryError. The official `I0t` fallback dispatcher
 * (@204942557) passes BOTH `maxRetries:n.maxRetries` (shared budget) and
 * `nonStreamingTimeoutMs:S` into the loop options; v284's `uOt` passed neither.
 *
 * Without the cap, a fallback that keeps timing out re-sends up to maxRetries
 * times, each burning the full nonStreamingTimeoutMs — minutes of silent
 * retries. The cap stops after CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES.
 */

const { withRetry, CannotRetryError } =
  require('../withRetry.js') as typeof import('../withRetry.js')

const ENV_KEYS = [
  'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES',
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_MAX_RETRIES',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

/**
 * Drain the withRetry generator against an operation that always throws a
 * request timeout. `nonStreamingTimeoutMs` mirrors the official fallback
 * dispatcher's loop option; leaving it undefined models the streaming path
 * (where the cap must never fire).
 */
async function drainTimeoutRetries(
  opts: { maxRetries: number; nonStreamingTimeoutMs?: number },
  failWith: () => Error = () => new APIConnectionTimeoutError(),
): Promise<{ attempts: number; threw: unknown }> {
  let attempts = 0
  const gen = withRetry(
    async () => ({}) as never, // dummy client — operation throws before use
    async () => {
      attempts++
      throw failWith()
    },
    {
      maxRetries: opts.maxRetries,
      model: 'test-model',
      thinkingConfig: { type: 'disabled' as const },
      nonStreamingTimeoutMs: opts.nonStreamingTimeoutMs,
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

describe('CC 2.1.285 item-B2: CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES cap', () => {
  test(
    'cap=2 + nonStreamingTimeoutMs=0: stops re-sending a timing-out fallback on the 3rd attempt',
    async () => {
      // nonStreamingTimeoutMs=0 → elapsed gate `>= 0*0.9` always passes, so the
      // cap counts every timeout. K reaches 2 on the 3rd attempt → throws.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '2'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 10,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )

  test(
    'cap=0: the very first qualifying timeout is fatal',
    async () => {
      // K=0 >= cap=0 on attempt 1 → immediate throw (no timeout retries).
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 10,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(1)
    },
    30000,
  )

  test(
    'env unset: cap disabled, timeout retries to the normal maxRetries budget',
    async () => {
      // No CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES → the cap block is skipped;
      // APIConnectionTimeoutError is retryable, so the loop exhausts
      // maxRetries+1 = 4 attempts and throws generic exhaustion.
      delete process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 3,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(4)
    },
    30000,
  )

  test(
    'cap set but nonStreamingTimeoutMs absent (streaming path): cap never fires',
    async () => {
      // The official gate requires r.nonStreamingTimeoutMs !== void 0; the
      // streaming path never sets it, so the cap is inert there.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '1'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 2,
        // nonStreamingTimeoutMs omitted
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )

  test(
    'elapsed ratio gate: a fast failure (< 90% of timeout) does not count toward the cap',
    async () => {
      // cap=0 would throw on attempt 1 IF the attempt ran ~the full timeout.
      // Here nonStreamingTimeoutMs=100000 but the operation throws immediately
      // (elapsed ≈ 0 < 90000), so `Date.now()-Et >= timeout*0.9` is false and
      // the cap is skipped → the loop retries to maxRetries+1 = 2.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 1,
        nonStreamingTimeoutMs: 100000,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(2)
    },
    30000,
  )

  test(
    'retry watchdog ON: cap suppressed (official !XW() guard)',
    async () => {
      // XW() ≡ isRetryWatchdogEnabled(). With the watchdog on, the official
      // gate `!XW()` is false → the cap never fires regardless of the env, so
      // the loop retries to maxRetries+1 = 2 even with cap=0.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 1,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(2)
    },
    30000,
  )

  test(
    'invalid env value (non-integer): cap disabled, normal budget applies',
    async () => {
      // parseEnvInt("abc") → undefined → cap disabled.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = 'abc'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 2,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )

  test(
    'cap does not affect non-timeout retryable errors (500 keeps full budget)',
    async () => {
      // The cap only matches APIConnectionTimeoutError; a 500 must still run
      // the full maxRetries+1 budget even when the env cap is 0.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0'
      const { APIError } = await import('@anthropic-ai/sdk')
      const { attempts, threw } = await drainTimeoutRetries(
        { maxRetries: 2, nonStreamingTimeoutMs: 0 },
        () =>
          new APIError(
            500,
            { message: 'Internal server error' },
            'boom',
            undefined,
          ),
      )
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )
})
