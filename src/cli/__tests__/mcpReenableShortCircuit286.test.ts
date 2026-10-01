import { describe, expect, test } from 'bun:test'
import { findConnectedMcpClient } from '../print.js'

/**
 * CC 2.1.286 item 53 — MCP server re-enable short-circuit when already
 * connected.
 *
 * Official v286 SDK enable handler `Xe` @222648472:
 *   `Xe=async(w)=>{let O=Ji(T,w);if(O===void 0)return;
 *    let K=Ht.find((le)=>le.name===w);
 *    if(K?.type==="connected")return K;
 *    if(K?.type==="disabled"||K?.type==="failed"){...pending...}
 *    return await bo(),Ht.find(...)}`
 * — a re-sent enable for a server whose client is already `connected`
 * returns that client immediately without tearing down / redialing.
 *
 * TRUE-NEW verification: the pattern `type==="connected")return K;` has
 * 1 hit in the v286 binary @222648472 and 0 hits in v285 (grep -aobF on
 * /tmp/cc-diff-286/{v285,v286}/package/claude). The companion v286 disable
 * handler `Gd` adds the cleanup-failure log
 * `Failed to close SDK MCP server after mcp_toggle disabled it: ${Me}`
 * @222648312 (also TRUE-NEW).
 *
 * OCC port: `findConnectedMcpClient` is the pure decision used by the
 * `mcp_toggle` enable branch in print.ts — connected → respond success
 * right away (no reconnectMcpServerImpl); anything else (disabled / failed /
 * pending / absent) → undefined → the redial path runs as before.
 */

type Client = { name: string; type: string }

function makeClient(name: string, type: string): Client {
  return { name, type }
}

describe('findConnectedMcpClient', () => {
  test('returns the client when a connected client with the server name exists', () => {
    // Arrange
    const connected = makeClient('my-server', 'connected')
    const clients = [
      makeClient('other', 'connected'),
      connected,
      makeClient('third', 'failed'),
    ]

    // Act
    const result = findConnectedMcpClient(clients, 'my-server')

    // Assert
    expect(result).toBe(connected)
  })

  test('returns undefined when the named client is disabled (reconnect path must run)', () => {
    // Arrange
    const clients = [makeClient('my-server', 'disabled')]

    // Act
    const result = findConnectedMcpClient(clients, 'my-server')

    // Assert
    expect(result).toBeUndefined()
  })

  test('returns undefined when the named client is failed', () => {
    // Arrange
    const clients = [makeClient('my-server', 'failed')]

    // Act
    const result = findConnectedMcpClient(clients, 'my-server')

    // Assert
    expect(result).toBeUndefined()
  })

  test('returns undefined when the named client is pending (mid-connect)', () => {
    // Arrange — official only short-circuits on exactly "connected".
    const clients = [makeClient('my-server', 'pending')]

    // Act
    const result = findConnectedMcpClient(clients, 'my-server')

    // Assert
    expect(result).toBeUndefined()
  })

  test('returns undefined when no client with the server name exists', () => {
    // Arrange
    const clients = [makeClient('a', 'connected'), makeClient('b', 'connected')]

    // Act
    const result = findConnectedMcpClient(clients, 'missing')

    // Assert
    expect(result).toBeUndefined()
  })

  test('returns undefined for an empty client list', () => {
    // Arrange / Act
    const result = findConnectedMcpClient([], 'my-server')

    // Assert
    expect(result).toBeUndefined()
  })

  test('first-listed connected client wins over a later same-name entry', () => {
    // Arrange — find() semantics: the first name match decides; if it is
    // not connected the result is undefined even when a later same-name
    // entry is connected (mirrors official `Ht.find(...)` then type check).
    const first = makeClient('dup', 'failed')
    const second = makeClient('dup', 'connected')
    const clients = [first, second]

    // Act
    const result = findConnectedMcpClient(clients, 'dup')

    // Assert
    expect(result).toBeUndefined()
  })

  test('preserves extra client fields (structural passthrough)', () => {
    // Arrange — official returns the found client object itself (`return K`),
    // so callers keep every field.
    const connected = {
      name: 'rich',
      type: 'connected',
      config: { url: 'https://example.test' },
    }

    // Act
    const result = findConnectedMcpClient([connected], 'rich')

    // Assert
    expect(result).toBe(connected)
    expect(result?.config.url).toBe('https://example.test')
  })
})
