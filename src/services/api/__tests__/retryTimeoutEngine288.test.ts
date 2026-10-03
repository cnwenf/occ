import { APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk'
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.288 (#8 + #34, one coupled retry-engine rework; transitively #36).
 *
 * #8 changelog: "Fixed mid-response API timeouts failing the turn:
 * non-interactive sessions and subagents now continue from the partial
 * response, and thinking-only responses are retried."
 * #34 changelog: "Fixed unattended sessions (CLAUDE_CODE_RETRY_WATCHDOG)
 * retrying for hours after a very long response stream failed; Claude Code now
 * streams again, and gives up after three timeouts."
 *
 * Byte-verified v288 evidence (official linux-x64 ELF, `dd`+`grep -aobF` only —
 * the binary was never executed):
 *
 * 1. Widened stream-failure server-error builder `Hf` @209389300 region
 *    (v287 `bm` @208138418 region had `api_error` only):
 *      v287: `bm=TB($s)||wLe($s)||$s instanceof xt&&$s.type==="api_error"`
 *      v288: `Hf=GB(Ys)||S$e(Ys)||Ys instanceof xt&&(Ys.type==="api_error"||Ys.type==="timeout_error")`
 *    with `GB(e){if(!(e instanceof xt))return!1;return e.status===529||
 *    (e.message?.includes('"type":"overloaded_error"')??!1)}` @201586077
 *    (= v287 `TB` @200866741, = OCC `is529Error`) and
 *    `S$e(e){return e instanceof xt&&e.status!==void 0&&e.status>=500&&
 *    e.status<600&&e.status!==529}` @209263220 (= OCC `is5xxServerError`).
 *
 * 2. `timedOut` stream-fail cause, classifier `xWo` @209272473:
 *      `if(e.isServerError)return e.error instanceof xt&&e.error.type==="timeout_error"?"timedOut":"serverError"`
 *
 * 3. Decision engine `TWo` @209267xxx (v287 `VLo`), thinking-only arm:
 *      `case"serverError":case"timedOut":if(r)return w;
 *       if(h.hasFallbackModel&&!h.persistent)return{decision:"useFallbackModel",counts:g};
 *       return rH("afterThinkingOnly",e==="timedOut"?1:2,g,h,w)`
 *    and full-output tail:
 *      `case"serverError":return s&&!r&&n!=="partialOutput"?rH("afterThinkingOnly",2,g,h,H):H;
 *       case"timedOut":case"malformed":case"badRequest":case"unknown":return H`
 *    (`s` = outlastedNonStreamingTimeout, `r` = stopReasonReceived,
 *     `n` = progress, `w` = fail, `H` = the non-streaming outcome).
 *
 * 4. Classified-failure field, builder `Uzt` @209272254 + call site @209391338:
 *      `{kind:"streamFailed",cause:r,progress:n,stopReasonReceived:e.stopReasonReceived,
 *        outlastedNonStreamingTimeout:e.outlastedNonStreamingTimeout}`
 *      `outlastedNonStreamingTimeout:he.monotonicNow()-Ih>=nqt()`
 *
 * 5. Watchdog retry cap @209253534 (v287 @208138418) — `!C6()` REMOVED:
 *      v287: `let Qt,nn=a.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES;
 *             if(nn!==void 0&&r.nonStreamingTimeoutMs!==void 0&&Yt instanceof AA&&
 *                Date.now()-Xt>=r.nonStreamingTimeoutMs*tLo&&!C6()){...}`
 *      v288: `let an,fn=a.CLAUDE_CODE_NON_STREAMING_TIMEOUT_RETRIES??
 *                (dY()&&r.failedStreamOutlastedTimeout?Vjo:void 0);
 *             if(fn!==void 0&&r.nonStreamingTimeoutMs!==void 0&&rn instanceof UA&&
 *                g.now()-Wt>=r.nonStreamingTimeoutMs*Wjo){
 *               if(V>=fn)throw m("api_request","api_request_nonstreaming_timeout_exhausted"),
 *                 new sc(rn,h);
 *               V++,an=fn-V}`
 *    `function C6(){return a.CLAUDE_CODE_RETRY_WATCHDOG}` @208132898 (v287) =
 *    `function dY(){return a.CLAUDE_CODE_RETRY_WATCHDOG}` @209248012 (v288);
 *    `Wjo=0.9,Vjo=2` @209247927. NOTE: the env var spelling is
 *    `CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES` in BOTH versions (byte-checked
 *    at both offsets; `strings` shows 4 hits each, 0 for a `NON_STREAMING`
 *    spelling) — the gap-research doc's `NON_STREAMING` spelling is a
 *    transcription artifact, the bytes win.
 *
 * 6. Producer threading (STAGED — lives in claude.ts, not this port's files):
 *    `yield*_9e({...},Hf&&(uu?.outlastedNonStreamingTimeout??!1))` @209400922 →
 *    `failedStreamOutlastedTimeout:n.failedStreamOutlastedTimeout` @209284691.
 */

const GROWTHBOOK_PATH = '../../analytics/growthbook.js'
const realGrowthbook = await import(GROWTHBOOK_PATH)
mock.module(GROWTHBOOK_PATH, () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: <T,>(_key: string, defaultValue: T): T =>
    defaultValue,
}))

afterAll(() => {
  mock.restore()
})

const {
  MAX_OVERLOADED_PER_MODEL_CALL,
  classifyServerErrorStreamCause,
  decideAttempt,
  initialAttemptCounts,
  isAPIErrorBodyType,
} = require('../modelCallRetries.js') as typeof import('../modelCallRetries.js')
const { withRetry, CannotRetryError, isStreamFailureServerError } =
  require('../withRetry.js') as typeof import('../withRetry.js')

const ENV_KEYS = [
  'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES',
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_MAX_RETRIES',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'API_TIMEOUT_MS',
  'USER_TYPE',
  'FALLBACK_FOR_ALL_PRIMARY_MODELS',
  'IS_SANDBOX',
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

/** An APIError whose parsed body carries `error.type` (Anthropic's wire shape). */
function bodyTypeError(
  status: number | undefined,
  type: string,
  message = 'boom',
): APIError {
  return new APIError(
    status,
    { type: 'error', error: { type, message } } as never,
    message,
    undefined,
  )
}

/** A streamFailed ClassifiedFailure with every v288 field explicit. */
function streamFailed(
  fields: Partial<{
    cause: string
    progress: string
    stopReasonReceived: boolean
    outlastedNonStreamingTimeout: boolean
  }>,
) {
  return {
    kind: 'streamFailed' as const,
    cause: 'serverError',
    progress: 'started',
    stopReasonReceived: false,
    outlastedNonStreamingTimeout: false,
    ...fields,
  } as never
}

function defaultConfig(
  overrides: Partial<
    Parameters<typeof import('../modelCallRetries.js').createModelCallRetries>[0]
  > = {},
) {
  return {
    maxRetries: 10,
    maxOverloaded: MAX_OVERLOADED_PER_MODEL_CALL,
    hasFallbackModel: false,
    persistent: false,
    background: false,
    ...overrides,
  }
}

/**
 * Drain withRetry against an operation that always throws a request timeout —
 * the same harness shape as nonstreamingTimeoutRetries285.test.ts, extended
 * with the v288 `failedStreamOutlastedTimeout` option.
 */
async function drainTimeoutRetries(opts: {
  maxRetries: number
  nonStreamingTimeoutMs?: number
  failedStreamOutlastedTimeout?: boolean
  failWith?: () => Error
}): Promise<{ attempts: number; threw: unknown }> {
  let attempts = 0
  const failWith = opts.failWith ?? (() => new APIConnectionTimeoutError())
  const gen = withRetry(
    async () => ({}) as never,
    async () => {
      attempts++
      throw failWith()
    },
    {
      maxRetries: opts.maxRetries,
      model: 'test-model',
      thinkingConfig: { type: 'disabled' as const },
      nonStreamingTimeoutMs: opts.nonStreamingTimeoutMs,
      failedStreamOutlastedTimeout: opts.failedStreamOutlastedTimeout,
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

// ---------------------------------------------------------------------------
// #8 — timeout_error joins the server-error builder and splits into `timedOut`
// ---------------------------------------------------------------------------

describe('CC 2.1.288 #8 — body-type read (binary xt.type source)', () => {
  test('reads the official body field: error.error.type', () => {
    expect(isAPIErrorBodyType(bodyTypeError(500, 'timeout_error'), 'timeout_error')).toBe(
      true,
    )
    expect(isAPIErrorBodyType(bodyTypeError(500, 'api_error'), 'api_error')).toBe(true)
    expect(isAPIErrorBodyType(bodyTypeError(500, 'api_error'), 'timeout_error')).toBe(
      false,
    )
  })

  test('a flat body type and an instance .type are both honored', () => {
    const flat = new APIError(
      400,
      { type: 'timeout_error', message: 'boom' } as never,
      'boom',
      undefined,
    )
    expect(isAPIErrorBodyType(flat, 'timeout_error')).toBe(true)
    const withInstanceType = Object.assign(bodyTypeError(500, 'api_error'), {
      type: 'timeout_error',
    })
    expect(isAPIErrorBodyType(withInstanceType, 'timeout_error')).toBe(true)
  })

  test('the message-substring fallback matches (OCC classifier convention)', () => {
    const streamed = new APIError(
      undefined,
      undefined,
      'stream error: {"type":"timeout_error"}',
      undefined,
    )
    expect(isAPIErrorBodyType(streamed, 'timeout_error')).toBe(true)
  })

  test('non-APIError values are never a body type match', () => {
    expect(isAPIErrorBodyType(new Error('{"type":"timeout_error"}'), 'timeout_error')).toBe(
      false,
    )
    expect(isAPIErrorBodyType(undefined, 'timeout_error')).toBe(false)
  })
})

describe('CC 2.1.288 #8 — classifyServerErrorStreamCause (binary xWo arm @209272473)', () => {
  test('timeout_error → timedOut', () => {
    expect(classifyServerErrorStreamCause(bodyTypeError(500, 'timeout_error'))).toBe(
      'timedOut',
    )
  })

  test('api_error / plain 5xx → serverError (v287 behavior preserved)', () => {
    expect(classifyServerErrorStreamCause(bodyTypeError(500, 'api_error'))).toBe(
      'serverError',
    )
    expect(
      classifyServerErrorStreamCause(
        new APIError(503, { message: 'unavailable' } as never, 'unavailable', undefined),
      ),
    ).toBe('serverError')
  })

  test('a non-APIError server failure stays serverError', () => {
    expect(classifyServerErrorStreamCause(new Error('gateway died'))).toBe('serverError')
  })
})

describe('CC 2.1.288 #8 — isStreamFailureServerError (binary Hf @209389300)', () => {
  test('overload (529 / overloaded_error body) is a server error (GB arm)', () => {
    expect(
      isStreamFailureServerError(
        new APIError(529, { message: 'overloaded' } as never, 'overloaded', undefined),
      ),
    ).toBe(true)
    expect(
      isStreamFailureServerError(
        new APIError(
          undefined,
          undefined,
          '{"type":"overloaded_error"}',
          undefined,
        ),
      ),
    ).toBe(true)
  })

  test('5xx other than 529 is a server error (S$e arm)', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(
        isStreamFailureServerError(
          new APIError(status, { message: 'x' } as never, 'x', undefined),
        ),
      ).toBe(true)
    }
  })

  test('NEW in v288: timeout_error is a server error', () => {
    expect(isStreamFailureServerError(bodyTypeError(400, 'timeout_error'))).toBe(true)
    expect(isStreamFailureServerError(bodyTypeError(undefined, 'timeout_error'))).toBe(true)
  })

  test('api_error stays a server error (v287 arm preserved)', () => {
    expect(isStreamFailureServerError(bodyTypeError(500, 'api_error'))).toBe(true)
  })

  test('400/401/404 and non-APIErrors are NOT server errors', () => {
    for (const status of [400, 401, 404, 429]) {
      expect(
        isStreamFailureServerError(
          new APIError(status, { message: 'x' } as never, 'x', undefined),
        ),
      ).toBe(false)
    }
    expect(isStreamFailureServerError(new Error('nope'))).toBe(false)
    expect(isStreamFailureServerError(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// #8 — decision engine arms (binary TWo)
// ---------------------------------------------------------------------------

describe('CC 2.1.288 #8 — thinkingOnly arm: timedOut retries with cap 1 (serverError keeps 2)', () => {
  test('thinkingOnly + timedOut: one retry, then fail (e==="timedOut"?1:2)', () => {
    const failure = streamFailed({ cause: 'timedOut', progress: 'thinkingOnly' })
    const first = decideAttempt(failure, initialAttemptCounts(), defaultConfig(), false)
    expect(first.decision).toBe('retry')
    expect(first.counts.afterThinkingOnly).toBe(1)
    const second = decideAttempt(failure, first.counts, defaultConfig(), false)
    expect(second.decision).toBe('fail')
    expect(second.counts.afterThinkingOnly).toBe(1)
  })

  test('thinkingOnly + serverError: still two retries, then fail (unchanged)', () => {
    const failure = streamFailed({ cause: 'serverError', progress: 'thinkingOnly' })
    const first = decideAttempt(failure, initialAttemptCounts(), defaultConfig(), false)
    expect(first.decision).toBe('retry')
    const second = decideAttempt(failure, first.counts, defaultConfig(), false)
    expect(second.decision).toBe('retry')
    expect(second.counts.afterThinkingOnly).toBe(2)
    const third = decideAttempt(failure, second.counts, defaultConfig(), false)
    expect(third.decision).toBe('fail')
  })

  test('thinkingOnly + timedOut + stopReasonReceived → fail (w)', () => {
    expect(
      decideAttempt(
        streamFailed({
          cause: 'timedOut',
          progress: 'thinkingOnly',
          stopReasonReceived: true,
        }),
        initialAttemptCounts(),
        defaultConfig(),
        false,
      ).decision,
    ).toBe('fail')
  })

  test('thinkingOnly + timedOut + fallback model and non-persistent → useFallbackModel', () => {
    expect(
      decideAttempt(
        streamFailed({ cause: 'timedOut', progress: 'thinkingOnly' }),
        initialAttemptCounts(),
        defaultConfig({ hasFallbackModel: true }),
        false,
      ).decision,
    ).toBe('useFallbackModel')
  })

  test('thinkingOnly + timedOut + persistent keeps the retry arm (no fallback hop)', () => {
    const outcome = decideAttempt(
      streamFailed({ cause: 'timedOut', progress: 'thinkingOnly' }),
      initialAttemptCounts(),
      defaultConfig({ hasFallbackModel: true, persistent: true }),
      false,
    )
    expect(outcome.decision).toBe('retry')
    expect(outcome.counts.afterThinkingOnly).toBe(1)
  })
})

describe('CC 2.1.288 #34 — full-output tail: serverError + outlastedNonStreamingTimeout streams again', () => {
  test('outlasted=true, no stop reason, progress started → retries WITH streaming (afterThinkingOnly bump)', () => {
    const outcome = decideAttempt(
      streamFailed({
        cause: 'serverError',
        progress: 'started',
        outlastedNonStreamingTimeout: true,
      }),
      initialAttemptCounts(),
      defaultConfig(),
      true,
    )
    // v288 `rH("afterThinkingOnly",2,g,h,H)` → bumpCounterOrFail → retryOrFail:
    // a plain streaming retry, NOT the v287 non-streaming fallback.
    expect(outcome.decision).toBe('retry')
    expect(outcome.counts.afterThinkingOnly).toBe(1)
  })

  test('outlasted=false keeps the v287 non-streaming fallback decision', () => {
    const outcome = decideAttempt(
      streamFailed({ cause: 'serverError', progress: 'started' }),
      initialAttemptCounts(),
      defaultConfig(),
      true,
    )
    expect(outcome.decision).toBe('retryWithoutStreaming')
    expect(outcome.counts.afterThinkingOnly).toBe(0)
    expect(outcome.counts.triedWithoutStreaming).toBe(true)
  })

  test('partialOutput is NOT retried away — it continues from the partial (n!=="partialOutput")', () => {
    const outcome = decideAttempt(
      streamFailed({
        cause: 'serverError',
        progress: 'partialOutput',
        outlastedNonStreamingTimeout: true,
      }),
      initialAttemptCounts(),
      defaultConfig(),
      true,
    )
    expect(outcome.decision).toBe('retryWithoutStreaming')
    expect(outcome.counts.afterThinkingOnly).toBe(0)
  })

  test('stopReasonReceived suppresses the bump (!r)', () => {
    const outcome = decideAttempt(
      streamFailed({
        cause: 'serverError',
        progress: 'started',
        stopReasonReceived: true,
        outlastedNonStreamingTimeout: true,
      }),
      initialAttemptCounts(),
      defaultConfig(),
      true,
    )
    expect(outcome.decision).toBe('retryWithoutStreaming')
    expect(outcome.counts.afterThinkingOnly).toBe(0)
  })

  test('the bump caps at 2, then falls back to the non-streaming outcome (H)', () => {
    const failure = streamFailed({
      cause: 'serverError',
      progress: 'started',
      outlastedNonStreamingTimeout: true,
    })
    const first = decideAttempt(failure, initialAttemptCounts(), defaultConfig(), true)
    expect(first.decision).toBe('retry')
    const second = decideAttempt(failure, first.counts, defaultConfig(), true)
    expect(second.decision).toBe('retry')
    expect(second.counts.afterThinkingOnly).toBe(2)
    const third = decideAttempt(failure, second.counts, defaultConfig(), true)
    expect(third.decision).toBe('retryWithoutStreaming')
  })

  test('timedOut in the tail never bumps — it goes non-streaming (case"timedOut":…return H)', () => {
    const outcome = decideAttempt(
      streamFailed({
        cause: 'timedOut',
        progress: 'started',
        outlastedNonStreamingTimeout: true,
      }),
      initialAttemptCounts(),
      defaultConfig(),
      true,
    )
    expect(outcome.decision).toBe('retryWithoutStreaming')
    expect(outcome.counts.afterThinkingOnly).toBe(0)
  })

  test('real output continues from the partial response: progress output → keepPartial', () => {
    for (const cause of ['timedOut', 'serverError']) {
      expect(
        decideAttempt(
          streamFailed({ cause, progress: 'output' }),
          initialAttemptCounts(),
          defaultConfig(),
          true,
        ).decision,
      ).toBe('keepPartial')
    }
  })

  test('non-streaming disallowed + outlasted serverError → fail (H = fail)', () => {
    expect(
      decideAttempt(
        streamFailed({
          cause: 'serverError',
          progress: 'started',
          outlastedNonStreamingTimeout: true,
        }),
        { ...initialAttemptCounts(), afterThinkingOnly: 2 },
        defaultConfig(),
        false,
      ).decision,
    ).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// #34 — the retry-loop timeout cap (binary fn expression @209253534)
// ---------------------------------------------------------------------------

describe('CC 2.1.288 #34 — watchdog cap: env ?? (dY() && failedStreamOutlastedTimeout ? 2 : undefined)', () => {
  test(
    'watchdog ON + failed stream outlasted the timeout, env unset → gives up after three timeouts (Vjo=2)',
    async () => {
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 5,
        nonStreamingTimeoutMs: 0,
        failedStreamOutlastedTimeout: true,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      // initial + 2 retries = 3 requests, then api_request_nonstreaming_timeout_exhausted
      expect(attempts).toBe(3)
    },
    30000,
  )

  test(
    'watchdog ON but the failed stream did NOT outlast the timeout → no cap, full budget',
    async () => {
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 2,
        nonStreamingTimeoutMs: 0,
        failedStreamOutlastedTimeout: false,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )

  test(
    'watchdog OFF + failedStreamOutlastedTimeout → no cap (dY() is required)',
    async () => {
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 2,
        nonStreamingTimeoutMs: 0,
        failedStreamOutlastedTimeout: true,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )

  test(
    '!C6() REMOVED: watchdog ON no longer suppresses an explicit env cap',
    async () => {
      // v287 had `&&!C6()` in the gate, so with the watchdog on the cap never
      // fired and the loop burned its whole budget. v288 dropped the guard:
      // cap=0 makes the very first qualifying timeout fatal even under the
      // watchdog. This is the #34 regression pin.
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 5,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(1)
    },
    30000,
  )

  test(
    'env override wins over the watchdog default (env=1 → two timeouts total)',
    async () => {
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '1'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 5,
        nonStreamingTimeoutMs: 0,
        failedStreamOutlastedTimeout: true,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(2)
    },
    30000,
  )

  test(
    'a watchdog default cap larger than maxRetries is bounded by the shared budget',
    async () => {
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '5'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 1,
        nonStreamingTimeoutMs: 0,
        failedStreamOutlastedTimeout: true,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(2)
    },
    30000,
  )

  test(
    'the cap only counts genuine timeouts: a fast failure (<90% of the timeout) is not capped (Wjo=0.9)',
    async () => {
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 1,
        nonStreamingTimeoutMs: 100000,
        failedStreamOutlastedTimeout: true,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(2)
    },
    30000,
  )

  test(
    'the cap only matches request timeouts: a 500 keeps the full budget under the watchdog',
    async () => {
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 2,
        nonStreamingTimeoutMs: 0,
        failedStreamOutlastedTimeout: true,
        failWith: () =>
          new APIError(500, { message: 'Internal server error' } as never, 'boom', undefined),
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )

  test(
    'streaming path (no nonStreamingTimeoutMs) is never capped, watchdog or not',
    async () => {
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 2,
        failedStreamOutlastedTimeout: true,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// #36 (STAGED, transitively covered) — abort semantics must not regress
// ---------------------------------------------------------------------------

describe('CC 2.1.288 #36 — abort throws APIUserAbortError before any fallback classification', () => {
  test('an already-aborted signal ends the request instead of hopping models', async () => {
    const { APIUserAbortError } = await import('@anthropic-ai/sdk')
    const controller = new AbortController()
    controller.abort()
    let attempts = 0
    const gen = withRetry(
      async () => ({}) as never,
      async () => {
        attempts++
        return 'never'
      },
      {
        maxRetries: 3,
        model: 'test-model',
        thinkingConfig: { type: 'disabled' as const },
        signal: controller.signal,
        fallbackModel: ['fallback-model'],
        failedStreamOutlastedTimeout: true,
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
    expect(threw).toBeInstanceOf(APIUserAbortError)
    expect(attempts).toBe(0)
  })
})
