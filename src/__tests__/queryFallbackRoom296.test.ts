import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { QueryDeps } from '../query/deps.js'

/**
 * OCC-154 fix-round df-02 (+ C-item t-05 wiring) — the per-turn contextRoom
 * in the REAL query() loop.
 *
 * Why this file exists: the 验收员 t-05 mutation recipe showed that deleting
 * the query.ts per-turn seeding block (the `contextRoom: () => turnContextRoom`
 * spread, ~lines 659-669) leaves contextRoom296 + allowLarge296 (86/86) green
 * — those suites unit-test the room factory and the lOr port but never
 * execute query.ts. This suite drives the real query() generator with fake
 * QueryDeps and a probe tool, capturing the tool-facing context exactly the
 * way a tool sees it mid-turn.
 *
 * Official v296 evidence (linux-x64 ELF, forensics dir /tmp/cc-diff-296):
 *   - Turn seeding @53556304: `$s=(h,w)=>pg({...})` resolves the turn model;
 *     `let[be,Rt]=await Ks(P,de(p).mode)`; `Yn=(h)=>{be=h,Rt=Xd(h)}` is the
 *     in-place model updater.
 *   - Room wiring @53561900: `p={...p,messages:P,turnStartIndex:xd(P),
 *     contextRoom:ra(()=>Rt,p.options.autoCompactWindow,()=>P)}` — the room
 *     closes over the LIVE resolved-model binding, so threshold/held()
 *     recompute whenever `Yn` runs.
 *   - Fallback chain-advance @53594595: `if(Yn(vt),An=!0,ge=!1,...
 *     p.options={...p.options,mainLoopModel:be,...},...continue` — the
 *     fallback refreshes `Rt` IN PLACE (no re-seed; the room object and its
 *     claimed() counter survive) and rewrites options.mainLoopModel.
 *
 * OCC mapping: `Rt` ≡ `turnModel` (the room's `getModel: () => turnModel`
 * closure), `Yn(vt)` ≡ `turnModel = nextFallbackModel` in the
 * FallbackTriggeredError catch. df-02 was the missing `Yn` counterpart: the
 * catch updated `currentModel` + `options.mainLoopModel` but never
 * `turnModel`, pinning the room threshold to the pre-fallback model
 * (claude-sonnet-4-5 → 167000 instead of claude-sonnet-4-5[1m] → 767000).
 *
 * Mutation-verify recipes (run these to confirm the suite pins the wiring):
 *   - df-02: remove `turnModel = nextFallbackModel` from query.ts's fallback
 *     catch → the fallback test goes RED (threshold 167000 ≠ 767000) while
 *     contextRoom296 + allowLarge296 stay green.
 *   - t-05: remove the `contextRoom: () => turnContextRoom` seeding spread in
 *     query.ts → BOTH tests go RED (`contextRoom` is not a function on the
 *     tool-facing context) while contextRoom296 + allowLarge296 stay green.
 */

// Isolate settings/hooks BEFORE the query module graph loads: turn-end
// handleStopHooks and the tool-execution hook pipeline read live settings,
// and this machine's real ~/.claude has hooks configured. Point
// CLAUDE_CONFIG_DIR at an empty dir; restore in afterAll.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'occ-qroom296-'))
const SAVED_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR

const { query } = await import('../query.js')
const { FallbackTriggeredError } = await import(
  '../services/api/withRetry.js'
)
const { getAutoCompactThreshold } = await import(
  '../services/compact/autoCompact.js'
)
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import(
  '../utils/fileStateCache.js'
)
const { createUserMessage } = await import('../utils/messages.js')
const { asSystemPrompt } = await import('../utils/systemPromptType.js')

afterAll(() => {
  if (SAVED_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = SAVED_CONFIG_DIR
  }
  rmSync(CONFIG_DIR, { recursive: true, force: true })
})

// ── Constants — the 验收员 df-02 scenario ──

const MODEL = 'claude-sonnet-4-5'
const FALLBACK_MODEL = 'claude-sonnet-4-5[1m]'
const PROBE_TOOL_NAME = 'RoomProbe296'

// ── Probe tool — captures the tool-facing context mid-turn ──

type ProbeCapture = {
  contextRoomIsFunction: boolean
  roomFound: boolean
  threshold: number | undefined
  optionsModel: string | undefined
}

let probeCaptures: ProbeCapture[] = []

const PROBE_TOOL = {
  name: PROBE_TOOL_NAME,
  maxResultSizeChars: 100_000,
  inputSchema: z.object({}).passthrough(),
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  needsPermissions: () => false,
  call: async (_input: unknown, context: ToolUseContext) => {
    const room = context.contextRoom?.()
    probeCaptures.push({
      contextRoomIsFunction: typeof context.contextRoom === 'function',
      roomFound: room !== undefined,
      threshold: room?.threshold,
      optionsModel: context.options.mainLoopModel,
    })
    return { data: 'PROBE_OK' }
  },
  mapToolResultToToolResultBlockParam: (data: unknown, toolUseID: string) => ({
    type: 'tool_result' as const,
    tool_use_id: toolUseID,
    content: String(data),
  }),
} as unknown as Tool

// ── Harness factories ──

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
  } as never
}

const TOOL_USE_BLOCK = {
  type: 'tool_use',
  id: 'toolu_probe_1',
  name: PROBE_TOOL_NAME,
  input: {},
}

const END_TURN_TEXT_BLOCK = { type: 'text', id: 'txt_1', text: 'done' }

type FakeCallModel = (params: {
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

async function driveQuery(
  callModel: FakeCallModel,
): Promise<{ modelsSeen: string[] }> {
  const modelsSeen: string[] = []
  const wrapped: FakeCallModel = params => {
    modelsSeen.push(params.options.model)
    return callModel(params)
  }
  const gen = query({
    messages: [createUserMessage({ content: 'probe the room' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: (async (
      _tool: Tool,
      seenInput: Record<string, unknown>,
    ) => ({ behavior: 'allow', updatedInput: seenInput })) as never,
    toolUseContext: makeContext(MODEL),
    fallbackModel: [FALLBACK_MODEL],
    querySource: 'repl_main_thread' as never,
    deps: makeDeps(wrapped),
  })
  while (true) {
    const next = await gen.next()
    if (next.done) {
      break
    }
  }
  return { modelsSeen }
}

// ── Tests ──

describe('OCC-154 df-02/t-05 — query() per-turn contextRoom wiring', () => {
  test('t-05: per-turn seeding installs a live contextRoom on the tool-facing context', async () => {
    probeCaptures = []
    let call = 0
    const fakeCallModel: FakeCallModel = async function* () {
      call++
      if (call === 1) {
        yield makeAssistant('1', [TOOL_USE_BLOCK], 'tool_use')
        return
      }
      yield makeAssistant('2', [END_TURN_TEXT_BLOCK], 'end_turn')
    } as unknown as FakeCallModel
    const { modelsSeen } = await driveQuery(fakeCallModel)

    expect(modelsSeen).toEqual([MODEL, MODEL])
    expect(probeCaptures.length).toBe(1)
    const probe = probeCaptures[0]!
    // The t-05 mutation (deleting the query.ts seeding spread) makes
    // contextRoom undefined here — `captured.contextRoom is not a function`.
    expect(probe.contextRoomIsFunction).toBe(true)
    expect(probe.roomFound).toBe(true)
    // No fallback in this scenario: the room threshold tracks the turn's
    // resolved model (default permission mode → the static setting).
    expect(probe.threshold).toBe(getAutoCompactThreshold(MODEL))
    expect(probe.optionsModel).toBe(MODEL)
  })

  test('df-02: FallbackTriggeredError refreshes the room model in place (Yn(vt) mirror)', async () => {
    probeCaptures = []
    let call = 0
    const fakeCallModel: FakeCallModel = async function* (params: {
      options: { model: string }
    }) {
      call++
      if (call === 1) {
        // The official chain-advance trigger: the streaming call fails with
        // a fallback-eligible error, caught at query.ts's inner catch.
        expect(params.options.model).toBe(MODEL)
        throw new FallbackTriggeredError(MODEL, FALLBACK_MODEL, 'overloaded')
      }
      if (call === 2) {
        // Post-fallback retry: the probe tool runs in the SAME turn, after
        // the catch's `continue`, seeing the room through the live closure.
        yield makeAssistant('2', [TOOL_USE_BLOCK], 'tool_use')
        return
      }
      yield makeAssistant('3', [END_TURN_TEXT_BLOCK], 'end_turn')
    } as unknown as FakeCallModel
    const { modelsSeen } = await driveQuery(fakeCallModel)

    // Turn 1: primary → fallback retry (probe turn) → turn 2 on the fallback
    // model (seeding re-reads options.mainLoopModel, rewritten by the catch).
    expect(modelsSeen).toEqual([MODEL, FALLBACK_MODEL, FALLBACK_MODEL])
    expect(probeCaptures.length).toBe(1)
    const probe = probeCaptures[0]!
    expect(probe.contextRoomIsFunction).toBe(true)
    expect(probe.roomFound).toBe(true)
    // THE df-02 assertion: without `turnModel = nextFallbackModel` the lazy
    // getModel closure stays pinned and this reads 167000 (sonnet-4-5 200k
    // window). The official `Yn(vt)` refresh makes it 767000 ([1m] 800k
    // effective window) — the room object itself survives (claimed() state
    // persists), exactly as the official chain-advance preserves `ra(...)`.
    expect(probe.threshold).toBe(getAutoCompactThreshold(FALLBACK_MODEL))
    expect(probe.threshold).not.toBe(getAutoCompactThreshold(MODEL))
    // The catch's options rewrite (mirror of official
    // `p.options={...p.options,mainLoopModel:be}`) is visible to tools too.
    expect(probe.optionsModel).toBe(FALLBACK_MODEL)
  })
})
