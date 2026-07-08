import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, getCurrentUrl } from '../../src/tools/WebBrowserTool/browser.js'
import { dispatchAction, isReadOnlyAction } from '../../src/tools/WebBrowserTool/actions.js'
import {
  WebBrowserBatchTool,
  WebBrowserGetPageTextTool,
  WebBrowserNavigateTool,
  WebBrowserScreenshotTool,
} from '../../src/tools/WebBrowserTool/WebBrowserTool.js'

// These tests launch real headless Chrome via puppeteer-core. Guard behind an
// env flag so `bun test` doesn't fail in environments without Chrome.
const RUN = process.env.OCC_WEBBROWSER_E2E === '1'
const describeIf = RUN ? describe : describe.skip

const FIXTURE_PATH = new URL(
  '../../test/e2e/fixtures/webbrowser-page.html',
  import.meta.url,
).pathname

let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ''

function startFixtureServer(): void {
  const port = 18799 + Math.floor(Math.random() * 100)
  server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/') {
        const file = Bun.file(FIXTURE_PATH)
        return new Response(file, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  baseUrl = `http://localhost:${port}/`
}

/** Minimal ToolUseContext mock — only setAppState/getAppState are exercised. */
function mockContext(): any {
  let state: any = {}
  return {
    abortController: new AbortController(),
    readFileState: new Map(),
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test',
      tools: [],
      verbose: false,
      thinkingConfig: {},
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { agents: [], defaultAgent: null } as any,
    },
    getAppState: () => state,
    setAppState: (f: (prev: any) => any) => {
      state = f(state)
    },
  }
}

describeIf('WebBrowser tool family (real headless Chrome)', () => {
  beforeEach(() => {
    startFixtureServer()
  })
  afterEach(async () => {
    server?.stop(true)
    server = null
    await cleanup()
  })

  test('navigate → get_page_text returns article text', async () => {
    const nav = await dispatchAction('navigate', { url: baseUrl })
    expect(nav.ok).toBe(true)
    expect(nav.ok && nav.result.type === 'text' ? nav.result.text : '').toContain(
      'Navigated to',
    )

    const text = await dispatchAction('get_page_text', undefined)
    expect(text.ok).toBe(true)
    const content =
      text.ok && text.result.type === 'text' ? text.result.text : ''
    expect(content).toContain('Hello from OCC WebBrowser')
    expect(content).toContain('alpha')
    expect(content).toContain('beta')
    // article content is prioritized; the footer (outside <article>) is excluded
    expect(content).not.toContain('footer noise')
  })

  test('screenshot returns a non-empty PNG image', async () => {
    await dispatchAction('navigate', { url: baseUrl })
    const shot = await dispatchAction('screenshot', { fullPage: true })
    expect(shot.ok).toBe(true)
    expect(
      shot.ok && shot.result.type === 'image' ? shot.result.base64.length : 0,
    ).toBeGreaterThan(100)
  })

  test('nested browser_batch is rejected', async () => {
    const res = await dispatchAction('browser_batch', {
      actions: [{ name: 'navigate', input: { url: baseUrl } }],
    })
    expect(res.ok).toBe(false)
    expect(res.ok ? '' : res.error).toContain('cannot be nested')
  })

  test('unimplemented action returns a clear not-implemented error', async () => {
    const res = await dispatchAction('computer', { action: 'left_click' })
    expect(res.ok).toBe(false)
    expect(res.ok ? '' : res.error).toContain('not implemented in OCC')
  })

  test('isReadOnlyAction: get_page_text/screenshot read-only, navigate not', () => {
    expect(isReadOnlyAction('get_page_text')).toBe(true)
    expect(isReadOnlyAction('screenshot')).toBe(true)
    expect(isReadOnlyAction('navigate')).toBe(false)
    expect(isReadOnlyAction('browser_batch')).toBe(false)
  })

  test('WebBrowserNavigateTool.call syncs bagelUrl + returns text result', async () => {
    const ctx = mockContext()
    const res = await WebBrowserNavigateTool.call({ url: baseUrl }, ctx, (() => {}) as any, {} as any)
    expect(res.data.result).toContain('Navigated to')
    // setAppState was called: bagelActive flipped on + bagelUrl synced
    expect(ctx.getAppState().bagelActive).toBe(true)
    expect(ctx.getAppState().bagelUrl).toContain('localhost')
    expect(getCurrentUrl()).toContain('localhost')
  })

  test('WebBrowserBatchTool.call runs [navigate, get_page_text] sequentially', async () => {
    const ctx = mockContext()
    const res = await WebBrowserBatchTool.call(
      {
        actions: [
          { name: 'navigate', input: { url: baseUrl } },
          { name: 'get_page_text', input: {} },
        ],
      },
      ctx,
      (() => {}) as any,
      {} as any,
    )
    expect(res.data.blocks.length).toBe(2)
    expect(res.data.error).toBeNull()
    expect(res.data.blocks[0].type).toBe('text')
    expect(
      res.data.blocks[0].type === 'text' ? res.data.blocks[0].text : '',
    ).toContain('Navigated to')
    expect(
      res.data.blocks[1].type === 'text' ? res.data.blocks[1].text : '',
    ).toContain('Hello from OCC WebBrowser')
  })

  test('WebBrowserBatchTool.call stops on first error (nested batch)', async () => {
    const ctx = mockContext()
    const res = await WebBrowserBatchTool.call(
      {
        actions: [
          { name: 'browser_batch', input: { actions: [] } },
          { name: 'get_page_text', input: {} },
        ],
      },
      ctx,
      (() => {}) as any,
      {} as any,
    )
    expect(res.data.blocks.length).toBe(1)
    expect(res.data.error).not.toBeNull()
    expect(
      res.data.blocks[0].type === 'text' ? res.data.blocks[0].text : '',
    ).toContain('ERROR')
  })

  test('WebBrowserBatchTool.isReadOnly reflects sub-actions', () => {
    expect(
      WebBrowserBatchTool.isReadOnly({
        actions: [{ name: 'get_page_text', input: {} }],
      } as any),
    ).toBe(true)
    expect(
      WebBrowserBatchTool.isReadOnly({
        actions: [{ name: 'navigate', input: {} }],
      } as any),
    ).toBe(false)
    expect(
      WebBrowserBatchTool.isReadOnly({
        actions: [
          { name: 'get_page_text', input: {} },
          { name: 'screenshot', input: {} },
        ],
      } as any),
    ).toBe(true)
  })

  test('WebBrowserScreenshotTool.call + mapToolResultToToolResultBlockParam yields an image block', async () => {
    await dispatchAction('navigate', { url: baseUrl })
    const ctx = mockContext()
    const res = await WebBrowserScreenshotTool.call(
      { fullPage: false },
      ctx,
      (() => {}) as any,
      {} as any,
    )
    expect(res.data.base64.length).toBeGreaterThan(100)
    const block = WebBrowserScreenshotTool.mapToolResultToToolResultBlockParam(
      res.data,
      'tu-1',
    )
    expect(block.type).toBe('tool_result')
    expect(Array.isArray(block.content)).toBe(true)
    const img = (block.content as any[])[0]
    expect(img.type).toBe('image')
    expect(img.source.type).toBe('base64')
    expect(img.source.media_type).toBe('image/png')
  })

  test('WebBrowserGetPageTextTool is read-only; WebBrowserNavigateTool is not', () => {
    expect(WebBrowserGetPageTextTool.isReadOnly({} as any)).toBe(true)
    expect(WebBrowserScreenshotTool.isReadOnly({} as any)).toBe(true)
    expect(WebBrowserNavigateTool.isReadOnly({ url: 'x' } as any)).toBe(false)
  })
})
