/**
 * CC 2.1.299 #042-class hardening — background redial config lookup in
 * src/services/mcp/client.ts.
 *
 * The redial path re-reads the latest merged MCP config after the holdoff
 * window and falls back to the stale `serverRef` captured at drop time:
 * `readOwnOption(latestServers, name) ?? serverRef`.
 *
 * Before the fix this was a raw `latestServers[name] ?? serverRef` index
 * read: a server named after an Object.prototype member (`constructor`,
 * `toString`, …) that is ABSENT from the latest config picked up the
 * inherited prototype member (truthy — `Object` for `constructor`) instead
 * of falling back to serverRef, and the redial then ran with a bogus config
 * object. Same class as WP2's #042 fixes; helper is the shared
 * `readOwnOption` from utils/plugins/optionKeySafety.ts.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readOwnOption } from '../../../utils/plugins/optionKeySafety.js'

type FakeServerConfig = { type: string; url?: string; command?: string }

const serverRef: FakeServerConfig = { type: 'sse', url: 'https://old.example/sse' }

/** Exact expression used at the redial site in client.ts. */
function resolveLatestRedialRef(
  latestServers: Record<string, FakeServerConfig>,
  name: string,
): FakeServerConfig {
  return readOwnOption(latestServers, name) ?? serverRef
}

describe('CC 2.1.299 #042-class — redial latest-config lookup', () => {
  test('reserved-name server ABSENT from latest config → falls back to serverRef, not Object', () => {
    const latestServers: Record<string, FakeServerConfig> = {
      real: { type: 'http', url: 'https://real.example/mcp' },
    }
    for (const name of ['constructor', 'toString', 'valueOf', '__proto__']) {
      const resolved = resolveLatestRedialRef(latestServers, name)
      expect(resolved).toBe(serverRef)
      // Explicitly NOT the inherited prototype member.
      expect(resolved).not.toBe(Object)
      expect(typeof resolved).toBe('object')
      expect((resolved as FakeServerConfig).url).toBe('https://old.example/sse')
    }
  })

  test('raw index read WOULD have misfired (documents the bug class)', () => {
    const latestServers: Record<string, FakeServerConfig> = {}
    // The pre-fix expression `latestServers[name] ?? serverRef` resolves
    // 'constructor' to the inherited Object constructor (truthy) — the
    // fallback never fires. This assertion pins why readOwnOption is needed.
    expect((latestServers as Record<string, unknown>)['constructor']).toBe(Object)
    expect(resolveLatestRedialRef(latestServers, 'constructor')).toBe(serverRef)
  })

  test('own entry present → latest config wins over stale serverRef', () => {
    const rotated: FakeServerConfig = { type: 'sse', url: 'https://new.example/sse' }
    const latestServers = { 'my-server': rotated, constructor: rotated }
    expect(resolveLatestRedialRef(latestServers, 'my-server')).toBe(rotated)
    // A prototype-named server that IS an own property resolves normally.
    expect(resolveLatestRedialRef(latestServers, 'constructor')).toBe(rotated)
  })

  test('wiring: client.ts redial site uses readOwnOption (no raw index read)', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'client.ts'),
      'utf8',
    )
    expect(source).toContain(
      'const latestRef = readOwnOption(latestServers, name) ?? serverRef',
    )
    expect(source).not.toContain('latestServers[name] ?? serverRef')
  })
})
