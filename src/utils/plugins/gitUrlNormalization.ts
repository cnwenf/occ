/**
 * Git URL / hostname normalization — a dependency-free LEAF module.
 *
 * Extracted from marketplaceHelpers.ts during the OCC-134 security follow-ups:
 * `schemas.ts` (imported very early and very widely) needs the official-org
 * predicates, and importing them from marketplaceHelpers.ts created a
 * schemas ↔ marketplaceHelpers cycle that dragged the heavy settings/plugin
 * graph into early module evaluation — surfacing as TDZ crashes
 * ("Cannot access 'X' before initialization") in unrelated suites
 * (WebFetchTool/cacheTtl, REPLTool/constants, MonitorTool, ...).
 *
 * This module MUST stay import-free so it can sit at the bottom of the graph.
 *
 * Faithful port of official Claude Code 2.1.276/2.1.280/2.1.285:
 *   - host-normalization module (chunk-7bfrtxgd.js @190787400-190789400:
 *     tIe/YEt/$Tn/bo/i/E_e/nIe)
 *   - git-address parser yAn@191030323 with A7e@191027175, yd/Sd/As@~191031088
 *   - official-org predicates Ctn@191095040 / Sd@191098726 (v280)
 *   - v285 (@195744448): `SY` now strips embedded \t\n\r before the authority
 *     scan, `IN` (bracket-host ambiguity check) is new, and `wY` starts with
 *     `if(IN(t))return!0;`
 */

/**
 * The official GitHub organization for Anthropic marketplaces (official `mt`).
 * Reserved names must come from this org.
 */
export const OFFICIAL_GITHUB_ORG = 'anthropics'

const GITHUB_HOST = 'github.com'
const GITHUB_SSH_HOST = 'ssh.github.com'
const INVALID_HOST_CHARS = /[:/\\?#@\s]/
const URL_LIKE_PROTOCOLS = new Set(['http', 'https', 'ws', 'wss', 'ftp'])
const GITHUB_GIT_PROTOCOLS = new Set([
  'https:',
  'http:',
  'git:',
  'git+https:',
  'git+http:',
  'git+ssh:',
  'ssh:',
])
const SSH_LIKE_PROTOCOLS = new Set(['ssh:', 'git+ssh:'])
const OWNER_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/
const HOST_NORMALIZE_CACHE_LIMIT = 50

const hostNormalizeCache = new Map<string, string>()

/** Port of official `c`: strip trailing dots. */
function stripTrailingDots(host: string): string {
  let end = host.length
  while (end > 0 && host[end - 1] === '.') end--
  return host.slice(0, end)
}

/**
 * Port of official `tIe`: conservative hostname normalization.
 * Strips \t\n\r, lowercases, strips trailing dots, rejects hosts containing
 * URL-structural characters, and validates via an https:// URL round-trip.
 */
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

/**
 * Port of official `YEt`: normalizeHostname + strip leading `www.`,
 * memoized with a capacity of 50 (official `ER` helper).
 */
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

/** Port of official `bo`. */
function isGitHubHost(raw: string): boolean {
  return hostMatches(raw, GITHUB_HOST)
}

/** Port of official `As`: github.com or ssh.github.com. */
function isGitHubOrSshGitHubHost(raw: string): boolean {
  return isGitHubHost(raw) || hostMatches(raw, GITHUB_SSH_HOST)
}

/**
 * Port of official `i`: characters that must never appear in a hostname
 * (percent-encoding, C0/C1 control chars, DEL, astral plane).
 */
function hasSuspiciousHostChars(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `i` — the C0/C1/DEL/astral class IS the check
  return /[%\x00-\x1f\x7f-\u{10FFFF}]/u.test(value)
}

/**
 * Port of official `E_e`/`SY` (v285 @195745251): detect backslash smuggling
 * in a URL's authority (e.g. `https://github.com\@evil.com/...`), which
 * browsers and git can interpret differently. v285 additionally strips
 * embedded \t\n\r before scanning (git itself ignores them in URLs).
 */
export function hasBackslashSmuggling(raw: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `SY` — strips leading C0/space and embedded \t\n\r before authority parsing
  const url = raw.replace(/^[\x00-\x20]+/, '').replace(/[\t\n\r]/g, '')
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

/** Official `aIe` (v285 @195744865 region): URL parse returning null on failure. */
function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * Official `xXn` (v285 @195745086 region): percent-decode every `%XX`
 * except `%00` (a NUL would truncate the string differently per git version,
 * so the literal `%00` spelling is kept for the caller's checks).
 */
function decodeNonNulPercents(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (match, hex: string) => {
    const code = Number.parseInt(hex, 16)
    return code === 0 ? match : String.fromCharCode(code)
  })
}

/**
 * Port of official `IN` (v285 @195744448, NEW — 0 hits in v284): true when a
 * git address contains a square bracket that git could read as marking the
 * host (or the start of a local path) rather than as literal text.
 *
 * A bracket is only legitimate as an IPv6 literal host: `git@[2001:db8::1]:…`
 * (scp-like) or `ssh://[2001:db8::1]/…` / `https://[::1]:443/…` (scheme
 * form, verified by an ssh:// URL round-trip). Any other `[`/`]` — including
 * percent-encoded `%5B`/`%5D` — is refused, because git can read it as
 * redirecting the connection or the local path somewhere else.
 */
export function hasAmbiguousBracketHost(raw: string): boolean {
  let start = 0
  while (start < raw.length && raw.charCodeAt(start) <= 32) start++
  const trimmed = raw.slice(start)
  const schemeMatch = /^([A-Za-z0-9][A-Za-z0-9+.-]*):\/\//.exec(trimmed)
  const scheme = schemeMatch?.[1]?.toLowerCase()
  const afterScheme = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed
  const colonIndex = afterScheme.indexOf(':')
  const slashIndex = afterScheme.indexOf('/')
  // Official: `!(s!==undefined ? s!=="file" : scpLike)` — i.e. this branch
  // runs for a file: URL, or a scheme-less string that is NOT scp-like
  // (`host:path` with the colon before any slash, no Windows drive letter).
  const bracketsCannotMarkHost =
    scheme !== undefined
      ? scheme === 'file'
      : !(
          colonIndex !== -1 &&
          (slashIndex === -1 || colonIndex < slashIndex) &&
          !/^[A-Za-z]:/.test(afterScheme)
        )
  if (bracketsCannotMarkHost) {
    // file: URL or bare local path — a bracket here still confuses git's
    // local-path reading, so only `@[` / leading `[` shapes are refused.
    const candidate = schemeMatch ? decodeNonNulPercents(afterScheme) : afterScheme
    return candidate.includes('@[') || candidate.startsWith('[')
  }
  const decoded = decodeNonNulPercents(afterScheme)
  const ipv6Match = schemeMatch
    ? /^(?:[^@/?#\\[\]]+@)?(\[[0-9A-Fa-f:.]+\])(?::\d*)?(?=\/|$)/.exec(decoded)
    : /^[^@:/[\]]+@(\[[0-9A-Fa-f:.]+\])(?=:)/.exec(decoded)
  const isValidIpv6Host =
    ipv6Match !== null &&
    !!tryParseUrl(`ssh://${ipv6Match[1]}/`)?.hostname
  return /[[\]]/.test(decoded.slice(isValidIpv6Host ? (ipv6Match?.[0].length ?? 0) : 0))
}

/** Port of official `nIe`/`wY` (v285 @195746483): entry guard for suspicious git addresses. */
function isSuspiciousGitUrl(url: string): boolean {
  if (hasAmbiguousBracketHost(url)) return true
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

/**
 * Extract GitHub owner/repo from any recognized git address form.
 * Port of official Claude Code 2.1.276 `yAn`@191030323.
 * Returns null if the address is not a GitHub repository address.
 *
 * Handles (host must normalize to github.com or ssh.github.com):
 * - scp-like: git@github.com:owner/repo.git
 * - ssh://git@github.com/owner/repo.git and ssh://git@ssh.github.com/owner/repo.git
 * - git+ssh://github.com/owner/repo.git
 * - git://github.com/owner/repo.git
 * - https://github.com/owner/repo.git and http://github.com/owner/repo
 *
 * Rejects `..`/`.` path segments, addresses with suspicious hosts
 * (control chars, percent-encoding, backslash smuggling), non-allowlisted
 * protocols, and non-GitHub hosts. Returns lowercased `owner/repo`.
 */
export function extractGitHubRepoFromGitUrl(url: string): string | null {
  if (isSuspiciousGitUrl(url)) return null
  let path = url
  const schemeEnd = url.indexOf('://')
  if (schemeEnd !== -1) {
    let parsed: URL | null
    try {
      parsed = new URL(url)
    } catch {
      parsed = null
    }
    const pathStart =
      url.slice(schemeEnd + 3).search(/[/?#]/) + schemeEnd + 3
    if (
      parsed === null ||
      !GITHUB_GIT_PROTOCOLS.has(parsed.protocol) ||
      !(SSH_LIKE_PROTOCOLS.has(parsed.protocol)
        ? isGitHubOrSshGitHubHost(parsed.hostname)
        : isGitHubHost(parsed.hostname)) ||
      url[pathStart] !== '/'
    )
      return null
    path = url.slice(pathStart + 1).split(/[?#]/)[0] ?? ''
  } else if (url.includes(':')) {
    const colonIndex = url.indexOf(':')
    if (
      url.slice(0, colonIndex).includes('/') ||
      !isGitHubOrSshGitHubHost(url.slice(url.indexOf('@') + 1, colonIndex))
    )
      return null
    path = url.slice(colonIndex + 1).replace(/^\//, '')
  }
  const repo = path.replace(/\/$/, '').replace(/\.git$/i, '')
  if (!OWNER_REPO_PATTERN.test(repo) || /\/\.\.?$/.test(repo)) return null
  return repo.toLowerCase()
}

/**
 * Port of official v280 `Ctn`@191095040:
 * `function Ctn(e){return UNn(e)?.startsWith(`${mt}/`)===!0}` (mt="anthropics").
 *
 * True only when the git address normalizes — via full host parsing in
 * extractGitHubRepoFromGitUrl (official `UNn`) — to a github.com (or
 * ssh.github.com) repository under the official Anthropic org. Substring
 * smuggling like `https://evil.example/github.com/anthropics/x.git` or
 * `evil.example/github.com:anthropics/x.git` is rejected: URL forms must
 * parse with an exact GitHub hostname and allowlisted protocol, and the
 * scp-like form forbids `/` in the segment before the first `:`.
 */
export function isOfficialAnthropicsGitAddress(address: string): boolean {
  return (
    extractGitHubRepoFromGitUrl(address)?.startsWith(
      `${OFFICIAL_GITHUB_ORG}/`,
    ) === true
  )
}

/**
 * Port of official v280 `Sd`@191098726:
 * `function Sd(e){let n=e.trim();return n.includes(":")&&Ctn(n)}`.
 * Git-URL variant of the official-org check used by `EVe`
 * (validateOfficialNameSource) for `source: 'git'` entries.
 */
export function isOfficialAnthropicsGitUrl(url: string): boolean {
  const trimmed = url.trim()
  return trimmed.includes(':') && isOfficialAnthropicsGitAddress(trimmed)
}
