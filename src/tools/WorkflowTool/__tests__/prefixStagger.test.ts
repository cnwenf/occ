/**
 * CC 2.1.229 (changelog #24 / binary `IZp`): workflow prefix stagger gate.
 *
 * Tests the verbatim mechanism ported into prefixStagger.ts: leader/waiter
 * enter semantics, responded -> markWarm, cap-bounded waits, warm-TTL expiry
 * (via injected clock), failed-leader release via done(), the cap env
 * resolver, and the prefix-key shape.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  WORKFLOW_PREFIX_STAGGER_DEFAULT_MS,
  WORKFLOW_PREFIX_WARM_TTL_MS,
  WorkflowPrefixStaggerGate,
  buildWorkflowPrefixKey,
  getWorkflowPrefixStaggerCapMs,
  getWorkflowPrefixStaggerGate,
} from '../prefixStagger.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('WorkflowPrefixStaggerGate (2.1.229 #24, binary IZp)', () => {
  test('first enter on a key is the leader and does not wait', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const handle = await gate.enter('k', { capMs: 5000 })
    expect(handle.leader).toBe(true)
    expect(handle.waitedMs).toBe(0)
    expect(gate.stateOf('k')).toBe('warming')
    handle.responded()
  })

  test('second enter on a warming key waits until the leader responds', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 5000 })
    const waiterPromise = gate.enter('k', { capMs: 5000 })
    // Give the waiter a moment to block on the warming entry.
    await sleep(30)
    leader.responded()
    const waiter = await waiterPromise
    expect(waiter.leader).toBe(false)
    expect(waiter.waitedMs).toBeGreaterThanOrEqual(20)
    expect(gate.stateOf('k')).toBe('warm')
  })

  test('waiter is bounded by capMs when the leader never responds', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 5000 })
    const start = Date.now()
    const waiter = await gate.enter('k', { capMs: 50 })
    const elapsed = Date.now() - start
    expect(waiter.leader).toBe(false)
    expect(waiter.waitedMs).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(2000)
    // The key is still warming — the cap release does not warm it.
    expect(gate.stateOf('k')).toBe('warming')
    leader.responded()
  })

  test('capMs 0 makes later enters pass through without waiting', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 0 })
    const start = Date.now()
    const second = await gate.enter('k', { capMs: 0 })
    expect(Date.now() - start).toBeLessThan(50)
    expect(second.leader).toBe(false)
    expect(second.waitedMs).toBe(0)
    leader.responded()
  })

  test('enter on a warm key passes through immediately', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 5000 })
    leader.responded()
    expect(gate.stateOf('k')).toBe('warm')
    const start = Date.now()
    const late = await gate.enter('k', { capMs: 5000 })
    expect(Date.now() - start).toBeLessThan(50)
    expect(late.leader).toBe(false)
    expect(late.waitedMs).toBe(0)
  })

  test('done() by a never-responded leader releases waiters and clears the entry', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 5000 })
    const waiterPromise = gate.enter('k', { capMs: 5000 })
    await sleep(20)
    // Leader fails without ever responding — waiters must not hang.
    leader.done()
    const start = Date.now()
    const waiter = await waiterPromise
    expect(Date.now() - start).toBeLessThan(1000)
    expect(waiter.leader).toBe(false)
    expect(gate.stateOf('k')).toBe('cold')
  })

  test('done() after responded() is a no-op (key stays warm)', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 5000 })
    leader.responded()
    leader.done()
    expect(gate.stateOf('k')).toBe('warm')
  })

  test('done() by a non-leader is a no-op', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 5000 })
    const second = await gate.enter('k', { capMs: 0 })
    second.done()
    expect(gate.stateOf('k')).toBe('warming')
    leader.responded()
  })

  test('responded() is idempotent', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 5000 })
    leader.responded()
    leader.responded()
    expect(gate.stateOf('k')).toBe('warm')
  })

  test('warm entry expires after the TTL (injected clock)', async () => {
    let clock = 1_000_000
    const gate = new WorkflowPrefixStaggerGate(() => clock)
    const leader = await gate.enter('k', { capMs: 5000 })
    leader.responded()
    expect(gate.stateOf('k')).toBe('warm')
    // Just before expiry — still warm.
    clock += WORKFLOW_PREFIX_WARM_TTL_MS - 1
    expect(gate.stateOf('k')).toBe('warm')
    // At the TTL boundary — cold (binary: `until <= now`).
    clock += 1
    expect(gate.stateOf('k')).toBe('cold')
    // A new enter becomes the leader again (expired entry swept).
    const next = await gate.enter('k', { capMs: 5000 })
    expect(next.leader).toBe(true)
    next.responded()
  })

  test('enter sweeps expired warm entries of other keys', async () => {
    let clock = 1_000_000
    const gate = new WorkflowPrefixStaggerGate(() => clock)
    const leader = await gate.enter('old', { capMs: 5000 })
    leader.responded()
    clock += WORKFLOW_PREFIX_WARM_TTL_MS + 1
    // Entering a different key sweeps the expired 'old' entry.
    await gate.enter('fresh', { capMs: 5000 })
    expect(gate.stateOf('old')).toBe('cold')
  })

  test('already-aborted signal makes a waiter return immediately', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 5000 })
    const controller = new AbortController()
    controller.abort()
    const start = Date.now()
    const waiter = await gate.enter('k', { capMs: 5000, signal: controller.signal })
    expect(Date.now() - start).toBeLessThan(50)
    expect(waiter.leader).toBe(false)
    leader.responded()
  })

  test('aborting a waiting signal releases it early', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 5000 })
    const controller = new AbortController()
    const waiterPromise = gate.enter('k', {
      capMs: 5000,
      signal: controller.signal,
    })
    await sleep(20)
    controller.abort()
    const start = Date.now()
    const waiter = await waiterPromise
    expect(Date.now() - start).toBeLessThan(1000)
    expect(waiter.leader).toBe(false)
    leader.responded()
  })

  test('clear() releases warming waiters and empties the gate', async () => {
    const gate = new WorkflowPrefixStaggerGate()
    const leader = await gate.enter('k', { capMs: 5000 })
    const waiterPromise = gate.enter('k', { capMs: 5000 })
    await sleep(20)
    gate.clear()
    const waiter = await waiterPromise
    expect(waiter.leader).toBe(false)
    expect(gate.stateOf('k')).toBe('cold')
    void leader
  })
})

describe('getWorkflowPrefixStaggerCapMs (binary call-site cap resolution)', () => {
  test('defaults to 5000ms when no env is set', () => {
    expect(getWorkflowPrefixStaggerCapMs({})).toBe(
      WORKFLOW_PREFIX_STAGGER_DEFAULT_MS,
    )
    expect(WORKFLOW_PREFIX_STAGGER_DEFAULT_MS).toBe(5000)
  })

  test('DISABLE_PROMPT_CACHING forces cap 0', () => {
    expect(getWorkflowPrefixStaggerCapMs({ DISABLE_PROMPT_CACHING: '1' })).toBe(0)
    // Takes precedence over an explicit override (binary call-site condition).
    expect(
      getWorkflowPrefixStaggerCapMs({
        DISABLE_PROMPT_CACHING: 'true',
        CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS: '123',
      }),
    ).toBe(0)
  })

  test('CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS overrides the default', () => {
    expect(
      getWorkflowPrefixStaggerCapMs({ CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS: '123' }),
    ).toBe(123)
    expect(
      getWorkflowPrefixStaggerCapMs({ CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS: '0' }),
    ).toBe(0)
  })

  test('invalid overrides fall back to the default', () => {
    expect(
      getWorkflowPrefixStaggerCapMs({ CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS: 'abc' }),
    ).toBe(WORKFLOW_PREFIX_STAGGER_DEFAULT_MS)
    expect(
      getWorkflowPrefixStaggerCapMs({ CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS: '-5' }),
    ).toBe(WORKFLOW_PREFIX_STAGGER_DEFAULT_MS)
    expect(
      getWorkflowPrefixStaggerCapMs({ CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS: '' }),
    ).toBe(WORKFLOW_PREFIX_STAGGER_DEFAULT_MS)
  })
})

describe('buildWorkflowPrefixKey (binary Ze shape)', () => {
  test('joins all six parts with a newline', () => {
    const key = buildWorkflowPrefixKey({
      model: 'claude-sonnet-5',
      effort: 'high',
      agentType: 'general-purpose',
      toolNames: 'Bash,Read,Write',
      schemaJson: '{"type":"object"}',
      cwd: '/repo',
    })
    expect(key).toBe(
      'claude-sonnet-5\nhigh\ngeneral-purpose\nBash,Read,Write\n{"type":"object"}\n/repo',
    )
  })

  test('undefined model/effort become empty strings', () => {
    const key = buildWorkflowPrefixKey({
      model: undefined,
      effort: undefined,
      agentType: 'worker',
      toolNames: '',
      schemaJson: '',
      cwd: '/repo',
    })
    expect(key).toBe('\n\nworker\n\n\n/repo')
  })
})

describe('getWorkflowPrefixStaggerGate (binary RZp singleton)', () => {
  test('returns the same instance across calls', () => {
    expect(getWorkflowPrefixStaggerGate()).toBe(getWorkflowPrefixStaggerGate())
  })

  afterEach(() => {
    // Keep the shared singleton clean for other test files.
    getWorkflowPrefixStaggerGate().clear()
  })
})

describe('warm TTL constant', () => {
  test('matches the binary s_v value', () => {
    expect(WORKFLOW_PREFIX_WARM_TTL_MS).toBe(270_000)
  })
})
