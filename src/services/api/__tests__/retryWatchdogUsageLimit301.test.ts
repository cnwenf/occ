// Repo-convention MACRO polyfill (must run before withRetry.js is required).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { clearFastModeCooldown } from '../../../utils/fastMode.js'

/**
 * CC 2.1.301 (occ160 WP-A) — CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS:
 * unattended retry mode ends a request at a usage limit that resets too far
 * away instead of waiting.
 *
 * Byte evidence (2.1.301 linux-x64 ELF, /tmp/cc-diff-301/v301/package/claude):
 *
 *   1. Watchdog capacity branch @228699313 (v300 @227784421 only set
 *      `Wr=Kt`; v301 inserts the budget block before `Vr=cn`):
 *        `if(cn instanceof Pt&&cn.status===429){
 *           if(Zn=nKr(cn,h),Zn!==null&&cn.headers?.get?.(
 *               "anthropic-ratelimit-unified-status")==="rejected"){
 *             let hr=(a.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS
 *               ??1/0)-V.usageLimitSpentMs;
 *             if(Zn>hr){
 *               let Kr=cn.headers?.get(esn),
 *                 Us=Kr==="allowed"||Kr==="allowed_warning";
 *               if(hr<=0||!Us&&cn.headers?.get(g9e)!=="fetch_error")
 *                 throw m("api_request",
 *                   "api_request_usage_limit_wait_too_long"),new Rc(cn,y);
 *               Zn=Us?Math.min(hr,G$(K,null,pvn,r.random)):hr}
 *             Vr=cn}}`
 *      esn="anthropic-ratelimit-unified-overage-status" (@221076197),
 *      g9e="anthropic-ratelimit-unified-overage-disabled-reason"
 *      (@221076246), pvn=300000 / mvn=21600000 (@228686263),
 *      nKr = UNCAPPED unified-reset reader (@228707043).
 *
 *   2. Ledger init @228688688:
 *        `V=r.modelCallRetries?.capacityWait??{spentMs:0,usageLimitSpentMs:0}`
 *      (modelCallRetries literal @228711516 matches).
 *
 *   3. Heartbeat accounting @228701537:
 *        `if(So){let Us=Kr?Math.min(Zn,Math.round(h.monotonicNow()-hr)):Zn;
 *          if(V.spentMs+=Us,Vr)V.usageLimitSpentMs+=Us}`
 *
 *   4. Env descriptor @216719076: `$U=H.int({min:1,digitsOnly:!0})` —
 *      identical shape to zU (CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS);
 *      export map @216688553 places $U between QU (CLAUDE_CODE_RETRY_WATCHDOG)
 *      and zU.
 *
 *   5. rewind_limit_question gate nN() @243133750 now checks BOTH env vars —
 *      N/A for OCC (no rewind_limit_question surface); noted in withRetry.ts.
 *
 * Covered below:
 *   - getRetryWatchdogMaxUsageLimitWaitMs digits-only fail-open + warn-once
 *     (mirrors the 295 MAX_WAIT_MS getter conventions);
 *   - early-end throw (wait > budget, overage NOT usable, not fetch_error);
 *   - cap-to-remaining when overage IS usable (allowed / allowed_warning);
 *   - the fetch_error exception path (unusable overage still waits `hr`);
 *   - usageLimitSpentMs accumulation across heartbeat chunks feeding the
 *     NEXT attempt's hr (usable-then-exhausted and fetch_error-then-
 *     exhausted sequences);
 *   - budget=Infinity default preserves 2.1.300 behavior (rejected 429
 *     waits normally; non-rejected / no-reset-delay 429s and 529s never
 *     enter the branch).
 */

// --- mocks: install BEFORE requiring withRetry.js --------------------------
// Passthrough-flag pattern (same as retryWatchdog295Review.test.ts):
// bun's mock.module is process-global; each mock delegates to the REAL
// implementation once its flag flips off in afterAll.

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

// Capture warn-level logForDebugging calls (the warn-once path).
const actualDebug = { ...require('../../../utils/debug.js') } as typeof import('../../../utils/debug.js')
let debugMockActive = true
type RecordedLog = { message: string; level: string }
const debugLogs: RecordedLog[] = []
mock.module('../../../utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    if (!debugMockActive)
      return actualDebug.logForDebugging(
        message,
        opts as { level?: 'debug' } | undefined,
      )
    debugLogs.push({ message, level: opts?.level ?? 'debug' })
  },
}))

const {
  withRetry,
  CannotRetryError,
  getRetryWatchdogMaxUsageLimitWaitMs,
  resetIgnoredRetryWatchdogMaxUsageLimitWaitWarnedForTesting,
} = require('../withRetry.js') as typeof import('../withRetry.js')

// --- env hygiene (same convention as retryWatchdog295Review) ----------------

const ENV_MAX_USAGE_WAIT = 'CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS'
const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS',
  ENV_MAX_USAGE_WAIT,
  'CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS',
  'CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS',
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
  debugLogs.length = 0
  resetIgnoredRetryWatchdogMaxUsageLimitWaitWarnedForTesting()
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
  // Flip every passthrough mock off — later files in the same test process
  // must see genuine sleep/analytics/debug behavior.
  sleepMockActive = false
  analyticsMockActive = false
  debugMockActive = false
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

/**
 * A usage-limit rejection: 429 + anthropic-ratelimit-unified-status=rejected
 * + a unified-reset timestamp `resetInMs` in the future (the official Zn via
 * nKr). Extra headers (overage-status / overage-disabled-reason) merge in.
 */
function usageLimitError(
  resetInMs: number,
  extraHeaders?: Record<string, string>,
): APIError {
  return apiError(429, '{"type":"rate_limit_error"}', {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(
      Math.round((Date.now() + resetInMs) / 1000),
    ),
    ...extraHeaders,
  })
}

function setMaxUsageWait(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_MAX_USAGE_WAIT]
  else process.env[ENV_MAX_USAGE_WAIT] = value
}

const warnMessages = (): string[] =>
  debugLogs.filter(l => l.level === 'warn').map(l => l.message)

const tooLongEvents = (): RecordedEvent[] =>
  events.filter(
    e =>
      e.name === 'api_request' &&
      e.metadata.reason === 'api_request_usage_limit_wait_too_long',
  )

const exhaustedEvents = (): RecordedEvent[] =>
  events.filter(
    e =>
      e.name === 'api_request' &&
      e.metadata.reason === 'api_request_capacity_wait_exhausted',
  )

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

const HEARTBEAT_MS = 30_000 // binary ado=30000

const ONE_HOUR_MS = 60 * 60 * 1000
const EIGHT_HOURS_MS = 8 * ONE_HOUR_MS

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
 * Every capacity-error sequence ends in a success valve — under the watchdog
 * 429/529s bypass maxRetries, so the valve bounds the loop and turns a
 * neutered early-end into a clean assertion failure instead of a hang.
 */
async function run(
  errorForCall: (callIndex: number) => Error | null,
  opts: { maxRetries: number },
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

// --- 1. getRetryWatchdogMaxUsageLimitWaitMs: digits-only fail-open ----------

describe('getRetryWatchdogMaxUsageLimitWaitMs — valid digits-only integers are honored ($U=H.int({min:1,digitsOnly:!0}))', () => {
  test('unset env → undefined (official `??1/0` → Infinity budget) and NO warning', () => {
    // Arrange — env hygiene already deleted the var.
    // Act
    const result = getRetryWatchdogMaxUsageLimitWaitMs()
    // Assert
    expect(result).toBeUndefined()
    expect(warnMessages().length).toBe(0)
  })

  test('digits-only integers >= 1 parse to their numeric value, no warning', () => {
    // Arrange/Act/Assert — including boundary (min=1), leading zeros, an
    // explicit '+', and surrounding whitespace (regex + parseEnvInt trim).
    const cases: [string, number][] = [
      ['1', 1],
      ['5000', 5000],
      ['007', 7],
      ['+5', 5],
      [' 250 ', 250],
      ['21600000', 21_600_000],
    ]
    for (const [raw, expected] of cases) {
      setMaxUsageWait(raw)
      expect(getRetryWatchdogMaxUsageLimitWaitMs()).toBe(expected)
    }
    expect(warnMessages().length).toBe(0)
  })
})

describe('getRetryWatchdogMaxUsageLimitWaitMs — malformed values fail open to undefined (digits-only, mirrors MAX_WAIT_MS)', () => {
  test.each([
    ['5s', 'unit suffix'],
    ['10 000', 'internal space (digit-separator form REJECTED by digitsOnly)'],
    ['abc', 'non-numeric'],
    ['', 'empty string (equivalent to unset)'],
    ['1e3', 'scientific notation REJECTED by digitsOnly'],
    ['--5', 'double sign'],
    ['150.5', 'fractional'],
    ['6_000', 'underscore separator REJECTED by digitsOnly'],
    ['0', 'digits-only but below min=1'],
    ['-5', 'negative, below min=1'],
  ])('%p → undefined (%s)', (raw: string) => {
    // Arrange
    setMaxUsageWait(raw)
    // Act/Assert — official semantics: anything unusable → undefined →
    // `??1/0` leaves the usage-limit-wait budget uncapped.
    expect(getRetryWatchdogMaxUsageLimitWaitMs()).toBeUndefined()
  })
})

describe('getRetryWatchdogMaxUsageLimitWaitMs — malformed non-empty values warn once (fail-open preserved)', () => {
  test('a malformed value logs a single warn naming the var and the value, deduped across calls', () => {
    // Arrange
    setMaxUsageWait('5s')
    // Act — three reads must not spam.
    getRetryWatchdogMaxUsageLimitWaitMs()
    getRetryWatchdogMaxUsageLimitWaitMs()
    getRetryWatchdogMaxUsageLimitWaitMs()
    // Assert — warn-once per distinct value; fail-open result unchanged.
    const warns = warnMessages()
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain(
      'CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS',
    )
    expect(warns[0]).toContain("'5s'")
  })

  test('distinct malformed values each warn once (Set is keyed per value)', () => {
    // Arrange/Act
    setMaxUsageWait('abc')
    getRetryWatchdogMaxUsageLimitWaitMs()
    setMaxUsageWait('1e3')
    getRetryWatchdogMaxUsageLimitWaitMs()
    setMaxUsageWait('abc')
    getRetryWatchdogMaxUsageLimitWaitMs() // already-warned value → deduped
    // Assert
    const warns = warnMessages()
    expect(warns.length).toBe(2)
    expect(warns.some(m => m.includes("'abc'"))).toBe(true)
    expect(warns.some(m => m.includes("'1e3'"))).toBe(true)
  })

  test('empty string stays SILENT (equivalent to unset)', () => {
    // Arrange
    setMaxUsageWait('')
    // Act
    const result = getRetryWatchdogMaxUsageLimitWaitMs()
    // Assert
    expect(result).toBeUndefined()
    expect(warnMessages().length).toBe(0)
  })

  test('digits-only below the min (0) also warns — an ignored operator-set value is never silent', () => {
    // Arrange
    setMaxUsageWait('0')
    // Act
    const result = getRetryWatchdogMaxUsageLimitWaitMs()
    // Assert
    expect(result).toBeUndefined()
    expect(warnMessages().length).toBe(1)
    expect(warnMessages()[0]).toContain("'0'")
  })
})

// --- 2. early-end throw: reset too far away, overage NOT usable -------------

describe('CC 2.1.301 — usage-limit early-end throw (api_request_usage_limit_wait_too_long)', () => {
  test(
    'rejected 429 resetting in 1h with a 1000ms budget and NO overage-status → throws before sleeping, telemetry exactly once',
    async () => {
      // Arrange — official: Zn≈3.6e6 > hr=1000; Kr=null → Us=false;
      // g9e header absent (null !== "fetch_error") → throw.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxUsageWait('1000')

      // Act
      const result = await run(
        n => (n === 1 ? usageLimitError(ONE_HOUR_MS) : null),
        { maxRetries: 5 },
      )

      // Assert — throw happens BEFORE the retry telemetry/sleep, so nothing
      // slept and nothing yielded.
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.ok).toBe(false)
      expect(result.opCalls).toBe(1)
      expect(sleepCalls).toEqual([])
      expect(result.yields.length).toBe(0)
      expect(tooLongEvents().length).toBe(1)
      // The early-end throw is the ONLY api_request event on this path.
      expect(events.filter(e => e.name === 'api_request').length).toBe(1)
      expect(exhaustedEvents().length).toBe(0)
    },
    15000,
  )

  test(
    'a present-but-unusable overage-status (not allowed/allowed_warning) also throws',
    async () => {
      // Arrange — Kr="disallowed" → Us=false; no fetch_error → throw.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxUsageWait('1000')

      // Act
      const result = await run(
        n =>
          n === 1
            ? usageLimitError(ONE_HOUR_MS, {
                'anthropic-ratelimit-unified-overage-status': 'disallowed',
              })
            : null,
        { maxRetries: 5 },
      )

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.opCalls).toBe(1)
      expect(sleepCalls).toEqual([])
      expect(tooLongEvents().length).toBe(1)
    },
    15000,
  )

  test(
    'hr<=0 throws EVEN WHEN overage is usable (official `if(hr<=0||...)` short-circuit)',
    async () => {
      // Arrange — call 1: hr=1, Zn≈3.6e6>1, Kr="allowed" → Us=true →
      // Zn=min(1, backoff)=1 → sleeps 1ms, usageLimitSpentMs=1. Call 2:
      // hr=1-1=0 → Zn>0 and hr<=0 → throw despite Kr="allowed".
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxUsageWait('1')

      // Act
      const result = await run(
        n =>
          n <= 2
            ? usageLimitError(ONE_HOUR_MS, {
                'anthropic-ratelimit-unified-overage-status': 'allowed',
              })
            : null,
        { maxRetries: 5 },
      )

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([1])
      expect(tooLongEvents().length).toBe(1)
    },
    15000,
  )
})

// --- 3. usable overage: cap-to-remaining (allowed / allowed_warning) --------

describe('CC 2.1.301 — usable overage caps the wait to the remaining usage budget (Zn=Us?Math.min(hr,G$(K,null,pvn,random)):hr)', () => {
  test.each([
    ['allowed', 'Kr==="allowed"'],
    ['allowed_warning', 'Kr==="allowed_warning"'],
  ])('overage-status=%p waits min(hr, 5-min-capped backoff) and succeeds', async (overageStatus: string) => {
    // Arrange — hr=40; the attempt-1 backoff window is [500,625] so
    // min(40, backoff)=40 deterministically proves the hr clamp.
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
    setMaxUsageWait('40')

    // Act
    const result = await run(
      n =>
        n === 1
          ? usageLimitError(ONE_HOUR_MS, {
              'anthropic-ratelimit-unified-overage-status': overageStatus,
            })
          : null,
      { maxRetries: 5 },
    )

    // Assert — the run SUCCEEDS after the clamped wait (early-end avoided).
    expect(result.threw).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.opCalls).toBe(2)
    expect(sleepCalls).toEqual([40])
    expect(tooLongEvents().length).toBe(0)
    // The clamped delay is what the retry telemetry reports.
    const retryEvent = events.find(e => e.name === 'tengu_api_retry')
    expect(retryEvent?.metadata.delayMs).toBe(40)
  })

  test(
    'the usable wait charges usageLimitSpentMs: the NEXT rejected 429 sees hr=0 and throws',
    async () => {
      // Arrange — budget 40. Call 1: allowed → sleeps 40 (single chunk),
      // usageLimitSpentMs=40. Call 2: allowed again but hr=40-40=0 →
      // official `hr<=0` throw. Proves the heartbeat accounting
      // (`if(Vr)V.usageLimitSpentMs+=Us`) really feeds the next attempt.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxUsageWait('40')

      // Act
      const result = await run(
        n =>
          n <= 2
            ? usageLimitError(ONE_HOUR_MS, {
                'anthropic-ratelimit-unified-overage-status':
                  'allowed_warning',
              })
            : null,
        { maxRetries: 5 },
      )

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([40])
      expect(tooLongEvents().length).toBe(1)
    },
    15000,
  )
})

// --- 4. fetch_error exception path ------------------------------------------

describe('CC 2.1.301 — fetch_error exception: unusable overage still waits the remaining budget (Zn=hr)', () => {
  test(
    'overage-disabled-reason=fetch_error with a 70000ms budget: chunks [30000,30000,10000], then the next rejected 429 exhausts hr and throws',
    async () => {
      // Arrange — Zn≈28.8e6 (8h) > hr=70000; Kr=null → Us=false BUT
      // g9e="fetch_error" → NO throw; Zn=hr=70000, capped at 6h (no-op).
      // Heartbeat chunking: 30000+30000+10000, each chunk charging BOTH
      // spentMs and usageLimitSpentMs (Vr set). Call 2: hr=0 → throw.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxUsageWait('70000')

      // Act
      const result = await run(
        n =>
          n <= 2
            ? usageLimitError(EIGHT_HOURS_MS, {
                'anthropic-ratelimit-unified-overage-disabled-reason':
                  'fetch_error',
              })
            : null,
        { maxRetries: 5 },
      )

      // Assert — chunk sizes pin the hr substitution (sum === 70000, not
      // the 8h reset delay) and the 30s heartbeat split.
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([HEARTBEAT_MS, HEARTBEAT_MS, 10_000])
      expect(sum(sleepCalls)).toBe(70_000)
      // Keep-alive yields: one per chunk, retryInMs counting down.
      expect(result.yields.map(y => y.retryInMs)).toEqual([
        70_000, 40_000, 10_000,
      ])
      // 70000 > the 60000ms persistent-wait log threshold → logged.
      const waitLog = events.find(
        e => e.name === 'tengu_api_persistent_retry_wait',
      )
      expect(waitLog?.metadata.delayMs).toBe(70_000)
      // Call 2 threw on hr<=0 — NOT via the overall capacity budget.
      expect(tooLongEvents().length).toBe(1)
      expect(exhaustedEvents().length).toBe(0)
    },
    15000,
  )

  test(
    'fetch_error wait is also clamped by the overall MAX_WAIT budget (official ir=Math.min(ir,Mr))',
    async () => {
      // Arrange — usage budget 70000 but overall budget 50: Zn=hr=70000 →
      // min(70000, 6h) → min(50, Mr) = 50. A single 50ms chunk; the next
      // rejected 429 throws too_long (hr=70000-50>0 but the OVERALL budget
      // exhausts first: Mr=50-50=0 → capacity_wait_exhausted).
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '50'
      setMaxUsageWait('70000')

      // Act
      const result = await run(
        n =>
          n <= 2
            ? usageLimitError(EIGHT_HOURS_MS, {
                'anthropic-ratelimit-unified-overage-disabled-reason':
                  'fetch_error',
              })
            : null,
        { maxRetries: 5 },
      )

      // Assert — call 1 sleeps the Mr-clamped 50ms; call 2 hits the
      // capacity_wait_exhausted gate BEFORE the usage-limit gate (official
      // statement order: Mr check precedes the 429 block).
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([50])
      expect(exhaustedEvents().length).toBe(1)
      expect(tooLongEvents().length).toBe(0)
    },
    15000,
  )
})

// --- 5. default Infinity preserves 2.1.300 behavior --------------------------

describe('CC 2.1.301 — budget unset (hr=Infinity) preserves 2.1.300 behavior; branch gates pinned', () => {
  test(
    'rejected 429 with a 1h reset and NO budget env: waits the normal retry-after-floored delay, no early-end, run succeeds',
    async () => {
      // Arrange — hr=Infinity → Zn(3.6e6) > Infinity is false → no
      // early-end; OCC keeps its existing getRetryDelay shape, floored at
      // retry-after 1s → exactly 1000ms. usageLimitWait is set (Vr) but
      // nothing reads the subtotal without the env.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'

      // Act
      const result = await run(
        n =>
          n === 1
            ? apiError(429, '{"type":"rate_limit_error"}', {
                'anthropic-ratelimit-unified-status': 'rejected',
                'anthropic-ratelimit-unified-reset': String(
                  Math.round((Date.now() + ONE_HOUR_MS) / 1000),
                ),
                'retry-after': '1',
              })
            : null,
        { maxRetries: 5 },
      )

      // Assert — 2.1.300 shape: visible retry, single 1000ms sleep, success.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([1000])
      expect(tooLongEvents().length).toBe(0)
      expect(events.filter(e => e.name === 'api_request').length).toBe(0)
    },
    15000,
  )

  test(
    '429 WITHOUT unified-status=rejected never enters the branch even with a tiny budget (official gate `==="rejected"`)',
    async () => {
      // Arrange — reset delay present but no unified-status header → the
      // official `Zn!==null&&headers.get(...)===​"rejected"` gate is false.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxUsageWait('1')

      // Act
      const result = await run(
        n =>
          n === 1
            ? apiError(429, '{"type":"rate_limit_error"}', {
                'anthropic-ratelimit-unified-reset': String(
                  Math.round((Date.now() + ONE_HOUR_MS) / 1000),
                ),
              })
            : null,
        { maxRetries: 5 },
      )

      // Assert — plain attempt-1 backoff window [500,625], no throw.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(sleepCalls.length).toBe(1)
      expect(sleepCalls[0]).toBeGreaterThanOrEqual(500)
      expect(sleepCalls[0]).toBeLessThanOrEqual(625)
      expect(tooLongEvents().length).toBe(0)
    },
    15000,
  )

  test(
    'rejected 429 WITHOUT a unified-reset delay (Zn===null) never enters the branch (official gate `Zn!==null&&`)',
    async () => {
      // Arrange
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxUsageWait('1')

      // Act
      const result = await run(
        n =>
          n === 1
            ? apiError(429, '{"type":"rate_limit_error"}', {
                'anthropic-ratelimit-unified-status': 'rejected',
              })
            : null,
        { maxRetries: 5 },
      )

      // Assert — plain backoff, no early-end.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(sleepCalls.length).toBe(1)
      expect(sleepCalls[0]).toBeGreaterThanOrEqual(500)
      expect(sleepCalls[0]).toBeLessThanOrEqual(625)
      expect(tooLongEvents().length).toBe(0)
    },
    15000,
  )

  test(
    'a PAST unified-reset (Zn===null via nKr `h>0?h:null`) never enters the branch',
    async () => {
      // Arrange — reset timestamp 10s in the past → nKr returns null.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxUsageWait('1')

      // Act
      const result = await run(
        n =>
          n === 1
            ? apiError(429, '{"type":"rate_limit_error"}', {
                'anthropic-ratelimit-unified-status': 'rejected',
                'anthropic-ratelimit-unified-reset': String(
                  Math.round((Date.now() - 10_000) / 1000),
                ),
              })
            : null,
        { maxRetries: 5 },
      )

      // Assert
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(tooLongEvents().length).toBe(0)
    },
    15000,
  )

  test(
    '529 with a tiny usage budget is untouched (official gate `cn.status===429`) — 2.1.295 spentMs behavior intact',
    async () => {
      // Arrange — MAX_USAGE=1 would throw on a rejected 429, but 529 never
      // enters the usage-limit branch; MAX_WAIT unset → overall budget
      // Infinity → plain backoff, then success.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxUsageWait('1')

      // Act
      const result = await run(n => (n <= 2 ? overloadedError() : null), {
        maxRetries: 5,
      })

      // Assert
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(3)
      expect(tooLongEvents().length).toBe(0)
      expect(exhaustedEvents().length).toBe(0)
      expect(sleepCalls.length).toBe(2)
    },
    15000,
  )

  test(
    'a NON-watchdog session ignores the usage budget entirely (official `if(So)` gate)',
    async () => {
      // Arrange — watchdog OFF: a rejected 429 with retry-after 1s takes the
      // normal visible-retry path regardless of the tiny budget env.
      setMaxUsageWait('1')

      // Act
      const result = await run(
        n =>
          n === 1
            ? usageLimitError(ONE_HOUR_MS, { 'retry-after': '1' })
            : null,
        { maxRetries: 5 },
      )

      // Assert
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(sleepCalls).toEqual([1000])
      expect(tooLongEvents().length).toBe(0)
    },
    15000,
  )
})
