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
import type { Tool } from '../../../Tool.js'

/**
 * CC 2.1.306 (research-api.md #1/#2) — claude.ts-LAYER integration coverage
 * for the tool-search refuse-recovery state machine (official v306 binary:
 * L6/Rse/N6/EF @249522800, iSe cluster @248312563, Jmn @249494776), driven
 * end-to-end through the REAL `queryModelWithStreaming` against an HTTP-layer
 * fetch mock (same discipline as toolSearchHoldWiring300 /
 * context1mBetaHeal295Review).
 *
 * v304 → v306 CHANGES pinned here (official binary is the source of truth;
 * v306 ELF has ZERO `toolSearchRefusedAt` string hits, v304: 6):
 *  - REMOVED: the persisted 1-day refused window (recordToolSearchRefused /
 *    isToolSearchRefused / the sha256(`${url}\0${model}`) key) and the
 *    `model_unsupported` gate it fed — so the v304 section-4 test is gone,
 *    and the surviving success tests assert the config seam NEVER gains a
 *    `toolSearchRefusedAt` key.
 *  - REMOVED: the `zOe` eligibility gate — ENABLE_TOOL_SEARCH=true no longer
 *    turns the recovery off (that test FLIPPED: recovery now runs).
 *  - NEW: two refuse paths — NAMED (Rse: the 400/422 names the tool-search
 *    beta via isToolSearchBetaRefusalNamed; fires regardless of endpoint) and
 *    ANONYMOUS (N6/Ese: status 400||422 ∧ ¬billing_error ∧ (¬Jmn() ∨ the
 *    message names `defer_loading`)). Named is checked first.
 *  - NEW: success-side telemetry is `tengu_beta_400_healed` {beta, model,
 *    provider, status, unnamed:!named} (v304's {unclaimed:true} is gone),
 *    plus the hLe debug log on the anonymous heal.
 *  - One-shot is now STRUCTURAL (no toolSearchRecoveryDone latch): the rebuilt
 *    retry has no tool-search beta, so L6's requestDeclaredToolSearch fails
 *    and a second eligible 400 surfaces.
 *
 * Recovery contract (unchanged wire behavior):
 *  - exactly ONE retry that (a) drops the tool-search beta, (b) re-declares
 *    the deferred tools in full (ToolSearch itself removed), (c) prepends the
 *    official critical_system_reminder as a system-reminder-wrapped isMeta
 *    user message — verbatim: "ToolSearch is no longer available. Tools
 *    listed earlier as deferred that are still available are declared in
 *    full: call them directly.";
 *  - ENABLE_TOOL_SEARCH=false → 'standard' mode: no tool search is ever sent,
 *    so the refused request never happens and no recovery runs (the official
 *    escape hatch named in EF's warn text).
 *
 * Config seam: under `bun test` NODE_ENV='test', getGlobalConfig() uses
 * config.ts's module-level TEST_GLOBAL_CONFIG_FOR_TESTING object.
 */

// ---------------------------------------------------------------------------
// VCR pass-through mock (NODE_ENV=test activates record/replay — identical
// 'PING' queries would replay instead of reaching the fetch mock).
// Passthrough-FLAG pattern so a shared-process run keeps genuine VCR behavior
// for other files after afterAll(). Require claude.ts AFTER this mock.
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
  // CI-parity (toolSearchHoldWiring300 rationale): keep any token-count
  // probe env-independent so it reaches the fetch mock instead of throwing
  // on fixture-missing in CI.
  withTokenCountVCR: ((
    messages: unknown,
    tools: unknown,
    f: () => Promise<number | null>,
    ...rest: unknown[]
  ) =>
    vcrMockActive
      ? f()
      : (
          realVcr.withTokenCountVCR as (
            ...a: unknown[]
          ) => Promise<number | null>
        )(messages, tools, f, ...rest)) as typeof realVcr.withTokenCountVCR,
}))

// Require AFTER the mock so claude.ts binds the mocked VCR wrappers.
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
const { resetToolSearchDeclared } = require('../../../utils/toolSearch.js') as typeof import(
  '../../../utils/toolSearch.js'
)
const { getGlobalConfig } = require('../../../utils/config.js') as typeof import(
  '../../../utils/config.js'
)
const { TOOL_SEARCH_BETA_HEADER_1P } = require('../../../constants/betas.js') as typeof import(
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
const { getGlobalClaudeFile } = require('../../../utils/env.js') as {
  getGlobalClaudeFile: (() => string) & { cache?: Map<unknown, string> }
}
const { clearBetasCaches } = require('../../../utils/betas.js') as {
  clearBetasCaches: () => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MODEL = 'claude-sonnet-4-6' // not in DEFAULT_UNSUPPORTED_MODEL_PATTERNS
const TOOL_SEARCH_NAME = 'ToolSearch'
const CUSTOM_URL = 'https://gateway.example.com'

// Official critical_system_reminder content (verbatim, v306 @242035159 region
// — `${Pi} is no longer available. ...`, Pi = "ToolSearch").
const CRITICAL_REMINDER =
  'ToolSearch is no longer available. Tools listed earlier as deferred that are still available are declared in full: call them directly.'

// A gateway refusal that matches NO other heal classifier: no
// `tools.N.input_schema` (toolschema), no `context_management: Extra inputs
// are not permitted` (#22), no 1M-beta / "invalid beta flag" text (#295), no
// advisor / media patterns. It also names neither the beta header (so the
// NAMED path cannot fire) nor `defer_loading` (so under a true-first-party
// arrangement the ANONYMOUS path cannot fire either).
const REFUSAL_400 = 'tool_reference blocks are not supported by this endpoint'

// The official "Unexpected value(s)" refusal shape (`e5t` first-line regex)
// naming the 1P tool-search beta — drives the NAMED path (Rse/iSe).
const NAMED_BETA_REFUSAL_400 = `Unexpected value(s) \`${TOOL_SEARCH_BETA_HEADER_1P}\` for the \`anthropic-beta\` header. Please consult our documentation at docs.anthropic.com or try again without the header.`

const PONG = 'PONG'

let tmpConfigDir: string
let prevConfigDir: string | undefined

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_MODEL',
  'USER_TYPE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_MAX_RETRIES',
  // The tool-search mode switch (unset → 'tst'; false → 'standard'; true →
  // 'tst' — and in v306 the recovery runs in BOTH tool-search modes).
  'ENABLE_TOOL_SEARCH',
  // Keep any VCR token-count fixtures out of occ/fixtures/.
  'CLAUDE_CODE_TEST_FIXTURES_ROOT',
  'API_TIMEOUT_MS',
  'API_FORCE_IDLE_TIMEOUT',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch

// ---------------------------------------------------------------------------
// HTTP-layer fetch mock (toolSearchHoldWiring300 shape) — URL-aware:
// count_tokens probes get a canned small count; /v1/messages calls consume the
// responder queue.
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
    if (url.includes('count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 100 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const responder = responders.shift()
    if (!responder) {
      throw new Error(
        `toolSearchRefuseRecovery304: unexpected fetch call #${requests.length} to ${url}`,
      )
    }
    return responder()
  }) as typeof fetch
}

function messageRequests(): RecordedRequest[] {
  return requests.filter(r => !r.url.includes('count_tokens'))
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A minimal successful streaming assistant turn ("PONG"). message_start is
 *  the site that calls markToolSearchRefusedHealed() on a recovery retry. */
function successSSEResponse(): () => Response {
  return () =>
    new Response(
      [
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_01TS306',
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

/** A JSON error response with the given status / error type / message — the
 *  SDK turns it into an APIError with `.status` and `.message`, and
 *  isAPIErrorBodyType reads `.error.error.type` off the parsed body. */
function errorResponse(
  status: number,
  message: string,
  type = 'invalid_request_error',
): () => Response {
  return () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    })
}

const error400 = (message: string): (() => Response) =>
  errorResponse(400, message)
const error422 = (message: string): (() => Response) =>
  errorResponse(422, message)
const error400Billing = (message: string): (() => Response) =>
  errorResponse(400, message, 'billing_error')

// ---------------------------------------------------------------------------
// Fake tools — only the fields the wire-build path reads. Unique MCP names
// per test: getDeferredToolTokenCount is memoized by deferred tool name AND
// toolToAPISchema caches per session by tool name.
// ---------------------------------------------------------------------------
function fakeToolSearchTool(): Tool {
  return {
    name: TOOL_SEARCH_NAME,
    prompt: async () => 'Search and load deferred tool definitions.',
    inputJSONSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  } as unknown as Tool
}

function fakeDeferredMcpTool(name: string, serverName: string): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName, toolName: name.split('__')[2] ?? 'tool' },
    prompt: async () => 'Short deferred MCP tool description.',
    inputJSONSchema: { type: 'object', properties: {} },
  } as unknown as Tool
}

// ---------------------------------------------------------------------------
// Query driver (context1mBetaHeal295Review shape — captures yields AND the
// terminal error so declined-recovery cases can assert on either surface).
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
  message?: { content?: unknown }
}

async function runQuery(tools: Tool[]): Promise<{
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
      tools,
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

/** Tool entry names in a recorded request body, wire order. */
function sentToolNames(req: RecordedRequest): string[] {
  const tools = (req.body?.tools ?? []) as Array<Record<string, unknown>>
  return tools.map(t => String(t.name))
}

function betaHeader(req: RecordedRequest): string {
  return req.headers.get('anthropic-beta') ?? ''
}

/** Serialized first wire message — used to assert the reminder prepend. */
function firstMessageJSON(req: RecordedRequest): string {
  const messages = (req.body?.messages ?? []) as unknown[]
  return JSON.stringify(messages[0] ?? null)
}

/** v306 REMOVED the persisted window — the config seam must never grow the
 *  v304 key (v306 ELF: zero `toolSearchRefusedAt` string hits). */
function refusedWindowAbsent(): void {
  const config = getGlobalConfig() as { toolSearchRefusedAt?: unknown }
  expect(config.toolSearchRefusedAt).toBeUndefined()
}

// ---------------------------------------------------------------------------
// Analytics capture — a REAL attached sink (context1mBetaHeal295Review
// discipline), no mock.module.
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
  // Default arrangement: firstParty provider behind a CUSTOM base URL (no
  // assume-first-party flag) → Jmn() FALSE → the anonymous path (Ese) has no
  // defer_loading requirement. ENABLE_TOOL_SEARCH unset → default 'tst' mode.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.ANTHROPIC_BASE_URL = CUSTOM_URL

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-tsrefuse-306-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()
  // Betas are memoized by model string; clear so a shared-process run cannot
  // reuse a beta list assembled under another file's env (e.g. the
  // assume-first-party arrangement of context1mBetaHeal304).
  clearBetasCaches()

  // Reset the conversation-level tool-search-declared latch.
  resetToolSearchDeclared()

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
  resetToolSearchDeclared()
  rmSync(tmpConfigDir, { recursive: true, force: true })
  resetAnalyticsForTesting()
})

afterAll(() => {
  vcrMockActive = false
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. The ANONYMOUS path fires: an unclaimed 400 behind a custom base URL
//    (Jmn false) on a request that declared deferred tools rebuilds the call
//    without tool search, with the critical reminder prepended.
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #1 — refuse-recovery, anonymous path (official N6/Ese)', () => {
  test(
    'unclaimed 400 behind a custom base URL → one retry without the tool-search beta, tools un-deferred, critical reminder prepended',
    async () => {
      // Arrange — attempt 1 is the gateway refusal, attempt 2 the rebuilt
      // request that succeeds.
      responders = [error400(REFUSAL_400), successSSEResponse()]

      // Act
      const { yielded, error } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srva__hidden', 'srva'),
      ])

      // Assert — two wire requests.
      expect(error).toBeNull()
      const msgs = messageRequests()
      expect(msgs).toHaveLength(2)
      // Original: tool search ON — ToolSearch declared, MCP tool deferred
      // (absent), 1P tool-search beta on the wire.
      expect(sentToolNames(msgs[0]!)).toEqual([TOOL_SEARCH_NAME])
      expect(betaHeader(msgs[0]!)).toContain(TOOL_SEARCH_BETA_HEADER_1P)
      // Retry: tool search OFF — beta stripped, the deferred MCP tool
      // re-declared in full, ToolSearch itself removed.
      expect(betaHeader(msgs[1]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(sentToolNames(msgs[1]!)).toEqual(['mcp__srva__hidden'])
      // The official critical_system_reminder is prepended as the first wire
      // message, system-reminder-wrapped.
      const first = firstMessageJSON(msgs[1]!)
      expect(first).toContain(CRITICAL_REMINDER)
      expect(first).toContain('<system-reminder>')
      // The rebuilt request answered normally.
      expect(assistantText(yielded)).toBe(PONG)
      expect(apiErrorNotices(yielded)).toEqual([])
    },
    30000,
  )

  test(
    'successful anonymous retry → tengu_beta_400_healed fires once with the v306 shape {beta,model,provider,status,unnamed:true} and NO toolSearchRefusedAt is persisted',
    async () => {
      // Arrange
      responders = [error400(REFUSAL_400), successSSEResponse()]

      // Act
      await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvb__hidden', 'srvb'),
      ])

      // Assert — official `hLe` telemetry shape on message_start of the
      // retry. v304's {unclaimed:true} field and the persisted
      // toolSearchRefusedAt window are GONE in v306.
      const healed = healedEvents()
      expect(healed).toHaveLength(1)
      const meta = healed[0]!.metadata as Record<string, unknown>
      expect(meta.beta).toBe(TOOL_SEARCH_BETA_HEADER_1P)
      expect(meta.model).toBe(MODEL)
      expect(typeof meta.provider).toBe('string')
      expect(meta.status).toBe(400)
      expect(meta.unnamed).toBe(true)
      expect(meta.unclaimed).toBeUndefined()
      refusedWindowAbsent()
    },
    30000,
  )

  test(
    'a 422 refusal recovers the same way (official Ese accepts status 400 || 422)',
    async () => {
      // Arrange
      responders = [error422(REFUSAL_400), successSSEResponse()]

      // Act
      const { yielded, error } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvc__hidden', 'srvc'),
      ])

      // Assert
      expect(error).toBeNull()
      const msgs = messageRequests()
      expect(msgs).toHaveLength(2)
      expect(betaHeader(msgs[0]!)).toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(betaHeader(msgs[1]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(sentToolNames(msgs[1]!)).toEqual(['mcp__srvc__hidden'])
      expect(firstMessageJSON(msgs[1]!)).toContain(CRITICAL_REMINDER)
      expect(assistantText(yielded)).toBe(PONG)
      const healed = healedEvents()
      expect(healed).toHaveLength(1)
      expect((healed[0]!.metadata as Record<string, unknown>).status).toBe(422)
      refusedWindowAbsent()
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 2. One-shot is STRUCTURAL in v306 (no toolSearchRecoveryDone latch): the
//    rebuilt retry carries no tool-search beta, so L6's
//    requestDeclaredToolSearch conjunct fails and a second eligible 400 never
//    re-enters the recovery.
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #1 — recovery is structurally one-shot per request', () => {
  test(
    '400 then a second 400 on the retry → no third send, nothing healed, error surfaces',
    async () => {
      // Arrange — the gateway refuses both the tool-search request and the
      // rebuilt one.
      responders = [error400(REFUSAL_400), error400(REFUSAL_400)]

      // Act
      const { yielded } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvd__hidden', 'srvd'),
      ])

      // Assert — exactly ONE retry (2 sends total); the second 400 falls
      // through to the normal non-retryable path (the retry never declared
      // the beta → L6 false). No message_start → no tengu_beta_400_healed,
      // and nothing is persisted anywhere.
      const msgs = messageRequests()
      expect(msgs).toHaveLength(2)
      expect(betaHeader(msgs[0]!)).toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(betaHeader(msgs[1]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(healedEvents()).toHaveLength(0)
      refusedWindowAbsent()
      expect(assistantText(yielded)).not.toBe(PONG)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 3. Eligibility gates.
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #1 — recovery eligibility gates', () => {
  test(
    'billing_error 400 is excluded from the anonymous path → single send, error surfaces',
    async () => {
      // Arrange — official gate `to.type!=="billing_error"` (Ese conjunct).
      responders = [error400Billing('your credit balance is too low')]

      // Act
      const { yielded } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srve__hidden', 'srve'),
      ])

      // Assert
      expect(messageRequests()).toHaveLength(1)
      expect(healedEvents()).toHaveLength(0)
      refusedWindowAbsent()
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )

  test(
    'ENABLE_TOOL_SEARCH=false → standard mode: no tool search on the wire, so the refused request never happens and no recovery runs',
    async () => {
      // Arrange — the official escape hatch named in EF's warn text. L6
      // fails: the request never declared the tool-search beta.
      process.env.ENABLE_TOOL_SEARCH = 'false'
      responders = [error400(REFUSAL_400)]

      // Act
      const { yielded } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvf__hidden', 'srvf'),
      ])

      // Assert — tools went out inline from the start (no ToolSearch, no
      // tool-search beta); the 400 surfaces with no retry.
      const msgs = messageRequests()
      expect(msgs).toHaveLength(1)
      expect(sentToolNames(msgs[0]!)).toEqual(['mcp__srvf__hidden'])
      expect(betaHeader(msgs[0]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(healedEvents()).toHaveLength(0)
      refusedWindowAbsent()
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )

  test(
    'ENABLE_TOOL_SEARCH=true → tool search IS sent AND the recovery now RUNS (v306: the zOe gate is gone — FLIPPED vs v304)',
    async () => {
      // Arrange — v304 turned the recovery off for =true; v306 has no such
      // gate, so the same refusal recovers.
      process.env.ENABLE_TOOL_SEARCH = 'true'
      responders = [error400(REFUSAL_400), successSSEResponse()]

      // Act
      const { yielded, error } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvg__hidden', 'srvg'),
      ])

      // Assert — the first request carried tool search; the rebuilt retry
      // dropped it and succeeded.
      expect(error).toBeNull()
      const msgs = messageRequests()
      expect(msgs).toHaveLength(2)
      expect(sentToolNames(msgs[0]!)).toEqual([TOOL_SEARCH_NAME])
      expect(betaHeader(msgs[0]!)).toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(betaHeader(msgs[1]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(sentToolNames(msgs[1]!)).toEqual(['mcp__srvg__hidden'])
      expect(firstMessageJSON(msgs[1]!)).toContain(CRITICAL_REMINDER)
      expect(assistantText(yielded)).toBe(PONG)
      const healed = healedEvents()
      expect(healed).toHaveLength(1)
      expect((healed[0]!.metadata as Record<string, unknown>).unnamed).toBe(
        true,
      )
      refusedWindowAbsent()
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 4. The NAMED path (official Rse/iSe): a 400 that names the tool-search beta
//    recovers even when the anonymous predicate would REJECT it — here via a
//    true-first-party arrangement (Jmn true: no ANTHROPIC_BASE_URL override)
//    with a message that does NOT contain `defer_loading`.
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #1 — named path (official Rse/iSe)', () => {
  test(
    'true-first-party + "Unexpected value(s)" beta refusal without defer_loading → the NAMED path recovers',
    async () => {
      // Arrange — Jmn() TRUE (firstParty, no base-URL override, env API key,
      // no unix socket). The anonymous predicate fails (no `defer_loading`
      // in the message); only the named classifier can fire.
      delete process.env.ANTHROPIC_BASE_URL
      responders = [error400(NAMED_BETA_REFUSAL_400), successSSEResponse()]

      // Act
      const { yielded, error } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvi__hidden', 'srvi'),
      ])

      // Assert — recovery ran: beta stripped, tools un-deferred, reminder
      // prepended, retry succeeded. Telemetry marks it NAMED (unnamed:false).
      expect(error).toBeNull()
      const msgs = messageRequests()
      expect(msgs).toHaveLength(2)
      expect(betaHeader(msgs[0]!)).toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(betaHeader(msgs[1]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(sentToolNames(msgs[1]!)).toEqual(['mcp__srvi__hidden'])
      expect(firstMessageJSON(msgs[1]!)).toContain(CRITICAL_REMINDER)
      expect(assistantText(yielded)).toBe(PONG)
      const healed = healedEvents()
      expect(healed).toHaveLength(1)
      const meta = healed[0]!.metadata as Record<string, unknown>
      expect(meta.unnamed).toBe(false)
      expect(meta.status).toBe(400)
      expect(meta.beta).toBe(TOOL_SEARCH_BETA_HEADER_1P)
      refusedWindowAbsent()
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 5. The defer_loading guard (official Ese `!Jmn()||/\bdefer_loading\b/`):
//    under a true-first-party arrangement, anonymous recovery requires the
//    refusal message to name the deferred-tools mechanism.
// ---------------------------------------------------------------------------
describe('CC 2.1.306 #2 — defer_loading guard under true-first-party (official Jmn/Ese)', () => {
  test(
    'true-first-party + anonymous 400 WITHOUT defer_loading → NO recovery, error surfaces',
    async () => {
      // Arrange — Jmn() TRUE; REFUSAL_400 names neither the beta header
      // (named path silent) nor `defer_loading` (anonymous path gated).
      delete process.env.ANTHROPIC_BASE_URL
      responders = [error400(REFUSAL_400)]

      // Act
      const { yielded } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvj__hidden', 'srvj'),
      ])

      // Assert — single send, the 400 surfaces.
      const msgs = messageRequests()
      expect(msgs).toHaveLength(1)
      expect(betaHeader(msgs[0]!)).toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(healedEvents()).toHaveLength(0)
      refusedWindowAbsent()
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )

  test(
    'true-first-party + anonymous 400 naming defer_loading → recovery runs',
    async () => {
      // Arrange — Jmn() TRUE, but the refusal message names the
      // deferred-tools mechanism, satisfying Ese's second disjunct.
      delete process.env.ANTHROPIC_BASE_URL
      responders = [
        error400('tools.3.defer_loading: unexpected field defer_loading'),
        successSSEResponse(),
      ]

      // Act
      const { yielded, error } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvk__hidden', 'srvk'),
      ])

      // Assert
      expect(error).toBeNull()
      const msgs = messageRequests()
      expect(msgs).toHaveLength(2)
      expect(betaHeader(msgs[1]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(sentToolNames(msgs[1]!)).toEqual(['mcp__srvk__hidden'])
      expect(firstMessageJSON(msgs[1]!)).toContain(CRITICAL_REMINDER)
      expect(assistantText(yielded)).toBe(PONG)
      const healed = healedEvents()
      expect(healed).toHaveLength(1)
      expect((healed[0]!.metadata as Record<string, unknown>).unnamed).toBe(
        true,
      )
      refusedWindowAbsent()
    },
    30000,
  )
})
