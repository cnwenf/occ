/**
 * CC 2.1.302 (#035) — PRODUCTION-WIRING pin for the prompt/agent hook
 * concurrency cap.
 *
 * The sibling hookConcurrencyCap302.test.ts drives the helper
 * (mergeHookGeneratorsWithPromptAgentCap) directly. This file closes the
 * wiring gap the acceptance review flagged: the cap must be observable
 * through the real production pipeline `executePreToolHooks → executeHooks →
 * mergeHookGeneratorsWithPromptAgentCap` (src/utils/hooks.ts call site —
 * `hookIndex => isPromptOrAgentHook(matchingHooks[hookIndex]!.hook)`).
 *
 * Would-fail guarantee (mutation-verified shape):
 * - Flipping the call-site index predicate to `() => false` (equivalent to
 *   reverting to the pre-302 uncapped `all()` merge) makes all 13 prompt
 *   hooks start concurrently → maxLive becomes 13 → the assertions below
 *   FAIL. The helper-only suite stays green under that mutation; this file
 *   does not.
 *
 * Official behavior under test (v302 ELF @246248866, cap `ant=12`): at most
 * 12 prompt/agent hooks of one event run at a time; the rest wait their turn.
 */

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../../settings/types.js'

// ---------------------------------------------------------------------------
// Mocks (Bun's mock.module leaks across files — spread the real module,
// override only the seam, restore in afterAll; hooksFailClosed288 pattern)
// ---------------------------------------------------------------------------
const actualSnapshotModule = await import('../hooksConfigSnapshot.js')
const actualConfigModule = await import('../../config.js')
const actualExecPromptModule = await import('../execPromptHook.js')
const actualExecAgentModule = await import('../execAgentHook.js')
const actualAnalyticsModule = await import('../../../services/analytics/index.js')

let mockedHooksConfig: HooksSettings | null = null

// Live-concurrency tracker + per-hook gates, driven through the REAL
// execPromptHook seam (the production prompt-hook executor).
type Tracker = {
  live: number
  maxLive: number
  starts: string[]
}
const tracker: Tracker = { live: 0, maxLive: 0, starts: [] }
const gates: Array<{ promise: Promise<void>; open: () => void }> = []

function createGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { promise, open }
}

mock.module('../hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
  shouldAllowManagedHooksOnly: () => false,
  shouldDisableAllHooksIncludingManaged: () => false,
}))

mock.module('../../config.js', () => ({
  ...actualConfigModule,
  checkHasTrustDialogAccepted: () => true,
}))

mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalyticsModule,
  logEvent: () => {},
}))

// The gated prompt-hook executor: enter → wait on this hook's gate → exit.
// Keyed by hook.prompt ('p0'…'p12') so each matched hook blocks on its own
// gate and the concurrency window is fully test-controlled.
mock.module('../execPromptHook.js', () => ({
  ...actualExecPromptModule,
  execPromptHook: async (
    hook: { type: string; prompt?: string },
    ...rest: unknown[]
  ) => {
    const tag = hook.prompt ?? '?'
    const index = Number(tag.slice(1))
    tracker.live++
    if (tracker.live > tracker.maxLive) {
      tracker.maxLive = tracker.live
    }
    tracker.starts.push(tag)
    await gates[index]?.promise
    tracker.live--
    void rest
    return { outcome: 'success' as const, hook } as never
  },
}))

// OCC-121 P3 carryover fix (finding #4): the gated AGENT-hook executor —
// same tracker/gates as the prompt arm, keyed by hook.prompt ('a0'…'a12').
// Drives the agent arm of isPromptOrAgentHook through the REAL production
// pipeline (executeStopHooks → executeHooks → merge-with-cap → dispatch →
// execAgentHook). Mutation: narrowing the call-site predicate to prompt-only
// (`h => h.type === 'prompt'`) uncaps the agent arm → maxLive 13 → RED.
mock.module('../execAgentHook.js', () => ({
  ...actualExecAgentModule,
  execAgentHook: async (
    hook: { type: string; prompt?: string },
    ...rest: unknown[]
  ) => {
    const tag = hook.prompt ?? '?'
    const index = Number(tag.slice(1))
    tracker.live++
    if (tracker.live > tracker.maxLive) {
      tracker.maxLive = tracker.live
    }
    tracker.starts.push(tag)
    await gates[index]?.promise
    tracker.live--
    void rest
    return { outcome: 'success' as const, hook } as never
  },
}))

afterAll(() => {
  mock.module('../hooksConfigSnapshot.js', () => ({ ...actualSnapshotModule }))
  mock.module('../execAgentHook.js', () => ({ ...actualExecAgentModule }))
  mock.module('../../config.js', () => ({ ...actualConfigModule }))
  mock.module('../execPromptHook.js', () => ({ ...actualExecPromptModule }))
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalyticsModule,
  }))
})

const { executePreToolHooks, executeStopHooks } = await import('../../hooks.js')

const PROMPT_TAGS = Array.from({ length: 13 }, (_, i) => `p${i}`)

function fakeToolUseContext(): never {
  return {
    getAppState: () => undefined,
    agentId: undefined,
    options: {},
  } as never
}

/** 13 user prompt hooks all matching PreToolUse (official #035 cap shape). */
function thirteenPromptHooksConfig(): HooksSettings {
  return {
    PreToolUse: [
      {
        matcher: '*',
        hooks: PROMPT_TAGS.map(tag => ({ type: 'prompt', prompt: tag })),
      },
    ],
  } as HooksSettings
}

const AGENT_TAGS = Array.from({ length: 13 }, (_, i) => `a${i}`)

/** 13 user agent hooks on Stop (OCC-121 P3 finding #4 — agent arm). */
function thirteenAgentHooksConfig(): HooksSettings {
  return {
    Stop: [
      {
        matcher: '*',
        hooks: AGENT_TAGS.map(tag => ({ type: 'agent', prompt: tag })),
      },
    ],
  } as HooksSettings
}

/** Macrotask flush — drains the stagger chain + merge races. */
const flush = (): Promise<void> =>
  new Promise<void>(resolve => setTimeout(resolve, 10))

afterEach(() => {
  mockedHooksConfig = null
  tracker.live = 0
  tracker.maxLive = 0
  tracker.starts.length = 0
  gates.length = 0
  for (const tag of PROMPT_TAGS) {
    void tag
    gates.push(createGate())
  }
})

// Seed gates before the first test too (afterEach only runs between tests).
for (let i = 0; i < PROMPT_TAGS.length; i++) {
  gates.push(createGate())
}

describe('CC 2.1.302 #035 production wiring: executePreToolHooks caps prompt-hook concurrency at 12', () => {
  test('13 matched prompt hooks through the real pipeline: max live concurrency is exactly 12, the 13th waits its turn', async () => {
    // Arrange — production entry point, real executeHooks, real merge call
    // site; only the hook config source and the prompt executor are seams.
    mockedHooksConfig = thirteenPromptHooksConfig()

    // Act — drive the production generator WITHOUT awaiting; the merge cap
    // decides how many execPromptHook calls are live at once.
    const collected: unknown[] = []
    const done = (async () => {
      for await (const result of executePreToolHooks(
        'Bash',
        'tu-cap302',
        { command: 'ls' },
        fakeToolUseContext(),
      )) {
        collected.push(result)
      }
    })()

    await flush()
    // Assert — exactly the official cap is live; p12 has NOT started.
    // (Mutation `hookIndex => false` at the call site → uncapped merge →
    // all 13 live here → these three assertions fail.)
    expect(tracker.maxLive).toBe(12)
    expect(tracker.live).toBe(12)
    expect(tracker.starts).toEqual(PROMPT_TAGS.slice(0, 12))

    // Finish the first hook → p12 takes its slot, concurrency stays at 12.
    gates[0]!.open()
    await flush()
    expect(tracker.starts).toEqual(PROMPT_TAGS)
    expect(tracker.live).toBe(12)
    expect(tracker.maxLive).toBe(12)

    // Release the rest; the pipeline completes and every hook ran.
    for (const gate of gates) {
      gate.open()
    }
    await done
    expect(tracker.maxLive).toBe(12)
    expect(tracker.starts).toEqual(PROMPT_TAGS)
    // 13 hook_progress messages (one per matched hook) flowed through the
    // production consumer loop before execution.
    const progressCount = collected.filter(
      r =>
        (r as { message?: { type?: string } }).message?.type === 'progress',
    ).length
    expect(progressCount).toBe(13)
  })
})

// OCC-121 P3 carryover fix (finding #4): the agent arm of the cap through the
// real exec pipeline. The unit suite pins isPromptOrAgentHook({type:'agent'})
// === true, but before this block no production fixture drove an agent hook
// through executeHooks → merge-with-cap → execAgentHook, so a predicate
// narrowed to prompt-only at the call site stayed green. Stop is used as the
// carrier event because executeStopHooks is the production entry that passes
// the conversation context (toolUseContext + messages) agent hooks require.
describe('CC 2.1.302 #035 production wiring (agent arm): executeStopHooks caps agent-hook concurrency at 12', () => {
  test('13 matched agent hooks through the real pipeline: max live concurrency is exactly 12, the 13th waits its turn', async () => {
    // Arrange — production entry point, real executeHooks, real merge call
    // site; only the hook config source and the agent executor are seams.
    mockedHooksConfig = thirteenAgentHooksConfig()

    // Act — drive the production generator WITHOUT awaiting; the merge cap
    // decides how many execAgentHook calls are live at once. messages=[] is
    // truthy so the agent dispatch guard passes; Stop never throws the
    // PermissionRequest agent-hook error.
    const collected: unknown[] = []
    const done = (async () => {
      for await (const result of executeStopHooks(
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        fakeToolUseContext(),
        [],
      )) {
        collected.push(result)
      }
    })()

    await flush()
    // Assert — exactly the official cap is live; a12 has NOT started.
    // (Mutation: call-site predicate → prompt-only ⇒ uncapped agent arm ⇒
    // all 13 live here ⇒ these assertions fail.)
    expect(tracker.maxLive).toBe(12)
    expect(tracker.live).toBe(12)
    expect(tracker.starts).toEqual(AGENT_TAGS.slice(0, 12))

    // Finish the first hook → a12 takes its slot, concurrency stays at 12.
    gates[0]!.open()
    await flush()
    expect(tracker.starts).toEqual(AGENT_TAGS)
    expect(tracker.live).toBe(12)
    expect(tracker.maxLive).toBe(12)

    // Release the rest; the pipeline completes and every hook ran.
    for (const gate of gates) {
      gate.open()
    }
    await done
    expect(tracker.maxLive).toBe(12)
    expect(tracker.starts).toEqual(AGENT_TAGS)
    void collected
  })
})
