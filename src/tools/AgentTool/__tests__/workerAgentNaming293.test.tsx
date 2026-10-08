import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStringIsolated } from '../../../components/CustomSelect/__tests__/renderIsolated280.js'
import { ThemeProvider } from '../../../ink.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const { userFacingName, resolveAgentDisplayName, isCustomSubagentType, renderGroupedAgentToolUse } =
  await import('../UI.js')

// Official Claude Code 2.1.293 changelog entry #14: a CUSTOM agent named
// `worker` must keep its name (vprev collapsed every `worker` to "Agent").
// Only a built-in (or unregistered) worker collapses.
//
// Binary-verified (vver ELF):
//   constant `eje="worker"` @220326400
//   `function dOr(n,e){if(!n||n===$1.agentType)return;if(n!==eje)return n;
//      let g=e?.find((p)=>p.agentType===eje);return g!==void 0&&g.source!=="built-in"?n:void 0}` @220331500
//   `function G2n(n,{activeAgents:e}={}){if(RV(n?.subagent_type,e))return dOn;
//      return dOr(n?.subagent_type,e)??\"Agent\"}`
// OCC has NO built-in worker, so the vprev collapse is 100% wrong here.
// (OCC has no `RV` fetch-collapse path — kept as-is, ledger-noted.)

type Src = 'built-in' | 'userSettings' | 'projectSettings' | 'plugin'
function agent(agentType: string, source: Src) {
  return { agentType, source, whenToUse: '', tools: ['*'], getSystemPrompt: () => '' } as never
}

const CUSTOM_WORKER = [agent('worker', 'userSettings')]
const BUILTIN_WORKER = [agent('worker', 'built-in')]

describe('#14 resolveAgentDisplayName (≡ official dOr)', () => {
  test('custom worker keeps its name', () => {
    expect(resolveAgentDisplayName('worker', CUSTOM_WORKER)).toBe('worker')
  })
  test('built-in worker collapses to undefined', () => {
    expect(resolveAgentDisplayName('worker', BUILTIN_WORKER)).toBeUndefined()
  })
  test('unregistered worker collapses to undefined', () => {
    expect(resolveAgentDisplayName('worker', [])).toBeUndefined()
    expect(resolveAgentDisplayName('worker', undefined)).toBeUndefined()
  })
  test('non-worker custom type returns itself', () => {
    expect(resolveAgentDisplayName('code-reviewer', [])).toBe('code-reviewer')
  })
  test('general-purpose and empty collapse to undefined', () => {
    expect(resolveAgentDisplayName('general-purpose', CUSTOM_WORKER)).toBeUndefined()
    expect(resolveAgentDisplayName(undefined, CUSTOM_WORKER)).toBeUndefined()
    expect(resolveAgentDisplayName('', CUSTOM_WORKER)).toBeUndefined()
  })
})

describe('#14 userFacingName (≡ official G2n)', () => {
  test('worker + user-source → "worker"', () => {
    expect(userFacingName({ subagent_type: 'worker' }, { activeAgents: CUSTOM_WORKER })).toBe('worker')
  })
  test('worker + built-in → "Agent"', () => {
    expect(userFacingName({ subagent_type: 'worker' }, { activeAgents: BUILTIN_WORKER })).toBe('Agent')
  })
  test('worker unregistered → "Agent"', () => {
    expect(userFacingName({ subagent_type: 'worker' })).toBe('Agent')
  })
  test('code-reviewer → itself', () => {
    expect(userFacingName({ subagent_type: 'code-reviewer' })).toBe('code-reviewer')
  })
  test('general-purpose / undefined → "Agent"', () => {
    expect(userFacingName({ subagent_type: 'general-purpose' })).toBe('Agent')
    expect(userFacingName(undefined)).toBe('Agent')
    expect(userFacingName({})).toBe('Agent')
  })
})

describe('#14 isCustomSubagentType (teammate branch, ≡ dOr !== undefined)', () => {
  test('custom worker is a custom subagent type', () => {
    expect(isCustomSubagentType('worker', CUSTOM_WORKER)).toBe(true)
  })
  test('built-in worker is not', () => {
    expect(isCustomSubagentType('worker', BUILTIN_WORKER)).toBe(false)
  })
  test('unregistered worker is not', () => {
    expect(isCustomSubagentType('worker')).toBe(false)
  })
  test('code-reviewer is', () => {
    expect(isCustomSubagentType('code-reviewer')).toBe(true)
  })
  test('general-purpose is not', () => {
    expect(isCustomSubagentType('general-purpose')).toBe(false)
    expect(isCustomSubagentType(undefined)).toBe(false)
  })
})

describe('#14 group header shows the custom worker type', () => {
  function toolUse(id: string, subagent_type: string) {
    return {
      param: { type: 'tool_use' as const, id, name: 'Agent', input: { subagent_type, description: 'd', prompt: 'p' } },
      isResolved: true,
      isError: false,
      isInProgress: false,
      progressMessages: [],
      result: undefined,
    }
  }

  test('two custom workers → "worker agents" in the group header', async () => {
    const node = renderGroupedAgentToolUse(
      [toolUse('a', 'worker'), toolUse('b', 'worker')] as never,
      { shouldAnimate: false, tools: [], activeAgents: CUSTOM_WORKER } as never,
    )
    const out = await renderToStringIsolated(React.createElement(ThemeProvider, null, node))
    expect(out).toContain('worker agents')
  })
})
