import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

/**
 * CC 2.1.295 PORT #014 — CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: a total
 * wall-clock budget for UNATTENDED retry-mode capacity waits (429/529 under
 * CLAUDE_CODE_RETRY_WATCHDOG). New in v295 (v294 has zero hits for the env
 * var name and for 'api_request_capacity_wait_exhausted').
 *
 * Official mechanism (v295 binary, byte-verified):
 *   - env parse `ci=H.int({min:1,digitsOnly:!0})` @206929253 — positive
 *     integer ≥ 1, digits only; unset/invalid → unlimited (`??1/0`);
 *   - branch head @217570880:
 *       `Eo=(a.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS??1/0)-V.spentMs;
 *        if(Eo<=0)throw m("api_request",
 *          "api_request_capacity_wait_exhausted"),new Zc(nn,y);
 *        ... ir=Math.min(ir,Eo)`
 *     — remaining budget ≤ 0 throws CannotRetryError (Zc) with the
 *     exhausted telemetry INSTEAD of waiting; otherwise the wait is clamped
 *     to the remaining budget;
 *   - ledger `V=r.modelCallRetries?.capacityWait??{spentMs:0}` @217560903 —
 *     shared per model call across withRetry invocations; the ledger factory
 *     ships `capacityWait:{spentMs:0}` @217582858;
 *   - charge `V.spentMs+=` per slept heartbeat chunk.
 *
 * The budget gate applies ONLY to watchdog-retryable errors (429/529) — the
 * official branch sits on the capacity-wait path; a plain 5xx keeps the 281
 * behavior (6h cap + heartbeat chunks, no budget check, no charge).
 */

// --- mocks: install BEFORE requiring withRetry.js --------------------------
// Passthrough-flag pattern (same as retryWatchdogRetryAfter281.test.ts):
// bun's mock.module is process-global, so each mock delegates to the REAL
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

const { withRetry, CannotRetryError, getRetryWatchdogMaxWaitMs } =
  require('../withRetry.js') as typeof import('../withRetry.js')
const { createModelCallRetries } =
  require('../modelCallRetries.js') as typeof import('../modelCallRetries.js')

// --- env hygiene -------------------------------------------------------------

const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS',
  'CLAUDE_CODE_UNATTENDED_RETRY',
  'CLAUDE_CODE_MAX_RETRIES',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_DISABLE_FAST_MODE',
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
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

afterAll(() => {
  sleepMockActive = false
  analyticsMockActive = false
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

function rateLimitError(headers?: Record<string, string>): APIError {
  return apiError(429, 'rate limited', headers)
}

function makeLedger() {
  return createModelCallRetries({
    maxRetries: 10,
    maxOverloaded: 10,
    hasFallbackModel: false,
    persistent: false,
    background: false,
  })
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
  opts: {
    maxRetries: number
    modelCallRetries?: ReturnType<typeof makeLedger>
  },
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
      ...(opts.modelCallRetries
        ? { modelCallRetries: opts.modelCallRetries }
        : {}),
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

// --- env parse: getRetryWatchdogMaxWaitMs ≡ H.int({min:1,digitsOnly:!0}) ----

describe('2.1.295 #014 — CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS env parse (ci=H.int({min:1,digitsOnly:!0}) @206929253)', () => {
  test('unset env returns undefined (budget unlimited via ??1/0)', () => {
    // Arrange — beforeEach deleted the key.
    // Act/Assert
    expect(getRetryWatchdogMaxWaitMs()).toBeUndefined()
  })

  test('"5000" parses to 5000', () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '5000'
    expect(getRetryWatchdogMaxWaitMs()).toBe(5000)
  })

  test('"1" parses to 1 (min:1 boundary)', () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '1'
    expect(getRetryWatchdogMaxWaitMs()).toBe(1)
  })

  test('"0" returns undefined (below min:1)', () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '0'
    expect(getRetryWatchdogMaxWaitMs()).toBeUndefined()
  })

  test('"-5000" returns undefined (below min:1)', () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '-5000'
    expect(getRetryWatchdogMaxWaitMs()).toBeUndefined()
  })

  test('"soon" returns undefined (not digitsOnly)', () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = 'soon'
    expect(getRetryWatchdogMaxWaitMs()).toBeUndefined()
  })

  test('digitsOnly rejects exponents, underscores, separators and decimals', () => {
    for (const raw of ['1e6', '64_000', '1,000', '1500.5']) {
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = raw
      expect(getRetryWatchdogMaxWaitMs()).toBeUndefined()
    }
  })
})

// --- behavior: budget clamp / exhausted throw / ledger sharing ---------------

describe('2.1.295 #014 — capacity-wait budget on the watchdog retry path (@217570880)', () => {
  test(
    'clamps a 429 wait to the remaining budget and charges the slept ms to the ledger',
    async () => {
      // Arrange — watchdog ON, budget 100ms; 429 with retry-after:120 (120s)
      // would otherwise sleep 120000ms.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '100'
      const ledger = makeLedger()

      // Act
      const result = await run(
        n => (n === 1 ? rateLimitError({ 'retry-after': '120' }) : null),
        { maxRetries: 5, modelCallRetries: ledger },
      )

      // Assert — clamped to 100ms, visibly (yield carries the clamped wait),
      // slept once, and charged to the shared ledger.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([100])
      expect(result.yields[0]?.retryInMs).toBe(100)
      expect(ledger.capacityWait.spentMs).toBe(100)
    },
    15000,
  )

  test(
    'dry ledger (spentMs == budget) throws CannotRetryError with api_request_capacity_wait_exhausted, without sleeping or logging tengu_api_retry',
    async () => {
      // Arrange — budget 100, ledger already spent 100 → Eo=0 → throw.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '100'
      const ledger = makeLedger()
      ledger.capacityWait.spentMs = 100

      // Act
      const result = await run(() => rateLimitError({ 'retry-after': '120' }), {
        maxRetries: 5,
        modelCallRetries: ledger,
      })

      // Assert — official `if(Eo<=0)throw m("api_request",
      // "api_request_capacity_wait_exhausted"),new Zc(nn,y)`: the throw
      // happens BEFORE the tengu_api_retry telemetry and before any sleep.
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.ok).toBe(false)
      expect(result.opCalls).toBe(1)
      expect(sleepCalls.length).toBe(0)
      expect(
        events.find(
          e =>
            e.name === 'api_request' &&
            e.metadata.reason === 'api_request_capacity_wait_exhausted',
        ),
      ).toBeDefined()
      expect(events.find(e => e.name === 'tengu_api_retry')).toBeUndefined()
    },
    15000,
  )

  test(
    'overshot ledger (spentMs > budget) also throws the exhausted error',
    async () => {
      // Arrange — budget 100, ledger spent 150 → Eo=-50 → throw.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '100'
      const ledger = makeLedger()
      ledger.capacityWait.spentMs = 150

      // Act
      const result = await run(() => rateLimitError({ 'retry-after': '1' }), {
        maxRetries: 5,
        modelCallRetries: ledger,
      })

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(sleepCalls.length).toBe(0)
      expect(
        events.find(
          e =>
            e.name === 'api_request' &&
            e.metadata.reason === 'api_request_capacity_wait_exhausted',
        ),
      ).toBeDefined()
    },
    15000,
  )

  test(
    'budget is shared across withRetry invocations of one model call via the ledger',
    async () => {
      // Arrange — budget 150; first invocation waits the full budget (429
      // retry-after:120 clamped to 150), second invocation finds Eo=0.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '150'
      const ledger = makeLedger()

      // Act — first model call succeeds after one clamped wait.
      const first = await run(
        n => (n === 1 ? rateLimitError({ 'retry-after': '120' }) : null),
        { maxRetries: 5, modelCallRetries: ledger },
      )
      // Second invocation (e.g. the next withRetry of the same model call).
      const second = await run(() => rateLimitError({ 'retry-after': '1' }), {
        maxRetries: 5,
        modelCallRetries: ledger,
      })

      // Assert
      expect(first.ok).toBe(true)
      expect(ledger.capacityWait.spentMs).toBe(150)
      expect(second.threw).toBeInstanceOf(CannotRetryError)
      expect(
        events.find(
          e =>
            e.name === 'api_request' &&
            e.metadata.reason === 'api_request_capacity_wait_exhausted',
        ),
      ).toBeDefined()
    },
    15000,
  )

  test(
    'unset env leaves the budget unlimited even with a huge spentMs ledger',
    async () => {
      // Arrange — no MAX_WAIT env (??1/0 → Infinity); ledger spent
      // MAX_SAFE_INTEGER. Eo=Infinity>0 → wait proceeds unclamped.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      const ledger = makeLedger()
      ledger.capacityWait.spentMs = Number.MAX_SAFE_INTEGER

      // Act — 429 retry-after:1 → 1000ms delay.
      const result = await run(
        n => (n === 1 ? rateLimitError({ 'retry-after': '1' }) : null),
        { maxRetries: 5, modelCallRetries: ledger },
      )

      // Assert
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(sleepCalls).toEqual([1000])
      expect(ledger.capacityWait.spentMs).toBe(
        Number.MAX_SAFE_INTEGER + 1000,
      )
    },
    15000,
  )

  test(
    'a 500 under the watchdog skips the budget check and does not charge the ledger',
    async () => {
      // Arrange — watchdog ON, budget 100 (would clamp a capacity wait), but
      // the error is a plain 500 — NOT watchdog-retryable, so the official
      // capacity-wait branch does not apply (281 behavior: 6h cap only).
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '100'
      const ledger = makeLedger()

      // Act — 500 retry-after:1 → 1000ms delay, unclamped.
      const result = await run(
        n =>
          n === 1
            ? apiError(500, 'server error', { 'retry-after': '1' })
            : null,
        { maxRetries: 5, modelCallRetries: ledger },
      )

      // Assert
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(sleepCalls).toEqual([1000])
      expect(ledger.capacityWait.spentMs).toBe(0)
    },
    15000,
  )

  test(
    'watchdog OFF ignores the budget entirely (no clamp, no charge, no exhausted throw)',
    async () => {
      // Arrange — budget 100 but watchdog OFF: the capacity-wait branch is
      // watchdog-scoped, so a 429 retry-after:5 sleeps the full 5000ms.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '100'
      const ledger = makeLedger()

      // Act
      const result = await run(
        n => (n === 1 ? rateLimitError({ 'retry-after': '5' }) : null),
        { maxRetries: 5, modelCallRetries: ledger },
      )

      // Assert
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(sleepCalls).toEqual([5000])
      expect(ledger.capacityWait.spentMs).toBe(0)
    },
    15000,
  )
})

// --- ledger factory ----------------------------------------------------------

describe('2.1.295 #014 — createModelCallRetries ships the capacityWait ledger (@217582858)', () => {
  test('a fresh ledger starts with capacityWait {spentMs: 0}', () => {
    // Arrange/Act
    const ledger = makeLedger()

    // Assert
    expect(ledger.capacityWait).toEqual({ spentMs: 0 })
  })
})
