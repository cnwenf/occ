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
 * CC 2.1.300 changelog #18 — claude.ts-LAYER integration coverage for the
 * ToolSearch conversation hold wiring:
 *
 *  - claude.ts:1815-1822 — `isToolSearchDeclared()` is threaded as the 6th
 *    `autoHeld` arg of `isToolSearchEnabled` (official query caller
 *    @227824350 passes `Q.recordedToolDescriptions?.has(Ci)`, Ci="ToolSearch"
 *    @219935042, as 7th arg `S` of `Lfr` @227142200);
 *  - claude.ts:1870 — `noteToolSearchDeclared()` arms the latch once
 *    ToolSearch's description actually goes out on the wire.
 *
 * toolSearchDeclaredLatch300.test.ts covers the latch semantics +
 * clearSessionCaches reset in isolation. This file closes the remaining gap
 * (mutation-proven during acceptance: hardcoding the 6th arg to `false` OR
 * deleting the :1870 arming left all 13 latch tests green). It drives the
 * REAL `queryModelWithStreaming` (the function containing both call sites)
 * with an HTTP-layer fetch mock and asserts on the actual wire bytes:
 *
 *  - armed latch + ENABLE_TOOL_SEARCH=auto → the hold short-circuits the
 *    threshold recompute (`auto_held` @227142599): ToolSearch on the wire,
 *    tool-search beta header set, ZERO count_tokens calls;
 *  - fresh conversation, default 'tst' mode → after the query the latch is
 *    ARMED (:1870), and a follow-up auto-mode query still holds;
 *  - control: fresh conversation + auto mode → below threshold → ToolSearch
 *    NOT on the wire (`auto_below_threshold`) — proves the held assertions
 *    above are not trivially true.
 *
 * fetch is mocked at globalThis (same discipline as advisorRetryWiring276 /
 * mcpHealWiring300). The mock is URL-aware: count_tokens probes (auto-mode
 * threshold, unheld only) get a canned small token count so the below-
 * threshold verdict is deterministic WITHOUT the haiku fallback (whose
 * non-streaming /v1/messages create would eat the responder queue);
 * /v1/messages calls consume the responder queue.
 */

// ---------------------------------------------------------------------------
// VCR pass-through mock (NODE_ENV=test activates record/replay — identical
// 'PING' queries would replay instead of reaching the fetch mock). Require
// claude.ts AFTER; ci-test.sh runs each file in its own process.
// ---------------------------------------------------------------------------
const VCR_MODULE_PATH = '../../vcr.js'
const realVcr = await import(VCR_MODULE_PATH)
mock.module(VCR_MODULE_PATH, () => ({
  ...realVcr,
  withVCR: (_messages: unknown, f: () => Promise<unknown>) => f(),
  withStreamingVCR: (
    _messages: unknown,
    f: () => AsyncGenerator<never, void>,
  ) => f(),
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
  isToolSearchDeclared,
  noteToolSearchDeclared,
  resetToolSearchDeclared,
} = require('../../../utils/toolSearch.js') as typeof import(
  '../../../utils/toolSearch.js'
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MODEL = 'claude-sonnet-4-6' // not in DEFAULT_UNSUPPORTED_MODEL_PATTERNS
const TOOL_SEARCH_NAME = 'ToolSearch'

// Env isolation: a tmp CLAUDE_CONFIG_DIR keeps the ambient ~/.claude (which
// may hold a real OAuth account) out of getAnthropicClient's auth path.
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
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  // The tool-search mode switch (unset → 'tst', auto → 'tst-auto').
  'ENABLE_TOOL_SEARCH',
  // Keep the control test's token-count VCR fixtures out of occ/fixtures/.
  'CLAUDE_CODE_TEST_FIXTURES_ROOT',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch

// ---------------------------------------------------------------------------
// HTTP-layer fetch mock — URL-aware: count_tokens probes get a canned 400
// (→ getDeferredToolTokenCount catch → null → deterministic char fallback);
// everything else consumes the responder queue.
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
      // Primary count endpoint succeeds with a SMALL count → below the auto
      // threshold deterministically, and the haiku fallback (a non-streaming
      // /v1/messages create that would eat the responder queue) never runs.
      return new Response(JSON.stringify({ input_tokens: 100 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const responder = responders.shift()
    if (!responder) {
      throw new Error(
        `toolSearchHoldWiring300: unexpected fetch call #${requests.length} to ${url}`,
      )
    }
    return responder()
  }) as typeof fetch
}

function messageRequests(): RecordedRequest[] {
  return requests.filter(r => !r.url.includes('count_tokens'))
}

function countTokenRequests(): RecordedRequest[] {
  return requests.filter(r => r.url.includes('count_tokens'))
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A minimal successful streaming assistant turn ("PONG"). */
function successSSEResponse(): () => Response {
  return () =>
    new Response(
      [
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_01TSHOLD',
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
          delta: { type: 'text_delta', text: 'PONG' },
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

/** Runs the real queryModelWithStreaming and collects everything it yields. */
async function runQuery(tools: Tool[]): Promise<
  Array<{ type: string; message?: { content?: unknown } }>
> {
  const controller = new AbortController()
  const yielded: Array<{ type: string; message?: { content?: unknown } }> = []
  const gen = queryModelWithStreaming({
    messages: [createUserMessage({ content: 'PING' })],
    systemPrompt: asSystemPrompt(['You are a test assistant.']),
    thinkingConfig: { type: 'disabled' },
    tools,
    signal: controller.signal,
    options: makeOptions(),
  })
  for await (const item of gen) {
    yielded.push(item as { type: string; message?: { content?: unknown } })
  }
  return yielded
}

function assistantText(
  yielded: Array<{ type: string; message?: { content?: unknown } }>,
): string {
  const texts: string[] = []
  for (const item of yielded) {
    if (item.type !== 'assistant') continue
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

/** Tool entry names in a recorded request body, wire order. */
function sentToolNames(req: RecordedRequest): string[] {
  const tools = (req.body?.tools ?? []) as Array<Record<string, unknown>>
  return tools.map(t => String(t.name))
}

function betaHeader(req: RecordedRequest): string {
  return req.headers.get('anthropic-beta') ?? ''
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
type SinkEvent = { eventName: string; metadata: Record<string, unknown> }
let events: SinkEvent[] = []

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Deterministic firstParty + API-key auth (isFirstPartyAnthropicBaseUrl)
  // → getToolSearchBetaHeader() returns the 1P header.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-tshold-wiring-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  // Route VCR token-count fixtures (withTokenCountVCR → withFixture writes to
  // `${CLAUDE_CODE_TEST_FIXTURES_ROOT ?? cwd}/fixtures/`) into the per-test
  // tmpdir so the control test's count_tokens call never pollutes occ/fixtures/.
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  resetSettingsCache()

  // Every test starts from a fresh conversation (unheld latch).
  resetToolSearchDeclared()
  events = []
  // reset FIRST (it nulls the sink), then attach — attachAnalyticsSink is
  // idempotent and _resetForTesting sets sink=null.
  resetAnalyticsForTesting()
  attachAnalyticsSink({
    logEvent: (eventName, metadata) => {
      events.push({ eventName, metadata })
    },
    logEventAsync: async (eventName, metadata) => {
      events.push({ eventName, metadata })
    },
  })
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
  resetSettingsCache()
  rmSync(tmpConfigDir, { recursive: true, force: true })
  resetToolSearchDeclared()
  resetAnalyticsForTesting()
})

afterAll(() => {
  mock.restore()
})

function modeDecisions(): SinkEvent[] {
  return events.filter(
    e => e.eventName === 'tengu_tool_search_mode_decision',
  )
}

// ---------------------------------------------------------------------------
// 1. The :1821 6th-arg threading — armed latch takes the auto_held path
// ---------------------------------------------------------------------------
describe('CC 2.1.300 #18 hold wiring — isToolSearchDeclared() 6th arg (claude.ts:1815-1822)', () => {
  test('armed latch + ENABLE_TOOL_SEARCH=auto → auto_held: ToolSearch on the wire, beta header set, no threshold recompute', async () => {
    // Arrange — simulate a conversation that already sent ToolSearch.
    noteToolSearchDeclared()
    process.env.ENABLE_TOOL_SEARCH = 'auto'
    responders = [successSSEResponse()]

    // Act
    const yielded = await runQuery([
      fakeToolSearchTool(),
      fakeDeferredMcpTool('mcp__srva__hidden', 'srva'),
    ])

    // Assert — one wire attempt; the held auto branch keeps ToolSearch and
    // defers the MCP tool (never discovered → not sent inline).
    const msgs = messageRequests()
    expect(msgs).toHaveLength(1)
    expect(sentToolNames(msgs[0]!)).toEqual([TOOL_SEARCH_NAME])
    expect(betaHeader(msgs[0]!)).toContain(TOOL_SEARCH_BETA_HEADER_1P)
    expect(assistantText(yielded)).toBe('PONG')
    // The hold short-circuits BEFORE checkAutoThreshold — zero count_tokens.
    // If the :1821 6th arg were hardcoded false, the threshold path would
    // run (count_tokens probe), fall below threshold, and ToolSearch would
    // be filtered OFF the wire — both assertions fail.
    expect(countTokenRequests()).toHaveLength(0)
    const held = modeDecisions().find(e => e.metadata.reason === 'auto_held')
    expect(held).toBeDefined()
    expect(held?.metadata.enabled).toBe(true)
    expect(held?.metadata.mode).toBe('tst-auto')
    expect(held?.metadata.checkedModel).toBe(MODEL)
  })
})

// ---------------------------------------------------------------------------
// 2. The :1870 arming — noteToolSearchDeclared() when the description ships
// ---------------------------------------------------------------------------
describe('CC 2.1.300 #18 hold wiring — noteToolSearchDeclared() arming (claude.ts:1870)', () => {
  test('a tst-mode query arms the latch, and a follow-up auto-mode query holds ToolSearch on the wire', async () => {
    // Arrange — fresh conversation, default mode ('tst' → always enabled).
    expect(isToolSearchDeclared()).toBe(false)
    const tools: Tool[] = [
      fakeToolSearchTool(),
      fakeDeferredMcpTool('mcp__srvb__hidden', 'srvb'),
    ]
    responders = [successSSEResponse()]

    // Act — query 1.
    await runQuery(tools)

    // Assert — ToolSearch went out on the wire, so the :1870 arming must
    // have fired (this assertion FAILS if noteToolSearchDeclared() is
    // deleted from claude.ts).
    expect(messageRequests()).toHaveLength(1)
    expect(sentToolNames(messageRequests()[0]!)).toEqual([TOOL_SEARCH_NAME])
    expect(isToolSearchDeclared()).toBe(true)

    // Arrange — flip to auto mode for the next query in the SAME
    // conversation: the deferred-tool descriptions are tiny, so WITHOUT the
    // hold the threshold would disable tool search mid-conversation.
    process.env.ENABLE_TOOL_SEARCH = 'auto'
    responders = [successSSEResponse()]

    // Act — query 2.
    const yielded2 = await runQuery(tools)

    // Assert — still held: ToolSearch on the wire, auto_held telemetry, no
    // threshold recompute (no count_tokens probe at all in this test).
    const msgs = messageRequests()
    expect(msgs).toHaveLength(2)
    expect(sentToolNames(msgs[1]!)).toEqual([TOOL_SEARCH_NAME])
    expect(betaHeader(msgs[1]!)).toContain(TOOL_SEARCH_BETA_HEADER_1P)
    expect(countTokenRequests()).toHaveLength(0)
    expect(assistantText(yielded2)).toBe('PONG')
    const held = modeDecisions().filter(e => e.metadata.reason === 'auto_held')
    expect(held).toHaveLength(1)
    // Query 1 logged the plain tst enablement.
    expect(
      modeDecisions().some(e => e.metadata.reason === 'tst_enabled'),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Control — unheld fresh conversation + auto mode → below threshold
// ---------------------------------------------------------------------------
describe('CC 2.1.300 #18 hold wiring — control (unheld auto conversation)', () => {
  test('fresh latch + ENABLE_TOOL_SEARCH=auto → auto_below_threshold: ToolSearch filtered OFF, tools inline, latch stays unarmed', async () => {
    // Arrange
    process.env.ENABLE_TOOL_SEARCH = 'auto'
    responders = [successSSEResponse()]

    // Act
    const yielded = await runQuery([
      fakeToolSearchTool(),
      fakeDeferredMcpTool('mcp__srvc__hidden', 'srvc'),
    ])

    // Assert — the threshold path ran (count_tokens probed, canned small
    // count → below threshold) and tool search is OFF: no ToolSearch entry,
    // the MCP tool goes out inline, no tool-search beta header.
    const msgs = messageRequests()
    expect(msgs).toHaveLength(1)
    expect(sentToolNames(msgs[0]!)).toEqual(['mcp__srvc__hidden'])
    expect(betaHeader(msgs[0]!)).not.toContain(TOOL_SEARCH_BETA_HEADER_1P)
    expect(countTokenRequests().length).toBeGreaterThan(0)
    expect(assistantText(yielded)).toBe('PONG')
    const below = modeDecisions().find(
      e => e.metadata.reason === 'auto_below_threshold',
    )
    expect(below).toBeDefined()
    expect(below?.metadata.enabled).toBe(false)
    // useToolSearch was false → the :1870 arming never ran.
    expect(isToolSearchDeclared()).toBe(false)
  })
})
