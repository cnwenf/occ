/**
 * CC 2.1.295 (#026) — exclusive-call-queued-behind registry + the
 * StreamingToolExecutor writer side of the auto-background hold fix.
 *
 * Official face (binary forensics, s295 / added.txt):
 *  - `Gn().exclusiveCallQueuedBehind` Map — NEW in 295 (0 hits in s294,
 *    4 hits in s295).
 *  - Scheduler registration in executeTool (s295 @9365045):
 *    `C={isQueued:()=>!this.discarded&&this.tools.slice(this.tools.indexOf(e)
 *    +1).some((R)=>R.status==="queued"&&!R.isConcurrencySafe),mayYetBeQueued:
 *    ()=>!this.discarded&&this.responseOpen,holdLogged:!1};T.set(e.id,C);`
 *    disposed via `if(T.get(e.id)===C)T.delete(e.id)` (identity guard).
 *  - `responseOpen=!0` on the executor class (s295 @9359360), flipped false
 *    at the top of `getRemainingResults` (s295 @9367479).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  clearExclusiveQueuedBehindCheck,
  getExclusiveQueuedBehindCheck,
  resetExclusiveQueuedBehindRegistry,
  setExclusiveQueuedBehindCheck,
  type ExclusiveQueuedBehindCheck,
} from '../exclusiveCallRegistry.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage, Message } from '../../../types/message.js'

// ---------------------------------------------------------------------------
// Mock runToolUse (OCC-97/OCC-103 delegation pattern): the fake generator
// blocks on a per-tool-id gate so the test controls when a tool finishes.
// ---------------------------------------------------------------------------

let mockActive = false
const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>()

function armGate(toolUseId: string): void {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  gates.set(toolUseId, { promise, resolve })
}

async function* fakeRunToolUse(block: { id: string }) {
  const gate = gates.get(block.id)
  if (gate) {
    await gate.promise
  }
  yield {
    message: {
      type: 'user',
      uuid: `result-${block.id}`,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: block.id, content: 'ok' }],
      },
    } as unknown as Message,
  }
}

let actualToolExecutionMod: Record<string, unknown>
let realRunToolUse: (...args: unknown[]) => unknown

let mod: typeof import('../StreamingToolExecutor.js')

beforeAll(async () => {
  actualToolExecutionMod = (await import('../toolExecution.js')) as unknown as Record<string, unknown>
  realRunToolUse = actualToolExecutionMod.runToolUse as (...args: unknown[]) => unknown

  mock.module('../toolExecution.js', () => ({
    ...actualToolExecutionMod,
    runToolUse: (...args: unknown[]) => {
      if (!mockActive) {
        return realRunToolUse(...args)
      }
      const block = args[0] as { id: string }
      return fakeRunToolUse(block)
    },
  }))

  mockActive = true
  mod = await import('../StreamingToolExecutor.js')
})

afterAll(() => {
  mockActive = false
})

beforeEach(() => {
  resetExclusiveQueuedBehindRegistry()
  gates.clear()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    setInProgressToolUseIDs: () => {},
    setHasInterruptibleToolInProgress: () => {},
    options: {},
    readFileState: {},
    getAppState: () => ({}),
  } as unknown as ToolUseContext
}

function makeTool(name: string, isConcurrencySafe: boolean) {
  return {
    name,
    inputSchema: {
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    isConcurrencySafe: () => isConcurrencySafe,
    isReadOnly: () => false,
  }
}

function makeBlock(id: string, name: string) {
  return { type: 'tool_use', id, name, input: {} } as never
}

function makeAssistantMessage(): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'assistant-1',
    message: { id: 'm1', role: 'assistant', content: [] },
    costUSD: 0,
    durationMs: 0,
    isSidechain: false,
    parentUuid: null,
    timestamp: new Date().toISOString(),
  } as unknown as AssistantMessage
}

function makeExecutor() {
  const tools = [makeTool('Agent', true), makeTool('Edit', false)] as never
  return new mod.StreamingToolExecutor(
    tools,
    undefined as never,
    makeContext(),
  )
}

// ---------------------------------------------------------------------------
// Registry semantics
// ---------------------------------------------------------------------------

describe('exclusiveCallQueuedBehind registry (official Gn().exclusiveCallQueuedBehind)', () => {
  test('set/get round-trip by tool use id', () => {
    const check: ExclusiveQueuedBehindCheck = {
      isQueued: () => true,
      mayYetBeQueued: () => false,
      holdLogged: false,
    }
    setExclusiveQueuedBehindCheck('tu_1', check)
    expect(getExclusiveQueuedBehindCheck('tu_1')).toBe(check)
    expect(getExclusiveQueuedBehindCheck('tu_missing')).toBeUndefined()
  })

  test('clear is identity-guarded — a stale dispose never removes a newer entry', () => {
    const old: ExclusiveQueuedBehindCheck = {
      isQueued: () => false,
      mayYetBeQueued: () => false,
      holdLogged: false,
    }
    const fresh: ExclusiveQueuedBehindCheck = {
      isQueued: () => true,
      mayYetBeQueued: () => false,
      holdLogged: false,
    }
    setExclusiveQueuedBehindCheck('tu_1', old)
    setExclusiveQueuedBehindCheck('tu_1', fresh)
    // Official dispose: `if(T.get(e.id)===C)T.delete(e.id)` — old !== stored.
    clearExclusiveQueuedBehindCheck('tu_1', old)
    expect(getExclusiveQueuedBehindCheck('tu_1')).toBe(fresh)
    clearExclusiveQueuedBehindCheck('tu_1', fresh)
    expect(getExclusiveQueuedBehindCheck('tu_1')).toBeUndefined()
  })

  test('reset clears every entry', () => {
    const check: ExclusiveQueuedBehindCheck = {
      isQueued: () => false,
      mayYetBeQueued: () => false,
      holdLogged: false,
    }
    setExclusiveQueuedBehindCheck('a', check)
    setExclusiveQueuedBehindCheck('b', check)
    resetExclusiveQueuedBehindRegistry()
    expect(getExclusiveQueuedBehindCheck('a')).toBeUndefined()
    expect(getExclusiveQueuedBehindCheck('b')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// StreamingToolExecutor writer side
// ---------------------------------------------------------------------------

describe('StreamingToolExecutor exclusive-call registration (official s295 @9365045)', () => {
  test('registers a check for the executing tool; isQueued true while an exclusive call is queued behind', async () => {
    armGate('tu_agent')
    const executor = makeExecutor()
    const assistant = makeAssistantMessage()

    executor.addTool(makeBlock('tu_agent', 'Agent'), assistant)
    // Let processQueue → executeTool run its synchronous registration part.
    await Promise.resolve()
    await Promise.resolve()

    const check = getExclusiveQueuedBehindCheck('tu_agent')
    expect(check).toBeDefined()
    // Nothing queued behind yet.
    expect(check!.isQueued()).toBe(false)
    // Response still open → an exclusive call may yet arrive.
    expect(check!.mayYetBeQueued()).toBe(true)
    expect(check!.holdLogged).toBe(false)

    // A non-concurrency-safe Edit queues behind the running Agent call and
    // cannot start while the Agent call executes.
    executor.addTool(makeBlock('tu_edit', 'Edit'), assistant)
    await Promise.resolve()
    await Promise.resolve()
    expect(check!.isQueued()).toBe(true)

    // Drain: getRemainingResults flips responseOpen false (s295 @9367479).
    gates.get('tu_agent')!.resolve()
    const gen = executor.getRemainingResults()
    let r = await gen.next()
    while (!r.done) {
      r = await gen.next()
    }
    // responseOpen false → mayYetBeQueued false.
    expect(check!.mayYetBeQueued()).toBe(false)
    // Completion disposed the entry (identity-guarded delete).
    expect(getExclusiveQueuedBehindCheck('tu_agent')).toBeUndefined()
  })

  test('discard() forces both predicates false (official !this.discarded guards)', async () => {
    armGate('tu_agent2')
    const executor = makeExecutor()
    const assistant = makeAssistantMessage()

    executor.addTool(makeBlock('tu_agent2', 'Agent'), assistant)
    executor.addTool(makeBlock('tu_edit2', 'Edit'), assistant)
    await Promise.resolve()
    await Promise.resolve()

    const check = getExclusiveQueuedBehindCheck('tu_agent2')
    expect(check).toBeDefined()
    expect(check!.isQueued()).toBe(true)
    expect(check!.mayYetBeQueued()).toBe(true)

    executor.discard()
    expect(check!.isQueued()).toBe(false)
    expect(check!.mayYetBeQueued()).toBe(false)

    gates.get('tu_agent2')!.resolve()
  })

  test('a concurrency-safe tool queued behind does NOT hold (official !R.isConcurrencySafe)', async () => {
    armGate('tu_agent3')
    const executor = makeExecutor()
    const assistant = makeAssistantMessage()

    executor.addTool(makeBlock('tu_agent3', 'Agent'), assistant)
    await Promise.resolve()
    await Promise.resolve()
    // Second Agent call is concurrency-safe → may run alongside, no hold.
    executor.addTool(makeBlock('tu_agent3b', 'Agent'), assistant)
    await Promise.resolve()
    await Promise.resolve()

    const check = getExclusiveQueuedBehindCheck('tu_agent3')
    expect(check).toBeDefined()
    expect(check!.isQueued()).toBe(false)

    armGate('tu_agent3b')
    gates.get('tu_agent3')!.resolve()
    gates.get('tu_agent3b')!.resolve()
  })
})
