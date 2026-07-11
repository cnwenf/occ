import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearCommandQueue,
  enqueue,
  getCommandQueueSnapshot,
  remove as removeFromQueue,
} from '../messageQueueManager.js'
import { getQueuedCommandDrainSnapshot } from '../queuedCommandDrain.js'

// 2.1.205 #3: a message sent while Claude was working used to be lost when
// the turn ended at --max-turns. The drain consumed it (removed from the
// queue) and turned it into a tool attachment, but the max_turns return
// meant the model never saw it. Fix: getQueuedCommandDrainSnapshot returns
// [] when the current turn will end at max_turns, leaving queued prompts in
// the queue for the next query.

const MAIN_THREAD_OPTS = {
  sleepRan: false,
  isMainThread: true,
  currentAgentId: undefined,
} as const

describe('getQueuedCommandDrainSnapshot (2.1.205 #3)', () => {
  beforeEach(() => {
    clearCommandQueue()
  })

  afterEach(() => {
    clearCommandQueue()
  })

  describe('max_turns preservation', () => {
    test('returns [] when the next turn exceeds maxTurns (prompt stays queued)', () => {
      enqueue({ value: 'hello from mid-turn', mode: 'prompt' })

      const snapshot = getQueuedCommandDrainSnapshot({
        ...MAIN_THREAD_OPTS,
        maxTurns: 1,
        turnCount: 1, // nextTurn = 2 > 1 → will hit max_turns
      })

      expect(snapshot).toEqual([])
      // The prompt is NOT consumed — still in the queue for the next query.
      expect(getCommandQueueSnapshot()).toHaveLength(1)
    })

    test('returns the prompt when maxTurns will NOT be hit (normal drain)', () => {
      enqueue({ value: 'hello from mid-turn', mode: 'prompt' })

      const snapshot = getQueuedCommandDrainSnapshot({
        ...MAIN_THREAD_OPTS,
        maxTurns: 5,
        turnCount: 1, // nextTurn = 2 ≤ 5 → continue
      })

      expect(snapshot).toHaveLength(1)
      expect(snapshot[0]!.value).toBe('hello from mid-turn')
      // Read-only snapshot — command still in queue until query.ts removes it.
      expect(getCommandQueueSnapshot()).toHaveLength(1)
    })

    test('returns the prompt when maxTurns is unset (no limit)', () => {
      enqueue({ value: 'no limit', mode: 'prompt' })

      const snapshot = getQueuedCommandDrainSnapshot({
        ...MAIN_THREAD_OPTS,
        maxTurns: undefined,
        turnCount: 999,
      })

      expect(snapshot).toHaveLength(1)
    })

    test('boundary: nextTurn === maxTurns does NOT trigger preservation', () => {
      // nextTurn (2) == maxTurns (2) is NOT > maxTurns → continue, drain.
      enqueue({ value: 'boundary', mode: 'prompt' })

      const snapshot = getQueuedCommandDrainSnapshot({
        ...MAIN_THREAD_OPTS,
        maxTurns: 2,
        turnCount: 1,
      })

      expect(snapshot).toHaveLength(1)
    })
  })

  describe('end-to-end queue preservation (mirrors query.ts flow)', () => {
    test('willHitMaxTurns: snapshot empty → nothing removed → prompt survives', () => {
      enqueue({ value: 'preserved', mode: 'prompt' })

      const snapshot = getQueuedCommandDrainSnapshot({
        ...MAIN_THREAD_OPTS,
        maxTurns: 1,
        turnCount: 1,
      })
      // query.ts builds consumedCommands from the snapshot; empty snapshot →
      // consumedCommands is empty → removeFromQueue is a no-op.
      const consumed = snapshot.filter(
        cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
      )
      removeFromQueue(consumed)

      expect(getCommandQueueSnapshot()).toHaveLength(1)
    })

    test('normal drain: snapshot has prompt → consumed → queue emptied', () => {
      enqueue({ value: 'drained', mode: 'prompt' })

      const snapshot = getQueuedCommandDrainSnapshot({
        ...MAIN_THREAD_OPTS,
        maxTurns: 5,
        turnCount: 1,
      })
      const consumed = snapshot.filter(
        cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
      )
      removeFromQueue(consumed)

      expect(getCommandQueueSnapshot()).toHaveLength(0)
    })
  })

  describe('subagent scoping', () => {
    test('subagent only drains task-notifications addressed to it', () => {
      const agentA = 'agent-A' as never // AgentId is a branded string
      enqueue({ value: 'my task done', mode: 'task-notification', agentId: agentA })
      enqueue({ value: 'other agent task', mode: 'task-notification', agentId: 'agent-B' as never })
      enqueue({ value: 'user prompt', mode: 'prompt', agentId: agentA })

      const snapshot = getQueuedCommandDrainSnapshot({
        sleepRan: false,
        isMainThread: false,
        currentAgentId: agentA,
        maxTurns: undefined,
        turnCount: 0,
      })

      expect(snapshot).toHaveLength(1)
      expect(snapshot[0]!.value).toBe('my task done')
      // Subagent never drains user prompts, even its own.
      expect(snapshot.find(c => c.mode === 'prompt')).toBeUndefined()
    })
  })

  describe('slash command exclusion', () => {
    test('slash commands are excluded from the drain snapshot', () => {
      enqueue({ value: '/commit', mode: 'prompt' })
      enqueue({ value: 'a real prompt', mode: 'prompt' })

      const snapshot = getQueuedCommandDrainSnapshot({
        ...MAIN_THREAD_OPTS,
        maxTurns: undefined,
        turnCount: 0,
      })

      expect(snapshot).toHaveLength(1)
      expect(snapshot[0]!.value).toBe('a real prompt')
      // Slash command stays in the queue for processSlashCommand after the turn.
      expect(getCommandQueueSnapshot()).toHaveLength(2)
    })
  })
})
