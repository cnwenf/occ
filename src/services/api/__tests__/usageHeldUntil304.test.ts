/**
 * CC 2.1.304 (#43) — /usage rate-limit END TIME.
 *
 * Official change (byte-verified in research-R5-cli-ux.md item #43):
 *   - formatter `fo(o)`:
 *       o===void 0 ? "rate limited — try again in a moment"
 *                  : `rate limited until ${vA(Math.ceil(o/60000)*60)}`
 *     (minute-ROUNDED-UP clock time; `vA` ≡ OCC formatResetTime over epoch
 *     seconds)
 *   - rate-limit memory store records `heldUntilMs` on 429/403:
 *       untilMs = Date.now() + Math.min(retryAfterMs>0 ? retryAfterMs : Ft, Ke)
 *     (Retry-After honored, default hold `Ft`, cap `Ke` — the official Ft/Ke
 *     VALUES are not pinned by the research; OCC uses 60s / 24h, documented
 *     in impl-WP6.md.)
 *
 * Covers: the pure formatter, the hold computation, and the
 * fetchUtilizationWithStatus catch-path wiring (heldUntilMs present on
 * 429/403, absent otherwise; isRateLimited/rateLimitedVia keep their
 * pre-304 429-only semantics).
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { formatResetTime } from '../../../utils/format.js'

// ---------------------------------------------------------------------------
// Mock plumbing (pattern: effortCap267.test.ts) — installed BEFORE the module
// under test is imported. Leak guard: bun runs all test files in ONE process
// and mock.module LIVE-PATCHES namespaces, so function refs are captured
// pre-mock and every closure delegates back through them once `mockActive`
// flips false in afterAll.
// ---------------------------------------------------------------------------

const actualAxios = await import('axios')
const actualAuth = await import('../../../utils/auth.js')
const actualConfig = await import('../../../utils/config.js')
const actualHttp = await import('../../../utils/http.js')
const actualOauth = await import('../../../constants/oauth.js')
const actualUserAgent = await import('../../../utils/userAgent.js')

const actualAxiosGet = actualAxios.default.get
const actualIsClaudeAISubscriber = actualAuth.isClaudeAISubscriber
const actualHasProfileScope = actualAuth.hasProfileScope
const actualGetClaudeAIOAuthTokens = actualAuth.getClaudeAIOAuthTokens
const actualGetOauthAccountInfo = actualAuth.getOauthAccountInfo
const actualGetGlobalConfig = actualConfig.getGlobalConfig
const actualSaveGlobalConfig = actualConfig.saveGlobalConfig
const actualGetAuthHeaders = actualHttp.getAuthHeaders
const actualGetOauthConfig = actualOauth.getOauthConfig
const actualGetClaudeCodeUserAgent = actualUserAgent.getClaudeCodeUserAgent

let mockActive = true
let axiosGetImpl: (url: string, config?: unknown) => Promise<unknown> =
  async () => {
    throw new Error('usageHeldUntil304: axiosGetImpl not configured')
  }

mock.module('axios', () => ({
  ...actualAxios,
  default: {
    ...actualAxios.default,
    get: (url: string, config?: unknown) =>
      mockActive
        ? axiosGetImpl(url, config)
        : actualAxiosGet.call(actualAxios.default, url, config),
  },
}))

mock.module('../../../utils/auth.js', () => ({
  ...actualAuth,
  isClaudeAISubscriber: () =>
    mockActive ? true : actualIsClaudeAISubscriber(),
  hasProfileScope: () => (mockActive ? true : actualHasProfileScope()),
  getClaudeAIOAuthTokens: () =>
    mockActive ? null : actualGetClaudeAIOAuthTokens(),
  getOauthAccountInfo: () => (mockActive ? null : actualGetOauthAccountInfo()),
}))

mock.module('../../../utils/config.js', () => ({
  ...actualConfig,
  // No persisted seed → the catch path lands on `unavailable` (no in-memory
  // seed either: every mocked fetch rejects before seeding). Deliberately an
  // EMPTY object — spreading the real config could carry a fresh on-disk
  // cachedUsageUtilization and divert the tests into the `seeded` path.
  getGlobalConfig: () =>
    mockActive
      ? ({} as ReturnType<typeof actualGetGlobalConfig>)
      : actualGetGlobalConfig(),
  saveGlobalConfig: (updater: Parameters<typeof actualSaveGlobalConfig>[0]) => {
    if (!mockActive) return actualSaveGlobalConfig(updater)
    return undefined as ReturnType<typeof actualSaveGlobalConfig>
  },
}))

mock.module('../../../utils/http.js', () => ({
  ...actualHttp,
  getAuthHeaders: () =>
    mockActive
      ? { headers: { Authorization: 'Bearer test' } }
      : actualGetAuthHeaders(),
}))

mock.module('../../../constants/oauth.js', () => ({
  ...actualOauth,
  getOauthConfig: () =>
    mockActive
      ? { ...actualGetOauthConfig(), BASE_API_URL: 'https://usage.test' }
      : actualGetOauthConfig(),
}))

mock.module('../../../utils/userAgent.js', () => ({
  ...actualUserAgent,
  getClaudeCodeUserAgent: () =>
    mockActive ? 'occ-test/0.0.0' : actualGetClaudeCodeUserAgent(),
}))

afterAll(() => {
  mockActive = false
  mock.module('axios', () => ({
    ...actualAxios,
    default: { ...actualAxios.default, get: actualAxiosGet },
  }))
  mock.module('../../../utils/auth.js', () => ({
    ...actualAuth,
    isClaudeAISubscriber: actualIsClaudeAISubscriber,
    hasProfileScope: actualHasProfileScope,
    getClaudeAIOAuthTokens: actualGetClaudeAIOAuthTokens,
    getOauthAccountInfo: actualGetOauthAccountInfo,
  }))
  mock.module('../../../utils/config.js', () => ({
    ...actualConfig,
    getGlobalConfig: actualGetGlobalConfig,
    saveGlobalConfig: actualSaveGlobalConfig,
  }))
  mock.module('../../../utils/http.js', () => ({
    ...actualHttp,
    getAuthHeaders: actualGetAuthHeaders,
  }))
  mock.module('../../../constants/oauth.js', () => ({
    ...actualOauth,
    getOauthConfig: actualGetOauthConfig,
  }))
  mock.module('../../../utils/userAgent.js', () => ({
    ...actualUserAgent,
    getClaudeCodeUserAgent: actualGetClaudeCodeUserAgent,
  }))
})

// Module under test — imported AFTER the mocks.
const usageModule = await import('../usage.js')

/** Point axiosGet at a rejection carrying an HTTP status (+ optional headers). */
function rejectWith(status: number, headers?: Record<string, string>): void {
  axiosGetImpl = async () => {
    const err = new Error(
      `Request failed with status code ${status}`,
    ) as Error & {
      response?: { status: number; headers?: Record<string, string>; data?: unknown }
    }
    err.response = { status, data: { error: 'rate limited' } }
    if (headers) err.response.headers = headers
    throw err
  }
}

// Mirrors of the (unexported) usage.ts constants — asserted behaviorally.
const DEFAULT_HOLD_MS = 60_000 // official `Ft`
const MAX_HOLD_MS = 86_400_000 // official `Ke`

describe('#43 formatRateLimitedText (official fo)', () => {
  test('undefined → the vague 303-era text VERBATIM', () => {
    // Arrange / Act.
    const text = usageModule.formatRateLimitedText(undefined)

    // Assert — official fo fallback string, byte-verified.
    expect(text).toBe('rate limited — try again in a moment')
  })

  test('a known hold → "rate limited until <minute-rounded clock>" (official vA over ceil-to-minute epoch seconds)', () => {
    // Arrange — a fixed epoch ms (2023-11-14T22:13:20Z).
    const heldUntilMs = 1_700_000_000_000

    // Act.
    const text = usageModule.formatRateLimitedText(heldUntilMs)

    // Assert — prefix verbatim + the exact official rounding composition.
    expect(text.startsWith('rate limited until ')).toBe(true)
    expect(text).toBe(
      `rate limited until ${formatResetTime(Math.ceil(heldUntilMs / 60_000) * 60)}`,
    )
  })

  test('rounds UP to the minute (official Math.ceil(o/60000)*60)', () => {
    // Arrange — an exact-minute deadline and its neighbors.
    const exactMinuteMs = 1_700_000_040_000 // divisible by 60_000
    const justAfterMs = exactMinuteMs + 1
    const nextMinuteMs = exactMinuteMs + 60_000

    // Assert.
    expect(exactMinuteMs % 60_000).toBe(0)
    // 1ms past a minute boundary lands on the NEXT minute, same as the
    // boundary itself (ceil), and differs from the previous exact minute.
    expect(usageModule.formatRateLimitedText(justAfterMs)).toBe(
      usageModule.formatRateLimitedText(nextMinuteMs),
    )
    expect(usageModule.formatRateLimitedText(exactMinuteMs)).not.toBe(
      usageModule.formatRateLimitedText(nextMinuteMs),
    )
  })
})

describe('#43 computeRateLimitHeldUntilMs (official store computation)', () => {
  test('honors a Retry-After delta-seconds header (official retryAfterMs>0 branch)', () => {
    // Arrange / Act.
    const before = Date.now()
    const held = usageModule.computeRateLimitHeldUntilMs('120')
    const after = Date.now()

    // Assert — now + 120s within the call window.
    expect(held).toBeGreaterThanOrEqual(before + 120_000)
    expect(held).toBeLessThanOrEqual(after + 120_000)
  })

  test('absent header → default hold (official Ft)', () => {
    // Arrange / Act.
    const before = Date.now()
    const held = usageModule.computeRateLimitHeldUntilMs(undefined)
    const after = Date.now()

    // Assert.
    expect(held).toBeGreaterThanOrEqual(before + DEFAULT_HOLD_MS)
    expect(held).toBeLessThanOrEqual(after + DEFAULT_HOLD_MS)
  })

  test('non-positive / unparseable Retry-After → default hold (official retryAfterMs>0 guard)', () => {
    // Arrange.
    const before = Date.now()

    // Act.
    const zero = usageModule.computeRateLimitHeldUntilMs('0')
    const negative = usageModule.computeRateLimitHeldUntilMs('-5')
    const garbage = usageModule.computeRateLimitHeldUntilMs('soon-ish')
    const after = Date.now()

    // Assert.
    for (const held of [zero, negative, garbage]) {
      expect(held).toBeGreaterThanOrEqual(before + DEFAULT_HOLD_MS)
      expect(held).toBeLessThanOrEqual(after + DEFAULT_HOLD_MS)
    }
  })

  test('an absurd Retry-After is CAPPED (official Ke in Math.min)', () => {
    // Arrange / Act.
    const before = Date.now()
    const held = usageModule.computeRateLimitHeldUntilMs('999999999')
    const after = Date.now()

    // Assert — capped at 24h, not 999999999s (~31 years).
    expect(held).toBeGreaterThanOrEqual(before + MAX_HOLD_MS)
    expect(held).toBeLessThanOrEqual(after + MAX_HOLD_MS)
  })

  test('an HTTP-date Retry-After is honored as a delta', () => {
    // Arrange — a date ~5 minutes out (HTTP-date has second granularity).
    const future = new Date(Date.now() + 300_000).toUTCString()

    // Act.
    const held = usageModule.computeRateLimitHeldUntilMs(future)

    // Assert — within a tolerance band around now+5min.
    expect(held).toBeGreaterThan(Date.now() + 295_000)
    expect(held).toBeLessThanOrEqual(Date.now() + 300_500)
  })
})

describe('#43 fetchUtilizationWithStatus records heldUntilMs (catch path)', () => {
  // NOTE: the catch path returns either `unavailable` (no seed) or `seeded`
  // (a persisted/in-memory seed exists). Which one depends on module-level
  // seed state that other test files may have populated, so these tests
  // assert ONLY the #43-relevant fields — heldUntilMs, isRateLimited,
  // rateLimitedVia — which are computed identically on both sub-paths.
  test('429 + Retry-After → heldUntilMs recorded; isRateLimited/rateLimitedVia unchanged', async () => {
    // Arrange.
    rejectWith(429, { 'retry-after': '120' })

    // Act.
    const before = Date.now()
    const result = await usageModule.fetchUtilizationWithStatus()
    const after = Date.now()

    // Assert.
    expect(result.isRateLimited).toBe(true)
    expect(result.rateLimitedVia).toBe('http_429')
    expect(result.heldUntilMs).toBeGreaterThanOrEqual(before + 120_000)
    expect(result.heldUntilMs).toBeLessThanOrEqual(after + 120_000)
  })

  test('403 + Retry-After → heldUntilMs recorded (official store covers 429/403), isRateLimited stays 429-only', async () => {
    // Arrange.
    rejectWith(403, { 'retry-after': '30' })

    // Act.
    const before = Date.now()
    const result = await usageModule.fetchUtilizationWithStatus()
    const after = Date.now()

    // Assert — the hold is recorded, but the pre-304 rate-limit flags keep
    // their 429-only semantics (existing consumers gate on them).
    expect(result.isRateLimited).toBe(false)
    expect(result.rateLimitedVia).toBeNull()
    expect(result.heldUntilMs).toBeGreaterThanOrEqual(before + 30_000)
    expect(result.heldUntilMs).toBeLessThanOrEqual(after + 30_000)
  })

  test('429 without Retry-After → default hold recorded', async () => {
    // Arrange.
    rejectWith(429)

    // Act.
    const before = Date.now()
    const result = await usageModule.fetchUtilizationWithStatus()
    const after = Date.now()

    // Assert.
    expect(result.heldUntilMs).toBeGreaterThanOrEqual(before + DEFAULT_HOLD_MS)
    expect(result.heldUntilMs).toBeLessThanOrEqual(after + DEFAULT_HOLD_MS)
  })

  test('a non-rate-limit error (500) → no heldUntilMs', async () => {
    // Arrange.
    rejectWith(500)

    // Act.
    const result = await usageModule.fetchUtilizationWithStatus()

    // Assert.
    expect(result.isRateLimited).toBe(false)
    expect(result.heldUntilMs).toBeUndefined()
  })
})
