// The real query path computes a message fingerprint reading MACRO.VERSION
// (build-time constant polyfilled in cli.tsx). Mirror the repo-convention
// polyfill for test execution (context1mBetaHeal295Review /
// advisorHostGate032 discipline) — it must run before claude.ts is required
// below.
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
 * CC 2.1.304 (#22) — focused coverage for the `context-management-2025-06-27`
 * beta 400 heal (`retryContextManagementRefused` /
 * `markContextManagementBetaHealed` in claude.ts, wired through withRetry's
 * fatal-400 chain next to the context-1m hook).
 *
 * Official 304 shape (research-R3-session-api.md "#22", byte-verified): the
 * `M6t` heal map gains a `dde` arm whose classifier `Bgt` matches an HTTP 400
 * whose message includes `context_management: Extra inputs are not permitted`
 * on a request carrying the context-management beta; the verdict is
 * `uke = "retry:beta-rejected:context_management"` (@246856307) — resend once
 * WITHOUT the beta header, and the `context_management` request field
 * auto-omits through its existing beta-presence gate in `paramsFromContext`
 * (the changelog's "resends the request without that field").
 *
 * OCC port contract pinned here (mirrors the context1mBetaHeal295Review
 * heal contract, same bespoke request-scoped state machine):
 *   - a NAMED 400 (message includes the official field-rejection text) on a
 *     request that carried the beta latches idle→retrying, and withRetry
 *     resends ONCE with BOTH the `anthropic-beta` header entry AND the
 *     `context_management` body field gone (`attempt--`/`continue`, not
 *     charged to the retry budget);
 *   - a stripped resend that SUCCEEDS marks the heal on message_start and
 *     fires `tengu_beta_400_healed` exactly once with the #22 shape
 *     {beta, model, provider, status:400, unnamed:false};
 *   - a SECOND 400 on the stripped resend never heals again (one-shot latch
 *     flips retrying→spent) — no third send, no telemetry, the error surfaces
 *     on the normal non-retryable 400 path;
 *   - an UNRELATED 400 (classifier miss) on an eligible request does not
 *     heal.
 *
 * The closures are NOT exported (they capture `betas`, `options`, and
 * `lastRequestBetas` from the enclosing `queryModel`), so the ONLY way to
 * exercise the REAL logic is to drive `queryModelWithStreaming` end-to-end
 * against an HTTP-layer fetch mock and assert on the actual wire bytes —
 * each request's `anthropic-beta` header AND `context_management` body field.
 *
 * Field-presence prerequisites (all arranged in beforeEach/makeOptions):
 *   - firstParty + shouldIncludeFirstPartyOnlyBetas() (assume-first-party
 *     flag, no CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
 *   - modelSupportsContextManagement('claude-sonnet-4-6') — canonical name
 *     does not include 'claude-3-' → beta header pushed;
 *   - thinking ENABLED (hasThinking) and redact-thinking INACTIVE
 *     (getIsNonInteractiveSession() true — bootstrap STATE.isInteractive
 *     defaults false and is pinned false here) so getAPIContextManagement()
 *     returns the clear_thinking_20251015 edits and the field is present.
 */

// ---------------------------------------------------------------------------
// VCR pass-through mock (context1mBetaHeal295Review rationale: under
// `bun test` NODE_ENV='test' activates the record/replay layer, which would
// cache whole query results keyed by message content and never reach the
// fetch mock). Passthrough-FLAG pattern so a shared-process run keeps genuine
// VCR behavior for other files after afterAll(). Require claude.ts AFTER this
// mock so it binds the passthrough withStreamingVCR.
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
const { setIsInteractive } = require('../../../bootstrap/state.js') as {
  setIsInteractive: (value: boolean) => void
}
const { CONTEXT_MANAGEMENT_BETA_HEADER } = require('../../../constants/betas.js') as typeof import(
  '../../../constants/betas.js'
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// firstParty + modelSupportsContextManagement (canonical 'claude-sonnet-4-6'
// does not include 'claude-3-') → getModelBetas pushes
// CONTEXT_MANAGEMENT_BETA_HEADER; with thinking enabled the request body
// carries the `context_management` field — the fully-eligible heal case.
const MODEL = 'claude-sonnet-4-6'

// NAMED rejection (official `Bgt` classifier): status 400 AND the message
// includes the verbatim field-rejection text. The realistic wrapper proves
// the includes()-based match, not an equality match.
const NAMED_400 =
  'Invalid request: context_management: Extra inputs are not permitted'
// Classifier miss — a plain 400 that must NOT heal.
const GENERIC_400 = 'invalid x-api-key'

const PONG = 'PONG'

// Env isolation (context1mBetaHeal295Review list + the thinking /
// context-management knobs that would flip hasThinking, the redact-thinking
// beta, or the ant tool-clearing opt-in).
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
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CLAUDE_CODE_MAX_RETRIES',
  'USE_API_CONTEXT_MANAGEMENT',
  'USE_API_CLEAR_TOOL_RESULTS',
  'USE_API_CLEAR_TOOL_USES',
  'API_TIMEOUT_MS',
  'API_FORCE_IDLE_TIMEOUT',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch
let tmpConfigDir: string
let prevConfigDir: string | undefined

// ---------------------------------------------------------------------------
// HTTP-layer fetch mock (context1mBetaHeal295Review shape): capture every
// request's url/headers/body and shift one responder per call.
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
        `contextManagementBetaHeal304: unexpected fetch call #${requests.length} to ${url}`,
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
 *  markContextManagementBetaHealed() on a healed resend. */
function successSSEResponse(model = MODEL): () => Response {
  return () =>
    new Response(
      [
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_01CM304',
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
 *  exactly the shape the heal classifier reads. */
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
// Query driver (context1mBetaHeal295Review shape — captures yields AND the
// terminal error so declined-heal cases can assert on either surface).
// Thinking ENABLED so getAPIContextManagement() returns the edits and the
// `context_management` field rides along with the beta header.
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
      thinkingConfig: { type: 'enabled', budgetTokens: 4096 },
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

/** True when the request's `anthropic-beta` header carries the
 *  context-management beta. */
function hasContextManagementBeta(req: RecordedRequest): boolean {
  return (req.headers.get('anthropic-beta') ?? '').includes(
    CONTEXT_MANAGEMENT_BETA_HEADER,
  )
}

/** True when the request body carries the `context_management` field. */
function hasContextManagementField(req: RecordedRequest): boolean {
  return req.body !== undefined && 'context_management' in req.body
}

// ---------------------------------------------------------------------------
// Analytics capture — a REAL attached sink (context1mBetaHeal295Review
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
  // isFirstPartyAnthropicBaseUrl() true). Pin STATE.isInteractive=false so
  // getIsNonInteractiveSession() is true and the redact-thinking beta stays
  // OFF — otherwise isRedactThinkingActive would suppress
  // getAPIContextManagement() and the field would never ride along.
  setIsInteractive(false)
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-context-mgmt-heal-304-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()
  // getAllModelBetas/getModelBetas are memoized by model string; clear so a
  // shared-process run cannot reuse a beta list assembled under another
  // file's env (e.g. a different provider or betas-disabled state).
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
// 1. The heal fires: a NAMED 400 on a beta-carrying request latches
//    idle→retrying and resends ONCE without the beta header AND without the
//    `context_management` body field.
// ---------------------------------------------------------------------------
describe('CC 2.1.304 #22 — context-management beta 400 heal', () => {
  test(
    'named 400 → exactly one resend without the beta header and without the context_management field → success',
    async () => {
      // Arrange — attempt 1 is the named refusal, attempt 2 the stripped
      // resend that succeeds.
      responders = [error400(NAMED_400), successSSEResponse()]

      // Act — the REAL queryModelWithStreaming drives the heal closure.
      const { yielded, error } = await runQuery(MODEL)

      // Assert — two wire requests: the original carried BOTH the beta header
      // and the field; the resend carries NEITHER (paramsFromContext filters
      // the header while the heal is active and the field auto-omits through
      // its beta-presence gate).
      expect(error).toBeNull()
      expect(requests).toHaveLength(2)
      expect(hasContextManagementBeta(requests[0]!)).toBe(true)
      expect(hasContextManagementField(requests[0]!)).toBe(true)
      expect(hasContextManagementBeta(requests[1]!)).toBe(false)
      expect(hasContextManagementField(requests[1]!)).toBe(false)
      // The healed resend answered normally.
      expect(assistantText(yielded)).toBe(PONG)
      expect(apiErrorNotices(yielded)).toEqual([])
    },
    30000,
  )

  test(
    'successful stripped resend → tengu_beta_400_healed fires exactly once with the #22 shape (status:400, unnamed:false)',
    async () => {
      // Arrange
      responders = [error400(NAMED_400), successSSEResponse()]

      // Act
      await runQuery(MODEL)

      // Assert — telemetry fired EXACTLY once on message_start of the resend,
      // with the same shape markContext1mBetaHealed uses (the #22 recipe pins
      // unnamed:false for this named classifier).
      const healed = healedEvents()
      expect(healed).toHaveLength(1)
      const meta = healed[0]!.metadata as Record<string, unknown>
      expect(meta.beta).toBe(CONTEXT_MANAGEMENT_BETA_HEADER)
      expect(meta.model).toBe(MODEL)
      expect(meta.status).toBe(400)
      expect(meta.unnamed).toBe(false)
      expect(typeof meta.provider).toBe('string')
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 2. One-shot latch: a SECOND 400 on the stripped resend never heals again —
//    at most ONE beta-stripped resend per request (retrying→spent). No
//    telemetry (the resend never reached message_start).
// ---------------------------------------------------------------------------
describe('CC 2.1.304 #22 — heal is one-shot per request', () => {
  test(
    'named 400 then a second named 400 on the resend → no third send, no telemetry, error surfaces',
    async () => {
      // Arrange — both the original and the stripped resend are refused.
      responders = [error400(NAMED_400), error400(NAMED_400)]

      // Act
      const { yielded } = await runQuery(MODEL)

      // Assert — exactly ONE resend (2 sends total); the second 400 flips the
      // latch to spent and falls through to the normal non-retryable 400 path,
      // surfacing as an API error. No message_start → no tengu_beta_400_healed.
      expect(requests).toHaveLength(2)
      expect(hasContextManagementBeta(requests[0]!)).toBe(true)
      expect(hasContextManagementBeta(requests[1]!)).toBe(false)
      expect(healedEvents()).toHaveLength(0)
      expect(assistantText(yielded)).not.toBe(PONG)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 3. The classifier gate: a 400 whose message does not include the official
//    field-rejection text is someone else's error and must not heal.
// ---------------------------------------------------------------------------
describe('CC 2.1.304 #22 — heal gate declines when not eligible', () => {
  test(
    'classifier gate: an unrelated 400 on an eligible beta-carrying request does not heal',
    async () => {
      // Arrange — the request is fully eligible (beta header + field), but the
      // 400 message matches neither the field-rejection text nor any heal
      // classifier (an auth error, not a beta rejection).
      responders = [error400(GENERIC_400), successSSEResponse()]

      // Act
      const { yielded } = await runQuery(MODEL)

      // Assert — the beta and field rode along, yet the unrelated 400 is not
      // healed: single send, no telemetry, error surfaces.
      expect(requests).toHaveLength(1)
      expect(hasContextManagementBeta(requests[0]!)).toBe(true)
      expect(hasContextManagementField(requests[0]!)).toBe(true)
      expect(healedEvents()).toHaveLength(0)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )
})
