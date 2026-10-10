import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext } from 'src/Tool.js'
import { filterToolsByDenyRules } from 'src/tools.js'

/**
 * CC 2.1.295 changelog #037 — integration check on the real tool-registry path.
 *
 * `filterToolsByDenyRules` (src/tools.ts) is the single funnel every tool pool
 * build goes through: getTools(), the CLAUDE_CODE_SIMPLE pools, the
 * embedded-search Glob/Grep re-add, and assembleToolPool()'s MCP partition. The
 * official v295 body (v295 @214477161) runs the deny-rule pass first and then
 * the launch-list gate, so a built-in that registers after the `--tools`
 * snapshot was taken is withheld here even though no deny rule names it.
 */

function contextWith(
  toolsKeptByLaunchList?: readonly string[],
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...(toolsKeptByLaunchList === undefined ? {} : { toolsKeptByLaunchList }),
  }
}

/** Minimal stand-in for a built-in tool object at the registry boundary. */
function builtIn(name: string): { name: string } {
  return { name }
}

describe('2.1.295 #037 filterToolsByDenyRules launch-list gate', () => {
  test('withholds a late-registering built-in that no deny rule names', () => {
    // Arrange — the session launched with `--tools Bash,Read`; a new built-in
    // appeared afterwards, so the startup deny snapshot never mentioned it.
    const context = contextWith(['Bash', 'Read'])
    const pool = [builtIn('Bash'), builtIn('Read'), builtIn('LateBuiltin')]

    // Act
    const kept = filterToolsByDenyRules(pool, context)

    // Assert
    expect(kept.map(tool => tool.name)).toEqual(['Bash', 'Read'])
  })

  test('leaves the pool untouched when no launch list was requested', () => {
    // Arrange
    const context = contextWith(undefined)
    const pool = [builtIn('Bash'), builtIn('LateBuiltin')]

    // Act
    const kept = filterToolsByDenyRules(pool, context)

    // Assert
    expect(kept.map(tool => tool.name)).toEqual(['Bash', 'LateBuiltin'])
  })

  test('still exempts MCP tools from the launch-list gate', () => {
    // Arrange — `--tools` narrows built-ins only; MCP tools arrive via servers.
    const context = contextWith(['Bash'])
    const pool = [
      builtIn('Bash'),
      builtIn('LateBuiltin'),
      { name: 'mcp__github__create_issue' },
    ]

    // Act
    const kept = filterToolsByDenyRules(pool, context)

    // Assert
    expect(kept.map(tool => tool.name)).toEqual([
      'Bash',
      'mcp__github__create_issue',
    ])
  })
})
