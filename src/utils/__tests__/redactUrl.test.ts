import { describe, expect, test } from 'bun:test'
import {
  REDACTED_URL,
  redactCredentialsInText,
  redactUrlCredentials,
} from '../redactUrl'

/**
 * 2.1.275 upstream port (SECURITY, changelog item 3): password/token shown
 * in plugin/marketplace messages, logs, `claude plugin marketplace list`.
 *
 * Official v276 byte references:
 * - scrubber `j6e` @200182994 (+ safe query-param allowlist `JCs` @200182917)
 * - redactor constant `kA="[redacted URL]"` @190591150
 * - text scrubber `d8t` @190591969 (`replace(/:\/\/[^/?#]*@/g,"://")`)
 */

const TOKEN = 'ghp_SecretToken123'

describe('redactUrlCredentials — official j6e alignment', () => {
  test('strips user:token userinfo from an https URL', () => {
    expect(
      redactUrlCredentials(`https://user:${TOKEN}@github.com/owner/repo.git`),
    ).toBe('https://github.com/owner/repo.git')
  })

  test('strips token-only userinfo', () => {
    expect(redactUrlCredentials(`https://${TOKEN}@host/path`)).toBe(
      'https://host/path',
    )
  })

  test('strips userinfo from the LAST @ before the host', () => {
    // p@ss contains an @ — everything between :// and the last authority @
    // is userinfo and must go.
    expect(
      redactUrlCredentials(`https://user:p@ss${TOKEN}@host/path`),
    ).toBe('https://host/path')
  })

  test('leaves a URL with @ only in the path (no userinfo) byte-identical', () => {
    const url = 'https://host/path@v1/file.zip'
    expect(redactUrlCredentials(url)).toBe(url)
  })

  test('leaves a credential-free URL byte-identical (no re-serialization)', () => {
    const url = 'https://HOST.example:8443/Path%20With?x=1#frag'
    // no userinfo/search-scrub trigger? search IS present → query filtering
    // applies; use a plain URL for the byte-identical guarantee:
    const plain = 'https://HOST.example:8443/Path%20With'
    expect(redactUrlCredentials(plain)).toBe(plain)
    // with a query string, unsafe params are masked (official JCs allowlist):
    expect(redactUrlCredentials(url)).toBe(
      'https://host.example:8443/Path%20With?***',
    )
  })

  test('unparseable credential-looking input fails closed to [redacted URL]', () => {
    // colon before the first @ → userinfo-shaped → kA (byte-exact official)
    expect(redactUrlCredentials(`https://user:${TOKEN}@exa mple.com/x`)).toBe(
      REDACTED_URL,
    )
    expect(REDACTED_URL).toBe('[redacted URL]')
    // multiple @s → ambiguous → kA
    expect(redactUrlCredentials(`user:${TOKEN}@host@other`)).toBe(REDACTED_URL)
  })

  test('unparseable input without credential markers passes through (official j6e fallback)', () => {
    // scp-like git shorthand: single @, no colon before it → unchanged
    const scp = 'git@github.com:owner/repo.git'
    expect(redactUrlCredentials(scp)).toBe(scp)
    // bare owner/repo shorthand and plain text
    expect(redactUrlCredentials('owner/repo')).toBe('owner/repo')
    // local filesystem paths stay intact
    expect(redactUrlCredentials('/home/dev/plugins@x/local.mcpb')).toBe(
      '/home/dev/plugins@x/local.mcpb',
    )
  })

  test('credentials plus another @ in path/query/fragment fails closed (official M check)', () => {
    expect(
      redactUrlCredentials(`https://user:${TOKEN}@host/p@th`),
    ).toBe(REDACTED_URL)
  })

  test('preserves an explicit trailing slash and drops an implicit one', () => {
    expect(redactUrlCredentials(`https://user:${TOKEN}@host/`)).toBe(
      'https://host/',
    )
    expect(redactUrlCredentials(`https://user:${TOKEN}@host`)).toBe(
      'https://host',
    )
  })

  test('query params follow the official JCs allowlist', () => {
    expect(
      redactUrlCredentials(`https://user:${TOKEN}@host/repo.zip?ref=main`),
    ).toBe('https://host/repo.zip?ref=main')
    expect(
      redactUrlCredentials(`https://user:${TOKEN}@host/r.zip?token=abc123`),
    ).toBe('https://host/r.zip?***')
    expect(
      redactUrlCredentials('https://host/r.zip?version=1.2.3&sig=leakymeat'),
    ).toBe('https://host/r.zip?version=1.2.3&***')
    // valueless params are masked
    expect(redactUrlCredentials('https://host/r.zip?flag')).toBe(
      'https://host/r.zip?***',
    )
  })

  test('fragment is dropped (official M strips hash)', () => {
    expect(redactUrlCredentials(`https://user:${TOKEN}@host/p#secret`)).toBe(
      'https://host/p',
    )
  })

  test('ssh URLs keep host/path and lose userinfo', () => {
    expect(
      redactUrlCredentials(`ssh://user:${TOKEN}@github.com/owner/repo.git`),
    ).toBe('ssh://github.com/owner/repo.git')
  })

  test('empty string and scheme-less garbage pass through', () => {
    expect(redactUrlCredentials('')).toBe('')
    expect(redactUrlCredentials('not a url')).toBe('not a url')
  })
})

describe('redactCredentialsInText — official d8t alignment', () => {
  test('strips userinfo from URLs embedded in free-form text', () => {
    const text = `Failed to clone from https://user:${TOKEN}@github.com/o/r.git (exit 128)`
    const out = redactCredentialsInText(text)
    expect(out).not.toContain(TOKEN)
    expect(out).toBe(
      'Failed to clone from https://github.com/o/r.git (exit 128)',
    )
  })

  test('scrubs multiple embedded URLs', () => {
    const text = `a https://u:t1@h1/x then http://u:t2@h2/y end`
    const out = redactCredentialsInText(text)
    expect(out).toBe('a https://h1/x then http://h2/y end')
  })

  test('leaves text without ://…@ patterns untouched', () => {
    const text = 'plain error at /tmp/x@y/z.mcpb (owner/repo, git@github.com:o/r.git)'
    expect(redactCredentialsInText(text)).toBe(text)
  })
})
