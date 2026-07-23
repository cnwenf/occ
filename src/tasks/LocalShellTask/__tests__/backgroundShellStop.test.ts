import { test, expect, describe, mock, beforeEach } from 'bun:test'

// Mock tree-kill BEFORE importing killShellTasks
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

/**
 * CC 2.1.217 #12: background shells sometimes became impossible to stop
 * after a session was sent to the background (or on heavily loaded machines).
 *
 * Root cause: killTask relies on task.shellCommand?.kill(), but after
 * backgrounding, the shellCommand reference can become null (process
 * reloaded from disk, or reference lost during session transition).
 * When shellCommand is null, the kill is a silent no-op — the shell
 * process keeps running and is impossible to stop.
 *
 * Fix: store the PID in the task state as a fallback, and use treeKill
 * when shellCommand is null but a PID is available.
 */
describe('CC 2.1.217 #12: background shell stoppable after /background', () => {
  beforeEach(() => {
    treeKillCalls = []
  })

  test('killTask uses treeKill(pid) fallback when shellCommand is null', () => {
    const taskId = 'shell-orphaned'
    const fakePid = 99999
    const task: LocalShellTaskState = {
      id: taskId,
      type: 'local_bash',
      status: 'running',
      description: 'test command',
      command: 'echo hello',
      startTime: Date.now(),
      outputFile: '',
      outputOffset: 0,
      notified: false,
      completionStatusSentInAttachment: false,
      shellCommand: null, // lost reference after backgrounding
      pid: fakePid, // fallback PID
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    }

    const tasks: Record<string, any> = { [taskId]: task }
    const setAppState = (fn: (prev: AppState) => AppState) => {
      const prev = { tasks } as any
      const next = fn(prev)
      Object.assign(tasks, next.tasks)
    }

    killTask(taskId, setAppState as any)

    // treeKill should have been called with the fallback PID
    expect(treeKillCalls.length).toBe(1)
    expect(treeKillCalls[0].pid).toBe(fakePid)

    // Task should be killed
    expect(tasks[taskId].status).toBe('killed')
    expect(tasks[taskId].shellCommand).toBeNull()
  })

  test('killTask uses shellCommand.kill() when available (no treeKill fallback)', () => {
    const taskId = 'shell-active'
    let killCalled = false
    const mockShellCommand = {
      kill: () => { killCalled = true },
      cleanup: () => {},
      status: 'running' as const,
      result: Promise.resolve({ code: 0, interrupted: false }),
      onTimeout: undefined,
      background: () => false,
    }
    const task: LocalShellTaskState = {
      id: taskId,
      type: 'local_bash',
      status: 'running',
      description: 'test command',
      command: 'echo hello',
      startTime: Date.now(),
      outputFile: '',
      outputOffset: 0,
      notified: false,
      completionStatusSentInAttachment: false,
      shellCommand: mockShellCommand as any,
      pid: 12345,
      lastReportedTotalLines: 0,
      isBackgrounded: false,
    }

    const tasks: Record<string, any> = { [taskId]: task }
    const setAppState = (fn: (prev: AppState) => AppState) => {
      const prev = { tasks } as any
      const next = fn(prev)
      Object.assign(tasks, next.tasks)
    }

    killTask(taskId, setAppState as any)

    // shellCommand.kill() was called
    expect(killCalled).toBe(true)
    // treeKill fallback NOT used (shellCommand was available)
    expect(treeKillCalls.length).toBe(0)

    expect(tasks[taskId].status).toBe('killed')
  })

  test('killTask is no-op for already-killed tasks (no treeKill)', () => {
    const taskId = 'shell-done'
    const task: LocalShellTaskState = {
      id: taskId,
      type: 'local_bash',
      status: 'killed',
      description: 'test command',
      command: 'echo hello',
      startTime: Date.now(),
      outputFile: '',
      outputOffset: 0,
      notified: false,
      completionStatusSentInAttachment: false,
      shellCommand: null,
      pid: 99999,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    }

    const tasks: Record<string, any> = { [taskId]: task }
    const setAppState = (fn: (prev: AppState) => AppState) => {
      const prev = { tasks } as any
      const next = fn(prev)
      Object.assign(tasks, next.tasks)
    }

    killTask(taskId, setAppState as any)
    expect(tasks[taskId].status).toBe('killed')
    expect(treeKillCalls.length).toBe(0)
  })
})
