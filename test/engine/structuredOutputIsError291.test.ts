// Polyfill (repo convention — see structuredOutputsEnvGate287.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'

/**
 * CC 2.1.290/291 (cluster-f item C) — `--json-schema` headless run must exit
 * 0 (not `is_error:true`) when the turn-ending tool already delivered and the
 * connection then dropped, leaving a trailing API-error notice as the last
 * assistant row.
 *
 * Official mechanism (recovered verbatim from the 2.1.290 linux-x64 ELF;
 * byte-identical in 2.1.291 — `tengu_trailing_api_error_notice_skipped` has
 * 0 hits in cc289 and 2 in cc290, so the fix is new in 2.1.290):
 *
 *   function yOo({trailing:e,preceding:s,terminalReason:n,retractionExhausted:r}){
 *     return e?.type==="assistant"&&e.isApiErrorMessage===!0&&e.error==="server_error"
 *       &&n==="completed"&&!r&&s!==void 0&&uht(s)&&ehn(s)!==!1}          @217856370
 *   function uht(e){if(e.type!=="user")return!1;let n=e.message.content;
 *     if(!Array.isArray(n)||n.length===0)return!1;
 *     return n.every(r=>typeof r==="object"&&r!==null&&"type"in r&&r.type==="tool_result")}
 *                                                                       @214392263
 *   var KKt="claude/endTurn";function VKt(e){return e?._meta?.[KKt]===!0}
 *   function ehn(e){if(e.type!=="user")return!1;
 *     let n=e.toolEndsTurn?"tool":VKt(e.mcpMeta)?"mcp_meta":!1;if(!n)return!1;
 *     let r=e.message.content;
 *     if(Array.isArray(r)&&r.some(s=>s.type==="tool_result"&&s.is_error===!0))return!1;
 *     return n}                                                          @212200012
 *
 *   call site: if(et&&yOo({trailing:qt,preceding:pt.at(-2),terminalReason:kt,
 *     retractionExhausted:gt.length===0&&Wt.size>0}))
 *     et=!1,Ft=null,Mt=void 0,It=void 0,Ut="",ct="tool_use",
 *     i("tengu_trailing_api_error_notice_skipped",{engine:_("session_engine"),
 *       has_structured_output:gt.length>0})
 *   let os=et?Ut:Ct; if(os===""){let W=gt.at(-1)?.data;if(W!==void 0)os=JSON.stringify(W)}
 *
 * So the skip is NARROW: every one of these must hold —
 *   trailing row is an assistant `isApiErrorMessage` with `error==="server_error"`
 *   (the partial-finalize path in claude.ts; a mid-stream drop),
 *   the query generator returned `{reason:"completed"}` (not aborted),
 *   the row immediately before it is an all-`tool_result` user row, and that
 *   row ended the turn (`toolEndsTurn`, or MCP `_meta["claude/endTurn"]`)
 *   with no errored tool_result in it.
 * Structured-output delivery alone is NOT sufficient — the controls below pin
 * each clause. These tests drive the REAL QueryEngine turn loop through a
 * mocked `query()` generator (the only network path) and assert the actual
 * yielded result envelope, which is what src/cli/print.ts turns into the
 * process exit code (`lastMessage.is_error ? 1 : 0`).
 */

// ---------------------------------------------------------------------------
// Mock query() — script-driven message generator with a configurable terminal
// reason (`kt` in the official call site). Must be installed BEFORE
// QueryEngine is imported so its `query` binding resolves to the fake.
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

const { QueryEngine } = await import('../../src/QueryEngine.js')
type QueryEngineConfig = import('../../src/QueryEngine.js').QueryEngineConfig
const { setSessionPersistenceDisabled } = await import(
  '../../src/bootstrap/state.js'
)
const { createAssistantAPIErrorMessage } = await import(
  '../../src/utils/messages.js'
)
const { SYNTHETIC_OUTPUT_TOOL_NAME } = await import(
  '../../src/tools/SyntheticOutputTool/SyntheticOutputTool.js'
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
    version: '2.1.291',
    timestamp: '2026-10-07T00:00:00.000Z',
  }
}

function assistantRow(
  content: unknown[],
  stopReason: string | null,
): ScriptedMessage {
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

function userRow(
  content: unknown[],
  extra: Record<string, unknown> = {},
): ScriptedMessage {
  return {
    ...baseFields(),
    type: 'user',
    ...extra,
    message: { role: 'user', content },
  }
}

function toolUseBlock(id: string, name: string, input: unknown) {
  return { type: 'tool_use', id, name, input }
}

function toolResultBlock(
  toolUseId: string,
  content: string,
  isError = false,
) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    ...(isError ? { is_error: true } : {}),
  }
}

/**
 * The trailing row: an assistant API-error notice. Built with the REAL
 * factory so `isApiErrorMessage`/`error`/`stop_reason` match what
 * src/services/api/claude.ts emits on the partial-finalize (mid-stream drop)
 * path — that path is the only one that stamps `error:'server_error'`.
 */
function apiErrorAssistant(
  error: 'server_error' | 'invalid_request' | 'unknown',
): ScriptedMessage {
  return createAssistantAPIErrorMessage({
    content: 'API Error: Connection dropped while streaming the response.',
    error,
  }) as unknown as ScriptedMessage
}

/** The StructuredOutput tool delivery attachment (toolExecution capture). */
function structuredOutputAttachment(data: unknown): ScriptedMessage {
  return {
    ...baseFields(),
    type: 'attachment',
    attachment: { type: 'structured_output', data },
  }
}

const STRUCTURED_DATA = { title: 'Delivered', score: 7 }

/** assistant(StructuredOutput tool_use) → user(tool_result) → attachment. */
function deliveredStructuredOutputTurn(): ScriptedMessage[] {
  const toolUseId = `toolu_${randomUUID()}`
  return [
    assistantRow(
      [
        toolUseBlock(toolUseId, SYNTHETIC_OUTPUT_TOOL_NAME, STRUCTURED_DATA),
      ],
      'tool_use',
    ),
    userRow([
      toolResultBlock(toolUseId, 'Structured output provided successfully'),
    ]),
    structuredOutputAttachment(STRUCTURED_DATA),
  ]
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
    // `--json-schema` headless run: the engine's structured-output path.
    jsonSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, score: { type: 'number' } },
      required: ['title', 'score'],
    },
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

async function collectResultEnvelope(
  engine: QueryEngine,
): Promise<Record<string, unknown>> {
  let envelope: Record<string, unknown> | undefined
  for await (const msg of engine.submitMessage('run the schema task')) {
    const candidate = msg as unknown as Record<string, unknown>
    if (candidate.type === 'result') envelope = candidate
  }
  if (!envelope) throw new Error('no result envelope yielded')
  return envelope
}

beforeAll(() => {
  // The engine records every row it sees; keep the test off the real
  // ~/.claude transcript store (persistSession = !isSessionPersistenceDisabled()).
  setSessionPersistenceDisabled(true)
})

afterAll(() => {
  setSessionPersistenceDisabled(false)
})

afterEach(() => {
  script = []
  terminalReason = 'completed'
})

// ---------------------------------------------------------------------------

describe('CC 2.1.290 cluster-f C — trailing API-error notice skip', () => {
  test('delivered structured output + post-delivery server_error drop → is_error:false, stop_reason tool_use, result is the delivered JSON', async () => {
    // Arrange — the StructuredOutput tool delivered, then the follow-up
    // request lost the connection mid-stream (partial finalize → server_error)
    // and the query still terminated with reason 'completed'.
    script = [
      ...deliveredStructuredOutputTurn(),
      apiErrorAssistant('server_error'),
    ]
    const engine = makeEngine()

    // Act
    const envelope = await collectResultEnvelope(engine)
    engine.close()

    // Assert — the run succeeded; print.ts derives exit 0 from is_error:false.
    expect(envelope.subtype).toBe('success')
    expect(envelope.is_error).toBe(false)
    expect(envelope.structured_output).toEqual(STRUCTURED_DATA)
    // official effects: ct="tool_use", Ut="" then os=JSON.stringify(gt.at(-1).data)
    expect(envelope.stop_reason).toBe('tool_use')
    expect(envelope.result).toBe(JSON.stringify(STRUCTURED_DATA))
  })

  test('MCP claude/endTurn tool result + server_error → is_error:false without structured output', async () => {
    // Arrange — official `ehn` mcp_meta branch (VKt: _meta["claude/endTurn"]).
    const toolUseId = `toolu_${randomUUID()}`
    script = [
      assistantRow(
        [toolUseBlock(toolUseId, 'mcp__demo__finish', { done: true })],
        'tool_use',
      ),
      userRow(
        [toolResultBlock(toolUseId, 'turn finished by mcp tool')],
        { mcpMeta: { _meta: { 'claude/endTurn': true } } },
      ),
      apiErrorAssistant('server_error'),
    ]
    const engine = makeEngine()

    // Act
    const envelope = await collectResultEnvelope(engine)
    engine.close()

    // Assert — skip fires with no structured output at all; the notice text
    // is cleared (official Ut=""/Ct="") so result is ''.
    expect(envelope.is_error).toBe(false)
    expect(envelope.structured_output).toBeUndefined()
    expect(envelope.stop_reason).toBe('tool_use')
    expect(envelope.result).toBe('')
  })

  test('control: a non-server_error trailing API error after delivery keeps is_error:true', async () => {
    // Arrange — official requires error==="server_error" exactly.
    script = [
      ...deliveredStructuredOutputTurn(),
      apiErrorAssistant('invalid_request'),
    ]
    const engine = makeEngine()

    // Act
    const envelope = await collectResultEnvelope(engine)
    engine.close()

    // Assert
    expect(envelope.is_error).toBe(true)
    expect(envelope.structured_output).toEqual(STRUCTURED_DATA)
  })

  test('control: an aborted terminal reason keeps is_error:true', async () => {
    // Arrange — official requires terminalReason==="completed"; a user Esc /
    // abort during the follow-up request must still surface as an error.
    terminalReason = 'aborted_streaming'
    script = [
      ...deliveredStructuredOutputTurn(),
      apiErrorAssistant('server_error'),
    ]
    const engine = makeEngine()

    // Act
    const envelope = await collectResultEnvelope(engine)
    engine.close()

    // Assert
    expect(envelope.is_error).toBe(true)
  })

  test('control: a non-tool_result preceding row keeps is_error:true', async () => {
    // Arrange — something else (a user text row) sits between the delivery and
    // the drop, so `uht` fails: the error is not a post-delivery tail notice.
    script = [
      ...deliveredStructuredOutputTurn(),
      userRow([{ type: 'text', text: 'and now summarize it' }]),
      apiErrorAssistant('server_error'),
    ]
    const engine = makeEngine()

    // Act
    const envelope = await collectResultEnvelope(engine)
    engine.close()

    // Assert
    expect(envelope.is_error).toBe(true)
  })

  test('control: an errored tool_result in the preceding row keeps is_error:true', async () => {
    // Arrange — official `ehn` veto: `r.some(s=>s.type==="tool_result"&&s.is_error===!0)`.
    const toolUseId = `toolu_${randomUUID()}`
    script = [
      ...deliveredStructuredOutputTurn(),
      assistantRow([toolUseBlock(toolUseId, 'mcp__demo__finish', {})], 'tool_use'),
      userRow(
        [toolResultBlock(toolUseId, 'mcp tool blew up', true)],
        { mcpMeta: { _meta: { 'claude/endTurn': true } } },
      ),
      apiErrorAssistant('server_error'),
    ]
    const engine = makeEngine()

    // Act
    const envelope = await collectResultEnvelope(engine)
    engine.close()

    // Assert — structured output WAS delivered, yet the veto wins.
    expect(envelope.is_error).toBe(true)
    expect(envelope.structured_output).toEqual(STRUCTURED_DATA)
  })

  test('control: server_error after an ordinary tool result keeps is_error:true', async () => {
    // Arrange — a normal (non-turn-ending) tool result followed by a drop on
    // the next request: the model never got to answer, so this is a real error.
    const toolUseId = `toolu_${randomUUID()}`
    script = [
      assistantRow([toolUseBlock(toolUseId, 'Read', { file_path: '/tmp/x' })], 'tool_use'),
      userRow([toolResultBlock(toolUseId, 'file contents')]),
      apiErrorAssistant('server_error'),
    ]
    const engine = makeEngine()

    // Act
    const envelope = await collectResultEnvelope(engine)
    engine.close()

    // Assert
    expect(envelope.is_error).toBe(true)
    expect(envelope.stop_reason).not.toBe('tool_use')
  })

  test('control: a trailing API error with no preceding tool result keeps is_error:true', async () => {
    // Arrange — the plain "API error is the outcome" case.
    script = [apiErrorAssistant('server_error')]
    const engine = makeEngine()

    // Act
    const envelope = await collectResultEnvelope(engine)
    engine.close()

    // Assert
    expect(envelope.subtype).toBe('success')
    expect(envelope.is_error).toBe(true)
    expect(envelope.structured_output).toBeUndefined()
  })

  test('control: a clean successful turn is untouched by the skip', async () => {
    // Arrange — delivery + a normal end_turn assistant answer, no error row.
    script = [
      ...deliveredStructuredOutputTurn(),
      assistantRow([{ type: 'text', text: 'Here is the result.' }], 'end_turn'),
    ]
    const engine = makeEngine()

    // Act
    const envelope = await collectResultEnvelope(engine)
    engine.close()

    // Assert
    expect(envelope.is_error).toBe(false)
    expect(envelope.result).toBe('Here is the result.')
    expect(envelope.stop_reason).toBe('end_turn')
    expect(envelope.structured_output).toEqual(STRUCTURED_DATA)
  })
})
