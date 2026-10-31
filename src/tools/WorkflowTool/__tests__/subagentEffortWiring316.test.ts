/**
 * CC 2.1.316 (OCC-139 review P2-1): `CLAUDE_CODE_SUBAGENT_EFFORT` →
 * `agent()` WIRING-SEAM integration coverage.
 *
 * The unit suite (subagentEffortEnv316.test.ts) drives the resolver directly;
 * this file drives the real `createPrimitives().agent()` so the three wiring
 * steps inside agent() are locked against regression in BOTH directions:
 *   1. env stamp — `resolveSubagentEffortEnvDefault(opts.effort)` result
 *      lands on `agentDef.effort` (primitives.ts, official
 *      `et=at!==void 0?{...ct,effort:at}:ct` @297031178);
 *   2. named precedence — a parseable named `opts.effort` still wins
 *      (official `at=rK(Te?.effort)??Pxo(...)`), is CANONICALIZED by the rK
 *      loose parse ('med' → 'medium'), and an UNPARSEABLE named value falls
 *      through to the env default (review P2-2);
 *   3. prefix-stagger key — `buildWorkflowPrefixKey` receives the EFFECTIVE
 *      effort (agentDef.effort), so equal-effective-effort siblings share a
 *      stagger bucket even when one arrives via env and one via name.
 *
 * Harness: mock.module runAgent (captures `agentDefinition`, yields one
 * assistant message — journalSaveWarn305.test.ts convention) + a spy
 * stagger gate capturing every prefixKey. Module mocks are restored in
 * afterAll (Bun's mock.module crosses file boundaries in the same worker).
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ── runAgent spy ─────────────────────────────────────────────────────────

const REAL_RUN_AGENT = await import('../../AgentTool/runAgent.js')
const capturedDefs: Array<{ effort?: unknown; agentType?: string }> = []
const AGENT_RESULT_TEXT = 'wiring-seam-agent-result'
function fakeRunAgent(params: { agentDefinition: unknown }): AsyncGenerator<never, void, unknown> {
  capturedDefs.push(params.agentDefinition as { effort?: unknown; agentType?: string })
  return (async function* () {
    yield {
      type: 'assistant',
      uuid: 'msg_wiring_1',
      message: {
        id: 'msg_wiring_1',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: AGENT_RESULT_TEXT }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: undefined,
      },
    }
  })() as never
}
mock.module('../../AgentTool/runAgent.js', () => ({
  ...REAL_RUN_AGENT,
  runAgent: fakeRunAgent,
}))

// ── prefix-stagger gate spy ──────────────────────────────────────────────

const REAL_PREFIX_STAGGER = await import('../prefixStagger.js')
const capturedKeys: string[] = []
const fakeGate = {
  enter: async (key: string) => {
    capturedKeys.push(key)
    return { leader: true, waitedMs: 0, responded: () => {}, done: () => {} }
  },
}
mock.module('../prefixStagger.js', () => ({
  ...REAL_PREFIX_STAGGER,
  getWorkflowPrefixStaggerGate: () => fakeGate,
  getWorkflowPrefixStaggerCapMs: () => 0,
}))

afterAll(() => {
  mock.module('../../AgentTool/runAgent.js', () => ({ ...REAL_RUN_AGENT }))
  mock.module('../prefixStagger.js', () => ({ ...REAL_PREFIX_STAGGER }))
})

const { createPrimitives } = await import('../primitives.js')
type WorkflowRuntimeContext = import('../primitives.js').WorkflowRuntimeContext

// ── ctx fixture (journalSaveWarn305 shape) ──────────────────────────────

function mockCtx(): WorkflowRuntimeContext {
  return {
    runId: 'wf_wiring316',
    workflowName: 'test',
    toolUseContext: {
      abortController: new AbortController(),
      messages: [],
      options: { tools: [] },
    },
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    availableTools: [],
    journal: undefined,
    cachedResults: undefined,
    tokenBudget: null,
    counters: { agentCount: 0, spentTokens: 0, failures: [], logs: [] },
    currentPhase: '',
    workflowProgress: [],
    seedPhaseTitles: [],
    abortController: new AbortController(),
    onProgress: undefined,
    resolveWorkflowScript: undefined,
  } as unknown as WorkflowRuntimeContext
}

const ENV_VAR = 'CLAUDE_CODE_SUBAGENT_EFFORT'
const SAVED = process.env[ENV_VAR]

beforeEach(() => {
  delete process.env[ENV_VAR]
  capturedDefs.length = 0
  capturedKeys.length = 0
})

afterEach(() => {
  if (SAVED === undefined) {
    delete process.env[ENV_VAR]
  } else {
    process.env[ENV_VAR] = SAVED
  }
})

/** buildWorkflowPrefixKey slot order: model\neffort\nagentType\ntools\nschema\ncwd. */
function effortSlot(key: string): string {
  return key.split('\n')[1] ?? ''
}

describe('CC 2.1.316 (review P2-1): SUBAGENT_EFFORT wiring seam inside agent()', () => {
  test('env default is stamped onto agentDef AND reaches the prefix-stagger key', async () => {
    process.env[ENV_VAR] = 'xhigh'
    const { agent } = createPrimitives(mockCtx())
    const result = await agent('wiring probe')
    expect(result).toBe(AGENT_RESULT_TEXT)
    expect(capturedDefs).toHaveLength(1)
    expect(capturedDefs[0]!.effort).toBe('xhigh')
    expect(capturedKeys).toHaveLength(1)
    expect(effortSlot(capturedKeys[0]!)).toBe('xhigh')
  })

  test('a named effort still wins over the env default', async () => {
    process.env[ENV_VAR] = 'xhigh'
    const { agent } = createPrimitives(mockCtx())
    await agent('wiring probe', { effort: 'low' })
    expect(capturedDefs[0]!.effort).toBe('low')
    expect(effortSlot(capturedKeys[0]!)).toBe('low')
  })

  test('named effort is canonicalized through the rK loose parse (med → medium)', async () => {
    const { agent } = createPrimitives(mockCtx())
    await agent('wiring probe', { effort: 'med' })
    expect(capturedDefs[0]!.effort).toBe('medium')
    expect(effortSlot(capturedKeys[0]!)).toBe('medium')
  })

  test('unparseable named effort falls through to the env default (review P2-2)', async () => {
    process.env[ENV_VAR] = 'high'
    const { agent } = createPrimitives(mockCtx())
    await agent('wiring probe', { effort: 'turbo' })
    expect(capturedDefs[0]!.effort).toBe('high')
    expect(effortSlot(capturedKeys[0]!)).toBe('high')
  })

  test('equal effective effort lands in the same stagger bucket (env-derived vs named)', async () => {
    const { agent } = createPrimitives(mockCtx())
    await agent('wiring probe', { effort: 'med' })
    await agent('wiring probe', { effort: 'medium' })
    expect(capturedKeys).toHaveLength(2)
    expect(capturedKeys[0]).toBe(capturedKeys[1])
    expect(capturedDefs[0]!.effort).toBe('medium')
    expect(capturedDefs[1]!.effort).toBe('medium')
  })

  test('no env + no named → agentDef carries no effort and the key effort slot is empty', async () => {
    const { agent } = createPrimitives(mockCtx())
    await agent('wiring probe')
    expect(capturedDefs[0]!.effort).toBeUndefined()
    expect(effortSlot(capturedKeys[0]!)).toBe('')
  })
})
