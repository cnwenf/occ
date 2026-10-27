// Polyfill (repo convention — see structuredOutputIsError291.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'

/**
 * CC 2.1.311 (item 9 @277223400) — the print-path (`claude -p`/SDK) must
 * retract a tombstoned message from the PERSISTED transcript, mirroring the
 * REPL (REPL.tsx:2888-2889 `void removeTranscriptMessage(uuid)`).
 *
 * Official v311 `Ze(Ct)` (byte-verified @277223400):
 *   ...n.splice(It,1),...a("tengu_tombstone_persisted_removal",{message_type:c(_n.type)});
 *   let Yt=K();rFr(async()=>{$dn(Ct,s,Yt).catch(l)})
 * i.e. emit `tengu_tombstone_persisted_removal {message_type}` then route the
 * removal through the serialized writer `rFr` = `inCallOrder(...)`.
 *
 * OCC adaptation (documented): OCC emits the event + fires the removal
 * unconditionally when the tombstone carries a uuid (per the triage action +
 * the REPL mirror), rather than gating on the official's in-memory-list index
 * (`C>It`) which OCC's print path does not track the same way. The removal
 * itself is serialized by sessionStorage's `inCallOrder` (see
 * sessionStorageInCallOrder311.test.ts).
 *
 * These tests drive the REAL QueryEngine turn loop through a mocked `query()`
 * generator (the only network path) — harness: structuredOutputIsError291.
 */

// ---------------------------------------------------------------------------
// Mocks — installed BEFORE QueryEngine is imported so its bindings resolve to
// the fakes. Each spreads the real module so unrelated exports stay intact.
// ---------------------------------------------------------------------------
type ScriptedMessage = Record<string, unknown>
let script: ScriptedMessage[] = []
let terminalReason: string | undefined = 'completed'

const realQueryModule = await import('../../src/query.js')
mock.module('../../src/query.js', () => ({
  ...realQueryModule,
  query: async function* fakeQuery(): AsyncGenerator<
    ScriptedMessage,
    { reason?: string } | undefined
  > {
    for (const message of script) {
      yield message
    }
    return terminalReason === undefined ? undefined : { reason: terminalReason }
  },
}))

const realSessionStorage = await import('../../src/utils/sessionStorage.js')
const removeTranscriptMessageSpy = mock(async (_uuid: string) => {})
mock.module('../../src/utils/sessionStorage.js', () => ({
  ...realSessionStorage,
  removeTranscriptMessage: removeTranscriptMessageSpy,
}))

const realAnalytics = await import('../../src/services/analytics/index.js')
const logEventSpy = mock((_name: string, _meta?: Record<string, unknown>) => {})
mock.module('../../src/services/analytics/index.js', () => ({
  ...realAnalytics,
  logEvent: logEventSpy,
}))

const { QueryEngine } = await import('../../src/QueryEngine.js')
type QueryEngineConfig = import('../../src/QueryEngine.js').QueryEngineConfig
const { setSessionPersistenceDisabled } = await import(
  '../../src/bootstrap/state.js'
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

function baseFields(): Record<string, unknown> {
  return {
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/tmp',
    sessionId: 'test-session',
    version: '2.1.311',
    timestamp: '2026-10-28T00:00:00.000Z',
  }
}

function assistantRow(content: unknown[], stopReason: string | null): ScriptedMessage {
  return {
    ...baseFields(),
    type: 'assistant',
    costUSD: 0,
    durationMs: 0,
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: USAGE,
    },
  }
}

/** A tombstone control signal wrapping the message being retracted. */
function tombstoneFor(retracted: ScriptedMessage): ScriptedMessage {
  return { type: 'tombstone', message: retracted }
}

function makeEngine(): QueryEngine {
  const appState = {
    mcp: { clients: [] },
    tasks: [],
    fastMode: false,
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: [],
      alwaysDenyRules: [],
      alwaysAskRules: [],
    },
  }
  const config = {
    cwd: '/tmp',
    commands: [],
    tools: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({
      behavior: 'allow' as const,
      updatedInput: undefined,
      state: {},
    }),
    getAppState: () => appState as never,
    setAppState: () => {},
    readFileCache: new Map(),
  } as unknown as QueryEngineConfig
  return new QueryEngine(config)
}

async function drain(engine: QueryEngine): Promise<ScriptedMessage[]> {
  const seen: ScriptedMessage[] = []
  for await (const msg of engine.submitMessage('go')) {
    seen.push(msg as unknown as ScriptedMessage)
  }
  return seen
}

beforeAll(() => {
  setSessionPersistenceDisabled(true)
})

afterAll(() => {
  setSessionPersistenceDisabled(false)
})

afterEach(() => {
  script = []
  terminalReason = 'completed'
  removeTranscriptMessageSpy.mockClear()
  logEventSpy.mockClear()
})

// ---------------------------------------------------------------------------

describe('CC 2.1.311 item 9 — print-path tombstone retraction', () => {
  test('a tombstone triggers removeTranscriptMessage with the retracted uuid', async () => {
    const retracted = assistantRow([{ type: 'text', text: 'orphaned' }], 'end_turn')
    const retractedUuid = retracted.uuid as string
    script = [
      assistantRow([{ type: 'text', text: 'kept' }], 'end_turn'),
      tombstoneFor(retracted),
    ]

    await drain(makeEngine())

    expect(removeTranscriptMessageSpy).toHaveBeenCalledTimes(1)
    expect(removeTranscriptMessageSpy).toHaveBeenCalledWith(retractedUuid)
  })

  test('a tombstone emits tengu_tombstone_persisted_removal with message_type', async () => {
    const retracted = assistantRow([{ type: 'text', text: 'orphaned' }], 'end_turn')
    script = [tombstoneFor(retracted)]

    await drain(makeEngine())

    const call = logEventSpy.mock.calls.find(
      c => c[0] === 'tengu_tombstone_persisted_removal',
    )
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual(
      expect.objectContaining({ message_type: 'assistant' }),
    )
  })

  test('the tombstone control signal never surfaces as a yielded message', async () => {
    const retracted = assistantRow([{ type: 'text', text: 'orphaned' }], 'end_turn')
    script = [
      assistantRow([{ type: 'text', text: 'kept' }], 'end_turn'),
      tombstoneFor(retracted),
    ]

    const seen = await drain(makeEngine())

    expect(seen.some(m => m.type === 'tombstone')).toBe(false)
  })

  test('a tombstone with no uuid is skipped (no removal, no telemetry)', async () => {
    script = [{ type: 'tombstone', message: { type: 'assistant' } }]

    await drain(makeEngine())

    expect(removeTranscriptMessageSpy).not.toHaveBeenCalled()
    expect(
      logEventSpy.mock.calls.some(
        c => c[0] === 'tengu_tombstone_persisted_removal',
      ),
    ).toBe(false)
  })
})
