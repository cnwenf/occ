import { afterAll, describe, expect, mock, test } from 'bun:test'

// CC 2.1.299 #060 (anthropics/claude-code#92238): the approaching-limit
// warning must not display more than 100%. Official v299 computes the shown
// integer as `Math.floor(rateLimitType === "overage" ? IXe(u) : ume(u))` where
// `ume(u) = Math.min(Math.round(u*1000)/10, 100)` clamps to 100 and `overage`
// (extra usage) is intentionally left unclamped. OCC mirrors that: clamp every
// limit type except 'overage'.

// OCC-97 hardening: bun's mock.module registry is shared across all test files
// in one run. Narrow factories here previously poisoned sibling files (e.g.
// `Export named 'formatFileSize' not found` / `'getClaudeAIOAuthTokens' not
// found` when the usage-command tests or auth importers shared the worker).
// Import the real modules first, spread them into superset mocks, and
// re-register the real modules in afterAll.
const actualAuth = await import('../../utils/auth.js')
const actualBilling = await import('../../utils/billing.js')
const actualFormat = await import('../../utils/format.js')

mock.module('../../utils/auth.js', () => ({
  ...actualAuth,
  getSubscriptionType: () => 'pro',
  getOauthAccountInfo: () => ({ hasExtraUsageEnabled: false }),
  isOverageProvisioningAllowed: () => false,
  isClaudeAISubscriber: () => true,
}))
mock.module('../../utils/billing.js', () => ({
  ...actualBilling,
  hasClaudeAiBillingAccess: () => true,
}))
mock.module('../../utils/format.js', () => ({
  ...actualFormat,
  formatResetTime: () => '2pm',
}))

// Cache-busting suffix: fresh evaluation deterministically binds the mocked
// modules regardless of what else ran in this process.
const { getRateLimitMessage } = await import('../rateLimitMessages.js?rateLimitMessages299')

afterAll(() => {
  mock.module('../../utils/auth.js', () => ({ ...actualAuth }))
  mock.module('../../utils/billing.js', () => ({ ...actualBilling }))
  mock.module('../../utils/format.js', () => ({ ...actualFormat }))
  mock.restore()
})

function limits(over: Partial<Parameters<typeof getRateLimitMessage>[0]>) {
  return {
    status: 'allowed_warning',
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
    ...over,
  } as Parameters<typeof getRateLimitMessage>[0]
}

describe('CC 2.1.299 #060 — approaching-limit warning clamps at 100%', () => {
  test('five_hour utilization 1.2 shows 100% (clamped)', () => {
    const res = getRateLimitMessage(
      limits({ rateLimitType: 'five_hour', utilization: 1.2 }),
      'claude-sonnet-4-5',
    )
    expect(res?.severity).toBe('warning')
    expect(res?.message).toContain("You've used 100% of your session limit")
  })

  test('seven_day utilization 0.85 shows 85% (unchanged)', () => {
    const res = getRateLimitMessage(
      limits({ rateLimitType: 'seven_day', utilization: 0.85 }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain("You've used 85% of your weekly limit")
  })

  test('utilization exactly 1.0 shows 100%', () => {
    const res = getRateLimitMessage(
      limits({ rateLimitType: 'five_hour', utilization: 1.0 }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain("You've used 100% of your session limit")
  })

  test('overage (extra usage) is NOT clamped — 1.2 shows 120%', () => {
    const res = getRateLimitMessage(
      limits({ rateLimitType: 'overage', utilization: 1.2 }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain("You've used 120% of your extra usage")
  })
})
