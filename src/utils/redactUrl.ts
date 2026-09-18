/**
 * URL credential scrubbers for user-facing plugin/marketplace strings.
 *
 * Port of the official 2.1.275 security fix ("Password/token shown in
 * plugin/marketplace messages, logs, `claude plugin marketplace list`").
 * Official v276 binary references (byte-exact sources):
 * - display scrubber `j6e` @200182994 (routes every plugin/marketplace source
 *   URL through userinfo stripping + query-param allowlisting)
 * - pre-existing redactor family @190591154+: `kA="[redacted URL]"` @190591150,
 *   text scrubber `d8t` @190591969 (`e.replace(/:\/\/[^/?#]*@/g,"://")`),
 *   safe query-param allowlist `JCs` @200182917
 *   (`["ref","branch","tag","path","file","file_path","version","format"]`)
 *
 * Rule: a raw marketplace/plugin URL may be used for the actual fetch/clone,
 * but NEVER interpolated into a rendered or logged string. Every user-facing
 * interpolation must go through `redactUrlCredentials` (URL values) or
 * `redactCredentialsInText` (free-form messages that may embed URLs).
 */

/** Byte-exact match of the official `kA` constant (v276 @190591150). */
export const REDACTED_URL = '[redacted URL]'

/**
 * Query parameters that may safely keep their values in displayed URLs.
 * Byte-exact match of the official `JCs` allowlist (v276 @200182917).
 */
const SAFE_QUERY_PARAMS = new Set([
  'ref',
  'branch',
  'tag',
  'path',
  'file',
  'file_path',
  'version',
  'format',
])

/** Official `j6e` safe-value pattern (v276 @200182994 region). */
const SAFE_QUERY_VALUE = /^(?:[\w.~/-]|%2f)*$/i

/**
 * Strip credentials from a plugin/marketplace source URL for display.
 *
 * - `https://user:token@host/path` → `https://host/path`
 * - URLs without userinfo are returned unchanged (byte-identical input).
 * - Unparseable input that could carry credentials (multiple `@`, or a `:`
 *   before the first `@`) fails closed to `"[redacted URL]"` (official `kA`);
 *   scp-like git shorthand (`git@github.com:owner/repo.git` — single `@`, no
 *   `:` before it) passes through unchanged, matching the official `j6e`
 *   parse-failure fallback.
 * - Query params are allowlisted like official `j6e`: only ref/branch/tag/
 *   path/file/file_path/version/format keep their values (signed-URL and
 *   token params become `***`); the fragment is dropped.
 */
export function redactUrlCredentials(url: string): string {
  let parsed: URL | undefined
  try {
    parsed = new URL(url)
  } catch {
    parsed = undefined
  }

  if (!parsed || !parsed.host) {
    // Official j6e fallback for unparseable/opaque input: only fail closed
    // when the string could actually carry userinfo credentials.
    const firstAt = url.indexOf('@')
    if (firstAt === -1) return url
    const looksLikeCredentials =
      url.indexOf('@', firstAt + 1) !== -1 || url.slice(0, firstAt).includes(':')
    return looksLikeCredentials ? REDACTED_URL : url
  }

  // Nothing sensitive: return the input byte-identically (no re-serialization).
  if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
    return url
  }

  // Official M(): credentials plus another '@' in path/query/fragment is
  // ambiguous to re-serialize — fail closed.
  if (
    (parsed.username !== '' || parsed.password !== '') &&
    `${parsed.pathname}${parsed.search}${parsed.hash}`.includes('@')
  ) {
    return REDACTED_URL
  }

  const search = parsed.search
  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  // Official M() strips a URL-added trailing slash; j6e's `g` re-adds it when
  // the original path explicitly ended with '/'.
  let base = parsed.toString().replace(/\/$/, '')
  if (/\/$/.test(url.split(/[?#]/)[0] ?? '') && !base.endsWith('/')) {
    base += '/'
  }

  if (search === '') return base

  const kept = search
    .slice(1)
    .split('&')
    .map(pair => {
      const eq = pair.indexOf('=')
      if (eq === -1) return pair === '' ? pair : '***'
      const key = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      let decoded: string
      try {
        decoded = decodeURIComponent(key.replace(/\+/g, ' '))
      } catch {
        decoded = ''
      }
      return SAFE_QUERY_PARAMS.has(decoded.toLowerCase()) &&
        SAFE_QUERY_VALUE.test(value)
        ? pair
        : '***'
    })
    .join('&')
  return `${base}?${kept}`
}

/**
 * Strip `://user:pass@` userinfo from every URL embedded in a free-form
 * string (error reasons, log lines). Byte-exact port of official `d8t`
 * (v276 @190591969). Non-URL text (paths, emails without a scheme) is
 * untouched.
 */
export function redactCredentialsInText(text: string): string {
  return text.replace(/:\/\/[^/?#]*@/g, '://')
}
