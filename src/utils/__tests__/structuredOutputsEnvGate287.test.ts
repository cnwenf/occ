// The real sideQuery path computes a message fingerprint reading MACRO.VERSION
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

/**
 * 2.1.287 (gap-research-287 cluster-b Item 3): CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
 * must strip the structured-output FORMAT, not just the beta header.
 *
 * Official binary evidence (v287, docs/gap-research-287/
 * cluster-b-protocol-auth-security.md Item 3):
 *   - v287 `FSn` @198808640 adds the env arm to the structured-outputs
 *     capability gate:
 *       function FSn(e){let n=Be(e),r=lc(e);if(!H$(r))return!1;if(K4())return!1;return!lr(n,"claude-opus-4-1")}
 *       function K4(){return a.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS||UD()}   // UD = hipaa taint (no OCC surface)
 *     (v286 `yhn` never consulted the env var — the bug.)
 *   - v287 sideQuery @205187168 gates BOTH the beta push and the
 *     output_config write on the predicate:
 *       let Ft=Boolean(S)&&ht(()=>FSn(We))&&t_e(We,"structured_outputs")
 *
 * These tests drive the REAL sideQuery() through an HTTP-layer fetch mock, so
 * every assertion is on the actual wire bytes (request body + anthropic-beta
 * header) the production gates assembled — same discipline as
 * advisorHostGate032.test.ts.
 */

// ---------------------------------------------------------------------------
// GrowthBook mock (OCC-97 discipline: spread the real module) — betas.ts
// reads the cached gates; defaults keep the beta table deterministic.
// ---------------------------------------------------------------------------
const GROWTHBOOK_MODULE_PATH = '../../services/analytics/growthbook.js'
const realGrowthbook = await import(GROWTHBOOK_MODULE_PATH)
mock.module(GROWTHBOOK_MODULE_PATH, () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: <T,>(
    _key: string,
    defaultValue: T,
  ): T => defaultValue,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
}))

// Require AFTER the mocks so betas.ts binds the mocked growthbook.
const { modelSupportsStructuredOutputs, clearBetasCaches } =
  require('../betas.js') as typeof import('../betas.js')
const { sideQuery } = require('../sideQuery.js') as typeof import('../sideQuery.js')
const { STRUCTURED_OUTPUTS_BETA_HEADER } = require('../../constants/betas.js') as typeof import(
  '../../constants/betas.js'
)
const { resetSettingsCache } = require('../settings/settingsCache.js') as {
  resetSettingsCache: () => void
}
const { getClaudeConfigHomeDir } = require('../envUtils.js') as {
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
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
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
        `structuredOutputsEnvGate287: unexpected fetch call #${requests.length} to ${url}`,
      )
    }
    return responder()
  }) as typeof fetch
}

/** A minimal successful non-streaming BetaMessage response. */
function jsonResponse(): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        id: 'msg_01TEST',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: 'A Title' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

/** Drives the real sideQuery with the session-title-style output_format. */
async function runSideQuery(): Promise<void> {
  await sideQuery({
    model: MODEL,
    system: 'You are a title generator.',
    messages: [{ role: 'user', content: 'PING' }],
    output_format: OUTPUT_FORMAT,
    max_tokens: 64,
    querySource: 'generate_session_title',
  })
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

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-structout-287-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  resetSettingsCache()
  clearBetasCaches()

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
})

afterAll(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// 1. The predicate itself (v287 `FSn` K4 arm)
// ---------------------------------------------------------------------------
describe('2.1.287 Item 3 — modelSupportsStructuredOutputs env arm (v287 FSn/K4)', () => {
  test('control: supported model on firstParty returns true with the env unset', () => {
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(true)
  })

  test('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 makes it return false', () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(false)
    expect(modelSupportsStructuredOutputs('claude-opus-4-5')).toBe(false)
    expect(modelSupportsStructuredOutputs('claude-haiku-4-5')).toBe(false)
  })

  test('the provider arm still short-circuits first (bedrock → false, env untouched)', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. sideQuery wire bytes — THE Item-3 contract (official `Ft` gates both
//    the beta push and the output_config write).
// ---------------------------------------------------------------------------
describe('2.1.287 Item 3 — sideQuery output_config gate (official Ft)', () => {
  test('control: output_format flows to output_config.format + the beta header', async () => {
    // Arrange
    responders = [jsonResponse()]

    // Act
    await runSideQuery()

    // Assert
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body?.output_config).toEqual({
      format: OUTPUT_FORMAT,
    })
    expect(hasStructuredOutputsBeta(requests[0]!)).toBe(true)
  })

  test('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 strips BOTH output_config and the beta header', async () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    responders = [jsonResponse()]

    // Act
    await runSideQuery()

    // Assert — no output_config anywhere in the wire body, no beta header,
    // but the request itself still goes out and succeeds.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toBeDefined()
    expect('output_config' in (requests[0]!.body as object)).toBe(false)
    expect(JSON.stringify(requests[0]!.body)).not.toContain('output_config')
    expect(hasStructuredOutputsBeta(requests[0]!)).toBe(false)
  })
})
