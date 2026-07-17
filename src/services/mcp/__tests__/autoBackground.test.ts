import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  callMcpToolWithAutoBackground,
  DEFAULT_MCP_AUTO_BACKGROUND_MS,
  EXCLUDED_TOOL_TYPES,
  getMcpAutoBackgroundMs,
  MAX_MCP_AUTO_BACKGROUND_MS,
  type McpBackgroundTaskRegistry,
} from '../autoBackground.js'
import {
  makeMcpBackgroundTask,
  type McpBackgroundTaskState,
} from '../../../tasks/McpBackgroundTask/McpBackgroundTask.js'

// Reset env between tests so the ladder is deterministic.
const ENV_KEYS = [
  'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS',
  'CLAUDE_AUTO_BACKGROUND_TASKS',
] as const

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('getMcpAutoBackgroundMs (2.1.212 ladder)', () => {
  test('default is 120000ms (2 min) in interactive sessions', () => {
    expect(
      getMcpAutoBackgroundMs(undefined, {
        isNonInteractiveSession: false,
        isPipeNonInteractiveMode: () => false,
      }),
    ).toBe(DEFAULT_MCP_AUTO_BACKGROUND_MS)
    expect(DEFAULT_MCP_AUTO_BACKGROUND_MS).toBe(120000)
  })

  test('returns 0 in non-interactive sessions without CLAUDE_AUTO_BACKGROUND_TASKS', () => {
    expect(
      getMcpAutoBackgroundMs(undefined, {
        isNonInteractiveSession: true,
        isPipeNonInteractiveMode: () => false,
      }),
    ).toBe(0)
  })

  test('returns 120000 in non-interactive sessions WITH CLAUDE_AUTO_BACKGROUND_TASKS', () => {
    process.env.CLAUDE_AUTO_BACKGROUND_TASKS = '1'
    expect(
      getMcpAutoBackgroundMs(undefined, {
        isNonInteractiveSession: true,
        isPipeNonInteractiveMode: () => false,
      }),
    ).toBe(120000)
  })

  test('CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS overrides the threshold', () => {
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '5000'
    expect(
      getMcpAutoBackgroundMs(undefined, {
        isNonInteractiveSession: false,
        isPipeNonInteractiveMode: () => false,
      }),
    ).toBe(5000)
  })

  test('non-numeric CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS → 0 (disabled, no throw)', () => {
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = 'not-a-number'
    expect(
      getMcpAutoBackgroundMs(undefined, {
        isNonInteractiveSession: false,
        isPipeNonInteractiveMode: () => false,
      }),
    ).toBe(0)
  })

  test('negative CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS clamped to 0', () => {
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '-100'
    expect(
      getMcpAutoBackgroundMs(undefined, {
        isNonInteractiveSession: false,
        isPipeNonInteractiveMode: () => false,
      }),
    ).toBe(0)
  })

  test('huge CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS clamped to INT_MAX', () => {
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '99999999999'
    expect(
      getMcpAutoBackgroundMs(undefined, {
        isNonInteractiveSession: false,
        isPipeNonInteractiveMode: () => false,
      }),
    ).toBe(MAX_MCP_AUTO_BACKGROUND_MS)
    expect(MAX_MCP_AUTO_BACKGROUND_MS).toBe(2147483647)
  })

  test('pipe non-interactive mode → 0 even with CLAUDE_AUTO_BACKGROUND_TASKS', () => {
    process.env.CLAUDE_AUTO_BACKGROUND_TASKS = '1'
    expect(
      getMcpAutoBackgroundMs(undefined, {
        isNonInteractiveSession: true,
        isPipeNonInteractiveMode: () => true,
      }),
    ).toBe(0)
  })

  test('CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0 explicitly disables', () => {
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '0'
    expect(
      getMcpAutoBackgroundMs(undefined, {
        isNonInteractiveSession: false,
        isPipeNonInteractiveMode: () => false,
      }),
    ).toBe(0)
  })

  test('excluded tool types never auto-background', () => {
    // EXCLUDED_TOOL_TYPES is empty by contract; verify the ladder still
    // respects membership when we mutate the set for this test only.
    const original = new Set(EXCLUDED_TOOL_TYPES)
    try {
      ;(EXCLUDED_TOOL_TYPES as Set<string>).add('never_background')
      expect(
        getMcpAutoBackgroundMs(
          { type: 'never_background' },
          {
            isNonInteractiveSession: false,
            isPipeNonInteractiveMode: () => false,
          },
        ),
      ).toBe(0)
    } finally {
      // Restore — the set is module-singleton.
      for (const k of EXCLUDED_TOOL_TYPES) {
        if (!original.has(k)) EXCLUDED_TOOL_TYPES.delete(k)
      }
    }
  })

  test('env override applies in non-interactive sessions when opted in', () => {
    process.env.CLAUDE_AUTO_BACKGROUND_TASKS = '1'
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '7000'
    expect(
      getMcpAutoBackgroundMs(undefined, {
        isNonInteractiveSession: true,
        isPipeNonInteractiveMode: () => false,
      }),
    ).toBe(7000)
  })
})

// ---------------------------------------------------------------------------
// makeMcpBackgroundTask
// ---------------------------------------------------------------------------

describe('makeMcpBackgroundTask', () => {
  test('builds an mcp_task state with the right shape', () => {
    const ac = new AbortController()
    const task = makeMcpBackgroundTask({
      serverName: 'srv',
      toolName: 'tl',
      toolUseId: 'tuu-1',
      abortController: ac,
    })
    expect(task.type).toBe('mcp_task')
    expect(task.status).toBe('running')
    expect(task.serverName).toBe('srv')
    expect(task.toolName).toBe('tl')
    expect(task.toolUseId).toBe('tuu-1')
    expect(task.description).toBe('srv/tl')
    expect(task.mcpStatus).toBe('working')
    expect(task.abortController).toBe(ac)
    expect(task.mcpTaskId).toBe(task.id)
    expect(task.id.startsWith('p')).toBe(true) // mcp_task prefix
  })

  test('respects a custom pollIntervalMs', () => {
    const task = makeMcpBackgroundTask({
      serverName: 's',
      toolName: 't',
      toolUseId: 'u',
      abortController: new AbortController(),
      pollIntervalMs: 250,
    })
    expect(task.pollIntervalMs).toBe(250)
  })
})

// ---------------------------------------------------------------------------
// callMcpToolWithAutoBackground
// ---------------------------------------------------------------------------

// A controllable run promise: resolves/rejects on demand.
type RunHandle<T> = {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
  fn: (signal: AbortSignal) => Promise<T>
  startedWith: AbortSignal | undefined
}

function makeRun<T>(): RunHandle<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  const handle: RunHandle<T> = {
    promise,
    resolve,
    reject,
    fn: (signal: AbortSignal): Promise<T> => {
      handle.startedWith = signal
      return promise
    },
    startedWith: undefined,
  }
  return handle
}

function makeRegistry(): McpBackgroundTaskRegistry & {
  registered: McpBackgroundTaskState[]
} {
  const registered: McpBackgroundTaskState[] = []
  return {
    registered,
    register(task) {
      registered.push(task)
    },
  }
}

describe('callMcpToolWithAutoBackground', () => {
  test('tool resolves before the threshold → returns the tool result, no backgrounding', async () => {
    const run = makeRun<{ content: string }>()
    const registry = makeRegistry()
    const onBackgrounded = () => {
      throw new Error('should not background')
    }

    const outcomeP = callMcpToolWithAutoBackground({
      run: run.fn,
      serverName: 'srv',
      toolName: 'tl',
      toolUseId: 'tuu-1',
      parentAbortController: new AbortController(),
      taskRegistry: registry,
      autoBackgroundMs: 10000, // large; tool will resolve first
      onBackgrounded,
    })

    // Resolve the tool almost immediately.
    run.resolve({ content: 'done' })
    const outcome = await outcomeP

    expect(outcome.kind).toBe('settled')
    if (outcome.kind === 'settled') {
      expect(outcome.result).toEqual({ content: 'done' })
    }
    expect(registry.registered.length).toBe(0)
  })

  test('tool exceeds the threshold → backgrounds: registers task, calls onBackgrounded, run still pending', async () => {
    const run = makeRun<{ content: string }>()
    const registry = makeRegistry()
    let backgroundedCalls = 0

    const outcomeP = callMcpToolWithAutoBackground({
      run: run.fn,
      serverName: 'srv',
      toolName: 'tl',
      toolUseId: 'tuu-1',
      parentAbortController: new AbortController(),
      taskRegistry: registry,
      autoBackgroundMs: 50, // tiny threshold
      onBackgrounded: () => {
        backgroundedCalls++
      },
    })

    const outcome = await outcomeP
    expect(outcome.kind).toBe('backgrounded')
    if (outcome.kind === 'backgrounded') {
      expect(outcome.serverName).toBe('srv')
      expect(outcome.toolName).toBe('tl')
      expect(outcome.toolUseId).toBe('tuu-1')
      expect(outcome.task.type).toBe('mcp_task')
      expect(outcome.task.mcpStatus).toBe('working')
    }
    expect(registry.registered.length).toBe(1)
    expect(backgroundedCalls).toBe(1)

    // The run is NOT aborted — it's still pending. Resolving it later must
    // not throw (the backgrounded path attaches a no-op catcher).
    run.resolve({ content: 'late' })
    // Drain the microtask queue so the no-op catch runs.
    await Promise.resolve()
    await Promise.resolve()
  })

  test('backgrounded run that later rejects does not emit unhandledRejection', async () => {
    const run = makeRun<{ content: string }>()
    const registry = makeRegistry()
    const warnings: string[] = []
    const onWarning = (e: unknown) => {
      warnings.push(String(e))
    }
    process.on('unhandledRejection', onWarning)

    const outcome = await callMcpToolWithAutoBackground({
      run: run.fn,
      serverName: 's',
      toolName: 't',
      toolUseId: 'u',
      parentAbortController: new AbortController(),
      taskRegistry: registry,
      autoBackgroundMs: 30,
    })
    expect(outcome.kind).toBe('backgrounded')

    run.reject(new Error('boom'))
    // Drain microtasks + a timeout so the rejection is handled.
    await new Promise(r => setTimeout(r, 10))
    process.removeListener('unhandledRejection', onWarning)
    expect(warnings.length).toBe(0)
  })

  test('parent abort during the race → returns settled (awaiting the run)', async () => {
    const run = makeRun<{ content: string }>()
    const registry = makeRegistry()
    const parent = new AbortController()

    const outcomeP = callMcpToolWithAutoBackground({
      run: run.fn,
      serverName: 's',
      toolName: 't',
      toolUseId: 'u',
      parentAbortController: parent,
      taskRegistry: registry,
      autoBackgroundMs: 10000,
    })
    // Abort the parent before the tool resolves.
    parent.abort()
    // The run should resolve (with whatever) so the awaited resultPromise
    // settles and the primitive returns.
    run.resolve({ content: 'aborted-parent' })
    const outcome = await outcomeP
    expect(outcome.kind).toBe('settled')
    if (outcome.kind === 'settled') {
      expect(outcome.result).toEqual({ content: 'aborted-parent' })
    }
    expect(registry.registered.length).toBe(0)
  })

  test('pending elicitation keeps waiting — does not background mid-elicitation', async () => {
    const run = makeRun<{ content: string }>()
    const registry = makeRegistry()
    let pendingElicitation = true
    let backgroundedWhilePending = false
    let backgroundedCalls = 0

    const outcomeP = callMcpToolWithAutoBackground({
      run: run.fn,
      serverName: 's',
      toolName: 't',
      toolUseId: 'u',
      parentAbortController: new AbortController(),
      taskRegistry: registry,
      autoBackgroundMs: 40,
      hasPendingElicitation: () => pendingElicitation,
      onBackgrounded: () => {
        backgroundedCalls++
        if (pendingElicitation) {
          backgroundedWhilePending = true
        }
      },
    })

    // Let several threshold cycles elapse while the elicitation is pending.
    await new Promise(r => setTimeout(r, 150))
    // The primitive should still be looping, not have returned. Verify no
    // task registered yet and onBackgrounded never fired mid-elicitation.
    expect(registry.registered.length).toBe(0)
    expect(backgroundedCalls).toBe(0)

    // Elicitation resolves → next threshold cycle backgrounds the tool.
    pendingElicitation = false
    const outcome = await outcomeP
    expect(outcome.kind).toBe('backgrounded')
    expect(registry.registered.length).toBe(1)
    expect(backgroundedCalls).toBe(1)
    expect(backgroundedWhilePending).toBe(false)

    run.resolve({ content: 'finally' })
    await new Promise(r => setTimeout(r, 5))
  })

  test('run is started with a child signal linked to the parent', async () => {
    const run = makeRun<{ content: string }>()
    const parent = new AbortController()

    callMcpToolWithAutoBackground({
      run: run.fn,
      serverName: 's',
      toolName: 't',
      toolUseId: 'u',
      parentAbortController: parent,
      taskRegistry: makeRegistry(),
      autoBackgroundMs: 10000,
    })

    // Give the primitive a tick to start the run.
    await Promise.resolve()
    expect(run.startedWith).toBeDefined()
    expect(run.startedWith?.aborted).toBe(false)

    // Aborting the parent propagates to the child (createChildAbortController).
    parent.abort()
    // createChildAbortController uses an async 'abort' event listener; allow
    // a microtask for propagation.
    await Promise.resolve()
    await Promise.resolve()
    expect(run.startedWith?.aborted).toBe(true)

    // Let the run settle so the primitive returns cleanly.
    run.resolve({ content: 'x' })
  })

  test('autoBackgroundMs=0 falls back to a settled outcome (no backgrounding path)', async () => {
    // When disabled, the dispatch site bypasses the primitive entirely;
    // but if invoked directly with 0, the sleep races at 0ms. The tool still
    // settles first because the settled promise is awaited before the sleep
    // can win meaningfully — but to avoid a race, just verify a fast-resolving
    // run settles cleanly.
    const run = makeRun<{ content: string }>()
    const registry = makeRegistry()
    const outcomeP = callMcpToolWithAutoBackground({
      run: run.fn,
      serverName: 's',
      toolName: 't',
      toolUseId: 'u',
      parentAbortController: new AbortController(),
      taskRegistry: registry,
      autoBackgroundMs: 0,
    })
    run.resolve({ content: 'fast' })
    const outcome = await outcomeP
    expect(outcome.kind).toBe('settled')
  })
})
