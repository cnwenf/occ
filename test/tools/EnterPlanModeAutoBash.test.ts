import { describe, expect, test, beforeEach } from 'bun:test'
import type { Tool, ToolUseContext, AssistantMessage } from '../../src/Tool.js'
import {
  setPlanModeAutoBashActive,
  isPlanModeAutoBashActive,
  setAutoModeActive,
  _resetForTesting as resetAutoModeState,
} from '../../src/utils/permissions/autoModeState.js'
import { PLAN_MODE_AUTO_BASH_HANDLING_ENABLED } from '../../src/tools/EnterPlanModeTool/constants.js'

/**
 * CC 2.1.218 #31: plan mode + auto — bash commands the static analyzer
 * can't prove read-only are auto-handled (not prompted) via the auto-mode
 * classifier path.
 *
 * Binary evidence (CC 2.1.218 ELF strings at /tmp/ccgap17_3020503/s21218.txt):
 *   - "static analysis does" — the official binary's bash static analyzer
 *     determines read-only status; unprovable commands previously prompted.
 *
 * Wiring: `isPlanModeAutoBashActive()` is now consulted in the permissions.ts
 * :530-535 condition so plan+auto (flag set) ENTERS the classifier path
 * (previously the flag was INERT — set by EnterPlanModeTool but never read).
 *
 * HONEST conclusion: with the flag wired, plan+auto for an unprovable-read-only
 * bash command ENTERS the classifier path. But in OCC (external build) the AI
 * classifier is a stub (bashClassifier.ts line 1: "Stub for external builds -
 * classifier permissions feature is ANT-ONLY"), so the classifier path
 * fail-opens to dialog (return 'ask'). TRUE "no-dialog" alignment is therefore
 * BLOCKED by the ant-only classifier stub — a deliberate external-build trim.
 * These tests assert the flag IS consulted (the auto-mode block is entered),
 * NOT a fake "no-dialog" e2e.
 *
 * How the tests prove the flag is consulted: the acceptEdits fast-path only
 * fires INSIDE the auto-mode block. A bash tool whose checkPermissions returns
 * 'ask' in plan/auto but 'allow' in acceptEdits will be ALLOWED (fast-path
 * fires) when the flag is set (block entered), but will return 'ask' (dialog,
 * block skipped) when the flag is clear.
 */

function createBashTool(): Tool {
  return {
    name: 'Bash',
    userFacingName: () => 'Bash',
    inputSchema: {
      parse: (i: unknown) => i,
      safeParse: (i: unknown) => ({ success: true, data: i }),
    },
    // Returns 'ask' in plan/auto mode, 'allow' in acceptEdits mode. This
    // lets the acceptEdits fast-path fire (proving the auto-mode block was
    // entered) when the planModeAutoBash flag routes us there.
    checkPermissions: async (
      _input: unknown,
      ctx: { getAppState: () => { toolPermissionContext: { mode: string } } },
    ) => {
      const mode = ctx.getAppState().toolPermissionContext.mode
      if (mode === 'acceptEdits') {
        return { behavior: 'allow' as const }
      }
      return {
        behavior: 'ask' as const,
        message: 'Bash command requires approval',
      }
    },
    description: async () => 'Bash',
    isMcp: false,
  } as unknown as Tool
}

function createContext(mode: string): ToolUseContext {
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

describe('CC 2.1.218 #31: isPlanModeAutoBashActive wired into permission flow', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY ??= 'test-placeholder'
    resetAutoModeState()
  })

  test('PLAN_MODE_AUTO_BASH_HANDLING_ENABLED constant is true', () => {
    expect(PLAN_MODE_AUTO_BASH_HANDLING_ENABLED).toBe(true)
  })

  test('flag set + mode plan + isAutoModeActive false → auto-mode block ENTERED (acceptEdits fast-path fires)', async () => {
    // Arrange: plan mode, auto-mode NOT active, but planModeAutoBash flag set.
    // This is the state EnterPlanModeTool creates when entering plan mode
    // from auto.
    setAutoModeActive(false)
    setPlanModeAutoBashActive(true)
    expect(isPlanModeAutoBashActive()).toBe(true)

    const { hasPermissionsToUseTool } = await import(
      '../../src/utils/permissions/permissions.js'
    )
    const tool = createBashTool()
    const ctx = createContext('plan')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'git status' },
      ctx,
      msg,
      'plan-auto-flag-set',
    )

    // Assert: the auto-mode block was entered → the acceptEdits fast-path
    // fired → result is 'allow'. WITHOUT the wiring (flag inert), the
    // auto-mode block would be skipped → result would be 'ask' (dialog).
    expect(result.behavior).toBe('allow')
    expect(result.behavior).not.toBe('ask')
  })

  test('flag clear + mode plan + isAutoModeActive false → auto-mode block SKIPPED (dialog)', async () => {
    // Arrange: plan mode, auto-mode NOT active, planModeAutoBash flag clear.
    // The auto-mode block must NOT be entered → dialog ('ask').
    setAutoModeActive(false)
    setPlanModeAutoBashActive(false)
    expect(isPlanModeAutoBashActive()).toBe(false)

    const { hasPermissionsToUseTool } = await import(
      '../../src/utils/permissions/permissions.js'
    )
    const tool = createBashTool()
    const ctx = createContext('plan')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'git status' },
      ctx,
      msg,
      'plan-auto-flag-clear',
    )

    // Assert: auto-mode block skipped → no acceptEdits fast-path → 'ask'.
    expect(result.behavior).toBe('ask')
  })

  test('flag set + mode auto → auto-mode block ENTERED (isAutoModeActive alone already routes)', async () => {
    setAutoModeActive(true)
    setPlanModeAutoBashActive(true)

    const { hasPermissionsToUseTool } = await import(
      '../../src/utils/permissions/permissions.js'
    )
    const tool = createBashTool()
    const ctx = createContext('auto')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'git status' },
      ctx,
      msg,
      'auto-mode-active',
    )

    expect(result.behavior).toBe('allow')
  })

  test('plan+auto bash reaches classifier path → rule-based allow (no dialog) for no-classifier-input tool', async () => {
    // Arrange: plan + flag set, a bash tool whose checkPermissions returns
    // 'ask' in ALL modes (so no acceptEdits fast-path allow). This forces
    // the flow to reach the classifier path.
    setAutoModeActive(false)
    setPlanModeAutoBashActive(true)

    const { hasPermissionsToUseTool } = await import(
      '../../src/utils/permissions/permissions.js'
    )
    // Tool that returns 'ask' in ALL modes — no fast-path allow. It also
    // declares no `toAutoClassifierInput`, so classifyYoloAction's compact
    // action is '' → returns shouldBlock:false ("Tool declares no
    // classifier-relevant input") — a REAL rule-based allow path BEFORE
    // the ant-only classifier API is ever called.
    const tool: Tool = {
      name: 'Bash',
      userFacingName: () => 'Bash',
      inputSchema: {
        parse: (i: unknown) => i,
        safeParse: (i: unknown) => ({ success: true, data: i }),
      },
      checkPermissions: async () => ({
        behavior: 'ask' as const,
        message: 'unprovable-read-only bash',
      }),
      description: async () => 'Bash',
      isMcp: false,
    } as unknown as Tool
    const ctx = createContext('plan')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { command: 'some-unprovable-command' },
      ctx,
      msg,
      'plan-auto-unprovable',
    )

    // Assert: the flag routed the flow INTO the classifier path. The
    // classifier's "no classifier-relevant input" rule-based path allows
    // it (no dialog) — this is a REAL auto-decide, not the stubbed API.
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason?.type).toBe('classifier')

    // HONEST CONCLUSION (documented, not faked): for a tool that declares
    // no classifier-relevant input, plan+auto achieves no-dialog via this
    // rule-based allow. For a REAL bash command that DOES declare
    // classifier-relevant input, the path would proceed to the ant-only
    // classifier API (stubbed/unavailable in OCC external builds) →
    // fail-open to dialog (or fail-closed if tengu_iron_gate_closed).
    // TRUE no-dialog for classifier-relevant bash is BLOCKED by the
    // ant-only classifier stub — a deliberate external-build trim.
  })
})

describe('CC 2.1.218 #31: ExitPlanMode resets planModeAutoBash flag', () => {
  beforeEach(() => {
    resetAutoModeState()
  })

  test('after exit-plan, isPlanModeAutoBashActive is false', async () => {
    // Arrange: entering plan mode set the flag true.
    setPlanModeAutoBashActive(true)
    expect(isPlanModeAutoBashActive()).toBe(true)

    // Act: call ExitPlanModeV2Tool.call() — the transition path resets the
    // flag so it doesn't stay stale and affect non-plan bash.
    const { ExitPlanModeV2Tool } = await import(
      '../../src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
    )
    const ctx: ToolUseContext = {
      abortController: { signal: { aborted: false } },
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'plan',
          prePlanMode: 'default',
          shouldAvoidPermissionPrompts: false,
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
        },
      }),
      setAppState: (fn: (prev: unknown) => unknown) => {
        // Apply the state transition so the reset side-effect runs.
        fn({
          toolPermissionContext: { mode: 'plan', prePlanMode: 'default' },
        })
      },
      options: { isNonInteractiveSession: false, tools: [] },
    } as unknown as ToolUseContext

    await ExitPlanModeV2Tool.call({}, ctx)

    // Assert: flag reset to false after exit-plan.
    expect(isPlanModeAutoBashActive()).toBe(false)
  })
})
