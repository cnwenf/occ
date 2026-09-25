import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { clearFastModeCooldown } from '../../../utils/fastMode.js'

/**
 * CC 2.1.281 PORT #022 + #023 — retry watchdog delay cap / too-long throw and
 * Retry-After:0 backoff floor.
 *
 * #022 (v281 @202416849, vs v280 @199579290):
 *   `else if(Kn=uU(gt+M,zn),S6())Kn=Math.min(Kn,TRe),yn=!0;
 *    else if(Kn>Opo)throw i("tengu_api_retry_after_too_long",{...}),
 *      m("api_request","api_request_retry_after_too_long"),new Fc(It,g)`
 *   - the backoff exponent becomes gt+M — accumulated persistent waits feed
 *     the exponential backoff of subsequent non-persistent retries (no
 *     reset-to-attempt-1 after long 429/529 waits);
 *   - watchdog (S6) sessions CAP the delay at TRe=21600000 (6h) and enter
 *     heartbeat long-wait mode (yn): 30s-chunked sleeps with keep-alive
 *     yields, plus tengu_api_persistent_retry_wait when > 60s;
 *   - non-watchdog delays > Opo THROW (tengu_api_retry_after_too_long +
 *     api_request/api_request_retry_after_too_long + CannotRetryError)
 *     instead of sleeping silently past a minute. Byte-verified: Opo=60000
 *     in v281 @202407030 (and v280 `ufr=60000` @199569644) — the finalized
 *     §P4 triage note claiming 600000 contradicts the ELF; the bytes win;
 *   - the persistent tail `if(Kt)gt--` replaces the v280 `if(_t>=s)_t=s`
 *     clamp: persistent waits freeze the attempt counter, so the first 5xx
 *     after long 429/529 waits no longer trips the retry-exhausted gate.
 *
 * #023 (v281 @202413332-202414432, vs v280 @199575533):
 *   `if(Eo&&!Sn){if(gt<=s){let Do=Math.min(uU(gt,xRe(It),vRe),vRe),kr=...;
 *     ...yield r$(kr,Do,gt,s,"request_retry");await qPt(Do,r)}continue}`
 *   The fast-mode short-retry path no longer sleeps the RAW header ms
 *   (`Retry-After: 0` → instant back-to-back re-request). The delay is
 *   FLOORED through the exponential backoff helper (uU), CAPPED at
 *   vRe=20000, budget-gated (`gt<=s`), and made VISIBLE via a yielded
 *   retry message.
 *
 * uU (@200159276; identical in v280 as k1 @197288416):
 *   `n=Math.min(500*2^(o-1),s); e=Math.round(n+Math.random()*0.25*n);
 *    if(t){i=parseInt(t,10); if(!isNaN(i)) return Math.max(i*1000,e)} return e`
 *   → getRetryDelay floors a retry-after header at the exponential backoff
 *     instead of returning the raw header value.
 *
 * Red-test baseline (OCC before this change):
 *   - getRetryDelay(1, '0') returned 0 (instant re-request);
 *   - a non-watchdog 500 with retry-after:120 slept 120s silently (no throw);
 *   - a watchdog 500 with a huge retry-after slept uncapped (no 6h cap, no
 *     heartbeat chunking, no persistent_retry_wait log);
 *   - a 5xx after 3 persistent 429 waits threw CannotRetryError (attempt had
 *     drifted to maxRetries+1 under the v280 clamp);
 *   - fast-mode short retries slept the raw header and were silent (0 yields).
 */

// --- mocks: install BEFORE requiring withRetry.js --------------------------
// Passthrough-flag pattern: bun's mock.module is process-global and a re-mock
// "restore" does NOT heal modules whose bindings already resolved to the mock
// namespace. Each mock below delegates to the REAL implementation once its
// flag flips off in afterAll, so later files in the same process see genuine
// sleep/analytics/feature behavior deterministically.

// Spread snapshot — a bare require/import namespace has LIVE bindings that
// bun's mock.module patches, so a passthrough delegate through it would
// recurse into the mock itself (proven hang: attributionBoolean281+symlinkTwins268).
const actualSleepModule = { ...require('../../../utils/sleep.js') } as typeof import('../../../utils/sleep.js')
let sleepMockActive = true
const sleepCalls: number[] = []
mock.module('../../../utils/sleep.js', () => ({
  ...actualSleepModule,
  sleep: async (ms: number, signal?: AbortSignal) => {
    if (!sleepMockActive) return actualSleepModule.sleep(ms, signal)
    sleepCalls.push(ms)
  },
}))

const actualAnalytics = { ...require('../../analytics/index.js') } as typeof import('../../analytics/index.js')
let analyticsMockActive = true
type RecordedEvent = { name: string; metadata: Record<string, unknown> }
const events: RecordedEvent[] = []
mock.module('../../analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    if (!analyticsMockActive) return actualAnalytics.logEvent(name, metadata)
    events.push({ name, metadata })
  },
}))

// UNATTENDED_RETRY is not in the production FEATURE_ALLOWLIST — flip it here
// so the persistent-mode (binary `Kt`) path is reachable in tests.
const { feature: realFeature } = require('../../../utils/featureFlags.js') as typeof import('../../../utils/featureFlags.js')
let flagsMockActive = true
let unattendedRetryEnabled = false
mock.module('../../../utils/featureFlags.js', () => ({
  ...require('../../../utils/featureFlags.js'),
  feature: (name: string) =>
    flagsMockActive && name === 'UNATTENDED_RETRY'
      ? unattendedRetryEnabled
      : realFeature(name),
}))

const { withRetry, CannotRetryError, getRetryDelay } =
  require('../withRetry.js') as typeof import('../withRetry.js')

// --- env hygiene (same convention as fastModeWatchdogRetry271.test.ts) ------

const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_DISABLE_FAST_MODE',
  'CLAUDE_CODE_UNATTENDED_RETRY',
  'CLAUDE_CODE_MAX_RETRIES',
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
  sleepCalls.length = 0
  events.length = 0
  unattendedRetryEnabled = false
  clearFastModeCooldown()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  clearFastModeCooldown()
})

afterAll(() => {
  // Flip every passthrough mock off — withRetry.js (and any other module that
  // resolved these bindings) keeps the mock namespace for the rest of the
  // shared test process, so the flags are the only reliable restore.
  sleepMockActive = false
  analyticsMockActive = false
  flagsMockActive = false
  unattendedRetryEnabled = false
})

// --- helpers ----------------------------------------------------------------

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

type YieldedMessage = {
  subtype?: string
  retryInMs?: number
  retryAttempt?: number
}

type RunResult = {
  ok: boolean
  opCalls: number
  yields: YieldedMessage[]
  threw: unknown
}

/**
 * Drain the withRetry generator. `errorForCall(n)` returns the error the
 * operation throws on call n (1-based); null means the call succeeds.
 */
async function run(
  errorForCall: (callIndex: number) => Error | null,
  opts: { maxRetries: number; fastMode?: boolean },
): Promise<RunResult> {
  let opCalls = 0
  const yields: YieldedMessage[] = []
  const gen = withRetry(
    async () => ({}) as never, // dummy client — operation never uses it
    async () => {
      opCalls++
      const error = errorForCall(opCalls)
      if (error) throw error
      return { ok: true }
    },
    {
      maxRetries: opts.maxRetries,
      model: 'test-model',
      thinkingConfig: { type: 'disabled' as const },
      ...(opts.fastMode ? { fastMode: true } : {}),
    },
  )
  try {
    while (true) {
      const next = await gen.next()
      if (next.done) break
      yields.push(next.value as YieldedMessage)
    }
    return { ok: true, opCalls, yields, threw: null }
  } catch (e) {
    return { ok: false, opCalls, yields, threw: e }
  }
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

const SIX_HOURS_MS = 6 * 60 * 60 * 1000 // binary TRe=21600000
const HEARTBEAT_MS = 30_000 // binary Nlr=30000

// --- #023 unit: getRetryDelay ≡ uU ------------------------------------------

describe('2.1.281 #023 — getRetryDelay floors retry-after through the exponential backoff (uU @200159276)', () => {
  test('Retry-After "0" returns the exponential-backoff floor, not 0', () => {
    // Arrange/Act/Assert — attempt 1: base=500, jitter ≤25% → [500, 625],
    // rounded (binary Math.round). Red before: raw header → 0.
    for (let i = 0; i < 30; i++) {
      const delay = getRetryDelay(1, '0')
      expect(delay).toBeGreaterThanOrEqual(500)
      expect(delay).toBeLessThanOrEqual(625)
      expect(Number.isInteger(delay)).toBe(true)
    }
  })

  test('a header LARGER than the backoff wins (Math.max(i*1000, e))', () => {
    // Arrange/Act/Assert
    expect(getRetryDelay(1, '120')).toBe(120_000)
    for (let i = 0; i < 30; i++) {
      // attempt 3: base=2000, jitter ≤500 → header 1s is below the floor.
      const delay = getRetryDelay(3, '1')
      expect(delay).toBeGreaterThanOrEqual(2000)
      expect(delay).toBeLessThanOrEqual(2500)
    }
  })

  test('backoff without a header is exponential, jittered, and rounded', () => {
    // Arrange/Act/Assert — attempt 4: base=4000 → [4000, 5000].
    for (let i = 0; i < 30; i++) {
      const delay = getRetryDelay(4, null)
      expect(delay).toBeGreaterThanOrEqual(4000)
      expect(delay).toBeLessThanOrEqual(5000)
      expect(Number.isInteger(delay)).toBe(true)
    }
  })
})

// --- #023 integration: fast-mode short-retry path -----------------------------

describe('2.1.281 #023 — fast-mode short retry: floored, capped, budget-gated, visible', () => {
  test(
    'Retry-After: 0 sleeps the exponential-backoff floor (not 0) and yields a visible retry',
    async () => {
      // Arrange — watchdog OFF, fast mode active, 529 with `retry-after: 0`.
      // v280 slept the raw 0ms and re-requested back-to-back, silently.
      // v281: `Do=Math.min(uU(gt,xRe(It),vRe),vRe)` + `yield r$(...)`.
      const error = () => overloadedError({ 'retry-after': '0' })

      // Act
      const result = await run(n => (n === 1 ? error() : null), {
        maxRetries: 5,
        fastMode: true,
      })

      // Assert — floored at attempt-1 backoff [500, 625], and visible.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls.length).toBe(1)
      expect(sleepCalls[0]).toBeGreaterThanOrEqual(500)
      expect(sleepCalls[0]).toBeLessThanOrEqual(625)
      expect(result.yields.length).toBe(1)
      expect(result.yields[0].subtype).toBe('api_error')
      expect(result.yields[0].retryInMs).toBe(sleepCalls[0])
      expect(result.yields[0].retryAttempt).toBe(1)
    },
    15000,
  )

  test(
    'short-retry delay is capped at the 20s threshold even when the backoff outgrows it',
    async () => {
      // Arrange — 7 consecutive `retry-after: 0` 529s, then success. By
      // attempt 7 the raw backoff base is min(500*2^6, 20000)=20000 and the
      // jitter can push uU to 25000 — the outer `Math.min(..., vRe)` must
      // clamp every delay to ≤ 20000.
      const error = () => overloadedError({ 'retry-after': '0' })

      // Act
      const result = await run(n => (n <= 7 ? error() : null), {
        maxRetries: 10,
        fastMode: true,
      })

      // Assert
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(sleepCalls.length).toBe(7)
      for (const ms of sleepCalls) {
        expect(ms).toBeLessThanOrEqual(20_000)
        expect(ms).toBeGreaterThanOrEqual(500)
        expect(Number.isInteger(ms)).toBe(true)
      }
      // attempt 7: base is already at the 20s cap → min(...) === 20000 exactly.
      expect(sleepCalls[6]).toBe(20_000)
    },
    15000,
  )

  test(
    'short retry past the budget does NOT sleep (`if(gt<=s)` gate) — the loop ends with CannotRetryError',
    async () => {
      // Arrange — maxRetries=0: the single attempt is the initial one, so the
      // short-retry gate `gt<=s` is false and the wait is skipped entirely
      // (v280 slept even with the budget exhausted).
      const error = () => overloadedError({ 'retry-after': '0' })

      // Act
      const result = await run(() => error(), {
        maxRetries: 0,
        fastMode: true,
      })

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.ok).toBe(false)
      expect(result.opCalls).toBe(1)
      expect(sleepCalls.length).toBe(0)
      expect(result.yields.length).toBe(0)
    },
    15000,
  )
})

// --- #022 integration: too-long throw + watchdog cap ---------------------------

describe('2.1.281 #022 — retry-delay cap, too-long throw, and heartbeat waits', () => {
  test(
    'non-watchdog delay > 60s throws tengu_api_retry_after_too_long instead of sleeping',
    async () => {
      // Arrange — watchdog OFF, non-persistent: a 500 with `retry-after: 120`
      // (120000ms > Opo=60000). v280 slept silently for 2 minutes.
      const error = () => apiError(500, 'server error', { 'retry-after': '120' })

      // Act
      const result = await run(error, { maxRetries: 5 })

      // Assert — throws, never sleeps, and emits both telemetry events.
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.ok).toBe(false)
      expect(result.opCalls).toBe(1)
      expect(sleepCalls.length).toBe(0)
      const tooLong = events.find(
        e => e.name === 'tengu_api_retry_after_too_long',
      )
      expect(tooLong).toBeDefined()
      expect(tooLong?.metadata.delayMs).toBe(120_000)
      expect(tooLong?.metadata.status).toBe(500)
      const apiRequest = events.find(
        e =>
          e.name === 'api_request' &&
          e.metadata.reason === 'api_request_retry_after_too_long',
      )
      expect(apiRequest).toBeDefined()
    },
    15000,
  )

  test(
    'non-watchdog delay of exactly 60s still sleeps (boundary: throw is > Opo, not >=)',
    async () => {
      // Arrange — `retry-after: 60` → 60000ms, NOT greater than Opo=60000.
      // Act
      const result = await run(
        n => (n === 1 ? apiError(500, 'server error', { 'retry-after': '60' }) : null),
        { maxRetries: 5 },
      )

      // Assert — single non-chunked sleep, no throw, no too-long telemetry.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(sleepCalls).toEqual([60_000])
      expect(
        events.find(e => e.name === 'tengu_api_retry_after_too_long'),
      ).toBeUndefined()
    },
    15000,
  )

  test(
    'watchdog caps a huge non-persistent delay at 6h and sleeps it in 30s heartbeat chunks with a persistent_retry_wait log',
    async () => {
      // Arrange — watchdog ON: `S6() → Kn=Math.min(Kn,TRe), yn=!0`. A 500 with
      // `retry-after: 999999` (≈277h) must cap at TRe=6h — NOT throw (the
      // too-long throw is else-of-watchdog) — and sleep in Nlr=30s chunks.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      const error = () => apiError(500, 'server error', { 'retry-after': '999999' })

      // Act
      const result = await run(n => (n === 1 ? error() : null), {
        maxRetries: 5,
      })

      // Assert
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls.length).toBe(SIX_HOURS_MS / HEARTBEAT_MS) // 720 chunks
      expect(sleepCalls.every(ms => ms === HEARTBEAT_MS)).toBe(true)
      expect(sum(sleepCalls)).toBe(SIX_HOURS_MS)
      // Keep-alive yields: one per chunk (binary `yield r$(...)` inside the loop).
      expect(result.yields.length).toBe(SIX_HOURS_MS / HEARTBEAT_MS)
      const waitLog = events.find(
        e => e.name === 'tengu_api_persistent_retry_wait',
      )
      expect(waitLog).toBeDefined()
      expect(waitLog?.metadata.delayMs).toBe(SIX_HOURS_MS)
      expect(waitLog?.metadata.status).toBe(500)
      const retryLog = events.find(e => e.name === 'tengu_api_retry')
      expect(retryLog?.metadata.delayMs).toBe(SIX_HOURS_MS) // capped BEFORE logging
      expect(
        events.find(e => e.name === 'tengu_api_retry_after_too_long'),
      ).toBeUndefined()
    },
    15000,
  )

  test(
    'persistent-path delay is capped at 6h (existing cap) and chunked into heartbeat sleeps',
    async () => {
      // Arrange — UNATTENDED_RETRY on: a 529 with `retry-after: 99999`
      // (99999000ms) must cap at PERSISTENT_RESET_CAP_MS=6h (binary TRe).
      unattendedRetryEnabled = true
      process.env.CLAUDE_CODE_UNATTENDED_RETRY = '1'
      const error = () => overloadedError({ 'retry-after': '99999' })

      // Act
      const result = await run(n => (n === 1 ? error() : null), {
        maxRetries: 5,
      })

      // Assert
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(sleepCalls.length).toBe(SIX_HOURS_MS / HEARTBEAT_MS)
      expect(sum(sleepCalls)).toBe(SIX_HOURS_MS)
      const waitLog = events.find(
        e => e.name === 'tengu_api_persistent_retry_wait',
      )
      expect(waitLog?.metadata.delayMs).toBe(SIX_HOURS_MS)
      expect(waitLog?.metadata.status).toBe(529)
    },
    15000,
  )

  test(
    '5xx after persistent 429 waits does NOT trip the exhausted gate, and its backoff exponent includes the accumulated waits (gt+M)',
    async () => {
      // Arrange — UNATTENDED_RETRY on, maxRetries=2, three persistent 429
      // waits then a plain 500. v280: the attempt counter drifted to
      // maxRetries+1 during the persistent waits (clamp `_t>=s→_t=s`), so the
      // 500 hit `attempt > maxRetries && !persistent && !watchdogRetryable`
      // and threw — the "fails on first 5xx after long waits" bug. v281:
      // `if(Kt)gt--` freezes the attempt counter, and the 500's backoff uses
      // `uU(gt+M)` = exponent 1+3=4 → [4000, 5000]ms, not a reset to
      // attempt-1's [500, 625].
      unattendedRetryEnabled = true
      process.env.CLAUDE_CODE_UNATTENDED_RETRY = '1'

      // Act
      const result = await run(
        n => {
          if (n <= 3) return apiError(429, 'rate limited', { 'retry-after': '1' })
          if (n === 4) return apiError(500, 'server error')
          return null
        },
        { maxRetries: 2 },
      )

      // Assert — survived the 5xx with a full-budget, continuity-aware backoff.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(5)
      expect(sleepCalls.length).toBe(4)
      expect(sleepCalls[0]).toBe(1000) // max(header 1s, attempt-1 backoff ≤625)
      expect(sleepCalls[3]).toBeGreaterThanOrEqual(4000) // exponent gt(1)+M(3)=4
      expect(sleepCalls[3]).toBeLessThanOrEqual(5000)
      // Attempt freeze is visible in the yields: persistent waits report the
      // persistentAttempt counter (1, 2, 3), then the 5xx reports the FROZEN
      // for-loop attempt (1) — v280 reported 3 here and then threw.
      expect(result.yields.map(y => y.retryAttempt)).toEqual([1, 2, 3, 1])
      expect(
        events.find(e => e.name === 'tengu_api_retry_after_too_long'),
      ).toBeUndefined()
    },
    15000,
  )
})
