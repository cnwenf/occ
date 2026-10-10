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
 * occ153 review cluster — CC 2.1.295 (item-3) capacity-wait watchdog budget
 * ledger + the dataflow-007 warn-once hardening of its env getter.
 *
 * Before this file the WHOLE ledger was untested (mutation M1 "cap never
 * applied" and M2 "exhaust never fires" both passed the full suite):
 *
 *   1. getRetryWatchdogMaxWaitMs — the digits-only env parse
 *      (`ci=H.int({min:1,digitsOnly:!0})`). Pins the official fail-open
 *      (`??1/0` → Infinity): '5s'/'10 000'/'abc'/''/'1e3'/'--5' all yield
 *      undefined. dataflow-007 adds ONE observable on top (return values
 *      unchanged): a malformed NON-EMPTY value now logs a one-time
 *      `logForDebugging(..., {level:'warn'})`, deduped per distinct value.
 *
 *   2. Budget-exhaust throw — official @217570880:
 *        `let Eo=(a.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS??1/0)-V.spentMs;
 *         if(Eo<=0)throw m("api_request",
 *           "api_request_capacity_wait_exhausted"),new Zc(nn,y)`
 *      Forced with a tiny cap + consecutive 529s: the SECOND capacity error
 *      throws CannotRetryError with the telemetry fired EXACTLY once.
 *
 *   3. Heartbeat chunk accounting — official
 *        `if(no)V.spentMs+=Cr?Math.min(Io,...):Io`
 *      A budget-clamped wait sleeps in 30s chunks (binary Nlr=30000) and the
 *      chunks accumulate into spentMs until the next capacity error exhausts.
 *
 *   4. Non-capacity retries (watchdogRetryable=false, e.g. transient 5xx)
 *      never touch the budget — both the exhaust check and the spentMs
 *      accumulator are gated by `if (watchdogRetryable)`. This mirrors the
 *      official gate and is pinned here as documented behavior.
 *
 *   5. PINNING-CURRENT-RELAXED-SEMANTICS: the budget ledger is
 *      PER-INVOCATION (`const capacityWait = { spentMs: 0 }` at the top of
 *      each withRetry() call), NOT the official per-model-call shared
 *      ledger (`r.modelCallRetries?.capacityWait`). Two independent
 *      invocations therefore each get a FULL fresh cap budget — a
 *      documented OCC relaxation (see the DEVIATION note at the
 *      capacityWait declaration in withRetry.ts), recorded in the gap
 *      report; this test pins the current shape so any future move to a
 *      shared ledger is a conscious, test-updating change.
 */

// --- mocks: install BEFORE requiring withRetry.js --------------------------
// Passthrough-flag pattern (same as retryWatchdogRetryAfter281.test.ts):
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

// Capture warn-level logForDebugging calls (the dataflow-007 warning path).
// withRetry.ts imports debug via the `src/utils/debug.js` alias; both
// specifiers resolve to the same module, so this mock intercepts it.
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
  getRetryWatchdogMaxWaitMs,
  resetIgnoredRetryWatchdogMaxWaitWarnedForTesting,
} = require('../withRetry.js') as typeof import('../withRetry.js')

// --- env hygiene (same convention as retryWatchdogRetryAfter281) ------------

const ENV_MAX_WAIT = 'CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS'
const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  ENV_MAX_WAIT,
  'CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS',
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
  resetIgnoredRetryWatchdogMaxWaitWarnedForTesting()
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

/** Transient 5xx that is NOT watchdogRetryable (is5xxServerError shape). */
function serverError(status = 500): APIError {
  return apiError(status, '{"type":"api_error","message":"internal"}')
}

function setMaxWait(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_MAX_WAIT]
  else process.env[ENV_MAX_WAIT] = value
}

const warnMessages = (): string[] =>
  debugLogs.filter(l => l.level === 'warn').map(l => l.message)

const exhaustedEvents = (): RecordedEvent[] =>
  events.filter(
    e =>
      e.name === 'api_request' &&
      e.metadata.reason === 'api_request_capacity_wait_exhausted',
  )

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

const HEARTBEAT_MS = 30_000 // binary Nlr=30000

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
 * IMPORTANT: every capacity-error sequence below ends in a success valve —
 * under a mutation that neuters the budget the watchdog retries capacity
 * errors PAST maxRetries (that bypass is the watchdog's job), so the valve
 * bounds the loop and turns the mutation into a clean assertion failure
 * instead of a hang.
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

// --- 1. getRetryWatchdogMaxWaitMs: digits-only fail-open (official `??1/0`) --

describe('getRetryWatchdogMaxWaitMs — valid digits-only integers are honored', () => {
  test('unset env → undefined (official `??1/0` → Infinity budget) and NO warning', () => {
    // Arrange — env hygiene already deleted the var.
    // Act
    const result = getRetryWatchdogMaxWaitMs()
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
      setMaxWait(raw)
      expect(getRetryWatchdogMaxWaitMs()).toBe(expected)
    }
    expect(warnMessages().length).toBe(0)
  })
})

describe('getRetryWatchdogMaxWaitMs — malformed values fail open to undefined (pins current digits-only behavior)', () => {
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
    setMaxWait(raw)
    // Act/Assert — official semantics: anything unusable → undefined →
    // `??1/0` leaves the capacity-wait budget uncapped. Return values are
    // UNCHANGED by the dataflow-007 warning.
    expect(getRetryWatchdogMaxWaitMs()).toBeUndefined()
  })
})

describe('getRetryWatchdogMaxWaitMs — dataflow-007: malformed non-empty values warn once (fail-open preserved)', () => {
  test('a malformed value logs a single warn naming the var and the value, deduped across calls', () => {
    // Arrange
    setMaxWait('5s')
    // Act — three reads (one per model call in production) must not spam.
    getRetryWatchdogMaxWaitMs()
    getRetryWatchdogMaxWaitMs()
    getRetryWatchdogMaxWaitMs()
    // Assert — warn-once per distinct value; fail-open result unchanged.
    const warns = warnMessages()
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain('CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS')
    expect(warns[0]).toContain("'5s'")
  })

  test('distinct malformed values each warn once (Set is keyed per value)', () => {
    // Arrange/Act
    setMaxWait('abc')
    getRetryWatchdogMaxWaitMs()
    setMaxWait('1e3')
    getRetryWatchdogMaxWaitMs()
    setMaxWait('abc')
    getRetryWatchdogMaxWaitMs() // already-warned value → deduped
    // Assert
    const warns = warnMessages()
    expect(warns.length).toBe(2)
    expect(warns.some(m => m.includes("'abc'"))).toBe(true)
    expect(warns.some(m => m.includes("'1e3'"))).toBe(true)
  })

  test('empty string stays SILENT (equivalent to unset — the fix warns on non-empty values only)', () => {
    // Arrange
    setMaxWait('')
    // Act
    const result = getRetryWatchdogMaxWaitMs()
    // Assert
    expect(result).toBeUndefined()
    expect(warnMessages().length).toBe(0)
  })

  test('digits-only below the min (0) also warns — an ignored operator-set value is never silent', () => {
    // Arrange
    setMaxWait('0')
    // Act
    const result = getRetryWatchdogMaxWaitMs()
    // Assert
    expect(result).toBeUndefined()
    expect(warnMessages().length).toBe(1)
    expect(warnMessages()[0]).toContain("'0'")
  })
})

// --- 2. forced budget-exhaust: throw + telemetry exactly once ----------------

describe('CC 2.1.295 item-3 — capacity-wait budget exhaust throws with telemetry (kills mutations M1/M2)', () => {
  test(
    'cap=1ms: the second consecutive 529 throws CannotRetryError and fires api_request_capacity_wait_exhausted EXACTLY once',
    async () => {
      // Arrange — watchdog ON, tiny cap. Call 1: budget=1-0=1>0 → the delay
      // clamps to 1ms, one heartbeat chunk sleeps it, spentMs=1. Call 2:
      // budget=1-1=0 → official `Eo<=0` throw. The n>=3 success valve keeps
      // a neutered-budget mutation bounded (watchdog 529s bypass maxRetries).
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxWait('1')

      // Act
      const result = await run(n => (n <= 2 ? overloadedError() : null), {
        maxRetries: 5,
      })

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.ok).toBe(false)
      expect(result.opCalls).toBe(2)
      // Call 1 slept the budget-clamped 1ms in a single chunk; call 2 threw
      // BEFORE sleeping.
      expect(sleepCalls).toEqual([1])
      expect(result.yields.length).toBe(1)
      const exhausted = exhaustedEvents()
      expect(exhausted.length).toBe(1)
      // The exhaust throw is the ONLY api_request event on this path (no
      // retry_exhausted — the budget gate fires first).
      expect(events.filter(e => e.name === 'api_request').length).toBe(1)
    },
    15000,
  )

  test(
    'a valid cap string takes effect end-to-end: budget clamps the wait, then exhausts (env getter is really wired into the loop)',
    async () => {
      // Arrange — cap='40', backoff for attempt 1 is [500, 625] so the clamp
      // to exactly 40ms proves getRetryWatchdogMaxWaitMs feeds the loop.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxWait('40')

      // Act
      const result = await run(n => (n <= 2 ? overloadedError() : null), {
        maxRetries: 5,
      })

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([40])
      expect(exhaustedEvents().length).toBe(1)
    },
    15000,
  )
})

// --- 3. heartbeat chunk accounting feeds spentMs -----------------------------

describe('CC 2.1.295 item-3 — heartbeat chunk accounting: a budget-clamped wait sleeps in 30s chunks that accumulate into spentMs', () => {
  test(
    'cap=70000 + retry-after 120s: wait clamps to the budget, chunks [30000,30000,10000], keep-alive yields count down, next 529 exhausts',
    async () => {
      // Arrange — retry-after:120 → getRetryDelay floors at 120000ms; the
      // watchdog caps at 6h (no-op); the budget clamps to 70000-0=70000.
      // Chunking: 30000 + 30000 + 10000, each chunk adding to spentMs
      // (`if(no)V.spentMs+=Io` — OCC has no early-wake path so every chunk
      // counts in full). Call 2 sees budget 70000-70000=0 → exhaust throw.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxWait('70000')

      // Act
      const result = await run(
        n =>
          n === 1
            ? overloadedError({ 'retry-after': '120' })
            : n <= 10
              ? overloadedError()
              : null,
        { maxRetries: 5 },
      )

      // Assert — chunk sizes pin BOTH the budget clamp (sum === cap, not
      // 120000) and the 30s heartbeat split.
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([HEARTBEAT_MS, HEARTBEAT_MS, 10_000])
      expect(sum(sleepCalls)).toBe(70_000)
      // Keep-alive yields: one per chunk, retryInMs counting the remaining
      // budget-clamped wait down.
      expect(result.yields.map(y => y.retryInMs)).toEqual([
        70_000, 40_000, 10_000,
      ])
      expect(result.yields.every(y => y.subtype === 'api_error')).toBe(true)
      // 70000 > the 60000ms persistent-wait log threshold → the wait is
      // logged with the CLAMPED delay (capped BEFORE logging, as in 281).
      const waitLog = events.find(
        e => e.name === 'tengu_api_persistent_retry_wait',
      )
      expect(waitLog?.metadata.delayMs).toBe(70_000)
      // spentMs reached the cap across the chunks → call 2 exhausts.
      expect(exhaustedEvents().length).toBe(1)
    },
    15000,
  )
})

// --- 4. non-capacity retries never touch the budget --------------------------

describe('CC 2.1.295 item-3 — non-capacity retries (watchdogRetryable=false) are NOT charged to the budget [documented current semantics]', () => {
  test(
    'transient 5xx under a 1ms cap: full backoff sleeps (never budget-clamped), no capacity telemetry, run still succeeds',
    async () => {
      // Arrange — cap=1 would exhaust on the SECOND capacity error, but 500
      // is not watchdogRetryable (isWatchdogRetryable = 529 || 429), so both
      // the budget check AND the spentMs accumulator (`if (watchdogRetryable)`
      // gates) are skipped entirely — the official gate shape, pinned as
      // documented behavior. Backoff sleeps are the FULL attempt-1/2
      // exponential windows, unclamped by the 1ms cap.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxWait('1')

      // Act
      const result = await run(n => (n <= 2 ? serverError(500) : null), {
        maxRetries: 5,
      })

      // Assert
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(3)
      expect(sleepCalls.length).toBe(2)
      // Attempt-1 window [500,625], attempt-2 window [1000,1250] — both far
      // above the 1ms cap → proves the budget clamp never saw these waits.
      expect(sleepCalls[0]).toBeGreaterThanOrEqual(500)
      expect(sleepCalls[0]).toBeLessThanOrEqual(625)
      expect(sleepCalls[1]).toBeGreaterThanOrEqual(1000)
      expect(sleepCalls[1]).toBeLessThanOrEqual(1250)
      expect(exhaustedEvents().length).toBe(0)
    },
    15000,
  )

  test(
    'a 5xx wait does not consume budget: a LATER 529 still gets the full cap (spentMs untouched by non-capacity sleeps)',
    async () => {
      // Arrange — cap=100. Call 1: 500 sleeps its full backoff (>=500ms,
      // uncharged). Call 2: 529 → budgetRemaining must still be 100-0=100 →
      // the wait clamps to exactly 100ms. Call 3: 529 → budget 0 → exhaust.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxWait('100')

      // Act
      const result = await run(
        n => (n === 1 ? serverError(503) : n <= 3 ? overloadedError() : null),
        { maxRetries: 5 },
      )

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.opCalls).toBe(3)
      expect(sleepCalls.length).toBe(2)
      expect(sleepCalls[0]).toBeGreaterThanOrEqual(500) // 503: unclamped
      expect(sleepCalls[1]).toBe(100) // 529: full fresh budget clamps to 100
      expect(exhaustedEvents().length).toBe(1)
    },
    15000,
  )
})

// --- 5. per-invocation budget scope (RELAXED vs official) --------------------

describe('pinning-current-relaxed-semantics — the capacity-wait budget is PER-INVOCATION, not the official per-model-call shared ledger', () => {
  test(
    'two independent withRetry invocations each get a FULL fresh cap budget (ct-02: `capacityWait={spentMs:0}` resets per call)',
    async () => {
      // Arrange — the official threads `V=r.modelCallRetries?.capacityWait`
      // so ALL withRetry invocations within one model call share spentMs;
      // OCC resets the ledger per invocation (documented DEVIATION at the
      // capacityWait declaration). If the ledger ever became shared, run 2
      // would see spentMs=1 on entry and throw on its FIRST op call with
      // zero sleeps — the per-run assertions below pin that it does not.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      setMaxWait('1')
      const errorForCall = (n: number) => (n <= 2 ? overloadedError() : null)

      // Act — invocation 1 exhausts its budget.
      const run1 = await run(errorForCall, { maxRetries: 5 })
      const run1Sleeps = [...sleepCalls]
      const run1Exhausted = exhaustedEvents().length
      sleepCalls.length = 0
      events.length = 0
      // Act — invocation 2 must get the SAME full budget despite run 1
      // having spent all of it.
      const run2 = await run(errorForCall, { maxRetries: 5 })

      // Assert — run 1.
      expect(run1.threw).toBeInstanceOf(CannotRetryError)
      expect(run1.opCalls).toBe(2)
      expect(run1Sleeps).toEqual([1])
      expect(run1Exhausted).toBe(1)
      // Assert — run 2: fresh budget → identical shape (first call SLEEPS
      // instead of throwing immediately; second call exhausts).
      expect(run2.threw).toBeInstanceOf(CannotRetryError)
      expect(run2.opCalls).toBe(2)
      expect(sleepCalls).toEqual([1])
      expect(exhaustedEvents().length).toBe(1)
    },
    15000,
  )
})
