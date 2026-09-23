import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 2.1.280 #042 WIRING-LEVEL regression tests for the PowerShellTool call
 * sites (`shell: 'powershell'` at the spawnBackgroundTask and
 * registerForeground callers in PowerShellTool.tsx).
 *
 * DEDICATED mock.module FILE: bun's mock.module is process-global and
 * PERMANENT for the process lifetime, so these mocks must never share a file
 * with other tests (CI runs each test file in its own bun process).
 *
 * WHY MOCKS (documented limitation): this machine has no PowerShell
 * (`getCachedPowerShellPath()` → null on linux), and the production PS path
 * short-circuits with a "PowerShell is not available" sentinel BEFORE reaching
 * either call site — so the PS wiring is not drivable end-to-end here. Two
 * seams are faked:
 *   1. powershellDetection.getCachedPowerShellPath → a fake pwsh path so the
 *      pre-flight gate passes;
 *   2. utils/Shell.js exec → a fake ShellCommand (controllable `result`
 *      promise) instead of a real pwsh spawn.
 * EVERYTHING downstream is the REAL production code: PowerShellTool.call →
 * runPowerShellCommand → spawnShellTask / registerForeground (real
 * LocalShellTask.tsx, including the conditional-spread `shell` persistence) →
 * classifyShellTaskResult (real per-shell dispatch) → enqueueShellNotification.
 *
 * Mutation coverage:
 *   (a) drop `shell: 'powershell'` from either PS call site → persisted
 *       `taskState.shell` undefined → strict fallback → 'failed' (tests 1/3)
 *       and the direct `shell` assertions (tests 1/2).
 *   (b) drop the persistence spread in LocalShellTask.tsx → same effect.
 *   (c) drop the classifier per-shell dispatch (or just the powershell arm) →
 *       benign exit 1 strict-classified → 'failed', no exitNote (tests 1/3).
 */

// --- Seam 1: make the pwsh pre-flight gate pass ---------------------------
const powershellDetectionOriginal = await import(
  '../../../utils/shell/powershellDetection.js'
)
mock.module('../../../utils/shell/powershellDetection.js', () => ({
  ...powershellDetectionOriginal,
  getCachedPowerShellPath: async () => '/usr/bin/fake-pwsh-042',
}))

// --- Seam 2: fake the process spawn, keep everything else real -------------
const shellOriginal = await import('../../../utils/Shell.js')

type FakeShellCommand = {
  command: any
  resolveResult: (result: {
    code: number
    interrupted: boolean
    stdout: string
    stderr: string
  }) => void
}

let currentFake: FakeShellCommand | null = null

function makeFakeShellCommand(taskId: string): FakeShellCommand {
  let resolveResult!: (result: any) => void
  const result = new Promise<any>(resolve => {
    resolveResult = resolve
  })
  const command: any = {
    pid: 424242,
    status: 'running',
    onTimeout: undefined,
    result,
    background(_id: string): boolean {
      if (command.status !== 'running') return false
      command.status = 'backgrounded'
      return true
    },
    cleanup(): void {},
    kill(): void {},
    taskOutput: {
      taskId,
      flush: async () => {},
      stdoutToFile: false,
      outputFileRedundant: true,
      path: '',
      outputFileSize: 0,
    },
  }
  return { command, resolveResult }
}

mock.module('../../../utils/Shell.js', () => ({
  ...shellOriginal,
  exec: async () => {
    if (!currentFake) throw new Error('test harness: no fake shell command set')
    return currentFake.command
  },
}))

// --- Production modules under test (imported AFTER the mocks) --------------
const { PowerShellTool } = await import('../PowerShellTool.js')
const { backgroundExistingForegroundTask } = await import(
  '../../../tasks/LocalShellTask/LocalShellTask.js'
)
const { clearCommandQueue, getCommandQueueSnapshot } = await import(
  '../../../utils/messageQueueManager.js'
)
const {
  findNotification,
  findSnapshot,
  isTerminal,
  makeHarness,
  makeToolContext,
  waitFor,
} = await import(
  '../../../tasks/LocalShellTask/__tests__/shellWiringHarness042.js'
)

// PS dispatch-arm discriminator: `grep foo f` exit 1 is benign under the
// powershell interpreter (azr grep → "No matches found") but strict-failed
// when `shell` is missing/wrong.
const PS_COMMAND = 'grep foo f'

describe('2.1.280 #042 wiring: PowerShellTool spawnBackgroundTask passes shell:"powershell"', () => {
  beforeEach(() => {
    clearCommandQueue()
  })

  test('run_in_background persists shell:"powershell" and benign exit 1 completes with the PS exitNote', async () => {
    // Arrange
    const harness = makeHarness()
    const context = makeToolContext(harness, { toolUseId: 'tu-042-ps-spawn' })
    const taskId = 'ps-042-spawn'
    currentFake = makeFakeShellCommand(taskId)

    // Act — production caller: PowerShellTool.call → runPowerShellCommand →
    // spawnBackgroundTask → spawnShellTask (real).
    const { data } = await (PowerShellTool as any).call(
      { command: PS_COMMAND, run_in_background: true },
      context,
    )

    // Assert — spawn persisted `shell: 'powershell'` (kills mutants (a3) and
    // (b) directly, before any classification).
    expect(data.backgroundTaskId).toBe(taskId)
    const spawned = harness.getState().tasks[taskId]
    expect(spawned).toBeDefined()
    expect(spawned.shell).toBe('powershell')
    expect(spawned.isBackgrounded).toBe(true)
    expect(spawned.status).toBe('running')

    // The fake pwsh process finishes: benign grep exit 1.
    currentFake.resolveResult({
      code: 1,
      interrupted: false,
      stdout: '',
      stderr: '',
    })
    await waitFor(
      () => isTerminal(harness.getState().tasks[taskId]),
      5000,
      'PS background task reaches terminal status',
    )

    // Per-shell PS semantics applied → completed (kills mutants (a3), (b),
    // (c)/powershell-arm; strict fallback would report 'failed').
    const task = harness.getState().tasks[taskId]
    expect(task.status).toBe('completed')
    expect(task.result).toEqual({ code: 1, interrupted: false })

    const notification = findNotification(getCommandQueueSnapshot(), taskId)
    expect(notification).toBeDefined()
    expect(notification).toContain('<status>completed</status>')
    expect(notification).toContain('No matches found')
  }, 9500)
})

describe('2.1.280 #042 wiring: PowerShellTool registerForeground passes shell:"powershell"', () => {
  beforeEach(() => {
    clearCommandQueue()
  })

  test('foreground command past the 2s threshold registers with shell:"powershell" persisted', async () => {
    // Arrange — the PS progress loop wakes on its own 1s timer (no poller
    // dependency), registers the foreground task at the 2s threshold, and
    // renders BackgroundHint via setToolJSX.
    const harness = makeHarness()
    const jsxCalls: unknown[] = []
    const context = makeToolContext(harness, {
      toolUseId: 'tu-042-ps-fg',
      setToolJSX: (v: unknown) => {
        jsxCalls.push(v)
      },
    })
    currentFake = makeFakeShellCommand('ps-042-fg')
    const fake = currentFake

    // Act — start a long-running foreground command; wait for registration.
    const callPromise = (PowerShellTool as any).call(
      { command: 'Start-Sleep 30' },
      context,
    )
    await waitFor(
      () =>
        findSnapshot(
          harness.history,
          task =>
            task.command === 'Start-Sleep 30' &&
            task.isBackgrounded === false &&
            task.status === 'running',
        ) !== undefined,
      6000,
      'PS foreground task registered',
    )

    // Let the call finish cleanly.
    fake.resolveResult({ code: 0, interrupted: false, stdout: '', stderr: '' })
    await callPromise

    // Assert — the registration branch really ran (BackgroundHint rendered).
    expect(jsxCalls.some(v => v !== null)).toBe(true)

    // registerForeground persisted `shell: 'powershell'` (kills mutants (a4)
    // and (b); unregisterForeground removes the task afterwards, so read the
    // captured write history).
    const registered = findSnapshot(
      harness.history,
      task =>
        task.command === 'Start-Sleep 30' &&
        task.isBackgrounded === false &&
        task.status === 'running',
    )
    expect(registered).toBeDefined()
    expect(registered!.shell).toBe('powershell')
  }, 9500)

  test('backgrounding a registered PS foreground task classifies benign exit 1 from the persisted shell', async () => {
    // Arrange — register a foreground PS task, then background it through the
    // production backgroundExistingForegroundTask path and let it exit 1.
    const harness = makeHarness()
    const context = makeToolContext(harness, {
      toolUseId: 'tu-042-ps-fg-bg',
      setToolJSX: () => {},
    })
    const taskId = 'ps-042-fg-bg'
    currentFake = makeFakeShellCommand(taskId)
    const fake = currentFake

    // Act
    const callPromise = (PowerShellTool as any).call(
      { command: PS_COMMAND },
      context,
    )
    await waitFor(
      () => {
        const t = harness.getState().tasks[taskId]
        return t !== undefined && t.isBackgrounded === false
      },
      6000,
      'PS foreground task registered',
    )
    const registered = harness.getState().tasks[taskId]
    expect(registered.shell).toBe('powershell')

    const backgrounded = backgroundExistingForegroundTask(
      taskId,
      registered.shellCommand,
      registered.description,
      harness.setAppState,
      'tu-042-ps-fg-bg',
    )
    expect(backgrounded).toBe(true)

    // The fake pwsh process finishes with the benign grep exit.
    fake.resolveResult({ code: 1, interrupted: false, stdout: '', stderr: '' })
    await callPromise
    await waitFor(
      () => isTerminal(harness.getState().tasks[taskId]),
      5000,
      'backgrounded PS foreground task reaches terminal status',
    )

    // Assert — classified through the persisted `shell: 'powershell'`
    // (kills mutants (a4), (b), (c)/powershell-arm).
    const task = harness.getState().tasks[taskId]
    expect(task.status).toBe('completed')
    expect(task.result).toEqual({ code: 1, interrupted: false })

    const notification = findNotification(getCommandQueueSnapshot(), taskId)
    expect(notification).toBeDefined()
    expect(notification).toContain('No matches found')
  }, 9500)
})
