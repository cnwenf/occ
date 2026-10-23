import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { QueryDeps } from '../deps.js'
import {
  canRetryMalformedToolUse,
  classifyMalformedToolUseRetryOutcome,
  MALFORMED_TOOL_USE_EXHAUSTED_TEXT,
  MALFORMED_TOOL_USE_RETRY_TEXT,
  MAX_MALFORMED_TOOL_USE_RETRIES,
  textHasLeakedInvoke,
} from '../malformedToolUseRetry.js'

/**
 * B12 (official 2.1.307): unparseable tool call retried up to twice before
 * ending the turn with an error.
 *
 * Official v307 ELF evidence (linux-x64, /tmp/cc-diff-308/new307.txt):
 *   - detection + retry + exhausted block @44483254:
 *     `if((C?.message.stop_reason??Nn)==="tool_use"&&jt.length===0&&
 *      !C?.isApiErrorMessage){...}` → tombstones for every assistant message
 *     of the turn, meta retry message (`isMeta:!0,turnCompanion:!0`),
 *     transition `{reason:"malformed_tool_use_retry"}` with
 *     `malformedToolUseRetryCount:On+1`; exhausted path yields
 *     `Ws({content:"The model's tool call could not be parsed (retry also
 *     failed)."})` and returns `{reason:"malformed_tool_use_exhausted"}`.
 *   - constants/detector/classifier @6754634: `cf=2`, `oi(e){return e<cf}`,
 *     `iu` leaked-`<antml:invoke` detector, `au` outcome classifier.
 *   - meta text `Mhn` @36317872.
 *   - outcome telemetry @44475072: fires post-stream when the PREVIOUS
 *     transition was `malformed_tool_use_retry`.
 *   - guard resets @6747889: next_turn + stop_hook_blocking reset
 *     `malformedToolUseRetryCount` to 0; the retry transition applies the
 *     `Ur` reset set (maxOutputTokensRecoveryCount 0, reactive-compact
 *     guard false) plus count+1.
 *
 * Query-loop harness cloned from src/__tests__/queryFallbackRoom296.test.ts
 * (fake QueryDeps + isolated CLAUDE_CONFIG_DIR before the dynamic import).
 */

// ── Isolation + analytics spy (must precede the dynamic query.js import) ──

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'occ-b12-307-'))
const SAVED_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR

const loggedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []
const actualAnalytics = {
  ...(await import('../../services/analytics/index.js')),
}
const analyticsMockFactory = () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    loggedEvents.push({ name, metadata: metadata ?? {} })
  },
})
// query.ts imports analytics through the `src/` alias; other modules in the
// graph use the relative specifier. Both resolve to the same file — mock
// both spellings so the spy catches every consumer.
mock.module('../../services/analytics/index.js', analyticsMockFactory)
mock.module('src/services/analytics/index.js', analyticsMockFactory)

// Test-isolation guard: test/engine/structuredOutputIsError291.test.ts
// installs a process-wide `mock.module('../../src/query.js', …)` that it
// never restores, so whichever file bun evaluates FIRST decides whether a
// plain `import('../../query.js')` here resolves to the real loop or to
// that file's scripted `fakeQuery` stub (callModel never runs → every
// query-loop assertion below fails with empty captures). The `?occ-b12`
// cache-bust specifier makes bun evaluate a FRESH, distinct instance of
// query.ts that the leaked mock cannot match (verified: the busted
// instance's `query.name` is `query`, never `fakeQuery`, in both file
// orders). query.ts is module-stateless — all per-call state lives in the
// generator + the injected QueryDeps — and its own imports (analytics,
// AppStateStore, messages, …) resolve through the normal shared registry,
// so the fresh instance still sees the analytics spy below and shares
// module identity (e.g. createUserMessage) with the rest of the suite.
// The specifier is a variable so tsc doesn't try to resolve the
// query-suffixed path (TS2307); bun resolves it at runtime.
const FRESH_QUERY_SPECIFIER = '../../query.js?occ-b12'
const { query } = (await import(FRESH_QUERY_SPECIFIER)) as typeof import('../../query.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import(
  '../../utils/fileStateCache.js'
)
const { createUserMessage } = await import('../../utils/messages.js')
const { asSystemPrompt } = await import('../../utils/systemPromptType.js')

afterAll(() => {
  mock.module('../../services/analytics/index.js', () => actualAnalytics)
  mock.module('src/services/analytics/index.js', () => actualAnalytics)
  if (SAVED_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = SAVED_CONFIG_DIR
  }
  rmSync(CONFIG_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  loggedEvents.length = 0
})

// ── Helper unit tests (pure module surface) ──

describe('B12 constants (official v307 Mhn @36317872, cf=2 @6754634)', () => {
  test('retry meta text is byte-exact official Mhn', () => {
    expect(MALFORMED_TOOL_USE_RETRY_TEXT).toBe(
      'The previous response failed to produce a valid tool call. Please retry the tool call now.',
    )
  })

  test('exhausted error text is byte-exact official inline constant (@44483254)', () => {
    expect(MALFORMED_TOOL_USE_EXHAUSTED_TEXT).toBe(
      "The model's tool call could not be parsed (retry also failed).",
    )
  })

  test('MAX_MALFORMED_TOOL_USE_RETRIES is official cf=2', () => {
    expect(MAX_MALFORMED_TOOL_USE_RETRIES).toBe(2)
  })
})

describe('canRetryMalformedToolUse (official oi(e){return e<cf} @6754634)', () => {
  test('true below the cap (counts 0 and 1)', () => {
    expect(canRetryMalformedToolUse(0)).toBe(true)
    expect(canRetryMalformedToolUse(1)).toBe(true)
  })

  test('false at and above the cap (boundary oi(2)=false)', () => {
    expect(canRetryMalformedToolUse(2)).toBe(false)
    expect(canRetryMalformedToolUse(3)).toBe(false)
  })
})

describe('textHasLeakedInvoke (official iu + df=/<antml:invoke\\b/ @6754634)', () => {
  function assistantWith(content: unknown[]): Message {
    return {
      type: 'assistant',
      message: { role: 'assistant', content },
    } as unknown as Message
  }

  test('true when the last text block contains a leaked <antml:invoke', () => {
    expect(
      textHasLeakedInvoke([
        assistantWith([
          { type: 'text', text: 'Let me run <antml:invoke name="Bash">' },
        ]),
      ]),
    ).toBe(true)
  })

  test('false when the marker appears without the leading <', () => {
    expect(
      textHasLeakedInvoke([
        assistantWith([{ type: 'text', text: 'prose about antml:invoke tags' }]),
      ]),
    ).toBe(false)
  })

  test('respects the \\b word boundary (official df)', () => {
    expect(
      textHasLeakedInvoke([
        assistantWith([{ type: 'text', text: '<antml:invoked>' }]),
      ]),
    ).toBe(false)
  })

  test('reads the LAST text block across all turn messages (official findLast)', () => {
    expect(
      textHasLeakedInvoke([
        assistantWith([{ type: 'text', text: '<antml:invoke name="X">' }]),
        assistantWith([{ type: 'text', text: 'clean tail' }]),
      ]),
    ).toBe(false)
    expect(
      textHasLeakedInvoke([
        assistantWith([{ type: 'text', text: 'clean head' }]),
        assistantWith([{ type: 'text', text: '<antml:invoke' }]),
      ]),
    ).toBe(true)
  })

  test('false for no messages / no text blocks (official ?? "")', () => {
    expect(textHasLeakedInvoke([])).toBe(false)
    expect(
      textHasLeakedInvoke([
        assistantWith([{ type: 'tool_use', id: 'tu_1', name: 'Bash' }]),
      ]),
    ).toBe(false)
  })
})

describe('classifyMalformedToolUseRetryOutcome (official au @6754634)', () => {
  test('succeeded — tool_use blocks present wins over every other input', () => {
    expect(classifyMalformedToolUseRetryOutcome(1, 'tool_use', false, 0)).toBe(
      'succeeded',
    )
    expect(classifyMalformedToolUseRetryOutcome(2, 'end_turn', false, 2)).toBe(
      'succeeded',
    )
  })

  test('malformed_again — tool_use stop, no blocks, retry still available', () => {
    expect(classifyMalformedToolUseRetryOutcome(0, 'tool_use', false, 0)).toBe(
      'malformed_again',
    )
    expect(classifyMalformedToolUseRetryOutcome(0, 'tool_use', false, 1)).toBe(
      'malformed_again',
    )
  })

  test('gave_up — tool_use stop, no blocks, retries exhausted', () => {
    expect(classifyMalformedToolUseRetryOutcome(0, 'tool_use', false, 2)).toBe(
      'gave_up',
    )
  })

  test('API-error response with tool_use stop falls through to other', () => {
    expect(classifyMalformedToolUseRetryOutcome(0, 'tool_use', true, 0)).toBe(
      'other',
    )
  })

  test('end_turn', () => {
    expect(classifyMalformedToolUseRetryOutcome(0, 'end_turn', false, 0)).toBe(
      'end_turn',
    )
    expect(classifyMalformedToolUseRetryOutcome(0, 'end_turn', true, 1)).toBe(
      'end_turn',
    )
  })

  test('other — any remaining stop reason', () => {
    expect(classifyMalformedToolUseRetryOutcome(0, null, false, 0)).toBe(
      'other',
    )
    expect(
      classifyMalformedToolUseRetryOutcome(0, 'stop_sequence', false, 0),
    ).toBe('other')
    expect(classifyMalformedToolUseRetryOutcome(0, 'max_tokens', false, 0)).toBe(
      'other',
    )
  })
})

// ── Query-loop integration tests (real query() with fake QueryDeps) ──

const MODEL = 'claude-sonnet-4-5'
const PROBE_TOOL_NAME = 'MalformedProbe307'

const PROBE_TOOL = {
  name: PROBE_TOOL_NAME,
  maxResultSizeChars: 100_000,
  inputSchema: z.object({}).passthrough(),
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  needsPermissions: () => false,
  call: async () => ({ data: 'PROBE_OK' }),
  mapToolResultToToolResultBlockParam: (data: unknown, toolUseID: string) => ({
    type: 'tool_result' as const,
    tool_use_id: toolUseID,
    content: String(data),
  }),
} as unknown as Tool

let uuidCounter = 0

function makeContext(mainLoopModel: string): ToolUseContext {
  return {
    options: {
      tools: [PROBE_TOOL],
      mcpClients: {},
      mainLoopModel,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
      isNonInteractiveSession: true,
    },
    abortController: new AbortController(),
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => ({ ...getDefaultAppState() }),
    setInProgressToolUseIDs: () => {},
  } as unknown as ToolUseContext
}

function makeAssistant(
  id: string,
  content: unknown[],
  stopReason: 'tool_use' | 'end_turn',
) {
  return {
    type: 'assistant',
    uuid: `uuid-a-${id}`,
    costUSD: 0,
    durationMs: 1,
    message: {
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as Record<string, unknown>
}

/** Malformed tool call: stop_reason "tool_use" but zero tool_use blocks. */
function makeMalformed(id: string, text?: string) {
  return makeAssistant(
    id,
    text === undefined ? [] : [{ type: 'text', id: `txt_${id}`, text }],
    'tool_use',
  )
}

const TOOL_USE_BLOCK = {
  type: 'tool_use',
  id: 'toolu_probe_1',
  name: PROBE_TOOL_NAME,
  input: {},
}

const END_TURN_TEXT_BLOCK = { type: 'text', id: 'txt_1', text: 'done' }

type FakeCallModel = (params: {
  messages?: unknown[]
  options: { model: string }
}) => AsyncGenerator<never, void>

function makeDeps(callModel: FakeCallModel): QueryDeps {
  const microcompact = async (messages: unknown[]) => ({ messages })
  const autocompact = async () => ({
    compactionResult: undefined,
    consecutiveFailures: 0,
  })
  return {
    callModel: callModel as unknown as QueryDeps['callModel'],
    microcompact: microcompact as unknown as QueryDeps['microcompact'],
    autocompact: autocompact as unknown as QueryDeps['autocompact'],
    uuid: () => `uuid-${++uuidCounter}`,
  }
}

type DriveResult = {
  yielded: unknown[]
  terminal: unknown
  modelsSeen: string[]
  messagesPerCall: Array<unknown[]>
}

async function driveQuery(callModel: FakeCallModel): Promise<DriveResult> {
  const yielded: unknown[] = []
  const modelsSeen: string[] = []
  const messagesPerCall: Array<unknown[]> = []
  const wrapped: FakeCallModel = params => {
    modelsSeen.push(params.options.model)
    messagesPerCall.push((params.messages ?? []) as unknown[])
    return callModel(params)
  }
  const gen = query({
    messages: [createUserMessage({ content: 'do the task' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: (async (
      _tool: Tool,
      seenInput: Record<string, unknown>,
    ) => ({ behavior: 'allow', updatedInput: seenInput })) as never,
    toolUseContext: makeContext(MODEL),
    querySource: 'repl_main_thread' as never,
    deps: makeDeps(wrapped),
  })
  let terminal: unknown
  while (true) {
    const next = await gen.next()
    if (next.done) {
      terminal = next.value
      break
    }
    yielded.push(next.value)
  }
  return { yielded, terminal, modelsSeen, messagesPerCall }
}

function eventsNamed(name: string) {
  return loggedEvents.filter(e => e.name === name)
}

function tombstonesOf(yielded: unknown[]) {
  return yielded.filter(
    y => (y as { type?: string } | null)?.type === 'tombstone',
  ) as Array<{ type: 'tombstone'; message: Message }>
}

function metaUserMessagesOf(yielded: unknown[]) {
  // isMeta gate: tool_result rows are also type 'user' but never meta.
  return yielded.filter(
    y =>
      (y as Message | null)?.type === 'user' &&
      (y as Message).isMeta === true,
  ) as Message[]
}

function contentOf(message: Message): unknown {
  return message.message?.content
}

describe('B12 query loop — malformed tool_use retry (official @44483254)', () => {
  test('retries once: tombstones the turn, injects the meta message, then succeeds', async () => {
    let call = 0
    const fake: FakeCallModel = async function* () {
      call++
      if (call === 1) {
        yield makeMalformed('1', 'I will now call <antml:invoke name="Bash">')
        return
      }
      if (call === 2) {
        yield makeAssistant('2', [TOOL_USE_BLOCK], 'tool_use')
        return
      }
      yield makeAssistant('3', [END_TURN_TEXT_BLOCK], 'end_turn')
    } as unknown as FakeCallModel

    const { yielded, terminal, modelsSeen, messagesPerCall } =
      await driveQuery(fake)

    expect(modelsSeen).toEqual([MODEL, MODEL, MODEL])

    // Tombstone for the malformed assistant response (official
    // `for(let lt of ne)yield{type:"tombstone",message:lt}`).
    const tombs = tombstonesOf(yielded)
    expect(tombs.length).toBe(1)
    expect(tombs[0]!.message.message?.id).toBe('msg_1')

    // Meta retry message: exact text + isMeta + turnCompanion (official
    // `Pe({content:Mhn,isMeta:!0,turnCompanion:!0,...})`).
    const metas = metaUserMessagesOf(yielded)
    expect(metas.length).toBe(1)
    expect(contentOf(metas[0]!)).toBe(MALFORMED_TOOL_USE_RETRY_TEXT)
    expect(metas[0]!.isMeta).toBe(true)
    expect(metas[0]!.turnCompanion).toBe(true)

    // Retry request context: malformed assistant rows EXCLUDED (official
    // `messages:[...j,Ne]` — j has no turn assistants), meta message last.
    const retryMessages = messagesPerCall[1] as Message[]
    expect(retryMessages.some(m => m.type === 'assistant')).toBe(false)
    expect(contentOf(retryMessages.at(-1)!)).toBe(MALFORMED_TOOL_USE_RETRY_TEXT)

    // Detection telemetry (official @44483254).
    const det = eventsNamed('tengu_malformed_tool_use_response')
    expect(det.length).toBe(1)
    expect(det[0]!.metadata).toEqual({
      will_retry: true,
      retry_count: 0,
      model: MODEL,
      text_has_leaked_invoke: true,
    })

    // Outcome telemetry after the retried response (official @44475072).
    const out = eventsNamed('tengu_malformed_tool_use_retry_outcome')
    expect(out.length).toBe(1)
    expect(out[0]!.metadata).toEqual({
      model: MODEL,
      retry_count: 1,
      outcome: 'succeeded',
    })

    expect(terminal).toEqual({ reason: 'completed' })
  })

  test('retries twice: second malformed response classified malformed_again, end_turn tail classified end_turn', async () => {
    let call = 0
    const fake: FakeCallModel = async function* () {
      call++
      if (call === 1) {
        yield makeMalformed('1', 'clean text, no tool call')
        return
      }
      if (call === 2) {
        yield makeMalformed('2')
        return
      }
      yield makeAssistant('3', [END_TURN_TEXT_BLOCK], 'end_turn')
    } as unknown as FakeCallModel

    const { yielded, terminal, modelsSeen } = await driveQuery(fake)

    expect(modelsSeen).toEqual([MODEL, MODEL, MODEL])
    expect(tombstonesOf(yielded).length).toBe(2)
    const metas = metaUserMessagesOf(yielded)
    expect(metas.length).toBe(2)
    for (const meta of metas) {
      expect(contentOf(meta)).toBe(MALFORMED_TOOL_USE_RETRY_TEXT)
      expect(meta.isMeta).toBe(true)
      expect(meta.turnCompanion).toBe(true)
    }

    const det = eventsNamed('tengu_malformed_tool_use_response')
    expect(det.map(e => e.metadata)).toEqual([
      {
        will_retry: true,
        retry_count: 0,
        model: MODEL,
        text_has_leaked_invoke: false,
      },
      {
        will_retry: true,
        retry_count: 1,
        model: MODEL,
        text_has_leaked_invoke: false,
      },
    ])

    const out = eventsNamed('tengu_malformed_tool_use_retry_outcome')
    expect(out.map(e => e.metadata)).toEqual([
      { model: MODEL, retry_count: 1, outcome: 'malformed_again' },
      { model: MODEL, retry_count: 2, outcome: 'end_turn' },
    ])

    expect(terminal).toEqual({ reason: 'completed' })
  })

  test('third consecutive malformed response exhausts: error message + malformed_tool_use_exhausted terminal', async () => {
    let call = 0
    const fake: FakeCallModel = async function* () {
      call++
      yield makeMalformed(String(call))
    } as unknown as FakeCallModel

    const { yielded, terminal, modelsSeen } = await driveQuery(fake)

    // Two retries max (official cf=2) → three model calls total.
    expect(modelsSeen).toEqual([MODEL, MODEL, MODEL])

    // Third detection: will_retry false at the cap.
    const det = eventsNamed('tengu_malformed_tool_use_response')
    expect(det.length).toBe(3)
    expect(det[2]!.metadata).toEqual({
      will_retry: false,
      retry_count: 2,
      model: MODEL,
      text_has_leaked_invoke: false,
    })

    // Outcome events fired after retries 1 and 2 only (no event after the
    // exhausted iteration — it never continues).
    const out = eventsNamed('tengu_malformed_tool_use_retry_outcome')
    expect(out.map(e => e.metadata)).toEqual([
      { model: MODEL, retry_count: 1, outcome: 'malformed_again' },
      { model: MODEL, retry_count: 2, outcome: 'gave_up' },
    ])

    // Exhausted path: error assistant message with the verbatim official
    // text (isApiErrorMessage via createAssistantAPIErrorMessage), NO extra
    // tombstones/meta beyond the two retries.
    const errors = yielded.filter(
      y => (y as Message).type === 'assistant' && (y as Message).isApiErrorMessage,
    ) as Message[]
    expect(errors.length).toBe(1)
    const errContent = errors[0]!.message?.content
    expect(Array.isArray(errContent)).toBe(true)
    expect((errContent as Array<{ text?: string }>)[0]?.text).toBe(
      MALFORMED_TOOL_USE_EXHAUSTED_TEXT,
    )
    expect(tombstonesOf(yielded).length).toBe(2)
    expect(metaUserMessagesOf(yielded).length).toBe(2)

    // Terminal reason string (official `{reason:"malformed_tool_use_exhausted"}`).
    expect(terminal).toEqual({ reason: 'malformed_tool_use_exhausted' })
  })

  test('NOT taken for an API-error message carrying stop_reason tool_use', async () => {
    let call = 0
    const fake: FakeCallModel = async function* () {
      call++
      yield { ...makeMalformed('1'), isApiErrorMessage: true }
    } as unknown as FakeCallModel

    const { yielded, terminal, modelsSeen } = await driveQuery(fake)

    expect(modelsSeen).toEqual([MODEL])
    expect(eventsNamed('tengu_malformed_tool_use_response').length).toBe(0)
    expect(tombstonesOf(yielded).length).toBe(0)
    expect(metaUserMessagesOf(yielded).length).toBe(0)
    // Falls through to the pre-existing isApiErrorMessage handling.
    expect(terminal).toEqual({ reason: 'completed' })
  })

  test('NOT taken for a well-formed end_turn response', async () => {
    const fake: FakeCallModel = async function* () {
      yield makeAssistant('1', [END_TURN_TEXT_BLOCK], 'end_turn')
    } as unknown as FakeCallModel

    const { terminal, modelsSeen } = await driveQuery(fake)

    expect(modelsSeen).toEqual([MODEL])
    expect(eventsNamed('tengu_malformed_tool_use_response').length).toBe(0)
    expect(eventsNamed('tengu_malformed_tool_use_retry_outcome').length).toBe(0)
    expect(terminal).toEqual({ reason: 'completed' })
  })

  test('NOT taken when stop_reason tool_use carries a real tool_use block (needsFollowUp path)', async () => {
    let call = 0
    const fake: FakeCallModel = async function* () {
      call++
      if (call === 1) {
        yield makeAssistant('1', [TOOL_USE_BLOCK], 'tool_use')
        return
      }
      yield makeAssistant('2', [END_TURN_TEXT_BLOCK], 'end_turn')
    } as unknown as FakeCallModel

    const { terminal, modelsSeen } = await driveQuery(fake)

    expect(modelsSeen).toEqual([MODEL, MODEL])
    expect(eventsNamed('tengu_malformed_tool_use_response').length).toBe(0)
    expect(terminal).toEqual({ reason: 'completed' })
  })
})
