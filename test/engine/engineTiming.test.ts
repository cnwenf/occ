import { describe, test, expect, beforeEach, mock } from 'bun:test'
import {
  monotonicDurationMs,
  monotonicNow,
} from '../../src/QueryEngine.js'
import { QueryEngine } from '../../src/QueryEngine.js'
import { hasToolUseBlocks } from '../../src/query.js'
import type { Message, AssistantMessage } from '../../src/types/message.js'
import type { QueryEngineConfig } from '../../src/QueryEngine.js'

/**
 * CC 2.1.218 #19 — turn-duration must come from a MONOTONIC source so a
 * system clock adjustment (NTP step, manual change) can never produce a
 * negative or wildly incorrect duration. Official binary exposes
 * `monotonicTimeNow` + `performance.now()` for deadlines; the turn-duration
 * math previously used `Date.now()` (wall clock, subject to rollback).
 */
describe('CC 2.1.218 #19 — monotonic turn duration', () => {
  test('monotonicDurationMs returns elapsed ms for normal ordering', () => {
    expect(monotonicDurationMs(100, 250)).toBe(150)
    expect(monotonicDurationMs(0, 0)).toBe(0)
  })

  test('monotonicDurationMs never goes negative across a simulated clock rollback', () => {
    // start captured before the clock jumps backward; end < start.
    // Wall-clock math (Date.now() - startTime) would yield a huge negative;
    // the monotonic helper clamps at 0.
    expect(monotonicDurationMs(10_000, 5_000)).toBe(0)
    expect(monotonicDurationMs(500, 499)).toBe(0)
  })

  test('monotonicNow is monotonic across a Date.now() regression', () => {
    // Force Date.now to jump backward between two monotonicNow() samples.
    const realDateNow = Date.now
    let t = 2_000_000_000_000
    Date.now = () => t
    try {
      const a = monotonicNow()
      t -= 60_000 // wall clock jumps back 60s (NTP step / manual change)
      const b = monotonicNow()
      // A monotonic source must not regress; b >= a.
      expect(b).toBeGreaterThanOrEqual(a)
    } finally {
      Date.now = realDateNow
    }
  })
})

/**
 * CC 2.1.218 #12 — engine teardown race could start and abandon a phantom
 * turn; input pushed after close must be consistent. Official binary:
 * `[engine] dropped turn intent received after close()` (warn level), in the
 * queued-message handler `Ke` → `case "turn": if (ae) { warn; break }`.
 * The closed flag `ae` makes submitMessage a no-op so no phantom turn can
 * start and the intent is dropped consistently.
 */
describe('CC 2.1.218 #12 — no phantom turn after close', () => {
  let warnSpy: ReturnType<typeof console.warn>
  const originalWarn = console.warn

  beforeEach(() => {
    warnSpy = mock(() => {})
    console.warn = warnSpy as unknown as typeof console.warn
  })

  function makeEngine(): QueryEngine {
    const config = {
      cwd: '/tmp',
      commands: [],
      tools: [],
      mcpClients: [],
      canUseTool: async () => ({
        behavior: 'allow' as const,
        updatedInput: undefined,
        state: {},
      }),
      getAppState: () => ({}) as any,
      setAppState: () => {},
      readFileCache: new Map(),
    } as unknown as QueryEngineConfig
    return new QueryEngine(config)
  }

  test('a turn cannot start after the engine is closed', async () => {
    const engine = makeEngine()
    engine.close()
    // After close, submitMessage must drop the turn intent without starting
    // a turn — no SDK messages yielded (no phantom turn).
    const yielded: unknown[] = []
    for await (const msg of engine.submitMessage('phantom')) {
      yielded.push(msg)
    }
    expect(yielded).toEqual([])
    // Official warn string must be emitted exactly once.
    const calls = warnSpy.mock.calls.flat() as string[]
    const dropped = calls.filter(c =>
      typeof c === 'string' ? c.includes('dropped turn intent received after close') : false,
    )
    expect(dropped.length).toBe(1)
  })

  test('close is idempotent — calling twice does not throw or double-warn', () => {
    const engine = makeEngine()
    engine.close()
    engine.close()
    const calls = warnSpy.mock.calls.flat() as string[]
    const dropped = calls.filter(c =>
      typeof c === 'string' ? c.includes('dropped turn intent received after close') : false,
    )
    // close() itself should not warn; only the dropped turn intent warns.
    expect(dropped.length).toBe(0)
  })
})

/**
 * CC 2.1.218 #13 — spurious "[Request interrupted by user]" messages after
 * interrupted tool calls, and an unpaired tool_use block. Official binary
 * carries both constants:
 *   t8 = "[Request interrupted by user]"
 *   GI  = "[Request interrupted by user for tool use]"
 * The streaming-abort path previously emitted the generic (t8) variant
 * unconditionally, even when tool_use blocks were present — a spurious
 * generic interrupt after an interrupted tool call. Fix: select the tool-use
 * variant (GI) when tool_use blocks exist in the assistant trajectory.
 */
describe('CC 2.1.218 #13 — tool_use-aware interrupt selection', () => {
  function asst(content: Array<{ type: string; id?: string }>): AssistantMessage {
    return {
      type: 'assistant',
      uuid: 'a-' + Math.random().toString(36).slice(2),
      message: { role: 'assistant', content: content as any },
    } as unknown as AssistantMessage
  }

  test('hasToolUseBlocks is false when no tool_use blocks are present', () => {
    expect(hasToolUseBlocks([asst([{ type: 'text' }])])).toBe(false)
    expect(hasToolUseBlocks([])).toBe(false)
  })

  test('hasToolUseBlocks is true when a tool_use block is present', () => {
    expect(
      hasToolUseBlocks([
        asst([{ type: 'text' }, { type: 'tool_use', id: 'tu_1' }]),
      ]),
    ).toBe(true)
  })

  test('hasToolUseBlocks is true when tool_use spans multiple assistant messages', () => {
    expect(
      hasToolUseBlocks([
        asst([{ type: 'text' }]),
        asst([{ type: 'tool_use', id: 'tu_2' }]),
      ]),
    ).toBe(true)
  })
})
