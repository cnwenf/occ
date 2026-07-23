import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

/**
 * 2.1.218 #22: context-overflow retry loop + Ctrl+B background-shell caps.
 *
 * Part (i): when a context-overflow error ("input length and `max_tokens`
 * exceed context limit") fires with a large thinking budget, the retry loop
 * must NOT re-send the identical doomed request. Previously, the adjusted
 * max_tokens was set to `minRequired` (= thinking budget + 1) which still
 * exceeded the context window, so the loop retried forever with the same
 * oversized request.
 *
 * Part (ii): Ctrl+B backgrounding (`startBackgroundSession`) must apply the
 * same subagent caps (`assertSubagentCapAndIncrement` +
 * `claimConcurrentSubagentSlot`) as other spawn paths (`runAgent`). When the
 * concurrent cap is reached, the background session must be denied (the query
 * is never called), matching how `runAgent` throws on cap exceeded.
 */

// --- Part (i): withRetry context-overflow --------------------------------

const {
  withRetry,
  CannotRetryError,
  parseMaxTokensContextOverflowError,
} = require('../withRetry.js') as typeof import('../withRetry.js')

/**
 * Build an APIError that parseMaxTokensContextOverflowError will match.
 * Format: "input length and `max_tokens` exceed context limit: X + Y > Z"
 */
function makeOverflowError(
  inputTokens: number,
  maxTokens: number,
  contextLimit: number,
): APIError {
  const message = `input length and \`max_tokens\` exceed context limit: ${inputTokens} + ${maxTokens} > ${contextLimit}`
  return new APIError(400, { message }, message, undefined)
}

describe('2.1.218 #22 (i) — context-overflow retry with large thinking budget', () => {
  test('does NOT re-send identical doomed request when thinking budget exceeds available context', async () => {
    // Arrange: inputTokens=180000, contextLimit=200000, safetyBuffer=1000
    // availableContext = 200000 - 180000 - 1000 = 19000
    // thinking budget = 50000 → minRequired = 50001 > 19000
    // Without the fix: adjustedMaxTokens = 50001, which still overflows
    // (180000 + 50001 > 200000), so the loop retries forever.
    const error = makeOverflowError(180000, 20000, 200000)

    let attempts = 0
    const options = {
      maxRetries: 10,
      model: 'test-model',
      thinkingConfig: { type: 'enabled' as const, budgetTokens: 50000 },
    }

    const gen = withRetry(
      async () => ({}) as never,
      async () => {
        attempts++
        throw error
      },
      options,
    )

    let threw = false
    let thrown: unknown
    try {
      while (true) {
        const next = await gen.next()
        if (next.done) break
      }
    } catch (e) {
      threw = true
      thrown = e
    }

    // The loop must fail fast — NOT retry the doomed request.
    expect(threw).toBe(true)
    // Only 1 attempt: the overflow was detected and the error thrown
    // immediately, not retried.
    expect(attempts).toBe(1)
    // The thrown error should be the original overflow error (not a
    // generic CannotRetryError from exhaustion).
    expect(thrown).toBe(error)
  })

  test('retries with adjusted max_tokens when thinking budget fits in available context', async () => {
    // Arrange: inputTokens=180000, contextLimit=200000, safetyBuffer=1000
    // availableContext = 19000
    // thinking budget = 5000 → minRequired = 5001 <= 19000
    // adjustedMaxTokens = max(3000, 19000, 5001) = 19000
    // 180000 + 19000 = 199000 < 200000 → no overflow on retry
    let callCount = 0
    const error = makeOverflowError(180000, 20000, 200000)

    const options = {
      maxRetries: 10,
      model: 'test-model',
      thinkingConfig: { type: 'enabled' as const, budgetTokens: 5000 },
    }

    const gen = withRetry(
      async () => ({}) as never,
      async (_client: unknown, _attempt: number, context: { maxTokensOverride?: number }) => {
        callCount++
        if (callCount === 1) {
          throw error
        }
        // On retry, maxTokensOverride should be set to the adjusted value
        expect(context.maxTokensOverride).toBe(19000)
        return 'success' as never
      },
      options,
    )

    let result: unknown
    while (true) {
      const next = await gen.next()
      if (next.done) {
        result = next.value
        break
      }
    }

    // The retry succeeded with adjusted max_tokens.
    expect(callCount).toBe(2)
    expect(result).toBe('success')
  })

  test('parseMaxTokensContextOverflowError extracts token counts from error message', () => {
    const error = makeOverflowError(188059, 20000, 200000)
    const parsed = parseMaxTokensContextOverflowError(error)
    expect(parsed).toEqual({
      inputTokens: 188059,
      maxTokens: 20000,
      contextLimit: 200000,
    })
  })
})

// --- Part (ii): Ctrl+B background-session subagent caps -------------------

// Mock query so we can verify whether it's called without running a real
// agent loop. Must be set up before any import of LocalMainSessionTask.
const queryMock = mock(() =>
  (async function* () {
    /* never yields — cap should block before this runs */
  })(),
)
mock.module('../../../query.js', () => ({
  ...require('../../../query.js'),
  query: queryMock,
}))

// Mock disk-output + transcript writes so no real filesystem side effects.
mock.module('../../../utils/task/diskOutput.js', () => ({
  ...require('../../../utils/task/diskOutput.js'),
  initTaskOutputAsSymlink: () => {},
  evictTaskOutput: () => {},
  getTaskOutputPath: () => '/dev/null',
}))
mock.module('../../../utils/sessionStorage.js', () => ({
  ...require('../../../utils/sessionStorage.js'),
  recordSidechainTranscript: () => Promise.resolve(),
  getAgentTranscriptPath: () => '/dev/null',
}))

const {
  startBackgroundSession,
} = require('../../../tasks/LocalMainSessionTask.js') as typeof import('../../../tasks/LocalMainSessionTask.js')
const { TaskRegistryImpl } = require('../../../utils/taskRegistry.js') as typeof import('../../../utils/taskRegistry.js')
const { resetStateForTests } = require('../../../bootstrap/state.js') as {
  resetStateForTests: () => void
}

const CONCURRENT_ENV = 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'
const SPAWN_ENV = 'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION'
const origConcurrent = process.env[CONCURRENT_ENV]
const origSpawn = process.env[SPAWN_ENV]

beforeEach(() => {
  delete process.env[CONCURRENT_ENV]
  delete process.env[SPAWN_ENV]
  if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test'
  resetStateForTests()
  queryMock.mockClear()
})

afterEach(() => {
  if (origConcurrent === undefined) delete process.env[CONCURRENT_ENV]
  else process.env[CONCURRENT_ENV] = origConcurrent
  if (origSpawn === undefined) delete process.env[SPAWN_ENV]
  else process.env[SPAWN_ENV] = origSpawn
  resetStateForTests()
})

describe('2.1.218 #22 (ii) — Ctrl+B backgrounding applies subagent caps', () => {
  test('does NOT call query when concurrent subagent cap is reached', async () => {
    // Arrange: cap=1, pre-fill concurrent count to 1
    process.env[CONCURRENT_ENV] = '1'
    const reg = new TaskRegistryImpl()
    // Take the one available slot so the cap is full.
    reg.takeConcurrencySlot()

    const taskStates: Record<string, unknown> = { tasks: {} }
    const setAppState = (updater: (prev: any) => any) => {
      const next = updater(taskStates)
      if (next && typeof next === 'object') {
        Object.assign(taskStates, next)
      }
    }

    const toolUseContext = { taskRegistry: reg } as never

    startBackgroundSession({
      messages: [],
      queryParams: {
        systemPrompt: { cache: [] } as never,
        userContext: {},
        systemContext: {},
        canUseTool: (async () => ({
          behavior: 'allow',
          updatedInput: {},
        })) as never,
        toolUseContext,
        querySource: 'repl_main_thread',
      } as never,
      description: 'test-bg-session',
      setAppState,
    })

    // Wait for the async runWithAgentContext callback to settle.
    await new Promise(resolve => setTimeout(resolve, 200))

    // The query must NOT have been called — the cap blocked it.
    expect(queryMock).toHaveBeenCalledTimes(0)
  })

  test('calls query when concurrent subagent cap is NOT reached', async () => {
    // Arrange: cap=10 (default), no pre-filled slots
    const reg = new TaskRegistryImpl()

    const taskStates: Record<string, unknown> = { tasks: {} }
    const setAppState = (updater: (prev: any) => any) => {
      const next = updater(taskStates)
      if (next && typeof next === 'object') {
        Object.assign(taskStates, next)
      }
    }

    const toolUseContext = { taskRegistry: reg } as never

    startBackgroundSession({
      messages: [],
      queryParams: {
        systemPrompt: { cache: [] } as never,
        userContext: {},
        systemContext: {},
        canUseTool: (async () => ({
          behavior: 'allow',
          updatedInput: {},
        })) as never,
        toolUseContext,
        querySource: 'repl_main_thread',
      } as never,
      description: 'test-bg-session',
      setAppState,
    })

    // Wait for the async callback to settle.
    await new Promise(resolve => setTimeout(resolve, 200))

    // The query SHOULD have been called — cap not reached.
    expect(queryMock).toHaveBeenCalledTimes(1)
  })
})
