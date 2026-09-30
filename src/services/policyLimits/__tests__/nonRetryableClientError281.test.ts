import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MACRO polyfill — getClaudeCodeUserAgent() reads MACRO.VERSION, a build-time
// constant polyfilled in cli.tsx (same pattern as
// remoteManagedSettings/__tests__/forceRemoteSettingsRefresh.test.ts).
// Without it the fetch path throws a ReferenceError which classifyAxiosError
// deems retryable ('other'), turning every skip-retry assertion into a
// 6-attempt backoff storm.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * PORT #103 (CC 2.1.281): the policy limits fetch must stop retrying
 * never-succeeding 4xx responses immediately.
 *
 * Official wiring @206240887 (default branch of the fetch error result):
 *   `errorCode:"request_failed",httpStatus:I,skipRetry:c$e(I)`
 * where c$e = isNonRetryableClientError (@193033439) — 4xx except the
 * transient trio 408/409/429. Before the port, a 400/422 looped through all
 * DEFAULT_MAX_RETRIES(5)+1 attempts before failing. 408/409/429, 5xx, and
 * network errors keep the existing backoff policy.
 *
 * Mocking follows the repo template (snapshot actuals → mock.module →
 * dynamic-import SUT → restore in afterAll). axios.get rejects with
 * controllable axios-shaped errors; sleep records the backoff delay and
 * resolves immediately so retry loops don't burn real seconds.
 */

// --- hermetic env: eligible Console API-key user, first-party URL, temp config dir
const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-pl-103-'))
const savedEnv: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL:
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
}
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-port103'
process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
process.env.CLAUDE_CONFIG_DIR = TEST_CONFIG_DIR

// --- axios mock: every get rejects with a controllable axios-shaped error
const actualAxios = await import('axios')

// axios rejects with AxiosError instances (Error subclass + marker property);
// errorMessage()/classifyAxiosError rely on both.
const httpAxiosError = (status: number): Error =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: {}, headers: {} },
  })
const NETWORK_AXIOS_ERROR: Error = Object.assign(
  new Error('connect ECONNREFUSED 127.0.0.1:443'),
  { isAxiosError: true, code: 'ECONNREFUSED' },
)

let nextAxiosError: Error = httpAxiosError(400)
let axiosGetCallCount = 0
// 2.1.285 wiring test: capture the outgoing headers of the last get call.
let lastAxiosHeaders: Record<string, string> | null = null

const mockedGet = mock(
  async (
    _url: string,
    config?: { headers?: Record<string, string> },
  ): Promise<never> => {
    axiosGetCallCount += 1
    lastAxiosHeaders = config?.headers ?? null
    throw nextAxiosError
  },
)

mock.module('axios', () => ({
  ...actualAxios,
  default: { ...actualAxios.default, get: mockedGet },
}))

// --- sleep mock: record the backoff delay, resolve immediately
const actualSleepModule = await import('../../../utils/sleep.js')
let recordedSleeps: number[] = []

mock.module('../../../utils/sleep.js', () => ({
  ...actualSleepModule,
  sleep: async (ms: number) => {
    recordedSleeps = [...recordedSleeps, ms]
  },
}))

const { refreshPolicyLimits, _resetPolicyLimitsForTesting } = await import(
  '../index.js'
)
// Zero-arg memoized config paths (getGlobalClaudeFile) pin whatever
// CLAUDE_CONFIG_DIR was set at FIRST call — a full-suite run shares one
// process, so an earlier file's temp dir can stay pinned after its env
// restore (and its dir removal). Clear both known caches around this file's
// env window (repo precedent: autoModeReset.test.ts).
const { getGlobalClaudeFile } = await import('../../../utils/env.js')
const { getClaudeConfigHomeDir } = await import('../../../utils/envUtils.js')
const clearConfigPathCaches = (): void => {
  getGlobalClaudeFile.cache.clear()
  getClaudeConfigHomeDir.cache.clear()
}

// index.ts DEFAULT_MAX_RETRIES = 5 → 6 total attempts for retryable errors.
const TOTAL_ATTEMPTS_WHEN_RETRYABLE = 6
const BACKOFF_WAITS_WHEN_RETRYABLE = 5

beforeEach(() => {
  axiosGetCallCount = 0
  lastAxiosHeaders = null
  recordedSleeps = []
  nextAxiosError = httpAxiosError(400)
  clearConfigPathCaches()
  _resetPolicyLimitsForTesting()
})

afterAll(async () => {
  _resetPolicyLimitsForTesting()
  // Restore the real modules for later test files sharing this process.
  mock.module('axios', () => ({
    ...actualAxios,
    default: actualAxios.default,
  }))
  mock.module('../../../utils/sleep.js', () => ({ ...actualSleepModule }))
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  // Drop pins taken during this file's temp-CLAUDE_CONFIG_DIR window BEFORE
  // removing the dir, so no later file resolves a deleted path.
  clearConfigPathCaches()
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
})

describe('policyLimits retry — 2.1.281 #103 non-retryable 4xx skips retry', () => {
  test('400 stops after the first attempt with no backoff', async () => {
    nextAxiosError = httpAxiosError(400)
    await refreshPolicyLimits()
    expect(axiosGetCallCount).toBe(1)
    expect(recordedSleeps).toEqual([])
  })

  test('422 (the pre-port deadlock case) stops after the first attempt', async () => {
    nextAxiosError = httpAxiosError(422)
    await refreshPolicyLimits()
    expect(axiosGetCallCount).toBe(1)
    expect(recordedSleeps).toEqual([])
  })

  test('429 still retries with the existing backoff policy', async () => {
    nextAxiosError = httpAxiosError(429)
    await refreshPolicyLimits()
    expect(axiosGetCallCount).toBe(TOTAL_ATTEMPTS_WHEN_RETRYABLE)
    expect(recordedSleeps.length).toBe(BACKOFF_WAITS_WHEN_RETRYABLE)
    expect(recordedSleeps.every(ms => ms > 0)).toBe(true)
  })

  test('409 (transient 4xx) still retries with backoff', async () => {
    nextAxiosError = httpAxiosError(409)
    await refreshPolicyLimits()
    expect(axiosGetCallCount).toBe(TOTAL_ATTEMPTS_WHEN_RETRYABLE)
    expect(recordedSleeps.length).toBe(BACKOFF_WAITS_WHEN_RETRYABLE)
  })

  test('500 still retries with the existing backoff policy', async () => {
    nextAxiosError = httpAxiosError(500)
    await refreshPolicyLimits()
    expect(axiosGetCallCount).toBe(TOTAL_ATTEMPTS_WHEN_RETRYABLE)
    expect(recordedSleeps.length).toBe(BACKOFF_WAITS_WHEN_RETRYABLE)
  })

  test('network error (no HTTP status) still retries with backoff', async () => {
    nextAxiosError = NETWORK_AXIOS_ERROR
    await refreshPolicyLimits()
    expect(axiosGetCallCount).toBe(TOTAL_ATTEMPTS_WHEN_RETRYABLE)
    expect(recordedSleeps.length).toBe(BACKOFF_WAITS_WHEN_RETRYABLE)
  })

  test('401 auth error keeps its pre-existing immediate skipRetry', async () => {
    nextAxiosError = httpAxiosError(401)
    await refreshPolicyLimits()
    expect(axiosGetCallCount).toBe(1)
    expect(recordedSleeps).toEqual([])
  })
})

/**
 * PORT (CC 2.1.285) — official `pt()` wiring @209340651:
 *   let O=be(); ... I=await kD(jFt()?{}:{envBearerFallbackFor:O})
 * The fetch computes the policy-limits endpoint FIRST and hands it to the
 * header builder as the env-bearer fallback target. This test lives in THIS
 * file because it owns the axios mock window (see envBearerFallback285.test.ts
 * header comment for why that file deliberately registers no mocks).
 *
 * Scenario = the changelog bug: session authenticates with
 * ANTHROPIC_AUTH_TOKEN against the Anthropic API while a stored team OAuth
 * login keeps it policy-eligible. v284 built no headers here ("No API key
 * available" → auth_failed + skipRetry → zero axios calls); v285 sends
 * `Authorization: Bearer $ANTHROPIC_AUTH_TOKEN` with NO anthropic-beta.
 * The stored login is seeded through the REAL plainTextStorage path
 * (.credentials.json in the temp CLAUDE_CONFIG_DIR); refreshToken:null keeps
 * checkAndRefreshOAuthTokenIfNeeded on its early-return branch (no network).
 */
describe('policyLimits fetch wiring — 2.1.285 pt() passes the endpoint', () => {
  test('AUTH_TOKEN session with stored team OAuth sends the env bearer to the endpoint', async () => {
    const { clearOAuthTokenCache } = await import('../../../utils/auth.js')
    const credentialsPath = join(TEST_CONFIG_DIR, '.credentials.json')
    const savedApiKey = process.env.ANTHROPIC_API_KEY
    const savedNodeEnv = process.env.NODE_ENV
    const savedCi = process.env.CI
    // The fallback's ng() gate compares the endpoint host against the
    // configured ANTHROPIC_BASE_URL host — an ambient non-first-party
    // ANTHROPIC_BASE_URL (e.g. a local proxy) would suppress it. This
    // scenario is the default-base case: clear it for the test window.
    const savedBaseUrl = process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_BASE_URL
    // bun test defaults NODE_ENV to "test", which makes the real
    // getAnthropicApiKeyWithSource throw its CI guard when no env credential
    // exists (isAnthropicAuthEnabled calls it unguarded). This scenario is
    // exactly the no-API-key case — run it on the normal path.
    process.env.NODE_ENV = 'development'
    delete process.env.CI
    // NODE_ENV≠test arms the config-reading guard; enableConfigs() is the
    // idempotent process-wide unlock the production bootstrap calls.
    const { enableConfigs } = await import('../../../utils/config.js')
    enableConfigs()
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'stored-oauth-token',
          refreshToken: null,
          expiresAt: null,
          scopes: ['user:profile', 'user:inference'],
          subscriptionType: 'team',
          rateLimitTier: null,
        },
      }),
      'utf8',
    )
    delete process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-env-token'
    clearOAuthTokenCache()
    try {
      nextAxiosError = httpAxiosError(400)
      await refreshPolicyLimits()

      expect(axiosGetCallCount).toBe(1)
      expect(lastAxiosHeaders?.Authorization).toBe('Bearer sk-ant-env-token')
      // Official cRe fallback arm carries no anthropic-beta header.
      expect(lastAxiosHeaders?.['anthropic-beta']).toBeUndefined()
      expect(lastAxiosHeaders?.['x-api-key']).toBeUndefined()
      // 400 is non-retryable (2.1.281 behavior) — single attempt, no backoff.
      expect(recordedSleeps).toEqual([])
    } finally {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey
      }
      if (savedNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = savedNodeEnv
      }
      if (savedCi === undefined) {
        delete process.env.CI
      } else {
        process.env.CI = savedCi
      }
      if (savedBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL
      } else {
        process.env.ANTHROPIC_BASE_URL = savedBaseUrl
      }
      delete process.env.ANTHROPIC_AUTH_TOKEN
      rmSync(credentialsPath, { force: true })
      clearOAuthTokenCache()
    }
  })
})
