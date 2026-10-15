import { describe, expect, test } from 'bun:test'
import {
  buildStatusLineRateLimits,
  clampUsedPercentage,
} from '../statusLineRateLimits.js'

// CC 2.1.299 #060 (anthropics/claude-code#92238): the status line's
// rate_limits.used_percentage must never exceed 100. Official v299 wraps the
// raw utilization in `ume(e) = Math.min(Math.round(e*1000)/10, 100)`
// (byte-verified in the 2.1.299 linux-x64 binary); v296 passed it through raw.

describe('clampUsedPercentage (2.1.299 #060)', () => {
  test('utilization fraction above 1.0 clamps to 100', () => {
    expect(clampUsedPercentage(1.2)).toBe(100)
    expect(clampUsedPercentage(1.0)).toBe(100)
    expect(clampUsedPercentage(1.0001)).toBe(100)
  })

  test('normal utilization is unchanged', () => {
    expect(clampUsedPercentage(0.5)).toBe(50)
    expect(clampUsedPercentage(0.855)).toBeCloseTo(85.5)
    expect(clampUsedPercentage(0)).toBe(0)
  })
})

describe('buildStatusLineRateLimits (2.1.299 #060)', () => {
  test('clamps five_hour and seven_day used_percentage at 100', () => {
    const result = buildStatusLineRateLimits({
      five_hour: { utilization: 1.2, resets_at: 1760000000 },
      seven_day: { utilization: 2, resets_at: 1760000600 },
    })
    expect(result.five_hour?.used_percentage).toBe(100)
    expect(result.five_hour?.resets_at).toBe(1760000000)
    expect(result.seven_day?.used_percentage).toBe(100)
  })

  test('passes through values below 100 unchanged', () => {
    const result = buildStatusLineRateLimits({
      five_hour: { utilization: 0.5, resets_at: 1760000000 },
      seven_day: { utilization: 0.42, resets_at: 1760000600 },
    })
    expect(result.five_hour?.used_percentage).toBe(50)
    expect(result.seven_day?.used_percentage).toBeCloseTo(42)
  })

  test('omits windows that are not present', () => {
    const result = buildStatusLineRateLimits({
      five_hour: { utilization: 0.1, resets_at: 1 },
    })
    expect(result.five_hour).toBeDefined()
    expect(result.seven_day).toBeUndefined()
    expect(buildStatusLineRateLimits({})).toEqual({})
  })
})
