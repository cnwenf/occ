import { describe, expect, test, beforeEach } from 'bun:test'
import type { Tool, ToolUseContext, AssistantMessage } from '../../../src/Tool.js'
import {
  _resetDenialsForTesting,
  getAutoModeDenials,
} from '../../../src/utils/autoModeDenials.js'
import {
  _resetForTesting as resetAutoModeState,
  setAutoModeActive,
} from '../../../src/utils/permissions/autoModeState.js'

/**
 * CC 2.1.218 #27: auto mode — dangerous-rm and background-& patterns are
 * auto-decided (denied) in the permission flow BEFORE the (stubbed,
 * ant-only) classifier is consulted, so they no longer open a dialog in
 * external builds.
 *
 * Binary evidence (CC 2.1.218 ELF strings at /tmp/ccgap17_3020503/s21218.txt):
 *   - `background_amp` compound type: `/(^|[^&])&\s*$/m`
 *   - `dangerousPatterns` function name in the official binary
 *
 * These tests call the REAL hasPermissionsToUseTool with mode='auto' and a
 * bash tool whose checkPermissions returns 'ask' (so the auto-mode branch is
 * entered). They assert the dangerous patterns are auto-DENIED (not 'ask' /
 * dialog) and that an auto-mode denial is recorded — WITHOUT the classifier.
 */

function createBashTool(): Tool {
  // checkPermissions returns 'ask' in any mode so the auto-mode branch fires.
  // In acceptEdits mode it ALSO returns 'ask' so the acceptEdits fast-path
  // does NOT short-circuit dangerous patterns before the auto-deny check.
  return {
    name: 'Bash',
    userFacingName: () => 'Bash',
    inputSchema: {
      parse: (i: unknown) => i,
      safeParse: (i: unknown) => ({ success: true, data: i }),
    },
    checkPermissions: async () => ({
      behavior: 'ask' as const,
      message: 'Bash command requires approval',
    }),
    description: async () => 'Bash',
    isMcp: false,
  } as unknown as Tool
}

function createContext(mode: string = 'auto'): ToolUseContext {
  return {
    abortController: { signal: { aborted: false } },
    getAppState: () => ({
      toolPermissionContext: {
        mode,
        shouldAvoidPermissionPrompts: false,
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
      },
      denialTracking: undefined,
    }),
    setAppState: (_fn: (prev: unknown) => unknown) => {},
    options: { isNonInteractiveSession: false, tools: [] },
    localDenialTracking: undefined,
  } as unknown as ToolUseContext
}

function createAssistantMessage(): AssistantMessage {
  return { message: { id: 'test-msg-id', content: [] } } as unknown as AssistantMessage
}

describe('CC 2.1.218 #27: shouldAutoDenyInAutoMode wired into permission flow', () => {
  beforeEach(() => {
    _resetDenialsForTesting()
    resetAutoModeState()
    setAutoModeActive(true)
  })

  test('dangerous `rm -rf /` in auto mode → auto-DENY (no dialog, no classifier)', async () => {
    const { hasPermissionsToUseTool } = await import(
      '../../../src/utils/permissions/permissions.js'
    )
    const tool = createBashTool()
    const ctx = createContext('auto')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'rm -rf /' },
      ctx,
      msg,
      'deny-rm-1',
    )

    // Assert: denied, NOT ask (dialog), NOT allow
    expect(result.behavior).toBe('deny')
    expect(result.behavior).not.toBe('ask')
    expect(result.behavior).not.toBe('allow')

    // Assert: an auto-mode denial was recorded
    const denials = getAutoModeDenials()
    expect(denials.length).toBeGreaterThan(0)
    expect(denials[0].toolName).toBe('Bash')
    expect(denials[0].reason).toContain('dangerous rm')
  })

  test('dangerous `rm -rf $HOME` in auto mode → auto-DENY', async () => {
    const { hasPermissionsToUseTool } = await import(
      '../../../src/utils/permissions/permissions.js'
    )
    const tool = createBashTool()
    const ctx = createContext('auto')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'rm -rf $HOME' },
      ctx,
      msg,
      'deny-rm-2',
    )

    expect(result.behavior).toBe('deny')
    const denials = getAutoModeDenials()
    expect(denials.length).toBeGreaterThan(0)
  })

  test('trailing background `&` (sleep 100 &) in auto mode → auto-DENY', async () => {
    const { hasPermissionsToUseTool } = await import(
      '../../../src/utils/permissions/permissions.js'
    )
    const tool = createBashTool()
    const ctx = createContext('auto')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'sleep 100 &' },
      ctx,
      msg,
      'deny-bg-1',
    )

    expect(result.behavior).toBe('deny')
    expect(result.behavior).not.toBe('ask')
    const denials = getAutoModeDenials()
    expect(denials.length).toBeGreaterThan(0)
    expect(denials[0].reason).toContain('background &')
  })

  test('`&&` compound is NOT auto-denied (background-& is trailing single &)', async () => {
    const { hasPermissionsToUseTool } = await import(
      '../../../src/utils/permissions/permissions.js'
    )
    const tool = createBashTool()
    const ctx = createContext('auto')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'echo hello && echo world' },
      ctx,
      msg,
      'no-deny-ampamp',
    )

    // && is NOT a background-& pattern → not auto-denied by this guard.
    // It proceeds to the stubbed classifier which fail-opens → ask (dialog).
    expect(result.behavior).not.toBe('deny')
  })

  test('safe `ls -la` in auto mode → NOT auto-denied (reaches classifier fail-open)', async () => {
    const { hasPermissionsToUseTool } = await import(
      '../../../src/utils/permissions/permissions.js'
    )
    const tool = createBashTool()
    const ctx = createContext('auto')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'ls -la' },
      ctx,
      msg,
      'safe-ls',
    )

    // Safe command is not matched by dangerous-rm or background-&.
    // No auto-deny recorded.
    expect(getAutoModeDenials().length).toBe(0)
    // With the stubbed classifier, it fail-opens to ask (dialog) — this is
    // the ant-only-classifier-stub limitation, reported honestly.
    expect(result.behavior).not.toBe('deny')
  })
})
