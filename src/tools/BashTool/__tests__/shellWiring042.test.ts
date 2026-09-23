import { beforeEach, describe, expect, test } from 'bun:test'
import {
  findNotification,
  findSnapshot,
  isTerminal,
  makeHarness,
  makeToolContext,
  waitFor,
} from '../../../tasks/LocalShellTask/__tests__/shellWiringHarness042.js'
import { backgroundExistingForegroundTask } from '../../../tasks/LocalShellTask/LocalShellTask.js'
import {
  clearCommandQueue,
  getCommandQueueSnapshot,
} from '../../../utils/messageQueueManager.js'
import { BashTool } from '../BashTool.js'

/**
 * 2.1.280 #042 WIRING-LEVEL regression tests (acceptance defect #042).
 *
 * The classifier unit tests (shellTaskResult042.test.ts) call
 * `classifyShellTaskResult` with hand-built fixtures — they passed even when
 * NO production caller passed `task.shell`, making the per-shell dispatch arm
 * dead code. These tests instead enter through the PRODUCTION entry point
 * `BashTool.call()` with REAL processes (no module mocks) and assert on what
 * the real `spawnShellTask` / `registerForeground` persist into AppState and
 * how the real result handler classifies the terminal exit:
 *
 *   Test 1 — spawnBackgroundTask call site (BashTool.tsx `shell: 'bash'`):
 *            run_in_background + `grep ... /dev/null` (real exit 1, benign per
 *            the bash interpreter table) must end `completed` with the
 *            "No matches found" exitNote in the <task-notification>.
 *   Test 2 — registerForeground call site (BashTool.tsx `shell: 'bash'`):
 *            a foreground command running past PROGRESS_THRESHOLD_MS (2s)
 *            registers a foreground task whose persisted state carries
 *            `shell: 'bash'`.
 *   Test 3 — backgroundExistingForegroundTask re-classification: backgrounding
 *            a registered foreground task whose command exits 1 benignly
 *            (`;`-joined grep) classifies from the PERSISTED state →
 *            `completed`, not `failed`.
 *
 * Mutation coverage (each mutation makes at least one assertion fail):
 *   (a) drop `shell: 'bash'` from either BashTool call site → persisted
 *       `taskState.shell` undefined → strict `code===0` fallback → status
 *       'failed' (Tests 1/3) and the direct `shell` assertions (Test 2).
 *   (b) drop the conditional-spread persistence in LocalShellTask.tsx →
 *       same observable effect as (a).
 *   (c) drop the per-shell dispatch in classifyShellTaskResult → benign exit 1
 *       classified strict → 'failed' + no exitNote (Tests 1/3).
 */

const BENIGN_GREP = 'grep zzz_no_match_042 /dev/null'

describe('2.1.280 #042 wiring: BashTool spawnBackgroundTask passes shell:"bash"', () => {
  beforeEach(() => {
    clearCommandQueue()
  })

  test('run_in_background grep exit 1 persists shell:"bash" and completes with the benign exitNote', async () => {
    // Arrange — real BashTool production context with a fake AppState channel.
    const harness = makeHarness()
    const context = makeToolContext(harness, { toolUseId: 'tu-042-spawn' })

    // Act — enter through the production caller (BashTool.call →
    // runShellCommand → spawnBackgroundTask → spawnShellTask).
    const { data } = await (BashTool as any).call(
      { command: BENIGN_GREP, run_in_background: true },
      context,
    )

    // Assert — the tool surfaced a background task id.
    const taskId = data.backgroundTaskId as string
    expect(taskId).toBeTruthy()

    // The spawn persisted `shell: 'bash'` on the task state (kills mutant (a1)
    // at the call site and mutant (b) at the persistence spread).
    expect(harness.getState().tasks[taskId].shell).toBe('bash')
    expect(harness.getState().tasks[taskId].isBackgrounded).toBe(true)

    // Wait for the real result handler (shellCommand.result.then →
    // classifyShellTaskResult(result, task) → updateTaskState).
    await waitFor(
      () => isTerminal(harness.getState().tasks[taskId]),
      8000,
      'background grep task reaches terminal status',
    )

    // Per-shell benign-exit semantics were applied: grep exit 1 is
    // "No matches found" → completed (kills mutants (a1), (b), (c) — the
    // strict fallback would report 'failed' for exit code 1).
    const task = harness.getState().tasks[taskId]
    expect(task.status).toBe('completed')
    expect(task.result).toEqual({ code: 1, interrupted: false })

    // The completion notification carries the classifier's exitNote
    // (official h$e: `(exit code 1: No matches found)`).
    const notification = findNotification(getCommandQueueSnapshot(), taskId)
    expect(notification).toBeDefined()
    expect(notification).toContain('<status>completed</status>')
    expect(notification).toContain('No matches found')
  }, 9500)
})

describe('2.1.280 #042 wiring: BashTool registerForeground passes shell:"bash"', () => {
  beforeEach(() => {
    clearCommandQueue()
  })

  test('foreground command past the 2s threshold registers with shell:"bash" persisted', async () => {
    // Arrange — setToolJSX stub: the progress loop only registers the
    // foreground task when a JSX channel is available (Ctrl+B hint branch).
    const harness = makeHarness()
    const jsxCalls: unknown[] = []
    const context = makeToolContext(harness, {
      toolUseId: 'tu-042-fg',
      setToolJSX: (v: unknown) => {
        jsxCalls.push(v)
      },
    })

    // Act — real `sleep 4`: completes past PROGRESS_THRESHOLD_MS (2000ms) so
    // the poller-driven progress loop hits the registerForeground branch.
    await (BashTool as any).call({ command: 'sleep 4' }, context)

    // Assert — the registration branch really ran (BackgroundHint rendered),
    // so the shell assertion below cannot pass vacuously.
    expect(jsxCalls.some(v => v !== null)).toBe(true)

    // registerForeground persisted `shell: 'bash'` on the foreground task
    // state (kills mutant (a2) at the registerForeground call site and
    // mutant (b) at the persistence spread). unregisterForeground removes the
    // task on completion, so read from the captured write history.
    const registered = findSnapshot(
      harness.history,
      task =>
        task.command === 'sleep 4' &&
        task.isBackgrounded === false &&
        task.status === 'running',
    )
    expect(registered).toBeDefined()
    expect(registered!.shell).toBe('bash')
  }, 9500)

  test('backgrounding a registered foreground task classifies benign exit 1 from the persisted shell', async () => {
    // Arrange — `;`-joined command: sleeps past the 2s registration threshold,
    // then exits 1 via grep-no-match. The `;` join attributes the exit to the
    // final command (r4e guard → false), so the benign interpretation stands.
    const harness = makeHarness()
    const command = `sleep 3.8; ${BENIGN_GREP}`
    const context = makeToolContext(harness, {
      toolUseId: 'tu-042-fg-bg',
      setToolJSX: () => {},
    })

    // Act — start the foreground call but do NOT await it yet.
    const callPromise = (BashTool as any).call({ command }, context)

    // Wait for the progress loop to register the foreground task (~t=3s).
    await waitFor(
      () =>
        Object.values(harness.getState().tasks).some(
          (t: any) => t.isBackgrounded === false && t.shellCommand != null,
        ),
      7000,
      'foreground task registered',
    )
    const registered: any = Object.values(harness.getState().tasks).find(
      (t: any) => t.isBackgrounded === false && t.shellCommand != null,
    )
    expect(registered.shell).toBe('bash')

    // Background it through the production Ctrl+B path. It sets up the result
    // handler that re-classifies against the PERSISTED state.
    const backgrounded = backgroundExistingForegroundTask(
      registered.id as string,
      registered.shellCommand,
      registered.description as string,
      harness.setAppState,
      'tu-042-fg-bg',
    )
    expect(backgrounded).toBe(true)

    const out = await callPromise
    // The generator observed the backgrounded shell (#handleExit set
    // backgroundTaskId) and returned the race fixed-result path: id stripped,
    // benign interpretation surfaced to the model.
    expect(out.data.backgroundTaskId).toBeUndefined()
    expect(out.data.returnCodeInterpretation).toBe('No matches found')

    // Wait for backgroundExistingForegroundTask's result handler.
    const taskId = registered.id as string
    await waitFor(
      () => isTerminal(harness.getState().tasks[taskId]),
      8000,
      'backgrounded foreground task reaches terminal status',
    )

    // Assert — classified through the persisted `shell: 'bash'`: benign grep
    // exit 1 → completed (kills mutants (a2), (b), (c); the strict fallback
    // or a dropped persistence spread would report 'failed').
    const task = harness.getState().tasks[taskId]
    expect(task.shell).toBe('bash')
    expect(task.status).toBe('completed')
    expect(task.result).toEqual({ code: 1, interrupted: false })
  }, 9500)
})
