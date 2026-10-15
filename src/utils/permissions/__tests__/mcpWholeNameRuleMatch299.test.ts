import { describe, expect, test } from 'bun:test'

import type { Tool, ToolPermissionContext } from '../../../Tool.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from '../permissions.js'

/**
 * claude-code 2.1.299 #65 + #158 — MCP `mcp__<server>` rule matching must key
 * off the server's WHOLE normalized name.
 *
 *   #65 (line 65): "Fixed deny and ask rules for an MCP server (`mcp__<server>`)
 *     not applying when the server's normalized name contains a double
 *     underscore."
 *   #158 (line 158): "Changed MCP allow rules to reach only the server they name:
 *     `mcp__a` no longer allows a server named `a__b` or `a_`; write
 *     `mcp__<server>__*` with the server's whole normalized name."
 *
 * OCC root cause: `toolMatchesRule` re-parsed the tool's own qualified name via
 * `mcpInfoFromString`, which splits on `__` and truncates the server name at the
 * FIRST `__`. For a server whose normalized name contains `__` (e.g. literal
 * `a__b`, or `a  b` → `a__b`), the tool parsed as server `a`, so:
 *   - #65: a rule `mcp__a__b` (server `a__b`, all tools) parsed as server `a` +
 *     tool `b` and never matched → deny/ask silently not applied (fail-open).
 *   - #158: an allow rule `mcp__a` parsed as server `a` and matched the tool's
 *     truncated server `a` → over-reached onto servers `a__b` and `a_`.
 *
 * Fix: the tool's real server name is available as `tool.mcpInfo.serverName`, so
 * match the rule string against the whole-name forms `mcp__<normalizedServer>`
 * and `mcp__<normalizedServer>__*` directly (exact-tool rules still match on the
 * qualified name upstream).
 */

type McpTool = Pick<Tool, 'name' | 'mcpInfo'>

function mcpTool(serverName: string, toolName: string): McpTool {
  // Mirror how the real registry names MCP tools: mcp__<normalizedServer>__<tool>.
  const normalized = serverName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return {
    name: `mcp__${normalized}__${toolName}`,
    mcpInfo: { serverName, toolName },
  }
}

function makeContext(opts: {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: opts.allow ? { userSettings: opts.allow } : {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    alwaysAskRules: opts.ask ? { userSettings: opts.ask } : {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

describe('MCP rule matching — 2.1.299 #65 (deny/ask apply when name has __)', () => {
  test('deny rule mcp__a__b applies to a server literally named a__b', () => {
    const ctx = makeContext({ deny: ['mcp__a__b'] })
    const rule = getDenyRuleForTool(ctx, mcpTool('a__b', 'tool'))
    expect(rule).not.toBeNull()
    expect(rule?.ruleValue.toolName).toBe('mcp__a__b')
  })

  test('ask rule mcp__a__b applies to a server literally named a__b', () => {
    const ctx = makeContext({ ask: ['mcp__a__b'] })
    const rule = getAskRuleForTool(ctx, mcpTool('a__b', 'tool'))
    expect(rule).not.toBeNull()
  })

  test('deny rule applies when a name with spaces normalizes to a__b', () => {
    // "a  b" (two spaces) normalizes to "a__b" — the changelog's "normalized
    // name contains a double underscore".
    const ctx = makeContext({ deny: ['mcp__a__b'] })
    const rule = getDenyRuleForTool(ctx, mcpTool('a  b', 'tool'))
    expect(rule).not.toBeNull()
  })

  test('whole-name wildcard mcp__a__b__* reaches server a__b', () => {
    const ctx = makeContext({ allow: ['mcp__a__b__*'] })
    const rule = toolAlwaysAllowedRule(ctx, mcpTool('a__b', 'tool'))
    expect(rule).not.toBeNull()
  })
})

describe('MCP rule matching — 2.1.299 #158 (allow reaches only the named server)', () => {
  test('allow rule mcp__a does NOT reach a server named a__b', () => {
    const ctx = makeContext({ allow: ['mcp__a'] })
    expect(toolAlwaysAllowedRule(ctx, mcpTool('a__b', 'tool'))).toBeNull()
  })

  test('allow rule mcp__a does NOT reach a server named a_ (trailing _)', () => {
    const ctx = makeContext({ allow: ['mcp__a'] })
    expect(toolAlwaysAllowedRule(ctx, mcpTool('a_', 'tool'))).toBeNull()
  })

  test('deny rule mcp__a does NOT reach a server named a__b', () => {
    const ctx = makeContext({ deny: ['mcp__a'] })
    expect(getDenyRuleForTool(ctx, mcpTool('a__b', 'tool'))).toBeNull()
  })

  test('whole-name rule mcp__a_ DOES reach a server named a_', () => {
    const ctx = makeContext({ allow: ['mcp__a_'] })
    expect(toolAlwaysAllowedRule(ctx, mcpTool('a_', 'tool'))).not.toBeNull()
  })
})

describe('MCP rule matching — regressions (single-segment names unchanged)', () => {
  test('server-level allow mcp__server1 still reaches server1 tools', () => {
    const ctx = makeContext({ allow: ['mcp__server1'] })
    expect(
      toolAlwaysAllowedRule(ctx, mcpTool('server1', 'tool1')),
    ).not.toBeNull()
  })

  test('wildcard allow mcp__server1__* still reaches server1 tools', () => {
    const ctx = makeContext({ allow: ['mcp__server1__*'] })
    expect(
      toolAlwaysAllowedRule(ctx, mcpTool('server1', 'tool1')),
    ).not.toBeNull()
  })

  test('exact-tool deny mcp__server1__tool1 still matches', () => {
    const ctx = makeContext({ deny: ['mcp__server1__tool1'] })
    expect(
      getDenyRuleForTool(ctx, mcpTool('server1', 'tool1')),
    ).not.toBeNull()
  })

  test('exact-tool deny for a different tool does not match', () => {
    const ctx = makeContext({ deny: ['mcp__server1__tool2'] })
    expect(getDenyRuleForTool(ctx, mcpTool('server1', 'tool1'))).toBeNull()
  })

  test('a non-MCP rule never matches an MCP tool', () => {
    const ctx = makeContext({ allow: ['Bash'] })
    expect(toolAlwaysAllowedRule(ctx, mcpTool('server1', 'tool1'))).toBeNull()
  })
})
