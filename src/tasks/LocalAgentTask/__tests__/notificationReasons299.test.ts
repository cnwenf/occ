import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AppState } from '../../../state/AppState.js'
import {
  clearCommandQueue,
  getCommandQueueSnapshot,
} from '../../../utils/messageQueueManager.js'
import type { TaskState } from '../../types.js'
import {
  enqueueAgentNotification,
  type LocalAgentTaskState,
} from '../LocalAgentTask.tsx'
import {
  BACKGROUND_WORK_INTERIM_NOTE,
  DEFAULT_STOP_NOTE,
  LATE_MESSAGE_NOTE,
  USAGE_LIMIT_CONTINUE_SENTENCE,
  buildNotificationNote,
  completedSummaryReason,
  hasLiveOwnedBackgroundWork,
  usageLimitNote,
  usageLimitResetPhrase,
} from '../notificationReasons.js'

/**
 * CC 2.1.299 #149: "Improved background agent notifications: they now say
 * when an agent is only waiting on its own background work, got a message too
 * late for its result, or was stopped by a usage limit."
 *
 * Each reason must surface its official string (byte-exact, recovered from
 * the v299 ELF — offsets in ./notificationReasons.ts header):
 *   - pt: summary "is waiting on its own background work" + interim note.
 *   - nn: " One or more messages sent to this agent arrived after this run's
 *     last step, too late for the result below. …"
 *   - Wn: " This agent's work so far is saved. The limit resets …. Once its
 *     requests are accepted again, send the agent a message (SendMessage) …"
 *   - default: summary "finished" (official RHo) + the stop-note variant.
 */

// ~3h out → formatResetTime's within-24h time-only branch (starts with a
// digit → official u8t picks the "resets at …" phrasing).
const RESETS_AT = Math.floor(Date.now() / 1000) + 3 * 3600

function makeAgentTask(
  taskId: string,
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id: taskId,
    type: 'local_agent',
    status: 'completed',
    description: 'test agent',
    startTime: Date.now(),
    outputFile: '',
    outputOffset: 0,
    notified: false,
    agentId: taskId,
    prompt: 'test',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } as LocalAgentTaskState
}

function makeShellTask(
  taskId: string,
  overrides: Record<string, unknown> = {},
): TaskState {
  return {
    id: taskId,
    type: 'local_bash',
    status: 'running',
    description: 'bg command',
    startTime: Date.now(),
    outputFile: '',
    outputOffset: 0,
    notified: false,
    command: 'sleep 100',
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    ...overrides,
  } as unknown as TaskState
}

function makeHarness(
  taskEntries: Array<[string, TaskState]>,
): {
  setAppState: (fn: (prev: AppState) => AppState) => void
  getAppState: () => AppState
  getTask: (id: string) => LocalAgentTaskState
} {
  const tasks: Record<string, TaskState> = {}
  for (const [id, task] of taskEntries) {
    tasks[id] = task
  }
  let state = {
    tasks,
    // abortSpeculation reads prev.speculation.status — idle short-circuits.
    speculation: { status: 'idle' },
  } as unknown as AppState
  const setAppState = (fn: (prev: AppState) => AppState) => {
    state = fn(state)
  }
  return {
    setAppState,
    getAppState: () => state,
    getTask: (id: string) => state.tasks[id] as LocalAgentTaskState,
  }
}

function notifyArgs(taskId: string) {
  return {
    taskId,
    description: 'test agent',
    status: 'completed' as const,
    finalMessage: 'the final report',
  }
}

function taskNotifications(): string[] {
  return getCommandQueueSnapshot()
    .filter(entry => entry.mode === 'task-notification')
    .map(entry => entry.value as string)
}

beforeEach(() => {
  clearCommandQueue()
})

afterEach(() => {
  clearCommandQueue()
})

describe('CC 2.1.299 #149: completed summary reasons', () => {
  test('default completed summary is the official RHo "finished"', () => {
    const { setAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1')],
    ])
    enqueueAgentNotification({ ...notifyArgs('agent-1'), setAppState })
    const [note] = taskNotifications()
    expect(note).toContain('<summary>Agent "test agent" finished</summary>')
  })

  test('completedSummaryReason mirrors the official ct ternary', () => {
    expect(completedSummaryReason(false)).toBe('finished')
    expect(completedSummaryReason(true)).toBe(
      'is waiting on its own background work',
    )
  })
})

describe('CC 2.1.299 #149: reason 1 — waiting on its own background work (pt/WZr)', () => {
  test('live owned shell child → waiting summary + interim note', () => {
    const { setAppState, getAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1')],
      ['shell-1', makeShellTask('shell-1', { agentId: 'agent-1' })],
    ])
    enqueueAgentNotification({
      ...notifyArgs('agent-1'),
      setAppState,
      getAppState,
    })
    const [note] = taskNotifications()
    expect(note).toContain(
      '<summary>Agent "test agent" is waiting on its own background work</summary>',
    )
    expect(note).toContain(BACKGROUND_WORK_INTERIM_NOTE)
    expect(note).not.toContain(DEFAULT_STOP_NOTE)
  })

  test('live owned workflow child (ownerAgentId) → waiting summary', () => {
    const workflow = {
      id: 'wf-1',
      type: 'local_workflow',
      status: 'running',
      ownerAgentId: 'agent-1',
    } as unknown as TaskState
    const { setAppState, getAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1')],
      ['wf-1', workflow],
    ])
    enqueueAgentNotification({
      ...notifyArgs('agent-1'),
      setAppState,
      getAppState,
    })
    expect(taskNotifications()[0]).toContain(
      'is waiting on its own background work',
    )
  })

  test('finished or unowned children do not trigger the waiting reason', () => {
    const { setAppState, getAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1')],
      ['shell-done', makeShellTask('shell-done', { agentId: 'agent-1', status: 'completed' })],
      ['shell-other', makeShellTask('shell-other', { agentId: 'someone-else' })],
      ['shell-main', makeShellTask('shell-main')],
    ])
    enqueueAgentNotification({
      ...notifyArgs('agent-1'),
      setAppState,
      getAppState,
    })
    const [note] = taskNotifications()
    expect(note).toContain('finished</summary>')
    expect(note).toContain(DEFAULT_STOP_NOTE)
    expect(note).not.toContain(BACKGROUND_WORK_INTERIM_NOTE)
  })

  test('without getAppState the gate stays false (default note)', () => {
    const { setAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1')],
      ['shell-1', makeShellTask('shell-1', { agentId: 'agent-1' })],
    ])
    enqueueAgentNotification({ ...notifyArgs('agent-1'), setAppState })
    const [note] = taskNotifications()
    expect(note).toContain('finished</summary>')
    expect(note).toContain(DEFAULT_STOP_NOTE)
  })

  test('hasLiveOwnedBackgroundWork excludes the task itself', () => {
    const { getAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1', { status: 'running' })],
    ])
    expect(
      hasLiveOwnedBackgroundWork(
        { id: 'agent-1', agentId: 'agent-1' },
        getAppState(),
      ),
    ).toBe(false)
  })
})

describe('CC 2.1.299 #149: reason 2 — message arrived too late for the result (nn)', () => {
  test('pending messages on completion surface the official sentence', () => {
    const { setAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1', { pendingMessages: ['late msg'] })],
    ])
    enqueueAgentNotification({ ...notifyArgs('agent-1'), setAppState })
    const [note] = taskNotifications()
    expect(note).toContain(LATE_MESSAGE_NOTE)
    expect(note).toContain(
      "One or more messages sent to this agent arrived after this run's last step, too late for the result below.",
    )
  })

  test('no pending messages → sentence absent', () => {
    const { setAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1')],
    ])
    enqueueAgentNotification({ ...notifyArgs('agent-1'), setAppState })
    expect(taskNotifications()[0]).not.toContain(LATE_MESSAGE_NOTE)
  })

  test('failed status with pending messages → sentence absent (gate is completed-only)', () => {
    const { setAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1', { pendingMessages: ['late msg'] })],
    ])
    enqueueAgentNotification({
      taskId: 'agent-1',
      description: 'test agent',
      status: 'failed',
      error: 'boom',
      setAppState,
    })
    expect(taskNotifications()[0]).not.toContain(LATE_MESSAGE_NOTE)
  })
})

describe('CC 2.1.299 #149: reason 3 — stopped by a usage limit (Wn/qn/u8t/Vyo)', () => {

  test('usage-limit denial surfaces work-saved + reset + continue sentences', () => {
    const { setAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1')],
    ])
    enqueueAgentNotification({
      ...notifyArgs('agent-1'),
      setAppState,
      usageLimitDenial: {
        limits: { resetsAt: RESETS_AT, rateLimitType: 'five_hour' },
      },
    })
    const [note] = taskNotifications()
    expect(note).toContain(" This agent's work so far is saved.")
    // Official qn → u8t: within-24h formats start with a digit → "resets at".
    expect(note).toMatch(/ The limit resets at \d/)
    expect(note).toContain(USAGE_LIMIT_CONTINUE_SENTENCE)
    expect(note).toContain(
      'Once its requests are accepted again, send the agent a message (SendMessage) to let it continue from where it stopped instead of starting a new agent.',
    )
  })

  test('callerCanContinueAgents:false suppresses the continue sentence (official V gate)', () => {
    expect(
      usageLimitNote(
        { limits: { resetsAt: RESETS_AT, rateLimitType: 'five_hour' } },
        false,
      ),
    ).not.toContain('SendMessage')
    expect(
      usageLimitNote({ limits: { resetsAt: RESETS_AT, rateLimitType: 'five_hour' } }, false),
    ).toContain("This agent's work so far is saved.")
  })

  test('overage limit type omits the reset sentence (official qn gate)', () => {
    const phrase = usageLimitResetPhrase({
      resetsAt: RESETS_AT,
      rateLimitType: 'overage',
    })
    expect(phrase).toBeUndefined()
    const note = usageLimitNote({ limits: { resetsAt: RESETS_AT, rateLimitType: 'overage' } })
    expect(note).not.toContain('The limit')
    expect(note).toContain("This agent's work so far is saved.")
  })

  test('missing resetsAt or rateLimitType omits the reset sentence', () => {
    expect(usageLimitResetPhrase({ resetsAt: RESETS_AT })).toBeUndefined()
    expect(usageLimitResetPhrase({ rateLimitType: 'five_hour' })).toBeUndefined()
    expect(usageLimitResetPhrase(undefined)).toBeUndefined()
  })

  test('denial without limits still surfaces work-saved + continue', () => {
    expect(usageLimitNote({})).toBe(
      ` This agent's work so far is saved.${USAGE_LIMIT_CONTINUE_SENTENCE}`,
    )
  })

  test('no denial → empty string', () => {
    expect(usageLimitNote(undefined)).toBe('')
  })
})

describe('CC 2.1.299 #149: note assembly (official body prefix)', () => {
  test('note wraps Yt+nn+Wn in <note> and starts with a newline', () => {
    const note = buildNotificationNote({
      waitingOnBackgroundWork: false,
      hasLateMessages: false,
    })
    expect(note).toBe(`\n<note>${DEFAULT_STOP_NOTE}</note>`)
  })

  test('all three reasons concatenate in official Yt+nn+Wn order', () => {
    const note = buildNotificationNote({
      waitingOnBackgroundWork: true,
      hasLateMessages: true,
      usageLimitDenial: {},
    })
    expect(note).toBe(
      `\n<note>${BACKGROUND_WORK_INTERIM_NOTE}${LATE_MESSAGE_NOTE} This agent's work so far is saved.${USAGE_LIMIT_CONTINUE_SENTENCE}</note>`,
    )
  })

  test('notification places the note between summary and result sections', () => {
    const { setAppState } = makeHarness([
      ['agent-1', makeAgentTask('agent-1', { pendingMessages: ['late'] })],
    ])
    enqueueAgentNotification({
      ...notifyArgs('agent-1'),
      setAppState,
      usageLimitDenial: { limits: { resetsAt: RESETS_AT, rateLimitType: 'five_hour' } },
    })
    const [message] = taskNotifications()
    const summaryEnd = message!.indexOf('</summary>')
    const noteStart = message!.indexOf('\n<note>')
    const noteEnd = message!.indexOf('</note>')
    const resultStart = message!.indexOf('\n<result>')
    expect(summaryEnd).toBeGreaterThan(-1)
    expect(noteStart).toBe(summaryEnd + '</summary>'.length)
    expect(noteEnd).toBeGreaterThan(noteStart)
    expect(resultStart).toBe(noteEnd + '</note>'.length)
  })
})
