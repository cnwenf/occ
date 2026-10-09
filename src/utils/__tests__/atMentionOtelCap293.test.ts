import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.293 changelog entry #47 — OTEL/telemetry `claude_code.at_mention` cap.
 * (docs/gap-research-293/triage-293.md §47; official vver @~216024405.)
 *
 * Official adds a shared per-resolver cap `q5e = 100` plus two helpers applied
 * verbatim across the at_mention emit region:
 *
 *   var q5e=100;
 *   function Ix(e,n,r){if(e>=q5e)return;
 *     if(n==="agent")i(r?"tengu_at_mention_agent_success":"tengu_at_mention_agent_not_found",{});
 *     else i(r?"tengu_at_mention_mcp_resource_success":"tengu_at_mention_mcp_resource_error",{});
 *     xX({mentionType:n,success:r})}
 *   function Xfn(e,n){if(n>q5e)i("tengu_at_mention_unreported",{mention_type:d(e),count:n-q5e})}
 *
 * Semantics: the cap is INDEX-based (`index >= 100` → no emit); `Ix` gates BOTH
 * the statsig event and the OTEL emit; `Xfn` reports overflow ONCE per resolver
 * call with `count = length-100`, only when `length > 100`. File/directory
 * mention emits are untouched.
 */

type EventCall = { name: string; meta: Record<string, unknown> }
type OtelCall = { event: string; attrs: Record<string, unknown> }

const eventCalls: EventCall[] = []
const otelCalls: OtelCall[] = []

const actualAnalytics = await import('../../services/analytics/index.js')
const actualTelemetry = await import('../telemetry/events.js')

mock.module('../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, meta: Record<string, unknown>) => {
    eventCalls.push({ name, meta })
  },
}))
mock.module('../telemetry/events.js', () => ({
  ...actualTelemetry,
  logOTelEvent: (event: string, attrs: Record<string, unknown>) => {
    otelCalls.push({ event, attrs })
    return Promise.resolve()
  },
}))

const {
  AT_MENTION_OTEL_CAP,
  emitAtMentionForTesting,
  reportAtMentionOverflowForTesting,
  processAgentMentionsForTesting,
  processMcpResourceAttachmentsForTesting,
} = await import('../attachments.js')

afterAll(() => {
  // Bun's mock.module leaks across test files in the same worker (OCC-97) —
  // restore the real analytics/telemetry modules.
  mock.module('../../services/analytics/index.js', () => ({ ...actualAnalytics }))
  mock.module('../telemetry/events.js', () => ({ ...actualTelemetry }))
})

beforeEach(() => {
  eventCalls.length = 0
  otelCalls.length = 0
})

const CAP = 100

function countEvents(name: string): number {
  return eventCalls.filter(e => e.name === name).length
}
function unreportedEvents(): EventCall[] {
  return eventCalls.filter(e => e.name === 'tengu_at_mention_unreported')
}
function otelAtMention(): OtelCall[] {
  return otelCalls.filter(o => o.event === 'at_mention')
}

function agentInput(n: number): string {
  return Array.from({ length: n }, (_, i) => `@agent-t${i}`).join(' ')
}
function mcpInput(n: number): string {
  return Array.from({ length: n }, (_, i) => `@s:r${i}`).join(' ')
}
function agentDefs(n: number): Array<{ agentType: string }> {
  return Array.from({ length: n }, (_, i) => ({ agentType: `t${i}` }))
}
function mcpContext(): ToolUseContext {
  return {
    options: { mcpClients: [], tools: [], mainLoopModel: 'claude-opus-5' },
    abortController: new AbortController(),
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

describe('CC 2.1.293 #47 — verbatim constant/helper shapes', () => {
  test('AT_MENTION_OTEL_CAP is the official q5e=100', () => {
    expect(AT_MENTION_OTEL_CAP).toBe(100)
  })
})

describe('CC 2.1.293 #47 — Ix (emitAtMention) index gate', () => {
  test('index < cap fires statsig + OTEL together (agent success)', () => {
    emitAtMentionForTesting(99, 'agent', true)
    expect(countEvents('tengu_at_mention_agent_success')).toBe(1)
    expect(countEvents('tengu_at_mention_agent_not_found')).toBe(0)
    const otel = otelAtMention()
    expect(otel.length).toBe(1)
    expect(otel[0]?.attrs).toEqual({ mention_type: 'agent', success: 'true' })
  })

  test('index >= cap fires NEITHER statsig NOR OTEL (agent)', () => {
    emitAtMentionForTesting(100, 'agent', true)
    emitAtMentionForTesting(150, 'agent', false)
    expect(eventCalls.length).toBe(0)
    expect(otelCalls.length).toBe(0)
  })

  test('agent not_found branch name', () => {
    emitAtMentionForTesting(0, 'agent', false)
    expect(countEvents('tengu_at_mention_agent_not_found')).toBe(1)
    expect(countEvents('tengu_at_mention_agent_success')).toBe(0)
    expect(otelAtMention()[0]?.attrs).toEqual({
      mention_type: 'agent',
      success: 'false',
    })
  })

  test('mcp_resource success/error branch names', () => {
    emitAtMentionForTesting(5, 'mcp_resource', true)
    expect(countEvents('tengu_at_mention_mcp_resource_success')).toBe(1)
    emitAtMentionForTesting(6, 'mcp_resource', false)
    expect(countEvents('tengu_at_mention_mcp_resource_error')).toBe(1)
    expect(otelAtMention().length).toBe(2)
  })

  test('index >= cap fires nothing for mcp_resource either', () => {
    emitAtMentionForTesting(100, 'mcp_resource', true)
    expect(eventCalls.length).toBe(0)
    expect(otelCalls.length).toBe(0)
  })
})

describe('CC 2.1.293 #47 — Xfn (reportAtMentionOverflow)', () => {
  test('count <= cap → no unreported event', () => {
    reportAtMentionOverflowForTesting('agent', 100)
    reportAtMentionOverflowForTesting('mcp_resource', 50)
    expect(unreportedEvents().length).toBe(0)
  })

  test('count = cap+1 → one unreported with count 1', () => {
    reportAtMentionOverflowForTesting('agent', 101)
    const u = unreportedEvents()
    expect(u.length).toBe(1)
    expect(u[0]?.meta).toEqual({ mention_type: 'agent', count: 1 })
  })

  test('count 150 mcp → unreported {mention_type:mcp_resource, count:50}', () => {
    reportAtMentionOverflowForTesting('mcp_resource', 150)
    const u = unreportedEvents()
    expect(u.length).toBe(1)
    expect(u[0]?.meta).toEqual({ mention_type: 'mcp_resource', count: 50 })
  })
})

describe('CC 2.1.293 #47 — processAgentMentions resolver (2 emit pairs)', () => {
  test('exactly 100 mentions → 100 emits, no overflow', () => {
    const out = processAgentMentionsForTesting(agentInput(100), agentDefs(100))
    expect(out.length).toBe(100)
    expect(countEvents('tengu_at_mention_agent_success')).toBe(100)
    expect(unreportedEvents().length).toBe(0)
    expect(otelAtMention().length).toBe(100)
  })

  test('150 mentions → exactly 100 emits + one unreported {agent, count:50}', () => {
    const out = processAgentMentionsForTesting(agentInput(150), agentDefs(150))
    // Attachments themselves are NOT capped — only the telemetry is.
    expect(out.length).toBe(150)
    expect(countEvents('tengu_at_mention_agent_success')).toBe(CAP)
    expect(unreportedEvents().length).toBe(1)
    expect(unreportedEvents()[0]?.meta).toEqual({
      mention_type: 'agent',
      count: 50,
    })
    expect(otelAtMention().length).toBe(CAP)
  })

  test('mixed found/not_found within first 100 keeps per-mention names', () => {
    // 10 mentions; only even indices resolve → 5 success + 5 not_found.
    const defs = Array.from({ length: 5 }, (_, i) => ({
      agentType: `t${i * 2}`,
    }))
    processAgentMentionsForTesting(agentInput(10), defs)
    expect(countEvents('tengu_at_mention_agent_success')).toBe(5)
    expect(countEvents('tengu_at_mention_agent_not_found')).toBe(5)
    expect(unreportedEvents().length).toBe(0)
  })

  test('index >= cap emits neither statsig nor OTEL even when found', () => {
    // 105 mentions: indices 100..104 resolve but must stay silent.
    processAgentMentionsForTesting(agentInput(105), agentDefs(105))
    expect(countEvents('tengu_at_mention_agent_success')).toBe(CAP)
    expect(otelAtMention().length).toBe(CAP)
    expect(unreportedEvents()[0]?.meta).toEqual({
      mention_type: 'agent',
      count: 5,
    })
  })
})

describe('CC 2.1.293 #47 — processMcpResourceAttachments resolver (6 emit pairs)', () => {
  test('100 mentions → 100 emits, no overflow', async () => {
    await processMcpResourceAttachmentsForTesting(mcpInput(100), mcpContext())
    // No connected clients → every mention hits an mcp_resource_error path.
    expect(countEvents('tengu_at_mention_mcp_resource_error')).toBe(100)
    expect(unreportedEvents().length).toBe(0)
    expect(otelAtMention().length).toBe(100)
  })

  test('150 mentions → exactly 100 emits + one unreported {mcp_resource, count:50}', async () => {
    await processMcpResourceAttachmentsForTesting(mcpInput(150), mcpContext())
    expect(countEvents('tengu_at_mention_mcp_resource_error')).toBe(CAP)
    expect(unreportedEvents().length).toBe(1)
    expect(unreportedEvents()[0]?.meta).toEqual({
      mention_type: 'mcp_resource',
      count: 50,
    })
    expect(otelAtMention().length).toBe(CAP)
  })
})
