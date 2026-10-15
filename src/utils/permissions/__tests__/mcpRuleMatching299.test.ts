/**
 * CC 2.1.299 #065 + #158 + #159 — MCP permission-rule matching against the
 * WHOLE normalized server name (official module @215236100, matcher S
 * @219828700, warn zFn @219823300; changelog-299.txt lines 67/160/161).
 *
 * Official semantics asserted here (hand-traced against the byte-exact
 * decompiled functions in mcpRuleMatching.ts header):
 * - ALLOW strict (#158): rule `mcp__a` allows server `a`'s tools but NOT
 *   server `a__b` (canonical name parses ambiguously) and NOT server `a_`
 *   (changelog: "no longer allows a server named a__b or a_").
 * - ALLOW whole-name: `mcp__a__b__*` DOES allow server `a__b`'s tools.
 * - DENY/ASK fail-safe over-match: deny `mcp__a` denies server `a__b`'s
 *   tools too (the name parse covers them) — the official deny branch is
 *   `c || (j && aXe candidates)`; over-denying is the deliberate fail-safe.
 * - #065: deny/ask `mcp__a__b` applies to server `a__b` (rule equals one of
 *   the tool's whole-name server candidates, aXe), even though the name
 *   parse of the rule alone misreads it as server "a", tool "b".
 * - zFn warnings: byte-exact, deduped once per rule name, two variants
 *   (mcpInfo tool / name-only tool).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { ToolPermissionContext } from '../../../Tool.js'
import * as debug from '../../debug.js'
import type { PermissionRule } from '../PermissionRule.js'
import {
  getMcpServerRuleNames,
  mcpAllowRuleReachesTool,
  mcpRuleMatchesTool,
  resetAllowRuleWarningsForTesting,
  ruleCoversMcpToolName,
  ruleReachesWholeNamedServer,
} from '../mcpRuleMatching.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from '../permissions.js'

type FakeTool = {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}

// Server "a", tool "tool1" — canonical name mcp__a__tool1.
const toolA: FakeTool = {
  name: 'mcp__a__tool1',
  mcpInfo: { serverName: 'a', toolName: 'tool1' },
}
// Server "a__b", tool "tool2" — canonical name mcp__a__b__tool2 (the #065/#158
// ambiguity case: the name parses as server "a", tool "b__tool2").
const toolAB: FakeTool = {
  name: 'mcp__a__b__tool2',
  mcpInfo: { serverName: 'a__b', toolName: 'tool2' },
}
// Server "a_", tool "tool3" — canonical name mcp__a___tool3 (changelog:
// "`mcp__a` no longer allows a server named `a__b` or `a_`").
const toolAUnderscore: FakeTool = {
  name: 'mcp__a___tool3',
  mcpInfo: { serverName: 'a_', toolName: 'tool3' },
}
// MCP-shaped name WITHOUT mcpInfo (SDK skip-prefix style): candidates come
// from the name's `__` boundaries.
const nameOnlyMcpTool: FakeTool = { name: 'mcp__a__b__tool' }
const bashTool: FakeTool = { name: 'Bash' }

function rule(toolName: string, ruleBehavior: 'allow' | 'deny' | 'ask'): PermissionRule {
  return {
    source: 'userSettings',
    ruleBehavior,
    ruleValue: { toolName },
  } as PermissionRule
}

function makeContext(overrides: Partial<ToolPermissionContext>): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  } as ToolPermissionContext
}

let logSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  resetAllowRuleWarningsForTesting()
  logSpy = spyOn(debug, 'logForDebugging').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
})

describe('CC 2.1.299 #158: allow rules reach only the server they name', () => {
  test('allow mcp__a matches server a\'s tool', () => {
    expect(mcpRuleMatchesTool(toolA, rule('mcp__a', 'allow'))).toBe(true)
  })

  test('allow mcp__a__* matches server a\'s tool', () => {
    expect(mcpRuleMatchesTool(toolA, rule('mcp__a__*', 'allow'))).toBe(true)
  })

  test('allow mcp__a does NOT match server a__b\'s tool (changelog line 160)', () => {
    expect(mcpRuleMatchesTool(toolAB, rule('mcp__a', 'allow'))).toBe(false)
  })

  test('allow mcp__a does NOT match server a_\'s tool (changelog line 160)', () => {
    expect(mcpRuleMatchesTool(toolAUnderscore, rule('mcp__a', 'allow'))).toBe(false)
  })

  test('allow mcp__a__* does NOT match server a__b\'s tool (partial name is not the whole name)', () => {
    expect(mcpRuleMatchesTool(toolAB, rule('mcp__a__*', 'allow'))).toBe(false)
  })

  test('allow mcp__a__b__* DOES match server a__b\'s tool (whole-name wildcard)', () => {
    expect(mcpRuleMatchesTool(toolAB, rule('mcp__a__b__*', 'allow'))).toBe(true)
  })

  test('allow mcp__a___* DOES match server a_\'s tool (whole-name wildcard)', () => {
    expect(
      mcpRuleMatchesTool(toolAUnderscore, rule('mcp__a___*', 'allow')),
    ).toBe(true)
  })

  test('allow rules never match non-MCP rules/tools (no false positives)', () => {
    expect(mcpRuleMatchesTool(bashTool, rule('Bash', 'allow'))).toBe(false)
    expect(mcpRuleMatchesTool(bashTool, rule('mcp__a', 'allow'))).toBe(false)
    expect(mcpRuleMatchesTool(toolA, rule('Bash', 'allow'))).toBe(false)
  })
})

describe('CC 2.1.299 #065: deny/ask rules apply to whole-name servers', () => {
  test('deny mcp__a__b applies to server a__b\'s tool (#065 candidates branch)', () => {
    // The name parse of the rule misreads it as server "a", tool "b" — the
    // whole-name candidate list (aXe) is what makes it apply.
    expect(mcpRuleMatchesTool(toolAB, rule('mcp__a__b', 'deny'))).toBe(true)
  })

  test('ask mcp__a__b applies to server a__b\'s tool', () => {
    expect(mcpRuleMatchesTool(toolAB, rule('mcp__a__b', 'ask'))).toBe(true)
  })

  test('deny mcp__a__b does NOT touch server a\'s tools', () => {
    expect(mcpRuleMatchesTool(toolA, rule('mcp__a__b', 'deny'))).toBe(false)
  })

  test('deny mcp__a covers server a AND (fail-safe) server a__b via the name parse', () => {
    // Official deny branch is deliberately over-matching: oo(jc(toolAB)) =
    // {serverName:"a", toolName:"b__tool2"} — covered by the server-wide rule.
    // NOTE: this over-match CONTRADICTS the WP spec wording ("deny mcp__a
    // does NOT deny tool of server a__b"); the binary is the source of truth
    // (aligning-with-official-binary: never invent) — flagged in the report.
    expect(mcpRuleMatchesTool(toolA, rule('mcp__a', 'deny'))).toBe(true)
    expect(mcpRuleMatchesTool(toolAB, rule('mcp__a', 'deny'))).toBe(true)
    expect(mcpRuleMatchesTool(toolAUnderscore, rule('mcp__a', 'deny'))).toBe(true)
  })

  test('deny mcp__a__b applies to a name-only mcp__a__b__* tool (boundary candidates)', () => {
    expect(
      mcpRuleMatchesTool(nameOnlyMcpTool, rule('mcp__a__b', 'deny')),
    ).toBe(true)
  })

  test('deny rules never match non-MCP tools', () => {
    expect(mcpRuleMatchesTool(bashTool, rule('mcp__a', 'deny'))).toBe(false)
  })
})

describe('CC 2.1.299: official primitives (aXe / XIo / lXe / IOr)', () => {
  test('getMcpServerRuleNames (aXe) — mcpInfo tool yields normalized + round-trip candidates', () => {
    // fA('a__b') round-trips to 'a' (oo('mcp__a__b__x').serverName), so the
    // candidates are ['mcp__a__b', 'mcp__a'].
    expect(getMcpServerRuleNames(toolAB)).toEqual(['mcp__a__b', 'mcp__a'])
    expect(getMcpServerRuleNames(toolA)).toEqual(['mcp__a', 'mcp__a'])
  })

  test('getMcpServerRuleNames (aXe) — name-only tool yields all __ prefixes', () => {
    expect(getMcpServerRuleNames(nameOnlyMcpTool)).toEqual([
      'mcp__a',
      'mcp__a__b',
    ])
    expect(getMcpServerRuleNames(bashTool)).toEqual([])
  })

  test('ruleCoversMcpToolName (IOr) — server-wide vs wildcard tool patterns', () => {
    expect(ruleCoversMcpToolName('mcp__a', 'mcp__a__tool1')).toBe(true)
    expect(ruleCoversMcpToolName('mcp__a', 'mcp__a__b__tool2')).toBe(true)
    expect(ruleCoversMcpToolName('mcp__a__tool*', 'mcp__a__tool1')).toBe(true)
    expect(ruleCoversMcpToolName('mcp__a__tool*', 'mcp__a__other')).toBe(false)
    // A non-wildcard toolName in the rule is NOT a covers match (the official
    // YIo only globs when TE(toolName)); exact names match via the equality
    // step in toolMatchesRule instead.
    expect(ruleCoversMcpToolName('mcp__a__tool1', 'mcp__a__tool1')).toBe(false)
    expect(ruleCoversMcpToolName('Bash', 'mcp__a__tool1')).toBe(false)
  })

  test('ruleReachesWholeNamedServer (XIo) — ambiguity gate', () => {
    expect(ruleReachesWholeNamedServer('mcp__a', toolA)).toBe(true)
    expect(ruleReachesWholeNamedServer('mcp__a', toolAB)).toBe(false)
    expect(ruleReachesWholeNamedServer('mcp__a', toolAUnderscore)).toBe(false)
    expect(ruleReachesWholeNamedServer('mcp__a__b__*', toolAB)).toBe(true)
    expect(ruleReachesWholeNamedServer('mcp__a__*', toolAB)).toBe(false)
    // every() over the name-only candidates ['mcp__a','mcp__a__b']: both
    // rules pass — 'mcp__a__b' EQUALS the second candidate, 'mcp__a__b__*'
    // starts with 'mcp__a__b__' (and with 'mcp__a__'). The gate fails only
    // when a candidate is NOT covered, e.g. 'mcp__a' vs toolAB's
    // candidate 'mcp__a__b' (asserted above).
    expect(ruleReachesWholeNamedServer('mcp__a__b', nameOnlyMcpTool)).toBe(true)
    expect(ruleReachesWholeNamedServer('mcp__a__b__*', nameOnlyMcpTool)).toBe(true)
  })

  test('mcpAllowRuleReachesTool (lXe) — covers AND unambiguous', () => {
    expect(mcpAllowRuleReachesTool('mcp__a', toolA)).toBe(true)
    expect(mcpAllowRuleReachesTool('mcp__a', toolAB)).toBe(false)
    expect(mcpAllowRuleReachesTool('mcp__a__b__*', toolAB)).toBe(true)
  })
})

describe('CC 2.1.299: zFn allow-rule warnings (byte-exact, deduped)', () => {
  test('mcpInfo tool → "belong to another MCP server" variant', () => {
    mcpRuleMatchesTool(toolAB, rule('mcp__a', 'allow'))

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(
      'Allow rule "mcp__a" does not allow the tools named "mcp__a__b__<tool>": they belong to another MCP server than the rule names. To allow them, use "mcp__a__b__*".',
      { level: 'warn' },
    )
  })

  test('name-only tool → "reads as more than one MCP server\'s" variant', () => {
    mcpRuleMatchesTool(nameOnlyMcpTool, rule('mcp__a', 'allow'))

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(
      'Allow rule "mcp__a" does not allow "mcp__a__b__tool": the name reads as more than one MCP server\'s. To allow it, use the tool\'s full name.',
      { level: 'warn' },
    )
  })

  test('warns once per rule name (official dedup Set M)', () => {
    mcpRuleMatchesTool(toolAB, rule('mcp__a', 'allow'))
    mcpRuleMatchesTool(toolAUnderscore, rule('mcp__a', 'allow'))

    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  test('successful allow match emits no warning', () => {
    mcpRuleMatchesTool(toolA, rule('mcp__a', 'allow'))

    expect(logSpy).not.toHaveBeenCalled()
  })
})

describe('CC 2.1.299: integration through permissions.ts rule lookups', () => {
  test('toolAlwaysAllowedRule: mcp__a allows server a only', () => {
    const ctx = makeContext({
      alwaysAllowRules: { userSettings: ['mcp__a'] },
    })

    expect(toolAlwaysAllowedRule(ctx, toolA as never)).not.toBeNull()
    expect(toolAlwaysAllowedRule(ctx, toolAB as never)).toBeNull()
    expect(toolAlwaysAllowedRule(ctx, toolAUnderscore as never)).toBeNull()
  })

  test('toolAlwaysAllowedRule: specific-tool rule matches via exact name', () => {
    const ctx = makeContext({
      alwaysAllowRules: { userSettings: ['mcp__a__b__tool2'] },
    })

    expect(toolAlwaysAllowedRule(ctx, toolAB as never)).not.toBeNull()
    expect(toolAlwaysAllowedRule(ctx, toolA as never)).toBeNull()
  })

  test('getDenyRuleForTool: deny mcp__a__b denies server a__b (#065) and spares server a', () => {
    const ctx = makeContext({
      alwaysDenyRules: { userSettings: ['mcp__a__b'] },
    })

    expect(getDenyRuleForTool(ctx, toolAB as never)).not.toBeNull()
    expect(getDenyRuleForTool(ctx, toolA as never)).toBeNull()
  })

  test('getAskRuleForTool: ask mcp__a__b__* asks server a__b', () => {
    const ctx = makeContext({
      alwaysAskRules: { userSettings: ['mcp__a__b__*'] },
    })

    expect(getAskRuleForTool(ctx, toolAB as never)).not.toBeNull()
  })

  test('non-MCP tools are unaffected (Bash allow rule still exact-matches)', () => {
    const ctx = makeContext({
      alwaysAllowRules: { userSettings: ['Bash'] },
      alwaysDenyRules: { userSettings: ['mcp__a'] },
    })

    expect(toolAlwaysAllowedRule(ctx, bashTool as never)).not.toBeNull()
    expect(getDenyRuleForTool(ctx, bashTool as never)).toBeNull()
  })
})
