import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AppState } from '../../../state/AppState.js'
import {
  clearCommandQueue,
  getCommandQueueSnapshot,
} from '../../../utils/messageQueueManager.js'
import type { TaskState } from '../../types.js'
import {
  enqueueAgentNotification,
  type LocalAgentTaskState,
} from '../LocalAgentTask.tsx'

/**
 * CC 2.1.299 #123: "Fixed background subagents in auto mode sometimes sending
 * their final report twice, once as the result and once as a message."
 *
 * Triage verdict for OCC: the official fix lives in the auto-mode handback
 * machinery (result-vs-message dual delivery), which OCC does not have — OCC
 * delivers a completed background agent's report through exactly one channel:
 * `enqueueAgentNotification` → one `<task-notification>` queue entry. The
 * double-delivery guard is the atomic `notified` check-and-set inside
 * `updateTaskState` (LocalAgentTask.tsx): the second call for the same task
 * sees `notified: true` and returns without enqueueing.
 *
 * This file is the regression test for that guard: a completion in auto mode
 * (backgrounded task, finalMessage set) must produce EXACTLY ONE report in the
 * queue, even when the completion path fires twice (e.g. result delivery and a
 * later status sweep both calling enqueueAgentNotification for the same task).
 */

function makeAgentTask(
  taskId: string,
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id: taskId,
    type: 'local_agent',
    status: 'completed',
    description: 'test agent',
    startTime: Date.now(),
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
    ...overrides,
  }
}

function makeHarness(taskIds: string[]) {
  const tasks: Record<string, TaskState> = {}
  for (const id of taskIds) {
    tasks[id] = makeAgentTask(id)
  }
  let state = {
    tasks,
    // abortSpeculation reads prev.speculation.status — idle short-circuits.
    speculation: { status: 'idle' },
  } as unknown as AppState
  const setAppState = (fn: (prev: AppState) => AppState) => {
    state = fn(state)
  }
  return {
    setAppState,
    getTask: (id: string) => state.tasks[id] as LocalAgentTaskState,
  }
}

function notifyArgs(taskId: string) {
  return {
    taskId,
    description: 'test agent',
    status: 'completed' as const,
    finalMessage: 'the final report',
    usage: { totalTokens: 42, toolUses: 3, durationMs: 1000 },
  }
}

function taskNotifications(): Array<{ value: string }> {
  return getCommandQueueSnapshot()
    .filter(entry => entry.mode === 'task-notification')
    .map(entry => ({ value: entry.value as string }))
}

describe('CC 2.1.299 #123: background subagent final report delivered exactly once', () => {
  beforeEach(() => {
    clearCommandQueue()
  })

  afterEach(() => {
    clearCommandQueue()
  })

  test('completion in auto mode → exactly one report in the queue', () => {
    const { setAppState } = makeHarness(['agent-1'])

    enqueueAgentNotification({ ...notifyArgs('agent-1'), setAppState })

    const notifications = taskNotifications()
    expect(notifications).toHaveLength(1)
    // The single report carries the final message exactly once — not
    // duplicated as both a "result" and a "message".
    expect(notifications[0]!.value.split('<result>the final report</result>')).toHaveLength(2)
    expect(notifications[0]!.value).toContain('<status>completed</status>')
  })

  test('double completion delivery for the same task → still exactly one report', () => {
    const { setAppState, getTask } = makeHarness(['agent-1'])

    // Simulate the 2.1.299 #123 failure mode: the completion path fires twice
    // for the same finished agent (once as the result, once as a message).
    enqueueAgentNotification({ ...notifyArgs('agent-1'), setAppState })
    enqueueAgentNotification({ ...notifyArgs('agent-1'), setAppState })

    const notifications = taskNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.value.split('<result>the final report</result>')).toHaveLength(2)
    // The dedupe guard is the atomic notified flag flip.
    expect(getTask('agent-1').notified).toBe(true)
  })

  test('a task already marked notified (e.g. by TaskStop) enqueues nothing', () => {
    const tasks: Record<string, TaskState> = {
      'agent-1': makeAgentTask('agent-1', { notified: true }),
    }
    let state = {
      tasks,
      speculation: { status: 'idle' },
    } as unknown as AppState
    const setAppState = (fn: (prev: AppState) => AppState) => {
      state = fn(state)
    }

    enqueueAgentNotification({ ...notifyArgs('agent-1'), setAppState })

    expect(taskNotifications()).toHaveLength(0)
  })

  test('dedupe is per-task: two different agents each deliver one report', () => {
    const { setAppState } = makeHarness(['agent-1', 'agent-2'])

    enqueueAgentNotification({ ...notifyArgs('agent-1'), setAppState })
    enqueueAgentNotification({ ...notifyArgs('agent-2'), setAppState })
    // Duplicate attempts for both — queue must stay at one entry per task.
    enqueueAgentNotification({ ...notifyArgs('agent-1'), setAppState })
    enqueueAgentNotification({ ...notifyArgs('agent-2'), setAppState })

    const notifications = taskNotifications()
    expect(notifications).toHaveLength(2)
    expect(notifications.filter(n => n.value.includes('<task-id>agent-1</task-id>'))).toHaveLength(1)
    expect(notifications.filter(n => n.value.includes('<task-id>agent-2</task-id>'))).toHaveLength(1)
  })
})
