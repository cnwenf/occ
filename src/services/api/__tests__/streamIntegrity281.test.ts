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
 * 2.1.281 PORT #018–#021 — SSE stream-integrity coverage for claude.ts.
 *
 * Drives the REAL `queryModelWithStreaming` with an HTTP-layer fetch mock
 * (same discipline as advisorRetryWiring276.test.ts), asserting on the
 * yielded messages / thrown error types / fetch call counts:
 *
 *  #021 stop_reason retention — a trailing usage-only message_delta with
 *     stop_reason:null must NOT wipe the earlier terminal stop_reason.
 *  #018 StreamTruncatedError — a clean stream close while the message
 *     envelope is still open (no message_stop, no stop_reason) throws
 *     StreamTruncatedError (code "StreamTruncated") instead of silently
 *     completing.
 *  #019 StreamMalformedEventError — content_block_delta for an unknown index
 *     ("unstarted") or an already-closed index ("closed") finalizes the
 *     partial (kept + notice) instead of RangeError('Content block not
 *     found') → discard+retry.
 *  #020 close-after-complete — a connection drop (watchdog stall) after the
 *     terminal stop_reason arrived with all blocks closed is treated as
 *     COMPLETE: no retry, no second request, no error notice.
 */

// ---------------------------------------------------------------------------
// VCR pass-through mock (same rationale as advisorRetryWiring276: under
// bun test NODE_ENV='test' activates the record/replay layer which would
// cache whole query results and never reach the fetch mock). Require
// claude.ts AFTER the mock.
// ---------------------------------------------------------------------------
const VCR_MODULE_PATH = '../../vcr.js'
// Spread snapshot — a bare import namespace has LIVE bindings that bun's
// mock.module patches; delegating through it would recurse into the mock.
const realVcr = { ...(await import(VCR_MODULE_PATH)) }
// Passthrough-flag pattern: bun runs every test file in ONE process and a
// re-mock "restore" does not heal modules whose bindings already resolved to
// the mock namespace. With the flag off (afterAll) the mock delegates to the
// real VCR layer, so later files in the run see genuine behavior.
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

// Analytics recorder. Installed as a module-level mock.module override (not
// just a sink attach) because bun runs all test files in ONE process and a
// sibling file (retryWatchdogRetryAfter281.test.ts) replaces the analytics
// module's logEvent with its own recorder — a sink attached to the real
// dispatch would then never fire. This file sorts last in the directory, so
// the override is installed after every sibling has finished running.
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
const { resetSettingsCache } = require('../../../utils/settings/settingsCache.js') as {
  resetSettingsCache: () => void
}
const { getClaudeConfigHomeDir } = require('../../../utils/envUtils.js') as {
  getClaudeConfigHomeDir: (() => string) & { cache?: Map<unknown, string> }
}
// getGlobalClaudeFile is a ZERO-ARG lodash memoize — the first call pins the
// config path for the whole process. Without clearing it around this file's
// temp-CLAUDE_CONFIG_DIR window, the pin can survive (pointing at a deleted
// dir) into every later test file.
const { getGlobalClaudeFile } = require('../../../utils/env.js') as {
  getGlobalClaudeFile: (() => string) & { cache?: Map<unknown, string> }
}

const MODEL = 'claude-sonnet-4-6'

// Env isolation: a tmp CLAUDE_CONFIG_DIR keeps the ambient ~/.claude out of
// the auth path — isClaudeAISubscriber() stays false and the API-key branch
// is deterministic.
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
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  // Stream-integrity knobs exercised below.
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_DISABLE_STREAM_WATCHDOG',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch

// ---------------------------------------------------------------------------
// HTTP-layer fetch mock + SSE builders
// ---------------------------------------------------------------------------
let fetchCount = 0
let responders: Array<(init?: { signal?: AbortSignal | null }) => Response> = []

function installFetchMock(): void {
  fetchCount = 0
  globalThis.fetch = (async (
    _url: unknown,
    init?: { signal?: AbortSignal | null },
  ) => {
    fetchCount++
    const responder = responders.shift()
    if (!responder) {
      throw new Error(
        `streamIntegrity281: unexpected fetch call #${fetchCount}`,
      )
    }
    return responder(init)
  }) as typeof fetch
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function messageStart(): string {
  return sseEvent('message_start', {
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
  })
}

function blockStart(index: number): string {
  return sseEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' },
  })
}

function textDelta(index: number, text: string): string {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  })
}

function blockStop(index: number): string {
  return sseEvent('content_block_stop', {
    type: 'content_block_stop',
    index,
  })
}

function messageDelta(stopReason: string | null, outputTokens: number): string {
  return sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  })
}

const MESSAGE_STOP = sseEvent('message_stop', { type: 'message_stop' })

function sseResponse(events: string[]): () => Response {
  return () =>
    new Response(events.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
}

/** A minimal successful NON-streaming message — the fallback re-send reply
 *  (same shape as advisorRetryWiring276's nonStreamingMessageResponse). */
function nonStreamingMessageResponse(text = 'FALLBACK COMPLETE'): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        id: 'msg_02TEST',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

/** An SSE body that delivers `events` and then stalls (never closes) — the
 *  idle watchdog aborts it after CLAUDE_STREAM_IDLE_TIMEOUT_MS. The request
 *  signal is wired like a real fetch: aborting it errors the body so the
 *  SDK's pending read rejects with an AbortError (clean iterator exit). */
function stalledSseResponse(
  events: string[],
): (init?: { signal?: AbortSignal | null }) => Response {
  return init => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(events.join('')))
        init?.signal?.addEventListener('abort', () => {
          // Bun's ReadableStreamDefaultController has no .abort(); erroring
          // with an AbortError DOMException is what a real aborted fetch
          // body read rejects with (SDK treats it as a clean exit).
          controller.error(new DOMException('Aborted', 'AbortError'))
        })
        // intentionally never close(): the watchdog fires and
        // releaseStreamResources() aborts via the request signal.
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
}

// ---------------------------------------------------------------------------
// Query driver
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
    usage?: { output_tokens?: number }
  }
  error?: string
}

/** Runs the real queryModelWithStreaming; captures yields and any throw. */
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

function lastAssistantMessage(
  yielded: YieldedItem[],
): YieldedItem['message'] | undefined {
  for (let i = yielded.length - 1; i >= 0; i--) {
    if (yielded[i]?.type === 'assistant' && !yielded[i]?.isApiErrorMessage) {
      return yielded[i].message
    }
  }
  return undefined
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

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-stream-integrity-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()

  resetAnalyticsForTesting()
  analyticsEvents = []

  responders = []
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
  // Drop any pin taken during the temp-dir window BEFORE it is removed, so no
  // later file in the shared process resolves a deleted path.
  getGlobalClaudeFile.cache?.clear?.()
  globalThis.fetch = savedFetch
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

afterAll(() => {
  // Flip the passthrough mocks off — modules that resolved these bindings
  // keep the mock namespace for the rest of the shared test process.
  vcrMockActive = false
  analyticsMockActive = false
})

// ---------------------------------------------------------------------------
// #021 — stop_reason retention on trailing usage-only message_delta
// ---------------------------------------------------------------------------
describe('2.1.281 #021 stop_reason retention', () => {
  test('trailing usage-only message_delta with stop_reason:null does not wipe the earlier stop_reason', async () => {
    responders.push(
      sseResponse([
        messageStart(),
        blockStart(0),
        textDelta(0, 'HI'),
        blockStop(0),
        messageDelta('end_turn', 5),
        // Trailing usage-only frame (v280 bug @199674803 wiped stop_reason).
        messageDelta(null, 7),
        MESSAGE_STOP,
      ]),
    )

    const { yielded, error } = await runQuery()

    expect(error).toBeNull()
    expect(fetchCount).toBe(1)
    expect(assistantTexts(yielded)).toEqual(['HI'])
    expect(lastAssistantMessage(yielded)?.stop_reason).toBe('end_turn')
    // The trailing frame still updates usage on the yielded message.
    expect(lastAssistantMessage(yielded)?.usage?.output_tokens).toBeGreaterThanOrEqual(7)
  })
})

// ---------------------------------------------------------------------------
// #018 — StreamTruncatedError on clean close inside an open envelope
// ---------------------------------------------------------------------------
describe('2.1.281 #018 StreamTruncatedError', () => {
  test('clean stream close with an open content block surfaces StreamTruncated (no silent completion, no retry)', async () => {
    // Disable the non-streaming fallback so the truncation error is not
    // converted into a fallback request (the official also routes
    // StreamTruncatedError through the retry/fallback path).
    process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'
    responders.push(
      sseResponse([
        messageStart(),
        blockStart(0),
        textDelta(0, 'PARTIAL'),
        blockStop(0),
        // Block 1 opens, then the stream ends cleanly: no content_block_stop,
        // no message_delta, no message_stop.
        blockStart(1),
        textDelta(1, 'cut off mid-block'),
      ]),
    )

    const { yielded, error } = await runQuery()

    // The outer catch(errorFromRetry) converts the thrown StreamTruncatedError
    // into a yielded synthetic API-error notice — what matters is that the
    // clean close did NOT pass as a completed response.
    expect(error).toBeNull()
    expect(fetchCount).toBe(1)
    expect(apiErrorNotices(yielded).join('\n')).toContain(
      'Stream ended before the response was complete',
    )
    // The completed block was still yielded before the truncation surfaced.
    expect(assistantTexts(yielded)).toEqual(['PARTIAL'])
  })

  test('DEFAULT env (no disable flag): truncation routes through the non-streaming fallback re-send (fetchCount=2)', async () => {
    // beforeEach deletes CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK — this is
    // the shipped default environment. Official parity: StreamTruncatedError
    // is EXCLUDED from getMidStreamFinalizeCause (claude.ts), so the default
    // build re-sends the whole query non-streaming instead of finalizing the
    // partial. This pins the double-execution tradeoff (inc-4258) as
    // intentional/official-matching — a clean-close truncation must NEVER be
    // silently finalized as complete in the default env.
    responders.push(
      sseResponse([
        messageStart(),
        blockStart(0),
        textDelta(0, 'PARTIAL'),
        blockStop(0),
        blockStart(1),
        textDelta(1, 'cut off mid-block'),
      ]),
      nonStreamingMessageResponse(),
    )

    const { yielded, error } = await runQuery()

    expect(error).toBeNull()
    // The re-send happened: fetch #1 = truncated stream, fetch #2 = fallback.
    expect(fetchCount).toBe(2)
    const texts = assistantTexts(yielded)
    expect(texts).toContain('FALLBACK COMPLETE')
    // Known tradeoff: the streaming partial already yielded to the consumer
    // is NOT retracted, so the fallback content arrives alongside it (the
    // duplicate-content cost the disable flag exists to opt out of).
    expect(texts).toContain('PARTIAL')
    // The fallback REPLACED the error path — no truncation notice surfaces.
    expect(apiErrorNotices(yielded).join('\n')).not.toContain(
      'Stream ended before the response was complete',
    )
    expect(lastAssistantMessage(yielded)?.stop_reason).toBe('end_turn')
    // Telemetry: the fallback fired (and NOT the disabled variant).
    const fallback = analyticsEvents.find(
      e => e.eventName === 'tengu_streaming_fallback_to_non_streaming',
    )
    expect(fallback).toBeDefined()
    expect(
      (fallback?.metadata as { fallback_disabled?: boolean }).fallback_disabled,
    ).toBe(false)
    expect(
      analyticsEvents.some(
        e => e.eventName === 'tengu_nonstreaming_fallback_started',
      ),
    ).toBe(true)
  })

  test('clean close after terminal message_delta (message_stop missing) completes without truncation', async () => {
    responders.push(
      sseResponse([
        messageStart(),
        blockStart(0),
        textDelta(0, 'DONE'),
        blockStop(0),
        messageDelta('end_turn', 4),
        // message_stop never arrives but the envelope reached its terminal
        // state — v281 `if(ml&&!(pc!==null&&Ob))` does NOT throw here.
      ]),
    )

    const { yielded, error } = await runQuery()

    expect(error).toBeNull()
    expect(assistantTexts(yielded)).toEqual(['DONE'])
    expect(lastAssistantMessage(yielded)?.stop_reason).toBe('end_turn')
  })
})

// ---------------------------------------------------------------------------
// #019 — StreamMalformedEventError replaces RangeError, partial kept
// ---------------------------------------------------------------------------
describe('2.1.281 #019 StreamMalformedEventError', () => {
  test('content_block_delta for an unknown index keeps the partial and surfaces the unstarted-event notice (no RangeError, no retry)', async () => {
    responders.push(
      sseResponse([
        messageStart(),
        blockStart(0),
        textDelta(0, 'HELLO'),
        blockStop(0),
        // Proxy replays a delta for an index that was never started.
        textDelta(5, 'ghost'),
      ]),
    )

    const { yielded, error } = await runQuery()

    // Finalized as a partial: no throw, no fallback request.
    expect(error).toBeNull()
    expect(fetchCount).toBe(1)
    expect(assistantTexts(yielded)).toEqual(['HELLO'])
    // stop_reason synthesized on the kept partial (text-only → end_turn).
    expect(lastAssistantMessage(yielded)?.stop_reason).toBe('end_turn')
    expect(apiErrorNotices(yielded).join('\n')).toContain(
      'Part of the response never arrived. The response above may be incomplete.',
    )
    const finalized = analyticsEvents.find(
      e => e.eventName === 'tengu_streaming_partial_finalized',
    )
    expect(finalized).toBeDefined()
    expect((finalized?.metadata as { cause?: string }).cause).toBe(
      'malformed_stream',
    )
  })

  test('content_block_delta for an already-closed index surfaces the malformed notice', async () => {
    responders.push(
      sseResponse([
        messageStart(),
        blockStart(0),
        textDelta(0, 'HELLO'),
        blockStop(0),
        // Duplicate delta for the CLOSED index 0.
        textDelta(0, 'replayed'),
      ]),
    )

    const { yielded, error } = await runQuery()

    expect(error).toBeNull()
    expect(fetchCount).toBe(1)
    expect(assistantTexts(yielded)).toEqual(['HELLO'])
    expect(apiErrorNotices(yielded).join('\n')).toContain(
      'The response stream was malformed. The response above may be incomplete.',
    )
  })

  test('the error class itself carries the official shape (blockState + messages)', async () => {
    const { StreamMalformedEventError, StreamTruncatedError } =
      require('../claude.js') as typeof import('../claude.js')

    const unstarted = new StreamMalformedEventError('unstarted')
    expect(unstarted.name).toBe('StreamMalformedEventError')
    expect(unstarted.message).toBe('Content block not found')
    expect(unstarted.blockState).toBe('unstarted')

    const closed = new StreamMalformedEventError('closed')
    expect(closed.message).toBe('Content block already closed')
    expect(closed.blockState).toBe('closed')

    const truncated = new StreamTruncatedError()
    expect(truncated.name).toBe('StreamTruncatedError')
    expect(truncated.code).toBe('StreamTruncated')
    expect(truncated.message).toBe('Stream ended before the response was complete')
  })
})

// ---------------------------------------------------------------------------
// #020 — drop after complete is treated as complete (no retry)
// ---------------------------------------------------------------------------
describe('2.1.281 #020 close-after-complete', () => {
  test('connection stall after terminal message_delta completes without retry or notice', async () => {
    // Fast idle watchdog: the stalled body below is aborted after 80ms.
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '80'
    responders.push(
      stalledSseResponse([
        messageStart(),
        blockStart(0),
        textDelta(0, 'DONE'),
        blockStop(0),
        messageDelta('end_turn', 4),
        // Connection drops here (before message_stop): stop_reason received,
        // terminal state reached, no open block → COMPLETE, not a retry.
      ]),
    )

    const { yielded, error } = await runQuery()

    expect(error).toBeNull()
    // Exactly one request: the completed response was NOT re-requested.
    expect(fetchCount).toBe(1)
    expect(assistantTexts(yielded)).toEqual(['DONE'])
    expect(lastAssistantMessage(yielded)?.stop_reason).toBe('end_turn')
    expect(apiErrorNotices(yielded)).toEqual([])
    const closeAfterComplete = analyticsEvents.find(
      e => e.eventName === 'tengu_streaming_close_after_complete',
    )
    expect(closeAfterComplete).toBeDefined()
    expect((closeAfterComplete?.metadata as { cause?: string }).cause).toBe(
      'watchdog',
    )
  })
})
