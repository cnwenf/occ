import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
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

const mockedGet = mock(
  async (_url: string, _config?: unknown): Promise<never> => {
    axiosGetCallCount += 1
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
