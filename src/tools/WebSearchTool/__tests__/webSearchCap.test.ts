import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TaskRegistryImpl } from '../../../utils/taskRegistry.js'
import { WebSearchTool } from '../WebSearchTool.js'

/**
 * CC 2.1.212: real behavioral e2e for the per-session WebSearch cap.
 *
 * Drives WebSearchTool.call() with a real TaskRegistry and a fake tool-use
 * context enough times to hit the cap. The cap short-circuits BEFORE any
 * network call (no queryModelWithStreaming, no API key), so this exercises
 * the genuine cap behavior with no Anthropic API key required.
 *
 * Also verifies: the rejected path does NOT increment; the proceeding path
 * does increment exactly once per call.
 */

const WEB_ENV = 'CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION'
const originalWeb = process.env[WEB_ENV]

beforeEach(() => {
  delete process.env[WEB_ENV]
})

afterEach(() => {
  if (originalWeb === undefined) delete process.env[WEB_ENV]
  else process.env[WEB_ENV] = originalWeb
})

/**
 * Build a minimal fake ToolUseContext carrying only what WebSearchTool.call
 * touches before the cap check: startTime/performance.now (global), input
 * query, and the taskRegistry. The cap returns BEFORE getAppState /
 * queryModelWithStreaming are reached, so a stub context suffices.
 */
function makeFakeContext(taskRegistry: TaskRegistryImpl) {
  // Cast through unknown — we only exercise the cap short-circuit, which
  // reads context.taskRegistry and returns before any other field is used.
  return {
    taskRegistry,
  } as unknown as Parameters<
    typeof WebSearchTool.call
  >[1]
}

describe('WebSearchTool.call() — per-session WebSearch cap (CC 2.1.212)', () => {
  test('returns budget-exhausted result when getWebSearchCalls() >= max', async () => {
    // Arrange — set a tiny cap and pre-fill the registry to the limit
    process.env[WEB_ENV] = '2'
    const reg = new TaskRegistryImpl()
    reg.incrementWebSearchCalls()
    reg.incrementWebSearchCalls()
    const input = { query: 'claude code 2.1.212 release notes' }

    // Act — call() with the count already at the cap
    const result = await WebSearchTool.call(
      input as never,
      makeFakeContext(reg),
      undefined as never,
      undefined as never,
      undefined as never,
    )

    // Assert — the cap short-circuited with the budget-exhausted message
    expect(result.data.query).toBe(input.query)
    expect(result.data.durationSeconds).toBe(0)
    expect(result.data.results).toHaveLength(1)
    expect(String(result.data.results[0])).toContain(
      'web search budget',
    )
    expect(String(result.data.results[0])).toContain('2 of 2')
    expect(String(result.data.results[0])).toContain(
      'CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION',
    )
  })

  test('does NOT increment on the capped (rejected) path', async () => {
    // Arrange
    process.env[WEB_ENV] = '1'
    const reg = new TaskRegistryImpl()
    reg.incrementWebSearchCalls() // now at the cap (1 of 1)
    const input = { query: 'anything' }

    // Act — rejected
    await WebSearchTool.call(
      input as never,
      makeFakeContext(reg),
      undefined as never,
      undefined as never,
      undefined as never,
    )

    // Assert — counter did not advance on the rejected path
    expect(reg.getWebSearchCalls()).toBe(1)
  })

  test('increments only on the proceeding path (under the cap)', async () => {
    // Arrange — cap=5, count=0. The proceeding path would normally fire
    // queryModelWithStreaming; to avoid that (no API key), we assert the
    // increment happens by pre-filling count to cap-1 and then asserting
    // the NEXT call (at the cap) rejects WITHOUT having been incremented
    // by the prior rejected call. Instead, verify the increment contract
    // directly: a context whose registry is at 0 with cap 5, when call()
    // throws after the increment (because queryModelWithStreaming will fail
    // without an API key), the counter must be exactly 1 — proving the
    // increment ran exactly once before the network work.
    process.env[WEB_ENV] = '5'
    const reg = new TaskRegistryImpl()
    const input = { query: 'a real search that needs a network call' }

    // Act — call() increments (1), then attempts the real search which
    // errors out (no API key / no queryModelWithStreaming wiring in this
    // stub context). The increment already ran.
    await expect(
      WebSearchTool.call(
        input as never,
        makeFakeContext(reg),
        undefined as never,
        undefined as never,
        undefined as never,
      ),
    ).rejects.toThrow()

    // Assert — increment ran exactly once on the proceeding path
    expect(reg.getWebSearchCalls()).toBe(1)
  })

  test('the budget message tells the model to continue with gathered info', async () => {
    // Arrange
    process.env[WEB_ENV] = '1'
    const reg = new TaskRegistryImpl()
    reg.incrementWebSearchCalls()

    // Act
    const result = await WebSearchTool.call(
      { query: 'x' } as never,
      makeFakeContext(reg),
      undefined as never,
      undefined as never,
      undefined as never,
    )

    // Assert
    expect(String(result.data.results[0])).toMatch(
      /Continue with the information already gathered/,
    )
  })

  test('drives the cap over N real calls then rejects the N+1th', async () => {
    // Arrange — cap=3. Drive 3 proceeding calls (each increments then fails
    // on the network step), then assert the 4th is rejected by the cap
    // without touching the network.
    process.env[WEB_ENV] = '3'
    const reg = new TaskRegistryImpl()

    // 3 proceeding calls — each increments once, then fails on the network step
    for (let i = 0; i < 3; i++) {
      await expect(
        WebSearchTool.call(
          { query: `q${i}` } as never,
          makeFakeContext(reg),
          undefined as never,
          undefined as never,
          undefined as never,
        ),
      ).rejects.toThrow()
      expect(reg.getWebSearchCalls()).toBe(i + 1)
    }

    // Act — 4th call is rejected by the cap (count == max), returns data
    const result = await WebSearchTool.call(
      { query: 'q3' } as never,
      makeFakeContext(reg),
      undefined as never,
      undefined as never,
      undefined as never,
    )

    // Assert — budget-exhausted, no increment
    expect(result.data.durationSeconds).toBe(0)
    expect(String(result.data.results[0])).toContain('3 of 3')
    expect(reg.getWebSearchCalls()).toBe(3)
  })
})
