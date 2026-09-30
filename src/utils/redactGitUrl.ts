/**
 * Git-URL display redactor — faithful port of the official CC 2.1.285 `vp`
 * closure (@195514283-195520600, redaction module).
 *
 * The v285 git-URL validator (`R8` @203141231) embeds the offending address
 * in every user-facing refusal as `${Kt(vp(e),200)}`: `vp` first strips
 * credentials / smuggled-authority shapes (falling back to "[redacted URL]"
 * when the address is ambiguous about where the authority ends), then `Kt`
 * (./textSanitize.ts) sanitizes what is safe to display.
 *
 * Official closure ported here (minified name → local name):
 *   vp → redactGitUrl            en → redactGitUrlInner
 *   te → redactUrlStrict         xe → applyRedactorIfStable
 *   et → decodeAmbiguousPercents A  → stripUrlWhitespace
 *   ot → cutAt                   se → hasCredentialsAfterScheme
 *   ut → isNetworkUrlWithBackslashCredential   ct → hasBackslashBeforeCredential
 *   cn → hasBracketHostAfterPathStart          Oe → isSmuggledDestination
 *   ln → isFileUrlBackslashCredential          dn → looksLikePlainLocalPath
 *   Pe → schemePrefixLength      De → lastCredentialAt
 *   fn → isPortOnlyHostTail      tt → hasUrlMarkers
 *   tn → hasQueryOrFragmentCredentials         on → hasCredentialsBeforeQuery
 *   nn → hasSuspiciousAuthority rn → parsesWithHost
 *   sn → scpLikeHostMismatch     ne → redactOrFallback
 *   ve → hasEncodedColonHostWithAt             oe → containsColonOrEncoded
 *   Ae → isGitSchemeUrlWithCredentials         M  → isScpLike
 *   Re → isNonSshScheme
 * Constants: bk → REDACTED_URL (shared with ./redactUrl.ts), YKr, Ee,
 * ie/an/at/un (scheme regexes).
 */

import { REDACTED_URL } from './redactUrl.js'

/** Official `A`: strip leading C0/space, then embedded tab/newline/CR. */
function stripUrlWhitespace(url: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `A` — the C0+space class IS the check
  return url.replace(/^[\u0000-\u0020]+/, '').replace(/[\t\n\r]/g, '')
}

/** Official `ot`: text before the first occurrence of `delimiter`. */
function cutAt(value: string, delimiter: string): string {
  const index = value.indexOf(delimiter)
  return index === -1 ? value : value.slice(0, index)
}

/**
 * Official `et`: percent-decode `%40`/`%3a` (and `%5c` for non-http-ish
 * schemes) so credential-shaped encodings can't hide from the checks.
 */
function decodeAmbiguousPercents(url: string): string {
  const normalized = stripUrlWhitespace(url)
  if (!/%(?:40|3a|5c)/i.test(normalized)) return url
  const isHttpish = /^(?:https?|wss?|ftp|file):/i.test(normalized)
  return normalized.replace(
    isHttpish ? /%(40|3a)/gi : /%(40|3a|5c)/gi,
    (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)),
  )
}

/**
 * Official `xe`: run `redactor`; if it produced neither the redaction
 * sentinel nor a percent-decode-stable result, fall back to `fallback`.
 */
function applyRedactorIfStable(
  url: string,
  redactor: (value: string) => string | null,
  fallback: string,
): string {
  const redacted = redactor(url)
  const decoded = decodeAmbiguousPercents(url)
  if (redacted === fallback || decoded === url) return redacted as string
  return redacted !== null &&
    decodeAmbiguousPercents(redacted) === (redactor(decoded) as string | null)
    ? redacted
    : fallback
}

/** Official `YKr`: colon, plain or percent-encoded. */
const COLON_OR_ENCODED_RE = /:|%3a/i

/** Official `Ee`: Windows drive-letter path or UNC prefix. */
const WINDOWS_DRIVE_OR_UNC_RE = /^(?:(?:file:\/\/)?[a-z]:(?:\\|\/(?!\/))|\\\\)/i

/** Official `ie`/`an`/`at`/`un` scheme-regex constants. */
const SCHEME_BOUNDARY = '(^|[^a-z0-9+.-]|%[0-9a-f]{2})'
const NET_SCHEMES = 'https?|wss?|ftps?'
const GIT_SSH_SCHEMES = 'ssh\\+git|git\\+ssh|ssh|git'
const DESTINATION_SCHEME_RE = new RegExp(
  `[a-z](?:[a-z0-9+.-]{1,31}:\\/+|:\\/\\/)|(?:https?|ftps?):(?!\\/)|${SCHEME_BOUNDARY}(?:wss?|file):(?!\\/)|${SCHEME_BOUNDARY}(?:${GIT_SSH_SCHEMES}):(?!\\/)(?=[^@/?#\\s]*?(?::|%3a))`,
  'i',
)

/**
 * Official `se`: a `scheme://` (or bare `://`) is present and credentials
 * (`@` / `%40`) follow the last embedded scheme — i.e. the URL really
 * carries a user[:pass] in its authority.
 */
function hasCredentialsAfterScheme(
  url: string,
  { forDestination = false }: { forDestination?: boolean } = {},
): boolean {
  const normalized = stripUrlWhitespace(url).replace(/\\/g, '/')
  const queryStart = normalized.search(/[?#]/)
  const beforeQuery =
    queryStart === -1 ? normalized : normalized.slice(0, queryStart)
  const schemeMatch =
    (forDestination
      ? /^[a-z][a-z0-9+.-]*:\/*/i.exec(beforeQuery)
      : null) ?? /:\/+/.exec(beforeQuery)
  if (!schemeMatch) return false
  const afterScheme = schemeMatch.index + schemeMatch[0].length
  const embedded = (
    forDestination
      ? DESTINATION_SCHEME_RE
      : /[a-z][a-z0-9+.-]{1,31}:\/+/i
  ).exec(beforeQuery.slice(afterScheme))
  const searchFrom =
    afterScheme + (embedded?.index ?? 0) + (embedded?.[0].length ?? 0)
  return (
    embedded !== null &&
    (normalized.includes('@', searchFrom) ||
      /%40/i.test(cutAt(normalized.slice(searchFrom), '/')))
  )
}

/** Official `ct`: a backslash appears before `?`/`#` with an `@` after it. */
function hasBackslashBeforeCredential(url: string): boolean {
  const normalized = stripUrlWhitespace(url)
  const queryStart = normalized.search(/[?#]/)
  const backslashIndex = (
    queryStart === -1 ? normalized : normalized.slice(0, queryStart)
  ).indexOf('\\')
  return backslashIndex !== -1 && normalized.includes('@', backslashIndex)
}

/** Official `ut`: network-shaped URL (not file:, not a Windows path) via ct. */
function isNetworkUrlWithBackslashCredential(url: string): boolean {
  const normalized = stripUrlWhitespace(url)
  if (WINDOWS_DRIVE_OR_UNC_RE.test(normalized) || /^file:/i.test(normalized)) {
    return false
  }
  return hasBackslashBeforeCredential(url)
}

/** Official `cn`: ssh-ish URL with `@[` after the path starts. */
function hasBracketHostAfterPathStart(url: string): boolean {
  const normalized = stripUrlWhitespace(url)
  const schemeMatch = /(?:ssh|git\+ssh|ssh\+git|git):\/\//i.exec(normalized)
  if (!schemeMatch) return false
  const authority = normalized
    .slice(schemeMatch.index + schemeMatch[0].length)
    .replace(/%40/gi, '@')
    .replace(/%5b/gi, '[')
  const pathStart = authority.search(/[/?#]/)
  return pathStart !== -1 && authority.includes('@[', pathStart)
}

/** Official `ln`: file: URL with backslash + colon-shaped credentials. */
function isFileUrlBackslashCredential(url: string): boolean {
  const normalized = stripUrlWhitespace(url)
  const queryStart = normalized.search(/[?#]/)
  const backslashIndex = (
    queryStart === -1 ? normalized : normalized.slice(0, queryStart)
  ).indexOf('\\')
  const lastAt = normalized.lastIndexOf('@')
  return (
    backslashIndex !== -1 &&
    lastAt > backslashIndex &&
    /:|%3a/i.test(normalized.slice(backslashIndex, lastAt))
  )
}

/** Official `Oe`: destination-smuggling shapes (git would connect elsewhere). */
function isSmuggledDestination(url: string, parsed: URL): boolean {
  return (
    hasCredentialsAfterScheme(url, { forDestination: true }) ||
    hasCredentialsAfterScheme(parsed.href, { forDestination: true }) ||
    hasBracketHostAfterPathStart(url) ||
    (parsed.protocol === 'file:' && isFileUrlBackslashCredential(url))
  )
}

/** Official `dn`: looks like a plain local path (Windows shapes allowed). */
function looksLikePlainLocalPath(url: string): boolean {
  return (
    /^[\w .+~@\\/-]*$/.test(url) &&
    !/\\(?:[^A-Za-z0-9@]|$)| $|\.[_~+]*\.|(?:^|\/)[_~+]*\.[_~+]*$/.test(url) &&
    !/(?:^|[^\\])@|@[^\\/ ]*(?:[/ ]|$)/.test(url)
  )
}

/** Official `Pe`: length of a leading `scheme://` prefix (0 when absent). */
function schemePrefixLength(url: string): number {
  const index = url.indexOf('://')
  return index !== -1 && /^[a-z][a-z0-9+.-]*$/i.test(url.slice(0, index))
    ? index + 3
    : 0
}

/** Official `De`: index of the last `@` that can start credentials. */
function lastCredentialAt(value: string): number {
  const atIndex = value.indexOf('@')
  if (atIndex === -1) return -1
  const queryStart = value.search(/[?#]/)
  if (queryStart !== -1 && queryStart < atIndex) {
    if (value.lastIndexOf('/', queryStart) !== -1) return -1
  }
  const slashIndex = value.indexOf('/', atIndex)
  return value.lastIndexOf('@', slashIndex === -1 ? value.length : slashIndex)
}

/** Official `oe`. */
function containsColonOrEncoded(value: string): boolean {
  return COLON_OR_ENCODED_RE.test(value)
}

/** Official `fn`: the tail after `@` is only a `:port` — not credentials. */
function isPortOnlyHostTail(
  value: string,
  atIndex: number,
  hadScheme: boolean,
): boolean {
  const slashIndex = value.indexOf('/')
  if (slashIndex <= 0 || slashIndex > atIndex) return false
  const host = value.slice(0, slashIndex).replace(/^\[[^\]]*\]/, '')
  return !containsColonOrEncoded(
    hadScheme ? host.replace(/:\d+$/, '') : host,
  )
}

/** Official `Re`: scheme is NOT ssh/git+ssh/ssh+git. */
function isNonSshScheme(scheme: string): boolean {
  return !/^(?:ssh|git\+ssh|ssh\+git)$/i.test(scheme)
}

/** Official `M`: scp-like `user@host:path` shape. */
function isScpLike(url: string): boolean {
  const colonIndex = url.indexOf(':')
  const slashIndex = url.indexOf('/')
  return (
    colonIndex > 0 &&
    !url.includes('://') &&
    (slashIndex === -1 || colonIndex < slashIndex)
  )
}

/** Official `tn`: query/fragment markers that imply embedded credentials. */
function hasQueryOrFragmentCredentials(url: string): boolean {
  const normalized = stripUrlWhitespace(url)
  const schemeLength = schemePrefixLength(normalized)
  const hasScheme = schemeLength !== 0
  const hashIndex = normalized.indexOf('#')
  if (
    normalized.includes('?') ||
    (hashIndex !== -1 &&
      (hasScheme || normalized.includes('@', hashIndex)))
  ) {
    return true
  }
  const afterScheme = normalized.slice(schemeLength)
  const credentialIndex = lastCredentialAt(afterScheme)
  if (credentialIndex === -1) return false
  const scheme = normalized.slice(0, schemeLength - 3)
  const authority = /^(?:ftps?|wss?)$/i.test(scheme)
    ? afterScheme.slice(0, credentialIndex).replace(/^[/\\]+/, '')
    : afterScheme.slice(0, credentialIndex)
  return (
    containsColonOrEncoded(authority) ||
    (hasScheme &&
      (/https?$/i.test(scheme) ||
        (!authority.includes('/') && isNonSshScheme(scheme))))
  )
}

/** Official `on`: credentials before `?`/`#` in scheme or scp-like forms. */
function hasCredentialsBeforeQuery(url: string): boolean {
  const normalized = stripUrlWhitespace(url)
  const schemeEnd = normalized.indexOf('://')
  if (schemeEnd !== -1 && /[?#]/.test(normalized)) return true
  const authority = cutAt(
    schemeEnd === -1 ? normalized : normalized.slice(schemeEnd + 3),
    '/',
  )
  const lastAt = authority.lastIndexOf('@')
  return (
    lastAt !== -1 &&
    (containsColonOrEncoded(authority.slice(0, lastAt)) ||
      (schemeEnd !== -1 && isNonSshScheme(normalized.slice(0, schemeEnd))))
  )
}

/** Official `tt`. */
function hasUrlMarkers(url: string): boolean {
  return hasQueryOrFragmentCredentials(url) || hasCredentialsBeforeQuery(url)
}

/** Official `nn`: authority fails the strict host/user shape or has `@[`. */
function hasSuspiciousAuthority(url: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `nn` — the C0+space class IS the check
  const trimmed = url.replace(/^[\u0000-\u0020]+/, '')
  const schemeMatch = /^[a-z+\t\n\r]*:[\t\n\r]*\/[\t\n\r]*\//i.exec(trimmed)
  const isGitScheme =
    schemeMatch !== null &&
    /^(?:ssh|git|git\+ssh|ssh\+git|file):\/\/$/i.test(
      (schemeMatch[0] ?? '').replace(/[\t\n\r]/g, ''),
    )
      ? schemeMatch
      : null
  if (!isGitScheme && !isScpLike(url)) return false
  const hostUserPattern = isGitScheme
    ? /^(?:[\w.~+-]+(?::[^@/?#%\s[\]]*)?@)?(?:\w(?:[\w.-]*\w)?|\[[\da-f]*:[\da-f.]*:[\da-f:.]*\])?(?::[\w~-]*)?(?:\/|$)/i
    : /^(?:[\w.~+-]+@)?(?:\w(?:[\w.-]*\w)?|\[[\da-f]*:[\da-f.]*:[\da-f:.]*\]):/i
  const afterScheme = isGitScheme
    ? trimmed.slice((isGitScheme[0] ?? '').length)
    : url
  const path = isGitScheme
    ? afterScheme.slice(Math.max(afterScheme.indexOf('/'), 0))
    : ''
  return (
    !hostUserPattern.test(afterScheme) ||
    /(?:@|%40)(?:\[|%5b)/i.test(path)
  )
}

/** Official `rn`. */
function parsesWithHost(url: string): boolean {
  try {
    return new URL(url).host !== ''
  } catch {
    return false
  }
}

/** Official `sn`: scp-like host before `:` doesn't match the redacted host. */
function scpLikeHostMismatch(url: string, redacted: string): boolean {
  const normalized = stripUrlWhitespace(url)
  const colonIndex = normalized.indexOf(':')
  const scheme = normalized.slice(0, colonIndex)
  if (colonIndex <= 0 || /[/?#]/.test(scheme) || url.includes('://')) {
    return false
  }
  const lastAt = scheme.lastIndexOf('@')
  const bracketStart = normalized.indexOf('@[')
  const ipv6Start =
    bracketStart !== -1
      ? bracketStart + 1
      : normalized.startsWith('[')
        ? 0
        : -1
  let host = scheme.slice(lastAt + 1)
  if (ipv6Start !== -1) {
    const bracketEnd = normalized.indexOf(']', ipv6Start)
    if (
      ipv6Start !== lastAt + 1 ||
      normalized[bracketEnd + 1] !== ':' ||
      /[/?#@\\]/.test(normalized.slice(ipv6Start + 1, bracketEnd))
    ) {
      return true
    }
    host = normalized.slice(ipv6Start, bracketEnd + 1)
  }
  return (
    redacted !== url &&
    redacted !== REDACTED_URL &&
    !redacted.startsWith(`${host}:`)
  )
}

/** Official `ne`: keep `candidate` unless the shapes disagree — else redact. */
function redactOrFallback(url: string, candidate: string): string {
  const isSmuggleShape = (value: string, redacted: string): boolean => {
    const normalized = stripUrlWhitespace(value)
    return (
      hasSuspiciousAuthority(value) ||
      (/^(?:ssh|git|git\+ssh|ssh\+git|file):\/\//i.test(normalized) &&
        redacted !== value &&
        !redacted
          .toLowerCase()
          .startsWith(
            normalized
              .slice(0, normalized.indexOf('://') + 3)
              .toLowerCase(),
          )) ||
      (isScpLike(value) &&
        (parsesWithHost(value) ||
          /[\t\n\r]/.test(value) ||
          scpLikeHostMismatch(value, redacted)))
    )
  }
  return (candidate !== url && isScpLike(candidate) && !isScpLike(url)) ||
    isSmuggleShape(url, candidate) ||
    isSmuggleShape(candidate, candidate)
    ? REDACTED_URL
    : candidate
}

/** Official `ve`: percent-encoded colon in host plus `@` later. */
function hasEncodedColonHostWithAt(parsed: URL): boolean {
  return (
    !parsed.hostname.startsWith('[') &&
    /%3a/i.test(parsed.hostname) &&
    `${parsed.pathname}${parsed.search}${parsed.hash}`.includes('@')
  )
}

/**
 * Official `Ae`: ssh/git/file scheme URL (not a Windows path) whose authority
 * or query carries `:`-shaped credentials.
 */
function isGitSchemeUrlWithCredentials(url: string): boolean {
  const normalized = stripUrlWhitespace(url)
  const colonIndex = normalized.indexOf(':')
  const scheme = colonIndex === -1 ? '' : normalized.slice(0, colonIndex)
  if (
    !/^[a-z][a-z0-9+.-]*$/i.test(scheme) ||
    !/(?:ssh|git\+ssh|ssh\+git|git|file)$/i.test(scheme) ||
    WINDOWS_DRIVE_OR_UNC_RE.test(normalized)
  ) {
    return false
  }
  const afterScheme = normalized.slice(colonIndex + 1)
  const authority = cutAt(
    afterScheme.slice((/^\/*/.exec(afterScheme)?.[0] ?? '').length),
    '/',
  )
  const queryStart = authority.search(/[?#]/)
  if (!(/%40/i.test(authority) || (queryStart !== -1 && authority.includes('@', queryStart)))) {
    return false
  }
  const decoded = authority.replace(
    /%([0-9a-f]{2})/gi,
    (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)),
  )
  const lastAt = decoded.lastIndexOf('@')
  return lastAt !== -1 && decoded.slice(0, lastAt).includes(':')
}

/**
 * Official `te`: strict URL-credentials redactor. Parses as URL when
 * possible; otherwise applies scp-like/authority heuristics. Returns
 * REDACTED_URL when the address is credential-shaped or ambiguous.
 */
function redactUrlStrict(url: string): string {
  if (!url) return url
  if (
    hasCredentialsAfterScheme(url) ||
    isNetworkUrlWithBackslashCredential(url) ||
    isGitSchemeUrlWithCredentials(url)
  ) {
    return REDACTED_URL
  }
  try {
    const parsed = new URL(url)
    if (!parsed.host) throw new TypeError('opaque')
    if (
      ((parsed.username !== '' || parsed.password !== '') &&
        `${parsed.pathname}${parsed.search}${parsed.hash}`.includes('@')) ||
      hasEncodedColonHostWithAt(parsed) ||
      isSmuggledDestination(url, parsed)
    ) {
      return REDACTED_URL
    }
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    const normalized = stripUrlWhitespace(url)
    const prefixLength = schemePrefixLength(normalized)
    const afterScheme = normalized.slice(prefixLength)
    const credentialIndex = lastCredentialAt(afterScheme)
    const queryStart = afterScheme.search(/[?#]/)
    if (credentialIndex !== -1 && queryStart !== -1 && queryStart < credentialIndex) {
      return REDACTED_URL
    }
    const tail =
      credentialIndex === -1
        ? afterScheme
        : afterScheme.slice(credentialIndex + 1)
    const tailQuery = tail.search(/[?#]/)
    if (
      tailQuery !== -1 &&
      tail.includes('@', tailQuery) &&
      !(
        credentialIndex !== -1 ||
        isPortOnlyHostTail(tail, tailQuery, prefixLength !== 0)
      )
    ) {
      return REDACTED_URL
    }
    const hostPart = cutAt(
      cutAt(
        credentialIndex === -1
          ? normalized
          : normalized.slice(prefixLength + credentialIndex + 1),
        '?',
      ),
      '#',
    )
    const lastAt = hostPart.lastIndexOf('@')
    const host = lastAt === -1 ? hostPart : hostPart.slice(lastAt + 1)
    return isScpLike(host) &&
      !isScpLike(normalized) &&
      !/^:\d+\/?$/.test(
        host.startsWith('[')
          ? host.slice(host.indexOf(']') + 1)
          : host.slice(host.indexOf(':')),
      )
      ? REDACTED_URL
      : host
  }
}

/** Official `en`: git-URL-aware redactor used by `vp`. */
function redactGitUrlInner(url: string): string {
  if (hasCredentialsAfterScheme(url) || isGitSchemeUrlWithCredentials(url)) {
    return REDACTED_URL
  }
  if (WINDOWS_DRIVE_OR_UNC_RE.test(url)) {
    const queryIndex = url.indexOf('?', url.startsWith('\\\\?\\') ? 4 : 0)
    return queryIndex === -1 ? url : url.slice(0, queryIndex)
  }
  if (isNetworkUrlWithBackslashCredential(url) && !looksLikePlainLocalPath(url)) {
    return REDACTED_URL
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return redactOrFallback(
      url,
      hasUrlMarkers(url) ? redactUrlStrict(url) : url,
    )
  }
  if (!parsed.host) {
    return redactOrFallback(
      url,
      parsed.search || parsed.hash || hasUrlMarkers(url)
        ? redactUrlStrict(url)
        : url,
    )
  }
  if (isSmuggledDestination(url, parsed)) return REDACTED_URL
  const isSshUser =
    parsed.username !== '' && isNonSshScheme(parsed.protocol.slice(0, -1))
  const isPrefixedUser =
    parsed.username !== '' &&
    !/^[^:]*:\//.test(stripUrlWhitespace(url))
  return redactOrFallback(
    url,
    isSshUser ||
      isPrefixedUser ||
      parsed.password ||
      containsColonOrEncoded(parsed.username) ||
      hasEncodedColonHostWithAt(parsed) ||
      parsed.search ||
      parsed.hash
      ? redactUrlStrict(url)
      : url,
  )
}

/**
 * Official `vp` (@195516130 region): `xe(e,en,bk)` — the redactor used in
 * every v285 git-URL refusal message and in clone logs. Credentials and
 * smuggled-authority shapes collapse to `[redacted URL]`.
 */
export function redactGitUrl(url: string): string {
  return applyRedactorIfStable(url, redactGitUrlInner, REDACTED_URL)
}
