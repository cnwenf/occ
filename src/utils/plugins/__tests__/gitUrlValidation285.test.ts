import { describe, expect, test } from 'bun:test'
import {
  assertValidGitUrl,
  getGitUrlValidationError,
  isValidGitUrl,
} from '../gitUrlValidation.js'
import {
  hasAmbiguousBracketHost,
  hasBackslashSmuggling,
} from '../gitUrlNormalization.js'

/**
 * 2.1.285 upstream port (SECURITY, changelog item 1): "Plugin marketplaces:
 * improved errors when a git address is rejected" — the v284 validator was
 * replaced by the strict official `R8` (@203140966 in the v285 linux binary),
 * which refuses hostile git addresses with a NAMED telemetry reason and a
 * credential-redacted / display-sanitized echo of the offending URL.
 *
 * Every assertion here is byte-derived from the official binary (v285):
 *   - `R8` validator body + `T8` supported-forms sentence + `D_n`/`N_n`/`F_n`
 *   - `IN` bracket-ambiguity check (@195744448) → hasAmbiguousBracketHost
 *   - `SY` backslash-smuggling check (@195745251) → hasBackslashSmuggling
 *   - `vp`/`Kt` redaction+sanitize pipeline for the echoed URL
 * Refusal reasons (the official `new I(message, reason)` 2nd arg) are asserted
 * verbatim via TelemetrySafeError.telemetryMessage.
 *
 * We assert ONLY official behavior — no invented caps, fallbacks, or messages.
 */

const REASON = {
  controlChars: 'git URL contains control characters',
  nul: 'git URL contains %00',
  bracket: 'git URL has a square bracket that git could read as the host',
  scpSlashes: 'scp-like git URL contains ://',
  unparseable: 'Invalid git URL',
  protocol: 'Invalid git URL protocol',
  backslashAuthority: 'git URL has a backslash in its authority',
  sshHostUser: 'ssh git URL host or user has disallowed characters',
  schemeNoSlashes: 'git URL scheme without //',
  fileHostOrNetwork: 'file git URL names a host or network path',
} as const

/** Assert a URL is refused with the given telemetry reason; return the Error. */
function expectRefusal(url: string, reason: string): Error {
  const err = getGitUrlValidationError(url)
  expect(err).toBeInstanceOf(Error)
  expect(err?.name).toBe('TelemetrySafeError')
  expect((err as { telemetryMessage?: string }).telemetryMessage).toBe(reason)
  return err as Error
}

describe('assertValidGitUrl: official R8 accepts the supported forms', () => {
  const valid = [
    'https://github.com/owner/repo.git',
    'http://example.com/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'git+ssh://github.com/owner/repo.git',
    'ssh+git://github.com/owner/repo.git',
    'file:///tmp/owner/repo',
    // scp-like (user@host:path) — D_n matches, no "://" → returned unchanged.
    'git@github.com:owner/repo.git',
    // scp-like with a bracketed IPv6 host is legitimate (IN allows it).
    'git@[2001:db8::1]:repo.git',
    'ssh://[2001:db8::1]/repo.git',
  ]
  for (const url of valid) {
    test(`accepts ${url}`, () => {
      expect(assertValidGitUrl(url)).toBe(url)
      expect(isValidGitUrl(url)).toBe(true)
      expect(getGitUrlValidationError(url)).toBeNull()
    })
  }
})

describe('assertValidGitUrl: official R8 named refusals', () => {
  test('control characters are refused first (raw \\n)', () => {
    const err = expectRefusal(
      'https://github.com/owner\nrepo.git',
      REASON.controlChars,
    )
    expect(err.message).toContain('control characters are not allowed')
  })

  test('%00 is refused with the version-drift explanation', () => {
    const err = expectRefusal(
      'https://github.com/owner%00repo.git',
      REASON.nul,
    )
    expect(err.message).toContain(
      '"%00" in a git address means different things to different versions of git',
    )
  })

  test('a literal square bracket git could read as the host is refused', () => {
    const err = expectRefusal(
      'https://github.com/owner/rep[o].git',
      REASON.bracket,
    )
    expect(err.message).toContain('git can read a square bracket')
    expect(err.message).toContain('brackets may only surround an IPv6 address')
  })

  test('a percent-encoded bracket (%5B/%5D) is refused the same way', () => {
    expectRefusal('https://github.com/owner/%5Brepo%5D.git', REASON.bracket)
  })

  test('an scp-like address containing "://" is refused', () => {
    const err = expectRefusal(
      'git@github.com:owner/repo://evil',
      REASON.scpSlashes,
    )
    expect(err.message).toContain(`can't contain "://"`)
    expect(err.message).toContain('git then reads the text before "://"')
  })

  test('an unparseable, non-scp-like address names the parse failure', () => {
    const err = expectRefusal('not-a-valid-git-address', REASON.unparseable)
    expect(err.message).toContain('(it could not be read as a URL)')
    expect(err.message).toContain("git:// isn't supported because it isn't encrypted")
  })

  test('git:// is refused as an unsupported protocol with the T8 sentence', () => {
    const err = expectRefusal('git://github.com/owner/repo.git', REASON.protocol)
    expect(err.message).toContain('Invalid git URL protocol: git:')
    expect(err.message).toContain(
      'https, http, ssh (also written git+ssh or ssh+git), user@host:path, or a local file:// address with no host.',
    )
  })

  test('a backslash in an https authority is refused', () => {
    const err = expectRefusal(
      'https://github.com\\@evil.com/owner/repo.git',
      REASON.backslashAuthority,
    )
    expect(err.message).toContain('a backslash before the first "/"')
    expect(err.message).toContain('write it as %5C if it is part of a user name')
  })

  test('an ssh URL carrying ? or # is refused', () => {
    const err = expectRefusal(
      'ssh://git@github.com/owner/repo.git?ref=evil',
      REASON.sshHostUser,
    )
    expect(err.message).toContain('Invalid ssh git URL')
    expect(err.message).toContain('may not carry ? or #')
  })

  test('a scheme URL not spelled scheme:// is refused', () => {
    const err = expectRefusal('file:/tmp/owner/repo', REASON.schemeNoSlashes)
    expect(err.message).toContain('a scheme URL must be spelled scheme://')
  })

  test('a file:// URL naming a host is refused', () => {
    const err = expectRefusal(
      'file://evil.com/tmp/repo',
      REASON.fileHostOrNetwork,
    )
    expect(err.message).toContain('Refusing git URL')
    expect(err.message).toContain('a file: URL must name a local path')
    // No drive-letter sentence for a non-drive-letter address.
    expect(err.message).not.toContain('A drive letter such as C:')
  })

  test('a file:// drive-letter URL adds the Windows-only sentence', () => {
    const err = expectRefusal('file://C:/repo', REASON.fileHostOrNetwork)
    expect(err.message).toContain(
      'A drive letter such as C: counts as a local path only on Windows.',
    )
  })
})

describe('assertValidGitUrl: refusals never echo embedded credentials', () => {
  test('a rejected URL with user:pass is redacted out of the message', () => {
    // git:// is an unsupported protocol → refused; the echoed URL must not
    // contain the password (official `Kt(vp(e),200)` redaction pipeline).
    const err = expectRefusal(
      'git://user:hunter2@github.com/owner/repo.git',
      REASON.protocol,
    )
    expect(err.message).not.toContain('hunter2')
  })
})

describe('hasAmbiguousBracketHost (official IN)', () => {
  test('false for a legitimate IPv6 host', () => {
    expect(hasAmbiguousBracketHost('git@[2001:db8::1]:repo.git')).toBe(false)
    expect(hasAmbiguousBracketHost('ssh://[2001:db8::1]/repo.git')).toBe(false)
    expect(hasAmbiguousBracketHost('https://github.com/owner/repo.git')).toBe(false)
  })
  test('true for brackets git could misread (literal + encoded)', () => {
    expect(hasAmbiguousBracketHost('https://github.com/owner/[x].git')).toBe(true)
    expect(hasAmbiguousBracketHost('https://github.com/owner/%5Bx%5D.git')).toBe(true)
    expect(hasAmbiguousBracketHost('git@github.com:[evil]/repo.git')).toBe(true)
  })
})

describe('hasBackslashSmuggling (official SY)', () => {
  test('true when a backslash sits in the authority', () => {
    expect(hasBackslashSmuggling('https://github.com\\@evil.com/x')).toBe(true)
  })
  test('false for a clean https URL and for a scheme-less string', () => {
    expect(hasBackslashSmuggling('https://github.com/owner/repo.git')).toBe(false)
    expect(hasBackslashSmuggling('git@github.com:owner/repo.git')).toBe(false)
  })
  test('strips embedded \\t\\n\\r before scanning (v285 parity)', () => {
    expect(hasBackslashSmuggling('https://github.com\t\\@evil.com/x')).toBe(true)
  })
})
