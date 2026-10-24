// Repo-convention MACRO polyfill (must run before withRetry.js is required).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

/**
 * CC 2.1.310 (triage-T3-sweep.md B-1) — the retry-watchdog scope gate parity.
 *
 * Official 310 gate (@249421445, byte-recovered; 3 hits for
 * CLAUDE_CODE_RETRY_WATCHDOG_SCOPE in the 310 ELF — env table @116653064,
 * export map @237740334, gate — vs 0 hits in 309):
 *
 *   `function zb(){return i.CLAUDE_CODE_RETRY_WATCHDOG&&
 *     i.CLAUDE_CODE_RETRY_WATCHDOG_SCOPE!=="capacity"}`
 *
 * with the env-table enum `["capacity"]`: setting
 * `CLAUDE_CODE_RETRY_WATCHDOG_SCOPE=capacity` DISABLES the retry watchdog even
 * when `CLAUDE_CODE_RETRY_WATCHDOG` is truthy; any other value (or unset)
 * leaves the first variable's verdict unchanged. The comparison is a strict
 * case-sensitive `!== "capacity"`.
 *
 * OCC port note: the first clause keeps OCC's existing `isEnvTruthy(...)`
 * style (the official reads the env object truthiness directly — OCC's
 * pre-existing 2.1.186 A13 shape, unchanged per task spec); only the second
 * clause is added, exactly as `!== 'capacity'`.
 */

const { isRetryWatchdogEnabled } = require('../withRetry.js') as typeof import(
  '../withRetry.js'
)

const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_RETRY_WATCHDOG_SCOPE',
] as const

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('CC 2.1.310 B-1 — CLAUDE_CODE_RETRY_WATCHDOG_SCOPE=capacity disables the watchdog', () => {
  test('watchdog truthy + SCOPE unset → enabled', () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
    expect(isRetryWatchdogEnabled()).toBe(true)
  })

  test('watchdog truthy + SCOPE=capacity → disabled', () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
    process.env.CLAUDE_CODE_RETRY_WATCHDOG_SCOPE = 'capacity'
    expect(isRetryWatchdogEnabled()).toBe(false)
  })

  test('watchdog truthy + SCOPE=other value → still enabled (enum is exactly ["capacity"])', () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
    process.env.CLAUDE_CODE_RETRY_WATCHDOG_SCOPE = 'everything'
    expect(isRetryWatchdogEnabled()).toBe(true)
  })

  test('the scope comparison is case-sensitive (official strict !== "capacity")', () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
    process.env.CLAUDE_CODE_RETRY_WATCHDOG_SCOPE = 'CAPACITY'
    expect(isRetryWatchdogEnabled()).toBe(true)
  })

  test('watchdog falsy → disabled regardless of scope', () => {
    process.env.CLAUDE_CODE_RETRY_WATCHDOG_SCOPE = 'capacity'
    expect(isRetryWatchdogEnabled()).toBe(false)
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = '0'
    expect(isRetryWatchdogEnabled()).toBe(false)
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = ''
    process.env.CLAUDE_CODE_RETRY_WATCHDOG_SCOPE = 'other'
    expect(isRetryWatchdogEnabled()).toBe(false)
  })
})
