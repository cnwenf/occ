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
 * CC 2.1.300 changelog #36 — claude.ts-LAYER integration coverage for the
 * MCP tool-schema 400 heal wiring (official `W1t(gd,st)` substitution
 * @227858355 inside the per-attempt params builder + `AGe` resolver
 * @225850721).
 *
 * toolSchemaRefused300.test.ts covers the classifier, resolver, canonical
 * hash, cap, retry token, and the withRetry hook in isolation. This file
 * closes the remaining gap (mutation-proven during acceptance: deleting the
 * `applyRefusedToolSchemas` wiring in claude.ts's `paramsFromContext`
 * (:2582-2589) left the whole 24-test r300 suite green). It drives the REAL
 * `queryModelWithStreaming` with an HTTP-layer fetch mock, so every
 * assertion is on the actual wire bytes of attempt N+1 after a
 * `tools.N.input_schema` refusal on attempt N:
 *
 *  - attempt 1 sends the MCP tool's full input_schema;
 *  - the 400 flows through withRetry's heal hook (:1005-1011) → the
 *    resolver records name→canonical-hash in the conversation-scoped map;
 *  - attempt 2's params are REBUILT by `paramsFromContext`, where
 *    `applyRefusedToolSchemas` (the :2587 wiring) substitutes
 *    EMPTY_INPUT_SCHEMA `{type:"object"}` — the assertion that FAILS if the
 *    wiring is deleted;
 *  - the substitution persists for the NEXT query in the same conversation
 *    (module-level map lifetime == conversation, documented deviation).
 *
 * fetch is mocked at globalThis (same discipline as advisorRetryWiring276):
 * buildFetch falls back to `globalThis.fetch` (client.ts:507), captured at
 * client-creation time inside the query, i.e. after the mock is installed.
 */

// ---------------------------------------------------------------------------
// VCR pass-through mock.
//
// Under bun test NODE_ENV defaults to 'test', which activates the VCR
// record/replay layer (src/services/vcr.ts shouldUseVCR): withVCR /
// withStreamingVCR cache WHOLE query results keyed only by message content,
// so identical 'PING' queries would replay the first recording and never
// reach the fetch mock. Mock the wrappers to pure pass-through instead
// (require claude.ts AFTER, same discipline as advisorRetryWiring276;
// ci-test.sh runs each file in its own process so the mock cannot leak).
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
  clearRefusedToolSchemas,
  EMPTY_INPUT_SCHEMA,
  getMcpSchemaRefusalNotes,
} = require('../refusedToolSchemas.js') as typeof import(
  '../refusedToolSchemas.js'
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
// Constants (byte-exact from the v300 binary; see toolSchemaRefused300)
// ---------------------------------------------------------------------------
const MODEL = 'claude-sonnet-4-6'

function schemaRefusedMessage(index: number): string {
  return `tools.${index}.input_schema: Input schema is invalid. Please ensure the schema is a valid JSON Schema object.`
}

// Env isolation: a tmp CLAUDE_CONFIG_DIR keeps the ambient ~/.claude (which
// may hold a real OAuth account) out of getAnthropicClient's auth path —
// isClaudeAISubscriber() stays false and the API-key branch is deterministic.
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
  'ENABLE_TOOL_SEARCH',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch

// ---------------------------------------------------------------------------
// HTTP-layer fetch mock (same recorder shape as advisorRetryWiring276)
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
        `mcpHealWiring300: unexpected fetch call #${requests.length} to ${url}`,
      )
    }
    return responder()
  }) as typeof fetch
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
            id: 'msg_01HEAL',
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

/** The official-shaped 400 the API sends when it refuses a tool schema. */
function schemaRefused400(index: number): () => Response {
  const message = schemaRefusedMessage(index)
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
// Fake MCP tool — only the fields the wire-build path reads (name, prompt,
// inputJSONSchema) plus isMcp/mcpInfo for the resolver's registry lookup
// (findToolByName → isMcpToolRefForSchemaRefusal → MCP-server note).
// Unique names per test: toolToAPISchema caches per session by tool name.
// ---------------------------------------------------------------------------
function fakeMcpTool(
  name: string,
  serverName: string,
  toolName: string,
): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName, toolName },
    inputJSONSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    },
    prompt: async () => `Fake MCP tool ${toolName} for heal-wiring tests.`,
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

/** The input_schema of the single tool entry in a recorded request body. */
function sentInputSchema(req: RecordedRequest): unknown {
  const tools = (req.body?.tools ?? []) as Array<Record<string, unknown>>
  expect(tools).toHaveLength(1)
  return tools[0]!.input_schema
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
  // Deterministic firstParty + API-key auth (isFirstPartyAnthropicBaseUrl).
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-mcp-heal-wiring-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  resetSettingsCache()

  // Conversation-scoped refused-tool-schema map starts empty each test.
  clearRefusedToolSchemas()
  resetAnalyticsForTesting()
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
  clearRefusedToolSchemas()
  resetAnalyticsForTesting()
})

afterAll(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. The heal retry — the :2582-2589 applyRefusedToolSchemas wiring
// ---------------------------------------------------------------------------
describe('CC 2.1.300 #36 heal wiring — tools.N.input_schema 400 (claude.ts:2582-2589)', () => {
  test('schema-refused 400 → attempt 2 re-sends the MCP tool with EMPTY_INPUT_SCHEMA, PONG delivered, note + telemetry recorded', async () => {
    // Arrange
    const events: Array<{
      eventName: string
      metadata: Record<string, unknown>
    }> = []
    attachAnalyticsSink({
      logEvent: (eventName, metadata) => {
        events.push({ eventName, metadata })
      },
      logEventAsync: async (eventName, metadata) => {
        events.push({ eventName, metadata })
      },
    })
    const tool = fakeMcpTool('mcp__healsrv__alpha', 'healsrv', 'alpha')
    responders = [schemaRefused400(0), successSSEResponse()]

    // Act
    const yielded = await runQuery([tool])

    // Assert — exactly two wire attempts.
    expect(requests).toHaveLength(2)
    // Attempt 1 carried the tool's full input schema.
    expect(requests[0]!.body?.tools).toBeDefined()
    expect(sentInputSchema(requests[0]!)).toEqual({
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    })
    // Attempt 2: paramsFromContext REBUILT the params and the :2587
    // applyRefusedToolSchemas wiring substituted the empty schema — this is
    // the assertion that FAILS if the wiring is deleted (attempt 2 would
    // re-send the refused full schema).
    expect(sentInputSchema(requests[1]!)).toEqual(EMPTY_INPUT_SCHEMA)
    // The retried stream flows through to the caller.
    expect(assistantText(yielded)).toBe('PONG')
    // Resolver telemetry (official `AGe` → tengu_api_tool_schema_replacement).
    const replaced = events.find(
      e =>
        e.eventName === 'tengu_api_tool_schema_replacement' &&
        e.metadata.action === 'replaced',
    )
    expect(replaced).toBeDefined()
    expect(replaced?.metadata.query_source).toBe('repl_main_thread')
    // MCP-server note recorded for /mcp surfacing (official @107537731).
    const note = getMcpSchemaRefusalNotes().get('healsrv')
    expect(note).toBeDefined()
    expect(note).toContain("the API refused this tool's input schema")
  })

  test('the substitution persists for the NEXT query in the same conversation', async () => {
    // Arrange — first query gets refused once, then succeeds.
    const tool = fakeMcpTool('mcp__healsrv2__beta', 'healsrv2', 'beta')
    responders = [schemaRefused400(0), successSSEResponse()]

    // Act — query 1 (heal happens), then query 2 on the same module state.
    await runQuery([tool])
    expect(requests).toHaveLength(2)
    responders = [successSSEResponse()]
    const yielded2 = await runQuery([tool])

    // Assert — query 2's FIRST attempt already sends the empty schema
    // (conversation-scoped refusedToolSchemas map + :2587 substitution).
    expect(requests).toHaveLength(3)
    expect(sentInputSchema(requests[2]!)).toEqual(EMPTY_INPUT_SCHEMA)
    expect(assistantText(yielded2)).toBe('PONG')
  })
})
