/**
 * WebBrowser tool family (OCC #10 H4) — REAL implementation.
 *
 * Drives a local headless Chrome via puppeteer-core + the system Chrome binary
 * (see browser.ts). Four built-in (non-MCP) tools mirror the official
 * "claude-in-chrome" family names so a model trained on the official tools can
 * drive OCC's subset:
 *
 *   - navigate       (state-mutating; asks permission per host)
 *   - get_page_text  (read-only; auto-allowed)
 *   - screenshot     (read-only; auto-allowed)
 *   - browser_batch  (read-only iff every sub-action is read-only)
 *
 * The puppeteer Browser/Page handles live in the browser.ts module singleton
 * (non-serializable — never in Zustand). Only derived strings (current URL,
 * captured console logs) are synced into AppState via context.setAppState so
 * the WebBrowserPanel can render them.
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { isPreapprovedHost } from '../WebFetchTool/preapproved.js'
import {
  dispatchAction,
  isReadOnlyAction,
  type ActionResult,
  type DispatchResult,
} from './actions.js'
import { getCurrentUrl, getLogs, registerCleanup } from './browser.js'
import {
  BATCH_DESCRIPTION,
  GET_PAGE_TEXT_DESCRIPTION,
  NAVIGATE_DESCRIPTION,
  SCREENSHOT_DESCRIPTION,
  WEB_BROWSER_BATCH_TOOL_NAME,
  WEB_BROWSER_GET_PAGE_TEXT_TOOL_NAME,
  WEB_BROWSER_NAVIGATE_TOOL_NAME,
  WEB_BROWSER_SCREENSHOT_TOOL_NAME,
} from './prompt.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Sync the browser singleton's derived state into AppState for the panel. */
function syncBrowserState(context: ToolUseContext): void {
  context.setAppState(prev => ({
    ...prev,
    bagelActive: true,
    bagelUrl: getCurrentUrl() || prev.bagelUrl,
    webBrowserLogs: [...getLogs().slice(-50)],
  }))
}

/** A content block emitted by browser_batch (text label or screenshot image). */
type BatchContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: 'base64'; data: string; media_type: 'image/png' }
    }

/** Normalize a raw url argument for permission checks (mirror actions.ts). */
function normalizeUrlForPerm(raw: string): string {
  if (raw === 'forward' || raw === 'back') return raw
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^[\w.-]+(:\d+)?(\/|$)/.test(raw)) return `https://${raw}`
  return raw
}

/** Convert an action result into an API content block. */
function resultToBlock(name: string, r: ActionResult): BatchContentBlock {
  if (r.type === 'image') {
    return {
      type: 'image',
      source: { type: 'base64', data: r.base64, media_type: r.mediaType },
    }
  }
  return { type: 'text', text: `[${name}]\n${r.text}` }
}

// ---------------------------------------------------------------------------
// navigate
// ---------------------------------------------------------------------------

const navigateInputSchema = z.strictObject({
  url: z
    .string()
    .describe(
      'The URL to navigate to, or "forward"/"back" to traverse browser history. Bare hostnames are upgraded to https://.',
    ),
  tabId: z.number().optional().describe('Ignored in OCC (single shared page).'),
})

export const WebBrowserNavigateTool = buildTool({
  name: WEB_BROWSER_NAVIGATE_TOOL_NAME,
  searchHint: 'navigate a headless browser to a URL',
  maxResultSizeChars: 100_000,
  async description() {
    return NAVIGATE_DESCRIPTION
  },
  userFacingName() {
    return 'Navigate'
  },
  get inputSchema() {
    return navigateInputSchema
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return input.url ?? ''
  },
  async checkPermissions(
    input: { url: string },
    _context,
  ): Promise<PermissionDecision> {
    const raw = input?.url
    // History traversal re-visits already-approved pages.
    if (raw === 'forward' || raw === 'back') {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'other', reason: 'Browser history traversal' },
      }
    }
    try {
      const parsedUrl = new URL(normalizeUrlForPerm(raw))
      if (isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: { type: 'other', reason: 'Preapproved host' },
        }
      }
    } catch {
      // fall through to ask
    }
    return {
      behavior: 'ask',
      message: `Claude wants to navigate the browser to ${raw}.`,
      decisionReason: { type: 'other', reason: 'Browser navigation' },
    }
  },
  async prompt() {
    return NAVIGATE_DESCRIPTION
  },
  renderToolUseMessage(input: Partial<{ url: string }>) {
    return input.url ?? null
  },
  async call(input, context) {
    registerCleanup()
    const res = await dispatchAction('navigate', input as Record<string, unknown>)
    syncBrowserState(context)
    const result =
      res.ok && res.result.type === 'text'
        ? res.result.text
        : `Error: ${res.ok ? '' : res.error}`
    return { data: { result, finalUrl: getCurrentUrl() } }
  },
  mapToolResultToToolResultBlockParam(
    data: { result: string },
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: data.result,
    }
  },
} satisfies ToolDef<typeof navigateInputSchema, { result: string; finalUrl: string }>)

// ---------------------------------------------------------------------------
// get_page_text
// ---------------------------------------------------------------------------

const getPageTextInputSchema = z.strictObject({
  tabId: z.number().optional().describe('Ignored in OCC (single shared page).'),
})

export const WebBrowserGetPageTextTool = buildTool({
  name: WEB_BROWSER_GET_PAGE_TEXT_TOOL_NAME,
  searchHint: 'extract text content from the browser page',
  maxResultSizeChars: 100_000,
  async description() {
    return GET_PAGE_TEXT_DESCRIPTION
  },
  userFacingName() {
    return 'Page text'
  },
  get inputSchema() {
    return getPageTextInputSchema
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput() {
    return ''
  },
  async prompt() {
    return GET_PAGE_TEXT_DESCRIPTION
  },
  renderToolUseMessage() {
    return 'get_page_text'
  },
  async call(_input, context) {
    registerCleanup()
    const res = await dispatchAction('get_page_text', undefined)
    syncBrowserState(context)
    const result =
      res.ok && res.result.type === 'text'
        ? res.result.text
        : `Error: ${res.ok ? '' : res.error}`
    return { data: { result } }
  },
  mapToolResultToToolResultBlockParam(
    data: { result: string },
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: data.result,
    }
  },
} satisfies ToolDef<typeof getPageTextInputSchema, { result: string }>)

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

const screenshotInputSchema = z.strictObject({
  tabId: z.number().optional().describe('Ignored in OCC (single shared page).'),
  fullPage: z
    .boolean()
    .optional()
    .describe('Capture the entire scrollable page instead of the viewport.'),
})

export const WebBrowserScreenshotTool = buildTool({
  name: WEB_BROWSER_SCREENSHOT_TOOL_NAME,
  searchHint: 'capture a screenshot of the browser page',
  maxResultSizeChars: 5_000_000,
  async description() {
    return SCREENSHOT_DESCRIPTION
  },
  userFacingName() {
    return 'Screenshot'
  },
  get inputSchema() {
    return screenshotInputSchema
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput() {
    return ''
  },
  async prompt() {
    return SCREENSHOT_DESCRIPTION
  },
  renderToolUseMessage(input: Partial<{ fullPage: boolean }>) {
    return input.fullPage ? 'screenshot (full page)' : 'screenshot'
  },
  async call(input, context) {
    registerCleanup()
    const res = await dispatchAction('screenshot', input as Record<string, unknown>)
    syncBrowserState(context)
    if (res.ok && res.result.type === 'image') {
      return {
        data: { base64: res.result.base64, mediaType: res.result.mediaType },
      }
    }
    // Error: no image to return; surface as a text result instead.
    return {
      data: {
        base64: '',
        mediaType: 'image/png' as const,
        error: res.ok ? '' : res.error,
      },
    }
  },
  mapToolResultToToolResultBlockParam(
    data: { base64: string; mediaType: 'image/png'; error?: string },
    toolUseID: string,
  ): ToolResultBlockParam {
    if (data.error || !data.base64) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Error: ${data.error ?? 'screenshot produced no image'}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            data: data.base64,
            media_type: data.mediaType,
          },
        },
      ],
    }
  },
} satisfies ToolDef<
  typeof screenshotInputSchema,
  { base64: string; mediaType: 'image/png'; error?: string }
>)

// ---------------------------------------------------------------------------
// browser_batch
// ---------------------------------------------------------------------------

const batchActionSchema = z.object({
  name: z.string().describe('The browser action to execute (e.g. navigate).'),
  input: z.record(z.string(), z.unknown()).describe(
    'The input object — exactly what you would pass to the standalone tool.',
  ),
})

const batchInputSchema = z.strictObject({
  actions: z
    .array(batchActionSchema)
    .min(1)
    .describe(
      'A sequence of { name, input } browser actions to execute sequentially.',
    ),
})

type BatchAction = { name: string; input: Record<string, unknown> }

/** True iff every sub-action in a batch input is read-only. */
function isBatchReadOnly(input: { actions?: BatchAction[] }): boolean {
  const actions = input?.actions
  if (!Array.isArray(actions) || actions.length === 0) return false
  return actions.every(a => isReadOnlyAction(a.name))
}

export const WebBrowserBatchTool = buildTool({
  name: WEB_BROWSER_BATCH_TOOL_NAME,
  searchHint: 'run a sequence of browser actions in one round trip',
  maxResultSizeChars: 5_000_000,
  async description() {
    return BATCH_DESCRIPTION
  },
  userFacingName() {
    return 'Browser batch'
  },
  get inputSchema() {
    return batchInputSchema
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input) {
    return isBatchReadOnly(input as { actions?: BatchAction[] })
  },
  toAutoClassifierInput(input) {
    const acts = (input as { actions?: BatchAction[] })?.actions ?? []
    return acts.map(a => a.name).join(',')
  },
  async checkPermissions(
    input: { actions?: BatchAction[] },
    _context,
  ): Promise<PermissionDecision> {
    // Read-only batches (only get_page_text/screenshot) auto-allow.
    if (isBatchReadOnly(input)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'other', reason: 'Read-only browser batch' },
      }
    }
    // A batch containing navigate (state-mutating) must ask — but only on the
    // first mutating action, mirroring the standalone navigate permission.
    const firstMutating = (input.actions ?? []).find(a => !isReadOnlyAction(a.name))
    return {
      behavior: 'ask',
      message: `Claude wants to run a browser_batch that includes a state-mutating action (${firstMutating?.name ?? 'navigate'}).`,
      decisionReason: { type: 'other', reason: 'Browser batch with mutating action' },
    }
  },
  async prompt() {
    return BATCH_DESCRIPTION
  },
  renderToolUseMessage(input: Partial<{ actions?: BatchAction[] }>) {
    const names = input.actions?.map(a => a.name).join(', ')
    return names ? `batch: ${names}` : 'browser_batch'
  },
  async call(input, context) {
    registerCleanup()
    const actions = (input.actions ?? []) as BatchAction[]
    const blocks: BatchContentBlock[] = []
    let firstError: string | null = null
    for (const action of actions) {
      // eslint-disable-next-line no-await-in-loop
      const res: DispatchResult = await dispatchAction(action.name, action.input)
      if (!res.ok) {
        blocks.push({
          type: 'text',
          text: `[${action.name}] ERROR: ${res.error}`,
        })
        firstError = res.error
        break
      }
      const block = resultToBlock(action.name, res.result)
      blocks.push(block as BatchContentBlock)
    }
    syncBrowserState(context)
    return {
      data: { blocks, error: firstError },
    }
  },
  mapToolResultToToolResultBlockParam(
    data: { blocks: BatchContentBlock[]; error: string | null },
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: data.blocks,
      ...(data.error ? { is_error: false } : {}),
    }
  },
} satisfies ToolDef<
  typeof batchInputSchema,
  { blocks: BatchContentBlock[]; error: string | null }
>)
