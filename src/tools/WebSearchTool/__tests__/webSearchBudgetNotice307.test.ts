import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TaskRegistryImpl } from '../../../utils/taskRegistry.js'
import { WebSearchTool } from '../WebSearchTool.js'

/**
 * CC 2.1.307 (A7): the budget-exhausted notice is replaced with the official
 * v307 session-no-refill rendering, byte-verified from the v307 ELF text dump
 * (new307.txt @35592316):
 *
 *   results:[`Web search was not performed: this ${ae}'s web search budget is
 *   used up (${bn}). ${Sn}; do not work around the limit by querying search
 *   engines with curl or wget from ${je}, by querying them in a browser or
 *   through a computer-use tool, or by searching or fetching through a
 *   third-party reader, proxy or archive service.${Cn}`]
 *
 * with (session variant — OCC has no turn-budget/refill machinery, so the
 * session-no-refill branch is the faithful port):
 *   ae = "session"
 *   bn = `limit: ${te} WebSearch ${I(te,"call")}, shared by every agent in
 *         this session; it does not refill`
 *   Sn = "Continue with the information already gathered instead of searching
 *         again, and say so in your answer"
 *   je = "Bash"
 *   Cn = ` If more searches are genuinely needed, ask the user to raise
 *         CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION.`
 *        (official gates the hint on Por()/CLAUDE_CODE_HIDE_SETTINGS_HINT —
 *        OCC has no hide-hint surface, so the tail is unconditional:
 *        documented divergence. Turn-budget/refill variants and the
 *        `searchCount:0` data field stay unported — OCC's WebSearch data shape
 *        has no searchCount field.)
 *
 * v306 has NO 'web search budget is used up' string (grep = 0 hits) — the
 * whole rendering is new in v307.
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

function makeFakeContext(taskRegistry: TaskRegistryImpl) {
  // Cap short-circuit reads context.taskRegistry only (webSearchCap.test.ts
  // harness) — returns before getAppState / queryModelWithStreaming.
  return {
    taskRegistry,
  } as unknown as Parameters<typeof WebSearchTool.call>[1]
}

async function exhaustCap(cap: number): Promise<string> {
  process.env[WEB_ENV] = String(cap)
  const reg = new TaskRegistryImpl()
  for (let i = 0; i < cap; i++) {
    reg.incrementWebSearchCalls()
  }
  const result = await WebSearchTool.call(
    { query: 'anything' } as never,
    makeFakeContext(reg),
    undefined as never,
    undefined as never,
    undefined as never,
  )
  return String(result.data.results[0])
}

/** The full official v307 session-no-refill rendering for a given cap. */
function expectedNotice(cap: number): string {
  const calls = cap === 1 ? 'call' : 'calls'
  return (
    `Web search was not performed: this session's web search budget is used up ` +
    `(limit: ${cap} WebSearch ${calls}, shared by every agent in this session; it does not refill). ` +
    `Continue with the information already gathered instead of searching again, and say so in your answer; ` +
    `do not work around the limit by querying search engines with curl or wget from Bash, ` +
    `by querying them in a browser or through a computer-use tool, ` +
    `or by searching or fetching through a third-party reader, proxy or archive service. ` +
    `If more searches are genuinely needed, ask the user to raise CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION.`
  )
}

describe('CC 2.1.307 A7 — WebSearch budget-exhausted notice (official v307 rendering)', () => {
  test('cap=2 exhausted → exact official session-no-refill string', async () => {
    // Act
    const notice = await exhaustCap(2)

    // Assert — byte-for-byte against the binary-verified template
    expect(notice).toBe(expectedNotice(2))
  })

  test('cap=1 exhausted → singular "1 WebSearch call" (official plural helper I)', async () => {
    // Act
    const notice = await exhaustCap(1)

    // Assert
    expect(notice).toBe(expectedNotice(1))
    expect(notice).toContain('limit: 1 WebSearch call,')
    expect(notice).not.toContain('1 WebSearch calls')
  })

  test('includes the browser / computer-use workaround clause', async () => {
    // Act
    const notice = await exhaustCap(2)

    // Assert
    expect(notice).toContain(
      'by querying them in a browser or through a computer-use tool',
    )
  })

  test('includes the curl/wget-from-Bash workaround clause', async () => {
    // Act
    const notice = await exhaustCap(2)

    // Assert
    expect(notice).toContain(
      'querying search engines with curl or wget from Bash',
    )
  })

  test('includes the third-party reader/proxy/archive workaround clause', async () => {
    // Act
    const notice = await exhaustCap(2)

    // Assert
    expect(notice).toContain(
      'searching or fetching through a third-party reader, proxy or archive service',
    )
  })

  test('includes the say-so-in-your-answer continuation clause', async () => {
    // Act
    const notice = await exhaustCap(2)

    // Assert
    expect(notice).toContain(
      'Continue with the information already gathered instead of searching again, and say so in your answer',
    )
  })

  test('old v306 count rendering ("N of M") is gone', async () => {
    // Act
    const notice = await exhaustCap(3)

    // Assert
    expect(notice).not.toContain('3 of 3')
    expect(notice).not.toContain('instead of issuing more searches')
    expect(notice).toContain('limit: 3 WebSearch calls')
  })

  test('capped path still returns the unchanged data envelope (query, single result, 0s)', async () => {
    // Arrange
    process.env[WEB_ENV] = '1'
    const reg = new TaskRegistryImpl()
    reg.incrementWebSearchCalls()
    const input = { query: 'q' }

    // Act
    const result = await WebSearchTool.call(
      input as never,
      makeFakeContext(reg),
      undefined as never,
      undefined as never,
      undefined as never,
    )

    // Assert — OCC's data shape keeps query/results/durationSeconds (the
    // official `searchCount:0` field is not ported — OCC has no such field).
    expect(result.data.query).toBe(input.query)
    expect(result.data.results).toHaveLength(1)
    expect(result.data.durationSeconds).toBe(0)
  })
})
