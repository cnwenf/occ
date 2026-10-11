// Repo-convention MACRO polyfill (must run before withRetry.js is required).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

/**
 * CC 2.1.296 (OCC-154 P2 #004): CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS.
 *
 * v296 rewrote the non-persistent backoff call site (v295 @217571323 →
 * v296 @218332694):
 *   v295: `else if(ir=EF(en+G,Qo,void 0,r.random,
 *            m1(nn)?a.CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS:void 0),
 *            FK())ir=Math.min(ir,dYe),Xr=!0;
 *          else if(ir>fcr)throw ...api_request_retry_after_too_long`
 *   v296: `else{let Vo=w1(an),
 *            or=Vo?a.CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS:void 0;
 *          if(dr=MF(on+G,fo,or,r.random,
 *            Vo?a.CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS:void 0),
 *            QK())dr=Math.min(dr,L6e),Hr=!0;
 *          else if(dr>Math.max(ehr,Math.ceil((or??0)*(1+Swo))))
 *            throw i("tengu_api_retry_after_too_long",
 *              {delayMs:dr,status:an.status,provider:YT()}),
 *              m("api_request","api_request_retry_after_too_long"),
 *              new kc(an,y)}`
 * Two deltas, both gated on the overloaded check w1 (≡ OCC is529Error,
 * byte-identical @209501135):
 *   1. the backoff cap (MF 3rd param, default 32000) is overridable via the
 *      new env — registry descriptor `Ci=H.int({min:32000,max:64000,
 *      digitsOnly:!0})` @207579344, export map @207578248;
 *   2. the too-long threshold widens from the bare `fcr`(=ehr=60000
 *      @218319887) to `Math.max(ehr,Math.ceil((or??0)*(1+Swo)))` — the
 *      widened cap PLUS its jitter headroom, Swo=0.25 @209499871
 *      (`var de=500,Swo=0.25;function MF(e,r,n=32000,o=Math.random,a=de)`).
 *      Rationale: a legitimate overloaded backoff near the raised cap must
 *      not trip the too-long throw.
 *
 * OCC mapping: MF ≡ getRetryDelay (3rd param maxDelayMs), w1 ≡ is529Error,
 * Ci ≡ getOverloadedRetryMaxDelayMs (parseEnvInt + range), threshold formula
 * ≡ getRetryAfterTooLongThresholdMs, ehr ≡ RETRY_AFTER_TOO_LONG_THRESHOLD_MS.
 *
 * Integration harness follows retryWatchdogRetryAfter281.test.ts
 * (passthrough-flag mocks installed BEFORE require; env hygiene; drain loop).
 */

// --- mocks: install BEFORE requiring withRetry.js --------------------------
const actualSleepModule = { ...(await import('../../../utils/sleep.js')) }
let sleepMockActive = true
const sleepCalls: number[] = []
mock.module('../../../utils/sleep.js', () => ({
  ...actualSleepModule,
  sleep: async (ms: number, signal?: AbortSignal) => {
    if (!sleepMockActive) {
      return actualSleepModule.sleep(ms, signal)
    }
    sleepCalls.push(ms)
  },
}))

const actualAnalytics = { ...(await import('../../analytics/index.js')) }
let analyticsMockActive = true
type RecordedEvent = { name: string; metadata: Record<string, unknown> }
const events: RecordedEvent[] = []
mock.module('../../analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    if (!analyticsMockActive) {
      return actualAnalytics.logEvent(name, metadata)
    }
    events.push({ name, metadata })
  },
}))

const {
  withRetry,
  CannotRetryError,
  getRetryDelay,
  getOverloadedRetryMaxDelayMs,
  getRetryAfterTooLongThresholdMs,
} = require('../withRetry.js') as typeof import('../withRetry.js')

// --- env hygiene (same convention as retryWatchdogRetryAfter281.test.ts) ----

const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_DISABLE_FAST_MODE',
  'CLAUDE_CODE_UNATTENDED_RETRY',
  'CLAUDE_CODE_MAX_RETRIES',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'FALLBACK_FOR_ALL_PRIMARY_MODELS',
  'USER_TYPE',
  'CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS',
  'CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS',
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  sleepCalls.length = 0
  events.length = 0
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

afterAll(() => {
  // Passthrough restore — bun's mock.module is process-global; flip the
  // flags off so later files in the shared test process see real behavior.
  sleepMockActive = false
  analyticsMockActive = false
})

// --- helpers ----------------------------------------------------------------

function apiError(
  status: number,
  message: string,
  headers?: Record<string, string>,
): APIError {
  return new APIError(
    status,
    { message },
    message,
    headers ? new Headers(headers) : undefined,
  )
}

/** 529 the SDK way — message carries the overloaded_error type marker (w1). */
function overloadedError(headers?: Record<string, string>): APIError {
  return apiError(529, '{"type":"overloaded_error"}', headers)
}

type RunResult = {
  ok: boolean
  opCalls: number
  threw: unknown
}

/** Drain the withRetry generator; `errorForCall(n)` → error on call n (1-based). */
async function run(
  errorForCall: (callIndex: number) => Error | null,
  opts: { maxRetries: number },
): Promise<RunResult> {
  let opCalls = 0
  const gen = withRetry(
    async () => ({}) as never, // dummy client — operation never uses it
    async () => {
      opCalls++
      const error = errorForCall(opCalls)
      if (error) {
        throw error
      }
      return { ok: true }
    },
    {
      maxRetries: opts.maxRetries,
      model: 'test-model',
      thinkingConfig: { type: 'disabled' as const },
    },
  )
  try {
    while (true) {
      const next = await gen.next()
      if (next.done) {
        break
      }
    }
    return { ok: true, opCalls, threw: null }
  } catch (e) {
    return { ok: false, opCalls, threw: e }
  }
}

const MAX_ENV_VAR = 'CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS'

// --- unit: env descriptor (Ci=H.int({min:32000,max:64000,digitsOnly:!0})) ----

describe('getOverloadedRetryMaxDelayMs (H.int({min:32000,max:64000,digitsOnly:!0}))', () => {
  test('unset → undefined (MF default cap 32000 applies)', () => {
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('valid mid-range value "48000" → 48000', () => {
    process.env[MAX_ENV_VAR] = '48000'
    expect(getOverloadedRetryMaxDelayMs()).toBe(48000)
  })

  test('boundary values 32000 and 64000 are valid', () => {
    process.env[MAX_ENV_VAR] = '32000'
    expect(getOverloadedRetryMaxDelayMs()).toBe(32000)
    process.env[MAX_ENV_VAR] = '64000'
    expect(getOverloadedRetryMaxDelayMs()).toBe(64000)
  })

  test('below min "31999" → undefined', () => {
    process.env[MAX_ENV_VAR] = '31999'
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('above max "64001" → undefined', () => {
    process.env[MAX_ENV_VAR] = '64001'
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('non-numeric "abc" → undefined', () => {
    process.env[MAX_ENV_VAR] = 'abc'
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('non-integer "48000.5" → undefined (digitsOnly)', () => {
    process.env[MAX_ENV_VAR] = '48000.5'
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('sci-notation "1e5" → undefined (digitsOnly rejects)', () => {
    process.env[MAX_ENV_VAR] = '1e5'
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('digit separators "48,000" → undefined (digitsOnly rejects)', () => {
    process.env[MAX_ENV_VAR] = '48,000'
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('signed "+48000" → 48000 (official regex allows a leading sign)', () => {
    process.env[MAX_ENV_VAR] = '+48000'
    expect(getOverloadedRetryMaxDelayMs()).toBe(48000)
  })

  test('negative "-48000" → undefined (below min)', () => {
    process.env[MAX_ENV_VAR] = '-48000'
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  test('empty string → undefined', () => {
    process.env[MAX_ENV_VAR] = ''
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })

  // Absorbed from the OCC-113-track suite (R2 incremental coverage); values
  // adapted to the official [32000,64000] descriptor range.
  test('the env var is re-read on every call (no per-process memo)', () => {
    process.env[MAX_ENV_VAR] = '40000'
    expect(getOverloadedRetryMaxDelayMs()).toBe(40000)
    process.env[MAX_ENV_VAR] = '60000'
    expect(getOverloadedRetryMaxDelayMs()).toBe(60000)
    delete process.env[MAX_ENV_VAR]
    expect(getOverloadedRetryMaxDelayMs()).toBeUndefined()
  })
})

// --- unit: threshold formula Math.max(ehr, Math.ceil((or??0)*(1+Swo))) -------

describe('getRetryAfterTooLongThresholdMs (v296 Math.max(ehr,Math.ceil((or??0)*(1+Swo))))', () => {
  test('no override → 60000 (v295 fcr/ehr behavior unchanged)', () => {
    expect(getRetryAfterTooLongThresholdMs(undefined)).toBe(60_000)
    expect(getRetryAfterTooLongThresholdMs()).toBe(60_000)
  })

  test('override 0 → 60000 (Math.max floor)', () => {
    expect(getRetryAfterTooLongThresholdMs(0)).toBe(60_000)
  })

  test('cap 32000 → max(60000, ceil(40000)) = 60000 (floor still wins)', () => {
    expect(getRetryAfterTooLongThresholdMs(32000)).toBe(60_000)
  })

  test('cap 48000 → max(60000, ceil(60000)) = 60000 (exact tie → floor)', () => {
    expect(getRetryAfterTooLongThresholdMs(48000)).toBe(60_000)
  })

  test('cap 48001 → ceil(60001.25) = 60002 (Math.ceil, not round/floor)', () => {
    expect(getRetryAfterTooLongThresholdMs(48001)).toBe(60_002)
  })

  test('cap 64000 → max(60000, ceil(80000)) = 80000', () => {
    expect(getRetryAfterTooLongThresholdMs(64000)).toBe(80_000)
  })
})

// --- unit: the override feeds getRetryDelay's 3rd param (capMs) --------------

describe('getRetryDelay maxDelayMs override window (MF 3rd param)', () => {
  test('default cap still 32000: attempt 8 → [32000, 40000]', () => {
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(8)
      expect(d).toBeGreaterThanOrEqual(32000)
      expect(d).toBeLessThanOrEqual(40000)
    }
  })

  test('cap 64000: attempt 8 (500*2^7=64000) → [64000, 80000]', () => {
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(8, null, 64000)
      expect(d).toBeGreaterThanOrEqual(64000)
      expect(d).toBeLessThanOrEqual(80000)
    }
  })

  // Absorbed from the OCC-113-track suite (R2 incremental coverage).
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

// --- integration: the call site wires env → cap + widened threshold ----------

describe('2.1.296 #004 — overloaded max-delay override at the non-persistent call site', () => {
  test(
    '529 + MAX=64000 + retry-after 70 SLEEPS (v295 threw: 70000 > 60000; v296 threshold 80000)',
    async () => {
      // Arrange — watchdog OFF, non-persistent, overloaded-shaped error.
      process.env[MAX_ENV_VAR] = '64000'
      const result = await run(
        n => (n === 1 ? overloadedError({ 'retry-after': '70' }) : null),
        { maxRetries: 5 },
      )

      // Assert — sleeps the floored header, no too-long throw/telemetry.
      expect(result.threw).toBeNull()
      expect(result.ok).toBe(true)
      expect(result.opCalls).toBe(2)
      expect(sleepCalls).toEqual([70_000])
      expect(
        events.find(e => e.name === 'tengu_api_retry_after_too_long'),
      ).toBeUndefined()
    },
    15000,
  )

  test(
    'non-overloaded 500 + MAX=64000 + retry-after 70 still THROWS (env is w1-gated)',
    async () => {
      // Arrange — official reads the env only when w1(an): a plain 500 keeps
      // or=void 0 → threshold stays 60000 → 70000 > 60000 → throw.
      process.env[MAX_ENV_VAR] = '64000'
      const result = await run(
        n =>
          n === 1
            ? apiError(500, 'server error', { 'retry-after': '70' })
            : null,
        { maxRetries: 5 },
      )

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.ok).toBe(false)
      expect(sleepCalls.length).toBe(0)
      const tooLong = events.find(
        e => e.name === 'tengu_api_retry_after_too_long',
      )
      expect(tooLong).toBeDefined()
      expect(tooLong?.metadata.delayMs).toBe(70_000)
      expect(tooLong?.metadata.status).toBe(500)
    },
    15000,
  )

  test(
    '529 + MAX=64000 + retry-after 90 THROWS (widened threshold is finite: 90000 > 80000)',
    async () => {
      // Arrange
      process.env[MAX_ENV_VAR] = '64000'
      const result = await run(
        n => (n === 1 ? overloadedError({ 'retry-after': '90' }) : null),
        { maxRetries: 5 },
      )

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.ok).toBe(false)
      expect(sleepCalls.length).toBe(0)
      const tooLong = events.find(
        e => e.name === 'tengu_api_retry_after_too_long',
      )
      expect(tooLong).toBeDefined()
      expect(tooLong?.metadata.delayMs).toBe(90_000)
      expect(tooLong?.metadata.status).toBe(529)
    },
    15000,
  )

  test(
    '529 + MAX unset + retry-after 70 still THROWS (v295 default behavior preserved)',
    async () => {
      // Arrange — no env: or=void 0 → threshold 60000, cap 32000 (the header
      // floor bypasses the cap inside MF, exactly as in v295).
      const result = await run(
        n => (n === 1 ? overloadedError({ 'retry-after': '70' }) : null),
        { maxRetries: 5 },
      )

      // Assert
      expect(result.threw).toBeInstanceOf(CannotRetryError)
      expect(result.ok).toBe(false)
      expect(sleepCalls.length).toBe(0)
      expect(
        events.find(e => e.name === 'tengu_api_retry_after_too_long'),
      ).toBeDefined()
    },
    15000,
  )

  test(
    '529 + MAX=64000: exponential backoff (no header) is capped at 64000+jitter, not 32000',
    async () => {
      // Arrange — attempt 8+ would exceed the old 32000 cap; with the env the
      // pre-jitter base clamps at 64000 → slept delay ∈ [64000, 80000] and
      // stays under the widened 80000 threshold (no throw).
      process.env[MAX_ENV_VAR] = '64000'
      process.env.CLAUDE_CODE_MAX_RETRIES = '10'
      const result = await run(() => overloadedError(), { maxRetries: 10 })

      // Assert — every sleep within the widened-cap window; the run ends
      // retry-exhausted (always-529), NOT via the too-long throw.
      expect(result.ok).toBe(false)
      expect(
        events.find(e => e.name === 'tengu_api_retry_after_too_long'),
      ).toBeUndefined()
      const lateSleeps = sleepCalls.slice(7) // attempts 8..10 (0-based tail)
      expect(lateSleeps.length).toBeGreaterThan(0)
      for (const ms of lateSleeps) {
        expect(ms).toBeGreaterThanOrEqual(64000)
        expect(ms).toBeLessThanOrEqual(80000)
      }
    },
    15000,
  )
})
