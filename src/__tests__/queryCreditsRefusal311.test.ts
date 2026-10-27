import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../Tool.js'
import type { QueryDeps } from '../query/deps.js'

/**
 * WP-B (triage-T1.md Item 5) — query-loop wiring for compact-after-long-
 * context-refusal, driving the REAL query() generator.
 *
 * Official v311 wiring (@257496863, byte-verified):
 *   `if(!ve.needsFollowUp&&bd(I,Mt,M))Jt=!0,ss=I;` — Jt withholds the
 *   refusal from the stream, ss remembers it. Post-loop merge
 *   `Q=E!==void 0&&E===ss` (@257505460); success → bare
 *   `g("compact_after_long_context_refusal")` + transition
 *   `{reason:"reactive_compact_retry"}`; failure → outcome logged
 *   (still_refused @257509841 / not_compacted @257509857 / aborted) and the
 *   withheld message is surfaced (`break e` → `if(Q)yield E` → normal turn
 *   end); abort → interruption + aborted exit.
 *
 * Scenarios (task spec):
 *   (a) refusal + window<=200000 → withheld, compaction attempted, loop
 *       resumes (refusal NEVER yielded; post-compact messages yielded).
 *   (b) second refusal → fatal surfaced with the existing message (latch:
 *       hasAttemptedReactiveCompact → still_refused, compact not re-run).
 *   (c) window >200000 ([1m] model) → fatal yielded immediately, compact
 *       never called.
 *   (d) aborted during compaction → interruption message, terminal
 *       {reason:'aborted_streaming'}, fatal NOT yielded.
 */

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'occ-qcredits311-'))
const SAVED_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR

// Mock ONLY tryCompactAfterLongContextRefusal — the real withhold detector
// (shouldWithholdLongContextCreditsRefusal) stays live so the query wiring is
// tested against real detection semantics.
const realReactive = await import('../services/compact/reactiveCompact.js')
type RefusalAttempt = Awaited<
  ReturnType<typeof realReactive.tryCompactAfterLongContextRefusal>
>
type RefusalParams = Parameters<
  typeof realReactive.tryCompactAfterLongContextRefusal
>[0]
type RefusalDeps = Parameters<
  typeof realReactive.tryCompactAfterLongContextRefusal
>[1]

let compactCalls: { hasAttempted: boolean; aborted: boolean }[] = []
let compactMode: 'succeed' | 'fail' | 'abort' = 'succeed'

// Capture the REAL function reference BEFORE mock.module patches the live
// bindings — the delegate below must not recurse into the fake.
const realTryCompact = realReactive.tryCompactAfterLongContextRefusal

mock.module('../services/compact/reactiveCompact.js', () => ({
  ...realReactive,
  tryCompactAfterLongContextRefusal: async (
    params: RefusalParams,
    deps?: RefusalDeps,
  ): Promise<RefusalAttempt> => {
    // Delegate to the REAL implementation when deps are injected — sibling
    // unit tests (reactiveCompactCredits311) call through this same mocked
    // registry entry with an injected `compact` spy. query.ts itself calls
    // without deps and gets the fake below.
    if (deps !== undefined) {
      return realTryCompact(params, deps)
    }
    compactCalls.push({
      hasAttempted: params.hasAttempted,
      aborted: params.aborted,
    })
    if (params.aborted || params.hasAttempted) {
      return {
        kind: 'skipped',
        outcome: params.aborted ? 'aborted' : 'still_refused',
      }
    }
    if (compactMode === 'abort') {
      params.cacheSafeParams.toolUseContext.abortController.abort()
      return { kind: 'skipped', outcome: 'aborted' }
    }
    if (compactMode === 'fail') {
      return { kind: 'skipped', outcome: 'not_compacted' }
    }
    return { kind: 'compacted', result: makeFakeCompactionResult() }
  },
}))

const { query } = await import('../query.js')
const {
  markLongContext1mCreditsBlocked,
  resetLongContext1mCreditsBlocked,
} = realReactive
const {
  createAssistantAPIErrorMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} = await import('../utils/messages.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import(
  '../utils/fileStateCache.js'
)
const { asSystemPrompt } = await import('../utils/systemPromptType.js')

afterAll(() => {
  // Un-mock the module so sibling test files in the same `bun test` process
  // (e.g. reactiveCompactCredits311) import the REAL implementation.
  mock.module('../services/compact/reactiveCompact.js', () => realReactive)
  if (SAVED_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = SAVED_CONFIG_DIR
  }
  rmSync(CONFIG_DIR, { recursive: true, force: true })
})

afterEach(() => {
  compactCalls = []
  compactMode = 'succeed'
  resetLongContext1mCreditsBlocked()
})

// ── Constants & factories ───────────────────────────────────────────────────

const MODEL = 'claude-sonnet-4-5' // 200000-token window (<= g6)
const MODEL_1M = 'claude-sonnet-4-5[1m]' // >200000-token window
const FATAL_TEXT =
  'API Error: Extra usage is required for 1M context · run /extra-usage to enable, or /model to switch to standard context'
const REFUSAL_DETAILS = 'Extra usage is required for long context'
const SUMMARY_TEXT = 'Summary of the conversation so far.'

let uuidCounter = 0

function makeContext(mainLoopModel: string): ToolUseContext {
  return {
    options: {
      tools: [],
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

function makeCreditsRefusal() {
  // Exactly what errors.ts's 1M-credits region now returns: fatal content +
  // raw refusal text on errorDetails. The latch is marked because the real
  // errors.ts path (API error handler) would have set it.
  markLongContext1mCreditsBlocked()
  return createAssistantAPIErrorMessage({
    content: FATAL_TEXT,
    error: 'rate_limit',
    errorDetails: REFUSAL_DETAILS,
  })
}

function makeAssistant(id: string, text: string) {
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
      content: [{ type: 'text', id: `txt_${id}`, text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as never
}

function makeFakeCompactionResult() {
  return {
    boundaryMarker: createCompactBoundaryMessage('auto', 210000),
    summaryMessages: [
      createUserMessage({
        content: `This session is being continued from a previous conversation.\n<summary>${SUMMARY_TEXT}</summary>`,
        isCompactSummary: true,
      }),
    ],
    attachments: [],
    hookResults: [],
  } as never
}

type FakeCallModel = () => AsyncGenerator<never, void>

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

/**
 * Conversation with >=2 API round groups so the too_few_groups precheck
 * (aWs ≡ groups<2) passes, mirroring a real long session that hit the wall.
 */
function conversationMessages() {
  return [
    createUserMessage({ content: 'first question' }),
    makeAssistant('r1', 'first answer'),
    createUserMessage({ content: 'second question' }),
    makeAssistant('r2', 'second answer'),
  ] as never[]
}

async function driveQuery(
  model: string,
  callModel: FakeCallModel,
): Promise<{ yielded: never[]; terminal: unknown }> {
  const yielded: never[] = []
  const gen = query({
    messages: conversationMessages(),
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: (async (
      _tool: unknown,
      seenInput: Record<string, unknown>,
    ) => ({ behavior: 'allow', updatedInput: seenInput })) as never,
    toolUseContext: makeContext(model),
    querySource: 'repl_main_thread' as never,
    deps: makeDeps(callModel),
  })
  let terminal: unknown
  while (true) {
    const next = await gen.next()
    if (next.done) {
      terminal = next.value
      break
    }
    yielded.push(next.value as never)
  }
  return { yielded, terminal }
}

function yieldedTexts(yielded: never[]): string {
  return yielded
    .map(y => {
      const m = y as { type?: string; message?: { content?: unknown } }
      if (m?.type !== 'assistant' && m?.type !== 'user') return ''
      const content = m.message?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .map(b => (b as { text?: string }).text ?? '')
          .join('')
      }
      return ''
    })
    .join('\n')
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('WP-B Item 5 — credits refusal: withhold + compact + continue', () => {
  test('(a) refusal at 200k window → withheld, compacted once, loop resumes', async () => {
    let call = 0
    const callModel = (async function* () {
      call++
      if (call === 1) {
        yield makeCreditsRefusal() as never
        return
      }
      yield makeAssistant('post', 'recovered answer') as never
    }) as unknown as FakeCallModel

    const { yielded, terminal } = await driveQuery(MODEL, callModel)
    const text = yieldedTexts(yielded)

    // Compaction attempted exactly once, first-refusal state.
    expect(compactCalls).toEqual([{ hasAttempted: false, aborted: false }])
    expect(call).toBe(2)
    // The fatal refusal was WITHHELD — never surfaced to the stream.
    expect(text).not.toContain('Extra usage is required for 1M context')
    // Post-compact messages were yielded (boundary + summary).
    expect(text).toContain(SUMMARY_TEXT)
    const hasBoundary = yielded.some(
      y =>
        (y as { type?: string; subtype?: string }).type === 'system' &&
        (y as { subtype?: string }).subtype === 'compact_boundary',
    )
    expect(hasBoundary).toBe(true)
    // The resumed turn completed with the real answer.
    expect(text).toContain('recovered answer')
    expect(terminal).toEqual({ reason: 'completed' })
  })

  test('(b) second refusal → fatal surfaced, compact gated by the latch (still_refused)', async () => {
    let call = 0
    const callModel = (async function* () {
      call++
      yield makeCreditsRefusal() as never
    }) as unknown as FakeCallModel

    const { yielded, terminal } = await driveQuery(MODEL, callModel)
    const text = yieldedTexts(yielded)

    // Iteration 1: hasAttempted=false → compacted → resume. Iteration 2:
    // hasAttempted=true → still_refused, compaction NOT re-run.
    expect(compactCalls).toEqual([
      { hasAttempted: false, aborted: false },
      { hasAttempted: true, aborted: false },
    ])
    expect(call).toBe(2)
    // The fatal message surfaces exactly once (the second refusal).
    const occurrences = text.split('Extra usage is required for 1M context').length - 1
    expect(occurrences).toBe(1)
    // Official failure path: `break e` → `if(Q)yield E` → normal turn end.
    expect(terminal).toEqual({ reason: 'completed' })
  })

  test("(b') compaction failure on the first refusal → not_compacted, fatal surfaces", async () => {
    compactMode = 'fail'
    let call = 0
    const callModel = (async function* () {
      call++
      yield makeCreditsRefusal() as never
    }) as unknown as FakeCallModel

    const { yielded, terminal } = await driveQuery(MODEL, callModel)
    const text = yieldedTexts(yielded)

    expect(compactCalls).toEqual([{ hasAttempted: false, aborted: false }])
    expect(call).toBe(1) // no resume — the turn ends on the fatal message
    expect(text).toContain('Extra usage is required for 1M context')
    expect(terminal).toEqual({ reason: 'completed' })
  })

  test('(c) window >200000 ([1m] model) → fatal yielded immediately, no compaction', async () => {
    let call = 0
    const callModel = (async function* () {
      call++
      yield makeCreditsRefusal() as never
    }) as unknown as FakeCallModel

    const { yielded, terminal } = await driveQuery(MODEL_1M, callModel)
    const text = yieldedTexts(yielded)

    expect(compactCalls).toEqual([])
    expect(call).toBe(1)
    expect(text).toContain('Extra usage is required for 1M context')
    expect(terminal).toEqual({ reason: 'completed' })
  })

  test('(d) aborted during compaction → interruption, aborted_streaming, fatal withheld', async () => {
    compactMode = 'abort'
    let call = 0
    const callModel = (async function* () {
      call++
      yield makeCreditsRefusal() as never
    }) as unknown as FakeCallModel

    const { yielded, terminal } = await driveQuery(MODEL, callModel)
    const text = yieldedTexts(yielded)

    expect(compactCalls).toEqual([{ hasAttempted: false, aborted: false }])
    expect(call).toBe(1)
    // Official aborted outcome: interruption message, NOT the fatal refusal.
    expect(text).toContain('Request interrupted by user')
    expect(text).not.toContain('Extra usage is required for 1M context')
    expect(terminal).toEqual({ reason: 'aborted_streaming' })
  })
})
