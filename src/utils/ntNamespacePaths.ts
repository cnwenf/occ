/**
 * NT-namespace / device path detection (CC 2.1.234 security alignment).
 *
 * The official 2.1.234 release rejects NT-namespace device paths before
 * filesystem access ("Fixed a security issue where NT-namespace paths
 * (\??\...) could be read"). Windows resolves `\??\` and the NT object
 * manager namespaces (`\GLOBAL??\`, `\GLOBALROOT\`, `\DosDevices\`,
 * `\Device\`) through the kernel object manager rather than normal path
 * resolution — they can address devices/volumes directly and bypass
 * string-based path checks. These helpers detect the path classes so the
 * read/permission gates can reject them before any I/O.
 *
 * All regexes are byte-for-byte from the 2.1.234 linux-x64 binary.
 */

import { win32 as win32Path } from 'path'

/**
 * NT-namespace device path: leading `\??\` (or `/??/`) — official `Xw`,
 * byte-verified.
 */
export function isNtNamespaceDevicePath(path: string): boolean {
  return /^[\\/]\?\?[\\/]/.test(path)
}

/**
 * NT object-manager namespace path: leading `\GLOBAL??\`, `\GLOBALROOT\`,
 * `\DosDevices\`, or `\Device\` (case-insensitive, both separators) —
 * official `Rys`, byte-verified.
 */
export function isNtObjectNamespacePath(path: string): boolean {
  return /^[\\/](GLOBAL\?\?|GLOBALROOT|DosDevices|Device)[\\/]/i.test(path)
}

/**
 * Combined NT-namespace check used by the read/permission gates: rejects both
 * the `\??\` device form and the object-manager namespace forms.
 */
export function isNtNamespacePath(path: string): boolean {
  return isNtNamespaceDevicePath(path) || isNtObjectNamespacePath(path)
}

/**
 * NT-namespace detection that also catches `\??\` produced by win32 path
 * normalization of mixed-separator input — official `Lwe`, byte-verified:
 * `HWc.test(e) || (e.includes('??') && HWc.test(win32.normalize(e)))` with
 * `HWc = /^[\\/]\?\?[\\/]/`.
 */
export function containsNtNamespacePath(path: string): boolean {
  if (isNtNamespaceDevicePath(path)) return true
  if (path.includes('??')) {
    return isNtNamespaceDevicePath(win32Normalize(path))
  }
  return false
}

/** win32 normalize (identity off-Windows semantics) — official `xWc`. */
function win32Normalize(path: string): string {
  return win32Path.normalize(path)
}

/**
 * Automount path detection — official `c6t`, byte-verified. Walks the
 * leading path components (skipping `.`/empty, popping on `..`); when the
 * first two real components are `net/<share>` (case-insensitive `net`) the
 * path is an automount target and `/net/<share>` is returned, else null.
 */
export function detectAutomountPath(path: string): string | null {
  if (!path.startsWith('/')) return null
  const components: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      components.pop()
      continue
    }
    components.push(segment)
    if (components.length === 2 && components[0]!.toLowerCase() === 'net') {
      return `/${components.join('/')}`
    }
  }
  return null
}

/**
 * Whether a path is an automount path (`/net/<share>`) — official `gy`/`bu`,
 * byte-verified semantics.
 */
export function isAutomountPath(path: string): boolean {
  return detectAutomountPath(path) !== null
}
