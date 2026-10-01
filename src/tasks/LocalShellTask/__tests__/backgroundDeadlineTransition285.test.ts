import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import {
  clearCommandQueue,
  getCommandQueueSnapshot,
} from '../../../utils/messageQueueManager.js'
// Harness-only imports (no LocalShellTask/backgroundDeadline module-graph
// entries) — safe to evaluate before the mock below is installed.
import {
  findNotification,
  isTerminal,
  makeHarness,
  waitFor,
} from './shellWiringHarness042.js'

/**
 * 2.1.285 #85: background-deadline arming at the TWO foreground→background
 * TRANSITION sites (LocalShellTask.tsx backgroundTask :560 and
 * backgroundExistingForegroundTask :681).
 *
 * The spawn-path arming (spawnShellTask :426, driven by BashTool.call with
 * run_in_background) is covered by backgroundDeadline285.test.ts. The official
 * foreground→background transition (`Utn` @206802800: `F=mrn(e,r,s,g,void 0,w)`)
 * passes NO requested timeout, so `c2n(undefined)` arms the 30-minute DEFAULT
 * deadline — the most security-relevant arm: a user foregrounded a command and
 * forgot it; it must still be reaped. This file closes that coverage gap by
 * driving the two PRODUCTION transition entries:
 *
 *   - `backgroundAll` (Ctrl+B) → `backgroundTask` (site :560)
 *   - `backgroundExistingForegroundTask` (in-place auto-background flip,
 *     site :681)
 *
 * Harness convention (same entry as the reviewer probe): `registerForeground`
 * registers a running foreground shell with a wired fake ShellCommand whose
 * `background()` flips status to 'backgrounded' and whose `result` promise
 * stays pending unless killed/settled — so ONLY the deadline reap can
 * terminate the reap-test task. `kill()` settles `result` (mirrors the real
 * ShellCommand: killing ends the process and resolves `result`), which drives
 * the production result handler → `releaseBackgroundDeadline?.(outcome)`.
 *
 * Deadline short-circuit: the transition sites arm with
 * `requestedTimeoutMs === undefined` → real `c2n(undefined)` = 1_800_000ms,
 * unobservable in a test. Following the repo's mock.module convention
 * (webfetchDeadline268.test.ts, OCC-97: spread the real module, override one
 * export, delegate when the override is disarmed, restore in afterAll),
 * `computeBackgroundDeadlineMs` is overridden to return a short delay FOR the
 * undefined request-arg only — recording every request-arg it receives. The
 * arm call sites themselves are untouched, so the recorded `undefined` pins
 * the default-arm contract (official `mrn(...,void 0)` → 30-minute default,
 * whose math is pinned by the pure tests in backgroundDeadline285.test.ts).
 *
 * Mutation coverage (reviewer mutation: drop BOTH deadline-arm calls, i.e.
 * replace `armBackgroundDeadline(...)` with `undefined` at :560 and :681 —
 * all 17 existing backgroundDeadline285 tests stay green):
 *   (m1) arm call removed at either site → `deadlineCalls` never records the
 *        undefined request-arg AND no timer handle is armed at the
 *        short-circuit delay → the `toContain(undefined)` / armed-handle
 *        assertions fail immediately; the reap tests then never reach
 *        killed+notified (waitFor timeout).
 *   (m2) transition passes a requested timeout instead of undefined → the
 *        recorded arg is a number, not undefined → `toContain(undefined)`
 *        fails and no short-circuit timer is armed.
 *   (m3) release closure not invoked by the result handler → the armed timer
 *        handle never lands in the clearTimeout spy → the release assertions
 *        fail (both the settle-before-deadline and the post-reap tests).
 *   (m4) notify-before-kill / `notified` claim dropped → duplicate
 *        notification for the taskId → the exactly-one assertions fail.
 *   (m5) killTask stopCause persistence dropped → `task.stopCause ===
 *        'deadline'` fails and the X9 summary renders bare "was stopped".
 */

// Real module FIRST (OCC-97): the override delegates to it and the restore
// spreads it, so mutable module state (backgroundDeadlineDisabled) stays in
// the single real instance shared with every other importer. NOTE: Bun's
// mock.module re-wires live bindings on already-imported namespaces too, so
// snapshot the REAL exports (and the real calculator) BEFORE installing the
// mock — the namespace object itself would otherwise show the wrapper.
const actualDeadline = await import('../backgroundDeadline.js')
const realExports = { ...actualDeadline }
const realComputeBackgroundDeadlineMs = actualDeadline.computeBackgroundDeadlineMs

/** Every request-arg computeBackgroundDeadlineMs receives (in call order). */
const deadlineCalls: Array<number | undefined> = []
/** When set, `undefined` request-args short-circuit to this delay (ms). */
let shortCircuitMs: number | undefined

mock.module('../backgroundDeadline.js', () => ({
  ...realExports,
  computeBackgroundDeadlineMs: (requestedTimeoutMs?: number) => {
    deadlineCalls.push(requestedTimeoutMs)
    if (shortCircuitMs !== undefined && requestedTimeoutMs === undefined) {
      return shortCircuitMs
    }
    return realComputeBackgroundDeadlineMs(requestedTimeoutMs)
  },
}))

afterAll(() => {
  // OCC-97: restore the real exports for any later test file in this worker.
  shortCircuitMs = undefined
  mock.module('../backgroundDeadline.js', () => ({ ...realExports }))
})

// Production transition entries — imported AFTER the mock is installed.
const {
  registerForeground,
  backgroundAll,
  backgroundExistingForegroundTask,
} = await import('../LocalShellTask.js')

const { BACKGROUND_DEADLINE_DEFAULT_MS, BACKGROUND_STOP_CAUSE_NOTE } =
  realExports

/** Short-circuited deadline for the reap tests — fires fast, reaps for real. */
const SHORT_REAP_MS = 150
/** Short-circuited deadline for the release tests — the task settles first. */
const SHORT_RELEASE_MS = 400

const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  // Deterministic default for the `c2n(undefined) === 30min` contract
  // assertion (getDefaultBashTimeoutMs reads process.env per call).
  savedEnv.BASH_DEFAULT_TIMEOUT_MS = process.env.BASH_DEFAULT_TIMEOUT_MS
  savedEnv.BASH_MAX_TIMEOUT_MS = process.env.BASH_MAX_TIMEOUT_MS
  delete process.env.BASH_DEFAULT_TIMEOUT_MS
  delete process.env.BASH_MAX_TIMEOUT_MS
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  realExports.setBackgroundDeadlineDisabled(false)
})

beforeEach(() => {
  clearCommandQueue()
  realExports.setBackgroundDeadlineDisabled(false)
  deadlineCalls.length = 0
  shortCircuitMs = undefined
})

afterEach(() => {
  shortCircuitMs = undefined
  clearCommandQueue()
})

type ExecResultLike = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
}

/**
 * Wired fake ShellCommand: `background()` flips status to 'backgrounded';
 * `result` stays pending unless `kill()` or `settle()` resolves it, so ONLY
 * the deadline reap can terminate a reap-test task. `kill()` settles the
 * result like the real ShellCommand (process death resolves `result`), which
 * drives the production result handler → release closure.
 */
function makeFakeShellCommand(taskId: string) {
  const calls = { background: 0, kill: 0, cleanup: 0 }
  let status: 'running' | 'backgrounded' | 'completed' | 'killed' = 'running'
  let resolveExec!: (result: ExecResultLike) => void
  const result = new Promise<ExecResultLike>(resolve => {
    resolveExec = resolve
  })
  const fake = {
    get status() {
      return status
    },
    pid: undefined as number | undefined,
    taskOutput: { taskId, flush: async () => {} },
    result,
    background(_backgroundTaskId: string): boolean {
      calls.background++
      status = 'backgrounded'
      return true
    },
    kill(): void {
      calls.kill++
      status = 'killed'
      resolveExec({ stdout: '', stderr: '', code: 143, interrupted: false })
    },
    cleanup(): void {
      calls.cleanup++
    },
    /** Normal completion (exit `code`) — the settle-before-deadline path. */
    settle(code: number): void {
      status = 'completed'
      resolveExec({ stdout: '', stderr: '', code, interrupted: false })
    },
    calls,
  }
  return fake
}

/**
 * setTimeout/clearTimeout pass-through spies: capture the armed deadline
 * timer handle (by its short-circuit delay) and every clearTimeout argument,
 * so the production release closure's `clearTimeout(timer)` is directly
 * observable (requirement 4: the deadline resource is released).
 */
function trackDeadlineTimers() {
  const armed: Array<{ handle: unknown; ms: number | undefined }> = []
  const cleared: unknown[] = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const setSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
    ((fn: (...args: any[]) => void, ms?: number, ...rest: any[]) => {
      const handle = originalSetTimeout(fn, ms as any, ...rest)
      armed.push({ handle, ms })
      return handle
    }) as any,
  )
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(
    ((handle?: unknown) => {
      cleared.push(handle)
      return originalClearTimeout(handle as any)
    }) as any,
  )
  return {
    armed,
    cleared,
    handlesArmedAt(ms: number): unknown[] {
      return armed.filter(a => a.ms === ms).map(a => a.handle)
    },
    restore(): void {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    },
  }
}

function notificationsFor(taskId: string): string[] {
  return getCommandQueueSnapshot()
    .filter(
      (cmd: any) => typeof cmd?.value === 'string' && cmd.value.includes(taskId),
    )
    .map((cmd: any) => cmd.value as string)
}

/** Shared assertion block for the two reap tests (sites :560 and :681). */
async function assertDefaultDeadlineReap(opts: {
  harness: ReturnType<typeof makeHarness>
  timers: ReturnType<typeof trackDeadlineTimers>
  fake: ReturnType<typeof makeFakeShellCommand>
  taskId: string
  description: string
}): Promise<void> {
  const { harness, timers, fake, taskId, description } = opts

  // Requirement 2 — the deadline fires and the task ends killed with
  // stopCause 'deadline' (notify-before-kill claimed `notified`).
  await waitFor(
    () => {
      const task = harness.getState().tasks[taskId]
      return task?.status === 'killed' && task?.notified === true
    },
    6000,
    'default-deadline reap kills the transitioned task',
  )
  const task = harness.getState().tasks[taskId]
  expect(task.stopCause).toBe('deadline')
  expect(isTerminal(task)).toBe(true)
  // The reap really killed the shell (killTask → shellCommand.kill/cleanup).
  expect(fake.calls.kill).toBe(1)
  expect(fake.calls.cleanup).toBeGreaterThanOrEqual(1)

  // Requirement 3 — exactly ONE notification (the notify-before-kill one;
  // the result handler's enqueue is suppressed by the `notified` claim),
  // carrying the official X9 summary + Q9 guidance inside <note>.
  const matching = notificationsFor(taskId)
  expect(matching.length).toBe(1)
  const notification = findNotification(getCommandQueueSnapshot(), taskId)
  expect(notification).toBeDefined()
  expect(notification).toContain('<status>killed</status>')
  expect(notification).toContain(
    `Background command "${description}" was stopped after reaching its background time limit`,
  )
  expect(notification).toContain('<note>')
  expect(notification).toContain(BACKGROUND_STOP_CAUSE_NOTE.deadline)
  expect(notification).toContain('</note>')

  // Requirement 4 — kill settled `result`, so the PRODUCTION result handler
  // ran to completion and invoked the release closure: the armed deadline
  // timer handle was passed to clearTimeout, no duplicate notification was
  // queued, and the killed+deadline snapshot is untouched.
  const armedHandles = timers.handlesArmedAt(SHORT_REAP_MS)
  expect(armedHandles.length).toBe(1)
  await waitFor(
    () => timers.cleared.includes(armedHandles[0]),
    6000,
    'release closure clears the deadline timer after the reap',
  )
  await new Promise(resolve => setTimeout(resolve, 200))
  const afterRelease = harness.getState().tasks[taskId]
  expect(afterRelease.status).toBe('killed')
  expect(afterRelease.stopCause).toBe('deadline')
  expect(notificationsFor(taskId).length).toBe(1)
}

/** Shared assertion block for the two release tests (sites :560 and :681). */
async function assertSettleBeforeDeadlineReleases(opts: {
  harness: ReturnType<typeof makeHarness>
  timers: ReturnType<typeof trackDeadlineTimers>
  fake: ReturnType<typeof makeFakeShellCommand>
  taskId: string
}): Promise<void> {
  const { harness, timers, fake, taskId } = opts

  // Settle the command well before the short-circuited deadline.
  fake.settle(0)
  await waitFor(
    () => isTerminal(harness.getState().tasks[taskId]),
    6000,
    'settled task completes',
  )

  // Requirement 4 — the result handler's release closure cleared the armed
  // deadline timer.
  const armedHandles = timers.handlesArmedAt(SHORT_RELEASE_MS)
  expect(armedHandles.length).toBe(1)
  await waitFor(
    () => timers.cleared.includes(armedHandles[0]),
    6000,
    'release closure clears the deadline timer on settle',
  )

  // Wait well past the (cleared) deadline: no reap may occur — completed
  // normally, no stopCause, shell never killed, plain completion
  // notification with no <note>, exactly one notification.
  await new Promise(resolve => setTimeout(resolve, SHORT_RELEASE_MS + 300))
  const task = harness.getState().tasks[taskId]
  expect(task.status).toBe('completed')
  expect(task.stopCause).toBeUndefined()
  expect(fake.calls.kill).toBe(0)
  const matching = notificationsFor(taskId)
  expect(matching.length).toBe(1)
  expect(matching[0]).toContain('<status>completed</status>')
  expect(matching[0]).not.toContain('background time limit')
  expect(matching[0]).not.toContain('<note>')
}

describe('2.1.285 #85 wiring: backgroundTask (backgroundAll/Ctrl+B, site :560) arms the default deadline', () => {
  test('foreground→background with no explicit timeout arms the 30-min default: reap kills with stopCause=deadline + X9/Q9 <note>, timer released after settle', async () => {
    // Arrange — production registration for a running foreground shell.
    // `result` stays pending, so ONLY the deadline reap can terminate it.
    const harness = makeHarness()
    const timers = trackDeadlineTimers()
    const fake = makeFakeShellCommand('task-085-bgall-reap')
    try {
      const taskId = registerForeground(
        {
          command: 'sleep 30',
          description: 'sleep 30',
          shellCommand: fake as any,
        } as any,
        harness.setAppState,
        'tu-085-bgall-reap',
      )
      expect(taskId).toBe('task-085-bgall-reap')
      expect(harness.getState().tasks[taskId].isBackgrounded).toBe(false)

      // Act — production Ctrl+B entry: backgroundAll → backgroundTask (:560)
      // → armBackgroundDeadline(..., requestedTimeoutMs = undefined).
      shortCircuitMs = SHORT_REAP_MS
      backgroundAll(harness.getAppState, harness.setAppState)

      // The transition itself happened through the production entry.
      expect(fake.calls.background).toBe(1)
      expect(fake.status).toBe('backgrounded')
      expect(harness.getState().tasks[taskId].isBackgrounded).toBe(true)

      // Requirement 1 — the official Utn contract: the transition armed with
      // NO requested timeout (undefined reached the official c2n), which is
      // the 30-minute default arm (math pinned by the pure tests).
      expect(deadlineCalls).toContain(undefined)
      expect(realComputeBackgroundDeadlineMs(undefined)).toBe(
        BACKGROUND_DEADLINE_DEFAULT_MS,
      )
      // A timer was really armed at the short-circuited default delay.
      expect(timers.handlesArmedAt(SHORT_REAP_MS).length).toBe(1)

      // Requirements 2/3/4.
      await assertDefaultDeadlineReap({
        harness,
        timers,
        fake,
        taskId,
        description: 'sleep 30',
      })
    } finally {
      shortCircuitMs = undefined
      timers.restore()
    }
  }, 12000)

  test('command settling before the default deadline releases the timer (never reaped)', async () => {
    // Arrange
    const harness = makeHarness()
    const timers = trackDeadlineTimers()
    const fake = makeFakeShellCommand('task-085-bgall-release')
    try {
      const taskId = registerForeground(
        {
          command: 'sleep 0.2',
          description: 'sleep 0.2',
          shellCommand: fake as any,
        } as any,
        harness.setAppState,
        'tu-085-bgall-release',
      )

      // Act — transition, then settle before the short-circuited deadline.
      shortCircuitMs = SHORT_RELEASE_MS
      backgroundAll(harness.getAppState, harness.setAppState)
      expect(deadlineCalls).toContain(undefined)

      // Assert (requirements 1 + 4 — release path).
      await assertSettleBeforeDeadlineReleases({ harness, timers, fake, taskId })
    } finally {
      shortCircuitMs = undefined
      timers.restore()
    }
  }, 12000)
})

describe('2.1.285 #85 wiring: backgroundExistingForegroundTask (in-place flip, site :681) arms the default deadline', () => {
  test('foreground→background with no explicit timeout arms the 30-min default: reap kills with stopCause=deadline + X9/Q9 <note>, timer released after settle', async () => {
    // Arrange
    const harness = makeHarness()
    const timers = trackDeadlineTimers()
    const fake = makeFakeShellCommand('task-085-inplace-reap')
    try {
      const taskId = registerForeground(
        {
          command: 'sleep 30',
          description: 'sleep 30',
          shellCommand: fake as any,
        } as any,
        harness.setAppState,
        'tu-085-inplace-reap',
      )
      expect(harness.getState().tasks[taskId].isBackgrounded).toBe(false)

      // Act — production in-place auto-background flip (:681) — structurally
      // the official Utn transition: arms with NO requested timeout.
      shortCircuitMs = SHORT_REAP_MS
      const backgrounded = backgroundExistingForegroundTask(
        taskId,
        fake as any,
        'sleep 30',
        harness.setAppState,
        'tu-085-inplace-reap',
      )
      expect(backgrounded).toBe(true)

      expect(fake.calls.background).toBe(1)
      expect(fake.status).toBe('backgrounded')
      expect(harness.getState().tasks[taskId].isBackgrounded).toBe(true)

      // Requirement 1 — undefined request-arg → the 30-minute default arm.
      expect(deadlineCalls).toContain(undefined)
      expect(realComputeBackgroundDeadlineMs(undefined)).toBe(
        BACKGROUND_DEADLINE_DEFAULT_MS,
      )
      expect(timers.handlesArmedAt(SHORT_REAP_MS).length).toBe(1)

      // Requirements 2/3/4.
      await assertDefaultDeadlineReap({
        harness,
        timers,
        fake,
        taskId,
        description: 'sleep 30',
      })
    } finally {
      shortCircuitMs = undefined
      timers.restore()
    }
  }, 12000)

  test('command settling before the default deadline releases the timer (never reaped)', async () => {
    // Arrange
    const harness = makeHarness()
    const timers = trackDeadlineTimers()
    const fake = makeFakeShellCommand('task-085-inplace-release')
    try {
      const taskId = registerForeground(
        {
          command: 'sleep 0.2',
          description: 'sleep 0.2',
          shellCommand: fake as any,
        } as any,
        harness.setAppState,
        'tu-085-inplace-release',
      )

      // Act — transition, then settle before the short-circuited deadline.
      shortCircuitMs = SHORT_RELEASE_MS
      const backgrounded = backgroundExistingForegroundTask(
        taskId,
        fake as any,
        'sleep 0.2',
        harness.setAppState,
        'tu-085-inplace-release',
      )
      expect(backgrounded).toBe(true)
      expect(deadlineCalls).toContain(undefined)

      // Assert (requirements 1 + 4 — release path).
      await assertSettleBeforeDeadlineReleases({ harness, timers, fake, taskId })
    } finally {
      shortCircuitMs = undefined
      timers.restore()
    }
  }, 12000)
})
