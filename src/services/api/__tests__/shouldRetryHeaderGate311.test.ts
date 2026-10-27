// The real query path computes a message fingerprint reading MACRO.VERSION
// (build-time constant polyfilled in cli.tsx). Mirror the repo-convention
// polyfill for test execution (withRetryIntegration286 discipline).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { APIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

/**
 * CC 2.1.311 (triage-T3 item 49 / WP-P): the early `x-should-retry:false`
 * gate in `shouldRetry`.
 *
 * Official v311 `Qur` (@251051850, byte-verified) inserts — BEFORE every
 * force-true branch — the gate:
 *
 *   if(ZXe(e)&&e.headers?.get("x-should-retry")==="false"
 *      &&(e.status===429||e.status===529||e.status===503&&cs())
 *      &&e.headers?.get(O0e)!=="fetch_error"
 *      &&(aAe()||gfn(e)))return!1;
 *
 * where ZXe ≡ isTransientCapacityError (529/overloaded OR 429), cs ≡
 * firstParty && first-party base URL, O0e = the unified overage-disabled-reason
 * header, aAe ≡ isRetryWatchdogEnabled, and gfn is the generic header-false
 * predicate (`x-should-retry==="false"` → true). v310 (and OCC pre-port) had
 * the header-false check LATE — after the overloaded/persistent/REMOTE force-true
 * branches — plus a non-official `USER_TYPE==="ant"` 5xx exception that let ants
 * ignore `x-should-retry:false` on 5xx. v311 removes the ant exception and moves
 * the gate first.
 *
 * shouldRetry is not exported, so these tests drive the REAL `withRetry`
 * generator and observe the attempt count (`opCalls`): a non-retryable error
 * surfaces as CannotRetryError after exactly ONE operation call.
 */

process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const { withRetry, CannotRetryError } =
  require('../withRetry.js') as typeof import('../withRetry.js')

const OVERAGE_DISABLED_REASON_HEADER =
  'anthropic-ratelimit-unified-overage-disabled-reason'

const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_RETRY_WATCHDOG_SCOPE',
  'CLAUDE_CODE_UNATTENDED_RETRY',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_FOUNDRY',
  'FALLBACK_FOR_ALL_PRIMARY_MODELS',
  'USER_TYPE',
  'IS_SANDBOX',
  'ANTHROPIC_BASE_URL',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
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

/** Build an APIError carrying an `x-should-retry` (and optional extra) header. */
function apiErrorWithHeaders(
  status: number,
  message: string,
  headers: Record<string, string>,
): APIError {
  return new APIError(status, { message }, message, new Headers(headers))
}

const DRAIN_TIMEOUT_MS = 5000

type DrainResult = {
  opCalls: number
  threw: unknown
  completed: boolean
}

/**
 * Drains the withRetry generator; the operation always throws `makeError()`.
 * Returns the number of operation attempts plus the terminal throw. A
 * wall-clock guard keeps a (unexpected) long backoff from hanging the run —
 * `completed:false` means the generator was still sleeping when the guard fired.
 */
async function drainAlwaysFailing(
  makeError: () => Error,
  opts: { maxRetries?: number } = {},
): Promise<DrainResult> {
  let opCalls = 0
  const gen = withRetry(
    async () => ({}) as never,
    async () => {
      opCalls++
      throw makeError()
    },
    {
      maxRetries: opts.maxRetries ?? 1,
      model: 'test-model',
      thinkingConfig: { type: 'disabled' as const },
    },
  )
  const deadline = Date.now() + DRAIN_TIMEOUT_MS
  let threw: unknown = null
  let completed = false
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const next = await Promise.race([
        gen.next(),
        new Promise<'timeout'>(resolve => {
          const timer = setTimeout(() => resolve('timeout'), remaining)
          timer.unref?.()
        }),
      ])
      if (next === 'timeout') break
      if (next.done) {
        completed = true
        break
      }
    }
  } catch (error) {
    threw = error
  } finally {
    try {
      await gen.return(undefined as never)
    } catch {
      // Generator already settled — nothing to clean up.
    }
  }
  return { opCalls, threw, completed }
}

describe('2.1.311 item-49 — early x-should-retry:false gate (official Qur ordering)', () => {
  test('429 + x-should-retry:false is NOT retried even though the overloaded-message force-true branch would match', async () => {
    // The message carries `"type":"overloaded_error"`, which is a force-true
    // branch in shouldRetry. v310 evaluated that branch BEFORE the header-false
    // check → retry. v311's gate fires first (429 ∈ {429,529,503}, header
    // false, firstParty default, no overage exemption) → no retry.
    const result = await drainAlwaysFailing(() =>
      apiErrorWithHeaders(
        429,
        '{"type":"error","error":{"type":"overloaded_error"}}',
        { 'x-should-retry': 'false' },
      ),
    )
    expect(result.opCalls).toBe(1)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
  })

  test('429 + x-should-retry:false + retry watchdog enabled is NOT retried', async () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
    const result = await drainAlwaysFailing(() =>
      apiErrorWithHeaders(429, 'rate limited', { 'x-should-retry': 'false' }),
    )
    expect(result.opCalls).toBe(1)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
  })

  test('503 + x-should-retry:false on a first-party base URL is NOT retried', async () => {
    // 503 is gated only when cs() (firstParty && first-party base URL) holds —
    // the default with no ANTHROPIC_BASE_URL set.
    const result = await drainAlwaysFailing(() =>
      apiErrorWithHeaders(503, 'service unavailable', {
        'x-should-retry': 'false',
      }),
    )
    expect(result.opCalls).toBe(1)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
  })

  test('USER_TYPE=ant no longer ignores x-should-retry:false on 5xx (ant exception removed)', async () => {
    // v310 OCC had a non-official exception: ants ignored x-should-retry:false
    // for 5xx, falling through to the `>=500 → true` branch → retry. v311 has
    // no ant exception; the header-false gate returns false → no retry.
    process.env.USER_TYPE = 'ant'
    const result = await drainAlwaysFailing(() =>
      apiErrorWithHeaders(500, 'internal error', { 'x-should-retry': 'false' }),
    )
    expect(result.opCalls).toBe(1)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
  })

  test('USER_TYPE=ant no longer ignores x-should-retry:false on 503 first-party', async () => {
    process.env.USER_TYPE = 'ant'
    const result = await drainAlwaysFailing(() =>
      apiErrorWithHeaders(503, 'service unavailable', {
        'x-should-retry': 'false',
      }),
    )
    expect(result.opCalls).toBe(1)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
  })

  test('x-should-retry:false + overage-disabled-reason "fetch_error" SKIPS the gate (exempt)', async () => {
    // The gate's `headers.get(O0e) !== "fetch_error"` clause is false here, so
    // the gate does not fire. The error still ends up non-retryable via the
    // late header-false branch — this pins that the exemption path is taken
    // without changing the terminal outcome for a 429.
    const result = await drainAlwaysFailing(() =>
      apiErrorWithHeaders(429, 'rate limited', {
        'x-should-retry': 'false',
        [OVERAGE_DISABLED_REASON_HEADER]: 'fetch_error',
      }),
    )
    expect(result.opCalls).toBe(1)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
  })

  test('503 + x-should-retry:false on a NON-first-party base URL SKIPS the gate', async () => {
    // cs() is false (custom base URL), so the 503 arm of the gate does not
    // match. The error is still non-retryable via the late header-false branch.
    process.env.ANTHROPIC_BASE_URL = 'https://custom-gateway.example.com'
    const result = await drainAlwaysFailing(() =>
      apiErrorWithHeaders(503, 'service unavailable', {
        'x-should-retry': 'false',
      }),
    )
    expect(result.opCalls).toBe(1)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
  })

  test('x-should-retry:false on a NON-gated status (400) is NOT retried (header honored)', async () => {
    // 400 is not in {429,529,503}; the gate does not fire, but the late
    // header-false branch still returns false. Guards against the gate port
    // accidentally widening header-false handling.
    const result = await drainAlwaysFailing(() =>
      apiErrorWithHeaders(400, 'bad request', { 'x-should-retry': 'false' }),
    )
    expect(result.opCalls).toBe(1)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
  })
})
