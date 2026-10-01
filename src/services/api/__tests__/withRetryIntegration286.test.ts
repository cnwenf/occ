import { APIError } from '@anthropic-ai/sdk'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { clearFastModeCooldown } from '../../../utils/fastMode.js'

/**
 * CC 2.1.286 withRetry integration (items A/B/D):
 *
 * - Item A (binary loop-head coercion `if(h.fastMode&&rBt(h.model))h.fastMode=!1`
 *   + branch1 `if(en&&lOe(qt,h.model)&&(r.modelIsRefusalFallbackTarget||SYn(h.model))
 *   {aBo(h.model),h.fastMode=!1,Ln?$t--:0;continue}` @206105122-region):
 *   "Fixed refusal and --fallback-model retries failing when the fallback
 *   model can't run fast; they now run at standard speed."
 * - Item B (binary trigger rewrite `Kn=NJe||LJe, Pn=r.fallbackModel??(Kn&&
 *   Fl==="firstParty"?iOe(r):void 0)` + unconditional telemetry with `reason`
 *   + 4-arg `Tx` @206105122-region): the refusal hop to the ladder's
 *   accessFallbackModel.
 * - Item D (binary loop head `takeApiAttempt`, catch-top `outOfApiAttempts`,
 *   exhausted-block `takeCredentialRenewal` (VMo=2), pre-telemetry
 *   `reportHttpFailure` — dump /tmp/cc-diff-286/w286_ledger.txt): the shared
 *   per-model-call retry ledger (≤14 requests).
 */

process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const ALLOWLIST_PATH = '../../../utils/model/modelAllowlist.js'
let realAllowlist: Record<string, unknown> = {}

beforeAll(async () => {
  realAllowlist = { ...((await import(ALLOWLIST_PATH)) as object) }
  // iOe arm `Hr(e)` — the ladder candidate is allowlist-checked; pin allowed.
  mock.module(ALLOWLIST_PATH, () => ({
    ...realAllowlist,
    isModelAllowed: () => true,
  }))
})

afterAll(() => {
  mock.restore()
})

const { withRetry, CannotRetryError, FallbackTriggeredError } =
  require('../withRetry.js') as typeof import('../withRetry.js')
const { NoApiAttemptsLeftError, createModelCallRetries } =
  require('../modelCallRetries.js') as typeof import('../modelCallRetries.js')
const {
  clearFastRejectedFallbackModels,
  isFastRejectedFallback,
  markFastRejected,
  resetFastRejectionStore,
} = require('../../../utils/model/fastRejection.js') as typeof import('../../../utils/model/fastRejection.js')
const {
  _resetForTesting: resetAnalyticsForTesting,
  attachAnalyticsSink,
} = require('../../analytics/index.js') as typeof import('../../analytics/index.js')

const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_DISABLE_FAST_MODE',
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
  'CLAUDE_CODE_NO_MODEL_FALLBACK',
  'CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK',
  'ANTHROPIC_API_KEY_HELPER',
  'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  resetFastRejectionStore()
  clearFastModeCooldown()
  resetAnalyticsForTesting()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  resetFastRejectionStore()
  clearFastModeCooldown()
  resetAnalyticsForTesting()
})

function apiError(status: number, message = 'err'): APIError {
  return new APIError(status, { message }, message, undefined)
}

/** The exact 400 the API sends when a model can't run fast (binary lOe). */
function speedRejection400(quotedModel: string): APIError {
  const message = `'${quotedModel}' does not support the \`speed\` parameter`
  return new APIError(400, { message }, message, undefined)
}

/** 404 shaped the way isModelNotFoundError (binary NJe) recognizes it. */
function modelNotFound404(model: string): APIError {
  const message = `{"type":"error","error":{"type":"not_found_error","message":"model: ${model} is not available"}}`
  return new APIError(404, { message }, message, undefined)
}

function attachCapturingSink(): Array<{
  eventName: string
  metadata: Record<string, unknown>
}> {
  const events: Array<{
    eventName: string
    metadata: Record<string, unknown>
  }> = []
  attachAnalyticsSink({
    logEvent: (eventName, metadata) => {
      events.push({ eventName, metadata })
    },
    logEventAsync: async (eventName, metadata) => {
      events.push({ eventName, metadata })
    },
  })
  return events
}

type RunResult = {
  ok: boolean
  opCalls: number
  fastModeByAttempt: (boolean | undefined)[]
  threw: unknown
}

/** Drains withRetry; the operation fails `failures` times then succeeds. */
async function run(
  makeError: () => Error,
  opts: {
    failures: number
    maxRetries?: number
    model?: string
    fastMode?: boolean
    extraOptions?: Partial<Parameters<typeof withRetry>[2]>
  },
): Promise<RunResult> {
  let opCalls = 0
  const fastModeByAttempt: (boolean | undefined)[] = []
  const gen = withRetry(
    async () => ({}) as never,
    async (_client, _attempt, context) => {
      opCalls++
      fastModeByAttempt.push(context.fastMode)
      if (opCalls <= opts.failures) {
        throw makeError()
      }
      return { ok: true }
    },
    {
      maxRetries: opts.maxRetries ?? 3,
      model: opts.model ?? 'test-model',
      thinkingConfig: { type: 'disabled' as const },
      ...(opts.fastMode !== undefined && { fastMode: opts.fastMode }),
      ...opts.extraOptions,
    },
  )
  try {
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
    return { ok: true, opCalls, fastModeByAttempt, threw: null }
  } catch (e) {
    return { ok: false, opCalls, fastModeByAttempt, threw: e }
  }
}

function ledgerConfig(overrides: Record<string, unknown> = {}) {
  return {
    maxRetries: 10,
    maxOverloaded: 3,
    hasFallbackModel: false,
    persistent: false,
    background: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Item A — standard-speed fallback for fast-rejected models
// ---------------------------------------------------------------------------
describe('2.1.286 item-A — withRetry integration (binary branch1 + loop-head coercion)', () => {
  test('speed-param 400 on a refusal-fallback target drops to standard speed and retries', async () => {
    // Arrange — attempt 1 fast, rejected; attempt 2 standard speed, succeeds.
    const events = attachCapturingSink()

    // Act
    const result = await run(() => speedRejection400('claude-sonnet-4-5'), {
      failures: 1,
      model: 'claude-sonnet-4-5',
      fastMode: true,
      extraOptions: { modelIsRefusalFallbackTarget: true },
    })

    // Assert — the retry does NOT count against the budget (continue), the
    // family is recorded in the store (aBo), and attempt 2 runs standard.
    expect(result.ok).toBe(true)
    expect(result.opCalls).toBe(2)
    expect(result.fastModeByAttempt).toEqual([true, false])
    expect(isFastRejectedFallback('claude-sonnet-4-5')).toBe(true)
    // No fatal telemetry — the turn recovered.
    expect(
      events.find(e => e.metadata?.reason === 'api_request_retry_exhausted'),
    ).toBeUndefined()
  })

  test('the ever-rejected store arm fires without the refusal-target flag (SYn)', async () => {
    // Arrange — family marked once then cleared from the FALLBACK set: the
    // loop-head coercion (rBt) no longer applies, but SYn keeps branch1 armed.
    markFastRejected('claude-sonnet-4-5')
    clearFastRejectedFallbackModels()
    expect(isFastRejectedFallback('claude-sonnet-4-5')).toBe(false)

    // Act
    const result = await run(() => speedRejection400('claude-sonnet-4-5'), {
      failures: 1,
      model: 'claude-sonnet-4-5',
      fastMode: true,
    })

    // Assert
    expect(result.ok).toBe(true)
    expect(result.opCalls).toBe(2)
    expect(result.fastModeByAttempt).toEqual([true, false])
  })

  test('loop-head coercion: an already-rejected family runs standard from attempt 1 (rBt)', async () => {
    // Arrange
    markFastRejected('claude-opus-5')

    // Act — no failure at all: the FIRST attempt must already be standard.
    const result = await run(() => new Error('unused'), {
      failures: 0,
      model: 'claude-opus-5',
      fastMode: true,
    })

    // Assert
    expect(result.ok).toBe(true)
    expect(result.opCalls).toBe(1)
    expect(result.fastModeByAttempt).toEqual([false])
  })

  test('without the flag or a store entry the speed-param 400 stays fatal', async () => {
    // Act
    const result = await run(() => speedRejection400('claude-sonnet-4-5'), {
      failures: 5,
      model: 'claude-sonnet-4-5',
      fastMode: true,
    })

    // Assert — 400 fails shouldRetry → CannotRetryError on the first attempt.
    expect(result.ok).toBe(false)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
    expect(result.opCalls).toBe(1)
    expect(isFastRejectedFallback('claude-sonnet-4-5')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Item B — refusal hop to the access-fallback (ladder) model
// ---------------------------------------------------------------------------
describe('2.1.286 item-B — withRetry refusal-fallback trigger (binary Kn/Pn/Tx rewrite)', () => {
  test('404 model refusal hops to accessFallbackModel with reason telemetry', async () => {
    // Arrange
    const events = attachCapturingSink()
    const refusal = modelNotFound404('claude-opus-5')

    // Act
    const result = await run(() => refusal, {
      failures: 5,
      model: 'claude-opus-5',
      extraOptions: { accessFallbackModel: 'claude-opus-4-8' },
    })

    // Assert — the v286 4-arg Tx: original model, ladder model, reason,
    // and the ORIGINAL error carried for the caller.
    expect(result.ok).toBe(false)
    expect(result.threw).toBeInstanceOf(FallbackTriggeredError)
    const fallbackError = result.threw as InstanceType<typeof FallbackTriggeredError>
    expect(fallbackError.originalModel).toBe('claude-opus-5')
    expect(fallbackError.fallbackModel).toBe('claude-opus-4-8')
    expect(fallbackError.trigger).toBe('model_not_found')
    expect(fallbackError.originalError).toBe(refusal)
    expect(result.opCalls).toBe(1)
    // v286: telemetry is UNCONDITIONAL and carries `reason`.
    const event = events.find(
      e => e.eventName === 'tengu_api_model_not_found_fallback_triggered',
    )
    expect(event).toBeDefined()
    expect(event?.metadata.original_model).toBe('claude-opus-5')
    expect(event?.metadata.fallback_model).toBe('claude-opus-4-8')
    expect(event?.metadata.reason).toBe('model_not_found')
  })

  test('CLAUDE_CODE_NO_MODEL_FALLBACK kills the ladder hop → CannotRetryError', async () => {
    // Arrange
    process.env.CLAUDE_CODE_NO_MODEL_FALLBACK = '1'

    // Act
    const result = await run(() => modelNotFound404('claude-opus-5'), {
      failures: 5,
      model: 'claude-opus-5',
      extraOptions: { accessFallbackModel: 'claude-opus-4-8' },
    })

    // Assert — 404 is non-retryable and no fallback is resolved (iOe's d9e arm).
    expect(result.ok).toBe(false)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
    expect(result.opCalls).toBe(1)
  })

  test('5xx with an explicit fallbackModel triggers server_error with reason', async () => {
    // Arrange — watchdog OFF (env cleared), so !g3()&&dOe is satisfied.
    const events = attachCapturingSink()

    // Act
    const result = await run(() => apiError(500, 'Internal server error'), {
      failures: 5,
      model: 'claude-opus-5',
      extraOptions: { fallbackModel: ['claude-sonnet-5'] },
    })

    // Assert — the v286 rewrite fixed the OCC quirk where this path logged no
    // event: telemetry now fires with reason 'server_error'.
    expect(result.threw).toBeInstanceOf(FallbackTriggeredError)
    const fallbackError = result.threw as InstanceType<typeof FallbackTriggeredError>
    expect(fallbackError.trigger).toBe('server_error')
    expect(fallbackError.fallbackModel).toBe('claude-sonnet-5')
    const event = events.find(
      e => e.eventName === 'tengu_api_model_not_found_fallback_triggered',
    )
    expect(event?.metadata.reason).toBe('server_error')
  })
})

// ---------------------------------------------------------------------------
// Item D — the shared per-model-call retry ledger
// ---------------------------------------------------------------------------
describe('2.1.286 item-D — withRetry ledger integration (binary FFt wiring)', () => {
  test('dry apiAttemptsLeft: NoApiAttemptsLeftError before any request is sent', async () => {
    // Arrange — the loop-head gate `takeApiAttempt()===!1` (idle-compact shape).
    const ledger = createModelCallRetries(ledgerConfig(), { count: 0 })

    // Act
    const result = await run(() => new Error('unused'), {
      failures: 0,
      extraOptions: { modelCallRetries: ledger },
    })

    // Assert — binary `throw new Fd(new pZ,h)`.
    expect(result.ok).toBe(false)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
    expect(
      (result.threw as InstanceType<typeof CannotRetryError>).originalError,
    ).toBeInstanceOf(NoApiAttemptsLeftError)
    expect(result.opCalls).toBe(0)
  })

  test('{count:1} budget: the first failure is fatal (api_request_attempts_exhausted)', async () => {
    // Arrange
    const events = attachCapturingSink()
    const ledger = createModelCallRetries(ledgerConfig(), { count: 1 })

    // Act
    const result = await run(() => apiError(500), {
      failures: 5,
      extraOptions: { modelCallRetries: ledger },
    })

    // Assert — the catch-top `outOfApiAttempts()` gate: no retry path may
    // consume more requests once the whole-call ledger is dry.
    expect(result.ok).toBe(false)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
    expect(result.opCalls).toBe(1)
    expect(
      events.find(
        e =>
          e.eventName === 'api_request' &&
          e.metadata?.reason === 'api_request_attempts_exhausted',
      ),
    ).toBeDefined()
  })

  test('credential renewal gets exactly VMo=2 attempt rewinds per model call', async () => {
    // Arrange — maxRetries 0 + always-401: without the ledger this throws
    // after 1 call; with it, 1 + 2 renewals = 3 calls, then exhausted.
    const events = attachCapturingSink()
    const ledger = createModelCallRetries(ledgerConfig({ maxRetries: 0 }))

    // Act
    const result = await run(() => apiError(401, 'invalid auth'), {
      failures: 5,
      maxRetries: 0,
      extraOptions: { modelCallRetries: ledger },
    })

    // Assert
    expect(result.ok).toBe(false)
    expect(result.threw).toBeInstanceOf(CannotRetryError)
    expect(result.opCalls).toBe(3)
    expect(
      events.find(
        e =>
          e.eventName === 'api_request' &&
          e.metadata?.reason === 'api_request_retry_exhausted',
      ),
    ).toBeDefined()
  })

  test('the ledger budget spans withRetry invocations (whole-call cap)', async () => {
    // Arrange — leg 1 burns the ledger (maxRetries 1 → 1 retry spent);
    // leg 2 is constructed the way the staged dispatch does
    // (`maxRetries: ledger.retriesLeft()` → 0) and fails after ONE request.
    const ledger = createModelCallRetries(ledgerConfig({ maxRetries: 1 }))

    // Act
    const leg1 = await run(() => apiError(500), {
      failures: 5,
      maxRetries: 1,
      extraOptions: { modelCallRetries: ledger },
    })
    expect(leg1.opCalls).toBe(2) // 1 initial + 1 retry
    expect(ledger.counts().retries).toBe(1)
    expect(ledger.retriesLeft()).toBe(0)

    const leg2 = await run(() => apiError(500), {
      failures: 5,
      maxRetries: ledger.retriesLeft(),
      extraOptions: { modelCallRetries: ledger },
    })

    // Assert — the shared ledger gives leg 2 no budget: 1 request, then fatal.
    expect(leg2.ok).toBe(false)
    expect(leg2.threw).toBeInstanceOf(CannotRetryError)
    expect(leg2.opCalls).toBe(1)
    // Whole call: 3 requests, one ledger.
    expect(leg1.opCalls + leg2.opCalls).toBe(3)
  })
})
