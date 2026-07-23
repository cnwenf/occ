import { test, expect, describe, mock, beforeEach } from 'bun:test'

// Mock the storage modules BEFORE importing the helper under test so the
// delete path never touches the real filesystem.
const deleteRemoteAgentMetadataCalls: string[] = []
const evictTaskOutputCalls: string[] = []
const appendDeletedSessionCalls: string[] = []
mock.module('../../../utils/sessionStorage.js', () => ({
  deleteRemoteAgentMetadata: (taskId: string) => {
    deleteRemoteAgentMetadataCalls.push(taskId)
    return Promise.resolve()
  },
  // CC 2.1.216 #14 no-resurrect: markSessionDeleted persists to disk via
  // appendDeletedSession. Provide a no-op recorder so the import resolves and
  // the tombstone-persistence side effect is observable without disk I/O.
  appendDeletedSession: (taskId: string) => {
    appendDeletedSessionCalls.push(taskId)
    return Promise.resolve()
  },
  readDeletedSessions: () => Promise.resolve([]),
}))
mock.module('../../../utils/task/diskOutput.js', () => ({
  evictTaskOutput: (taskId: string) => {
    evictTaskOutputCalls.push(taskId)
    return Promise.resolve()
  },
}))

const {
  shouldDeleteOnDoubleCtrlX,
  markSessionDeleted,
  isDeletedSession,
  clearDeletedSessions,
  deleteBackgroundSession,
  DOUBLE_CTRL_X_TIMEOUT_MS,
} = await import('../backgroundTaskDelete.js')

// Build a minimal setAppState recorder mirroring AppStateStore's
// (updater: (prev) => AppState) => void contract.
function makeStoreRecorder(initialTasks: Record<string, unknown>) {
  const state: { tasks: Record<string, unknown> } = { tasks: { ...initialTasks } }
  const setAppState = (updater: (prev: { tasks: Record<string, unknown> }) => { tasks: Record<string, unknown> }) => {
    const next = updater(state)
    if (next && typeof next === 'object') {
      state.tasks = next.tasks
    }
  }
  return { state, setAppState }
}

/**
 * CC 2.1.216 #14: pressing Ctrl+X twice in the agent list failed to delete
 * a session; deleted sessions reappeared when their background worker died.
 *
 * Two gaps:
 *  (a) Single 'x' only stops RUNNING tasks — completed/dead sessions had no
 *      removal path. Double Ctrl+X must DELETE any selected session.
 *  (b) A deleted session's sidecar metadata survived, so when the worker
 *      died and restoreRemoteAgentTasks re-scanned the sidecar, the session
 *      resurrected into the store. Deletion must mark a tombstone AND wipe
 *      the sidecar so the worker-death restore path skips it.
 */
describe('CC 2.1.216 #14: double Ctrl+X delete decision (pure)', () => {
  test('second press within timeout window => delete (true)', () => {
    expect(shouldDeleteOnDoubleCtrlX(50)).toBe(true)
    expect(shouldDeleteOnDoubleCtrlX(0)).toBe(true)
    expect(shouldDeleteOnDoubleCtrlX(DOUBLE_CTRL_X_TIMEOUT_MS)).toBe(true)
  })

  test('first press (no prior press) => stop, not delete (false)', () => {
    // A huge time-since-last simulates "no prior press" (ref defaults to 0 →
    // Date.now() - 0 is enormous, well outside the window).
    expect(shouldDeleteOnDoubleCtrlX(Number.MAX_SAFE_INTEGER)).toBe(false)
    expect(shouldDeleteOnDoubleCtrlX(DOUBLE_CTRL_X_TIMEOUT_MS + 1)).toBe(false)
  })

  test('negative time (clock skew) => false, never delete on garbage', () => {
    expect(shouldDeleteOnDoubleCtrlX(-1)).toBe(false)
  })

  test('custom timeout overrides default', () => {
    expect(shouldDeleteOnDoubleCtrlX(350, 500)).toBe(true)
    expect(shouldDeleteOnDoubleCtrlX(501, 500)).toBe(false)
  })
})

describe('CC 2.1.216 #14: deleted-session tombstone (no-resurrect)', () => {
  beforeEach(() => {
    clearDeletedSessions()
  })

  test('isDeletedSession is false before mark, true after mark', () => {
    const id = 'session-abc'
    expect(isDeletedSession(id)).toBe(false)
    markSessionDeleted(id)
    expect(isDeletedSession(id)).toBe(true)
  })

  test('clearDeletedSessions empties the tombstone set', () => {
    markSessionDeleted('a')
    markSessionDeleted('b')
    expect(isDeletedSession('a')).toBe(true)
    clearDeletedSessions()
    expect(isDeletedSession('a')).toBe(false)
    expect(isDeletedSession('b')).toBe(false)
  })

  test('isDeletedSession unknown id returns false', () => {
    expect(isDeletedSession('never-marked')).toBe(false)
  })
})

describe('CC 2.1.216 #14: deleteBackgroundSession wiring', () => {
  beforeEach(() => {
    clearDeletedSessions()
    deleteRemoteAgentMetadataCalls.length = 0
    evictTaskOutputCalls.length = 0
  })

  test('removes a remote_agent session from the store, marks tombstone, wipes sidecar + output', async () => {
    const taskId = 'remote-1'
    const initial = { [taskId]: { id: taskId, type: 'remote_agent', status: 'completed' } }
    const { state, setAppState } = makeStoreRecorder(initial)

    await deleteBackgroundSession({ id: taskId, type: 'remote_agent' }, setAppState as never)

    expect(state.tasks[taskId]).toBeUndefined()
    expect(isDeletedSession(taskId)).toBe(true)
    expect(deleteRemoteAgentMetadataCalls).toEqual([taskId])
    expect(evictTaskOutputCalls).toEqual([taskId])
  })

  test('removes a local_bash task from the store without touching remote sidecar', async () => {
    const taskId = 'shell-1'
    const initial = { [taskId]: { id: taskId, type: 'local_bash', status: 'running' } }
    const { state, setAppState } = makeStoreRecorder(initial)

    await deleteBackgroundSession({ id: taskId, type: 'local_bash' }, setAppState as never)

    expect(state.tasks[taskId]).toBeUndefined()
    expect(isDeletedSession(taskId)).toBe(true)
    // local_bash has no remote sidecar to wipe
    expect(deleteRemoteAgentMetadataCalls).toEqual([])
    expect(evictTaskOutputCalls).toEqual([taskId])
  })

  test('removes a local_agent task from the store', async () => {
    const taskId = 'agent-1'
    const initial = { [taskId]: { id: taskId, type: 'local_agent', status: 'completed' } }
    const { state, setAppState } = makeStoreRecorder(initial)

    await deleteBackgroundSession({ id: taskId, type: 'local_agent' }, setAppState as never)

    expect(state.tasks[taskId]).toBeUndefined()
    expect(isDeletedSession(taskId)).toBe(true)
    expect(evictTaskOutputCalls).toEqual([taskId])
  })

  test('does not throw when the task is already absent from the store', async () => {
    const taskId = 'gone'
    const { setAppState } = makeStoreRecorder({})

    await deleteBackgroundSession({ id: taskId, type: 'remote_agent' }, setAppState as never)

    // Still tombstones + sidecar-wipes so a future restore won't resurrect.
    expect(isDeletedSession(taskId)).toBe(true)
    expect(deleteRemoteAgentMetadataCalls).toEqual([taskId])
  })

  test('a tombstoned id is reported deleted (worker-death path skip check)', () => {
    const taskId = 'will-resurrect'
    markSessionDeleted(taskId)
    // The worker-death restore path calls isDeletedSession before re-adding.
    expect(isDeletedSession(taskId)).toBe(true)
  })
})
