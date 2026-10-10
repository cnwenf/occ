import { describe, expect, test } from 'bun:test'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../errors.js'
import {
  MAX_WS_MESSAGE_BYTES,
  WebSocketTransport,
} from '../mcpWebSocketTransport.js'

/**
 * CC 2.1.295 (item 8) — 16 MiB incoming MCP WebSocket message cap.
 *
 * Binary evidence (official transport class `NJe`, verbatim from s295):
 *
 *   onBunMessage=(e)=>{try{let r=typeof e.data==="string"?e.data:String(e.data);
 *     if(Buffer.byteLength(r)>cne){this.handleError(new x(
 *       `MCP server sent a WebSocket message over ${cne/1024/1024} MiB.
 *        Claude Code did not read it and closed the connection.`,
 *       "mcp websocket message over the cap")),this.close().catch(()=>{});return}
 *     let o=X(r),n=this.parseMessage(o);this.onmessage?.(n)}catch(r){this.handleError(r)}}
 *
 * with `cne=16777216` and `x` = TelemetrySafeError. The guard fires BEFORE any
 * parsing, uses `>` (exactly-at-cap is allowed), reports through the normal
 * error channel, and closes the socket without reading the message.
 */

type Listener = (event: unknown) => void

class FakeWebSocket {
  readyState = 1
  closeCalls = 0
  private listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(fn)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn)
  }

  close(): void {
    this.closeCalls++
    this.readyState = 3
  }

  send(_data: string): void {}

  dispatchMessage(data: unknown): void {
    for (const fn of [...(this.listeners.get('message') ?? [])]) {
      fn({ data })
    }
  }
}

function makeTransport(): {
  transport: WebSocketTransport
  ws: FakeWebSocket
  messages: unknown[]
  errors: Error[]
  closes: number[]
} {
  const ws = new FakeWebSocket()
  const transport = new WebSocketTransport(
    ws as unknown as ConstructorParameters<typeof WebSocketTransport>[0],
  )
  const messages: unknown[] = []
  const errors: Error[] = []
  const closes: number[] = []
  transport.onmessage = message => messages.push(message)
  transport.onerror = error => errors.push(error)
  transport.onclose = () => closes.push(Date.now())
  return { transport, ws, messages, errors, closes }
}

describe('WebSocketTransport 16 MiB incoming message cap (2.1.295)', () => {
  test('exports the official cne=16777216 cap', () => {
    // Assert
    expect(MAX_WS_MESSAGE_BYTES).toBe(16_777_216)
    expect(MAX_WS_MESSAGE_BYTES).toBe(16 * 1024 * 1024)
  })

  test('delivers an under-cap JSON-RPC message to onmessage without error', () => {
    // Arrange
    const { ws, messages, errors } = makeTransport()

    // Act
    ws.dispatchMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}')

    // Assert
    expect(messages).toHaveLength(1)
    expect(errors).toHaveLength(0)
    expect(ws.closeCalls).toBe(0)
  })

  test('rejects a message one byte over the cap with the official TelemetrySafeError and closes the socket', () => {
    // Arrange
    const { ws, messages, errors, closes } = makeTransport()
    const oversized = 'x'.repeat(MAX_WS_MESSAGE_BYTES + 1)

    // Act
    ws.dispatchMessage(oversized)

    // Assert — official error surfaced through onerror, message NOT parsed
    expect(messages).toHaveLength(0)
    expect(errors).toHaveLength(1)
    const error = errors[0]
    expect(error).toBeInstanceOf(
      TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    )
    expect(error?.message).toBe(
      'MCP server sent a WebSocket message over 16 MiB. Claude Code did not read it and closed the connection.',
    )
    expect(
      (
        error as TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      ).telemetryMessage,
    ).toBe('mcp websocket message over the cap')
    // official `this.close()` — socket closed, transport onclose fired
    expect(ws.closeCalls).toBe(1)
    expect(closes.length).toBeGreaterThanOrEqual(1)
  })

  test('does NOT reject a message exactly at the cap (guard is strict >)', async () => {
    // Arrange
    const { ws, errors } = makeTransport()
    const atCap = 'x'.repeat(MAX_WS_MESSAGE_BYTES)

    // Act — the guard passes; the invalid JSON then fails normal parsing
    ws.dispatchMessage(atCap)
    // let any microtasks from close() settle
    await Promise.resolve()

    // Assert — a parse error, not the cap error, and no cap-triggered close
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).not.toContain('MiB')
    expect(ws.closeCalls).toBe(0)
  })

  test('measures the cap in bytes, not characters (multibyte payload over cap is rejected)', () => {
    // Arrange — 'é' is 2 bytes in UTF-8: cap/2 chars = cap+... > cap bytes
    const { ws, errors, messages } = makeTransport()
    const multibyte = 'é'.repeat(Math.floor(MAX_WS_MESSAGE_BYTES / 2) + 1)
    expect(multibyte.length).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES)
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(MAX_WS_MESSAGE_BYTES)

    // Act
    ws.dispatchMessage(multibyte)

    // Assert
    expect(messages).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('over 16 MiB')
    expect(ws.closeCalls).toBe(1)
  })
})
