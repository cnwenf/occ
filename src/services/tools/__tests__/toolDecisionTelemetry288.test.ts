/**
 * CC 2.1.288 #31/#32 — headless `tool_decision` telemetry + span-end fallback,
 * byte-verified against the official v2.1.288 linux-x64 ELF.
 *
 * #32 — the v287 emit gate `vn.behavior!=="ask" && !s.toolDecisions.has(n)`
 *   (@207737973) lost its ask clause in v288: `if(!s.toolDecisions.has(n))`
 *   (@208843664). 'ask' outcomes now emit `tool_decision` too.
 *
 * #31 — v287's span-end fallbacks were the literal `"unknown"`:
 *     deny/ask: `Upn("reject",gr?.source||"unknown")`
 *     allow   : `Upn(ao?.decision||"unknown",ao?.source||"unknown")` (@207742786)
 *   v288 replaced them with the Aho-computed `mo` pair:
 *     deny/ask: `Ymn("reject",er?.source||mo.source)` (@208844295)
 *     allow   : `Ymn(wo?.decision||mo.decision,wo?.source||mo.source)` (@208848426)
 *   where `mo=Aho(zn,s.abortController.signal.aborted)` is computed ONCE before
 *   the emit gate. `er`/`wo` are `s.toolDecisions.get(n)`.
 *
 * OCC divergence preserved (CC 2.1.216 #29): the deny/ask span-end decision is
 * `isAbort ? 'abort' : 'reject'` (official literal is always "reject"), and a
 * failed/interrupted SDK prompt request maps to source `user_abort`.
 *
 * Integration harness mirrors mcpToolOutputOtel283.test.ts: drive the real
 * `runToolUse` generator with a fake tool + fake `canUseTool`, capturing the
 * `tool_decision` OTel event (events.js seam) and the `endToolBlockedOnUserSpan`
 * arguments (sessionTracing.js seam).
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

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill before toolExecution.js loads.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const actualTracing = await import('../../../utils/telemetry/sessionTracing.js')
const actualTracingExports = { ...actualTracing }
const actualEvents = await import('../../../utils/telemetry/events.js')
const actualEventsExports = { ...actualEvents }

type SpanEnd = { decision?: string; source?: string }
type OtelCall = { name: string; attrs: Record<string, string | undefined> }
const spanEnds: SpanEnd[] = []
const otelCalls: OtelCall[] = []

const TRACING_SPEC = '../../../utils/telemetry/sessionTracing.js'
const EVENTS_SPEC = '../../../utils/telemetry/events.js'

mock.module(TRACING_SPEC, () => ({
  ...actualTracingExports,
  endToolBlockedOnUserSpan: (decision?: string, source?: string): void => {
    spanEnds.push({ decision, source })
  },
}))

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
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'

type StoredDecision = {
  source: string
  decision: 'accept' | 'reject' | 'abort'
  timestamp: number
}

function makeFakeTool(name: string): Tool {
  return {
    name,
    inputSchema: z.object({}),
    async call() {
      return { data: { ok: true } }
    },
    mapToolResultToToolResultBlockParam(_data: unknown, toolUseId: string) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: () => name,
  } as unknown as Tool
}

function makeContext(
  tool: Tool,
  toolDecisions?: Map<string, StoredDecision>,
): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    abortController: new AbortController(),
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => appState,
    toolDecisions,
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
    uuid: 'a-288-1',
    requestId: undefined,
    message: { id: 'msg_288_1', role: 'assistant', content: [toolUse] },
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

function toolDecisionEvents(): OtelCall[] {
  return otelCalls.filter(c => c.name === 'tool_decision')
}

beforeEach(() => {
  spanEnds.length = 0
  otelCalls.length = 0
})

// ---------------------------------------------------------------------------
// #32 — 'ask' outcomes now emit tool_decision (the v287 ask gate is gone)
// ---------------------------------------------------------------------------

describe('CC 2.1.288 #32 — ask emits tool_decision', () => {
  test('ask (not aborted) → tool_decision {decision:"reject", source:"config"}', async () => {
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool)
    await drive(ctx, tool, 'tu_ask_1', () => ({
      behavior: 'ask',
      message: 'needs approval',
    }))
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.decision).toBe('reject')
    expect(events[0].attrs.source).toBe('config')
  })

  test('ask aborted mid-prompt → tool_decision source "user_abort" (abort flag is read from the signal, not hardcoded)', async () => {
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool)
    await drive(ctx, tool, 'tu_ask_2', c => {
      // Model a user interrupt landing while the permission prompt is open:
      // the official reads `s.abortController.signal.aborted` into Aho AFTER
      // the decision resolves.
      ;(c.abortController as AbortController).abort()
      return { behavior: 'ask', message: 'needs approval' }
    })
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs.decision).toBe('reject')
    expect(events[0].attrs.source).toBe('user_abort')
  })

  test('ask span-end falls back to the Aho source ("config"), not "unknown" (#31 on the ask path)', async () => {
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool)
    await drive(ctx, tool, 'tu_ask_3', () => ({
      behavior: 'ask',
      message: 'needs approval',
    }))
    expect(spanEnds).toHaveLength(1)
    expect(spanEnds[0]).toEqual({ decision: 'reject', source: 'config' })
  })
})

// ---------------------------------------------------------------------------
// #31 — span-ends fall back to the Aho-computed pair instead of "unknown"
// ---------------------------------------------------------------------------

describe('CC 2.1.288 #31 — span-end fallback (deny)', () => {
  test('deny with a session rule → span-end ("reject","user_reject"), NOT "unknown"', async () => {
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool)
    await drive(ctx, tool, 'tu_deny_1', () => ({
      behavior: 'deny',
      message: 'denied by rule',
      decisionReason: { type: 'rule', rule: { source: 'session' } },
    }))
    expect(spanEnds).toHaveLength(1)
    expect(spanEnds[0]).toEqual({ decision: 'reject', source: 'user_reject' })
    // The deny also emits tool_decision (behavior !== 'ask' — unchanged).
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs).toMatchObject({
      decision: 'reject',
      source: 'user_reject',
    })
  })

  test('CC 2.1.216 #29 preserved: SDK prompt abort → span-end decision "abort", source "user_abort"', async () => {
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool)
    await drive(ctx, tool, 'tu_deny_2', () => ({
      behavior: 'deny',
      message: 'aborted',
      decisionReason: {
        type: 'permissionPromptTool',
        permissionPromptToolName: 'mcp__host__approve',
        toolResult: undefined,
      },
    }))
    expect(spanEnds).toHaveLength(1)
    // #29: an interrupted/failed prompt request is an ABORT, not a rejection.
    expect(spanEnds[0]).toEqual({ decision: 'abort', source: 'user_abort' })
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs).toMatchObject({
      decision: 'abort',
      source: 'user_abort',
    })
  })
})

describe('CC 2.1.288 #31 — span-end fallback (allow)', () => {
  test('allow with a session rule → span-end ("accept","user_temporary"), NOT "unknown"', async () => {
    const tool = makeFakeTool('Grep')
    const ctx = makeContext(tool)
    await drive(ctx, tool, 'tu_allow_1', () => ({
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'rule', rule: { source: 'session' } },
    }))
    expect(spanEnds).toHaveLength(1)
    expect(spanEnds[0]).toEqual({ decision: 'accept', source: 'user_temporary' })
    const events = toolDecisionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].attrs).toMatchObject({
      decision: 'accept',
      source: 'user_temporary',
    })
  })
})

// ---------------------------------------------------------------------------
// Precedence — a stored toolDecisions entry wins over the Aho fallback, and its
// presence suppresses the headless emit (the interactive path already logged).
// ---------------------------------------------------------------------------

describe('CC 2.1.288 #31 — toolDecisions precedence', () => {
  test('stored decision wins over the Aho fallback and suppresses the emit', async () => {
    const tool = makeFakeTool('Grep')
    const stored: StoredDecision = {
      decision: 'accept',
      source: 'user_permanent',
      timestamp: Date.now(),
    }
    const ctx = makeContext(tool, new Map([['tu_prec_1', stored]]))
    await drive(ctx, tool, 'tu_prec_1', () => ({
      behavior: 'allow',
      updatedInput: {},
      // Aho would map a session allow to user_temporary — the stored
      // user_permanent MUST win.
      decisionReason: { type: 'rule', rule: { source: 'session' } },
    }))
    expect(spanEnds).toHaveLength(1)
    expect(spanEnds[0]).toEqual({
      decision: 'accept',
      source: 'user_permanent',
    })
    // Gate `!toolDecisions.has(id)` is false → no headless tool_decision emit.
    expect(toolDecisionEvents()).toHaveLength(0)
  })
})
