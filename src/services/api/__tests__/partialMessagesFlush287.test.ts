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
import type { Options, StreamEnvelopeState } from '../claude.js'

/**
 * CL:39 (2.1.287) — "Fixed --include-partial-messages sending a cut-short
 * reply's message_stop late or never, so apps could show the reply as still in
 * progress."
 *
 * v287 adds the flush generator `Um` + the tool-block suppression set `INo`
 * and calls `yield* Um()` at every stream terminal point. When the message
 * envelope is still open at a terminal point it synthesizes the closing
 * `content_block_stop` (SUPPRESSED for an open tool block — the tool result
 * supplies its own close) followed by `message_stop`, so an
 * `--include-partial-messages` consumer stops showing the reply as in progress.
 *
 * Block A unit-tests the exported pure generator `flushStreamClose(state)`
 * (≡ official `Um`) and the `OPEN_BLOCK_TOOL_TYPES` set (≡ official `INo`).
 * Block B drives the REAL `queryModelWithStreaming` with an HTTP-layer fetch
 * mock (same discipline as streamIntegrity281.test.ts) to verify the envelope
 * state machine wiring (message_start / content_block_start / content_block_stop)
 * and that the synthetic close events flow through the same `stream_event`
 * forwarding path the QueryEngine includePartialMessages consumer reads.
 */

// ---------------------------------------------------------------------------
// VCR pass-through mock (same rationale as streamIntegrity281: under bun test
// NODE_ENV='test' activates the record/replay layer which would cache whole
// query results and never reach the fetch mock). Require claude.ts AFTER the
// mock. Passthrough-flag pattern so later files in the shared test process see
// genuine behavior once this file's afterAll flips the flag off.
// ---------------------------------------------------------------------------
const VCR_MODULE_PATH = '../../vcr.js'
const realVcr = { ...(await import(VCR_MODULE_PATH)) }
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

const {
  queryModelWithStreaming,
  flushStreamClose,
  OPEN_BLOCK_TOOL_TYPES,
} = require('../claude.js') as typeof import('../claude.js')
const { createUserMessage } = require('../../../utils/messages.js') as typeof import(
  '../../../utils/messages.js'
)
const { asSystemPrompt } = require('../../../utils/systemPromptType.js') as typeof import(
  '../../../utils/systemPromptType.js'
)
const { getEmptyToolPermissionContext } = require('../../../Tool.js') as typeof import(
  '../../../Tool.js'
)

const MODEL = 'claude-sonnet-4-6'

// ===========================================================================
// Block A — pure unit tests of the flush generator (≡ official `Um`)
// ===========================================================================
describe('CL:39 (2.1.287) flushStreamClose generator (official Um)', () => {
  function collect(state: StreamEnvelopeState): Array<Record<string, unknown>> {
    return Array.from(flushStreamClose(state)) as Array<Record<string, unknown>>
  }

  test('(1) envelope open + open NON-tool block yields content_block_stop(index) then message_stop', () => {
    // Arrange
    const state: StreamEnvelopeState = {
      messageEnvelopeOpen: true,
      openBlockIndex: 2,
      openBlockIsTool: false,
    }

    // Act
    const events = collect(state)

    // Assert — exact official Um output order and shapes.
    expect(events).toEqual([
      { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
      { type: 'stream_event', event: { type: 'message_stop' } },
    ])
    // State is reset (official `nf=!1,Ph=null,N_=!1`).
    expect(state).toEqual({
      messageEnvelopeOpen: false,
      openBlockIndex: null,
      openBlockIsTool: false,
    })
  })

  test('(2) envelope open + open TOOL block yields ONLY message_stop (suppression)', () => {
    // Arrange — openBlockIsTool true mirrors INo.has('tool_use') at
    // content_block_start; the synthetic content_block_stop is suppressed.
    const state: StreamEnvelopeState = {
      messageEnvelopeOpen: true,
      openBlockIndex: 0,
      openBlockIsTool: true,
    }

    // Act
    const events = collect(state)

    // Assert
    expect(events).toEqual([
      { type: 'stream_event', event: { type: 'message_stop' } },
    ])
    expect(state).toEqual({
      messageEnvelopeOpen: false,
      openBlockIndex: null,
      openBlockIsTool: false,
    })
  })

  test('(2b) envelope open + NO open block (index null) yields ONLY message_stop', () => {
    const state: StreamEnvelopeState = {
      messageEnvelopeOpen: true,
      openBlockIndex: null,
      openBlockIsTool: false,
    }

    const events = collect(state)

    expect(events).toEqual([
      { type: 'stream_event', event: { type: 'message_stop' } },
    ])
  })

  test('(3) envelope already closed yields nothing (no-op after a real message_stop)', () => {
    const state: StreamEnvelopeState = {
      messageEnvelopeOpen: false,
      openBlockIndex: 0,
      openBlockIsTool: false,
    }

    const events = collect(state)

    expect(events).toEqual([])
    // Untouched — the guard returns before any mutation.
    expect(state).toEqual({
      messageEnvelopeOpen: false,
      openBlockIndex: 0,
      openBlockIsTool: false,
    })
  })

  test('(4) double-flush is idempotent — the second call yields nothing', () => {
    const state: StreamEnvelopeState = {
      messageEnvelopeOpen: true,
      openBlockIndex: 1,
      openBlockIsTool: false,
    }

    const first = collect(state)
    const second = collect(state)

    expect(first).toEqual([
      { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
      { type: 'stream_event', event: { type: 'message_stop' } },
    ])
    expect(second).toEqual([])
  })

  test('OPEN_BLOCK_TOOL_TYPES ≡ official INo (tool_use / server_tool_use / mcp_tool_use)', () => {
    // The per-type suppression set content_block_start consults
    // (`N_=INo.has(Fs.content_block.type)`).
    expect(OPEN_BLOCK_TOOL_TYPES.has('tool_use')).toBe(true)
    expect(OPEN_BLOCK_TOOL_TYPES.has('server_tool_use')).toBe(true)
    expect(OPEN_BLOCK_TOOL_TYPES.has('mcp_tool_use')).toBe(true)
    // Non-tool block types must NOT be suppressed.
    expect(OPEN_BLOCK_TOOL_TYPES.has('text')).toBe(false)
    expect(OPEN_BLOCK_TOOL_TYPES.has('thinking')).toBe(false)
    expect(OPEN_BLOCK_TOOL_TYPES.has('redacted_thinking')).toBe(false)
    expect(OPEN_BLOCK_TOOL_TYPES.size).toBe(3)
  })
})

// ===========================================================================
// Block B — realistic harness: real queryModelWithStreaming over a fetch mock
// ===========================================================================
let tmpConfigDir: string
let prevConfigDir: string | undefined
let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch

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
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_DISABLE_STREAM_WATCHDOG',
] as const

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
        `partialMessagesFlush287: unexpected fetch call #${fetchCount}`,
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

function textBlockStart(index: number): string {
  return sseEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' },
  })
}

function toolBlockStart(index: number): string {
  return sseEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'tool_use',
      id: `toolu_0${index}TEST`,
      name: 'Bash',
      input: {},
    },
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

type StreamEventYield = {
  type: 'stream_event'
  event: { type: string; index?: number }
}

/** Runs the real queryModelWithStreaming; captures stream_event yields. */
async function runStreamEvents(): Promise<{
  streamEvents: StreamEventYield[]
  error: unknown
}> {
  const controller = new AbortController()
  const streamEvents: StreamEventYield[] = []
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
      const rec = item as { type?: string }
      if (rec?.type === 'stream_event') {
        streamEvents.push(item as StreamEventYield)
      }
    }
  } catch (err) {
    error = err
  }
  return { streamEvents, error }
}

function eventTypes(streamEvents: StreamEventYield[]): string[] {
  return streamEvents.map(e => e.event.type)
}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-partial-flush-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir

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
  globalThis.fetch = savedFetch
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

afterAll(() => {
  vcrMockActive = false
})

describe('CL:39 (2.1.287) envelope state machine + flush wiring (real stream)', () => {
  test('(5a) content_block_start marks a TOOL block → clean EOF with terminal stop_reason flushes ONLY message_stop', async () => {
    // A tool_use block opens, a terminal stop_reason arrives, then the
    // connection closes cleanly WITHOUT content_block_stop / message_stop.
    responders.push(
      sseResponse([
        messageStart(),
        toolBlockStart(0),
        messageDelta('tool_use', 4),
      ]),
    )

    const { streamEvents, error } = await runStreamEvents()

    expect(error).toBeNull()
    const types = eventTypes(streamEvents)
    // The synthetic close is appended after the real forwarded parts.
    expect(types[types.length - 1]).toBe('message_stop')
    // Suppression: NO synthetic content_block_stop for the open tool block.
    expect(types).not.toContain('content_block_stop')
    // Exactly one message_stop (the synthetic one — the real one never came).
    expect(types.filter(t => t === 'message_stop')).toHaveLength(1)
  })

  test('(5b) content_block_start marks a TEXT block → clean EOF with terminal stop_reason flushes content_block_stop(index) then message_stop', async () => {
    responders.push(
      sseResponse([
        messageStart(),
        textBlockStart(0),
        textDelta(0, 'HI'),
        messageDelta('end_turn', 5),
      ]),
    )

    const { streamEvents, error } = await runStreamEvents()

    expect(error).toBeNull()
    const types = eventTypes(streamEvents)
    // The flush synthesizes the missing close events at the very end.
    expect(types.slice(-2)).toEqual(['content_block_stop', 'message_stop'])
    const syntheticStop = streamEvents[streamEvents.length - 2]
    expect(syntheticStop.event).toEqual({
      type: 'content_block_stop',
      index: 0,
    })
  })

  test('(5c) a fully-closed stream (real message_stop) flushes NOTHING extra', async () => {
    responders.push(
      sseResponse([
        messageStart(),
        textBlockStart(0),
        textDelta(0, 'HI'),
        blockStop(0),
        messageDelta('end_turn', 5),
        MESSAGE_STOP,
      ]),
    )

    const { streamEvents, error } = await runStreamEvents()

    expect(error).toBeNull()
    const types = eventTypes(streamEvents)
    // message_stop cleared the envelope → the terminal flush is a no-op, so
    // there is exactly ONE content_block_stop and ONE message_stop (the real
    // forwarded ones), with no synthetic duplicates.
    expect(types.filter(t => t === 'content_block_stop')).toHaveLength(1)
    expect(types.filter(t => t === 'message_stop')).toHaveLength(1)
    expect(types[types.length - 1]).toBe('message_stop')
  })
})
