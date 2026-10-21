import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.305 — workflow journal save-failure warning (binary claude
 * @260784887, byte-verified; novel s305 string, 0 hits in s304).
 *
 * Official v305 replaces the silent `.catch(() => {})` on the agent()
 * journal save with:
 *   `t(`workflow journal: did not save an agent() result, so a resumed run
 *     will re-run from this call: ${cHe(He).msg}`, {level:"warn"})`
 * The agent result is still returned either way — a resumed run simply
 * re-runs from this call. (Official also detaches the journal writer via
 * St(); OCC's WorkflowJournal has no detach API, so the warn is the portable
 * half of the fix — documented deviation in docs/gap-research-306/impl-WP7.md.)
 *
 * Harness: mock.module runAgent (async generator yielding one assistant
 * message — drainGenerator collects it, extractAgentTextResult reads the
 * text block) + a debug.js spy capturing logForDebugging(message, options)
 * per the forkSubagentSourceValidation302.test.ts spread-real convention.
 * Module mocks are restored in afterAll (Bun's mock.module crosses file
 * boundaries in the same worker).
 */

// ── module spies (load-time snapshots spread in — bun mock.module live bindings) ──

const REAL_DEBUG = await import('../../../utils/debug.js')
const debugCalls: Array<{ message: string; options?: { level?: string } }> = []
mock.module('../../../utils/debug.js', () => ({
  ...REAL_DEBUG,
  logForDebugging: (message: string, options?: { level?: string }) => {
    debugCalls.push({ message, options })
  },
}))

const REAL_RUN_AGENT = await import('../../AgentTool/runAgent.js')
const AGENT_RESULT_TEXT = 'journal-warn-agent-result'
function fakeRunAgent(): AsyncGenerator<never, void, unknown> {
  // One assistant message with a single text block — the minimal drain that
  // extractAgentTextResult turns into the agent() return value.
  return (async function* () {
    yield {
      type: 'assistant',
      uuid: 'msg_journal_warn_1',
      message: {
        id: 'msg_journal_warn_1',
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

afterAll(() => {
  mock.module('../../../utils/debug.js', () => ({ ...REAL_DEBUG }))
  mock.module('../../AgentTool/runAgent.js', () => ({ ...REAL_RUN_AGENT }))
})

const { createPrimitives } = await import('../primitives.js')
type WorkflowRuntimeContext = import('../primitives.js').WorkflowRuntimeContext

// ── ctx fixtures ─────────────────────────────────────────────────────────

const WARN_PREFIX =
  'workflow journal: did not save an agent() result, so a resumed run will re-run from this call: '

function mockCtx(journal: unknown): WorkflowRuntimeContext {
  return {
    runId: 'wf_journalwarn305',
    workflowName: 'test',
    toolUseContext: {
      abortController: new AbortController(),
      messages: [],
      options: { tools: [] },
    },
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    availableTools: [],
    journal,
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

function failingJournal() {
  return {
    appendStarted: async () => {},
    appendResult: async () => {
      throw new Error('ENOSPC: journal disk full')
    },
  }
}

function healthyJournal() {
  return {
    appendStarted: async () => {},
    appendResult: async () => {},
  }
}

function journalWarns(): Array<{ message: string; options?: { level?: string } }> {
  return debugCalls.filter(c => c.message.startsWith(WARN_PREFIX))
}

describe('CC 2.1.305: workflow journal save-failure warning', () => {
  beforeEach(() => {
    debugCalls.length = 0
  })

  test('warns with the official message at warn level when appendResult rejects', async () => {
    // Arrange
    const ctx = mockCtx(failingJournal())
    const { agent } = createPrimitives(ctx)

    // Act
    const result = await agent('do the thing')

    // Assert — the agent result is STILL returned (official: the warn is
    // fire-and-forget in the catch; the run continues).
    expect(result).toBe(AGENT_RESULT_TEXT)
    const warns = journalWarns()
    expect(warns.length).toBe(1)
    expect(warns[0].message).toBe(
      `${WARN_PREFIX}ENOSPC: journal disk full`,
    )
    expect(warns[0].options?.level).toBe('warn')
    // The agent completed normally otherwise (counted, no failure recorded).
    expect(ctx.counters.agentCount).toBe(1)
    expect(ctx.counters.failures.length).toBe(0)
  })

  test('stays silent when the journal save succeeds', async () => {
    // Arrange
    const ctx = mockCtx(healthyJournal())
    const { agent } = createPrimitives(ctx)

    // Act
    const result = await agent('do the thing')

    // Assert — no warn (the catch never fires on a resolved appendResult).
    expect(result).toBe(AGENT_RESULT_TEXT)
    expect(journalWarns().length).toBe(0)
    expect(ctx.counters.agentCount).toBe(1)
  })

  test('stays silent when no journal is attached (journal === undefined)', async () => {
    // Arrange — the append block is gated on ctx.journal.
    const ctx = mockCtx(undefined)
    const { agent } = createPrimitives(ctx)

    // Act
    const result = await agent('do the thing')

    // Assert
    expect(result).toBe(AGENT_RESULT_TEXT)
    expect(journalWarns().length).toBe(0)
  })
})
