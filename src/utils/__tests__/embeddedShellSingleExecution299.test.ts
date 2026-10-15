import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'

// Some transitively-imported modules read MACRO.VERSION at import/call time.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.299 #112: official changelog — "custom slash command's embedded
 * shell line runs twice when a newer message interrupts during prompt
 * check". The official bug lives in its screening/re-check subsystem
 * (`screeningPending`/`screeningOwed`): an interrupt during screening
 * re-screened the same queued prompt, re-running command expansion (and with
 * it the embedded ```! cmd``` shell blocks) from the RAW content.
 *
 * OCC is structurally immune — there is no screening re-check flow:
 *
 * 1. queueProcessor.processQueueIfReady dequeues BEFORE executeInput runs
 *    (exactly-once drain) — an interrupt during processing can only enqueue
 *    the NEW message; the in-flight command is never re-drained.
 * 2. executeShellCommandsInPrompt REPLACES each executed block with its
 *    output in the returned text, so re-expanding an already-expanded prompt
 *    is a no-op (the BLOCK_PATTERN no longer matches).
 * 3. The #167 pre-expansion hook pass runs hooks only — it never re-invokes
 *    getPromptForCommand, so it adds no second expansion per submission.
 *
 * These tests pin properties 1 and 2 so a future re-check/screening port
 * cannot silently reintroduce double execution.
 */

const actualPermissions = await import('../permissions/permissions.js')
const actualBashTool = await import('../../tools/BashTool/BashTool.js')

const bashCallSpy = mock(
  async (_input: { command: string }, _ctx: unknown) => ({
    data: { stdout: 'MARKER-OUTPUT', stderr: '', interrupted: false },
  }),
)

mock.module('../permissions/permissions.js', () => ({
  ...actualPermissions,
  hasPermissionsToUseTool: async () => ({ behavior: 'allow' }),
}))
mock.module('../../tools/BashTool/BashTool.js', () => ({
  ...actualBashTool,
  BashTool: { ...actualBashTool.BashTool, call: bashCallSpy },
}))

afterAll(() => {
  mock.module('../permissions/permissions.js', () => ({
    ...actualPermissions,
  }))
  mock.module('../../tools/BashTool/BashTool.js', () => ({
    ...actualBashTool,
  }))
})

const { executeShellCommandsInPrompt } = await import(
  '../promptShellExecution.js'
)
const { enqueue, hasCommandsInQueue, resetCommandQueue } = await import(
  '../messageQueueManager.js'
)
const { processQueueIfReady } = await import('../queueProcessor.js')

const ctx = {} as ToolUseContext

describe('2.1.299 #112 — embedded shell blocks execute exactly once per invocation', () => {
  test('expansion replaces the executed block, so re-expanding the expanded prompt is a no-op', async () => {
    bashCallSpy.mockClear()
    const raw = [
      'Command summary:',
      '```!',
      'git status --short',
      '```',
      'End of summary.',
    ].join('\n')

    const expanded = await executeShellCommandsInPrompt(raw, ctx, '/test-cmd')
    expect(bashCallSpy).toHaveBeenCalledTimes(1)
    expect(expanded).toContain('MARKER-OUTPUT')
    expect(expanded).not.toContain('```!')

    // Simulate the official bug's re-check: the SAME (already-expanded)
    // prompt passes through expansion again after an interrupt. No shell
    // block survives in the expanded text, so nothing re-executes.
    const rechecked = await executeShellCommandsInPrompt(
      expanded,
      ctx,
      '/test-cmd',
    )
    expect(bashCallSpy).toHaveBeenCalledTimes(1)
    expect(rechecked).toBe(expanded)
  })

  test('inline !`cmd` markers are also consumed by the first expansion', async () => {
    bashCallSpy.mockClear()
    const raw = 'State: !`cat /tmp/state` — done'

    const expanded = await executeShellCommandsInPrompt(raw, ctx, '/test-cmd')
    expect(bashCallSpy).toHaveBeenCalledTimes(1)
    expect(expanded).toContain('MARKER-OUTPUT')

    const rechecked = await executeShellCommandsInPrompt(
      expanded,
      ctx,
      '/test-cmd',
    )
    expect(bashCallSpy).toHaveBeenCalledTimes(1)
    expect(rechecked).toBe(expanded)
  })

  test('queued command is dequeued BEFORE execution — an interrupt mid-check cannot re-drain it', () => {
    resetCommandQueue()
    enqueue({ value: '/custom-cmd', mode: 'prompt' })

    let executions = 0
    const first = processQueueIfReady({
      executeInput: async () => {
        executions++
        // Simulate the in-flight prompt check being interrupted by a newer
        // message: the drain promise is still pending here.
        await new Promise(resolve => setTimeout(resolve, 5))
      },
    })
    expect(first.processed).toBe(true)

    // Synchronous dequeue-before-execute: while the command is still in
    // flight, the queue is already empty — a re-check triggered by a newer
    // arriving message finds nothing to reprocess.
    expect(hasCommandsInQueue()).toBe(false)
    expect(executions).toBe(1)

    const second = processQueueIfReady({
      executeInput: async () => {
        executions++
      },
    })
    expect(second.processed).toBe(false)
    expect(executions).toBe(1)

    resetCommandQueue()
  })
})
