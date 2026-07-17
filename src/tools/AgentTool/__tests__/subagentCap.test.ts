import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  resetStateForTests,
} from '../../../bootstrap/state.js'
import { TaskRegistryImpl } from '../../../utils/taskRegistry.js'
import { runAgent } from '../runAgent.js'
import { spawnTeammate } from '../../shared/spawnMultiAgent.js'

/**
 * CC 2.1.212: real behavioral e2e for the per-session subagent-spawn cap.
 *
 * Drives the actual spawn entry points (runAgent + spawnTeammate) with a
 * TaskRegistry pre-filled to the limit and asserts the thrown cap error.
 * The cap check is the very first statement of each spawn entry point, so
 * it throws before any real spawn / network / pane work — no API key or
 * tmux backend required.
 */

const AGENT_ENV = 'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION'
const originalAgent = process.env[AGENT_ENV]

beforeEach(() => {
  delete process.env[AGENT_ENV]
  if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test'
  resetStateForTests()
})

afterEach(() => {
  if (originalAgent === undefined) delete process.env[AGENT_ENV]
  else process.env[AGENT_ENV] = originalAgent
  resetStateForTests()
})

/**
 * Minimal fake ToolUseContext carrying only the taskRegistry. Both
 * assertSubagentCapAndIncrement (runAgent) and spawnTeammate read the
 * registry as their first action and throw before any other field is
 * touched, so a stub context is sufficient.
 */
function makeFakeContext(reg: TaskRegistryImpl) {
  return { taskRegistry: reg } as unknown as Parameters<
    typeof runAgent
  >[0]['toolUseContext']
}

describe('runAgent — per-session subagent cap (CC 2.1.212)', () => {
  test('throws subagent-cap error when getTotalAgentSpawns() >= max', async () => {
    // Arrange — cap=1, pre-fill to 1
    process.env[AGENT_ENV] = '1'
    const reg = new TaskRegistryImpl()
    reg.incrementTotalAgentSpawns()

    const params = {
      agentDefinition: { agentType: 'general-purpose' },
      promptMessages: [],
      toolUseContext: makeFakeContext(reg),
      canUseTool: (async () => ({
        behavior: 'allow',
        updatedInput: {},
      })) as never,
      isAsync: false,
      querySource: 'agent:builtin:general-purpose',
      availableTools: [],
    } as unknown as Parameters<typeof runAgent>[0]

    // Act — runAgent is an async generator; the cap throws on first next()
    const gen = runAgent(params)
    let caught: unknown = null
    try {
      await gen.next()
    } catch (e) {
      caught = e
    }

    // Assert
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain(
      'Subagent spawn limit reached',
    )
    expect((caught as Error).message).toContain('1 of 1')
  })

  test('increments only on the proceeding path (under the cap)', async () => {
    // Arrange — cap=200 (default), count=0. runAgent will proceed past the
    // cap check (increment to 1) then fail downstream on the stub context.
    // We assert the counter advanced exactly once — proving the increment
    // ran before the actual spawn work.
    const reg = new TaskRegistryImpl()
    const params = {
      agentDefinition: { agentType: 'general-purpose' },
      promptMessages: [],
      toolUseContext: makeFakeContext(reg),
      canUseTool: (async () => ({
        behavior: 'allow',
        updatedInput: {},
      })) as never,
      isAsync: false,
      querySource: 'agent:builtin:general-purpose',
      availableTools: [],
    } as unknown as Parameters<typeof runAgent>[0]

    // Act — proceeds past the cap check (increments), then fails downstream
    const gen = runAgent(params)
    try {
      await gen.next()
    } catch {
      // expected — downstream stub context lacks real wiring
    }

    // Assert — increment ran exactly once on the proceeding path
    expect(reg.getTotalAgentSpawns()).toBe(1)
  })

  test('does not increment on the capped (rejected) path', async () => {
    // Arrange — cap=2, pre-fill to 2
    process.env[AGENT_ENV] = '2'
    const reg = new TaskRegistryImpl()
    reg.incrementTotalAgentSpawns()
    reg.incrementTotalAgentSpawns()

    const params = {
      agentDefinition: { agentType: 'general-purpose' },
      promptMessages: [],
      toolUseContext: makeFakeContext(reg),
      canUseTool: (async () => ({
        behavior: 'allow',
        updatedInput: {},
      })) as never,
      isAsync: false,
      querySource: 'agent:builtin:general-purpose',
      availableTools: [],
    } as unknown as Parameters<typeof runAgent>[0]

    // Act
    const gen = runAgent(params)
    try {
      await gen.next()
    } catch {
      // expected cap throw
    }

    // Assert — counter unchanged (still 2)
    expect(reg.getTotalAgentSpawns()).toBe(2)
  })

  test('the cap error mentions CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION', async () => {
    // Arrange
    process.env[AGENT_ENV] = '1'
    const reg = new TaskRegistryImpl()
    reg.incrementTotalAgentSpawns()

    const params = {
      agentDefinition: { agentType: 'general-purpose' },
      promptMessages: [],
      toolUseContext: makeFakeContext(reg),
      canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
      isAsync: false,
      querySource: 'agent:builtin:general-purpose',
      availableTools: [],
    } as unknown as Parameters<typeof runAgent>[0]

    // Act
    const gen = runAgent(params)
    let msg = ''
    try {
      await gen.next()
    } catch (e) {
      msg = (e as Error).message
    }

    // Assert
    expect(msg).toContain('CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION')
  })
})

describe('spawnTeammate — per-session subagent cap (CC 2.1.212)', () => {
  test('throws subagent-cap error when getTotalAgentSpawns() >= max', async () => {
    // Arrange — cap=1, pre-fill to 1. spawnTeammate's first statement is
    // assertSubagentCapAndIncrement(context), which throws before
    // handleSpawn (pane/in-process work) is ever reached.
    process.env[AGENT_ENV] = '1'
    const reg = new TaskRegistryImpl()
    reg.incrementTotalAgentSpawns()

    const config = {
      agent_type: 'general-purpose',
      prompt: 'do something',
    } as unknown as Parameters<typeof spawnTeammate>[0]

    // Act + Assert
    await expect(
      spawnTeammate(config, makeFakeContext(reg)),
    ).rejects.toThrow(/Subagent spawn limit reached/)

    // Counter unchanged on the rejected path
    expect(reg.getTotalAgentSpawns()).toBe(1)
  })

  test('increments on the proceeding path (under the cap)', async () => {
    // Arrange — cap=200 (default), count=0. spawnTeammate will increment
    // (to 1) then proceed into handleSpawn, which will fail on the stub
    // context. We assert the increment ran exactly once.
    const reg = new TaskRegistryImpl()
    const config = {
      agent_type: 'general-purpose',
      prompt: 'do something',
    } as unknown as Parameters<typeof spawnTeammate>[0]

    // Act — increments then fails downstream on the stub context
    try {
      await spawnTeammate(config, makeFakeContext(reg))
    } catch {
      // expected — downstream stub lacks real pane / in-process wiring
    }

    // Assert — increment ran exactly once on the proceeding path
    expect(reg.getTotalAgentSpawns()).toBe(1)
  })
})
