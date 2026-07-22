import { describe, expect, test } from 'bun:test'
import {
  TaskRegistryImpl,
  getNoopTaskRegistry,
  type TaskRegistry,
} from '../taskRegistry.js'

/**
 * CC 2.1.212: per-session TaskRegistry primitive. The real implementation
 * is a mutable counter by nature (matches the official binary); the no-op
 * stub returns 0 / no-ops for headless/SDK contexts.
 */

describe('TaskRegistryImpl (real registry)', () => {
  test('starts at zero for both counters', () => {
    // Arrange
    const reg = new TaskRegistryImpl()

    // Assert
    expect(reg.getTotalAgentSpawns()).toBe(0)
    expect(reg.getWebSearchCalls()).toBe(0)
  })

  test('incrementTotalAgentSpawns increases the count by one', () => {
    // Arrange
    const reg = new TaskRegistryImpl()

    // Act
    reg.incrementTotalAgentSpawns()
    reg.incrementTotalAgentSpawns()

    // Assert
    expect(reg.getTotalAgentSpawns()).toBe(2)
  })

  test('incrementWebSearchCalls increases the count by one', () => {
    // Arrange
    const reg = new TaskRegistryImpl()

    // Act
    reg.incrementWebSearchCalls()
    reg.incrementWebSearchCalls()
    reg.incrementWebSearchCalls()

    // Assert
    expect(reg.getWebSearchCalls()).toBe(3)
  })

  test('resetTotalAgentSpawns sets the count back to zero', () => {
    // Arrange
    const reg = new TaskRegistryImpl()
    reg.incrementTotalAgentSpawns()
    reg.incrementTotalAgentSpawns()
    reg.incrementTotalAgentSpawns()

    // Act
    reg.resetTotalAgentSpawns()

    // Assert
    expect(reg.getTotalAgentSpawns()).toBe(0)
  })

  test('resetWebSearchCalls sets the count back to zero', () => {
    // Arrange
    const reg = new TaskRegistryImpl()
    reg.incrementWebSearchCalls()
    reg.incrementWebSearchCalls()

    // Act
    reg.resetWebSearchCalls()

    // Assert
    expect(reg.getWebSearchCalls()).toBe(0)
  })

  test('the two counters are independent', () => {
    // Arrange
    const reg = new TaskRegistryImpl()

    // Act
    reg.incrementTotalAgentSpawns()
    reg.incrementWebSearchCalls()
    reg.incrementWebSearchCalls()

    // Assert
    expect(reg.getTotalAgentSpawns()).toBe(1)
    expect(reg.getWebSearchCalls()).toBe(2)
  })

  test('each instance is isolated from other instances', () => {
    // Arrange
    const a = new TaskRegistryImpl()
    const b = new TaskRegistryImpl()

    // Act
    a.incrementTotalAgentSpawns()
    b.incrementWebSearchCalls()
    b.incrementWebSearchCalls()

    // Assert
    expect(a.getTotalAgentSpawns()).toBe(1)
    expect(a.getWebSearchCalls()).toBe(0)
    expect(b.getTotalAgentSpawns()).toBe(0)
    expect(b.getWebSearchCalls()).toBe(2)
  })

  test('satisfies the TaskRegistry interface', () => {
    // Arrange + Act
    const reg: TaskRegistry = new TaskRegistryImpl()

    // Assert — typecheck-only; exercises all six methods.
    expect(reg.getTotalAgentSpawns()).toBe(0)
    expect(reg.getWebSearchCalls()).toBe(0)
    reg.incrementTotalAgentSpawns()
    reg.incrementWebSearchCalls()
    reg.resetTotalAgentSpawns()
    reg.resetWebSearchCalls()
    expect(reg.getTotalAgentSpawns()).toBe(0)
    expect(reg.getWebSearchCalls()).toBe(0)
  })
})

describe('getNoopTaskRegistry (headless/SDK stub)', () => {
  test('getTotalAgentSpawns always returns 0 and does not accumulate', () => {
    // Arrange
    const reg = getNoopTaskRegistry()

    // Act — increment is a no-op
    reg.incrementTotalAgentSpawns()
    reg.incrementTotalAgentSpawns()
    reg.incrementTotalAgentSpawns()

    // Assert
    expect(reg.getTotalAgentSpawns()).toBe(0)
  })

  test('getWebSearchCalls always returns 0 and does not accumulate', () => {
    // Arrange
    const reg = getNoopTaskRegistry()

    // Act
    reg.incrementWebSearchCalls()
    reg.incrementWebSearchCalls()

    // Assert
    expect(reg.getWebSearchCalls()).toBe(0)
  })

  test('reset methods are no-ops and do not throw', () => {
    // Arrange
    const reg = getNoopTaskRegistry()

    // Act + Assert — no throw
    expect(() => reg.resetTotalAgentSpawns()).not.toThrow()
    expect(() => reg.resetWebSearchCalls()).not.toThrow()
    expect(reg.getTotalAgentSpawns()).toBe(0)
    expect(reg.getWebSearchCalls()).toBe(0)
  })

  test('returns the same stateless instance across calls', () => {
    // Arrange + Act
    const a = getNoopTaskRegistry()
    const b = getNoopTaskRegistry()

    // Assert — the stub is stateless; identity is stable.
    expect(a).toBe(b)
  })
})

describe('TaskRegistryImpl concurrent-subagent slot (CC 2.1.217)', () => {
  test('getConcurrentSubagents starts at 0', () => {
    const reg = new TaskRegistryImpl()
    expect(reg.getConcurrentSubagents()).toBe(0)
  })

  test('takeConcurrencySlot increments the running count', () => {
    const reg = new TaskRegistryImpl()
    reg.takeConcurrencySlot()
    reg.takeConcurrencySlot()
    expect(reg.getConcurrentSubagents()).toBe(2)
  })

  test('release decrements the running count', () => {
    const reg = new TaskRegistryImpl()
    const release = reg.takeConcurrencySlot()
    expect(reg.getConcurrentSubagents()).toBe(1)
    release()
    expect(reg.getConcurrentSubagents()).toBe(0)
  })

  test('release is idempotent — calling twice does not underflow', () => {
    const reg = new TaskRegistryImpl()
    const release = reg.takeConcurrencySlot()
    release()
    release()
    release()
    expect(reg.getConcurrentSubagents()).toBe(0)
  })

  test('running count clamps at 0 (never negative)', () => {
    const reg = new TaskRegistryImpl()
    const release = reg.takeConcurrencySlot()
    release()
    // Extra release beyond zero stays at 0 (mirrors official Math.max(0, …))
    release()
    expect(reg.getConcurrentSubagents()).toBe(0)
  })

  test('multiple in-flight slots are tracked independently', () => {
    const reg = new TaskRegistryImpl()
    const r1 = reg.takeConcurrencySlot()
    const r2 = reg.takeConcurrencySlot()
    const r3 = reg.takeConcurrencySlot()
    expect(reg.getConcurrentSubagents()).toBe(3)
    r2()
    expect(reg.getConcurrentSubagents()).toBe(2)
    r1()
    expect(reg.getConcurrentSubagents()).toBe(1)
    r3()
    expect(reg.getConcurrentSubagents()).toBe(0)
  })

  test('concurrent counter is independent of the total-spawn counter', () => {
    const reg = new TaskRegistryImpl()
    reg.incrementTotalAgentSpawns()
    reg.takeConcurrencySlot()
    reg.takeConcurrencySlot()
    expect(reg.getTotalAgentSpawns()).toBe(1)
    expect(reg.getConcurrentSubagents()).toBe(2)
  })
})

describe('getNoopTaskRegistry concurrent-subagent slot (CC 2.1.217)', () => {
  test('getConcurrentSubagents always returns 0 (headless never blocks)', () => {
    const reg = getNoopTaskRegistry()
    reg.takeConcurrencySlot()
    reg.takeConcurrencySlot()
    expect(reg.getConcurrentSubagents()).toBe(0)
  })

  test('takeConcurrencySlot returns a no-op release that does not throw', () => {
    const reg = getNoopTaskRegistry()
    const release = reg.takeConcurrencySlot()
    expect(() => release()).not.toThrow()
    expect(reg.getConcurrentSubagents()).toBe(0)
  })
})
