/**
 * CC 2.1.295 (item 5) — ListMcpResourcesTool abortability.
 *
 * Binary evidence (official tool `kK`, verbatim from s295):
 *
 *   create(e){return{async call(s,{signal:m}){...
 *     C=()=>f.ensureConnectedClient(i,{signal:m,context:"MC...
 *
 * The official call destructures the turn's AbortSignal and threads it into
 * ensureConnectedClient and the resources/list walk, so cancelling the turn
 * interrupts an in-flight listing. OCC's client helpers take no signal
 * parameter, so ListMcpResourcesTool races the signal via raceAbort() and —
 * crucially — the per-server catch rethrows aborts (isAbortError) instead of
 * swallowing them into a partial `[]` result.
 *
 * Repo mock.module template (mcpOAuthTransientSkip281.test.ts): snapshot
 * actuals BEFORE mocking, dynamic-import the module under test AFTER
 * registration with a cache-busting specifier, passthrough flags + restore
 * actuals in afterAll (bun's mock.module is process-global, OCC-97).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Capture the real modules BEFORE mocking (spread snapshots — bare import
// namespaces have LIVE bindings that mock.module patches).
const realMcpClient = { ...(await import('../../../services/mcp/client.js')) }
const realLog = { ...(await import('../../../utils/log.js')) }

// Per-test controllable seams.
let mcpAbortMocksActive = true
type AnyClient = { type: string; name: string }
let ensureCalls: AnyClient[] = []
let fetchCalls: AnyClient[] = []
let loggedMcpErrors: Array<{ server: string; message: string }> = []
let ensureImpl: (client: AnyClient) => Promise<unknown> = async client => client
let fetchImpl: (client: AnyClient) => Promise<unknown[]> = async () => []

const actualEnsureConnectedClient = realMcpClient.ensureConnectedClient as (
  client: never,
) => Promise<unknown>
const actualFetchResourcesForClient = realMcpClient.fetchResourcesForClient as (
  client: never,
) => Promise<unknown[]>
const actualLogMCPError = realLog.logMCPError as (
  server: string,
  message: string,
) => void

mock.module('../../../services/mcp/client.js', () => ({
  ...realMcpClient,
  ensureConnectedClient: (client: AnyClient) => {
    if (!mcpAbortMocksActive) {
      return actualEnsureConnectedClient(client as never)
    }
    ensureCalls.push(client)
    return ensureImpl(client)
  },
  fetchResourcesForClient: (client: AnyClient) => {
    if (!mcpAbortMocksActive) {
      return actualFetchResourcesForClient(client as never)
    }
    fetchCalls.push(client)
    return fetchImpl(client)
  },
}))

mock.module('../../../utils/log.js', () => ({
  ...realLog,
  logMCPError: (server: string, message: string) => {
    if (mcpAbortMocksActive) {
      loggedMcpErrors.push({ server, message })
    } else {
      actualLogMCPError(server, message)
    }
  },
}))

// Import the target AFTER the mocks are registered so ListMcpResourcesTool
// binds the fakes. Cache-busting specifier: an isolated instance bound to
// THIS file's mocks.
const ISOLATED_SPECIFIER = '../ListMcpResourcesTool.js?occ-list-mcp-abort-295'
const { ListMcpResourcesTool } = (await import(
  ISOLATED_SPECIFIER
)) as typeof import('../ListMcpResourcesTool.js')

afterAll(() => {
  mcpAbortMocksActive = false
  // Restore the real modules for any other test file in this worker (OCC-97).
  mock.module('../../../services/mcp/client.js', () => realMcpClient)
  mock.module('../../../utils/log.js', () => realLog)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(name: string): AnyClient {
  return { type: 'connected', name }
}

type CallContext = Parameters<typeof ListMcpResourcesTool.call>[1]

function makeContext(
  clients: AnyClient[],
  abortController: AbortController,
): CallContext {
  return {
    options: { mcpClients: clients },
    abortController,
  } as unknown as CallContext
}

const RESOURCE = {
  uri: 'file:///notes.txt',
  name: 'notes.txt',
  mimeType: 'text/plain',
  server: 'srv-a',
}

beforeEach(() => {
  ensureCalls = []
  fetchCalls = []
  loggedMcpErrors = []
  ensureImpl = async client => client
  fetchImpl = async () => []
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ListMcpResourcesTool abortable resources/list (2.1.295)', () => {
  test('resolves resources normally when the turn is not aborted', async () => {
    // Arrange
    const abortController = new AbortController()
    fetchImpl = async () => [RESOURCE]

    // Act
    const result = await ListMcpResourcesTool.call(
      {},
      makeContext([makeClient('srv-a')], abortController),
    )

    // Assert
    expect(result.data).toEqual([RESOURCE])
    expect(fetchCalls).toHaveLength(1)
    expect(loggedMcpErrors).toHaveLength(0)
  })

  test('rejects with AbortError on a pre-aborted signal and never fetches resources', async () => {
    // Arrange
    const abortController = new AbortController()
    abortController.abort()

    // Act + Assert
    const call = ListMcpResourcesTool.call(
      {},
      makeContext([makeClient('srv-a')], abortController),
    )
    await expect(call).rejects.toThrow()
    await call.catch(error => {
      expect((error as Error).name).toBe('AbortError')
    })
    // The resources/list request never starts after an up-front abort.
    expect(fetchCalls).toHaveLength(0)
    // An abort is NOT logged as a per-server MCP error.
    expect(loggedMcpErrors).toHaveLength(0)
  })

  test('rejects with AbortError when the turn is cancelled mid-reconnect', async () => {
    // Arrange — ensureConnectedClient stays pending until after the abort
    const abortController = new AbortController()
    let resolveEnsure: (value: unknown) => void = () => {}
    ensureImpl = () =>
      new Promise(resolve => {
        resolveEnsure = resolve
      })

    // Act
    const call = ListMcpResourcesTool.call(
      {},
      makeContext([makeClient('srv-a')], abortController),
    )
    await Promise.resolve()
    abortController.abort()
    resolveEnsure(makeClient('srv-a'))

    // Assert
    await expect(call).rejects.toThrow()
    await call.catch(error => {
      expect((error as Error).name).toBe('AbortError')
    })
    expect(fetchCalls).toHaveLength(0)
  })

  test('an AbortError from the resources/list fetch escapes the per-server catch', async () => {
    // Arrange — the fetch itself rejects with an abort (shared AbortError)
    const abortController = new AbortController()
    fetchImpl = async () => {
      const { AbortError } = await import('../../../utils/errors.js')
      throw new AbortError()
    }

    // Act
    const call = ListMcpResourcesTool.call(
      {},
      makeContext([makeClient('srv-a')], abortController),
    )

    // Assert — aborts surface instead of degrading to a partial [] result
    await expect(call).rejects.toThrow()
    await call.catch(error => {
      expect((error as Error).name).toBe('AbortError')
    })
    expect(loggedMcpErrors).toHaveLength(0)
  })

  test('a non-abort server failure is still swallowed into an empty list', async () => {
    // Arrange — reconnect fails with a plain error (pre-295 behavior kept)
    const abortController = new AbortController()
    ensureImpl = async () => {
      throw new Error('reconnect failed')
    }

    // Act
    const result = await ListMcpResourcesTool.call(
      {},
      makeContext([makeClient('srv-a')], abortController),
    )

    // Assert
    expect(result.data).toEqual([])
    expect(loggedMcpErrors).toHaveLength(1)
    expect(loggedMcpErrors[0]?.server).toBe('srv-a')
    expect(loggedMcpErrors[0]?.message).toContain('reconnect failed')
  })

  test('an abort on one server rejects the whole call even when another server succeeds', async () => {
    // Arrange — srv-a succeeds, srv-b's fetch aborts (Promise.all semantics)
    const abortController = new AbortController()
    fetchImpl = async client => {
      if (client.name === 'srv-b') {
        const { AbortError } = await import('../../../utils/errors.js')
        throw new AbortError()
      }
      return [RESOURCE]
    }

    // Act
    const call = ListMcpResourcesTool.call(
      {},
      makeContext([makeClient('srv-a'), makeClient('srv-b')], abortController),
    )

    // Assert
    await expect(call).rejects.toThrow()
    await call.catch(error => {
      expect((error as Error).name).toBe('AbortError')
    })
  })
})
