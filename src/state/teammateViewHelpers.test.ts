import { describe, expect, test } from 'bun:test'
import { exitTeammateView, enterTeammateView } from './teammateViewHelpers.js'
import type { AppState } from './AppState.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'

// CC 2.1.218 #4 — "Esc in the agent view returns to the conversation it
// backgrounded" (not discard).
//
// exitTeammateView is the pure state-transition called when Esc fires in
// viewing-agent mode (useBackgroundTaskNavigation). It must:
//   1. Return to the leader's view (viewSelectionMode='none',
//      viewingAgentTaskId=undefined) — the "conversation it backgrounded."
//   2. NOT kill the agent — the task stays alive (status unchanged,
//      abortController untouched) so the backgrounded conversation is
//      preserved, not discarded.
//   3. Release retain + clear in-memory messages (cache eviction, not
//      conversation discard — the sidechain JSONL persists on disk).
//   4. Schedule eviction (evictAfter) for terminal tasks so the row
//      lingers briefly then disappears.
//
// Tests cover the DECISION LOGIC (state transitions), not visual render.

/** Minimal LocalAgentTaskState factory for tests. */
function makeLocalAgentTask(
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id: 'task-1',
    type: 'local_agent',
    status: 'running',
    description: 'test agent',
    startTime: 1000,
    outputFile: '/tmp/out',
    outputOffset: 0,
    notified: false,
    agentId: 'agent-1',
    prompt: 'do work',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: false,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } as unknown as LocalAgentTaskState
}

/** Minimal AppState factory — only the fields exitTeammateView/enterTeammateView touch. */
function makeAppState(
  overrides: {
    viewingAgentTaskId?: string
    viewSelectionMode?: AppState['viewSelectionMode']
    tasks?: Record<string, LocalAgentTaskState>
  } = {},
): AppState {
  return {
    viewingAgentTaskId: overrides.viewingAgentTaskId,
    viewSelectionMode: overrides.viewSelectionMode ?? 'none',
    tasks: overrides.tasks ?? {},
  } as unknown as AppState
}

/** Run a helper against a mutable state snapshot and return the result. */
function runWithState<T>(
  initial: AppState,
  fn: (set: (updater: (prev: AppState) => AppState) => void) => T,
): { state: AppState; result: T } {
  let state = initial
  const setAppState = (updater: (prev: AppState) => AppState) => {
    state = updater(state)
  }
  const result = fn(setAppState)
  return { state, result }
}

describe('exitTeammateView — Esc in agent view returns to backgrounded conversation (218#4)', () => {
  test('returns to leader view: viewSelectionMode → none, viewingAgentTaskId → undefined', () => {
    // Arrange — user is viewing a running teammate
    const task = makeLocalAgentTask({ retain: true, status: 'running' })
    const initial = makeAppState({
      viewingAgentTaskId: 'task-1',
      viewSelectionMode: 'viewing-agent',
      tasks: { 'task-1': task },
    })

    // Act — Esc fires, exitTeammateView transitions state
    const { state } = runWithState(initial, set => {
      exitTeammateView(set)
    })

    // Assert — returned to the leader's (backgrounded) conversation
    expect(state.viewSelectionMode).toBe('none')
    expect(state.viewingAgentTaskId).toBeUndefined()
  })

  test('does NOT kill a running agent — status stays running, abortController untouched', () => {
    // Arrange — running teammate with retain
    const abort = new AbortController()
    const task = makeLocalAgentTask({
      retain: true,
      status: 'running',
      abortController: abort,
    })
    const initial = makeAppState({
      viewingAgentTaskId: 'task-1',
      viewSelectionMode: 'viewing-agent',
      tasks: { 'task-1': task },
    })

    // Act
    const { state } = runWithState(initial, set => {
      exitTeammateView(set)
    })

    // Assert — the agent stays alive; only the view changed
    const taskAfter = state.tasks['task-1']
    expect(taskAfter.status).toBe('running')
    expect(taskAfter.abortController).toBe(abort)
    expect(taskAfter.retain).toBe(false)
  })

  test('clears in-memory messages (cache eviction) but preserves the task row', () => {
    // Arrange — running teammate with loaded messages
    const task = makeLocalAgentTask({
      retain: true,
      status: 'running',
      messages: [{ role: 'assistant', content: [] }] as never,
      diskLoaded: true,
    })
    const initial = makeAppState({
      viewingAgentTaskId: 'task-1',
      viewSelectionMode: 'viewing-agent',
      tasks: { 'task-1': task },
    })

    // Act
    const { state } = runWithState(initial, set => {
      exitTeammateView(set)
    })

    // Assert — messages cleared from memory (disk persists), task still in tasks dict
    const taskAfter = state.tasks['task-1']
    expect(taskAfter.messages).toBeUndefined()
    expect(taskAfter.diskLoaded).toBe(false)
    expect(state.tasks['task-1']).toBeDefined()
  })

  test('schedules eviction (evictAfter) for terminal tasks, not running ones', () => {
    // Arrange — completed teammate
    const completedTask = makeLocalAgentTask({
      retain: true,
      status: 'completed',
    })
    const runningTask = makeLocalAgentTask({
      id: 'task-running',
      retain: true,
      status: 'running',
    })
    const initial = makeAppState({
      viewingAgentTaskId: 'task-1',
      viewSelectionMode: 'viewing-agent',
      tasks: { 'task-1': completedTask, 'task-running': runningTask },
    })

    // Act
    const { state } = runWithState(initial, set => {
      exitTeammateView(set)
    })

    // Assert — terminal task gets evictAfter; running task does not
    expect(state.tasks['task-1'].evictAfter).toBeDefined()
    expect(state.tasks['task-1'].evictAfter).toBeGreaterThan(0)
    // Running task is untouched (not the viewed one)
    expect(state.tasks['task-running'].evictAfter).toBeUndefined()
  })

  test('no-op when not viewing any agent (viewSelectionMode already none)', () => {
    // Arrange — already in leader view
    const initial = makeAppState({
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none',
      tasks: {},
    })

    // Act
    const { state } = runWithState(initial, set => {
      exitTeammateView(set)
    })

    // Assert — state unchanged (no crash, no spurious mutations)
    expect(state.viewSelectionMode).toBe('none')
    expect(state.viewingAgentTaskId).toBeUndefined()
  })

  test('task with no retain: clears view state without touching the task', () => {
    // Arrange — viewing a task that lost retain (e.g. already released)
    const task = makeLocalAgentTask({ retain: false, status: 'running' })
    const initial = makeAppState({
      viewingAgentTaskId: 'task-1',
      viewSelectionMode: 'viewing-agent',
      tasks: { 'task-1': task },
    })

    // Act
    const { state } = runWithState(initial, set => {
      exitTeammateView(set)
    })

    // Assert — view cleared, task untouched (no retain to release)
    expect(state.viewSelectionMode).toBe('none')
    expect(state.viewingAgentTaskId).toBeUndefined()
    // Task identity preserved — no new object created (no retain → no release)
    expect(state.tasks['task-1']).toBe(task)
  })

  test('preserves the leader conversation (other tasks untouched)', () => {
    // Arrange — viewing teammate, leader has another task running
    const viewedTask = makeLocalAgentTask({ retain: true, status: 'running' })
    const otherTask = makeLocalAgentTask({
      id: 'task-other',
      retain: false,
      status: 'running',
    })
    const initial = makeAppState({
      viewingAgentTaskId: 'task-1',
      viewSelectionMode: 'viewing-agent',
      tasks: { 'task-1': viewedTask, 'task-other': otherTask },
    })

    // Act
    const { state } = runWithState(initial, set => {
      exitTeammateView(set)
    })

    // Assert — the "conversation it backgrounded" (leader + other tasks) is intact
    expect(state.tasks['task-other']).toBe(otherTask)
    expect(Object.keys(state.tasks)).toContain('task-1')
    expect(Object.keys(state.tasks)).toContain('task-other')
  })
})

describe('enterTeammateView — backgrounds the leader conversation (218#4)', () => {
  test('enters agent view: sets viewingAgentTaskId + viewing-agent mode, retains task', () => {
    // Arrange — leader view, a running agent exists
    const task = makeLocalAgentTask({ retain: false, status: 'running' })
    const initial = makeAppState({
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none',
      tasks: { 'task-1': task },
    })

    // Act
    const { state } = runWithState(initial, set => {
      enterTeammateView('task-1', set)
    })

    // Assert — now viewing the agent (leader conversation is backgrounded, not discarded)
    expect(state.viewSelectionMode).toBe('viewing-agent')
    expect(state.viewingAgentTaskId).toBe('task-1')
    expect(state.tasks['task-1'].retain).toBe(true)
    expect(state.tasks['task-1'].evictAfter).toBeUndefined()
  })

  test('enter then exit round-trip: returns to the exact leader view', () => {
    // Arrange — start in leader view with a running agent
    const task = makeLocalAgentTask({ retain: false, status: 'running' })
    const initial = makeAppState({
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none',
      tasks: { 'task-1': task },
    })

    // Act — enter agent view, then Esc back out
    const { state } = runWithState(initial, set => {
      enterTeammateView('task-1', set)
      exitTeammateView(set)
    })

    // Assert — back to leader view, agent released but alive
    expect(state.viewSelectionMode).toBe('none')
    expect(state.viewingAgentTaskId).toBeUndefined()
    expect(state.tasks['task-1'].status).toBe('running')
    expect(state.tasks['task-1'].retain).toBe(false)
  })
})
