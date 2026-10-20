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
import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Options } from '../claude.js'
import type { Tool } from '../../../Tool.js'

/**
 * CC 2.1.304 (#58) — claude.ts-LAYER integration coverage for the tool-search
 * refuse-recovery (official `b6`/`tse`/`mZ`/`ugn` chain, byte-verified in
 * research-R4-skills-hooks.md "#58"), driven end-to-end through the REAL
 * `queryModelWithStreaming` against an HTTP-layer fetch mock (same discipline
 * as toolSearchHoldWiring300 / context1mBetaHeal295Review).
 *
 * Setup shape (official `zOe()` true): provider firstParty, a CUSTOM
 * `ANTHROPIC_BASE_URL` (NO assume-first-party flag), `ENABLE_TOOL_SEARCH`
 * unset → default 'tst' mode (the vprev-303 optimistic-disable branch was
 * removed) → ToolSearch on the wire with the 1P tool-search beta and the MCP
 * tool deferred.
 *
 * Recovery contract pinned here:
 *  - an HTTP 400 (or 422) that NO other recovery claimed on a request that
 *    used tool search → exactly ONE retry that (a) drops the tool-search beta,
 *    (b) re-declares the deferred tools in full (ToolSearch itself removed),
 *    (c) prepends the official critical_system_reminder as a system-reminder-
 *    wrapped isMeta user message — verbatim: "ToolSearch is no longer
 *    available. Tools listed earlier as deferred that are still available are
 *    declared in full: call them directly.";
 *  - on the retry's message_start: `toolSearchRefusedAt[key]` is recorded
 *    (official `DUs`; key = sha256(`${ANTHROPIC_BASE_URL}\0${model}`)
 *    .slice(0,24)) and `tengu_beta_400_healed` fires exactly once with
 *    {beta, model, provider, unclaimed:true};
 *  - a SECOND eligible 400 on the retry never re-enters (one-shot latch +
 *    the beta is gone): no third send, nothing recorded, the error surfaces;
 *  - a `billing_error`-typed 400 is excluded (official `eo.type!=="billing_
 *    error"`);
 *  - `ENABLE_TOOL_SEARCH=false` → 'standard' mode: no tool search is ever
 *    sent, so the refused request is skipped entirely and no recovery runs;
 *  - `ENABLE_TOOL_SEARCH=true` → tool search IS sent but the recovery is off
 *    (zOe false): a 400 surfaces with no retry and nothing recorded;
 *  - a persisted refused window makes the NEXT query skip tool search
 *    outright (gate reason `model_unsupported`, official `Zae` → `d(e)`).
 *
 * Config seam: under `bun test` NODE_ENV='test', getGlobalConfig()/
 * saveGlobalConfig() use config.ts's module-level TEST_GLOBAL_CONFIG_FOR_
 * TESTING object; tests reset it by deleting the `toolSearchRefusedAt` key.
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
const {
  recordToolSearchRefused,
  resetToolSearchDeclared,
} = require('../../../utils/toolSearch.js') as typeof import(
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

// Official critical_system_reminder content (verbatim, research-R4 "#58").
const CRITICAL_REMINDER =
  'ToolSearch is no longer available. Tools listed earlier as deferred that are still available are declared in full: call them directly.'

// A gateway refusal that matches NO other heal classifier: no
// `tools.N.input_schema` (toolschema), no `context_management: Extra inputs
// are not permitted` (#22), no 1M-beta / "invalid beta flag" text (#295), no
// advisor / media patterns.
const REFUSAL_400 = 'tool_reference blocks are not supported by this endpoint'

const PONG = 'PONG'

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
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_MAX_RETRIES',
  // The tool-search mode switch (unset → 'tst'; false → 'standard'; true →
  // 'tst' with the refuse-recovery off).
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
            id: 'msg_01TS304',
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

/** The official `c(e)` key for the current endpoint+model. */
function expectedRefusedKey(): string {
  return createHash('sha256')
    .update(`${CUSTOM_URL}\0${MODEL}`)
    .digest('hex')
    .slice(0, 24)
}

function refusedEntries(): Record<string, number> {
  return getGlobalConfig().toolSearchRefusedAt ?? {}
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

function modeDecisions(): Array<{ eventName: string; metadata: Record<string, unknown> }> {
  return analyticsEvents
    .filter(e => e.eventName === 'tengu_tool_search_mode_decision')
    .map(e => ({ eventName: e.eventName, metadata: e.metadata as Record<string, unknown> }))
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
  // Official `zOe()` arrangement: firstParty provider, CUSTOM base URL (no
  // assume-first-party flag), ENABLE_TOOL_SEARCH unset → default 'tst' mode.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.ANTHROPIC_BASE_URL = CUSTOM_URL

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-tsrefuse-304-'))
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

  // Reset the persisted refused window (TEST_GLOBAL_CONFIG_FOR_TESTING is the
  // live config object under NODE_ENV='test') and the conversation latch.
  const config = getGlobalConfig() as { toolSearchRefusedAt?: unknown }
  delete config.toolSearchRefusedAt
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
  const config = getGlobalConfig() as { toolSearchRefusedAt?: unknown }
  delete config.toolSearchRefusedAt
  resetToolSearchDeclared()
  rmSync(tmpConfigDir, { recursive: true, force: true })
  resetAnalyticsForTesting()
})

afterAll(() => {
  vcrMockActive = false
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. The recovery fires: an unclaimed 400 on a tool-search request rebuilds
//    the call without tool search, with the critical reminder prepended.
// ---------------------------------------------------------------------------
describe('CC 2.1.304 #58 — refuse-recovery (official b6/tse/mZ)', () => {
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
    'successful retry → toolSearchRefusedAt recorded under the official sha256 key and tengu_beta_400_healed fires once with {unclaimed:true}',
    async () => {
      // Arrange
      responders = [error400(REFUSAL_400), successSSEResponse()]

      // Act
      await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvb__hidden', 'srvb'),
      ])

      // Assert — official `DUs` write on message_start of the retry:
      // toolSearchRefusedAt[sha256(`${url}\0${model}`).slice(0,24)] = now.
      const entries = refusedEntries()
      expect(Object.keys(entries)).toEqual([expectedRefusedKey()])
      expect(Math.abs(Date.now() - (entries[expectedRefusedKey()] as number))).toBeLessThan(60_000)
      // Official `ugn` telemetry shape.
      const healed = healedEvents()
      expect(healed).toHaveLength(1)
      const meta = healed[0]!.metadata as Record<string, unknown>
      expect(meta.beta).toBe(TOOL_SEARCH_BETA_HEADER_1P)
      expect(meta.model).toBe(MODEL)
      expect(meta.unclaimed).toBe(true)
      expect(typeof meta.provider).toBe('string')
    },
    30000,
  )

  test(
    'a 422 refusal recovers the same way (official b6 accepts 400 || 422)',
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
      expect(Object.keys(refusedEntries())).toEqual([expectedRefusedKey()])
      expect(healedEvents()).toHaveLength(1)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 2. One-shot: a second eligible error on the rebuilt request never re-enters
//    the recovery (toolSearchRecoveryDone latch + the beta is already gone
//    from `betas`, so requestUsedToolSearch is false).
// ---------------------------------------------------------------------------
describe('CC 2.1.304 #58 — recovery is one-shot per request', () => {
  test(
    '400 then a second 400 on the retry → no third send, nothing recorded, error surfaces',
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
      // through to the normal non-retryable path. No message_start → no
      // toolSearchRefusedAt write and no tengu_beta_400_healed.
      const msgs = messageRequests()
      expect(msgs).toHaveLength(2)
      expect(betaHeader(msgs[0]!)).toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(betaHeader(msgs[1]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(refusedEntries()).toEqual({})
      expect(healedEvents()).toHaveLength(0)
      expect(assistantText(yielded)).not.toBe(PONG)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 3. Eligibility gates of the official `b6` predicate.
// ---------------------------------------------------------------------------
describe('CC 2.1.304 #58 — recovery eligibility gates', () => {
  test(
    'billing_error 400 is excluded → single send, nothing recorded, error surfaces',
    async () => {
      // Arrange — official gate `eo.type!=="billing_error"`.
      responders = [error400Billing('your credit balance is too low')]

      // Act
      const { yielded } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srve__hidden', 'srve'),
      ])

      // Assert
      expect(messageRequests()).toHaveLength(1)
      expect(refusedEntries()).toEqual({})
      expect(healedEvents()).toHaveLength(0)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )

  test(
    'ENABLE_TOOL_SEARCH=false → standard mode: no tool search on the wire, so the refused request never happens and no recovery runs',
    async () => {
      // Arrange — official recipe #5: `=false skips the refused request`.
      process.env.ENABLE_TOOL_SEARCH = 'false'
      responders = [error400(REFUSAL_400)]

      // Act
      const { yielded } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvf__hidden', 'srvf'),
      ])

      // Assert — tools went out inline from the start (no ToolSearch, no
      // tool-search beta); the 400 is not recovered (requestUsedToolSearch
      // false) and surfaces.
      const msgs = messageRequests()
      expect(msgs).toHaveLength(1)
      expect(sentToolNames(msgs[0]!)).toEqual(['mcp__srvf__hidden'])
      expect(betaHeader(msgs[0]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(refusedEntries()).toEqual({})
      expect(healedEvents()).toHaveLength(0)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )

  test(
    'ENABLE_TOOL_SEARCH=true → tool search IS sent but the recovery is off (zOe false): 400 surfaces with no retry',
    async () => {
      // Arrange — official recipe #5: `=true always sends tool search and
      // turns this recovery off`.
      process.env.ENABLE_TOOL_SEARCH = 'true'
      responders = [error400(REFUSAL_400)]

      // Act
      const { yielded } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvg__hidden', 'srvg'),
      ])

      // Assert — the request carried tool search, yet no rebuilt retry ran
      // and nothing was recorded.
      const msgs = messageRequests()
      expect(msgs).toHaveLength(1)
      expect(sentToolNames(msgs[0]!)).toEqual([TOOL_SEARCH_NAME])
      expect(betaHeader(msgs[0]!)).toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(refusedEntries()).toEqual({})
      expect(healedEvents()).toHaveLength(0)
      expect(apiErrorNotices(yielded).length).toBeGreaterThan(0)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// 4. The persisted window: once refused, the NEXT query for that endpoint+
//    model skips tool search outright (official `Zae` → `d(e)`, surfaced
//    through isToolSearchEnabled as `model_unsupported`).
// ---------------------------------------------------------------------------
describe('CC 2.1.304 #58 — persisted refused window gates the next query', () => {
  test(
    'a recorded refusal makes the next query send tools inline with no tool-search beta (model_unsupported)',
    async () => {
      // Arrange — simulate the day-long window left by an earlier refusal.
      recordToolSearchRefused(MODEL)
      expect(Object.keys(refusedEntries())).toEqual([expectedRefusedKey()])
      responders = [successSSEResponse()]

      // Act
      const { yielded, error } = await runQuery([
        fakeToolSearchTool(),
        fakeDeferredMcpTool('mcp__srvh__hidden', 'srvh'),
      ])

      // Assert — single request, no ToolSearch, no tool-search beta, the MCP
      // tool declared inline; the gate decision telemetry names the reason.
      expect(error).toBeNull()
      const msgs = messageRequests()
      expect(msgs).toHaveLength(1)
      expect(sentToolNames(msgs[0]!)).toEqual(['mcp__srvh__hidden'])
      expect(betaHeader(msgs[0]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
      expect(assistantText(yielded)).toBe(PONG)
      const unsupported = modeDecisions().find(
        e => e.metadata.reason === 'model_unsupported',
      )
      expect(unsupported).toBeDefined()
      expect(unsupported?.metadata.enabled).toBe(false)
      // No recovery ran — nothing healed, window unchanged.
      expect(healedEvents()).toHaveLength(0)
    },
    30000,
  )
})
