/**
 * CC 2.1.299 #158/#159 — agent `tools:` lists take ONLY the named MCP
 * server's tools (official agent-tools branch @231360600; changelog-299.txt
 * line 161: "Changed agent `tools:` lists to take only the named MCP server's
 * tools; list a server whose name contains `__` as `mcp__<whole name>__*`").
 *
 * Official branch (byte-exact from the v299 ELF):
 *   let He=oo(fe);
 *   if(He!==null&&He.serverName!=="*"&&(He.toolName===void 0||He.toolName==="*")){
 *     _e.push(ee);let Ae=!1;
 *     for(let $e of re){...if(!lXe(fe,$e)){...continue}Ae=!0;R.push($e)...}
 *     if(!Ae)t(`Agent tools entry "${ee}" takes no tool: no connected MCP
 *       server of that name has one.`,{level:"warn"});
 *     continue}
 *   let pt=fe.endsWith("__*")?fe.slice(0,-3):fe,
 *       yt=...filter((Ae)=>Ae.mcpInfo!==void 0&&zs(Ae.mcpInfo.serverName,"")
 *         ===`${pt}__`&&lXe(`${pt}__*`,Ae)...);
 *   if(pt!==fe&&yt[0]!==void 0){_e.push(ee);...push all yt...;continue}
 *   // else fall through to the exact-name map lookup
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as debug from '../../../utils/debug.js'
import type { Tool, Tools } from '../../../Tool.js'
import { resolveAgentTools } from '../agentToolUtils.js'
import { resetAllowRuleWarningsForTesting } from '../../../utils/permissions/mcpRuleMatching.js'

function makeTool(
  name: string,
  mcpInfo?: { serverName: string; toolName: string },
): Tool {
  return {
    name,
    ...(mcpInfo ? { mcpInfo } : {}),
    description: async () => name,
    inputSchema: {} as never,
    call: async () => ({ data: {} }),
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    isReadOnly: () => true,
    maxResultSizeChars: 1000,
  } as unknown as Tool
}

// Connected MCP servers: "a" (tool1), "a__b" (tool2), "a_" (tool3) + Bash.
const toolA = makeTool('mcp__a__tool1', { serverName: 'a', toolName: 'tool1' })
const toolAB = makeTool('mcp__a__b__tool2', {
  serverName: 'a__b',
  toolName: 'tool2',
})
const toolAUnderscore = makeTool('mcp__a___tool3', {
  serverName: 'a_',
  toolName: 'tool3',
})
const bash = makeTool('Bash')
const availableTools: Tools = [toolA, toolAB, toolAUnderscore, bash]

function resolve(tools: string[]) {
  return resolveAgentTools(
    { tools, source: 'project' as const },
    availableTools,
  )
}

function resolvedNames(tools: string[]): string[] {
  return resolve(tools).resolvedTools.map(tool => tool.name)
}

let logs: { message: string; level?: string }[] = []
let spy: ReturnType<typeof spyOn> | undefined

beforeEach(() => {
  logs = []
  resetAllowRuleWarningsForTesting()
  spy = spyOn(debug, 'logForDebugging').mockImplementation(
    (message: string, opts?: { level?: string }) => {
      logs.push({ message, level: opts?.level })
      return undefined as never
    },
  )
})

afterEach(() => {
  spy?.mockRestore()
})

describe('CC 2.1.299 #159: server-wide agent tools entries', () => {
  test('mcp__a resolves ONLY server a\'s tools (not a__b, not a_)', () => {
    // Arrange / Act
    const result = resolve(['mcp__a'])

    // Assert
    expect(result.hasWildcard).toBe(false)
    expect(result.resolvedTools).toEqual([toolA])
    expect(result.validTools).toEqual(['mcp__a'])
    expect(result.invalidTools).toEqual([])
  })

  test('mcp__a__* resolves ONLY server a\'s tools', () => {
    expect(resolvedNames(['mcp__a__*'])).toEqual(['mcp__a__tool1'])
  })

  test('mcp__a__b__* (whole name) resolves ONLY server a__b\'s tools', () => {
    // Arrange / Act — changelog: a server whose name contains `__` must be
    // listed as mcp__<whole name>__*.
    const result = resolve(['mcp__a__b__*'])

    // Assert
    expect(result.resolvedTools).toEqual([toolAB])
    expect(result.validTools).toEqual(['mcp__a__b__*'])
    expect(result.invalidTools).toEqual([])
  })

  test('mcp__a___* (whole name of server a_) resolves ONLY its tools', () => {
    expect(resolvedNames(['mcp__a___*'])).toEqual(['mcp__a___tool3'])
  })

  test('specific-tool entry still resolves via the exact-name lookup', () => {
    const result = resolve(['mcp__a__b__tool2'])

    expect(result.resolvedTools).toEqual([toolAB])
    expect(result.validTools).toEqual(['mcp__a__b__tool2'])
    expect(result.invalidTools).toEqual([])
  })

  test('mixed builtin + MCP entries resolve independently', () => {
    const result = resolve(['Bash', 'mcp__a'])

    expect(result.resolvedTools).toEqual([bash, toolA])
    expect(result.invalidTools).toEqual([])
  })

  test('entry for a nonexistent server → valid, resolves nothing, byte-exact warn', () => {
    // Arrange / Act — official pushes the entry into validTools (_e) and
    // warns when no tool matched (Ae stays false).
    const result = resolve(['mcp__nonexistent'])

    // Assert
    expect(result.validTools).toEqual(['mcp__nonexistent'])
    expect(result.resolvedTools).toEqual([])
    expect(logs).toContainEqual({
      message:
        'Agent tools entry "mcp__nonexistent" takes no tool: no connected MCP server of that name has one.',
      level: 'warn',
    })
  })

  test('mcp__* (wildcard server) is NOT treated as an MCP server entry', () => {
    // oo('mcp__*') → serverName '*' → official skips the server-wide branch;
    // no tool is named 'mcp__*' → invalid entry.
    const result = resolve(['mcp__*'])

    expect(result.resolvedTools).toEqual([])
    expect(result.invalidTools).toEqual(['mcp__*'])
  })

  test('duplicate entries resolve each tool once (official F dedup Set)', () => {
    const result = resolve(['mcp__a', 'mcp__a__*'])

    expect(result.resolvedTools).toEqual([toolA])
    expect(result.validTools).toEqual(['mcp__a', 'mcp__a__*'])
  })
})
