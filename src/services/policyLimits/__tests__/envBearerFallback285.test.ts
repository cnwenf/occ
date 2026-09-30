import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthTokens } from '../../../services/oauth/types.js'

/**
 * PORT (CC 2.1.285): "Fixed sessions that authenticate with
 * ANTHROPIC_AUTH_TOKEN against the Anthropic API never loading the
 * organization's policy."
 *
 * Official v285 `cRe(e={})` header builder (auth chunk @198114510 region,
 * byte-verified):
 *   ... no API key ...
 *   if(ut()){ let r=ln(); if(!r?.accessToken) return no_oauth_token;
 *             return Bearer + anthropic-beta:oauth-2025-04-20 }
 *   let n=nS(); if(!n){
 *     let r=e.envBearerFallbackFor, s=r?ev():void 0;
 *     if(s&&r&&wh()&&ng(r)&&!a.ANTHROPIC_UNIX_SOCKET)
 *       return{headers:{Authorization:`Bearer ${s}`}};
 *     return no_api_key }
 *   return x-api-key
 *
 * v284 (`ARe` @200263118) had no envBearerFallbackFor arm: an
 * ANTHROPIC_AUTH_TOKEN session kept its stored team/enterprise OAuth login
 * ELIGIBLE (official `$Ce`, unchanged v284≡v285) but `ut()` was false
 * (`nl()`=false with AUTH_TOKEN set), so the header build failed with "No API
 * key available" → auth_failed + skipRetry → the org policy never loaded.
 * v285 adds the env-bearer fallback inside the no-API-key branch (NO
 * anthropic-beta header on that arm).
 *
 * Test architecture — deliberately NO mock.module and NO top-level env
 * mutation: bun loads every test file's top level before any tests run, so a
 * file-level axios/auth mock here would still be registered while
 * nonRetryableClientError281.test.ts's tests execute (and top-level env
 * deletes would wipe that file's env contract). Instead the REAL auth stack
 * is driven through its public inputs:
 *   - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL /
 *     ANTHROPIC_UNIX_SOCKET / _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL env
 *   - a `.credentials.json` (plainTextStorage on Linux) inside a temp
 *     CLAUDE_CONFIG_DIR for the stored team OAuth login
 * The env snapshot/restore lives in beforeAll/afterAll (which run inside
 * this file's test window, after every file's top level has executed), so
 * sibling files' env is preserved byte-for-byte. The SUT is imported lazily
 * in beforeAll for the same first-instantiation-wins reason. The network
 * layer (fetchPolicyLimits passing the endpoint as envBearerFallbackFor,
 * official `pt()`: `kD(jFt()?{}:{envBearerFallbackFor:O})`) is asserted in
 * nonRetryableClientError281.test.ts, which owns the axios mock window.
 *
 * The official `no_oauth_token` arm (inference-scoped tokens without an
 * accessToken) is unreachable through real storage (getClaudeAIOAuthTokens
 * returns null unless oauthData.accessToken) — OCC keeps it as a defensive
 * branch mirroring cRe; it is not unit-testable through the public inputs.
 */

const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-pl-285-'))
const CREDENTIALS_PATH = join(TEST_CONFIG_DIR, '.credentials.json')

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'USER_TYPE',
  'CLAUDE_CONFIG_DIR',
] as const

const POLICY_ENDPOINT =
  'https://api.anthropic.com/api/claude_code/policy_limits'

// Snapshot taken in beforeAll — i.e. AFTER every sibling file's top-level env
// setup has run — and restored verbatim in afterAll so later files' windows
// see exactly what their own top level established.
//
// NODE_ENV/CI: bun test defaults NODE_ENV to "test", which flips the real
// getAnthropicApiKeyWithSource into its CI guard — it THROWS
// "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required" when no
// env credential exists. The no-API-key scenarios below (the whole point of
// the 2.1.285 fix) must exercise the normal path, so this window runs with
// NODE_ENV=development and CI unset, restored in afterAll.
let savedEnv: Record<string, string | undefined> = {}

let getAuthHeaders: (options?: {
  envBearerFallbackFor?: string
}) => { headers: Record<string, string>; error?: string }
let clearOAuthTokenCache: () => void
let clearConfigPathCaches: () => void

const teamOAuthTokens = (
  accessToken: string | null,
  scopes: string[] = ['user:profile', 'user:inference'],
): OAuthTokens =>
  ({
    accessToken,
    refreshToken: null,
    expiresAt: null,
    scopes,
    subscriptionType: 'team',
    rateLimitTier: null,
  }) as OAuthTokens

function writeStoredOAuth(tokens: OAuthTokens): void {
  writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify({ claudeAiOauth: tokens }),
    'utf8',
  )
}

function removeStoredOAuth(): void {
  rmSync(CREDENTIALS_PATH, { force: true })
}

beforeAll(async () => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
  savedEnv.NODE_ENV = process.env.NODE_ENV
  savedEnv.CI = process.env.CI
  process.env.NODE_ENV = 'development'
  delete process.env.CI
  // NODE_ENV≠test arms the config-reading guard ("Config accessed before
  // allowed"); enableConfigs() is the idempotent process-wide unlock the
  // production bootstrap calls.
  const { enableConfigs } = await import('../../../utils/config.js')
  enableConfigs()

  const sut = await import('../index.js')
  getAuthHeaders = sut.getAuthHeaders
  const auth = await import('../../../utils/auth.js')
  clearOAuthTokenCache = auth.clearOAuthTokenCache
  const { getGlobalClaudeFile } = await import('../../../utils/env.js')
  const { getClaudeConfigHomeDir } = await import('../../../utils/envUtils.js')
  clearConfigPathCaches = (): void => {
    getGlobalClaudeFile.cache.clear()
    getClaudeConfigHomeDir.cache.clear()
  }
})

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
  process.env.CLAUDE_CONFIG_DIR = TEST_CONFIG_DIR
  removeStoredOAuth()
  clearOAuthTokenCache()
  clearConfigPathCaches()
})

afterAll(async () => {
  removeStoredOAuth()
  clearOAuthTokenCache()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  clearConfigPathCaches()
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
})

describe('policyLimits getAuthHeaders — 2.1.285 env-bearer fallback', () => {
  test('API key still wins with x-api-key (no Authorization)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-env-token'
    const result = getAuthHeaders({ envBearerFallbackFor: POLICY_ENDPOINT })
    expect(result.headers['x-api-key']).toBe('sk-ant-test-key')
    expect(result.headers.Authorization).toBeUndefined()
    expect(result.error).toBeUndefined()
  })

  test('OAuth branch wins when ut() is true and the stored token has the inference scope', () => {
    writeStoredOAuth(teamOAuthTokens('stored-oauth-token'))
    clearOAuthTokenCache()
    const result = getAuthHeaders({ envBearerFallbackFor: POLICY_ENDPOINT })
    expect(result.headers.Authorization).toBe('Bearer stored-oauth-token')
    expect(result.headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(result.error).toBeUndefined()
  })

  test('THE FIX: AUTH_TOKEN session (ut()=false) with stored team OAuth falls back to the env bearer — v284 returned "No authentication available"', () => {
    writeStoredOAuth(teamOAuthTokens('stored-oauth-token'))
    clearOAuthTokenCache()
    // ANTHROPIC_AUTH_TOKEN flips the real isAnthropicAuthEnabled() to false
    // (official nl()) — exactly the changelog's broken session shape.
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-env-token'
    const result = getAuthHeaders({ envBearerFallbackFor: POLICY_ENDPOINT })
    expect(result.headers.Authorization).toBe('Bearer sk-ant-env-token')
    // Official fallback arm carries NO anthropic-beta header (verbatim cRe).
    expect(result.headers['anthropic-beta']).toBeUndefined()
    expect(result.error).toBeUndefined()
  })

  test('stored OAuth without the inference scope skips the OAuth branch (RF/vbn gate)', () => {
    writeStoredOAuth(
      teamOAuthTokens('console-token', ['org:create_api_key', 'user:profile']),
    )
    clearOAuthTokenCache()
    const result = getAuthHeaders({ envBearerFallbackFor: POLICY_ENDPOINT })
    // No AUTH_TOKEN set → the fallback has no credential either.
    expect(result.headers).toEqual({})
    expect(result.error).toBe('No authentication available')
  })

  test('non-inference-scope OAuth + AUTH_TOKEN → fallback still fires', () => {
    writeStoredOAuth(
      teamOAuthTokens('console-token', ['org:create_api_key', 'user:profile']),
    )
    clearOAuthTokenCache()
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-env-token'
    const result = getAuthHeaders({ envBearerFallbackFor: POLICY_ENDPOINT })
    expect(result.headers.Authorization).toBe('Bearer sk-ant-env-token')
  })

  test('no envBearerFallbackFor option → fallback never fires (official s=r?ev():void 0)', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-env-token'
    const result = getAuthHeaders()
    expect(result.headers).toEqual({})
    expect(result.error).toBe('No authentication available')
  })

  test('no credential at all → No authentication available (v284 behavior preserved)', () => {
    const result = getAuthHeaders({ envBearerFallbackFor: POLICY_ENDPOINT })
    expect(result.headers).toEqual({})
    expect(result.error).toBe('No authentication available')
  })

  test('ANTHROPIC_UNIX_SOCKET suppresses the fallback', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-env-token'
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/test.sock'
    const result = getAuthHeaders({ envBearerFallbackFor: POLICY_ENDPOINT })
    expect(result.headers).toEqual({})
    expect(result.error).toBe('No authentication available')
  })

  test('non-first-party ANTHROPIC_BASE_URL suppresses the fallback (wh() gate)', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-env-token'
    process.env.ANTHROPIC_BASE_URL = 'https://my-gateway.example.com'
    const result = getAuthHeaders({
      envBearerFallbackFor:
        'https://my-gateway.example.com/api/claude_code/policy_limits',
    })
    expect(result.error).toBe('No authentication available')
  })

  test('endpoint host ≠ configured base host suppresses the fallback (ng() gate)', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-env-token'
    const result = getAuthHeaders({
      envBearerFallbackFor:
        'https://claude.fedstart.com/api/claude_code/policy_limits',
    })
    expect(result.error).toBe('No authentication available')
  })

  test('http (non-https) endpoint suppresses the fallback (MC gate)', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-env-token'
    const result = getAuthHeaders({
      envBearerFallbackFor:
        'http://api.anthropic.com/api/claude_code/policy_limits',
    })
    expect(result.error).toBe('No authentication available')
  })

  test('approved FedStart base (DC/mIe arm) admits the fallback when wh() is assumed', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-env-token'
    process.env.ANTHROPIC_BASE_URL = 'https://claude.fedstart.com'
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
    const result = getAuthHeaders({
      envBearerFallbackFor:
        'https://claude.fedstart.com/api/claude_code/policy_limits',
    })
    expect(result.headers.Authorization).toBe('Bearer sk-ant-env-token')
  })
})
