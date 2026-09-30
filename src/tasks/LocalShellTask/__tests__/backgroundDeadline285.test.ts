import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { BashTool } from '../../../tools/BashTool/BashTool.js'
import {
  clearCommandQueue,
  getCommandQueueSnapshot,
} from '../../../utils/messageQueueManager.js'
import {
  BACKGROUND_DEADLINE_DEFAULT_MS,
  BACKGROUND_STOP_CAUSE_NOTE,
  BACKGROUND_STOP_CAUSE_SUMMARY,
  backgroundDeadlineCapMs,
  backgroundDeadlineFloorMs,
  backgroundTimeoutUsageNote,
  computeBackgroundDeadlineMs,
  isBackgroundDeadlineCapable,
  isBackgroundDeadlineEnabled,
  runInBackgroundDescription,
  setBackgroundDeadlineDisabled,
} from '../backgroundDeadline.js'
import { killTask } from '../killShellTasks.js'
import { backgroundCommandSummary } from '../LocalShellTask.js'
import {
  findNotification,
  isTerminal,
  makeHarness,
  makeToolContext,
  waitFor,
} from './shellWiringHarness042.js'

/**
 * 2.1.285 #85: background shell deadline reap.
 *
 * Official byte evidence (v285 linux-x64 ELF, /tmp/cc-diff-285 forensics):
 *   - Constants @201231000: `d5e=1800000`; `Zee()=Math.min(Math.max(7200000,
 *     nhe()),2147483647)`; `VTo(e)=Math.max(d5e,the(e))`;
 *     `c2n(e){if(!gHr())return;return Math.min(e??VTo(),Zee())}`
 *   - Gates @202100341: `Nan(){return!LH().backgroundDeadlineDisabled}`,
 *     `gHr(){return Nan()&&x("tengu_cosmic_shore",!0)}` (GrowthBook default
 *     TRUE → folds to the capability check in OCC)
 *   - Kill callback `Ncr(e,n,r)` @206797679: eligibility re-check
 *     (`status==="running" && !notified && shellCommand?.status===
 *     "backgrounded"`), `r.cause="deadline"`, notify-before-kill (`prn`),
 *     `task_local_shell_background_deadline` analytics
 *   - Arming `mrn` @206798147: `B=c2n(S); K=setTimeout(Ncr,B,...); K?.unref()`;
 *     monitor excluded at the spawn caller (`w!=="monitor"?mrn(...):void 0`
 *     @206800243); foreground→background passes undefined timeout (`Utn`:
 *     `mrn(e,r,s,g,void 0,w)` @206802961) → 30-minute default
 *   - Message tables @203048512: `X9` killed-summary fragments, `Q9` guidance
 *     notes rendered inside `<note>` (`xj="note"` @195567729, `tIt` builder)
 *
 * Mutation coverage (each mutation makes at least one assertion fail):
 *   (a) drop the `timeout` pass-through in BashTool spawnBackgroundTask →
 *       the 400ms-deadline wiring test never fires (task stays running past
 *       its requested lifetime → waitFor 'deadline kills' fails).
 *   (b) invert `computeBackgroundDeadlineMs` min/max (use floor instead of
 *       requested) → same failure as (a).
 *   (c) drop the notify-before-kill or the `notified` claim → either no
 *       notification in the queue or a duplicate 'killed' notification from
 *       the result handler.
 *   (d) drop `stopCause` persistence in killTask → the state assertion
 *       `task.stopCause === 'deadline'` fails and the summary renders the
 *       bare "was stopped" (X9 lookup assertion fails).
 *   (e) drop the disabled-capability early return → the disabled wiring test
 *       (task must stay running) fails.
 *   (f) drop the monitor/undefined-deadline arming guards → not directly
 *       observable here (MonitorTool is a separate surface); covered by the
 *       pure computeBackgroundDeadlineMs disabled test.
 */

const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  // Deterministic default/max bash timeouts for the pure-math assertions
  // (getDefaultBashTimeoutMs/getMaxBashTimeoutMs read process.env per call).
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
  setBackgroundDeadlineDisabled(false)
})

beforeEach(() => {
  clearCommandQueue()
  setBackgroundDeadlineDisabled(false)
})

describe('2.1.285 #85: computeBackgroundDeadlineMs (official c2n)', () => {
  test('returns undefined when the capability is disabled', () => {
    // Arrange
    setBackgroundDeadlineDisabled(true)

    // Act + Assert — official `c2n`: `if(!gHr())return;`
    expect(isBackgroundDeadlineCapable()).toBe(false)
    expect(isBackgroundDeadlineEnabled()).toBe(false)
    expect(computeBackgroundDeadlineMs()).toBeUndefined()
    expect(computeBackgroundDeadlineMs(5_000)).toBeUndefined()
  })

  test('no requested timeout → 30-minute default (min(max(30min, bashDefault), cap))', () => {
    // Arrange — defaults: bash default 120_000, max 600_000.
    // Act + Assert — official `VTo()=Math.max(d5e,the())` → 1_800_000;
    // `Zee()=Math.min(Math.max(7200000,nhe()),2147483647)` → 7_200_000;
    // `c2n(undefined)=Math.min(VTo(),Zee())` → 1_800_000.
    expect(backgroundDeadlineFloorMs()).toBe(BACKGROUND_DEADLINE_DEFAULT_MS)
    expect(backgroundDeadlineCapMs()).toBe(7_200_000)
    expect(computeBackgroundDeadlineMs()).toBe(BACKGROUND_DEADLINE_DEFAULT_MS)
  })

  test('requested timeout below the cap is honored verbatim', () => {
    // Act + Assert — official `c2n(e)=Math.min(e??VTo(),Zee())`.
    expect(computeBackgroundDeadlineMs(500)).toBe(500)
    expect(computeBackgroundDeadlineMs(60_000)).toBe(60_000)
  })

  test('requested timeout above the cap is clamped to Zee()', () => {
    // Act + Assert
    expect(computeBackgroundDeadlineMs(10_000_000)).toBe(7_200_000)
    expect(computeBackgroundDeadlineMs(Number.MAX_SAFE_INTEGER)).toBe(7_200_000)
  })

  test('cap floor: BASH_MAX_TIMEOUT_MS above 2h raises the cap (official Zee)', () => {
    // Arrange
    process.env.BASH_MAX_TIMEOUT_MS = '10800000' // 3h
    try {
      // Act + Assert — max(7200000, 10800000) → 10800000 (< 2^31-1).
      expect(backgroundDeadlineCapMs()).toBe(10_800_000)
      expect(computeBackgroundDeadlineMs(9_000_000)).toBe(9_000_000)
    } finally {
      delete process.env.BASH_MAX_TIMEOUT_MS
    }
  })

  test('floor: BASH_DEFAULT_TIMEOUT_MS above 30min raises the default (official VTo)', () => {
    // Arrange
    process.env.BASH_DEFAULT_TIMEOUT_MS = '3600000' // 1h
    process.env.BASH_MAX_TIMEOUT_MS = '3600000'
    try {
      // Act + Assert — max(1800000, 3600000) → 3600000.
      expect(backgroundDeadlineFloorMs()).toBe(3_600_000)
      expect(computeBackgroundDeadlineMs()).toBe(3_600_000)
    } finally {
      delete process.env.BASH_DEFAULT_TIMEOUT_MS
      delete process.env.BASH_MAX_TIMEOUT_MS
    }
  })
})

describe('2.1.285 #85: schema description + prompt usage note ($an / Fan)', () => {
  test('runInBackgroundDescription enabled branch documents the lifetime semantics', () => {
    // Act
    const description = runInBackgroundDescription()

    // Assert — official `$an()` enabled branch (byte-verified @202100341).
    expect(description).toContain('run this command in the background')
    expect(description).toContain('`timeout` limits how long the command may run in the background')
    expect(description).toContain(`default ${BACKGROUND_DEADLINE_DEFAULT_MS} ms`)
    expect(description).toContain('max 7200000 ms')
  })

  test('runInBackgroundDescription disabled branch keeps the OCC pre-existing text', () => {
    // Arrange
    setBackgroundDeadlineDisabled(true)

    // Act + Assert — documented divergence: disabled branch retains OCC's
    // "Use Read to read the output later." sentence.
    const description = runInBackgroundDescription()
    expect(description).toBe(
      'Set to true to run this command in the background. Use Read to read the output later.',
    )
  })

  test('backgroundTimeoutUsageNote appends the official Fan() sentence when enabled, empty when disabled', () => {
    // Act + Assert — enabled (official `Fan()` shape).
    const note = backgroundTimeoutUsageNote()
    expect(note).toContain('With `run_in_background` the timeout is instead how long')
    expect(note).toContain(`default ${BACKGROUND_DEADLINE_DEFAULT_MS}ms / 30 minutes`)
    expect(note).toContain('max 7200000ms / 2 hours')
    expect(note).toContain('at that limit it is stopped and you are notified.')

    // Disabled → empty string.
    setBackgroundDeadlineDisabled(true)
    expect(backgroundTimeoutUsageNote()).toBe('')
  })
})

describe('2.1.285 #85: stop-cause tables (official X9 / Q9, verbatim)', () => {
  test('X9 summary fragments match the official strings', () => {
    expect(BACKGROUND_STOP_CAUSE_SUMMARY.memory_pressure).toBe(
      'stopped because the system is running low on memory',
    )
    expect(BACKGROUND_STOP_CAUSE_SUMMARY.deadline).toBe(
      'stopped after reaching its background time limit',
    )
  })

  test('Q9 deadline guidance note matches the official string', () => {
    expect(BACKGROUND_STOP_CAUSE_NOTE.deadline).toBe(
      'If the work in progress still needs it, start it again with `run_in_background` and a longer `timeout`. If it already had the longest `timeout` allowed, do not restart it. Either way, report that it was stopped.',
    )
    // memory_pressure entry ported verbatim but producer-less in OCC (the
    // official pressure-reap subsystem is staged — no CLAUDE_CODE_DISABLE_BG_
    // SHELL_PRESSURE_REAP consumer yet).
    expect(BACKGROUND_STOP_CAUSE_NOTE.memory_pressure).toContain(
      'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1',
    )
  })

  test('backgroundCommandSummary killed branch renders the X9 lookup (official e2e)', () => {
    // Act + Assert — `${Obe}"${n}" was ${S?X9[S]:"stopped"}`
    expect(backgroundCommandSummary('sleep 30', 'killed', undefined, undefined, 'deadline')).toBe(
      'Background command "sleep 30" was stopped after reaching its background time limit',
    )
    expect(
      backgroundCommandSummary('sleep 30', 'killed', undefined, undefined, 'memory_pressure'),
    ).toBe('Background command "sleep 30" was stopped because the system is running low on memory')
    // No stopCause → bare "was stopped" (pre-285 behavior preserved).
    expect(backgroundCommandSummary('sleep 30', 'killed', undefined)).toBe(
      'Background command "sleep 30" was stopped',
    )
  })
})

describe('2.1.285 #85: killTask persists stopCause (official prn/t2e)', () => {
  test('killTask with stopCause writes it onto the killed snapshot', () => {
    // Arrange — inline LocalShellTaskState (backgroundShellStop.test.ts
    // pattern); fake shellCommand so kill()/cleanup() are observable.
    let killCalls = 0
    let cleanupCalls = 0
    const tasks: Record<string, any> = {
      'task-sc-1': {
        id: 'task-sc-1',
        type: 'local_bash',
        status: 'running',
        description: 'sleep 30',
        command: 'sleep 30',
        startTime: Date.now(),
        outputFile: '/tmp/occ-test-deadline-sc.out',
        outputOffset: 0,
        notified: false,
        completionStatusSentInAttachment: false,
        shellCommand: {
          status: 'backgrounded',
          kill: () => {
            killCalls++
          },
          cleanup: () => {
            cleanupCalls++
          },
        },
        pid: undefined,
        lastReportedTotalLines: 0,
        isBackgrounded: true,
      },
    }
    const setAppState = (fn: (prev: any) => any) => {
      const next = fn({ tasks })
      Object.assign(tasks, next.tasks)
    }

    // Act
    killTask('task-sc-1', setAppState, 'deadline')

    // Assert — official `t2e({...e,status:"killed",exitCode:void 0,
    // stopCause:n})`: stopCause lands on the snapshot, kill+cleanup ran.
    expect(tasks['task-sc-1'].status).toBe('killed')
    expect(tasks['task-sc-1'].stopCause).toBe('deadline')
    expect(tasks['task-sc-1'].notified).toBe(true)
    expect(killCalls).toBe(1)
    expect(cleanupCalls).toBe(1)
  })

  test('killTask without stopCause leaves the field absent (no bare kill regression)', () => {
    // Arrange
    const tasks: Record<string, any> = {
      'task-sc-2': {
        id: 'task-sc-2',
        type: 'local_bash',
        status: 'running',
        description: 'sleep 1',
        command: 'sleep 1',
        startTime: Date.now(),
        outputFile: '/tmp/occ-test-deadline-sc2.out',
        outputOffset: 0,
        notified: false,
        completionStatusSentInAttachment: false,
        shellCommand: { status: 'backgrounded', kill: () => {}, cleanup: () => {} },
        lastReportedTotalLines: 0,
        isBackgrounded: true,
      },
    }
    const setAppState = (fn: (prev: any) => any) => {
      const next = fn({ tasks })
      Object.assign(tasks, next.tasks)
    }

    // Act
    killTask('task-sc-2', setAppState)

    // Assert
    expect(tasks['task-sc-2'].status).toBe('killed')
    expect('stopCause' in tasks['task-sc-2']).toBe(false)
  })
})

describe('2.1.285 #85 wiring: BashTool run_in_background deadline reap (Ncr/mrn)', () => {
  test('requested timeout arms the deadline: task is killed with stopCause=deadline and the X9/Q9 notification', async () => {
    // Arrange — real production entry (BashTool.call → spawnBackgroundTask →
    // spawnShellTask with the raw `timeout` input → armBackgroundDeadline).
    // `sleep 30` cannot finish within the 400ms requested lifetime, so ONLY
    // the deadline timer can terminate it (kills mutants (a), (b)).
    const harness = makeHarness()
    const context = makeToolContext(harness, { toolUseId: 'tu-085-deadline' })

    // Act
    const { data } = await (BashTool as any).call(
      { command: 'sleep 30', run_in_background: true, timeout: 400 },
      context,
    )
    const taskId = data.backgroundTaskId as string
    expect(taskId).toBeTruthy()
    expect(harness.getState().tasks[taskId].isBackgrounded).toBe(true)

    // The reap fires at ~400ms: Ncr eligibility check passes (running,
    // not notified, shellCommand.status === 'backgrounded'), prn notifies
    // BEFORE killTask flips the snapshot to killed.
    await waitFor(
      () => {
        const task = harness.getState().tasks[taskId]
        return task?.status === 'killed' && task?.notified === true
      },
      6000,
      'deadline reap kills the backgrounded task',
    )

    // Assert — stopCause persisted (kills mutant (d)).
    const task = harness.getState().tasks[taskId]
    expect(task.stopCause).toBe('deadline')
    expect(isTerminal(task)).toBe(true)

    // Exactly ONE notification (notify-before-kill claimed `notified`, so the
    // result handler's enqueue is suppressed — kills mutant (c)).
    const queue = getCommandQueueSnapshot()
    const matching = queue.filter(
      (cmd: any) => typeof cmd?.value === 'string' && cmd.value.includes(taskId),
    )
    expect(matching.length).toBe(1)

    // The notification carries the official X9 summary + Q9 note inside
    // <note> (official tIt: `\n<${xj}>${Wt(Q9[w])}</${xj}>`).
    const notification = findNotification(queue, taskId)
    expect(notification).toBeDefined()
    expect(notification).toContain('<status>killed</status>')
    expect(notification).toContain(
      'Background command "sleep 30" was stopped after reaching its background time limit',
    )
    expect(notification).toContain('<note>')
    expect(notification).toContain(BACKGROUND_STOP_CAUSE_NOTE.deadline)
    expect(notification).toContain('</note>')
  }, 9500)

  test('command finishing before the deadline is never reaped (release clears the timer)', async () => {
    // Arrange — `echo` finishes in ~10ms; requested lifetime 5000ms.
    const harness = makeHarness()
    const context = makeToolContext(harness, { toolUseId: 'tu-085-settled' })

    // Act
    const { data } = await (BashTool as any).call(
      { command: 'echo deadline-settle-check', run_in_background: true, timeout: 5000 },
      context,
    )
    const taskId = data.backgroundTaskId as string

    await waitFor(
      () => isTerminal(harness.getState().tasks[taskId]),
      8000,
      'background echo reaches terminal status',
    )

    // Assert — completed normally; the mrn release closure cleared the
    // timer, so no deadline kill and no stopCause.
    const task = harness.getState().tasks[taskId]
    expect(task.status).toBe('completed')
    expect(task.stopCause).toBeUndefined()

    // The settle release must have disarmed the timer (a leaked timer would
    // fire at 5000ms); the notification is the plain completion one.
    const notification = findNotification(getCommandQueueSnapshot(), taskId)
    expect(notification).toBeDefined()
    expect(notification).toContain('<status>completed</status>')
    expect(notification).not.toContain('background time limit')
    expect(notification).not.toContain('<note>')
  }, 9500)

  test('disabled capability: the requested timeout does NOT reap (no timer armed)', async () => {
    // Arrange — SDK/Cloud-host exemption equivalent (official
    // `LH().backgroundDeadlineDisabled` → `Nan()` false → `c2n` returns
    // undefined → `K===void 0`, no setTimeout). Kills mutant (e).
    setBackgroundDeadlineDisabled(true)
    const harness = makeHarness()
    const context = makeToolContext(harness, { toolUseId: 'tu-085-disabled' })

    // Act — requested lifetime 300ms, then wait well past it.
    const { data } = await (BashTool as any).call(
      { command: 'sleep 8', run_in_background: true, timeout: 300 },
      context,
    )
    const taskId = data.backgroundTaskId as string
    await new Promise(resolve => setTimeout(resolve, 900))

    // Assert — still running, no notification, no stopCause.
    const task = harness.getState().tasks[taskId]
    expect(task.status).toBe('running')
    expect(task.notified).toBe(false)
    expect(task.stopCause).toBeUndefined()
    expect(findNotification(getCommandQueueSnapshot(), taskId)).toBeUndefined()

    // Cleanup — kill the real `sleep 8` process.
    killTask(taskId, harness.setAppState)
    expect(harness.getState().tasks[taskId].status).toBe('killed')
    setBackgroundDeadlineDisabled(false)
  }, 9500)
})
