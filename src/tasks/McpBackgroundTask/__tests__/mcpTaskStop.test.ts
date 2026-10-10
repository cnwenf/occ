import { beforeEach, describe, expect, test } from 'bun:test'
import type { AppState } from '../../../state/AppState.js'
import { getAllTasks, getTaskByType } from '../../../tasks.js'
import {
  clearPendingNotifications,
  getPendingNotificationsSnapshot,
} from '../../../utils/messageQueueManager.js'
import {
  evictTerminalTask,
  MCP_TASK_RETENTION_MS,
} from '../../../utils/task/framework.js'
import { stopTask, StopTaskError } from '../../stopTask.js'
import {
  buildMcpTaskStoppedNotification,
  makeMcpBackgroundTask,
  McpBackgroundTask,
  type McpBackgroundTaskState,
} from '../McpBackgroundTask.js'

/**
 * Item 6 — stopping a long-running MCP tool call must inform Claude via a tool
 * result. Mirrors official Claude Code 2.1.295, where `mcp_task` is a
 * first-class task-registry entry: it is stoppable, and stopping delivers a
 * `<task-notification>` (status "killed") to the model with priority "next",
 * subject to a 30s retention window (binary `yI=30000`) before the row is
 * evicted from AppState.
 */

// --- helpers ---------------------------------------------------------------

type Tasks = Record<string, McpBackgroundTaskState>

/** Minimal AppState holder: `tasks` record + getAppState/setAppState pair. */
function makeStateHolder(initialTasks: Tasks) {
  let state = { tasks: initialTasks } as unknown as AppState
  const getAppState = () => state
  const setAppState = (fn: (prev: AppState) => AppState) => {
    state = fn(state)
  }
  return {
    getAppState,
    setAppState,
    get tasks(): Tasks {
      return (state as unknown as { tasks: Tasks }).tasks
    },
  }
}

/**
 * Fake AbortController that counts abort() calls. Returned as an object with a
 * live getter so `fake.abortCalls` reflects calls made after destructuring.
 */
function makeFakeController() {
  let abortCalls = 0
  const controller = {
    abort: () => {
      abortCalls++
    },
  } as unknown as AbortController
  return {
    controller,
    get abortCalls() {
      return abortCalls
    },
  }
}

function findTaskNotification() {
  return getPendingNotificationsSnapshot().find(
    cmd => cmd.mode === 'task-notification',
  )
}

function makeRunningTask(toolUseId = 'tu_42') {
  const fake = makeFakeController()
  const task = makeMcpBackgroundTask({
    serverName: 'srv',
    toolName: 'tool',
    toolUseId,
    abortController: fake.controller,
  })
  return { fake, task }
}

function makeTerminalTask(
  overrides: Partial<McpBackgroundTaskState> = {},
): McpBackgroundTaskState {
  const { task } = makeRunningTask('tu')
  return {
    ...task,
    status: 'killed',
    notified: true,
    endTime: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  clearPendingNotifications()
})

// --- registry --------------------------------------------------------------

describe('task registry exposes mcp_task (Item 6)', () => {
  test('getAllTasks includes McpBackgroundTask', () => {
    // Assert
    expect(getAllTasks()).toContain(McpBackgroundTask)
  })

  test("getTaskByType('mcp_task') resolves to McpBackgroundTask", () => {
    // Assert — this lookup is what makes stopTask() able to dispatch to kill()
    // instead of throwing StopTaskError('unsupported_type').
    expect(getTaskByType('mcp_task')).toBe(McpBackgroundTask)
  })
})

// --- notification format ---------------------------------------------------

describe('buildMcpTaskStoppedNotification format (official SQn/Di)', () => {
  test('emits task-id, tool-use-id, status killed, and summary when toolUseId given', () => {
    // Act
    const xml = buildMcpTaskStoppedNotification('p1', 'srv/tool', 'tu_42')

    // Assert
    expect(xml).toContain('<task-notification>')
    expect(xml).toContain('<task-id>p1</task-id>')
    expect(xml).toContain('<tool-use-id>tu_42</tool-use-id>')
    expect(xml).toContain('<status>killed</status>')
    expect(xml).toContain('Task "srv/tool" was stopped by the user')
    expect(xml).toContain('</task-notification>')
  })

  test('omits <tool-use-id> when toolUseId is not provided', () => {
    // Act
    const xml = buildMcpTaskStoppedNotification('p1', 'srv/tool')

    // Assert
    expect(xml).not.toContain('<tool-use-id>')
    expect(xml).toContain('<task-id>p1</task-id>')
  })

  test('does not invent <output-file> or <task-type> (official Di passes neither)', () => {
    // Act
    const xml = buildMcpTaskStoppedNotification('p1', 'srv/tool', 'tu_42')

    // Assert — an MCP background task has no disk transcript; the official
    // builder for this path emits only taskId/toolUseId/status/summary.
    expect(xml).not.toContain('<output-file>')
    expect(xml).not.toContain('<task-type>')
  })

  test('XML-escapes the description interpolated into the summary', () => {
    // Act
    const xml = buildMcpTaskStoppedNotification('p1', 'a<b>&c', 'tu')

    // Assert
    expect(xml).toContain('a&lt;b&gt;&amp;c')
    expect(xml).not.toContain('a<b>&c')
  })
})

// --- core stop path --------------------------------------------------------

describe('stopTask on a running mcp_task (Item 6 core)', () => {
  test('returns the stop result, aborts the controller, transitions to killed, and enqueues the tool-result notification', async () => {
    // Arrange
    const { fake, task } = makeRunningTask('tu_42')
    const holder = makeStateHolder({ [task.id]: task })

    // Act
    const result = await stopTask(task.id, {
      getAppState: holder.getAppState,
      setAppState: holder.setAppState,
    })

    // Assert — result envelope
    expect(result.taskId).toBe(task.id)
    expect(result.taskType).toBe('mcp_task')
    expect(result.command).toBe('srv/tool')

    // Assert — the backgrounded call's own controller was aborted exactly once
    expect(fake.abortCalls).toBe(1)

    // Assert — state transitioned to a terminal, notified row
    const after = holder.tasks[task.id]!
    expect(after.status).toBe('killed')
    expect(after.notified).toBe(true)
    expect(typeof after.endTime).toBe('number')
    expect(after.abortController).toBeUndefined()

    // Assert — the model is informed via a task-notification with priority next
    const note = findTaskNotification()
    expect(note).toBeDefined()
    expect(note!.priority).toBe('next')
    const value = note!.value as string
    expect(value).toContain('<task-notification>')
    expect(value).toContain(`<task-id>${task.id}</task-id>`)
    expect(value).toContain('<tool-use-id>tu_42</tool-use-id>')
    expect(value).toContain('<status>killed</status>')
    expect(value).toContain('Task "srv/tool" was stopped by the user')
  })
})

// --- already-finished ------------------------------------------------------

describe('stopping an already-finished mcp_task behaves sanely', () => {
  test('stopTask throws not_running and enqueues no notification', async () => {
    // Arrange
    const killed = makeTerminalTask()
    const holder = makeStateHolder({ [killed.id]: killed })

    // Act
    let thrown: unknown
    try {
      await stopTask(killed.id, {
        getAppState: holder.getAppState,
        setAppState: holder.setAppState,
      })
    } catch (err) {
      thrown = err
    }

    // Assert
    expect(thrown).toBeInstanceOf(StopTaskError)
    expect((thrown as StopTaskError).code).toBe('not_running')
    expect(findTaskNotification()).toBeUndefined()
  })

  test('McpBackgroundTask.kill on a non-running task is an idempotent no-op', async () => {
    // Arrange
    const fake = makeFakeController()
    const killed = makeTerminalTask({ abortController: fake.controller })
    const holder = makeStateHolder({ [killed.id]: killed })
    const before = holder.tasks[killed.id]

    // Act
    await McpBackgroundTask.kill(killed.id, holder.setAppState)

    // Assert — same reference (updater no-op skipped the write), no abort, no
    // notification. This is the double-delivery guard: a second stop, or a stop
    // racing the call's own completion, must not re-notify the model.
    expect(holder.tasks[killed.id]).toBe(before)
    expect(fake.abortCalls).toBe(0)
    expect(findTaskNotification()).toBeUndefined()
  })
})

// --- retention window ------------------------------------------------------

describe('MCP_TASK_RETENTION_MS eviction window (official yI=30000)', () => {
  test('equals 30 seconds', () => {
    expect(MCP_TASK_RETENTION_MS).toBe(30_000)
  })

  test('retains a just-stopped mcp_task whose endTime is within the window', () => {
    // Arrange
    const killed = makeTerminalTask({ endTime: Date.now() })
    const holder = makeStateHolder({ [killed.id]: killed })

    // Act
    evictTerminalTask(killed.id, holder.setAppState)

    // Assert — still present so the row stays visible while the stop
    // notification settles.
    expect(holder.tasks[killed.id]).toBeDefined()
  })

  test('evicts an mcp_task whose retention window has elapsed', () => {
    // Arrange
    const killed = makeTerminalTask({
      endTime: Date.now() - (MCP_TASK_RETENTION_MS + 1000),
    })
    const holder = makeStateHolder({ [killed.id]: killed })

    // Act
    evictTerminalTask(killed.id, holder.setAppState)

    // Assert — GC'd once the window has passed.
    expect(holder.tasks[killed.id]).toBeUndefined()
  })
})
