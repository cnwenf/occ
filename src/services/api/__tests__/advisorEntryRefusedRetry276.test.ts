import { APIError } from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { AdvisorRetryRequestState } from '../advisorRetry.js'
import type { AssistantMessage, UserMessage } from '../../../types/message.js'

/**
 * 2.1.276 advisor hotfix — advisor-entry-refused 400 classifier, retry
 * handler, session latches, and withRetry integration.
 *
 * The 2.1.275 release added the `advisor_20260301` server-tool schema to
 * every agentic request; proxies/gateways behind ANTHROPIC_BASE_URL that do
 * not know the tag reject the request with a 400 ("tools.0.model: Input tag
 * 'advisor_20260301' found using 'type' does not match any tag."), breaking
 * EVERY request. The 2.1.276 hotfix (official `TPe`/`vtt` classifiers, `zHe`
 * retry handler, `Wvt` one-shot latch, `Yqt` org kill-switch, `Qqt`
 * resolution gate) strips the advisor tool and retries once.
 *
 * All strings/regexes below are byte-exact from the v276 binary
 * (/tmp/cc-diff-276/v276/package/claude, JS-source region ~198013377+).
 */

// ---------------------------------------------------------------------------
// GrowthBook mock (OCC-97 discipline: spread the real module, restore after).
// advisor.ts reads `tengu_sage_compass` through
// getFeatureValue_CACHED_MAY_BE_STALE; the mock returns `{enabled: true}` so
// isAdvisorEnabled() is true in the firstParty test environment.
// ---------------------------------------------------------------------------
const GROWTHBOOK_MODULE_PATH = '../../analytics/growthbook.js'
const realGrowthbook = await import(GROWTHBOOK_MODULE_PATH)
mock.module(GROWTHBOOK_MODULE_PATH, () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: <T,>(key: string, defaultValue: T): T =>
    key === 'tengu_sage_compass'
      ? ({ enabled: true } as unknown as T)
      : defaultValue,
}))

const {
  isAdvisorEntryRefusedError,
  isAdvisorOrgWideEntryRefusedError,
} = require('../errorUtils.js') as typeof import('../errorUtils.js')

const {
  _resetAdvisorRefusalStateForTesting,
  isAdvisorEnabled,
  isAdvisorEntryRefused,
  isAdvisorOrgDisabled,
  markAdvisorEntryRefused,
} = require('../../../utils/advisor.js') as typeof import('../../../utils/advisor.js')

const {
  createAdvisorEntryRefusedRetryHandler,
} = require('../advisorRetry.js') as typeof import('../advisorRetry.js')

const {
  withRetry,
  CannotRetryError,
} = require('../withRetry.js') as typeof import('../withRetry.js')

const {
  _resetForTesting: resetAnalyticsForTesting,
  attachAnalyticsSink,
} = require('../../analytics/index.js') as typeof import('../../analytics/index.js')

const { ADVISOR_BETA_HEADER } = require('../../../constants/betas.js') as typeof import('../../../constants/betas.js')

// Byte-exact v276 refusal messages (offsets in the final report).
const ADVISOR_NOT_AVAILABLE_400 =
  'the advisor tool is not available for your account'
const ADVISOR_MODEL_REJECTED_400 =
  'claude-haiku-4-5-20251001 cannot be used as an advisor'
// The 2.1.275 regression message — caught by TPe's `tools\.\d+\.model: `
// branch (no dedicated matcher exists in v276).
const INPUT_TAG_400 =
  "tools.0.model: Input tag 'advisor_20260301' found using 'type' does not match any tag."
const ADVISOR_ORG_REFUSED_400 =
  'the advisor tool is not available for this organization'

function makeApiError(status: number, message: string): APIError {
  return new APIError(status, { message }, message, undefined)
}

// Env vars that would flip isAdvisorEnabled()/provider selection — saved and
// cleared per test, restored after.
const ADVISOR_ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
] as const

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ADVISOR_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  _resetAdvisorRefusalStateForTesting()
  resetAnalyticsForTesting()
})

afterEach(() => {
  for (const key of ADVISOR_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  _resetAdvisorRefusalStateForTesting()
  resetAnalyticsForTesting()
})

afterAll(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. Classifiers — official `TPe` / `vtt`
// ---------------------------------------------------------------------------
describe('2.1.276 advisor hotfix — TPe classifier (isAdvisorEntryRefusedError)', () => {
  test('matches the "advisor tool is not available" 400', () => {
    // Arrange
    const error = makeApiError(400, ADVISOR_NOT_AVAILABLE_400)

    // Act & Assert
    expect(isAdvisorEntryRefusedError(error)).toBe(true)
  })

  test('matches the "cannot be used as an advisor" 400', () => {
    // Arrange
    const error = makeApiError(400, ADVISOR_MODEL_REJECTED_400)

    // Act & Assert
    expect(isAdvisorEntryRefusedError(error)).toBe(true)
  })

  test("matches the 2.1.275 regression Input-tag 400 via the tools.N.model branch", () => {
    // Arrange — the exact proxy/gateway rejection that broke every request
    // in 2.1.275 when ANTHROPIC_BASE_URL pointed at a non-Anthropic gateway.
    const error = makeApiError(400, INPUT_TAG_400)

    // Act & Assert
    expect(isAdvisorEntryRefusedError(error)).toBe(true)
  })

  test('rejects the same message on a 500', () => {
    // Arrange
    const error = makeApiError(500, ADVISOR_NOT_AVAILABLE_400)

    // Act & Assert
    expect(isAdvisorEntryRefusedError(error)).toBe(false)
  })

  test('rejects the same message on a 403', () => {
    // Arrange
    const error = makeApiError(403, INPUT_TAG_400)

    // Act & Assert
    expect(isAdvisorEntryRefusedError(error)).toBe(false)
  })

  test('rejects an unrelated 400', () => {
    // Arrange
    const error = makeApiError(400, 'invalid x-api-key')

    // Act & Assert
    expect(isAdvisorEntryRefusedError(error)).toBe(false)
  })

  test('rejects a non-APIError carrying the same message', () => {
    // Arrange
    const plain = new Error(ADVISOR_NOT_AVAILABLE_400)

    // Act & Assert
    expect(isAdvisorEntryRefusedError(plain)).toBe(false)
    expect(isAdvisorEntryRefusedError({ message: INPUT_TAG_400 })).toBe(false)
    expect(isAdvisorEntryRefusedError(undefined)).toBe(false)
  })
})

describe('2.1.276 advisor hotfix — vtt classifier (isAdvisorOrgWideEntryRefusedError)', () => {
  test('matches the org-wide refusal 400', () => {
    // Arrange
    const error = makeApiError(400, ADVISOR_ORG_REFUSED_400)

    // Act & Assert
    expect(isAdvisorOrgWideEntryRefusedError(error)).toBe(true)
  })

  test('returns false for a plain (non-org) refusal', () => {
    // Arrange
    const error = makeApiError(400, ADVISOR_NOT_AVAILABLE_400)

    // Act & Assert
    expect(isAdvisorOrgWideEntryRefusedError(error)).toBe(false)
  })

  test('returns false for the Input-tag regression shape (not org-scoped)', () => {
    // Arrange
    const error = makeApiError(400, INPUT_TAG_400)

    // Act & Assert
    expect(isAdvisorOrgWideEntryRefusedError(error)).toBe(false)
  })

  test('returns false when the org message arrives on a non-400', () => {
    // Arrange
    const error = makeApiError(500, ADVISOR_ORG_REFUSED_400)

    // Act & Assert
    expect(isAdvisorOrgWideEntryRefusedError(error)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Session latches — official `advisorHeld.refused` + `Vqt`/`Yqt` kill-switch
// ---------------------------------------------------------------------------
describe('2.1.276 advisor hotfix — advisor.ts refusal latches', () => {
  test('advisor is enabled by default in the firstParty test environment', () => {
    // Assert — growthbook mock returns {enabled: true}; no refusal yet.
    expect(isAdvisorEnabled()).toBe(true)
    expect(isAdvisorEntryRefused()).toBe(false)
    expect(isAdvisorOrgDisabled()).toBe(false)
  })

  test('a non-org refusal latches the session flag but keeps isAdvisorEnabled true', () => {
    // Act — official `Ue.advisorHeld={…,refused:!0}` without `Yqt()`.
    markAdvisorEntryRefused(false)

    // Assert — resolution gate (Qqt analog in claude.ts) stops re-adding the
    // schema, but the official keeps `Bb()` true so the beta header survives.
    expect(isAdvisorEntryRefused()).toBe(true)
    expect(isAdvisorOrgDisabled()).toBe(false)
    expect(isAdvisorEnabled()).toBe(true)
  })

  test('an org-wide refusal arms the process-wide kill-switch and disables isAdvisorEnabled', () => {
    // Act — official `if(vtt(hr))Yqt()`.
    markAdvisorEntryRefused(true)

    // Assert
    expect(isAdvisorEntryRefused()).toBe(true)
    expect(isAdvisorOrgDisabled()).toBe(true)
    expect(isAdvisorEnabled()).toBe(false)
  })

  test('CLAUDE_CODE_DISABLE_ADVISOR_TOOL still wins over the latches', () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'

    // Act & Assert
    expect(isAdvisorEnabled()).toBe(false)
    markAdvisorEntryRefused(false)
    expect(isAdvisorEnabled()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Retry handler — official `zHe` + `Wvt` one-shot latch + `Hvt` header strip
// ---------------------------------------------------------------------------

/** Advisor server-tool schema entry as pushed by claude.ts (official `zm`). */
function makeAdvisorToolSchema(): BetaToolUnion {
  return {
    type: 'advisor_20260301',
    name: 'advisor',
    model: 'claude-opus-5',
  } as unknown as BetaToolUnion
}

function makeBashToolSchema(): BetaToolUnion {
  return {
    name: 'Bash',
    input_schema: { type: 'object', properties: {} },
  } as unknown as BetaToolUnion
}

/**
 * Minimal message fixture — stripAdvisorBlocks maps over the array and the
 * handler only counts the setMessages call, so an empty normalized array is
 * a valid `bi` stand-in.
 */
function makeMessages(): (UserMessage | AssistantMessage)[] {
  return []
}

function makeState(overrides?: {
  tools?: BetaToolUnion[]
  betas?: string[]
}): {
  state: AdvisorRetryRequestState
  calls: { setTools: number; setMessages: number; setBetas: number }
  tools: () => BetaToolUnion[]
  betas: () => string[]
} {
  let tools = overrides?.tools ?? [makeBashToolSchema(), makeAdvisorToolSchema()]
  let betas = overrides?.betas ?? ['some-other-beta', ADVISOR_BETA_HEADER]
  const calls = { setTools: 0, setMessages: 0, setBetas: 0 }
  const messages = makeMessages()
  const state = {
    getTools: () => tools,
    setTools: (next: BetaToolUnion[]) => {
      calls.setTools++
      tools = next
    },
    getMessages: () => messages,
    setMessages: () => {
      calls.setMessages++
    },
    getBetas: () => betas,
    setBetas: (next: string[]) => {
      calls.setBetas++
      betas = next
    },
  }
  return { state, calls, tools: () => tools, betas: () => betas }
}

/** Captures logEvent calls through a real attached sink (no mock.module). */
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

describe('2.1.276 advisor hotfix — zHe retry handler (createAdvisorEntryRefusedRetryHandler)', () => {
  test('strips the advisor schema, latches the refusal, and fires telemetry on a plain refusal', () => {
    // Arrange
    const events = attachCapturingSink()
    const { state, calls, tools, betas } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)
    const error = makeApiError(400, INPUT_TAG_400)

    // Act
    const shouldRetry = handler(error)

    // Assert — official `zm=zm.filter((Xo)=>!Co(Xo))`: advisor schema gone,
    // Bash schema untouched.
    expect(shouldRetry).toBe(true)
    expect(calls.setTools).toBe(1)
    expect(tools()).toHaveLength(1)
    expect((tools()[0] as { name?: string }).name).toBe('Bash')
    // Official `bi=ga(kOe(Cz(bi)),"error_recovery")` — messages re-normalized
    // through stripAdvisorBlocks (the `Cz` step).
    expect(calls.setMessages).toBe(1)
    // Session latch set, org kill-switch NOT armed (Input-tag is not org-scoped).
    expect(isAdvisorEntryRefused()).toBe(true)
    expect(isAdvisorOrgDisabled()).toBe(false)
    // Official `Hvt`: `if(!Bb())we=we.filter(…)` — config still enabled after
    // a non-org refusal, so the beta header is KEPT.
    expect(calls.setBetas).toBe(0)
    expect(betas()).toContain(ADVISOR_BETA_HEADER)
    // Telemetry: `i("tengu_advisor_entry_refused_retry",{query_source,organization_wide})`.
    const event = events.find(
      e => e.eventName === 'tengu_advisor_entry_refused_retry',
    )
    expect(event).toBeDefined()
    expect(event?.metadata.query_source).toBe('repl')
    expect(event?.metadata.organization_wide).toBe(false)
  })

  test('org-wide refusal arms the kill-switch so Hvt strips the beta header', () => {
    // Arrange
    const events = attachCapturingSink()
    const { state, betas } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)
    const error = makeApiError(400, ADVISOR_ORG_REFUSED_400)

    // Act
    const shouldRetry = handler(error)

    // Assert — official `if(vtt(hr))Yqt()` disables `Bb()`, so `Hvt` strips
    // `Ewn` from the betas on the retried request.
    expect(shouldRetry).toBe(true)
    expect(isAdvisorOrgDisabled()).toBe(true)
    expect(isAdvisorEnabled()).toBe(false)
    expect(betas()).not.toContain(ADVISOR_BETA_HEADER)
    expect(betas()).toContain('some-other-beta')
    const event = events.find(
      e => e.eventName === 'tengu_advisor_entry_refused_retry',
    )
    expect(event?.metadata.organization_wide).toBe(true)
  })

  test('is one-shot — a second advisor refusal on the same request returns false (official Wvt)', () => {
    // Arrange
    const { state, calls } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act
    const first = handler(makeApiError(400, INPUT_TAG_400))
    const setToolsAfterFirst = calls.setTools
    const second = handler(makeApiError(400, ADVISOR_NOT_AVAILABLE_400))

    // Assert
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(calls.setTools).toBe(setToolsAfterFirst)
  })

  test('returns false when the request carried no advisor schema', () => {
    // Arrange — official `if(!zm.some(Co))return`: a refusal without the
    // advisor tool in the request is someone else's 400.
    const events = attachCapturingSink()
    const { state, calls, tools } = makeState({
      tools: [makeBashToolSchema()],
    })
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act
    const shouldRetry = handler(makeApiError(400, INPUT_TAG_400))

    // Assert — no strip, no latch, no telemetry.
    expect(shouldRetry).toBe(false)
    expect(calls.setTools).toBe(0)
    expect(tools()).toHaveLength(1)
    expect(isAdvisorEntryRefused()).toBe(false)
    expect(
      events.find(e => e.eventName === 'tengu_advisor_entry_refused_retry'),
    ).toBeUndefined()
  })

  test('returns false for a non-advisor 400', () => {
    // Arrange
    const { state, calls } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act
    const shouldRetry = handler(makeApiError(400, 'invalid x-api-key'))

    // Assert
    expect(shouldRetry).toBe(false)
    expect(calls.setTools).toBe(0)
    expect(isAdvisorEntryRefused()).toBe(false)
  })

  test('returns false for a retryable-by-status error even with advisor text', () => {
    // Arrange — TPe requires status===400; a 529 with the same body is a
    // normal overload retry, not an advisor refusal.
    const { state } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act & Assert
    expect(handler(makeApiError(529, ADVISOR_NOT_AVAILABLE_400))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. withRetry integration — the hook fires before the fatal-400 gate and
//    does not count against the retry budget (attempt-- / continue).
// ---------------------------------------------------------------------------
describe('2.1.276 advisor hotfix — withRetry integration', () => {
  const baseOptions = {
    maxRetries: 3,
    model: 'test-model',
    thinkingConfig: { type: 'disabled' as const },
  }

  async function drain(gen: AsyncGenerator<unknown, unknown>): Promise<void> {
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
  }

  test('retries once and succeeds when the handler strips the advisor refusal', async () => {
    // Arrange — attempt 1 throws the Input-tag 400, attempt 2 succeeds.
    let callCount = 0
    let handlerCalls = 0
    const gen = withRetry(
      async () => ({}) as never,
      async () => {
        callCount++
        if (callCount === 1) {
          throw makeApiError(400, INPUT_TAG_400)
        }
        return 'success' as never
      },
      {
        ...baseOptions,
        retryAdvisorEntryRefused: () => {
          handlerCalls++
          return true
        },
      },
    )

    // Act
    let result: unknown
    while (true) {
      const next = await gen.next()
      if (next.done) {
        result = next.value
        break
      }
    }

    // Assert — the strip-retry does not count against the budget and the
    // second attempt's value flows through.
    expect(result).toBe('success')
    expect(callCount).toBe(2)
    expect(handlerCalls).toBe(1)
  })

  test('surfaces CannotRetryError when the one-shot handler declines the second refusal', async () => {
    // Arrange — every attempt throws the advisor 400; the real handler is
    // one-shot (Wvt), modeled here by returning true once then false.
    let callCount = 0
    let handlerCalls = 0
    const gen = withRetry(
      async () => ({}) as never,
      async () => {
        callCount++
        throw makeApiError(400, ADVISOR_ORG_REFUSED_400)
      },
      {
        ...baseOptions,
        retryAdvisorEntryRefused: () => {
          handlerCalls++
          return handlerCalls === 1
        },
      },
    )

    // Act
    let thrown: unknown
    try {
      await drain(gen)
    } catch (e) {
      thrown = e
    }

    // Assert — exactly one extra attempt, then fatal like any other 400.
    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect(callCount).toBe(2)
    expect(handlerCalls).toBe(2)
  })

  test('never invokes the handler for a non-advisor 400', async () => {
    // Arrange
    let callCount = 0
    let handlerCalls = 0
    const gen = withRetry(
      async () => ({}) as never,
      async () => {
        callCount++
        throw makeApiError(400, 'invalid x-api-key')
      },
      {
        ...baseOptions,
        retryAdvisorEntryRefused: () => {
          handlerCalls++
          return true
        },
      },
    )

    // Act
    let thrown: unknown
    try {
      await drain(gen)
    } catch (e) {
      thrown = e
    }

    // Assert — the 400 goes straight to the fatal gate.
    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect(callCount).toBe(1)
    expect(handlerCalls).toBe(0)
  })
})
