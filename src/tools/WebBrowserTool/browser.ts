/**
 * Singleton puppeteer-core browser manager for the WebBrowser tools.
 *
 * Holds the non-serializable Browser/Page handles in module scope (NEVER in
 * Zustand/AppState — only derived strings like the current URL and captured
 * console logs surface to state, synced by the tool call() via setAppState).
 *
 * Launches the system Chrome binary (no Chromium download) headless with
 * --no-sandbox (required when running as root in containers).
 */
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

const CHROME_EXECUTABLE_PATH =
  process.env.OCC_WEBBROWSER_CHROME_PATH ?? '/usr/bin/google-chrome-stable'

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--no-first-run',
]

const NAV_TIMEOUT_MS = 30_000
const MAX_LOGS = 100

let browser: Browser | null = null
let page: Page | null = null
let currentUrl = ''
let cleanupRegistered = false
const logs: string[] = []

export type BrowserLaunchError = {
  ok: false
  error: string
}

function addLog(line: string): void {
  logs.push(line)
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
}

/** Lazily launch Chrome and create the single shared page. Throws on failure. */
export async function getBrowser(): Promise<Browser> {
  if (browser) return browser
  browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_EXECUTABLE_PATH,
    args: CHROME_ARGS,
  })
  return browser
}

/**
 * Returns the active page, creating one on first call. Page-level console and
 * error listeners are attached once and push into the module-level logs ring.
 */
export async function getPage(): Promise<Page> {
  const b = await getBrowser()
  if (page) return page
  page = await b.newPage()
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
  page.on('console', (msg: { type(): string; text(): string }) => {
    addLog(`[${msg.type()}] ${msg.text()}`)
  })
  page.on('pageerror', (err: Error) => {
    addLog(`[pageerror] ${err.message}`)
  })
  return page
}

export function getCurrentUrl(): string {
  return currentUrl
}

export function setCurrentUrl(url: string): void {
  currentUrl = url
}

export function getLogs(): readonly string[] {
  return logs
}

export function isCleanupRegistered(): boolean {
  return cleanupRegistered
}

export function setCleanupRegistered(v: boolean): void {
  cleanupRegistered = v
}

/**
 * Close the browser and reset module state. Idempotent. Safe to call on
 * process exit. Errors are swallowed so an exit handler never throws.
 */
export async function cleanup(): Promise<void> {
  try {
    if (page) {
      await page.close().catch(() => {})
      page = null
    }
  } catch {
    // ignore
  }
  try {
    if (browser) {
      await browser.close().catch(() => {})
      browser = null
    }
  } catch {
    // ignore
  }
}

/**
 * Register a process-exit cleanup once. Guards on cleanupRegistered so the
 * handler is never installed twice across repeated tool calls. The handler
 * closes Chrome so headless processes don't outlive the OCC session.
 */
export function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  const handler = (): void => {
    void cleanup()
  }
  // 'beforeExit' allows async work to flush; 'exit' is synchronous but we still
  // kick off the CDP disconnect. Bun/Node reap the child Chrome on process
  // death regardless, so this is best-effort hygiene.
  process.on('beforeExit', handler)
  process.on('exit', handler)
}
