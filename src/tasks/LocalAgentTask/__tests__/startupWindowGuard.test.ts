import { test, expect, describe } from 'bun:test'
import {
  killAllRunningAgentTasks,
  killAsyncAgent,
  type LocalAgentTaskState,
} from '../LocalAgentTask.tsx'
import type { AppState } from '../../../state/AppState.js'
import type { TaskState } from '../../types.js'

/**
 * CC 2.1.216 #15: background subagents got cancelled when a high-priority
 * message arrived during their startup window — fix so startup-window
 * subagents aren't cancelled by a high-priority message.
 *
 * The fix: killAllRunningAgentTasks skips agents whose startTime is within
 * the STARTUP_WINDOW_MS window (they haven't fully initialized yet).
 * A direct killAsyncAgent(taskId) (explicit TaskStop) is NOT guarded —
 * only the bulk killAllRunningAgentTasks path is.
 */
const STARTUP_WINDOW_MS = 5000 // mirror the implementation constant

function makeAgentTask(
  taskId: string,
  startTime: number,
): [string, LocalAgentTaskState] {
  const task: LocalAgentTaskState = {
    id: taskId,
    type: 'local_agent',
    status: 'running',
    description: 'test agent',
    startTime,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    agentId: taskId,
    prompt: 'test',
    agentType: 'general-purpose',
    abortController: new AbortController(),
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }
  return [taskId, task]
}

describe('CC 2.1.216 #15: startup-window subagent cancellation guard', () => {
  test('killAllRunningAgentTasks skips agents within their startup window', () => {
    const now = Date.now()
    const [id1, task1] = makeAgentTask('agent-young', now) // just spawned
    const [id2, task2] = makeAgentTask('agent-old', now - STARTUP_WINDOW_MS - 1000) // past startup

    const tasks: Record<string, TaskState> = {
      [id1]: task1,
      [id2]: task2,
    }

    const setAppState = (fn: (prev: AppState) => AppState) => {
      const prev: AppState = { tasks } as any
      const next = fn(prev)
      Object.assign(tasks, next.tasks)
    }

    killAllRunningAgentTasks(tasks, setAppState as any)

    // Young agent should still be running (protected by startup window)
    expect(tasks[id1].status).toBe('running')
    // Old agent should be killed
    expect(tasks[id2].status).toBe('killed')
  })

  test('killAllRunningAgentTasks kills all agents when none are in startup window', () => {
    const now = Date.now()
    const [id1, task1] = makeAgentTask('agent-1', now - STARTUP_WINDOW_MS - 1)
    const [id2, task2] = makeAgentTask('agent-2', now - STARTUP_WINDOW_MS - 1)

    const tasks: Record<string, TaskState> = {
      [id1]: task1,
      [id2]: task2,
    }

    const setAppState = (fn: (prev: AppState) => AppState) => {
      const prev: AppState = { tasks } as any
      const next = fn(prev)
      Object.assign(tasks, next.tasks)
    }

    killAllRunningAgentTasks(tasks, setAppState as any)

    expect(tasks[id1].status).toBe('killed')
    expect(tasks[id2].status).toBe('killed')
  })

  test('direct killAsyncAgent is NOT guarded by startup window', () => {
    // Explicit TaskStop should always work regardless of startup window
    const now = Date.now()
    const [id, task] = makeAgentTask('agent-direct', now)

    const tasks: Record<string, TaskState> = { [id]: task }
    const setAppState = (fn: (prev: AppState) => AppState) => {
      const prev: AppState = { tasks } as any
      const next = fn(prev)
      Object.assign(tasks, next.tasks)
    }

    killAsyncAgent(id, setAppState as any)
    expect(tasks[id].status).toBe('killed')
  })
})
