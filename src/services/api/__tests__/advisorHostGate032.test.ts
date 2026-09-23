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

/**
 * Acceptance #032 (P2) — the host-scoped advisor disable must gate SCHEMA
 * ASSEMBLY, not just the in-flight retry strip.
 *
 * Before this fix, `markAdvisorHostDisabled()` (official v280 `RJr`) was
 * write-only at the decision point: only the retry handler consulted the
 * host store, so the NEXT request to the same rejected host re-attached the
 * advisor beta header (claude.ts `betas.push(ADVISOR_BETA_HEADER)` gate) and
 * re-resolved advisorModel / the `advisor_20260301` schema (claude.ts
 * resolution gate) because both gates called the host-unaware
 * `isAdvisorEnabled()`. The fix swaps both claude.ts gates to
 * `isAdvisorEnabledForCurrentHost()` — the official v280 `qb()` analog
 * (`yct` minus the `$H` host arm).
 *
 * Like advisorRetryWiring276.test.ts, this file drives the REAL
 * `queryModelWithStreaming` with an HTTP-layer fetch mock, so every
 * assertion is on the actual wire bytes (request body `tools` + the
 * `anthropic-beta` header) of the request the production gates assembled.
 *
 * Mutation resistance: the disabled-host tests call `markAdvisorHostDisabled()`
 * with the session refused latch UNSET, and test 4 explicitly clears the
 * latch after a real host-scoped refusal — so the host-disable store is the
 * ONLY thing that can block the beta/schema. Reverting either claude.ts gate
 * to bare `isAdvisorEnabled()` re-attaches both and fails these tests
 * (verified during the fix — see the mutation-check note in the PR/report).
 */

// ---------------------------------------------------------------------------
// GrowthBook mock (OCC-97 discipline: spread the real module) — makes
// isAdvisorEnabled() true (tengu_sage_compass2 → {enabled:true}).
// ---------------------------------------------------------------------------
const GROWTHBOOK_MODULE_PATH = '../../analytics/growthbook.js'
const realGrowthbook = await import(GROWTHBOOK_MODULE_PATH)
mock.module(GROWTHBOOK_MODULE_PATH, () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: <T,>(key: string, defaultValue: T): T =>
    key === 'tengu_sage_compass2'
      ? ({ enabled: true } as unknown as T)
      : defaultValue,
}))

// ---------------------------------------------------------------------------
// VCR pass-through mock (same rationale as advisorRetryWiring276: under
// bun test NODE_ENV='test' activates the record/replay layer, which would
// cache whole query results keyed by message content and never reach the
// fetch mock).
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

// Require AFTER the mocks so claude.ts/advisor.ts bind the mocked growthbook.
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
  _resetAdvisorRefusalStateForTesting,
  isAdvisorEnabled,
  isAdvisorEntryRefused,
} = require('../../../utils/advisor.js') as typeof import('../../../utils/advisor.js')
const {
  _resetAdvisorHostDisableForTesting,
  isAdvisorEnabledForCurrentHost,
  markAdvisorHostDisabled,
} = require('../advisorRetry.js') as typeof import('../advisorRetry.js')
const { ADVISOR_BETA_HEADER } = require('../../../constants/betas.js') as typeof import(
  '../../../constants/betas.js'
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const INPUT_TAG_400 =
  "tools.0.model: Input tag 'advisor_20260301' found using 'type' does not match any tag."
const MODEL = 'claude-sonnet-4-6' // in modelSupportsAdvisor + isValidAdvisorModel allowlists
const ADVISOR_TOOL_TYPE = 'advisor_20260301'
// Two DISTINCT raw base URLs — the official host key (`Pk`/`xQr`) is the raw
// ANTHROPIC_BASE_URL string, deliberately NOT gateway-vendor-normalized, so
// disabling host A must leave host B enabled.
const HOST_A = 'https://gateway-a.example.com'
const HOST_B = 'https://gateway-b.example.com'

// Env isolation (same discipline as advisorRetryWiring276): a tmp
// CLAUDE_CONFIG_DIR keeps the ambient ~/.claude out of the auth path.
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
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch

// ---------------------------------------------------------------------------
// HTTP-layer fetch mock
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
        `advisorHostGate032: unexpected fetch call #${requests.length} to ${url}`,
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
            id: 'msg_01TEST',
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

const inputTag400 = () =>
  () =>
    new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: INPUT_TAG_400 },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )

// ---------------------------------------------------------------------------
// Query driver
// ---------------------------------------------------------------------------
function makeOptions(): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: MODEL,
    isNonInteractiveSession: true,
    // repl_main_thread → isAgenticQuery (claude.ts) — required by the
    // advisor resolution gate.
    querySource: 'repl_main_thread',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    advisorModel: MODEL,
  }
}

/** Runs the real queryModelWithStreaming and collects everything it yields. */
async function runQuery(): Promise<
  Array<{ type: string; message?: { content?: unknown } }>
> {
  const controller = new AbortController()
  const yielded: Array<{ type: string; message?: { content?: unknown } }> = []
  const gen = queryModelWithStreaming({
    messages: [createUserMessage({ content: 'PING' })],
    systemPrompt: asSystemPrompt(['You are a test assistant.']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
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

function hasAdvisorTool(req: RecordedRequest): boolean {
  const tools = (req.body?.tools ?? []) as Array<Record<string, unknown>>
  return tools.some(t => t.type === ADVISOR_TOOL_TYPE && t.name === 'advisor')
}

function hasAdvisorBeta(req: RecordedRequest): boolean {
  return (req.headers.get('anthropic-beta') ?? '').includes(ADVISOR_BETA_HEADER)
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
  // Deterministic firstParty + API-key auth. The assume-first-party flag
  // keeps isFirstPartyAnthropicBaseUrl() true while ANTHROPIC_BASE_URL points
  // at a test gateway host (the official allowlist would reject it) — the
  // host-disable key is the RAW base URL either way (official `xQr`).
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
  process.env.ANTHROPIC_BASE_URL = HOST_A

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-advisor-hostgate-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  resetSettingsCache()

  _resetAdvisorRefusalStateForTesting()
  _resetAdvisorHostDisableForTesting()
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
  _resetAdvisorRefusalStateForTesting()
  _resetAdvisorHostDisableForTesting()
  resetAnalyticsForTesting()
})

afterAll(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. Control — the non-disabled behavior is preserved EXACTLY
// ---------------------------------------------------------------------------
describe('#032 host gate — control (no host disabled)', () => {
  test('an un-disabled host still gets the advisor beta header AND schema', async () => {
    // Arrange
    expect(isAdvisorEnabled()).toBe(true)
    expect(isAdvisorEnabledForCurrentHost()).toBe(true)
    responders = [successSSEResponse()]

    // Act
    const yielded = await runQuery()

    // Assert — the request went to HOST_A carrying both advisor arms.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain('gateway-a.example.com')
    expect(hasAdvisorTool(requests[0]!)).toBe(true)
    expect(hasAdvisorBeta(requests[0]!)).toBe(true)
    expect(assistantText(yielded)).toBe('PONG')
  })
})

// ---------------------------------------------------------------------------
// 2. THE #032 CONTRACT — markAdvisorHostDisabled() gates the NEXT request
//    at schema-assembly time (production gate path, refused latch UNSET so
//    the host store is the only possible blocker).
// ---------------------------------------------------------------------------
describe('#032 host gate — schema-assembly decision consults the host store', () => {
  test('after markAdvisorHostDisabled(), the next request to that host attaches NEITHER beta header NOR advisor schema', async () => {
    // Arrange — HOST_A is current; mark it disabled directly (official
    // `RJr` — the store key is the raw ANTHROPIC_BASE_URL).
    expect(isAdvisorEnabled()).toBe(true)
    markAdvisorHostDisabled()
    // The process arm is untouched — ONLY the host arm flipped. If the
    // claude.ts gates still called bare isAdvisorEnabled(), everything
    // below would re-attach (this is the mutation-sensitive assertion).
    expect(isAdvisorEnabled()).toBe(true)
    expect(isAdvisorEnabledForCurrentHost()).toBe(false)
    expect(isAdvisorEntryRefused()).toBe(false)
    responders = [successSSEResponse()]

    // Act — the NEXT request to the same rejected host.
    const yielded = await runQuery()

    // Assert — production wire bytes: no advisor schema, no advisor beta.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain('gateway-a.example.com')
    expect(hasAdvisorTool(requests[0]!)).toBe(false)
    expect(hasAdvisorBeta(requests[0]!)).toBe(false)
    // The request itself still succeeds (non-advisor traffic is unaffected).
    expect(assistantText(yielded)).toBe('PONG')
  })

  test('a DIFFERENT host remains enabled while the marked host stays disabled for the session', async () => {
    // Arrange — disable HOST_A, then point the client at HOST_B.
    markAdvisorHostDisabled()
    expect(isAdvisorEnabledForCurrentHost()).toBe(false)
    process.env.ANTHROPIC_BASE_URL = HOST_B
    expect(isAdvisorEnabledForCurrentHost()).toBe(true)
    responders = [successSSEResponse()]

    // Act — request to HOST_B.
    const yielded = await runQuery()

    // Assert — HOST_B is untouched by HOST_A's disable: beta + schema attach.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain('gateway-b.example.com')
    expect(hasAdvisorTool(requests[0]!)).toBe(true)
    expect(hasAdvisorBeta(requests[0]!)).toBe(true)
    expect(assistantText(yielded)).toBe('PONG')

    // Arrange — back to HOST_A in the same session: still disabled.
    process.env.ANTHROPIC_BASE_URL = HOST_A
    expect(isAdvisorEnabledForCurrentHost()).toBe(false)
    responders = [successSSEResponse()]

    // Act
    await runQuery()

    // Assert
    expect(requests).toHaveLength(2)
    expect(requests[1]!.url).toContain('gateway-a.example.com')
    expect(hasAdvisorTool(requests[1]!)).toBe(false)
    expect(hasAdvisorBeta(requests[1]!)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Full production path — a real host-scoped INPUT_TAG 400 refusal marks
//    the host, and the host store ALONE (refused latch cleared) keeps the
//    next request clean; clearing the store re-opens the gate.
// ---------------------------------------------------------------------------
describe('#032 host gate — end-to-end refusal persistence', () => {
  test('host-scoped 400 → host store blocks re-attachment on the NEXT request even with the refused latch cleared', async () => {
    // Arrange — attempt 1 refused (Input-tag = host scope → official `RJr`),
    // attempt 2 is the stripped in-flight retry.
    responders = [inputTag400(), successSSEResponse()]
    expect(isAdvisorEnabled()).toBe(true)

    // Act — the refused query (in-flight retry path, unchanged by #032).
    const yielded = await runQuery()

    // Assert — in-flight strip still works and the host got marked.
    expect(requests).toHaveLength(2)
    expect(hasAdvisorTool(requests[0]!)).toBe(true)
    expect(hasAdvisorTool(requests[1]!)).toBe(false)
    expect(isAdvisorEntryRefused()).toBe(true)
    expect(isAdvisorEnabledForCurrentHost()).toBe(false)
    expect(assistantText(yielded)).toBe('PONG')

    // Arrange — clear ONLY the advisor.ts session latches, keeping the
    // advisorRetry.ts host store (they are separate stores). Without the
    // #032 gate wiring, isAdvisorEnabled() is true again (host-scoped
    // refusals never arm the org kill-switch) and the latch gate is open,
    // so the NEXT request would re-attach beta + schema and get refused
    // again — exactly the acceptance defect.
    _resetAdvisorRefusalStateForTesting()
    expect(isAdvisorEnabled()).toBe(true)
    expect(isAdvisorEntryRefused()).toBe(false)
    expect(isAdvisorEnabledForCurrentHost()).toBe(false)
    responders = [successSSEResponse()]

    // Act — next request to the same host.
    const yielded2 = await runQuery()

    // Assert — host store alone blocked both arms.
    expect(requests).toHaveLength(3)
    expect(hasAdvisorTool(requests[2]!)).toBe(false)
    expect(hasAdvisorBeta(requests[2]!)).toBe(false)
    expect(assistantText(yielded2)).toBe('PONG')

    // Arrange — clearing the host store re-opens the gate (proves the store
    // was the blocker, and the disable is session-scoped, not permanent).
    _resetAdvisorHostDisableForTesting()
    expect(isAdvisorEnabledForCurrentHost()).toBe(true)
    responders = [successSSEResponse()]

    // Act
    await runQuery()

    // Assert — beta + schema re-attached.
    expect(requests).toHaveLength(4)
    expect(hasAdvisorTool(requests[3]!)).toBe(true)
    expect(hasAdvisorBeta(requests[3]!)).toBe(true)
  })
})
