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
 * 2.1.280 #032 — advisor Input-tag retry behind proxy/gateway.
 *
 * v276's `TPe` classifier was 400-only and matched the 2.1.275 proxy
 * regression solely via its `tools\.\d+\.model: ` field prefix. v280 replaced
 * it with `ake` (dedicated Input-tag regex `ske` + a 422 branch) and split
 * the retry handler's disable path by `kat` scope: process-wide kill (org
 * lacks access), HOST-wide disable (gateway Input-tag rejection — official
 * `RJr`/`mm`/`Pk`/`$H` machinery), or conversation-only.
 *
 * All official snippets below are byte-exact from the v280 binary
 * (/tmp/cc-diff-280/v280/package/claude):
 *   - `ake`/`ske`/`kat` + `mNn`/`Dit` regex construction @198649190/@198649483/@198625095
 *   - `Ece` retry handler @199639819
 *   - `mm`/`CJr`/`Pk`/`RJr`/`$H` host machinery @196095138
 *   - `xQr` host-key getter @196305973 (registration `CJr(xQr)` @199710349)
 * v278 verified to still carry the 400-only baseline (`Eue` @199586933; zero
 * hits for the Input-tag template and for `host_wide`).
 */

// ---------------------------------------------------------------------------
// GrowthBook mock (same discipline as advisorEntryRefusedRetry276.test.ts):
// spread the real module, restore after. Makes isAdvisorEnabled() true in the
// firstParty test environment so the handler's beta-strip gate is observable.
// ---------------------------------------------------------------------------
const GROWTHBOOK_MODULE_PATH = '../../analytics/growthbook.js'
const realGrowthbook = await import(GROWTHBOOK_MODULE_PATH)
mock.module(GROWTHBOOK_MODULE_PATH, () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: <T,>(key: string, defaultValue: T): T =>
    key === 'tengu_sage_compass2'
      ? ({ enabled: true } as unknown as T)
      : defaultValue,
}))

const {
  classifyAdvisorRefusalScope,
  isAdvisorEntryRefusedError,
  isAdvisorInputTagError,
} = require('../errorUtils.js') as typeof import('../errorUtils.js')

const {
  _resetAdvisorHostDisableForTesting,
  createAdvisorEntryRefusedRetryHandler,
  isAdvisorEnabledForCurrentHost,
  isAdvisorHostDisabled,
  isAdvisorKilledForCurrentHost,
  markAdvisorHostDisabled,
} = require('../advisorRetry.js') as typeof import('../advisorRetry.js')

const {
  _resetAdvisorRefusalStateForTesting,
} = require('../../../utils/advisor.js') as typeof import('../../../utils/advisor.js')

const {
  _resetForTesting: resetAnalyticsForTesting,
  attachAnalyticsSink,
} = require('../../analytics/index.js') as typeof import('../../analytics/index.js')

const { ADVISOR_BETA_HEADER } = require('../../../constants/betas.js') as typeof import('../../../constants/betas.js')

// The v280 `ske` regex is built from `"advisor_20260301".replace(/\d+$/,"")`
// — version-agnostic by design, so it must also match future tags.
const INPUT_TAG_422 =
  "Input tag 'advisor_20260301' found using 'type' does not match any tag."
const INPUT_TAG_400_WITH_PREFIX = `tools.0.model: ${INPUT_TAG_422}`
const FUTURE_INPUT_TAG =
  "Input tag 'advisor_20270301' found using 'type' does not match any tag."
const ADVISOR_NOT_AVAILABLE_400 =
  'the advisor tool is not available for your account'
const ADVISOR_MODEL_REJECTED_400 =
  'claude-haiku-4-5-20251001 cannot be used as an advisor'
const ADVISOR_ORG_REFUSED_400 =
  'the advisor tool is not available for this organization'

function makeApiError(status: number, message: string): APIError {
  return new APIError(status, { message }, message, undefined)
}

// Env vars that would flip isAdvisorEnabled()/provider selection or the host
// key — saved and cleared per test, restored after.
const ADVISOR_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
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
  _resetAdvisorHostDisableForTesting()
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
  _resetAdvisorHostDisableForTesting()
  resetAnalyticsForTesting()
})

afterAll(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. Classifier — official v280 `ake` / `ske`
// ---------------------------------------------------------------------------
describe('2.1.280 #032 — ake classifier (isAdvisorEntryRefusedError)', () => {
  test('matches a bare Input-tag 400 without the tools.N.model prefix (new ske branch)', () => {
    // Arrange — v276's TPe missed this shape: no `tools\.\d+\.model: ` prefix
    // and none of the three v276 message substrings.
    const error = makeApiError(400, INPUT_TAG_422)

    // Act & Assert
    expect(isAdvisorEntryRefusedError(error)).toBe(true)
  })

  test('matches the 2.1.275 regression shape (400 + tools.N.model prefix)', () => {
    // Arrange
    const error = makeApiError(400, INPUT_TAG_400_WITH_PREFIX)

    // Act & Assert
    expect(isAdvisorEntryRefusedError(error)).toBe(true)
  })

  test('matches a 422 carrying the Input tag (new v280 branch)', () => {
    // Arrange — some gateways answer unknown server-tool tags with 422.
    const error = makeApiError(422, INPUT_TAG_422)

    // Act & Assert
    expect(isAdvisorEntryRefusedError(error)).toBe(true)
  })

  test('matches future advisor tags — regex is version-agnostic (official Dit construction)', () => {
    // Arrange — official: new RegExp(`Input tag '${"advisor_20260301".replace(/\d+$/,"")}\\d+'`)
    const error = makeApiError(422, FUTURE_INPUT_TAG)

    // Act & Assert
    expect(isAdvisorInputTagError(FUTURE_INPUT_TAG)).toBe(true)
    expect(isAdvisorEntryRefusedError(error)).toBe(true)
  })

  test('rejects a 422 without the Input tag', () => {
    // Arrange — the 422 arm is `e.status===422&&ske(e.message)`, nothing else.
    const notAvailable = makeApiError(422, ADVISOR_NOT_AVAILABLE_400)
    const orgRefused = makeApiError(422, ADVISOR_ORG_REFUSED_400)
    const unrelated = makeApiError(422, 'invalid_request_error')

    // Act & Assert
    expect(isAdvisorEntryRefusedError(notAvailable)).toBe(false)
    expect(isAdvisorEntryRefusedError(orgRefused)).toBe(false)
    expect(isAdvisorEntryRefusedError(unrelated)).toBe(false)
  })

  test('rejects the Input tag on other statuses (403/500)', () => {
    // Arrange
    const forbidden = makeApiError(403, INPUT_TAG_422)
    const serverError = makeApiError(500, INPUT_TAG_422)

    // Act & Assert
    expect(isAdvisorEntryRefusedError(forbidden)).toBe(false)
    expect(isAdvisorEntryRefusedError(serverError)).toBe(false)
  })

  test('keeps the v276 400 arms intact', () => {
    // Arrange & Act & Assert
    expect(
      isAdvisorEntryRefusedError(makeApiError(400, ADVISOR_NOT_AVAILABLE_400)),
    ).toBe(true)
    expect(
      isAdvisorEntryRefusedError(makeApiError(400, ADVISOR_MODEL_REJECTED_400)),
    ).toBe(true)
    expect(
      isAdvisorEntryRefusedError(makeApiError(400, ADVISOR_ORG_REFUSED_400)),
    ).toBe(true)
    expect(
      isAdvisorEntryRefusedError(makeApiError(400, 'invalid x-api-key')),
    ).toBe(false)
  })

  test('rejects non-APIError carriers', () => {
    // Arrange
    const plain = new Error(INPUT_TAG_422)

    // Act & Assert — official `if(!(e instanceof Ct))return!1`
    expect(isAdvisorEntryRefusedError(plain)).toBe(false)
    expect(isAdvisorEntryRefusedError({ status: 422, message: INPUT_TAG_422 })).toBe(false)
    expect(isAdvisorEntryRefusedError(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Scope classifier — official v280 `kat`
// ---------------------------------------------------------------------------
describe('2.1.280 #032 — kat scope classifier (classifyAdvisorRefusalScope)', () => {
  test('org-unavailable message → process', () => {
    // Arrange
    const error = makeApiError(400, ADVISOR_ORG_REFUSED_400)

    // Act & Assert
    expect(classifyAdvisorRefusalScope(error)).toBe('process')
  })

  test('Input-tag 400 (with or without prefix) → host', () => {
    // Arrange & Act & Assert
    expect(
      classifyAdvisorRefusalScope(makeApiError(400, INPUT_TAG_422)),
    ).toBe('host')
    expect(
      classifyAdvisorRefusalScope(makeApiError(400, INPUT_TAG_400_WITH_PREFIX)),
    ).toBe('host')
  })

  test('Input-tag 422 → host', () => {
    // Arrange
    const error = makeApiError(422, INPUT_TAG_422)

    // Act & Assert
    expect(classifyAdvisorRefusalScope(error)).toBe('host')
  })

  test('account/model-level refusals → conversation', () => {
    // Arrange & Act & Assert — official: no org substring, no Input tag.
    expect(
      classifyAdvisorRefusalScope(makeApiError(400, ADVISOR_NOT_AVAILABLE_400)),
    ).toBe('conversation')
    expect(
      classifyAdvisorRefusalScope(makeApiError(400, ADVISOR_MODEL_REJECTED_400)),
    ).toBe('conversation')
  })
})

// ---------------------------------------------------------------------------
// 3. Host-scoped disable store — official `mm`/`Pk`/`RJr`/`$H` + `xQr`
// ---------------------------------------------------------------------------
describe('2.1.280 #032 — host-scoped disable (RJr/$H)', () => {
  test('disables the advisor for the current host only, not other hosts', () => {
    // Arrange — official host key is the raw ANTHROPIC_BASE_URL (xQr).
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-a.example.com'
    expect(isAdvisorHostDisabled()).toBe(false)
    expect(isAdvisorEnabledForCurrentHost()).toBe(true)

    // Act — official `RJr(){mm.add(Pk())}`
    markAdvisorHostDisabled()

    // Assert — same host: disabled; the qb()-analog gate reports false.
    expect(isAdvisorHostDisabled()).toBe(true)
    expect(isAdvisorEnabledForCurrentHost()).toBe(false)
    expect(isAdvisorKilledForCurrentHost()).toBe(true)

    // A different host is untouched.
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-b.example.com'
    expect(isAdvisorHostDisabled()).toBe(false)
    expect(isAdvisorEnabledForCurrentHost()).toBe(true)
    expect(isAdvisorKilledForCurrentHost()).toBe(false)

    // Returning to the disabled host re-arms.
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-a.example.com'
    expect(isAdvisorHostDisabled()).toBe(true)
    expect(isAdvisorEnabledForCurrentHost()).toBe(false)
  })

  test('falls back to the configured/default base URL when ANTHROPIC_BASE_URL is unset', () => {
    // Arrange — no env: official xQr falls through to the config URL
    // (getOauthConfig().BASE_API_URL in OCC; prod default
    // "https://api.anthropic.com") and then to the literal default.
    markAdvisorHostDisabled()

    // Act & Assert — the default host is disabled...
    expect(isAdvisorHostDisabled()).toBe(true)
    // ...but any explicit proxy host is a different key.
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-a.example.com'
    expect(isAdvisorHostDisabled()).toBe(false)
  })

  test('the process kill-switch ($H Ck arm) disables every host', () => {
    // Arrange — org-wide refusal arms isAdvisorOrgDisabled (utils/advisor.ts).
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-a.example.com'

    // Act
    const events = attachCapturingSink()
    const { state } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)
    handler(makeApiError(400, ADVISOR_ORG_REFUSED_400))

    // Assert — process scope: killed everywhere, host set untouched.
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-b.example.com'
    expect(isAdvisorKilledForCurrentHost()).toBe(true)
    expect(isAdvisorHostDisabled()).toBe(false)
    expect(events.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Retry handler — official v280 `Ece`
// ---------------------------------------------------------------------------

/** Advisor server-tool schema entry as pushed by claude.ts. */
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

function makeState(overrides?: {
  tools?: BetaToolUnion[]
  betas?: string[]
}): {
  state: AdvisorRetryRequestState
  calls: { setTools: number; setMessages: number; setBetas: number }
  tools: () => BetaToolUnion[]
  betas: () => string[]
} {
  let tools =
    overrides?.tools ?? [makeBashToolSchema(), makeAdvisorToolSchema()]
  let betas = overrides?.betas ?? ['some-other-beta', ADVISOR_BETA_HEADER]
  const calls = { setTools: 0, setMessages: 0, setBetas: 0 }
  const messages: (UserMessage | AssistantMessage)[] = []
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

function refusedEvent(events: Array<{ eventName: string; metadata: Record<string, unknown> }>) {
  return events.find(
    e => e.eventName === 'tengu_advisor_entry_refused_retry',
  )
}

describe('2.1.280 #032 — Ece retry handler (createAdvisorEntryRefusedRetryHandler)', () => {
  test('422 Input-tag refusal: strips advisor, host-disables, strips beta, logs host_wide', () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-a.example.com'
    const events = attachCapturingSink()
    const { state, calls, tools, betas } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act — the new v280 422 arm.
    const shouldRetry = handler(makeApiError(422, INPUT_TAG_422))

    // Assert
    expect(shouldRetry).toBe(true)
    expect(calls.setTools).toBe(1)
    expect(tools()).toHaveLength(1)
    expect((tools()[0] as { name?: string }).name).toBe('Bash')
    expect(calls.setMessages).toBe(1)
    // Host scope: session latch set, org kill NOT armed, host disabled.
    expect(isAdvisorKilledForCurrentHost()).toBe(true)
    expect(isAdvisorHostDisabled()).toBe(true)
    expect(isAdvisorEnabledForCurrentHost()).toBe(false)
    // Official `XHe`: `qb()` is false via the $H host arm → beta stripped.
    expect(calls.setBetas).toBe(1)
    expect(betas()).not.toContain(ADVISOR_BETA_HEADER)
    expect(betas()).toContain('some-other-beta')
    // Telemetry: {query_source, organization_wide:false, host_wide:true}
    const event = refusedEvent(events)
    expect(event).toBeDefined()
    expect(event?.metadata.query_source).toBe('repl')
    expect(event?.metadata.organization_wide).toBe(false)
    expect(event?.metadata.host_wide).toBe(true)
  })

  test('400 Input-tag refusal is host-scoped too', () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-a.example.com'
    const events = attachCapturingSink()
    const { state, betas } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act
    const shouldRetry = handler(makeApiError(400, INPUT_TAG_400_WITH_PREFIX))

    // Assert
    expect(shouldRetry).toBe(true)
    expect(isAdvisorHostDisabled()).toBe(true)
    expect(betas()).not.toContain(ADVISOR_BETA_HEADER)
    const event = refusedEvent(events)
    expect(event?.metadata.organization_wide).toBe(false)
    expect(event?.metadata.host_wide).toBe(true)
  })

  test('org refusal stays process-scoped: kill-switch armed, host set untouched', () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-a.example.com'
    const events = attachCapturingSink()
    const { state, betas } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act
    const shouldRetry = handler(makeApiError(400, ADVISOR_ORG_REFUSED_400))

    // Assert — official `if(Nr==="process")TJr()`; RJr NOT called.
    expect(shouldRetry).toBe(true)
    expect(isAdvisorHostDisabled()).toBe(false)
    expect(isAdvisorKilledForCurrentHost()).toBe(true)
    expect(betas()).not.toContain(ADVISOR_BETA_HEADER)
    const event = refusedEvent(events)
    expect(event?.metadata.organization_wide).toBe(true)
    expect(event?.metadata.host_wide).toBe(false)
  })

  test('conversation-scoped refusal: no kill, no host disable, beta kept', () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-a.example.com'
    const events = attachCapturingSink()
    const { state, calls, betas } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act
    const shouldRetry = handler(makeApiError(400, ADVISOR_NOT_AVAILABLE_400))

    // Assert — official: neither TJr nor RJr; qb() still true → header kept.
    expect(shouldRetry).toBe(true)
    expect(isAdvisorHostDisabled()).toBe(false)
    expect(isAdvisorKilledForCurrentHost()).toBe(false)
    expect(isAdvisorEnabledForCurrentHost()).toBe(true)
    expect(calls.setBetas).toBe(0)
    expect(betas()).toContain(ADVISOR_BETA_HEADER)
    const event = refusedEvent(events)
    expect(event?.metadata.organization_wide).toBe(false)
    expect(event?.metadata.host_wide).toBe(false)
  })

  test('is one-shot — a second refusal on the same request returns false (official QHe)', () => {
    // Arrange
    const { state, calls } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act
    const first = handler(makeApiError(422, INPUT_TAG_422))
    const setToolsAfterFirst = calls.setTools
    const second = handler(makeApiError(422, INPUT_TAG_422))

    // Assert
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(calls.setTools).toBe(setToolsAfterFirst)
  })

  test('returns false when the request carried no advisor schema', () => {
    // Arrange
    const events = attachCapturingSink()
    const { state, calls } = makeState({ tools: [makeBashToolSchema()] })
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act
    const shouldRetry = handler(makeApiError(422, INPUT_TAG_422))

    // Assert — official `if(!qu.some(Ar))return`
    expect(shouldRetry).toBe(false)
    expect(calls.setTools).toBe(0)
    expect(refusedEvent(events)).toBeUndefined()
  })

  test('returns false for non-advisor errors', () => {
    // Arrange
    const { state, calls } = makeState()
    const handler = createAdvisorEntryRefusedRetryHandler(state, 'repl' as never)

    // Act & Assert — official `if(QHe||!ake(er))return`
    expect(handler(makeApiError(422, 'invalid_request_error'))).toBe(false)
    expect(handler(makeApiError(500, INPUT_TAG_422))).toBe(false)
    expect(calls.setTools).toBe(0)
  })
})
