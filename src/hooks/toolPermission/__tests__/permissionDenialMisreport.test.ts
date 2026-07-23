import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  attachAnalyticsSink,
  _resetForTesting,
  type AnalyticsSink,
} from '../../../services/analytics/index.js'

// Mock the sandbox adapter so logPermissionDecision's baseMetadata() doesn't
// read settings or spawn dependency-check shells. Must be registered before
// importing permissionLogging.js (which imports SandboxManager).
mock.module('../../../utils/sandbox/sandbox-adapter.js', () => ({
  SandboxManager: { isSandboxingEnabled: () => false },
}))

// Import the unit under test after mocks are in place.
const { logPermissionDecision } = await import('../permissionLogging.js')
import {
  decisionReasonToOTelSource,
  isSdkPermissionAbort,
  sdkPermissionDecisionLabel,
} from '../sdkPermissionTelemetry.js'
import type { PermissionDecisionReason } from '../../../types/permissions.js'
import type { PermissionLogContext } from '../permissionLogging.js'
import type { ToolUseContext } from '../../../Tool.js'

/**
 * CC 2.1.216 #29 — telemetry misreporting permission denials:
 *   (i)  a permission-prompt REQUEST that FAILS (no host response) must NOT
 *        count as a user rejection;
 *   (ii) a user EXPLICIT reject is still recorded as a rejection (unchanged);
 *   (iii) a user INTERRUPT is reported as a user ABORT, not a rejection.
 *
 * Verification: a mock analytics sink captures the tengu_tool_use_rejected_*
 * rejection events; the stored toolDecisions map mirrors the OTel
 * tool_decision label. SDK / headless classification is covered by pure
 * unit tests on decisionReasonToOTelSource + sdkPermissionDecisionLabel.
 */

type RecordedEvent = { eventName: string; metadata: Record<string, unknown> }

function makeCtx(): PermissionLogContext & {
  toolUseContext: ToolUseContext
} {
  const toolUseContext = {
    toolDecisions: new Map<string, unknown>(),
  } as unknown as ToolUseContext
  return {
    tool: { name: 'Bash' } as PermissionLogContext['tool'],
    input: {},
    toolUseContext,
    messageId: 'msg-1',
    toolUseID: 'tu-1',
  } as PermissionLogContext
}

function permissionPromptReason(
  toolResult: unknown,
): PermissionDecisionReason {
  return {
    type: 'permissionPromptTool',
    permissionPromptToolName: 'mcp__host__approve',
    toolResult,
  }
}

describe('CC 2.1.216 #29 — interactive permission telemetry (mock sink)', () => {
  let recorded: RecordedEvent[]
  let sink: AnalyticsSink

  beforeEach(() => {
    _resetForTesting()
    recorded = []
    sink = {
      logEvent: (eventName, metadata) => {
        recorded.push({ eventName, metadata: { ...metadata } })
      },
      logEventAsync: async (eventName, metadata) => {
        recorded.push({ eventName, metadata: { ...metadata } })
      },
    }
    attachAnalyticsSink(sink)
  })

  afterEach(() => {
    _resetForTesting()
  })

  test('(ii) explicit user reject → rejection recorded (unchanged)', () => {
    const ctx = makeCtx()
    logPermissionDecision(ctx, {
      decision: 'reject',
      source: { type: 'user_reject', hasFeedback: false },
    })

    // Rejection analytics event MUST fire for a genuine rejection.
    const rejectionEvents = recorded.filter(
      e => e.eventName === 'tengu_tool_use_rejected_in_prompt',
    )
    expect(rejectionEvents).toHaveLength(1)
    // Stored OTel decision label mirrors the tool_decision event payload.
    const stored = (
      ctx.toolUseContext.toolDecisions as Map<string, unknown>
    ).get('tu-1') as { decision: string; source: string }
    expect(stored.decision).toBe('reject')
    expect(stored.source).toBe('user_reject')
  })

  test('(iii) user interrupt (user_abort) → ABORT, not rejection', () => {
    const ctx = makeCtx()
    logPermissionDecision(ctx, {
      decision: 'reject',
      source: { type: 'user_abort' },
    })

    // A user interrupt must NOT fire the rejection analytics event — the
    // abort is already covered by tengu_tool_use_cancelled (logCancelled).
    const rejectionEvents = recorded.filter(
      e => e.eventName === 'tengu_tool_use_rejected_in_prompt',
    )
    expect(rejectionEvents).toHaveLength(0)
    // Telemetered as a user ABORT instead of a rejection.
    const stored = (
      ctx.toolUseContext.toolDecisions as Map<string, unknown>
    ).get('tu-1') as { decision: string; source: string }
    expect(stored.decision).toBe('abort')
    expect(stored.source).toBe('user_abort')
  })
})

describe('CC 2.1.216 #29 — SDK permission-prompt classification (pure)', () => {
  test('(i) FAILED request (no host response) → not a rejection', () => {
    // toolResult undefined = the permission-prompt request never produced a
    // usable host response (failed / aborted).
    const reason = permissionPromptReason(undefined)
    expect(isSdkPermissionAbort(reason)).toBe(true)
    expect(decisionReasonToOTelSource(reason, 'deny')).toBe('user_abort')
    expect(sdkPermissionDecisionLabel('deny', reason)).toBe('abort')
  })

  test('(ii) explicit host deny (real response, no interrupt) → rejection', () => {
    const reason = permissionPromptReason({
      behavior: 'deny',
      message: 'User said no',
    })
    expect(isSdkPermissionAbort(reason)).toBe(false)
    expect(decisionReasonToOTelSource(reason, 'deny')).toBe('user_reject')
    expect(sdkPermissionDecisionLabel('deny', reason)).toBe('reject')
  })

  test('(iii) host-reported interrupt → ABORT, not rejection', () => {
    const reason = permissionPromptReason({
      behavior: 'deny',
      message: 'User aborted',
      interrupt: true,
    })
    expect(isSdkPermissionAbort(reason)).toBe(true)
    expect(decisionReasonToOTelSource(reason, 'deny')).toBe('user_abort')
    expect(sdkPermissionDecisionLabel('deny', reason)).toBe('abort')
  })

  test('host decisionClassification is honored when present', () => {
    // Even on an interrupt-shaped result, an explicit user_reject
    // classification from the host is authoritative.
    const reason = permissionPromptReason({
      behavior: 'deny',
      message: 'no',
      interrupt: true,
      decisionClassification: 'user_reject',
    })
    expect(decisionReasonToOTelSource(reason, 'deny')).toBe('user_reject')
  })

  test('allow path is unchanged (no abort classification)', () => {
    const reason = permissionPromptReason({
      behavior: 'allow',
      updatedInput: {},
    })
    expect(sdkPermissionDecisionLabel('allow', reason)).toBe('accept')
    expect(decisionReasonToOTelSource(reason, 'allow')).toBe('user_temporary')
  })

  test('non-permissionPromptTool reasons are unaffected', () => {
    const ruleReason = {
      type: 'rule',
      rule: { source: 'session' },
    } as unknown as PermissionDecisionReason
    // A session-sourced deny rule is still a user_reject.
    expect(decisionReasonToOTelSource(ruleReason, 'deny')).toBe('user_reject')
    expect(sdkPermissionDecisionLabel('deny', ruleReason)).toBe('reject')
    expect(isSdkPermissionAbort(ruleReason)).toBe(false)
  })
})
