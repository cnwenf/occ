import { describe, expect, test } from 'bun:test'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { WebSocketTransport } from '../mcpWebSocketTransport.js'

/**
 * Gap #124 (official 2.1.295): a ws MCP server message over 16 MiB must NOT
 * be parsed — the transport reports a coded error and closes the connection.
 *
 * Official evidence (v295 @243779021, constant `cne=16777216` @213397583):
 *   onBunMessage=(e)=>{try{
 *     let r=typeof e.data==="string"?e.data:String(e.data);
 *     if(Buffer.byteLength(r)>cne){
 *       this.handleError(new x(
 *         `MCP server sent a WebSocket message over ${cne/1024/1024} MiB. `+
 *         "Claude Code did not read it and closed the connection.",
 *         "mcp websocket message over the cap")),
 *       this.close().catch(()=>{});return}
 *     ...parse...
 *   }}catch(r){this.handleError(r)}}
 *
 * v294 (@240769909) has NO size check.
 */

const MAX_MESSAGE_BYTES = 16777216
const OVER_CAP_MESSAGE = `MCP server sent a WebSocket message over ${MAX_MESSAGE_BYTES / 1024 / 1024} MiB. Claude Code did not read it and closed the connection.`
const OVER_CAP_CODE = 'mcp websocket message over the cap'

type CapturedListener = (event: { data: unknown }) => void

function createMockBunSocket() {
  const listeners = new Map<string, CapturedListener[]>()
  const socket = {
    readyState: 1, // OPEN
    closeCalls: 0,
    close() {
      this.closeCalls++
      this.readyState = 3 // CLOSED
    },
    send(_data: string) {},
    addEventListener(type: string, listener: CapturedListener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    removeEventListener(type: string, listener: CapturedListener) {
      listeners.set(type, (listeners.get(type) ?? []).filter(l => l !== listener))
    },
    dispatch(type: string, event: { data: unknown }) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event)
      }
    },
    listenerCount(type: string): number {
      return (listeners.get(type) ?? []).length
    },
  }
  return socket
}

async function createStartedTransport() {
  const socket = createMockBunSocket()
  const transport = new WebSocketTransport(socket as never)
  await transport.start()
  return { socket, transport }
}

describe('MCP WebSocket transport 16 MiB receive cap (#124, official 2.1.295)', () => {
  test('message over the cap is not parsed: coded error emitted and connection closed', async () => {
    // Arrange
    const { socket, transport } = await createStartedTransport()
    const received: JSONRPCMessage[] = []
    const errors: Error[] = []
    transport.onmessage = message => received.push(message)
    transport.onerror = error => errors.push(error)
    const oversize = 'a'.repeat(MAX_MESSAGE_BYTES + 1)

    // Act
    socket.dispatch('message', { data: oversize })

    // Assert: error carries the official message + code
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toBe(OVER_CAP_MESSAGE)
    expect((errors[0] as Error & { code?: string }).code).toBe(OVER_CAP_CODE)
    // Assert: the payload was never parsed / delivered
    expect(received.length).toBe(0)
    // Assert: the connection was closed
    expect(socket.closeCalls).toBe(1)
  })

  test('message exactly at the cap is NOT rejected by the size guard (strict > comparison)', async () => {
    // Arrange
    const { socket, transport } = await createStartedTransport()
    const errors: Error[] = []
    transport.onerror = error => errors.push(error)
    const atCap = 'a'.repeat(MAX_MESSAGE_BYTES)

    // Act — invalid JSON, so it fails at the parse step, not the size guard
    socket.dispatch('message', { data: atCap })

    // Assert: no over-cap error, no size-guard close
    expect(
      errors.some(e => (e as Error & { code?: string }).code === OVER_CAP_CODE),
    ).toBe(false)
    expect(socket.closeCalls).toBe(0)
  })

  test('normal-size valid JSON-RPC message still parses and is delivered', async () => {
    // Arrange
    const { socket, transport } = await createStartedTransport()
    const received: JSONRPCMessage[] = []
    const errors: Error[] = []
    transport.onmessage = message => received.push(message)
    transport.onerror = error => errors.push(error)

    // Act
    socket.dispatch('message', {
      data: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ping' }),
    })

    // Assert
    expect(errors.length).toBe(0)
    expect(received.length).toBe(1)
    expect(socket.closeCalls).toBe(0)
  })

  test('oversize rejection also removes listeners via close cleanup', async () => {
    // Arrange
    const { socket, transport } = await createStartedTransport()
    transport.onerror = () => {}
    expect(socket.listenerCount('message')).toBe(1)

    // Act
    socket.dispatch('message', { data: 'x'.repeat(MAX_MESSAGE_BYTES + 1) })

    // Assert — close() ran handleCloseCleanup, listeners removed
    await Promise.resolve()
    expect(socket.listenerCount('message')).toBe(0)
  })
})
