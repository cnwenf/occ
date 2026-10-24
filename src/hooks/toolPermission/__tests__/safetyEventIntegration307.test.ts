/**
 * CC 2.1.307 A2 — `claude_code.safety_event` integration through
 * logPermissionDecision (the official call site).
 *
 * Official v307 Pfs (@245156620 region) fans each permission decision out to
 * BOTH the existing tool_decision emit AND the new safety_event emitter (LMn
 * @36240106). OCC wires the same fan-out inside logPermissionDecision
 * (permissionLogging.ts), immediately after the tool_decision emit.
 *
 * Invariants under test:
 *  - exactly ONE safety_event per decision that has a category (alongside the
 *    one tool_decision), zero when the skip gates fire (bare config accept,
 *    wYr tools, tengu_snoopy_creek gate off)
 *  - safety_event.decision is the RAW decision (reject), never the abort-
 *    mapped tool_decision label ('abort')
 *  - tool_decision emission is unchanged when the safety gate is off
 *
 * Harness mirrors toolDecisionOtelFields302.test.ts (events.js capture seam +
 * sandbox mock) and adds the growthbook gate mock for tengu_snoopy_creek.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const EVENTS_SPEC = '../../../utils/telemetry/events.js'
const SANDBOX_SPEC = '../../../utils/sandbox/sandbox-adapter.js'
const GROWTHBOOK_SPEC = '../../../services/analytics/growthbook.js'

const actualEvents = await import(EVENTS_SPEC)
const actualEventsExports = { ...actualEvents }
const actualGrowthbook = await import(GROWTHBOOK_SPEC)
const actualGrowthbookExports = { ...actualGrowthbook }
const actualSandboxAdapter = await import(SANDBOX_SPEC)
const actualSandboxAdapterExports = { ...actualSandboxAdapter }

type OtelCall = { name: string; attrs: Record<string, string | undefined> }
const otelCalls: OtelCall[] = []

// Official FMn(){return k(bYr,!0)} — gate default TRUE.
let safetyGateEnabled = true

mock.module(EVENTS_SPEC, () => ({
  ...actualEventsExports,
  logOTelEvent: (
    name: string,
    attrs: Record<string, string | undefined> = {},
  ): Promise<void> => {
    otelCalls.push({ name, attrs: { ...attrs } })
    return Promise.resolve()
  },
}))

// OCC-131 (2.1.309 WP-B): sandbox-adapter gained `SandboxPolicyRefusalError`
// (consumed by Shell.ts in the import chain) — a partial factory without it
// throws "Export named ... not found". Spread the real module (OCC-97 pattern).
mock.module(SANDBOX_SPEC, () => ({
  ...actualSandboxAdapterExports,
  SandboxManager: { isSandboxingEnabled: () => false },
}))

mock.module(GROWTHBOOK_SPEC, () => ({
  ...actualGrowthbookExports,
  getFeatureValue_CACHED_MAY_BE_STALE: <T,>(
    feature: string,
    defaultValue: T,
  ): T =>
    feature === 'tengu_snoopy_creek'
      ? (safetyGateEnabled as T)
      : actualGrowthbookExports.getFeatureValue_CACHED_MAY_BE_STALE(
          feature,
          defaultValue,
        ),
}))

afterAll(() => {
  mock.module(EVENTS_SPEC, () => ({ ...actualEventsExports }))
  mock.module(GROWTHBOOK_SPEC, () => ({ ...actualGrowthbookExports }))
  // OCC-131: restore the sandbox adapter too — the SandboxManager stub above
  // would otherwise leak into later files in the same worker.
  mock.module(SANDBOX_SPEC, () => ({ ...actualSandboxAdapterExports }))
})

const { logPermissionDecision } = await import('../permissionLogging.js')
import type { PermissionLogContext } from '../permissionLogging.js'

import type { ToolUseContext } from 'src/Tool.js'
import type {
  PermissionDecisionReason,
  PermissionMode,
} from 'src/types/permissions.js'

beforeEach(() => {
  otelCalls.length = 0
  safetyGateEnabled = true
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCtx(opts?: {
  toolName?: string
  mcpInfo?: { serverName: string; toolName: string }
  input?: unknown
  toolUseID?: string
  permissionMode?: PermissionMode
}): PermissionLogContext {
  const toolUseContext = {
    toolDecisions: new Map<string, unknown>(),
    getAppState: () => ({
      toolPermissionContext: { mode: opts?.permissionMode ?? 'default' },
    }),
  } as unknown as ToolUseContext
  return {
    tool: {
      name: opts?.toolName ?? 'Bash',
      ...(opts?.mcpInfo !== undefined && { mcpInfo: opts.mcpInfo }),
    } as PermissionLogContext['tool'],
    input: opts?.input ?? {},
    toolUseContext,
    messageId: 'msg-307',
    toolUseID: opts?.toolUseID ?? 'tu-307',
    permissionMode: opts?.permissionMode,
  } as PermissionLogContext
}

function ruleDenyReason(source = 'projectSettings'): PermissionDecisionReason {
  return {
    type: 'rule',
    rule: {
      source,
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'Bash' },
    },
  } as PermissionDecisionReason
}

function eventsNamed(name: string): OtelCall[] {
  return otelCalls.filter(c => c.name === name)
}

// ---------------------------------------------------------------------------

describe('CC 2.1.307 A2 — safety_event integration via logPermissionDecision', () => {
  test('config rule deny emits tool_decision ONCE and safety_event ONCE, with matching tool_use_id', () => {
    logPermissionDecision(
      makeCtx({ toolName: 'Bash', permissionMode: 'default' }),
      { decision: 'reject', source: 'config', decisionReason: ruleDenyReason() },
      undefined,
    )
    const toolDecisions = eventsNamed('tool_decision')
    const safety = eventsNamed('safety_event')
    expect(toolDecisions).toHaveLength(1)
    expect(safety).toHaveLength(1)
    expect(safety[0].attrs.category).toBe('permission_rule')
    expect(safety[0].attrs.reason_code).toBe('rule:projectSettings')
    expect(safety[0].attrs.decision).toBe('reject')
    expect(safety[0].attrs.decision_source).toBe('config')
    expect(safety[0].attrs.tool_use_id).toBe(toolDecisions[0].attrs.tool_use_id)
    expect(safety[0].attrs.sandbox_violation_count).toBe('0')
    expect(safety[0].attrs.sandbox_enabled).toBe('false')
  })

  test('bare config accept (no decisionReason) emits tool_decision ONLY — safety_event skipped (CYr undefined gate)', () => {
    logPermissionDecision(
      makeCtx({ toolName: 'Read' }),
      { decision: 'accept', source: 'config' },
      undefined,
    )
    expect(eventsNamed('tool_decision')).toHaveLength(1)
    expect(eventsNamed('safety_event')).toHaveLength(0)
  })

  test('user abort: tool_decision says abort, safety_event keeps the RAW reject decision + user_abort source + user_rejected category', () => {
    logPermissionDecision(
      makeCtx({ toolName: 'Bash' }),
      { decision: 'reject', source: { type: 'user_abort' } },
      undefined,
    )
    const toolDecisions = eventsNamed('tool_decision')
    const safety = eventsNamed('safety_event')
    expect(toolDecisions).toHaveLength(1)
    expect(toolDecisions[0].attrs.decision).toBe('abort')
    expect(safety).toHaveLength(1)
    expect(safety[0].attrs.decision).toBe('reject')
    expect(safety[0].attrs.decision_source).toBe('user_abort')
    expect(safety[0].attrs.category).toBe('user_rejected')
  })

  test('user reject: safety_event category user_rejected with grant_scope absent', () => {
    logPermissionDecision(
      makeCtx({ toolName: 'Bash' }),
      { decision: 'reject', source: { type: 'user_reject', hasFeedback: true } },
      undefined,
    )
    const safety = eventsNamed('safety_event')
    expect(safety).toHaveLength(1)
    expect(safety[0].attrs.category).toBe('user_rejected')
    expect(safety[0].attrs.decision_source).toBe('user_reject')
    expect(safety[0].attrs.grant_scope).toBeUndefined()
  })

  test('user permanent accept after an ask: safety_event accept + permission_rule + grant_scope always', () => {
    logPermissionDecision(
      makeCtx({ toolName: 'Bash', permissionMode: 'default' }),
      {
        decision: 'accept',
        source: { type: 'user', permanent: true },
        decisionReason: {
          type: 'rule',
          rule: {
            source: 'session',
            ruleBehavior: 'ask',
            ruleValue: { toolName: 'Bash' },
          },
        } as PermissionDecisionReason,
      },
      1,
    )
    const safety = eventsNamed('safety_event')
    expect(safety).toHaveLength(1)
    expect(safety[0].attrs.decision).toBe('accept')
    expect(safety[0].attrs.decision_source).toBe('user_permanent')
    expect(safety[0].attrs.category).toBe('permission_rule')
    expect(safety[0].attrs.reason_code).toBe('rule:session')
    expect(safety[0].attrs.grant_scope).toBe('always')
  })

  test('classifier-source accept (tryClassifier path): no mapped category → safety_event skipped, tool_decision still emitted', () => {
    // j6r: a classifier auto-accept carries no ask/deny record → no
    // reasonCode → CYr undefined → skip (official behaves identically).
    logPermissionDecision(
      makeCtx({ toolName: 'Bash' }),
      { decision: 'accept', source: { type: 'classifier' } },
      undefined,
    )
    expect(eventsNamed('tool_decision')).toHaveLength(1)
    expect(eventsNamed('safety_event')).toHaveLength(0)
  })

  test('tengu_snoopy_creek gate OFF: tool_decision unaffected, safety_event suppressed', () => {
    safetyGateEnabled = false
    logPermissionDecision(
      makeCtx({ toolName: 'Bash' }),
      { decision: 'reject', source: 'config', decisionReason: ruleDenyReason() },
      undefined,
    )
    expect(eventsNamed('tool_decision')).toHaveLength(1)
    expect(eventsNamed('safety_event')).toHaveLength(0)
  })

  test('wYr skip tool (AskUserQuestion): tool_decision emitted, safety_event suppressed even with a mapped category', () => {
    logPermissionDecision(
      makeCtx({ toolName: 'AskUserQuestion' }),
      { decision: 'reject', source: 'config', decisionReason: ruleDenyReason() },
      undefined,
    )
    expect(eventsNamed('tool_decision')).toHaveLength(1)
    expect(eventsNamed('safety_event')).toHaveLength(0)
  })

  test('mcp tool deny: safety_event tool_class mcp / tool_name mcp_tool / tool_source mcp', () => {
    logPermissionDecision(
      makeCtx({
        toolName: 'mcp__slack__read_channel',
        mcpInfo: { serverName: 'slack', toolName: 'read_channel' },
      }),
      { decision: 'reject', source: 'config', decisionReason: ruleDenyReason() },
      undefined,
    )
    const safety = eventsNamed('safety_event')
    expect(safety).toHaveLength(1)
    expect(safety[0].attrs.tool_class).toBe('mcp')
    expect(safety[0].attrs.tool_name).toBe('mcp_tool')
    expect(safety[0].attrs.tool_source).toBe('mcp')
  })

  test('safety_event does NOT disturb the tool_decision attribute set (regression guard for the 302 key order)', () => {
    logPermissionDecision(
      makeCtx({ toolName: 'Bash', permissionMode: 'default' }),
      { decision: 'reject', source: 'config', decisionReason: ruleDenyReason() },
      undefined,
    )
    const toolDecision = eventsNamed('tool_decision')[0]
    expect(toolDecision.attrs.decision).toBe('reject')
    expect(toolDecision.attrs.source).toBe('config')
    expect(toolDecision.attrs.tool_name).toBe('Bash')
    expect(toolDecision.attrs.tool_source).toBe('builtin')
    expect(toolDecision.attrs.permission_mode).toBe('default')
  })
})
