/**
 * claude-code 2.1.295 (items 1 + 2) — listPagination.ts contract tests.
 *
 * Pins the official binary behavior reverse-engineered from the 2.1.295
 * bundle (`ua`/`Ir` network classifier, `ca` string-code Set, `wo` HTTP-status
 * guard, `Qn`/`Kn` paginated walker + tengu_mcp_list_paginated telemetry):
 *
 *   - Numeric `code`/`status` fields (HTTP statuses, JSON-RPC codes —
 *     including negative codes like ListPaginationExceeded -32002) are NEVER
 *     network errors, even when the message text mentions "ECONNRESET".
 *   - String `code` values in the official Set ARE network errors.
 *   - The walker stops on a repeated cursor ("repeated_cursor") and at the
 *     20-page cap ("capped"), logs the official lines, and emits
 *     tengu_mcp_list_paginated with field name `outcome`.
 *   - Transient failures retry with the official [250, 500, 1000]ms delays;
 *     non-retryable errors (InvalidParams, AbortError, DOMException
 *     TimeoutError, HTTP statuses) propagate immediately; a torn-down
 *     transport (`client.transport === undefined`, official `Vn`) never
 *     retries.
 *
 * Repo mock.module template (mcpOAuthTransientSkip281.test.ts): snapshot
 * actuals BEFORE mocking, dynamic-import the module under test AFTER
 * registration, heal the seam + restore in afterAll — bun's mock.module is
 * process-global and mock.restore() does NOT heal already-resolved bindings.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

// Capture the real modules BEFORE mocking (spread snapshots — bare import
// namespaces have LIVE bindings that mock.module patches).
const realAnalytics = { ...(await import('../../analytics/index.js')) }
const realSleep = { ...(await import('../../../utils/sleep.js')) }
const realLog = { ...(await import('../../../utils/log.js')) }

let loggedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []
let loggedMcpDebug: Array<{ server: string; message: string }> = []
let sleepCalls: number[] = []
// Passthrough flag: with this off (afterAll) every seam delegates to the REAL
// implementation, so leaked closures stay behavior-neutral for later files
// in the shared test process.
let paginationMocksActive = true
const actualLogEvent = realAnalytics.logEvent as (
  name: string,
  metadata: Record<string, unknown>,
) => void

mock.module('../../analytics/index.js', () => ({
  ...realAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    if (paginationMocksActive) {
      loggedEvents.push({ name, metadata })
    } else {
      actualLogEvent(name, metadata)
    }
  },
}))

mock.module('../../../utils/sleep.js', () => ({
  ...realSleep,
  sleep: (
    ms: number,
    signal?: AbortSignal,
    options?: Parameters<typeof realSleep.sleep>[2],
  ) => {
    if (paginationMocksActive) {
      sleepCalls.push(ms)
      return Promise.resolve()
    }
    return realSleep.sleep(ms, signal, options)
  },
}))

mock.module('../../../utils/log.js', () => ({
  ...realLog,
  logMCPDebug: (server: string, message: string) => {
    if (paginationMocksActive) {
      loggedMcpDebug.push({ server, message })
    } else {
      realLog.logMCPDebug(server, message)
    }
  },
}))

// Import the target AFTER the mocks are registered so listPagination.ts
// binds the fakes.
const { MAX_LIST_PAGES, isNetworkError, isRetryableListError, walkPaginatedList } =
  await import('../listPagination.js')

afterAll(() => {
  paginationMocksActive = false
  // Heal the seams: point them at the REAL implementations so any leaked
  // bindings stay behavior-neutral for other test files in this process.
  mock.module('../../analytics/index.js', () => realAnalytics)
  mock.module('../../../utils/sleep.js', () => realSleep)
  mock.module('../../../utils/log.js', () => realLog)
})

beforeEach(() => {
  loggedEvents = []
  loggedMcpDebug = []
  sleepCalls = []
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorWithFields(
  message: string,
  fields: Record<string, unknown>,
): Error {
  return Object.assign(new Error(message), fields)
}

function makeFakeClient(
  responder: (
    callIndex: number,
    cursor: string | undefined,
  ) => unknown | Promise<unknown>,
) {
  const requests: Array<{ method: string; cursor: string | undefined }> = []
  const fake = {
    transport: {} as unknown,
    async request(req: { method: string; params?: { cursor?: string } }) {
      requests.push({ method: req.method, cursor: req.params?.cursor })
      return responder(requests.length - 1, req.params?.cursor)
    },
  }
  return { client: fake as unknown as Client, requests, fake }
}

function paginatedTelemetry(): Array<Record<string, unknown>> {
  return loggedEvents
    .filter(e => e.name === 'tengu_mcp_list_paginated')
    .map(e => e.metadata)
}

const fakeSchema = {} as never
const extractItems = (result: Record<string, unknown>) =>
  (result.items ?? undefined) as readonly unknown[] | undefined

// ---------------------------------------------------------------------------
// isNetworkError — official `ua` classifier
// ---------------------------------------------------------------------------

describe('2.1.295 isNetworkError (official ua classifier)', () => {
  test('classifies AbortError as a network error', () => {
    // Arrange
    const error = errorWithFields('The operation was aborted', {
      name: 'AbortError',
    })

    // Act & Assert
    expect(isNetworkError(error)).toBe(true)
  })

  test('does not classify HTTP status errors as network errors even when the message mentions ECONNRESET', () => {
    // Arrange
    const badGateway = errorWithFields('upstream failed', { status: 502 })
    const unavailable = errorWithFields('ECONNRESET reported by server', {
      status: 503,
    })

    // Act & Assert — the numeric status wins over the message text
    expect(isNetworkError(badGateway)).toBe(false)
    expect(isNetworkError(unavailable)).toBe(false)
  })

  test('does not classify a numeric code error as a network error even when the message mentions ECONNRESET', () => {
    // Arrange — a SERVER error reply whose text merely name-drops a network
    // error must not drop the connection (the pre-295 substring bug)
    const error = errorWithFields('server hit ECONNRESET talking to upstream', {
      code: 500,
    })

    // Act & Assert
    expect(isNetworkError(error)).toBe(false)
  })

  test('does not classify McpError protocol replies as network errors', () => {
    // Arrange
    const connectionClosed = new McpError(
      ErrorCode.ConnectionClosed,
      'Connection closed',
    )
    const internal = new McpError(
      ErrorCode.InternalError,
      'server hit ECONNRESET while proxying',
    )

    // Act & Assert — negative JSON-RPC codes are never network errors
    expect(isNetworkError(connectionClosed)).toBe(false)
    expect(isNetworkError(internal)).toBe(false)
  })

  test('does not classify ListPaginationExceeded (-32002) as a network error', () => {
    // Arrange
    const exceeded = new McpError(-32002, 'ListPaginationExceeded')

    // Act & Assert
    expect(isNetworkError(exceeded)).toBe(false)
  })

  test('classifies every string code in the official Set as a network error and others as not', () => {
    // Arrange — official `ca` Set
    const networkCodes = [
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'EHOSTUNREACH',
      'ECONNREFUSED',
      'ConnectionRefused',
      'ConnectionClosed',
    ]

    // Act & Assert
    for (const code of networkCodes) {
      expect(isNetworkError(errorWithFields('failure', { code }))).toBe(true)
    }
    expect(isNetworkError(errorWithFields('failure', { code: 'ENOENT' }))).toBe(
      false,
    )
  })

  test('does not classify the SDK HTTP-POST error as a network error', () => {
    // Arrange — official `da` regex extracts the embedded HTTP status
    const error = new Error('Error POSTing to endpoint (HTTP 502)')

    // Act & Assert
    expect(isNetworkError(error)).toBe(false)
  })

  test('classifies official message substrings as network errors', () => {
    // Arrange & Act & Assert — official `As` substrings + extras
    expect(isNetworkError(new Error('read ECONNRESET 10.0.0.1:443'))).toBe(true)
    expect(isNetworkError(new Error('Body Timeout Error'))).toBe(true)
    expect(isNetworkError(new Error('The connection was terminated'))).toBe(
      true,
    )
    expect(isNetworkError(new Error('SSE stream disconnected'))).toBe(true)
    expect(isNetworkError(new Error('Failed to reconnect SSE stream'))).toBe(
      true,
    )
    expect(isNetworkError(new Error('some other failure'))).toBe(false)
  })

  test('matches terminated only on a word boundary', () => {
    // Arrange — official uses /\bterminated\b/, not includes('terminated')
    const error = new Error('unterminated string in JSON payload')

    // Act & Assert
    expect(isNetworkError(error)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isRetryableListError — official `jn`/`Lr` retry gate (OCC-restricted)
// ---------------------------------------------------------------------------

describe('2.1.295 isRetryableListError (official jn retry gate)', () => {
  test('retries McpError ConnectionClosed — the transport dropped mid-list', () => {
    // Arrange
    const error = new McpError(ErrorCode.ConnectionClosed, 'Connection closed')

    // Act & Assert
    expect(isRetryableListError(error)).toBe(true)
  })

  test('does not retry the non-retryable protocol error codes', () => {
    // Arrange — official non-retryable Set, incl. the 295 codes OCC's SDK
    // (1.29.0) does not export yet
    const nonRetryableCodes = [
      ErrorCode.RequestTimeout,
      ErrorCode.MethodNotFound,
      ErrorCode.InvalidRequest,
      ErrorCode.InvalidParams,
      -32002, // ListPaginationExceeded
      -32021, // MissingRequiredClientCapability
      -32022, // UnsupportedProtocolVersion
    ]

    // Act & Assert
    for (const code of nonRetryableCodes) {
      expect(isRetryableListError(new McpError(code, 'protocol error'))).toBe(
        false,
      )
    }
  })

  test('retries plain errors with a network string code', () => {
    // Arrange
    const error = errorWithFields('socket hang up', { code: 'ECONNRESET' })

    // Act & Assert
    expect(isRetryableListError(error)).toBe(true)
  })

  test('does not retry AbortError — an interrupt must end the turn promptly', () => {
    // Arrange
    const error = errorWithFields('The operation was aborted', {
      name: 'AbortError',
    })

    // Act & Assert
    expect(isRetryableListError(error)).toBe(false)
  })

  test('does not retry DOMException TimeoutError', () => {
    // Arrange
    const error = new DOMException('The operation timed out.', 'TimeoutError')

    // Act & Assert
    expect(isRetryableListError(error)).toBe(false)
  })

  test('does not retry errors carrying an HTTP status', () => {
    // Arrange
    const error = errorWithFields('Not Found', { status: 404 })

    // Act & Assert
    expect(isRetryableListError(error)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// walkPaginatedList — official `Qn` walker
// ---------------------------------------------------------------------------

describe('2.1.295 walkPaginatedList (official Qn walker)', () => {
  test('stops when the server returns a nextCursor already sent in this walk', async () => {
    // Arrange — server loops on cursor 'A' forever
    const { client, requests } = makeFakeClient(callIndex => ({
      items: [`item-${callIndex}`],
      nextCursor: 'A',
    }))

    // Act
    const items = await walkPaginatedList(
      client,
      'loop-server',
      'resources/list',
      fakeSchema,
      extractItems,
    )

    // Assert
    expect(requests).toEqual([
      { method: 'resources/list', cursor: undefined },
      { method: 'resources/list', cursor: 'A' },
    ])
    expect(items).toEqual(['item-0', 'item-1'])
    expect(loggedMcpDebug).toContainEqual({
      server: 'loop-server',
      message:
        'resources/list returned a nextCursor already sent in this walk (page 2); stopping',
    })
    expect(paginatedTelemetry()).toEqual([
      {
        method: 'resources/list',
        pageCount: 2,
        itemCount: 2,
        outcome: 'repeated_cursor',
        source: 'pages',
      },
    ])
  })

  test('stops at the 20-page cap when the server keeps returning fresh cursors', async () => {
    // Arrange
    const { client, requests } = makeFakeClient(callIndex => ({
      items: [`item-${callIndex}`],
      nextCursor: `cursor-${callIndex + 1}`,
    }))

    // Act
    const items = await walkPaginatedList(
      client,
      'endless-server',
      'prompts/list',
      fakeSchema,
      extractItems,
    )

    // Assert
    expect(MAX_LIST_PAGES).toBe(20)
    expect(requests).toHaveLength(20)
    expect(items).toHaveLength(20)
    expect(loggedMcpDebug).toContainEqual({
      server: 'endless-server',
      message:
        'prompts/list still returning nextCursor after 20 pages; stopping',
    })
    expect(paginatedTelemetry()).toEqual([
      {
        method: 'prompts/list',
        pageCount: 20,
        itemCount: 20,
        outcome: 'capped',
        source: 'pages',
      },
    ])
  })

  test('emits no telemetry for a single-page walk', async () => {
    // Arrange
    const { client, requests } = makeFakeClient(() => ({ items: ['only'] }))

    // Act
    const items = await walkPaginatedList(
      client,
      'single-server',
      'tools/list',
      fakeSchema,
      extractItems,
    )

    // Assert
    expect(items).toEqual(['only'])
    expect(requests).toHaveLength(1)
    expect(paginatedTelemetry()).toHaveLength(0)
  })

  test('emits outcome complete for a normal multi-page walk', async () => {
    // Arrange
    const { client } = makeFakeClient((_callIndex, cursor) =>
      cursor === undefined
        ? { items: ['a'], nextCursor: 'x' }
        : { items: ['b'] },
    )

    // Act
    const items = await walkPaginatedList(
      client,
      'two-page-server',
      'tools/list',
      fakeSchema,
      extractItems,
    )

    // Assert
    expect(items).toEqual(['a', 'b'])
    expect(paginatedTelemetry()).toEqual([
      {
        method: 'tools/list',
        pageCount: 2,
        itemCount: 2,
        outcome: 'complete',
        source: 'pages',
      },
    ])
  })

  test('retries a transient network failure with the official 250ms first delay and succeeds', async () => {
    // Arrange — first call throws a network error, second succeeds
    const { client } = makeFakeClient(callIndex => {
      if (callIndex === 0) {
        throw errorWithFields('socket hang up', { code: 'ECONNRESET' })
      }
      return { items: ['ok'] }
    })

    // Act
    const items = await walkPaginatedList(
      client,
      'flaky-server',
      'tools/list',
      fakeSchema,
      extractItems,
    )

    // Assert
    expect(items).toEqual(['ok'])
    expect(sleepCalls).toEqual([250])
    expect(loggedMcpDebug).toContainEqual({
      server: 'flaky-server',
      message: 'tools/list failed (socket hang up); retrying in 250ms',
    })
    // First attempt failed before any page completed → no telemetry
    expect(paginatedTelemetry()).toHaveLength(0)
  })

  test('propagates a non-retryable InvalidParams McpError without retrying', async () => {
    // Arrange
    const { client, requests } = makeFakeClient(() => {
      throw new McpError(ErrorCode.InvalidParams, 'bad cursor')
    })

    // Act & Assert
    await expect(
      walkPaginatedList(
        client,
        'invalid-server',
        'resources/list',
        fakeSchema,
        extractItems,
      ),
    ).rejects.toThrow('bad cursor')
    expect(requests).toHaveLength(1)
    expect(sleepCalls).toHaveLength(0)
    expect(paginatedTelemetry()).toHaveLength(0)
  })

  test('exhausts the official [250, 500, 1000]ms retry schedule then rejects', async () => {
    // Arrange — every call throws a retryable network error
    const { client, requests } = makeFakeClient(() => {
      throw errorWithFields('read ECONNRESET', { code: 'ECONNRESET' })
    })

    // Act & Assert
    await expect(
      walkPaginatedList(
        client,
        'down-server',
        'resources/list',
        fakeSchema,
        extractItems,
      ),
    ).rejects.toThrow('read ECONNRESET')
    expect(requests).toHaveLength(4) // initial try + 3 retries
    expect(sleepCalls).toEqual([250, 500, 1000])
  })

  test('emits exactly one error telemetry when a mid-walk failure never recovers', async () => {
    // Arrange — only the very first call succeeds; everything after throws
    const { client, requests } = makeFakeClient(callIndex => {
      if (callIndex === 0) {
        return { items: ['page-1-item'], nextCursor: 'B' }
      }
      throw errorWithFields('read ECONNRESET', { code: 'ECONNRESET' })
    })

    // Act & Assert
    await expect(
      walkPaginatedList(
        client,
        'half-dead-server',
        'resources/list',
        fakeSchema,
        extractItems,
      ),
    ).rejects.toThrow('read ECONNRESET')
    expect(requests).toHaveLength(5) // page1 + throw, then 3 retry rounds each throwing on page 1
    expect(sleepCalls).toEqual([250, 500, 1000])
    expect(paginatedTelemetry()).toEqual([
      {
        method: 'resources/list',
        pageCount: 1,
        itemCount: 1,
        outcome: 'error',
        source: 'pages',
      },
    ])
  })

  test('never retries once the transport has been torn down', async () => {
    // Arrange — the request itself tears the transport down (official `Vn`)
    const { client, requests, fake } = makeFakeClient(() => {
      fake.transport = undefined
      throw errorWithFields('read ECONNRESET', { code: 'ECONNRESET' })
    })

    // Act & Assert
    await expect(
      walkPaginatedList(
        client,
        'torn-server',
        'resources/list',
        fakeSchema,
        extractItems,
      ),
    ).rejects.toThrow('read ECONNRESET')
    expect(requests).toHaveLength(1)
    expect(sleepCalls).toHaveLength(0)
  })
})
