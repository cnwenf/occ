import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getWebFetchCacheTtlDescription,
  getWebFetchCacheTtlMs,
  resetWebFetchCacheTtlForTesting,
} from '../cacheTtl.js'

/**
 * 2.1.233 alignment (OCC-95): the WebFetch URL-cache TTL is configurable via
 * CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS with the official
 * `Ge.int({min:1,digitsOnly:!0})` env-schema semantics — unset, non-digits,
 * non-finite, or <1 values silently fall back to the 900000 ms default.
 */

const ENV_KEY = 'CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS'
const DEFAULT_TTL_MS = 900_000

let savedEnvValue: string | undefined

beforeEach(() => {
  savedEnvValue = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  resetWebFetchCacheTtlForTesting()
})

afterEach(() => {
  if (savedEnvValue === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedEnvValue
  }
  resetWebFetchCacheTtlForTesting()
})

function withTtlEnv(value: string): number {
  process.env[ENV_KEY] = value
  resetWebFetchCacheTtlForTesting()
  return getWebFetchCacheTtlMs()
}

describe('2.1.233 — getWebFetchCacheTtlMs', () => {
  test('unset env uses the 15-minute default', () => {
    expect(getWebFetchCacheTtlMs()).toBe(DEFAULT_TTL_MS)
  })

  test('non-digit values fall back to the default (digitsOnly)', () => {
    for (const value of ['abc', '1e6', '15m', '900.5', '0x10', '']) {
      expect(withTtlEnv(value)).toBe(DEFAULT_TTL_MS)
    }
  })

  test('values below the min:1 bound fall back to the default', () => {
    for (const value of ['0', '-5', '-1']) {
      expect(withTtlEnv(value)).toBe(DEFAULT_TTL_MS)
    }
  })

  test('valid integer values are honored', () => {
    expect(withTtlEnv('60000')).toBe(60_000)
    expect(withTtlEnv('1')).toBe(1)
    expect(withTtlEnv('+120000')).toBe(120_000)
  })

  test('surrounding whitespace is trimmed before parsing', () => {
    expect(withTtlEnv('  60000  ')).toBe(60_000)
  })

  test('the parsed value is memoized per process', () => {
    process.env[ENV_KEY] = '60000'
    expect(getWebFetchCacheTtlMs()).toBe(60_000)
    // Env changes are ignored once the memo is populated (official AVs/Mwd).
    process.env[ENV_KEY] = '30000'
    expect(getWebFetchCacheTtlMs()).toBe(60_000)
  })
})

describe('2.1.233 — getWebFetchCacheTtlDescription', () => {
  test('default renders as 15 minutes', () => {
    expect(getWebFetchCacheTtlDescription()).toBe('15 minutes')
  })

  test('singular minute for a 60-second TTL', () => {
    process.env[ENV_KEY] = '60000'
    resetWebFetchCacheTtlForTesting()
    expect(getWebFetchCacheTtlDescription()).toBe('1 minute')
  })

  test('sub-minute TTLs round up to at least 1 minute', () => {
    process.env[ENV_KEY] = '30000'
    resetWebFetchCacheTtlForTesting()
    expect(getWebFetchCacheTtlDescription()).toBe('1 minute')
  })

  test('plural minutes for larger TTLs', () => {
    process.env[ENV_KEY] = '120000'
    resetWebFetchCacheTtlForTesting()
    expect(getWebFetchCacheTtlDescription()).toBe('2 minutes')
  })
})
