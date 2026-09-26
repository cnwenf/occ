/**
 * CC 2.1.283 OTEL `tool.output` for MCP / WebFetch / WebSearch results
 * (OCC-138 / C2), byte-verified against the official v2.1.283 linux-x64 ELF:
 *
 * - NEW query-engine block @ELF ~204862679 (absent in the 2.1.282 binary —
 *   282 has 2 `tool.output` occurrences, 283 has 3):
 *     if((e.mcpInfo!==void 0||HQn.has(e.name))&&!oo.detached&&rTr(Wt)){
 *       let Sr=wbo(ls.content);
 *       oTr(Wt,"tool.output",{output:e.mcpInfo?.accountMemory===!0?KEe(Sr):Sr})}
 *   placed AFTER the tool_result mapping (`ls`) and BEFORE the endToolSpan
 *   counterpart (`iPt`) — endToolSpan clears the ALS store the emitter reads,
 *   so the emission must precede it.
 * - `HQn=new Set([Mr,uv])` @204827266 where Mr="WebFetch" @200200794 and
 *   uv="WebSearch" @202646603.
 * - `rTr(n){return ND()&&Iut()&&!Rk()&&n.isRecording()}` @201186406 — call
 *   -site gate (tracing enabled AND OTEL_LOG_TOOL_CONTENT).
 * - `wbo` @201186465 — content flattener (string pass-through; non-array →
 *   ""; blocks → text or `[type]` placeholders joined with newlines).
 * - `oTr` @201186638 — the span-event emitter OCC already ports as
 *   addToolContentEvent (truncation + `${key}_truncated` flags).
 *
 * Documented NO-OP deviations (see toolExecution.ts): `!oo.detached` — OCC
 * tool results have no detached variant; `KEe` accountMemory redaction —
 * OCC's mcpInfo carries no accountMemory flag (MCP account memory not
 * ported), so the redaction branch can never fire.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import * as actualTracing from 'src/utils/telemetry/sessionTracing.js'

// getUserAgent()/skills paths read the build-time MACRO; supply the dev-time
// polyfill before toolExecution.js is (dynamically) imported, same guard as
// permissionDenialFlag269.test.ts.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// Capture the real functions by value BEFORE mock.module — Bun live-patches
// the namespace object (OCC-97 lesson, same as hookExecutionCompleteOtel280).
const realFlatten = actualTracing.flattenToolOutputContent
const realGate = actualTracing.shouldRecordToolContentEvent

// ---------------------------------------------------------------------------
// Pure flattener (official `wbo`)
// ---------------------------------------------------------------------------

describe('2.1.283 C2 — flattenToolOutputContent (official wbo)', () => {
  test('string content passes through unchanged', () => {
    expect(realFlatten('plain string output')).toBe('plain string output')
    expect(realFlatten('')).toBe('')
  })

  test('non-array non-string content flattens to ""', () => {
    for (const value of [undefined, null, 42, true, {}, { type: 'text', text: 'x' }]) {
      expect(realFlatten(value)).toBe('')
    }
  })

  test('empty array flattens to ""', () => {
    expect(realFlatten([])).toBe('')
  })

  test('text blocks flatten to their text, joined with newlines', () => {
    expect(
      realFlatten([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond')
  })

  test('non-text blocks flatten to [type] placeholders', () => {
    expect(
      realFlatten([
        { type: 'text', text: 'hello' },
        { type: 'image', source: { data: 'AAA' } },
        { type: 'tool_use', id: 'x', name: 'y', input: {} },
      ]),
    ).toBe('hello\n[image]\n[tool_use]')
  })

  test('missing/null type flattens to [unknown] (official ?? "unknown")', () => {
    expect(realFlatten([{ text: 'no type' }, null, undefined])).toBe(
      '[unknown]\n[unknown]\n[unknown]',
    )
  })

  test('text block with non-string text is String()-coerced (official String(e.text))', () => {
    expect(realFlatten([{ type: 'text', text: 123 }, { type: 'text' }])).toBe(
      '123\nundefined',
    )
  })
})

// ---------------------------------------------------------------------------
// Call-site gate (official `rTr`)
// ---------------------------------------------------------------------------

const GATE_ENV_KEYS = [
  'ENABLE_BETA_TRACING_DETAILED',
  'BETA_TRACING_ENDPOINT',
  'USER_TYPE',
  'OTEL_LOG_TOOL_CONTENT',
] as const

let savedGateEnv: Record<string, string | undefined> = {}

function saveGateEnv(): void {
  savedGateEnv = {}
  for (const key of GATE_ENV_KEYS) {
    savedGateEnv[key] = process.env[key]
  }
}

function restoreGateEnv(): void {
  for (const key of GATE_ENV_KEYS) {
    if (savedGateEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedGateEnv[key]
    }
  }
}

function enableTracingEnv(): void {
  // isBetaTracingEnabled: env pair + USER_TYPE=ant short-circuit (no
  // GrowthBook cache read). isAnyTracingEnabled = enhanced(false in OCC —
  // ENHANCED_TELEMETRY_BETA is not in FEATURE_ALLOWLIST) || beta.
  process.env.ENABLE_BETA_TRACING_DETAILED = '1'
  process.env.BETA_TRACING_ENDPOINT = 'https://trace.test'
  process.env.USER_TYPE = 'ant'
  // isToolContentLoggingEnabled (official Iut)
  process.env.OTEL_LOG_TOOL_CONTENT = '1'
}

describe('2.1.283 C2 — shouldRecordToolContentEvent (official rTr gate)', () => {
  beforeEach(saveGateEnv)
  afterEach(restoreGateEnv)

  test('tracing enabled + OTEL_LOG_TOOL_CONTENT=1 → true', () => {
    enableTracingEnv()
    expect(realGate()).toBe(true)
  })

  test('OTEL_LOG_TOOL_CONTENT unset → false (official Iut)', () => {
    enableTracingEnv()
    delete process.env.OTEL_LOG_TOOL_CONTENT
    expect(realGate()).toBe(false)
  })

  test('OTEL_LOG_TOOL_CONTENT=0 → false (isEnvTruthy)', () => {
    enableTracingEnv()
    process.env.OTEL_LOG_TOOL_CONTENT = '0'
    expect(realGate()).toBe(false)
  })

  test('tracing disabled → false even with OTEL_LOG_TOOL_CONTENT=1', () => {
    enableTracingEnv()
    delete process.env.ENABLE_BETA_TRACING_DETAILED
    expect(realGate()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration: runToolUse emission (official query-engine block)
// ---------------------------------------------------------------------------

type CallLogEntry =
  | { kind: 'tool.output'; attrs: Record<string, string | number | boolean> }
  | { kind: 'endToolSpan' }

const callLog: CallLogEntry[] = []

const TRACING_MODULE_SPEC = '../../../utils/telemetry/sessionTracing.js'

mock.module(TRACING_MODULE_SPEC, () => ({
  ...actualTracing,
  addToolContentEvent: (
    eventName: string,
    attributes: Record<string, string | number | boolean>,
  ) => {
    if (eventName === 'tool.output') {
      callLog.push({ kind: 'tool.output', attrs: attributes })
    }
  },
  endToolSpan: () => {
    callLog.push({ kind: 'endToolSpan' })
  },
}))

let runToolUse: (typeof import('../toolExecution.js'))['runToolUse']

beforeAll(async () => {
  const mod = await import('../toolExecution.js')
  runToolUse = mod.runToolUse
})

afterAll(() => {
  // Restore the real module (OCC-97: mock.module leaks across files when
  // tests share a process; ci-test.sh isolates per file, but restore anyway).
  mock.module(TRACING_MODULE_SPEC, () => ({ ...actualTracing }))
})

import type { AssistantMessage } from 'src/types/message.js'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'

function makeFakeTool(opts: {  name: string
  mcpInfo?: { serverName: string; toolName: string }
  content: unknown
}): Tool {
  return {
    name: opts.name,
    mcpInfo: opts.mcpInfo,
    inputSchema: z.object({}),
    async call() {
      return { data: { ok: true } }
    },
    mapToolResultToToolResultBlockParam(_data: unknown, toolUseId: string) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: opts.content,
      }
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
    options: {
      tools: [tool],
      mcpClients: [],
      mainLoopModel: 'claude-opus-5',
      isNonInteractiveSession: true,
    },
  } as unknown as ToolUseContext
}

async function driveTool(tool: Tool): Promise<void> {
  const toolUse = { type: 'tool_use', id: 'tu_c2_1', name: tool.name, input: {} }
  const assistantMessage = {
    uuid: 'a-c2-1',
    requestId: undefined,
    message: { id: 'msg_c2_1', role: 'assistant', content: [toolUse] },
  } as unknown as AssistantMessage
  const canUseTool = (async () => ({
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'user', via: 'canUseTool' },
  })) as never
  for await (const _update of runToolUse(
    toolUse as never,
    assistantMessage,
    canUseTool,
    makeContext(tool),
  )) {
    // drain the generator
  }
}

describe('2.1.283 C2 — runToolUse tool.output emission', () => {
  beforeEach(() => {
    saveGateEnv()
    enableTracingEnv()
    callLog.length = 0
  })
  afterEach(restoreGateEnv)

  test('MCP tool (mcpInfo defined) → tool.output with flattened mapped content', async () => {
    const tool = makeFakeTool({
      name: 'mcp__srv__echo',
      mcpInfo: { serverName: 'srv', toolName: 'echo' },
      content: [
        { type: 'text', text: 'hello from mcp' },
        { type: 'image', source: {} },
      ],
    })
    await driveTool(tool)
    const outputs = callLog.filter(e => e.kind === 'tool.output')
    expect(outputs.length).toBe(1)
    expect(outputs[0].kind === 'tool.output' && outputs[0].attrs.output).toBe(
      'hello from mcp\n[image]',
    )
  })

  test('emission happens BEFORE endToolSpan (official 283 ordering: oTr then iPt)', async () => {
    const tool = makeFakeTool({
      name: 'mcp__srv__order',
      mcpInfo: { serverName: 'srv', toolName: 'order' },
      content: [{ type: 'text', text: 'x' }],
    })
    await driveTool(tool)
    const kinds = callLog.map(e => e.kind)
    const outIdx = kinds.indexOf('tool.output')
    const endIdx = kinds.indexOf('endToolSpan')
    expect(outIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThanOrEqual(0)
    expect(outIdx).toBeLessThan(endIdx)
  })

  test('WebFetch / WebSearch (official HQn set) → emitted without mcpInfo', async () => {
    // Pin the official Mr/uv string values.
    expect(WEB_FETCH_TOOL_NAME).toBe('WebFetch')
    expect(WEB_SEARCH_TOOL_NAME).toBe('WebSearch')
    for (const name of [WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME]) {
      callLog.length = 0
      const tool = makeFakeTool({
        name,
        content: [{ type: 'text', text: `${name} result` }],
      })
      await driveTool(tool)
      const outputs = callLog.filter(e => e.kind === 'tool.output')
      expect(outputs.length).toBe(1)
      expect(outputs[0].kind === 'tool.output' && outputs[0].attrs.output).toBe(
        `${name} result`,
      )
    }
  })

  test('builtin tool without mcpInfo → NOT emitted via the 283 path', async () => {
    const tool = makeFakeTool({
      name: 'Grep',
      content: [{ type: 'text', text: 'no matches' }],
    })
    await driveTool(tool)
    const outputs = callLog.filter(e => e.kind === 'tool.output')
    expect(outputs.length).toBe(0)
    // endToolSpan still ran — the tool completed normally
    expect(callLog.some(e => e.kind === 'endToolSpan')).toBe(true)
  })

  test('gate OFF (OTEL_LOG_TOOL_CONTENT unset) → nothing emitted', async () => {
    delete process.env.OTEL_LOG_TOOL_CONTENT
    const tool = makeFakeTool({
      name: 'mcp__srv__quiet',
      mcpInfo: { serverName: 'srv', toolName: 'quiet' },
      content: [{ type: 'text', text: 'secret-ish output' }],
    })
    await driveTool(tool)
    expect(callLog.filter(e => e.kind === 'tool.output').length).toBe(0)
  })

  test('string mapped content passes through the flattener verbatim', async () => {
    const tool = makeFakeTool({
      name: 'mcp__srv__str',
      mcpInfo: { serverName: 'srv', toolName: 'str' },
      content: 'raw string content',
    })
    await driveTool(tool)
    const outputs = callLog.filter(e => e.kind === 'tool.output')
    expect(outputs.length).toBe(1)
    expect(outputs[0].kind === 'tool.output' && outputs[0].attrs.output).toBe(
      'raw string content',
    )
  })
})
