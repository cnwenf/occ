import { describe, expect, test } from 'bun:test'
import { isNetworkConnectionError } from '../client.js'

/**
 * Gap #019 (official 2.1.295): remote MCP connections were dropped when a
 * server's error REPLY merely contained a network-error name in its message.
 * v295 replaced the v294 pure-string matcher (`Ar` @240892414) with the
 * structured classifier `Ir` (@243847856, dup @244006230):
 *
 *   function Ir(e){
 *     if(e.name==="AbortError")return!0;
 *     let r="code"in e?e.code:void 0,n="status"in e?e.status:void 0,
 *         s=/^Error POSTing to endpoint \(HTTP (\d+)\)/.exec(e.message)?.[1];
 *     if(qt(n)||qt(r)||typeof r==="number"&&r<0||s!==void 0&&qt(Number(s)))
 *       return!1;                                   // structured checks FIRST
 *     if(typeof r==="string"&&kr.has(r))return!0;   // string code set
 *     let h=e.message;                              // message fallback LAST
 *     return qo.some(y=>h.includes(y))||h.includes("Body Timeout Error")||
 *       /\bterminated\b/.test(h)||h.includes("SSE stream disconnected")||
 *       h.includes("Failed to reconnect SSE stream")}
 *
 * with qt = number in [100,599], qo = ECONNRESET/ETIMEDOUT/EPIPE/EHOSTUNREACH/
 * ECONNREFUSED, kr = qo + ConnectionRefused + ConnectionClosed.
 */

function errorWith(
  props: Partial<Error> & Record<string, unknown>,
): Error {
  const error = new Error((props.message as string) ?? '')
  if (props.name !== undefined) {
    error.name = props.name
  }
  for (const [key, value] of Object.entries(props)) {
    if (key !== 'message' && key !== 'name') {
      ;(error as unknown as Record<string, unknown>)[key] = value
    }
  }
  return error
}

describe('isNetworkConnectionError — v295 structured classifier (#019)', () => {
  test('AbortError is always a connection error regardless of code/status', () => {
    // Arrange
    const error = errorWith({ name: 'AbortError', message: 'aborted', code: 200 })

    // Act & Assert — name check runs before everything
    expect(isNetworkConnectionError(error)).toBe(true)
  })

  test('server error REPLY with negative JSON-RPC code mentioning ECONNRESET is NOT a connection error (the #019 bug)', () => {
    // Arrange — a tool-call failure the server reported with network-error text
    const error = errorWith({
      name: 'McpError',
      message: 'Tool invocation failed: upstream ECONNRESET',
      code: -32603,
    })

    // Act & Assert — negative numeric code short-circuits to false
    expect(isNetworkConnectionError(error)).toBe(false)
  })

  test('negative numeric code with ConnectionClosed text is NOT a connection error', () => {
    // Arrange
    const error = errorWith({
      message: 'ConnectionClosed while calling tool',
      code: -32000,
    })

    // Act & Assert
    expect(isNetworkConnectionError(error)).toBe(false)
  })

  test('HTTP-range numeric status is NOT a connection error', () => {
    // Arrange
    const error = errorWith({ message: 'ECONNRESET', status: 500 })

    // Act & Assert
    expect(isNetworkConnectionError(error)).toBe(false)
  })

  test('HTTP-range numeric code is NOT a connection error', () => {
    // Arrange
    const error = errorWith({ message: 'ETIMEDOUT', code: 503 })

    // Act & Assert
    expect(isNetworkConnectionError(error)).toBe(false)
  })

  test('"Error POSTing to endpoint (HTTP n)" wrapper is NOT a connection error', () => {
    // Arrange — SDK SSE POST wrapper with HTTP status in [100,599]
    const error = new Error('Error POSTing to endpoint (HTTP 502)')

    // Act & Assert
    expect(isNetworkConnectionError(error)).toBe(false)
  })

  test('string code in the terminal set IS a connection error', () => {
    // Arrange & Act & Assert — kr = qo + ConnectionRefused + ConnectionClosed
    for (const code of [
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'EHOSTUNREACH',
      'ECONNREFUSED',
      'ConnectionRefused',
      'ConnectionClosed',
    ]) {
      expect(isNetworkConnectionError(errorWith({ message: '', code }))).toBe(
        true,
      )
    }
  })

  test('string code outside the terminal set falls through to the message check', () => {
    // Arrange
    const error = errorWith({ message: 'something else', code: 'ENOENT' })

    // Act & Assert
    expect(isNetworkConnectionError(error)).toBe(false)
  })

  test('message fallback: bare network-code substrings ARE connection errors', () => {
    // Arrange & Act & Assert — qo substring list (v294-compatible behavior)
    for (const message of [
      'read ECONNRESET',
      'connect ETIMEDOUT 10.0.0.1:443',
      'write EPIPE',
      'EHOSTUNREACH',
      'ECONNREFUSED',
      'Body Timeout Error',
      'SSE stream disconnected',
      'Failed to reconnect SSE stream',
    ]) {
      expect(isNetworkConnectionError(new Error(message))).toBe(true)
    }
  })

  test('message fallback: "terminated" matches only on word boundaries (v295 /\\bterminated\\b/)', () => {
    // Arrange
    const wordTerminated = new Error('socket terminated unexpectedly')
    const embeddedTerminated = new Error('unterminated string literal in reply')

    // Act & Assert
    expect(isNetworkConnectionError(wordTerminated)).toBe(true)
    expect(isNetworkConnectionError(embeddedTerminated)).toBe(false)
  })

  test('plain application error without codes or network text is NOT a connection error', () => {
    // Arrange
    const error = new Error('Invalid tool arguments')

    // Act & Assert
    expect(isNetworkConnectionError(error)).toBe(false)
  })
})
