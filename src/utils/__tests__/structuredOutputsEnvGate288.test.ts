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
 * 2.1.288 (gap-research-288 cluster-d #14): structured outputs failing on
 * Mantle/gateways — official v288 adds `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS`
 * as a SECOND, INDEPENDENT kill-switch arm of the structured-outputs
 * capability gate.
 *
 * Official binary evidence (v288 linux-x64 ELF, byte-verified via dd):
 *   - v287 gate `FSn`@201390036 (2 arms):
 *       function FSn(e){let n=Be(e),r=lc(e);if(!H$(r))return!1;if(K4())return!1;return!lr(n,"claude-opus-4-1")}
 *   - v288 gate `aEn`@202198805 (3 arms — the string
 *     CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS sits at offset 202198805):
 *       function aEn(e){let n=Be(e),r=uc(e);if(!rF(r))return!1;if(O3())return!1;
 *         if(a.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS)return!1;return!sr(n,"claude-opus-4-1")}
 *     with `O3`@200808412:
 *       function O3(){return a.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS||sL()}  // sL = hipaa taint
 *   - v287 binary contains ZERO occurrences of the new string (grep -aobF) —
 *     it is new in v288. Other v288 sites: 94851532, 199612605 (env registry
 *     export map), 212352579 (session-env set Z_r, next to the EB var),
 *     213670299/213670340 (child-env propagation
 *     `...a.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS&&{CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS:"1"}`),
 *     232015967 (host-managed env list, next to the EB var).
 *   - v288 format writer `NWo`@209277463 (unchanged shape, now consults aEn):
 *       function NWo(e,n,r,s){if(!e||"format"in n||!aEn(s)||dae(s))return!1;
 *         if(n.format=e,!r.includes(WZ))r.push(WZ);return!0}
 *
 * The two env arms are INDEPENDENT: either variable alone disables structured
 * outputs (session titles, memory recall and prompt hooks stop sending
 * output_config.format behind Mantle/gateways that reject it).
 *
 * Parsing note (pre-existing OCC convention, same as the v287 EB arm): the
 * official arms use raw string truthiness (`if(a.X)`), OCC uses isEnvTruthy
 * ('1'/'true'/'yes'/'on') — the convention every CLAUDE_CODE_DISABLE_* gate in
 * betas.ts/api.ts/advisor.ts/toolSearch.ts already follows.
 *
 * These tests drive the predicate directly AND the real sideQuery() through an
 * HTTP-layer fetch mock, so the wire assertions are on the actual request
 * bytes — same discipline as structuredOutputsEnvGate287.test.ts.
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
  'CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS',
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
// HTTP-layer fetch mock (same shape as structuredOutputsEnvGate287.test.ts)
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
        `structuredOutputsEnvGate288: unexpected fetch call #${requests.length} to ${url}`,
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

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-structout-288-'))
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
// 1. The predicate itself — v288 `aEn` third arm
//    (if(a.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS)return!1)
// ---------------------------------------------------------------------------
describe('2.1.288 #14 — modelSupportsStructuredOutputs DISABLE_STRUCTURED_OUTPUTS arm (v288 aEn)', () => {
  test('control: supported model on firstParty returns true with both env vars unset', () => {
    // Arrange / Act / Assert
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(true)
  })

  test('CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS=1 makes it return false for every allowlisted model', () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '1'

    // Act / Assert
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(false)
    expect(modelSupportsStructuredOutputs('claude-sonnet-4-5')).toBe(false)
    expect(modelSupportsStructuredOutputs('claude-opus-4-1')).toBe(false)
    expect(modelSupportsStructuredOutputs('claude-opus-4-5')).toBe(false)
    expect(modelSupportsStructuredOutputs('claude-opus-4-6')).toBe(false)
    expect(modelSupportsStructuredOutputs('claude-haiku-4-5')).toBe(false)
  })

  test('isEnvTruthy spellings (true/yes/on) also disable, matching the sibling-arm convention', () => {
    // Arrange / Act / Assert
    for (const value of ['true', 'yes', 'on', 'TRUE', ' 1 ']) {
      process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = value
      expect(modelSupportsStructuredOutputs(MODEL)).toBe(false)
    }
  })

  test('falsy or empty values (0/false/empty string) leave the predicate unchanged', () => {
    // Arrange / Act / Assert — OCC isEnvTruthy convention (documented
    // divergence: the official arm is raw-string-truthy, so "0" would
    // disable there; every OCC CLAUDE_CODE_DISABLE_* gate parses with
    // isEnvTruthy, same as the v287 EB arm).
    for (const value of ['0', 'false', '', 'no', 'off']) {
      process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = value
      expect(modelSupportsStructuredOutputs(MODEL)).toBe(true)
    }
  })

  test('the provider arm still short-circuits first (bedrock → false, new env untouched)', () => {
    // Arrange
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    // Act / Assert
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Independence from CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS — the official
//    gate has TWO separate env arms (O3() and the new one); either alone
//    disables, in both directions.
// ---------------------------------------------------------------------------
describe('2.1.288 #14 — the two kill-switch arms are independent (v288 aEn O3 + third arm)', () => {
  test('DISABLE_STRUCTURED_OUTPUTS=1 alone (EB unset) → false', () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '1'
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS

    // Act / Assert
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(false)
  })

  test('DISABLE_EXPERIMENTAL_BETAS=1 alone (new var unset) → false (v287 arm unchanged)', () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    delete process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS

    // Act / Assert
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(false)
  })

  test('DISABLE_STRUCTURED_OUTPUTS=1 with DISABLE_EXPERIMENTAL_BETAS explicitly falsy → still false', () => {
    // Arrange — the new arm must NOT depend on the EB arm in any way.
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '1'
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '0'

    // Act / Assert
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(false)
  })

  test('DISABLE_EXPERIMENTAL_BETAS=1 with DISABLE_STRUCTURED_OUTPUTS explicitly falsy → still false', () => {
    // Arrange — mirror direction.
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '0'

    // Act / Assert
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(false)
  })

  test('both vars falsy → true (neither arm fires)', () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '0'
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '0'

    // Act / Assert
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(true)
  })

  test('both vars truthy → false', () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '1'
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'

    // Act / Assert
    expect(modelSupportsStructuredOutputs(MODEL)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. sideQuery wire bytes — the predicate change must reach the wire: with
//    the new kill switch on, NO output_config and NO structured-outputs beta
//    header go out, but the request itself still succeeds (this is the
//    session-title/memory-recall/prompt-hook path the changelog fixes).
// ---------------------------------------------------------------------------
describe('2.1.288 #14 — sideQuery output_config gate honors the new kill switch', () => {
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

  test('CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS=1 strips BOTH output_config and the beta header', async () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '1'
    responders = [jsonResponse()]

    // Act
    await runSideQuery()

    // Assert — no output_config anywhere in the wire body, no beta header,
    // but the request still goes out and succeeds (Mantle/gateway-safe).
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toBeDefined()
    expect('output_config' in (requests[0]!.body as object)).toBe(false)
    expect(JSON.stringify(requests[0]!.body)).not.toContain('output_config')
    expect(hasStructuredOutputsBeta(requests[0]!)).toBe(false)
  })

  test('CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS=0 leaves the wire unchanged', async () => {
    // Arrange
    process.env.CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS = '0'
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
})
