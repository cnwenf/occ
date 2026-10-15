import { afterAll, describe, expect, mock, test } from 'bun:test'

// CC 2.1.299 #060 (anthropics/claude-code#92238): the non-interactive /usage
// "Current utilization" line must not display more than 100%.

// OCC-97 hardening (see applyEffort299.test.ts / applyPromptContentLead018.test.ts):
// Bun's mock.module registry is shared across test files in one worker. The
// original narrow factories here (auth.js with only 4 exports) caused
// `SyntaxError: Export named 'isClaudeAISubscriber' not found` for unrelated
// files sharing the worker, depending on module-evaluation timing. Fix: import
// the real modules first, spread them into superset mocks, load the SUT via a
// cache-busting suffix, and re-register the real modules in afterAll instead of
// relying on mock.restore() alone.
const actualCostTracker = await import('../../../cost-tracker.js')
const actualClaudeAiLimits = await import('../../../services/claudeAiLimits.js')
const actualAuth = await import('../../../utils/auth.js')

let mockUtilization = 1.2

mock.module('../../../cost-tracker.js', () => ({
  ...actualCostTracker,
  formatTotalCost: () => 'Total session cost: $0.42',
}))
mock.module('../../../services/claudeAiLimits.js', () => ({
  ...actualClaudeAiLimits,
  // `currentLimits` is a stable object; `.utilization` reads the live test
  // variable so each case can vary it (ESM named binding is captured once).
  currentLimits: {
    status: 'allowed',
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
    get utilization() {
      return mockUtilization
    },
  },
}))
mock.module('../../../utils/auth.js', () => ({
  ...actualAuth,
  isClaudeAISubscriber: () => true,
  // Superset guard: rateLimitMessages imports these from auth.js.
  getSubscriptionType: () => 'pro',
  getOauthAccountInfo: () => ({ hasExtraUsageEnabled: false }),
  isOverageProvisioningAllowed: () => false,
}))

// Fresh SUT instance via a cache-busting suffix so the mocked bindings are
// deterministically picked up regardless of what else ran in this worker.
const { call } = await import('../usage-noninteractive.js?usageNoninteractive299')

afterAll(() => {
  // Re-register the real modules (superset) rather than mock.restore(): other
  // test files in the same worker may still hold/resolve these module paths.
  mock.module('../../../cost-tracker.js', () => ({ ...actualCostTracker }))
  mock.module('../../../services/claudeAiLimits.js', () => ({ ...actualClaudeAiLimits }))
  mock.module('../../../utils/auth.js', () => ({ ...actualAuth }))
  mock.restore()
})

async function usageText(): Promise<string> {
  const result = await call('', {} as never)
  return result.type === 'text' ? result.value : ''
}

describe('CC 2.1.299 #060 — /usage (-p) clamps utilization at 100%', () => {
  test('utilization 1.2 displays 100%', async () => {
    mockUtilization = 1.2
    expect(await usageText()).toContain('Current utilization: 100%')
  })

  test('utilization 1.0 displays 100%', async () => {
    mockUtilization = 1.0
    expect(await usageText()).toContain('Current utilization: 100%')
  })

  test('utilization 0.5 displays 50% unchanged', async () => {
    mockUtilization = 0.5
    expect(await usageText()).toContain('Current utilization: 50%')
  })
})
