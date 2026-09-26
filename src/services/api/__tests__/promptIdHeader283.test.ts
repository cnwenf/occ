/**
 * CC 2.1.283 `x-claude-code-prompt-id` gateway header (OCC-138 / C1),
 * byte-verified against the official v2.1.283 linux-x64 ELF:
 *
 * - Constant `var bqn="x-claude-code-prompt-id"` @ELF 198746663 — NEW in 283
 *   (0 occurrences in the 2.1.282 binary). Also a member of the protected
 *   header set `TC` (error-message selection only; no OCC counterpart needed).
 * - Validator `en(t)` (chunk-s1pmhfks @ELF 195845579):
 *     var d=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
 *     function en(t){if(typeof t!=="string")return null;return d.test(t)?t:null}
 * - Client factory `EV` spread @ELF 202059092:
 *     ...W&&S!==void 0&&en(S)!==null&&{[bqn]:S}
 *   where W = the gateway-hints gate (`qnn`/Tle) and S = the promptId param.
 *   Gate off, promptId undefined, or a non-canonical UUID → header DROPPED
 *   silently (never throws).
 * - Call sites: only the query-engine client creations pass promptId (main
 *   query after `query_client_creation_start` @205359056 + the two yOt
 *   non-streaming fallbacks @205395827/205399719); verifyApiKey and side
 *   queries leave it undefined.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// getUserAgent() reads the build-time MACRO; supply the dev-time polyfill
// before client.js is (dynamically) imported, same guard as
// reservedNamespacePermissions282.test.ts.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import {
  PROMPT_ID_HEADER,
  validatePromptIdHeader,
} from '../gatewayHints.js'

const VALID_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const VALID_UUID_UPPER = '3F2504E0-4F89-41D3-9A0C-0305E82C3301'

// ---------------------------------------------------------------------------
// Pure validator (official `en`)
// ---------------------------------------------------------------------------

describe('2.1.283 C1 — validatePromptIdHeader (official en)', () => {
  test('header name matches the official binary string', () => {
    expect(PROMPT_ID_HEADER).toBe('x-claude-code-prompt-id')
  })

  test('canonical lowercase UUID passes through unchanged', () => {
    expect(validatePromptIdHeader(VALID_UUID)).toBe(VALID_UUID)
  })

  test('uppercase hex UUID passes (official regex carries /i)', () => {
    expect(validatePromptIdHeader(VALID_UUID_UPPER)).toBe(VALID_UUID_UPPER)
  })

  test('non-UUID strings are rejected → null (header dropped)', () => {
    for (const bad of [
      '',
      'not-a-uuid',
      // right shape, wrong segment lengths
      '3f2504e04f8941d39a0c0305e82c3301',
      '3f2504e0-4f89-41d3-9a0c-0305e82c330',
      '3f2504e0-4f89-41d3-9a0c-0305e82c33011',
      // right lengths, non-hex char
      'zf2504e0-4f89-41d3-9a0c-0305e82c3301',
      // anchored: embedded UUID with surrounding text
      `prefix-${VALID_UUID}`,
      `${VALID_UUID}-suffix`,
      ` ${VALID_UUID}`,
      `${VALID_UUID}\n`,
      // CRLF header-injection attempt must never reach the wire
      `${VALID_UUID}\r\nx-injected: 1`,
    ]) {
      expect(validatePromptIdHeader(bad)).toBeNull()
    }
  })

  test('non-string inputs are rejected → null (official typeof guard)', () => {
    for (const bad of [
      undefined,
      null,
      42,
      true,
      {},
      [],
      // eslint-disable-next-line no-new-wrappers -- pin the typeof!=="string" branch
      new String(VALID_UUID),
    ]) {
      expect(validatePromptIdHeader(bad)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// Client-level header emission (official EV spread)
// ---------------------------------------------------------------------------
//
// Env isolation mirrors advisorRetryWiring276: a tmp CLAUDE_CONFIG_DIR keeps
// the ambient ~/.claude (which may hold a real OAuth account) out of
// getAnthropicClient's auth path, and the gate is driven purely by the
// CLAUDE_CODE_GATEWAY_HINT_HEADERS tri-bool so provider config is irrelevant.

const GATE_ENV_KEY = 'CLAUDE_CODE_GATEWAY_HINT_HEADERS'
const ISOLATED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'USER_TYPE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  GATE_ENV_KEY,
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpConfigDir: string
let savedConfigDir: string | undefined

beforeEach(() => {
  savedEnv = {}
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-promptid283-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
})

afterEach(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

async function buildDefaultHeaders(opts: {
  gate: string
  promptId?: string
}): Promise<Headers> {
  process.env[GATE_ENV_KEY] = opts.gate
  const { getAnthropicClient } = await import('../client.js')
  const client = await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
    source: 'test_query',
    promptId: opts.promptId,
  })
  // SDK 0.80: the constructed defaultHeaders live on the private _options
  // bag (the client has no public defaultHeaders accessor). Wrap in Headers
  // for case-insensitive lookup.
  const raw = (
    client as unknown as { _options?: { defaultHeaders?: HeadersInit } }
  )._options?.defaultHeaders
  expect(raw).toBeDefined()
  return new Headers(raw)
}

afterAll(() => {
  // Nothing module-mocked; env restored per-test above.
})

describe('2.1.283 C1 — x-claude-code-prompt-id header emission', () => {
  test('gate ON + valid UUID → header sent verbatim', async () => {
    const headers = await buildDefaultHeaders({
      gate: 'true',
      promptId: VALID_UUID,
    })
    expect(headers.get(PROMPT_ID_HEADER)).toBe(VALID_UUID)
  })

  test('gate ON + uppercase UUID → header sent verbatim (no case folding)', async () => {
    const headers = await buildDefaultHeaders({
      gate: 'true',
      promptId: VALID_UUID_UPPER,
    })
    expect(headers.get(PROMPT_ID_HEADER)).toBe(VALID_UUID_UPPER)
  })

  test('gate ON + non-UUID promptId → header dropped silently', async () => {
    const headers = await buildDefaultHeaders({
      gate: 'true',
      promptId: `evil\r\n${VALID_UUID}`,
    })
    expect(headers.get(PROMPT_ID_HEADER)).toBeNull()
  })

  test('gate ON + promptId undefined → header absent (verifyApiKey parity)', async () => {
    const headers = await buildDefaultHeaders({ gate: 'true' })
    expect(headers.get(PROMPT_ID_HEADER)).toBeNull()
    // the 2.1.273 hint headers still flow in the same gated block
    expect(headers.get('x-claude-code-request-class')).not.toBeNull()
  })

  test('gate OFF + valid UUID → header absent (official W&&S&& spread)', async () => {
    const headers = await buildDefaultHeaders({
      gate: 'false',
      promptId: VALID_UUID,
    })
    expect(headers.get(PROMPT_ID_HEADER)).toBeNull()
    expect(headers.get('x-claude-code-request-class')).toBeNull()
  })
})
