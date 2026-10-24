// The real query path computes a message fingerprint reading MACRO.VERSION
// (build-time constant polyfilled in cli.tsx). Mirror the repo-convention
// polyfill for test execution (contextManagementBetaHeal304 /
// context1mBetaHeal295Review discipline) — it must run before claude.ts is
// required below.
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

/**
 * CC 2.1.310 (WP-api item-2) — focused coverage for the effort-beta 400 heal
 * (`retryEffortRefused` / the `$K`-faithful detector / the per-model
 * effort-unsupported latch in claude.ts, wired through withRetry's fatal-400
 * chain next to the context-1m / context_management hooks).
 *
 * Official 310 shape (triage-T1.md item 2, byte-verified against the 2.1.310
 * ELF):
 *   - detector `$K` (@248256506): `function $K(e){if(!(e instanceof Dt)||
 *     e.status!==400)return!1;if(rwe(e)!==null)return!1;let n=e.message
 *     .toLowerCase();if(n.includes("effort parameter")&&n.includes("not
 *     support"))return!0;if(n.includes("output_config")&&n.includes("effort")
 *     &&n.includes("extra inputs are not permitted"))return!0;return ID(e
 *     .message,"effort_unsupported")||FK(e,tbe)}` — the 309→310 delta is the
 *     new `||FK(e,tbe)` arm (beta-header refusal matcher `b8t`);
 *   - `ID` (@248256xxx, with `uMo(e){return`${gm}${e}`}`,
 *     `gm="capability_rejected: "`): substring match on
 *     `capability_rejected: <token>` with a right-boundary check (the char
 *     after the match must not be [A-Za-z0-9_:.-] or must be end-of-string);
 *   - `b8t`: `/^Unexpected value\(s\) ((?:`[^`]+`(?:, )?)+) for the
 *     `anthropic[-_]beta`/` against `jbe(e)` (first line of
 *     `e.error?.error?.message`, else `e.message` with a leading `^\d{3} `
 *     status prefix stripped) — the captured backtick list must include
 *     `` `effort-2025-11-24` `` — OR `ID(e.message,
 *     `beta_header:effort-2025-11-24`)`;
 *   - `rwe`/`mMo` thinking-type exclusion (@245175709): a 400 whose message
 *     parses as a thinking-type refusal (`thinking.type … enabled|adaptive …
 *     not supported`, `adaptive thinking is not supported`, or the
 *     capability_rejected thinking_type tokens) is NOT an effort refusal;
 *   - heal arm `x_t` (@249531868): latches the model into the process-wide
 *     effort-unsupported registry (`gAn(Q.model)`, plus the resolved wire
 *     model when different), logs the verbatim warn text, fires
 *     `tengu_effort_unsupported_retry` {model: wt(model)}, verdict
 *     `"retry:effort-unsupported"` — resend WITHOUT `output_config.effort`
 *     AND without the `effort-2025-11-24` beta; the latch is consulted by the
 *     effort capability readers (`Tw`: `if(qdr(e))return!1`) so this process
 *     never sends either to this model again (`JCs` delete-first gate).
 *
 * OCC port contract pinned here:
 *   - the exported detector accepts each official error shape and rejects
 *     unrelated 400s, non-400s, boundary-violating tokens and thinking-type
 *     refusals;
 *   - an effort-refusal 400 on an effort-carrying request resends ONCE with
 *     BOTH the `anthropic-beta` header entry AND `output_config.effort` gone
 *     (`attempt--`/`continue`, not charged to the retry budget), and
 *     `tengu_effort_unsupported_retry` fires exactly once;
 *   - a SECOND effort-refusal 400 on the stripped resend never heals again
 *     (one-shot per-request state, mirroring the context_management heal);
 *   - the latch is process-wide: a SUBSEQUENT request for the same model
 *     omits effort + beta from its very first attempt;
 *   - `configureEffortParams` consults the latch in its delete-first gate
 *     (even an EXTRA_BODY-injected `output_config.effort` is removed).
 *
 * The heal closure is NOT exported (it captures `options` and the per-request
 * state from the enclosing `queryModel`), so the heal is exercised by driving
 * `queryModelWithStreaming` end-to-end against an HTTP-layer fetch mock and
 * asserting on the actual wire bytes — each request's `anthropic-beta` header
 * AND `output_config` body field (contextManagementBetaHeal304 discipline).
 */

// ---------------------------------------------------------------------------
// VCR pass-through mock (contextManagementBetaHeal304 rationale: under
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

// ---------------------------------------------------------------------------
// Analytics pass-through capture mock (OCC-132 full-suite hardening): 48
// pre-existing test files mock.module this module and bun's mock.restore()
// does not undo mock.module overrides, so by the time this file runs inside a
// shared-process `bun test src`, `logEvent` may already be another file's stub
// that never consults sinks — starving the attachAnalyticsSink-based capture
// (3 integration tests failed with 0 telemetry events in the full run while
// green standalone). Flag-gated passthrough (same pattern as the VCR mock
// above): while this file runs, logEvent/logEventAsync are captured locally
// AND forwarded to the file-entry module state; after afterAll flips the flag
// the registered mock delegates purely, leaving later files exactly as they
// were. Eager spread copy — a bare namespace has LIVE bindings that bun's
// mock.module patches in place.
// ---------------------------------------------------------------------------
const ANALYTICS_MODULE_PATH = '../../analytics/index.js'
const realAnalytics = { ...(await import(ANALYTICS_MODULE_PATH)) }
let analyticsMockActive = true
let analyticsEvents: Array<{ eventName: string; metadata: unknown }> = []
mock.module(ANALYTICS_MODULE_PATH, () => ({
  ...realAnalytics,
  logEvent: ((eventName: string, metadata: unknown) => {
    if (analyticsMockActive) {
      analyticsEvents.push({ eventName, metadata })
    }
    return (
      realAnalytics.logEvent as
        | ((e: string, m: unknown) => unknown)
        | undefined
    )?.(eventName, metadata)
  }) as typeof realAnalytics.logEvent,
  logEventAsync: (async (eventName: string, metadata: unknown) => {
    if (analyticsMockActive) {
      analyticsEvents.push({ eventName, metadata })
    }
    return (
      realAnalytics.logEventAsync as
        | ((e: string, m: unknown) => Promise<unknown>)
        | undefined
    )?.(eventName, metadata)
  }) as typeof realAnalytics.logEventAsync,
}))

const {
  queryModelWithStreaming,
  isEffortRefusedError,
  markEffortUnsupported,
  isEffortUnsupported,
  resetEffortUnsupportedLatchesForTesting,
  configureEffortParams,
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
const { clearBetasCaches } = require('../../../utils/betas.js') as {
  clearBetasCaches: () => void
}
const { setIsInteractive } = require('../../../bootstrap/state.js') as {
  setIsInteractive: (value: boolean) => void
}
const { EFFORT_BETA_HEADER } = require('../../../constants/betas.js') as typeof import(
  '../../../constants/betas.js'
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// firstParty + modelSupportsEffort ('sonnet-4-6' is in the allowlist) with an
// explicit effortValue → configureEffortParams sets output_config.effort AND
// pushes EFFORT_BETA_HEADER — the fully-eligible heal case.
const MODEL = 'claude-sonnet-4-6'

// Official error shapes (detector acceptance cases).
const CAPABILITY_REJECTED_EFFORT =
  '400 capability_rejected: effort_unsupported'
const UNEXPECTED_VALUES_WITH_EFFORT =
  'Unexpected value(s) `effort-2025-11-24`, `context-1m-2025-08-07` for the `anthropic-beta` header.'
const CAPABILITY_REJECTED_BETA_HEADER =
  '400 capability_rejected: beta_header:effort-2025-11-24 is not available for this organization.'
const LEGACY_EFFORT_PARAMETER =
  'The effort parameter is not supported for this model.'
const LEGACY_OUTPUT_CONFIG_EXTRA_INPUTS =
  'output_config.effort: Extra inputs are not permitted'

// Detector rejection cases.
const GENERIC_400 = 'invalid x-api-key'

const PONG = 'PONG'

// Env isolation (contextManagementBetaHeal304 list + the effort knob that
// would flip resolveAppliedEffort).
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
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
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
// HTTP-layer fetch mock (contextManagementBetaHeal304 shape): capture every
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
        `effortBetaHeal310: unexpected fetch call #${requests.length} to ${url}`,
      )
    }
    return responder()
  }) as typeof fetch
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A minimal successful streaming assistant turn (message_start → PONG →
 *  message_stop). */
function successSSEResponse(model = MODEL): () => Response {
  return () =>
    new Response(
      [
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_01EFF310',
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
 *  this into an APIError with `.status === 400`, `.message` derived as
 *  `${status} ${body.error.message}`, and `.error` = the parsed body, exactly
 *  the shape the official detector (`$K`/`jbe`) reads. */
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
// Detector unit-test helpers — construct APIErrors the way the SDK does.
// ---------------------------------------------------------------------------
/** APIError whose `.message` is `${status} ${bodyMessage}` and whose body has
 *  the real `{type, error:{type, message}}` envelope (jbe's preferred
 *  `e.error?.error?.message` branch). */
function apiErrorWithBody(
  status: number,
  bodyMessage: string,
): APIError {
  return new APIError(
    status,
    { type: 'error', error: { type: 'invalid_request_error', message: bodyMessage } },
    `${status} ${bodyMessage}`,
    undefined,
  )
}

/** APIError whose body has NO nested error.error.message, so jbe takes the
 *  `e.message` fallback branch (the SDK ctor builds e.message as
 *  `${status} ${body.message}` — exactly the real-world `^\d{3} `-prefixed
 *  shape that branch strips). */
function apiErrorWithMessageOnly(status: number, message: string): APIError {
  return new APIError(status, { message }, message, undefined)
}

// ---------------------------------------------------------------------------
// Query driver (contextManagementBetaHeal304 shape — captures yields AND the
// terminal error so declined-heal cases can assert on either surface).
// effortValue 'high' → resolveAppliedEffort returns 'high' →
// configureEffortParams sets output_config.effort + pushes the beta header.
// ---------------------------------------------------------------------------
function makeOptions(model: string): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model,
    effortValue: 'high',
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

/** True when the request's `anthropic-beta` header carries the effort beta. */
function hasEffortBeta(req: RecordedRequest): boolean {
  return (req.headers.get('anthropic-beta') ?? '').includes(
    EFFORT_BETA_HEADER,
  )
}

/** The request body's `output_config.effort` value, when present. */
function wireEffort(req: RecordedRequest): unknown {
  const outputConfig = req.body?.output_config as
    | { effort?: unknown }
    | undefined
  return outputConfig?.effort
}

// ---------------------------------------------------------------------------
// Analytics capture — via the passthrough mock registered above (NOT
// attachAnalyticsSink: under full-suite pollution the sink dispatch inside the
// real logEvent may already be stubbed out by an earlier file, and attaching a
// sink alongside the mock capture would double-count when the module is
// pristine). resetAnalyticsForTesting() (sink=null, queue cleared) MUST still
// run first so no OTHER file's stale sink double-receives via the forward.
// ---------------------------------------------------------------------------
function attachCapturingSink(): void {
  analyticsEvents = []
}

function effortRetryEvents(): Array<{
  eventName: string
  metadata: unknown
}> {
  return analyticsEvents.filter(
    e => e.eventName === 'tengu_effort_unsupported_retry',
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
  // Deterministic firstParty + API-key auth (the assume-first-party flag keeps
  // isFirstPartyAnthropicBaseUrl() true).
  setIsInteractive(false)
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-effort-heal-310-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()
  // getAllModelBetas/getModelBetas are memoized by model string; clear so a
  // shared-process run cannot reuse a beta list assembled under another
  // file's env (e.g. a different provider or betas-disabled state).
  clearBetasCaches()

  // The latch is process-wide — each test starts from an unlatched state.
  resetEffortUnsupportedLatchesForTesting()

  if (typeof resetAnalyticsForTesting === 'function') resetAnalyticsForTesting()
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
  resetEffortUnsupportedLatchesForTesting()
  rmSync(tmpConfigDir, { recursive: true, force: true })
  if (typeof resetAnalyticsForTesting === 'function') resetAnalyticsForTesting()
})

afterAll(() => {
  vcrMockActive = false
  analyticsMockActive = false
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. Detector unit coverage — official `$K` (@248256506) acceptance and
//    rejection shapes.
// ---------------------------------------------------------------------------
describe('CC 2.1.310 item-2 — effort-refusal detector ($K port)', () => {
  test('accepts a capability_rejected effort_unsupported 400 (ID arm)', () => {
    expect(
      isEffortRefusedError(apiErrorWithBody(400, 'capability_rejected: effort_unsupported')),
    ).toBe(true)
    // The `400 ` status prefix variant (SDK-derived message).
    expect(isEffortRefusedError(apiErrorWithMessageOnly(400, CAPABILITY_REJECTED_EFFORT))).toBe(
      true,
    )
  })

  test('accepts the Unexpected value(s) beta-list 400 when the list names the effort header (b8t regex arm)', () => {
    expect(
      isEffortRefusedError(apiErrorWithBody(400, UNEXPECTED_VALUES_WITH_EFFORT)),
    ).toBe(true)
    // jbe fallback branch: body without a nested error.error.message →
    // e.message (SDK ctor prepends the `400 ` status prefix) with that
    // ^\d{3} prefix stripped, first line only.
    expect(
      isEffortRefusedError(
        apiErrorWithMessageOnly(400, UNEXPECTED_VALUES_WITH_EFFORT),
      ),
    ).toBe(true)
  })

  test('accepts a capability_rejected beta_header:effort-2025-11-24 400 (b8t ID arm)', () => {
    expect(
      isEffortRefusedError(
        apiErrorWithBody(400, 'capability_rejected: beta_header:effort-2025-11-24 is not available for this organization.'),
      ),
    ).toBe(true)
    expect(
      isEffortRefusedError(apiErrorWithMessageOnly(400, CAPABILITY_REJECTED_BETA_HEADER)),
    ).toBe(true)
  })

  test('accepts the two pre-310 message conditions (effort parameter / output_config extra-inputs)', () => {
    expect(isEffortRefusedError(apiErrorWithBody(400, LEGACY_EFFORT_PARAMETER))).toBe(true)
    expect(
      isEffortRefusedError(apiErrorWithBody(400, LEGACY_OUTPUT_CONFIG_EXTRA_INPUTS)),
    ).toBe(true)
  })

  test('rejects an Unexpected value(s) list that does NOT name the effort header', () => {
    expect(
      isEffortRefusedError(
        apiErrorWithBody(
          400,
          'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header.',
        ),
      ),
    ).toBe(false)
  })

  test('rejects unrelated 400s, non-400 statuses and boundary-violating tokens', () => {
    // Classifier miss — a plain auth 400.
    expect(isEffortRefusedError(apiErrorWithBody(400, GENERIC_400))).toBe(false)
    // Non-400 status gate — the same text at 422 is NOT an effort refusal.
    expect(
      isEffortRefusedError(apiErrorWithBody(422, 'capability_rejected: effort_unsupported')),
    ).toBe(false)
    // ID right-boundary check: `effort_unsupported_v2` does not match
    // (`_` ∈ [A-Za-z0-9_:.-]).
    expect(
      isEffortRefusedError(apiErrorWithBody(400, 'capability_rejected: effort_unsupported_v2')),
    ).toBe(false)
    // Without the `capability_rejected: ` prefix the ID arm does not fire.
    expect(isEffortRefusedError(apiErrorWithBody(400, 'effort_unsupported'))).toBe(false)
    // jbe first-line semantics: the regex arm only reads the FIRST line.
    expect(
      isEffortRefusedError(
        apiErrorWithBody(
          400,
          `Invalid request\n${UNEXPECTED_VALUES_WITH_EFFORT}`,
        ),
      ),
    ).toBe(false)
  })

  test('rejects thinking-type refusals (rwe exclusion) even when effort words appear', () => {
    // mMo regex 1: thinking.type … enabled … not supported.
    expect(
      isEffortRefusedError(
        apiErrorWithBody(
          400,
          'thinking.type: `enabled` is not supported together with the effort parameter',
        ),
      ),
    ).toBe(false)
    // mMo regex 2: adaptive thinking is not supported.
    expect(
      isEffortRefusedError(
        apiErrorWithBody(400, 'adaptive thinking is not supported for this model'),
      ),
    ).toBe(false)
    // capability_rejected thinking_type tokens.
    expect(
      isEffortRefusedError(
        apiErrorWithBody(400, 'capability_rejected: thinking_type:enabled'),
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. The heal fires end-to-end: an effort-refusal 400 on an effort-carrying
//    request resends ONCE without the beta header AND without
//    output_config.effort, and fires tengu_effort_unsupported_retry once.
// ---------------------------------------------------------------------------
describe('CC 2.1.310 item-2 — effort-beta 400 heal', () => {
  test(
    'effort refusal → exactly one resend without the beta header and without output_config.effort → success + telemetry',
    async () => {
      // Arrange — attempt 1 is the refusal, attempt 2 the stripped resend
      // that succeeds.
      responders = [error400(CAPABILITY_REJECTED_EFFORT), successSSEResponse()]

      // Act — the REAL queryModelWithStreaming drives the heal closure.
      const { yielded, error } = await runQuery(MODEL)

      // Assert — two wire requests: the original carried BOTH the effort beta
      // header and output_config.effort; the resend carries NEITHER (the
      // latch gates configureEffortParams on the rebuild).
      expect(error).toBeNull()
      expect(requests).toHaveLength(2)
      expect(hasEffortBeta(requests[0]!)).toBe(true)
      expect(wireEffort(requests[0]!)).toBe('high')
      expect(hasEffortBeta(requests[1]!)).toBe(false)
      expect(wireEffort(requests[1]!)).toBeUndefined()
      // The healed resend answered normally.
      expect(assistantText(yielded)).toBe(PONG)
      expect(apiErrorNotices(yielded)).toEqual([])
      // Official telemetry: `a("tengu_effort_unsupported_retry",{model:wt(Q.model)})`
      // — fired exactly once, conforming model id passes through wt.
      const events = effortRetryEvents()
      expect(events).toHaveLength(1)
      expect((events[0]!.metadata as Record<string, unknown>).model).toBe(MODEL)
      // The latch is process-wide and now holds this model.
      expect(isEffortUnsupported(MODEL)).toBe(true)
    },
    30000,
  )

  test(
    'beta-list refusal shape also heals (b8t regex arm end-to-end)',
    async () => {
      // Arrange
      responders = [
        error400(UNEXPECTED_VALUES_WITH_EFFORT),
        successSSEResponse(),
      ]

      // Act
      const { yielded, error } = await runQuery(MODEL)

      // Assert
      expect(error).toBeNull()
      expect(requests).toHaveLength(2)
      expect(hasEffortBeta(requests[0]!)).toBe(true)
      expect(hasEffortBeta(requests[1]!)).toBe(false)
      expect(wireEffort(requests[1]!)).toBeUndefined()
      expect(assistantText(yielded)).toBe(PONG)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 3. One-shot per request: a SECOND effort-refusal 400 on the stripped resend
//    never heals again — at most ONE stripped resend per request.
// ---------------------------------------------------------------------------
describe('CC 2.1.310 item-2 — heal is one-shot per request', () => {
  test(
    'refusal then a second refusal on the resend → no third send, error surfaces, telemetry once',
    async () => {
      // Arrange — both the original and the stripped resend are refused.
      responders = [
        error400(CAPABILITY_REJECTED_EFFORT),
        error400(CAPABILITY_REJECTED_EFFORT),
      ]

      // Act
      const { yielded } = await runQuery(MODEL)

      // Assert — exactly ONE resend (2 sends total); the second refusal flips
      // the per-request state to spent and falls through to the normal
      // non-retryable 400 path. tengu_effort_unsupported_retry fired once (on
      // the first heal only).
      expect(requests).toHaveLength(2)
      expect(hasEffortBeta(requests[0]!)).toBe(true)
      expect(hasEffortBeta(requests[1]!)).toBe(false)
      expect(effortRetryEvents()).toHaveLength(1)
      expect(assistantText(yielded)).not.toBe(PONG)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 4. Process-wide latch: a SUBSEQUENT request for the latched model omits
//    effort + beta from its very first attempt (official `qdr` readers).
// ---------------------------------------------------------------------------
describe('CC 2.1.310 item-2 — per-model effort-unsupported latch', () => {
  test(
    'after a heal, the next request for the same model sends neither effort nor the beta on attempt 1',
    async () => {
      // Arrange — first query heals (refusal → stripped success).
      responders = [
        error400(CAPABILITY_REJECTED_EFFORT),
        successSSEResponse(),
        successSSEResponse(),
      ]
      await runQuery(MODEL)
      expect(requests).toHaveLength(2)

      // Act — a SECOND, independent query for the same model.
      const { yielded, error } = await runQuery(MODEL)

      // Assert — the second query's very first (and only) attempt already
      // omits effort + beta: the latch is consulted in configureEffortParams.
      expect(error).toBeNull()
      expect(requests).toHaveLength(3)
      const subsequent = requests[2]!
      expect(hasEffortBeta(subsequent)).toBe(false)
      expect(wireEffort(subsequent)).toBeUndefined()
      expect(assistantText(yielded)).toBe(PONG)
      // No additional heal telemetry — nothing was refused on the new query.
      expect(effortRetryEvents()).toHaveLength(1)
    },
    30000,
  )

  test('a directly latched model never gets effort from configureEffortParams (delete-first gate)', () => {
    // Arrange — an EXTRA_BODY-injected effort already present in output_config
    // (the official `JCs` delete-first branch) plus the latch.
    markEffortUnsupported(MODEL)
    const outputConfig: { effort?: string } = { effort: 'high' }
    const betas: string[] = []

    // Act
    configureEffortParams('high', outputConfig, {}, betas, MODEL)

    // Assert — effort REMOVED, beta NOT pushed.
    expect('effort' in outputConfig).toBe(false)
    expect(betas).toEqual([])
  })

  test('control: an unlatched supported model keeps effort + beta (existing behavior pinned)', () => {
    // Arrange
    const outputConfig: { effort?: string } = {}
    const betas: string[] = []

    // Act
    configureEffortParams('high', outputConfig, {}, betas, MODEL)

    // Assert
    expect(outputConfig.effort).toBe('high')
    expect(betas).toEqual([EFFORT_BETA_HEADER])
  })
})

// ---------------------------------------------------------------------------
// 5. Classifier gate end-to-end: an unrelated 400 on an effort-carrying
//    request must not heal.
// ---------------------------------------------------------------------------
describe('CC 2.1.310 item-2 — heal gate declines when not eligible', () => {
  test(
    'an unrelated 400 on an eligible effort-carrying request does not heal',
    async () => {
      // Arrange — the request is fully eligible (effort field + beta header),
      // but the 400 is an auth error, not an effort refusal.
      responders = [error400(GENERIC_400), successSSEResponse()]

      // Act
      const { yielded } = await runQuery(MODEL)

      // Assert — effort rode along, yet the unrelated 400 is not healed:
      // single send, no telemetry, no latch, error surfaces.
      expect(requests).toHaveLength(1)
      expect(hasEffortBeta(requests[0]!)).toBe(true)
      expect(wireEffort(requests[0]!)).toBe('high')
      expect(effortRetryEvents()).toHaveLength(0)
      expect(isEffortUnsupported(MODEL)).toBe(false)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )
})
