import { afterAll, describe, expect, mock, test } from 'bun:test'

// CC 2.1.312 (item 20): two byte-verified deltas in the rate-limit surface.
//
// 1) Display-name rename — v311 map @246735413 `wce={five_hour:"session limit",…}`
//    → v312 map @246569205 `Hce={five_hour:"5-hour limit",…}`. The official
//    message classifier keeps a legacy fallback for the old wording
//    (`if(c(d.five_hour)||c("session limit"))return"session"`); OCC's
//    RATE_LIMIT_ERROR_PREFIXES matcher keys on generic prefixes ("You've hit
//    your"), so it is rename-proof by construction.
// 2) New "Over N% … used" early-warning branch — v312 `$t` @246574430 computes
//    `m=n?void 0:Ke(e.surpassedThreshold)` and renders
//    `n?"You've used n% of your r":m?"Over m% of your r used":"Approaching r"`
//    with `Ke(e){if(e===void 0||!Number.isFinite(e)||e<=0||e>=1)return;
//    return Math.min(99,Math.floor(Math.round(e*1e4)/100))}` — both `Over ${m}%`
//    and `Ke` are new-in-312 (0 hits in v311, 1 in v312). The branch only fires
//    when no utilization percent is available.
//
// Harness mirrors rateLimitMessages299.test.ts (superset mocks + cache-busting
// import) to avoid cross-file mock poisoning.

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

const { getRateLimitMessage, getUsingOverageText } = await import(
  '../rateLimitMessages.js?rateLimitMessages312'
)
const { getRateLimitDisplayName } = await import(
  '../claudeAiLimits.js?claudeAiLimits312'
)

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

describe('CC 2.1.312 item 20 — "session limit" renamed to "5-hour limit"', () => {
  test('display-name map (official Hce @246569205)', () => {
    expect(getRateLimitDisplayName('five_hour')).toBe('5-hour limit')
  })

  test('early warning uses the new name', () => {
    const res = getRateLimitMessage(
      limits({ rateLimitType: 'five_hour', utilization: 1.0 }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain("You've used 100% of your 5-hour limit")
  })

  test('limit-reached error uses the new name', () => {
    const res = getRateLimitMessage(
      limits({ status: 'rejected', rateLimitType: 'five_hour' }),
      'claude-sonnet-4-5',
    )
    expect(res?.severity).toBe('error')
    expect(res?.message).toContain("You've hit your 5-hour limit")
  })

  test('overage-transition text uses the new name', () => {
    const text = getUsingOverageText(
      limits({ rateLimitType: 'five_hour', resetsAt: 123 }),
    )
    expect(text).toContain('5-hour limit')
    expect(text).not.toContain('session limit')
  })
})

describe('CC 2.1.312 item 20 — "Over N% of your <limit> used" branch (official $t/Ke)', () => {
  test('surpassedThreshold without utilization renders Over N%', () => {
    const res = getRateLimitMessage(
      limits({ rateLimitType: 'five_hour', surpassedThreshold: 0.85 }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain('Over 85% of your 5-hour limit used')
  })

  test('utilization percent wins over surpassedThreshold (official m=n?void 0:Ke(…))', () => {
    const res = getRateLimitMessage(
      limits({
        rateLimitType: 'five_hour',
        utilization: 0.9,
        surpassedThreshold: 0.85,
      }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain("You've used 90% of your 5-hour limit")
    expect(res?.message).not.toContain('Over 85%')
  })

  test('rounding follows Ke: floor(round(x*1e4)/100)', () => {
    const res = getRateLimitMessage(
      limits({ rateLimitType: 'five_hour', surpassedThreshold: 0.8567 }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain('Over 85% of your 5-hour limit used')
  })

  test('clamped at 99 (official Math.min(99,…))', () => {
    const res = getRateLimitMessage(
      limits({ rateLimitType: 'five_hour', surpassedThreshold: 0.999 }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain('Over 99% of your 5-hour limit used')
  })

  test.each([
    ['zero', 0],
    ['one', 1],
    ['above one', 1.5],
    ['negative', -0.2],
    ['NaN', Number.NaN],
  ])('invalid threshold (%s) falls back to Approaching', (_label, value) => {
    const res = getRateLimitMessage(
      limits({ rateLimitType: 'five_hour', surpassedThreshold: value }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain('Approaching 5-hour limit')
    expect(res?.message).not.toContain('Over ')
  })

  test('resets suffix still joins the Over% base (official filter(Boolean).join(" · "))', () => {
    const res = getRateLimitMessage(
      limits({
        rateLimitType: 'five_hour',
        surpassedThreshold: 0.85,
        resetsAt: 123,
      }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain('Over 85% of your 5-hour limit used · resets 2pm')
  })

  test('weekly limit renders Over% with its own name', () => {
    const res = getRateLimitMessage(
      limits({ rateLimitType: 'seven_day', surpassedThreshold: 0.72 }),
      'claude-sonnet-4-5',
    )
    expect(res?.message).toContain('Over 72% of your weekly limit used')
  })
})
