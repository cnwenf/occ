import { describe, expect, test } from 'bun:test'
import { resolveAgentTools } from '../agentToolUtils.js'
import type { Tool, Tools } from '../../../Tool.js'

// 2.1.208 #22: Fix Agent tool launching with no tools when a subagent's
// `tools` list resolves to nothing. Previously a bogus `tools:` list silently
// launched a toolless worker. Now the AgentTool checks resolveAgentTools and
// throws a clear error naming the unrecognized entries. Mirrors the binary's
// `subagent zero-tool spawn refused` throw.

// Minimal mock tool for testing
function makeTool(name: string): Tool {
  return {
    name,
    description: async () => name,
    inputSchema: {} as never,
    call: async () => ({ data: {} }),
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    isReadOnly: () => true,
    maxResultSizeChars: 1000,
  } as unknown as Tool
}

describe('2.1.208 #22 resolveAgentTools zero-tools detection', () => {
  const availableTools: Tools = [
    makeTool('Read'),
    makeTool('Grep'),
    makeTool('Glob'),
    makeTool('Edit'),
  ]

  test('bogus tools list resolves to zero tools + invalidTools populated', () => {
    const agent = {
      tools: ['NonexistentTool', 'AlsoBogus'],
      source: 'project' as const,
    }
    const result = resolveAgentTools(agent, availableTools)
    expect(result.hasWildcard).toBe(false)
    expect(result.resolvedTools).toEqual([])
    expect(result.invalidTools).toEqual(['NonexistentTool', 'AlsoBogus'])
    expect(result.validTools).toEqual([])
  })

  test('valid tools list resolves correctly', () => {
    const agent = {
      tools: ['Read', 'Grep'],
      source: 'project' as const,
    }
    const result = resolveAgentTools(agent, availableTools)
    expect(result.resolvedTools.length).toBe(2)
    expect(result.invalidTools).toEqual([])
    expect(result.validTools).toEqual(['Read', 'Grep'])
  })

  test('wildcard returns all available tools', () => {
    const agent = {
      tools: ['*'],
      source: 'project' as const,
    }
    const result = resolveAgentTools(agent, availableTools)
    expect(result.hasWildcard).toBe(true)
    expect(result.resolvedTools.length).toBe(4)
    expect(result.invalidTools).toEqual([])
  })

  test('undefined tools returns wildcard (all tools)', () => {
    const agent = {
      tools: undefined,
      source: 'project' as const,
    }
    const result = resolveAgentTools(agent, availableTools)
    expect(result.hasWildcard).toBe(true)
  })

  test('mix of valid and invalid tools', () => {
    const agent = {
      tools: ['Read', 'BogusTool', 'Grep'],
      source: 'project' as const,
    }
    const result = resolveAgentTools(agent, availableTools)
    expect(result.resolvedTools.length).toBe(2)
    expect(result.invalidTools).toEqual(['BogusTool'])
    expect(result.validTools).toEqual(['Read', 'Grep'])
  })

  test('empty tools list resolves to zero tools, no wildcard', () => {
    const agent = {
      tools: [],
      source: 'project' as const,
    }
    const result = resolveAgentTools(agent, availableTools)
    expect(result.hasWildcard).toBe(false)
    expect(result.resolvedTools).toEqual([])
    // Empty list doesn't produce invalidTools entries
    expect(result.invalidTools).toEqual([])
  })

  test('AgentTool.tsx check: zero resolvedTools + no wildcard would throw', () => {
    // This test verifies the condition checked in AgentTool.tsx:
    //   if (resolved.resolvedTools.length === 0 && !resolved.hasWildcard)
    //     throw new Error(`...unrecognized [${resolved.invalidTools.join(', ')}]...`)
    const agent = {
      tools: ['TypoTool', 'WrongName'],
      source: 'project' as const,
    }
    const result = resolveAgentTools(agent, availableTools)
    const wouldThrow = result.resolvedTools.length === 0 && !result.hasWildcard
    expect(wouldThrow).toBe(true)

    // The error message would name the unrecognized entries
    const reason = result.invalidTools.length > 0
      ? `unrecognized [${result.invalidTools.join(', ')}]`
      : 'no recognized tools matched in this session'
    expect(reason).toBe('unrecognized [TypoTool, WrongName]')

    const errorMsg =
      `Agent 'test' would be spawned with zero tools \u2014 refusing. `
      + `Its tools list resolved to nothing: ${reason}. `
      + `Fix the agent's tools frontmatter or pass a different subagent_type.`
    expect(errorMsg).toContain('TypoTool')
    expect(errorMsg).toContain('WrongName')
    expect(errorMsg).toContain('refusing')
  })

  test('valid tools do NOT trigger the zero-tools throw condition', () => {
    const agent = {
      tools: ['Read'],
      source: 'project' as const,
    }
    const result = resolveAgentTools(agent, availableTools)
    const wouldThrow = result.resolvedTools.length === 0 && !result.hasWildcard
    expect(wouldThrow).toBe(false)
  })

  test('wildcard does NOT trigger the zero-tools throw condition', () => {
    const agent = {
      tools: ['*'],
      source: 'project' as const,
    }
    const result = resolveAgentTools(agent, availableTools)
    const wouldThrow = result.resolvedTools.length === 0 && !result.hasWildcard
    expect(wouldThrow).toBe(false)
  })
})
