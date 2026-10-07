// Repo-convention MACRO polyfill (must run before withRetry.js is required).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { afterEach, describe, expect, test } from 'bun:test'

/**
 * CC 2.1.292 (occ149 P2): CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS.
 *
 * Official 2.1.292 a$ (@205639755) grew a 5th param — the exponential-backoff
 * base-delay override (default le=500):
 *   `function a$(e,r,n=32000,o=Math.random,a=le){let s=Math.round(gT({
 *     attempt:e,baseMs:a,capMs:n,jitter:{kind:"proportional",ratio:0.25},
 *     random:o})); ...}`
 * and the non-persistent retry call site (@214125966) passes it ONLY for
 * overloaded-shaped errors:
 *   `Wo=a$(Vt+G,Ao,void 0,r.random,
 *     oB(Jt)?a.CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS:void 0)`
 * The env registry descriptor (@203747314) is
 *   `hi=H.int({min:500,max:32000,digitsOnly:!0})`
 * → digits-only integer within [500, 32000]; anything else falls back to the
 * 500 default.
 *
 * OCC mapping: a$ ≡ getRetryDelay (4th param baseDelayMs), oB ≡ is529Error,
 * registry validation ≡ getOverloadedRetryBaseDelayMs (parseEnvInt + range).
 */

const { getRetryDelay, getOverloadedRetryBaseDelayMs, BASE_DELAY_MS } =
  require('../withRetry.js') as typeof import('../withRetry.js')

const ENV_VAR = 'CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS'
let savedEnv: string | undefined

function setEnv(value: string | undefined): void {
  if (savedEnv === undefined) {
    savedEnv = process.env[ENV_VAR]
  }
  if (value === undefined) {
    delete process.env[ENV_VAR]
  } else {
    process.env[ENV_VAR] = value
  }
}

afterEach(() => {
  if (savedEnv !== undefined) {
    process.env[ENV_VAR] = savedEnv
  } else {
    delete process.env[ENV_VAR]
  }
  savedEnv = undefined
})

describe('getRetryDelay baseDelayMs override (CC 2.1.292 a$ 5th param)', () => {
  test('default base stays 500 (attempt 1 → [500, 625])', () => {
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(1)
      expect(d).toBeGreaterThanOrEqual(500)
      expect(d).toBeLessThanOrEqual(625)
    }
  })

  test('baseDelayMs=2000 scales the attempt-1 window to [2000, 2500]', () => {
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(1, null, 32000, 2000)
      expect(d).toBeGreaterThanOrEqual(2000)
      expect(d).toBeLessThanOrEqual(2500)
    }
  })

  test('baseDelayMs doubles per attempt (attempt 2 → [4000, 5000])', () => {
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(2, null, 32000, 2000)
      expect(d).toBeGreaterThanOrEqual(4000)
      expect(d).toBeLessThanOrEqual(5000)
    }
  })

  test('capMs still clamps the pre-jitter base (official gT Math.min)', () => {
    // base 32000 at attempt 10 would be 32000*2^9 — capped at 1000, then
    // proportional jitter up to +25% → [1000, 1250].
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(10, null, 1000, 32000)
      expect(d).toBeGreaterThanOrEqual(1000)
      expect(d).toBeLessThanOrEqual(1250)
    }
  })

  test('retry-after header still floors the overridden backoff (Math.max)', () => {
    const d = getRetryDelay(1, '30', 32000, 500)
    expect(d).toBe(30000)
  })

  test('retry-after floor does not cap-clip: max(30s, jittered backoff)', () => {
    const d = getRetryDelay(1, '0', 32000, 2000)
    // Math.max(0, [2000..2500]) → the backoff wins.
    expect(d).toBeGreaterThanOrEqual(2000)
    expect(d).toBeLessThanOrEqual(2500)
  })
})

describe('getOverloadedRetryBaseDelayMs (H.int({min:500,max:32000,digitsOnly:!0}))', () => {
  test('unset → undefined (a$ default le=500 applies)', () => {
    setEnv(undefined)
    expect(getOverloadedRetryBaseDelayMs()).toBeUndefined()
  })

  test('valid mid-range value "5000" → 5000', () => {
    setEnv('5000')
    expect(getOverloadedRetryBaseDelayMs()).toBe(5000)
  })

  test('boundary values 500 and 32000 are valid', () => {
    setEnv('500')
    expect(getOverloadedRetryBaseDelayMs()).toBe(500)
    setEnv('32000')
    expect(getOverloadedRetryBaseDelayMs()).toBe(32000)
  })

  test('below min "499" → undefined', () => {
    setEnv('499')
    expect(getOverloadedRetryBaseDelayMs()).toBeUndefined()
  })

  test('above max "32001" → undefined', () => {
    setEnv('32001')
    expect(getOverloadedRetryBaseDelayMs()).toBeUndefined()
  })

  test('non-numeric "abc" → undefined', () => {
    setEnv('abc')
    expect(getOverloadedRetryBaseDelayMs()).toBeUndefined()
  })

  test('non-integer "1500.5" → undefined (digitsOnly)', () => {
    setEnv('1500.5')
    expect(getOverloadedRetryBaseDelayMs()).toBeUndefined()
  })

  test('sci-notation "1e3" → undefined (digitsOnly rejects)', () => {
    setEnv('1e3')
    expect(getOverloadedRetryBaseDelayMs()).toBeUndefined()
  })

  test('digit separators "1,000" → undefined (digitsOnly rejects)', () => {
    setEnv('1,000')
    expect(getOverloadedRetryBaseDelayMs()).toBeUndefined()
  })

  test('signed "+1000" → 1000 (official regex allows a leading sign)', () => {
    setEnv('+1000')
    expect(getOverloadedRetryBaseDelayMs()).toBe(1000)
  })

  test('negative "-1000" → undefined (below min)', () => {
    setEnv('-1000')
    expect(getOverloadedRetryBaseDelayMs()).toBeUndefined()
  })

  test('empty string → undefined', () => {
    setEnv('')
    expect(getOverloadedRetryBaseDelayMs()).toBeUndefined()
  })
})
