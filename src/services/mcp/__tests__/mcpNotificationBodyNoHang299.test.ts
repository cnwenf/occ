/**
 * CC 2.1.299 #079 (anthropics/claude-code#99014) — MCP over HTTP must not
 * hang when a server never ends the body of its reply to a NOTIFICATION.
 *
 * Official changelog (2.1.299): "Fixed MCP connections over HTTP hanging for
 * 30 seconds and failing when a server never ends the body of its reply to a
 * notification (anthropics/claude-code#99014)."
 *
 * Binary forensics: the SDK's StreamableHTTPClientTransport.send() is
 * byte-identical v296↔v299 for the notification path (`await E.text?.()
 * .catch(()=>{})` for a 202 and for the no-request else branch) — the fix is
 * NOT in send(). OCC's npm SDK (1.29.0) is uneditable, and OCC adds its own
 * `capMcpResponseBody` drain layer (2.1.139) AFTER the request timeout is
 * cleared — so a never-ending notification body would hang that drain loop
 * forever. The OCC-layer fix (client.ts wrapFetchWithTimeout) detects a
 * no-request POST (mirroring the SDK's `hasRequests` filter) and cancels the
 * body instead of draining it; id'd requests still fully await/cap the body.
 *
 * Test strategy: the notification reply body is a ReadableStream whose read()
 * NEVER resolves but whose cancel() resolves promptly. Pre-fix this hangs (the
 * test times out); post-fix it resolves in milliseconds.
 */
import { describe, expect, test } from 'bun:test'
import { wrapFetchWithTimeout } from '../client.js'

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

/** A body stream that never yields and never ends, but cancels promptly. */
function neverEndingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      // Intentionally never enqueue and never close → read() hangs forever.
    },
    cancel() {
      // Resolves promptly (this is what the fix relies on).
    },
  })
}

/** A body stream that yields one JSON-RPC result buffer, then closes. */
function finiteBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function mockFetchReturning(body: ReadableStream<Uint8Array>): FetchLike {
  return async () =>
    new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    })
}

const NOTIFICATION = JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
})
const REQUEST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

describe('CC 2.1.299 #079 — notification reply body must not hang the drain', () => {
  test('notification POST with a never-ending body resolves promptly (body cancelled)', async () => {
    const wrapped = wrapFetchWithTimeout(
      mockFetchReturning(neverEndingBody()),
      60_000,
    )
    const started = Date.now()

    const response = await wrapped('http://srv.example/mcp', {
      method: 'POST',
      body: NOTIFICATION,
      headers: { 'content-type': 'application/json' },
    })

    const elapsed = Date.now() - started
    // Resolved without draining the never-ending body.
    expect(elapsed).toBeLessThan(2_000)
    expect(response.status).toBe(200)
    // Empty body handed back; the SDK only text()s it to release the connection.
    expect(await response.text()).toBe('')
  }, 5_000)

  test('batch of only notifications (no request) also resolves promptly', async () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} },
    ])
    const wrapped = wrapFetchWithTimeout(
      mockFetchReturning(neverEndingBody()),
      60_000,
    )
    const started = Date.now()

    const response = await wrapped('http://srv.example/mcp', {
      method: 'POST',
      body: batch,
    })

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(response.status).toBe(200)
  }, 5_000)

  test("id'd request STILL fully awaits/caps the body (payload preserved)", async () => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'echo' }] },
    })
    const wrapped = wrapFetchWithTimeout(
      mockFetchReturning(finiteBody(payload)),
      60_000,
    )

    const response = await wrapped('http://srv.example/mcp', {
      method: 'POST',
      body: REQUEST,
    })

    // The request path drains + rebuilds the body, so the JSON-RPC payload
    // survives for the SDK to parse.
    expect(await response.text()).toBe(payload)
  }, 5_000)

  test('mixed batch (notification + request) is treated as a request → body drained', async () => {
    const mixed = JSON.stringify([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} },
    ])
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} })
    const wrapped = wrapFetchWithTimeout(
      mockFetchReturning(finiteBody(payload)),
      60_000,
    )

    const response = await wrapped('http://srv.example/mcp', {
      method: 'POST',
      body: mixed,
    })

    expect(await response.text()).toBe(payload)
  }, 5_000)
})
