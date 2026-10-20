/**
 * CC 2.1.304 #34 — "Fixed a PreToolUse hook's deny reason being replaced by a
 * timeout error when an Agent SDK callback hook on the same tool call timed
 * out."
 *
 * Official mechanism (v304 linux-x64 ELF, see docs/gap-research-304/
 * research-R2-bash-perms.md §#34): `deniedBefore` recorder threaded through
 * aggregator `j8` → chain member `XLt` → `UEo` → pipeline `jTn` → outer catch
 * (@249269330–249269950) which prepends the recorded deny reason to the
 * timeout stopReason: `$e=xe.deniedBefore?`${xe.deniedBefore}\n\n`:""` …
 * `stopReason:Ee??$e+zVr`.
 *
 * OCC adaptation: OCC has no fold-abort path (2.1.210 #9 already swallows
 * callback timeouts into a blockingError yield), but the same symptom occurs
 * by last-wins overwrite — the timeout deny (toolHooks.ts blockingError
 * branch) overwrites an earlier real deny via toolExecution.ts's
 * `case 'hookPermissionResult'` last-wins consumer. Fix: runPreToolUseHooks
 * tracks the last REAL deny reason (`lastDenyReason`, the `deniedBefore`
 * analog) and prepends it (`${R}\n\n${timeoutText}`) to any later
 * callback-timeout deny or to the outer-catch timeout stopReason. The
 * aggregated permissionBehavior RE-ANNOUNCEMENT of a timeout result (hooks.ts
 * :4840 region, marked with `callbackTimeout: true`) repeats the merged
 * message so the FINAL (last-wins) deny keeps the official form.
 *
 * Test levels in this ONE file (see the mock-seam comment below for why the
 * real-pipeline coverage is not a sibling file):
 *  - unit: the executePreToolHooks seam is mocked (hookPluginId301.test.ts
 *    pattern) to drive exact aggregated-yield sequences;
 *  - integration: the same seam DELEGATES to the real executePreToolHooks
 *    (`useRealHooks`), with two real SDK callback hooks registered through
 *    registerHookCallbacks (hook A denies via the official JSON, hook B idles
 *    until its 50 ms per-hook timeout aborts it) and a counting analytics
 *    sink for `tengu_sdk_hook_callback_timeout`.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import type { HookCallback } from '../../../types/hooks.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

// --- Mock seams (hookPluginId301.test.ts pattern), extended with a
// delegation flag so this file can ALSO drive the real hook pipeline through
// the same toolHooks instance. bun's mock.module restore does not reliably
// rewire already-instantiated importers within one `bun test` process, so a
// sibling integration file importing ../toolHooks.js independently could end
// up bound to this file's mock with stale state — real-pipeline coverage
// therefore lives HERE, behind `useRealHooks`.
const actualHooksModule = await import('../../../utils/hooks.js')
const realExecutePreToolHooks = actualHooksModule.executePreToolHooks
type HookYield = Record<string, unknown>
let useRealHooks = false
let preToolHookResults: HookYield[] = []
let preToolHookThrowAfter: Error | undefined
mock.module('../../../utils/hooks.js', () => ({
  ...actualHooksModule,
  executePreToolHooks: (
    ...args: Parameters<typeof realExecutePreToolHooks>
  ): ReturnType<typeof realExecutePreToolHooks> => {
    if (useRealHooks) {
      return realExecutePreToolHooks(...args)
    }
    return (async function* () {
      yield* preToolHookResults
      if (preToolHookThrowAfter) {
        throw preToolHookThrowAfter
      }
    })()
  },
}))

const actualDebugModule = await import('../../../utils/debug.js')
mock.module('../../../utils/debug.js', () => ({
  ...actualDebugModule,
  logForDebugging: () => {},
}))

afterAll(() => {
  // Safety net: if bun's restore does not rewire importers already bound to
  // the dispatcher above, leave it delegating to the REAL implementation so
  // later test files in the same process can never observe stale mock state.
  useRealHooks = true
  preToolHookThrowAfter = undefined
  mock.module('../../../utils/hooks.js', () => ({ ...actualHooksModule }))
  mock.module('../../../utils/debug.js', () => ({ ...actualDebugModule }))
})

const { runPreToolUseHooks } = await import('../toolHooks.js')
const { getDefaultAppState } = await import('../../../state/AppStateStore.js')
const {
  clearRegisteredHooks,
  registerHookCallbacks,
} = await import('../../../bootstrap/state.js')
const {
  attachAnalyticsSink,
  _resetForTesting,
} = await import('../../analytics/index.js')
const {
  PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE,
  getPreToolHookBlockingMessage,
  hookCallbackTimeoutMessage,
} = actualHooksModule

const TOOL_NAME = 'FakeDenyBeforeTool304'
const TIMEOUT_TEXT = 'PreToolUse:FakeDenyBeforeTool304 callback hook timed out after 50ms'

function makeTool(): Tool {
  return {
    name: TOOL_NAME,
    inputSchema: z.strictObject({ cmd: z.string() }),
  } as unknown as Tool
}

function makeToolUseContext(): ToolUseContext {
  return {
    options: { tools: [], mcpClients: {}, mainLoopModel: 'claude-test' },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      ...getDefaultAppState(),
      toolPermissionContext: {
        ...getDefaultAppState().toolPermissionContext,
        mode: 'default',
      },
    }),
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

async function collect(): Promise<Array<Record<string, unknown>>> {
  const yields: Array<Record<string, unknown>> = []
  for await (const item of runPreToolUseHooks(
    makeToolUseContext(),
    makeTool(),
    { cmd: 'ls' },
    'tu_304_34',
    'msg_304_34',
    undefined as never,
    undefined as never,
    undefined,
  )) {
    yields.push(item as Record<string, unknown>)
  }
  return yields
}

type DenyYield = {
  hookPermissionResult: {
    behavior: string
    message?: string
    decisionReason?: { reason?: string }
  }
}

function denyYields(yields: Array<Record<string, unknown>>): DenyYield[] {
  return yields.filter(
    y =>
      y.type === 'hookPermissionResult' &&
      (y as DenyYield).hookPermissionResult.behavior === 'deny',
  ) as DenyYield[]
}

/** Aggregated yield shape of the hooks.ts callback-timeout swallow path. */
function callbackTimeoutYield(text: string = TIMEOUT_TEXT): HookYield {
  return {
    blockingError: { blockingError: text, command: 'callback' },
    callbackTimeout: true,
  }
}

beforeEach(() => {
  useRealHooks = false
  preToolHookResults = []
  preToolHookThrowAfter = undefined
})

describe('CC 2.1.304 #34: callback-timeout deny does not replace a prior real deny', () => {
  test('permissionBehavior deny followed by a callback timeout → merged "R + blank line + timeoutText" message', async () => {
    // Arrange — hook A denies via permissionBehavior (aggregated deny yield),
    // hook B's SDK callback times out later (marked blockingError yield).
    preToolHookResults = [
      {
        permissionBehavior: 'deny',
        hookPermissionDecisionReason: 'deny-reason-R',
      },
      callbackTimeoutYield(),
    ]

    // Act
    const denies = denyYields(await collect())

    // Assert — the LAST deny (what the last-wins consumer keeps) carries the
    // official prepend form: prior reason, blank line, timeout text.
    expect(denies.length).toBe(2)
    const finalMessage = denies[denies.length - 1]!.hookPermissionResult.message!
    expect(finalMessage).toBe(
      `deny-reason-R\n\n${getPreToolHookBlockingMessage(
        `PreToolUse:${TOOL_NAME}`,
        { blockingError: TIMEOUT_TEXT, command: 'callback' },
      )}`,
    )
    expect(finalMessage.startsWith('deny-reason-R\n\n')).toBe(true)
    expect(finalMessage).toContain('timed out after 50ms')
    // decisionReason.reason mirrors the merged message.
    expect(denies[denies.length - 1]!.hookPermissionResult.decisionReason!.reason).toBe(
      finalMessage,
    )
  })

  test('blockingError deny (exit-2 style) followed by a callback timeout → merged message', async () => {
    // Arrange — a command-hook style blockingError deny (no callbackTimeout
    // marker) is a REAL deny and must be tracked too.
    preToolHookResults = [
      { blockingError: { blockingError: 'script said no', command: 'my.sh' } },
      callbackTimeoutYield(),
    ]

    // Act
    const denies = denyYields(await collect())

    // Assert
    expect(denies.length).toBe(2)
    const realDenyMessage = denies[0]!.hookPermissionResult.message!
    expect(realDenyMessage).toBe(
      `PreToolUse:${TOOL_NAME} hook error: script said no`,
    )
    const finalMessage = denies[1]!.hookPermissionResult.message!
    expect(finalMessage).toBe(
      `${realDenyMessage}\n\nPreToolUse:${TOOL_NAME} hook error: ${TIMEOUT_TEXT}`,
    )
    expect(finalMessage).toContain('timed out after 50ms')
  })

  test('callback timeout with NO prior deny → plain timeout message (no prefix, no leading blank line)', async () => {
    // Arrange
    preToolHookResults = [callbackTimeoutYield()]

    // Act
    const denies = denyYields(await collect())

    // Assert — unchanged #9 behavior when there is nothing to preserve.
    expect(denies.length).toBe(1)
    const message = denies[0]!.hookPermissionResult.message!
    expect(message).toBe(
      getPreToolHookBlockingMessage(`PreToolUse:${TOOL_NAME}`, {
        blockingError: TIMEOUT_TEXT,
        command: 'callback',
      }),
    )
    expect(message.startsWith('\n')).toBe(false)
    expect(message).not.toContain('\n\n')
  })

  test('two consecutive callback timeouts do not stack — each prepends only the last REAL deny', async () => {
    // Arrange
    preToolHookResults = [
      {
        permissionBehavior: 'deny',
        hookPermissionDecisionReason: 'deny-reason-R',
      },
      callbackTimeoutYield('timeout-A-text'),
      callbackTimeoutYield('timeout-B-text'),
    ]

    // Act
    const denies = denyYields(await collect())

    // Assert — the final deny is `R\n\n<timeout B>`: timeout A's merged text
    // was NOT re-tracked (timeout denies never enter lastDenyReason).
    expect(denies.length).toBe(3)
    const finalMessage = denies[2]!.hookPermissionResult.message!
    expect(finalMessage.startsWith('deny-reason-R\n\n')).toBe(true)
    expect(finalMessage).toContain('timeout-B-text')
    expect(finalMessage).not.toContain('timeout-A-text')
  })

  test('aggregated permissionBehavior re-announcement of the timeout repeats the merged message (last-wins final)', async () => {
    // Arrange — the REAL pipeline yields, for ONE callback-timeout result:
    // (1) the blockingError yield, then (2) the aggregated permissionBehavior
    // re-announcement (hooks.ts:4840 region) which carries no reason of its
    // own. Without the #34 marker the re-announcement's generic "Hook X
    // denied this tool" fallback would clobber the merged message under the
    // last-wins consumer.
    preToolHookResults = [
      {
        permissionBehavior: 'deny',
        hookPermissionDecisionReason: 'deny-reason-R',
      },
      callbackTimeoutYield(),
      { permissionBehavior: 'deny', callbackTimeout: true },
    ]

    // Act
    const denies = denyYields(await collect())

    // Assert
    expect(denies.length).toBe(3)
    const finalMessage = denies[2]!.hookPermissionResult.message!
    expect(finalMessage).toBe(
      `deny-reason-R\n\nPreToolUse:${TOOL_NAME} hook error: ${TIMEOUT_TEXT}`,
    )
    expect(finalMessage).not.toContain('denied this tool')
  })

  test('re-announcement without a prior real deny repeats the plain timeout message', async () => {
    // Arrange
    preToolHookResults = [
      callbackTimeoutYield(),
      { permissionBehavior: 'deny', callbackTimeout: true },
    ]

    // Act
    const denies = denyYields(await collect())

    // Assert — both the blockingError deny and its re-announcement carry the
    // same plain timeout text (nothing to preserve, #9 behavior unchanged).
    expect(denies.length).toBe(2)
    const plain = `PreToolUse:${TOOL_NAME} hook error: ${TIMEOUT_TEXT}`
    expect(denies[0]!.hookPermissionResult.message!).toBe(plain)
    expect(denies[1]!.hookPermissionResult.message!).toBe(plain)
  })

  test('re-announcement with no cached timeout message still prepends the last real deny (defensive path)', async () => {
    // Arrange — a marked re-announcement WITHOUT the preceding blockingError
    // yield cannot occur in the real pipeline (both come from the same
    // aggregated result), but the defensive fallback must still preserve R.
    preToolHookResults = [
      {
        permissionBehavior: 'deny',
        hookPermissionDecisionReason: 'deny-reason-R',
      },
      { permissionBehavior: 'deny', callbackTimeout: true },
    ]

    // Act
    const denies = denyYields(await collect())

    // Assert
    expect(denies.length).toBe(2)
    const finalMessage = denies[1]!.hookPermissionResult.message!
    expect(finalMessage.startsWith('deny-reason-R\n\n')).toBe(true)
  })
})

describe('CC 2.1.304 #34: outer catch prepends the tracked deny reason to the timeout stopReason', () => {
  test('dispatch failure after a real deny → stopReason "R + blank line + PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE"', async () => {
    // Arrange — official outer catch: `$e=xe.deniedBefore?`${xe.deniedBefore}\n\n`:""`
    // … `stopReason:Ee??$e+zVr`.
    preToolHookResults = [
      {
        permissionBehavior: 'deny',
        hookPermissionDecisionReason: 'deny-reason-R',
      },
    ]
    preToolHookThrowAfter = new Error('hook dispatch blew up')

    // Act
    const yields = await collect()

    // Assert
    const stopReason = yields.find(y => y.type === 'stopReason') as
      | { stopReason: string }
      | undefined
    expect(stopReason).toBeDefined()
    expect(stopReason!.stopReason).toBe(
      `deny-reason-R\n\n${PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE}`,
    )
    expect(yields[yields.length - 1]!.type).toBe('stop')
  })

  test('dispatch failure with NO prior deny → bare PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE (#9 regression guard)', async () => {
    // Arrange
    preToolHookThrowAfter = new Error('hook dispatch blew up')

    // Act
    const yields = await collect()

    // Assert
    const stopReason = yields.find(y => y.type === 'stopReason') as
      | { stopReason: string }
      | undefined
    expect(stopReason).toBeDefined()
    expect(stopReason!.stopReason).toBe(PRE_TOOL_USE_HOOK_TIMEOUT_MESSAGE)
    expect(yields[yields.length - 1]!.type).toBe('stop')
  })
})

describe('CC 2.1.304 #34 (integration, real pipeline): deny reason survives an SDK callback timeout', () => {
  const INT_DENY_REASON = 'deny-reason-from-hook-A'
  /** HookCallback.timeout is in SECONDS — 0.05 → callbackTimeoutMs = 50. */
  const HOOK_B_TIMEOUT_SECONDS = 0.05
  const HOOK_B_TIMEOUT_MS = 50
  const capturedEventNames: string[] = []

  /** Hook A: instant deny with the official PreToolUse deny JSON shape. */
  const denyHook: HookCallback = {
    type: 'callback',
    callback: async () =>
      ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: INT_DENY_REASON,
        },
      }) as never,
  }

  /**
   * Hook B: idle SDK callback — only rejects when its per-hook abort signal
   * fires (createCombinedAbortSignal timeout), which is what makes the #9
   * swallow path classify it as a callback timeout. A never-resolving promise
   * would hang the run instead (the timeout aborts the signal; it does not
   * cancel the callback promise by itself).
   */
  const timeoutHook: HookCallback = {
    type: 'callback',
    timeout: HOOK_B_TIMEOUT_SECONDS,
    callback: (_input, _toolUseID, signal) =>
      new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('callback hook signal already aborted'))
          return
        }
        signal?.addEventListener('abort', () => {
          reject(new Error('callback hook cancelled by per-hook timeout'))
        })
      }),
  }

  beforeAll(() => {
    // Clean slate regardless of file order, then attach a counting sink
    // (attachAnalyticsSink is idempotent; the seam needs no module mock).
    _resetForTesting()
    attachAnalyticsSink({
      logEvent: eventName => {
        capturedEventNames.push(eventName)
      },
      logEventAsync: async eventName => {
        capturedEventNames.push(eventName)
      },
    })
  })

  afterAll(() => {
    _resetForTesting()
  })

  afterEach(() => {
    clearRegisteredHooks()
    capturedEventNames.length = 0
  })

  test('hook A deny + hook B callback timeout → final deny is "R + blank line + timeout denial" and telemetry fires once', async () => {
    // Arrange — real hooks.ts pipeline through the delegation seam.
    useRealHooks = true
    registerHookCallbacks({
      PreToolUse: [
        { matcher: TOOL_NAME, hooks: [denyHook] },
        { matcher: TOOL_NAME, hooks: [timeoutHook] },
      ],
    })

    // Act
    const yields = await collect()

    // Assert — the pipeline completes normally (no outer-catch stop path).
    expect(yields.some(y => y.type === 'stopReason')).toBe(false)
    expect(yields.some(y => y.type === 'stop')).toBe(false)

    // Hook A produces two denies (blockingError yield + permissionBehavior
    // yield); hook B's timeout produces the merged deny plus its aggregated
    // re-announcement — the FINAL one is what the last-wins consumer keeps.
    const denies = denyYields(yields)
    expect(denies.length).toBeGreaterThanOrEqual(3)
    const finalMessage = denies[denies.length - 1]!.hookPermissionResult.message!
    expect(finalMessage).toBe(
      `${INT_DENY_REASON}\n\nPreToolUse:${TOOL_NAME} hook error: ${hookCallbackTimeoutMessage(
        `PreToolUse:${TOOL_NAME}`,
        HOOK_B_TIMEOUT_MS,
      )}`,
    )
    expect(finalMessage).toContain('timed out after 50ms')

    // The #9 telemetry still fires exactly once for the timed-out callback.
    expect(
      capturedEventNames.filter(n => n === 'tengu_sdk_hook_callback_timeout')
        .length,
    ).toBe(1)
  }, 15000)

  test('callback timeout with NO other hook → plain timeout deny (unchanged #9 behavior)', async () => {
    // Arrange
    useRealHooks = true
    registerHookCallbacks({
      PreToolUse: [{ matcher: TOOL_NAME, hooks: [timeoutHook] }],
    })

    // Act
    const yields = await collect()

    // Assert — no aggregated re-announcement (aggregated permissionBehavior
    // stays undefined when the ONLY result is the timeout), so exactly one
    // plain deny survives.
    const denies = denyYields(yields)
    expect(denies.length).toBe(1)
    const message = denies[0]!.hookPermissionResult.message!
    expect(message).toBe(
      `PreToolUse:${TOOL_NAME} hook error: ${hookCallbackTimeoutMessage(
        `PreToolUse:${TOOL_NAME}`,
        HOOK_B_TIMEOUT_MS,
      )}`,
    )
    expect(message).not.toContain('\n\n')
    expect(
      capturedEventNames.filter(n => n === 'tengu_sdk_hook_callback_timeout')
        .length,
    ).toBe(1)
  }, 15000)
})
