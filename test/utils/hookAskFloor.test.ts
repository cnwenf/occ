import { describe, expect, test, mock } from 'bun:test'
import type { PermissionDecision } from '../../src/utils/permissions/PermissionResult.js'
import type { PermissionResult } from '../../src/types/permissions.js'
import type { Tool, ToolUseContext, AssistantMessage } from '../../src/Tool.js'
import type { CanUseToolFn } from '../../src/hooks/useCanUseTool.js'

/**
 * Tests for the CC 2.1.211 "auto mode overriding PreToolUse hook ask" fix.
 *
 * The fix ports the upstream hookAskFloor logic:
 * - When a PreToolUse hook returns `ask` and rules also require `ask`,
 *   `resolveHookPermissionDecision` passes `hookAskFloor: true` to canUseTool
 *   (instead of forceDecision). This causes hasPermissionsToUseTool to
 *   floor the decision at "prompt the user" — auto mode's classifier
 *   cannot override the hook's ask with an allow.
 *
 * Binary recon evidence:
 *   - `hookAskFloor` appears 0x in CC 2.1.210 binary, 3x in 2.1.211
 *   - `function xOg(){return!1}` — the y-check is a stub returning false
 *   - In resolveHookPermissionDecision: `d?{...n,hookAskFloor:!0}:n`
 *   - In hasPermissionsToUseTool: `_=r.hookAskFloor===!0` → floors at ask
 */

// -- Mock helpers --

/**
 * Creates a mock tool. When `checkPermissionsReturnsAsk` is true,
 * the tool's checkPermissions returns an ask safetyCheck, which
 * causes checkRuleBasedPermissions to return ask (triggering the
 * hookAskFloor path when the hook also returned ask).
 */
function createMockTool(
  name: string = 'Bash',
  checkPermissionsReturnsAsk: boolean = false,
): Tool {
  return {
    name,
    userFacingName: () => name,
    inputSchema: {
      parse: (input: unknown) => input,
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    checkPermissions: async () =>
      checkPermissionsReturnsAsk
        ? {
            behavior: 'ask' as const,
            decisionReason: {
              type: 'safetyCheck' as const,
              classifierApprovable: false,
            },
            message: 'Safety check requires approval',
          }
        : ({ behavior: 'passthrough' as const } as any),
    description: async () => name,
    requiresUserInteraction: undefined,
    isMcp: false,
    inputsEquivalent: undefined,
  } as unknown as Tool
}

function createMockToolUseContext(
  mode: string = 'auto',
  shouldAvoidPermissionPrompts: boolean = false,
): ToolUseContext {
  return {
    getAbortController: () => ({ signal: { aborted: false } }),
    abortController: { signal: { aborted: false } },
    getAppState: () => ({
      toolPermissionContext: {
        mode,
        shouldAvoidPermissionPrompts,
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
      },
    }),
    options: {
      isNonInteractiveSession: false,
      tools: [],
    },
  } as unknown as ToolUseContext
}

function createMockAssistantMessage(): AssistantMessage {
  return {
    message: { id: 'test-msg-id', content: [] },
  } as unknown as AssistantMessage
}

/**
 * Mock canUseTool that simulates useCanUseTool + hasPermissionsToUseTool:
 * - forceDecision set → return it directly (skips classifier)
 * - hookAskFloor set + interactive → return ask (floor at prompt)
 * - hookAskFloor set + headless → return deny
 * - neither → return allow (auto-mode classifier allows — old behavior)
 */
function createCanUseToolMock(): ReturnType<typeof mock<CanUseToolFn>> {
  return mock<CanUseToolFn>(
    async (
      _tool: Tool,
      _input: Record<string, unknown>,
      _ctx: ToolUseContext,
      _msg: AssistantMessage,
      _id: string,
      forceDecision?: PermissionDecision,
      hookAskFloor?: boolean,
    ): Promise<PermissionDecision> => {
      if (forceDecision) {
        return forceDecision
      }
      if (hookAskFloor) {
        const shouldAvoid = _ctx.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts
        if (shouldAvoid) {
          return {
            behavior: 'deny' as const,
            message: 'Hook ask requires interactive approval',
            decisionReason: {
              type: 'asyncAgent' as const,
              reason: 'Permission prompts are not available in this context',
            },
          }
        }
        return { behavior: 'ask' as const, message: 'Hook asks — floored at prompt' }
      }
      return { behavior: 'allow' as const, updatedInput: _input }
    },
  )
}

// -- Tests for resolveHookPermissionDecision --

describe('resolveHookPermissionDecision — hookAskFloor (CC 2.1.211)', () => {
  test('hook ask + rule ask → canUseTool called with hookAskFloor=true, no forceDecision', async () => {
    // Arrange: tool's checkPermissions returns ask (safety check),
    // so checkRuleBasedPermissions returns ask.
    const canUseToolMock = createCanUseToolMock()

    const { resolveHookPermissionDecision } = await import(
      '../../src/services/tools/toolHooks.js'
    )

    const tool = createMockTool('Bash', true) // checkPermissions returns ask
    const input = { command: 'rm -rf /' }
    const ctx = createMockToolUseContext('auto')
    const msg = createMockAssistantMessage()

    const hookPermissionResult: PermissionResult = {
      behavior: 'ask',
      message: 'Hook asks for confirmation',
    }

    // Act
    await resolveHookPermissionDecision(
      hookPermissionResult,
      tool,
      input,
      ctx,
      canUseToolMock,
      msg,
      'tool-use-id-1',
    )

    // Assert
    const call = canUseToolMock.mock.calls[0]
    expect(call).toBeDefined()
    expect(call![5]).toBeUndefined() // no forceDecision
    expect(call![6]).toBe(true) // hookAskFloor = true
  })

  test('hook ask + rule pass → canUseTool called with forceDecision, no hookAskFloor', async () => {
    // Arrange: tool's checkPermissions returns passthrough (no rule objection),
    // so checkRuleBasedPermissions returns null.
    const canUseToolMock = createCanUseToolMock()

    const { resolveHookPermissionDecision } = await import(
      '../../src/services/tools/toolHooks.js'
    )

    const tool = createMockTool('Bash', false) // checkPermissions returns passthrough
    const input = { command: 'echo hello' }
    const ctx = createMockToolUseContext('default')
    const msg = createMockAssistantMessage()

    const hookPermissionResult: PermissionResult = {
      behavior: 'ask',
      message: 'Hook asks for confirmation',
    }

    // Act
    await resolveHookPermissionDecision(
      hookPermissionResult,
      tool,
      input,
      ctx,
      canUseToolMock,
      msg,
      'tool-use-id-2',
    )

    // Assert
    const call = canUseToolMock.mock.calls[0]
    expect(call).toBeDefined()
    expect(call![5]).toEqual(hookPermissionResult) // forceDecision = hook's ask
    expect(call![6]).toBeFalsy() // no hookAskFloor
  })

  test('hook allow + rule ask → canUseTool called without hookAskFloor and without forceDecision', async () => {
    // Arrange: tool's checkPermissions returns ask, but hook returned allow
    const canUseToolMock = createCanUseToolMock()

    const { resolveHookPermissionDecision } = await import(
      '../../src/services/tools/toolHooks.js'
    )

    const tool = createMockTool('Bash', true) // checkPermissions returns ask
    const input = { command: 'rm -rf /' }
    const ctx = createMockToolUseContext('auto')
    const msg = createMockAssistantMessage()

    const hookPermissionResult: PermissionResult = {
      behavior: 'allow',
      updatedInput: input,
    }

    // Act
    await resolveHookPermissionDecision(
      hookPermissionResult,
      tool,
      input,
      ctx,
      canUseToolMock,
      msg,
      'tool-use-id-3',
    )

    // Assert
    const call = canUseToolMock.mock.calls[0]
    expect(call).toBeDefined()
    expect(call![5]).toBeUndefined() // no forceDecision
    expect(call![6]).toBeFalsy() // no hookAskFloor (hook returned allow, not ask)
  })

  test('hook deny → returns deny directly, canUseTool not called', async () => {
    const canUseToolMock = createCanUseToolMock()

    const { resolveHookPermissionDecision } = await import(
      '../../src/services/tools/toolHooks.js'
    )

    const tool = createMockTool('Bash', false)
    const input = { command: 'echo hello' }
    const ctx = createMockToolUseContext('auto')
    const msg = createMockAssistantMessage()

    const hookPermissionResult: PermissionResult = {
      behavior: 'deny',
      message: 'Hook denied',
    }

    // Act
    const result = await resolveHookPermissionDecision(
      hookPermissionResult,
      tool,
      input,
      ctx,
      canUseToolMock,
      msg,
      'tool-use-id-4',
    )

    // Assert
    expect(result.decision.behavior).toBe('deny')
    expect(canUseToolMock).toHaveBeenCalledTimes(0)
  })

  test('no hook decision → canUseTool called without forceDecision or hookAskFloor', async () => {
    const canUseToolMock = createCanUseToolMock()

    const { resolveHookPermissionDecision } = await import(
      '../../src/services/tools/toolHooks.js'
    )

    const tool = createMockTool('Bash', false)
    const input = { command: 'echo hello' }
    const ctx = createMockToolUseContext('auto')
    const msg = createMockAssistantMessage()

    // Act — no hook decision (undefined)
    await resolveHookPermissionDecision(
      undefined,
      tool,
      input,
      ctx,
      canUseToolMock,
      msg,
      'tool-use-id-5',
    )

    // Assert
    const call = canUseToolMock.mock.calls[0]
    expect(call).toBeDefined()
    expect(call![5]).toBeUndefined()
    expect(call![6]).toBeFalsy()
  })
})

// -- Tests for the full hookAskFloor behavioral contract --

describe('hookAskFloor behavioral contract (CC 2.1.211)', () => {
  // These tests verify the end-to-end behavior: when a PreToolUse hook
  // returns `ask` and rules also require `ask`, the auto-mode classifier
  // must NOT override the ask. The user must be prompted.

  test('hook ask + rule ask in auto mode → decision is ask (NOT auto-allow)', async () => {
    // Arrange: tool's checkPermissions returns ask (rule ask path)
    const canUseToolMock = createCanUseToolMock()

    const { resolveHookPermissionDecision } = await import(
      '../../src/services/tools/toolHooks.js'
    )

    const tool = createMockTool('Bash', true)
    const input = { command: 'rm -rf /' }
    const ctx = createMockToolUseContext('auto')
    const msg = createMockAssistantMessage()

    const hookPermissionResult: PermissionResult = {
      behavior: 'ask',
      message: 'Hook asks for confirmation',
    }

    // Act
    const result = await resolveHookPermissionDecision(
      hookPermissionResult,
      tool,
      input,
      ctx,
      canUseToolMock,
      msg,
      'tool-use-id-6',
    )

    // Assert: decision should be ask (prompt), NOT allow
    expect(result.decision.behavior).toBe('ask')
    expect(result.decision.behavior).not.toBe('allow')
  })

  test('hook ask + rule ask in headless mode → decision is deny (cannot prompt)', async () => {
    // Arrange: headless mode (shouldAvoidPermissionPrompts = true)
    const canUseToolMock = createCanUseToolMock()

    const { resolveHookPermissionDecision } = await import(
      '../../src/services/tools/toolHooks.js'
    )

    const tool = createMockTool('Bash', true)
    const input = { command: 'rm -rf /' }
    const ctx = createMockToolUseContext('auto', true) // headless
    const msg = createMockAssistantMessage()

    const hookPermissionResult: PermissionResult = {
      behavior: 'ask',
      message: 'Hook asks for confirmation',
    }

    // Act
    const result = await resolveHookPermissionDecision(
      hookPermissionResult,
      tool,
      input,
      ctx,
      canUseToolMock,
      msg,
      'tool-use-id-7',
    )

    // Assert: should deny in headless mode (can't prompt)
    expect(result.decision.behavior).toBe('deny')
  })

  test('hook allow + rule ask in auto mode → auto mode CAN still override to allow', async () => {
    // Arrange: hook returned allow (not ask), so hookAskFloor is NOT set.
    // Auto mode classifier can still allow.
    const canUseToolMock = createCanUseToolMock()

    const { resolveHookPermissionDecision } = await import(
      '../../src/services/tools/toolHooks.js'
    )

    const tool = createMockTool('Bash', true)
    const input = { command: 'rm -rf /' }
    const ctx = createMockToolUseContext('auto')
    const msg = createMockAssistantMessage()

    const hookPermissionResult: PermissionResult = {
      behavior: 'allow',
      updatedInput: input,
    }

    // Act
    const result = await resolveHookPermissionDecision(
      hookPermissionResult,
      tool,
      input,
      ctx,
      canUseToolMock,
      msg,
      'tool-use-id-8',
    )

    // Assert: auto mode can still allow (no hookAskFloor protection for hook-allow)
    expect(result.decision.behavior).toBe('allow')
  })
})

// -- REAL-decision tests: exercise the actual hasPermissionsToUseTool --
// These tests call the REAL hasPermissionsToUseTool (not a mock) to verify
// the hookAskFloor guard actually fires in the auto-mode block.

describe('hasPermissionsToUseTool REAL decision code — hookAskFloor guard', () => {
  // This test calls the actual hasPermissionsToUseTool function with
  // hookAskFloor=true. The tool is set up so that:
  // 1. hasPermissionsToUseToolInner returns {behavior:'ask'} (safety check, classifierApprovable)
  // 2. The auto-mode block is entered (mode='auto')
  // 3. The safety check guard is skipped (classifierApprovable=true)
  // 4. The acceptEdits fast-path WOULD return allow (tool returns allow in acceptEdits mode)
  //
  // WITHOUT the fix: hookAskFloor lands in the wrong param slot (6th=_forceDecision,
  // not 7th=hookAskFloor), so the guard never fires → acceptEdits fast-path
  // returns allow (THE BUG).
  //
  // WITH the fix: hookAskFloor is the 6th param, the guard fires → returns ask.

  test('hookAskFloor=true in auto mode → REAL hasPermissionsToUseTool returns ask (NOT allow)', async () => {
    const { hasPermissionsToUseTool } = await import(
      '../../src/utils/permissions/permissions.js'
    )

    // Mock tool: returns ask in auto mode, allow in acceptEdits mode
    const tool = {
      name: 'Bash',
      userFacingName: () => 'Bash',
      inputSchema: {
        parse: (i: unknown) => i,
        safeParse: (i: unknown) => ({ success: true, data: i }),
      },
      checkPermissions: async (_input: unknown, ctx: { getAppState: () => { toolPermissionContext: { mode: string } } }) => {
        const mode = ctx.getAppState().toolPermissionContext.mode
        if (mode === 'acceptEdits') {
          return { behavior: 'allow' as const }
        }
        return {
          behavior: 'ask' as const,
          decisionReason: {
            type: 'safetyCheck' as const,
            classifierApprovable: true,
          },
          message: 'Safety check requires approval',
        }
      },
      description: async () => 'Bash',
      isMcp: false,
    } as unknown as Tool

    const ctx = {
      abortController: { signal: { aborted: false } },
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'auto',
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

    const msg = createMockAssistantMessage()

    // Act: call the REAL hasPermissionsToUseTool with hookAskFloor=true
    // The 6th arg is hookAskFloor (after the fix) or _forceDecision (before the fix)
    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'rm -rf /' },
      ctx,
      msg,
      'real-test-1',
      true, // hookAskFloor=true — should floor at ask
    )

    // Assert: with the fix, this should be 'ask' (floored at prompt)
    // Without the fix, this would be 'allow' (acceptEdits fast-path overrides)
    expect(result.behavior).toBe('ask')
    expect(result.behavior).not.toBe('allow')
  })

  test('hookAskFloor=true in headless auto mode → REAL hasPermissionsToUseTool returns deny', async () => {
    const { hasPermissionsToUseTool } = await import(
      '../../src/utils/permissions/permissions.js'
    )

    const tool = {
      name: 'Bash',
      userFacingName: () => 'Bash',
      inputSchema: {
        parse: (i: unknown) => i,
        safeParse: (i: unknown) => ({ success: true, data: i }),
      },
      checkPermissions: async (_input: unknown, ctx: { getAppState: () => { toolPermissionContext: { mode: string } } }) => {
        const mode = ctx.getAppState().toolPermissionContext.mode
        if (mode === 'acceptEdits') {
          return { behavior: 'allow' as const }
        }
        return {
          behavior: 'ask' as const,
          decisionReason: {
            type: 'safetyCheck' as const,
            classifierApprovable: true,
          },
          message: 'Safety check requires approval',
        }
      },
      description: async () => 'Bash',
      isMcp: false,
    } as unknown as Tool

    const ctx = {
      abortController: { signal: { aborted: false } },
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'auto',
          shouldAvoidPermissionPrompts: true, // headless
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

    const msg = createMockAssistantMessage()

    // Act: call REAL hasPermissionsToUseTool with hookAskFloor=true in headless
    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'rm -rf /' },
      ctx,
      msg,
      'real-test-2',
      true, // hookAskFloor=true — should deny in headless
    )

    // Assert: with the fix, headless + hookAskFloor → deny
    // Without the fix, this would be 'allow' (acceptEdits fast-path overrides)
    expect(result.behavior).toBe('deny')
    expect(result.behavior).not.toBe('allow')
  })
})
