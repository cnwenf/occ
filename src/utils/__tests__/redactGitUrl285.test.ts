import { describe, expect, test } from 'bun:test'
import { redactGitUrl } from '../redactGitUrl.js'
import { REDACTED_URL } from '../redactUrl.js'

/**
 * Dedicated coverage for `src/utils/redactGitUrl.ts` — the byte-faithful port of
 * the official CC 2.1.285 `vp` closure. `vp` is the credential-redaction guard
 * embedded in EVERY user-facing git-URL refusal (`${Kt(vp(e),200)}`) and in
 * clone logs, so a regression that echoes a credential on any smuggling shape
 * would leak a secret straight into a message the user sees.
 *
 * These tests PIN the CURRENT (correct) behavior of the port. Every expectation
 * below was verified by running the real implementation, not guessed. Each
 * `describe` maps to a branch / branch-cluster in redactGitUrl.ts; inline
 * `branch:` comments name the exact production function each case exercises.
 *
 * Public surface under test: `redactGitUrl(url) =
 *   applyRedactorIfStable(url, redactGitUrlInner, REDACTED_URL)`.
 *
 * Security invariant asserted throughout: for any credential-bearing or
 * smuggled input, the raw secret substrings ('pass', 'token', 'hunter2',
 * 'user:pass', '@evil.com') NEVER appear in the returned string.
 */

const SENTINEL = REDACTED_URL // '[redacted URL]'

/** Assert none of the given secret substrings survive in the redacted output. */
function expectNoSecrets(output: string, secrets: string[]): void {
  for (const secret of secrets) {
    expect(output).not.toContain(secret)
  }
}

/** Pin an exact redaction output AND assert the secrets are gone. */
function expectRedaction(input: string, expected: string, secrets: string[]): void {
  const out = redactGitUrl(input)
  expect(out).toBe(expected)
  expectNoSecrets(out, secrets)
}

// ---------------------------------------------------------------------------
// 1. Backslash-credential file URLs.
//    branch: redactGitUrlInner → isSmuggledDestination → isFileUrlBackslashCredential
//    (the `@`/`:` live in the PATH, so only the file-backslash guard catches them).
//    This is the reviewer's MAIN mutation-leak shape.
// ---------------------------------------------------------------------------
describe('redactGitUrl: backslash-credential file URLs collapse to the sentinel', () => {
  test('file://server/share\\user:pass@evil.com/x → [redacted URL], no credential echoed', () => {
    const input = 'file://server/share\\user:pass@evil.com/x'
    expectRedaction(input, SENTINEL, ['pass', 'user:pass', '@evil.com', 'hunter2'])
  })

  test('backslash-credential file URL without a trailing path still redacts', () => {
    const input = 'file://server/share\\user:pass@evil.com'
    expectRedaction(input, SENTINEL, ['pass', 'user:pass', '@evil.com'])
  })

  test('network-shaped backslash smuggling (https) also redacts', () => {
    // branch: redactGitUrlInner → isNetworkUrlWithBackslashCredential && !looksLikePlainLocalPath
    const input = 'https://github.com\\@evil.com/x'
    expectRedaction(input, SENTINEL, ['@evil.com'])
  })
})

// ---------------------------------------------------------------------------
// 2. Encoded-colon / encoded-@ hosts.
//    branch: hasEncodedColonHostWithAt, isGitSchemeUrlWithCredentials,
//    hasCredentialsAfterScheme (%40/%3a aware), decodeAmbiguousPercents.
// ---------------------------------------------------------------------------
describe('redactGitUrl: encoded-colon and encoded-@ hosts', () => {
  test('git://h0st%3a443/path@later → [redacted URL] (encoded colon in host + later @)', () => {
    // branch: redactUrlStrict → hasEncodedColonHostWithAt
    expectRedaction('git://h0st%3a443/path@later', SENTINEL, [])
  })

  test('ssh://user%3apass@host/x → [redacted URL] (encoded colon credential)', () => {
    // branch: isGitSchemeUrlWithCredentials (decodes %3a, sees user:pass@)
    expectRedaction('ssh://user%3apass@host/x', SENTINEL, ['pass'])
  })

  test('ssh://git%40github.com/x → [redacted URL] (encoded @ in ssh authority)', () => {
    // branch: isGitSchemeUrlWithCredentials (%40 → @)
    expectRedaction('ssh://git%40github.com/x', SENTINEL, [])
  })

  test('git://host%3a443%40user/path → [redacted URL]', () => {
    expectRedaction('git://host%3a443%40user/path', SENTINEL, [])
  })

  test('git://ho%3ast/path@x → [redacted URL]', () => {
    expectRedaction('git://ho%3ast/path@x', SENTINEL, [])
  })

  test('https://user%3Apass@host/path strips the credential (decoded, not sentinel)', () => {
    // branch: applyRedactorIfStable stable-decode path → redactUrlStrict strips userinfo
    expectRedaction('https://user%3Apass@host/path', 'https://host/path', ['pass', 'user'])
  })

  test('git://host%5cuser:pass@evil/x → [redacted URL] (%5c backslash in non-http scheme)', () => {
    // branch: decodeAmbiguousPercents decodes %5c for non-http-ish → backslash guard fires
    expectRedaction('git://host%5cuser:pass@evil/x', SENTINEL, ['pass', 'user:pass'])
  })

  test('https://host%5cuser:pass@evil/x strips userinfo (%5c NOT decoded for http-ish)', () => {
    // branch: isHttpish → decodeAmbiguousPercents leaves %5c; URL userinfo still stripped
    const out = redactGitUrl('https://host%5cuser:pass@evil/x')
    expect(out).toBe('https://evil/x')
    expectNoSecrets(out, ['pass', 'user:pass', 'user'])
  })
})

// ---------------------------------------------------------------------------
// 3. [redacted URL] fallback for ambiguous authority endings + oscillation.
//    branch: applyRedactorIfStable stability check → falls back to the sentinel
//    when decoding makes the redactor disagree with itself (oscillation), or
//    when scpLikeHostMismatch flags an ambiguous authority boundary.
// ---------------------------------------------------------------------------
describe('redactGitUrl: ambiguous-authority and oscillation fallback to the sentinel', () => {
  test('user:pass@host:path → [redacted URL] (ambiguous scp-like authority boundary)', () => {
    // branch: redactOrFallback → isSmuggleShape → scpLikeHostMismatch
    expectRedaction('user:pass@host:path', SENTINEL, ['pass', 'user:pass'])
  })

  test('https://u%40host → [redacted URL] (redaction oscillates under %40 decode)', () => {
    // inner(raw) keeps 'https://u%40host'; decoded 'https://u@host' strips to
    // 'https://host' → decode(inner) !== inner(decoded) → unsafe → sentinel.
    expectRedaction('https://u%40host', SENTINEL, [])
  })

  test('git://user:pass@host/p%40x:pass → [redacted URL] (strip-vs-redact oscillation)', () => {
    expectRedaction('git://user:pass@host/p%40x:pass', SENTINEL, ['pass', 'user:pass'])
  })

  test('https://git@ho%3ast → [redacted URL] (host-only redaction oscillates on %3a decode)', () => {
    expectRedaction('https://git@ho%3ast', SENTINEL, [])
  })

  test('ssh://git@host/path@[evil] → [redacted URL] (bracket host after path start)', () => {
    // branch: isSmuggledDestination → hasBracketHostAfterPathStart
    expectRedaction('ssh://git@host/path@[evil]', SENTINEL, [])
  })

  test('ssh://git@host/path%40%5bevil%5d → [redacted URL] (encoded bracket after path)', () => {
    expectRedaction('ssh://git@host/path%40%5bevil%5d', SENTINEL, [])
  })
})

// ---------------------------------------------------------------------------
// 4. applyRedactorIfStable stability behavior (all four branches).
// ---------------------------------------------------------------------------
describe('redactGitUrl: applyRedactorIfStable branch coverage', () => {
  test('redacted === fallback → returns the sentinel (no stability check needed)', () => {
    // branch: `if (redacted === fallback ...) return redacted`
    expect(redactGitUrl('file://server/share\\user:pass@evil.com/x')).toBe(SENTINEL)
  })

  test('decoded === url (benign %20) → returns the redactor output directly', () => {
    // branch: `if (... || decoded === url) return redacted` — %20 is not %40/%3a/%5c
    expect(redactGitUrl('https://user:pass@host/a%20b')).toBe('https://host/a%20b')
  })

  test('decoded === url (benign %2F, no credential) → passes through untouched', () => {
    expect(redactGitUrl('https://host/p%2Fq')).toBe('https://host/p%2Fq')
  })

  test('decode-stable %40 in PATH → returns redactor output (not the sentinel)', () => {
    // branch: stability check passes because decode(inner) === inner(decoded)
    expect(redactGitUrl('https://host/%40user:pass')).toBe('https://host/%40user:pass')
  })

  test('decode-UNSTABLE authority → falls back to the sentinel', () => {
    // branch: `return ... ? redacted : fallback` (the false arm)
    expect(redactGitUrl('https://u%40host')).toBe(SENTINEL)
  })
})

// ---------------------------------------------------------------------------
// 5. Standard shapes: credential stripping, passthrough, scp/ssh/ipv6, Windows.
// ---------------------------------------------------------------------------
describe('redactGitUrl: standard credential stripping', () => {
  test('https://user:token@host/path → https://host/path', () => {
    expectRedaction('https://user:token@host/path', 'https://host/path', ['token', 'user'])
  })

  test('https://user:pass@host (no path) → https://host', () => {
    expectRedaction('https://user:pass@host', 'https://host', ['pass', 'user'])
  })

  test('http://a:b@c → http://c', () => {
    expectRedaction('http://a:b@c', 'http://c', ['a:b'])
  })

  test('https://user@host/path (username only) → https://host/path', () => {
    expect(redactGitUrl('https://user@host/path')).toBe('https://host/path')
  })

  test('ssh://user:pass@github.com/repo.git → ssh://github.com/repo.git', () => {
    expectRedaction('ssh://user:pass@github.com/repo.git', 'ssh://github.com/repo.git', ['pass'])
  })

  test('git://user:hunter2@github.com/owner/repo.git → git://github.com/owner/repo.git', () => {
    // This is the exact control shape from the mutation finding.
    expectRedaction(
      'git://user:hunter2@github.com/owner/repo.git',
      'git://github.com/owner/repo.git',
      ['hunter2', 'user'],
    )
  })

  test('query and fragment are stripped', () => {
    // branch: redactUrlStrict clears parsed.search / parsed.hash
    expect(redactGitUrl('https://host/path?ref=x')).toBe('https://host/path')
    expect(redactGitUrl('https://host/path#frag')).toBe('https://host/path')
    expect(redactGitUrl('https://user@host/path?x=1')).toBe('https://host/path')
  })
})

describe('redactGitUrl: no-credential URLs pass through unchanged', () => {
  const passthrough = [
    'https://github.com/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'git+ssh://github.com/owner/repo.git',
    'ssh+git://github.com/owner/repo.git',
    'file:///tmp/owner/repo',
    'git@github.com:owner/repo.git', // scp-like, no credential
    'git@[2001:db8::1]:repo.git', // scp-like IPv6
    'ssh://[2001:db8::1]/repo.git', // ssh IPv6
    'git://host:22/path', // git scheme with a port (not a credential)
    'ssh://git@host:22/repo', // ssh user + port
    'host:path/to/repo', // bare scp-like host:path
    '/home/me/repo', // absolute local path
    './repo', // relative local path
    'example.com', // bare host
    'https://host/', // trailing slash preserved (inner does not touch it)
  ]
  for (const url of passthrough) {
    test(`passthrough: ${url}`, () => {
      expect(redactGitUrl(url)).toBe(url)
    })
  }

  test('empty string is returned as-is', () => {
    expect(redactGitUrl('')).toBe('')
  })
})

describe('redactGitUrl: Windows drive-letter / UNC paths', () => {
  test('C:\\Users\\me\\repo passes through', () => {
    // branch: redactGitUrlInner → WINDOWS_DRIVE_OR_UNC_RE, no '?' → returned as-is
    expect(redactGitUrl('C:\\Users\\me\\repo')).toBe('C:\\Users\\me\\repo')
  })

  test('\\\\server\\share\\repo (UNC) passes through', () => {
    expect(redactGitUrl('\\\\server\\share\\repo')).toBe('\\\\server\\share\\repo')
  })

  test('C:\\repo?x=1 is cut at the query', () => {
    // branch: WINDOWS_DRIVE_OR_UNC_RE with queryIndex !== -1 → slice(0, queryIndex)
    expect(redactGitUrl('C:\\repo?x=1')).toBe('C:\\repo')
  })

  test('\\\\?\\C:\\repo?x=1 device-path query is cut from index 4', () => {
    // branch: url.startsWith('\\\\?\\') → indexOf('?', 4)
    expect(redactGitUrl('\\\\?\\C:\\repo?x=1')).toBe('\\\\?\\C:\\repo')
  })
})

// ---------------------------------------------------------------------------
// 6. Branch-edge shapes: whitespace stripping, the looksLikePlainLocalPath
//    exception arm, invalid-port password shapes, and tail-query heuristics.
// ---------------------------------------------------------------------------
describe('redactGitUrl: whitespace, local-path exception, and parse-failure edges', () => {
  test('leading spaces are stripped before redaction (official `A`)', () => {
    // branch: stripUrlWhitespace leading C0/space class
    expectRedaction('  https://user:pass@host/path', 'https://host/path', ['pass', 'user'])
  })

  test('embedded tab before a backslash-@ smuggle is stripped, then redacted', () => {
    // branch: stripUrlWhitespace \t\n\r removal feeding isNetworkUrlWithBackslashCredential
    expectRedaction('https://github.com\t\\@evil.com/x', SENTINEL, ['@evil.com'])
  })

  test('file-backslash credential with an ENCODED colon (%3a) also redacts', () => {
    // branch: isFileUrlBackslashCredential `:|%3a` disjunct (the %3a arm)
    expectRedaction('file://server/share\\user%3apass@evil.com/x', SENTINEL, [
      'pass',
      'user%3apass',
      '@evil.com',
    ])
  })

  test('a plain backslash-@ local path is NOT treated as network smuggling', () => {
    // branch: redactGitUrlInner isNetworkUrlWithBackslashCredential && !looksLikePlainLocalPath
    // — the looksLikePlainLocalPath true-arm keeps this Windows-ish shape intact.
    expect(redactGitUrl('\\@b\\c')).toBe('\\@b\\c')
  })

  test('https://user@host:pass/x (password-shaped invalid port) → [redacted URL]', () => {
    // new URL throws (bad port) → redactUrlStrict catch path extracts an
    // scp-like host from a non-scp-like URL → sentinel.
    expectRedaction('https://user@host:pass/x', SENTINEL, ['pass', 'user'])
  })

  test('example.com/repo?ref=a@b → query dropped, host kept (port-only tail guard)', () => {
    // branch: redactUrlStrict catch path tailQuery + isPortOnlyHostTail true-arm
    expect(redactGitUrl('example.com/repo?ref=a@b')).toBe('example.com/repo')
  })

  test('example.com:8080/repo?x@y → [redacted URL] (@ after ? in an scp-like shape)', () => {
    // branch: redactUrlStrict catch path tailQuery/@ heuristic — ambiguous → sentinel
    expectRedaction('example.com:8080/repo?x@y', SENTINEL, [])
  })
})

// ---------------------------------------------------------------------------
// 6. Idempotence: redacting an already-redacted string is stable.
// ---------------------------------------------------------------------------
describe('redactGitUrl: idempotence', () => {
  test('the sentinel is a fixed point', () => {
    expect(redactGitUrl(SENTINEL)).toBe(SENTINEL)
  })

  const corpus = [
    'file://server/share\\user:pass@evil.com/x',
    'https://user:token@host/path',
    'git://h0st%3a443/path@later',
    'https://u%40host',
    'ssh://git@github.com/o/r.git',
    'git@github.com:o/r.git',
    'https://github.com/o/r.git',
    'user:pass@host:path',
    'git://user:hunter2@github.com/owner/repo.git',
    'https://host/%40user:pass',
    'C:\\repo?x=1',
  ]
  for (const url of corpus) {
    test(`redactGitUrl(redactGitUrl(x)) === redactGitUrl(x) for ${url}`, () => {
      const once = redactGitUrl(url)
      const twice = redactGitUrl(once)
      expect(twice).toBe(once)
      // Non-leak of each credential/smuggling shape is asserted in its own
      // dedicated test above; this loop pins stability (a fixed point) only.
      // Note: `https://host/%40user:pass` legitimately keeps 'pass' — it is a
      // PATH segment, not a credential — so a blanket secret scan is wrong here.
    })
  }
})
