import { describe, expect, test } from 'bun:test'

/**
 * CC 2.1.281 #147 — fetchResourcesForClient drops MCP Apps UI resources.
 *
 * v281 binary: list surfaces filter with `XXe` (@207138863 detector,
 * @207460730 tool filter+log, @220778776 suggestions). OCC applies the
 * shared `filterMcpAppUiResources` helper inside fetchResourcesForClient so
 * every downstream consumer (tool, @-mention store via
 * useManageMCPConnections) sees the filtered list. Read-by-URI
 * (ReadMcpResourceTool → resources/read) never goes through this function,
 * so ui:// reads keep working.
 */

import type { MCPServerConnection } from '../types.js'
import { fetchResourcesForClient } from '../client.js'

function fakeConnectedClient(
  name: string,
  resources: Array<{ uri: string; name: string; mimeType?: string }>,
): MCPServerConnection {
  return {
    type: 'connected',
    name,
    capabilities: { resources: {} },
    client: {
      request: async () => ({ resources }),
    },
  } as unknown as MCPServerConnection
}

describe('2.1.281 #147 — fetchResourcesForClient UI-resource filter', () => {
  test('drops ui:// and text/html;profile=mcp-app resources, keeps others', async () => {
    // memoizeWithLRU is keyed by server name — unique per test
    const client = fakeConnectedClient('ui-filter-srv-281-a', [
      { uri: 'ui://dashboard', name: 'Dashboard' },
      { uri: 'res://app', name: 'App', mimeType: 'text/html;profile=mcp-app' },
      { uri: 'res://data', name: 'Data', mimeType: 'application/json' },
      { uri: 'res://page', name: 'Page', mimeType: 'text/html' },
    ])

    const result = await fetchResourcesForClient(client)

    expect(result.map(r => r.uri)).toEqual(['res://data', 'res://page'])
    expect(result.every(r => r.server === 'ui-filter-srv-281-a')).toBe(true)
  })

  test('returns empty array when every resource is a UI resource', async () => {
    const client = fakeConnectedClient('ui-filter-srv-281-b', [
      { uri: 'UI://main', name: 'Main' },
      { uri: 'res://widget', name: 'W', mimeType: 'text/html; profile=mcp-app' },
    ])

    const result = await fetchResourcesForClient(client)

    expect(result).toEqual([])
  })

  test('passes through a list with no UI resources unchanged', async () => {
    const client = fakeConnectedClient('ui-filter-srv-281-c', [
      { uri: 'res://a', name: 'A' },
      { uri: 'res://b', name: 'B', mimeType: 'text/plain' },
    ])

    const result = await fetchResourcesForClient(client)

    expect(result.map(r => r.uri)).toEqual(['res://a', 'res://b'])
  })
})
