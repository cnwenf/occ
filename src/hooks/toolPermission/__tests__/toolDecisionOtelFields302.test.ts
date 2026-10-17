/**
 * CC 2.1.302 changelog #14 part B — OTel `tool_decision` attribute eviction.
 *
 *   "new `tool_decision` attributes pushing out `tool_use_id`, `tool_source`
 *    and `tool_parameters` when OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT is low"
 *
 * The official fix reorders the emitted attribute object so the CORE
 * IDENTIFIERS come FIRST and the truncatable tail (classifier fields +
 * permission_mode) comes LAST — a low attribute-count limit then truncates the
 * tail, not the identifiers. Byte-verified against both ELFs (never executed;
 * strings-recovered) — the emit site is a pure key-order change:
 *
 *   v301 hi("tool_decision",{decision:K,source:Se,...be,
 *     permission_mode:Fl(...),tool_name:Ln(s.name),tool_use_id:w,
 *     ...PDr(s.mcpInfo),...Object.keys(Ee).length>0&&{tool_parameters:_(Ee)}})
 *   v302 Si("tool_decision",{decision:K,source:Se,tool_name:In(s.name),
 *     tool_use_id:w,...w0r(s.mcpInfo),
 *     ...Object.keys(Te).length>0&&{tool_parameters:_(Te)},
 *     ...be,permission_mode:jl(...)})
 *
 *   PDr (@220029703) ≡ w0r (@237506975), byte-identical:
 *     function w0r(e){let n=!e?"builtin":eu(e)?"sdk_host_builtin_mcp":"mcp";
 *       return{tool_source:c(n)}}
 *     eu(e){return e?.serverType==="sdk"&&Bu()}  // Bu(){return f()&&!n().childSession}
 *   Te=F5n(s.name,h,s.mcpInfo) — the OTEL_LOG_TOOL_DETAILS-gated parameter
 *     extractor; `_(Te)` serializes it (OCC: jsonStringify), included only
 *     when non-empty.
 *
 * OCC additionally NEVER emitted tool_use_id / tool_source / tool_parameters
 * (pre-existing gap vs BOTH official versions) — this port closes that too.
 *
 * Harness mirrors toolDecisionOtelFields301.test.ts: the events.js seam is
 * mocked so the emitted attribute object is captured verbatim (the `{...attrs}`
 * spread preserves JS string-key insertion order, which IS the OTel log-record
 * wire order under test).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill before modules load.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const actualEvents = await import('../../../utils/telemetry/events.js')
const actualEventsExports = { ...actualEvents }

type OtelCall = { name: string; attrs: Record<string, string | undefined> }
const otelCalls: OtelCall[] = []

const EVENTS_SPEC = '../../../utils/telemetry/events.js'
const SANDBOX_SPEC = '../../../utils/sandbox/sandbox-adapter.js'

mock.module(EVENTS_SPEC, () => ({
  ...actualEventsExports,
  logOTelEvent: (
    name: string,
    attrs: Record<string, string | undefined> = {},
  ): Promise<void> => {
    // Capture the emitted object verbatim; the spread preserves key order.
    otelCalls.push({ name, attrs: { ...attrs } })
    return Promise.resolve()
  },
}))

// permissionLogging's baseMetadata() reads SandboxManager; mock it so tests
// don't read settings or spawn dependency-check shells (301 pattern).
mock.module(SANDBOX_SPEC, () => ({
  SandboxManager: { isSandboxingEnabled: () => false },
}))

afterAll(() => {
  mock.module(EVENTS_SPEC, () => ({ ...actualEventsExports }))
})

// Units under test — imported AFTER the mocks are registered.
const {
  logPermissionDecision,
  buildToolSourceAttribute,
  buildToolParametersForTelemetry,
} = await import('../permissionLogging.js')
type PermissionLogContext =
  (typeof import('../permissionLogging.js'))['PermissionLogContext']

import type { ToolUseContext } from 'src/Tool.js'
import { CLASSIFIER_UNAVAILABLE_REASON } from 'src/utils/messages.js'
import type {
  PermissionDecisionReason,
  PermissionMode,
} from 'src/types/permissions.js'

// ---------------------------------------------------------------------------
// Env gate fixture (official Tc — OTEL_LOG_TOOL_DETAILS, boolean-parsed)
// ---------------------------------------------------------------------------

const TOOL_DETAILS_ENV = 'OTEL_LOG_TOOL_DETAILS'
let savedToolDetailsEnv: string | undefined

function enableToolDetails(value = '1'): void {
  process.env[TOOL_DETAILS_ENV] = value
}

function disableToolDetails(): void {
  delete process.env[TOOL_DETAILS_ENV]
}

beforeEach(() => {
  savedToolDetailsEnv = process.env[TOOL_DETAILS_ENV]
  otelCalls.length = 0
})

afterEach(() => {
  if (savedToolDetailsEnv === undefined) {
    delete process.env[TOOL_DETAILS_ENV]
  } else {
    process.env[TOOL_DETAILS_ENV] = savedToolDetailsEnv
  }
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCtx(opts?: {
  toolName?: string
  mcpInfo?: { serverName: string; toolName: string; serverType?: string }
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
    messageId: 'msg-302',
    toolUseID: opts?.toolUseID ?? 'tu-302',
    permissionMode: opts?.permissionMode,
  } as PermissionLogContext
}

function blockReason(category?: string): PermissionDecisionReason {
  return {
    type: 'classifier',
    classifier: 'auto-mode',
    reason: 'Blocked: this action needs review',
    ...(category !== undefined && { category }),
  }
}

function unavailableReason(): PermissionDecisionReason {
  return {
    type: 'classifier',
    classifier: 'auto-mode',
    reason: CLASSIFIER_UNAVAILABLE_REASON,
  }
}

function toolDecisionAttrs(): Record<string, string | undefined> {
  const events = otelCalls.filter(c => c.name === 'tool_decision')
  expect(events).toHaveLength(1)
  return events[0].attrs
}

// ---------------------------------------------------------------------------
// Section A — attribute KEY ORDER (the eviction fix)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #14B — tool_decision attribute key order', () => {
  test('FULL tail (classifier block + category + params) lands in exact v302 order: identifiers first, permission_mode last', () => {
    enableToolDetails('1')
    const ctx = makeCtx({
      toolName: 'Bash',
      input: { command: 'git status' },
      permissionMode: 'auto',
    })
    logPermissionDecision(
      ctx,
      {
        decision: 'reject',
        source: 'config',
        decisionReason: blockReason('production_deploy'),
      },
      undefined,
    )
    // Key order in the emitted object literal IS the OTel wire order.
    expect(Object.keys(toolDecisionAttrs())).toEqual([
      'decision',
      'source',
      'tool_name',
      'tool_use_id',
      'tool_source',
      'tool_parameters',
      'classifier_verdict',
      'classifier_category',
      'permission_mode',
    ])
  })

  test('core identifiers occupy the first four slots (decision, source, tool_name, tool_use_id) then tool_source — the truncation-safe head', () => {
    disableToolDetails()
    const ctx = makeCtx({ toolName: 'Read', input: { file_path: '/x' } })
    logPermissionDecision(
      ctx,
      { decision: 'accept', source: 'config' },
      undefined,
    )
    const keys = Object.keys(toolDecisionAttrs())
    expect(keys.slice(0, 5)).toEqual([
      'decision',
      'source',
      'tool_name',
      'tool_use_id',
      'tool_source',
    ])
  })

  test('permission_mode is ALWAYS the last key (the eviction tail), with and without classifier fields', () => {
    disableToolDetails()
    // No classifier fields (config reject without decisionReason).
    const ctxA = makeCtx({ toolName: 'Read', input: { file_path: '/x' } })
    logPermissionDecision(ctxA, { decision: 'reject', source: 'config' }, undefined)
    let keys = Object.keys(toolDecisionAttrs())
    expect(keys[keys.length - 1]).toBe('permission_mode')
    expect(keys).not.toContain('classifier_verdict')

    otelCalls.length = 0
    // With a classifier verdict but no category (unavailable → verdict only).
    const ctxB = makeCtx({ toolName: 'Read', input: { file_path: '/x' } })
    logPermissionDecision(
      ctxB,
      {
        decision: 'reject',
        source: 'config',
        decisionReason: unavailableReason(),
      },
      undefined,
    )
    keys = Object.keys(toolDecisionAttrs())
    expect(keys[keys.length - 1]).toBe('permission_mode')
    // classifier_verdict sits in the tail, immediately before permission_mode.
    expect(keys[keys.length - 2]).toBe('classifier_verdict')
  })

  test('tool_parameters (when present) sits between tool_source and the classifier tail', () => {
    enableToolDetails('1')
    const ctx = makeCtx({
      toolName: 'Bash',
      input: { command: 'npm test' },
      permissionMode: 'auto',
    })
    logPermissionDecision(
      ctx,
      {
        decision: 'reject',
        source: 'config',
        decisionReason: blockReason('data_exfiltration'),
      },
      undefined,
    )
    const keys = Object.keys(toolDecisionAttrs())
    expect(keys.indexOf('tool_source')).toBeLessThan(keys.indexOf('tool_parameters'))
    expect(keys.indexOf('tool_parameters')).toBeLessThan(
      keys.indexOf('classifier_verdict'),
    )
  })
})

// ---------------------------------------------------------------------------
// Section B — tool_source mapping (official w0r ≡ PDr)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #14B — tool_source (w0r) mapping', () => {
  test('built-in tool (no mcpInfo) → tool_source:"builtin" via the emitted attrs', () => {
    const ctx = makeCtx({ toolName: 'Bash', input: {} })
    logPermissionDecision(ctx, { decision: 'accept', source: 'config' }, undefined)
    expect(toolDecisionAttrs().tool_source).toBe('builtin')
  })

  test('MCP tool (mcpInfo set) → tool_source:"mcp" via the emitted attrs', () => {
    const ctx = makeCtx({
      toolName: 'mcp__slack__read_channel',
      mcpInfo: { serverName: 'slack', toolName: 'read_channel' },
      input: {},
    })
    logPermissionDecision(ctx, { decision: 'accept', source: 'config' }, undefined)
    expect(toolDecisionAttrs().tool_source).toBe('mcp')
  })

  test('buildToolSourceAttribute: undefined mcpInfo → builtin; server/tool mcpInfo → mcp', () => {
    expect(
      buildToolSourceAttribute({ name: 'Read' } as never),
    ).toEqual({ tool_source: 'builtin' })
    expect(
      buildToolSourceAttribute({
        name: 'mcp__x__y',
        mcpInfo: { serverName: 'x', toolName: 'y' },
      } as never),
    ).toEqual({ tool_source: 'mcp' })
  })

  test('buildToolSourceAttribute: the sdk_host_builtin_mcp branch is structurally present but DORMANT in OCC (no serverType surface) — a hypothetical serverType:"sdk" mcpInfo maps to it', () => {
    // OCC's mcpInfo (Tool.ts:553) carries {serverName,toolName} with NO
    // serverType, and OCC has no SDK-host/childSession runtime context (the
    // official Bu() conjunct), so this branch never fires for real OCC tools.
    // The mapping is kept faithful so it activates if OCC ever gains the field.
    expect(
      buildToolSourceAttribute({
        name: 'mcp__x__y',
        mcpInfo: { serverName: 'x', toolName: 'y', serverType: 'sdk' },
      } as never),
    ).toEqual({ tool_source: 'sdk_host_builtin_mcp' })
  })
})

// ---------------------------------------------------------------------------
// Section C — tool_parameters (official F5n extractor, details-gated)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #14B — tool_parameters extraction', () => {
  test('Bash tool + OTEL_LOG_TOOL_DETAILS=1 → tool_parameters present with bash_command + full_command', () => {
    enableToolDetails('1')
    const ctx = makeCtx({
      toolName: 'Bash',
      input: { command: 'git status --short' },
    })
    logPermissionDecision(ctx, { decision: 'accept', source: 'config' }, undefined)
    const raw = toolDecisionAttrs().tool_parameters
    expect(typeof raw).toBe('string')
    const parsed = JSON.parse(raw as string) as Record<string, unknown>
    expect(parsed.bash_command).toBe('git')
    expect(parsed.full_command).toBe('git status --short')
  })

  test('MCP tool + env=1 → tool_parameters carries mcp_server_name/mcp_tool_name', () => {
    enableToolDetails('1')
    const ctx = makeCtx({
      toolName: 'mcp__slack__read_channel',
      mcpInfo: { serverName: 'slack', toolName: 'read_channel' },
      input: {},
    })
    logPermissionDecision(ctx, { decision: 'accept', source: 'config' }, undefined)
    const raw = toolDecisionAttrs().tool_parameters
    expect(typeof raw).toBe('string')
    const parsed = JSON.parse(raw as string) as Record<string, unknown>
    expect(parsed.mcp_server_name).toBe('slack')
    expect(parsed.mcp_tool_name).toBe('read_channel')
  })

  test('OTEL_LOG_TOOL_DETAILS off → tool_parameters key ABSENT even for a Bash command (details-gated)', () => {
    disableToolDetails()
    const ctx = makeCtx({
      toolName: 'Bash',
      input: { command: 'git status' },
    })
    logPermissionDecision(ctx, { decision: 'accept', source: 'config' }, undefined)
    expect(toolDecisionAttrs()).not.toHaveProperty('tool_parameters')
  })

  test('extractor yields empty (Read tool, env=1) → tool_parameters key ABSENT (official Object.keys(Te).length>0 gate)', () => {
    enableToolDetails('1')
    const ctx = makeCtx({ toolName: 'Read', input: { file_path: '/x' } })
    logPermissionDecision(ctx, { decision: 'accept', source: 'config' }, undefined)
    expect(toolDecisionAttrs()).not.toHaveProperty('tool_parameters')
  })

  test('buildToolParametersForTelemetry returns {} when the gate is off (direct unit)', () => {
    disableToolDetails()
    expect(
      buildToolParametersForTelemetry(
        { name: 'Bash' } as never,
        { command: 'git status' },
      ),
    ).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Section D — tool_use_id (pre-existing gap closed)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #14B — tool_use_id', () => {
  test('tool_use_id equals the in-scope ctx.toolUseID', () => {
    const ctx = makeCtx({ toolName: 'Bash', input: {}, toolUseID: 'toolu_01ABC' })
    logPermissionDecision(ctx, { decision: 'accept', source: 'config' }, undefined)
    expect(toolDecisionAttrs().tool_use_id).toBe('toolu_01ABC')
  })
})

// ---------------------------------------------------------------------------
// Section E — regression: new identifiers don't disturb the config gate
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #14B — regression vs occ160 WP-C classifier gate', () => {
  test('non-config source: identifiers + tool_source still emitted first, but NO classifier fields (config gate intact)', () => {
    enableToolDetails('1')
    const ctx = makeCtx({
      toolName: 'Bash',
      input: { command: 'git status' },
      permissionMode: 'auto',
    })
    logPermissionDecision(
      ctx,
      {
        decision: 'reject',
        source: { type: 'user_reject', hasFeedback: false },
        decisionReason: blockReason('production_deploy'),
      },
      undefined,
    )
    const attrs = toolDecisionAttrs()
    expect(attrs.source).toBe('user_reject')
    expect(attrs.classifier_verdict).toBeUndefined()
    expect(attrs.classifier_category).toBeUndefined()
    // Identifiers still present + first.
    expect(Object.keys(attrs).slice(0, 5)).toEqual([
      'decision',
      'source',
      'tool_name',
      'tool_use_id',
      'tool_source',
    ])
    expect(attrs.permission_mode).toBe('auto')
    expect(Object.keys(attrs)[Object.keys(attrs).length - 1]).toBe(
      'permission_mode',
    )
  })
})
