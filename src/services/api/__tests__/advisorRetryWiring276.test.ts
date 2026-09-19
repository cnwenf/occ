// The real query path computes a message fingerprint reading MACRO.VERSION
// (build-time constant polyfilled in cli.tsx). Mirror the repo-convention
// polyfill for test execution.
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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Options } from '../claude.js'

/**
 * 2.1.276 advisor hotfix — test-001: claude.ts-LAYER integration coverage
 * for the advisor-entry-refused retry wiring.
 *
 * advisorEntryRefusedRetry276.test.ts covers the classifier, the handler
 * (official `zHe`), the session latches, and withRetry's hook in isolation.
 * This file closes the remaining gap (mutation-proven during acceptance:
 * deleting ALL THREE `retryAdvisorEntryRefused` wirings in claude.ts —
 * handler creation :2178-2194, streaming :2318, non-streaming :3095/:3202 —
 * left 157 advisor tests green). It drives the REAL `queryModelWithStreaming`
 * with an HTTP-layer fetch mock, so every assertion is on the actual wire
 * bytes of attempt N+1 after a refusal on attempt N:
 *
 *  - streaming path: 400 INPUT_TAG → handler strips the advisor schema from
 *    `allTools` via the live-binding closure (:2180-2191) → attempt 2's body
 *    carries no `advisor_20260301` entry, beta header KEPT (non-org refusal),
 *    session latch `isAdvisorEntryRefused()` blocks re-add on the NEXT query
 *    (:1443-1448 gate), fresh module state re-adds it.
 *  - org-wide refusal: beta header STRIPPED from attempt 2 (official `Hvt` —
 *    `Yqt()` disables `Bb()`).
 *  - non-streaming fallback path: 404 at stream creation →
 *    `is404StreamCreationError` (:3156-3162) → `executeNonStreamingRequest`
 *    with the SAME shared handler instance wired at :3202 → 400 INPUT_TAG →
 *    stripped retry succeeds.
 *
 * fetch is mocked at globalThis (not options.fetchOverride) because the
 * non-streaming fallback constructs its client WITHOUT fetchOverride
 * (:3086/:3195 pass only `{model, source}`) — buildFetch then falls back to
 * `globalThis.fetch` (client.ts:507), captured at client-creation time inside
 * the query, i.e. after the mock is installed.
 */

// ---------------------------------------------------------------------------
// GrowthBook mock (OCC-97 discipline: spread the real module) — makes
// isAdvisorEnabled() true (tengu_sage_compass2 → {enabled:true}).
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

// ---------------------------------------------------------------------------
// VCR pass-through mock.
//
// Under bun test NODE_ENV defaults to 'test', which activates the VCR
// record/replay layer (src/services/vcr.ts shouldUseVCR): withVCR /
// withStreamingVCR cache WHOLE query results keyed only by message content,
// so identical 'PING' queries would replay the first recording and never
// reach the fetch mock (and under CI a missing fixture throws instead of
// recording). NODE_ENV cannot be flipped away from 'test' — config.ts's
// getConfig guard requires it. Mock the wrappers to pure pass-through
// instead (require claude.ts AFTER, same discipline as the growthbook mock;
// ci-test.sh runs each file in its own process so the mock cannot leak).
// ---------------------------------------------------------------------------
const VCR_MODULE_PATH = '../../vcr.js'
const realVcr = await import(VCR_MODULE_PATH)
mock.module(VCR_MODULE_PATH, () => ({
  ...realVcr,
  withVCR: (_messages: unknown, f: () => Promise<unknown>) => f(),
  withStreamingVCR: (
    _messages: unknown,
    f: () => AsyncGenerator<never, void>,
  ) => f(),
}))

// Require AFTER the mock so claude.ts/advisor.ts bind the mocked growthbook.
const { queryModelWithStreaming } = require('../claude.js') as typeof import(
  '../claude.js'
)
const { createUserMessage } = require('../../../utils/messages.js') as typeof import(
  '../../../utils/messages.js'
)
const { asSystemPrompt } = require('../../../utils/systemPromptType.js') as typeof import(
  '../../../utils/systemPromptType.js'
)
const { getEmptyToolPermissionContext } = require('../../../Tool.js') as typeof import(
  '../../../Tool.js'
)
const {
  _resetAdvisorRefusalStateForTesting,
  isAdvisorEnabled,
  isAdvisorEntryRefused,
  isAdvisorOrgDisabled,
} = require('../../../utils/advisor.js') as typeof import('../../../utils/advisor.js')
const { ADVISOR_BETA_HEADER } = require('../../../constants/betas.js') as typeof import(
  '../../../constants/betas.js'
)
const {
  _resetForTesting: resetAnalyticsForTesting,
  attachAnalyticsSink,
} = require('../../analytics/index.js') as typeof import('../../analytics/index.js')
const { resetSettingsCache } = require('../../../utils/settings/settingsCache.js') as {
  resetSettingsCache: () => void
}
const { getClaudeConfigHomeDir } = require('../../../utils/envUtils.js') as {
  getClaudeConfigHomeDir: (() => string) & { cache?: Map<unknown, string> }
}

// ---------------------------------------------------------------------------
// Constants (byte-exact from the v276 binary; see advisorEntryRefusedRetry276)
// ---------------------------------------------------------------------------
const INPUT_TAG_400 =
  "tools.0.model: Input tag 'advisor_20260301' found using 'type' does not match any tag."
const ADVISOR_ORG_REFUSED_400 =
  'the advisor tool is not available for this organization'
const MODEL = 'claude-sonnet-4-6' // in modelSupportsAdvisor + isValidAdvisorModel allowlists
const ADVISOR_TOOL_TYPE = 'advisor_20260301'

// Env isolation: a tmp CLAUDE_CONFIG_DIR keeps the ambient ~/.claude (which
// may hold a real OAuth account) out of getAnthropicClient's auth path —
// isClaudeAISubscriber() stays false and the API-key branch is deterministic.
let tmpConfigDir: string
let prevConfigDir: string | undefined

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'USER_TYPE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  // Advisor/provider flips (same set as advisorEntryRefusedRetry276).
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch

// ---------------------------------------------------------------------------
// HTTP-layer fetch mock
// ---------------------------------------------------------------------------
type RecordedRequest = {
  url: string
  headers: Headers
  body: Record<string, unknown> | undefined
}

let requests: RecordedRequest[] = []
let responders: Array<() => Response> = []

function installFetchMock(): void {
  requests = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? String(input)
          : (input as Request).url
    const rawBody =
      init?.body ??
      (input instanceof Request ? await input.clone().text() : undefined)
    const body =
      typeof rawBody === 'string' && rawBody.length > 0
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : undefined
    const headers = new Headers(
      (init?.headers as HeadersInit | undefined) ??
        (input instanceof Request ? input.headers : undefined),
    )
    requests.push({ url, headers, body })
    const responder = responders.shift()
    if (!responder) {
      throw new Error(
        `advisorRetryWiring276: unexpected fetch call #${requests.length} to ${url}`,
      )
    }
    return responder()
  }) as typeof fetch
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A minimal successful streaming assistant turn ("PONG"). */
function successSSEResponse(): () => Response {
  return () =>
    new Response(
      [
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_01TEST',
            type: 'message',
            role: 'assistant',
            model: MODEL,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        }),
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'PONG' },
        }),
        sseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: 0,
        }),
        sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        }),
        sseEvent('message_stop', { type: 'message_stop' }),
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
}

function errorResponse(
  status: number,
  errorType: string,
  message: string,
): () => Response {
  return () =>
    new Response(
      JSON.stringify({ type: 'error', error: { type: errorType, message } }),
      { status, headers: { 'content-type': 'application/json' } },
    )
}

const inputTag400 = () =>
  errorResponse(400, 'invalid_request_error', INPUT_TAG_400)
const orgRefused400 = () =>
  errorResponse(400, 'invalid_request_error', ADVISOR_ORG_REFUSED_400)
const notFound404 = () =>
  errorResponse(404, 'not_found_error', 'streaming endpoint not found')

/** A minimal successful NON-streaming message ("PONG"). */
function nonStreamingMessageResponse(): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        id: 'msg_02TEST',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: 'PONG' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

// ---------------------------------------------------------------------------
// Query driver
// ---------------------------------------------------------------------------
function makeOptions(): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: MODEL,
    isNonInteractiveSession: true,
    // repl_main_thread → isAgenticQuery (claude.ts:1391) — required by the
    // advisor resolution gate (:1443-1448).
    querySource: 'repl_main_thread',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    advisorModel: MODEL,
  }
}

/** Runs the real queryModelWithStreaming and collects everything it yields. */
async function runQuery(): Promise<
  Array<{ type: string; message?: { content?: unknown } }>
> {
  const controller = new AbortController()
  const yielded: Array<{ type: string; message?: { content?: unknown } }> = []
  const gen = queryModelWithStreaming({
    messages: [createUserMessage({ content: 'PING' })],
    systemPrompt: asSystemPrompt(['You are a test assistant.']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: controller.signal,
    options: makeOptions(),
  })
  for await (const item of gen) {
    yielded.push(item as { type: string; message?: { content?: unknown } })
  }
  return yielded
}

function assistantText(
  yielded: Array<{ type: string; message?: { content?: unknown } }>,
): string {
  const texts: string[] = []
  for (const item of yielded) {
    if (item.type !== 'assistant') continue
    const content = item.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'text'
        ) {
          texts.push(String((block as { text?: string }).text ?? ''))
        }
      }
    }
  }
  return texts.join('')
}

function hasAdvisorTool(req: RecordedRequest): boolean {
  const tools = (req.body?.tools ?? []) as Array<Record<string, unknown>>
  return tools.some(
    t => t.type === ADVISOR_TOOL_TYPE && t.name === 'advisor',
  )
}

function betaHeader(req: RecordedRequest): string {
  return req.headers.get('anthropic-beta') ?? ''
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Deterministic firstParty + API-key auth (isFirstPartyAnthropicBaseUrl).
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-advisor-wiring-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  resetSettingsCache()

  _resetAdvisorRefusalStateForTesting()
  resetAnalyticsForTesting()
  savedFetch = globalThis.fetch
  installFetchMock()
})

afterEach(() => {
  globalThis.fetch = savedFetch
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  resetSettingsCache()
  rmSync(tmpConfigDir, { recursive: true, force: true })
  _resetAdvisorRefusalStateForTesting()
  resetAnalyticsForTesting()
})

afterAll(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. Streaming path — the :2318 wiring
// ---------------------------------------------------------------------------
describe('2.1.276 advisor retry wiring — streaming path (claude.ts:2178/:2318)', () => {
  test('INPUT_TAG 400 → attempt 2 has the advisor schema stripped, beta header kept, latch set, PONG delivered', async () => {
    // Arrange
    const events: Array<{ eventName: string; metadata: Record<string, unknown> }> =
      []
    attachAnalyticsSink({
      logEvent: (eventName, metadata) => {
        events.push({ eventName, metadata })
      },
      logEventAsync: async (eventName, metadata) => {
        events.push({ eventName, metadata })
      },
    })
    responders = [inputTag400(), successSSEResponse()]
    expect(isAdvisorEnabled()).toBe(true)

    // Act
    const yielded = await runQuery()

    // Assert — exactly two wire attempts.
    expect(requests).toHaveLength(2)
    // Attempt 1 carried the advisor server-tool schema + beta header.
    expect(hasAdvisorTool(requests[0]!)).toBe(true)
    expect(betaHeader(requests[0]!)).toContain(ADVISOR_BETA_HEADER)
    // Attempt 2: the live-binding setTools closure (:2181-2183) dropped it —
    // this is the assertion that FAILS if the :2318 wiring is deleted.
    expect(hasAdvisorTool(requests[1]!)).toBe(false)
    // Non-org refusal: official `Hvt` KEEPS the beta header (`Bb()` still true).
    expect(betaHeader(requests[1]!)).toContain(ADVISOR_BETA_HEADER)
    // Session latch set; org kill-switch NOT armed.
    expect(isAdvisorEntryRefused()).toBe(true)
    expect(isAdvisorOrgDisabled()).toBe(false)
    // The retried stream flows through to the caller.
    expect(assistantText(yielded)).toBe('PONG')
    // Telemetry (official `zHe` → tengu_advisor_entry_refused_retry).
    const event = events.find(
      e => e.eventName === 'tengu_advisor_entry_refused_retry',
    )
    expect(event).toBeDefined()
    expect(event?.metadata.query_source).toBe('repl_main_thread')
    expect(event?.metadata.organization_wide).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Session latch — the :1443-1448 re-add gate
// ---------------------------------------------------------------------------
describe('2.1.276 advisor retry wiring — session latch gate (claude.ts:1443-1448)', () => {
  test('a refused session never re-adds the schema; a fresh latch state does', async () => {
    // Arrange — simulate the post-refusal session state directly.
    const { markAdvisorEntryRefused } = require('../../../utils/advisor.js') as typeof import(
      '../../../utils/advisor.js'
    )
    markAdvisorEntryRefused(false)
    responders = [successSSEResponse()]

    // Act — next query in the same "session".
    const yielded = await runQuery()

    // Assert — schema NOT re-added (gate `!isAdvisorEntryRefused()`), but the
    // beta header survives (isAdvisorEnabled() stays true for non-org).
    expect(requests).toHaveLength(1)
    expect(hasAdvisorTool(requests[0]!)).toBe(false)
    expect(betaHeader(requests[0]!)).toContain(ADVISOR_BETA_HEADER)
    expect(assistantText(yielded)).toBe('PONG')

    // Arrange — fresh module state (official: new process / latch cleared).
    _resetAdvisorRefusalStateForTesting()
    responders = [successSSEResponse()]

    // Act
    const yielded2 = await runQuery()

    // Assert — the gate re-opens and the advisor schema is sent again.
    expect(requests).toHaveLength(2) // recorder accumulates across the run
    expect(hasAdvisorTool(requests[1]!)).toBe(true)
    expect(assistantText(yielded2)).toBe('PONG')
  })
})

// ---------------------------------------------------------------------------
// 3. Org-wide refusal — beta header stripped on the retry
// ---------------------------------------------------------------------------
describe('2.1.276 advisor retry wiring — org-wide refusal (Hvt/Yqt header strip)', () => {
  test('org refusal → attempt 2 drops BOTH the schema and the advisor beta header', async () => {
    // Arrange
    responders = [orgRefused400(), successSSEResponse()]

    // Act
    const yielded = await runQuery()

    // Assert
    expect(requests).toHaveLength(2)
    expect(hasAdvisorTool(requests[0]!)).toBe(true)
    expect(betaHeader(requests[0]!)).toContain(ADVISOR_BETA_HEADER)
    // Official `Hvt`: `if(!Bb())we=we.filter(...)` — Yqt() armed the
    // kill-switch, so setBetas dropped ADVISOR_BETA_HEADER from the retry.
    expect(hasAdvisorTool(requests[1]!)).toBe(false)
    expect(betaHeader(requests[1]!)).not.toContain(ADVISOR_BETA_HEADER)
    expect(isAdvisorOrgDisabled()).toBe(true)
    expect(isAdvisorEnabled()).toBe(false)
    expect(assistantText(yielded)).toBe('PONG')
  })
})

// ---------------------------------------------------------------------------
// 4. Non-streaming fallback path — the :3202 wiring
// ---------------------------------------------------------------------------
describe('2.1.276 advisor retry wiring — non-streaming fallback (claude.ts:3156/:3202)', () => {
  test('404 stream creation → non-streaming fallback strips advisor on INPUT_TAG 400 and succeeds', async () => {
    // Arrange — attempt 1: streaming 404 (→ CannotRetryError →
    // is404StreamCreationError); attempt 2: non-streaming INPUT_TAG 400;
    // attempt 3: non-streaming success.
    responders = [
      notFound404(),
      inputTag400(),
      nonStreamingMessageResponse(),
    ]

    // Act
    const yielded = await runQuery()

    // Assert — three wire attempts: stream, then two non-streaming.
    expect(requests).toHaveLength(3)
    expect(requests[0]!.body?.stream).toBe(true)
    expect(requests[1]!.body?.stream).toBeUndefined()
    // The fallback carried the advisor schema (latch not yet set)...
    expect(hasAdvisorTool(requests[1]!)).toBe(true)
    expect(betaHeader(requests[1]!)).toContain(ADVISOR_BETA_HEADER)
    // ...and the SHARED handler instance (wired at :3202) stripped it on the
    // retry — this assertion FAILS if the :3202 wiring is deleted.
    expect(hasAdvisorTool(requests[2]!)).toBe(false)
    expect(isAdvisorEntryRefused()).toBe(true)
    expect(assistantText(yielded)).toBe('PONG')
  })
})
