/**
 * CC 2.1.229 (changelog #10 / binary `LGo`): attribution header env-opt-out
 * bypass for auto-mode side queries.
 *
 * Tests the exact bypass condition: `ignoreEnvOptOut` forces the header past
 * a CLAUDE_CODE_ATTRIBUTION_HEADER opt-out ONLY when the provider is
 * firstParty, ANTHROPIC_BASE_URL is unset or host === api.anthropic.com,
 * and ANTHROPIC_UNIX_SOCKET is not set. Without the flag the opt-out still
 * wins. The GrowthBook killswitch is not bypassed (stubbed growthbook
 * returns the default `true`, so it cannot be toggled here — asserted as
 * not-fired-by-the-bypass by the killswitch check remaining after the
 * bypass branch in system.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getAttributionHeader } from '../system.js'

// getAttributionHeader reads MACRO.VERSION at call time — mirror the cli.tsx
// dev polyfill (build injects it) with a recognizable version so assertions
// can embed it. system.ts only touches MACRO inside functions, so defining
// it before the first call is sufficient.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: '2.1.999-test' }
}

const ENV_KEYS = [
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_ENTRYPOINT',
] as const

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

describe('getAttributionHeader baseline (no opt-out)', () => {
  test('emits the billing header with version fingerprint and entrypoint', () => {
    const header = getAttributionHeader('fp123')
    expect(header.startsWith('x-anthropic-billing-header: ')).toBe(true)
    expect(header).toContain('cc_version=2.1.999-test.fp123;')
    expect(header).toContain('cc_entrypoint=unknown;')
  })

  test('honors CLAUDE_CODE_ENTRYPOINT when set', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'auto-mode-test'
    const header = getAttributionHeader('fp')
    expect(header).toContain('cc_entrypoint=auto-mode-test;')
  })
})

describe('CLAUDE_CODE_ATTRIBUTION_HEADER env opt-out', () => {
  test('returns empty string on a falsy env value without the bypass flag', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    expect(getAttributionHeader('fp')).toBe('')
    expect(getAttributionHeader('fp', {})).toBe('')
    expect(getAttributionHeader('fp', { ignoreEnvOptOut: false })).toBe('')
  })

  test('non-falsy env values do not opt out', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '1'
    expect(getAttributionHeader('fp')).not.toBe('')
  })
})

describe('ignoreEnvOptOut bypass (binary LGo condition)', () => {
  test('forces the header past the env opt-out on plain first-party', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    // Provider firstParty (no CLAUDE_CODE_USE_* set), ANTHROPIC_BASE_URL
    // unset, no ANTHROPIC_UNIX_SOCKET → bypass applies.
    const header = getAttributionHeader('fp', { ignoreEnvOptOut: true })
    expect(header.startsWith('x-anthropic-billing-header: ')).toBe(true)
    expect(header).toContain('cc_version=2.1.999-test.fp;')
  })

  test('applies when ANTHROPIC_BASE_URL host is exactly api.anthropic.com', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = 'false'
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(getAttributionHeader('fp', { ignoreEnvOptOut: true })).not.toBe('')
  })

  test('does not apply behind a custom gateway base URL', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    expect(getAttributionHeader('fp', { ignoreEnvOptOut: true })).toBe('')
  })

  test('does not apply for a non-default port on api.anthropic.com', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    // host === 'api.anthropic.com:8443' — not in the plain-host list.
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com:8443'
    expect(getAttributionHeader('fp', { ignoreEnvOptOut: true })).toBe('')
  })

  test('does not apply when ANTHROPIC_BASE_URL is unparseable', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    process.env.ANTHROPIC_BASE_URL = 'not a url'
    expect(getAttributionHeader('fp', { ignoreEnvOptOut: true })).toBe('')
  })

  test('does not apply for non-firstParty providers', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(getAttributionHeader('fp', { ignoreEnvOptOut: true })).toBe('')
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    expect(getAttributionHeader('fp', { ignoreEnvOptOut: true })).toBe('')
  })

  test('does not apply when ANTHROPIC_UNIX_SOCKET is set', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/anthropic.sock'
    expect(getAttributionHeader('fp', { ignoreEnvOptOut: true })).toBe('')
  })
})
