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
 * Fix (merge-integrated): matching now routes through `mcpRuleMatchesTool` —
 * the official `S` matcher recovered verbatim from the 2.1.299 linux-x64 ELF
 * (./mcpRuleMatching.ts, binary evidence @219828700). It keeps the official
 * allow/deny asymmetry: ALLOW rules must cover the tool's canonical name AND
 * reach only the whole-named server; DENY/ASK rules fail safe and also apply
 * when the rule equals one of the tool's whole-name server candidates.
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

  // Official asymmetry (binary-verified `S` matcher @219828700 — see
  // mcpRuleMatching.ts): DENY/ASK rules fail SAFE and may over-reach. Deny
  // `mcp__a` DOES reach server `a__b` because the canonical name
  // `mcp__a__b__tool` name-parses as server `a` (covers=true). Over-matching a
  // deny is the safe direction; the earlier symmetric expectation here was the
  // approximation's, not the official binary's.
  test('deny rule mcp__a DOES reach a server named a__b (official fail-safe over-match)', () => {
    const ctx = makeContext({ deny: ['mcp__a'] })
    expect(getDenyRuleForTool(ctx, mcpTool('a__b', 'tool'))).not.toBeNull()
  })

  // Official ALLOW semantics: allow requires the rule's name-parse to COVER the
  // tool's canonical name unambiguously. Server `a_`'s canonical name
  // `mcp__a___tool` name-parses as server `a`, so the whole-name rule
  // `mcp__a_` never covers it — changelog #158 itself says "`mcp__a` no longer
  // allows a server named `a__b` or `a_`", and the official zFn warning points
  // at the whole-name wildcard form `mcp__a___*` instead.
  test('whole-name rule mcp__a_ does NOT reach a server named a_ (canonical name parses ambiguously)', () => {
    const ctx = makeContext({ allow: ['mcp__a_'] })
    expect(toolAlwaysAllowedRule(ctx, mcpTool('a_', 'tool'))).toBeNull()
  })

  test('whole-name wildcard mcp__a___* DOES reach a server named a_', () => {
    const ctx = makeContext({ allow: ['mcp__a___*'] })
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
