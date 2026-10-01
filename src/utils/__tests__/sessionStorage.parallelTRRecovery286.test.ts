/**
 * CC 2.1.286 — port of the official `Bmr` recovery function
 * ("Fixed `claude --resume` / `--continue` sometimes losing every turn after
 * a batch of parallel tool calls when the earlier session crashed or was
 * killed").
 *
 * Byte-verified source: official v286 ELF code region 208294542–208301107
 * (canonical-identical in v285 at 207144795–207151360). These tests exercise
 * `recoverOrphanedParallelToolResults` through the exported
 * `buildConversationChain` entry point with crashed-session fixtures:
 *
 *  (a) tail orphaned tool_results (dangling parentUuid — source assistant
 *      link lost to the crash) are recovered by call-id re-anchoring and
 *      re-ordered by file position,
 *  (b) turns after the parallel batch are NOT lost (v285 bug repro),
 *  (c) telemetry: tengu_chain_parallel_tr_recovered gains
 *      `recovered_tail_count`; a new tengu_chain_tool_result_recovered_by_call_id
 *      event fires with `recovered_count` when the call-id pass recovers,
 *  (d) single-tool-call orphan recovery is unchanged (regression),
 *  plus: clean parallel batch reassembly, ambiguous call-id (two message.ids
 *  claim the same tool_use id → never re-anchored), and a no-op passthrough.
 *
 * Mock plumbing follows the OCC-97/129 convention (transcriptLoad276.test.ts).
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { randomUUID, type UUID } from 'crypto'

// ---------------------------------------------------------------------------
// Mock plumbing — installed BEFORE the module under test is imported so its
// live bindings resolve to the capture shim.
// ---------------------------------------------------------------------------

const actualAnalytics = await import('../../services/analytics/index.js')
const actualLogEvent = actualAnalytics.logEvent

const capturedEvents: Array<{
  name: string
  metadata: Record<string, boolean | number | undefined>
}> = []
let mockActive = true

mock.module('../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (
    name: string,
    metadata: Record<string, boolean | number | undefined>,
  ) => {
    if (!mockActive) {
      actualLogEvent(name, metadata as never)
      return
    }
    capturedEvents.push({ name, metadata })
  },
}))

afterAll(() => {
  // Leak guard: re-pin the REAL function reference captured pre-mock.
  mockActive = false
  mock.module('../../services/analytics/index.js', () => ({
    ...actualAnalytics,
    logEvent: actualLogEvent,
  }))
})

const { buildConversationChain } = await import('../sessionStorage.js')

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

const SESSION_ID = randomUUID()
let fileCounter = 0

function baseFields(): Record<string, unknown> {
  // Strictly increasing timestamps matching Map insertion (= file) order.
  fileCounter += 1
  return {
    cwd: '/tmp/occ-286-fixture',
    userType: 'external',
    sessionId: SESSION_ID,
    timestamp: `2026-09-28T00:00:${String(fileCounter).padStart(2, '0')}.000Z`,
    version: '2.1.286',
    isSidechain: false,
  }
}

type Fixture = {
  uuid: UUID
  timestamp: string
  row: Record<string, unknown>
}

function userRow(
  parentUuid: UUID | null,
  content: unknown = 'hi',
  extra: Record<string, unknown> = {},
): Fixture {
  const uuid = randomUUID()
  const base = baseFields()
  return {
    uuid,
    timestamp: base.timestamp as string,
    row: {
      ...base,
      type: 'user',
      uuid,
      parentUuid,
      message: { role: 'user', content },
      ...extra,
    },
  }
}

function assistantRow(
  parentUuid: UUID | null,
  msgId: string | undefined,
  content: unknown,
  extra: Record<string, unknown> = {},
): Fixture {
  const uuid = randomUUID()
  const base = baseFields()
  return {
    uuid,
    timestamp: base.timestamp as string,
    row: {
      ...base,
      type: 'assistant',
      uuid,
      parentUuid,
      message: { role: 'assistant', id: msgId, content },
      ...extra,
    },
  }
}

function attachmentRow(parentUuid: UUID | null): Fixture {
  const uuid = randomUUID()
  const base = baseFields()
  return {
    uuid,
    timestamp: base.timestamp as string,
    row: {
      ...base,
      type: 'attachment',
      uuid,
      parentUuid,
      attachment: { type: 'queued_command' },
      message: undefined,
    },
  }
}

function progressRow(parentUuid: UUID | null): Fixture {
  const uuid = randomUUID()
  const base = baseFields()
  return {
    uuid,
    timestamp: base.timestamp as string,
    row: {
      ...base,
      type: 'progress',
      uuid,
      parentUuid,
      data: {},
    },
  }
}

const toolUse = (id: string) => ({
  type: 'tool_use',
  id,
  name: 'Bash',
  input: { command: `echo ${id}` },
})
const toolResult = (toolUseId: string) => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content: `result of ${toolUseId}`,
})

/** Assemble fixtures into the messages Map — insertion order = file order. */
function toMessages(fixtures: Fixture[]): Map<UUID, never> {
  const messages = new Map()
  for (const f of fixtures) messages.set(f.uuid, f.row)
  return messages as Map<UUID, never>
}

function leafOf(fixtures: Fixture[]): never {
  return fixtures[fixtures.length - 1]!.row as never
}

function uuidsOf(chain: Array<{ uuid: UUID }>): UUID[] {
  return chain.map(m => m.uuid)
}

beforeEach(() => {
  capturedEvents.length = 0
  fileCounter = 0
})

function eventsNamed(name: string): Array<Record<string, boolean | number | undefined>> {
  return capturedEvents.filter(e => e.name === name).map(e => e.metadata)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildConversationChain — 2.1.286 parallel tool_result recovery', () => {
  test('(d) single tool call: orphaned tool_result recovered right after its assistant (regression, unchanged vs pre-286)', () => {
    // Legacy progress-fork shape: walk follows the progress child, drops the
    // tool_result child of the single-tool assistant.
    const u1 = userRow(null, 'run one thing')
    const a1 = assistantRow(u1.uuid, 'msg_1', [toolUse('t1')])
    const prog = progressRow(a1.uuid)
    const r1 = userRow(a1.uuid, [toolResult('t1')], {
      sourceToolAssistantUUID: a1.uuid,
    })
    const u2 = userRow(prog.uuid, 'thanks')

    const messages = toMessages([u1, a1, prog, r1, u2])
    const chain = buildConversationChain(messages, leafOf([u2]))

    // Walk alone yields [u1, a1, prog, u2]; recovery re-inserts r1 after a1.
    expect(uuidsOf(chain)).toEqual([u1.uuid, a1.uuid, r1.uuid, prog.uuid, u2.uuid])
    expect(eventsNamed('tengu_chain_parallel_tr_recovered')).toEqual([
      { recovered_count: 1, recovered_tail_count: 0 },
    ])
    expect(eventsNamed('tengu_chain_tool_result_recovered_by_call_id')).toEqual([])
  })

  test('clean parallel batch: orphaned sibling branch reassembled in file order', () => {
    // N parallel tool_uses → N assistants sharing message.id; each TR's
    // parentUuid points at its own one-block assistant, so the single-parent
    // walk keeps only the r2 branch and drops r1.
    const u1 = userRow(null, 'run two things')
    const a1 = assistantRow(u1.uuid, 'msg_1', [toolUse('t1')])
    const a2 = assistantRow(a1.uuid, 'msg_1', [toolUse('t2')])
    const r1 = userRow(a1.uuid, [toolResult('t1')], {
      sourceToolAssistantUUID: a1.uuid,
    })
    const r2 = userRow(a2.uuid, [toolResult('t2')], {
      sourceToolAssistantUUID: a2.uuid,
    })
    const u2 = userRow(r2.uuid, 'thanks')

    const messages = toMessages([u1, a1, a2, r1, r2, u2])
    const chain = buildConversationChain(messages, leafOf([u2]))

    expect(uuidsOf(chain)).toEqual([
      u1.uuid,
      a1.uuid,
      a2.uuid,
      r1.uuid,
      r2.uuid,
      u2.uuid,
    ])
    expect(eventsNamed('tengu_chain_parallel_tr_recovered')).toEqual([
      { recovered_count: 1, recovered_tail_count: 0 },
    ])
  })

  test('(a)+(b)+(c) crashed batch: dangling-parent tool_result re-anchored by call id, tail attachment recovered, turns after batch kept', () => {
    // Crash shape: the session was killed mid-batch. r2 landed on disk with a
    // parentUuid pointing at a record that never got written (dangling), and
    // its sourceToolAssistantUUID dangles too — only the call id (t2) ties it
    // back to sibling assistant a2. An attachment (att1) hangs off r1 and is
    // off-chain. The next turn (u2 → a3) was appended after the crash.
    const danglingUuid = randomUUID() // never written to the transcript
    const u1 = userRow(null, 'run two things')
    const a1 = assistantRow(u1.uuid, 'msg_1', [toolUse('t1')])
    const a2 = assistantRow(a1.uuid, 'msg_1', [toolUse('t2')])
    const r1 = userRow(a1.uuid, [toolResult('t1')], {
      sourceToolAssistantUUID: a1.uuid,
    })
    const att1 = attachmentRow(r1.uuid)
    const r2 = userRow(danglingUuid, [toolResult('t2')], {
      sourceToolAssistantUUID: danglingUuid,
    })
    const u2 = userRow(r1.uuid, 'keep going')
    const a3 = assistantRow(u2.uuid, 'msg_2', [
      { type: 'text', text: 'all done' },
    ])

    const messages = toMessages([u1, a1, a2, r1, att1, r2, u2, a3])
    const chain = buildConversationChain(messages, leafOf([a3]))

    // Walk alone yields [u1, a1, r1, u2, a3] — a2, att1 and r2 orphaned.
    // Recovery must re-anchor all three AND keep every turn after the batch.
    expect(uuidsOf(chain)).toEqual([
      u1.uuid,
      a1.uuid,
      a2.uuid, // off-chain sibling assistant
      r1.uuid,
      att1.uuid, // linear tail off r1
      r2.uuid, // call-id re-anchored TR
      u2.uuid, // turns after the batch NOT lost
      a3.uuid,
    ])

    // (c) telemetry — official props, exact names.
    expect(eventsNamed('tengu_chain_parallel_tr_recovered')).toEqual([
      { recovered_count: 2, recovered_tail_count: 1 },
    ])
    expect(eventsNamed('tengu_chain_tool_result_recovered_by_call_id')).toEqual([
      { recovered_count: 1 },
    ])
  })

  test('(b) crashed batch with fallback re-parent: chain through the recovered TR keeps every turn', () => {
    // Crash variant: r2 survived with parentUuid fallen back to a1 (its real
    // source assistant a2 was linked only via sourceToolAssistantUUID), and
    // the next turn hangs off r2. v285-era recovery could lose the batch
    // order; the 286 port must return the full conversation.
    const u1 = userRow(null, 'run two things')
    const a1 = assistantRow(u1.uuid, 'msg_1', [toolUse('t1')])
    const a2 = assistantRow(a1.uuid, 'msg_1', [toolUse('t2')])
    const r1 = userRow(a1.uuid, [toolResult('t1')], {
      sourceToolAssistantUUID: a1.uuid,
    })
    const r2 = userRow(a1.uuid, [toolResult('t2')], {
      sourceToolAssistantUUID: a2.uuid,
    })
    const u2 = userRow(r2.uuid, 'keep going')
    const a3 = assistantRow(u2.uuid, 'msg_2', [
      { type: 'text', text: 'all done' },
    ])

    const messages = toMessages([u1, a1, a2, r1, r2, u2, a3])
    const chain = buildConversationChain(messages, leafOf([a3]))

    // Walk alone yields [u1, a1, r2, u2, a3] — a2 and r1 orphaned.
    expect(uuidsOf(chain)).toEqual([
      u1.uuid,
      a1.uuid,
      a2.uuid,
      r1.uuid,
      r2.uuid,
      u2.uuid,
      a3.uuid,
    ])
    expect(eventsNamed('tengu_chain_parallel_tr_recovered')).toEqual([
      { recovered_count: 2, recovered_tail_count: 0 },
    ])
    // r2 was already on-chain → the call-id re-anchor pass did not fire.
    expect(eventsNamed('tengu_chain_tool_result_recovered_by_call_id')).toEqual([])
  })

  test('ambiguous call id (two message.ids claim the same tool_use id) is never re-anchored', () => {
    // Official `he` map: a call id claimed by assistants with different
    // message.id collapses to null → the dangling TR stays unrecovered
    // (no guess), but the rest of the batch still recovers.
    const danglingUuid = randomUUID()
    const u1 = userRow(null, 'run two things')
    const a1 = assistantRow(u1.uuid, 'msg_1', [toolUse('t1')])
    const a2 = assistantRow(a1.uuid, 'msg_1', [toolUse('t2')])
    const aX = assistantRow(u1.uuid, 'msg_9', [toolUse('t2')]) // conflicting emitter
    const r1 = userRow(a1.uuid, [toolResult('t1')], {
      sourceToolAssistantUUID: a1.uuid,
    })
    const r2 = userRow(danglingUuid, [toolResult('t2')], {
      sourceToolAssistantUUID: danglingUuid,
    })
    const u2 = userRow(r1.uuid, 'keep going')
    const a3 = assistantRow(u2.uuid, 'msg_2', [
      { type: 'text', text: 'all done' },
    ])

    const messages = toMessages([u1, a1, a2, aX, r1, r2, u2, a3])
    const chain = buildConversationChain(messages, leafOf([a3]))

    // a2 recovered as off-chain sibling; r2 NOT recovered (ambiguous t2);
    // aX belongs to an unrelated message.id group untouched by the chain.
    expect(uuidsOf(chain)).toEqual([
      u1.uuid,
      a1.uuid,
      a2.uuid,
      r1.uuid,
      u2.uuid,
      a3.uuid,
    ])
    expect(chain.some(m => m.uuid === r2.uuid)).toBe(false)
    expect(eventsNamed('tengu_chain_parallel_tr_recovered')).toEqual([
      { recovered_count: 1, recovered_tail_count: 0 },
    ])
    expect(eventsNamed('tengu_chain_tool_result_recovered_by_call_id')).toEqual([])
  })

  test('clean transcript without tool calls passes through untouched with no telemetry', () => {
    const u1 = userRow(null, 'hello')
    const a1 = assistantRow(u1.uuid, 'msg_1', [{ type: 'text', text: 'hi' }])
    const u2 = userRow(a1.uuid, 'bye')
    const a2 = assistantRow(u2.uuid, 'msg_2', [{ type: 'text', text: 'bye' }])

    const messages = toMessages([u1, a1, u2, a2])
    const chain = buildConversationChain(messages, leafOf([a2]))

    expect(uuidsOf(chain)).toEqual([u1.uuid, a1.uuid, u2.uuid, a2.uuid])
    expect(capturedEvents).toEqual([])
  })

  test('sidechain tool_result is not re-anchored into the main chain', () => {
    // Official `W` gate: re-linking requires identical isSidechain + agentId.
    // A subagent's dangling TR must not leak into the main-thread chain.
    const danglingUuid = randomUUID()
    const u1 = userRow(null, 'run two things')
    const a1 = assistantRow(u1.uuid, 'msg_1', [toolUse('t1')])
    const a2 = assistantRow(a1.uuid, 'msg_1', [toolUse('t2')])
    const r1 = userRow(a1.uuid, [toolResult('t1')], {
      sourceToolAssistantUUID: a1.uuid,
    })
    const r2Sidechain = userRow(danglingUuid, [toolResult('t2')], {
      sourceToolAssistantUUID: danglingUuid,
      isSidechain: true,
      agentId: 'agent-xyz',
    })
    const u2 = userRow(r1.uuid, 'keep going')

    const messages = toMessages([u1, a1, a2, r1, r2Sidechain, u2])
    const chain = buildConversationChain(messages, leafOf([u2]))

    expect(chain.some(m => m.uuid === r2Sidechain.uuid)).toBe(false)
    expect(uuidsOf(chain)).toEqual([
      u1.uuid,
      a1.uuid,
      a2.uuid,
      r1.uuid,
      u2.uuid,
    ])
    expect(eventsNamed('tengu_chain_tool_result_recovered_by_call_id')).toEqual([])
  })
})
