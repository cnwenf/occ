import { describe, expect, test } from 'bun:test'
import {
  buildFallbackRefusalMessage,
  buildInvalidPackageNameMessage,
  buildRegistryRefusalMessage,
  containsControlChar,
  findSpecRejectionReason,
  GIT_HOST_BLOCKLIST,
  isValidNpmPackageName,
  isValidNpmRegistryUrl,
  normalizeGitHost,
  validateNpmSpecUrl,
  validateRegistryOverride,
} from '../npmSpecValidation.js'

/**
 * CC 2.1.286 changelog (SECURITY): "Changed plugin installs to refuse npm
 * sources that are git repositories or folders, and to install plugin
 * dependencies only from registry packages." — VALIDATION half.
 *
 * Every assertion below pins behavior recovered byte-for-byte from the official
 * 2.1.286 linux-x64 ELF (`/tmp/cc-diff-286/v286/package/claude`, code region
 * ~207.63 MB). Official minified identifiers in comments: `X8t` (spec reason),
 * `HWe` (spec + moved), `Z8t` (registry override), `krr` (git blocklist),
 * `Tje`/`HD` (host normalize), `Err` (control char), `fJe` (registry URL),
 * `zy`/`Nue` (name), `Krr`/`Mrr` (refusal builders).
 */

// --- Official reason strings (byte-exact, v286) -----------------------------
const R_NOT_HTTP = 'is not an http or https link'
const R_BAD_CHARS =
  'contains a "#", whitespace, a backslash or a control character'
const R_DOUBLE_SLASH = 'starts its path with "//"'
const gitReason = (label = 'npm') =>
  `is on GitHub, GitLab, Bitbucket or SourceHut, where ${label} may fetch it as a git repository and run its setup script`
const httpReason = (label = 'npm') =>
  `is an unencrypted http link on a host other than your npm registry, so ${label} could send your saved registry token to it in the clear`

// --- krr: git-host blocklist ------------------------------------------------
describe('GIT_HOST_BLOCKLIST (official krr @207630990)', () => {
  test('contains exactly the five official git hosts', () => {
    expect([...GIT_HOST_BLOCKLIST].sort()).toEqual(
      ['bitbucket.org', 'gist.github.com', 'git.sr.ht', 'github.com', 'gitlab.com'].sort(),
    )
  })
})

// --- Tje/HD: host normalization ---------------------------------------------
describe('normalizeGitHost (official Tje/HD)', () => {
  test('strips leading www. labels repeatedly', () => {
    expect(normalizeGitHost('www.github.com')).toBe('github.com')
    expect(normalizeGitHost('www.www.gitlab.com')).toBe('gitlab.com')
  })
  test('lowercases', () => {
    expect(normalizeGitHost('GitHub.COM')).toBe('github.com')
  })
  test('leaves non-hostname-shaped strings (with : / @ etc.) as-is', () => {
    expect(normalizeGitHost('github.com:22')).toBe('github.com:22')
    expect(normalizeGitHost('user@github.com')).toBe('user@github.com')
  })
  test('empty string stays empty', () => {
    expect(normalizeGitHost('')).toBe('')
  })
})

// --- Err: control-char scan -------------------------------------------------
describe('containsControlChar (official Err @207633382)', () => {
  test('false for printable ASCII', () => {
    expect(containsControlChar('abc XYZ 019 !@~')).toBe(false)
  })
  test('false for space (32) — bound is exclusive', () => {
    expect(containsControlChar(' ')).toBe(false)
  })
  test('true for C0 control chars (< 32)', () => {
    expect(containsControlChar('a\x00b')).toBe(true)
    expect(containsControlChar('a\x1fb')).toBe(true)
    expect(containsControlChar('\t')).toBe(true)
  })
  test('true for DEL (127)', () => {
    expect(containsControlChar('a\x7fb')).toBe(true)
  })
  test('false for empty string', () => {
    expect(containsControlChar('')).toBe(false)
  })
})

// --- fJe: registry URL validator --------------------------------------------
describe('isValidNpmRegistryUrl (official fJe @197012762)', () => {
  test('accepts http(s) registries', () => {
    expect(isValidNpmRegistryUrl('https://registry.npmjs.org')).toBe(true)
    expect(isValidNpmRegistryUrl('http://localhost:4873')).toBe(true)
    expect(isValidNpmRegistryUrl('https://npm.example.com/')).toBe(true)
  })
  test('rejects non-http(s) schemes', () => {
    expect(isValidNpmRegistryUrl('ftp://registry.example.com')).toBe(false)
    expect(isValidNpmRegistryUrl('file:///tmp/reg')).toBe(false)
    expect(isValidNpmRegistryUrl('git+https://github.com/x/y')).toBe(false)
  })
  test('rejects a first char of / or \\ after the scheme', () => {
    expect(isValidNpmRegistryUrl('https:///registry')).toBe(false)
    expect(isValidNpmRegistryUrl('https://\\registry')).toBe(false)
  })
  test('rejects garbage', () => {
    expect(isValidNpmRegistryUrl('not a url')).toBe(false)
    expect(isValidNpmRegistryUrl('')).toBe(false)
  })
})

// --- zy/Nue: npm package-name validator -------------------------------------
describe('isValidNpmPackageName (official zy/Nue @207643059/197035693)', () => {
  test('accepts plain + scoped registry names', () => {
    expect(isValidNpmPackageName('my-plugin')).toBe(true)
    expect(isValidNpmPackageName('@scope/my-plugin')).toBe(true)
    expect(isValidNpmPackageName('a.b_c-d')).toBe(true)
  })
  test('accepts uppercase via case-folding (official .replace(/[A-Z]/g,…))', () => {
    expect(isValidNpmPackageName('MyPlugin')).toBe(true)
    expect(isValidNpmPackageName('@Scope/MyPlugin')).toBe(true)
  })
  test('rejects git/url/folder specs', () => {
    expect(isValidNpmPackageName('github:foo/bar')).toBe(false)
    expect(isValidNpmPackageName('https://x.com/a.tgz')).toBe(false)
    expect(isValidNpmPackageName('./folder')).toBe(false)
    expect(isValidNpmPackageName('/abs/folder')).toBe(false)
    expect(isValidNpmPackageName('git+ssh://git@github.com/x/y')).toBe(false)
  })
  test('rejects .. and // and empty and bad shapes', () => {
    expect(isValidNpmPackageName('a..b')).toBe(false)
    expect(isValidNpmPackageName('a//b')).toBe(false)
    expect(isValidNpmPackageName('@scope')).toBe(false)
    expect(isValidNpmPackageName('')).toBe(false)
    expect(isValidNpmPackageName('-lead')).toBe(false)
  })
})

// --- X8t: spec rejection reason ---------------------------------------------
describe('findSpecRejectionReason (official X8t @207632528)', () => {
  test('non-http(s) schemes and folders → not-an-http-link', () => {
    for (const spec of [
      'ftp://registry.example.com/a.tgz',
      'git+https://github.com/x/y',
      './folder',
      '/abs/folder',
      'file:///tmp/a.tgz',
      'github:foo/bar',
      'my-plugin',
    ]) {
      expect(findSpecRejectionReason(spec, undefined)).toBe(R_NOT_HTTP)
    }
  })
  test('"#", whitespace, backslash → bad-chars reason', () => {
    expect(findSpecRejectionReason('https://reg.example.com/a.tgz#frag', undefined)).toBe(R_BAD_CHARS)
    expect(findSpecRejectionReason('https://reg.example.com/a b.tgz', undefined)).toBe(R_BAD_CHARS)
    expect(findSpecRejectionReason('https://reg.example.com/a\tb.tgz', undefined)).toBe(R_BAD_CHARS)
    expect(findSpecRejectionReason('https://reg.example.com\\a.tgz', undefined)).toBe(R_BAD_CHARS)
  })
  test('control char / DEL → bad-chars reason', () => {
    expect(findSpecRejectionReason('https://reg.example.com/a\x01b.tgz', undefined)).toBe(R_BAD_CHARS)
    expect(findSpecRejectionReason('https://reg.example.com/a\x7fb.tgz', undefined)).toBe(R_BAD_CHARS)
  })
  test('git hosts → git reason (default label npm)', () => {
    for (const spec of [
      'https://github.com/foo/bar',
      'https://gist.github.com/foo/bar',
      'https://gitlab.com/foo/bar',
      'https://bitbucket.org/foo/bar',
      'https://git.sr.ht/~foo/bar',
    ]) {
      expect(findSpecRejectionReason(spec, undefined)).toBe(gitReason())
    }
  })
  test('git host matching is case- and www-insensitive', () => {
    expect(findSpecRejectionReason('https://WWW.GitHub.com/foo/bar', undefined)).toBe(gitReason())
    expect(findSpecRejectionReason('https://www.gitlab.com/foo/bar', undefined)).toBe(gitReason())
  })
  test('GitLab package-registry exception (both conditions) is allowed', () => {
    expect(
      findSpecRejectionReason(
        'https://gitlab.com/api/v4/projects/123/-/package_files/x.tgz',
        undefined,
      ),
    ).toBeUndefined()
  })
  test('GitLab without /-/ still refused', () => {
    expect(
      findSpecRejectionReason('https://gitlab.com/api/v4/projects/123/packages/x.tgz', undefined),
    ).toBe(gitReason())
  })
  test('GitLab not under /api/v4/ still refused', () => {
    expect(findSpecRejectionReason('https://gitlab.com/foo/bar/-/raw/x.tgz', undefined)).toBe(gitReason())
  })
  test('GitLab exception also works with www. prefix', () => {
    expect(
      findSpecRejectionReason(
        'https://www.gitlab.com/api/v4/projects/1/-/package_files/x.tgz',
        undefined,
      ),
    ).toBeUndefined()
  })
  test('double-slash path → double-slash reason', () => {
    expect(findSpecRejectionReason('https://reg.example.com//evil.com/x.tgz', undefined)).toBe(R_DOUBLE_SLASH)
  })
  test('http to a foreign host → unencrypted-http reason', () => {
    expect(findSpecRejectionReason('http://evil.example.com/x.tgz', undefined)).toBe(httpReason())
    expect(findSpecRejectionReason('http://evil.example.com/x.tgz', 'http://my.registry')).toBe(httpReason())
  })
  test('http to your own registry origin is allowed', () => {
    expect(findSpecRejectionReason('http://my.registry/x.tgz', 'http://my.registry')).toBeUndefined()
  })
  test('plain https tarball on a normal host is allowed', () => {
    expect(findSpecRejectionReason('https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz', undefined)).toBeUndefined()
  })
  test('custom label is interpolated into git + http reasons', () => {
    expect(findSpecRejectionReason('https://github.com/foo/bar', undefined, 'pnpm')).toBe(gitReason('pnpm'))
    expect(findSpecRejectionReason('http://evil.example.com/x.tgz', undefined, 'yarn')).toBe(httpReason('yarn'))
  })
})

// --- HWe: spec + moved ------------------------------------------------------
describe('validateNpmSpecUrl (official HWe @207632383)', () => {
  test('direct rejection → moved:false', () => {
    const r = validateNpmSpecUrl('https://github.com/foo/bar', undefined, undefined)
    expect(r).toEqual({ reason: gitReason(), moved: false })
  })
  test('passes with no registry base → undefined', () => {
    expect(
      validateNpmSpecUrl('https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz', undefined, undefined),
    ).toBeUndefined()
  })
  test('passes, and relative-to-registry resolution also passes → undefined', () => {
    expect(
      validateNpmSpecUrl(
        'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
        'https://registry.npmjs.org',
        undefined,
      ),
    ).toBeUndefined()
  })
  test('passes directly but resolves onto a foreign http registry → moved:true', () => {
    const r = validateNpmSpecUrl('https://ok.example.com/pkg/a.tgz', 'http://evil.example.com', undefined)
    expect(r).toEqual({ reason: httpReason(), moved: true })
  })
  test('unparseable registry base → moved:true, not-an-http-link', () => {
    const r = validateNpmSpecUrl('https://ok.example.com/pkg/a.tgz', 'not a base url', undefined)
    expect(r).toEqual({ reason: R_NOT_HTTP, moved: true })
  })
  test('custom label propagates to the moved reason', () => {
    const r = validateNpmSpecUrl('https://ok.example.com/pkg/a.tgz', 'http://evil.example.com', undefined, 'pnpm')
    expect(r).toEqual({ reason: httpReason('pnpm'), moved: true })
  })
})

// --- Z8t: registry-override validation --------------------------------------
describe('validateRegistryOverride (official Z8t @207633872)', () => {
  test('no registry → ok, default-origin probe not called', async () => {
    let called = false
    const r = await validateRegistryOverride('pkg', undefined, async () => {
      called = true
      return undefined
    })
    expect(r).toEqual({ ok: true })
    expect(called).toBe(false)
  })
  test('invalid registry URL → refusal (not a URL)', async () => {
    const r = await validateRegistryOverride('my-plugin', 'ftp://x.example.com', async () => undefined)
    expect(r).toEqual({
      ok: false,
      message:
        '"my-plugin" was not fetched: the npm registry set for it is not a valid address.',
      reason: 'npm registry override is not a URL',
    })
  })
  test('https registry → ok, no origin, probe not called', async () => {
    let called = false
    const r = await validateRegistryOverride('pkg', 'https://registry.example.com', async () => {
      called = true
      return undefined
    })
    expect(r).toEqual({ ok: true })
    expect(called).toBe(false)
  })
  test('http registry equal to default origin → ok carrying that origin', async () => {
    const r = await validateRegistryOverride(
      'pkg',
      'http://my.registry',
      async () => 'http://my.registry',
    )
    expect(r).toEqual({ ok: true, origin: 'http://my.registry' })
  })
  test('http registry differing from default → refusal (http)', async () => {
    const r = await validateRegistryOverride(
      'my-plugin',
      'http://evil.registry',
      async () => 'http://my.registry',
    )
    expect(r).toEqual({
      ok: false,
      message:
        '"my-plugin" was not fetched: its npm registry, http://evil.registry, is unencrypted and isn\'t your default npm registry, so npm could send your saved registry token to it in the clear. It works once the registry uses https (for a marketplace plugin, the marketplace\'s owner sets it) or is your default npm registry (npm config set registry <url>).',
      reason: 'npm registry override is http',
    })
  })
  test('http registry with no default (https default → undefined) → refusal', async () => {
    const r = await validateRegistryOverride('pkg', 'http://evil.registry', async () => undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('npm registry override is http')
    }
  })
})

// --- Mrr / Krr / bRr refusal builders (byte-exact templates) ----------------
describe('buildRegistryRefusalMessage (official Mrr @207635951)', () => {
  test('non-moved variant', () => {
    expect(buildRegistryRefusalMessage('pkg@1.0.0', { reason: gitReason(), moved: false })).toBe(
      `"pkg@1.0.0" was not installed: its registry lists a download address that ${gitReason()}. The package's publisher can fix that.`,
    )
  })
  test('moved variant', () => {
    expect(buildRegistryRefusalMessage('pkg@1.0.0', { reason: httpReason(), moved: true })).toBe(
      `"pkg@1.0.0" was not installed: npm may move this package's download address onto the npm registry the marketplace sets, and there it ${httpReason()}. The marketplace's owner can fix that.`,
    )
  })
})

describe('buildFallbackRefusalMessage (official Krr @207643337)', () => {
  test('non-moved variant', () => {
    expect(buildFallbackRefusalMessage('github:foo/bar', { reason: gitReason(), moved: false })).toBe(
      `"github:foo/bar" was not installed: it ${gitReason()}. An npm plugin source must name a registry package (name or name@version) or link to a tarball file. For a plugin in a git repository, use a "github", "url" or "git-subdir" source.`,
    )
  })
  test('moved variant', () => {
    expect(buildFallbackRefusalMessage('some-spec', { reason: httpReason(), moved: true })).toBe(
      `"some-spec" was not installed: npm may move this link onto the npm registry the marketplace sets, and there it ${httpReason()}. The marketplace's owner can fix that.`,
    )
  })
})

describe('buildInvalidPackageNameMessage (official bRr @207631180)', () => {
  test('byte-exact', () => {
    expect(buildInvalidPackageNameMessage('github:foo/bar')).toBe(
      `"github:foo/bar" was not fetched: it is not a valid npm package name. Valid names look like "my-plugin" or "@scope/my-plugin".`,
    )
  })
})
