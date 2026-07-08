/**
 * WebBrowser tool family (OCC #10 H4).
 *
 * The official "WebBrowser" surface is a family of MCP tools served by a
 * "claude-in-chrome" extension-pairing transport. OCC ships a trimmed,
 * built-in (non-MCP) implementation that drives a local headless Chrome via
 * puppeteer-core + the system Chrome binary. Tool names + the browser_batch
 * semantics mirror the official family so a model trained on the official
 * tools can drive OCC's subset.
 *
 * Implemented subset: navigate, get_page_text, screenshot, browser_batch.
 * Not implemented (return a clear "not implemented in OCC" error): computer,
 * read_page, form_input, file_upload, tabs_*, scroll, hover, etc.
 */

export const WEB_BROWSER_NAVIGATE_TOOL_NAME = 'navigate'
export const WEB_BROWSER_GET_PAGE_TEXT_TOOL_NAME = 'get_page_text'
export const WEB_BROWSER_SCREENSHOT_TOOL_NAME = 'screenshot'
export const WEB_BROWSER_BATCH_TOOL_NAME = 'browser_batch'

/** Read-only sub-actions auto-allowed in plan/auto mode (mirrors official
 * CHROME_READONLY_SUBACTIONS — restricted to OCC's implemented subset). */
export const READONLY_SUBACTIONS = new Set([
  'get_page_text',
  'screenshot',
])

export const NAVIGATE_DESCRIPTION = `Navigate the browser to a URL, or go forward/back in browser history.

- Accepts a fully-formed URL (http/https) or the literal "forward"/"back" to traverse browser history.
- Bare hostnames (e.g. "example.com") are upgraded to https://.
- Returns the final URL after redirects, the page title, and the HTTP status.
- This is a state-mutating action: it changes the active page. It is NOT auto-allowed in plan mode.`

export const GET_PAGE_TEXT_DESCRIPTION = `Extract the raw text content of the current browser page.

- Prioritizes <article> content when present, otherwise extracts <body> text.
- Strips <script>/<style>/<noscript>/<iframe> and returns plain text (HTML tags removed).
- Read-only: does not modify page state. Safe to auto-allow in plan mode.`

export const SCREENSHOT_DESCRIPTION = `Capture a PNG screenshot of the current browser page.

- By default captures the visible viewport; set fullPage: true for the entire scrollable page.
- Returns the image as a base64 image content block the model can view directly.
- Read-only: does not modify page state. Safe to auto-allow in plan mode.`

export const BATCH_DESCRIPTION = `Execute a sequence of browser actions in ONE round trip.

- Each item is { name, input } where input is exactly what you would pass to the standalone tool.
- Actions execute SEQUENTIALLY (not in parallel) and stop on the first error.
- browser_batch cannot be nested (a batch action whose name is browser_batch is rejected).
- Prefer browser_batch to execute multiple actions in one call — it is significantly faster. Batch your next sequence of clicks, types, navigations, and screenshots together.
- Read-only iff every sub-action is read-only. A batch containing navigate (state-mutating) is NOT auto-allowed in plan mode; a batch of only get_page_text/screenshot IS auto-allowed.`

export const WEB_BROWSER_DESCRIPTION = `Access a web browser to navigate pages, read text content, and take screenshots.

OCC drives a local headless Chrome (via puppeteer-core + the system Chrome binary). This is an isolated browser with no access to your logged-in sessions or cookies. For authenticated/private pages, prefer a specialized MCP tool.

Implemented actions: navigate, get_page_text, screenshot, browser_batch. Other official browser actions (computer, read_page, form_input, tabs_*) are not implemented in OCC and will return an error.`
