/**
 * CC 2.1.216 #14: pressing Ctrl+X twice in the agent list failed to DELETE
 * a session (single 'x' only STOPs running tasks), and deleted sessions
 * reappeared when their background worker died because the sidecar metadata
 * survived and the worker-death restore path re-registered them.
 *
 * This module holds the pure decision logic + tombstone store so it can be
 * unit-tested in isolation (the dialog component delegates here). Kept
 * framework-free: no React imports, no AppState type coupling — the dialog
 * passes the store updater callback.
 */

import { logForDebugging } from '../../utils/debug.js'
import {
  appendDeletedSession,
  deleteRemoteAgentMetadata,
  readDeletedSessions,
} from '../../utils/sessionStorage.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'

/** Double-Ctrl+X window. Matches useDoublePress's DOUBLE_PRESS_TIMEOUT_MS. */
export const DOUBLE_CTRL_X_TIMEOUT_MS = 800

/**
 * Pure decision: given the milliseconds since the previous Ctrl+X press,
 * should THIS press be treated as the SECOND (delete) press?
 *
 * - First press (ref default 0 → enormous elapsed): false → stop, not delete.
 * - Second press within the window: true → delete.
 * - Negative elapsed (clock skew / ref reset to 0 mid-press): false — never
 *   delete on garbage.
 */
export function shouldDeleteOnDoubleCtrlX(
  timeSinceLastPressMs: number,
  timeoutMs: number = DOUBLE_CTRL_X_TIMEOUT_MS,
): boolean {
  return timeSinceLastPressMs >= 0 && timeSinceLastPressMs <= timeoutMs
}

/**
 * Tombstone of sessions the user has explicitly deleted. The worker-death
 * restore path (restoreRemoteAgentTasks) reads sidecar metadata and re-adds
 * sessions; once a user has deleted a session we must NEVER re-add it, so
 * deleteBackgroundSession both wipes the sidecar AND marks the id here. A
 * future restore pass that calls isDeletedSession(id) before registerTask
 * will skip even if a stray sidecar reappears (e.g. raced write).
 */
const deletedSessions = new Set<string>()

export function markSessionDeleted(taskId: string): void {
  deletedSessions.add(taskId)
  // CC 2.1.216 #14 no-resurrect: persist to disk so a client restart still
  // skips this session. Failure must be observable (no silent swallow) — the
  // in-memory Set is the hot-path guard, but the disk list is the restart
  // backstop read by loadDeletedSessionsFromDisk on the next client lifetime.
  void appendDeletedSession(taskId).catch((e) => {
    logForDebugging(
      `markSessionDeleted: failed to persist tombstone for ${taskId}: ${String(e)}`,
    )
  })
}

export function isDeletedSession(taskId: string): boolean {
  return deletedSessions.has(taskId)
}

export function clearDeletedSessions(): void {
  deletedSessions.clear()
}

/**
 * Hydrate the in-memory tombstone Set from the disk list. Called by the
 * worker-death / client-restart restore path (restoreRemoteAgentTasks) before
 * any registerTask, so sessions deleted in a prior client lifetime are skipped
 * even though the in-memory Set was cleared by the restart. The disk list is
 * the source of truth across restarts; the Set is the fast in-process check.
 */
export async function loadDeletedSessionsFromDisk(): Promise<void> {
  const ids = await readDeletedSessions()
  for (const id of ids) {
    deletedSessions.add(id)
  }
}

/**
 * Minimal task reference the dialog hands to the deleter. `type` is the
 * BackgroundTaskState `type` discriminator ('remote_agent' | 'local_bash'
 * | 'local_agent' | ...). The dialog's ListItem union carries these plus
 * a synthetic 'leader' entry which is NOT deletable — the dialog must not
 * call this for leader items.
 */
export type DeletableSessionRef = {
  id: string
  type: string
}

/**
 * Delete a background session from the in-memory store, mark it tombstoned,
 * and wipe any persistent sidecar/output so the worker-death restore path
 * cannot resurrect it.
 *
 * Store update mirrors `unregisterTask`: spread tasks without the deleted id.
 * `setAppState` follows the AppStateStore `(updater: (prev) => AppState)
 * => void` contract; typed loosely here to avoid pulling AppState's heavy
 * type graph into this testable module.
 */
export async function deleteBackgroundSession(
  task: DeletableSessionRef,
  setAppState: (updater: (prev: { tasks: Record<string, unknown> }) => { tasks: Record<string, unknown> }) => void,
): Promise<void> {
  const { id, type } = task

  // 1. Remove from the in-memory store so it vanishes from the dialog.
  setAppState(prev => {
    if (!prev.tasks || !(id in prev.tasks)) {
      // Already absent — return prev unchanged so subscribers don't re-render.
      return prev
    }
    const nextTasks: Record<string, unknown> = {}
    for (const key of Object.keys(prev.tasks)) {
      if (key !== id) {
        nextTasks[key] = prev.tasks[key]
      }
    }
    return { ...prev, tasks: nextTasks }
  })

  // 2. Tombstone so the worker-death restore path skips this id even if a
  //    sidecar reappears.
  markSessionDeleted(id)

  // 3. Evict on-disk task output (logs) — applies to every task type.
  //    Best-effort: eviction failure must not crash the dialog, but it must
  //    be observable (logged), not silently swallowed — the no-resurrect
  //    guard's failure modes must surface.
  void evictTaskOutput(id).catch((e) => {
    logForDebugging(
      `deleteBackgroundSession: output eviction failed for ${id}: ${String(e)}`,
    )
  })

  // 4. Wipe the remote-agent sidecar so restoreRemoteAgentTasks does not
  //    re-register the session on the next worker-death/client-restart scan.
  //    Only remote_agent sessions carry a sidecar. The tombstone (step 2 +
  //    the disk list) keeps the session skipped even if this unlink fails,
  //    but a failed unlink must NOT be silently swallowed — log it so the
  //    no-resurrect guard's failure is observable.
  if (type === 'remote_agent') {
    void deleteRemoteAgentMetadata(id).catch((e) => {
      logForDebugging(
        `deleteBackgroundSession: sidecar unlink failed for ${id}: ${String(e)}`,
      )
    })
  }
}
