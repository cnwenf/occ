import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isFirstPartyAnthropicBaseUrl } from '../model/providers.js'

/**
 * 2.1.276 alignment: base-url allowlist predicate (official es()/Xo()).
 * Byte-verified v274:
 *   function Xo(){if(a._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return dw()}
 *   function dw(){let e=process.env.ANTHROPIC_BASE_URL;if(!e)return!0;return av(e)}
 *   function av(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}
 */

const KEYS = [
  'ANTHROPIC_BASE_URL',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'USER_TYPE',
]
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('isFirstPartyAnthropicBaseUrl (official es() port)', () => {
  test('unset base URL → true', () => {
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)
  })
  test('api.anthropic.com → true', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)
  })
  test('proxy base URL → false (the 2.1.275 regression trigger)', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://llm-proxy.corp.example.com'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)
  })
  test('malformed base URL → false', () => {
    process.env.ANTHROPIC_BASE_URL = 'not a url'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)
  })
  test('_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL overrides a proxy URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://llm-proxy.corp.example.com'
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)
  })
  test('_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL falsy value does not override', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://llm-proxy.corp.example.com'
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '0'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)
  })
  test('api-staging.anthropic.com for ant users → true (OCC superset)', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api-staging.anthropic.com'
    process.env.USER_TYPE = 'ant'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)
  })
  test('api-staging.anthropic.com for non-ant users → false', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api-staging.anthropic.com'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)
  })
})
