/**
 * CC 2.1.251 (Gap-109b): search-path symlink TOCTOU gate for Grep/Glob.
 *
 * Binary → OCC mapping (decompiled 2.1.251 linux-x64 ELF, module at the
 * "Refusing to search" strings):
 *   S2t(path, approvedPaths)       → prepareVerifiedSearchTarget()
 *   Nve(context, path)             → takeApprovedPathsForRead() (symlinkResolutionStash.ts)
 *   d() subset gate                → assertSearchResolutionsUnchanged() (closure)
 *   c7 (SymlinkReadRefusedError)   → SymlinkReadRefusedError (symlinkResolutionStash.ts)
 *   fu() null-byte guard           → assertNoNullBytesInSearch()
 *   v/R() PATH-name-only rg guard  → rgPath guard in prepareVerifiedSearchTarget()
 *   aY open + errno refusals       → open/stat block in prepareVerifiedSearchTarget()
 *   lY X_OK traversability refusal → access(X_OK) block
 *   H2t() deny-rule recheck        → assertDenyPatternsUnchanged()
 *   Ygt deny-glob snapshot         → computeReadDenyPatternSnapshot()
 *
 * The permission check records the target's symlink resolutions in the
 * session read lane (stashCheckTimeResolutions at checkPermissions time).
 * Before the search spawns ripgrep, this gate consumes that stash and refuses
 * — with the binary's exact messages — if any resolution changed, if the
 * target can no longer be opened, or if the Read deny patterns shifted while
 * the search was being prepared. recheckBeforeSpawn() re-runs the subset
 * gate immediately before spawn (binary beforeSpawn:
 * `e.recheckBeforeSpawn(), H2t(ve, e, xe)`).
 *
 * Staged (forensics in docs/upstream-version-gap-occ109.md §4b): the binary's
 * fd-pinning lane — holding the O_RDONLY fd across the spawn, canonical
 * resolution via readlink(/proc/self/fd/N), spawnCwd=/proc/self/fd/N with
 * relativeOutput target="." and XYn/KPn output-path remapping — plus the
 * per-result deny judging (judgeEveryResult/l_t), the safe-lane early return
 * (jn/Os/yr), and the Windows branch. OCC spawns ripgrep at the lexical path;
 * the check-time gate + pre-spawn recheck close the check→spawn TOCTOU window
 * with the same refusal surface.
 */

import * as fs from 'fs'
import { isAbsolute, sep } from 'path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getCwd } from '../cwd.js'
import { getPathsForPermissionCheck } from '../fsOperations.js'
import { ripgrepCommand } from '../ripgrep.js'
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from './filesystem.js'
import {
  SymlinkReadRefusedError,
  takeApprovedPathsForRead,
} from './symlinkResolutionStash.js'

// Byte-matched refusal messages (binary u(), R(), open-catch, X_OK-catch,
// H2t — all thrown as c7/SymlinkReadRefusedError).
export function searchSymlinkRefusedMessage(path: string): string {
  return `Refusing to search ${path}: its symlink resolution changed after permission was checked. If a link in the working directory is being rewritten concurrently, stop that and retry.`
}

export function searchPathOnlyRipgrepRefusedMessage(path: string): string {
  return `Refusing to search ${path}: ripgrep was found only by name on PATH, and a search outside the working directory cannot apply your Read deny rules in that configuration. Install ripgrep at an absolute path or search under the working directory.`
}

export function searchCouldNotOpenMessage(
  path: string,
  errno: string,
): string {
  return `Refusing to search ${path}: it could not be opened (${errno}) — it is unreadable, or is being replaced concurrently.`
}

export function searchNotTraversableMessage(path: string): string {
  return `Cannot search ${path}: the directory is not traversable (no execute permission).`
}

export function searchDenyRulesChangedMessage(path: string): string {
  return `Refusing to search ${path}: a path one of its Read deny rules is written through changed while the search was being prepared. Retry.`
}

// Binary j0/RipgrepNullByteError (fu() guard).
export class RipgrepNullByteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RipgrepNullByteError'
  }
}

function assertNoNullBytesInSearch(lexicalPath: string): void {
  // Binary fu([], target, sessionCwd): a NUL in the target or the spawn cwd
  // would truncate the path seen by ripgrep vs the path that was checked.
  if (lexicalPath.includes('\u0000')) {
    throw new RipgrepNullByteError(
      'Cannot spawn ripgrep: the target path contains a null byte (\\0)',
    )
  }
  if (getCwd().includes('\u0000')) {
    throw new RipgrepNullByteError(
      'Cannot spawn ripgrep: the session working directory contains a null byte (\\0)',
    )
  }
}

// Binary rp(): containment check used by the spawn-cwd guards. The binary's
// case-insensitive Windows prefix variant (inside rp's try-block) is staged;
// OCC targets linux/macOS where exact-prefix containment is the live case.
function isPathUnder(target: string, base: string): boolean {
  if (target === base) {
    return true
  }
  const baseWithSep = base.endsWith(sep) ? base : base + sep
  return target.startsWith(baseWithSep)
}

export interface VerifiedSearchTarget {
  readonly lexicalPath: string
  readonly isDirectory: boolean
  /** Re-runs the resolution subset gate; call immediately before spawn. */
  recheckBeforeSpawn(): void
}

/**
 * Binary S2t. Returns null when the target vanished (ENOENT/ENOTDIR) between
 * the permission check and now — the callers turn that into an empty result
 * (binary GPn / Qat null branch), matching the official behavior.
 */
export async function prepareVerifiedSearchTarget(
  context: ToolUseContext,
  lexicalPath: string,
): Promise<VerifiedSearchTarget | null> {
  assertNoNullBytesInSearch(lexicalPath)

  // Consume the check-time read-lane stash (binary Nve). Throws the eviction
  // refusal when the entry was displaced before the tool ran.
  const approved = new Set(takeApprovedPathsForRead(context, lexicalPath))

  // First gate (binary d()): every fresh resolution of the target must still
  // be in the set captured at permission-check time.
  const assertResolutionsUnchanged = (): void => {
    for (const resolved of getPathsForPermissionCheck(lexicalPath)) {
      if (!approved.has(resolved)) {
        throw new SymlinkReadRefusedError(
          searchSymlinkRefusedMessage(lexicalPath),
        )
      }
    }
  }
  assertResolutionsUnchanged()

  // PATH-name-only ripgrep guard (binary v/R()): with a bare-name rg binary
  // the deny rules cannot be anchored for a search outside the session cwd.
  const { rgPath } = ripgrepCommand()
  if (!isAbsolute(rgPath) && !isPathUnder(lexicalPath, getCwd())) {
    throw new SymlinkReadRefusedError(
      searchPathOnlyRipgrepRefusedMessage(lexicalPath),
    )
  }

  // Open the target (binary aY with O_RDONLY|O_NONBLOCK): proves it still
  // exists and is readable right now; errno refusals are byte-matched.
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(
      lexicalPath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    )
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code
    if (errno === 'ENOENT' || errno === 'ENOTDIR') {
      return null
    }
    if (errno === 'EACCES' || errno === 'EPERM' || errno === 'ELOOP') {
      throw new SymlinkReadRefusedError(
        searchCouldNotOpenMessage(lexicalPath, errno),
      )
    }
    throw e
  }

  try {
    const stats = await handle.stat()
    if (stats.isDirectory()) {
      // Binary lY(..., X_OK): a directory without execute permission cannot
      // be traversed by ripgrep; refuse instead of spawning a doomed search.
      try {
        await fs.promises.access(lexicalPath, fs.constants.X_OK)
      } catch {
        throw new SymlinkReadRefusedError(
          searchNotTraversableMessage(lexicalPath),
        )
      }
    }
    return {
      lexicalPath,
      isDirectory: stats.isDirectory(),
      recheckBeforeSpawn: assertResolutionsUnchanged,
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Binary Ygt equivalent at OCC granularity: the Read deny patterns that will
 * be passed to ripgrep as `!` globs, normalized against the search base.
 * Snapshotted at prep time and compared before spawn (binary H2t).
 */
export function computeReadDenyPatternSnapshot(
  toolPermissionContext: ToolPermissionContext,
  basePath: string,
): string[] {
  return normalizePatternsToPath(
    getFileReadIgnorePatterns(toolPermissionContext),
    basePath,
  )
}

/** Binary H2t: refuse if the deny patterns shifted during preparation. */
export function assertDenyPatternsUnchanged(
  lexicalPath: string,
  baseline: string[],
  current: string[],
): void {
  if (
    current.length !== baseline.length ||
    current.some((pattern, index) => pattern !== baseline[index])
  ) {
    throw new SymlinkReadRefusedError(
      searchDenyRulesChangedMessage(lexicalPath),
    )
  }
}
