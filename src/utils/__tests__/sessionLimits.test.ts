import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  assertSubagentCapAndIncrement,
  getMaxConcurrentSubagents,
  getMaxSubagentsPerSession,
  getMaxSubagentSpawnDepth,
  getMaxWebSearchesPerSession,
} from '../sessionLimits.js'
import { TaskRegistryImpl, getNoopTaskRegistry } from '../taskRegistry.js'

/**
 * CC 2.1.212: per-session cap primitives.
 *   CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION (default 200)
 *   CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION   (default 200)
 * Bad env values fall back to 200 (match the upstream `??` semantics).
 *
 * CC 2.1.217 (Stage 1, schema/env only):
 *   CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS (default 20, concurrent-running cap)
 *   CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (default 1, nested-spawn depth)
 */

const WEB_ENV = 'CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION'
const AGENT_ENV = 'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION'
const CONCURRENT_ENV = 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'
const DEPTH_ENV = 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH'

const originalWeb = process.env[WEB_ENV]
const originalAgent = process.env[AGENT_ENV]
const originalConcurrent = process.env[CONCURRENT_ENV]
const originalDepth = process.env[DEPTH_ENV]

beforeEach(() => {
  delete process.env[WEB_ENV]
  delete process.env[AGENT_ENV]
  delete process.env[CONCURRENT_ENV]
  delete process.env[DEPTH_ENV]
})

afterEach(() => {
  if (originalWeb === undefined) delete process.env[WEB_ENV]
  else process.env[WEB_ENV] = originalWeb
  if (originalAgent === undefined) delete process.env[AGENT_ENV]
  else process.env[AGENT_ENV] = originalAgent
  if (originalConcurrent === undefined) delete process.env[CONCURRENT_ENV]
  else process.env[CONCURRENT_ENV] = originalConcurrent
  if (originalDepth === undefined) delete process.env[DEPTH_ENV]
  else process.env[DEPTH_ENV] = originalDepth
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

describe('getMaxConcurrentSubagents (CC 2.1.217, Stage 1)', () => {
  test('defaults to 20 when the env var is unset', () => {
    // Arrange — env unset by beforeEach
    // Act
    const max = getMaxConcurrentSubagents()

    // Assert — official default TUg = 20
    expect(max).toBe(20)
  })

  test('env override changes the limit', () => {
    // Arrange
    process.env[CONCURRENT_ENV] = '8'

    // Act
    const max = getMaxConcurrentSubagents()

    // Assert
    expect(max).toBe(8)
  })

  test('bad env value (non-numeric) falls back to 20', () => {
    process.env[CONCURRENT_ENV] = 'nope'
    expect(getMaxConcurrentSubagents()).toBe(20)
  })

  test('zero falls back to 20 (not a valid positive limit)', () => {
    process.env[CONCURRENT_ENV] = '0'
    expect(getMaxConcurrentSubagents()).toBe(20)
  })

  test('negative value falls back to 20', () => {
    process.env[CONCURRENT_ENV] = '-3'
    expect(getMaxConcurrentSubagents()).toBe(20)
  })

  test('is distinct from the per-session total-spawn cap (200), not the same knob', () => {
    // Arrange — set both to prove they read independent env vars
    process.env[CONCURRENT_ENV] = '7'
    process.env[AGENT_ENV] = '99'

    // Assert — two independent knobs, two independent defaults
    expect(getMaxConcurrentSubagents()).toBe(7)
    expect(getMaxSubagentsPerSession()).toBe(99)
  })
})

describe('getMaxSubagentSpawnDepth (CC 2.1.217, Stage 1)', () => {
  test('defaults to 1 (no nested subagents) when the env var is unset', () => {
    // Arrange — env unset by beforeEach
    // Act
    const depth = getMaxSubagentSpawnDepth()

    // Assert — official default Avu = 1 (no nesting by default)
    expect(depth).toBe(1)
  })

  test('env override raises the allowed nesting depth', () => {
    process.env[DEPTH_ENV] = '3'
    expect(getMaxSubagentSpawnDepth()).toBe(3)
  })

  test('explicit depth of 1 is accepted (equals the default, still no nesting)', () => {
    process.env[DEPTH_ENV] = '1'
    expect(getMaxSubagentSpawnDepth()).toBe(1)
  })

  test('bad env value (non-numeric) falls back to 1', () => {
    process.env[DEPTH_ENV] = 'garbage'
    expect(getMaxSubagentSpawnDepth()).toBe(1)
  })

  test('zero falls back to 1 (official guard: depth must be an integer ≥ 1)', () => {
    process.env[DEPTH_ENV] = '0'
    expect(getMaxSubagentSpawnDepth()).toBe(1)
  })

  test('negative value falls back to 1', () => {
    process.env[DEPTH_ENV] = '-2'
    expect(getMaxSubagentSpawnDepth()).toBe(1)
  })

  test('fractional value falls back to 1 (must be a positive integer)', () => {
    process.env[DEPTH_ENV] = '2.5'
    expect(getMaxSubagentSpawnDepth()).toBe(1)
  })
})
