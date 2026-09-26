// Byte-verified port of official Claude Code v2.1.283: MCP tool outputs +
// WebFetch + WebSearch outputs are now added to the `tool.output` span event
// (when OTEL_LOG_TOOL_CONTENT=1). This complements the pre-existing base
// emitter (non-MCP Read/Edit/Write/Bash — the official `UQn` set). The new
// path mirrors the official `HQn = new Set([WebFetch, WebSearch])` plus the
// `e.mcpInfo !== void 0` MCP gate.
//
// Official byte anchors re-verified in forensics/v283/claude (v282 lacks them):
//   - new block            @204862589  `if((e.mcpInfo!==void 0||HQn.has(e.name))&&!oo.detached&&rTr(Wt)){...}`
//   - HQn/UQn sets         @204827239  `UQn=new Set([at,At,wn,Ue]),HQn=new Set([Mr,uv])`
//   - wbo serializer       @201186465  string as-is / array→text parts joined "\n", else `[type]`
//   - KEe redaction        @201178413  `<${n.length} chars; not recorded>`
//   - oTr emitter          @201186638  per-string LT truncation + `${k}_truncated`/`${k}_original_length`
//   - rTr gate             @201186406  ND()&&Iut()&&!Rk()&&n.isRecording()

import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// --- OTEL api mock (spread actual, override trace, restore after) -----------
// OCC-97: Bun's mock.module leaks across test files in the same worker, so we
// spread the real module and only override the tracer's span factory.
// Bare top-level `await import` of a package specifier fails to resolve under
// Bun's isolated `.bun` store from a test entry file, so resolve the URL first.
const actualOtel = await import(import.meta.resolve('@opentelemetry/api'))

interface AddEventCall {
  name: string
  attrs: Record<string, string | number | boolean>
}
const addEventCalls: AddEventCall[] = []

const mockSpan = {
  spanContext: () => ({ spanId: 'span-283', traceId: 'trace-283', traceFlags: 0 }),
  addEvent: (name: string, attrs?: Record<string, string | number | boolean>) => {
    addEventCalls.push({ name, attrs: attrs ?? {} })
    return mockSpan
  },
  addEvents: () => mockSpan,
  isRecording: () => true,
  setAttributes: () => mockSpan,
  setStatus: () => mockSpan,
  updateName: () => mockSpan,
  recordException: () => {},
  end: () => {},
}

mock.module('@opentelemetry/api', () => ({
  ...actualOtel,
  trace: {
    ...actualOtel.trace,
    getTracer: () => ({ startSpan: () => mockSpan }),
    getActiveSpan: () => mockSpan,
  },
}))

afterAll(() => {
  mock.module('@opentelemetry/api', () => ({ ...actualOtel }))
})

// Import AFTER the mock is registered so the module binds the mocked api.
const {
  serializeToolResultContent,
  redactToolContentNotRecorded,
  buildToolContentAttributes,
  shouldEmitToolOutputContent,
  addToolResultOutputEvent,
  startToolSpan,
  endToolSpan,
} = await import('./sessionTracing.js')

// MAX_CONTENT_SIZE in betaSessionTracing.ts is 60 * 1024.
const MAX_CONTENT_SIZE = 60 * 1024

// --- env helpers ------------------------------------------------------------
const SAVED_ENV: Record<string, string | undefined> = {}
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    SAVED_ENV[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

afterEach(() => {
  restoreEnv()
  addEventCalls.length = 0
})

// ===========================================================================
// serializeToolResultContent — port of official `wbo`
// ===========================================================================
describe('serializeToolResultContent (official wbo)', () => {
  test('returns string content as-is', () => {
    expect(serializeToolResultContent('plain output')).toBe('plain output')
    expect(serializeToolResultContent('')).toBe('')
  })

  test('joins text parts with newlines', () => {
    const content = [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ]
    expect(serializeToolResultContent(content)).toBe('line one\nline two')
  })

  test('renders non-text parts as [type]', () => {
    const content = [
      { type: 'text', text: 'before' },
      { type: 'image', source: { data: 'zzz' } },
      { type: 'text', text: 'after' },
    ]
    expect(serializeToolResultContent(content)).toBe('before\n[image]\nafter')
  })

  test('renders a part with a missing type as [unknown]', () => {
    const content = [{ text: 'no type here' }]
    expect(serializeToolResultContent(content)).toBe('[unknown]')
  })

  test('non-array, non-string content serializes to empty string', () => {
    expect(serializeToolResultContent(undefined)).toBe('')
    expect(serializeToolResultContent(null)).toBe('')
    expect(serializeToolResultContent({ type: 'text', text: 'obj' })).toBe('')
    expect(serializeToolResultContent(42)).toBe('')
  })
})

// ===========================================================================
// redactToolContentNotRecorded — port of official `KEe`
// ===========================================================================
describe('redactToolContentNotRecorded (official KEe)', () => {
  test('produces the exact `<N chars; not recorded>` shape', () => {
    expect(redactToolContentNotRecorded('secret content')).toBe(
      '<14 chars; not recorded>',
    )
    expect(redactToolContentNotRecorded('')).toBe('<0 chars; not recorded>')
  })
})

// ===========================================================================
// buildToolContentAttributes — port of official `oTr` truncation loop
// ===========================================================================
describe('buildToolContentAttributes (official oTr truncation)', () => {
  test('short strings pass through with no truncation markers', () => {
    const out = buildToolContentAttributes({ output: 'small' })
    expect(out).toEqual({ output: 'small' })
    expect('output_truncated' in out).toBe(false)
    expect('output_original_length' in out).toBe(false)
  })

  test('oversized strings are truncated and annotated', () => {
    const big = 'x'.repeat(MAX_CONTENT_SIZE + 500)
    const out = buildToolContentAttributes({ output: big })
    expect(out.output_truncated).toBe(true)
    expect(out.output_original_length).toBe(MAX_CONTENT_SIZE + 500)
    // truncated content is shorter than the original
    expect((out.output as string).length).toBeLessThan(big.length)
  })

  test('non-string values pass through untouched', () => {
    const out = buildToolContentAttributes({ count: 7, flag: true })
    expect(out).toEqual({ count: 7, flag: true })
  })
})

// ===========================================================================
// shouldEmitToolOutputContent — port of official gate
//   (e.mcpInfo !== void 0 || HQn.has(e.name))
// ===========================================================================
describe('shouldEmitToolOutputContent (official gate)', () => {
  test('WebFetch and WebSearch are included (HQn set)', () => {
    expect(shouldEmitToolOutputContent({ name: 'WebFetch' })).toBe(true)
    expect(shouldEmitToolOutputContent({ name: 'WebSearch' })).toBe(true)
  })

  test('any MCP tool is included (mcpInfo !== undefined)', () => {
    expect(
      shouldEmitToolOutputContent({
        name: 'mcp__server__tool',
        mcpInfo: { serverName: 'server', toolName: 'tool' },
      }),
    ).toBe(true)
  })

  test('regular non-MCP tools are NOT on the new path', () => {
    expect(shouldEmitToolOutputContent({ name: 'Grep' })).toBe(false)
    expect(shouldEmitToolOutputContent({ name: 'Read' })).toBe(false)
    expect(shouldEmitToolOutputContent({ name: 'Bash' })).toBe(false)
    expect(shouldEmitToolOutputContent({ name: 'Glob' })).toBe(false)
  })
})

// ===========================================================================
// addToolResultOutputEvent — end-to-end emission through the real OTEL path
// ===========================================================================
describe('addToolResultOutputEvent (tool.output emission)', () => {
  function enableLogging(): void {
    setEnv({
      USER_TYPE: 'ant',
      ENABLE_BETA_TRACING_DETAILED: '1',
      BETA_TRACING_ENDPOINT: 'http://localhost:4318',
      OTEL_LOG_TOOL_CONTENT: '1',
    })
    // Establish the tool span context (toolContext) that addToolContentEvent reads.
    startToolSpan('WebFetch')
  }

  test('WebFetch emits tool.output with serialized content when logging on', () => {
    enableLogging()
    addToolResultOutputEvent({ name: 'WebFetch' }, 'fetched page text')
    const evt = addEventCalls.find(c => c.name === 'tool.output')
    expect(evt).toBeDefined()
    expect(evt?.attrs).toEqual({ output: 'fetched page text' })
    endToolSpan()
  })

  test('WebSearch serializes array content parts into the output', () => {
    enableLogging()
    addToolResultOutputEvent(
      { name: 'WebSearch' },
      [
        { type: 'text', text: 'result A' },
        { type: 'text', text: 'result B' },
      ],
    )
    const evt = addEventCalls.find(c => c.name === 'tool.output')
    expect(evt?.attrs).toEqual({ output: 'result A\nresult B' })
    endToolSpan()
  })

  test('MCP tool with accountMemory redacts the output (forward-compat shape)', () => {
    enableLogging()
    addToolResultOutputEvent(
      { name: 'mcp__mem__store', mcpInfo: { accountMemory: true } },
      'sensitive memory content',
    )
    const evt = addEventCalls.find(c => c.name === 'tool.output')
    // 'sensitive memory content'.length === 24
    expect(evt?.attrs).toEqual({ output: '<24 chars; not recorded>' })
    endToolSpan()
  })

  test('regular non-MCP tool (Grep) does NOT emit on the new path', () => {
    enableLogging()
    addToolResultOutputEvent({ name: 'Grep' }, 'match output')
    expect(addEventCalls.find(c => c.name === 'tool.output')).toBeUndefined()
    endToolSpan()
  })

  test('no emission when OTEL_LOG_TOOL_CONTENT is off', () => {
    setEnv({
      USER_TYPE: 'ant',
      ENABLE_BETA_TRACING_DETAILED: '1',
      BETA_TRACING_ENDPOINT: 'http://localhost:4318',
      OTEL_LOG_TOOL_CONTENT: '0',
    })
    startToolSpan('WebFetch')
    addToolResultOutputEvent({ name: 'WebFetch' }, 'fetched page text')
    expect(addEventCalls.find(c => c.name === 'tool.output')).toBeUndefined()
    endToolSpan()
  })
})
