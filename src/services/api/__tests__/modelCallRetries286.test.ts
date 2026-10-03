import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { afterAll, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.286 (item-D): shared per-model-call retry ledger — binary `FFt`
 * (byte-verified dump /tmp/cc-diff-286/w286_ledger.txt). One limit covers a
 * whole model call: with default retry settings a failing call sends at most
 * 14 requests = 11 (1 initial + 10 retries) + 1 chain hop with
 * retriesLeft()=0 + 2 credential renewals (VMo).
 *
 * Pins: classifier (YMo), decision engine entry (hOe), the retry increment
 * path (reportHttpFailure), the triedWithoutStreaming restore quirk, the
 * renewal cap (VMo=2), the api-attempt gate, retriesLeft arithmetic, the
 * stream-path decisions (KMo/mOe) and undoLastCount.
 *
 * CC 2.1.288 (#8/#34) note: `streamFailed` is now a 4-field classification —
 * `outlastedNonStreamingTimeout` is REQUIRED (binary `Uzt` always emits it).
 * Every literal below passes `false`, i.e. the v287 behavior, so these v286
 * pins are unchanged by the rework; the v288 deltas (the `timedOut` cause, the
 * thinking-only timedOut arm, the outlasted-streams-again tail) are pinned in
 * retryTimeoutEngine288.test.ts. `KMo` is `TWo` in v288.
 */

const GROWTHBOOK_PATH = '../../analytics/growthbook.js'
const realGrowthbook = await import(GROWTHBOOK_PATH)
mock.module(GROWTHBOOK_PATH, () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: <T,>(_key: string, defaultValue: T): T =>
    defaultValue,
}))

const {
  CREDENTIAL_RENEWALS_PER_MODEL_CALL,
  MAX_OVERLOADED_PER_MODEL_CALL,
  NoApiAttemptsLeftError,
  classifyFailureForLedger,
  createModelCallRetries,
  decideAttempt,
  initialAttemptCounts,
} = require('../modelCallRetries.js') as typeof import('../modelCallRetries.js')

afterAll(() => {
  mock.restore()
})

function apiError(status: number, message = 'err'): APIError {
  return new APIError(status, { message }, message, undefined)
}

/** The staged QueryModel construction defaults (binary @206191201). */
function defaultConfig(overrides: Partial<Parameters<typeof createModelCallRetries>[0]> = {}) {
  return {
    maxRetries: 10,
    maxOverloaded: MAX_OVERLOADED_PER_MODEL_CALL,
    hasFallbackModel: false,
    persistent: false,
    background: false,
    ...overrides,
  }
}

describe('2.1.286 item-D — constants (binary VMo / LK / pZ)', () => {
  test('credential renewals per model call = 2 (VMo)', () => {
    expect(CREDENTIAL_RENEWALS_PER_MODEL_CALL).toBe(2)
  })

  test('max overloaded per model call = 3 (LK)', () => {
    expect(MAX_OVERLOADED_PER_MODEL_CALL).toBe(3)
  })

  test('NoApiAttemptsLeftError carries the exact binary pZ message', () => {
    expect(new NoApiAttemptsLeftError().message).toBe(
      'Not sent: no API attempts left',
    )
  })

  test('initial counts are all zero (LFt)', () => {
    expect(initialAttemptCounts()).toEqual({
      retries: 0,
      overloaded: 0,
      stalls: 0,
      truncations: 0,
      afterThinkingOnly: 0,
      triedWithoutStreaming: false,
    })
  })
})

describe('2.1.286 item-D — classifyFailureForLedger (binary YMo)', () => {
  test('connection error → noResponse', () => {
    expect(
      classifyFailureForLedger(
        new APIConnectionError({ message: 'Connection error.' }),
        false,
      ),
    ).toEqual({ kind: 'noResponse' })
  })

  test('APIError 500 → httpError with fallbackModelCouldHelp passthrough', () => {
    expect(classifyFailureForLedger(apiError(500), true)).toEqual({
      kind: 'httpError',
      status: 500,
      fallbackModelCouldHelp: true,
    })
  })

  test('401/403 are NOT classified (auth has its own renewal path)', () => {
    expect(classifyFailureForLedger(apiError(401), true)).toBeUndefined()
    expect(classifyFailureForLedger(apiError(403), true)).toBeUndefined()
  })

  test('APIError wrapped as a cause is classified', () => {
    const wrapped = new Error('stream blew up', { cause: apiError(529) })
    expect(classifyFailureForLedger(wrapped, false)).toEqual({
      kind: 'httpError',
      status: 529,
      fallbackModelCouldHelp: false,
    })
  })

  test('plain errors are not classified', () => {
    expect(classifyFailureForLedger(new Error('nope'), false)).toBeUndefined()
    expect(classifyFailureForLedger(undefined, false)).toBeUndefined()
  })
})

describe('2.1.286 item-D — decideAttempt (binary hOe)', () => {
  test('noResponse retries and bumps counts.retries (Y0)', () => {
    const outcome = decideAttempt(
      { kind: 'noResponse' },
      initialAttemptCounts(),
      defaultConfig(),
      false,
    )
    expect(outcome.decision).toBe('retry')
    expect(outcome.counts.retries).toBe(1)
  })

  test('httpError 529 counts an overload (mOe)', () => {
    const outcome = decideAttempt(
      { kind: 'httpError', status: 529, fallbackModelCouldHelp: false },
      initialAttemptCounts(),
      defaultConfig(),
      false,
    )
    expect(outcome.decision).toBe('retry')
    expect(outcome.counts.overloaded).toBe(1)
  })

  test('httpError 529 at maxOverloaded with a fallback model → useFallbackModel', () => {
    const counts = { ...initialAttemptCounts(), overloaded: 2 }
    const outcome = decideAttempt(
      { kind: 'httpError', status: 529, fallbackModelCouldHelp: false },
      counts,
      defaultConfig({ hasFallbackModel: true }),
      false,
    )
    expect(outcome.decision).toBe('useFallbackModel')
    expect(outcome.counts.overloaded).toBe(3)
  })

  test('httpError 429 persistent → retry WITHOUT spending budget (qMo arm 2)', () => {
    const outcome = decideAttempt(
      { kind: 'httpError', status: 429, fallbackModelCouldHelp: false },
      initialAttemptCounts(),
      defaultConfig({ persistent: true }),
      false,
    )
    expect(outcome).toEqual({
      decision: 'retry',
      counts: initialAttemptCounts(),
    })
  })

  test('httpError 404 (not yet tried non-streaming) → retryWithoutStreaming (Tse)', () => {
    const outcome = decideAttempt(
      { kind: 'httpError', status: 404, fallbackModelCouldHelp: false },
      initialAttemptCounts(),
      defaultConfig(),
      false,
    )
    expect(outcome.decision).toBe('retryWithoutStreaming')
    expect(outcome.counts.triedWithoutStreaming).toBe(true)
    expect(outcome.counts.retries).toBe(1)
  })

  test('httpError 400 → fail (no retry arm)', () => {
    const outcome = decideAttempt(
      { kind: 'httpError', status: 400, fallbackModelCouldHelp: false },
      initialAttemptCounts(),
      defaultConfig(),
      false,
    )
    expect(outcome.decision).toBe('fail')
  })

  test('budget spent → fallthrough instead of retry (Y0 exhausted)', () => {
    const counts = { ...initialAttemptCounts(), retries: 10 }
    const outcome = decideAttempt(
      { kind: 'noResponse' },
      counts,
      defaultConfig({ maxRetries: 10 }),
      false,
    )
    expect(outcome.decision).toBe('fail')
    expect(outcome.counts.retries).toBe(10)
  })

  test('streamFailed thinkingOnly+serverError caps at NFt=2 then fails', () => {
    const failure = {
      kind: 'streamFailed' as const,
      cause: 'serverError' as const,
      progress: 'thinkingOnly' as const,
      stopReasonReceived: false,
      outlastedNonStreamingTimeout: false,
    }
    const first = decideAttempt(failure, initialAttemptCounts(), defaultConfig(), false)
    expect(first.decision).toBe('retry')
    expect(first.counts.afterThinkingOnly).toBe(1)
    const second = decideAttempt(failure, first.counts, defaultConfig(), false)
    expect(second.decision).toBe('retry')
    expect(second.counts.afterThinkingOnly).toBe(2)
    const third = decideAttempt(failure, second.counts, defaultConfig(), false)
    expect(third.decision).toBe('fail')
  })

  test('streamFailed denied → fail; output progress → keepPartial (KMo)', () => {
    expect(
      decideAttempt(
        {
          kind: 'streamFailed',
          cause: 'denied',
          progress: 'nothing',
          stopReasonReceived: false,
          outlastedNonStreamingTimeout: false,
        },
        initialAttemptCounts(),
        defaultConfig(),
        false,
      ).decision,
    ).toBe('fail')
    expect(
      decideAttempt(
        {
          kind: 'streamFailed',
          cause: 'connectionLost',
          progress: 'output',
          stopReasonReceived: true,
          outlastedNonStreamingTimeout: false,
        },
        initialAttemptCounts(),
        defaultConfig(),
        false,
      ).decision,
    ).toBe('keepPartial')
  })
})

describe('2.1.286 item-D — createModelCallRetries (binary FFt)', () => {
  test('reportHttpFailure on classifiable 500s spends the shared retry budget', () => {
    const ledger = createModelCallRetries(defaultConfig({ maxRetries: 10 }))
    for (let i = 0; i < 10; i++) {
      ledger.reportHttpFailure(apiError(500), 'retry')
    }
    // The whole-call cap: after 10 retries the budget is dry — the 11th
    // request of this withRetry invocation would be its last (1 + 10 = 11).
    expect(ledger.counts().retries).toBe(10)
    expect(ledger.retriesLeft()).toBe(0)
  })

  test('the 14-request arithmetic: 11 + 1 chain hop + 2 renewals', () => {
    // Leg 1: the primary withRetry — 1 initial + maxRetries(10) = 11 requests.
    const primary = createModelCallRetries(defaultConfig({ maxRetries: 10 }))
    for (let i = 0; i < 10; i++) {
      primary.reportHttpFailure(apiError(500), 'retry')
    }
    expect(primary.retriesLeft()).toBe(0)
    // Leg 2: the fallback-model chain hop starts with retriesLeft() = 0
    // (staged dispatch: `maxRetries:l_.retriesLeft()`) — exactly 1 request.
    const hop = createModelCallRetries(
      defaultConfig({ maxRetries: primary.retriesLeft() }),
    )
    expect(hop.retriesLeft()).toBe(0)
    // Leg 3: credential renewals — VMo = 2 attempt rewinds per model call.
    expect(hop.takeCredentialRenewal()).toBe(true)
    expect(hop.takeCredentialRenewal()).toBe(true)
    expect(hop.takeCredentialRenewal()).toBe(false)
    // Total: 11 + 1 + 2 = 14.
    expect(11 + 1 + CREDENTIAL_RENEWALS_PER_MODEL_CALL).toBe(14)
  })

  test('unclassifiable errors take the plain retries+1 increment, clamped', () => {
    const ledger = createModelCallRetries(defaultConfig({ maxRetries: 2 }))
    ledger.reportHttpFailure(new Error('weird'), 'retry')
    ledger.reportHttpFailure(new Error('weird'), 'retry')
    ledger.reportHttpFailure(new Error('weird'), 'retry')
    expect(ledger.counts().retries).toBe(2) // Math.min clamp at maxRetries
  })

  test('binary quirk: reportHttpFailure restores the pre-call triedWithoutStreaming', () => {
    // `let{triedWithoutStreaming:ve}=s,Te=W(...);s={...s,triedWithoutStreaming:ve}`
    // — a 404 through reportHttpFailure bumps retries via Tse but the flag is
    // reset to the pre-call value (byte-faithful).
    const ledger = createModelCallRetries(defaultConfig())
    ledger.reportHttpFailure(apiError(404), 'retry')
    expect(ledger.counts().triedWithoutStreaming).toBe(false)
    expect(ledger.counts().retries).toBe(1)
  })

  test('api-attempt gate: {count:1} allows exactly one request (idle-compact path)', () => {
    const budget = { count: 1 }
    const ledger = createModelCallRetries(defaultConfig(), budget)
    expect(ledger.outOfApiAttempts()).toBe(false)
    expect(ledger.takeApiAttempt()).toBe(true)
    expect(ledger.takeApiAttempt()).toBe(false)
    expect(ledger.outOfApiAttempts()).toBe(true)
  })

  test('no apiAttemptsLeft → unlimited whole-call attempts, never out', () => {
    const ledger = createModelCallRetries(defaultConfig())
    expect(ledger.takeApiAttempt()).toBe(true)
    expect(ledger.takeApiAttempt()).toBe(true)
    expect(ledger.outOfApiAttempts()).toBe(false)
  })

  test('onStreamFailed retries overload, gives up at maxOverloaded, undo rewinds', () => {
    const ledger = createModelCallRetries(
      defaultConfig({ maxRetries: 10, hasFallbackModel: true }),
    )
    const overloaded = {
      kind: 'streamFailed' as const,
      cause: 'overloaded' as const,
      progress: 'started' as const,
      stopReasonReceived: false,
      outlastedNonStreamingTimeout: false,
    }
    expect(ledger.onStreamFailed(overloaded, false)).toBe('retry')
    const afterFirst = ledger.counts()
    expect(afterFirst.overloaded).toBe(1)
    expect(ledger.onStreamFailed(overloaded, false)).toBe('retry')
    expect(ledger.counts().overloaded).toBe(2)
    // Third overload hits maxOverloaded (LK=3 not <) → useFallbackModel, and
    // the ledger latches gave-up (binary `w`).
    expect(ledger.onStreamFailed(overloaded, false)).toBe('useFallbackModel')
    expect(ledger.counts().overloaded).toBe(3)
    // undoLastCount rewinds to the snapshot taken at onStreamFailed entry.
    ledger.undoLastCount()
    expect(ledger.counts().overloaded).toBe(2)
  })

  test('onWithRetryGaveUp on an unclassifiable error → fail', () => {
    const ledger = createModelCallRetries(defaultConfig())
    expect(ledger.onWithRetryGaveUp(new Error('weird'))).toBe('fail')
  })

  test('onWithRetryGaveUp on a 404 → retryWithoutStreaming', () => {
    const ledger = createModelCallRetries(defaultConfig())
    expect(ledger.onWithRetryGaveUp(apiError(404))).toBe('retryWithoutStreaming')
  })

  test('out-of-attempts clamps non-keepPartial decisions to fail (binary H)', () => {
    const ledger = createModelCallRetries(defaultConfig({ maxRetries: 10 }), {
      count: 1,
    })
    ledger.takeApiAttempt() // budget now 0
    expect(
      ledger.onStreamFailed(
        {
          kind: 'streamFailed',
          cause: 'serverError',
          progress: 'started',
          stopReasonReceived: false,
          outlastedNonStreamingTimeout: false,
        },
        true,
      ),
    ).toBe('fail') // would have been retryWithoutStreaming, clamped by H
  })
})
