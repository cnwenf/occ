/**
 * CC 2.1.251 security fix (changelog: symlink TOCTOU hardening, Gap-109a).
 *
 * Ports the official 2.1.251 check-time/IO-time symlink-resolution binding:
 * at permission-check time each file tool records ("stashes") the full
 * symlink-resolution set of its target path; immediately before the actual
 * IO the resolution set is recomputed and must still be a subset of the
 * stashed one — otherwise the operation is refused. A concurrent rewrite of
 * a symlink in the working directory can no longer redirect an approved
 * read/write between the permission check and the IO.
 *
 * Ported byte-semantically from the official 2.1.251 ELF:
 * - class `Re`   → SymlinkResolutionStash (caps 256 / 1048576, write+read
 *                  lanes, evicted-key set, lane poisoning, `\x00`-joined
 *                  keys, intersection re-stash, per-toolUseId consume
 *                  cleanup)
 * - `kCn`        → PERMISSION_STASH_EVICTED
 * - `a1` / `Nve` → takeApprovedPaths / takeApprovedPathsForRead (exact
 *                  expiry message + exact "no check-time stash" debug log)
 * - `Gm` / `c7`  → SymlinkWriteRefusedError / SymlinkReadRefusedError
 * - `H` / `B`    → symlinkReadRefusedMessage / symlinkWriteRefusedMessage
 * - `Qt`         → stashKey
 *
 * The first gate of the binary's fd-level open-with-verify (`Uzt` for reads:
 * `let o=new Set(e); for(let d of ao(t)) if(!o.has(d)) throw H(t)`; `LC`
 * for writes: same subset check throwing `B`) is reproduced by
 * assertSymlinkResolutionsUnchangedFor{Read,Write} over OCC's check-time
 * resolution builder (getPathsForPermissionCheck — the OCC analogue of the
 * binary's `ao`; it computes the original path + every symlink target + the
 * final canonical path). The remaining fd-level hardening inside Uzt/LC
 * (O_NOFOLLOW opens, /proc/self/fd readlink rechecks, parent-directory
 * canonical walks) is staged — see docs/upstream-version-gap-occ109.md §4b.
 */
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import { getPathsForPermissionCheck } from '../fsOperations.js'
import { expandPath } from '../path.js'

export type ResolutionMode = 'write' | 'read'

/** Binary `kCn` — returned by consume() when the entry was evicted (or its
 * lane poisoned): the permission check is too old to trust. */
export const PERMISSION_STASH_EVICTED = Symbol('permission-stash-evicted')

/** Resolution set as computed at check time (binary: `ao(path)` array). */
export type StashEntry = string[]

const DEFAULT_ENTRIES_CAP = 256
const DEFAULT_EVICTED_KEYS_CAP = 1048576

/** Binary `Qt(e,t)` — join toolUseId and path with a NUL byte. */
function stashKey(toolUseId: string, path: string): string {
  return `${toolUseId}\u0000${path}`
}

/**
 * Binary class `Re` — the per-session stash of check-time symlink
 * resolutions. Two lanes (write/read), each a Map from
 * `toolUseId\x00path` to the resolution array. Eviction pressure (more than
 * entriesCap live entries) moves the oldest entry to the evicted set; if the
 * evicted set itself exceeds evictedKeysCap the lane is poisoned (every
 * later miss is treated as expired). consume() is one-shot per toolUseId:
 * it removes every entry of that toolUseId from the lane.
 */
export class SymlinkResolutionStash {
  private readonly entriesCap: number
  private readonly evictedKeysCap: number
  private readonly lanes: Record<ResolutionMode, Map<string, StashEntry>> = {
    write: new Map(),
    read: new Map(),
  }
  private readonly evicted: Record<ResolutionMode, Set<string>> = {
    write: new Set(),
    read: new Set(),
  }
  private readonly poisoned: Record<ResolutionMode, boolean> = {
    write: false,
    read: false,
  }

  constructor(
    entriesCap: number = DEFAULT_ENTRIES_CAP,
    evictedKeysCap: number = DEFAULT_EVICTED_KEYS_CAP,
  ) {
    this.entriesCap = entriesCap
    this.evictedKeysCap = evictedKeysCap
  }

  /** Binary `Re.stash(e,t,o,r)`. No-op when toolUseId is undefined. */
  stash(
    toolUseId: string | undefined,
    path: string,
    resolutions: StashEntry,
    mode: ResolutionMode = 'write',
  ): void {
    if (toolUseId === undefined) return
    const lane = this.lanes[mode]
    const evictedSet = this.evicted[mode]
    const key = stashKey(toolUseId, path)
    // An evicted key is never re-stashed — the tool use is expired for good.
    if (evictedSet.has(key)) return
    const existing = lane.get(key)
    if (existing !== undefined) {
      // Re-stash narrows: keep only resolutions present in BOTH sets.
      const fresh = new Set(resolutions)
      lane.set(
        key,
        existing.filter(candidate => fresh.has(candidate)),
      )
      return
    }
    if (lane.size >= this.entriesCap) {
      const oldest = lane.keys().next().value
      if (oldest !== undefined) {
        lane.delete(oldest)
        evictedSet.add(oldest)
        if (evictedSet.size > this.evictedKeysCap) {
          this.poisoned[mode] = true
          const oldestEvicted = evictedSet.values().next().value
          if (oldestEvicted !== undefined) evictedSet.delete(oldestEvicted)
        }
      }
    }
    lane.set(key, resolutions)
  }

  /** Binary `Re.consume(e,t,o)`. */
  consume(
    toolUseId: string | undefined,
    path: string,
    mode: ResolutionMode = 'write',
  ): StashEntry | typeof PERMISSION_STASH_EVICTED | undefined {
    if (toolUseId === undefined) return undefined
    const lane = this.lanes[mode]
    const key = stashKey(toolUseId, path)
    const entry = lane.get(key)
    const expired =
      entry === undefined &&
      (this.evicted[mode].delete(key) || this.poisoned[mode])
    // One-shot: drop every entry of this toolUseId from the lane.
    const prefix = `${toolUseId}\u0000`
    for (const k of lane.keys()) {
      if (k.startsWith(prefix)) lane.delete(k)
    }
    if (expired) return PERMISSION_STASH_EVICTED
    return entry
  }
}

/** Binary `Gm`. */
export class SymlinkWriteRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SymlinkWriteRefusedError'
  }
}

/** Binary `c7`. */
export class SymlinkReadRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SymlinkReadRefusedError'
  }
}

/** Binary `H(t)` — thrown by the read gate when the resolution changed. */
export function symlinkReadRefusedMessage(path: string): string {
  return `Refusing to read ${path}: its symlink resolution changed after permission was checked. If a link in the working directory is being rewritten concurrently, stop that and retry.`
}

/** Binary `B(t)` — thrown by the write gate when the resolution changed. */
export function symlinkWriteRefusedMessage(path: string): string {
  return `Refusing to write ${path}: its parent-directory symlink resolution changed after permission was checked.`
}

// The binary keeps the stash on the session object
// (`writePermissionStash: kind === 'fork' ? root.writePermissionStash : new Re`)
// — one instance per session tree, shared by forks. OCC runs one session
// tree per process, so a lazily-created process-level singleton is the
// analogue. Entries are keyed by toolUseId, so concurrent tool uses stay
// separated even where processes are shared (daemon workers).
let sessionWritePermissionStash: SymlinkResolutionStash | undefined

export function getSessionWritePermissionStash(): SymlinkResolutionStash {
  if (sessionWritePermissionStash === undefined) {
    sessionWritePermissionStash = new SymlinkResolutionStash()
  }
  return sessionWritePermissionStash
}

/** Test hook: swap or reset the session stash. */
export function setSessionWritePermissionStashForTesting(
  stash: SymlinkResolutionStash | undefined,
): void {
  sessionWritePermissionStash = stash
}

/**
 * Binary `a1(e,t,r)` — consume the check-time stash entry for
 * (toolUseId, path), or fail closed:
 * - evicted/poisoned entry → SymlinkRead/WriteRefusedError with the
 *   byte-matched expiry message;
 * - entry present → return it;
 * - no entry (permission path never stashed) → debug-log and fall back to a
 *   fresh resolution set (the gate below then trivially passes).
 */
export function takeApprovedPaths(
  context: Pick<ToolUseContext, 'toolUseId'>,
  path: string,
  mode: ResolutionMode = 'write',
): StashEntry {
  const entry = getSessionWritePermissionStash().consume(
    context.toolUseId,
    path,
    mode,
  )
  if (entry === PERMISSION_STASH_EVICTED) {
    throw new (mode === 'read'
      ? SymlinkReadRefusedError
      : SymlinkWriteRefusedError)(
      `Refusing to ${mode === 'read' ? 'read' : 'write'} ${path}: its permission check expired before it ran (too many concurrent file operations). Retry.`,
    )
  }
  if (entry !== undefined) return entry
  if (context.toolUseId) {
    logForDebugging(
      `takeApprovedPathsForWrite: no check-time stash for toolUseId=${context.toolUseId}; using fresh resolution`,
    )
  }
  return getPathsForPermissionCheck(path)
}

/** Binary `Nve(e,t)`. */
export function takeApprovedPathsForRead(
  context: Pick<ToolUseContext, 'toolUseId'>,
  path: string,
): StashEntry {
  return takeApprovedPaths(context, path, 'read')
}

/**
 * Check-time stash call. The binary runs this inside each file tool's
 * checkPermissions (FileReadTool `NI`/`FI` read lane; FileWriteTool `Ky`,
 * FileEditTool `B_`, NotebookEditTool `Q6` write lane): compute `ao(path)`
 * and stash it under (toolUseId, path) before the rule checks run. OCC's
 * `getPathsForPermissionCheck` is the `ao` analogue (original path + every
 * symlink-chain target + canonical path).
 */
export function stashCheckTimeResolutions(
  context: Pick<ToolUseContext, 'toolUseId'>,
  rawPath: string | undefined,
  mode: ResolutionMode,
): void {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return
  let path: string
  try {
    path = expandPath(rawPath)
  } catch {
    // Null-byte / invalid paths are rejected by validateInput downstream.
    return
  }
  getSessionWritePermissionStash().stash(
    context.toolUseId,
    path,
    getPathsForPermissionCheck(path),
    mode,
  )
}

/**
 * Binary `Uzt` first gate (read lane):
 * `let o=new Set(e); for(let d of ao(t)) if(!o.has(d)) throw H(t)`
 * Run immediately before the IO; throws SymlinkReadRefusedError with the
 * byte-matched message when any fresh resolution was not approved at check
 * time.
 */
export function assertSymlinkResolutionsUnchangedForRead(
  context: Pick<ToolUseContext, 'toolUseId'>,
  path: string,
): void {
  const approved = new Set(takeApprovedPathsForRead(context, path))
  for (const resolved of getPathsForPermissionCheck(path)) {
    if (!approved.has(resolved)) {
      throw new SymlinkReadRefusedError(symlinkReadRefusedMessage(path))
    }
  }
}

/**
 * Binary `LC` gate `s()` (write lane, non-replace variant): the same subset
 * check over `ao(t)`, throwing `B(t)` — SymlinkWriteRefusedError with the
 * byte-matched parent-directory message.
 */
export function assertSymlinkResolutionsUnchangedForWrite(
  context: Pick<ToolUseContext, 'toolUseId'>,
  path: string,
): void {
  const approved = new Set(takeApprovedPaths(context, path, 'write'))
  for (const resolved of getPathsForPermissionCheck(path)) {
    if (!approved.has(resolved)) {
      throw new SymlinkWriteRefusedError(symlinkWriteRefusedMessage(path))
    }
  }
}
