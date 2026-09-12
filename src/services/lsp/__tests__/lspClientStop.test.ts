import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

/**
 * Official 2.1.269 (E25): LSP `exit` notification is sent even if the
 * `shutdown` request fails.
 *
 * Binary evidence (s269 @27390521):
 *   `let ee;try{await E.sendRequest("shutdown")}catch(se){ee=se}`
 *   `try{await E.sendNotification("exit")}catch(se){throw ee??se}`
 *   `if(ee!==void 0)throw ee`
 *
 * 2.1.268 awaited both inside a single try — a shutdown rejection skipped
 * the exit notification, leaving the server waiting for an `exit` that
 * never arrives. When BOTH fail, the shutdown error wins (`ee??se`).
 */

const callOrder: string[] = []

const mockConnection = {
  sendRequest: mock(async (_method: string, _params?: unknown) => null),
  sendNotification: mock(async (_method: string, _params?: unknown) => {}),
  onError: mock((_handler: unknown) => {}),
  onClose: mock((_handler: unknown) => {}),
  onNotification: mock((_method: string, _handler: unknown) => {}),
  onRequest: mock((_method: string, _handler: unknown) => {}),
  listen: mock(() => {}),
  trace: mock(async () => {}),
  dispose: mock(() => {}),
}

// Record call order on top of the per-test implementations.
const recordingSendRequest = async (
  method: string,
  impl: (method: string) => Promise<unknown>,
): Promise<unknown> => {
  callOrder.push(`request:${method}`)
  return impl(method)
}

mock.module('vscode-jsonrpc/node.js', () => ({
  createMessageConnection: () => mockConnection,
  StreamMessageReader: class {
    constructor(_stream: unknown) {}
  },
  StreamMessageWriter: class {
    constructor(_stream: unknown) {}
  },
  Trace: { Verbose: 'verbose' },
}))

const { createLSPClient } = await import('../LSPClient.js')

let client: ReturnType<typeof createLSPClient>

beforeAll(async () => {
  client = createLSPClient('test-server')
})

afterAll(() => {
  mock.restore()
})

afterEach(() => {
  callOrder.length = 0
  mockConnection.sendRequest.mockClear()
  mockConnection.sendNotification.mockClear()
  mockConnection.dispose.mockClear()
})

/** start() spawns a real, harmless `sleep` process; the rpc layer is mocked. */
async function startClient(): Promise<void> {
  await client.start('sleep', ['30'])
}

describe('LSPClient.stop (Official 2.1.269 E25)', () => {
  test('sends exit after a successful shutdown and resolves', async () => {
    await startClient()
    mockConnection.sendRequest.mockImplementation(async method =>
      recordingSendRequest(method, async () => null),
    )
    mockConnection.sendNotification.mockImplementation(async method => {
      callOrder.push(`notification:${method}`)
    })

    await expect(client.stop()).resolves.toBeUndefined()
    expect(mockConnection.sendRequest).toHaveBeenCalledWith('shutdown', {})
    expect(mockConnection.sendNotification).toHaveBeenCalledWith('exit', {})
    expect(callOrder).toEqual(['request:shutdown', 'notification:exit'])
  })

  test('sends exit even when shutdown rejects, and surfaces the shutdown error', async () => {
    await startClient()
    const shutdownError = new Error('shutdown rejected')
    mockConnection.sendRequest.mockImplementation(async method =>
      recordingSendRequest(method, async () => {
        throw shutdownError
      }),
    )
    mockConnection.sendNotification.mockImplementation(async method => {
      callOrder.push(`notification:${method}`)
    })

    await expect(client.stop()).rejects.toBe(shutdownError)
    // The core E25 assertion: exit was still sent.
    expect(mockConnection.sendNotification).toHaveBeenCalledWith('exit', {})
    expect(callOrder).toEqual(['request:shutdown', 'notification:exit'])
    // Cleanup still ran (finally block preserved).
    expect(mockConnection.dispose).toHaveBeenCalled()
  })

  test('surfaces the exit error when shutdown succeeded but exit rejects', async () => {
    await startClient()
    const exitError = new Error('exit rejected')
    mockConnection.sendRequest.mockImplementation(async method =>
      recordingSendRequest(method, async () => null),
    )
    mockConnection.sendNotification.mockImplementation(async () => {
      throw exitError
    })

    // Official `throw ee??se` — ee (shutdown) undefined → throw se (exit).
    await expect(client.stop()).rejects.toBe(exitError)
    expect(mockConnection.dispose).toHaveBeenCalled()
  })

  test('prefers the shutdown error when both shutdown and exit reject', async () => {
    await startClient()
    const shutdownError = new Error('shutdown rejected')
    const exitError = new Error('exit rejected')
    mockConnection.sendRequest.mockImplementation(async method =>
      recordingSendRequest(method, async () => {
        throw shutdownError
      }),
    )
    mockConnection.sendNotification.mockImplementation(async () => {
      throw exitError
    })

    // Official `throw ee??se` — shutdown error wins when both fail.
    await expect(client.stop()).rejects.toBe(shutdownError)
    expect(mockConnection.sendNotification).toHaveBeenCalledWith('exit', {})
    expect(mockConnection.dispose).toHaveBeenCalled()
  })
})
