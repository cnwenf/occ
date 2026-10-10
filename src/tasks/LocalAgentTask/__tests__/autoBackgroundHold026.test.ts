import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetExclusiveCallRegistryForTesting,
  setExclusiveCallQueuedBehind,
} from '../../../services/tools/exclusiveCallRegistry.js'
import { registerAgentForeground } from '../LocalAgentTask.tsx'
import type { AppState } from '../../../state/AppState.js'

/**
 * Official 2.1.295 #026: auto-background timer hold (binary EQo/Pwn/l9r).
 *   EQo arm: dt=setTimeout(Pwn,V,H,e,Math.min(V,_Br),(nt)=>{dt=nt})  (_Br=1000)
 *   Pwn: if(In(h)&&Awn(h)==="response_streaming"){s(setTimeout(Pwn,r,e,n,r,s));return} l9r(n,e)
 *   l9r: if(In(r)&&a9r(r))return!1; let s=YGe(e,n); ... return s
 * A subagent must NOT be moved to the background while a tool call that must
 * run alone is queued behind its Agent call; while the response is still
 * streaming the timer re-arms instead of backgrounding.
 *
 * Suite-hardening notes (OCC-153 round): this file ran LAST in the full
 * single-process suite and (a) failed when a preceding file leaked a
 * mock.module poison over isLocalAgentTask (fixed at the polluter —
 * test/commands/clear/clear-cost-reset.test.ts now restores the real module
 * in afterAll) and (b) could hang the whole suite: a failed assertion skipped
 * the cancelAutoBackground cleanup that sat AFTER it, and a cancel/fire race
 * in the re-arm test could leave an infinite 30ms re-arm chain keeping the
 * event loop alive. Every test now cancels via try/finally, afterAll cancels
 * all registered agents and resets the registry, timing margins are widened
 * for loaded-suite scheduling jitter, and the re-arm test flips the hold flag
 * off BEFORE cancelling so any leaked chain terminates in one bounded fire
 * (a visible assertion failure) instead of spinning forever.
 */

const AUTO_BACKGROUND_MS = 50 // short real timeouts (retry = min(50, 1000) = 50)
// Generous windows: under full-suite load, timer delivery jitters far more
// than the bare interval. The "must NOT background" windows stay small
// multiples of the interval so a refusal is still proven, not just tolerated.
const RESOLVE_WINDOW_MS = AUTO_BACKGROUND_MS * 6
const REFUSE_WINDOW_MS = AUTO_BACKGROUND_MS * 3

function makeSetAppState() {
  const states: AppState[] = []
  let current: AppState = { tasks: {} } as AppState
  const setAppState = (fn: (prev: AppState) => AppState) => {
    current = fn(current)
    states.push(current)
  }
  return {
    setAppState,
    getState: () => current,
  }
}

function makeSelectedAgent() {
  return {
    agentType: 'general-purpose',
    description: 'test agent',
    prompt: 'test prompt',
  }
}

// Every registered agent is tracked so afterAll can guarantee no timer chain
// outlives this file, even when an assertion throws mid-test.
const liveAgents: Array<{ cancelAutoBackground?: () => void }> = []

function registerAgent(agentId: string, toolUseId: string | undefined) {
  const { setAppState, getState } = makeSetAppState()
  const registered = registerAgentForeground({
    agentId,
    description: 'test agent',
    prompt: 'test prompt',
    selectedAgent: makeSelectedAgent() as never,
    setAppState: setAppState as never,
    autoBackgroundMs: AUTO_BACKGROUND_MS,
    toolUseId,
  })
  liveAgents.push(registered)
  return { ...registered, getState }
}

async function resolvesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  const result = await Promise.race([
    p.then(() => 'resolved' as const),
    new Promise<'timeout'>(resolve =>
      setTimeout(() => resolve('timeout'), ms),
    ),
  ])
  return result === 'resolved'
}

describe('CC 2.1.295 #026: auto-background hold (registerAgentForeground timer)', () => {
  beforeEach(() => {
    _resetExclusiveCallRegistryForTesting()
  })

  afterAll(() => {
    // Belt and braces: cancel every timer chain this file armed and clear the
    // exclusive-call registry so nothing leaks into the next file (or keeps
    // the event loop alive at suite teardown).
    for (const agent of liveAgents) {
      agent.cancelAutoBackground?.()
    }
    liveAgents.length = 0
    _resetExclusiveCallRegistryForTesting()
  })

  test('call_queued_behind: the one-shot auto-background refuses and does NOT re-arm while an exclusive call is queued behind the Agent call', async () => {
    // Arrange — an exclusive call sits queued behind this Agent call
    setExclusiveCallQueuedBehind('tu_bg_1', {
      isQueued: () => true,
      mayYetBeQueued: () => false,
      holdLogged: false,
    })
    const agent = registerAgent('agent-bg-1', 'tu_bg_1')

    try {
      // Act — wait well past autoBackgroundMs; l9r refused WITHOUT re-arming,
      // so no later fire can ever resolve the signal
      const backgrounded = await resolvesWithin(
        agent.backgroundSignal,
        REFUSE_WINDOW_MS,
      )

      // Assert — l9r refused: still foreground, resolver untouched
      expect(backgrounded).toBe(false)
      const task = agent.getState().tasks['agent-bg-1'] as
        | { isBackgrounded?: boolean }
        | undefined
      expect(task?.isBackgrounded).toBe(false)
    } finally {
      agent.cancelAutoBackground?.()
    }
  })

  test('response_streaming: the timer re-arms and backgrounds the subagent once the response closes', async () => {
    // Arrange — response still open, nothing queued yet
    let responseOpen = true
    setExclusiveCallQueuedBehind('tu_bg_2', {
      isQueued: () => false,
      mayYetBeQueued: () => responseOpen,
      holdLogged: false,
    })
    const agent = registerAgent('agent-bg-2', 'tu_bg_2')

    try {
      // Act — still open across the first two fire slots: must NOT have
      // backgrounded yet (the timer re-arms instead)
      const earlyBackgrounded = await resolvesWithin(
        agent.backgroundSignal,
        AUTO_BACKGROUND_MS * 2 + AUTO_BACKGROUND_MS / 2,
      )
      expect(earlyBackgrounded).toBe(false)

      // Act — close the response; the re-armed timer (retry = min(V, _Br))
      // must now background the subagent
      responseOpen = false
      const backgrounded = await resolvesWithin(
        agent.backgroundSignal,
        RESOLVE_WINDOW_MS,
      )

      // Assert
      expect(backgrounded).toBe(true)
      const task = agent.getState().tasks['agent-bg-2'] as
        | { isBackgrounded?: boolean }
        | undefined
      expect(task?.isBackgrounded).toBe(true)
    } finally {
      agent.cancelAutoBackground?.()
    }
  })

  test('no hold: backgrounds after autoBackgroundMs exactly like before (YGe path unchanged)', async () => {
    // Arrange — no registry entry for this toolUseId
    const agent = registerAgent('agent-bg-3', 'tu_bg_3')

    try {
      // Act
      const backgrounded = await resolvesWithin(
        agent.backgroundSignal,
        RESOLVE_WINDOW_MS,
      )

      // Assert
      expect(backgrounded).toBe(true)
      const task = agent.getState().tasks['agent-bg-3'] as
        | { isBackgrounded?: boolean }
        | undefined
      expect(task?.isBackgrounded).toBe(true)
    } finally {
      agent.cancelAutoBackground?.()
    }
  })

  test('cancelAutoBackground clears the LATEST (re-armed) timer via the arm-setter (binary: (nt)=>{dt=nt})', async () => {
    // Arrange — response open so the timer keeps re-arming
    let holdOpen = true
    setExclusiveCallQueuedBehind('tu_bg_4', {
      isQueued: () => false,
      mayYetBeQueued: () => holdOpen,
      holdLogged: false,
    })
    const agent = registerAgent('agent-bg-4', 'tu_bg_4')

    try {
      // Act — let it re-arm at least once (2.5 intervals avoids landing
      // exactly on a fire boundary), then release the hold and cancel in the
      // same tick. Releasing the hold FIRST means that even if cancel missed
      // the latest handle, the leaked chain terminates at its next fire with
      // a visible assertion failure instead of an endless re-arm loop.
      await new Promise(resolve =>
        setTimeout(resolve, AUTO_BACKGROUND_MS * 2.5),
      )
      holdOpen = false
      agent.cancelAutoBackground?.()
      _resetExclusiveCallRegistryForTesting()

      // Assert — nothing fires after cancel even though the hold is gone
      const backgrounded = await resolvesWithin(
        agent.backgroundSignal,
        RESOLVE_WINDOW_MS,
      )
      expect(backgrounded).toBe(false)
    } finally {
      agent.cancelAutoBackground?.()
    }
  })
})
