/**
 * CC 2.1.312 (#22) — 1-second timeout floor for prompt/agent hooks inside the
 * per-hook executors. Official binary evidence (v312 linux-x64 ELF, READ-ONLY
 * forensics; the binary was never executed):
 *
 *   BM/pEr @251761428 (verbatim):
 *     var Wet=12,kvn=24,fEr=12,pEr=1,bvn=1e4; …
 *     function BM(e,n){return e.timeout?Math.max(e.timeout,pEr)*1000:n}
 *   prompt executor @251763592 (verbatim):
 *     let Oe=BM(e,30000),De=Date.now(),{signal:We,cleanup:ze}=us(h,{timeoutMs:Oe});
 *   agent executor @251774554 (verbatim):
 *     let Oe=BM(e,60000),De=ar(),{signal:We,cleanup:ze}=us(h,{timeoutMs:Oe})
 *
 * The floor applies to prompt/agent hooks ONLY — the command/callback/http
 * timeout derivations have no floor (@251904162
 * `Ho.timeout?Math.min(zB(Ho)?BM(Ho,S):Ho.timeout*1000,Bd):S`, @251902451
 * callback, @251785385 http) and are NOT touched here.
 *
 * `BM` itself already landed in hookSessionSlots312.ts as `hookTimeoutMs`
 * (including the falsy-`timeout:0` → event-default branch). This suite pins
 * that the two EXECUTORS derive their effective timeout through it.
 *
 * Assertion seam (documented choice): the derivation feeds straight into
 * `createCombinedAbortSignal(signal, { timeoutMs })` in both executors
 * (official `us(h,{timeoutMs:Oe})`), so the test mocks that module boundary,
 * captures `timeoutMs`, and delegates to the real implementation. The model
 * call is short-circuited (prompt: rejecting queryModelWithoutStreaming →
 * non_blocking_error; agent: empty query() generator → cancelled) — the
 * returned outcome is irrelevant, the captured timeout is the pin.
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
// Hermetic for credential-less environments (CI runners).
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

// --- Mock seams (OCC-97 pattern: eager snapshot copies BEFORE mock.module,
// narrow overrides, restore in afterAll). ---

const actualAbortModule = await import('../../combinedAbortSignal.js')
// Capture the REAL function reference before mock.module patches the captured
// namespace object IN PLACE (OCC-97/132): delegating through
// `actualAbortModule.createCombinedAbortSignal` after patching would re-enter
// the mock and recurse forever.
const realCreateCombinedAbortSignal = actualAbortModule.createCombinedAbortSignal
const capturedTimeouts: number[] = []
mock.module('../../combinedAbortSignal.js', () => ({
  ...actualAbortModule,
  createCombinedAbortSignal: (
    signal: AbortSignal | undefined,
    opts?: { signalB?: AbortSignal; timeoutMs?: number },
  ) => {
    if (opts?.timeoutMs !== undefined) {
      capturedTimeouts.push(opts.timeoutMs)
    }
    return realCreateCombinedAbortSignal(signal, opts)
  },
}))

const actualClaudeModule = await import('../../../services/api/claude.js')
mock.module('../../../services/api/claude.js', () => ({
  ...actualClaudeModule,
  // Short-circuit the model call: the rejection lands in execPromptHook's
  // catch → non_blocking_error, AFTER the timeout was derived + captured.
  queryModelWithoutStreaming: async () => {
    throw new Error('test: model call short-circuited')
  },
}))

const actualModelModule = await import('../../model/model.js')
mock.module('../../model/model.js', () => ({
  ...actualModelModule,
  getSmallFastModel: () => 'claude-haiku-test',
}))

const actualQueryModule = await import('../../../query.js')
mock.module('../../../query.js', () => ({
  ...actualQueryModule,
  // Empty stream → execAgentHook falls through to outcome 'cancelled'
  // (no structured output) without needing the full query pipeline.
  query: () =>
    (async function* (): AsyncGenerator<Record<string, unknown>, void> {})(),
}))

const actualMessagesModule = await import('../../messages.js')
mock.module('../../messages.js', () => ({
  ...actualMessagesModule,
  handleMessageFromStream: () => {},
}))

const actualSessionStorageModule = await import('../../sessionStorage.js')
mock.module('../../sessionStorage.js', () => ({
  ...actualSessionStorageModule,
  getTranscriptPath: () => '/tmp/occ-test-transcript.jsonl',
  getAgentTranscriptPath: () => '/tmp/occ-test-agent-transcript.jsonl',
}))

const actualAnalyticsModule = await import('../../../services/analytics/index.js')
mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalyticsModule,
  logEvent: () => {},
}))

afterAll(() => {
  mock.module('../../combinedAbortSignal.js', () => ({ ...actualAbortModule }))
  mock.module('../../../services/api/claude.js', () => ({ ...actualClaudeModule }))
  mock.module('../../model/model.js', () => ({ ...actualModelModule }))
  mock.module('../../../query.js', () => ({ ...actualQueryModule }))
  mock.module('../../messages.js', () => ({ ...actualMessagesModule }))
  mock.module('../../sessionStorage.js', () => ({ ...actualSessionStorageModule }))
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalyticsModule,
  }))
})

const { execPromptHook } = await import('../execPromptHook.js')
const { execAgentHook } = await import('../execAgentHook.js')
const { hookTimeoutMs } = await import('../hookSessionSlots312.js')
import type { ToolUseContext } from '../../../Tool.js'
import type { AgentHook, PromptHook } from '../../settings/types.js'

function makeContext(): ToolUseContext {
  let appState: Record<string, unknown> = {
    toolPermissionContext: { mode: 'dontAsk', alwaysAllowRules: { session: [] } },
    sessionHooks: new Map(),
  }
  return {
    options: { mainLoopModel: 'claude-caller-model', tools: [] },
    agentId: undefined,
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (updater: unknown) => {
      appState =
        typeof updater === 'function'
          ? (updater as (prev: Record<string, unknown>) => Record<string, unknown>)(appState)
          : (updater as Record<string, unknown>)
    },
    setResponseLength: () => {},
    messages: [],
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

function makePromptHook(timeout?: number): PromptHook {
  return {
    type: 'prompt',
    prompt: 'check the condition',
    ...(timeout !== undefined ? { timeout } : {}),
  } as unknown as PromptHook
}

function makeAgentHook(timeout?: number): AgentHook {
  return {
    type: 'agent',
    prompt: 'verify the condition',
    ...(timeout !== undefined ? { timeout } : {}),
  } as unknown as AgentHook
}

async function runPromptHook(hook: PromptHook): Promise<number> {
  capturedTimeouts.length = 0
  await execPromptHook(
    hook,
    'TestPromptHook',
    'PostToolUse',
    '{}',
    new AbortController().signal,
    makeContext(),
    undefined,
    'tu_test_312',
  )
  expect(capturedTimeouts.length).toBe(1)
  return capturedTimeouts[0]!
}

async function runAgentHook(hook: AgentHook): Promise<number> {
  capturedTimeouts.length = 0
  await execAgentHook(
    hook,
    'TestAgentHook',
    'PostToolUse',
    '{}',
    new AbortController().signal,
    makeContext(),
    'tu_test_312',
    [],
    undefined,
  )
  expect(capturedTimeouts.length).toBe(1)
  return capturedTimeouts[0]!
}

beforeEach(() => {
  capturedTimeouts.length = 0
})

// --- BM parity baseline (already-landed hookSessionSlots312 export) -----------

describe('2.1.312 #22 — hookTimeoutMs (official BM @251761428) parity values', () => {
  test('floors sub-second timeouts to 1000ms and keeps larger ones', () => {
    expect(hookTimeoutMs({ timeout: 0.5 }, 30000)).toBe(1000)
    expect(hookTimeoutMs({ timeout: 1 }, 30000)).toBe(1000)
    expect(hookTimeoutMs({ timeout: 5 }, 30000)).toBe(5000)
  })

  test('timeout 0 / undefined fall back to the event default, NOT the floor', () => {
    expect(hookTimeoutMs({ timeout: 0 }, 30000)).toBe(30000)
    expect(hookTimeoutMs({}, 60000)).toBe(60000)
  })
})

// --- prompt executor (official `BM(Ho,30000)` @251763592) ----------------------

describe('2.1.312 #22 — execPromptHook derives its timeout through the 1s floor (official BM(e,30000))', () => {
  test('timeout 0.5 → effective 1000ms (the floor)', async () => {
    expect(await runPromptHook(makePromptHook(0.5))).toBe(1000)
  })

  test('timeout undefined → event default 30000ms, NOT the floor', async () => {
    expect(await runPromptHook(makePromptHook())).toBe(30000)
  })

  test('timeout 0 (falsy) → event default 30000ms (BM truthiness branch, verbatim)', async () => {
    expect(await runPromptHook(makePromptHook(0))).toBe(30000)
  })

  test('timeout 5 → 5000ms (above the floor, untouched)', async () => {
    expect(await runPromptHook(makePromptHook(5))).toBe(5000)
  })

  test('timeout 1 → exactly 1000ms at the floor boundary', async () => {
    expect(await runPromptHook(makePromptHook(1))).toBe(1000)
  })
})

// --- agent executor (official `BM(Ho,60000)` @251774554) -----------------------

describe('2.1.312 #22 — execAgentHook derives its timeout through the 1s floor (official BM(e,60000))', () => {
  test('timeout 0.5 → effective 1000ms (the floor)', async () => {
    expect(await runAgentHook(makeAgentHook(0.5))).toBe(1000)
  })

  test('timeout undefined → event default 60000ms, NOT the floor', async () => {
    expect(await runAgentHook(makeAgentHook())).toBe(60000)
  })

  test('timeout 0 (falsy) → event default 60000ms (BM truthiness branch, verbatim)', async () => {
    expect(await runAgentHook(makeAgentHook(0))).toBe(60000)
  })

  test('timeout 5 → 5000ms (above the floor, untouched)', async () => {
    expect(await runAgentHook(makeAgentHook(5))).toBe(5000)
  })
})
