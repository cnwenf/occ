/**
 * dataflow-001 + mcp_task dialog UI branch coverage.
 *
 * dataflow-001: double-Ctrl+X delete of a RUNNING mcp_task used to go through
 * deleteBackgroundSession only — the row was removed/tombstoned but kill() was
 * never called, so the backgrounded call's AbortController (and with it the
 * MCP transport) stayed alive with no way to stop it. The fix routes a
 * running mcp_task through the same kill path as single-x BEFORE deletion.
 *
 * These tests render the real dialog (interactive fake-TTY harness, same
 * PassThrough trick as elicitationDoneButton288.test.tsx) with a running
 * mcp_task backed by a fake AbortController, drive the key events, and assert
 * the abort/notify/delete outcome. The mcp_task list-view render branch
 * ("MCP tasks" section + row label) is covered on the way.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { render } from '../../../ink.js'
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
} from '../../../state/AppState.js'
import {
  makeMcpBackgroundTask,
  type McpBackgroundTaskState,
} from '../../../tasks/McpBackgroundTask/McpBackgroundTask.js'
import {
  clearPendingNotifications,
  getPendingNotificationsSnapshot,
} from '../../../utils/messageQueueManager.js'
import { BackgroundTasksDialog } from '../BackgroundTasksDialog.js'

// --- helpers ---------------------------------------------------------------

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

/** Fake AbortController that counts abort() calls (live getter). */
function makeFakeController() {
  let abortCalls = 0
  const controller = {
    abort: () => {
      abortCalls++
    },
    signal: new AbortController().signal,
  } as unknown as AbortController
  return {
    controller,
    get abortCalls() {
      return abortCalls
    },
  }
}

function makeRunningMcpTask(): {
  fake: ReturnType<typeof makeFakeController>
  task: McpBackgroundTaskState
} {
  const fake = makeFakeController()
  const task = makeMcpBackgroundTask({
    serverName: 'srv',
    toolName: 'tool',
    toolUseId: 'tu_dialog_1',
    abortController: fake.controller,
  })
  return { fake, task }
}

/**
 * Interactive render harness: fake-TTY PassThrough stdin/stdout so `write()`
 * drives Box onKeyDown. Mirrors elicitationDoneButton288.test.tsx.
 */
async function renderDialog(tasks: Record<string, McpBackgroundTaskState>) {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (enabled: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  if (typeof stdin.ref !== 'function') stdin.ref = () => {}
  if (typeof stdin.unref !== 'function') stdin.unref = () => {}

  const initialState = {
    ...getDefaultAppState(),
    tasks,
  } as unknown as AppState

  const instance = await render(
    <AppStateProvider initialState={initialState}>
      <BackgroundTasksDialog
        onDone={mock(() => {})}
        toolUseContext={{} as never}
      />
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin,
      patchConsole: false,
    },
  )
  await tick()
  return {
    text: () => stripAnsi(output),
    async write(input: string) {
      stdin.write(input)
      await tick()
      await tick()
    },
    async close() {
      instance.unmount()
      await tick()
    },
  }
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out')
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

function findTaskNotification() {
  return getPendingNotificationsSnapshot().find(
    cmd => cmd.mode === 'task-notification',
  )
}

beforeEach(() => {
  clearPendingNotifications()
})

// --- mcp_task render branch (test-bg-tasks-dialog-mcp) ----------------------

describe('BackgroundTasksDialog mcp_task list render branch', () => {
  test('renders the "MCP tasks" section with the server/tool label', async () => {
    // Arrange
    const { task } = makeRunningMcpTask()
    const view = await renderDialog({ [task.id]: task })

    try {
      // Assert — the mcp_task UI branch renders its own section + row label
      const text = view.text()
      expect(text).toContain('MCP tasks')
      expect(text).toContain('srv/tool')
    } finally {
      await view.close()
    }
  })
})

// --- dataflow-001: double-x on a RUNNING mcp_task kills before deleting -----

describe('dataflow-001: double-x delete of a running mcp_task', () => {
  test('the double-x delete of a STILL-RUNNING mcp_task aborts its controller (kill before delete)', async () => {
    // Arrange — two running mcp_tasks. Press 1 kills task A and arms the
    // double-x window; the killed row leaves the selectable list, so the
    // cursor lands on task B. Press 2 (within the 800ms window) is therefore
    // a double-press delete on B, which is STILL RUNNING — exactly the
    // deleted-but-alive transport case: deleteBackgroundSession alone would
    // remove the row without ever calling kill().
    const a = makeRunningMcpTask()
    const b = makeRunningMcpTask()
    const view = await renderDialog({
      [a.task.id]: a.task,
      [b.task.id]: b.task,
    })

    try {
      // Act
      await view.write('x') // press 1: single-x kill on A, arms the window
      await waitFor(() => a.fake.abortCalls >= 1)
      await view.write('x') // press 2: double-press delete on running B

      // Assert — B's controller was aborted by the delete path's kill
      // (revert the dataflow-001 branch and this stays 0: B is deleted
      // alive, its transport unreachable).
      await waitFor(() => b.fake.abortCalls >= 1)
      expect(b.fake.abortCalls).toBe(1)

      // Assert — B's row was deleted from the list.
      await waitFor(() => view.text().includes('MCP tasks (1)'))
    } finally {
      await view.close()
    }
  })

  test('double-x on the sole running mcp_task aborts, notifies, and deletes the row', async () => {
    // Arrange
    const { fake, task } = makeRunningMcpTask()
    const view = await renderDialog({ [task.id]: task })

    try {
      // Act — two rapid 'x' presses: first arms the window, second deletes
      await view.write('x')
      await view.write('x')

      // Assert — the kill path ran: the backgrounded call's own controller
      // was aborted exactly once (no deleted-but-alive transport).
      await waitFor(() => fake.abortCalls >= 1)
      expect(fake.abortCalls).toBe(1)

      // Assert — kill enqueued the model-facing stop notification (priority
      // next), so the model learns the task was killed.
      const note = findTaskNotification()
      expect(note).toBeDefined()
      expect(note!.priority).toBe('next')
      expect(note!.value as string).toContain('<status>killed</status>')

      // Assert — the row was then deleted from the list (delete still runs).
      // text() is cumulative across frames, so assert the empty-list frame
      // ("No tasks currently running") eventually renders rather than the
      // absence of the label.
      await waitFor(() => view.text().includes('No tasks currently running'))
      expect(view.text()).toContain('No tasks currently running')
    } finally {
      await view.close()
    }
  })

  test('single x on a running mcp_task kills WITHOUT deleting the row', async () => {
    // Arrange
    const { fake, task } = makeRunningMcpTask()
    const view = await renderDialog({ [task.id]: task })

    try {
      // Act — a single press (no prior press arms the double-x window)
      await view.write('x')
      await waitFor(() => fake.abortCalls >= 1)

      // Assert — killed, but the row stays (now terminal) so the user sees
      // the outcome; deletion only happens on the double press.
      expect(fake.abortCalls).toBe(1)
      expect(view.text()).toContain('srv/tool')
    } finally {
      await view.close()
    }
  })
})
