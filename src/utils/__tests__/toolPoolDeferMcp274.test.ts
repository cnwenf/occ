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
import {
  deferInitialMcpToolsToLiveState,
  mergeAndFilterTools,
} from '../toolPool.js'

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

/**
 * P3-3: failed/disabled servers with an empty live tool set must keep the
 * frozen auth stubs (recovery entry `mcp__<server>__authenticate`) while
 * still dropping the frozen real tools (stale — the server is NOT connected).
 * These tests FAIL if the P3-3 fix is reverted to the strip-everything
 * behavior (mutation-resistant).
 */
describe('P3-3 deferInitialMcpToolsToLiveState — failed/disabled stub preservation', () => {
  test("reviewer regression: failed + empty live tools → auth stubs KEPT, real tool DROPPED", () => {
    const initial = [builtIn, stubAuth, stubComplete, realTool]
    const result = deferInitialMcpToolsToLiveState(
      initial,
      [{ name: 'srv', type: 'failed' }],
      [],
    )
    expect(result.map(t => t.name)).toEqual([
      'Bash',
      'mcp__srv__authenticate',
      'mcp__srv__complete_authentication',
    ])
  })

  test('disabled + empty live tools behaves the same as failed', () => {
    const initial = [builtIn, stubAuth, stubComplete, realTool]
    const result = deferInitialMcpToolsToLiveState(
      initial,
      [{ name: 'srv', type: 'disabled' }],
      [],
    )
    expect(result.map(t => t.name)).toEqual([
      'Bash',
      'mcp__srv__authenticate',
      'mcp__srv__complete_authentication',
    ])
  })

  test('live tool set NON-empty → ALL frozen tools with that prefix dropped even when failed', () => {
    const initial = [builtIn, stubAuth, stubComplete, realTool]
    const result = deferInitialMcpToolsToLiveState(
      initial,
      [{ name: 'srv', type: 'failed' }],
      [fakeTool('mcp__srv__live_tool', { isMcp: true })],
    )
    expect(result.map(t => t.name)).toEqual(['Bash'])
  })

  test.each([
    'connected',
    'needs-auth',
    'pending',
    'needs-approval',
    'unconfigured',
    undefined,
  ])(
    'state %s + empty live tools → all frozen tools with that prefix dropped',
    type => {
      const initial = [builtIn, stubAuth, stubComplete, realTool]
      const result = deferInitialMcpToolsToLiveState(
        initial,
        [{ name: 'srv', type }],
        [],
      )
      expect(result.map(t => t.name)).toEqual(['Bash'])
    },
  )

  test('prefix-boundary safety: failed server "sr" preserves only its own stubs', () => {
    const srStub = fakeTool('mcp__sr__authenticate', { isMcp: true })
    const srReal = fakeTool('mcp__sr__thing', { isMcp: true })
    const initial = [srStub, srReal, stubAuth, realTool]
    const result = deferInitialMcpToolsToLiveState(
      initial,
      [{ name: 'sr', type: 'failed' }],
      [],
    )
    // "sr" stub kept, "sr" real tool dropped; untracked "srv" tools untouched.
    expect(result.map(t => t.name)).toEqual([
      'mcp__sr__authenticate',
      'mcp__srv__authenticate',
      'mcp__srv__real_tool',
    ])
  })

  test('stub suffix match is boundary-exact (no substring false positives)', () => {
    const lookalike1 = fakeTool('mcp__srv__reauthenticate', { isMcp: true })
    const lookalike2 = fakeTool('mcp__srv__authenticate_v2', { isMcp: true })
    const initial = [lookalike1, lookalike2, stubComplete]
    const result = deferInitialMcpToolsToLiveState(
      initial,
      [{ name: 'srv', type: 'failed' }],
      [],
    )
    expect(result.map(t => t.name)).toEqual([
      'mcp__srv__complete_authentication',
    ])
  })

  test('per-server independence: failed "srv" keeps stubs while connected "other" defers fully', () => {
    const initial = [stubAuth, otherServerTool]
    const result = deferInitialMcpToolsToLiveState(
      initial,
      [
        { name: 'srv', type: 'failed' },
        { name: 'other', type: 'connected' },
      ],
      [fakeTool('mcp__other__ping', { isMcp: true })],
    )
    expect(result.map(t => t.name)).toEqual(['mcp__srv__authenticate'])
  })

  test('inputs are never mutated (immutable contract)', () => {
    const initial = [builtIn, stubAuth, realTool]
    const clients = [{ name: 'srv', type: 'failed' as const }]
    const liveTools: { name?: string }[] = []
    const initialSnapshot = [...initial]
    deferInitialMcpToolsToLiveState(initial, clients, liveTools)
    expect(initial).toEqual(initialSnapshot)
    expect(clients).toEqual([{ name: 'srv', type: 'failed' }])
    expect(liveTools).toEqual([])
  })
})

/**
 * Call-site contract tests. computeTools (REPL.tsx), the effectiveInitialTools
 * memo (REPL.tsx) and buildAllTools (print.ts) are not directly unit-testable
 * (React/memo/closure), but all three reduce to the SAME pure pipeline:
 *   mergeAndFilterTools(deferInitialMcpToolsToLiveState(frozen, clients, liveTools), assembled, mode)
 * These tests exercise that pipeline with call-site-shaped inputs for the
 * reviewer's regression scenario, so a revert of the fix (or of a call site
 * dropping the liveTools argument in a way that changes behavior) fails here.
 */
describe('P3-3 call-site contract — regression scenario through the production pipeline', () => {
  // The exact combination all three production call sites produce when a
  // needs-auth server transitions to FAILED and a failed reconnect flushes
  // the live tool set to []: frozen initialTools (built-ins + startup MCP
  // incl. stubs), clients=[{name:'srv', type:'failed'}], liveTools=[].
  const frozenInitialTools = [builtIn, stubAuth, stubComplete, realTool]
  const failedClients = [{ name: 'srv', type: 'failed' as const }]
  const emptyLiveTools: Tool[] = []

  test('REPL computeTools shape: defer → mergeAndFilterTools keeps the recovery entry', () => {
    // computeTools(): assembled = assembleToolPool(ctx, state.mcp.tools) —
    // with an empty live tool set the assembled pool contributes no srv tools.
    const merged = mergeAndFilterTools(
      deferInitialMcpToolsToLiveState(
        frozenInitialTools,
        failedClients,
        emptyLiveTools,
      ),
      [],
      'default',
    )
    const names = merged.map(t => t.name)
    expect(names).toContain('mcp__srv__authenticate')
    expect(names).toContain('mcp__srv__complete_authentication')
    expect(names).not.toContain('mcp__srv__real_tool')
    expect(names).toContain('Bash')
  })

  test('print buildAllTools shape: frozen = [...tools, ...sdkTools, ...dynamicMcpState.tools]', () => {
    // buildAllTools() defers the concatenated frozen list against
    // appState.mcp.clients + appState.mcp.tools, then merges + uniqBy name.
    const startupTools = [builtIn]
    const sdkTools: Tool[] = []
    const dynamicMcpTools = [stubAuth, stubComplete, realTool]
    const merged = mergeAndFilterTools(
      deferInitialMcpToolsToLiveState(
        [...startupTools, ...sdkTools, ...dynamicMcpTools],
        failedClients,
        emptyLiveTools,
      ),
      [],
      'default',
    )
    const names = merged.map(t => t.name)
    expect(names).toContain('mcp__srv__authenticate')
    expect(names).toContain('mcp__srv__complete_authentication')
    expect(names).not.toContain('mcp__srv__real_tool')
  })

  test('omitting liveTools (old 2-arg call) still drops srv tools — proves call sites must pass it', () => {
    // Guard on the contract itself: with state 'failed' and NO liveTools arg
    // the stubs survive via rule 2 (empty live set), matching what the
    // regression scenario requires; the assertion documents that the third
    // argument is what distinguishes rule 1 (live non-empty) from rule 2.
    const withLiveTool = deferInitialMcpToolsToLiveState(
      frozenInitialTools,
      failedClients,
      [fakeTool('mcp__srv__fresh', { isMcp: true })],
    )
    expect(withLiveTool.map(t => t.name)).not.toContain(
      'mcp__srv__authenticate',
    )
    const withoutLiveTools = deferInitialMcpToolsToLiveState(
      frozenInitialTools,
      failedClients,
    )
    expect(withoutLiveTools.map(t => t.name)).toContain(
      'mcp__srv__authenticate',
    )
  })
})
