import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  claimConcurrentSubagentSlot,
  getMaxConcurrentSubagents,
  getMaxSubagentSpawnDepth,
  getMaxWebSearchesPerSession,
} from '../sessionLimits.js'
import { TaskRegistryImpl, getNoopTaskRegistry } from '../taskRegistry.js'

/**
 * CC 2.1.212: per-session cap primitives.
 *   CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION (default 200)
 * Bad env values fall back to 200 (match the upstream `??` semantics).
 *
 * CC 2.1.217 (Stage 1, schema/env only):
 *   CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS (default 20, concurrent-running cap)
 *   CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (default 3 since CC 2.1.219, nested-spawn depth)
 *
 * CC 2.1.224: the CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION total-spawn cap was
 * REMOVED upstream — no getter reads that env var anymore (verified against
 * the 2.1.224 linux-x64 ELF: the getter and the "Subagent spawn limit
 * reached" assert are gone; only the concurrency and depth caps remain).
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

describe('CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION (removed in CC 2.1.224)', () => {
  test('no exported getter reads the removed total-spawn env var', () => {
    // Arrange — the env var is set to a value that used to matter
    process.env[AGENT_ENV] = '1'

    // Act + Assert — the module no longer exports the cap primitives. This
    // is a compile-time fact mirrored at runtime: importing the removed
    // names would fail module resolution. The remaining getters are
    // unaffected by the removed env var.
    expect(getMaxConcurrentSubagents()).toBe(20)
    expect(getMaxSubagentSpawnDepth()).toBe(3)
    expect(getMaxWebSearchesPerSession()).toBe(200)
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
})

describe('getMaxSubagentSpawnDepth (CC 2.1.219: default 3, was 1 in 2.1.217)', () => {
  test('defaults to 3 (nested subagents allowed to depth 3) when the env var is unset', () => {
    // Arrange — env unset by beforeEach
    // Act
    const depth = getMaxSubagentSpawnDepth()

    // Assert — CC 2.1.219 raised the official default Avu 1 → 3
    expect(depth).toBe(3)
  })

  test('env override raises the allowed nesting depth', () => {
    process.env[DEPTH_ENV] = '5'
    expect(getMaxSubagentSpawnDepth()).toBe(5)
  })

  test('explicit depth of 1 disables nesting (CC 2.1.219 opt-out)', () => {
    process.env[DEPTH_ENV] = '1'
    expect(getMaxSubagentSpawnDepth()).toBe(1)
  })

  test('bad env value (non-numeric) falls back to the default 3', () => {
    process.env[DEPTH_ENV] = 'garbage'
    expect(getMaxSubagentSpawnDepth()).toBe(3)
  })

  test('zero falls back to 3 (official guard: depth must be an integer ≥ 1)', () => {
    process.env[DEPTH_ENV] = '0'
    expect(getMaxSubagentSpawnDepth()).toBe(3)
  })

  test('negative value falls back to 3', () => {
    process.env[DEPTH_ENV] = '-2'
    expect(getMaxSubagentSpawnDepth()).toBe(3)
  })

  test('fractional value falls back to 3 (must be a positive integer)', () => {
    process.env[DEPTH_ENV] = '2.5'
    expect(getMaxSubagentSpawnDepth()).toBe(3)
  })
})

describe('claimConcurrentSubagentSlot (CC 2.1.217, Stage 2)', () => {
  test('under the cap: returns a release fn and increments running count', () => {
    // Arrange — default cap 20, empty registry (0 running)
    const reg = new TaskRegistryImpl()
    const context = { taskRegistry: reg }

    // Act
    const release = claimConcurrentSubagentSlot(context)

    // Assert — slot taken
    expect(typeof release).toBe('function')
    expect(reg.getConcurrentSubagents()).toBe(1)

    // release decrements back
    release()
    expect(reg.getConcurrentSubagents()).toBe(0)
  })

  test('at the cap: throws the official subagent_concurrency_cap message', () => {
    // Arrange — default cap 20; pre-fill to the cap
    const reg = new TaskRegistryImpl()
    for (let i = 0; i < 20; i++) reg.takeConcurrencySlot()
    const context = { taskRegistry: reg }

    // Act + Assert
    expect(() => claimConcurrentSubagentSlot(context)).toThrow(
      /Concurrent subagent limit reached\. You can run 20 subagents at once\. Do not retry\. If the user wants more concurrent subagents, ask them to increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS\./,
    )
    // No slot taken on a denied claim
    expect(reg.getConcurrentSubagents()).toBe(20)
  })

  test('above the cap: also throws (>= semantics)', () => {
    const reg = new TaskRegistryImpl()
    for (let i = 0; i < 25; i++) reg.takeConcurrencySlot()
    expect(() =>
      claimConcurrentSubagentSlot({ taskRegistry: reg }),
    ).toThrow(/Concurrent subagent limit reached/)
  })

  test('env override raises the cap (default 20 → 3)', () => {
    process.env[CONCURRENT_ENV] = '3'
    const reg = new TaskRegistryImpl()
    reg.takeConcurrencySlot()
    reg.takeConcurrencySlot()
    // 2 < 3 → allowed
    const release = claimConcurrentSubagentSlot({ taskRegistry: reg })
    expect(reg.getConcurrentSubagents()).toBe(3)
    release()
    // Now at cap (3) → next claim throws
    reg.takeConcurrencySlot()
    expect(() =>
      claimConcurrentSubagentSlot({ taskRegistry: reg }),
    ).toThrow(/You can run 3 subagents at once/)
  })

  test('the thrown error names CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', () => {
    const reg = new TaskRegistryImpl()
    for (let i = 0; i < 20; i++) reg.takeConcurrencySlot()
    let caught: Error | null = null
    try {
      claimConcurrentSubagentSlot({ taskRegistry: reg })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS')
  })

  test('headless/noop registry never blocks (getConcurrentSubagents=0)', () => {
    // Arrange — noop registry returns 0 running → always under cap
    const context = { taskRegistry: getNoopTaskRegistry() }

    // Act + Assert — claim succeeds, release is a no-op
    const release = claimConcurrentSubagentSlot(context)
    expect(() => release()).not.toThrow()
    expect(context.taskRegistry.getConcurrentSubagents()).toBe(0)
  })

  test('undefined taskRegistry is treated as 0 running (does not block)', () => {
    // Arrange — no registry (defensive)
    const context = { taskRegistry: undefined }

    // Act — claim does not throw; release is a no-op
    const release = claimConcurrentSubagentSlot(context)
    expect(() => release()).not.toThrow()
  })
})
