/**
 * Gap-137b (OCC-137 re-acceptance round): unit tests for the CC 2.1.312
 * sensitive-header-name display redactor (`uxn`/`pt` byte-verbatim port).
 *
 * Semantics under test are the OFFICIAL ones, byte-verified from the 2.1.312
 * linux-x64 ELF:
 *   - name-only match (values never inspected)
 *   - unanchored substring match, case-insensitive (`pt` has no ^/$ anchors)
 *   - `O6e` invisible-char hardening (zero-width/soft-hyphen evasion fails)
 *   - non-mutating (new null-prototype object)
 *   - display-only: the config write path stores plaintext (e2e covers that)
 */
import { describe, expect, test } from 'bun:test'

import {
  HEADER_VALUE_REDACTED,
  redactHeadersForDisplay,
} from '../headerRedaction.js'

describe('redactHeadersForDisplay — official uxn semantics (2.1.312)', () => {
  test('reviewer repro: Authorization redacted, X-Custom verbatim', () => {
    // Arrange
    const headers = {
      Authorization: 'Bearer sk-test-secret-123',
      'X-Custom': 'plainvalue',
    }

    // Act
    const display = redactHeadersForDisplay(headers)

    // Assert
    expect(display.Authorization).toBe(HEADER_VALUE_REDACTED)
    expect(display['X-Custom']).toBe('plainvalue')
  })

  test('redaction is name-only: sensitive VALUE under a benign name stays', () => {
    // The official `uxn` never inspects values — `pt.test(name)` only.
    const display = redactHeadersForDisplay({
      'X-Custom': 'Bearer sk-super-secret-value',
    })
    expect(display['X-Custom']).toBe('Bearer sk-super-secret-value')
  })

  test('case-insensitive matching', () => {
    const display = redactHeadersForDisplay({
      AUTHORIZATION: 'v1',
      authorization: 'v2',
      'x-Api-KEY': 'v3',
      'X-API-KEY': 'v4',
      Cookie: 'v5',
      BEARER: 'v6',
    })
    expect(display.AUTHORIZATION).toBe(HEADER_VALUE_REDACTED)
    expect(display.authorization).toBe(HEADER_VALUE_REDACTED)
    expect(display['x-Api-KEY']).toBe(HEADER_VALUE_REDACTED)
    expect(display['X-API-KEY']).toBe(HEADER_VALUE_REDACTED)
    expect(display.Cookie).toBe(HEADER_VALUE_REDACTED)
    expect(display.BEARER).toBe(HEADER_VALUE_REDACTED)
  })

  test('unanchored substring match: secret inside a longer name is redacted', () => {
    const display = redactHeadersForDisplay({
      'My-Secret-Header': 'v1',
      'X-Session-Key-2': 'v2',
      'x-goog-api-key': 'v3',
      'proxy-authorization': 'v4',
    })
    expect(display['My-Secret-Header']).toBe(HEADER_VALUE_REDACTED)
    expect(display['X-Session-Key-2']).toBe(HEADER_VALUE_REDACTED)
    expect(display['x-goog-api-key']).toBe(HEADER_VALUE_REDACTED)
    expect(display['proxy-authorization']).toBe(HEADER_VALUE_REDACTED)
  })

  test('names outside the pt alternation are NOT redacted', () => {
    // `x-honeycomb-team` belongs to the separate credential-WARNING regex
    // (`Iae`), not to the `pt` display redactor — the official shows it
    // verbatim in the mcp add confirm output.
    const display = redactHeadersForDisplay({
      'x-honeycomb-team': 'v1',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Request-Id': 'abc-123',
    })
    expect(display['x-honeycomb-team']).toBe('v1')
    expect(display['Content-Type']).toBe('application/json')
    expect(display.Accept).toBe('text/event-stream')
    expect(display['X-Request-Id']).toBe('abc-123')
  })

  test('full pt alternation coverage (one representative per branch)', () => {
    const sensitive: Record<string, string> = {
      'api-key': 'v',
      apikey: 'v',
      api_key: 'v',
      'x-secret': 'v',
      'x-token': 'v',
      'x-password': 'v',
      'x-passwd': 'v',
      'x-credential': 'v',
      'x-bearer': 'v',
      'auth-header': 'v',
      auth_header: 'v',
      'memory-request-mac': 'v',
      memory_request_mac: 'v',
      'session-id': 'v',
      sessionid: 'v',
      'session-key': 'v',
      sessionkey: 'v',
      'connection-string': 'v',
      'private-key': 'v',
      'ssh-key': 'v',
      'encryption-key': 'v',
      'signing-key': 'v',
      'access-key': 'v',
      'deploy-key': 'v',
      'master-key': 'v',
      'license-key': 'v',
      'client-secret': 'v',
      client_secret: 'v',
    }
    const display = redactHeadersForDisplay(sensitive)
    for (const name of Object.keys(sensitive)) {
      expect(display[name]).toBe(HEADER_VALUE_REDACTED)
    }
  })

  test('bare "key" is NOT sensitive (alternation requires a qualifier)', () => {
    // `pt` has no bare `key` branch — only qualified forms (`api[_-]?key`,
    // `(?:private|ssh|…)[_-]?key`, `session[_-]?key`).
    const display = redactHeadersForDisplay({
      Key: 'v1',
      'X-Key': 'v2',
    })
    expect(display.Key).toBe('v1')
    expect(display['X-Key']).toBe('v2')
  })

  test('O6e invisible-char hardening: zero-width/soft-hyphen evasion fails', () => {
    // Explicit \u escapes (never raw invisibles in source - unreviewable):
    const zwspToken = 'to\u200bken' // zero-width space inside "token"
    const zwspApiKey = 'api\u200bkey' // zero-width space replacing the separator
    const shyAuth = 'au\u00adthorization' // soft hyphen inside "authorization"
    const wjPassword = 'pass\u2060word' // word joiner inside "password"
    const bomSecret = 'x-s\uFEFFecret' // BOM/ZWNBSP inside "secret"
    const display = redactHeadersForDisplay({
      [zwspToken]: 'v1',
      [zwspApiKey]: 'v2',
      [shyAuth]: 'v3',
      [wjPassword]: 'v4',
      [bomSecret]: 'v5',
    })
    expect(display[zwspToken]).toBe(HEADER_VALUE_REDACTED)
    expect(display[zwspApiKey]).toBe(HEADER_VALUE_REDACTED)
    expect(display[shyAuth]).toBe(HEADER_VALUE_REDACTED)
    expect(display[wjPassword]).toBe(HEADER_VALUE_REDACTED)
    expect(display[bomSecret]).toBe(HEADER_VALUE_REDACTED)
  })

  test('non-mutating: input object is untouched, result is a new object', () => {
    // Arrange
    const headers: Record<string, string> = {
      Authorization: 'Bearer sk-live',
      'X-Custom': 'plain',
    }
    const snapshot = { ...headers }

    // Act
    const display = redactHeadersForDisplay(headers)

    // Assert
    expect(headers).toEqual(snapshot)
    expect(display).not.toBe(headers)
    // Official builds the copy with Object.create(null) — null prototype.
    expect(Object.getPrototypeOf(display)).toBeNull()
  })

  test('empty record round-trips to an empty record', () => {
    const display = redactHeadersForDisplay({})
    expect(Object.keys(display)).toEqual([])
  })
})
