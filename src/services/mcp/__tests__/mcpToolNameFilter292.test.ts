import { beforeEach, describe, expect, test } from 'bun:test'
import type { Tool } from '../../../Tool.js'
import {
  filterMcpToolsForApi,
  MCP_TOOL_NAME_MAX_LENGTH,
  resetMcpToolNameWarningCache,
} from '../mcpToolNameFilter.js'

// CC 2.1.292 (occ149 P1): official `o9e` (@219151099) — MCP tools whose
// full name exceeds B6r=128 characters are dropped from the API request
// (warn-once per name via a Set capped at C=256), non-MCP tools always pass,
// and one `tengu_mcp_degraded` event fires per affected server with the
// per-server skip count and a hashed server key.

function fakeTool(
  name: string,
  mcpInfo?: { serverName: string; toolName: string },
): Tool {
  return { name, mcpInfo } as never
}

function mcpTool(server: string, toolName: string): Tool {
  // Realistic full name: mcp__<server>__<tool>
  return fakeTool(`mcp__${server}__${toolName}`, {
    serverName: server,
    toolName,
  })
}

function longName(totalLength: number, prefix = 'mcp__s__'): string {
  return prefix + 'x'.repeat(Math.max(0, totalLength - prefix.length))
}

beforeEach(() => {
  resetMcpToolNameWarningCache()
})

describe('filterMcpToolsForApi (CC 2.1.292 o9e port)', () => {
  test('non-MCP tools always pass regardless of name length', () => {
    const tools = [fakeTool(longName(300)), fakeTool('Read')]
    const kept = filterMcpToolsForApi(tools)
    expect(kept).toHaveLength(2)
  })

  test('MCP tool with name length exactly 128 passes', () => {
    const tool = mcpTool('s', 'x'.repeat(128 - 'mcp__s__'.length))
    expect(tool.name).toHaveLength(MCP_TOOL_NAME_MAX_LENGTH)
    expect(filterMcpToolsForApi([tool])).toHaveLength(1)
  })

  test('MCP tool with name length 129 is dropped', () => {
    const tool = mcpTool('s', 'x'.repeat(129 - 'mcp__s__'.length))
    expect(tool.name).toHaveLength(MCP_TOOL_NAME_MAX_LENGTH + 1)
    expect(filterMcpToolsForApi([tool])).toHaveLength(0)
  })

  test('mixed list keeps valid tools in order, drops oversized ones', () => {
    const ok1 = mcpTool('srv', 'alpha')
    const bad = mcpTool('srv', 'y'.repeat(200))
    const ok2 = fakeTool('Bash')
    const kept = filterMcpToolsForApi([ok1, bad, ok2])
    expect(kept).toEqual([ok1, ok2])
  })

  test('does not mutate the input array', () => {
    const bad = mcpTool('srv', 'y'.repeat(200))
    const tools = [bad]
    const kept = filterMcpToolsForApi(tools)
    expect(tools).toHaveLength(1)
    expect(kept).not.toBe(tools)
  })

  test('hiddenFromModel === true is dropped even with a short name', () => {
    const tool = {
      name: 'mcp__srv__short',
      mcpInfo: {
        serverName: 'srv',
        toolName: 'short',
        hiddenFromModel: true,
      },
    } as never
    expect(filterMcpToolsForApi([tool])).toHaveLength(0)
  })

  test('hiddenFromModel false/undefined does not drop', () => {
    const tool = {
      name: 'mcp__srv__short',
      mcpInfo: {
        serverName: 'srv',
        toolName: 'short',
        hiddenFromModel: false,
      },
    } as never
    expect(filterMcpToolsForApi([tool])).toHaveLength(1)
  })

  test('same oversized name in a later call is still dropped (filter is not warn-gated)', () => {
    const bad = mcpTool('srv', 'y'.repeat(200))
    expect(filterMcpToolsForApi([bad])).toHaveLength(0)
    // Second call: the warn-once Set already has the name, but the tool is
    // still filtered out (only the WARNING is deduped, not the drop).
    expect(filterMcpToolsForApi([bad])).toHaveLength(0)
  })

  test('warn-dedupe cap: the 257th distinct oversized name is still dropped', () => {
    const tools: Tool[] = []
    for (let i = 0; i < 257; i++) {
      tools.push(mcpTool('srv', `tool${i}_${'y'.repeat(200)}`))
    }
    // All 257 are oversized → all dropped, even past the C=256 warn cap.
    expect(filterMcpToolsForApi(tools)).toHaveLength(0)
  })
})
