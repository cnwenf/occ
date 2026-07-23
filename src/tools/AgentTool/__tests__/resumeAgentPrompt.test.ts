import { test, expect, describe, mock } from 'bun:test'
import { writeAgentMetadata, readAgentMetadata, type AgentMetadata } from '../../../utils/sessionStorage.js'

/**
 * CC 2.1.216 #7: Resumed background agent sessions reverted to the DEFAULT
 * agent — the agent's prompt and tool restrictions must be restored on resume.
 *
 * The fix persists the agent's systemPrompt and disallowedTools to metadata
 * so a resumed session restores them instead of falling back to the default
 * (general-purpose) agent.
 */
describe('CC 2.1.216 #7: agent resume prompt + tool restrictions', () => {
  test('AgentMetadata type accepts systemPrompt and disallowedTools', () => {
    const meta: AgentMetadata = {
      agentType: 'my-custom-agent',
      systemPrompt: 'You are a custom agent that does X.',
      disallowedTools: ['Bash', 'Write'],
    }
    expect(meta.systemPrompt).toBe('You are a custom agent that does X.')
    expect(meta.disallowedTools).toEqual(['Bash', 'Write'])
  })

  test('writeAgentMetadata persists systemPrompt and disallowedTools', async () => {
    // writeAgentMetadata writes to a sidecar .meta.json file. We verify
    // the round-trip: write → read → fields preserved.
    const agentId = 'test-resume-prompt-' + Date.now() as any
    const meta: AgentMetadata = {
      agentType: 'custom-researcher',
      systemPrompt: 'You are a research agent. Always cite sources.',
      disallowedTools: ['Edit', 'Write'],
      description: 'Research task',
      model: 'sonnet',
    }

    // writeAgentMetadata is async (writes to disk)
    await writeAgentMetadata(agentId, meta)

    const readBack = await readAgentMetadata(agentId)
    expect(readBack).not.toBeNull()
    expect(readBack!.agentType).toBe('custom-researcher')
    expect(readBack!.systemPrompt).toBe('You are a research agent. Always cite sources.')
    expect(readBack!.disallowedTools).toEqual(['Edit', 'Write'])
    expect(readBack!.description).toBe('Research task')
    expect(readBack!.model).toBe('sonnet')
  })

  test('metadata without systemPrompt/disallowedTools is backward-compatible', async () => {
    // Older metadata files don't have these fields — readAgentMetadata
    // must not break.
    const agentId = 'test-resume-old-' + Date.now() as any
    const meta: AgentMetadata = {
      agentType: 'general-purpose',
    }

    await writeAgentMetadata(agentId, meta)
    const readBack = await readAgentMetadata(agentId)
    expect(readBack!.systemPrompt).toBeUndefined()
    expect(readBack!.disallowedTools).toBeUndefined()
  })
})
