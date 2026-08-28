import { describe, expect, test } from 'bun:test'
import { GENERAL_PURPOSE_AGENT } from '../built-in/generalPurposeAgent.js'
import type { AgentDefinition } from '../loadAgentsDir.js'
import { getPrompt } from '../prompt.js'

// Hermetic for credential-less environments (CI runners): under CI=true /
// NODE_ENV=test the auth guard (src/utils/auth.ts) demands ANTHROPIC_API_KEY
// or CLAUDE_CODE_OAUTH_TOKEN before credential resolution. This suite is
// offline prompt-builder logic; seed a dummy key when none is present.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

// 2.1.235 item 6: the Agent tool must not advertise a general-purpose
// default in sessions where that agent is unavailable. Official fix
// (byte-verified): the prompt builder `fhf` takes `generalPurposeAvailable`
// (computed by `_bf` over the agent list + allowedAgentTypes) and swaps the
// "If omitted, the general-purpose agent is used." sentence for
// "subagent_type is required: the general-purpose agent is not available in
// this session, so choose one of the listed agent types." (T9o constant,
// fork-offering variant — impossible in OCC, FORK_SUBAGENT flag is off).

function makeAgent(agentType: string): AgentDefinition {
  return {
    agentType,
    whenToUse: `Test agent ${agentType}`,
    tools: ['*'],
    source: 'built-in',
    getSystemPrompt: () => '',
  } as unknown as AgentDefinition
}

const REVIEWER = makeAgent('code-reviewer')

describe('2.1.235 item 6 Agent prompt general-purpose availability', () => {
  test('advertises the general-purpose default when it is available', async () => {
    const prompt = await getPrompt([GENERAL_PURPOSE_AGENT, REVIEWER])
    expect(prompt).toContain(
      'specify a subagent_type parameter to select which agent type to use.',
    )
    expect(prompt).toContain('If omitted, the general-purpose agent is used.')
    expect(prompt).not.toContain('subagent_type is required')
  })

  test('warns instead when allowedAgentTypes excludes general-purpose', async () => {
    const prompt = await getPrompt([GENERAL_PURPOSE_AGENT, REVIEWER], false, [
      'code-reviewer',
    ])
    expect(prompt).toContain(
      'subagent_type is required: the general-purpose agent is not available in this session, so choose one of the listed agent types.',
    )
    expect(prompt).not.toContain('If omitted, the general-purpose agent is used.')
  })

  test('a single normalized alias counts as available (official _bf alias branch)', async () => {
    const alias = makeAgent('General Purpose')
    const prompt = await getPrompt([alias, REVIEWER])
    expect(prompt).toContain('If omitted, the general-purpose agent is used.')
    expect(prompt).not.toContain('subagent_type is required')
  })

  test('an alias excluded by allowedAgentTypes is unavailable', async () => {
    const alias = makeAgent('General Purpose')
    const prompt = await getPrompt([alias, REVIEWER], false, ['code-reviewer'])
    expect(prompt).toContain('subagent_type is required')
    expect(prompt).not.toContain('If omitted, the general-purpose agent is used.')
  })

  test('multiple normalized aliases without an exact match are unavailable (official _bf)', async () => {
    // _bf: exact match wins; otherwise ONLY a single alias counts.
    const aliasA = makeAgent('General Purpose')
    const aliasB = makeAgent('general_purpose')
    const prompt = await getPrompt([aliasA, aliasB, REVIEWER])
    expect(prompt).toContain('subagent_type is required')
  })
})
