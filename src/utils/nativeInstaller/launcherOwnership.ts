/**
 * Launcher ownership discriminator — 2.1.207 #5.
 *
 * Mirrors the official claude-code binary's `Ear` / `Aar` functions. The
 * auto-updater must NOT overwrite a launcher at `~/.local/bin/claude` that it
 * does not own (a custom wrapper script/symlink the user placed there). The
 * installer only overwrites launchers it created:
 *
 * - A **native-managed** launcher: a symlink whose resolved target points into
 *   the `$XDG_DATA_HOME/claude/versions/` directory (the installer's own
 *   version store).
 * - An **npm-managed** launcher (shim): realpath ends with `.js` or includes
 *   `node_modules`.
 *
 * Anything else is **externally managed** — the updater leaves it untouched
 * (new versions still install under `versions/`), version cleanup is skipped
 * (the installer can't tell which version the launcher needs), and `/doctor`
 * reports the externally-managed launcher.
 *
 * Kept dependency-free (no import from installer.ts) to avoid a circular
 * import: both installer.ts and doctorDiagnostic.ts import from here.
 */
import { lstat, readlink, realpath } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { getErrnoCode } from '../errors.js'

/**
 * Versions-directory marker. The binary's `eGy` =
 * `sep + join("claude","versions") + sep`. A resolved native symlink target
 * always contains this segment (e.g. `…/share/claude/versions/2.1.210`),
 * distinguishing the installer's XDG versions dir from unrelated paths.
 */
const VERSIONS_DIR_MARKER = `${sep}${join('claude', 'versions')}${sep}`

/**
 * Is the launcher managed by the native installer? Mirrors `Ear`:
 * - Windows: always true (the installer copies the binary, not a symlink).
 * - Otherwise: the launcher must be a symlink whose resolved target includes
 *   the `claude/versions/` directory marker.
 * - ENOENT counts as managed (a missing launcher is created, not refused).
 *   Other errors count as not-managed (refuse to overwrite).
 */
export async function isNativeManagedLauncher(
  executablePath: string,
): Promise<boolean> {
  if (process.platform === 'win32') return true
  try {
    const stats = await lstat(executablePath)
    if (!stats.isSymbolicLink()) return false
    const linkTarget = await readlink(executablePath)
    const resolved = resolve(dirname(executablePath), linkTarget)
    return resolved.includes(VERSIONS_DIR_MARKER)
  } catch (error) {
    // ar(t): ENOENT → managed (create it); other errors → not managed
    return getErrnoCode(error) === 'ENOENT'
  }
}

/**
 * Is the launcher an npm shim? Mirrors `Aar`: realpath ends with `.js` or
 * includes `node_modules`. Throws on error — callers catch with `() => false`,
 * matching the binary's `!await Aar(e).catch(() => !1)`.
 */
export async function isNpmManagedLauncher(
  executablePath: string,
): Promise<boolean> {
  const real = await realpath(executablePath)
  return real.endsWith('.js') || real.includes('node_modules')
}

/**
 * Is the launcher externally managed (not owned by the native installer or
 * npm)? When true, the auto-updater must NOT overwrite it and version cleanup
 * must be skipped.
 */
export async function isExternallyManagedLauncher(
  executablePath: string,
): Promise<boolean> {
  return (
    !(await isNativeManagedLauncher(executablePath)) &&
    !(await isNpmManagedLauncher(executablePath).catch(() => false))
  )
}
