import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getIsNonInteractiveSession,
  getPermissionPromptToolName,
  resetStateForTests,
  setIsInteractive,
  setPermissionPromptToolName,
} from '../../../bootstrap/state.js'
import { FORK_AGENT, FORK_SUBAGENT_TYPE } from '../forkSubagent.js'
import {
  resolveAgentEffectivePermissionMode,
  resolveShouldAvoidPermissionPrompts,
  runAgent,
} from '../runAgent.js'

/**
 * CC 2.1.285 (security): "Fixed fork subagents not keeping the session's plan
 * mode or `dontAsk` mode: a fork now runs under its parent's permission mode
 * and cannot exit plan mode."
 *
 * Official v285 permission-context builder (decompiled ELF):
 *   `else if(xe==="bubble"&&(E.mode==="plan"||E.mode==="dontAsk"))Ze=E.mode`
 * where xe = the agent definition's declared permissionMode (FORK_AGENT
 * declares 'bubble'), E = the parent toolPermissionContext, Ze = effective
 * mode. These tests pin resolveAgentEffectivePermissionMode — the pure
 * extraction of that branch used by runAgent's agentGetAppState.
 *
 * CC 2.1.285: "Fixed `claude -p --permission-prompt-tool` background subagent
 * permission requests being auto-denied" — official `Se=ke()&&QRt(cI())`
 * (!isInteractive && promptToolName!==undefined && !=="none") makes
 * shouldAvoidPrompts false so the request routes to the prompt tool.
 */

describe('fork subagent permission-mode inheritance (CC 2.1.285)', () => {
  test('FORK_AGENT declares bubble mode and the fork agentType', () => {
    expect(FORK_AGENT.agentType).toBe(FORK_SUBAGENT_TYPE)
    expect(FORK_AGENT.permissionMode).toBe('bubble')
  })

  test('fork under plan mode stays in plan mode (cannot escape plan)', () => {
    expect(
      resolveAgentEffectivePermissionMode('bubble', 'plan', false),
    ).toBe('plan')
  })

  test('fork under dontAsk mode keeps dontAsk', () => {
    expect(
      resolveAgentEffectivePermissionMode('bubble', 'dontAsk', false),
    ).toBe('dontAsk')
  })

  test('fork under default mode keeps bubbling (declared mode)', () => {
    expect(
      resolveAgentEffectivePermissionMode('bubble', 'default', false),
    ).toBe('bubble')
  })

  test('non-fork declared modes are untouched by the bubble branch', () => {
    expect(resolveAgentEffectivePermissionMode('plan', 'default', false)).toBe(
      'plan',
    )
    expect(
      resolveAgentEffectivePermissionMode('acceptEdits', 'default', false),
    ).toBe('acceptEdits')
  })

  test('2.1.223 bypass-policy gate still wins over the declared mode', () => {
    expect(
      resolveAgentEffectivePermissionMode(
        'bypassPermissions',
        'default',
        true,
      ),
    ).toBe('default')
    expect(
      resolveAgentEffectivePermissionMode(
        'bypassPermissions',
        'default',
        false,
      ),
    ).toBe('bypassPermissions')
  })
})

describe('background subagent prompt routing (CC 2.1.285)', () => {
  beforeEach(() => {
    if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test'
    resetStateForTests()
  })

  afterEach(() => {
    resetStateForTests()
  })

  test('bootstrap state round-trips the permission-prompt-tool name', () => {
    expect(getPermissionPromptToolName()).toBeUndefined()
    setPermissionPromptToolName('mcp__foo__prompt')
    expect(getPermissionPromptToolName()).toBe('mcp__foo__prompt')
    setIsInteractive(false)
    expect(getIsNonInteractiveSession()).toBe(true)
  })

  test('async subagent in print mode WITH prompt tool is NOT auto-denied', () => {
    // Official Se = ke() && QRt(cI()): non-interactive + real tool name.
    setIsInteractive(false)
    setPermissionPromptToolName('mcp__foo__prompt')
    expect(
      resolveShouldAvoidPermissionPrompts(undefined, undefined, true),
    ).toBe(false)
  })

  test('prompt-tool name "none" does not disable auto-deny', () => {
    setIsInteractive(false)
    setPermissionPromptToolName('none')
    expect(
      resolveShouldAvoidPermissionPrompts(undefined, undefined, true),
    ).toBe(true)
  })

  test('interactive session keeps the default !isAsync behavior', () => {
    setIsInteractive(true)
    setPermissionPromptToolName('mcp__foo__prompt')
    expect(
      resolveShouldAvoidPermissionPrompts(undefined, undefined, true),
    ).toBe(true)
    expect(
      resolveShouldAvoidPermissionPrompts(undefined, undefined, false),
    ).toBe(false)
  })

  test('bubble agents always prompt regardless of print mode', () => {
    setIsInteractive(false)
    setPermissionPromptToolName(undefined)
    expect(
      resolveShouldAvoidPermissionPrompts(undefined, 'bubble', true),
    ).toBe(false)
  })

  test('explicit canShowPermissionPrompts wins over everything', () => {
    setIsInteractive(false)
    setPermissionPromptToolName('mcp__foo__prompt')
    expect(resolveShouldAvoidPermissionPrompts(false, 'bubble', false)).toBe(
      true,
    )
    expect(
      resolveShouldAvoidPermissionPrompts(true, undefined, true),
    ).toBe(false)
  })

  test('runAgent module exports the helpers used by agentGetAppState', () => {
    // Guard against accidental de-export during refactors — the closure in
    // runAgent delegates to these two pure functions.
    expect(typeof runAgent).toBe('function')
    expect(typeof resolveAgentEffectivePermissionMode).toBe('function')
    expect(typeof resolveShouldAvoidPermissionPrompts).toBe('function')
  })
})
