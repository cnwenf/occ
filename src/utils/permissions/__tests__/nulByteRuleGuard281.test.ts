import { describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import { matchWildcardPattern } from '../shellRuleMatching.js'

// The permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (build-time constant polyfilled in cli.tsx at runtime).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official 2.1.281 changelog: "Fixed a permission rule containing a NUL byte
 * being expanded into a wildcard match; such a rule now matches nothing."
 *
 * OCC exposure differs from the official one but the contract is identical:
 * matchWildcardPattern() uses NUL-delimited sentinels (\x00ESCAPED_STAR\x00 /
 * \x00ESCAPED_BACKSLASH\x00) to protect `\*` and `\\` escapes. A rule that
 * SMUGGLES a raw sentinel survives the escape/regex-escape passes and is
 * reinterpreted during placeholder restoration — e.g. the rule
 * `make\x00ESCAPED_STAR\x00 *` restored to the regex `make\* .*`, which
 * matched the command `make* deploy` (a wildcard expansion the rule author
 * never wrote). The guard fails closed: any pattern containing \x00 matches
 * nothing, for every consumer of the shared matcher (Bash, PowerShell,
 * FileEdit/Read/Write, Grep, Glob).
 */
describe('2.1.281 NUL-byte permission rule guard (matchWildcardPattern)', () => {
  test('patterns without NUL keep matching normally', () => {
    expect(matchWildcardPattern('git *', 'git push')).toBe(true)
    expect(matchWildcardPattern('git *', 'npm install')).toBe(false)
    expect(matchWildcardPattern('echo \\*', 'echo *')).toBe(true)
    expect(matchWildcardPattern('echo \\*', 'echo hi')).toBe(false)
  })

  test('a rule containing a raw NUL byte matches nothing', () => {
    // Even when the command contains the same NUL byte at the same position,
    // the official contract is "matches nothing" — fail closed.
    expect(matchWildcardPattern('git\x00 *', 'git\x00 push')).toBe(false)
    expect(matchWildcardPattern('npm\x00run *', 'npm\x00run build')).toBe(false)
    expect(matchWildcardPattern('\x00*', 'anything')).toBe(false)
    expect(matchWildcardPattern('*', 'anything')).toBe(true)
  })

  test('a smuggled ESCAPED_STAR sentinel no longer expands to a literal-star wildcard', () => {
    // Pre-guard behavior: the sentinel was restored to regex `\*`, so this
    // rule matched the command `make* deploy` — an expansion the rule text
    // never expressed. Post-guard: matches nothing.
    const smuggled = 'make\x00ESCAPED_STAR\x00 *'
    expect(matchWildcardPattern(smuggled, 'make* deploy')).toBe(false)
    expect(matchWildcardPattern(smuggled, 'make deploy')).toBe(false)
  })

  test('a smuggled ESCAPED_BACKSLASH sentinel matches nothing', () => {
    expect(
      matchWildcardPattern('rm\x00ESCAPED_BACKSLASH\x00 *', 'rm\\ /tmp/x'),
    ).toBe(false)
  })

  test('guard applies in case-insensitive mode too (PowerShell path)', () => {
    expect(matchWildcardPattern('Get\x00 *', 'Get\x00 Process', true)).toBe(
      false,
    )
    expect(matchWildcardPattern('get *', 'Get Process', true)).toBe(true)
  })

  test('NUL anywhere in the pattern disables the rule (start, middle, end)', () => {
    expect(matchWildcardPattern('\x00git *', 'git push')).toBe(false)
    expect(matchWildcardPattern('gi\x00t *', 'git push')).toBe(false)
    expect(matchWildcardPattern('git *\x00', 'git push')).toBe(false)
  })
})

describe('2.1.281 NUL-byte rule guard — bashToolHasPermission integration', () => {
  async function permissionWithAllowRule(rule: string, command: string) {
    const { bashToolHasPermission } = await import(
      '../../../tools/BashTool/bashPermissions.js'
    )
    const appState = {
      toolPermissionContext: {
        ...getEmptyToolPermissionContext(),
        mode: 'default',
        alwaysAllowRules: { cliArg: [rule] },
      },
    } as never
    const ctx = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'sonnet',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(100),
      getAppState: () => appState,
      setAppState: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      messages: [],
    } as unknown as ToolUseContext
    return bashToolHasPermission(
      { command, description: '' } as never,
      ctx,
    )
  }

  test('a smuggled-sentinel allow rule cannot auto-allow the expanded command', async () => {
    const result = await permissionWithAllowRule(
      'Bash(make\x00ESCAPED_STAR\x00 *)',
      'make* deploy',
    )
    expect(result.behavior).not.toBe('allow')
  })

  test('an equivalent honest wildcard allow rule still auto-allows', async () => {
    const result = await permissionWithAllowRule(
      'Bash(make *)',
      'make deploy',
    )
    expect(result.behavior).toBe('allow')
  })
})
