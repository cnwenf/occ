import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { StreamingToolExecutor } from '../StreamingToolExecutor.js'
import { resetExclusiveQueuedBehindRegistry } from '../exclusiveCallRegistry.js'

/**
 * Official 2.1.295 #072: "skill's allowed-tools and effort dropped when the
 * Skill tool finished before the response stream ended, denying the skill's
 * Bash commands in `-p` runs."
 *
 * Root cause (binary v294→v295, class `gs` = StreamingToolExecutor):
 *   - v294 executed a non-concurrency-safe tool's context layers immediately
 *     (`this.toolUseContext=aTe(this.toolUseContext,n)`) but only set the
 *     flag `appliedConcurrencySafeLayers`, which the immediate path never
 *     touched. The final drain gate
 *     `if(...,this.appliedConcurrencySafeLayers)yield{newContext:...}`
 *     therefore stayed false for a skill.
 *   - A skill (non-concurrency-safe, `isConcurrencySafe`→false) that finished
 *     BEFORE the stream ended had its result message — the only carrier of
 *     `newContext` — drained mid-stream by `getCompletedResults()`, whose
 *     consumer ignores `newContext` (official `vn`; OCC query.ts). Once
 *     status→'yielded', the post-stream
 *     `getRemainingResults()` had no message left to re-surface the applied
 *     allowed-tools/effort → next turn denied the skill's Bash.
 *   - v295 fix: rename to `appliedLayers`, set `this.appliedLayers=!0` in the
 *     immediate-apply path, and gate the final drain on it. Both sites are
 *     byte-verified in v295 AND v296 (structurally identical; only the
 *     minified context-merge helper name drifts WAe→_Ce):
 *       · immediate-apply `this.appliedLayers=!0`
 *           v295 @ 223352014 · v296 @ 224134210
 *       · final-drain `if(this.applyEndedRunLayers(),this.appliedLayers)
 *         yield{newContext:this.toolUseContext}`
 *           v295 @ 223353268 · v296 @ 224135464
 *       · field decl `appliedLayers=!1`
 *           v295 @ 223344772 · v296 @ 224126969
 *
 * OCC port: StreamingToolExecutor sets `this.appliedLayers = true` after
 * applying a non-concurrency-safe tool's contextModifiers, and
 * `getRemainingResults()` ends with `if (this.appliedLayers) yield
 * { newContext: this.toolUseContext }`. OCC has no applyEndedRunLayers
 * (deferred concurrency-safe layers are intentionally unsupported — see the
 * NOTE in executeTool), so the comma operator collapses to the flag check.
 *
 * Uses the REAL runToolUse pipeline (release-gate harness pattern, cf.
 * exclusiveCallRegistry295.test.ts) — no module mocks, so nothing leaks into
 * sibling test files.
 */

// Per-tool-name release gates so tests control exactly when a call finishes.
const releaseGates = new Map<string, () => void>()

// The model override a skill's contextModifier applies — stands in for the
// real SkillTool allowed-tools/model/effort context mutations. Typed field
// `ToolUseContext.options.mainLoopModel` keeps assertions `any`-free.
const SKILL_MODEL = 'skill-model-072'

function skillContextModifier(ctx: ToolUseContext): ToolUseContext {
  return { ...ctx, options: { ...ctx.options, mainLoopModel: SKILL_MODEL } }
}

function makeFakeTool(
  name: string,
  isConcurrencySafe: boolean,
  contextModifier?: (ctx: ToolUseContext) => ToolUseContext,
): Tool {
  return {
    name,
    maxResultSizeChars: 100_000,
    inputSchema: z.object({}).passthrough(),
    isConcurrencySafe: () => isConcurrencySafe,
    call: async () => {
      await new Promise<void>(resolve => {
        releaseGates.set(name, resolve)
      })
      return contextModifier
        ? { data: `DONE:${name}`, contextModifier }
        : { data: `DONE:${name}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseID: string) => ({
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: String(data),
    }),
  } as unknown as Tool
}

// Skill-like: non-concurrency-safe + a context modifier (the #072 subject).
const SKILL_TOOL = makeFakeTool('FakeSkill072', false, skillContextModifier)
// Non-concurrency-safe but NO modifier — appliedLayers must stay false.
const PLAIN_TOOL = makeFakeTool('FakePlain072', false)
// Concurrency-safe WITH a modifier — OCC ignores it (executeTool NOTE), so
// appliedLayers must stay false and the context must be unchanged.
const CONCURRENT_SKILL_TOOL = makeFakeTool(
  'FakeConcSkill072',
  true,
  skillContextModifier,
)
const TOOLS = [SKILL_TOOL, PLAIN_TOOL, CONCURRENT_SKILL_TOOL]

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

type Drained = { message?: unknown; newContext?: ToolUseContext }

/** Poll until the tool's call() has actually reached its gate, then release. */
async function releaseWhenGated(name: string): Promise<void> {
  for (let i = 0; i < 200 && !releaseGates.has(name); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  releaseGates.get(name)?.()
}

/**
 * Simulate the mid-stream consumer (official `vn` / OCC query.ts:1005): drain
 * `getCompletedResults()` reading ONLY `message` and deliberately IGNORING
 * `newContext`. Polls until the tool has completed and been consumed
 * (status→'yielded'). Returns the number of messages drained.
 */
async function drainCompletedIgnoringContext(
  executor: StreamingToolExecutor,
): Promise<number> {
  for (let i = 0; i < 200; i++) {
    let count = 0
    for (const update of executor.getCompletedResults()) {
      if (update.message) count++
      // intentionally ignore update.newContext (matches official mid-stream)
    }
    if (count > 0) return count
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return 0
}

describe('CC 2.1.295 #072: StreamingToolExecutor appliedLayers final newContext', () => {
  beforeEach(() => {
    resetExclusiveQueuedBehindRegistry()
    releaseGates.clear()
  })

  test('a skill that finished BEFORE the stream ended still surfaces its applied context via the final newContext yield', async () => {
    // Arrange — a Skill-like (non-concurrency-safe, context-modifying) call
    const executor = makeExecutor()
    executor.addTool(makeBlock('tu_s1', 'FakeSkill072'), makeAssistantMessage('tu_s1'))

    // Act — the skill completes and its result message is consumed mid-stream
    // by a consumer that ignores newContext (the #072 trigger condition)
    await releaseWhenGated('FakeSkill072')
    const midStream = await drainCompletedIgnoringContext(executor)
    expect(midStream).toBeGreaterThan(0)

    // Now drain the post-stream remainder. The skill is already 'yielded', so
    // no message carries newContext — only the appliedLayers-gated final yield
    // can re-surface the skill's model/effort/allowed-tools.
    const drained: Drained[] = []
    for await (const update of executor.getRemainingResults()) {
      drained.push(update)
    }

    // Assert — exactly one context-only update, carrying the modified context.
    // WITHOUT the fix this is empty (0) → the skill's context is dropped.
    const contextOnly = drained.filter(u => u.newContext && !u.message)
    expect(contextOnly.length).toBe(1)
    expect(contextOnly[0]!.newContext!.options.mainLoopModel).toBe(SKILL_MODEL)
  })

  test('a non-concurrency-safe tool with NO context modifier does not emit a final newContext (appliedLayers stays false)', async () => {
    // Arrange
    const executor = makeExecutor()
    executor.addTool(makeBlock('tu_p2', 'FakePlain072'), makeAssistantMessage('tu_p2'))

    // Act
    const drained: Drained[] = []
    const drainPromise = (async () => {
      for await (const update of executor.getRemainingResults()) {
        drained.push(update)
      }
    })()
    await releaseWhenGated('FakePlain072')
    await drainPromise

    // Assert — the tool's message flowed, but no context-only final yield
    expect(drained.some(u => u.message)).toBe(true)
    expect(drained.filter(u => u.newContext && !u.message).length).toBe(0)
  })

  test('a skill that finishes DURING the drain emits its message AND the final newContext with the modified context', async () => {
    // Arrange — normal path: skill completes while getRemainingResults drains
    const executor = makeExecutor()
    executor.addTool(makeBlock('tu_s3', 'FakeSkill072'), makeAssistantMessage('tu_s3'))

    // Act
    const drained: Drained[] = []
    const drainPromise = (async () => {
      for await (const update of executor.getRemainingResults()) {
        drained.push(update)
      }
    })()
    await releaseWhenGated('FakeSkill072')
    await drainPromise

    // Assert — message flowed, and the final context-only yield is present
    expect(drained.some(u => u.message)).toBe(true)
    const contextOnly = drained.filter(u => u.newContext && !u.message)
    expect(contextOnly.length).toBe(1)
    expect(contextOnly[0]!.newContext!.options.mainLoopModel).toBe(SKILL_MODEL)
  })

  test('a concurrency-safe tool modifier is not applied (OCC NOTE) → no final newContext and the context is unchanged', async () => {
    // Arrange — concurrency-safe tool carrying a modifier OCC intentionally
    // ignores (executeTool only applies modifiers for !isConcurrencySafe)
    const executor = makeExecutor()
    executor.addTool(makeBlock('tu_c4', 'FakeConcSkill072'), makeAssistantMessage('tu_c4'))

    // Act
    const drained: Drained[] = []
    const drainPromise = (async () => {
      for await (const update of executor.getRemainingResults()) {
        drained.push(update)
      }
    })()
    await releaseWhenGated('FakeConcSkill072')
    await drainPromise

    // Assert — no appliedLayers, so no context-only final yield; the context
    // was never modified (still the original mainLoopModel)
    expect(drained.some(u => u.message)).toBe(true)
    expect(drained.filter(u => u.newContext && !u.message).length).toBe(0)
    const anyCtx = drained.find(u => u.newContext)?.newContext
    expect(anyCtx?.options.mainLoopModel).toBe('claude-opus-5')
  })
})
