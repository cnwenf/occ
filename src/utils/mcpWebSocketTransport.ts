import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type WsWebSocket from 'ws'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { toError } from './errors.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

// WebSocket readyState constants (same for both native and ws)
const WS_CONNECTING = 0
const WS_OPEN = 1

// Official 2.1.295 receive-side cap (`cne=16777216` in the v295 binary,
// onBunMessage @243779021): a message larger than this is NOT parsed — the
// transport reports a coded error and closes the connection (DoS guard #124).
const MCP_WEBSOCKET_MAX_MESSAGE_BYTES = 16777216

/**
 * Coded error mirroring the official binary's `new x(message, code)` shape
 * (the `x` class lives in another chunk; the observable contract is the
 * message string plus a `code` string property).
 */
class CodedWebSocketError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'CodedWebSocketError'
    this.code = code
  }
}

// Minimal interface shared by globalThis.WebSocket and ws.WebSocket
type WebSocketLike = {
  readonly readyState: number
  close(): void
  send(data: string): void
}

export class WebSocketTransport implements Transport {
  private started = false
  private opened: Promise<void>
  private isBun = typeof Bun !== 'undefined'

  constructor(private ws: WebSocketLike) {
    this.opened = new Promise((resolve, reject) => {
      if (this.ws.readyState === WS_OPEN) {
        resolve()
      } else if (this.isBun) {
        const nws = this.ws as unknown as globalThis.WebSocket
        const onOpen = () => {
          nws.removeEventListener('open', onOpen)
          nws.removeEventListener('error', onError)
          resolve()
        }
        const onError = (event: Event) => {
          nws.removeEventListener('open', onOpen)
          nws.removeEventListener('error', onError)
          logForDiagnosticsNoPII('error', 'mcp_websocket_connect_fail')
          reject(event)
        }
        nws.addEventListener('open', onOpen)
        nws.addEventListener('error', onError)
      } else {
        const nws = this.ws as unknown as WsWebSocket
        nws.on('open', () => {
          resolve()
        })
        nws.on('error', error => {
          logForDiagnosticsNoPII('error', 'mcp_websocket_connect_fail')
          reject(error)
        })
      }
    })

    // Attach persistent event handlers
    if (this.isBun) {
      const nws = this.ws as unknown as globalThis.WebSocket
      nws.addEventListener('message', this.onBunMessage)
      nws.addEventListener('error', this.onBunError)
      nws.addEventListener('close', this.onBunClose)
    } else {
      const nws = this.ws as unknown as WsWebSocket
      nws.on('message', this.onNodeMessage)
      nws.on('error', this.onNodeError)
      nws.on('close', this.onNodeClose)
    }
  }

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  /**
   * Official 2.1.295 oversized-message guard (v295 onBunMessage @243779021):
   * `if (Buffer.byteLength(data) > 16777216) { handleError(coded); close(); return }`
   * — the payload is never parsed. Returns true when the message was rejected.
   */
  private rejectOversizeMessage(byteLength: number): boolean {
    if (byteLength > MCP_WEBSOCKET_MAX_MESSAGE_BYTES) {
      this.handleError(
        new CodedWebSocketError(
          `MCP server sent a WebSocket message over ${MCP_WEBSOCKET_MAX_MESSAGE_BYTES / 1024 / 1024} MiB. Claude Code did not read it and closed the connection.`,
          'mcp websocket message over the cap',
        ),
      )
      void this.close().catch(() => {})
      return true
    }
    return false
  }

  // Bun (native WebSocket) event handlers
  private onBunMessage = (event: MessageEvent) => {
    try {
      const data =
        typeof event.data === 'string' ? event.data : String(event.data)
      if (this.rejectOversizeMessage(Buffer.byteLength(data))) {
        return
      }
      const messageObj = jsonParse(data)
      const message = JSONRPCMessageSchema.parse(messageObj)
      this.onmessage?.(message)
    } catch (error) {
      this.handleError(error)
    }
  }

  private onBunError = () => {
    this.handleError(new Error('WebSocket error'))
  }

  private onBunClose = () => {
    this.handleCloseCleanup()
  }

  // Node (ws package) event handlers
  // NOTE: the official binary only runs the Bun path; OCC keeps a node-ws
  // compat branch, so the same 16 MiB receive guard is applied here as a
  // faithful extension of the official behavior.
  private onNodeMessage = (data: Buffer) => {
    try {
      if (this.rejectOversizeMessage(data.byteLength)) {
        return
      }
      const messageObj = jsonParse(data.toString('utf-8'))
      const message = JSONRPCMessageSchema.parse(messageObj)
      this.onmessage?.(message)
    } catch (error) {
      this.handleError(error)
    }
  }

  private onNodeError = (error: unknown) => {
    this.handleError(error)
  }

  private onNodeClose = () => {
    this.handleCloseCleanup()
  }

  // Shared error handler
  private handleError(error: unknown): void {
    logForDiagnosticsNoPII('error', 'mcp_websocket_message_fail')
    this.onerror?.(toError(error))
  }

  // Shared close handler with listener cleanup
  private handleCloseCleanup(): void {
    this.onclose?.()
    // Clean up listeners after close
    if (this.isBun) {
      const nws = this.ws as unknown as globalThis.WebSocket
      nws.removeEventListener('message', this.onBunMessage)
      nws.removeEventListener('error', this.onBunError)
      nws.removeEventListener('close', this.onBunClose)
    } else {
      const nws = this.ws as unknown as WsWebSocket
      nws.off('message', this.onNodeMessage)
      nws.off('error', this.onNodeError)
      nws.off('close', this.onNodeClose)
    }
  }

  /**
   * Starts listening for messages on the WebSocket.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Start can only be called once per transport.')
    }
    await this.opened
    if (this.ws.readyState !== WS_OPEN) {
      logForDiagnosticsNoPII('error', 'mcp_websocket_start_not_opened')
      throw new Error('WebSocket is not open. Cannot start transport.')
    }
    this.started = true
    // Unlike stdio, WebSocket connections are typically already established when the transport is created.
    // No explicit connection action needed here, just attaching listeners.
  }

  /**
   * Closes the WebSocket connection.
   */
  async close(): Promise<void> {
    if (
      this.ws.readyState === WS_OPEN ||
      this.ws.readyState === WS_CONNECTING
    ) {
      this.ws.close()
    }
    // Ensure listeners are removed even if close was called externally or connection was already closed
    this.handleCloseCleanup()
  }

  /**
   * Sends a JSON-RPC message over the WebSocket connection.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ws.readyState !== WS_OPEN) {
      logForDiagnosticsNoPII('error', 'mcp_websocket_send_not_opened')
      throw new Error('WebSocket is not open. Cannot send message.')
    }
    const json = jsonStringify(message)

    try {
      if (this.isBun) {
        // Native WebSocket.send() is synchronous (no callback)
        this.ws.send(json)
      } else {
        await new Promise<void>((resolve, reject) => {
          ;(this.ws as unknown as WsWebSocket).send(json, error => {
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          })
        })
      }
    } catch (error) {
      this.handleError(error)
      throw error
    }
  }
}
