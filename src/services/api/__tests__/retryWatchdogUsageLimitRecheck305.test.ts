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
  spyOn,
  test,
} from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { clearFastModeCooldown } from '../../../utils/fastMode.js'

/**
 * CC 2.1.305 (research-api.md item 3) — CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS:
 * while waiting out a usage-limit rejection, the watchdog periodically asks
 * `isUsageLimitLifted(429Error)` whether the limit already lifted, and breaks
 * the wait early when it did (or when a retry-wake fires during the probe).
 *
 * Byte evidence (2.1.306 linux-x64 ELF, /tmp/forensic305/v306/claude):
 *
 *   1. Env descriptor @238022068: `cx=H.int({min:60000,max:10800000,
 *      digitsOnly:!0})` (1min–3h); export map @237991422
 *      `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS:()=>cx`.
 *
 *   2. Wait-loop setup @249463400 (verbatim):
 *        `let Gr=Vo?M_o:ns,qr=co&&!Vo,fs=ps&&r.isUsageLimitLifted?
 *          a.CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS:void 0;
 *         if(ps&&Se)Q++,Se=!1;
 *         let Lo=fs===void 0?1/0:0,Ur=0,us=ns;
 *         while(us>0){
 *           if(fs!==void 0&&Lo<=0)Lo=xN(1+Q,null,TQe/2,r.random,fs);
 *           ...
 *           if(us-=sr,Lo-=sr,Lo<=0&&us>Gr&&ps&&r.isUsageLimitLifted){
 *             let ji=!1,Ga=r.subscribeRetryWake?.(()=>{ji=!0}),
 *               Fa=h.monotonicNow(),cs=!1;
 *             try{cs=await r.isUsageLimitLifted(ps)}catch(jo){l(jo)}
 *             finally{Ga?.()}
 *             if(Se=cs,cs||ji)break;
 *             Ur=Math.max(0,Math.round(h.monotonicNow()-Fa))}}`
 *      ps = the 429 error object itself (`ps=on` @249462443), Q/Se are
 *      generator-level (@249451413), M_o=30000 / TQe=21600000 (@249448960).
 *
 *   3. Wake-able sleep Tmn (same extract): absent subscribeRetryWake →
 *      plain abortError sleep returning false; present → an internal
 *      AbortController races the caller signal, the sleep RESOLVES on a
 *      wake-abort (no abortError on that call), then the caller-abort
 *      re-check throws, else the woken flag returns.
 *
 * STAGED-dependency semantics: OCC ships NO caller wiring
 * isUsageLimitLifted/subscribeRetryWake yet, so in production fs=void 0 →
 * Lo=1/0 → the probe branch is unreachable and the 2.1.301 watchdog
 * behavior is unchanged (pinned by the absent-deps test below).
 *
 * Covered below:
 *   - getRetryWatchdogUsageLimitRecheckMs digits-only [60000,10800000]
 *     fail-open + warn-once (sibling-getter conventions);
 *   - absent-deps no-op (env set but no isUsageLimitLifted → 301 behavior);
 *   - recheck scheduling math (Lo=xN(1+Q,null,TQe/2,random,fs), probe gated
 *     `Lo<=0 && us>Gr`);
 *   - early-lift break + Q++/Se=!1 round backoff across waits;
 *   - probe throw → logError, wait continues;
 *   - wake during sleep (Tmn woken break) and wake during probe (ji flag);
 *   - Ur probe-duration credit against the next chunk;
 *   - wake-aware charging (ji=Math.min(sr,Vs+elapsed)) feeding spentMs and
 *     the MAX_WAIT capacity gate.
 */

// --- mocks: install BEFORE requiring withRetry.js --------------------------
// Passthrough-flag pattern (same as retryWatchdogUsageLimit301.test.ts):
// bun's mock.module is process-global; each mock delegates to the REAL
// implementation once its flag flips off in afterAll.

const actualSleepModule = { ...require('../../../utils/sleep.js') } as typeof import('../../../utils/sleep.js')
let sleepMockActive = true
const sleepCalls: number[] = []
/** Optional per-test hook run inside the mocked sleep (e.g. clock advance). */
let onSleep: ((ms: number) => void) | undefined
mock.module('../../../utils/sleep.js', () => ({
  ...actualSleepModule,
  sleep: async (ms: number, signal?: AbortSignal) => {
    if (!sleepMockActive) return actualSleepModule.sleep(ms, signal)
    sleepCalls.push(ms)
    onSleep?.(ms)
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

// Capture logError calls (the probe `catch(jo){l(jo)}` path).
const actualLog = { ...require('../../../utils/log.js') } as typeof import('../../../utils/log.js')
let logMockActive = true
const loggedErrors: unknown[] = []
mock.module('../../../utils/log.js', () => ({
  ...actualLog,
  logError: (error: unknown) => {
    if (!logMockActive) return actualLog.logError(error)
    loggedErrors.push(error)
  },
}))

const {
  withRetry,
  CannotRetryError,
  getRetryWatchdogUsageLimitRecheckMs,
  resetIgnoredRetryWatchdogUsageLimitRecheckWarnedForTesting,
} = require('../withRetry.js') as typeof import('../withRetry.js')

// --- env hygiene (same convention as retryWatchdogUsageLimit301) ------------

const ENV_RECHECK = 'CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS'
const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS',
  'CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS',
  ENV_RECHECK,
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
  loggedErrors.length = 0
  onSleep = undefined
  resetIgnoredRetryWatchdogUsageLimitRecheckWarnedForTesting()
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
  // must see genuine sleep/analytics/debug/log behavior.
  sleepMockActive = false
  analyticsMockActive = false
  debugMockActive = false
  logMockActive = false
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

/**
 * A usage-limit rejection with an UNUSABLE overage and the fetch_error
 * exception (301 harness convention): the wait becomes exactly `budgetMs`
 * (Zn=hr), chunked into 30s heartbeat slices — deterministic recheck math.
 */
function fetchErrorUsageLimitError(): APIError {
  return apiError(429, '{"type":"rate_limit_error"}', {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(
      Math.round((Date.now() + 8 * 60 * 60 * 1000) / 1000),
    ),
    'anthropic-ratelimit-unified-overage-disabled-reason': 'fetch_error',
  })
}

function setRecheckMs(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_RECHECK]
  else process.env[ENV_RECHECK] = value
}

const warnMessages = (): string[] =>
  debugLogs.filter(l => l.level === 'warn').map(l => l.message)

const exhaustedEvents = (): RecordedEvent[] =>
  events.filter(
    e =>
      e.name === 'api_request' &&
      e.metadata.reason === 'api_request_capacity_wait_exhausted',
  )

const HEARTBEAT_MS = 30_000 // binary M_o=30000

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

type RunOpts = {
  maxRetries: number
  isUsageLimitLifted?: (error: APIError) => Promise<boolean>
  subscribeRetryWake?: (onWake: () => void) => () => void
  signal?: AbortSignal
}

/** Drain the withRetry generator (301 harness shape + the new 305 deps). */
async function run(
  errorForCall: (callIndex: number) => Error | null,
  opts: RunOpts,
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
      isUsageLimitLifted: opts.isUsageLimitLifted,
      subscribeRetryWake: opts.subscribeRetryWake,
      signal: opts.signal,
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

/** Zero-jitter backoff: xN(1+Q,null,TQe/2,random=0,fs) → fs*2^Q exactly. */
function pinMathRandomToZero(): { restore: () => void } {
  const spy = spyOn(Math, 'random').mockReturnValue(0)
  return { restore: () => spy.mockRestore() }
}

/** Controllable monotonic clock for monotonicNowMs() (= performance.now()). */
function pinPerformanceNow(startMs = 1_000_000): {
  now: () => number
  advance: (ms: number) => void
  restore: () => void
} {
  let fakeNow = startMs
  const spy = spyOn(performance, 'now').mockImplementation(() => fakeNow)
  return {
    now: () => fakeNow,
    advance: (ms: number) => {
      fakeNow += ms
    },
    restore: () => spy.mockRestore(),
  }
}

/** Watchdog ON + fetch_error usage-limit waits of exactly `budgetMs`. */
function arrangeFetchErrorWaits(budgetMs: number): void {
  process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
  process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS =
    String(budgetMs)
}

// --- 1. getRetryWatchdogUsageLimitRecheckMs: digits-only [60000,10800000] ---

describe('getRetryWatchdogUsageLimitRecheckMs — valid digits-only integers within [60000,10800000] are honored (cx=H.int({min:60000,max:10800000,digitsOnly:!0}))', () => {
  test('unset env → undefined (fs=void 0 → Lo=1/0 → recheck disabled) and NO warning', () => {
    // Arrange — env hygiene already deleted the var.
    // Act
    const result = getRetryWatchdogUsageLimitRecheckMs()
    // Assert
    expect(result).toBeUndefined()
    expect(warnMessages().length).toBe(0)
  })

  test('digits-only integers within range parse to their numeric value, no warning', () => {
    // Arrange/Act/Assert — including both boundaries, leading zeros, an
    // explicit '+', and surrounding whitespace (regex + parseEnvInt trim).
    const cases: [string, number][] = [
      ['60000', 60_000],
      ['10800000', 10_800_000],
      [' 120000 ', 120_000],
      ['+90000', 90_000],
      ['0060001', 60_001],
    ]
    for (const [raw, expected] of cases) {
      setRecheckMs(raw)
      expect(getRetryWatchdogUsageLimitRecheckMs()).toBe(expected)
    }
    expect(warnMessages().length).toBe(0)
  })
})

describe('getRetryWatchdogUsageLimitRecheckMs — malformed or out-of-range values fail open to undefined (recheck stays disabled)', () => {
  test.each([
    ['5s', 'unit suffix'],
    ['1e3', 'scientific notation REJECTED by digitsOnly'],
    ['6_000', 'underscore separator REJECTED by digitsOnly'],
    ['90.5', 'fractional'],
    ['abc', 'non-numeric'],
    ['', 'empty string (equivalent to unset)'],
    ['59999', 'digits-only but below min=60000'],
    ['10800001', 'digits-only but above max=10800000'],
    ['-60000', 'negative, below min'],
  ])('%p → undefined (%s)', (raw: string) => {
    // Arrange
    setRecheckMs(raw)
    // Act/Assert — official semantics: anything unusable → undefined →
    // `fs=void 0` → the recheck probe never runs.
    expect(getRetryWatchdogUsageLimitRecheckMs()).toBeUndefined()
  })
})

describe('getRetryWatchdogUsageLimitRecheckMs — malformed non-empty values warn once (fail-open preserved)', () => {
  test('a malformed value logs a single warn naming the var and the value, deduped across calls', () => {
    // Arrange
    setRecheckMs('5s')
    // Act — three reads must not spam.
    getRetryWatchdogUsageLimitRecheckMs()
    getRetryWatchdogUsageLimitRecheckMs()
    getRetryWatchdogUsageLimitRecheckMs()
    // Assert — warn-once per distinct value; fail-open result unchanged.
    const warns = warnMessages()
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain(ENV_RECHECK)
    expect(warns[0]).toContain("'5s'")
  })

  test('distinct malformed values each warn once (Set is keyed per value)', () => {
    // Arrange/Act
    setRecheckMs('abc')
    getRetryWatchdogUsageLimitRecheckMs()
    setRecheckMs('1e3')
    getRetryWatchdogUsageLimitRecheckMs()
    setRecheckMs('abc')
    getRetryWatchdogUsageLimitRecheckMs() // already-warned value → deduped
    // Assert
    const warns = warnMessages()
    expect(warns.length).toBe(2)
    expect(warns.some(m => m.includes("'abc'"))).toBe(true)
    expect(warns.some(m => m.includes("'1e3'"))).toBe(true)
  })

  test('empty string stays SILENT (equivalent to unset)', () => {
    // Arrange
    setRecheckMs('')
    // Act
    const result = getRetryWatchdogUsageLimitRecheckMs()
    // Assert
    expect(result).toBeUndefined()
    expect(warnMessages().length).toBe(0)
  })

  test('digits-only below the min (59999) also warns — an ignored operator-set value is never silent', () => {
    // Arrange
    setRecheckMs('59999')
    // Act
    const result = getRetryWatchdogUsageLimitRecheckMs()
    // Assert
    expect(result).toBeUndefined()
    expect(warnMessages().length).toBe(1)
    expect(warnMessages()[0]).toContain("'59999'")
  })
})

// --- 2. absent-deps no-op: fs=void 0 → Lo=1/0 → 2.1.301 behavior -----------

describe('CC 2.1.305 — STAGED deps: env set but isUsageLimitLifted ABSENT → fs=void 0, recheck unreachable, 301 behavior byte-identical', () => {
  test(
    'fetch_error budget 70000 with RECHECK env set and no deps: chunks [30000,30000,10000] exactly as the 301 suite pins',
    async () => {
      // Arrange — official `fs=ps&&r.isUsageLimitLifted?...:void 0`: the
      // env alone never enables the probe; the dependency gate comes first.
      arrangeFetchErrorWaits(70_000)
      setRecheckMs('60000')

      // Act — call 1 waits 70000 (fetch_error Zn=hr); call 2 sees hr=0 →
      // api_request_usage_limit_wait_too_long (301 semantics).
      const result = await run(
        n => (n <= 2 ? fetchErrorUsageLimitError() : null),
        { maxRetries: 5 },
      )

      // Assert — identical to retryWatchdogUsageLimit301 test 4: no probe,
      // no extra sleeps, no extra yields.
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([HEARTBEAT_MS, HEARTBEAT_MS, 10_000])
      expect(result.yields.map(y => y.retryInMs)).toEqual([
        70_000, 40_000, 10_000,
      ])
    },
    15000,
  )
})

// --- 3. recheck scheduling math ---------------------------------------------

describe('CC 2.1.305 — recheck scheduling (Lo=xN(1+Q,null,TQe/2,random,fs), probe gated `Lo<=0&&us>Gr`)', () => {
  test(
    'fs=60000, budget 150000: exactly ONE probe after the 2nd chunk; the probe receives the 429 error object itself (ps=on)',
    async () => {
      // Arrange — zero jitter → Lo=60000 exactly. Chunks of 30000: after
      // chunk 1 Lo=30000 (no probe), after chunk 2 Lo=0 and remaining
      // 90000 > Gr=30000 → probe #1. Probe false → next reschedule only at
      // the top of chunk 5's iteration, where remaining hits 0 first.
      arrangeFetchErrorWaits(150_000)
      setRecheckMs('60000')
      const random = pinMathRandomToZero()
      const probeErrors: unknown[] = []

      // Act
      const result = await run(
        n => (n === 1 ? fetchErrorUsageLimitError() : null),
        {
          maxRetries: 5,
          isUsageLimitLifted: async error => {
            probeErrors.push(error)
            return false
          },
        },
      )

      // Assert — full 5-chunk wait, exactly one probe, probe arg IS the
      // usage-limit 429 (official passes `ps`, the error object).
      random.restore()
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
      ])
      expect(probeErrors.length).toBe(1)
      expect(probeErrors[0]).toBeInstanceOf(APIError)
      expect((probeErrors[0] as APIError).status).toBe(429)
    },
    15000,
  )

  test(
    'probe never fires when the remaining wait fits one more slice (official `us>Gr` guard): budget 90000, fs=60000',
    async () => {
      // Arrange — chunks: 30000 (Lo 60000→30000), 30000 (Lo→0, remaining
      // 30000, NOT > Gr=30000 → no probe), 30000 (remaining 0 → exit).
      arrangeFetchErrorWaits(90_000)
      setRecheckMs('60000')
      const random = pinMathRandomToZero()
      let probeCalls = 0

      // Act
      const result = await run(
        n => (n === 1 ? fetchErrorUsageLimitError() : null),
        {
          maxRetries: 5,
          isUsageLimitLifted: async () => {
            probeCalls++
            return false
          },
        },
      )

      // Assert
      random.restore()
      expect(result.ok).toBe(true)
      expect(probeCalls).toBe(0)
      expect(sleepCalls).toEqual([HEARTBEAT_MS, HEARTBEAT_MS, HEARTBEAT_MS])
    },
    15000,
  )
})

// --- 4. early-lift break + Q++/Se round backoff ------------------------------

describe('CC 2.1.305 — lifted probe breaks the wait early; `if(ps&&Se)Q++,Se=!1` doubles the next round interval', () => {
  test(
    'probe → true ends the wait after 2 chunks and retries immediately; second usage-limit wait probes at the DOUBLED interval (Q=1 → Lo=120000)',
    async () => {
      // Arrange — budget 300000 (10 chunks). Wait 1: Q=0 → Lo=60000 →
      // probe after chunk 2 → lifted=true → break (Se=true). Wait 2:
      // `if(ps&&Se)Q++` → Q=1, Se=false → Lo=xN(2,...)=120000 (zero
      // jitter) → probe after chunk 4 → lifted → break. hr accounting:
      // wait 1 charged 60000 → wait 2 budget hr=240000 (8 chunks) — the
      // chunk-4 probe gate (remaining 120000 > 30000) still fires.
      arrangeFetchErrorWaits(300_000)
      setRecheckMs('60000')
      const random = pinMathRandomToZero()
      let probeCalls = 0

      // Act
      const result = await run(
        n => (n <= 2 ? fetchErrorUsageLimitError() : null),
        {
          maxRetries: 5,
          isUsageLimitLifted: async () => {
            probeCalls++
            return true
          },
        },
      )

      // Assert — 2 chunks + 4 chunks, two lifted probes, success on call 3.
      random.restore()
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(3)
      expect(probeCalls).toBe(2)
      expect(sleepCalls).toEqual([
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
      ])
    },
    15000,
  )
})

// --- 5. probe throw → logError, wait continues -------------------------------

describe('CC 2.1.305 — probe rejection is caught and logged (official `catch(jo){l(jo)}`), the wait continues unchanged', () => {
  test(
    'isUsageLimitLifted rejects → logError receives the probe error, all 5 chunks sleep, run succeeds',
    async () => {
      // Arrange
      arrangeFetchErrorWaits(150_000)
      setRecheckMs('60000')
      const random = pinMathRandomToZero()
      const probeFailure = new Error('probe network failure')

      // Act
      const result = await run(
        n => (n === 1 ? fetchErrorUsageLimitError() : null),
        {
          maxRetries: 5,
          isUsageLimitLifted: async () => {
            throw probeFailure
          },
        },
      )

      // Assert — the throw never escapes the loop; Se stays false (no Q++).
      random.restore()
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(loggedErrors).toContain(probeFailure)
      expect(sleepCalls).toEqual([
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
      ])
    },
    15000,
  )
})

// --- 6. wake paths (official Tmn + probe `Ga=r.subscribeRetryWake?.(...)`) ---

describe('CC 2.1.305 — retry-wake during the chunk sleep breaks the wait (Tmn woken flag)', () => {
  test(
    'synchronous wake at subscribe: first chunk breaks, unsubscribe runs, retry happens immediately',
    async () => {
      // Arrange — no recheck env (this path is independent of fs). The wake
      // subscription fires its callback synchronously; Tmn's internal
      // controller aborts and the (mocked) sleep resolves → woken=true.
      arrangeFetchErrorWaits(150_000)
      let unsubscribeCalls = 0

      // Act
      const result = await run(
        n => (n === 1 ? fetchErrorUsageLimitError() : null),
        {
          maxRetries: 5,
          subscribeRetryWake: onWake => {
            onWake()
            return () => {
              unsubscribeCalls++
            }
          },
        },
      )

      // Assert — only the first chunk slept; `if(Qs)break` ended the wait.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([HEARTBEAT_MS])
      expect(unsubscribeCalls).toBe(1)
    },
    15000,
  )

  test(
    'wake fired DURING the recheck probe also breaks (official `if(Se=cs,cs||ji)break` with ji=true, cs=false)',
    async () => {
      // Arrange — the wake callback fires on a 0ms timer; the probe awaits
      // 10ms of real time before returning false → ji=true wins the race.
      arrangeFetchErrorWaits(150_000)
      setRecheckMs('60000')
      const random = pinMathRandomToZero()
      let probeCalls = 0

      // Act
      const result = await run(
        n => (n === 1 ? fetchErrorUsageLimitError() : null),
        {
          maxRetries: 5,
          isUsageLimitLifted: async () => {
            probeCalls++
            await new Promise(resolve => setTimeout(resolve, 10))
            return false
          },
          subscribeRetryWake: onWake => {
            const timer = setTimeout(onWake, 0)
            return () => clearTimeout(timer)
          },
        },
      )

      // Assert — the wait ended at the probe (2 chunks), NOT via lifted.
      random.restore()
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(probeCalls).toBe(1)
      expect(sleepCalls).toEqual([HEARTBEAT_MS, HEARTBEAT_MS])
    },
    15000,
  )
})

// --- 7. Ur probe-duration credit ---------------------------------------------

describe('CC 2.1.305 — probe wall time credits the next chunk sleep (Ur=Math.max(0,round(monotonicNow()-Fa)))', () => {
  test(
    'a 5000ms probe makes the next chunk sleep 25000 instead of 30000 (Vs=Math.min(sr,Ur))',
    async () => {
      // Arrange — pinned monotonic clock; the probe advances it by 5000.
      // Chunk 3 sleeps sr-Vs = 30000-5000 = 25000. Chunks still DECREMENT
      // `remaining` by the full sr (official `us-=sr`), so the wait keeps
      // its 5-chunk / 150000 total shape.
      arrangeFetchErrorWaits(150_000)
      setRecheckMs('60000')
      const random = pinMathRandomToZero()
      const clock = pinPerformanceNow()

      // Act
      const result = await run(
        n => (n === 1 ? fetchErrorUsageLimitError() : null),
        {
          maxRetries: 5,
          isUsageLimitLifted: async () => {
            clock.advance(5_000)
            return false
          },
        },
      )

      // Assert
      random.restore()
      clock.restore()
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([
        HEARTBEAT_MS,
        HEARTBEAT_MS,
        25_000,
        HEARTBEAT_MS,
        HEARTBEAT_MS,
      ])
    },
    15000,
  )
})

// --- 8. wake-aware charging (official ji=Math.min(sr,Vs+elapsed)) ------------

describe('CC 2.1.305 — early wake charges only elapsed time to the capacity ledger', () => {
  test(
    'wake 4000ms into a 10000ms chunk charges 4000 (not the full chunk): the 10000ms MAX_WAIT budget survives into a second wait instead of exhausting',
    async () => {
      // Arrange — pinned clock; the mocked sleep advances it 4000 (the wake
      // lands 4s into the chunk). Charge = min(sr, Vs+elapsed) =
      // min(10000, 0+4000) = 4000.
      // Attempt 1: Ys=10000 → Zn=hr=150000 clamped by `ns=Math.min(ns,Ys)`
      // → delayMs=10000 (single chunk) → wake break, spentMs=4000.
      // Attempt 2: Ys=10000-4000=6000 > 0 (a FULL-chunk charge would give
      // Ys=0 → capacity_wait_exhausted — this contrast is what pins the
      // wake-aware math) → delayMs=min(hr,Ys)=6000 → wake break again,
      // spentMs=8000. Call 3 succeeds.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '10000'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS =
        '150000'
      const clock = pinPerformanceNow()
      onSleep = () => clock.advance(4_000)

      // Act
      const result = await run(
        n => (n <= 2 ? fetchErrorUsageLimitError() : null),
        {
          maxRetries: 5,
          subscribeRetryWake: onWake => {
            onWake()
            return () => {}
          },
        },
      )

      // Assert — both waits broke on the wake after their (budget-clamped)
      // single chunk; no exhaustion; success on call 3.
      clock.restore()
      onSleep = undefined
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(3)
      expect(sleepCalls).toEqual([10_000, 6_000])
      expect(exhaustedEvents().length).toBe(0)
    },
    15000,
  )

  test(
    'a FULL-elapsed wake charge (20000 of a 30000ms chunk) still feeds spentMs: the next attempt exhausts a 10000ms MAX_WAIT budget (Ys<=0 gate)',
    async () => {
      // Arrange — no MAX_WAIT clamp on attempt 1's delay this time: the
      // usage budget (150000) yields the full 30000ms first chunk; the
      // mocked sleep advances the clock 20000 → charge min(30000,20000).
      // Attempt 2: Ys = 10000 - 20000 <= 0 → capacity_wait_exhausted
      // (official gate order: the Mr check precedes the 429 block).
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '10000'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS =
        '150000'
      const clock = pinPerformanceNow()
      onSleep = () => clock.advance(20_000)

      // Act
      const result = await run(
        n => (n <= 2 ? fetchErrorUsageLimitError() : null),
        {
          maxRetries: 5,
          subscribeRetryWake: onWake => {
            onWake()
            return () => {}
          },
        },
      )

      // Assert — attempt 1's delay is ALSO clamped to Ys=10000 (single
      // 10000ms chunk, charge min(10000, 20000)=10000); attempt 2 exhausts.
      clock.restore()
      onSleep = undefined
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([10_000])
      expect(exhaustedEvents().length).toBe(1)
    },
    15000,
  )
})
