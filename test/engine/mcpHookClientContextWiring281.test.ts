import { afterEach, describe, expect, test } from 'bun:test'
import { QueryEngine, type QueryEngineConfig } from '../../src/QueryEngine.js'
import {
  getMcpHookClientContext,
  getMcpHookClientContextGetter,
  setMcpHookClientContext,
} from '../../src/utils/hooks/execMcpToolHook.js'
import type { MCPServerConnection } from '../../src/services/mcp/types.js'

/**
 * CC 2.1.281 #052 — QueryEngine registers the LIVE MCP-client accessor with
 * the mcp_tool hook layer (binary `bk()` / liveClients registry @96655146)
 * so the connect-wait polls current connection state instead of the
 * construction-time `config.mcpClients` snapshot, and unwinds the
 * registration on close() without clobbering a newer (subagent) engine's
 * registration.
 */

type MutableState = { mcp: { clients: MCPServerConnection[] } }

function makeClient(name: string): MCPServerConnection {
  return { name, status: 'connected' } as unknown as MCPServerConnection
}

function makeEngine(state: MutableState): QueryEngine {
  const config = {
    cwd: '/tmp',
    commands: [],
    tools: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({
      behavior: 'allow' as const,
      updatedInput: undefined,
      state: {},
    }),
    getAppState: () => state,
    setAppState: () => {},
    readFileCache: new Map(),
  } as unknown as QueryEngineConfig
  return new QueryEngine(config)
}

afterEach(() => {
  setMcpHookClientContext(undefined)
})

describe('CC 2.1.281 #052 — QueryEngine live MCP-client accessor wiring', () => {
  test('constructor registers an accessor that re-reads the live store', () => {
    const state: MutableState = { mcp: { clients: [] } }
    const engine = makeEngine(state)
    try {
      expect(getMcpHookClientContextGetter()).toBeTypeOf('function')
      expect(getMcpHookClientContext()).toEqual({ mcpClients: [] })
      // LIVE, not a snapshot: a server connecting after construction must be
      // visible to the next poll (this is the whole point of `Pgo()`/`bk()`).
      state.mcp.clients = [...state.mcp.clients, makeClient('late-server')]
      expect(getMcpHookClientContext()?.mcpClients?.map(c => c.name)).toEqual([
        'late-server',
      ])
    } finally {
      engine.close()
    }
  })

  test('close() clears the registration when no newer engine owns it', () => {
    const engine = makeEngine({ mcp: { clients: [] } })
    engine.close()
    expect(getMcpHookClientContextGetter()).toBeUndefined()
    expect(getMcpHookClientContext()).toBeUndefined()
  })

  test('a subagent engine takes over, and its close restores the parent', () => {
    const parentState: MutableState = { mcp: { clients: [makeClient('parent-srv')] } }
    const parent = makeEngine(parentState)
    const parentGetter = getMcpHookClientContextGetter()
    const child = makeEngine({ mcp: { clients: [makeClient('child-srv')] } })
    try {
      // Child registration wins while it is open.
      expect(getMcpHookClientContextGetter()).not.toBe(parentGetter)
      expect(getMcpHookClientContext()?.mcpClients?.map(c => c.name)).toEqual([
        'child-srv',
      ])
    } finally {
      child.close()
    }
    // Closing the child must restore the parent's accessor, not clear it.
    expect(getMcpHookClientContextGetter()).toBe(parentGetter)
    expect(getMcpHookClientContext()?.mcpClients?.map(c => c.name)).toEqual([
      'parent-srv',
    ])
    parent.close()
    expect(getMcpHookClientContextGetter()).toBeUndefined()
  })

  test('closing a stale parent does not clobber the live child registration', () => {
    const parent = makeEngine({ mcp: { clients: [] } })
    const child = makeEngine({ mcp: { clients: [makeClient('child-srv')] } })
    const childGetter = getMcpHookClientContextGetter()
    parent.close() // parent no longer owns the registration
    expect(getMcpHookClientContextGetter()).toBe(childGetter)
    expect(getMcpHookClientContext()?.mcpClients?.map(c => c.name)).toEqual([
      'child-srv',
    ])
    child.close()
    // Stack restore puts the (already closed) parent getter back, but the
    // closed-guard makes it yield no context — a dead engine never serves
    // live connection state.
    expect(getMcpHookClientContext()).toBeUndefined()
  })

  test('close() is idempotent — double close does not disturb the registry', () => {
    const engine = makeEngine({ mcp: { clients: [] } })
    const successor = makeEngine({ mcp: { clients: [] } })
    engine.close()
    engine.close() // second close is a no-op (isClosed guard)
    // Successor still owns the registration.
    expect(getMcpHookClientContextGetter()).not.toBeUndefined()
    expect(getMcpHookClientContext()?.mcpClients).toEqual([])
    successor.close()
    // Restores the closed engine's getter — dead, so no live context.
    expect(getMcpHookClientContext()).toBeUndefined()
  })
})
