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
 * 验收 P2-2 correction (2026-10-07): an earlier revision of this file proved
 * "block entered" by letting the acceptEdits fast-path ALLOW a write-shaped
 * tool in PLAN mode. That was the bug, not the proof: official 289/290/291
 * gate the acceptEdits fast-path on `!Er` where `Er=Ce==="plan"&&!Kn`
 * (cc289 @210258204/210258689, cc290 @213334712/213335197, cc291
 * @213291816/213292302) — plan mode NEVER runs the acceptEdits simulation.
 * OCC's permissions.ts now mirrors the `!Er` guard.
 *
 * How the tests prove the flag is consulted (post-fix): the 2.1.290
 * plan_mode_floor only runs INSIDE the auto-mode classifier block. A
 * non-read-only tool in plan mode returns ask with
 * `decisionReason.reason === 'plan_mode_floor'` when the flag is set (block
 * entered, fast-path skipped per `Er`, classifier allow floored), but a PLAIN
 * ask with no decisionReason when the flag is clear (block skipped). In AUTO
 * mode the acceptEdits fast-path still fires (`Er` is false) — asserted below
 * so the plan gate is provably plan-only.
 *
 * Scope note on "NEVER": plan mode never auto-allows a NON-READ-ONLY call via
 * the acceptEdits simulation (Er gate) or the classifier (plan_mode_floor).
 * Safe-allowlist tools CAN still auto-allow in plan mode — the official
 * allowlist gate `if(!Di&&!Bo&&jr)` (cc291 @213295651 region) carries no
 * `Er` guard, and OCC's allowlist fast-path matches.
 *
 * In OCC (external build) the AI classifier is a stub (bashClassifier.ts
 * line 1: "Stub for external builds - classifier permissions feature is
 * ANT-ONLY"), so tools that declare classifier-relevant input fail-open to
 * dialog. These fixtures declare none → the REAL rule-based allow path runs
 * before the ant-only classifier API is ever called.
 */

function createBashTool(): Tool {
  return {
    name: 'Bash',
    userFacingName: () => 'Bash',
    inputSchema: {
      parse: (i: unknown) => i,
      safeParse: (i: unknown) => ({ success: true, data: i }),
    },
    // Returns 'ask' in plan/auto mode, 'allow' in acceptEdits mode. Used for
    // the AUTO-mode control: the acceptEdits fast-path fires there (`Er` only
    // gates plan mode), proving the auto-mode block was entered.
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

/**
 * 验收 P2-2 fixture — REAL write-tool semantics (the reviewer's probe shape):
 * a cwd file write is ALLOWED under acceptEdits and asks otherwise, and the
 * tool is NOT read-only. Pre-fix, the acceptEdits fast-path in plan mode
 * returned allow {type:'mode',mode:'auto'} for this tool, bypassing the
 * plan_mode_floor. Post-fix (official `Er` gate), plan mode must floor it to
 * ask + plan_mode_floor; auto mode must still fast-path allow it.
 * Declares no `toAutoClassifierInput` → classifyYoloAction's compact action
 * is '' → shouldBlock:false rule-based allow BEFORE the ant-only classifier
 * API — so the floor at permissions.ts:1143 is genuinely reached.
 */
function createWriteTool(): Tool {
  return {
    name: 'FileWrite',
    userFacingName: () => 'Write',
    inputSchema: {
      parse: (i: unknown) => i,
      safeParse: (i: unknown) => ({ success: true, data: i }),
    },
    checkPermissions: async (
      _input: unknown,
      ctx: { getAppState: () => { toolPermissionContext: { mode: string } } },
    ) => {
      const mode = ctx.getAppState().toolPermissionContext.mode
      if (mode === 'acceptEdits') {
        // Real FileWriteTool: a write inside the working dir is allowed in
        // acceptEdits mode.
        return { behavior: 'allow' as const }
      }
      return {
        behavior: 'ask' as const,
        message: 'Claude requested permissions to write to the file',
      }
    },
    description: async () => 'Write',
    isMcp: false,
    isReadOnly: () => false,
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

  test('flag set + mode plan + isAutoModeActive false → auto-mode block ENTERED (non-read-only write floored to ask + plan_mode_floor)', async () => {
    // Arrange: plan mode, auto-mode NOT active, but planModeAutoBash flag set.
    // This is the state EnterPlanModeTool creates when entering plan mode
    // from auto.
    setAutoModeActive(false)
    setPlanModeAutoBashActive(true)
    expect(isPlanModeAutoBashActive()).toBe(true)

    const { hasPermissionsToUseTool } = await import(
      '../../src/utils/permissions/permissions.js'
    )
    const tool = createWriteTool()
    const ctx = createContext('plan')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { file_path: 'notes.md', content: 'x' },
      ctx,
      msg,
      'plan-auto-flag-set',
    )

    // Assert: the auto-mode block was entered. Proof it was entered: the
    // plan_mode_floor decisionReason is ONLY stamped inside the block. The
    // acceptEdits fast-path did NOT fire (official `Er` gate — plan mode
    // never simulates acceptEdits), the classifier-path rule-based allow was
    // floored because the tool is not read-only. WITHOUT the wiring (flag
    // inert), the block would be skipped → plain ask, no decisionReason.
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.reason).toBe('plan_mode_floor')
  })

  test('flag clear + mode plan + isAutoModeActive false → auto-mode block SKIPPED (plain dialog ask, no floor reason)', async () => {
    // Arrange: plan mode, auto-mode NOT active, planModeAutoBash flag clear.
    // The auto-mode block must NOT be entered → dialog ('ask') with NO
    // plan_mode_floor decisionReason (the floor only runs inside the block).
    setAutoModeActive(false)
    setPlanModeAutoBashActive(false)
    expect(isPlanModeAutoBashActive()).toBe(false)

    const { hasPermissionsToUseTool } = await import(
      '../../src/utils/permissions/permissions.js'
    )
    const tool = createWriteTool()
    const ctx = createContext('plan')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { file_path: 'notes.md', content: 'x' },
      ctx,
      msg,
      'plan-auto-flag-clear',
    )

    // Assert: auto-mode block skipped → the tool's own checkPermissions ask
    // passes through untouched — no plan_mode_floor stamp.
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.reason).not.toBe('plan_mode_floor')
  })

  test('flag set + mode auto → acceptEdits fast-path STILL fires (Er gate is plan-only)', async () => {
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

    // Official: `Er=Ce==="plan"&&!Kn` — in AUTO mode Er is false, so the
    // acceptEdits simulation runs and allows. The fast-path return shape is
    // decisionReason {type:'mode',mode:'auto'}.
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toEqual({ type: 'mode', mode: 'auto' })
  })

  test('验收 P2-2 regression: real write-tool semantics in plan+auto → ask + plan_mode_floor (acceptEdits fast-path must NOT bypass the floor)', async () => {
    // The reviewer's probe, verbatim in shape: a tool with REAL FileWrite
    // semantics — isReadOnly false; checkPermissions ALLOWs under acceptEdits
    // (a cwd write would) and asks otherwise — under mode 'plan' with
    // isPlanModeAutoBashActive. Pre-fix this returned
    //   PROBE-BEHAVIOR: allow REASON: {"type":"mode","mode":"auto"}
    // because the acceptEdits fast-path at permissions.ts:744 fired BEFORE
    // the plan_mode_floor and simulated acceptEdits mode. Official
    // 289/290/291 gate that simulation on `!Er` (`Er=Ce==="plan"&&!Kn`), so
    // plan mode must reach the floor instead.
    setAutoModeActive(false)
    setPlanModeAutoBashActive(true)

    const { hasPermissionsToUseTool } = await import(
      '../../src/utils/permissions/permissions.js'
    )
    const tool = createWriteTool()
    const ctx = createContext('plan')
    const msg = createAssistantMessage()

    const result = await hasPermissionsToUseTool(
      tool,
      { file_path: 'notes.md', content: 'x' },
      ctx,
      msg,
      'p2-2-probe',
    )

    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.reason).toBe('plan_mode_floor')
    // The bug's exact observable — an allow with mode/auto reason — must not
    // reappear.
    expect(result.behavior).not.toBe('allow')

    // HONEST CONCLUSION (scoped, not overclaimed): plan mode never auto-allows
    // a NON-READ-ONLY tool call — neither via the acceptEdits simulation (Er
    // gate) nor via the classifier allow (2.1.290 `_rn` floor). A structurally
    // read-only call (isReadOnly → true) is still honored with no dialog, and
    // safe-allowlist tools still auto-allow in plan mode (the official
    // allowlist gate carries no Er guard). For a REAL bash command that
    // declares classifier-relevant input, the path proceeds to the ant-only
    // classifier API (stubbed/unavailable in OCC external builds) → fail-open
    // to dialog (or fail-closed if tengu_iron_gate_closed).
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
