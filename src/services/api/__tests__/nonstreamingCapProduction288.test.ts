// The real query path computes a message fingerprint reading MACRO.VERSION
// (build-time constant polyfilled in cli.tsx). Mirror the repo-convention
// polyfill for test execution (streamIntegrity281 discipline) — it must run
// before claude.ts is required below.
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
 * CC 2.1.288 #8/#34 (OCC-106 P2-3) — PRODUCTION-ENTRY coverage for the
 * non-streaming timeout retry cap through the REAL claude.ts fallback wiring.
 *
 * Acceptance finding: the v288 watchdog-cap matrix in
 * retryTimeoutEngine288.test.ts threads `failedStreamOutlastedTimeout`
 * directly into withRetry options, and nonstreamingTimeoutRetries285's
 * production-entry describe calls `executeNonStreamingRequest` directly —
 * so NEITHER pins the claude.ts threading that feeds the cap in the shipped
 * query path (`nonStreamingTimeoutMs: fallbackTimeoutMs`, claude.ts:1216).
 * Deleting that wiring left the whole suite green while the cap silently
 * disarmed (reviewer mutation probe).
 *
 * This file drives the REAL `queryModelWithStreaming` with an HTTP-layer
 * fetch mock (streamIntegrity281 discipline):
 *
 *   stream request  → 200 SSE that closes mid-envelope (no message_stop)
 *                     → StreamTruncatedError → the production non-streaming
 *                     fallback (executeNonStreamingRequest at the
 *                     `yield*` site inside the streaming catch)
 *   fallback sends  → hang forever; the SDK's own per-request
 *                     `timeout: fallbackTimeoutMs` (= API_TIMEOUT_MS here)
 *                     aborts each one into a GENUINE APIConnectionTimeoutError
 *                     whose elapsed time satisfies the cap's
 *                     `>= nonStreamingTimeoutMs * 0.9` budget gate
 *
 * Cap arithmetic (withRetry.ts): CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES=2
 * → attempt 1 times out (counter 0<2 → 1), attempt 2 (1<2 → 2), attempt 3
 * (2>=2 → logEvent('api_request', reason
 * 'api_request_nonstreaming_timeout_exhausted') + CannotRetryError). Total
 * non-streaming sends = cap+1 = 3 — "attempts ≤ 3" from the acceptance
 * verdict.
 *
 * Scope note (honest, per the acceptance ruling): the WATCHDOG-DEFAULT arm of
 * the cap (`isRetryWatchdogEnabled() && failedStreamOutlastedTimeout ? 2 :
 * undefined`) stays STAGED — no production caller computes
 * `failedStreamOutlastedTimeout` yet (the official producer is the claude.ts
 * stream loop's `he.monotonicNow()-Ih>=nqt()` check). What IS live in
 * production and pinned here end-to-end is the explicit-env arm:
 * `CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES` applies through the real
 * claude.ts → executeNonStreamingRequest → withRetry chain, and only because
 * claude.ts threads `nonStreamingTimeoutMs` — remove that line and the cap
 * gate never engages, test 1 below degrades into test 2's shape (4 sends,
 * late success, no exhaustion event) and goes RED. Engine landed, producer
 * STAGED — the watchdog default cap is not live.
 */

// ---------------------------------------------------------------------------
// VCR pass-through mock (streamIntegrity281 rationale: under bun test
// NODE_ENV='test' activates the record/replay layer which would cache whole
// query results and never reach the fetch mock). Require claude.ts AFTER.
// ---------------------------------------------------------------------------
const VCR_MODULE_PATH = '../../vcr.js'
// Spread snapshot — a bare import namespace has LIVE bindings that bun's
// mock.module patches; delegating through it would recurse into the mock.
const realVcr = { ...(await import(VCR_MODULE_PATH)) }
// Passthrough-flag pattern: with the flag off (afterAll) the mock delegates to
// the real VCR layer, so any module that resolved the mock namespace in a
// shared-process run keeps genuine behavior afterwards.
let vcrMockActive = true
mock.module(VCR_MODULE_PATH, () => ({
  ...realVcr,
  withVCR: ((messages: unknown, f: () => Promise<unknown>, ...rest: unknown[]) =>
    vcrMockActive
      ? f()
      : (realVcr.withVCR as (...a: unknown[]) => Promise<unknown>)(
          messages,
          f,
          ...rest,
        )) as typeof realVcr.withVCR,
  withStreamingVCR: ((
    messages: unknown,
    f: () => AsyncGenerator<never, void>,
    ...rest: unknown[]
  ) =>
    vcrMockActive
      ? f()
      : (realVcr.withStreamingVCR as (...a: unknown[]) => AsyncGenerator<never, void>)(
          messages,
          f,
          ...rest,
        )) as typeof realVcr.withStreamingVCR,
}))

// Analytics recorder (same passthrough-flag discipline as streamIntegrity281).
let analyticsEvents: Array<{ eventName: string; metadata: unknown }> = []
let analyticsMockActive = true
const ANALYTICS_MODULE_PATH = '../../analytics/index.js'
const realAnalytics = { ...(await import(ANALYTICS_MODULE_PATH)) }
mock.module(ANALYTICS_MODULE_PATH, () => ({
  ...realAnalytics,
  logEvent: (eventName: string, metadata: unknown) => {
    if (!analyticsMockActive)
      return (realAnalytics.logEvent as (n: string, m: unknown) => void)(
        eventName,
        metadata,
      )
    analyticsEvents.push({ eventName, metadata })
  },
  logEventAsync: async (eventName: string, metadata: unknown) => {
    if (!analyticsMockActive)
      return (
        realAnalytics.logEventAsync as (
          n: string,
          m: unknown,
        ) => Promise<void>
      )(eventName, metadata)
    analyticsEvents.push({ eventName, metadata })
  },
}))

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
  _resetForTesting: resetAnalyticsForTesting,
} = require('../../analytics/index.js') as typeof import('../../analytics/index.js')
const { resetSettingsCache } = require('../../../utils/settings/settingsCache.js') as {
  resetSettingsCache: () => void
}
const { getClaudeConfigHomeDir } = require('../../../utils/envUtils.js') as {
  getClaudeConfigHomeDir: (() => string) & { cache?: Map<unknown, string> }
}
const { getGlobalClaudeFile } = require('../../../utils/env.js') as {
  getGlobalClaudeFile: (() => string) & { cache?: Map<unknown, string> }
}

const MODEL = 'claude-sonnet-4-6'

// Cap under test: 2 retries → 3 total non-streaming sends ("attempts ≤ 3").
const CAP_RETRIES = '2'
const EXPECTED_SENDS_CAPPED = 3
// The hung-fetch mock gives up hanging here: send #4 succeeds. If the cap
// gate never engages (mutation: claude.ts drops `nonStreamingTimeoutMs`), the
// loop re-sends until this late success instead of dying at send #3 — that is
// how the control test bounds the broken path.
const LATE_SUCCESS_SEND = 4
const LATE_SUCCESS_TEXT = 'LATE SUCCESS AFTER CAP WOULD HAVE FIRED'
// Small so the SDK's own per-request timeout (`timeout: fallbackTimeoutMs` =
// min(API_TIMEOUT_MS, MAX_TIMER_MS), claude.ts getNonstreamingFallbackTimeoutMs)
// converts each hung send into a genuine APIConnectionTimeoutError after ~200ms
// — comfortably past the cap's 0.9 * nonStreamingTimeoutMs elapsed gate.
const API_TIMEOUT = '200'

// Env isolation (streamIntegrity281 list + this file's knobs).
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'USER_TYPE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'API_TIMEOUT_MS',
  'API_FORCE_IDLE_TIMEOUT',
  'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_MAX_RETRIES',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_DISABLE_STREAM_WATCHDOG',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch
let tmpConfigDir: string
let prevConfigDir: string | undefined

// ---------------------------------------------------------------------------
// HTTP-layer fetch mock: streaming → truncated SSE; non-streaming → hang, then
// a late success from LATE_SUCCESS_SEND onward.
// ---------------------------------------------------------------------------
let streamingFetches = 0
let nonStreamingFetches = 0

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** #018-shaped truncation: block 1 opens, then the stream ends cleanly — no
 *  content_block_stop, no message_delta, no message_stop → StreamTruncatedError
 *  → the production non-streaming fallback (default env). */
function truncatedSseResponse(): Response {
  const events = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_01CAP',
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
      delta: { type: 'text_delta', text: 'PARTIAL' },
    }),
    sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'cut off mid-block' },
    }),
  ]
  return new Response(events.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function lateSuccessResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_02CAP',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: LATE_SUCCESS_TEXT }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** A fetch that NEVER resolves on its own; it rejects with an AbortError the
 *  instant the request signal aborts — exactly like a real hung fetch (same
 *  primitive as nonstreamingTimeoutRetries285's installStalledFetchMock). The
 *  SDK's own per-request `timeout` owns the abort, so each hung send becomes a
 *  genuine APIConnectionTimeoutError after real elapsed time. */
function hungFetchPromise(init?: {
  signal?: AbortSignal | null
}): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })
}

function isStreamingBody(init?: { body?: unknown }): boolean {
  const raw =
    typeof init?.body === 'string'
      ? init.body
      : init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : ''
  try {
    return (JSON.parse(raw) as { stream?: unknown }).stream === true
  } catch {
    return raw.includes('"stream":true')
  }
}

function installFetchMock(): void {
  streamingFetches = 0
  nonStreamingFetches = 0
  globalThis.fetch = (async (
    _url: unknown,
    init?: { body?: unknown; signal?: AbortSignal | null },
  ) => {
    if (isStreamingBody(init)) {
      streamingFetches++
      return truncatedSseResponse()
    }
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : ''
    // The SDK 0.80.0 non-streaming wire body OMITS the `stream` key entirely
    // (verified empirically — messages.js sends `stream: body.stream ?? false`
    // only for the API call variant, not the serialized body), so discriminate
    // on the messages payload instead of a `"stream":false` literal.
    if (!body.includes('"messages"')) {
      throw new Error(
        `nonstreamingCapProduction288: unexpected fetch (body: ${body.slice(0, 120)})`,
      )
    }
    nonStreamingFetches++
    if (nonStreamingFetches >= LATE_SUCCESS_SEND) return lateSuccessResponse()
    return hungFetchPromise(init)
  }) as typeof fetch
}

// ---------------------------------------------------------------------------
// Query driver (streamIntegrity281 shape)
// ---------------------------------------------------------------------------
function makeOptions(): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: MODEL,
    isNonInteractiveSession: true,
    querySource: 'repl_main_thread',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
  }
}

type YieldedItem = {
  type: string
  isApiErrorMessage?: boolean
  message?: {
    content?: unknown
    stop_reason?: string | null
  }
  error?: string
}

async function runQuery(): Promise<{
  yielded: YieldedItem[]
  error: unknown
}> {
  const controller = new AbortController()
  const yielded: YieldedItem[] = []
  let error: unknown = null
  try {
    const gen = queryModelWithStreaming({
      messages: [createUserMessage({ content: 'PING' })],
      systemPrompt: asSystemPrompt(['You are a test assistant.']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: controller.signal,
      options: makeOptions(),
    })
    for await (const item of gen) {
      yielded.push(item as YieldedItem)
    }
  } catch (err) {
    error = err
  }
  return { yielded, error }
}

function assistantTexts(yielded: YieldedItem[]): string[] {
  const texts: string[] = []
  for (const item of yielded) {
    if (item.type !== 'assistant' || item.isApiErrorMessage) continue
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
  return texts
}

function apiErrorNotices(yielded: YieldedItem[]): string[] {
  return yielded
    .filter(item => item.isApiErrorMessage === true)
    .map(item => {
      const content = item.message?.content
      return Array.isArray(content)
        ? content
            .map(b =>
              b && typeof b === 'object' && 'text' in b
                ? String((b as { text?: unknown }).text ?? '')
                : '',
            )
            .join('')
        : ''
    })
    .filter(text => text.length > 0)
}

function exhaustionEvents(): Array<{ eventName: string; metadata: unknown }> {
  return analyticsEvents.filter(
    e =>
      e.eventName === 'api_request' &&
      (e.metadata as { reason?: string } | undefined)?.reason ===
        'api_request_nonstreaming_timeout_exhausted',
  )
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
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-nonstream-cap-288-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()

  resetAnalyticsForTesting()
  analyticsEvents = []

  savedFetch = globalThis.fetch
  installFetchMock()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()
  globalThis.fetch = savedFetch
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

afterAll(() => {
  vcrMockActive = false
  analyticsMockActive = false
})

// ---------------------------------------------------------------------------
describe('CC 2.1.288 #34 PRODUCTION ENTRY: the claude.ts non-streaming fallback honors the timeout cap', () => {
  test(
    'truncated stream → hung fallback stops at cap+1 sends (attempts ≤ 3) and surfaces the exhaustion event',
    async () => {
      // Arrange — cap=2 via the LIVE env arm; each hung send burns the real
      // API_TIMEOUT_MS budget (200ms) so the cap's elapsed gate
      // (>= 0.9 * nonStreamingTimeoutMs) is satisfied by genuine timeouts.
      process.env.API_TIMEOUT_MS = API_TIMEOUT
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = CAP_RETRIES

      // Act — real queryModelWithStreaming; the fetch mock truncates the
      // stream (→ production fallback) and hangs every fallback send.
      const { yielded, error } = await runQuery()

      // Assert — the outer catch(errorFromRetry) converts the terminal
      // CannotRetryError into a yielded API-error notice (no throw).
      expect(error).toBeNull()
      expect(streamingFetches).toBe(1)
      // The acceptance criterion: attempts ≤ cap+1 = 3 — and exactly 3 here
      // (send 3 is the one that trips `retries >= cap`), never the late
      // success waiting at send 4.
      expect(nonStreamingFetches).toBeLessThanOrEqual(EXPECTED_SENDS_CAPPED)
      expect(nonStreamingFetches).toBe(EXPECTED_SENDS_CAPPED)
      expect(exhaustionEvents()).toHaveLength(1)
      // The production fallback entry really ran (not a dummy drain).
      expect(
        analyticsEvents.some(
          e => e.eventName === 'tengu_nonstreaming_fallback_started',
        ),
      ).toBe(true)
      expect(
        analyticsEvents.some(
          e =>
            e.eventName === 'tengu_streaming_fallback_to_non_streaming' &&
            (e.metadata as { fallback_disabled?: boolean })
              .fallback_disabled === false,
        ),
      ).toBe(true)
      // The turn failed with a visible API error; the late success never ran.
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
      expect(assistantTexts(yielded)).not.toContain(LATE_SUCCESS_TEXT)
    },
    30000,
  )

  test(
    'control (mutation detector): cap env unset → the same failure re-sends PAST 3 to the late success',
    async () => {
      // Arrange — no cap env: withRetry falls back to the shared maxRetries
      // budget (getDefaultMaxRetries → 10, watchdog off), so the hung sends
      // keep going until the mock's late success at send 4.
      process.env.API_TIMEOUT_MS = API_TIMEOUT
      delete process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES

      // Act
      const { yielded, error } = await runQuery()

      // Assert — 4 > 3 non-streaming sends and a COMPLETED turn. This is the
      // exact shape test 1 degenerates into when the cap gate cannot engage
      // (e.g. claude.ts drops `nonStreamingTimeoutMs: fallbackTimeoutMs` at
      // the executeNonStreamingRequest withRetry options): the acceptance
      // probe showed the old suite stayed green under that mutation — now
      // test 1 goes red because its send count / exhaustion event / error
      // notice assertions all fail against this shape.
      expect(error).toBeNull()
      expect(streamingFetches).toBe(1)
      expect(nonStreamingFetches).toBe(LATE_SUCCESS_SEND)
      expect(exhaustionEvents()).toHaveLength(0)
      expect(assistantTexts(yielded)).toContain(LATE_SUCCESS_TEXT)
      expect(apiErrorNotices(yielded)).toEqual([])
    },
    30000,
  )
})
