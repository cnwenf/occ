import { logForDebugging } from './debug.js'
import { getPlatform, type Platform } from './platform.js'

/**
 * CC 2.1.281 changelog #033 (security) — macOS automount / kernel-resolved
 * path prefix guards.
 *
 * Byte-verified against the official v2.1.281 linux-x64 ELF:
 *
 * - Kernel-resolved prefix validator `UH(t)` @192900730 (v280=0 / v281=2+
 *   occurrences of "Kernel-resolved path prefix"; /.vol 0→15, /.nofollow 0→10,
 *   /.resolve 0→10):
 *
 *     if(!/\/\.(?:vol|file|nofollow|resolve)(?:\/|$)/i.test(t))return!1;
 *     if(!t.startsWith("/"))return!1;
 *     // normalize segments: skip ""/"." , pop on ".."
 *     if(e.length===1&&/^\.(?:vol|file|nofollow|resolve)$/i.test(n))return!0
 *
 *   i.e. the path is kernel-resolved when its FIRST normalized segment is
 *   .vol/.file/.nofollow/.resolve (case-insensitive). These are prefixes the
 *   macOS kernel redirects (firmlinks/`.vol` short-name resolution), so a
 *   stat() can trigger a directory-service lookup and mount to a remote host.
 *
 * - Automount browse surface (`iS`/`O`/`WW` family @192900730-192905000):
 *   exactly `/net` (single normalized segment, lowercased), `/net/<x>`,
 *   `/Network/Servers/<x>`, and any path whose first normalized segment is
 *   `network` (any depth). Per the #033 task spec OCC denies ANY depth under
 *   `/net` or `/Network` — a superset of the official set, darwin-gated.
 *
 * - Deny message @97322030 (attachment validator `Urr`; sentence byte-exact
 *   after the quoted path):
 *
 *     `"${e}" is under /net, /Network, /.vol, /.file, /.nofollow or /.resolve,
 *      which could trigger a network mount, so it is not supported. Copy the
 *      file to an ordinary local path and pass that path instead.`
 *
 * - Log reasons @197007388 (permission-dialog guard):
 *     "Kernel-resolved path prefix (/.vol etc.) detected (defense-in-depth check)"
 *   and the pre-existing v280 automount family:
 *     "Automount browse surface detected (defense-in-depth check)"
 */

const KERNEL_RESOLVED_SEGMENT_REGEX = /\/\.(?:vol|file|nofollow|resolve)(?:\/|$)/i
const KERNEL_RESOLVED_FIRST_SEGMENT_REGEX = /^\.(?:vol|file|nofollow|resolve)$/i

const KERNEL_RESOLVED_LOG_REASON =
  'Kernel-resolved path prefix (/.vol etc.) detected (defense-in-depth check)'
const AUTOMOUNT_LOG_REASON =
  'Automount browse surface detected (defense-in-depth check)'

/** Official deny sentence @97322030, byte-exact after the quoted path. */
export function macosNetworkMountDenyMessage(path: string): string {
  return `"${path}" is under /net, /Network, /.vol, /.file, /.nofollow or /.resolve, which could trigger a network mount, so it is not supported. Copy the file to an ordinary local path and pass that path instead.`
}

/**
 * Normalize an absolute POSIX path into segments (skip "" and ".", pop on
 * "..") — byte-faithful to the official walk inside `UH`. Returns null for
 * non-absolute input.
 */
function normalizedSegments(path: string): string[] | null {
  if (!path.startsWith('/')) return null
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments
}

/** Official `UH` @192900730: first normalized segment is a kernel-resolved dotdir. */
export function isKernelResolvedPathPrefix(path: string): boolean {
  if (!KERNEL_RESOLVED_SEGMENT_REGEX.test(path)) return false
  if (!path.startsWith('/')) return false
  // Byte-faithful to UH: the check fires when the accumulated normalized
  // prefix is exactly one segment and that segment is a kernel dotdir — so
  // "/a/../.vol/x" counts (pop brings the stack back to just ".vol").
  const stack: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      stack.pop()
      continue
    }
    stack.push(segment)
    if (stack.length === 1 && KERNEL_RESOLVED_FIRST_SEGMENT_REGEX.test(segment)) {
      return true
    }
  }
  return false
}

/**
 * Automount browse surface (`iS`/`O`/`WW` family): any depth under `/net` or
 * `/Network` (first normalized segment, case-insensitive).
 */
export function isAutomountBrowsePath(path: string): boolean {
  const segments = normalizedSegments(path)
  if (segments === null || segments.length === 0) return false
  const first = segments[0]!.toLowerCase()
  return first === 'net' || first === 'network'
}

/** Union of the two surfaces (platform-independent predicate). */
export function isMacosNetworkMountSurfacePath(path: string): boolean {
  return isAutomountBrowsePath(path) || isKernelResolvedPathPrefix(path)
}

/**
 * Darwin-gated deny check for the file tools / permission validators.
 * `platform` is injectable for tests; production callers take the memoized
 * `getPlatform()` default. Logs the official defense-in-depth reason via
 * logForDebugging (OCC's log convention; the official reason strings are
 * kept byte-exact) and returns true when the path must be denied.
 */
export function shouldDenyMacosNetworkMountPath(
  path: string,
  platform: Platform = getPlatform(),
): boolean {
  if (platform !== 'macos') return false
  if (!isMacosNetworkMountSurfacePath(path)) return false
  const reason = isKernelResolvedPathPrefix(path)
    ? KERNEL_RESOLVED_LOG_REASON
    : AUTOMOUNT_LOG_REASON
  logForDebugging(`${reason}: denied "${path}"`)
  return true
}
