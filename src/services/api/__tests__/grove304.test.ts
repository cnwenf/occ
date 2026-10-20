/**
 * CC 2.1.304 #27 — Grove hardening (docs/gap-research-304/research-R5-cli-ux.md #27):
 * (a) getGroveNoticeConfig failure clears its memo cache AND propagates the
 *     HTTP status (`errorStatus`) — ApiResult extended per the official `v`
 *     HTTP-status error class;
 * (b) shape validation with the official verbatim messages
 *     'Grove notice config answer has no boolean grove_enabled' /
 *     'Grove settings answer has no boolean or null grove_enabled';
 * (c) markGroveNoticeViewed/updateGroveSettings cache-clear moved to `finally`
 *     (a failed POST/PATCH may still have landed server-side);
 * (d) fetchAndStoreGroveConfig: server-error answer (errorStatus present,
 *     !== 401) + existing cache entry → re-stamp timestamp, keep the last
 *     known-good grove_enabled (avoids an hourly refetch storm).
 *
 * No pre-existing grove tests existed (deviation note in impl-WP7.md) — this
 * is the new suite. axios + config + auth are mocked at the module seam and
 * restored in afterAll (OCC-97: Bun's mock.module crosses file boundaries in
 * the same worker).
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import * as REAL_DEBUG_NS from '../../../utils/debug.js'
import * as REAL_LOG_NS from '../../../utils/log.js'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// OCC-97 pattern: snapshot the real exports BEFORE mocking so afterAll can
// hand later test files in this worker the unmocked modules back.
const REAL_AXIOS_SNAPSHOT = { ...(await import('axios')) }
const REAL_CONFIG_SNAPSHOT = { ...(await import('../../../utils/config.js')) }
const REAL_AUTH_SNAPSHOT = { ...(await import('../../../utils/auth.js')) }
const REAL_PRIVACY_SNAPSHOT = {
  ...(await import('../../../utils/privacyLevel.js')),
}
const REAL_OAUTH_SNAPSHOT = {
  ...(await import('../../../constants/oauth.js')),
}
const REAL_HTTP_SNAPSHOT = { ...(await import('../../../utils/http.js')) }
const REAL_USERAGENT_SNAPSHOT = {
  ...(await import('../../../utils/userAgent.js')),
}
const REAL_PROCESS_SNAPSHOT = { ...(await import('../../../utils/process.js')) }
const REAL_SHUTDOWN_SNAPSHOT = {
  ...(await import('../../../utils/gracefulShutdown.js')),
}
const REAL_DEBUG_SNAPSHOT = { ...REAL_DEBUG_NS }
const REAL_LOG_SNAPSHOT = { ...REAL_LOG_NS }

type AxiosResponse = { data: unknown }

let axiosGetCalls = 0
let axiosPostCalls = 0
let axiosPatchCalls = 0
let axiosGetImpl: (url: string) => Promise<AxiosResponse>
let axiosPostImpl: (url: string) => Promise<unknown>
let axiosPatchImpl: (url: string) => Promise<unknown>

await mock.module('axios', () => ({
  ...REAL_AXIOS_SNAPSHOT,
  default: {
    get: async (url: string) => {
      axiosGetCalls += 1
      return axiosGetImpl(url)
    },
    post: async (url: string) => {
      axiosPostCalls += 1
      return axiosPostImpl(url)
    },
    patch: async (url: string) => {
      axiosPatchCalls += 1
      return axiosPatchImpl(url)
    },
    isAxiosError: (err: unknown) =>
      Boolean(err) && (err as { isAxiosError?: boolean }).isAxiosError === true,
  },
}))

let globalConfig: {
  groveConfigCache?: Record<
    string,
    { grove_enabled: boolean; timestamp: number }
  >
} = {}

await mock.module('../../../utils/config.js', () => ({
  ...REAL_CONFIG_SNAPSHOT,
  getGlobalConfig: () => globalConfig,
  saveGlobalConfig: (
    updater: (current: typeof globalConfig) => typeof globalConfig,
  ) => {
    globalConfig = updater(globalConfig)
  },
}))

let mockIsConsumerSubscriber = true
let mockAccountUuid: string | undefined = 'acct-1'

await mock.module('../../../utils/auth.js', () => ({
  ...REAL_AUTH_SNAPSHOT,
  isConsumerSubscriber: () => mockIsConsumerSubscriber,
  getOauthAccountInfo: () =>
    mockAccountUuid ? { accountUuid: mockAccountUuid } : null,
}))

await mock.module('../../../utils/privacyLevel.js', () => ({
  ...REAL_PRIVACY_SNAPSHOT,
  isEssentialTrafficOnly: () => false,
}))

await mock.module('../../../constants/oauth.js', () => ({
  ...REAL_OAUTH_SNAPSHOT,
  getOauthConfig: () => ({ BASE_API_URL: 'https://api.test' }),
}))

await mock.module('../../../utils/http.js', () => ({
  ...REAL_HTTP_SNAPSHOT,
  withOAuth401Retry: async (fn: () => Promise<unknown>) => fn(),
  getAuthHeaders: () => ({ headers: { Authorization: 'Bearer test-token' } }),
  getUserAgent: () => 'occ-test-agent',
}))

await mock.module('../../../utils/userAgent.js', () => ({
  ...REAL_USERAGENT_SNAPSHOT,
  getClaudeCodeUserAgent: () => 'occ-test-agent',
}))

await mock.module('../../../utils/process.js', () => ({
  ...REAL_PROCESS_SNAPSHOT,
  writeToStderr: () => {},
}))

await mock.module('../../../utils/gracefulShutdown.js', () => ({
  ...REAL_SHUTDOWN_SNAPSHOT,
  gracefulShutdown: async () => {},
}))

const debugMessages: string[] = []
const loggedErrors: unknown[] = []

await mock.module('../../../utils/debug.js', () => ({
  ...REAL_DEBUG_SNAPSHOT,
  logForDebugging: (message: string) => {
    debugMessages.push(message)
  },
}))

await mock.module('../../../utils/log.js', () => ({
  ...REAL_LOG_SNAPSHOT,
  logError: (err: unknown) => {
    loggedErrors.push(err)
  },
}))

const grove = await import('../grove.js')

const HOUR_MS = 60 * 60 * 1000

function axiosError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  })
}

const VALID_SETTINGS = { grove_enabled: true, grove_notice_viewed_at: null }

beforeEach(() => {
  axiosGetCalls = 0
  axiosPostCalls = 0
  axiosPatchCalls = 0
  axiosGetImpl = async () => ({ data: VALID_SETTINGS })
  axiosPostImpl = async () => ({})
  axiosPatchImpl = async () => ({})
  globalConfig = {}
  mockIsConsumerSubscriber = true
  mockAccountUuid = 'acct-1'
  debugMessages.length = 0
  loggedErrors.length = 0
  // Memoized across tests within the file — always start cold.
  grove.getGroveSettings.cache.clear?.()
  grove.getGroveNoticeConfig.cache.clear?.()
})

afterEach(() => {
  mock.restore()
})

afterAll(() => {
  // Restore every mocked module for later test files in this worker (OCC-97).
  mock.module('axios', () => ({ ...REAL_AXIOS_SNAPSHOT }))
  mock.module('../../../utils/config.js', () => ({ ...REAL_CONFIG_SNAPSHOT }))
  mock.module('../../../utils/auth.js', () => ({ ...REAL_AUTH_SNAPSHOT }))
  mock.module('../../../utils/privacyLevel.js', () => ({
    ...REAL_PRIVACY_SNAPSHOT,
  }))
  mock.module('../../../constants/oauth.js', () => ({ ...REAL_OAUTH_SNAPSHOT }))
  mock.module('../../../utils/http.js', () => ({ ...REAL_HTTP_SNAPSHOT }))
  mock.module('../../../utils/userAgent.js', () => ({
    ...REAL_USERAGENT_SNAPSHOT,
  }))
  mock.module('../../../utils/process.js', () => ({ ...REAL_PROCESS_SNAPSHOT }))
  mock.module('../../../utils/gracefulShutdown.js', () => ({
    ...REAL_SHUTDOWN_SNAPSHOT,
  }))
  mock.module('../../../utils/debug.js', () => ({ ...REAL_DEBUG_SNAPSHOT }))
  mock.module('../../../utils/log.js', () => ({ ...REAL_LOG_SNAPSHOT }))
})

async function flushBackgroundWork(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

// ---------------------------------------------------------------------------
// (a) getGroveNoticeConfig — errorStatus + cache-clear on failure
// ---------------------------------------------------------------------------

test('getGroveNoticeConfig returns errorStatus from the axios response and does not memoize the failure', async () => {
  // Arrange
  axiosGetImpl = async () => {
    throw axiosError(500)
  }

  // Act
  const first = await grove.getGroveNoticeConfig()
  const second = await grove.getGroveNoticeConfig()

  // Assert
  expect(first).toEqual({ success: false, errorStatus: 500 })
  expect(second).toEqual({ success: false, errorStatus: 500 })
  // Cache was cleared before returning → the second call hit axios again.
  expect(axiosGetCalls).toBe(2)
})

test('getGroveNoticeConfig failure without an HTTP response returns plain {success:false}', async () => {
  // Arrange
  axiosGetImpl = async () => {
    throw new Error('network down')
  }

  // Act
  const result = await grove.getGroveNoticeConfig()

  // Assert
  expect(result).toEqual({ success: false })
})

// ---------------------------------------------------------------------------
// (b) shape validation — official verbatim messages
// ---------------------------------------------------------------------------

test('getGroveNoticeConfig rejects a config answer without boolean grove_enabled (official message)', async () => {
  // Arrange
  axiosGetImpl = async () => ({
    data: { grove_enabled: 'yes', domain_excluded: false },
  })

  // Act
  const result = await grove.getGroveNoticeConfig()

  // Assert
  expect(result.success).toBe(false)
  expect(
    debugMessages.some(m =>
      m.includes('Grove notice config answer has no boolean grove_enabled'),
    ),
  ).toBe(true)
  // A shape-validation throw must not poison the memo cache either.
  axiosGetImpl = async () => ({
    data: {
      grove_enabled: true,
      domain_excluded: true,
      notice_is_grace_period: false,
      notice_reminder_frequency: null,
    },
  })
  const retry = await grove.getGroveNoticeConfig()
  expect(retry.success).toBe(true)
  expect(axiosGetCalls).toBe(2)
})

test('getGroveSettings rejects an answer without boolean-or-null grove_enabled (official message)', async () => {
  // Arrange
  axiosGetImpl = async () => ({
    data: { grove_enabled: 'nope', grove_notice_viewed_at: null },
  })

  // Act
  const result = await grove.getGroveSettings()

  // Assert
  expect(result).toEqual({ success: false })
  expect(String((loggedErrors[0] as Error).message)).toBe(
    'Grove settings answer has no boolean or null grove_enabled',
  )
})

test('getGroveSettings accepts null grove_enabled (choice not yet made)', async () => {
  // Arrange
  axiosGetImpl = async () => ({
    data: { grove_enabled: null, grove_notice_viewed_at: null },
  })

  // Act & Assert
  expect(await grove.getGroveSettings()).toEqual({
    success: true,
    data: { grove_enabled: null, grove_notice_viewed_at: null },
  })
})

test('getGroveSettings failure is not memoized (transient outage must not lock the session)', async () => {
  // Arrange
  axiosGetImpl = async () => {
    throw new Error('network down')
  }

  // Act
  await grove.getGroveSettings()
  await grove.getGroveSettings()

  // Assert
  expect(axiosGetCalls).toBe(2)
})

// ---------------------------------------------------------------------------
// (c) finally-clear on failed POST/PATCH
// ---------------------------------------------------------------------------

test('markGroveNoticeViewed clears the settings cache even when the POST fails', async () => {
  // Arrange — prime a successful memoized settings read.
  await grove.getGroveSettings()
  expect(axiosGetCalls).toBe(1)
  axiosPostImpl = async () => {
    throw new Error('server exploded')
  }

  // Act
  await grove.markGroveNoticeViewed()
  await grove.getGroveSettings()

  // Assert — the failed POST may still have landed server-side; the memo was
  // invalidated in `finally`, so the re-read hit axios again.
  expect(axiosPostCalls).toBe(1)
  expect(axiosGetCalls).toBe(2)
})

test('updateGroveSettings clears the settings cache even when the PATCH fails', async () => {
  // Arrange
  await grove.getGroveSettings()
  expect(axiosGetCalls).toBe(1)
  axiosPatchImpl = async () => {
    throw new Error('server exploded')
  }

  // Act
  await grove.updateGroveSettings(false)
  await grove.getGroveSettings()

  // Assert
  expect(axiosPatchCalls).toBe(1)
  expect(axiosGetCalls).toBe(2)
})

// ---------------------------------------------------------------------------
// (d) fetchAndStoreGroveConfig — re-stamp on server-error answers
// ---------------------------------------------------------------------------

test('stale cache + server-error answer (non-401): re-stamps timestamp, keeps last known-good grove_enabled', async () => {
  // Arrange
  const staleTimestamp = Date.now() - 25 * HOUR_MS
  globalConfig = {
    groveConfigCache: {
      'acct-1': { grove_enabled: true, timestamp: staleTimestamp },
    },
  }
  axiosGetImpl = async () => {
    throw axiosError(500)
  }

  // Act — stale cache returns the cached value and refreshes in background.
  const qualified = await grove.isQualifiedForGrove()
  await flushBackgroundWork()

  // Assert
  expect(qualified).toBe(true)
  const entry = globalConfig.groveConfigCache?.['acct-1']
  expect(entry?.grove_enabled).toBe(true)
  expect(entry?.timestamp).toBeGreaterThan(staleTimestamp)
})

test('401 answers do NOT re-stamp the cache (re-auth, not a server error)', async () => {
  // Arrange
  const staleTimestamp = Date.now() - 25 * HOUR_MS
  globalConfig = {
    groveConfigCache: {
      'acct-1': { grove_enabled: true, timestamp: staleTimestamp },
    },
  }
  axiosGetImpl = async () => {
    throw axiosError(401)
  }

  // Act
  await grove.isQualifiedForGrove()
  await flushBackgroundWork()

  // Assert
  expect(globalConfig.groveConfigCache?.['acct-1']?.timestamp).toBe(
    staleTimestamp,
  )
})

test('server-error answer with no existing cache entry stores nothing', async () => {
  // Arrange — cold start: isQualifiedForGrove returns false + background fetch.
  axiosGetImpl = async () => {
    throw axiosError(503)
  }

  // Act
  const qualified = await grove.isQualifiedForGrove()
  await flushBackgroundWork()

  // Assert
  expect(qualified).toBe(false)
  expect(globalConfig.groveConfigCache).toBeUndefined()
})
