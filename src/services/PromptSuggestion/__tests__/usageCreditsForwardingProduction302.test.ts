// CC 2.1.302 (#19) — PRODUCTION-ENTRY forwarding assertions for the per-turn
// usage-credits billing flag.
//
// usageCreditsSuppress302.test.ts pins the gate helper
// (getSuggestionSuppressReason) in isolation. This file pins the two
// PRODUCTION call sites that forward `queryTracking?.billedToUsageCredits`
// into that gate — a mutation setting either forwarded argument to
// `undefined` keeps the 8 isolated gate tests green, and only these
// production-entry tests go RED:
//
//   Site 1 — promptSuggestion.ts:237 `executePromptSuggestion` →
//            `tryGenerateSuggestion(..., context.toolUseContext
//            .queryTracking?.billedToUsageCredits)`. Captured behaviorally at
//            the lowest seam: mocked `runForkedAgent` (forked query must NOT
//            run when billed=true and MUST run when billed=false even with
//            limits overageInUse=true — both directions fail under the
//            `undefined` mutation because the gate then falls back to
//            overageInUse) + mocked analytics logEvent (suppress reason
//            'usage_credits' proves suppression came from the gate, not an
//            exception swallowed by executePromptSuggestion's catch).
//
//   Site 2 — speculation.ts:358 `generatePipelinedSuggestion` (reached via
//            the exported `startSpeculation` entry) →
//            `getSuggestionSuppressReason(appState, context.toolUseContext
//            .queryTracking?.billedToUsageCredits)`. Captured directly by
//            mocking the gate module the call site invokes
//            ('../promptSuggestion.js') and asserting the captured second
//            argument (USER_TYPE='ant' is required for isSpeculationEnabled,
//            and under 'ant' the real gate never returns 'usage_credits' —
//            so argument capture, not suppression behavior, is the only
//            mutation-detecting assertion available at this site).
//
// Mocking follows the streamIntegrity281.test.ts pass-through-flag
// convention: every mock delegates to a spread snapshot of the real module
// once its flag is off, and afterAll re-mocks with the real spreads, so
// later test files in the single bun process see genuine behavior.
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
import { randomUUID } from 'crypto'
import { rmSync } from 'fs'
import { join } from 'path'
import type { AppState } from '../../../state/AppState.js'
import type { Message } from '../../../types/message.js'
import type { REPLHookContext } from '../../../utils/hooks/postSamplingHooks.js'

const CLAUDE_AI_LIMITS_PATH = '../../claudeAiLimits.js'
const FORKED_AGENT_PATH = '../../../utils/forkedAgent.js'
const ANALYTICS_PATH = '../../analytics/index.js'
const PROMPT_SUGGESTION_PATH = '../promptSuggestion.js'
const CONFIG_PATH = '../../../utils/config.js'

// Spread snapshots — a bare import namespace has LIVE bindings that bun's
// mock.module patches; delegating through it would recurse into the mock.
const actualClaudeAiLimits = { ...(await import(CLAUDE_AI_LIMITS_PATH)) }
const actualForkedAgent = { ...(await import(FORKED_AGENT_PATH)) }
const actualAnalytics = { ...(await import(ANALYTICS_PATH)) }
const actualPromptSuggestion = { ...(await import(PROMPT_SUGGESTION_PATH)) }
const actualConfig = { ...(await import(CONFIG_PATH)) }

const { createUserMessage } = await import('../../../utils/messages.js')
const { IDLE_SPECULATION_STATE } = await import('../../../state/AppStateStore.js')
const { EMPTY_USAGE } = await import('../../api/logging.js')
const { getClaudeTempDir } = await import(
  '../../../utils/permissions/filesystem.js'
)

// ---------------------------------------------------------------------------
// Seam mocks (installed BEFORE the SUT instances are imported below).
// ---------------------------------------------------------------------------

let limitsMockActive = true
let mockStatus = 'allowed'
let mockOverageInUse: boolean | undefined

mock.module(CLAUDE_AI_LIMITS_PATH, () => ({
  ...actualClaudeAiLimits,
  // Live getters so each case can vary the limits state (the ESM named
  // binding is captured once by the SUT import).
  currentLimits: {
    get status() {
      return limitsMockActive
        ? mockStatus
        : actualClaudeAiLimits.currentLimits.status
    },
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
    get overageInUse() {
      return limitsMockActive
        ? mockOverageInUse
        : actualClaudeAiLimits.currentLimits.overageInUse
    },
  },
}))

let forkedAgentMockActive = true
type ForkedAgentParams = Parameters<typeof actualForkedAgent.runForkedAgent>[0]
type ForkedAgentResult = Awaited<
  ReturnType<typeof actualForkedAgent.runForkedAgent>
>
const runForkedAgentCalls: ForkedAgentParams[] = []
let forkedAgentResult: ForkedAgentResult

mock.module(FORKED_AGENT_PATH, () => ({
  ...actualForkedAgent,
  runForkedAgent: (async (params: ForkedAgentParams) => {
    if (!forkedAgentMockActive)
      return actualForkedAgent.runForkedAgent(params)
    runForkedAgentCalls.push(params)
    return forkedAgentResult
  }) as typeof actualForkedAgent.runForkedAgent,
}))

let analyticsMockActive = true
const analyticsEvents: Array<{ eventName: string; metadata: unknown }> = []

mock.module(ANALYTICS_PATH, () => ({
  ...actualAnalytics,
  logEvent: ((eventName: string, metadata: unknown) => {
    if (!analyticsMockActive)
      return (
        actualAnalytics.logEvent as (n: string, m: never) => void
      )(eventName, metadata as never)
    analyticsEvents.push({ eventName, metadata })
  }) as typeof actualAnalytics.logEvent,
}))

// Gate-module capture for site 2 (speculation.ts imports the gate cross-
// module, so the mocked binding is what the production call site invokes).
let gateMockActive = true
const gateCalls: Array<{ appState: unknown; billedToUsageCredits: unknown }> =
  []

mock.module(PROMPT_SUGGESTION_PATH, () => ({
  ...actualPromptSuggestion,
  getSuggestionSuppressReason: ((
    appState: AppState,
    billedToUsageCredits?: boolean,
  ) => {
    if (!gateMockActive)
      return actualPromptSuggestion.getSuggestionSuppressReason(
        appState,
        billedToUsageCredits,
      )
    gateCalls.push({ appState, billedToUsageCredits })
    // Short-circuit the pipelined path after capture (the real gate would
    // never return 'usage_credits' under USER_TYPE='ant', which site 2
    // requires for isSpeculationEnabled — capture is the assertion here).
    return 'usage_credits'
  }) as typeof actualPromptSuggestion.getSuggestionSuppressReason,
}))

let configMockActive = true
mock.module(CONFIG_PATH, () => ({
  ...actualConfig,
  getGlobalConfig: (() =>
    configMockActive
      ? { speculationEnabled: true }
      : actualConfig.getGlobalConfig()) as typeof actualConfig.getGlobalConfig,
}))

// SUT instances — cache-busted so their dependency imports resolve against
// the mocked registry entries above (same convention as
// usageCreditsSuppress302.test.ts). The site-1 instance keeps its REAL
// intra-module gate (mock.module cannot intercept same-module calls, which
// is exactly what site 1 needs: real gate logic + mocked downstream seams).
const { executePromptSuggestion } = await import(
  '../promptSuggestion.js?ufwd302site1'
)
const { startSpeculation } = await import('../speculation.js?ufwd302site2')

afterAll(() => {
  limitsMockActive = false
  forkedAgentMockActive = false
  analyticsMockActive = false
  gateMockActive = false
  configMockActive = false
  mock.module(CLAUDE_AI_LIMITS_PATH, () => ({ ...actualClaudeAiLimits }))
  mock.module(FORKED_AGENT_PATH, () => ({ ...actualForkedAgent }))
  mock.module(ANALYTICS_PATH, () => ({ ...actualAnalytics }))
  mock.module(PROMPT_SUGGESTION_PATH, () => ({ ...actualPromptSuggestion }))
  mock.module(CONFIG_PATH, () => ({ ...actualConfig }))
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let savedUserType: string | undefined
beforeEach(() => {
  savedUserType = process.env.USER_TYPE
  mockStatus = 'allowed'
  mockOverageInUse = undefined
  runForkedAgentCalls.length = 0
  analyticsEvents.length = 0
  gateCalls.length = 0
  forkedAgentResult = {
    messages: [
      {
        type: 'assistant',
        uuid: randomUUID(),
        requestId: 'req_fwd_test',
        message: {
          content: [{ type: 'text', text: 'run the tests' }],
          usage: { ...EMPTY_USAGE, output_tokens: 7 },
        },
      } as unknown as Message,
    ],
    totalUsage: { ...EMPTY_USAGE, output_tokens: 7 },
  } as ForkedAgentResult
})
afterEach(() => {
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
})

function makeAppState(): AppState {
  return {
    promptSuggestionEnabled: true,
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    elicitation: { queue: [] },
    toolPermissionContext: { mode: 'default' },
    speculation: IDLE_SPECULATION_STATE,
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
  } as unknown as AppState
}

function makeAssistantMessage(): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    isApiErrorMessage: false,
    message: {
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'All done.' }],
      // Small usage so getParentCacheSuppressReason does not fire.
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as Message
}

interface Fixture {
  context: REPLHookContext
  setAppState: (f: (prev: AppState) => AppState) => void
  appliedStates: AppState[]
  getCurrentState: () => AppState
}

function makeReplContext(queryTracking?: {
  chainId: string
  depth: number
  billedToUsageCredits?: boolean
}): Fixture {
  let state = makeAppState()
  const appliedStates: AppState[] = []
  const setAppState = (f: (prev: AppState) => AppState): void => {
    state = f(state)
    appliedStates.push(state)
  }
  const context = {
    querySource: 'repl_main_thread',
    // Two assistant turns so the early_conversation guard does not fire.
    messages: [
      makeAssistantMessage(),
      createUserMessage({ content: 'do the thing' }),
      makeAssistantMessage(),
    ],
    systemPrompt: {},
    userContext: {},
    systemContext: {},
    toolUseContext: {
      getAppState: () => state,
      setAppState,
      abortController: new AbortController(),
      queryTracking,
    },
  } as unknown as REPLHookContext
  return {
    context,
    setAppState,
    appliedStates,
    getCurrentState: () => state,
  }
}

function cleanupSpeculationOverlay(fixture: Fixture): void {
  const speculation = (fixture.getCurrentState() as unknown as {
    speculation: { status: string; id?: string }
  }).speculation
  if (speculation?.status === 'active' && speculation.id) {
    rmSync(
      join(
        getClaudeTempDir(),
        'speculation',
        String(process.pid),
        speculation.id,
      ),
      { recursive: true, force: true },
    )
  }
}

// ---------------------------------------------------------------------------
// Site 1 — promptSuggestion.ts:237 (executePromptSuggestion)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 (#19): production-entry billing forwarding', () => {
  describe('promptSuggestion.ts:237 executePromptSuggestion', () => {
    test('forwards queryTracking.billedToUsageCredits=true into the gate → suppressed with usage_credits, no forked query', async () => {
      process.env.USER_TYPE = 'external'
      // Limits fallback is OFF: only the forwarded per-turn flag can suppress.
      // Mutating :237 to `undefined` would let the forked query run → RED.
      mockOverageInUse = false
      const fixture = makeReplContext({
        chainId: 'chain_site1_billed',
        depth: 0,
        billedToUsageCredits: true,
      })

      await executePromptSuggestion(fixture.context)

      expect(runForkedAgentCalls.length).toBe(0)
      expect(fixture.appliedStates.length).toBe(0)
      const suppressed = analyticsEvents.find(
        e =>
          e.eventName === 'tengu_prompt_suggestion' &&
          (e.metadata as { reason?: string }).reason === 'usage_credits',
      )
      expect(suppressed).toBeDefined()
    })

    test('forwards queryTracking.billedToUsageCredits=false into the gate → overrides limits overage, forked query runs', async () => {
      process.env.USER_TYPE = 'external'
      // Limits fallback is ON: an explicit false must still allow generation
      // (official `n??o===!0`). Mutating :237 to `undefined` would suppress
      // via the overageInUse fallback → RED.
      mockOverageInUse = true
      const fixture = makeReplContext({
        chainId: 'chain_site1_not_billed',
        depth: 0,
        billedToUsageCredits: false,
      })

      await executePromptSuggestion(fixture.context)

      expect(runForkedAgentCalls.length).toBe(1)
      expect(runForkedAgentCalls[0]!.querySource).toBe('prompt_suggestion')
      const lastState = fixture.appliedStates.at(-1) as unknown as {
        promptSuggestion: { text: string | null }
      }
      expect(lastState?.promptSuggestion?.text).toBe('run the tests')
    })
  })

  // -------------------------------------------------------------------------
  // Site 2 — speculation.ts:358 (generatePipelinedSuggestion via
  // startSpeculation)
  // -------------------------------------------------------------------------

  describe('speculation.ts:358 pipelined suggestion via startSpeculation', () => {
    test('forwards queryTracking.billedToUsageCredits=true into getSuggestionSuppressReason', async () => {
      // isSpeculationEnabled requires USER_TYPE='ant'.
      process.env.USER_TYPE = 'ant'
      const fixture = makeReplContext({
        chainId: 'chain_site2_billed',
        depth: 0,
        billedToUsageCredits: true,
      })

      await startSpeculation(
        'try the failing test',
        fixture.context,
        fixture.setAppState,
        false,
      )
      // The pipelined generation is fire-and-forget but calls the gate
      // synchronously before its first await; one macrotask tick for safety.
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(gateCalls.length).toBe(1)
      expect(gateCalls[0]!.billedToUsageCredits).toBe(true)
      expect(gateCalls[0]!.appState).toBe(fixture.getCurrentState())
      cleanupSpeculationOverlay(fixture)
    })

    test('forwards queryTracking.billedToUsageCredits=false into getSuggestionSuppressReason', async () => {
      process.env.USER_TYPE = 'ant'
      const fixture = makeReplContext({
        chainId: 'chain_site2_not_billed',
        depth: 0,
        billedToUsageCredits: false,
      })

      await startSpeculation(
        'try the failing test',
        fixture.context,
        fixture.setAppState,
        false,
      )
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(gateCalls.length).toBe(1)
      // Strict equality: mutating :358 to `undefined` fails this too.
      expect(gateCalls[0]!.billedToUsageCredits).toBe(false)
      cleanupSpeculationOverlay(fixture)
    })
  })
})
