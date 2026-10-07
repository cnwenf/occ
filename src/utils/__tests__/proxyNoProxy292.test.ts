import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getNoProxy,
  getProxyFetchOptions,
  shouldBypassProxy,
} from '../proxy.js'

/**
 * CC 2.1.292 (occ149 P6): "Fixed NO_PROXY being ignored for Claude Code's
 * own API requests (sign-in, policy, feedback, artifacts) when HTTPS_PROXY
 * is set."
 *
 * Byte-verified against the official 2.1.292 linux-x64 ELF proxy module
 * (@203984200-203992500):
 *   - `YLe`/`__r` (≡ getNoProxy): `no_proxy==="*"||NO_PROXY==="*"` → "*";
 *     both set and different → `${no_proxy},${NO_PROXY}` (merged list);
 *     otherwise `no_proxy || NO_PROXY`.
 *   - `py` (≡ shouldBypassProxy): secure-protocol default port now covers
 *     `r.protocol==="https:"||r.protocol==="wss:"`.
 *   - `Xi` (≡ getProxyFetchOptions): new `url` option —
 *     `if(e.url&&py(e.url))return{...o,...BRt()}` (base + TLS only, no
 *     proxy/dispatcher) before the proxy branch.
 */

const ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'NO_PROXY',
  'no_proxy',
  'ANTHROPIC_UNIX_SOCKET',
] as const

let envSnapshot: Record<string, string | undefined>

beforeEach(() => {
  envSnapshot = {}
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key]
    else process.env[key] = envSnapshot[key]
  }
})

describe('getNoProxy (CC 2.1.292 YLe/__r merge semantics)', () => {
  test('both set and different → comma-merged list (lowercase first)', () => {
    process.env.no_proxy = 'a.example.com'
    process.env.NO_PROXY = 'b.example.com'
    expect(getNoProxy()).toBe('a.example.com,b.example.com')
  })

  test('both set and equal → single value, not duplicated', () => {
    process.env.no_proxy = 'same.example.com'
    process.env.NO_PROXY = 'same.example.com'
    expect(getNoProxy()).toBe('same.example.com')
  })

  test('either variable "*" → "*" (wildcard wins over any list)', () => {
    process.env.no_proxy = 'a.example.com'
    process.env.NO_PROXY = '*'
    expect(getNoProxy()).toBe('*')

    process.env.no_proxy = '*'
    process.env.NO_PROXY = 'b.example.com'
    expect(getNoProxy()).toBe('*')
  })

  test('only one variable set → that value; lowercase preferred', () => {
    process.env.NO_PROXY = 'upper.example.com'
    expect(getNoProxy()).toBe('upper.example.com')

    delete process.env.NO_PROXY
    process.env.no_proxy = 'lower.example.com'
    expect(getNoProxy()).toBe('lower.example.com')
  })

  test('neither set → undefined', () => {
    expect(getNoProxy()).toBeUndefined()
  })

  test('empty-string variable falls through to the other (official n||r)', () => {
    process.env.no_proxy = ''
    process.env.NO_PROXY = 'b.example.com'
    expect(getNoProxy()).toBe('b.example.com')
  })
})

describe('shouldBypassProxy (CC 2.1.292 py port)', () => {
  test('wss: defaults to port 443 for host:port patterns', () => {
    expect(shouldBypassProxy('wss://stream.example.com', 'stream.example.com:443')).toBe(true)
  })

  test('ws: defaults to port 80 for host:port patterns', () => {
    expect(shouldBypassProxy('ws://stream.example.com', 'stream.example.com:80')).toBe(true)
  })

  test('explicit port still matches host:port pattern', () => {
    expect(shouldBypassProxy('https://h.example.com:8443', 'h.example.com:8443')).toBe(true)
    expect(shouldBypassProxy('https://h.example.com:8443', 'h.example.com:443')).toBe(false)
  })

  test('merged default list: NO_PROXY-only entry now bypasses', () => {
    // Pre-292 precedence (no_proxy || NO_PROXY) ignored the uppercase entry
    // entirely when the lowercase one was set.
    process.env.no_proxy = 'a.example.com'
    process.env.NO_PROXY = 'b.example.com'
    expect(shouldBypassProxy('https://b.example.com/v1')).toBe(true)
    expect(shouldBypassProxy('https://a.example.com/v1')).toBe(true)
    expect(shouldBypassProxy('https://c.example.com/v1')).toBe(false)
  })

  test('"*" bypasses everything; leading-dot suffix match unchanged', () => {
    expect(shouldBypassProxy('https://anywhere.test', '*')).toBe(true)
    expect(shouldBypassProxy('https://sub.example.com', '.example.com')).toBe(true)
    expect(shouldBypassProxy('https://notexample.com', '.example.com')).toBe(false)
  })
})

describe('getProxyFetchOptions url bypass (CC 2.1.292 Xi port)', () => {
  test('proxy set + NO_PROXY-matching url → no proxy, no dispatcher', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
    process.env.NO_PROXY = 'api.internal.example'
    const opts = getProxyFetchOptions({ url: 'https://api.internal.example/v1' })
    expect(opts.proxy).toBeUndefined()
    expect(opts.dispatcher).toBeUndefined()
    expect(opts.unix).toBeUndefined()
  })

  test('proxy set + non-matching url → proxy still applied (Bun branch)', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
    process.env.NO_PROXY = 'api.internal.example'
    const opts = getProxyFetchOptions({ url: 'https://api.anthropic.com/v1/messages' })
    expect(opts.proxy).toBe('http://proxy.corp.example:8080')
  })

  test('proxy set + no url → legacy behavior unchanged (proxy applied)', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
    process.env.NO_PROXY = 'api.internal.example'
    const opts = getProxyFetchOptions()
    expect(opts.proxy).toBe('http://proxy.corp.example:8080')
  })

  test('NO_PROXY="*" + any url → bypass', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
    process.env.NO_PROXY = '*'
    const opts = getProxyFetchOptions({ url: 'https://api.anthropic.com/v1/messages' })
    expect(opts.proxy).toBeUndefined()
    expect(opts.dispatcher).toBeUndefined()
  })

  test('merged no_proxy/NO_PROXY lists are both honored by the bypass', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
    process.env.no_proxy = 'a.internal.example'
    process.env.NO_PROXY = 'b.internal.example'
    expect(getProxyFetchOptions({ url: 'https://b.internal.example/x' }).proxy).toBeUndefined()
    expect(getProxyFetchOptions({ url: 'https://a.internal.example/x' }).proxy).toBeUndefined()
    expect(getProxyFetchOptions({ url: 'https://c.external.example/x' }).proxy).toBe(
      'http://proxy.corp.example:8080',
    )
  })

  test('no proxy configured → plain options regardless of url', () => {
    process.env.NO_PROXY = 'api.internal.example'
    const opts = getProxyFetchOptions({ url: 'https://api.internal.example/v1' })
    expect(opts.proxy).toBeUndefined()
    expect(opts.dispatcher).toBeUndefined()
  })

  test('forAnthropicAPI unix socket still takes precedence over proxy+url', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
    process.env.NO_PROXY = 'api.internal.example'
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/claude-ssh.sock'
    const opts = getProxyFetchOptions({
      forAnthropicAPI: true,
      url: 'https://api.internal.example/v1',
    })
    // Official Xi checks the unix socket BEFORE the proxy/bypass branch.
    expect(opts.unix).toBe('/tmp/claude-ssh.sock')
    expect(opts.proxy).toBeUndefined()
  })
})
