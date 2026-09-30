/**
 * Strict git-URL validator — faithful port of the official CC 2.1.285 `R8`
 * (@203141231) and its wrappers `Sv`/`i0n`, plus the file:// path-shape
 * helpers its `file:` branch calls (`cC`/`Tn`/`Mf`/`coe` chain,
 * @195331537-195345900).
 *
 * v284→v285 delta (byte evidence): the v284 validator `z6` (@205444971)
 * lacked the `%00` check, the square-bracket check (`IN`), the scp-like
 * `"://"` rejection, the http/https backslash-authority check (`SY`), the
 * "(it could not be read as a URL)" parse-failure suffix, and the
 * drive-letter sentence on the file:// refusal; v285 added all of them and
 * renamed the "Supported protocols" text to the `T8` sentence below.
 *
 * Refusal messages carry a telemetry-safe reason via OCC's
 * TelemetrySafeError (official: `new I(message, reason)` — the official
 * `I` class stores the second arg as `telemetryMessage`).
 *
 * The URL echoed back to the user is always `${Kt(vp(e),200)}` — the
 * redactGitUrl (official `vp`) + sanitizeDetailText (official `Kt`)
 * pipeline, so credentials / ANSI / control characters in a hostile address
 * can never reach the terminal verbatim.
 */

import { win32 } from 'path'
import {
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS as TelemetrySafeError,
  toError,
} from '../errors.js'
import {
  isAutomountPrefixPath,
  isFoldedBareNet,
  isFoldedNetworkFirstSegment,
  isKernelResolvedPathPrefix,
} from '../macosKernelPaths.js'
import { isNtObjectNamespacePath } from '../ntNamespacePaths.js'
import { REDACTED_URL } from '../redactUrl.js'
import { redactGitUrl } from '../redactGitUrl.js'
import { sanitizeDetailText } from '../textSanitize.js'
import {
  hasAmbiguousBracketHost,
  hasBackslashSmuggling,
} from './gitUrlNormalization.js'

/** Official `T8` (@203140800 region) — supported-forms sentence, byte-exact. */
const SUPPORTED_GIT_URLS =
  "https, http, ssh (also written git+ssh or ssh+git), user@host:path, or a local file:// address with no host. git:// isn't supported because it isn't encrypted."

/** Official `D_n`: scp-like `user@host:` (host may be a bracketed IPv6). */
const SCP_LIKE_RE =
  /^(?!-)[A-Za-z0-9._-]+@(?:(?!-)[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\]):(?!\/\/)/

/** Official `N_n`: a bare hostname or bracketed IPv6 literal. */
const SSH_HOST_RE =
  /^(?:(?!-)[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])$/

/** Official `F_n`: a plain ssh user name. */
const SSH_USER_RE = /^(?!-)[A-Za-z0-9._-]+$/

/** Official `YKr`: colon, plain or percent-encoded. */
const COLON_OR_ENCODED_RE = /:|%3a/i

/** Protocols the official validator accepts (order byte-exact). */
const ALLOWED_PROTOCOLS = [
  'https:',
  'http:',
  'ssh:',
  'file:',
  'git+ssh:',
  'ssh+git:',
]

const SSH_PROTOCOLS = ['ssh:', 'git+ssh:', 'ssh+git:']

// ---------------------------------------------------------------------------
// file:// branch helpers — official @195331537-195345900 chunk.
// ---------------------------------------------------------------------------

/** Official `jt`: `\??\` (or `/??/`) NT-device prefix. */
const DEVICE_NAMESPACE_PREFIX_RE = /^[\\/]\?\?[\\/]/

/** Official `ia`: `.`/`..` segments with optional trailing dots/spaces. */
const DOT_SEGMENT_LOOSE_RE = /(^|[\\/])\.{1,2}[. ]*([\\/]|$)/

/** Official `mS`: DOS reserved device names (incl. superscript-digit COM/LPT). */
const DOS_RESERVED_NAME_RE =
  /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

/** Official `SSn` (linux mode, as compiled into the linux binary via `yM`). */
function hasDotSegmentPath(path: string): boolean {
  return /(^|\/)\.{1,2}(\/|$)/.test(path)
}

/** Official `Jt`: `Q.win32?Q.win32.normalize(t):t` — Q.win32 is always truthy, so this always normalizes with win32 semantics (byte-faithful to the linux binary). */
function win32Normalize(path: string): string {
  return win32.normalize(path)
}

/** Official `VN`: `\??\` device prefix, incl. normalization-revealed. */
function isDeviceNamespacePath(path: string): boolean {
  return (
    DEVICE_NAMESPACE_PREFIX_RE.test(path) ||
    (path.includes('??') && DEVICE_NAMESPACE_PREFIX_RE.test(win32Normalize(path)))
  )
}

/** Official `Rn` (via `mG`): UNC prefix (`//` or `\\`) or device namespace. */
function isUncOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path) || isDeviceNamespacePath(path)
}

/** Official `Vt`: dot/space-suffixed segments or DOS reserved names. */
function hasDevicePathTail(path: string): boolean {
  return (
    DOT_SEGMENT_LOOSE_RE.test(path) ||
    /[. :](?=[\\/]|$)/.test(path) ||
    path
      .split(/[\\/]/)
      .some(
        segment =>
          isDosReservedName(segment) ||
          isDosReservedName(segment.slice(0, Math.max(0, segment.indexOf(':')))),
      )
  )
}

/** Official `mS`. */
function isDosReservedName(segment: string): boolean {
  const dotIndex = segment.indexOf('.')
  const base = (dotIndex === -1 ? segment : segment.slice(0, dotIndex)).replace(
    / +$/,
    '',
  )
  return DOS_RESERVED_NAME_RE.test(base)
}

/**
 * Official `coe`: strip a `\\?\`/`\??\` prefix when it precedes a drive
 * letter — unless the remainder mixes separators or has device-path tails.
 */
function stripDriveLetterDevicePrefix(path: string): string {
  const match = /^(?:\\\\[?.]\\|\\\?\?\\)(?=[A-Za-z]:[\\/])/.exec(path)
  if (!match) return path
  const rest = path.slice(match[0].length)
  const afterDrive = rest.slice(2)
  return match[0].includes('\\') && afterDrive.includes('/') ||
    hasDevicePathTail(afterDrive)
    ? path
    : rest
}

/** Official `Tn`: `mG(t)||Vi(t)` (mG ≡ Rn; Vi ≡ isAutomountPrefixPath). */
function isUncDeviceOrAutomountPath(path: string): boolean {
  return isUncOrDevicePath(path) || isAutomountPrefixPath(path)
}

/** Official `Mf`: `Vi(t)||v_(t)||GN(t)||Q_(t)`. */
function isNetworkShapedPath(path: string): boolean {
  return (
    isAutomountPrefixPath(path) ||
    isFoldedBareNet(path) ||
    isFoldedNetworkFirstSegment(path) ||
    isKernelResolvedPathPrefix(path)
  )
}

/** Official `cC`: `let e=coe(t);return Tn(e)||Mf(e)||O7n(e)`. */
function isRemoteOrDeviceShapedPath(path: string): boolean {
  const stripped = stripDriveLetterDevicePrefix(path)
  return (
    isUncDeviceOrAutomountPath(stripped) ||
    isNetworkShapedPath(stripped) ||
    isNtObjectNamespacePath(stripped)
  )
}

/** Official `$_n`: decoded path of a file:// URL (fail-closed sentinel). */
function decodeFileUrlPath(url: string): string {
  try {
    return decodeURIComponent(url.replace(/^file:\/\//i, ''))
  } catch {
    return '/../malformed-percent-encoding'
  }
}

/** Official `B_n`: decoded URL pathname (fail-closed sentinel). */
function decodeUrlPathname(parsed: URL): string {
  try {
    return decodeURIComponent(parsed.pathname)
  } catch {
    return '//malformed-percent-encoding/'
  }
}

/** `Kt(vp(e),200)` — the official's safe-display form of a rejected URL. */
function displayUrl(url: string): string {
  return sanitizeDetailText(redactGitUrl(url), 200)
}

/**
 * Official `R8` (@203141231): validate a git URL, returning it unchanged on
 * success and throwing a TelemetrySafeError with the official message +
 * telemetry reason on every refusal. Check order is byte-faithful:
 * control chars → %00 → brackets (IN) → scp-like containing "://" → URL
 * parse → protocol allowlist → backslash authority (http/https) → ssh
 * host/user shape → scheme:// spelling → file:// local-path shape.
 */
export function assertValidGitUrl(url: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official R8's control-character gate — the C0/DEL class IS the check
  if (/[\u0000-\u001f\u007f]/.test(url)) {
    throw new TelemetrySafeError(
      `Invalid git URL: ${displayUrl(url)} — control characters are not allowed`,
      'git URL contains control characters',
    )
  }
  if (url.includes('%00')) {
    throw new TelemetrySafeError(
      `Invalid git URL: ${displayUrl(url)} — "%00" in a git address means different things to different versions of git, so it is not allowed. Remove it.`,
      'git URL contains %00',
    )
  }
  if (hasAmbiguousBracketHost(url)) {
    throw new TelemetrySafeError(
      `Invalid git URL: ${displayUrl(url)} — git can read a square bracket (also written %5B or %5D) as marking a server name or where a local path starts, so it could connect to a different server or open a different folder than this address names. In a server address, brackets may only surround an IPv6 address, as in git@[2001:db8::1]:repo.git. Remove them, or rename the folder whose name has them.`,
      'git URL has a square bracket that git could read as the host',
    )
  }
  if (SCP_LIKE_RE.test(url)) {
    if (!url.includes('://')) return url
    throw new TelemetrySafeError(
      `Invalid git URL: an address written as user@host:path can't contain "://", because git then reads the text before "://" as a protocol name, as in https://. Remove the "://".`,
      'scp-like git URL contains ://',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new TelemetrySafeError(
      `Invalid git URL: ${displayUrl(url)} (it could not be read as a URL). Supported: ${SUPPORTED_GIT_URLS}`,
      'Invalid git URL',
    )
  }
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    const redacted = redactGitUrl(url)
    const schemePrefix = url.slice(0, url.indexOf(':') + 1).toLowerCase()
    const message =
      redacted === url
        ? `Invalid git URL protocol: ${sanitizeDetailText(parsed.protocol, 40)}. Supported: ${SUPPORTED_GIT_URLS}`
        : schemePrefix !== '' &&
            redacted.toLowerCase().startsWith(schemePrefix)
          ? `Invalid git URL: ${sanitizeDetailText(redacted, 200)}. Supported: ${SUPPORTED_GIT_URLS}`
          : `Invalid git URL. Supported: ${SUPPORTED_GIT_URLS}`
    throw new TelemetrySafeError(message, 'Invalid git URL protocol')
  }
  if (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
    hasBackslashSmuggling(url)
  ) {
    throw new TelemetrySafeError(
      `Invalid git URL: ${displayUrl(url)} — a backslash before the first "/" can make git connect to a different server than this address names. Remove it, or write it as %5C if it is part of a user name.`,
      'git URL has a backslash in its authority',
    )
  }
  if (SSH_PROTOCOLS.includes(parsed.protocol)) {
    const authority =
      /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(url)?.[1] ?? ''
    const lastAt = authority.lastIndexOf('@')
    const user = lastAt === -1 ? undefined : authority.slice(0, lastAt)
    const hostPart = lastAt === -1 ? authority : authority.slice(lastAt + 1)
    const host =
      /^(.*?)(?::([0-9]{1,5}))?$/.exec(hostPart)?.[1] ?? hostPart
    if (
      /[?#]/.test(url) ||
      !SSH_HOST_RE.test(host) ||
      (user !== undefined && !SSH_USER_RE.test(user))
    ) {
      throw new TelemetrySafeError(
        `Invalid ssh git URL: the host must be a hostname or bracketed IPv6 literal (optionally :port), the user a plain name, and the URL may not carry ? or # (${sanitizeDetailText(buildSshRefusalDisplay(url), 200)})`,
        'ssh git URL host or user has disallowed characters',
      )
    }
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    throw new TelemetrySafeError(
      `Invalid git URL: ${displayUrl(url)} — a scheme URL must be spelled scheme://…`,
      'git URL scheme without //',
    )
  }
  if (
    parsed.protocol === 'file:' &&
    (hasDotSegmentPath(decodeFileUrlPath(url)) ||
      parsed.host !== '' ||
      /^file:\/\/[^/\\]/i.test(url) ||
      /^file:[\\/]*[\\]/i.test(url) ||
      isRemoteOrDeviceShapedPath(decodeUrlPathname(parsed)))
  ) {
    throw new TelemetrySafeError(
      `Refusing git URL ${displayUrl(url)}: a file: URL must name a local path (no host, no network-shaped path).${
        /^file:\/\/[a-z]:/i.test(url)
          ? ' A drive letter such as C: counts as a local path only on Windows.'
          : ''
      }`,
      'file git URL names a host or network path',
    )
  }
  return url
}

/**
 * The official ssh-refusal display computation (inlined in `R8`): mask a
 * `user:pass` in the authority as `user:***`, redact query/fragment tails,
 * and fall back to `[redacted URL]` whenever the authority shape is
 * ambiguous (`%40` present, `vp` already bailed, or the `@` placement does
 * not match the parsed scheme authority).
 */
function buildSshRefusalDisplay(url: string): string {
  const match =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official R8's authority re-parse — the C0+space class IS the check
    /^[\u0000-\u0020]*[a-z][a-z0-9+.-]*:(?:\/\/)?([^/?#]*)/i.exec(url)
  const authority = match?.[1] ?? ''
  const authorityOffset = (match?.[0].length ?? 0) - authority.length
  const userPart = authority.slice(0, Math.max(0, authority.lastIndexOf('@')))
  const colonIndex = userPart.search(COLON_OR_ENCODED_RE)
  const masked =
    colonIndex !== -1
      ? `${url.slice(0, authorityOffset)}${userPart.slice(0, colonIndex)}:***${url.slice(authorityOffset + userPart.length)}`
      : url
  const hasSlashes = match?.[0].includes('//') === true
  const hostIsPortless =
    hasSlashes && authority !== '' && !/:(?!\d+$)|%3a/i.test(authority)
  const atMismatch =
    (url.includes('@') && !authority.includes('@') && !hostIsPortless) ||
    (authority.includes('@') &&
      url.includes('@', authorityOffset + authority.length))
  return /%40/i.test(url) || redactGitUrl(url) === REDACTED_URL
    ? REDACTED_URL
    : atMismatch || !hasSlashes
      ? redactGitUrl(url)
      : masked.replace(/[?#][\s\S]*$/, tail => `${tail[0]}***`)
}

/** Official `Sv` (@203144771): validate, returning the refusal Error or null. */
export function getGitUrlValidationError(url: string): Error | null {
  try {
    assertValidGitUrl(url)
    return null
  } catch (error) {
    return toError(error)
  }
}

/** Official `i0n` (@203144831): boolean form of `Sv`. */
export function isValidGitUrl(url: string): boolean {
  return getGitUrlValidationError(url) === null
}
