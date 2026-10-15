/**
 * CC 2.1.299 #025 — out-of-process (tmux/iTerm2) teammate spawn site.
 *
 * `registerOutOfProcessTeammateTask` (spawnMultiAgent.ts:843) derived the task
 * description from a raw `${prompt.substring(0,50)}…` fragment. It now routes
 * through the shared `describeTeammatePrompt` (official `GQn`, redact-then-
 * truncate) so the stored/displayed/hook-emitted description can never contain
 * a detected secret. This asserts the fix at the actual spawn site by capturing
 * the task state handed to AppState via registerTask's setAppState.
 */
import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../../tasks/InProcessTeammateTask/types.js'
import { describeTeammatePrompt } from '../../../utils/swarm/describeTeammate.js'
import { registerOutOfProcessTeammateTask } from '../spawnMultiAgent.js'

const SK_ANT_PROMPT =
  'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 please review the auth module'
const AWS_PROMPT =
  'AKIAIOSFODNN7EXAMPLE is the access key id for the deploy pipeline'
const CLEAN_SHORT = 'Summarize the auth module and list its exports'

function capturingSetAppState() {
  let registered: InProcessTeammateTaskState | undefined
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    const next = updater({ tasks: {} } as unknown as AppState)
    const ids = Object.keys(next.tasks ?? {})
    if (ids.length > 0) {
      registered = next.tasks[ids[0]] as InProcessTeammateTaskState
    }
  }
  return { setAppState, getRegistered: () => registered }
}

function spawn(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  prompt: string,
  sanitizedName = 'reviewer',
): void {
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId: `${sanitizedName}@team-a`,
    sanitizedName,
    teamName: 'team-a',
    teammateColor: 'blue',
    prompt,
    paneId: '%1',
    insideTmux: true,
    backendType: 'tmux',
  })
}

describe('registerOutOfProcessTeammateTask — derived description carries no secret (#025)', () => {
  test('sk-ant key in first 50 chars → redacted description', () => {
    const { setAppState, getRegistered } = capturingSetAppState()
    spawn(setAppState, SK_ANT_PROMPT)
    const task = getRegistered()
    expect(task).toBeDefined()
    expect(task?.description).toBe(
      'reviewer: [REDACTED] please review the auth module',
    )
    expect(task?.description).not.toContain('sk-ant')
    expect(task?.description).not.toContain(
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    )
    // raw prompt still stored as the teammate input, not the description
    expect(task?.prompt).toBe(SK_ANT_PROMPT)
  })

  test('AWS access key id in first 50 chars → redacted description', () => {
    const { setAppState, getRegistered } = capturingSetAppState()
    spawn(setAppState, AWS_PROMPT)
    expect(getRegistered()?.description).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(getRegistered()?.description).toContain('[REDACTED]')
  })

  test('clean prompt → description unchanged (regression)', () => {
    const { setAppState, getRegistered } = capturingSetAppState()
    spawn(setAppState, CLEAN_SHORT, 'summarizer')
    expect(getRegistered()?.description).toBe(`summarizer: ${CLEAN_SHORT}`)
  })

  test('description matches the shared describeTeammatePrompt seam', () => {
    const { setAppState, getRegistered } = capturingSetAppState()
    spawn(setAppState, SK_ANT_PROMPT, 'worker')
    expect(getRegistered()?.description).toBe(
      `worker: ${describeTeammatePrompt(SK_ANT_PROMPT)}`,
    )
  })
})
