import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { isEndpointOnConfiguredAnthropicBase } from '../providers.js'

/**
 * PORT (CC 2.1.285): `ng(e)` — the endpoint-host predicate gating the
 * ANTHROPIC_AUTH_TOKEN env-bearer fallback in the auth header builder.
 * Byte-verified against the 2.1.285 binary (auth chunk-f74xvn8g):
 *
 *   var RC="api.anthropic.com";                                  // @198111811
 *   function tg(){if(a.ANTHROPIC_BASE_URL)return Vi(a.ANTHROPIC_BASE_URL);return RC}
 *   function ng(e){return ji(tg(),e)}
 *   function ji(e,n){let r=MC(n)?Vi(n):void 0;return e!==void 0&&e===r&&DC(r)}
 *   function MC(e){try{return new URL(e).protocol==="https:"}catch{return!1}}
 *   function Vi(e){if(!e)return;try{return new URL(e).host}catch{return}}
 *   function DC(e){return vh(`https://${e}`)||mIe.some((n)=>Vi(n)===e)}
 *   function vh(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}
 *   mIe=["https://beacon.claude-ai.staging.ant.dev","https://claude.fedstart.com",
 *        "https://claude-staging.fedstart.com"]                  // @195582744
 */

const ENV_KEYS = ['ANTHROPIC_BASE_URL'] as const
const savedEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}

beforeEach(() => {
  delete process.env.ANTHROPIC_BASE_URL
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('isEndpointOnConfiguredAnthropicBase — official ng()', () => {
  test('default base: https endpoint on api.anthropic.com is admitted', () => {
    expect(
      isEndpointOnConfiguredAnthropicBase(
        'https://api.anthropic.com/api/claude_code/policy_limits',
      ),
    ).toBe(true)
  })

  test('http endpoint is rejected (MC https-only gate)', () => {
    expect(
      isEndpointOnConfiguredAnthropicBase(
        'http://api.anthropic.com/api/claude_code/policy_limits',
      ),
    ).toBe(false)
  })

  test('host ≠ configured ANTHROPIC_BASE_URL host is rejected (ji equality)', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(
      isEndpointOnConfiguredAnthropicBase(
        'https://claude.fedstart.com/api/claude_code/policy_limits',
      ),
    ).toBe(false)
  })

  test('custom base matching the endpoint host but NOT an approved credential host is rejected (DC gate)', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://my-gateway.example.com'
    expect(
      isEndpointOnConfiguredAnthropicBase(
        'https://my-gateway.example.com/api/claude_code/policy_limits',
      ),
    ).toBe(false)
  })

  test('approved FedStart base + matching endpoint host is admitted (DC mIe arm)', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://claude.fedstart.com'
    expect(
      isEndpointOnConfiguredAnthropicBase(
        'https://claude.fedstart.com/api/claude_code/policy_limits',
      ),
    ).toBe(true)
  })

  test('approved claude-staging.fedstart.com base + matching endpoint is admitted', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://claude-staging.fedstart.com'
    expect(
      isEndpointOnConfiguredAnthropicBase(
        'https://claude-staging.fedstart.com/v1/policy',
      ),
    ).toBe(true)
  })

  test('invalid endpoint URL is rejected (Vi returns undefined)', () => {
    expect(isEndpointOnConfiguredAnthropicBase('not a url')).toBe(false)
  })

  test('SET-but-unparseable ANTHROPIC_BASE_URL rejects every endpoint (tg→Vi undefined, ji e!==void 0 guard)', () => {
    process.env.ANTHROPIC_BASE_URL = 'not a url'
    expect(
      isEndpointOnConfiguredAnthropicBase('https://api.anthropic.com/v1/x'),
    ).toBe(false)
  })

  test('host with port must match exactly (URL.host includes the port)', () => {
    expect(
      isEndpointOnConfiguredAnthropicBase(
        'https://api.anthropic.com:8443/api/claude_code/policy_limits',
      ),
    ).toBe(false)
  })
})
