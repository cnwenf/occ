// Repo-convention MACRO polyfill (must run before withRetry.js is required).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { afterEach, describe, expect, test } from 'bun:test'

/**
 * CC 2.1.296 (#004): CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS.
 *
 * "Added CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS environment variable to
 * set a longer maximum delay for the backoff when retrying an overloaded
 * (529) request" (cl-296).
 *
 * Official 296 call site (non-persistent retry branch):
 *   `let Vo=w1(an),or=Vo?a.CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS:void 0;
 *    dr=MF(on+G,fo,or,r.random,Vo?BASE:void 0);
 *    if(QK())dr=Math.min(dr,L6e),Hr=!0;
 *    else if(dr>Math.max(ehr,Math.ceil((or??0)*(1+Swo))))throw ...`
 *   (w1≡is529Error, MF≡getRetryDelay, ehr≡60000, Swo≡0.25 jitter ratio).
 *
 * OCC mapping: MF ≡ getRetryDelay (3rd param maxDelayMs — the a$ capMs),
 * registry parse ≡ getOverloadedRetryMaxDelayMs, stretched guard ≡
 * RETRY_AFTER_TOO_LONG_THRESHOLD_MS vs Math.ceil(maxDelay*(1+0.25)).
 *
 * Deviation note (documented in withRetry.ts): the 296 evidence carries NO
 * recoverable H.int descriptor for this env (unlike the base-delay env's
 * `H.int({min:500,max:32000,digitsOnly:!0})`), so OCC parses digits-only and
 * requires a positive integer — a minimal sanity floor, not a byte-verified
 * bound.
 */

const { getRetryDelay, getOverloadedRetryMaxDelayMs } =
  require('../withRetry.js') as typeof import('../withRetry.js')

const ENV_VAR = 'CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS'
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

describe('getRetryDelay maxDelayMs cap window (CC 2.1.296 a$ capMs param)', () => {
  test('default cap 32000: attempt 8 saturates at [32000, 40000]', () => {
    // base 500*2^7 = 64000 → capped at 32000, then +25% jitter.
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(8)
      expect(d).toBeGreaterThanOrEqual(32000)
      expect(d).toBeLessThanOrEqual(40000)
    }
  })

  test('a longer 529 cap (60000) lifts the saturated window to [60000, 75000]', () => {
    // base 500*2^7 = 64000 → capped at 60000, then +25% jitter.
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(8, null, 60000)
      expect(d).toBeGreaterThanOrEqual(60000)
      expect(d).toBeLessThanOrEqual(75000)
    }
  })

  test('deep attempts stay clamped at the raised cap (attempt 12 → [60000, 75000])', () => {
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(12, null, 60000)
      expect(d).toBeGreaterThanOrEqual(60000)
      expect(d).toBeLessThanOrEqual(75000)
    }
  })

  test('the cap only clamps — sub-cap attempts are untouched (attempt 1 → [500, 625])', () => {
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(1, null, 60000)
      expect(d).toBeGreaterThanOrEqual(500)
      expect(d).toBeLessThanOrEqual(625)
    }
  })

  test('retry-after header still floors above the raised cap (Math.max)', () => {
    const d = getRetryDelay(1, '90', 60000)
    expect(d).toBe(90000)
  })

  test('raised cap composes with the 292 base-delay override (base 2000, attempt 6 → [60000, 75000])', () => {
    // base 2000*2^5 = 64000 → capped at 60000.
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(6, null, 60000, 2000)
      expect(d).toBeGreaterThanOrEqual(60000)
      expect(d).toBeLessThanOrEqual(75000)
    }
  })
})

describe('getOverloadedRetryMaxDelayMs (digits-only positive integer parse)', () => {
  test('unset → undefined (a$ default capMs 32000 applies)', () => {
    setEnv(undefined)
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('valid value "60000" → 60000', () => {
    setEnv('60000')
    expect(getOverloadedRetryMaxDelayMs()).toBe(60000)
  })

  test('lower boundary "1" → 1 (positivity floor)', () => {
    setEnv('1')
    expect(getOverloadedRetryMaxDelayMs()).toBe(1)
  })

  test('a leading + is accepted (schema trims) "+1000" → 1000', () => {
    setEnv('+1000')
    expect(getOverloadedRetryMaxDelayMs()).toBe(1000)
  })

  test('surrounding whitespace is accepted "  30000  " → 30000', () => {
    setEnv('  30000  ')
    expect(getOverloadedRetryMaxDelayMs()).toBe(30000)
  })

  test('non-positive values fall back to undefined', () => {
    for (const value of ['0', '-1000', '-0']) {
      setEnv(value)
      expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
    }
  })

  test('non-numeric "abc" → undefined', () => {
    setEnv('abc')
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('digitsOnly rejects notation the generic int parser would accept', () => {
    for (const value of ['1500.5', '1e3', '1,000', '64_000', '0x10']) {
      setEnv(value)
      expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
    }
  })

  test('empty string → undefined', () => {
    setEnv('')
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('the env var is re-read on every call (no per-process memo)', () => {
    setEnv('60000')
    expect(getOverloadedRetryMaxDelayMs()).toBe(60000)
    setEnv('120000')
    expect(getOverloadedRetryMaxDelayMs()).toBe(120000)
    setEnv(undefined)
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })
})
