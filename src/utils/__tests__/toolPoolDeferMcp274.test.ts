/**
 * CC 2.1.274 Gap-128b — after a successful MCP OAuth completion the next
 * turn's tool list must contain ONLY the server's real tools (the official
 * REPL removes both auth stubs; verified behaviorally against the official
 * 2.1.274 binary — forensics in docs/upstream-version-gap-occ128.md).
 *
 * Root cause this locks in: main.tsx freezes the startup MCP tools
 * (including `mcp__<server>__authenticate` / `__complete_authentication`
 * stubs) into the REPL's `initialTools` prop, and `mergeAndFilterTools`
 * gives initialTools dedup precedence — so the OAuth continuation's
 * prefix-replacement swap on appState.mcp.tools could never remove the
 * frozen startup stubs. The fix: once the connection manager has seeded a
 * server into the live store (`appState.mcp.clients` contains it — the
 * manager seeds clients and tools atomically), the frozen initial MCP tools
 * for that server defer to live state.
 */
import { describe, expect, test } from 'bun:test'

import type { Tool } from '../../Tool.js'
import { deferInitialMcpToolsToLiveState } from '../toolPool.js'

function fakeTool(name: string, extra: Record<string, unknown> = {}): Tool {
  return { name, ...extra } as unknown as Tool
}

const builtIn = fakeTool('Bash')
const otherServerTool = fakeTool('mcp__other__ping', { isMcp: true })
const stubAuth = fakeTool('mcp__srv__authenticate', { isMcp: true })
const stubComplete = fakeTool('mcp__srv__complete_authentication', {
  isMcp: true,
})
const realTool = fakeTool('mcp__srv__real_tool', { isMcp: true })

describe('2.1.274 deferInitialMcpToolsToLiveState', () => {
  test('no live clients → initial tools pass through untouched', () => {
    const initial = [builtIn, stubAuth, stubComplete]
    expect(deferInitialMcpToolsToLiveState(initial, [])).toEqual(initial)
  })

  test('server present in live clients → its frozen MCP tools are dropped', () => {
    const initial = [builtIn, stubAuth, stubComplete, otherServerTool]
    const result = deferInitialMcpToolsToLiveState(initial, [{ name: 'srv' }])
    expect(result.map(t => t.name)).toEqual([
      'Bash',
      'mcp__other__ping',
    ])
  })

  test('built-ins and other servers are kept when one server goes live', () => {
    const initial = [builtIn, otherServerTool, realTool]
    const result = deferInitialMcpToolsToLiveState(initial, [{ name: 'srv' }])
    expect(result.map(t => t.name)).toEqual(['Bash', 'mcp__other__ping'])
  })

  test('multiple live clients → all their frozen tools defer', () => {
    const initial = [builtIn, stubAuth, otherServerTool]
    const result = deferInitialMcpToolsToLiveState(initial, [
      { name: 'srv' },
      { name: 'other' },
    ])
    expect(result.map(t => t.name)).toEqual(['Bash'])
  })

  test('prefix match is server-scoped, not substring-greedy', () => {
    // A server named "sr" must not swallow tools of server "srv".
    const initial = [stubAuth, fakeTool('mcp__sr__thing', { isMcp: true })]
    const result = deferInitialMcpToolsToLiveState(initial, [{ name: 'sr' }])
    expect(result.map(t => t.name)).toEqual(['mcp__srv__authenticate'])
  })

  test('non-prefixed tool with isMcp flag is untouched (no server match)', () => {
    const odd = fakeTool('weird_name', { isMcp: true })
    expect(deferInitialMcpToolsToLiveState([odd], [{ name: 'srv' }])).toEqual([
      odd,
    ])
  })
})
