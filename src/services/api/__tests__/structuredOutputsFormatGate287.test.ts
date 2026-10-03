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
 * 2.1.287 (gap-research-287 cluster-b Item 3): the claude.ts
 * `outputConfig.format` WRITE must be gated on the structured-outputs
 * capability predicate, matching the official wire writer `lNo`:
 *
 *   function lNo(e,n,r,s){if(!e||"format"in n||!FSn(s)||!t_e(s,"structured_outputs"))return;
 *   if(n.format=e,!r.includes(Uoe))r.push(Uoe)}
 *
 * i.e. NO format without the gate — and v287 `FSn` gained the
 * `if(K4())return!1` arm (K4 = CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS || hipaa;
 * hipaa has no OCC surface). Before this fix OCC wrote the format
 * unconditionally and gated only the beta-header push, so the kill-switch env
 * still sent output_config.format on the wire — the v286 bug that made
 * Bedrock-fronting gateways reject session-title / prompt-hook requests.
 *
 * Like advisorHostGate032.test.ts, this file drives the REAL
 * `queryModelWithStreaming` with an HTTP-layer fetch mock, so every assertion
 * is on the actual wire bytes (request body `output_config` + the
 * `anthropic-beta` header) the production gates assembled.
 */

// ---------------------------------------------------------------------------
// GrowthBook mock (OCC-97 discipline: spread the real module) — defaults keep
// the beta table deterministic (tengu_tool_pear off → the beta-table
// structured-outputs arm can never fire; only the claude.ts format gate can
// push the header).
// ---------------------------------------------------------------------------
const GROWTHBOOK_MODULE_PATH = '../../analytics/growthbook.js'
const realGrowthbook = await import(GROWTHBOOK_MODULE_PATH)
mock.module(GROWTHBOOK_MODULE_PATH, () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: <T,>(
    _key: string,
    defaultValue: T,
  ): T => defaultValue,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
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

// Require AFTER the mocks so claude.ts/betas.ts bind the mocked growthbook.
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
const { clearBetasCaches } = require('../../../utils/betas.js') as typeof import(
  '../../../utils/betas.js'
)
const { STRUCTURED_OUTPUTS_BETA_HEADER } = require('../../../constants/betas.js') as typeof import(
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
const MODEL = 'claude-sonnet-4-6' // in the modelSupportsStructuredOutputs allowlist
const OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
  },
} as const

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BETAS',
  'USER_TYPE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'DISABLE_INTERLEAVED_THINKING',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof globalThis.fetch
let tmpConfigDir: string
let prevConfigDir: string | undefined

// ---------------------------------------------------------------------------
// HTTP-layer fetch mock (same shape as advisorHostGate032.test.ts)
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
        `structuredOutputsFormatGate287: unexpected fetch call #${requests.length} to ${url}`,
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
    // The Item-3 payload: a session-title-style structured output format.
    outputFormat: OUTPUT_FORMAT,
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

function hasStructuredOutputsBeta(req: RecordedRequest): boolean {
  return (req.headers.get('anthropic-beta') ?? '').includes(
    STRUCTURED_OUTPUTS_BETA_HEADER,
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
  // Deterministic firstParty + API-key auth (no base URL → api.anthropic.com).
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-structout-fmt-287-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  resetSettingsCache()
  clearBetasCaches()

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
  clearBetasCaches()
  rmSync(tmpConfigDir, { recursive: true, force: true })
  resetAnalyticsForTesting()
})

afterAll(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. Control — the ungated behavior is preserved EXACTLY (mutation anchor:
//    the format write + beta push happen when the env is unset).
// ---------------------------------------------------------------------------
describe('2.1.287 Item 3 — claude.ts format gate control', () => {
  test('with the env unset, outputFormat reaches output_config.format AND the beta header is pushed', async () => {
    // Arrange
    responders = [successSSEResponse()]

    // Act
    const yielded = await runQuery()

    // Assert — production wire bytes.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body?.output_config).toEqual({
      format: OUTPUT_FORMAT,
    })
    expect(hasStructuredOutputsBeta(requests[0]!)).toBe(true)
    expect(assistantText(yielded)).toBe('PONG')
  })
})

// ---------------------------------------------------------------------------
// 2. THE Item-3 CONTRACT — CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS strips the
//    format write itself (official v287 `lNo` + `FSn` K4 arm), not just the
//    beta header. The request must still succeed without output_config.
// ---------------------------------------------------------------------------
describe('2.1.287 Item 3 — claude.ts format write honors the kill switch', () => {
  test('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 omits BOTH output_config.format AND the structured-outputs beta', async () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    responders = [successSSEResponse()]

    // Act
    const yielded = await runQuery()

    // Assert — no output_config anywhere in the wire body, no beta header,
    // and the turn still completes (only the format is stripped).
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toBeDefined()
    expect('output_config' in (requests[0]!.body as object)).toBe(false)
    expect(JSON.stringify(requests[0]!.body)).not.toContain('output_config')
    expect(hasStructuredOutputsBeta(requests[0]!)).toBe(false)
    expect(assistantText(yielded)).toBe('PONG')
  })
})

// ---------------------------------------------------------------------------
// 3. 2.1.288 (gap-research-288 cluster-d #14) — the v288 gate `aEn`@202198805
//    added a THIRD arm, independent of the v287 EB arm:
//      function aEn(e){let n=Be(e),r=uc(e);if(!rF(r))return!1;if(O3())return!1;
//        if(a.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS)return!1;return!sr(n,"claude-opus-4-1")}
//    CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS alone must strip the format write
//    (official writer `NWo`@209277463 consults aEn) so Mantle/gateway setups
//    that reject structured outputs can turn them off without disabling every
//    experimental beta.
// ---------------------------------------------------------------------------
describe('2.1.288 #14 — claude.ts format write honors CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS', () => {
  test('CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS=1 (EB unset) omits BOTH output_config.format AND the structured-outputs beta', async () => {
    // Arrange — the new arm must fire WITHOUT the v287 EB var (independence).
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '1'
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    responders = [successSSEResponse()]

    // Act
    const yielded = await runQuery()

    // Assert — no output_config anywhere in the wire body, no beta header,
    // and the turn still completes (only the format is stripped).
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toBeDefined()
    expect('output_config' in (requests[0]!.body as object)).toBe(false)
    expect(JSON.stringify(requests[0]!.body)).not.toContain('output_config')
    expect(hasStructuredOutputsBeta(requests[0]!)).toBe(false)
    expect(assistantText(yielded)).toBe('PONG')
  })

  test('CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS=1 with DISABLE_EXPERIMENTAL_BETAS explicitly falsy still strips the format', async () => {
    // Arrange — the new arm does not depend on the EB arm's value.
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '1'
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '0'
    responders = [successSSEResponse()]

    // Act
    await runQuery()

    // Assert
    expect(requests).toHaveLength(1)
    expect('output_config' in (requests[0]!.body as object)).toBe(false)
    expect(hasStructuredOutputsBeta(requests[0]!)).toBe(false)
  })

  test('CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS=0 (falsy) leaves the format write + beta push unchanged', async () => {
    // Arrange — falsy values must NOT disable (isEnvTruthy convention, same
    // parsing as the sibling EB arm).
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '0'
    responders = [successSSEResponse()]

    // Act
    const yielded = await runQuery()

    // Assert
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body?.output_config).toEqual({
      format: OUTPUT_FORMAT,
    })
    expect(hasStructuredOutputsBeta(requests[0]!)).toBe(true)
    expect(assistantText(yielded)).toBe('PONG')
  })
})
