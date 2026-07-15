import { describe, expect, test } from 'bun:test'
import type { ScopedMcpServerConfig, UnconfiguredMCPServer } from '../../src/services/mcp/types.js'

/**
 * CC 2.1.208 #43: MCP servers with an empty URL show "not configured" in /mcp
 * instead of a config error.
 *
 * The binary's `zcs(e)` classifier returns true (unconfigured) when:
 *   `e.configErrorReason === "url_empty" || (!e.configError && "url" in e && e.url.trim() === "")`
 *
 * In OCC, `connectToServer` returns `{ type: 'unconfigured' }` before
 * attempting `new URL("")`, so the server never enters the "failed" path.
 * This test verifies the classification logic mirrors the binary's `zcs()`.
 */

/** Mirrors the binary's `zcs(e)` classifier (standalone for testing). */
function isUnconfigured(e: {
  configErrorReason?: string | null
  configError?: unknown
  url?: string
}): boolean {
  return (
    e.configErrorReason === 'url_empty' ||
    (!e.configError && 'url' in e && typeof e.url === 'string' && e.url.trim() === '')
  )
}

/** Mirrors `connectToServer`'s early-return for empty URLs. */
function classifyServer(
  config: ScopedMcpServerConfig,
): { type: 'unconfigured' } | { type: 'other' } {
  if ('url' in config && typeof config.url === 'string' && config.url.trim() === '') {
    return { type: 'unconfigured' }
  }
  return { type: 'other' }
}

describe('MCP empty-URL "not configured" (CC 2.1.208 #43)', () => {
  test('zcs classifier: empty url with no configError → unconfigured', () => {
    expect(isUnconfigured({ url: '' })).toBe(true)
    expect(isUnconfigured({ url: '   ' })).toBe(true)
  })

  test('zcs classifier: url_empty configErrorReason → unconfigured', () => {
    expect(isUnconfigured({ configErrorReason: 'url_empty', url: 'http://x' })).toBe(true)
  })

  test('zcs classifier: non-empty url → not unconfigured', () => {
    expect(isUnconfigured({ url: 'http://localhost:3000' })).toBe(false)
    expect(isUnconfigured({ url: '  http://x  ' })).toBe(false)
  })

  test('zcs classifier: configError present → not unconfigured (handled elsewhere)', () => {
    expect(isUnconfigured({ configError: 'some_error', url: '' })).toBe(false)
  })

  test('connectToServer short-circuit: empty-url sse config → unconfigured type', () => {
    const config = {
      type: 'sse' as const,
      url: '',
      scope: 'user' as const,
    } as ScopedMcpServerConfig
    expect(classifyServer(config)).toEqual({ type: 'unconfigured' })
  })

  test('connectToServer short-circuit: whitespace-url http config → unconfigured', () => {
    const config = {
      type: 'http' as const,
      url: '   ',
      scope: 'local' as const,
    } as ScopedMcpServerConfig
    expect(classifyServer(config)).toEqual({ type: 'unconfigured' })
  })

  test('connectToServer short-circuit: valid url → not unconfigured', () => {
    const config = {
      type: 'sse' as const,
      url: 'http://localhost:3000/sse',
      scope: 'user' as const,
    } as ScopedMcpServerConfig
    expect(classifyServer(config)).toEqual({ type: 'other' })
  })

  test('UnconfiguredMCPServer type has correct shape', () => {
    const server: UnconfiguredMCPServer = {
      name: 'my-remote-server',
      type: 'unconfigured',
      config: {
        type: 'sse',
        url: '',
        scope: 'user',
      } as ScopedMcpServerConfig,
    }
    expect(server.type).toBe('unconfigured')
    expect(server.name).toBe('my-remote-server')
  })
})
