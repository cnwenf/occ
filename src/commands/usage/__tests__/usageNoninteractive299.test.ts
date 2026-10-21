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
// Cross-file leak guard: `bun test src/commands/usage` also picks up
// src/commands/usage-credits/__tests__/usageCreditsMessage288.test.ts (path
// substring match), which runs first and registers NARROW module mocks
// (auth.js → `{ getSubscriptionType }` only, plus config.js/log.js/
// services/api/usage.js). Bun's mock.restore() does NOT unregister module
// mocks, so the bare specifiers below would capture those stubs and the
// superset spread would lack isClaudeAISubscriber → `SyntaxError: Export
// named 'isClaudeAISubscriber' not found` when the SUT links auth.js.
// Cache-busting query suffixes resolve to fresh REAL module instances that
// bypass the leaked registry entries (same trick as the SUT import below).
// Order matters: capture the REAL auth first and immediately re-register it
// as a superset mock. claudeAiLimits.ts (and the effort.js chain) import
// isClaudeAISubscriber from auth.js at link time; if the leaked narrow stub
// were still the registry entry when those modules are freshly evaluated,
// their link would fail before this file's own mocks exist.
const actualAuth = await import('../../../utils/auth.js?wp8Real')
mock.module('../../../utils/auth.js', () => ({ ...actualAuth }))
const actualCostTracker = await import('../../../cost-tracker.js?wp8Real')
const actualClaudeAiLimits = await import(
  '../../../services/claudeAiLimits.js?wp8Real'
)

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
