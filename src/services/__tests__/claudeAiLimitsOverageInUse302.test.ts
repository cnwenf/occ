// CC 2.1.302 (#19) prerequisite layer: the official v302 limits store parses
// `anthropic-ratelimit-unified-overage-in-use` and exposes `overageInUse` on
// the limits state.
//
// Binary evidence (v302, /tmp/cc-diff-302/v302/package/claude):
//   @238390657 (dd skip=238390300): `Kr="anthropic-ratelimit-unified-overage-in-use"`
//   @238506000-region (Jl header parse): `O=e.get(Kr)==="true"` …
//     `te={status:…,…O&&{overageInUse:O},…}`
//   @238522075: `function ePo(e,r,n=!1,s=Date.now(),h,y){return
//     se.extractQuotaStatusFromHeaders(e,r,n,s,h,y)}` — the producer both
//     response sites call; the gate reads `{status,overageInUse}=ha()`.
//
// Mocking follows the usageNoninteractive299.test.ts superset convention
// (OCC-97 hardening): import the real modules first, spread into superset
// mocks, load the SUT via a cache-busting suffix, re-register reals in
// afterAll.
import { afterAll, describe, expect, mock, test } from 'bun:test'

const actualRateLimitMocking = await import('../rateLimitMocking.js')

let mockShouldProcessRateLimits = true

mock.module('../rateLimitMocking.js', () => ({
  ...actualRateLimitMocking,
  shouldProcessRateLimits: () => mockShouldProcessRateLimits,
  processRateLimitHeaders: (headers: globalThis.Headers) => headers,
}))

const limits = await import('../claudeAiLimits.js?overageInUse302')

afterAll(() => {
  mock.module('../rateLimitMocking.js', () => ({ ...actualRateLimitMocking }))
  mock.restore()
})

function makeHeaders(init: Record<string, string>): globalThis.Headers {
  return new globalThis.Headers(init)
}

describe('CC 2.1.302 (#19): overage-in-use header parse into limits state', () => {
  test('header "true" → extractQuotaStatusFromHeaders returns overageInUse true and state carries it', () => {
    mockShouldProcessRateLimits = true
    const result = limits.extractQuotaStatusFromHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'true',
      }),
    )
    expect(result?.overageInUse).toBe(true)
    expect(limits.currentLimits.overageInUse).toBe(true)
  })

  test('header "false" → overageInUse is not set (official: O=e.get(Kr)==="true", spread only when truthy)', () => {
    mockShouldProcessRateLimits = true
    const result = limits.extractQuotaStatusFromHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'false',
      }),
    )
    expect(result).toBeDefined()
    expect(result?.overageInUse).toBeUndefined()
  })

  test('header absent → overageInUse is not set', () => {
    mockShouldProcessRateLimits = true
    const result = limits.extractQuotaStatusFromHeaders(
      makeHeaders({ 'anthropic-ratelimit-unified-status': 'allowed' }),
    )
    expect(result).toBeDefined()
    expect(result?.overageInUse).toBeUndefined()
  })

  test('overageInUse survives the allowed_warning early-warning return path', () => {
    mockShouldProcessRateLimits = true
    const result = limits.extractQuotaStatusFromHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.9',
        'anthropic-ratelimit-unified-overage-in-use': 'true',
      }),
    )
    expect(result?.status).toBe('allowed_warning')
    expect(result?.overageInUse).toBe(true)
  })

  test('rate limits not processed (non-subscriber) → returns undefined, no overageInUse on state', () => {
    mockShouldProcessRateLimits = false
    const result = limits.extractQuotaStatusFromHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'true',
      }),
    )
    expect(result).toBeUndefined()
    // The pre-existing skip path clears rate-limit state; overageInUse must
    // not leak onto it from the un-processed headers.
    expect(limits.currentLimits.overageInUse).toBeUndefined()
    mockShouldProcessRateLimits = true
  })
})
