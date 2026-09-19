import { beforeEach, describe, expect, test } from 'bun:test'

import type { MCPServerConnection } from '../../services/mcp/types.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import {
  MCP_NEEDS_AUTH_NOTICED_CAP,
  clearNeedsAuthNoticedThisSession,
  countNoticedServersNowConnected,
  markNeedsAuthNoticed,
  type NeedsAuthNoticeDeps,
  normalizeMcpNeedsAuthNoticed,
  pruneNoticedServersNowConnected,
  shouldAnnounceNeedsAuth,
} from '../mcpNeedsAuthNotice.js'

/**
 * claude-code 2.1.276: "Fixed a crash at launch when the persisted
 * `mcpNeedsAuthNoticed` value in ~/.claude.json is malformed."
 *
 * Official v276 normalizer `nl` + accessor `pee` (byte-extracted @190631562 /
 * @215917027):
 *
 *   function nl(n){if(!Array.isArray(n))return[];return n.every((e)=>
 *     typeof e==="string")?n:n.filter((e)=>typeof e==="string")}
 *   function pee(h){return nl(h.mcpNeedsAuthNoticed)}
 *
 * All four consumers (`cet` shouldAnnounce, `qbe` mark, `Vbe` count, `Gbe`
 * prune) route through `pee`. Before the fix, a hand-edited/corrupted value
 * (`{}`, `123`, …) reached `.includes`/`.filter` and threw a TypeError inside
 * the useMcpConnectivityStatus React effect at launch; a string value got
 * silent substring semantics. The mark write path normalizes BEFORE merging,
 * so a malformed value self-heals on the next persist.
 *
 * Persistence goes through the NODE_ENV=test in-memory global config,
 * matching the existing mcpNeedsAuthNotice.test.ts convention.
 */

const ALL_FALSE_DEPS: NeedsAuthNoticeDeps = {
  hasEverConnected: () => false,
  connectedThisSession: () => false,
}

function localNeedsAuth(name: string): MCPServerConnection {
  return {
    name,
    type: 'needs-auth',
    config: { type: 'http', url: 'https://srv.test/mcp', scope: 'user' },
  } as MCPServerConnection
}

function connected(name: string): MCPServerConnection {
  return {
    name,
    type: 'connected',
    config: { type: 'http', url: 'https://srv.test/mcp', scope: 'user' },
  } as MCPServerConnection
}

/** Persist a raw (possibly malformed) value, bypassing the string[] type. */
function setPersistedRaw(value: unknown): void {
  saveGlobalConfig(current => ({
    ...current,
    mcpNeedsAuthNoticed: value as string[],
  }))
}

function persistedRaw(): unknown {
  return getGlobalConfig().mcpNeedsAuthNoticed
}

beforeEach(() => {
  clearNeedsAuthNoticedThisSession()
  setPersistedRaw([])
})

describe('2.1.276 normalizeMcpNeedsAuthNoticed (official nl)', () => {
  test('non-array values normalize to []', () => {
    expect(normalizeMcpNeedsAuthNoticed('foo')).toEqual([])
    expect(normalizeMcpNeedsAuthNoticed(123)).toEqual([])
    expect(normalizeMcpNeedsAuthNoticed(null)).toEqual([])
    expect(normalizeMcpNeedsAuthNoticed(undefined)).toEqual([])
    expect(normalizeMcpNeedsAuthNoticed({})).toEqual([])
    expect(normalizeMcpNeedsAuthNoticed(true)).toEqual([])
  })

  test('mixed array keeps only string entries', () => {
    expect(normalizeMcpNeedsAuthNoticed([1, 'a', null, 'b', {}])).toEqual([
      'a',
      'b',
    ])
  })

  test('all-strings array is returned unchanged (official every fast path — identity)', () => {
    const value = ['a', 'b']
    expect(normalizeMcpNeedsAuthNoticed(value)).toBe(value)
    const empty: unknown[] = []
    expect(normalizeMcpNeedsAuthNoticed(empty)).toBe(empty)
  })
})

describe('2.1.276 shouldAnnounceNeedsAuth tolerates malformed persisted value', () => {
  test('object value → no throw, treated as nothing noticed', () => {
    setPersistedRaw({})
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('srv'), ALL_FALSE_DEPS)).toBe(
      true,
    )
  })

  test('number value → no throw, treated as nothing noticed', () => {
    setPersistedRaw(123)
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('srv'), ALL_FALSE_DEPS)).toBe(
      true,
    )
  })

  test('string value → no substring semantics (pre-fix "srv".includes("sr") suppressed)', () => {
    setPersistedRaw('srv')
    // Pre-fix: the raw string's String.prototype.includes made 'sr' look
    // noticed. Post-fix the malformed value normalizes to [] → announceable.
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('sr'), ALL_FALSE_DEPS)).toBe(
      true,
    )
  })

  test('mixed array → string entries still suppress', () => {
    setPersistedRaw([1, 'srv'])
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('srv'), ALL_FALSE_DEPS)).toBe(
      false,
    )
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('other'), ALL_FALSE_DEPS)).toBe(
      true,
    )
  })
})

describe('2.1.276 markNeedsAuthNoticed self-heals malformed persisted value', () => {
  test('object value → persists a clean string[]', () => {
    setPersistedRaw({})
    markNeedsAuthNoticed([localNeedsAuth('a')], ALL_FALSE_DEPS)
    expect(persistedRaw()).toEqual(['a'])
  })

  test('mixed array → non-string entries dropped on the merge write', () => {
    setPersistedRaw([1, 'a'])
    markNeedsAuthNoticed([localNeedsAuth('b')], ALL_FALSE_DEPS)
    expect(persistedRaw()).toEqual(['a', 'b'])
  })

  test('cap still applies to the normalized merge (slice(-128))', () => {
    expect(MCP_NEEDS_AUTH_NOTICED_CAP).toBe(128)
    // 129 raw entries: normalization drops the 42, leaving 128 strings;
    // merging 'new' makes 129, so slice(-128) evicts the oldest ('old-0').
    const seed: unknown[] = [
      42,
      ...Array.from({ length: 128 }, (_, i) => `old-${i}`),
    ]
    setPersistedRaw(seed)
    markNeedsAuthNoticed([localNeedsAuth('new')], ALL_FALSE_DEPS)
    const noticed = persistedRaw() as string[]
    expect(noticed.length).toBe(128)
    expect(noticed[noticed.length - 1]).toBe('new')
    expect(noticed).not.toContain(42)
    expect(noticed).not.toContain('old-0')
    expect(noticed[0]).toBe('old-1')
  })
})

describe('2.1.276 countNoticedServersNowConnected tolerates malformed persisted value', () => {
  test('number value → no throw, count 0', () => {
    setPersistedRaw(123)
    expect(countNoticedServersNowConnected([connected('a')])).toBe(0)
  })

  test('mixed array → counts string entries only', () => {
    setPersistedRaw([1, 'a', 'b'])
    const clients = [connected('a'), localNeedsAuth('b'), connected('c')]
    expect(countNoticedServersNowConnected(clients)).toBe(1)
  })
})

describe('2.1.276 pruneNoticedServersNowConnected tolerates malformed persisted value', () => {
  test('object value → no throw, config left untouched (official: length 0 → return O)', () => {
    setPersistedRaw({})
    pruneNoticedServersNowConnected([connected('a')])
    expect(persistedRaw()).toEqual({})
  })

  test('mixed array with a now-connected name → writes clean string[] remainder', () => {
    setPersistedRaw([1, 'a', 'b'])
    pruneNoticedServersNowConnected([connected('a')])
    expect(persistedRaw()).toEqual(['b'])
  })

  test('prune of a healthy list still removes connected names only', () => {
    setPersistedRaw(['a', 'b', 'c'])
    pruneNoticedServersNowConnected([connected('a'), localNeedsAuth('b')])
    expect(persistedRaw()).toEqual(['b', 'c'])
  })
})
