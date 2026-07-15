import { describe, expect, mock, test } from 'bun:test'
import type { ShellCommand } from '../../ShellCommand.js'

/**
 * #29 (2.1.208): "async hook output retained after backgrounding."
 *
 * When an async hook completes and its response is delivered (or it has no
 * stdout to deliver), the ShellCommand and its TaskOutput must be cleaned up
 * — otherwise the StreamWrapper event listeners, CircularBuffer, and
 * DiskTaskOutput handle persist for the session lifetime (a memory leak in
 * long sessions with many backgrounded async hooks).
 *
 * The fix: call shellCommand.cleanup() in the 'remove' path of
 * checkForAsyncHookResponses and in removeDeliveredAsyncHooks.
 */

// Mock hookEvents to avoid timer side effects during tests.
mock.module('../../hooks/hookEvents.js', () => ({
  startHookProgressInterval: () => () => {},
  emitHookResponse: () => {},
}))

const {
  registerPendingAsyncHook,
  removeDeliveredAsyncHooks,
  checkForAsyncHookResponses,
  clearAllAsyncHooks,
} = await import('../../hooks/AsyncHookRegistry.js')

/**
 * Create a mock ShellCommand with a spy on cleanup().
 * Uses a closure variable so the cleanup mock's call count is tracked
 * correctly (spreading a primitive would copy the value, not the reference).
 */
function createMockShellCommand(opts: {
  status?: 'running' | 'backgrounded' | 'completed' | 'killed'
  stdout?: string
  stderr?: string
  code?: number
}): { sc: ShellCommand; getCleanupCalls: () => number } {
  const cleanupMock = mock(() => {})
  const stdout = opts.stdout ?? ''
  const stderr = opts.stderr ?? ''
  const sc = {
    status: opts.status ?? 'completed',
    result: Promise.resolve({
      stdout: '',
      stderr: '',
      code: opts.code ?? 0,
      interrupted: false,
    }),
    cleanup: cleanupMock,
    kill: () => {},
    background: () => true,
    onTimeout: undefined,
    taskOutput: {
      getStdout: async () => stdout,
      getStderr: () => stderr,
      clear: () => {},
      spillToDisk: () => {},
      stdoutToFile: false,
      path: '',
      taskId: '',
      outputFileRedundant: false,
      outputFileSize: 0,
      totalLines: 0,
      totalBytes: 0,
      isOverflowed: false,
      deleteOutputFile: async () => {},
      flush: async () => {},
      writeStdout: () => {},
      writeStderr: () => {},
    },
  } as unknown as ShellCommand
  return { sc, getCleanupCalls: () => cleanupMock.mock.calls.length }
}

describe('AsyncHookRegistry cleanup (#29 — async hook output retained after backgrounding)', () => {
  test('checkForAsyncHookResponses remove-path calls shellCommand.cleanup() for hooks with no stdout', async () => {
    // Arrange: register a hook that has completed but produced no stdout.
    // This triggers the 'remove' path (responseAttachmentSent || !stdout.trim()).
    clearAllAsyncHooks()
    const { sc, getCleanupCalls } = createMockShellCommand({
      stdout: '',
      status: 'completed',
    })
    registerPendingAsyncHook({
      processId: 'test_hook_no_stdout',
      hookId: 'hook-2',
      asyncResponse: { async: true, asyncTimeout: 5000 },
      hookName: 'PreToolUse:Test',
      hookEvent: 'PreToolUse',
      command: 'echo test',
      shellCommand: sc,
    })

    // Act: poll for responses — the hook has no stdout, so it takes the 'remove' path.
    const responses = await checkForAsyncHookResponses()

    // Assert: no responses (no stdout), and cleanup() was called
    expect(responses).toHaveLength(0)
    expect(getCleanupCalls()).toBe(1)
  })

  test('checkForAsyncHookResponses response-path calls shellCommand.cleanup() via finalizeHook', async () => {
    // Arrange: register a hook that completed with stdout containing JSON.
    // This triggers the 'response' path → finalizeHook → cleanup().
    clearAllAsyncHooks()
    const { sc, getCleanupCalls } = createMockShellCommand({
      stdout: '{"ok":true}',
      status: 'completed',
    })
    registerPendingAsyncHook({
      processId: 'test_hook_with_output',
      hookId: 'hook-3',
      asyncResponse: { async: true, asyncTimeout: 5000 },
      hookName: 'PreToolUse:Test',
      hookEvent: 'PreToolUse',
      command: 'echo test',
      shellCommand: sc,
    })

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert: one response returned, cleanup() called via finalizeHook.
    expect(responses).toHaveLength(1)
    expect(getCleanupCalls()).toBe(1)
  })

  test('checkForAsyncHookResponses skip-path does NOT call cleanup() for running hooks', async () => {
    // Arrange: register a hook that is still running (not completed).
    clearAllAsyncHooks()
    const { sc, getCleanupCalls } = createMockShellCommand({
      stdout: 'partial',
      status: 'running',
    })
    registerPendingAsyncHook({
      processId: 'test_hook_running',
      hookId: 'hook-4',
      asyncResponse: { async: true, asyncTimeout: 5000 },
      hookName: 'PreToolUse:Test',
      hookEvent: 'PreToolUse',
      command: 'echo test',
      shellCommand: sc,
    })

    // Act
    const responses = await checkForAsyncHookResponses()

    // Assert: no responses (still running), cleanup() NOT called.
    expect(responses).toHaveLength(0)
    expect(getCleanupCalls()).toBe(0)

    // Cleanup
    clearAllAsyncHooks()
  })
})
