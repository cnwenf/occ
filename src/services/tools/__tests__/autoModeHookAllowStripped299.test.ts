import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { AssistantMessage, Tool, ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { PermissionResult } from '../../types/permissions.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'

// The permission path reads MACRO.VERSION (via getBundledSkillsRoot) at runtime.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// Capture telemetry so the official event name is pinned.
const actualAnalyticsModule = await import('../../analytics/index.js')
const capturedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []

mock.module('../../analytics/index.js', () => ({
  ...actualAnalyticsModule,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    capturedEvents.push({ name, metadata })
  },
}))

afterAll(() => {
  mock.module('../../analytics/index.js', () => ({
    ...actualAnalyticsModule,
  }))
})

const { resolveHookPermissionDecision } = await import('../toolHooks.js')

/**
 * CC 2.1.299 #122 (security): plan/auto mode must strip a PreToolUse hook's
 * permissionDecision:"allow" — official `Mur` (exported as
 * `stripConfinedHookApproval`) @226848501 in the v299 ELF (byte-verified):
 *
 *   reason:  `while auto mode is on (also behind plan mode) a hook cannot approve ${tool}`
 *   debug:   `${name} permissionDecision=allow ignored: ${reason}`
 *   strip:   `if(e.permissionBehavior==="allow") … e.permissionBehavior=void 0`
 *            and `if(e.permissionRequestResult?.behavior==="allow") …
 *            e.permissionRequestResult=void 0`
 *   telemetry: `i("tengu_auto_mode_permission_request_allow_ignored",{})`
 *            (0 hits in the 2.1.296 strings dump — new in 299)
 *
 * Only 'allow' is stripped; deny/ask pass through. Pre-fix, OCC's
 * resolveHookPermissionDecision honored a hook allow whenever
 * checkRuleBasedPermissions returned null — so a hook could silently execute
 * writes IN PLAN MODE (the plan_mode_floor only guards the classifier-allow
 * path, never the hook-allow path).
 */

// ── helpers ──

function makeTool(): Tool {
  return {
    name: 'Write',
    userFacingName: () => 'Write',
    inputSchema: {
      parse: (input: unknown) => input,
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    // passthrough + empty rule sets → checkRuleBasedPermissions returns null
    checkPermissions: async () => ({ behavior: 'passthrough', message: '' }),
    description: async () => 'Write',
    requiresUserInteraction: undefined,
    isMcp: false,
  } as unknown as Tool
}

function makeContext(mode = 'default'): ToolUseContext {
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
    }),
    options: { isNonInteractiveSession: false, tools: [] },
  } as unknown as ToolUseContext
}

function makeMsg(): AssistantMessage {
  return { message: { id: 'm', content: [] } } as unknown as AssistantMessage
}

function makeCanUseToolMock(): ReturnType<typeof mock<CanUseToolFn>> {
  return mock<CanUseToolFn>(
    async (
      _tool: Tool,
      _input: Record<string, unknown>,
      _ctx: ToolUseContext,
      _msg: AssistantMessage,
      _id: string,
      forceDecision?: PermissionDecision,
    ): Promise<PermissionDecision> => {
      // Mirror the full pipeline: a stripped allow re-enters the normal flow
      // and (in plan/auto mode) floors at a prompt instead of allowing.
      if (forceDecision) return forceDecision
      return { behavior: 'ask' as const, message: 'prompt the user' }
    },
  )
}

function hookAllow(updatedInput?: Record<string, unknown>): PermissionResult {
  return {
    behavior: 'allow',
    updatedInput,
    decisionReason: {
      type: 'hook',
      hookName: 'PreToolUse:Write',
      reason: undefined,
    },
  } as unknown as PermissionResult
}

// ── tests ──

describe('2.1.299 #122 — plan/auto mode strips hook allow', () => {
  test('plan mode + hook allow → NOT honored, falls through to the pipeline', async () => {
    const canUseToolMock = makeCanUseToolMock()
    const { decision } = await resolveHookPermissionDecision(
      hookAllow(),
      makeTool(),
      { file_path: '/tmp/x', content: 'pwn' },
      makeContext('plan'),
      canUseToolMock,
      makeMsg(),
      'tool-use-1',
    )
    // Pre-fix: rule check null → hook allow stood → behavior 'allow',
    // canUseTool NEVER called (silent write in plan mode).
    expect(canUseToolMock).toHaveBeenCalledTimes(1)
    expect(decision.behavior).toBe('ask')
    expect(decision.behavior).not.toBe('allow')
  })

  test('auto mode + hook allow → NOT honored, falls through to the pipeline', async () => {
    const canUseToolMock = makeCanUseToolMock()
    const { decision } = await resolveHookPermissionDecision(
      hookAllow(),
      makeTool(),
      { file_path: '/tmp/x', content: 'pwn' },
      makeContext('auto'),
      canUseToolMock,
      makeMsg(),
      'tool-use-2',
    )
    expect(canUseToolMock).toHaveBeenCalledTimes(1)
    expect(decision.behavior).toBe('ask')
    expect(decision.behavior).not.toBe('allow')
  })

  test('plan mode strip emits the official telemetry event name', async () => {
    capturedEvents.length = 0
    await resolveHookPermissionDecision(
      hookAllow(),
      makeTool(),
      { file_path: '/tmp/x' },
      makeContext('plan'),
      makeCanUseToolMock(),
      makeMsg(),
      'tool-use-3',
    )
    expect(
      capturedEvents.some(
        e => e.name === 'tengu_auto_mode_permission_request_allow_ignored',
      ),
    ).toBe(true)
  })

  test('default mode strip does NOT emit the telemetry event', async () => {
    capturedEvents.length = 0
    await resolveHookPermissionDecision(
      hookAllow(),
      makeTool(),
      { file_path: '/tmp/x' },
      makeContext('default'),
      makeCanUseToolMock(),
      makeMsg(),
      'tool-use-4',
    )
    expect(
      capturedEvents.some(
        e => e.name === 'tengu_auto_mode_permission_request_allow_ignored',
      ),
    ).toBe(false)
  })

  test('default mode + hook allow → still honored (regression)', async () => {
    const canUseToolMock = makeCanUseToolMock()
    const { decision } = await resolveHookPermissionDecision(
      hookAllow(),
      makeTool(),
      { file_path: '/tmp/x', content: 'ok' },
      makeContext('default'),
      canUseToolMock,
      makeMsg(),
      'tool-use-5',
    )
    // Rule check null → hook allow stands, no pipeline round-trip.
    expect(decision.behavior).toBe('allow')
    expect(canUseToolMock).not.toHaveBeenCalled()
  })

  test('plan mode + hook allow with updatedInput → input survives the strip', async () => {
    const updated = { file_path: '/tmp/x', content: 'hook-rewritten' }
    const { input } = await resolveHookPermissionDecision(
      hookAllow(updated),
      makeTool(),
      { file_path: '/tmp/x', content: 'original' },
      makeContext('plan'),
      makeCanUseToolMock(),
      makeMsg(),
      'tool-use-6',
    )
    expect(input).toEqual(updated)
  })

  test('plan mode + hook deny → deny still honored (only allow is stripped)', async () => {
    const canUseToolMock = makeCanUseToolMock()
    const deny = {
      behavior: 'deny',
      message: 'hook says no',
    } as PermissionResult
    const { decision } = await resolveHookPermissionDecision(
      deny,
      makeTool(),
      { file_path: '/tmp/x' },
      makeContext('plan'),
      canUseToolMock,
      makeMsg(),
      'tool-use-7',
    )
    expect(decision.behavior).toBe('deny')
    expect(canUseToolMock).not.toHaveBeenCalled()
  })

  test('auto mode + hook ask → ask passes through to the dialog (not stripped)', async () => {
    capturedEvents.length = 0
    const canUseToolMock = makeCanUseToolMock()
    const ask = {
      behavior: 'ask',
      message: 'hook wants a prompt',
    } as PermissionResult
    const { decision } = await resolveHookPermissionDecision(
      ask,
      makeTool(),
      { file_path: '/tmp/x' },
      makeContext('auto'),
      canUseToolMock,
      makeMsg(),
      'tool-use-8',
    )
    expect(decision.behavior).toBe('ask')
    // The ask forceDecision path — NOT the strip path: canUseTool receives
    // the hook result as forceDecision and no strip telemetry is emitted.
    expect(canUseToolMock).toHaveBeenCalledTimes(1)
    expect(canUseToolMock.mock.calls[0]?.[5]).toBe(ask)
    expect(
      capturedEvents.some(
        e => e.name === 'tengu_auto_mode_permission_request_allow_ignored',
      ),
    ).toBe(false)
  })

  test('plan mode + no hook decision → normal pipeline (unchanged)', async () => {
    const canUseToolMock = makeCanUseToolMock()
    const { decision } = await resolveHookPermissionDecision(
      undefined,
      makeTool(),
      { file_path: '/tmp/x' },
      makeContext('plan'),
      canUseToolMock,
      makeMsg(),
      'tool-use-9',
    )
    expect(decision.behavior).toBe('ask')
    expect(canUseToolMock).toHaveBeenCalledTimes(1)
  })
})
