/**
 * CC 2.1.302 changelog #14 part B — PRODUCTION-WIRING pin for the HEADLESS
 * dispatch-fallback `tool_decision` emit in toolExecution.ts
 * (checkPermissionsAndCallTool).
 *
 * OCC-121 self-acceptance finding (12-PORT verification, item #14B FAIL →
 * fixed this round): the 2.1.302 port had only landed at the INTERACTIVE
 * site (permissionLogging.ts logPermissionDecision, pinned by
 * toolDecisionOtelFields302.test.ts which drives that function directly).
 * The sibling dispatch-fallback site — the ONLY tool_decision emit in
 * headless `-p`/SDK mode, where the interactive permission-logging path is
 * bypassed (OTEL_LOGS_EXPORTER=console dist probe reproduced it twice:
 * Bash auto-accept + Write acceptEdits) — was still emitting the v301 shape
 * `{decision, source, ...classifier, permission_mode, tool_name}` with NO
 * tool_use_id / tool_source / tool_parameters.
 *
 * Official v302 changed BOTH sites (ELF @245575922, dd-verified read-only
 * this round; the interactive @245156620 was verified in the port round):
 *
 *   Si("tool_decision",{decision:as,source:Fs,tool_name:In(e.name),
 *     tool_use_id:n,...w0r(e.mcpInfo),
 *     ...Object.keys($i).length>0&&{tool_parameters:_($i)},
 *     ...Fs==="config"&&yo.behavior!=="ask"&&H8e(as,yo.decisionReason),
 *     permission_mode:jl(Jn)},s.agentContext)
 *   with $i=F5n(e.name,gt,e.mcpInfo) — the OTEL_LOG_TOOL_DETAILS-gated
 *   parameter extractor (OCC: buildToolParametersForTelemetry).
 *
 * Would-fail guarantee (mutation-verified shape): reverting the fallback
 * emit to the v301 key order / dropping the three identifier fields makes
 * the exact Object.keys() assertions below FAIL, while the interactive-site
 * suite (toolDecisionOtelFields302) stays green — that asymmetry was the
 * gap this file closes.
 *
 * Harness mirrors toolDecisionTelemetry288.test.ts: drive the REAL
 * `runToolUse` generator with a fake tool + fake `canUseTool`, capturing the
 * emitted attribute objects verbatim through the events.js seam (the
 * `{...attrs}` spread preserves JS string-key insertion order, which IS the
 * OTel log-record wire order under test).
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
import { z } from 'zod'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill before toolExecution.js
// loads.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const actualTracing = await import('../../../utils/telemetry/sessionTracing.js')
const actualTracingExports = { ...actualTracing }
const actualEvents = await import('../../../utils/telemetry/events.js')
const actualEventsExports = { ...actualEvents }

type OtelCall = { name: string; attrs: Record<string, string | undefined> }
const otelCalls: OtelCall[] = []

const TRACING_SPEC = '../../../utils/telemetry/sessionTracing.js'
const EVENTS_SPEC = '../../../utils/telemetry/events.js'

mock.module(TRACING_SPEC, () => ({
  ...actualTracingExports,
  endToolBlockedOnUserSpan: (): void => {},
}))

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

afterAll(() => {
  mock.module(TRACING_SPEC, () => ({ ...actualTracingExports }))
  mock.module(EVENTS_SPEC, () => ({ ...actualEventsExports }))
})

let runToolUse: (typeof import('../toolExecution.js'))['runToolUse']
beforeAll(async () => {
  runToolUse = (await import('../toolExecution.js')).runToolUse
})

import type { AssistantMessage } from 'src/types/message.js'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import type { PermissionDecisionReason } from 'src/types/permissions.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'

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

// ---------------------------------------------------------------------------
// Fixtures (288 pattern)
// ---------------------------------------------------------------------------

function makeFakeTool(opts: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): Tool {
  return {
    name: opts.name,
    mcpInfo: opts.mcpInfo,
    inputSchema: z.object({}),
    async call() {
      return { data: { ok: true } }
    },
    mapToolResultToToolResultBlockParam(_data: unknown, toolUseId: string) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: () => opts.name,
  } as unknown as Tool
}

function makeContext(tool: Tool): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    abortController: new AbortController(),
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => appState,
    // No stored toolDecisions — the fallback emit gate
    // `!toolUseContext.toolDecisions?.has(toolUseID)` must be open.
    toolDecisions: undefined,
    options: {
      tools: [tool],
      mcpClients: [],
      mainLoopModel: 'claude-opus-5',
      isNonInteractiveSession: true,
    },
  } as unknown as ToolUseContext
}

async function drive(
  ctx: ToolUseContext,
  tool: Tool,
  toolUseID: string,
  canUseTool: (ctx: ToolUseContext) => unknown,
): Promise<void> {
  const toolUse = { type: 'tool_use', id: toolUseID, name: tool.name, input: {} }
  const assistantMessage = {
    uuid: 'a-fb302-1',
    requestId: undefined,
    message: { id: 'msg_fb302_1', role: 'assistant', content: [toolUse] },
  } as unknown as AssistantMessage
  const canUseToolFn = (async () => canUseTool(ctx)) as never
  for await (const _update of runToolUse(
    toolUse as never,
    assistantMessage,
    canUseToolFn,
    ctx,
  )) {
    // drain the generator
  }
}

function blockReason(category?: string): PermissionDecisionReason {
  return {
    type: 'classifier',
    classifier: 'auto-mode',
    reason: 'Blocked: this action needs review',
    ...(category !== undefined && { category }),
  } as PermissionDecisionReason
}

function toolDecisionAttrs(): Record<string, string | undefined> {
  const events = otelCalls.filter(c => c.name === 'tool_decision')
  expect(events).toHaveLength(1)
  return events[0].attrs
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
// Section A — the v302 head shape through the REAL dispatch path
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #14B fallback wiring — identifiers-first key order via runToolUse', () => {
  test('allow (rule source, details off): exact v302 key order with tool_use_id + tool_source, permission_mode last', async () => {
    disableToolDetails()
    const tool = makeFakeTool({ name: 'Grep' })
    const ctx = makeContext(tool)
    await drive(ctx, tool, 'tu_fb302_allow', () => ({
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'rule', rule: { source: 'session' } },
    }))
    const attrs = toolDecisionAttrs()
    // Key order in the emitted object IS the OTel wire order. v301 shape
    // ({decision, source, permission_mode, tool_name}, no identifiers) fails
    // this assertion — that was the half-landed-port gap.
    expect(Object.keys(attrs)).toEqual([
      'decision',
      'source',
      'tool_name',
      'tool_use_id',
      'tool_source',
      'permission_mode',
    ])
    expect(attrs.decision).toBe('accept')
    expect(attrs.source).toBe('user_temporary')
    expect(attrs.tool_name).toBe('Grep')
    expect(attrs.tool_use_id).toBe('tu_fb302_allow')
    expect(attrs.tool_source).toBe('builtin')
    expect(typeof attrs.permission_mode).toBe('string')
  })

  test('FULL tail (MCP params + classifier block + category, details on) lands in exact v302 order', async () => {
    enableToolDetails('1')
    const tool = makeFakeTool({
      name: 'mcp__srv__echo',
      mcpInfo: { serverName: 'srv', toolName: 'echo' },
    })
    const ctx = makeContext(tool)
    await drive(ctx, tool, 'tu_fb302_full', () => ({
      behavior: 'deny',
      message: 'blocked by classifier',
      decisionReason: blockReason('production_deploy'),
    }))
    const attrs = toolDecisionAttrs()
    expect(Object.keys(attrs)).toEqual([
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
    expect(attrs.decision).toBe('reject')
    // classifier reason maps to source 'config' (decisionReasonToOTelSource)
    expect(attrs.source).toBe('config')
    expect(attrs.tool_source).toBe('mcp')
    expect(attrs.tool_use_id).toBe('tu_fb302_full')
    const params = JSON.parse(attrs.tool_parameters ?? '{}') as Record<
      string,
      unknown
    >
    expect(params.mcp_server_name).toBe('srv')
    expect(params.mcp_tool_name).toBe('echo')
    expect(attrs.classifier_verdict).toBe('block')
    expect(attrs.classifier_category).toBe('production_deploy')
  })

  test('details OFF: tool_parameters is absent even for an MCP tool (the F5n gate)', async () => {
    disableToolDetails()
    const tool = makeFakeTool({
      name: 'mcp__srv__echo',
      mcpInfo: { serverName: 'srv', toolName: 'echo' },
    })
    const ctx = makeContext(tool)
    await drive(ctx, tool, 'tu_fb302_nodetails', () => ({
      behavior: 'deny',
      message: 'denied',
      decisionReason: { type: 'rule', rule: { source: 'session' } },
    }))
    const attrs = toolDecisionAttrs()
    expect(Object.keys(attrs)).not.toContain('tool_parameters')
    expect(attrs.tool_source).toBe('mcp')
    expect(attrs.tool_use_id).toBe('tu_fb302_nodetails')
  })
})

// ---------------------------------------------------------------------------
// Section B — the ask gate (kept from the v301 port, official-verbatim)
// ---------------------------------------------------------------------------

describe('CC 2.1.302 #14B fallback wiring — ask gate on the classifier spread', () => {
  test("ask → source 'config' but NO classifier fields (behavior!=='ask' gate), identifiers still present", async () => {
    enableToolDetails('1')
    const tool = makeFakeTool({ name: 'Grep' })
    const ctx = makeContext(tool)
    await drive(ctx, tool, 'tu_fb302_ask', () => ({
      behavior: 'ask',
      message: 'needs approval',
      decisionReason: blockReason('production_deploy'),
    }))
    const attrs = toolDecisionAttrs()
    expect(attrs.decision).toBe('reject')
    expect(attrs.source).toBe('config')
    // The ask gate keeps classifier fields off ask-derived 'reject' telemetry.
    expect(Object.keys(attrs)).not.toContain('classifier_verdict')
    expect(Object.keys(attrs)).not.toContain('classifier_category')
    // Identifiers survive on the ask path too.
    expect(attrs.tool_use_id).toBe('tu_fb302_ask')
    expect(attrs.tool_source).toBe('builtin')
    expect(Object.keys(attrs).at(-1)).toBe('permission_mode')
  })
})
