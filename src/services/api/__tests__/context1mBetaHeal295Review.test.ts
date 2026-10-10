// The real query path computes a message fingerprint reading MACRO.VERSION
// (build-time constant polyfilled in cli.tsx). Mirror the repo-convention
// polyfill for test execution (streamIntegrity281 / advisorHostGate032
// discipline) — it must run before claude.ts is required below.
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
 * CC 2.1.295 (item-1) — focused coverage for the `context-1m-2025-08-07`
 * beta 400 heal state machine (Code Review P1 must-fix #1).
 *
 * claude.ts:~2215-2360 adds a request-scoped state machine
 * (`idle`→`retrying`/`guessing`→`spent`/`unproven`) plus three closures —
 * `retryContext1mBetaRefused` (the withRetry fatal-400 hook, official `qtt`),
 * `markContext1mBetaHealed` (the success mark, official `Ztt`), and
 * `isContext1mHealActive` (official `SEe`, driving the params-builder beta
 * strip). None were exported and none had coverage: the reviewer's mutation
 * (`return false` at the top of `retryContext1mBetaRefused`, i.e. heal never
 * fires) left the whole suite green.
 *
 * The closures are NOT exported (they capture `betas`, `options`, and
 * `lastRequestBetas` from the enclosing `queryModel`), so the ONLY way to
 * exercise the REAL logic is to drive `queryModelWithStreaming` end-to-end.
 * Like advisorHostGate032 / nonstreamingCapProduction288, this file installs
 * an HTTP-layer fetch mock and asserts on the actual wire bytes — the
 * `anthropic-beta` header of each request — plus the `tengu_beta_400_healed`
 * telemetry captured through a real attached analytics sink.
 *
 * Heal contract pinned here:
 *   - a NAMED 400 (message carries the header / "long context beta") on a
 *     request that carried the beta for a 1M-capable model latches
 *     idle→retrying, and withRetry resends ONCE with the beta stripped
 *     (`attempt--`/`continue`, not charged to the retry budget);
 *   - an UNNAMED 400 ("invalid beta flag") latches idle→guessing instead;
 *   - a stripped resend that SUCCEEDS marks the beta spent and fires
 *     `tengu_beta_400_healed` exactly once ({beta,model,provider,status:400,
 *     unnamed}) — unnamed:false for the named/retrying path, true for
 *     guessing;
 *   - a SECOND 400 on the stripped resend never heals again (at most ONE
 *     beta-stripped resend per request): retrying→unproven, or
 *     guessing→spent when the second 400 is also unnamed;
 *   - the heal is gated OFF when the request did not carry the beta, when
 *     `modelSupports1M(options.model)` is false, or when the 400 is neither
 *     named nor unnamed.
 *
 * Documented deviation (faithfully reproduced, NOT a bug): OCC has no surface
 * for the official per-model spent registry (`$wr`), so the heal state is
 * REQUEST-SCOPED — a fresh `queryModel` call starts at `idle` and may heal
 * again. The top-of-handler `spent` short-circuit is therefore defensive
 * within a single request (a successful heal ends the attempt loop, so no
 * further 400 can arrive in the same request); it is not separately drivable
 * through the streaming path and is noted rather than forced.
 */

// ---------------------------------------------------------------------------
// VCR pass-through mock (streamIntegrity281 / nonstreamingCapProduction288
// rationale: under `bun test` NODE_ENV='test' activates the record/replay
// layer, which would cache whole query results keyed by message content and
// never reach the fetch mock). Passthrough-FLAG pattern so a shared-process
// run keeps genuine VCR behavior for other files after afterAll(). Require
// claude.ts AFTER this mock so it binds the passthrough withStreamingVCR.
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
      : (
          realVcr.withStreamingVCR as (
            ...a: unknown[]
          ) => AsyncGenerator<never, void>
        )(messages, f, ...rest)) as typeof realVcr.withStreamingVCR,
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
const { clearBetasCaches } = require('../../../utils/betas.js') as {
  clearBetasCaches: () => void
}
const { CONTEXT_1M_BETA_HEADER } = require('../../../constants/betas.js') as typeof import(
  '../../../constants/betas.js'
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// Carries the 1M beta (getModelBetas pushes it whenever has1mContext(model))
// AND modelSupports1M() is true (canonical includes 'claude-sonnet-4') — the
// fully-eligible heal case.
const MODEL_1M = 'claude-sonnet-4-6[1m]'
// The normalized wire model the API echoes back (normalizeModelStringForAPI
// strips the [1m] suffix) — used for the success SSE envelope.
const MODEL_1M_WIRE = 'claude-sonnet-4-6'
// Carries the 1M beta (has1mContext is a pure suffix test) but
// modelSupports1M() is FALSE (canonical 'claude-3-5-sonnet' matches none of
// the sonnet-4/5, haiku-5, opus-4-6/7/8, opus-5 families) — isolates the
// modelSupports1M gate.
const MODEL_NO_1M_SUPPORT = 'claude-3-5-sonnet[1m]'
// No [1m] suffix and getSonnet1mExpTreatmentEnabled() is false with an empty
// clientDataCache, so the request carries NO 1M beta — isolates the
// betasCarried1m gate.
const MODEL_NO_BETA = 'claude-sonnet-4-6'

// NAMED rejection (official `Yie`): status 400 AND the message includes the
// beta header (or "long context beta"). Deliberately avoids the advisor
// classifier patterns and "invalid beta flag" so it is named-only.
const NAMED_400 = `the ${CONTEXT_1M_BETA_HEADER} beta header is not supported for this model`
// UNNAMED rejection (official `iN`): status 400 AND the lowercased message
// includes "invalid beta flag", with NO header / "long context beta" text.
const UNNAMED_400 = 'invalid beta flag provided in the request'
// Neither named nor unnamed — a plain 400 that must NOT heal.
const GENERIC_400 = 'invalid x-api-key'

const PONG = 'PONG'

// Env isolation (nonstreamingCapProduction288 list + the 1M/beta knobs that
// would flip has1mContext / modelSupports1M / getSonnet1mExpTreatmentEnabled).
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
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_MAX_RETRIES',
  'API_TIMEOUT_MS',
  'API_FORCE_IDLE_TIMEOUT',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch
let tmpConfigDir: string
let prevConfigDir: string | undefined

// ---------------------------------------------------------------------------
// HTTP-layer fetch mock (advisorHostGate032 shape): capture every request's
// url/headers/body and shift one responder per call.
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
        `context1mBetaHeal295Review: unexpected fetch call #${requests.length} to ${url}`,
      )
    }
    return responder()
  }) as typeof fetch
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A minimal successful streaming assistant turn (message_start → PONG →
 *  message_stop). message_start is the site that calls
 *  markContext1mBetaHealed() on a healed resend. */
function successSSEResponse(model = MODEL_1M_WIRE): () => Response {
  return () =>
    new Response(
      [
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_01HEAL',
            type: 'message',
            role: 'assistant',
            model,
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
          delta: { type: 'text_delta', text: PONG },
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

/** A 400 whose body message is `message` — the SDK's `.withResponse()` turns
 *  this into an APIError with `.status === 400` and `.message === message`,
 *  exactly the shape the heal classifiers read. */
function error400(message: string): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
}

// ---------------------------------------------------------------------------
// Query driver (nonstreamingCapProduction288 shape — captures yields AND the
// terminal error so declined-heal cases can assert on either surface).
// ---------------------------------------------------------------------------
function makeOptions(model: string): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model,
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
}

async function runQuery(model: string): Promise<{
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
      options: makeOptions(model),
    })
    for await (const item of gen) {
      yielded.push(item as YieldedItem)
    }
  } catch (err) {
    error = err
  }
  return { yielded, error }
}

function assistantText(yielded: YieldedItem[]): string {
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
  return texts.join('')
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

/** True when the request's `anthropic-beta` header carries the 1M beta. */
function hasContext1mBeta(req: RecordedRequest): boolean {
  return (req.headers.get('anthropic-beta') ?? '').includes(
    CONTEXT_1M_BETA_HEADER,
  )
}

// ---------------------------------------------------------------------------
// Analytics capture — a REAL attached sink (advisorEntryRefusedRetry276
// discipline), no mock.module. attachAnalyticsSink is idempotent, so
// resetAnalyticsForTesting() (sink=null, queue cleared) MUST run first.
// ---------------------------------------------------------------------------
let analyticsEvents: Array<{ eventName: string; metadata: unknown }> = []

function attachCapturingSink(): void {
  analyticsEvents = []
  attachAnalyticsSink({
    logEvent: (eventName, metadata) => {
      analyticsEvents.push({ eventName, metadata })
    },
    logEventAsync: async (eventName, metadata) => {
      analyticsEvents.push({ eventName, metadata })
    },
  })
}

function healedEvents(): Array<{ eventName: string; metadata: unknown }> {
  return analyticsEvents.filter(e => e.eventName === 'tengu_beta_400_healed')
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
  // Deterministic firstParty + API-key auth (the assume-first-party flag keeps
  // isFirstPartyAnthropicBaseUrl() true). 1M context stays ENABLED (the
  // disable env is cleared above) so has1mContext / modelSupports1M are live.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-context1m-heal-295-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()
  // getAllModelBetas/getModelBetas are memoized by model string; clear so a
  // shared-process run cannot reuse a beta list assembled under another
  // file's env (e.g. a different provider or 1M-disabled state).
  clearBetasCaches()

  resetAnalyticsForTesting()
  attachCapturingSink()

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
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()
  clearBetasCaches()
  rmSync(tmpConfigDir, { recursive: true, force: true })
  resetAnalyticsForTesting()
})

afterAll(() => {
  vcrMockActive = false
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. The heal fires: a NAMED 400 on a beta-carrying 1M request latches
//    idle→retrying, resends ONCE without the beta, and marks spent on success.
// ---------------------------------------------------------------------------
describe('CC 2.1.295 item-1 — context-1m beta 400 heal (named / retrying)', () => {
  test(
    'named 400 → exactly one beta-stripped resend that succeeds → tengu_beta_400_healed once (unnamed:false)',
    async () => {
      // Arrange — attempt 1 is the named refusal, attempt 2 the stripped
      // resend that succeeds.
      responders = [error400(NAMED_400), successSSEResponse()]

      // Act — the REAL queryModelWithStreaming drives the heal closure.
      const { yielded, error } = await runQuery(MODEL_1M)

      // Assert — two wire requests: the original carried the beta, the resend
      // did NOT (paramsFromContext strips it while the heal is active).
      expect(error).toBeNull()
      expect(requests).toHaveLength(2)
      expect(hasContext1mBeta(requests[0]!)).toBe(true)
      expect(hasContext1mBeta(requests[1]!)).toBe(false)
      // The healed resend answered normally.
      expect(assistantText(yielded)).toBe(PONG)
      expect(apiErrorNotices(yielded)).toEqual([])
      // Telemetry fired EXACTLY once on message_start with the named shape.
      const healed = healedEvents()
      expect(healed).toHaveLength(1)
      const meta = healed[0]!.metadata as Record<string, unknown>
      expect(meta.beta).toBe(CONTEXT_1M_BETA_HEADER)
      expect(meta.model).toBe(MODEL_1M)
      expect(meta.status).toBe(400)
      expect(meta.unnamed).toBe(false)
      expect(typeof meta.provider).toBe('string')
    },
    30000,
  )

  test(
    'unnamed "invalid beta flag" 400 → idle→guessing heal, stripped resend succeeds → telemetry once (unnamed:true)',
    async () => {
      // Arrange
      responders = [error400(UNNAMED_400), successSSEResponse()]

      // Act
      const { yielded, error } = await runQuery(MODEL_1M)

      // Assert — same one-shot strip-and-resend, but the guessing path marks
      // the telemetry `unnamed:true`.
      expect(error).toBeNull()
      expect(requests).toHaveLength(2)
      expect(hasContext1mBeta(requests[0]!)).toBe(true)
      expect(hasContext1mBeta(requests[1]!)).toBe(false)
      expect(assistantText(yielded)).toBe(PONG)
      const healed = healedEvents()
      expect(healed).toHaveLength(1)
      expect((healed[0]!.metadata as Record<string, unknown>).unnamed).toBe(
        true,
      )
      expect((healed[0]!.metadata as Record<string, unknown>).status).toBe(400)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 2. One-shot latch: a SECOND 400 on the stripped resend never heals again —
//    at most ONE beta-stripped resend per request (retrying→unproven, or
//    guessing→spent when the second 400 is also unnamed). No telemetry (the
//    resend never reached message_start).
// ---------------------------------------------------------------------------
describe('CC 2.1.295 item-1 — heal is one-shot per request', () => {
  test(
    'named 400 then a second named 400 on the resend → no third send, no telemetry (retrying→unproven)',
    async () => {
      // Arrange — both the original and the stripped resend are refused.
      responders = [error400(NAMED_400), error400(NAMED_400)]

      // Act
      const { yielded } = await runQuery(MODEL_1M)

      // Assert — exactly ONE resend (2 sends total); the second 400 is not
      // healed, so it falls through to the normal non-retryable 400 path and
      // surfaces as an API error. No message_start → no tengu_beta_400_healed.
      expect(requests).toHaveLength(2)
      expect(hasContext1mBeta(requests[0]!)).toBe(true)
      expect(hasContext1mBeta(requests[1]!)).toBe(false)
      expect(healedEvents()).toHaveLength(0)
      expect(assistantText(yielded)).not.toBe(PONG)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )

  test(
    'unnamed 400 then a second unnamed 400 on the resend → no third send, no telemetry (guessing→spent)',
    async () => {
      // Arrange — the guessing arm flips to `spent` when the second 400 is
      // ALSO unnamed (the ternary's true branch), vs `unproven` above.
      responders = [error400(UNNAMED_400), error400(UNNAMED_400)]

      // Act
      const { yielded } = await runQuery(MODEL_1M)

      // Assert — one-shot holds on the guessing path too.
      expect(requests).toHaveLength(2)
      expect(hasContext1mBeta(requests[1]!)).toBe(false)
      expect(healedEvents()).toHaveLength(0)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 3. The heal gate — each early-return arm of retryContext1mBetaRefused.
// ---------------------------------------------------------------------------
describe('CC 2.1.295 item-1 — heal gate declines when not eligible', () => {
  test(
    'modelSupports1M gate: a beta-carrying request for a NON-1M-capable model does not heal',
    async () => {
      // Arrange — claude-3-5-sonnet[1m] carries the beta (has1mContext is a
      // pure suffix test) but modelSupports1M() is false, so the gate declines.
      responders = [error400(NAMED_400), successSSEResponse(MODEL_NO_1M_SUPPORT)]

      // Act
      const { yielded } = await runQuery(MODEL_NO_1M_SUPPORT)

      // Assert — the request DID carry the beta (proving the decline is the
      // modelSupports1M arm, not betasCarried1m), yet there is NO resend and
      // NO telemetry; the 400 surfaces as an API error.
      expect(requests).toHaveLength(1)
      expect(hasContext1mBeta(requests[0]!)).toBe(true)
      expect(healedEvents()).toHaveLength(0)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )

  test(
    'betasCarried1m gate: a named 400 on a request WITHOUT the beta does not heal',
    async () => {
      // Arrange — claude-sonnet-4-6 (no [1m], exp treatment off) carries no
      // 1M beta; a named 400 is therefore someone else's error.
      responders = [error400(NAMED_400), successSSEResponse(MODEL_NO_BETA)]

      // Act
      const { yielded } = await runQuery(MODEL_NO_BETA)

      // Assert — no beta on the wire, no resend, no telemetry.
      expect(requests).toHaveLength(1)
      expect(hasContext1mBeta(requests[0]!)).toBe(false)
      expect(healedEvents()).toHaveLength(0)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )

  test(
    'classifier gate: a 400 that is neither named nor "invalid beta flag" does not heal',
    async () => {
      // Arrange — an eligible 1M beta-carrying request, but the 400 message
      // matches neither classifier (an auth error, not a beta rejection).
      responders = [error400(GENERIC_400), successSSEResponse()]

      // Act
      const { yielded } = await runQuery(MODEL_1M)

      // Assert — the beta rode along, yet the unrelated 400 is not healed.
      expect(requests).toHaveLength(1)
      expect(hasContext1mBeta(requests[0]!)).toBe(true)
      expect(healedEvents()).toHaveLength(0)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )
})
