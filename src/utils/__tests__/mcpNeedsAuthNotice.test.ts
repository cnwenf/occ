import { beforeEach, describe, expect, test } from 'bun:test'

import type { MCPServerConnection } from '../../services/mcp/types.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import {
  MCP_NEEDS_AUTH_NOTICED_CAP,
  clearNeedsAuthNoticedThisSession,
  countNeedsAuthToAnnounce,
  countNoticedServersNowConnected,
  getNeedsAuthNoticedThisSessionSize,
  markNeedsAuthNoticed,
  type NeedsAuthNoticeDeps,
  pruneNoticedServersNowConnected,
  shouldAnnounceNeedsAuth,
} from '../mcpNeedsAuthNotice.js'

/**
 * CC 2.1.268 E63: the "N MCP servers need authentication" startup notice
 * announces each server only once. Official 2.1.268 dedup subsystem
 * (byte-verified from the binary):
 *
 *   var Z5t=128,DH={hasEverConnected:Ykt,connectedThisSession:Vkt};
 *   function net(w,{hasEverConnected:P,connectedThisSession:ee}){
 *     if(w.type!=="needs-auth"||!TEt(w,P,ee))return!1;
 *     return Nt().needsAuthNoticedThisSession.has(w.name)||
 *            !(ne().mcpNeedsAuthNoticed??[]).includes(w.name)}
 *   function Kye(w,P){return j(w,(ee)=>net(ee,P))}
 *   function zye(w,P,ee){ ... mcpNeedsAuthNoticed:[...xe,...Re].slice(-Z5t) ... }
 *   function Qye(w){ ... connected && mcpNeedsAuthNoticed.includes(name) ... }
 *   function Yye(w,P){ ... filter out names of now-connected clients ... }
 *
 * Deps are injected (mirroring official `DH`), so the gate/count/prune tests
 * below are pure; persistence goes through the NODE_ENV=test in-memory global
 * config, matching the existing mcpSlice218.test.ts convention.
 */

const ALL_FALSE_DEPS: NeedsAuthNoticeDeps = {
  hasEverConnected: () => false,
  connectedThisSession: () => false,
}

const ALL_TRUE_DEPS: NeedsAuthNoticeDeps = {
  hasEverConnected: () => true,
  connectedThisSession: () => true,
}

function localNeedsAuth(name: string): MCPServerConnection {
  return {
    name,
    type: 'needs-auth',
    config: { type: 'http', url: 'https://srv.test/mcp', scope: 'user' },
  } as MCPServerConnection
}

function claudeAiNeedsAuth(
  name: string,
  eligible?: boolean,
): MCPServerConnection {
  return {
    name,
    type: 'needs-auth',
    config: {
      type: 'claudeai-proxy',
      id: name,
      scope: 'claudeai',
      ...(eligible !== undefined ? { eligible } : {}),
    },
  } as MCPServerConnection
}

function connected(name: string): MCPServerConnection {
  return {
    name,
    type: 'connected',
    config: { type: 'http', url: 'https://srv.test/mcp', scope: 'user' },
  } as MCPServerConnection
}

function failedUnconfigured(name: string): MCPServerConnection {
  return {
    name,
    type: 'failed',
    errorCode: 'UNCONFIGURED',
    config: { type: 'http', url: 'https://srv.test/mcp', scope: 'user' },
  } as MCPServerConnection
}

function setPersistedNoticed(names: string[]): void {
  saveGlobalConfig(current => ({ ...current, mcpNeedsAuthNoticed: names }))
}

function persistedNoticed(): string[] | undefined {
  return getGlobalConfig().mcpNeedsAuthNoticed
}

beforeEach(() => {
  clearNeedsAuthNoticedThisSession()
  setPersistedNoticed([])
})

describe('2.1.268 E63 shouldAnnounceNeedsAuth (official net)', () => {
  test('local needs-auth server never announced → true', () => {
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('srv'), ALL_FALSE_DEPS)).toBe(
      true,
    )
  })

  test('non-needs-auth client → false', () => {
    expect(shouldAnnounceNeedsAuth(connected('srv'), ALL_TRUE_DEPS)).toBe(false)
    expect(shouldAnnounceNeedsAuth(failedUnconfigured('srv'), ALL_TRUE_DEPS)).toBe(
      false,
    )
  })

  test('IDE internals (sse-ide / ws-ide) → excluded (official TEt tail)', () => {
    const ide = {
      name: 'ide',
      type: 'needs-auth',
      config: { type: 'sse-ide', url: 'https://ide.test', scope: 'local' },
    } as MCPServerConnection
    const ws = { ...ide, config: { ...ide.config, type: 'ws-ide' } } as MCPServerConnection
    expect(shouldAnnounceNeedsAuth(ide, ALL_TRUE_DEPS)).toBe(false)
    expect(shouldAnnounceNeedsAuth(ws, ALL_TRUE_DEPS)).toBe(false)
  })

  test('claude.ai eligible===false && !connectedThisSession → excluded', () => {
    const client = claudeAiNeedsAuth('connector', false)
    expect(
      shouldAnnounceNeedsAuth(client, {
        hasEverConnected: () => true,
        connectedThisSession: () => false,
      }),
    ).toBe(false)
    expect(
      shouldAnnounceNeedsAuth(client, {
        hasEverConnected: () => true,
        connectedThisSession: () => true,
      }),
    ).toBe(true)
  })

  test('claude.ai counted iff hasEverConnected (official TEt branch)', () => {
    const client = claudeAiNeedsAuth('connector')
    expect(
      shouldAnnounceNeedsAuth(client, {
        hasEverConnected: () => false,
        connectedThisSession: () => true,
      }),
    ).toBe(false)
    expect(
      shouldAnnounceNeedsAuth(client, {
        hasEverConnected: () => true,
        connectedThisSession: () => false,
      }),
    ).toBe(true)
  })

  test('persisted-noticed server → false (announced once across sessions)', () => {
    setPersistedNoticed(['srv'])
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('srv'), ALL_FALSE_DEPS)).toBe(
      false,
    )
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('other'), ALL_FALSE_DEPS)).toBe(
      true,
    )
  })

  test('session-noticed server stays announceable within the session', () => {
    markNeedsAuthNoticed([localNeedsAuth('srv')], ALL_FALSE_DEPS)
    // Persisted now contains 'srv', but the session Set keeps it announceable
    // (official: needsAuthNoticedThisSession.has(name) || !persisted.includes)
    expect(persistedNoticed()).toEqual(['srv'])
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('srv'), ALL_FALSE_DEPS)).toBe(
      true,
    )
    // After a conversation reset the persisted list suppresses the notice.
    clearNeedsAuthNoticedThisSession()
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('srv'), ALL_FALSE_DEPS)).toBe(
      false,
    )
  })
})

describe('2.1.268 E63 countNeedsAuthToAnnounce (official Kye/j)', () => {
  test('counts only announceable servers', () => {
    setPersistedNoticed(['b'])
    const clients = [
      localNeedsAuth('a'),
      localNeedsAuth('b'), // persisted-noticed, not session-noticed → skipped
      connected('c'),
      failedUnconfigured('d'),
      claudeAiNeedsAuth('e', false), // eligible===false, deps all-false → skipped
    ]
    expect(countNeedsAuthToAnnounce(clients, ALL_FALSE_DEPS)).toBe(1)
  })

  test('empty list → 0', () => {
    expect(countNeedsAuthToAnnounce([], ALL_FALSE_DEPS)).toBe(0)
  })
})

describe('2.1.268 E63 markNeedsAuthNoticed (official zye)', () => {
  test('records session Set + persisted list for announceable servers only', () => {
    const clients = [localNeedsAuth('a'), connected('b'), localNeedsAuth('c')]
    markNeedsAuthNoticed(clients, ALL_FALSE_DEPS)
    expect(persistedNoticed()).toEqual(['a', 'c'])
    expect(getNeedsAuthNoticedThisSessionSize()).toBe(2)
  })

  test('idempotent — re-marking adds no duplicates', () => {
    const clients = [localNeedsAuth('a')]
    markNeedsAuthNoticed(clients, ALL_FALSE_DEPS)
    markNeedsAuthNoticed(clients, ALL_FALSE_DEPS)
    expect(persistedNoticed()).toEqual(['a'])
    expect(getNeedsAuthNoticedThisSessionSize()).toBe(1)
  })

  test('nothing announceable → persisted list untouched', () => {
    setPersistedNoticed(['x'])
    markNeedsAuthNoticed([connected('a')], ALL_FALSE_DEPS)
    expect(persistedNoticed()).toEqual(['x'])
  })

  test('persisted list capped at 128 via slice(-128) — oldest evicted', () => {
    expect(MCP_NEEDS_AUTH_NOTICED_CAP).toBe(128)
    const seed = Array.from({ length: 128 }, (_, i) => `old-${i}`)
    setPersistedNoticed(seed)
    markNeedsAuthNoticed(
      [localNeedsAuth('new-1'), localNeedsAuth('new-2')],
      ALL_FALSE_DEPS,
    )
    const noticed = persistedNoticed()!
    expect(noticed.length).toBe(128)
    expect(noticed.slice(-2)).toEqual(['new-1', 'new-2'])
    expect(noticed).not.toContain('old-0')
    expect(noticed).not.toContain('old-1')
    expect(noticed[0]).toBe('old-2')
  })

  test('persisted-noticed but session-fresh servers are not re-added', () => {
    setPersistedNoticed(['a'])
    clearNeedsAuthNoticedThisSession()
    // 'a' is persisted → net() false → mark skips it entirely.
    markNeedsAuthNoticed([localNeedsAuth('a')], ALL_FALSE_DEPS)
    expect(persistedNoticed()).toEqual(['a'])
    expect(getNeedsAuthNoticedThisSessionSize()).toBe(0)
  })
})

describe('2.1.268 E63 prune (official Qye + Yye)', () => {
  test('countNoticedServersNowConnected: 0 with no persisted list', () => {
    saveGlobalConfig(current => ({
      ...current,
      mcpNeedsAuthNoticed: undefined,
    }))
    expect(countNoticedServersNowConnected([connected('a')])).toBe(0)
  })

  test('countNoticedServersNowConnected counts connected persisted names', () => {
    setPersistedNoticed(['a', 'b'])
    const clients = [connected('a'), localNeedsAuth('b'), connected('c')]
    expect(countNoticedServersNowConnected(clients)).toBe(1)
  })

  test('pruneNoticedServersNowConnected removes now-connected names only', () => {
    setPersistedNoticed(['a', 'b', 'c'])
    pruneNoticedServersNowConnected([connected('a'), localNeedsAuth('b')])
    expect(persistedNoticed()).toEqual(['b', 'c'])
  })

  test('prune is a no-op write when nothing is connected', () => {
    setPersistedNoticed(['a', 'b'])
    pruneNoticedServersNowConnected([localNeedsAuth('a')])
    expect(persistedNoticed()).toEqual(['a', 'b'])
  })

  test('pruned server announces again on next needs-auth', () => {
    setPersistedNoticed(['srv'])
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('srv'), ALL_FALSE_DEPS)).toBe(
      false,
    )
    pruneNoticedServersNowConnected([connected('srv')])
    expect(shouldAnnounceNeedsAuth(localNeedsAuth('srv'), ALL_FALSE_DEPS)).toBe(
      true,
    )
  })
})
