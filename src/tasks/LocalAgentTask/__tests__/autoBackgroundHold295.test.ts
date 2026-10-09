/**
 * CC 2.1.295 (#026) — auto-background hold gate.
 *
 * Official changelog: "Fixed `CLAUDE_AUTO_BACKGROUND_TASKS` moving a subagent
 * to the background while an edit or shell command waited behind it, which
 * started that call before the subagent finished."
 *
 * Official machinery (binary forensics, s295):
 *  - `Awn(e)` hold probe: guards `status==="running" && !isBackgrounded &&
 *    toolUseId!==undefined`, consults `Gn().exclusiveCallQueuedBehind.get(
 *    e.toolUseId)`, returns 'call_queued_behind' | 'response_streaming' |
 *    undefined; once-only `holdLogged` latch + warn log +
 *    `f("task_local_agent_auto_background","call_queued_behind")`.
 *  - `Pwn` timer callback: re-arms at `Math.min(V,_Br)` (official `_Br=1000`)
 *    while 'response_streaming', else `l9r`.
 *  - `l9r`: skips backgrounding on any hold, else backgrounds +
 *    `g("task_local_agent_auto_background")`.
 *  - Arming: initial delay = autoBackgroundMs, re-arm setter pattern
 *    `(nt)=>{dt=nt}` / `clearTimeout(dt)`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { AppState } from '../../../state/AppState.js'
import type { SetAppState } from '../../../Task.js'
import type { LocalAgentTaskState } from '../LocalAgentTask.js'
import {
  getAutoBackgroundHold,
  registerAgentForeground,
  unregisterAgentForeground,
} from '../LocalAgentTask.js'
import {
  resetExclusiveQueuedBehindRegistry,
  setExclusiveQueuedBehindCheck,
  type ExclusiveQueuedBehindCheck,
} from '../../../services/tools/exclusiveCallRegistry.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function makeCheck(over: Partial<ExclusiveQueuedBehindCheck> = {}): ExclusiveQueuedBehindCheck {
  return {
    isQueued: () => false,
    mayYetBeQueued: () => false,
    holdLogged: false,
    ...over,
  }
}

function makeTask(over: Partial<LocalAgentTaskState> = {}): LocalAgentTaskState {
  return {
    id: 'agent-hold',
    type: 'local_agent',
    status: 'running',
    description: 'test agent',
    startTime: Date.now(),
    outputFile: '',
    outputOffset: 0,
    notified: false,
    agentId: 'agent-hold',
    prompt: 'test',
    agentType: 'general-purpose',
    abortController: new AbortController(),
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: false,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    toolUseId: 'tu_agent',
    ...over,
  } as LocalAgentTaskState
}

function makeStateHolder(): {
  getAppState: () => AppState
  setAppState: SetAppState
} {
  let state = { tasks: {} } as unknown as AppState
  const setAppState = ((updater: unknown) => {
    state =
      typeof updater === 'function'
        ? (updater as (prev: AppState) => AppState)(state)
        : (updater as AppState)
  }) as unknown as SetAppState
  return { getAppState: () => state, setAppState }
}

function register(over: {
  agentId: string
  autoBackgroundMs: number
  toolUseId?: string
  getAppState: () => AppState
  setAppState: SetAppState
}) {
  return registerAgentForeground({
    agentId: over.agentId,
    description: 'test agent',
    prompt: 'test',
    selectedAgent: { agentType: 'general-purpose' } as never,
    setAppState: over.setAppState,
    getAppState: over.getAppState,
    autoBackgroundMs: over.autoBackgroundMs,
    toolUseId: over.toolUseId,
  })
}

afterEach(() => {
  resetExclusiveQueuedBehindRegistry()
})

describe('getAutoBackgroundHold (official Awn)', () => {
  test('returns call_queued_behind when an exclusive call is queued behind', () => {
    const check = makeCheck({ isQueued: () => true })
    setExclusiveQueuedBehindCheck('tu_agent', check)
    expect(getAutoBackgroundHold(makeTask())).toBe('call_queued_behind')
    // Once-only log latch (official holdLogged).
    expect(check.holdLogged).toBe(true)
    expect(getAutoBackgroundHold(makeTask())).toBe('call_queued_behind')
  })

  test('returns response_streaming when nothing is queued yet but the response is open', () => {
    setExclusiveQueuedBehindCheck('tu_agent', makeCheck({ mayYetBeQueued: () => true }))
    expect(getAutoBackgroundHold(makeTask())).toBe('response_streaming')
  })

  test('returns undefined when the response closed and nothing queued behind', () => {
    setExclusiveQueuedBehindCheck('tu_agent', makeCheck())
    expect(getAutoBackgroundHold(makeTask())).toBeUndefined()
  })

  test('returns undefined without a registry entry', () => {
    expect(getAutoBackgroundHold(makeTask())).toBeUndefined()
  })

  test('official guards: not running / already backgrounded / no toolUseId / non-agent task', () => {
    setExclusiveQueuedBehindCheck('tu_agent', makeCheck({ isQueued: () => true }))
    expect(getAutoBackgroundHold(makeTask({ status: 'completed' }))).toBeUndefined()
    expect(getAutoBackgroundHold(makeTask({ isBackgrounded: true }))).toBeUndefined()
    expect(getAutoBackgroundHold(makeTask({ toolUseId: undefined }))).toBeUndefined()
    expect(getAutoBackgroundHold({ type: 'shell', id: 'x' })).toBeUndefined()
    expect(getAutoBackgroundHold(undefined)).toBeUndefined()
  })
})

describe('registerAgentForeground auto-background timer (official Pwn/l9r)', () => {
  test('does NOT background while an exclusive call is queued behind the Agent call', async () => {
    const { getAppState, setAppState } = makeStateHolder()
    setExclusiveQueuedBehindCheck('tu_q1', makeCheck({ isQueued: () => true }))
    const reg = register({
      agentId: 'agent-q1',
      autoBackgroundMs: 40,
      toolUseId: 'tu_q1',
      getAppState,
      setAppState,
    })
    await sleep(150)
    const task = getAppState().tasks['agent-q1'] as LocalAgentTaskState
    expect(task.isBackgrounded).toBe(false)
    // The background signal must not have resolved (the edit/shell queued
    // behind would otherwise start before the subagent finished).
    const outcome = await Promise.race([
      reg.backgroundSignal.then(() => 'resolved'),
      sleep(50).then(() => 'pending'),
    ])
    expect(outcome).toBe('pending')
    reg.cancelAutoBackground?.()
    unregisterAgentForeground('agent-q1', setAppState)
  })

  test('re-arms while response_streaming, then backgrounds once the response closes', async () => {
    const { getAppState, setAppState } = makeStateHolder()
    let responseOpen = true
    setExclusiveQueuedBehindCheck('tu_q2', makeCheck({ mayYetBeQueued: () => responseOpen }))
    const reg = register({
      agentId: 'agent-q2',
      autoBackgroundMs: 40,
      toolUseId: 'tu_q2',
      getAppState,
      setAppState,
    })
    // First fire sees response_streaming and must NOT background.
    await sleep(100)
    expect((getAppState().tasks['agent-q2'] as LocalAgentTaskState).isBackgrounded).toBe(false)
    // Response closes (getRemainingResults flips responseOpen false) →
    // the next re-arm backgrounds.
    responseOpen = false
    await sleep(150)
    expect((getAppState().tasks['agent-q2'] as LocalAgentTaskState).isBackgrounded).toBe(true)
    const outcome = await Promise.race([
      reg.backgroundSignal.then(() => 'resolved'),
      sleep(50).then(() => 'pending'),
    ])
    expect(outcome).toBe('resolved')
    reg.cancelAutoBackground?.()
    unregisterAgentForeground('agent-q2', setAppState)
  })

  test('backgrounds as before when no registry entry exists (no hold)', async () => {
    const { getAppState, setAppState } = makeStateHolder()
    const reg = register({
      agentId: 'agent-q3',
      autoBackgroundMs: 40,
      toolUseId: 'tu_q3',
      getAppState,
      setAppState,
    })
    await sleep(150)
    expect((getAppState().tasks['agent-q3'] as LocalAgentTaskState).isBackgrounded).toBe(true)
    const outcome = await Promise.race([
      reg.backgroundSignal.then(() => 'resolved'),
      sleep(50).then(() => 'pending'),
    ])
    expect(outcome).toBe('resolved')
    reg.cancelAutoBackground?.()
    unregisterAgentForeground('agent-q3', setAppState)
  })

  test('cancelAutoBackground clears the re-armed timer', async () => {
    const { getAppState, setAppState } = makeStateHolder()
    setExclusiveQueuedBehindCheck('tu_q4', makeCheck({ mayYetBeQueued: () => true }))
    const reg = register({
      agentId: 'agent-q4',
      autoBackgroundMs: 40,
      toolUseId: 'tu_q4',
      getAppState,
      setAppState,
    })
    // Let it re-arm at least once, then cancel (e.g. subagent completed).
    await sleep(100)
    reg.cancelAutoBackground?.()
    resetExclusiveQueuedBehindRegistry()
    await sleep(120)
    const task = getAppState().tasks['agent-q4'] as LocalAgentTaskState
    expect(task.isBackgrounded).toBe(false)
    unregisterAgentForeground('agent-q4', setAppState)
  })
})
