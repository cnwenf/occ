import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  API_KEY_NOT_SENT_REASON,
  getAPIProviderForAnalytics,
  hasCustomBaseUrlForAnalytics,
  hasFirstPartyCapabilities,
  isActualFirstPartyAnthropicBaseUrl,
  isFirstPartyAnthropicHost,
  isFirstPartyApiBackend,
  sanitizeApiKeyForAnthropicOwnedEndpoint,
} from '../firstPartyEndpoint.js'

/**
 * CC 2.1.299 (#052 + #070): first-party endpoint discriminator family ported
 * verbatim from the official ELF (gi/$ie/vf/Pm/din/ba/fG/cA @215994500–
 * 215998500, export table @239295153) plus the f5 key sanitizer (fast-mode
 * chunk @~217810900):
 *
 *   Ax=/^(sk-ant-|sk-[\w-]{86}$)/
 *   function qu(){if(a.ANTHROPIC_BASE_URL)return ta(a.ANTHROPIC_BASE_URL);return vx}  // vx="api.anthropic.com"
 *   function nh(e){return Pm(`https://${e}`)||Aje.some((n)=>ta(n)===e)}
 *   function f5(e){let n=qu(),r=n===void 0||!nh(n),s=typeof e==="string"&&Ax.test(e.trim());return!e||r&&!s?null:e}
 *
 * These unit tests pin the helper semantics: hostname set, env behavior,
 * empty/undefined/unparseable base URL, and the genuine-key exception.
 */

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'USER_TYPE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
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

afterAll(() => {
  // No module mocks in this file; keep the env clean for later suites.
})

describe('isFirstPartyAnthropicHost (official Pm)', () => {
  test('accepts exactly api.anthropic.com', () => {
    // Arrange / Act / Assert
    expect(isFirstPartyAnthropicHost('https://api.anthropic.com')).toBe(true)
    expect(isFirstPartyAnthropicHost('https://api.anthropic.com/v1')).toBe(true)
  })

  test('rejects gateway hosts, sibling anthropic hosts, and unparseable URLs', () => {
    expect(isFirstPartyAnthropicHost('https://gw.example')).toBe(false)
    expect(isFirstPartyAnthropicHost('https://not-api.anthropic.com')).toBe(false)
    expect(isFirstPartyAnthropicHost('not a url')).toBe(false)
    expect(isFirstPartyAnthropicHost('')).toBe(false)
  })

  test('treats the explicit default port as the same host', () => {
    // URL normalizes :443 away for https — host stays api.anthropic.com.
    expect(isFirstPartyAnthropicHost('https://api.anthropic.com:443')).toBe(true)
  })
})

describe('isActualFirstPartyAnthropicBaseUrl (official vf)', () => {
  test('returns true when ANTHROPIC_BASE_URL is unset', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(isActualFirstPartyAnthropicBaseUrl()).toBe(true)
  })

  test('returns true when ANTHROPIC_BASE_URL points at api.anthropic.com', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(isActualFirstPartyAnthropicBaseUrl()).toBe(true)
  })

  test('returns false for a third-party gateway base URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    expect(isActualFirstPartyAnthropicBaseUrl()).toBe(false)
  })

  test('returns false for a set-but-unparseable base URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'garbage'
    expect(isActualFirstPartyAnthropicBaseUrl()).toBe(false)
  })

  test('ignores _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL (no env override, unlike gi)', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
    expect(isActualFirstPartyAnthropicBaseUrl()).toBe(false)
  })
})

describe('hasCustomBaseUrlForAnalytics (official din)', () => {
  test('returns undefined for third-party cloud providers (bedrock)', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(hasCustomBaseUrlForAnalytics()).toBeUndefined()
  })

  test('returns true for firstParty provider behind a gateway base URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    expect(hasCustomBaseUrlForAnalytics()).toBe(true)
  })

  test('returns false for firstParty provider with default base URL', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(hasCustomBaseUrlForAnalytics()).toBe(false)
  })
})

describe('isFirstPartyApiBackend (official ba)', () => {
  test('true with firstParty provider and default base URL', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(isFirstPartyApiBackend()).toBe(true)
  })

  test('false behind a gateway base URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    expect(isFirstPartyApiBackend()).toBe(false)
  })

  test('false for bedrock provider', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(isFirstPartyApiBackend()).toBe(false)
  })
})

describe('hasFirstPartyCapabilities (official fG) / getAPIProviderForAnalytics (official cA)', () => {
  test('firstParty provider has first-party capabilities', () => {
    expect(hasFirstPartyCapabilities()).toBe(true)
    expect(getAPIProviderForAnalytics()).toBe('firstParty')
  })

  test('bedrock provider lacks first-party capabilities', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(hasFirstPartyCapabilities()).toBe(false)
    expect(getAPIProviderForAnalytics()).toBe('bedrock')
  })
})

describe('sanitizeApiKeyForAnthropicOwnedEndpoint (official f5)', () => {
  test('drops null/undefined/empty keys', () => {
    expect(sanitizeApiKeyForAnthropicOwnedEndpoint(null)).toBeNull()
    expect(sanitizeApiKeyForAnthropicOwnedEndpoint(undefined)).toBeNull()
    expect(sanitizeApiKeyForAnthropicOwnedEndpoint('')).toBeNull()
  })

  test('passes any key when ANTHROPIC_BASE_URL is unset (default host is first-party)', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(sanitizeApiKeyForAnthropicOwnedEndpoint('gateway-style-key')).toBe(
      'gateway-style-key',
    )
  })

  test('drops a gateway key under a custom ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    expect(sanitizeApiKeyForAnthropicOwnedEndpoint('gw-secret-key')).toBeNull()
  })

  test('still sends a genuine sk-ant- shaped key under a gateway base URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    expect(
      sanitizeApiKeyForAnthropicOwnedEndpoint('sk-ant-api03-abcdefgh'),
    ).toBe('sk-ant-api03-abcdefgh')
  })

  test('still sends an sk- key with exactly 86 word/dash chars (official Ax)', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    const key = `sk-${'a'.repeat(86)}`
    expect(sanitizeApiKeyForAnthropicOwnedEndpoint(key)).toBe(key)
  })

  test('drops an sk- key with only 85 chars (shape mismatch)', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    expect(
      sanitizeApiKeyForAnthropicOwnedEndpoint(`sk-${'a'.repeat(85)}`),
    ).toBeNull()
  })

  test('trims surrounding whitespace before the shape test and returns the original key', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    expect(
      sanitizeApiKeyForAnthropicOwnedEndpoint('  sk-ant-api03-x  '),
    ).toBe('  sk-ant-api03-x  ')
  })

  test('drops any key when the base URL is set but unparseable', () => {
    process.env.ANTHROPIC_BASE_URL = 'not-a-url'
    expect(
      sanitizeApiKeyForAnthropicOwnedEndpoint('sk-ant-api03-abcdefgh'),
    ).toBe('sk-ant-api03-abcdefgh') // genuine shape still passes (f5: shape OR host)
    expect(sanitizeApiKeyForAnthropicOwnedEndpoint('gw-key')).toBeNull()
  })

  test('passes any key on approved FedStart hosts (official Aje)', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://claude.fedstart.com'
    expect(sanitizeApiKeyForAnthropicOwnedEndpoint('fedstart-key')).toBe(
      'fedstart-key',
    )
    process.env.ANTHROPIC_BASE_URL = 'https://claude-staging.fedstart.com'
    expect(sanitizeApiKeyForAnthropicOwnedEndpoint('fedstart-key')).toBe(
      'fedstart-key',
    )
  })
})

describe('API_KEY_NOT_SENT_REASON', () => {
  test('matches the official drop-reason string verbatim (@105112445)', () => {
    expect(API_KEY_NOT_SENT_REASON).toBe(
      'API key not sent: ANTHROPIC_BASE_URL is not an Anthropic host',
    )
  })
})
