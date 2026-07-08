/**
 * Sub-action dispatcher for the WebBrowser browser_batch tool, and the shared
 * handler implementations used by both the individual tools and the batch
 * sequencer. Each handler returns a discriminated action result so the batch
 * tool can assemble mixed text + image content blocks in one round trip.
 */
import { getPage, getCurrentUrl, setCurrentUrl, registerCleanup } from './browser.js'

export type ActionResult =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mediaType: 'image/png' }

export type DispatchResult =
  | { ok: true; result: ActionResult }
  | { ok: false; error: string }

/** Sub-actions implemented in OCC. */
const IMPLEMENTED_ACTIONS = new Set([
  'navigate',
  'get_page_text',
  'screenshot',
])

/** Read-only sub-actions (mirrors READONLY_SUBACTIONS in prompt.ts). */
export function isReadOnlyAction(name: string): boolean {
  return name === 'get_page_text' || name === 'screenshot'
}

function okText(text: string): DispatchResult {
  return { ok: true, result: { type: 'text', text } }
}

function fail(error: string): DispatchResult {
  return { ok: false, error }
}

/** Normalize a raw url argument: upgrade bare hostnames to https://. */
function normalizeUrl(raw: string): string {
  if (raw === 'forward' || raw === 'back') return raw
  if (/^https?:\/\//i.test(raw)) return raw
  // bare hostname (e.g. "example.com" or "example.com/path") → https://
  if (/^[\w.-]+(:\d+)?(\/|$)/.test(raw)) return `https://${raw}`
  return raw
}

async function handleNavigate(input: {
  url: string
  tabId?: number
}): Promise<DispatchResult> {
  const rawUrl = input?.url
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return fail('navigate requires a "url" string.')
  }
  try {
    const page = await getPage()
    registerCleanup()
    const target = normalizeUrl(rawUrl)
    if (target === 'forward' || target === 'back') {
      const navFn = target === 'forward' ? page.goForward : page.goBack
      await navFn.call(page, { waitUntil: 'networkidle2' }).catch(() => {})
      const finalUrl = page.url()
      setCurrentUrl(finalUrl)
      const title = await page.title().catch(() => '')
      return okText(
        `Navigated ${target}. URL: ${finalUrl}\nTitle: ${title}`,
      )
    }
    const httpResp = await page.goto(target, {
      waitUntil: 'networkidle2',
    })
    const finalUrl = page.url()
    setCurrentUrl(finalUrl)
    const title = await page.title().catch(() => '')
    const status = httpResp?.status() ?? 0
    return okText(
      `Navigated to ${finalUrl}\nTitle: ${title}\nHTTP status: ${status}`,
    )
  } catch (err) {
    return fail(
      `navigate failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function handleGetPageText(): Promise<DispatchResult> {
  try {
    const page = await getPage()
    registerCleanup()
    const text = await page.evaluate(() => {
      const article = document.querySelector('article')
      const el = article ?? document.body
      // innerText respects rendering (collapses whitespace, skips hidden),
      // giving clean plain text closest to "raw text content".
      const raw = el ? (el as HTMLElement).innerText : ''
      return raw
        .split('\n')
        .map((l: string) => l.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    })
    if (!text) {
      return okText(
        getCurrentUrl()
          ? `Page ${getCurrentUrl()} has no extractable text content.`
          : 'No page loaded. Call navigate first.',
      )
    }
    return okText(text)
  } catch (err) {
    return fail(
      `get_page_text failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function handleScreenshot(input: {
  fullPage?: boolean
  tabId?: number
}): Promise<DispatchResult> {
  try {
    const page = await getPage()
    registerCleanup()
    const shot = await page.screenshot({
      fullPage: input?.fullPage === true,
    })
    // puppeteer-core returns a Uint8Array under Bun; base64-encode for the
    // image content block (mirrors FileReadTool's image return path).
    const base64 = Buffer.from(shot as Uint8Array).toString('base64')
    return { ok: true, result: { type: 'image', base64, mediaType: 'image/png' } }
  } catch (err) {
    return fail(
      `screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Dispatch a single sub-action by name. Used by both the standalone tools and
 * browser_batch. Rejects browser_batch (nested) and unimplemented names with a
 * clear "not implemented in OCC" error.
 */
export async function dispatchAction(
  name: string,
  input: Record<string, unknown> | undefined,
): Promise<DispatchResult> {
  const args = (input ?? {}) as Record<string, unknown>
  if (name === 'browser_batch') {
    return fail(
      'browser_batch cannot be nested (a batch action whose name is browser_batch is rejected).',
    )
  }
  if (!IMPLEMENTED_ACTIONS.has(name)) {
    return fail(
      `"${name}" is not implemented in OCC's WebBrowser. Implemented actions: navigate, get_page_text, screenshot, browser_batch.`,
    )
  }
  switch (name) {
    case 'navigate':
      return handleNavigate({ url: String(args.url ?? ''), tabId: typeof args.tabId === 'number' ? args.tabId : undefined })
    case 'get_page_text':
      return handleGetPageText()
    case 'screenshot':
      return handleScreenshot({
        fullPage: args.fullPage === true,
        tabId: typeof args.tabId === 'number' ? args.tabId : undefined,
      })
    default:
      return fail(`Unknown action: ${name}`)
  }
}
