import { lstatSync, realpathSync, type Stats } from 'fs'
import { win32 } from 'path'
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

/**
 * ─────────────────────────────────────────────────────────────────────────
 * CC 2.1.282 changelog (security) — CLAUDE.md/rules STARTUP symlink
 * containment. The official build grew a dedicated deny aggregate `nE` and a
 * symlink gate `ZO` that guard every startup memory-file surface (memory
 * probes, .claude/rules walks, AGENTS.md discovery, @include expansion,
 * exclude-pattern resolution). This section ports those predicates.
 *
 * Byte-verified against the official v2.1.282 linux-x64 ELF:
 *
 * - `nE` @201925278 (deny aggregate):
 *     function nE(e){return Hn(e)&&!wl(e)||Hi(e)||uA(e)||Hb(e)||H$(e)||Ph(e)||S_(e)}
 * - `ZO` @201920217 (symlink gate):
 *     function ZO(e,n){if(!n.isSymlink||n.isCanonical)return!1;
 *                      return!(n.resolvedPath===e&&mL(e))}
 * - `H$` @193979174 (automounter map dir — LINUX build; the two `||!1`
 *   arms are darwin-only branches compiled out of linux):
 *     function H$(t){if(!t.startsWith("/"))return!1;
 *       let e=t.split("/").filter((r)=>r!==""&&r!==".");
 *       if(e.length<1||e.length>3||e.includes(".."))return!1;
 *       if(C(e)&&(e.length===2||!1))return!0;
 *       let n=e[0].toLowerCase();
 *       return e.length<=2&&(n==="net"||!1)}
 * - `C` (net-host / network-servers stack check):
 *     function C(t){return t.length===2&&dA(t[0])==="net"||
 *       t.length===3&&dA(t[0])==="network"&&dA(t[1])==="servers"}
 * - `dA` (invisible-format-char strip + case fold):
 *     t.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g,"")
 *      .toUpperCase().toLowerCase()
 * - `S_` @193976417 ≡ existing `isKernelResolvedPathPrefix` above (identical
 *   to 281's `UH`).
 * - `Hb` @193980152 (folded bare /net): first normalize ".." walk, then
 *   `e.length===1&&e[0].toLowerCase()==="net"`.
 * - `mL` @193980350 (folded first segment "network", any depth; memoized
 *   with Map cap `Ht`=1024 clear-on-overflow and length cap `Wt`=4096
 *   bypassing memoization).
 * - `Hi`≡`Vhe`@193979593 (memoized, same caps) walking `Et`: returns
 *   "/"+stack.join("/") the moment the stack matches `C` — i.e. any
 *   ..-folded /net/<host> or /Network/Servers/<host> PREFIX.
 * - `Hn` @193975759 (UNC): /^[\\/]{2}/.test(t)||gL(t); `gL` @193990346:
 *   $t.test(t)||t.includes("??")&&$t.test(Gt(t)) with $t=/^[\\/]\?\?[\\/]/
 *   and `Gt` = win32.normalize on Windows builds, identity elsewhere;
 *   `Ph` @193975861 = $t alone; `wl` (WSL exception):
 *     /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]([^\\/]*)/i — exception applies
 *     unless the host segment is dot/space-only (/^\.{0,2}[. ]*$/).
 * - `uA` @193980691 is `return!1` in the linux build (compiled-out arm) —
 *   omitted here; documented in `isDeniedMemoryPath`.
 * - macOS deny message @211555751 corroborates the H$ darwin arms:
 *   "leads to an automounter map directory (/net, /net/<host>; macOS
 *   /Network, /home) — refusing it (naming anything in it asks the
 *   automounter or a host)"
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Official `dA` invisible format-char class (zero-width/bidi marks). */
const INVISIBLE_FORMAT_CHARS_REGEX =
  /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g

/** Official `$t`/`Ph`: Windows device-namespace prefix (\??\ or /??/). */
const DEVICE_NAMESPACE_PREFIX_REGEX = /^[\\/]\?\?[\\/]/

/** Official `Hn` first arm: UNC prefix (// or \\). */
const UNC_PREFIX_REGEX = /^[\\/]{2}/

/** Official `wl`: UNC path into a WSL distro share. */
const WSL_UNC_HOST_REGEX = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]([^\\/]*)/i

/** Official `wl` guard: dot/space-only hosts do NOT take the exception. */
const WSL_PLACEHOLDER_HOST_REGEX = /^\.{0,2}[. ]*$/

/** Official `Ht`: memo table capacity — cleared wholesale on overflow. */
const MEMO_CACHE_MAX_ENTRIES = 1024

/** Official `Wt`: paths longer than this skip memoization (compute direct). */
const MEMO_PATH_LENGTH_CAP = 4096

/** Official `dA`: strip invisible format chars, then case-fold. */
function foldSegmentCase(segment: string): string {
  return segment.replace(INVISIBLE_FORMAT_CHARS_REGEX, '')
    .toUpperCase()
    .toLowerCase()
}

/** Official `C`: stack is exactly /net/<host> or /Network/Servers/<host>. */
function isNetHostOrNetworkServersStack(stack: readonly string[]): boolean {
  return (
    (stack.length === 2 && foldSegmentCase(stack[0]!) === 'net') ||
    (stack.length === 3 &&
      foldSegmentCase(stack[0]!) === 'network' &&
      foldSegmentCase(stack[1]!) === 'servers')
  )
}

/** Official `Et`: ".."-folding walk; returns the matched prefix or null. */
function foldedAutomountPrefixUncached(path: string): string | null {
  const stack: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      stack.pop()
      continue
    }
    stack.push(segment)
    if (isNetHostOrNetworkServersStack(stack)) return `/${stack.join('/')}`
  }
  return null
}

const foldedAutomountPrefixMemo = new Map<string, string | null>()

/**
 * Official `Vhe` @193979593 (memoized — Map cap `Ht` cleared on overflow,
 * paths over `Wt` computed without memoization). Returns the root-anchored
 * /net/<host> or /Network/Servers/<host> prefix of the ..-folded path.
 */
export function foldedAutomountPrefix(path: string): string | null {
  if (!path.startsWith('/')) return null
  if (path.length > MEMO_PATH_LENGTH_CAP) {
    return foldedAutomountPrefixUncached(path)
  }
  let computed = foldedAutomountPrefixMemo.get(path)
  if (computed === undefined) {
    computed = foldedAutomountPrefixUncached(path)
    if (foldedAutomountPrefixMemo.size >= MEMO_CACHE_MAX_ENTRIES) {
      foldedAutomountPrefixMemo.clear()
    }
    foldedAutomountPrefixMemo.set(path, computed)
  }
  return computed
}

/** Official `Hi` ≡ `Vhe(path)!==null`. */
export function isAutomountPrefixPath(path: string): boolean {
  return foldedAutomountPrefix(path) !== null
}

/** Official `Hb` @193980152: the ..-folded path is exactly /net. */
export function isFoldedBareNet(path: string): boolean {
  const segments = normalizedSegments(path)
  return (
    segments !== null &&
    segments.length === 1 &&
    segments[0]!.toLowerCase() === 'net'
  )
}

/** Official `Nt` (mL's uncached body). */
function foldedNetworkFirstSegmentUncached(path: string): boolean {
  const stack: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      stack.pop()
      continue
    }
    stack.push(segment)
    if (stack.length === 1 && stack[0]!.toLowerCase() === 'network') {
      return true
    }
  }
  return false
}

const foldedNetworkFirstSegmentMemo = new Map<string, boolean>()

/** Official `mL` @193980350 (memoized; same caps as `Vhe`). */
export function isFoldedNetworkFirstSegment(path: string): boolean {
  if (!path.startsWith('/')) return false
  if (path.length > MEMO_PATH_LENGTH_CAP) {
    return foldedNetworkFirstSegmentUncached(path)
  }
  let computed = foldedNetworkFirstSegmentMemo.get(path)
  if (computed === undefined) {
    computed = foldedNetworkFirstSegmentUncached(path)
    if (foldedNetworkFirstSegmentMemo.size >= MEMO_CACHE_MAX_ENTRIES) {
      foldedNetworkFirstSegmentMemo.clear()
    }
    foldedNetworkFirstSegmentMemo.set(path, computed)
  }
  return computed
}

/**
 * Official `H$` @193979174 — automounter map directory.
 *
 * Linux-build source (byte-exact above): /net and /net/<host> on ALL
 * platforms; the two `||!1` stubs are darwin-only arms. The macOS deny
 * message @211555751 ("automounter map directory (/net, /net/<host>; macOS
 * /Network, /home)") identifies them; OCC reconstructs them as
 * `platform === 'macos'` gates (INFERRED — the darwin arm bodies are not in
 * the linux binary):
 *   - `C(e) && e.length===3` on darwin → /Network/Servers/<host> (redundant
 *     with the Hi arm of the aggregate, kept for structural fidelity);
 *   - `n==="home"` on darwin → /home and /home/<user> (≤2 segments).
 *
 * Note H$ does NOT fold "..": any path containing a ".." segment is refused
 * outright (e.includes("..")), unlike Hi/mL/Hb which fold.
 */
export function isAutomounterMapDir(
  path: string,
  platform: Platform = getPlatform(),
): boolean {
  if (!path.startsWith('/')) return false
  const segments = path.split('/').filter(s => s !== '' && s !== '.')
  if (segments.length < 1 || segments.length > 3 || segments.includes('..')) {
    return false
  }
  const isDarwin = platform === 'macos'
  if (
    isNetHostOrNetworkServersStack(segments) &&
    (segments.length === 2 || (segments.length === 3 && isDarwin))
  ) {
    return true
  }
  const first = segments[0]!.toLowerCase()
  return (
    segments.length <= 2 && (first === 'net' || (first === 'home' && isDarwin))
  )
}

/** Official `Gt`: win32.normalize on Windows builds, identity elsewhere. */
function win32NormalizeIfWindows(path: string): string {
  return process.platform === 'win32' ? win32.normalize(path) : path
}

/** Official `gL` @193990346 (\??\ device paths, incl. normalization-revealed). */
export function isWindowsDevicePath(path: string): boolean {
  return (
    DEVICE_NAMESPACE_PREFIX_REGEX.test(path) ||
    (path.includes('??') &&
      DEVICE_NAMESPACE_PREFIX_REGEX.test(win32NormalizeIfWindows(path)))
  )
}

/** Official `Hn` @193975759: UNC path (// or \\ prefix, or device namespace). */
export function isUncPath(path: string): boolean {
  return UNC_PREFIX_REGEX.test(path) || isWindowsDevicePath(path)
}

/** Official `wl`: UNC paths into a WSL distro share (with real host names). */
export function isWslUncPath(path: string): boolean {
  const match = WSL_UNC_HOST_REGEX.exec(path)
  return match !== null && !WSL_PLACEHOLDER_HOST_REGEX.test(match[1] ?? '')
}

/** nE's first arm: `Hn(e)&&!wl(e)` — UNC minus the WSL exception. */
export function isDeniedUncPath(path: string): boolean {
  return isUncPath(path) && !isWslUncPath(path)
}

/**
 * Aggregate startup-memory deny predicate — OCC port of official `nE`
 * @201925278, used by the CLAUDE.md/rules containment gates in claudemd.ts.
 *
 * Deltas vs the official, both deliberate and documented:
 *  - `uA` (@193980691) is `return!1` in the linux build (compiled-out arm) —
 *    omitted.
 *  - OCC INSTRUCTED SUPERSET: `mL` (folded first segment "network") is
 *    added. Official `nE` does NOT include mL — mL only appears in ZO's
 *    literal-path exception — but this port's task spec requires the folded
 *    first-segment "network" arm in the startup aggregate, consistent with
 *    OCC's pre-existing documented any-depth /Network posture
 *    (isAutomountBrowsePath). Effect: a literal, non-symlink path like
 *    /Network/foo/CLAUDE.md is skipped on every platform, where the official
 *    would skip it only on darwin (via H$/ZO); strictly stricter, never laxer.
 */
export function isDeniedMemoryPath(
  path: string,
  platform: Platform = getPlatform(),
): boolean {
  return (
    isDeniedUncPath(path) || // Hn && !wl
    isAutomountPrefixPath(path) || // Hi
    isFoldedBareNet(path) || // Hb
    isAutomounterMapDir(path, platform) || // H$
    isWindowsDevicePath(path) || // Ph (byte-redundant inside Hn in the official too)
    isKernelResolvedPathPrefix(path) || // S_
    isFoldedNetworkFirstSegment(path) // mL — OCC superset (task-instructed)
  )
}

/**
 * OCC port of the official symlink gate `ZO` @201920217 combined with `Ho`'s
 * fail-closed ancestry arms, for the startup memory surfaces.
 *
 * The official gate refuses when a path is a symlink whose ancestry could
 * not be verified — Ho marks unverifiable resolutions with the sentinel
 * "\x00unverified-ancestry" (isCanonical:false), and ZO then refuses unless
 * the resolved path equals the literal AND the literal is an mL "network"
 * path (an exception that lets literal /Network spellings fall through to
 * nE itself). OCC's `safeResolvePath` never yields isSymlink:true with
 * isCanonical:false, so replaying ZO's formula against it would be dead
 * code; this helper reproduces the SEMANTICS directly:
 *
 *  - not a symlink → allow (false);
 *  - symlink whose target cannot be resolved (dangling, ELOOP, EACCES —
 *    ANY throw from realpathSync.native) → REFUSE. Fail-closed: this is the
 *    OCC equivalent of the official's unverified-ancestry refusal (a
 *    dangling link on macOS may still name an automount surface that would
 *    resolve after a network mount appears);
 *  - symlink that resolves → refuse iff the resolved target OR the literal
 *    link path hits a denied memory surface (nE).
 *
 * Deviation vs official (stricter, deliberate): a symlink to an ordinary
 * existing file outside the repo (e.g. /etc/passwd on linux) is ALLOWED —
 * matching the official, which has no general out-of-repo containment here.
 */
export function shouldRefuseMemorySymlink(
  linkPath: string,
  platform: Platform = getPlatform(),
): boolean {
  let stats: Stats
  try {
    stats = lstatSync(linkPath)
  } catch {
    // Nothing to lstat (ENOENT etc.) — not a symlink; the caller's own read
    // error handling deals with missing files.
    return false
  }
  if (!stats.isSymbolicLink()) return false
  let resolvedPath: string
  try {
    resolvedPath = realpathSync.native(linkPath)
  } catch {
    // Fail-closed ≡ official unverified-ancestry refusal.
    return true
  }
  return (
    isDeniedMemoryPath(linkPath, platform) ||
    isDeniedMemoryPath(resolvedPath, platform)
  )
}
