import { describe, expect, test } from 'bun:test'
import { getPlatform } from '../../platform.js'
import { gitUrlTransport, isPartialCloneTransport } from '../gitTransport.js'

/**
 * 2.1.287 upstream port (gap-research-287 cluster-B Item 7): the official v287
 * git-URL transport parser `Se` (@201495046) and the partial-clone predicate
 * `F4n` (@201495013, allowlist `he=["https","ssh"]` @201494988).
 *
 * Every assertion below is a consequence of the byte-verbatim ported parser —
 * nothing is invented. Official form:
 *
 * ```js
 * function F4n(e){return he.includes(Se(e))}
 * function Se(e){let n=/^[A-Za-z0-9][A-Za-z0-9+.-]*(?=::)/.exec(e)?.[0];if(n!==void 0)return n;
 * let r=/^([a-z][a-z0-9+.-]*):\/\//i.exec(e)?.[1];if(r!==void 0)return r==="git+ssh"||r==="ssh+git"?"ssh":r;
 * let s=e.indexOf(":"),o=e.indexOf("/");
 * return s===-1||o!==-1&&o<s||O()==="windows"&&/^[A-Za-z]:[\\/]/.test(e)?"file":"ssh"}
 * ```
 *
 * PLATFORM NOTE (same convention as gitSshCommand285.test.ts): these tests run
 * on POSIX (`getPlatform() !== 'windows'`), matching the CI target, so the
 * official Windows drive-letter arm (`O()==="windows" && /^[A-Za-z]:[\\/]/`) is
 * UNTESTABLE-ON-CI here — it is asserted only through its non-Windows
 * consequence (`C:\repo` → `ssh`, because the colon-before-slash rule falls
 * through to the scp-like branch when the platform check is false).
 */

describe('gitUrlTransport (official Se) — report step-5 table', () => {
  test('https://x → https', () => {
    expect(gitUrlTransport('https://x')).toBe('https')
  })

  test('http://x → http', () => {
    expect(gitUrlTransport('http://x')).toBe('http')
  })

  test('git+ssh://x → ssh (official normalizes git+ssh to ssh)', () => {
    expect(gitUrlTransport('git+ssh://x')).toBe('ssh')
  })

  test('ssh+git://x → ssh (official normalizes ssh+git to ssh)', () => {
    expect(gitUrlTransport('ssh+git://x')).toBe('ssh')
  })

  test('git@host:p → ssh (scp-like form)', () => {
    expect(gitUrlTransport('git@host:p')).toBe('ssh')
  })

  test('/local/path → file', () => {
    expect(gitUrlTransport('/local/path')).toBe('file')
  })

  test('ext::cmd → ext (git remote-helper form)', () => {
    expect(gitUrlTransport('ext::cmd')).toBe('ext')
  })

  test('Windows drive C:\\repo → file ONLY on windows; non-windows arm yields ssh', () => {
    // Official: `...||O()==="windows"&&/^[A-Za-z]:[\\/]/.test(e)?"file":"ssh"`.
    // On the POSIX CI host the platform conjunct is false, so the drive letter
    // falls through to the scp-like `ssh` branch (colon present, no slash).
    // The `file` result for `C:\repo` is untestable-on-ci (needs windows).
    expect(getPlatform()).not.toBe('windows')
    expect(gitUrlTransport('C:\\repo')).toBe('ssh')
  })
})

describe('gitUrlTransport (official Se) — remaining verbatim-parser branches', () => {
  test('file:// scheme URLs → file', () => {
    expect(gitUrlTransport('file:///tmp/repo.git')).toBe('file')
  })

  test('ssh:// URLs → ssh', () => {
    expect(gitUrlTransport('ssh://git@host:22/p')).toBe('ssh')
  })

  test('relative and dot-relative paths → file (no colon)', () => {
    expect(gitUrlTransport('relative/path')).toBe('file')
    expect(gitUrlTransport('./local')).toBe('file')
  })

  test('bare host:path → ssh (colon before any slash)', () => {
    expect(gitUrlTransport('host:p')).toBe('ssh')
  })

  test('credentialed https URL → https (scheme captured before the userinfo)', () => {
    expect(gitUrlTransport('https://user:pw@host/p.git')).toBe('https')
  })

  test('remote-helper form wins over the :// scheme (first regex is checked first)', () => {
    expect(gitUrlTransport('ext::ssh://host/p')).toBe('ext')
  })

  test('the scheme is returned as matched — no lowercasing (byte-fidelity)', () => {
    // The official `://` regex carries the `i` flag but the capture is raw, so
    // an uppercase scheme is returned verbatim and therefore misses the
    // lowercase allowlist.
    // Ported as-is; asserted so a future "normalization" cannot silently
    // diverge from the official parser.
    expect(gitUrlTransport('HTTPS://x')).toBe('HTTPS')
  })
})

describe('isPartialCloneTransport (official F4n, allowlist he=["https","ssh"])', () => {
  test('https and ssh URLs allow partial clone', () => {
    expect(isPartialCloneTransport('https://x')).toBe(true)
    expect(isPartialCloneTransport('ssh://git@host/p')).toBe(true)
    expect(isPartialCloneTransport('git+ssh://x')).toBe(true)
    expect(isPartialCloneTransport('ssh+git://x')).toBe(true)
    expect(isPartialCloneTransport('git@host:p')).toBe(true)
  })

  test('http URLs do NOT allow partial clone (the v287 fix)', () => {
    expect(isPartialCloneTransport('http://x')).toBe(false)
    expect(isPartialCloneTransport('http://example.com/repo.git')).toBe(false)
  })

  test('file, remote-helper and uppercase-scheme URLs do NOT allow partial clone', () => {
    expect(isPartialCloneTransport('/local/path')).toBe(false)
    expect(isPartialCloneTransport('file:///tmp/repo.git')).toBe(false)
    expect(isPartialCloneTransport('ext::cmd')).toBe(false)
    expect(isPartialCloneTransport('HTTPS://x')).toBe(false)
  })
})
