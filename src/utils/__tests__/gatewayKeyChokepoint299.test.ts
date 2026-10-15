import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearOAuthTokenCache } from '../auth.js'
import { getGlobalClaudeFile } from '../env.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { API_KEY_NOT_SENT_REASON } from '../firstPartyEndpoint.js'
import { getAuthHeaders } from '../http.js'

/**
 * CC 2.1.299 (#052 + #070): the anthropic-owned auxiliary chokepoint.
 *
 * Official `yr` (@218212300/@218212358):
 *   te=Z.headers["x-api-key"],
 *   le=Z.error??(te&&!f5(te)?"API key not sent: ANTHROPIC_BASE_URL is not an
 *   Anthropic host":void 0);
 *   if(le&&s.auth!=="optional")return{ok:!1,reason:"no-auth",detail:le};
 *   S=le?{}:Z.headers
 *
 * OCC applies the same rule inside getAuthHeaders() (src/utils/http.ts), the
 * single credential resolver behind growthbook init, 1P event logging,
 * feedback, usage, and metrics-opt-out. With a gateway key under a custom
 * ANTHROPIC_BASE_URL the resolver must return `.error` and NO key header;
 * with first-party config the key is attached; the OAuth (subscriber) branch
 * is unaffected (official `LZ` attaches Bearer independently of the base
 * URL).
 *
 * Test architecture — deliberately NO mock.module: a file-level auth mock
 * outlives this file's window and breaks siblings that drive the REAL auth
 * stack (see the cross-file rationale in
 * policyLimits/__tests__/envBearerFallback285.test.ts). Instead the real
 * auth stack is driven through its public inputs: ANTHROPIC_API_KEY /
 * ANTHROPIC_BASE_URL / CLAUDE_CODE_OAUTH_TOKEN env plus a temp
 * CLAUDE_CONFIG_DIR so no stored credentials leak in.
 */

const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-gw-chokepoint-'))

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'USER_TYPE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
]
const savedEnv: Record<string, string | undefined> = {}

function clearConfigPathCaches(): void {
  getGlobalClaudeFile.cache.clear()
  getClaudeConfigHomeDir.cache.clear()
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CLAUDE_CONFIG_DIR = TEST_CONFIG_DIR
  clearOAuthTokenCache()
  clearConfigPathCaches()
})

afterEach(() => {
  clearOAuthTokenCache()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  clearConfigPathCaches()
})

afterAll(async () => {
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
})

describe('getAuthHeaders gateway-key chokepoint (official yr/f5)', () => {
  test('drops a gateway key under a custom ANTHROPIC_BASE_URL with the official reason', () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env.ANTHROPIC_API_KEY = 'gw-secret-key'

    // Act
    const result = getAuthHeaders()

    // Assert — no key header leaks to Anthropic-owned endpoints
    expect(result.error).toBe(API_KEY_NOT_SENT_REASON)
    expect(result.headers).toEqual({})
    expect(JSON.stringify(result.headers)).not.toContain('gw-secret-key')
  })

  test('still attaches a genuine sk-ant- key under a gateway base URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-genuine'

    const result = getAuthHeaders()

    expect(result.error).toBeUndefined()
    expect(result.headers['x-api-key']).toBe('sk-ant-api03-genuine')
  })

  test('attaches any key with first-party config (base URL unset)', () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_API_KEY = 'console-key'

    const result = getAuthHeaders()

    expect(result.error).toBeUndefined()
    expect(result.headers['x-api-key']).toBe('console-key')
  })

  test('attaches the key when the base URL is api.anthropic.com itself', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    process.env.ANTHROPIC_API_KEY = 'console-key'

    const result = getAuthHeaders()

    expect(result.error).toBeUndefined()
    expect(result.headers['x-api-key']).toBe('console-key')
  })

  test('leaves the OAuth subscriber branch untouched even behind a gateway base URL', () => {
    // Official LZ: Bearer is attached independently of ANTHROPIC_BASE_URL.
    // CLAUDE_CODE_OAUTH_TOKEN injects a subscriber token (env-sourced tokens
    // carry the inference scope → isClaudeAISubscriber() is true).
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'injected-oauth-token'

    const result = getAuthHeaders()

    expect(result.error).toBeUndefined()
    expect(result.headers.Authorization).toBe('Bearer injected-oauth-token')
    expect(result.headers['x-api-key']).toBeUndefined()
  })
})
