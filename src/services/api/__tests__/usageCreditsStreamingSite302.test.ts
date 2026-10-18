/**
 * CC 2.1.302 (#19) — STREAMING response-site billing wiring pin.
 *
 * usageCreditsRecording302.test.ts drives the NON-streaming site e2e
 * (executeNonStreamingRequest) plus the shared recorder helper directly. The
 * acceptance review flagged the gap: the STREAMING producer at
 * src/services/api/claude.ts:3624
 *   `recordBilledToUsageCredits(resp.headers, options.queryTracking)`
 * has no would-fail assertion — deleting that call keeps the sibling suite
 * green, so the #19 billing-skip gate can silently vanish from the MAIN
 * (streaming) query path.
 *
 * This file closes that gap: it drives the REAL `queryModelWithStreaming`
 * through an HTTP-layer SSE fetch mock whose response carries the official
 * `anthropic-ratelimit-unified-overage-in-use: true` header, and asserts the
 * per-turn `options.queryTracking.billedToUsageCredits` flag is recorded from
 * the STREAMING response (official streaming producer @246195751).
 *
 * Would-fail guarantee (mutation-verified shape): deleting the claude.ts:3624
 * call leaves `billedToUsageCredits` undefined → the assertions below FAIL.
 * The sibling helper/non-streaming suite stays green under that mutation; this
 * file does not.
 *
 * Seam discipline follows streamIntegrity281.test.ts (real query path + SSE
 * fetch mock + VCR pass-through) and usageCreditsRecording302.test.ts
 * (rate-limit gate mocked TRUE — usage-credits billing only exists for
 * claude.ai subscribers).
 */
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

// ---------------------------------------------------------------------------
// VCR pass-through (streamIntegrity281 rationale): under bun test the
// record/replay layer would cache whole query results and never reach the
// fetch mock. Require claude.ts AFTER the mock.
// ---------------------------------------------------------------------------
const VCR_MODULE_PATH = '../../vcr.js'
const realVcr = { ...(await import(VCR_MODULE_PATH)) }
let vcrMockActive = true
mock.module(VCR_MODULE_PATH, () => ({
  ...realVcr,
  withVCR: ((
    messages: unknown,
    f: () => Promise<unknown>,
    ...rest: unknown[]
  ) =>
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
      : (
          realVcr.withStreamingVCR as (
            ...a: unknown[]
          ) => AsyncGenerator<never, void>
        )(messages, f, ...rest)) as typeof realVcr.withStreamingVCR,
}))

// ---------------------------------------------------------------------------
// Rate-limit gate mock (usageCreditsRecording302 rationale):
// extractQuotaStatusFromHeaders gates on shouldProcessRateLimits(
// isClaudeAISubscriber()). Mock the gate TRUE (usage-credits billing only
// exists for claude.ai subscribers) rather than mocking isClaudeAISubscriber
// itself — client.ts builds `apiKey: isClaudeAISubscriber() ? null : …` and
// would demand an OAuth token this harness does not have.
// ---------------------------------------------------------------------------
const RATE_LIMIT_MODULE_PATH = '../../rateLimitMocking.js'
const actualRateLimitMocking = { ...(await import(RATE_LIMIT_MODULE_PATH)) }
let rateLimitMockActive = true
mock.module(RATE_LIMIT_MODULE_PATH, () => ({
  ...actualRateLimitMocking,
  shouldProcessRateLimits: (isSubscriber: boolean) =>
    rateLimitMockActive
      ? true
      : (
          actualRateLimitMocking.shouldProcessRateLimits as (
            isSubscriber: boolean,
          ) => boolean
        )(isSubscriber),
  processRateLimitHeaders: (headers: globalThis.Headers) =>
    rateLimitMockActive
      ? headers
      : (
          actualRateLimitMocking.processRateLimitHeaders as (
            h: globalThis.Headers,
          ) => globalThis.Headers
        )(headers),
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

let tmpConfigDir: string
let prevConfigDir: string | undefined
let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch

// ---------------------------------------------------------------------------
// SSE fetch mock — a clean, fully-terminated stream whose RESPONSE HEADERS
// carry the official usage-credits billing signal. The streaming producer
// reads `resp.headers` (claude.ts:3619), so the headers must live on the SSE
// Response, not in the event body.
// ---------------------------------------------------------------------------
let fetchCount = 0
let streamResponseHeaders: Record<string, string> = {}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function cleanStreamBody(): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_01USAGE302',
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
      delta: { type: 'text_delta', text: 'HELLO' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

function installFetchMock(): void {
  fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount++
    return new Response(cleanStreamBody(), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        ...streamResponseHeaders,
      },
    })
  }) as unknown as typeof fetch
}

function makeOptions(queryTracking: {
  chainId: string
  depth: number
  billedToUsageCredits?: boolean
}): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: MODEL,
    isNonInteractiveSession: true,
    querySource: 'repl_main_thread',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    queryTracking,
  } as Options
}

async function runStreamingQuery(queryTracking: {
  chainId: string
  depth: number
  billedToUsageCredits?: boolean
}): Promise<void> {
  const controller = new AbortController()
  const gen = queryModelWithStreaming({
    messages: [createUserMessage({ content: 'PING' })],
    systemPrompt: asSystemPrompt(['You are a test assistant.']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: controller.signal,
    options: makeOptions(queryTracking),
  })
  for await (const _item of gen) {
    void _item
  }
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

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-usage-stream-302-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()

  streamResponseHeaders = {}
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
  globalThis.fetch = savedFetch
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

afterAll(() => {
  vcrMockActive = false
  rateLimitMockActive = false
})

describe('CC 2.1.302 (#19): STREAMING response site records billedToUsageCredits', () => {
  test('overage-in-use: true on the streaming response → queryTracking.billedToUsageCredits === true', async () => {
    streamResponseHeaders = {
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-overage-in-use': 'true',
    }
    const queryTracking = { chainId: 'chain-stream-302', depth: 0 }
    await runStreamingQuery(queryTracking)

    expect(fetchCount).toBe(1)
    // (Mutation: delete the claude.ts:3624 call → stays undefined → FAIL.)
    expect(queryTracking.billedToUsageCredits).toBe(true)
  })

  test('overage-in-use: false on the streaming response → queryTracking.billedToUsageCredits === false (official `=ft.overageInUse===!0`)', async () => {
    streamResponseHeaders = {
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-overage-in-use': 'false',
    }
    const queryTracking = { chainId: 'chain-stream-302', depth: 0 }
    await runStreamingQuery(queryTracking)

    expect(fetchCount).toBe(1)
    expect(queryTracking.billedToUsageCredits).toBe(false)
  })

  test('header absent on the streaming response → queryTracking.billedToUsageCredits === false, not undefined', async () => {
    streamResponseHeaders = {
      'anthropic-ratelimit-unified-status': 'allowed',
    }
    const queryTracking = { chainId: 'chain-stream-302', depth: 0 }
    await runStreamingQuery(queryTracking)

    expect(fetchCount).toBe(1)
    expect(queryTracking.billedToUsageCredits).toBe(false)
  })
})
