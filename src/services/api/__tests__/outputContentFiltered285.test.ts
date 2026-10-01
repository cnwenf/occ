// The real query path computes a message fingerprint reading MACRO.VERSION
// (build-time constant polyfilled in cli.tsx). Mirror the repo-convention
// polyfill for test execution (streamIntegrity281 discipline).
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
import { APIError } from '@anthropic-ai/sdk'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Options } from '../claude.js'
import { isOutputContentFilteredError } from '../errorUtils.js'
import { classifyAPIError } from '../errors.js'

/**
 * CC 2.1.285 (item-B3): "Fixed responses blocked by the API's output content
 * filter being re-sent and retried, sometimes for minutes, instead of showing
 * the filter's error right away."
 *
 * The official v285 binary extracted a shared predicate `g0` (@203962444):
 *   `var QYn="Output blocked by content filtering policy";
 *    function g0(e){if(!(e instanceof Error)||!e.message.includes(QYn))return!1;
 *      let n="originalError"in e&&e.originalError instanceof Error?e.originalError:e,
 *          r=n instanceof Rt?k9n(n):void 0;
 *      return r===void 0||r===400}`
 * where `Rt` ≡ APIError and `k9n` (@197932304) resolves the effective status
 * (numeric .status → overloaded shape 529 → rate-limit shape 429 → undefined).
 *
 * g0 is wired into THREE sites, all mirrored here:
 *   1. the retry loop catch (withRetry.ts) — fatal CannotRetryError on attempt 1;
 *   2. the streaming→non-streaming fallback (claude.ts) — rethrow, no fallback.
 *      Driven end-to-end through the REAL queryModelWithStreaming with an
 *      HTTP-layer fetch/SSE mock in the site-2 describe at the bottom of this
 *      file (mutation-proven during review: disabling the claude.ts rethrow
 *      previously kept the whole suite green);
 *   3. classifyAPIError (errors.ts) — 'output_content_filtered'.
 *
 * v284 only had the inline classifier string; OCC previously had NEITHER the
 * predicate nor the fatal retry/fallback branches, so a filtered response was
 * retried like any other error. These tests pin the v285 behavior.
 */

const FILTER = 'Output blocked by content filtering policy'

const { withRetry, CannotRetryError } =
  require('../withRetry.js') as typeof import('../withRetry.js')

// ---------------------------------------------------------------------------
// Site-2 harness — drives the REAL queryModelWithStreaming (claude.ts) with an
// HTTP-layer fetch/SSE mock (streamIntegrity281 discipline). VCR pass-through
// must be installed BEFORE claude.ts is required; under bun test NODE_ENV
// ='test' would otherwise activate record/replay and never reach fetch. This
// file sorts before streamIntegrity281/retryWatchdogRetryAfter281 which install
// their own module mocks, so the flagged pass-through (flipped off in afterAll)
// keeps the shared single test process clean for them.
// ---------------------------------------------------------------------------
const VCR_MODULE_PATH = '../../vcr.js'
// Spread snapshot — a bare import namespace has LIVE bindings that bun's
// mock.module patches; delegating through it would recurse into the mock.
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
      : (realVcr.withStreamingVCR as (
          ...a: unknown[]
        ) => AsyncGenerator<never, void>)(messages, f, ...rest)) as typeof realVcr.withStreamingVCR,
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
  attachAnalyticsSink,
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

/**
 * Build an APIError carrying the filter message. `.message` is derived by the
 * SDK's makeMessage from `error.message` (the body), so the filter string is
 * placed in the body to guarantee `error.message.includes(FILTER)`.
 */
function filterAPIError(
  status: number | undefined,
  opts?: { headerRetry?: boolean; bodySuffix?: string },
): APIError {
  const bodyMessage = `${FILTER}${opts?.bodySuffix ?? ''}`
  const headers = opts?.headerRetry
    ? new Headers({ 'x-should-retry': 'true' })
    : undefined
  return new APIError(status, { message: bodyMessage }, bodyMessage, headers)
}

/** Drain the withRetry generator; return how many operation attempts ran. */
async function runUntilThrow(
  failWith: () => Error,
  maxRetries = 10,
): Promise<{ attempts: number; threw: unknown }> {
  let attempts = 0
  const gen = withRetry(
    async () => ({}) as never, // dummy client — operation throws before use
    async () => {
      attempts++
      throw failWith()
    },
    {
      maxRetries,
      model: 'test-model',
      thinkingConfig: { type: 'disabled' as const },
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

describe('CC 2.1.285 item-B3: isOutputContentFilteredError (g0 predicate)', () => {
  test('400 + filter message → true (bare filter rejection is fatal)', () => {
    expect(isOutputContentFilteredError(filterAPIError(400))).toBe(true)
  })

  test('undefined status + filter message → true (non-HTTP rejection is fatal)', () => {
    expect(isOutputContentFilteredError(filterAPIError(undefined))).toBe(true)
  })

  test('429 + filter message → false (rate-limit status wins, stays retryable)', () => {
    expect(isOutputContentFilteredError(filterAPIError(429))).toBe(false)
  })

  test('529 + filter message → false (overloaded status wins)', () => {
    expect(isOutputContentFilteredError(filterAPIError(529))).toBe(false)
  })

  test('undefined status but overloaded_error message shape → false (k9n resolves 529)', () => {
    const e = filterAPIError(undefined, {
      bodySuffix: ' "type":"overloaded_error"',
    })
    expect(isOutputContentFilteredError(e)).toBe(false)
  })

  test('undefined status but rate_limit_error message shape → false (k9n resolves 429)', () => {
    const e = filterAPIError(undefined, {
      bodySuffix: ' "type":"rate_limit_error"',
    })
    expect(isOutputContentFilteredError(e)).toBe(false)
  })

  test('unwraps originalError: wrapper (filter msg) + originalError=APIError 400 → true', () => {
    const outer = new Error(`transport wrapped: ${FILTER}`)
    ;(outer as { originalError?: unknown }).originalError = filterAPIError(400)
    expect(isOutputContentFilteredError(outer)).toBe(true)
  })

  test('unwraps originalError: wrapper (filter msg) + originalError=APIError 429 → false', () => {
    // The outer message alone carries the filter string, but g0 consults the
    // unwrapped originalError's status (429) — proving the unwrap decides.
    const outer = new Error(`transport wrapped: ${FILTER}`)
    ;(outer as { originalError?: unknown }).originalError = filterAPIError(429)
    expect(isOutputContentFilteredError(outer)).toBe(false)
  })

  test('plain Error with filter message and no originalError → true (undefined status)', () => {
    expect(isOutputContentFilteredError(new Error(FILTER))).toBe(true)
  })

  test('non-Error input → false', () => {
    expect(isOutputContentFilteredError(FILTER)).toBe(false)
    expect(isOutputContentFilteredError(null)).toBe(false)
    expect(isOutputContentFilteredError(undefined)).toBe(false)
    expect(isOutputContentFilteredError({ message: FILTER })).toBe(false)
  })

  test('Error without the filter message → false', () => {
    expect(isOutputContentFilteredError(new Error('some other failure'))).toBe(
      false,
    )
    expect(
      isOutputContentFilteredError(
        new APIError(400, { message: 'bad request' }, 'bad request', undefined),
      ),
    ).toBe(false)
  })
})

describe('CC 2.1.285 item-B3: classifyAPIError → output_content_filtered', () => {
  test('400 filter error classifies as output_content_filtered', () => {
    expect(classifyAPIError(filterAPIError(400))).toBe('output_content_filtered')
  })

  test('undefined-status filter error classifies as output_content_filtered', () => {
    expect(classifyAPIError(filterAPIError(undefined))).toBe(
      'output_content_filtered',
    )
  })

  test('429 filter error does NOT classify as output_content_filtered (transport status wins)', () => {
    expect(classifyAPIError(filterAPIError(429))).not.toBe(
      'output_content_filtered',
    )
  })

  test('529 filter error does NOT classify as output_content_filtered', () => {
    expect(classifyAPIError(filterAPIError(529))).not.toBe(
      'output_content_filtered',
    )
  })
})

describe('CC 2.1.285 item-B3: withRetry surfaces the filter error immediately', () => {
  test('400 filter error throws CannotRetryError on the first attempt (no retry storm)', async () => {
    const { attempts, threw } = await runUntilThrow(() => filterAPIError(400))
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })

  test('filter error with x-should-retry:true still throws on attempt 1 (g0 precedes shouldRetry)', async () => {
    // Without the g0 fatal branch, shouldRetry honors x-should-retry:true (no
    // claude.ai subscriber in the test env) and re-sends up to maxRetries;
    // g0 is checked first in the catch, so the filtered response surfaces at
    // once. This is the exact "retried for minutes" bug the changelog fixes.
    const { attempts, threw } = await runUntilThrow(() =>
      filterAPIError(400, { headerRetry: true }),
    )
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })

  test('undefined-status filter error is fatal too (would otherwise be non-retryable, but g0 owns it)', async () => {
    const { attempts, threw } = await runUntilThrow(() =>
      filterAPIError(undefined),
    )
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })

  test('CannotRetryError preserves the original filter error for downstream display', async () => {
    const { threw } = await runUntilThrow(() => filterAPIError(400))
    expect(threw).toBeInstanceOf(CannotRetryError)
    const cre = threw as InstanceType<typeof CannotRetryError>
    expect(isOutputContentFilteredError(cre.originalError)).toBe(true)
  })

  test('non-filter 500 keeps the normal retry budget (no regression)', async () => {
    // A generic retryable server error must still exhaust maxRetries+1, so the
    // g0 branch is not accidentally catching everything.
    const make500 = () =>
      new APIError(500, { message: 'Internal server error' }, 'boom', undefined)
    const { attempts, threw } = await runUntilThrow(make500, 2)
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(3)
  }, 30000)
})

// ---------------------------------------------------------------------------
// SITE 2 — the streaming→non-streaming fallback branch in claude.ts
// (:3383 `if (isOutputContentFilteredError(streamingError)) { … throw }`).
// The tests above drain withRetry directly (site 1) and classifyAPIError
// (site 3); NEITHER exercises the production streaming entry, so disabling the
// :3383 immediate rethrow kept them all green (reviewer mutation-test-01).
// This describe drives the REAL queryModelWithStreaming against an HTTP-layer
// SSE mock and pins: fetchCount===1 (no non-streaming re-send) + the filter
// text surfaces as the API-error notice + the fallback_disabled:true event.
// ---------------------------------------------------------------------------
const MODEL = 'claude-sonnet-4-6'

let fetchCount = 0
let responders: Array<(init?: { signal?: AbortSignal | null }) => Response> = []
let savedFetch: typeof globalThis.fetch
let tmpConfigDir: string
let prevConfigDir: string | undefined
let savedEnv: Record<string, string | undefined> = {}

// Analytics recorder via the real module's sink (attachAnalyticsSink). This
// file sorts before retryWatchdogRetryAfter281/streamIntegrity281, which each
// install their own analytics module mock — the sink approach (not mock.module)
// is the correct one at this alphabetical position (advisorRetryWiring276
// precedent) and is torn down in afterEach so later files see a clean dispatch.
let analyticsEvents: Array<{ eventName: string; metadata: Record<string, unknown> }> = []

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
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_DISABLE_STREAM_WATCHDOG',
] as const

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
        `outputContentFiltered285: unexpected fetch call #${fetchCount}`,
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
      id: 'msg_01FILTER',
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

/** An SSE `event: error` frame — the SDK's streaming.mjs turns this into
 *  `throw new APIError(undefined, safeJSON(data) ?? data, undefined, headers)`.
 *  With the filter text in the body, APIError.makeMessage derives `.message`
 *  containing FILTER and `.status` is undefined → isOutputContentFilteredError
 *  returns true (site 2 fires). */
function sseErrorEvent(
  message: string,
  type = 'invalid_request_error',
): string {
  return sseEvent('error', { type: 'error', error: { type, message } })
}

function sseResponse(events: string[]): () => Response {
  return () =>
    new Response(events.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
}

/** A minimal successful NON-streaming message — the fallback re-send reply.
 *  Queued as a SECOND responder so that if site 2 regresses (rethrow disabled)
 *  the fallback re-send completes instead of hanging on an unserved request;
 *  the assertions then FAIL cleanly (fetchCount===2, no filter notice). */
function nonStreamingMessageResponse(
  text = 'FALLBACK COMPLETE',
): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        id: 'msg_02FALLBACK',
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
  message?: { content?: unknown }
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

describe('CC 2.1.285 item-B3 SITE 2: claude.ts streaming→non-streaming fallback rethrows the filter error', () => {
  beforeEach(() => {
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

    tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-output-filter-'))
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    getClaudeConfigHomeDir.cache?.clear?.()
    getGlobalClaudeFile.cache?.clear?.()
    resetSettingsCache()

    resetAnalyticsForTesting()
    analyticsEvents = []
    attachAnalyticsSink({
      logEvent: (eventName, metadata) => {
        analyticsEvents.push({ eventName, metadata })
      },
      logEventAsync: async (eventName, metadata) => {
        analyticsEvents.push({ eventName, metadata })
      },
    })

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
    getGlobalClaudeFile.cache?.clear?.()
    globalThis.fetch = savedFetch
    rmSync(tmpConfigDir, { recursive: true, force: true })
    resetAnalyticsForTesting()
  })

  test('mid-stream output-content-filter error → fetchCount===1 (NO non-streaming re-send) and the filter text surfaces', async () => {
    responders.push(
      sseResponse([messageStart(), sseErrorEvent(FILTER)]),
      // Served ONLY if the :3383 rethrow regresses and the fallback re-send
      // happens — the assertions below then fail cleanly instead of hanging.
      nonStreamingMessageResponse(),
    )

    const { yielded, error } = await runQuery()

    // The filter error is rethrown at :3383, caught by the outer catch, and
    // surfaced as an API-error notice — queryModelWithStreaming does NOT throw
    // to the caller.
    expect(error).toBeNull()
    // THE core site-2 assertion: exactly one wire request. A non-streaming
    // fallback re-send would make this 2 (and would be served the responder
    // above). Disabling the :3383 rethrow breaks this.
    expect(fetchCount).toBe(1)
    expect(apiErrorNotices(yielded).join('\n')).toContain(FILTER)
    expect(assistantTexts(yielded)).not.toContain('FALLBACK COMPLETE')

    const fallback = analyticsEvents.find(
      e => e.eventName === 'tengu_streaming_fallback_to_non_streaming',
    )
    expect(fallback).toBeDefined()
    expect(fallback?.metadata).toMatchObject({
      error: 'output_content_filtered',
      fallback_disabled: true,
      fallback_cause: 'output_content_filtered',
    })
  }, 20000)

  test('control: a NON-filter mid-stream error still falls back to non-streaming (fetchCount===2)', async () => {
    // Proves the harness CAN fall back, so the fetchCount===1 above is the g0
    // branch firing — not a broken stream that never reaches the fallback.
    responders.push(
      sseResponse([messageStart(), sseErrorEvent('Transient upstream failure', 'api_error')]),
      nonStreamingMessageResponse(),
    )

    const { yielded, error } = await runQuery()

    expect(error).toBeNull()
    expect(fetchCount).toBe(2)
    expect(assistantTexts(yielded)).toContain('FALLBACK COMPLETE')

    const fallback = analyticsEvents.find(
      e => e.eventName === 'tengu_streaming_fallback_to_non_streaming',
    )
    expect(fallback).toBeDefined()
    expect(fallback?.metadata).toMatchObject({ fallback_disabled: false })
  }, 20000)
})

afterAll(() => {
  // Flip the passthrough mock off — modules that resolved these bindings keep
  // the mock namespace for the rest of the shared single-process test run.
  vcrMockActive = false
})
