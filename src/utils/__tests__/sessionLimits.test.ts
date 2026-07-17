import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  assertSubagentCapAndIncrement,
  getMaxSubagentsPerSession,
  getMaxWebSearchesPerSession,
} from '../sessionLimits.js'
import { TaskRegistryImpl, getNoopTaskRegistry } from '../taskRegistry.js'

/**
 * CC 2.1.212: per-session cap primitives.
 *   CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION (default 200)
 *   CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION   (default 200)
 * Bad env values fall back to 200 (match the upstream `??` semantics).
 */

const WEB_ENV = 'CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION'
const AGENT_ENV = 'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION'

const originalWeb = process.env[WEB_ENV]
const originalAgent = process.env[AGENT_ENV]

beforeEach(() => {
  delete process.env[WEB_ENV]
  delete process.env[AGENT_ENV]
})

afterEach(() => {
  if (originalWeb === undefined) delete process.env[WEB_ENV]
  else process.env[WEB_ENV] = originalWeb
  if (originalAgent === undefined) delete process.env[AGENT_ENV]
  else process.env[AGENT_ENV] = originalAgent
})

describe('getMaxWebSearchesPerSession', () => {
  test('defaults to 200 when the env var is unset', () => {
    // Arrange — env unset by beforeEach
    // Act
    const max = getMaxWebSearchesPerSession()

    // Assert
    expect(max).toBe(200)
  })

  test('env override changes the limit', () => {
    // Arrange
    process.env[WEB_ENV] = '5'

    // Act
    const max = getMaxWebSearchesPerSession()

    // Assert
    expect(max).toBe(5)
  })

  test('bad env value (non-numeric) falls back to 200', () => {
    // Arrange
    process.env[WEB_ENV] = 'not-a-number'

    // Act
    const max = getMaxWebSearchesPerSession()

    // Assert
    expect(max).toBe(200)
  })

  test('empty string env value falls back to 200', () => {
    // Arrange
    process.env[WEB_ENV] = ''

    // Act
    const max = getMaxWebSearchesPerSession()

    // Assert
    expect(max).toBe(200)
  })

  test('zero is not a valid positive limit — falls back to 200', () => {
    // Arrange
    process.env[WEB_ENV] = '0'

    // Act
    const max = getMaxWebSearchesPerSession()

    // Assert
    expect(max).toBe(200)
  })

  test('negative value falls back to 200', () => {
    // Arrange
    process.env[WEB_ENV] = '-5'

    // Act
    const max = getMaxWebSearchesPerSession()

    // Assert
    expect(max).toBe(200)
  })

  test('fractional value falls back to 200 (must be a finite positive integer)', () => {
    // Arrange
    process.env[WEB_ENV] = '2.5'

    // Act
    const max = getMaxWebSearchesPerSession()

    // Assert
    expect(max).toBe(200)
  })

  test('scientific notation 1e3 parses to 1000, not 1', () => {
    // Arrange — mirrors CC 2.1.208 #11 scientific-notation fix
    process.env[WEB_ENV] = '1e3'

    // Act
    const max = getMaxWebSearchesPerSession()

    // Assert
    expect(max).toBe(1000)
  })
})

describe('getMaxSubagentsPerSession', () => {
  test('defaults to 200 when the env var is unset', () => {
    expect(getMaxSubagentsPerSession()).toBe(200)
  })

  test('env override changes the limit', () => {
    process.env[AGENT_ENV] = '3'
    expect(getMaxSubagentsPerSession()).toBe(3)
  })

  test('bad env value (non-numeric) falls back to 200', () => {
    process.env[AGENT_ENV] = 'garbage'
    expect(getMaxSubagentsPerSession()).toBe(200)
  })

  test('zero falls back to 200 (not a valid positive limit)', () => {
    process.env[AGENT_ENV] = '0'
    expect(getMaxSubagentsPerSession()).toBe(200)
  })
})

describe('assertSubagentCapAndIncrement', () => {
  test('throws subagent-cap error when getTotalAgentSpawns() >= max', () => {
    // Arrange — set a low cap and pre-fill the registry to the limit
    process.env[AGENT_ENV] = '2'
    const reg = new TaskRegistryImpl()
    reg.incrementTotalAgentSpawns()
    reg.incrementTotalAgentSpawns()
    const context = { taskRegistry: reg }

    // Act + Assert
    expect(() => assertSubagentCapAndIncrement(context)).toThrow(
      /Subagent spawn limit reached \(2 of 2 agents spawned\)/,
    )
  })

  test('throws when count already exceeds the max', () => {
    // Arrange
    process.env[AGENT_ENV] = '3'
    const reg = new TaskRegistryImpl()
    // Pre-fill above the limit
    reg.incrementTotalAgentSpawns()
    reg.incrementTotalAgentSpawns()
    reg.incrementTotalAgentSpawns()
    reg.incrementTotalAgentSpawns()

    // Act + Assert
    expect(() =>
      assertSubagentCapAndIncrement({ taskRegistry: reg }),
    ).toThrow(/Subagent spawn limit reached/)
  })

  test('increments only on the proceeding path (under the cap)', () => {
    // Arrange
    process.env[AGENT_ENV] = '5'
    const reg = new TaskRegistryImpl()
    expect(reg.getTotalAgentSpawns()).toBe(0)

    // Act — under the cap, proceeds and increments
    assertSubagentCapAndIncrement({ taskRegistry: reg })

    // Assert
    expect(reg.getTotalAgentSpawns()).toBe(1)
  })

  test('increment happens after the cap passes, before returning', () => {
    // Arrange — set max=2, fill to 1 (one slot left)
    process.env[AGENT_ENV] = '2'
    const reg = new TaskRegistryImpl()
    reg.incrementTotalAgentSpawns()

    // Act — still under the cap, proceeds
    assertSubagentCapAndIncrement({ taskRegistry: reg })

    // Assert — incremented to the limit
    expect(reg.getTotalAgentSpawns()).toBe(2)

    // Next call must throw (now AT the limit) — does not increment further
    expect(() => assertSubagentCapAndIncrement({ taskRegistry: reg })).toThrow()
    expect(reg.getTotalAgentSpawns()).toBe(2)
  })

  test('the thrown error message mentions CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION', () => {
    // Arrange
    process.env[AGENT_ENV] = '1'
    const reg = new TaskRegistryImpl()
    reg.incrementTotalAgentSpawns()

    // Act
    let caught: Error | null = null
    try {
      assertSubagentCapAndIncrement({ taskRegistry: reg })
    } catch (e) {
      caught = e as Error
    }

    // Assert
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain(
      'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION',
    )
  })

  test('treats an undefined taskRegistry as a zero-count no-op (headless path)', () => {
    // Arrange — no registry, default cap of 200
    // Act + Assert — must not throw, must not crash
    expect(() =>
      assertSubagentCapAndIncrement({ taskRegistry: undefined }),
    ).not.toThrow()
  })

  test('the no-op stub registry never throws and never counts up', () => {
    // Arrange — the headless no-op stub; getters always return 0
    const reg = getNoopTaskRegistry()

    // Act — under the cap (0 < 200), should "proceed" and call increment (no-op)
    assertSubagentCapAndIncrement({ taskRegistry: reg })

    // Assert — still 0
    expect(reg.getTotalAgentSpawns()).toBe(0)
  })
})
