import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { StreamingToolExecutor } from '../StreamingToolExecutor.js'
import {
  _resetExclusiveCallRegistryForTesting,
  getExclusiveCallQueuedBehind,
} from '../exclusiveCallRegistry.js'

/**
 * Official 2.1.295 #026: the streaming executor registers every executing
 * tool call in the global exclusiveCallQueuedBehind registry (binary
 * `executeTool`: `T.set(e.id,C)` with isQueued/mayYetBeQueued closures and a
 * `using`-disposal that identity-guards the delete), and flips
 * `responseOpen=false` at the top of getRemainingResults (binary:
 * `if(this.responseOpen=!1,this.discarded)return`).
 *
 * Uses the REAL runToolUse pipeline (same harness pattern as
 * writeCoerceNote280.test.ts) — no module mocks, so nothing leaks into
 * sibling test files.
 */

// Per-tool-name release gates so tests control exactly when a call finishes.
const releaseGates = new Map<string, () => void>()

function makeFakeTool(name: string, isConcurrencySafe: boolean): Tool {
  return {
    name,
    maxResultSizeChars: 100_000,
    inputSchema: z.object({}).passthrough(),
    isConcurrencySafe: () => isConcurrencySafe,
    call: async () => {
      await new Promise<void>(resolve => {
        releaseGates.set(name, resolve)
      })
      return { data: `DONE:${name}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseID: string) => ({
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: String(data),
    }),
  } as unknown as Tool
}

const AGENT_TOOL = makeFakeTool('FakeAgent026', false)
const EDIT_TOOL = makeFakeTool('FakeEdit026', false)
const READ_TOOL = makeFakeTool('FakeRead026', true)
const TOOLS = [AGENT_TOOL, EDIT_TOOL, READ_TOOL]

function makeContext(): ToolUseContext {
  return {
    options: {
      tools: TOOLS,
      mcpClients: {},
      mainLoopModel: 'claude-opus-5',
    },
    abortController: new AbortController(),
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => ({ ...getDefaultAppState() }),
    setInProgressToolUseIDs: () => {},
  } as unknown as ToolUseContext
}

const canUseTool = (async (
  _t: Tool,
  seenInput: Record<string, unknown>,
) => ({ behavior: 'allow', updatedInput: seenInput })) as never

function makeBlock(id: string, name: string) {
  return { type: 'tool_use', id, name, input: {} } as never
}

function makeAssistantMessage(id: string) {
  return {
    uuid: `uuid-${id}`,
    message: { id: `msg-${id}`, role: 'assistant', content: [] },
  } as never
}

function makeExecutor(): StreamingToolExecutor {
  return new StreamingToolExecutor(TOOLS, canUseTool, makeContext())
}

function release(name: string): void {
  releaseGates.get(name)?.()
}

/** Poll until the tool's call() has actually reached its gate, then release. */
async function releaseWhenGated(name: string): Promise<void> {
  for (let i = 0; i < 100 && !releaseGates.has(name); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  release(name)
}

describe('CC 2.1.295 #026: StreamingToolExecutor exclusive-call registration', () => {
  beforeEach(() => {
    _resetExclusiveCallRegistryForTesting()
    releaseGates.clear()
  })

  test('registers a hold for the executing call whose isQueued() sees a non-concurrency-safe call queued behind it', () => {
    // Arrange
    const executor = makeExecutor()

    // Act — the Agent-like call starts executing; the Edit-like call must
    // wait behind it (non-concurrency-safe)
    executor.addTool(makeBlock('tu_agent', 'FakeAgent026'), makeAssistantMessage('tu_agent'))
    executor.addTool(makeBlock('tu_edit', 'FakeEdit026'), makeAssistantMessage('tu_edit'))

    // Assert — binary C={isQueued:()=>!this.discarded&&this.tools.slice(
    //   this.tools.indexOf(e)+1).some((R)=>R.status==="queued"&&!R.isConcurrencySafe),...}
    const hold = getExclusiveCallQueuedBehind('tu_agent')
    expect(hold).toBeDefined()
    expect(hold!.isQueued()).toBe(true)
    // responseOpen is still true — the response has not been drained yet
    expect(hold!.mayYetBeQueued()).toBe(true)
    expect(hold!.holdLogged).toBe(false)
    // The queued call has not started, so it has no registry entry
    expect(getExclusiveCallQueuedBehind('tu_edit')).toBeUndefined()

    // Cleanup — release the executing tool
    release('FakeAgent026')
  })

  test('isQueued() is false when only a concurrency-safe call is queued behind (binary: !R.isConcurrencySafe)', () => {
    // Arrange
    const executor = makeExecutor()

    // Act — a Read-like (concurrency-safe) call queued behind the exclusive
    // Agent-like call does NOT hold auto-background
    executor.addTool(makeBlock('tu_agent2', 'FakeAgent026'), makeAssistantMessage('tu_agent2'))
    executor.addTool(makeBlock('tu_read', 'FakeRead026'), makeAssistantMessage('tu_read'))

    // Assert
    const hold = getExclusiveCallQueuedBehind('tu_agent2')
    expect(hold).toBeDefined()
    expect(hold!.isQueued()).toBe(false)
    expect(hold!.mayYetBeQueued()).toBe(true)

    // Cleanup
    release('FakeAgent026')
    release('FakeRead026')
  })

  test('getRemainingResults flips responseOpen so mayYetBeQueued() becomes false (binary: if(this.responseOpen=!1,...))', async () => {
    // Arrange
    const executor = makeExecutor()
    executor.addTool(makeBlock('tu_agent3', 'FakeAgent026'), makeAssistantMessage('tu_agent3'))
    const hold = getExclusiveCallQueuedBehind('tu_agent3')
    expect(hold).toBeDefined()
    expect(hold!.mayYetBeQueued()).toBe(true)

    // Act — start draining remaining results (sets responseOpen=false),
    // then release the tool so the drain can finish
    const drained: unknown[] = []
    const drainPromise = (async () => {
      for await (const update of executor.getRemainingResults()) {
        drained.push(update)
      }
    })()
    await new Promise(resolve => setTimeout(resolve, 10))

    // Assert — the response is now closed
    expect(hold!.mayYetBeQueued()).toBe(false)

    // Act — finish the tool and drain
    await releaseWhenGated('FakeAgent026')
    await drainPromise

    // Assert — results flowed and the registry entry was cleared on
    // completion (binary `using` disposal → identity-guarded delete)
    expect(drained.length).toBeGreaterThan(0)
    expect(getExclusiveCallQueuedBehind('tu_agent3')).toBeUndefined()
  })

  test('the hold entry is cleared once the executing call completes and the queued exclusive call runs after it', async () => {
    // Arrange
    const executor = makeExecutor()
    executor.addTool(makeBlock('tu_agent4', 'FakeAgent026'), makeAssistantMessage('tu_agent4'))
    executor.addTool(makeBlock('tu_edit4', 'FakeEdit026'), makeAssistantMessage('tu_edit4'))
    expect(getExclusiveCallQueuedBehind('tu_agent4')).toBeDefined()

    // Act — release the agent; the queued edit starts only afterwards
    await releaseWhenGated('FakeAgent026')
    let editHold = getExclusiveCallQueuedBehind('tu_edit4')
    for (let i = 0; i < 100 && editHold === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      editHold = getExclusiveCallQueuedBehind('tu_edit4')
    }
    expect(editHold).toBeDefined()
    await releaseWhenGated('FakeEdit026')

    const drained: unknown[] = []
    for await (const update of executor.getRemainingResults()) {
      drained.push(update)
    }

    // Assert — both entries disposed; both results yielded in order
    expect(getExclusiveCallQueuedBehind('tu_agent4')).toBeUndefined()
    expect(getExclusiveCallQueuedBehind('tu_edit4')).toBeUndefined()
    expect(drained.length).toBeGreaterThanOrEqual(2)
  })
})
