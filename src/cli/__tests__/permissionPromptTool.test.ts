import { describe, expect, test } from 'bun:test'
import type { Tool } from '../../Tool.js'
import { waitForPermissionPromptTool } from '../print.js'

const TOOL_NAME = 'mcp__myserver__approve'

function makeTool(name: string = TOOL_NAME): Tool {
  return { name } as unknown as Tool
}

describe('waitForPermissionPromptTool', () => {
  test('returns the tool immediately when present on first lookup', async () => {
    const tool = makeTool()
    const getMcpTools = () => [tool]
    const result = await waitForPermissionPromptTool(
      getMcpTools,
      TOOL_NAME,
      1000,
    )
    expect(result).toBe(tool)
  })

  test('polls and resolves once the tool registers (cold start)', async () => {
    const tool = makeTool()
    let calls = 0
    const getMcpTools = (): Tool[] => {
      calls++
      // Empty for the first 2 lookups, then the tool appears.
      return calls <= 2 ? [] : [tool]
    }
    const result = await waitForPermissionPromptTool(
      getMcpTools,
      TOOL_NAME,
      5000,
    )
    expect(result).toBe(tool)
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test('returns undefined after the bounded wait when never found', async () => {
    const getMcpTools = (): Tool[] => []
    const start = Date.now()
    const result = await waitForPermissionPromptTool(
      getMcpTools,
      TOOL_NAME,
      250,
    )
    expect(result).toBeUndefined()
    // Should have waited roughly the full window (>= 200ms).
    expect(Date.now() - start).toBeGreaterThanOrEqual(200)
  })

  test('respects a short connectWaitMs for fast failure', async () => {
    const getMcpTools = (): Tool[] => []
    const result = await waitForPermissionPromptTool(
      getMcpTools,
      TOOL_NAME,
      100,
    )
    expect(result).toBeUndefined()
  })

  test('matches a tool by alias', async () => {
    const tool = {
      name: 'mcp__myserver__approve_real',
      aliases: [TOOL_NAME],
    } as unknown as Tool
    const result = await waitForPermissionPromptTool(
      () => [tool],
      TOOL_NAME,
      1000,
    )
    expect(result).toBe(tool)
  })

  test('does not match a differently-named tool', async () => {
    const other = makeTool('mcp__other__thing')
    const result = await waitForPermissionPromptTool(
      () => [other],
      TOOL_NAME,
      100,
    )
    expect(result).toBeUndefined()
  })

  test('eventual appearance after several empty polls still resolves', async () => {
    const tool = makeTool()
    let calls = 0
    const getMcpTools = (): Tool[] => {
      calls++
      return calls < 5 ? [] : [tool]
    }
    const result = await waitForPermissionPromptTool(
      getMcpTools,
      TOOL_NAME,
      10000,
    )
    expect(result).toBe(tool)
    expect(calls).toBeGreaterThanOrEqual(5)
  })
})
