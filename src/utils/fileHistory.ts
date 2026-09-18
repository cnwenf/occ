import { createHash, randomBytes, type UUID } from 'crypto'
import { diffLines } from 'diff'
import { constants as fsConstants, type Stats } from 'fs'
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import {
  getIsNonInteractiveSession,
  getOriginalCwd,
  getSessionId,
} from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import { notifyVscodeFileUpdated } from 'src/services/mcp/vscodeSdkMcp.js'
import type { LogOption } from 'src/types/logs.js'
import { inspect } from 'util'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getErrnoCode, isENOENT } from './errors.js'
import { pathExists } from './file.js'
import { logError } from './log.js'
import { recordFileHistorySnapshot } from './sessionStorage.js'
import { sleep } from './sleep.js'

type BackupFileName = string | null // The null value means the file does not exist in this version

export type FileHistoryBackup = {
  backupFileName: BackupFileName
  version: number
  backupTime: Date
}

export type FileHistorySnapshot = {
  messageId: UUID // The associated message ID for this snapshot
  trackedFileBackups: Record<string, FileHistoryBackup> // Map of file paths to backup versions
  timestamp: Date
}

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  // Monotonically-increasing counter incremented on every snapshot, even when
  // old snapshots are evicted.  Used by useGitDiffStats as an activity signal
  // (snapshots.length plateaus once the cap is reached).
  snapshotSequence: number
}

const MAX_SNAPSHOTS = 100
export type DiffStats =
  | {
      filesChanged?: string[]
      insertions: number
      deletions: number
    }
  | undefined

export function fileHistoryEnabled(): boolean {
  if (getIsNonInteractiveSession()) {
    return fileHistoryEnabledSdk()
  }
  return (
    getGlobalConfig().fileCheckpointingEnabled !== false &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}

function fileHistoryEnabledSdk(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}

/**
 * Tracks a file edit (and add) by creating a backup of its current contents (if necessary).
 *
 * This must be called before the file is actually added or edited, so we can save
 * its contents before the edit.
 */
export async function fileHistoryTrackEdit(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  filePath: string,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  const trackingPath = maybeShortenFilePath(filePath)

  // Phase 1: check if backup is needed. Speculative writes would overwrite
  // the deterministic {hash}@v1 backup on every repeat call — a second
  // trackEdit after an edit would corrupt v1 with post-edit content.
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return
  const mostRecent = captured.snapshots.at(-1)
  if (!mostRecent) {
    logError(new Error('FileHistory: Missing most recent snapshot'))
    logEvent('tengu_file_history_track_edit_failed', {})
    return
  }
  if (mostRecent.trackedFileBackups[trackingPath]) {
    // Already tracked in the most recent snapshot; next makeSnapshot will
    // re-check mtime and re-backup if changed. Do not touch v1 backup.
    return
  }

  // Phase 2: async backup.
  let backup: FileHistoryBackup
  try {
    backup = await createBackup(filePath, 1)
  } catch (error) {
    logError(error)
    logEvent('tengu_file_history_track_edit_failed', {})
    return
  }
  const isAddingFile = backup.backupFileName === null

  // Phase 3: commit. Re-check tracked (another trackEdit may have raced).
  updateFileHistoryState((state: FileHistoryState) => {
    try {
      const mostRecentSnapshot = state.snapshots.at(-1)
      if (
        !mostRecentSnapshot ||
        mostRecentSnapshot.trackedFileBackups[trackingPath]
      ) {
        return state
      }

      // This file has not already been tracked in the most recent snapshot, so we
      // need to retroactively track a backup there.
      const updatedTrackedFiles = state.trackedFiles.has(trackingPath)
        ? state.trackedFiles
        : new Set(state.trackedFiles).add(trackingPath)

      // Shallow-spread is sufficient: backup values are never mutated after
      // insertion, so we only need fresh top-level + trackedFileBackups refs
      // for React change detection. A deep clone would copy every existing
      // backup's Date/string fields — O(n) cost to add one entry.
      const updatedMostRecentSnapshot = {
        ...mostRecentSnapshot,
        trackedFileBackups: {
          ...mostRecentSnapshot.trackedFileBackups,
          [trackingPath]: backup,
        },
      }

      const updatedState = {
        ...state,
        snapshots: (() => {
          const copy = state.snapshots.slice()
          copy[copy.length - 1] = updatedMostRecentSnapshot
          return copy
        })(),
        trackedFiles: updatedTrackedFiles,
      }
      maybeDumpStateForDebug(updatedState)

      // Record a snapshot update since it has changed.
      void recordFileHistorySnapshot(
        messageId,
        updatedMostRecentSnapshot,
        true, // isSnapshotUpdate
      ).catch(error => {
        logError(new Error(`FileHistory: Failed to record snapshot: ${error}`))
      })

      logEvent('tengu_file_history_track_edit_success', {
        isNewFile: isAddingFile,
        version: backup.version,
      })
      logForDebugging(`FileHistory: Tracked file modification for ${filePath}`)

      return updatedState
    } catch (error) {
      logError(error)
      logEvent('tengu_file_history_track_edit_failed', {})
      return state
    }
  })
}

/**
 * Adds a snapshot in the file history and backs up any modified tracked files.
 */
export async function fileHistoryMakeSnapshot(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return undefined
  }

  // Phase 1: capture current state with a no-op updater so we know which
  // files to back up. Returning the same reference keeps this a true no-op
  // for any wrapper that honors same-ref returns (src/CLAUDE.md wrapper
  // rule). Wrappers that unconditionally spread will trigger one extra
  // re-render; acceptable for a once-per-turn call.
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return // updateFileHistoryState was a no-op stub (e.g. mcp.ts)

  // Phase 2: do all IO async, outside the updater.
  const trackedFileBackups: Record<string, FileHistoryBackup> = {}
  const mostRecentSnapshot = captured.snapshots.at(-1)
  if (mostRecentSnapshot) {
    logForDebugging(`FileHistory: Making snapshot for message ${messageId}`)
    await Promise.all(
      Array.from(captured.trackedFiles, async trackingPath => {
        try {
          const filePath = maybeExpandFilePath(trackingPath)
          const latestBackup =
            mostRecentSnapshot.trackedFileBackups[trackingPath]
          const nextVersion = latestBackup ? latestBackup.version + 1 : 1

          // Stat the file once; ENOENT means the tracked file was deleted.
          let fileStats: Stats | undefined
          try {
            fileStats = await stat(filePath)
          } catch (e: unknown) {
            if (!isENOENT(e)) throw e
          }

          if (!fileStats) {
            trackedFileBackups[trackingPath] = {
              backupFileName: null, // Use null to denote missing tracked file
              version: nextVersion,
              backupTime: new Date(),
            }
            logEvent('tengu_file_history_backup_deleted_file', {
              version: nextVersion,
            })
            logForDebugging(
              `FileHistory: Missing tracked file: ${trackingPath}`,
            )
            return
          }

          // File exists - check if it needs to be backed up
          if (
            latestBackup &&
            latestBackup.backupFileName !== null &&
            !(await checkOriginFileChanged(
              filePath,
              latestBackup.backupFileName,
              fileStats,
            ))
          ) {
            // File hasn't been modified since the latest version, reuse it
            trackedFileBackups[trackingPath] = latestBackup
            return
          }

          // File is newer than the latest backup, create a new backup
          trackedFileBackups[trackingPath] = await createBackup(
            filePath,
            nextVersion,
          )
        } catch (error) {
          logError(error)
          logEvent('tengu_file_history_backup_file_failed', {})
        }
      }),
    )
  }

  // Phase 3: commit the new snapshot to state. Read state.trackedFiles FRESH
  // — if fileHistoryTrackEdit added a file during phase 2's async window, it
  // wrote the backup to state.snapshots[-1].trackedFileBackups. Inherit those
  // so the new snapshot covers every currently-tracked file.
  updateFileHistoryState((state: FileHistoryState) => {
    try {
      const lastSnapshot = state.snapshots.at(-1)
      if (lastSnapshot) {
        for (const trackingPath of state.trackedFiles) {
          if (trackingPath in trackedFileBackups) continue
          const inherited = lastSnapshot.trackedFileBackups[trackingPath]
          if (inherited) trackedFileBackups[trackingPath] = inherited
        }
      }
      const now = new Date()
      const newSnapshot: FileHistorySnapshot = {
        messageId,
        trackedFileBackups,
        timestamp: now,
      }

      const allSnapshots = [...state.snapshots, newSnapshot]
      // claude-code 2.1.208 #35: when snapshots overflow MAX_SNAPSHOTS, prune
      // the backup files of the evicted snapshots that no kept snapshot still
      // references. Fire-and-forget; an unlink failure must not block the turn.
      let snapshots: FileHistorySnapshot[]
      if (allSnapshots.length > MAX_SNAPSHOTS) {
        const evicted = allSnapshots.slice(
          0,
          allSnapshots.length - MAX_SNAPSHOTS,
        )
        const kept = allSnapshots.slice(-MAX_SNAPSHOTS)
        void pruneSupersededBackups(evicted, kept).catch(error => {
          logError(
            new Error(
              `FileHistory: failed to prune superseded backups: ${error}`,
            ),
          )
        })
        snapshots = kept
      } else {
        snapshots = allSnapshots
      }
      const updatedState: FileHistoryState = {
        ...state,
        snapshots,
        snapshotSequence: (state.snapshotSequence ?? 0) + 1,
      }
      maybeDumpStateForDebug(updatedState)

      void notifyVscodeSnapshotFilesUpdated(state, updatedState).catch(logError)

      // Record the file history snapshot to session storage for resume support
      void recordFileHistorySnapshot(
        messageId,
        newSnapshot,
        false, // isSnapshotUpdate
      ).catch(error => {
        logError(new Error(`FileHistory: Failed to record snapshot: ${error}`))
      })

      logForDebugging(
        `FileHistory: Added snapshot for ${messageId}, tracking ${state.trackedFiles.size} files`,
      )
      logEvent('tengu_file_history_snapshot_success', {
        trackedFilesCount: state.trackedFiles.size,
        snapshotCount: updatedState.snapshots.length,
      })

      return updatedState
    } catch (error) {
      logError(error)
      logEvent('tengu_file_history_snapshot_failed', {})
      return state
    }
  })
}

/**
 * Rewinds the file system to a previous snapshot.
 */
export async function fileHistoryRewind(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  // Rewind is a pure filesystem side-effect and does not mutate
  // FileHistoryState. Capture state with a no-op updater, then do IO async.
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return

  const targetSnapshot = captured.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )
  if (!targetSnapshot) {
    logError(new Error(`FileHistory: Snapshot for ${messageId} not found`))
    logEvent('tengu_file_history_rewind_failed', {
      trackedFilesCount: captured.trackedFiles.size,
      snapshotFound: false,
    })
    throw new Error('The selected snapshot was not found')
  }

  try {
    logForDebugging(
      `FileHistory: [Rewind] Rewinding to snapshot for ${messageId}`,
    )
    const { filesChanged, skippedLinks } = await applySnapshot(
      captured,
      targetSnapshot,
    )

    logForDebugging(`FileHistory: [Rewind] Finished rewinding to ${messageId}`)
    logEvent('tengu_file_history_rewind_success', {
      trackedFilesCount: captured.trackedFiles.size,
      filesChangedCount: filesChanged.length,
      skippedLinksCount: skippedLinks,
    })
    // 2.1.216 #36: report skipped link/non-regular paths. Matches the
    // official binary's stderr warning (`Warning: N tracked path[s] skipped:
    // <reason>. Run with --debug for the paths.`).
    if (skippedLinks > 0) {
      const noun = skippedLinks === 1 ? 'path was' : 'paths were'
      process.stderr.write(
        `Warning: ${skippedLinks} tracked ${noun} skipped: ${REWIND_SKIP_REASON}. Run with --debug for the paths.\n`,
      )
    }
  } catch (error) {
    logError(error)
    logEvent('tengu_file_history_rewind_failed', {
      trackedFilesCount: captured.trackedFiles.size,
      snapshotFound: true,
    })
    throw error
  }
}

export function fileHistoryCanRestore(
  state: FileHistoryState,
  messageId: UUID,
): boolean {
  if (!fileHistoryEnabled()) {
    return false
  }

  return state.snapshots.some(snapshot => snapshot.messageId === messageId)
}

/**
 * Computes diff stats for a file snapshot by counting the number of files that would be changed
 * if reverting to that snapshot.
 */
export async function fileHistoryGetDiffStats(
  state: FileHistoryState,
  messageId: UUID,
): Promise<DiffStats> {
  if (!fileHistoryEnabled()) {
    return undefined
  }

  const targetSnapshot = state.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )

  if (!targetSnapshot) {
    return undefined
  }

  const results = await Promise.all(
    Array.from(state.trackedFiles, async trackingPath => {
      try {
        const filePath = maybeExpandFilePath(trackingPath)
        const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]

        const backupFileName: BackupFileName | undefined = targetBackup
          ? targetBackup.backupFileName
          : getBackupFileNameFirstVersion(trackingPath, state)

        if (backupFileName === undefined) {
          // Error resolving the backup, so don't touch the file
          logError(
            new Error('FileHistory: Error finding the backup file to apply'),
          )
          logEvent('tengu_file_history_rewind_restore_file_failed', {
            dryRun: true,
          })
          return null
        }

        const stats = await computeDiffStatsForFile(
          filePath,
          backupFileName === null ? undefined : backupFileName,
        )
        if (stats?.insertions || stats?.deletions) {
          return { filePath, stats }
        }
        if (backupFileName === null && (await pathExists(filePath))) {
          // Zero-byte file created after snapshot: counts as changed even
          // though diffLines reports 0/0.
          return { filePath, stats }
        }
        return null
      } catch (error) {
        logError(error)
        logEvent('tengu_file_history_rewind_restore_file_failed', {
          dryRun: true,
        })
        return null
      }
    }),
  )

  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0
  for (const r of results) {
    if (!r) continue
    filesChanged.push(r.filePath)
    insertions += r.stats?.insertions || 0
    deletions += r.stats?.deletions || 0
  }
  return { filesChanged, insertions, deletions }
}

/**
 * Lightweight boolean-only check: would rewinding to this message change any
 * file on disk? Uses the same stat/content comparison as the non-dry-run path
 * of applySnapshot (checkOriginFileChanged) instead of computeDiffStatsForFile,
 * so it never calls diffLines. Early-exits on the first changed file. Use when
 * the caller only needs a yes/no answer; fileHistoryGetDiffStats remains for
 * callers that display insertions/deletions.
 */
export async function fileHistoryHasAnyChanges(
  state: FileHistoryState,
  messageId: UUID,
): Promise<boolean> {
  if (!fileHistoryEnabled()) {
    return false
  }

  const targetSnapshot = state.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )
  if (!targetSnapshot) {
    return false
  }

  for (const trackingPath of state.trackedFiles) {
    try {
      const filePath = maybeExpandFilePath(trackingPath)
      const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]
      const backupFileName: BackupFileName | undefined = targetBackup
        ? targetBackup.backupFileName
        : getBackupFileNameFirstVersion(trackingPath, state)

      if (backupFileName === undefined) {
        continue
      }
      if (backupFileName === null) {
        // Backup says file did not exist; probe via stat (operate-then-catch).
        if (await pathExists(filePath)) return true
        continue
      }
      if (await checkOriginFileChanged(filePath, backupFileName)) return true
    } catch (error) {
      logError(error)
    }
  }
  return false
}

/**
 * claude-code 2.1.216 #36: user-facing reason printed when /rewind skips
 * tracked paths that are links or otherwise unsafe to touch. Grep-verified
 * against the official 2.1.216 binary (identifier `b7n`).
 */
export const REWIND_SKIP_REASON =
  'the tracked path is (or became) a link or other non-regular file, its directory changed since the checkpoint, or its backup could not be safely read'

type RewindSafetyVerdict =
  | { verdict: 'safe' }
  | { verdict: 'refused'; detail: string }

/**
 * claude-code 2.1.216 #36: safety gate run before /rewind restores or deletes
 * a file at a tracked path. Mirrors the official binary's `z4g(filePath,
 * realParentDir)` link/non-regular/nlink checks. A refused verdict means the
 * path must NOT be touched — restoring or deleting through it would write
 * through (or unlink) a symlink/hardlink target, which is a filesystem
 * integrity hazard. ENOENT falls through as "safe" (creating a new file at a
 * path that does not yet exist is fine).
 *
 * `realParentDir` is the parent directory's realpath captured at backup time.
 * When supplied, the parent-directory-moved / dangling-symlink checks run;
 * when undefined (OCC snapshots don't currently track it), only the
 * destination-file checks run. Exported for testing.
 */
export async function checkRewindDestinationSafety(
  filePath: string,
  realParentDir?: string,
): Promise<RewindSafetyVerdict> {
  const refuse = (detail: string): RewindSafetyVerdict => ({
    verdict: 'refused',
    detail,
  })
  try {
    const s = await lstat(filePath)
    if (s.isSymbolicLink()) return refuse('destination is a symlink')
    if (!s.isFile()) return refuse('destination is not a regular file')
    if (s.nlink > 1) {
      return refuse(`destination is hard-linked (nlink=${s.nlink})`)
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      return refuse(`destination path does not resolve (${code})`)
    }
    if (!isENOENT(e)) throw e
    // ENOENT: path does not exist — safe to (re)create. Fall through.
  }
  if (realParentDir !== undefined) {
    const parent = dirname(filePath)
    let resolved: string | undefined
    try {
      resolved = await realpath(parent)
    } catch (s: unknown) {
      const code = getErrnoCode(s)
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        return refuse(`parent path does not resolve (${code})`)
      }
      if (!isENOENT(s)) throw s
      // Parent doesn't resolve; probe whether it's a dangling symlink.
      try {
        if ((await lstat(parent)).isSymbolicLink()) {
          return refuse('parent directory is a dangling symlink')
        }
      } catch (c: unknown) {
        if (!isENOENT(c)) throw c
      }
      // Walk up to the first ancestor that exists, then resolve relative.
      let ancestor = parent
      for (;;) {
        const up = dirname(ancestor)
        if (up === ancestor) break
        ancestor = up
        try {
          await lstat(ancestor)
        } catch (u: unknown) {
          if (!isENOENT(u)) throw u
          continue
        }
        resolved = await realpath(ancestor).then(r =>
          join(r, relative(ancestor, parent)),
        )
        break
      }
    }
    if (resolved !== undefined && resolved !== realParentDir) {
      return refuse(`parent directory moved (${resolved} != ${realParentDir})`)
    }
    const parentStat = await stat(parent).catch((s: unknown) => {
      if (isENOENT(s)) return undefined
      throw s
    })
    if (parentStat !== undefined && !parentStat.isDirectory()) {
      return refuse('parent path is not a directory')
    }
  }
  return { verdict: 'safe' }
}

/**
 * Applies the given file snapshot state to the tracked files (writes/deletes
 * on disk), returning the changed file paths and the count of skipped link /
 * non-regular paths. Async IO only.
 *
 * claude-code 2.1.275 #11: restores run through Promise.allSettled (mirroring
 * the official v276 `lFt` batch discipline) so one file's failure — including
 * an exhausted incomplete-copy retry schedule — cannot abort the restore of
 * the others. Per-file errors are caught inside each task (logError +
 * tengu_file_history_rewind_restore_file_failed), exactly like the previous
 * sequential loop; the rejected branch below is a defensive net. Results are
 * aggregated in trackedFiles iteration order, keeping filesChanged
 * deterministic. Public return shape is unchanged.
 */
async function applySnapshot(
  state: FileHistoryState,
  targetSnapshot: FileHistorySnapshot,
): Promise<{ filesChanged: string[]; skippedLinks: number }> {
  const results = await Promise.allSettled(
    Array.from(state.trackedFiles, trackingPath =>
      applySnapshotFile(state, targetSnapshot, trackingPath),
    ),
  )

  const filesChanged: string[] = []
  let skippedLinks = 0
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.kind === 'changed') {
        filesChanged.push(result.value.filePath)
      } else if (result.value.kind === 'skipped') {
        skippedLinks++
      }
    } else {
      logError(result.reason)
      logEvent('tengu_file_history_rewind_restore_file_failed', {
        dryRun: false,
      })
    }
  }
  return { filesChanged, skippedLinks }
}

/** Per-file outcome of a snapshot application: restored/deleted, skipped for link safety, or unchanged/failed. */
type ApplySnapshotFileOutcome =
  | { kind: 'changed'; filePath: string }
  | { kind: 'skipped' }
  | { kind: 'unchanged' }

/**
 * Applies the target snapshot to a single tracked file. Body is identical to
 * the pre-2.1.275 sequential applySnapshot loop, expressed as return values
 * instead of continue/push so Promise.allSettled can drive it.
 */
async function applySnapshotFile(
  state: FileHistoryState,
  targetSnapshot: FileHistorySnapshot,
  trackingPath: string,
): Promise<ApplySnapshotFileOutcome> {
  try {
    const filePath = maybeExpandFilePath(trackingPath)
    const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]

    const backupFileName: BackupFileName | undefined = targetBackup
      ? targetBackup.backupFileName
      : getBackupFileNameFirstVersion(trackingPath, state)

    if (backupFileName === undefined) {
      // Error resolving the backup, so don't touch the file
      logError(
        new Error('FileHistory: Error finding the backup file to apply'),
      )
      logEvent('tengu_file_history_rewind_restore_file_failed', {
        dryRun: false,
      })
      return { kind: 'unchanged' }
    }

    // 2.1.216 #36: refuse to restore/delete through a symlink or hardlink at
    // a tracked path. The official binary runs this check (z4g) before any
    // unlink/copyFile; we match that ordering so the path is never touched.
    const safety = await checkRewindDestinationSafety(filePath)
    if (safety.verdict === 'refused') {
      logEvent('tengu_file_history_rewind_restore_file_failed', {
        dryRun: false,
      })
      logForDebugging(
        `FileHistory: [Rewind] Refusing to touch ${filePath}: ${safety.detail}`,
        { level: 'error' },
      )
      return { kind: 'skipped' }
    }

    if (backupFileName === null) {
      // File did not exist at the target version; delete it if present.
      try {
        await unlink(filePath)
        logForDebugging(`FileHistory: [Rewind] Deleted ${filePath}`)
        return { kind: 'changed', filePath }
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code === 'ENOTDIR' || code === 'ELOOP' || code === 'EISDIR') {
          // Path resolves to something we can't unlink safely — count as
          // skipped, matching the official applySnapshot catch block.
          logEvent('tengu_file_history_rewind_restore_file_failed', {
            dryRun: false,
          })
          return { kind: 'skipped' }
        }
        if (!isENOENT(e)) throw e
        // Already absent; nothing to do.
        return { kind: 'unchanged' }
      }
    }

    // File should exist at a specific version. Restore only if it differs.
    if (await checkOriginFileChanged(filePath, backupFileName)) {
      await restoreBackup(filePath, backupFileName)
      logForDebugging(
        `FileHistory: [Rewind] Restored ${filePath} from ${backupFileName}`,
      )
      return { kind: 'changed', filePath }
    }
    return { kind: 'unchanged' }
  } catch (error) {
    logError(error)
    logEvent('tengu_file_history_rewind_restore_file_failed', {
      dryRun: false,
    })
    return { kind: 'unchanged' }
  }
}

/**
 * Checks if the original file has been changed compared to the backup file.
 * Optionally reuses a pre-fetched stat for the original file (when the caller
 * already stat'd it to check existence, we avoid a second syscall).
 *
 * Exported for testing.
 */
export async function checkOriginFileChanged(
  originalFile: string,
  backupFileName: string,
  originalStatsHint?: Stats,
): Promise<boolean> {
  const backupPath = resolveBackupPath(backupFileName)

  let originalStats: Stats | null = originalStatsHint ?? null
  if (!originalStats) {
    try {
      originalStats = await stat(originalFile)
    } catch (e: unknown) {
      if (!isENOENT(e)) return true
    }
  }
  let backupStats: Stats | null = null
  try {
    backupStats = await stat(backupPath)
  } catch (e: unknown) {
    if (!isENOENT(e)) return true
  }

  return compareStatsAndContent(originalStats, backupStats, async () => {
    try {
      const [originalContent, backupContent] = await Promise.all([
        readFile(originalFile, 'utf-8'),
        readFile(backupPath, 'utf-8'),
      ])
      return originalContent !== backupContent
    } catch {
      // File deleted between stat and read -> treat as changed.
      return true
    }
  })
}

/**
 * Shared stat/content comparison logic for sync and async change checks.
 * Returns true if the file has changed relative to the backup.
 */
function compareStatsAndContent<T extends boolean | Promise<boolean>>(
  originalStats: Stats | null,
  backupStats: Stats | null,
  compareContent: () => T,
): T | boolean {
  // One exists, one missing -> changed
  if ((originalStats === null) !== (backupStats === null)) {
    return true
  }
  // Both missing -> no change
  if (originalStats === null || backupStats === null) {
    return false
  }

  // Check file stats like permission and file size
  if (
    originalStats.mode !== backupStats.mode ||
    originalStats.size !== backupStats.size
  ) {
    return true
  }

  // This is an optimization that depends on the correct setting of the modified
  // time. If the original file's modified time was before the backup time, then
  // we can skip the file content comparison.
  if (originalStats.mtimeMs < backupStats.mtimeMs) {
    return false
  }

  // Use the more expensive file content comparison. The callback handles its
  // own read errors — a try/catch here is dead for async callbacks anyway.
  return compareContent()
}

/**
 * Computes the number of lines changed in the diff.
 */
async function computeDiffStatsForFile(
  originalFile: string,
  backupFileName?: string,
): Promise<DiffStats> {
  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0
  try {
    const backupPath = backupFileName
      ? resolveBackupPath(backupFileName)
      : undefined

    const [originalContent, backupContent] = await Promise.all([
      readFileAsyncOrNull(originalFile),
      backupPath ? readFileAsyncOrNull(backupPath) : null,
    ])

    if (originalContent === null && backupContent === null) {
      return {
        filesChanged,
        insertions,
        deletions,
      }
    }

    filesChanged.push(originalFile)

    // Compute the diff
    const changes = diffLines(originalContent ?? '', backupContent ?? '')
    changes.forEach(c => {
      if (c.added) {
        insertions += c.count || 0
      }
      if (c.removed) {
        deletions += c.count || 0
      }
    })
  } catch (error) {
    logError(new Error(`FileHistory: Error generating diffStats: ${error}`))
  }

  return {
    filesChanged,
    insertions,
    deletions,
  }
}

function getBackupFileName(filePath: string, version: number): string {
  const fileNameHash = createHash('sha256')
    .update(filePath)
    .digest('hex')
    .slice(0, 16)
  return `${fileNameHash}@v${version}`
}

// claude-code 2.1.208 #35: safety guard matching the on-disk backup name
// format ({16 hex chars}@v{version}). pruneSupersededBackups only deletes
// files whose name matches this pattern, so a corrupted/foreign entry in the
// tracked-file map can never trick the pruner into deleting an unrelated file.
const BACKUP_FILE_NAME_REGEX = /^[0-9a-f]{16}@v\d+$/

/**
 * claude-code 2.1.208 #35: prune superseded file-history backups from disk.
 *
 * When snapshots overflow MAX_SNAPSHOTS, the oldest snapshots are dropped from
 * the in-memory state. Previously their backup files (under
 * ~/.claude/file-history/<sessionId>/) were left on disk forever, so an
 * edit-heavy session accumulated unbounded checkpoint disk usage (and the
 * transcript that re-listed them grew without bound — up to 79x larger in
 * edit-heavy sessions). This deletes the backup files referenced *only* by
 * the evicted snapshots:
 *   - still referenced by a kept snapshot → keep (it's not superseded yet)
 *   - version === 1 → keep (the pre-edit baseline, always retained for rewind)
 *   - name doesn't match BACKUP_FILE_NAME_REGEX → keep (safety guard)
 * ENOENT during unlink is expected (already gone) and silently ignored.
 *
 * Ports the official binary's TSg(evictedSnapshots, keptSnapshots).
 */
export async function pruneSupersededBackups(
  evictedSnapshots: FileHistorySnapshot[],
  keptSnapshots: FileHistorySnapshot[],
): Promise<void> {  const sessionId = getSessionId()

  // Collect every backup file name still referenced by a kept snapshot.
  const stillReferenced = new Set<string>()
  for (const snapshot of keptSnapshots) {
    for (const backup of Object.values(snapshot.trackedFileBackups)) {
      if (backup.backupFileName !== null) {
        stillReferenced.add(backup.backupFileName)
      }
    }
  }

  // Collect superseded backup file names from the evicted snapshots.
  const toDelete = new Set<string>()
  for (const snapshot of evictedSnapshots) {
    for (const backup of Object.values(snapshot.trackedFileBackups)) {
      if (
        backup.backupFileName !== null &&
        !stillReferenced.has(backup.backupFileName) &&
        backup.version !== 1 &&
        BACKUP_FILE_NAME_REGEX.test(backup.backupFileName)
      ) {
        toDelete.add(backup.backupFileName)
      }
    }
  }

  for (const backupFileName of toDelete) {
    try {
      await unlink(resolveBackupPath(backupFileName, sessionId))
    } catch (error) {
      if (!isENOENT(error)) {
        logError(
          new Error(
            `FileHistory: failed to delete evicted backup ${backupFileName}: ${error}`,
          ),
        )
      }
    }
  }
}

function resolveBackupPath(backupFileName: string, sessionId?: string): string {
  const configDir = getClaudeConfigHomeDir()
  return join(
    configDir,
    'file-history',
    sessionId || getSessionId(),
    backupFileName,
  )
}

/**
 * Creates a backup of the file at filePath. If the file does not exist
 * (ENOENT), records a null backup (file-did-not-exist marker). All IO is
 * async. Lazy mkdir: tries copyFile first, creates the directory on ENOENT.
 */
async function createBackup(
  filePath: string | null,
  version: number,
): Promise<FileHistoryBackup> {
  if (filePath === null) {
    return { backupFileName: null, version, backupTime: new Date() }
  }

  const backupFileName = getBackupFileName(filePath, version)
  const backupPath = resolveBackupPath(backupFileName)

  // Stat first: if the source is missing, record a null backup and skip the
  // copy. Separates "source missing" from "backup dir missing" cleanly —
  // sharing a catch for both meant a file deleted between copyFile-success
  // and stat would leave an orphaned backup with a null state record.
  let srcStats: Stats
  try {
    srcStats = await stat(filePath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return { backupFileName: null, version, backupTime: new Date() }
    }
    throw e
  }

  // copyFile preserves content and avoids reading the whole file into the JS
  // heap (which the previous readFileSync+writeFileSync pipeline did, OOMing
  // on large tracked files). Lazy mkdir: 99% of calls hit the fast path
  // (directory already exists); on ENOENT, mkdir then retry.
  //
  // claude-code 2.1.275 #11: mirrors the official v276 backup-creation shape
  // (`arn`): unlink any stale backup at the deterministic {hash}@v{version}
  // path first, then create the copy with COPYFILE_EXCL so an existing backup
  // file is never silently overwritten — if a concurrent creator re-lands the
  // path between the unlink and the copy, we fail loudly with EEXIST (which
  // surfaces as a per-file backup failure) instead of interleaving content.
  await unlink(backupPath).catch((e: unknown) => {
    if (!isENOENT(e)) throw e
  })
  try {
    await copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL)
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e
    await mkdir(dirname(backupPath), { recursive: true })
    await copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL)
  }

  // Preserve file permissions on the backup.
  await chmod(backupPath, srcStats.mode)

  logEvent('tengu_file_history_backup_file_created', {
    version: version,
    fileSize: srcStats.size,
  })

  return {
    backupFileName,
    version,
    backupTime: new Date(),
  }
}

/**
 * claude-code 2.1.275 #11 — byte-exact error thrown when a restore copy lands
 * fewer bytes than the backup source had (official v276 binary:
 * `Error("FileHistory: backup copy is incomplete")` @197429010; v274 has no
 * post-copy verification at all — 0 binary hits — which is why /rewind could
 * silently restore a truncated / zero-filled file).
 */
const BACKUP_COPY_INCOMPLETE_MESSAGE = 'FileHistory: backup copy is incomplete'

/**
 * claude-code 2.1.275 #11 — official v276 retry backoff schedule
 * (`var ivo=[100,200,400,800]` @197428145). One initial attempt plus four
 * retries; the 1.5 s total matches the official "after about 1.5 s of
 * retries" log text. Injectable via `copyFileVerifiedAtomic`'s `delays`
 * parameter (mirrors official `urn(e,n,r=ivo)`). Exported for testing.
 */
export const COPY_RETRY_BACKOFF_MS: readonly number[] = [100, 200, 400, 800]

/**
 * Official v276 retryable rename errno codes
 * (`bX=new Set(["EPERM","EBUSY","EACCES"])` @191305720).
 */
const RETRYABLE_RENAME_ERRNO_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EBUSY',
  'EACCES',
])

/**
 * Official v276 temp-copy naming (`jT(e)` @191305759:
 * `` `${e}.tmp.${randomBytes(4).toString("hex")}` ``): the temp file lives in
 * the destination directory (same filesystem, so rename stays atomic) with a
 * random 4-byte suffix.
 */
function makeTempCopyPath(destPath: string): string {
  return `${destPath}.tmp.${randomBytes(4).toString('hex')}`
}

function isRetryableRestoreCopyError(error: unknown): boolean {
  if (
    error instanceof Error &&
    error.message === BACKUP_COPY_INCOMPLETE_MESSAGE
  ) {
    return true
  }
  const code = getErrnoCode(error)
  if (code === undefined) {
    return false
  }
  // EEXIST here can only come from a COPYFILE_EXCL temp-name collision (a
  // rename EEXIST is treated as success inside the loop) — retry with a fresh
  // random temp name.
  return code === 'EEXIST' || RETRYABLE_RENAME_ERRNO_CODES.has(code)
}

/**
 * claude-code 2.1.275 #11: verified atomic copy used by every restore path
 * (the /rewind copyFile path and the cross-session hardlink-fallback copy
 * path). Ports the official v276 `avo` copy-fallback shape:
 *
 *   1. `copyFile(src → temp-in-dest-dir, COPYFILE_EXCL)` — never clobbers an
 *      existing file at any point;
 *   2. post-copy size verification against the source size — a
 *      truncated/zero-filled copy throws the byte-exact
 *      `FileHistory: backup copy is incomplete` (the actual 2.1.275 fix;
 *      v274 restored silently);
 *   3. `rename(temp → dest)` — atomic replacement, so the target is never
 *      observed half-written.
 *
 * The whole cycle retries on the official backoff schedule
 * [100,200,400,800] ms for an incomplete copy, a retryable errno
 * (EPERM/EBUSY/EACCES — e.g. another process holding the destination), or a
 * temp-name EEXIST collision. A rename EEXIST means a concurrent migrator
 * already landed the destination — the official code treats that as success.
 * Once the schedule is exhausted the last error is rethrown so callers surface
 * a per-file failure instead of silently succeeding with truncated data.
 * Temp files are unlinked best-effort after every attempt (official `finally`
 * clause).
 *
 * Deviation note: official v276 retries only the rename step (`urn`); the
 * incomplete-copy error propagates immediately. Per the 2.1.275 port task
 * spec, OCC retries the whole copy+verify cycle on the same schedule —
 * strictly safer against a transient truncated copy.
 *
 * Exported for testing.
 */
export async function copyFileVerifiedAtomic(
  srcPath: string,
  destPath: string,
  expectedSize: number,
  delays: readonly number[] = COPY_RETRY_BACKOFF_MS,
): Promise<void> {
  let remainingDelays = delays
  let lastError: unknown
  for (;;) {
    const tempPath = makeTempCopyPath(destPath)
    try {
      await copyFile(srcPath, tempPath, fsConstants.COPYFILE_EXCL)
      const tempStats = await lstat(tempPath)
      if (tempStats.size !== expectedSize) {
        throw new Error(BACKUP_COPY_INCOMPLETE_MESSAGE)
      }
      try {
        await rename(tempPath, destPath)
      } catch (renameError: unknown) {
        if (getErrnoCode(renameError) === 'EEXIST') {
          // A concurrent migrator already landed the destination.
          return
        }
        throw renameError
      }
      return
    } catch (error: unknown) {
      lastError = error
      const [delay, ...rest] = remainingDelays
      if (!isRetryableRestoreCopyError(error) || delay === undefined) {
        break
      }
      remainingDelays = rest
      await sleep(delay)
    } finally {
      await unlink(tempPath).catch(() => {})
    }
  }
  throw lastError
}

/**
 * Restores a file from its backup path with proper directory creation and
 * permissions.
 *
 * claude-code 2.1.275 #11: the restore is now verified and atomic — copy to a
 * temp file in the destination directory (COPYFILE_EXCL), verify the copied
 * size against the backup, then rename over the target. Incomplete copies and
 * retryable errnos are retried on the official [100,200,400,800] ms schedule;
 * exhausted retries throw the byte-exact
 * `FileHistory: backup copy is incomplete` so callers surface a per-file
 * failure (v274 restored truncated/zero-filled backups silently).
 * Lazy mkdir: tries the copy first, creates the directory on ENOENT.
 */
async function restoreBackup(
  filePath: string,
  backupFileName: string,
): Promise<void> {
  const backupPath = resolveBackupPath(backupFileName)

  // Stat first: if the backup is missing, log and bail before attempting
  // the copy. Separates "backup missing" from "destination dir missing".
  let backupStats: Stats
  try {
    backupStats = await stat(backupPath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      logEvent('tengu_file_history_rewind_restore_file_failed', {})
      logError(
        new Error(`FileHistory: [Rewind] Backup file not found: ${backupPath}`),
      )
      return
    }
    throw e
  }

  // Lazy mkdir: 99% of calls hit the fast path (destination dir exists).
  try {
    await copyFileVerifiedAtomic(backupPath, filePath, backupStats.size)
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e
    await mkdir(dirname(filePath), { recursive: true })
    await copyFileVerifiedAtomic(backupPath, filePath, backupStats.size)
  }

  // Restore the file permissions
  await chmod(filePath, backupStats.mode)
}

/**
 * Gets the first (earliest) backup version for a file, used when rewinding
 * to a target backup point where the file has not been tracked yet.
 *
 * @returns The backup file name for the first version, or null if the file
 * did not exist in the first version, or undefined if we cannot find a
 * first version at all
 */
function getBackupFileNameFirstVersion(
  trackingPath: string,
  state: FileHistoryState,
): BackupFileName | undefined {
  for (const snapshot of state.snapshots) {
    const backup = snapshot.trackedFileBackups[trackingPath]
    if (backup !== undefined && backup.version === 1) {
      // This can be either a file name or null, with null meaning the file
      // did not exist in the first version.
      return backup.backupFileName
    }
  }

  // The undefined means there was an error resolving the first version.
  return undefined
}

/**
 * Use the relative path as the key to reduce session storage space for tracking.
 */
function maybeShortenFilePath(filePath: string): string {
  if (!isAbsolute(filePath)) {
    return filePath
  }
  const cwd = getOriginalCwd()
  if (filePath.startsWith(cwd)) {
    return relative(cwd, filePath)
  }
  return filePath
}

function maybeExpandFilePath(filePath: string): string {
  if (isAbsolute(filePath)) {
    return filePath
  }
  return join(getOriginalCwd(), filePath)
}

/**
 * Restores file history snapshot state for a given log option.
 */
export function fileHistoryRestoreStateFromLog(
  fileHistorySnapshots: FileHistorySnapshot[],
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  if (!fileHistoryEnabled()) {
    return
  }
  // Make a copy of the snapshots as we migrate from absolute path to
  // shortened relative tracking path.
  const snapshots: FileHistorySnapshot[] = []
  // Rebuild the tracked files from the snapshots
  const trackedFiles = new Set<string>()
  for (const snapshot of fileHistorySnapshots) {
    const trackedFileBackups: Record<string, FileHistoryBackup> = {}
    for (const [path, backup] of Object.entries(snapshot.trackedFileBackups)) {
      const trackingPath = maybeShortenFilePath(path)
      trackedFiles.add(trackingPath)
      trackedFileBackups[trackingPath] = backup
    }
    snapshots.push({
      ...snapshot,
      trackedFileBackups: trackedFileBackups,
    })
  }
  onUpdateState({
    snapshots: snapshots,
    trackedFiles: trackedFiles,
    snapshotSequence: snapshots.length,
  })
}

/**
 * Copy file history snapshots for a given log option.
 */
export async function copyFileHistoryForResume(log: LogOption): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  const fileHistorySnapshots = log.fileHistorySnapshots
  if (!fileHistorySnapshots || log.messages.length === 0) {
    return
  }
  const lastMessage = log.messages[log.messages.length - 1]
  const previousSessionId = lastMessage?.sessionId
  if (!previousSessionId) {
    logError(
      new Error(
        `FileHistory: Failed to copy backups on restore (no previous session id)`,
      ),
    )
    return
  }

  const sessionId = getSessionId()
  if (previousSessionId === sessionId) {
    logForDebugging(
      `FileHistory: No need to copy file history for resuming with same session id: ${sessionId}`,
    )
    return
  }

  try {
    // All backups share the same directory: {configDir}/file-history/{sessionId}/
    // Create it once upfront instead of once per backup file
    const newBackupDir = join(
      getClaudeConfigHomeDir(),
      'file-history',
      sessionId,
    )
    await mkdir(newBackupDir, { recursive: true })

    // Migrate all backup files from the previous session to current session.
    // claude-code 2.1.275 #11: mirrors the official v276 `lFt` batching —
    // snapshots and their backup entries migrate via Promise.allSettled (one
    // failing file never aborts the rest), and a shared in-flight Map ensures a
    // backupFileName referenced by several snapshots is copied exactly once.
    const inFlightCopies = new Map<string, Promise<void>>()
    let failedSnapshots = 0
    await Promise.allSettled(
      fileHistorySnapshots.map(async snapshot => {
        const backupEntries = Object.values(snapshot.trackedFileBackups).filter(
          (backup): backup is typeof backup & { backupFileName: string } =>
            backup.backupFileName !== null,
        )

        const results = await Promise.allSettled(
          backupEntries.map(({ backupFileName }) => {
            let pending = inFlightCopies.get(backupFileName)
            if (!pending) {
              pending = copyBackupFromPreviousSession(
                backupFileName,
                previousSessionId,
                newBackupDir,
                sessionId,
              )
              inFlightCopies.set(backupFileName, pending)
            }
            return pending
          }),
        )

        const copyFailed = results.some(r => r.status === 'rejected')

        // Record the snapshot only if we have successfully migrated the backup files
        if (!copyFailed) {
          void recordFileHistorySnapshot(
            snapshot.messageId,
            snapshot,
            false, // isSnapshotUpdate
          ).catch(_ => {
            logError(
              new Error(`FileHistory: Failed to record copy backup snapshot`),
            )
          })
        } else {
          failedSnapshots++
        }
      }),
    )

    if (failedSnapshots > 0) {
      logEvent('tengu_file_history_resume_copy_failed', {
        numSnapshots: fileHistorySnapshots.length,
        failedSnapshots,
      })
    }
  } catch (error) {
    logError(error)
  }
}

/**
 * Migrates a single backup file from the previous session's backup directory
 * into the current session's directory.
 *
 * claude-code 2.1.275 #11: ports the official v276 `avo`: lstat+isFile source
 * verification up front, hardlink-first migration, and — when the hardlink
 * fails (e.g. EXDEV across devices) — a copy fallback that is atomic
 * (temp+rename), exclusive (COPYFILE_EXCL), size-verified (byte-exact
 * `FileHistory: backup copy is incomplete`), and retried on the official
 * [100,200,400,800] ms backoff schedule for EPERM/EBUSY/EACCES. Per-file
 * failures rethrow so the allSettled caller marks only that snapshot failed
 * without aborting the rest. v274 copied straight onto the destination with
 * no verification — the truncated/zero-filled backup source of the 2.1.275
 * data-loss bug.
 */
async function copyBackupFromPreviousSession(
  backupFileName: string,
  previousSessionId: string,
  newBackupDir: string,
  sessionId: string,
): Promise<void> {
  const oldBackupPath = resolveBackupPath(backupFileName, previousSessionId)
  const newBackupPath = join(newBackupDir, backupFileName)

  // Official `avo`: stat the source first; a missing source gets the
  // byte-exact log and fails this file only.
  let srcStats: Stats
  try {
    srcStats = await lstat(oldBackupPath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      logForDebugging(
        `FileHistory: Failed to copy backup ${backupFileName} on restore (backup file does not exist in ${previousSessionId})`,
        { level: 'error' },
      )
    }
    throw e
  }
  if (!srcStats.isFile()) {
    throw new Error('FileHistory: backup source is not a regular file')
  }

  try {
    await link(oldBackupPath, newBackupPath)
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'EEXIST') {
      // Already migrated — never overwrite an existing backup.
      return
    }
    if (code === 'ENOENT') {
      logForDebugging(
        `FileHistory: Failed to copy backup ${backupFileName} on restore (backup file does not exist in ${previousSessionId})`,
        { level: 'error' },
      )
      throw e
    }
    logForDebugging(
      `FileHistory: hard link failed (${code}), falling back to copy: ${oldBackupPath} -> ${newBackupPath}`,
      { level: 'error' },
    )
    try {
      await copyFileVerifiedAtomic(oldBackupPath, newBackupPath, srcStats.size)
    } catch (copyError: unknown) {
      const copyCode = getErrnoCode(copyError)
      if (
        copyCode !== undefined &&
        RETRYABLE_RENAME_ERRNO_CODES.has(copyCode)
      ) {
        logForDebugging(
          `FileHistory: could not move the copied backup ${backupFileName} into place — rename still refused (${copyCode}) after about 1.5 s of retries, likely held by another process; backup not migrated, a rewind to this checkpoint will report it missing`,
          { level: 'error' },
        )
      }
      logError(
        new Error(
          `FileHistory: Error copying over backup from previous session`,
        ),
      )
      throw copyError
    }
  }

  logForDebugging(
    `FileHistory: Copied backup ${backupFileName} from session ${previousSessionId} to ${sessionId}`,
  )
}

/**
 * Notifies VSCode about files that have changed between snapshots.
 * Compares the previous snapshot with the new snapshot and sends file_updated
 * notifications for any files whose content has changed.
 * Fire-and-forget (void-dispatched from fileHistoryMakeSnapshot).
 */
async function notifyVscodeSnapshotFilesUpdated(
  oldState: FileHistoryState,
  newState: FileHistoryState,
): Promise<void> {
  const oldSnapshot = oldState.snapshots.at(-1)
  const newSnapshot = newState.snapshots.at(-1)

  if (!newSnapshot) {
    return
  }

  for (const trackingPath of newState.trackedFiles) {
    const filePath = maybeExpandFilePath(trackingPath)
    const oldBackup = oldSnapshot?.trackedFileBackups[trackingPath]
    const newBackup = newSnapshot.trackedFileBackups[trackingPath]

    // Skip if both backups reference the same version (no change)
    if (
      oldBackup?.backupFileName === newBackup?.backupFileName &&
      oldBackup?.version === newBackup?.version
    ) {
      continue
    }

    // Get old content from the previous backup
    let oldContent: string | null = null
    if (oldBackup?.backupFileName) {
      const backupPath = resolveBackupPath(oldBackup.backupFileName)
      oldContent = await readFileAsyncOrNull(backupPath)
    }

    // Get new content from the new backup or current file
    let newContent: string | null = null
    if (newBackup?.backupFileName) {
      const backupPath = resolveBackupPath(newBackup.backupFileName)
      newContent = await readFileAsyncOrNull(backupPath)
    }
    // If newBackup?.backupFileName === null, the file was deleted; newContent stays null.

    // Only notify if content actually changed
    if (oldContent !== newContent) {
      notifyVscodeFileUpdated(filePath, oldContent, newContent)
    }
  }
}

/** Async read that swallows all errors and returns null (best-effort). */
async function readFileAsyncOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

const ENABLE_DUMP_STATE = false
function maybeDumpStateForDebug(state: FileHistoryState): void {
  if (ENABLE_DUMP_STATE) {
    console.error(inspect(state, false, 5))
  }
}
