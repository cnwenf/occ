/**
 * MCP list-pagination walker + network-error classification, aligned to the
 * official 2.1.295 binary.
 *
 * Reverse-engineered from the official bundle (two byte-identical copies,
 * minified as `ua`/`Ir` + `Qn`/`Kn` + `Nt`/`_o`):
 *
 *   var As=["ECONNRESET","ETIMEDOUT","EPIPE","EHOSTUNREACH","ECONNREFUSED"],
 *       ca=new Set([...As,"ConnectionRefused","ConnectionClosed"]),
 *       da=/^Error POSTing to endpoint \(HTTP (\d+)\)/;
 *   function wo(e){return typeof e==="number"&&e>=100&&e<=599}
 *   function ua(e){if(e.name==="AbortError")return!0;
 *     let n="code"in e?e.code:void 0,r="status"in e?e.status:void 0,
 *         s=da.exec(e.message)?.[1];
 *     if(wo(r)||wo(n)||typeof n==="number"&&n<0||s!==void 0&&wo(Number(s)))return!1;
 *     if(typeof n==="string"&&ca.has(n))return!0;
 *     let h=e.message;
 *     return As.some(y=>h.includes(y))||h.includes("Body Timeout Error")||
 *       /\bterminated\b/.test(h)||h.includes("SSE stream disconnected")||
 *       h.includes("Failed to reconnect SSE stream")}
 *
 * The old OCC classifier (`isTerminalConnectionError`) matched on substrings
 * only, so a SERVER error reply whose text merely mentioned e.g. "ECONNRESET"
 * (or a JSON-RPC error carrying a numeric `code`/`status`) was misread as a
 * dropped connection. The 295 classifier checks numeric codes/statuses first
 * (protocol/HTTP errors are never network errors — including negative
 * JSON-RPC codes like ListPaginationExceeded) and only then falls back to the
 * string-code Set and message substrings.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { errorMessage } from '../../utils/errors.js'
import { logMCPDebug } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

// ---------------------------------------------------------------------------
// Error classification (official `ua` / `wo` / `As` / `ca` / `da`)
// ---------------------------------------------------------------------------

/** Official `As`: message substrings that identify a network-level failure. */
const NETWORK_ERROR_SUBSTRINGS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ECONNREFUSED',
]

/**
 * Official `ca`: the substring list plus string error `code` values that also
 * classify as network errors.
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  ...NETWORK_ERROR_SUBSTRINGS,
  'ConnectionRefused',
  'ConnectionClosed',
])

/** Official `da`: SDK HTTP-POST failure whose message embeds the status. */
const HTTP_POST_ERROR_PATTERN = /^Error POSTing to endpoint \(HTTP (\d+)\)/

/** Official `wo`: true for plausible HTTP status codes. */
function isHttpStatusCode(value: unknown): boolean {
  return typeof value === 'number' && value >= 100 && value <= 599
}

function readErrorField(error: unknown, field: 'code' | 'status'): unknown {
  return error !== null && typeof error === 'object' && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined
}

/**
 * Official 2.1.295 network-error classifier (`ua`/`Ir`). True when the error
 * represents a network/transport-level failure (connection reset, timeout,
 * SSE drop, abort) rather than a protocol- or server-level error reply.
 *
 * Numeric `code`/`status` fields always win over message text: a server
 * error reply that mentions "ECONNRESET" in its message is NOT a network
 * error, and negative JSON-RPC codes (ConnectionClosed -32000,
 * RequestTimeout -32001, ListPaginationExceeded -32002 in newer SDKs) are
 * NOT network errors either.
 */
export function isNetworkError(error: unknown): boolean {
  const err = error as
    | { name?: string; message?: string; code?: unknown; status?: unknown }
    | null
    | undefined
  if (err?.name === 'AbortError') return true

  const message = typeof err?.message === 'string' ? err.message : ''
  const code = readErrorField(error, 'code')
  const status = readErrorField(error, 'status')
  const httpPostStatus = HTTP_POST_ERROR_PATTERN.exec(message)?.[1]

  if (
    isHttpStatusCode(status) ||
    isHttpStatusCode(code) ||
    (typeof code === 'number' && code < 0) ||
    (httpPostStatus !== undefined && isHttpStatusCode(Number(httpPostStatus)))
  ) {
    return false
  }

  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true

  return (
    NETWORK_ERROR_SUBSTRINGS.some(c => message.includes(c)) ||
    message.includes('Body Timeout Error') ||
    /\bterminated\b/.test(message) ||
    message.includes('SSE stream disconnected') ||
    message.includes('Failed to reconnect SSE stream')
  )
}

/**
 * Official 2.1.295 SDK error codes that the list-retry gate (`jn`/`Lr`)
 * treats as non-retryable but OCC's SDK (1.29.0) does not export yet.
 * Values verified byte-exact in the official bundle:
 *   ListPaginationExceeded=-32002, MissingRequiredClientCapability=-32021,
 *   UnsupportedProtocolVersion=-32022.
 */
const MCP_ERROR_CODE_LIST_PAGINATION_EXCEEDED = -32002
const MCP_ERROR_CODE_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021
const MCP_ERROR_CODE_UNSUPPORTED_PROTOCOL_VERSION = -32022

const NON_RETRYABLE_MCP_ERROR_CODES: ReadonlySet<number> = new Set([
  ErrorCode.RequestTimeout,
  ErrorCode.MethodNotFound,
  ErrorCode.InvalidRequest,
  ErrorCode.InvalidParams,
  MCP_ERROR_CODE_LIST_PAGINATION_EXCEEDED,
  MCP_ERROR_CODE_MISSING_REQUIRED_CLIENT_CAPABILITY,
  MCP_ERROR_CODE_UNSUPPORTED_PROTOCOL_VERSION,
])

/**
 * Retry gate for paginated list requests, ported from the official
 * `jn`/`Lr` classifier restricted to the error classes OCC's SDK exposes:
 *
 * - McpError: retryable EXCEPT the non-retryable protocol codes above.
 *   Notably ConnectionClosed (-32000) IS retryable — the transport dropped
 *   mid-list and a redial can succeed. ListPaginationExceeded is NOT.
 * - DOMException "TimeoutError": not retryable (official has this branch).
 * - AbortError: not retryable — an interrupt (Esc) must end the turn
 *   promptly, never trigger background retries. (The official excludes user
 *   aborts from retry via its internal abort-error classes.)
 * - Everything else: retry only when it classifies as a network error.
 */
export function isRetryableListError(error: unknown): boolean {
  if (error instanceof McpError) {
    return !NON_RETRYABLE_MCP_ERROR_CODES.has(error.code)
  }
  if (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'TimeoutError'
  ) {
    return false
  }
  if (error instanceof Error && error.name === 'AbortError') return false
  return isNetworkError(error)
}

/**
 * Official `Vn`: after the transport has been torn down (`client.transport`
 * is undefined) retrying is pointless — the request can never be sent.
 */
function isTransportGone(client: Client): boolean {
  return (
    'transport' in client &&
    (client as unknown as { transport?: unknown }).transport === undefined
  )
}

// ---------------------------------------------------------------------------
// Paginated list walker (official `Qn`/`Kn`; second copy `Nt`/`_o`)
// ---------------------------------------------------------------------------

/** Official `rs`: hard page cap for a single cursor walk. */
export const MAX_LIST_PAGES = 20

/** Official `Os`: per-attempt retry delays (initial try + 3 retries). */
const LIST_RETRY_DELAYS_MS = [250, 500, 1000]

type ListRequestArg = Parameters<Client['request']>[0]
type ListResultSchema = Parameters<Client['request']>[1]
type ListRequestOptions = Parameters<Client['request']>[2]

/** Official `Kn`: tengu_mcp_list_paginated telemetry emitter. */
export function logListPaginatedTelemetry(
  method: string,
  pageCount: number | undefined,
  itemCount: number,
  outcome: string,
  source = 'pages',
): void {
  logEvent('tengu_mcp_list_paginated', {
    // Fixed protocol strings (method names / outcome / source enums), never
    // user data — verified not code or filepaths.
    method:
      method as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    pageCount,
    itemCount,
    outcome:
      outcome as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    source:
      source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * Official 2.1.295 paginated list walker (`Qn`). Walks a cursor-paginated
 * MCP list method with three protections the unguarded do-while loops lacked:
 *
 * 1. Repeated-cursor detection — a nextCursor already sent in this walk
 *    stops the loop ("repeated_cursor").
 * 2. Page cap — at most MAX_LIST_PAGES (20) pages per walk ("capped").
 * 3. Bounded retry — transient failures retry with the official
 *    [250, 500, 1000]ms delays, gated by isRetryableListError and the
 *    transport-gone check; anything else propagates.
 *
 * Multi-page walks emit `tengu_mcp_list_paginated` telemetry (field name
 * `outcome`, byte-exact from the binary) and the official log lines via the
 * MCP debug log.
 */
export async function walkPaginatedList(
  client: Client,
  serverName: string,
  method: string,
  resultSchema: ListResultSchema,
  extractItems: (
    result: Record<string, unknown>,
  ) => readonly unknown[] | undefined,
  requestOptions?: ListRequestOptions,
): Promise<unknown[]> {
  let errorTelemetryLogged = false

  for (let attempt = 0; ; attempt++) {
    const items: unknown[] = []
    const sentCursors = new Set<string>()
    let cursor: string | undefined
    let pageCount = 0
    let stopReason: 'repeated_cursor' | 'capped' | undefined

    try {
      do {
        const result = (await client.request(
          {
            method,
            ...(cursor ? { params: { cursor } } : {}),
          } as unknown as ListRequestArg,
          resultSchema,
          requestOptions,
        )) as Record<string, unknown> & { nextCursor?: string }
        pageCount++

        const pageItems = extractItems(result)
        if (pageItems) items.push(...pageItems)

        if (cursor) sentCursors.add(cursor)
        cursor = result.nextCursor
        if (cursor && sentCursors.has(cursor)) {
          stopReason = 'repeated_cursor'
          break
        }
        if (cursor && pageCount >= MAX_LIST_PAGES) {
          stopReason = 'capped'
          break
        }
      } while (cursor)

      if (stopReason === 'repeated_cursor') {
        logMCPDebug(
          serverName,
          `${method} returned a nextCursor already sent in this walk (page ${pageCount}); stopping`,
        )
      }
      if (stopReason === 'capped') {
        logMCPDebug(
          serverName,
          `${method} still returning nextCursor after ${MAX_LIST_PAGES} pages; stopping`,
        )
      }
      if (pageCount > 1) {
        logListPaginatedTelemetry(
          method,
          pageCount,
          items.length,
          stopReason ?? 'complete',
        )
      }
      return items
    } catch (error) {
      if (pageCount > 0 && !errorTelemetryLogged) {
        errorTelemetryLogged = true
        logListPaginatedTelemetry(method, pageCount, items.length, 'error')
      }
      const delayMs = LIST_RETRY_DELAYS_MS[attempt]
      if (
        delayMs === undefined ||
        !isRetryableListError(error) ||
        isTransportGone(client)
      ) {
        throw error
      }
      logMCPDebug(
        serverName,
        `${method} failed (${errorMessage(error)}); retrying in ${delayMs}ms`,
      )
      await sleep(delayMs)
      if (isTransportGone(client)) throw error
    }
  }
}
