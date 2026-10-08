import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

// WebFetchTool transitively pulls in the fetch path which reads MACRO.VERSION
// (a build-time constant polyfilled in cli.tsx). Mirror that polyfill so the
// module imports cleanly under `bun test`.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Item #018a call-site branches (2.1.292/293 forensics §1.2, always-on pieces
 * only — the gated `agent_raw` verbatim reader `LLo` / `web-fetch` subagent /
 * tool-filter chain is item #018b and stays STAGED):
 *
 *   Rn=Xl(Ut,Ut.length-H)                          // offset slice
 *   past_end:   H>0&&Rn===""  → `Nothing left to read from offset ${H}: this page's text is ${Ut.length} characters long.`
 *   raw_markdown: Jt&&nn.includes("text/markdown")&&Rn.length<$Tn → zn=Rn
 *   secondary_model: contentLead into Jht + coverage note
 *     `[${dr} note: ... covers only characters ${Ln} to ${Eo}; the final ${Ut.length-Eo} were not read${M2t(Eo)}.]`
 *     when Eo<Ut.length && !binary && toolUseId!==undefined
 *   redirect relay echoes `- offset: ${H}` when H>0
 *   maxResultSizeChars: XN=50000 (official o_ @213376381)
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker —
// bun retroactively patches the bindings of ALREADY-evaluated importers
// (e.g. dotlessHostname268's static `import { getURLMarkdownContent } from
// '../utils.js'`), so a hard mock here would hijack other files' tests.
// Follow the rateLimitedPreflight286 delegating pattern: override only while
// this file's fixture (`mockedFetchResult`) is armed, otherwise delegate to
// the real module, and restore in afterAll.
const actualUtils = await import('../utils.js')

// Capture the real function refs BEFORE mock.module is registered: bun
// retroactively patches properties on the imported namespace object, so
// delegating via `actualUtils.fn` after registration would recurse into the
// mock itself ("Maximum call stack size exceeded").
const actualGetURLMarkdownContent = actualUtils.getURLMarkdownContent
const actualApplyPromptToMarkdown = actualUtils.applyPromptToMarkdown

type FetchResult = Awaited<ReturnType<typeof actualUtils.getURLMarkdownContent>>

let mockedFetchResult: FetchResult | undefined
let mockedSummary = 'SUMMARY'
let applyCalls: Array<{
  prompt: string
  markdownContent: string
  contentLead: string | undefined
}> = []

mock.module('../utils.js', () => ({
  ...actualUtils,
  getURLMarkdownContent: async (
    url: string,
    abortController: AbortController,
  ) => {
    if (mockedFetchResult === undefined) {
      return actualGetURLMarkdownContent(url, abortController)
    }
    return mockedFetchResult
  },
  applyPromptToMarkdown: async (
    prompt: string,
    markdownContent: string,
    signal: AbortSignal,
    isNonInteractiveSession: boolean,
    isPreapprovedDomain: boolean,
    contentLead?: string,
  ) => {
    if (mockedFetchResult === undefined) {
      return actualApplyPromptToMarkdown(
        prompt,
        markdownContent,
        signal,
        isNonInteractiveSession,
        isPreapprovedDomain,
        contentLead,
      )
    }
    applyCalls.push({ prompt, markdownContent, contentLead })
    return mockedSummary
  },
}))

const { WebFetchTool } = await import('../WebFetchTool.js')

afterAll(() => {
  mock.module('../utils.js', () => ({ ...actualUtils }))
})

afterEach(() => {
  mockedFetchResult = undefined
  mockedSummary = 'SUMMARY'
  applyCalls = []
})

function makeContext(toolUseId?: string) {
  return {
    abortController: new AbortController(),
    options: { isNonInteractiveSession: false },
    toolUseId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function fetched(content: string, contentType = 'text/html') {
  return {
    content,
    bytes: Buffer.byteLength(content),
    code: 200,
    codeText: 'OK',
    contentType,
  }
}

describe('#018a — maxResultSizeChars matches official XN=50000', () => {
  test('maxResultSizeChars is 50_000 (was 100_000; official o_ @213376381)', () => {
    expect(WebFetchTool.maxResultSizeChars).toBe(50_000)
  })
})

describe('#018a — input schema: offset param', () => {
  test('parses without offset (backwards compatible)', () => {
    const parsed = WebFetchTool.inputSchema.safeParse({
      url: 'https://example.com/page',
      prompt: 'summarize',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.offset).toBeUndefined()
    }
  })

  test('coerces a numeric-string offset (official pO/XMe preprocess)', () => {
    const parsed = WebFetchTool.inputSchema.safeParse({
      url: 'https://example.com/page',
      prompt: 'summarize',
      offset: '500',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.offset).toBe(500)
    }
  })

  test('accepts offset 0 and plain integers', () => {
    const parsed = WebFetchTool.inputSchema.safeParse({
      url: 'https://example.com/page',
      prompt: 'summarize',
      offset: 0,
    })
    expect(parsed.success).toBe(true)
  })

  test('rejects negative offset (official .nonnegative())', () => {
    const parsed = WebFetchTool.inputSchema.safeParse({
      url: 'https://example.com/page',
      prompt: 'summarize',
      offset: -1,
    })
    expect(parsed.success).toBe(false)
  })

  test('rejects fractional offset (official .int())', () => {
    const parsed = WebFetchTool.inputSchema.safeParse({
      url: 'https://example.com/page',
      prompt: 'summarize',
      offset: 1.5,
    })
    expect(parsed.success).toBe(false)
    const coercedFromString = WebFetchTool.inputSchema.safeParse({
      url: 'https://example.com/page',
      prompt: 'summarize',
      offset: '1.5',
    })
    expect(coercedFromString.success).toBe(false)
  })

  test('rejects non-numeric offset strings', () => {
    const parsed = WebFetchTool.inputSchema.safeParse({
      url: 'https://example.com/page',
      prompt: 'summarize',
      offset: 'abc',
    })
    expect(parsed.success).toBe(false)
  })

  test('offset describe text is the official verbatim string', () => {
    const offsetField = (
      WebFetchTool.inputSchema as unknown as {
        shape: { offset: { description?: string } }
      }
    ).shape.offset
    expect(offsetField.description).toBe(
      'Character position in the page text to start reading from. Use it to read on through a page too long for one call, with the value the previous result gave.',
    )
  })
})

describe('#018a — past_end branch', () => {
  test('offset past end of page text → verbatim past_end message', async () => {
    mockedFetchResult = fetched('abc')
    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize', offset: 10 },
      makeContext('tu_1'),
    )
    expect(data.result).toBe(
      "Nothing left to read from offset 10: this page's text is 3 characters long.",
    )
    // secondary model must NOT be invoked on the past_end path
    expect(applyCalls).toHaveLength(0)
  })

  test('offset exactly at end of page text → past_end too', async () => {
    mockedFetchResult = fetched('abcdef')
    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize', offset: 6 },
      makeContext('tu_1'),
    )
    expect(data.result).toBe(
      "Nothing left to read from offset 6: this page's text is 6 characters long.",
    )
  })

  test('offset 0 on empty content does NOT trigger past_end (official: H>0 required)', async () => {
    mockedFetchResult = fetched('')
    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize', offset: 0 },
      makeContext('tu_1'),
    )
    expect(data.result).toBe(mockedSummary)
    expect(applyCalls).toHaveLength(1)
  })
})

describe('#018a — offset slicing feeds the secondary model', () => {
  test('secondary model receives only the tail from offset on', async () => {
    mockedFetchResult = fetched('abcdefghij')
    await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize', offset: 4 },
      makeContext('tu_1'),
    )
    expect(applyCalls).toHaveLength(1)
    expect(applyCalls[0]?.markdownContent).toBe('efghij')
  })

  test('contentLead passed verbatim when offset > 0', async () => {
    mockedFetchResult = fetched('abcdefghij')
    await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize', offset: 4 },
      makeContext('tu_1'),
    )
    expect(applyCalls[0]?.contentLead).toBe(
      "The content below is one part of a longer page: it starts 4 characters into the page's 10.\n",
    )
  })

  test('no contentLead when offset is 0/absent', async () => {
    mockedFetchResult = fetched('abcdefghij')
    await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize' },
      makeContext('tu_1'),
    )
    expect(applyCalls[0]?.markdownContent).toBe('abcdefghij')
    expect(applyCalls[0]?.contentLead ?? '').toBe('')
  })

  test('surrogate pair straddling the offset boundary is not split', async () => {
    // 'a😀b' — offset 2 would land between the surrogate pair; official Xl
    // drops the leading lone low surrogate.
    mockedFetchResult = fetched('a😀b')
    await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize', offset: 2 },
      makeContext('tu_1'),
    )
    expect(applyCalls[0]?.markdownContent).toBe('b')
  })
})

describe('#018a — coverage note (secondary_model path)', () => {
  test('appended with exact official string when the answer covers only part of the page', async () => {
    const longContent = 'x'.repeat(150_000)
    mockedFetchResult = fetched(longContent)
    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize' },
      makeContext('tu_1'),
    )
    expect(data.result).toBe(
      'SUMMARY' +
        "\n\n[WebFetch note: this page's text is 150000 characters long and the answer above covers only characters 0 to 100000; the final 50000 were not read — to read on, call WebFetch again with the same url and offset: 100000.]",
    )
  })

  test('reflects the offset in covered range', async () => {
    const longContent = 'x'.repeat(150_000)
    mockedFetchResult = fetched(longContent)
    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize', offset: 20_000 },
      makeContext('tu_1'),
    )
    // slice from 20000 → 130000 chars; zJn caps at 100000 → covers
    // 20000..120000, final 30000 unread, continuation offset 120000.
    expect(data.result).toBe(
      'SUMMARY' +
        "\n\n[WebFetch note: this page's text is 150000 characters long and the answer above covers only characters 20000 to 120000; the final 30000 were not read — to read on, call WebFetch again with the same url and offset: 120000.]",
    )
  })

  test('absent when the whole page fits the 100k remainder cap', async () => {
    mockedFetchResult = fetched('x'.repeat(99_999))
    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize' },
      makeContext('tu_1'),
    )
    expect(data.result).toBe('SUMMARY')
  })

  test('absent for binary content types (official !In gate)', async () => {
    mockedFetchResult = fetched('x'.repeat(150_000), 'application/pdf')
    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize' },
      makeContext('tu_1'),
    )
    expect(data.result).toBe('SUMMARY')
  })

  test('absent when the toolUseId is not attributable (official Je!==void 0 gate)', async () => {
    mockedFetchResult = fetched('x'.repeat(150_000))
    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize' },
      makeContext(undefined),
    )
    expect(data.result).toBe('SUMMARY')
  })
})

describe('#018a — raw_markdown branch uses the offset slice', () => {
  test('preapproved text/markdown returns the sliced text verbatim', async () => {
    mockedFetchResult = fetched('abcdefghij', 'text/markdown')
    const { data } = await WebFetchTool.call(
      {
        url: 'https://platform.claude.com/docs/page.md',
        prompt: 'summarize',
        offset: 4,
      },
      makeContext('tu_1'),
    )
    expect(data.result).toBe('efghij')
    expect(applyCalls).toHaveLength(0)
  })

  test('preapproved text/markdown over the 100k cap still goes to the secondary model', async () => {
    mockedFetchResult = fetched('x'.repeat(120_000), 'text/markdown')
    const { data } = await WebFetchTool.call(
      {
        url: 'https://platform.claude.com/docs/page.md',
        prompt: 'summarize',
      },
      makeContext('tu_1'),
    )
    expect(applyCalls).toHaveLength(1)
    expect(data.result.startsWith('SUMMARY')).toBe(true)
  })
})

describe('#018a — redirect relay echoes the offset', () => {
  test('includes `- offset: N` when offset > 0', async () => {
    mockedFetchResult = {
      type: 'redirect',
      originalUrl: 'https://example.com/page',
      redirectUrl: 'https://other.com/page',
      statusCode: 302,
    }
    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize', offset: 55 },
      makeContext('tu_1'),
    )
    expect(data.result).toContain('- url: "https://other.com/page"')
    expect(data.result).toContain('- prompt: "summarize"')
    expect(data.result).toContain('- offset: 55')
  })

  test('omits the offset bullet when offset is 0/absent', async () => {
    mockedFetchResult = {
      type: 'redirect',
      originalUrl: 'https://example.com/page',
      redirectUrl: 'https://other.com/page',
      statusCode: 302,
    }
    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/page', prompt: 'summarize' },
      makeContext('tu_1'),
    )
    expect(data.result).not.toContain('- offset:')
  })
})

describe('#018a — tool description localhost bullet (official rd() full variant)', () => {
  test('DESCRIPTION carries the official localhost bullet', async () => {
    const { DESCRIPTION } = await import('../prompt.js')
    expect(DESCRIPTION).toContain(
      '- localhost and other hostnames without a dot are not supported; for a local server, use curl via Bash',
    )
  })
})
