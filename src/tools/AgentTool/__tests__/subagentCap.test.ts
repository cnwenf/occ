import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resetStateForTests } from '../../../bootstrap/state.js'
import { markInProcessFallback } from '../../../utils/swarm/backends/registry.js'
import { TaskRegistryImpl } from '../../../utils/taskRegistry.js'
import { runAgent } from '../runAgent.js'
import { spawnTeammate } from '../../shared/spawnMultiAgent.js'

/**
 * CC 2.1.224: the 2.1.212 per-session total-spawn cap was REMOVED upstream.
 *
 * These tests pin the removal behaviorally: the two spawn entry points
 * (runAgent + spawnTeammate) must no longer throw "Subagent spawn limit
 * reached", and CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION must be a no-op —
 * even when set to 1 with a registry that used to count as "at the cap".
 * Spawns now proceed past where the cap check sat and fail (in this stub
 * harness) only on downstream missing wiring, never on a cap error.
 *
 * Binary proof (2.1.224 linux-x64 ELF): zero hits for "agents spawned"
 * (2 in 2.1.223) and no "Subagent spawn limit reached" string; only the
 * concurrency cap (20) and spawn-depth cap (3) remain.
 */

const AGENT_ENV = 'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION'
const originalAgent = process.env[AGENT_ENV]

beforeEach(() => {
  // The removed env var is set to its most restrictive value on every test:
  // under 2.1.212–2.1.223 semantics this would refuse the very first spawn.
  process.env[AGENT_ENV] = '1'
  if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test'
  // Keep spawnTeammate on the in-process path so the stub-context harness
  // fails on missing wiring instead of touching a live pane backend.
  markInProcessFallback()
  resetStateForTests()
})

afterEach(() => {
  if (originalAgent === undefined) delete process.env[AGENT_ENV]
  else process.env[AGENT_ENV] = originalAgent
  resetStateForTests()
})

/**
 * Minimal fake ToolUseContext carrying only the taskRegistry. Under the old
 * cap, the entry points read the registry first and threw before any other
 * field was touched. With the cap gone, the same stub proceeds until it hits
 * missing downstream wiring (getAppState etc.) — which is exactly the
 * observable difference these tests assert.
 */
function makeFakeContext(reg: TaskRegistryImpl) {
  return { taskRegistry: reg } as unknown as Parameters<
    typeof runAgent
  >[0]['toolUseContext']
}

describe('runAgent — total-spawn cap removed (CC 2.1.224)', () => {
  test('does not throw the spawn-cap error even at the old cap', async () => {
    // Arrange — env=1 (would have capped at 1 spawn under 2.1.223)
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

    // Act — runAgent is an async generator; the old cap threw on first next()
    const gen = runAgent(params)
    let caught: unknown = null
    try {
      await gen.next()
    } catch (e) {
      caught = e
    }

    // Assert — whatever fails now is downstream stub wiring, NEVER the cap
    if (caught !== null) {
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).not.toContain(
        'Subagent spawn limit reached',
      )
      expect((caught as Error).message).not.toContain(
        'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION',
      )
    }
  })

  test('a second spawn in the same session is also not cap-refused', async () => {
    // Arrange — under 2.1.223 the second spawn with env=1 was the guaranteed
    // refusal case. Drive two sequential spawns through the entry point.
    const reg = new TaskRegistryImpl()
    const makeParams = () =>
      ({
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
      }) as unknown as Parameters<typeof runAgent>[0]

    // Act + Assert — neither spawn produces the cap error
    for (let spawn = 0; spawn < 2; spawn++) {
      const gen = runAgent(makeParams())
      try {
        await gen.next()
      } catch (e) {
        expect((e as Error).message).not.toContain(
          'Subagent spawn limit reached',
        )
      }
    }
  })
})

describe('spawnTeammate — total-spawn cap removed (CC 2.1.224)', () => {
  test('does not throw the spawn-cap error even at the old cap', async () => {
    // Arrange — env=1; under 2.1.223 spawnTeammate's first statement threw
    // before handleSpawn was ever reached.
    const reg = new TaskRegistryImpl()
    const config = {
      agent_type: 'general-purpose',
      name: 'cap-removal-probe',
      team_name: 'cap-removal-team',
      prompt: 'do something',
    } as unknown as Parameters<typeof spawnTeammate>[0]

    // Act + Assert — rejection (if any) is downstream wiring, not the cap
    let caught: unknown = null
    try {
      await spawnTeammate(config, makeFakeContext(reg))
    } catch (e) {
      caught = e
    }
    if (caught !== null) {
      expect((caught as Error).message).not.toContain(
        'Subagent spawn limit reached',
      )
      expect((caught as Error).message).not.toContain(
        'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION',
      )
    }
  })
})
