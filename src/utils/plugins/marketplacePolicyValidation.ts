import type { MarketplaceSource } from './schemas.js'

/**
 * CC 2.1.277 policy port (report_C C9, SECURITY): per-entry enforceability
 * validation for the managed-settings marketplace policy arrays
 * (`strictKnownMarketplaces` / `blockedMarketplaces`).
 *
 * Before v277 the official binary (and OCC) validated these arrays as a
 * whole: one malformed entry failed the entire policy file's schema check →
 * the file was dropped → the policy silently became UNSET (fail-OPEN). v277
 * validates per entry (official `Ht` enforceability check + `Or` field
 * validator): malformed/unenforceable entries are dropped with a warning and
 * the remaining valid entries keep enforcing.
 *
 * Every function here is a byte-faithful port of the official v277 ELF
 * (settings-module region ~0xb78e500–0xb78f000):
 *   - `checkMarketplaceEntryEnforceability`  = official `Ht`
 *   - `regexCompiles`                        = official `UYt`
 *   - `parseGitHubOwnerWildcard`             = official `zYt` (+`jYt`/`xdr`)
 *   - `gitUrlHasWildcard`                    = official `ir`
 *   - URL/git-URL normalizers                = official `aAt`/`Ixn`/`sr`/`rr`/`R9t`/`$Pe`/`$s`
 *   - host primitives                        = official `HIe`/`Ao`/`Dn`/`BYt`/`i`/`Nbe`
 *
 * This file is intentionally SELF-CONTAINED (leaf): the host/git primitives
 * are duplicated from marketplaceHelpers.ts because that module imports
 * `getSettingsForSource` from settings.ts, and the settings-side sanitizer
 * that consumes this file would otherwise create an import cycle
 * (settings.ts → marketplacePolicySanitizer.ts → this file →
 * marketplaceHelpers.ts → settings.ts). The duplicated helpers are pure
 * string functions kept identical to their marketplaceHelpers.ts twins.
 */

const GITHUB_HOST = 'github.com' // official `Ns`
const GITHUB_SSH_HOST = 'ssh.github.com' // official `xxn`
const INVALID_HOST_CHARS = /[:/\\?#@\s]/
const URL_LIKE_PROTOCOLS = new Set(['http', 'https', 'ws', 'wss', 'ftp'])
/** Official `zd`: protocols whose URL credentials are stripped in `Ixn`. */
const CREDENTIAL_STRIP_PROTOCOLS = new Set([
  'http:',
  'https:',
  'git:',
  'git+http:',
  'git+https:',
])
/** Official `xdr`: characters allowed in a github owner-wildcard owner. */
const OWNER_CHARS_PATTERN = /^[A-Za-z0-9._-]+$/
/** Official scp-like git address parser `R9t`. */
const SCP_LIKE_GIT_URL_PATTERN = /^([^@:/[\]]+)@([^@:/[\]]+):(.*)$/s
/** Official scp-like host matcher inside `ir`. */
const SCP_LIKE_HOST_PATTERN = /^(?:[^@]+@)?([^@:/]+):(.*)$/s
const HOST_NORMALIZE_CACHE_LIMIT = 50

const hostNormalizeCache = new Map<string, string>()

/** Port of official `c`: strip trailing dots. */
function stripTrailingDots(host: string): string {
  let end = host.length
  while (end > 0 && host[end - 1] === '.') end--
  return host.slice(0, end)
}

/** Port of official `tIe`/`HIe`: conservative hostname normalization. */
function normalizeHostname(raw: string): string {
  const host = stripTrailingDots(raw.replace(/[\t\n\r]/g, '').toLowerCase())
  if (host === '' || INVALID_HOST_CHARS.test(host)) return host
  try {
    const parsed = new URL(`https://${host}`)
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    )
      return host
    return stripTrailingDots(parsed.hostname)
  } catch {
    return host
  }
}

/** Port of official `YEt`: normalizeHostname + strip leading `www.`. */
function normalizeHostForComparison(raw: string): string {
  const cached = hostNormalizeCache.get(raw)
  if (cached !== undefined) return cached
  let host = normalizeHostname(raw)
  while (host.startsWith('www.')) host = host.slice(4)
  if (hostNormalizeCache.size >= HOST_NORMALIZE_CACHE_LIMIT) {
    hostNormalizeCache.clear()
  }
  hostNormalizeCache.set(raw, host)
  return host
}

/** Port of official `$Tn`. */
function hostMatches(raw: string, expected: string): boolean {
  return normalizeHostForComparison(raw) === expected
}

/** Port of official `bo`/`Ao`. */
function isGitHubHost(raw: string): boolean {
  return hostMatches(raw, GITHUB_HOST)
}

/** Port of official `Dn`: `Ao(e) || HIe(e) === "ssh.github.com"`. */
function isGitHubOrSshGitHubHost(raw: string): boolean {
  return isGitHubHost(raw) || normalizeHostname(raw) === GITHUB_SSH_HOST
}

/** Port of official `i`. */
function hasSuspiciousHostChars(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `i` — the C0/C1/DEL/astral class IS the check
  return /[%\x00-\x1f\x7f-\u{10FFFF}]/u.test(value)
}

/** Port of official `E_e`/`BYt`: backslash smuggling in a URL authority. */
function hasBackslashSmuggling(raw: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `E_e` — strips leading C0/space before authority parsing
  const url = raw.replace(/^[\x00-\x20]+/, '')
  const schemeEnd = url.indexOf('://')
  if (schemeEnd === -1) return false
  let rest = url.slice(schemeEnd + 3)
  const scheme = url.slice(0, schemeEnd).toLowerCase()
  if (URL_LIKE_PROTOCOLS.has(scheme)) {
    const slashes = rest.match(/^[/\\]+/)?.[0] ?? ''
    if (slashes.includes('\\')) return true
    rest = rest.slice(slashes.length)
  }
  const pathStart = rest.search(/[/?#]/)
  return (pathStart === -1 ? rest : rest.slice(0, pathStart)).includes('\\')
}

/** Port of official `nIe`/`Nbe`: entry guard for suspicious git addresses. */
function isSuspiciousGitUrl(url: string): boolean {
  if (url.includes('://')) {
    if (hasBackslashSmuggling(url)) return true
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        return false
      return hasSuspiciousHostChars(parsed.hostname)
    } catch {
      return true
    }
  }
  const colonIndex = url.indexOf(':')
  const atIndex = url.indexOf('@')
  if (colonIndex >= 0 && atIndex > colonIndex) return true
  const host = url.match(/^(?:[^@]+@)?([^:]+):/)?.[1]
  return host ? hasSuspiciousHostChars(host) : false
}

/** Port of official `$Pe`: `HIe` normalize, github hosts fold to github.com. */
function normalizeGithubAwareHost(raw: string): string {
  const host = normalizeHostname(raw)
  return isGitHubHost(host) ? GITHUB_HOST : host
}

/** Port of official `$s`: `$Pe` then ssh.github.com → github.com. */
function normalizeGithubHostForUrl(raw: string): string {
  const host = normalizeGithubAwareHost(raw)
  return host === GITHUB_SSH_HOST ? GITHUB_HOST : host
}

/** Port of official `sr`: collapse `.`/`..` path segments. */
function normalizePathSegments(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.filter(segment => segment !== '').join('/')
}

/** Port of official `rr`: fixed-point trailing-slash + `.git` suffix strip. */
function stripDotGitSuffix(path: string): string {
  let length = path.length
  for (;;) {
    let end = length
    while (end > 0 && path.charCodeAt(end - 1) === 47) end--
    if (end >= 4 && path.startsWith('.git', end - 4)) end -= 4
    if (end === length)
      return length === path.length ? path : path.slice(0, length)
    length = end
  }
}

/** Port of official `aAt`: comparison-normalize a URL or scp-like address. */
function normalizeUrlForComparison(
  raw: string,
  options?: { stripDotGit?: boolean },
): string {
  if (raw.includes('://')) {
    try {
      const parsed = new URL(raw)
      parsed.hostname = normalizeGithubHostForUrl(parsed.hostname)
      parsed.username = ''
      parsed.password = ''
      parsed.search = ''
      parsed.hash = ''
      try {
        parsed.pathname = decodeURIComponent(parsed.pathname)
      } catch {
        // keep the raw pathname when it contains invalid percent-escapes
      }
      const normalized = normalizePathSegments(parsed.pathname)
      parsed.pathname = options?.stripDotGit
        ? stripDotGitSuffix(normalized)
        : normalized
      return parsed.toString()
    } catch {
      return raw
    }
  }
  const scpLike = raw.match(/^[^@]+@([^:]+)(:.*)$/s)
  return scpLike
    ? `${normalizeGithubHostForUrl(scpLike[1] ?? '')}${scpLike[2]}`
    : raw
}

/** Port of official `R9t`: parse `user@host:path` scp-like git addresses. */
function parseScpLikeGitUrl(
  raw: string,
): { user: string; host: string; path: string } | null {
  const match = SCP_LIKE_GIT_URL_PATTERN.exec(raw)
  return match
    ? { user: match[1] as string, host: match[2] as string, path: match[3] as string }
    : null
}

/** Port of official `Ixn`: normalize a git URL (host fold + credential strip). */
function normalizeGitUrl(raw: string): string {
  if (isSuspiciousGitUrl(raw)) return raw
  if (raw.includes('://')) {
    try {
      const parsed = new URL(raw)
      parsed.hostname = normalizeGithubAwareHost(parsed.hostname)
      if (
        CREDENTIAL_STRIP_PROTOCOLS.has(parsed.protocol) ||
        isGitHubHost(parsed.hostname)
      ) {
        parsed.username = ''
        parsed.password = ''
      }
      return parsed.toString()
    } catch {
      return raw
    }
  }
  const scpLike = parseScpLikeGitUrl(raw)
  if (!scpLike) return raw
  const host = scpLike.host.toLowerCase().replace(/\.+$/, '')
  return isGitHubHost(host)
    ? `${GITHUB_HOST}:${scpLike.path}`
    : `${scpLike.user}@${host}:${scpLike.path}`
}

/**
 * Port of official `ir`: does a git URL contain a wildcard anywhere git could
 * interpret it (normalized URL host/path, or the decoded scp-like path)?
 * Wildcard-bearing git URLs are unenforceable — git treats `*` literally, so
 * the entry can never match what the user actually clones.
 */
function gitUrlHasWildcard(url: string): boolean {
  if (url.includes('://')) {
    if (hasBackslashSmuggling(url)) return false
    let hostname: string
    try {
      hostname = new URL(url).hostname
    } catch {
      return false
    }
    if (!isGitHubOrSshGitHubHost(hostname)) return false
    if (normalizeUrlForComparison(url, { stripDotGit: true }).includes('*'))
      return true
    const normalized = normalizeGitUrl(url)
    try {
      const parsed = new URL(normalized)
      return parsed.hostname.includes('*') || parsed.pathname.includes('*')
    } catch {
      return normalized.includes('*')
    }
  }
  const match = url.match(SCP_LIKE_HOST_PATTERN)
  const host = match?.[1]
  const path = match?.[2]
  if (!host || path === undefined || !isGitHubOrSshGitHubHost(host))
    return false
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // keep the raw path when it contains invalid percent-escapes
  }
  return decoded.includes('*')
}

/** Port of official `UYt`: does the pattern compile as a RegExp? */
function regexCompiles(pattern: string): boolean {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

/** Port of official `jYt`: valid github owner name (no leading `-`, no `.`/`..`). */
function isValidWildcardOwner(owner: string): boolean {
  return (
    OWNER_CHARS_PATTERN.test(owner) &&
    !owner.startsWith('-') &&
    owner !== '.' &&
    owner !== '..'
  )
}

/** Port of official `zYt`: parse `"<owner>/*"`, returning the owner or null. */
function parseGitHubOwnerWildcard(repo: string): string | null {
  if (!repo.endsWith('/*')) return null
  const owner = repo.slice(0, -2)
  return isValidWildcardOwner(owner) ? owner : null
}

/**
 * Port of official v277 `Ht`@0xb7aacac (settings module): returns the official
 * "cannot be enforced" reason for a policy entry, or null when the entry is
 * enforceable. Messages are byte-identical to the binary.
 */
export function checkMarketplaceEntryEnforceability(
  entry: MarketplaceSource,
): string | null {
  const pattern =
    entry.source === 'hostPattern'
      ? entry.hostPattern
      : entry.source === 'pathPattern'
        ? entry.pathPattern
        : null
  if (pattern !== null && !regexCompiles(pattern))
    return `${entry.source}: regex does not compile; the entry cannot be enforced`
  if (
    entry.source === 'github' &&
    entry.repo.includes('*') &&
    parseGitHubOwnerWildcard(entry.repo) === null
  )
    return 'github: an owner wildcard must be exactly "<owner>/*"; the entry cannot be enforced'
  if (entry.source === 'git' && gitUrlHasWildcard(entry.url))
    return 'git: wildcards are only supported in github-form entries, as "<owner>/*"; the entry cannot be enforced'
  if (
    (entry.source === 'github' || entry.source === 'git') &&
    entry.ref !== undefined &&
    entry.ref.includes('*')
  )
    return `${entry.source}: ref contains "*", which git does not allow in ref names; the entry cannot be enforced`
  return null
}
