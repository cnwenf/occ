import { afterAll, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.288 #68 — improved `/usage-credits` message for Team/Enterprise
 * members whose organization has turned OFF usage credit requests.
 *
 * Official delta (byte-verified against /tmp/cc-diff-288/v288/package/claude,
 * function `ple` @219946788, `is_allowed===false` branch):
 *   v287: "Contact your admin to manage usage credit settings."
 *   v288: "Usage credit requests are turned off for your organization."
 *
 * OCC's `runUsageCredits()` emitted a v287-era generic deflection on that
 * branch. This test drives the production `is_allowed === false` path with the
 * API/util modules mocked and asserts the official v288 sentence.
 */

const OFFICIAL_MESSAGE =
  'Usage credit requests are turned off for your organization.'

// Full-replacement mocks: usage-credits-core imports only the named exports
// stubbed here, so no real network/config module graph is loaded.
mock.module('../../../services/api/adminRequests.js', () => ({
  checkAdminRequestEligibility: async () => ({ is_allowed: false }),
  createAdminRequest: async () => {
    throw new Error('should not be reached when is_allowed === false')
  },
  getMyAdminRequests: async () => [],
}))
mock.module('../../../services/api/overageCreditGrant.js', () => ({
  invalidateOverageCreditGrantCache: () => {},
}))
mock.module('../../../services/api/usage.js', () => ({
  fetchUtilization: async () => ({
    extra_usage: { is_enabled: true, monthly_limit: 100 },
  }),
}))
mock.module('../../../utils/auth.js', () => ({
  getSubscriptionType: () => 'team',
}))
mock.module('../../../utils/billing.js', () => ({
  hasClaudeAiBillingAccess: () => false,
}))
mock.module('../../../utils/config.js', () => ({
  getGlobalConfig: () => ({ hasVisitedExtraUsage: true }),
  saveGlobalConfig: () => {},
}))
mock.module('../../../utils/browser.js', () => ({
  openBrowser: async () => true,
}))
mock.module('../../../utils/log.js', () => ({
  logError: () => {},
}))

const { runUsageCredits } = await import('../usage-credits-core.js')

afterAll(() => {
  mock.restore()
})

describe('CC 2.1.288 #68 — /usage-credits when credit requests are off', () => {
  test('is_allowed === false returns the official v288 message', async () => {
    const result = await runUsageCredits()
    expect(result).toEqual({ type: 'message', value: OFFICIAL_MESSAGE })
  })

  test('source no longer emits the v287-era deflection on the is_allowed branch', async () => {
    const src = await Bun.file(
      new URL('../usage-credits-core.ts', import.meta.url),
    ).text()
    expect(src).toContain(OFFICIAL_MESSAGE)
  })
})
