import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

// Mock tree-kill BEFORE importing killShellTasks (backgroundShellStop pattern)
let treeKillCalls: Array<{ pid: number; signal: string }> = []
mock.module('tree-kill', () => {
  const fn = (pid: number, signal?: string) => {
    treeKillCalls.push({ pid, signal: signal ?? 'SIGKILL' })
  }
  return { default: fn, __esModule: true }
})

const { killTask } = await import('../killShellTasks.js')
import type { LocalShellTaskState } from '../guards.js'
import type { AppState } from '../../../state/AppState.js'
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  appendTaskOutput,
  evictTaskOutput,
  getTaskOutputPath,
} from '../../../utils/task/diskOutput.js'

/**
 * CC 2.1.301 #39 — killed background shell tasks must close their output
 * file with the `\n[killed]\n` trailer (official bWn @222257169:
 * `if(n==="killed")i.appendTrailer("\n[killed]\n","killed")`).
 *
 * v300 wrote the trailer only on the non-adopted path; OCC wrote NO trailer
 * at all — killTask went straight from the state update to
 * `void evictTaskOutput(taskId)`. The trailer must be appended BEFORE the
 * eviction so it lands in the file readers (BashOutput tail, user `cat`)
 * see.
 */

let taskCounter = 0
function freshTaskId(): string {
  taskCounter += 1
  return `kill-trailer-301-${taskCounter}`
}

function makeRunningTask(taskId: string): LocalShellTaskState {
  return {
    id: taskId,
    type: 'local_bash',
    status: 'running',
    description: 'test command',
    command: 'sleep 30',
    startTime: Date.now(),
    outputFile: '',
    outputOffset: 0,
    notified: false,
    completionStatusSentInAttachment: false,
    shellCommand: {
      kill: () => {},
      cleanup: () => {},
      status: 'running' as const,
      result: Promise.resolve({ code: 0, interrupted: false }),
      onTimeout: undefined,
      background: () => false,
    } as any,
    pid: 424242,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
  }
}

function makeSetAppState(tasks: Record<string, any>) {
  return ((fn: (prev: AppState) => AppState) => {
    const prev = { tasks } as any
    const next = fn(prev)
    Object.assign(tasks, next.tasks)
  }) as any
}

beforeEach(() => {
  treeKillCalls = []
  _resetTaskOutputDirForTest()
})

afterEach(async () => {
  await _clearOutputsForTest()
  _resetTaskOutputDirForTest()
})

describe('CC 2.1.301 #39: killTask writes the [killed] trailer', () => {
  test('killing a running task appends "\\n[killed]\\n" before eviction', async () => {
    const taskId = freshTaskId()
    appendTaskOutput(taskId, 'streaming line 1\nstreaming line 2')

    const tasks: Record<string, any> = { [taskId]: makeRunningTask(taskId) }
    killTask(taskId, makeSetAppState(tasks))

    expect(tasks[taskId].status).toBe('killed')

    // killTask fires `void evictTaskOutput`; awaiting a second (idempotent)
    // evict deterministically joins the same flush before we read the file.
    await evictTaskOutput(taskId)

    const content = readFileSync(getTaskOutputPath(taskId), 'utf8')
    expect(content).toBe('streaming line 1\nstreaming line 2\n[killed]\n')
  })

  test('killTask via the treeKill fallback (null shellCommand) also writes the trailer', async () => {
    const taskId = freshTaskId()
    appendTaskOutput(taskId, 'orphan output')

    const task = makeRunningTask(taskId)
    task.shellCommand = null
    const tasks: Record<string, any> = { [taskId]: task }
    killTask(taskId, makeSetAppState(tasks))

    expect(treeKillCalls.length).toBe(1)
    await evictTaskOutput(taskId)

    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe(
      'orphan output\n[killed]\n',
    )
  })

  test('no-op kill (task not running) writes no trailer and creates no file', async () => {
    const taskId = freshTaskId()
    const task = makeRunningTask(taskId)
    task.status = 'killed' // already terminal
    const tasks: Record<string, any> = { [taskId]: task }

    killTask(taskId, makeSetAppState(tasks))
    await evictTaskOutput(taskId)

    expect(existsSync(getTaskOutputPath(taskId))).toBe(false)
  })

  test('unknown task id: no trailer file is created', async () => {
    const taskId = freshTaskId()
    killTask(taskId, makeSetAppState({}))
    await evictTaskOutput(taskId)

    expect(existsSync(getTaskOutputPath(taskId))).toBe(false)
  })
})
