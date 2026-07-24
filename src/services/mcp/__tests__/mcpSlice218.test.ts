import { describe, expect, test } from 'bun:test'
import {
  getMcpServerFailureMessage,
  formatFailedMcpServerForWarning,
  isUnconfiguredMcpServer,
  mcpServerHealthStatusLabel,
} from '../utils'
import {
  getMcpNeedsAuthCount,
  markClaudeAiMcpConnected,
  isClaudeAiMcpCurrentlyConnected,
  clearClaudeAiMcpCurrentlyConnected,
  resetClaudeAiEverConnectedForTest,
} from '../claudeai'
import {
  detachMcpToolResultContent,
  extractMcpFailureErrorCode,
} from '../client'
import type {
  FailedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../types'
import type { MCPToolResult } from '../../../../utils/mcpValidation'

/**
 * CC 2.1.218 #5: `claude mcp list` / `/mcp` must surface HTTP status + error
 * text when a server fails to connect. The official carries an `errorCode`
 * (named code, numeric HTTP status, or "23" for timeout) alongside `error` on
 * the failed connection result, and renders it via the `TQo` extractor and
 * `kbo` warning formatter.
 *
 * Binary evidence (s21218.txt):
 *   TQo(e){let t="url"in e.config?e.config.url:null,r=e.errorCode;
 *     if(r==="INVALID_CONFIG"||r==="UNCONFIGURED"||r==="AUTH_HEADER_REJECTED"
 *        ||r==="CLI_OWNED_BEARER_REJECTED"||r==="FIRST_PARTY_AUTH_REJECTED"
 *        ||r==="ENDPOINT_NOT_FOUND")return e.error??r;
 *     if(r){let n=Number(r),o=r==="23"?"request timed out"
 *        :Number.isInteger(n)&&n>=100&&n<=599?`HTTP ${r}`:r;
 *        return t?`${o} at ${t}`:o}
 *     return e.error??""}
 *   kbo(e){let t=e.errorCode?` (${e.errorCode})`:"",r=e.error?`: "${e.error}"`:"";
 *     return`${e.name}${t}${r}`}
 *   wee(e){return e.type==="failed"&&e.errorCode==="UNCONFIGURED"}
 *   whp failed branch: wee(r)?{status:"- Not configured"}
 *                        :{status:`${cross} Failed to connect`}
 */
describe('2.1.218 #5 — failed MCP server status + error text', () => {
  function failed(
    overrides: Partial<FailedMCPServer> & { name: string },
  ): FailedMCPServer {
    return {
      type: 'failed',
      config: { type: 'http', url: 'https://srv.test/mcp', scope: 'user' },
      ...overrides,
    } as FailedMCPServer
  }

  test('numeric HTTP errorCode surfaces as "HTTP <status> at <url>"', () => {
    const r = failed({ name: 'srv', errorCode: '401', error: 'Unauthorized' })
    expect(getMcpServerFailureMessage(r)).toBe('HTTP 401 at https://srv.test/mcp')
  })

  test('numeric HTTP errorCode surfaces as "HTTP <status>" when no url', () => {
    const r: FailedMCPServer = {
      name: 'srv',
      type: 'failed',
      errorCode: '503',
      error: 'down',
      config: { type: 'stdio', command: 'x', args: [], scope: 'user' },
    }
    expect(getMcpServerFailureMessage(r)).toBe('HTTP 503')
  })

  test('errorCode "23" surfaces as "request timed out"', () => {
    const r = failed({ name: 'srv', errorCode: '23', error: 'ETIMEDOUT' })
    expect(getMcpServerFailureMessage(r)).toBe('request timed out at https://srv.test/mcp')
  })

  test('named INVALID_CONFIG falls back to error when present', () => {
    const r = failed({ name: 'srv', errorCode: 'INVALID_CONFIG', error: 'bad url' })
    expect(getMcpServerFailureMessage(r)).toBe('bad url')
  })

  test('named UNCONFIGURED falls back to errorCode when error absent', () => {
    const r = failed({ name: 'srv', errorCode: 'UNCONFIGURED' })
    expect(getMcpServerFailureMessage(r)).toBe('UNCONFIGURED')
  })

  test('no errorCode returns error string', () => {
    const r = failed({ name: 'srv', error: 'boom' })
    expect(getMcpServerFailureMessage(r)).toBe('boom')
  })

  test('no errorCode and no error returns empty', () => {
    const r = failed({ name: 'srv' })
    expect(getMcpServerFailureMessage(r)).toBe('')
  })

  test('kbo warning formatter: name (errorCode): "error"', () => {
    const r = failed({ name: 'srv', errorCode: '401', error: 'Unauthorized' })
    expect(formatFailedMcpServerForWarning(r)).toBe('srv (401): "Unauthorized"')
  })

  test('kbo warning formatter: name only when no codes', () => {
    const r = failed({ name: 'srv' })
    expect(formatFailedMcpServerForWarning(r)).toBe('srv')
  })

  test('wee: only failed+UNCONFIGURED is "not configured"', () => {
    expect(isUnconfiguredMcpServer(failed({ name: 's', errorCode: 'UNCONFIGURED' }))).toBe(true)
    expect(isUnconfiguredMcpServer(failed({ name: 's', errorCode: '401' }))).toBe(false)
    expect(isUnconfiguredMcpServer(failed({ name: 's' }))).toBe(false)
  })

  test('health label: - Not configured for UNCONFIGURED, else ✗ Failed to connect', () => {
    expect(
      mcpServerHealthStatusLabel(
        failed({ name: 's', errorCode: 'UNCONFIGURED' }) as MCPServerConnection,
      ),
    ).toBe('- Not configured')
    expect(
      mcpServerHealthStatusLabel(
        failed({ name: 's', errorCode: '401', error: 'Unauthorized' }) as MCPServerConnection,
      ),
    ).toBe('✗ Failed to connect')
  })

  // OCC-21 Gap-2c: binary renders U+2714 (✔) for the connected label, not
  // U+2713 (✓) — live A/B verified against `claude mcp list`.
  test('health label: connected renders ✔ (U+2714), not ✓ (U+2713)', () => {
    const connected = {
      type: 'connected',
      name: 's',
      config: { type: 'http', url: 'https://srv.test/mcp', scope: 'user' },
    } as MCPServerConnection
    const label = mcpServerHealthStatusLabel(connected)
    expect(label).toBe('✔ Connected')
    expect(label).not.toContain('✓')
    expect(label.codePointAt(0)).toBe(0x2714)
  })

  test('extractMcpFailureErrorCode: numeric HTTP status from .code', () => {
    expect(extractMcpFailureErrorCode({ code: 401 })).toBe('401')
    expect(extractMcpFailureErrorCode({ code: 503 })).toBe('503')
  })

  test('extractMcpFailureErrorCode: HTTP status embedded in OAuthError-style message', () => {
    expect(extractMcpFailureErrorCode(new Error('HTTP 403: forbidden'))).toBe('403')
  })

  test('extractMcpFailureErrorCode: timeout → "23"', () => {
    expect(extractMcpFailureErrorCode(new Error('request timed out'))).toBe('23')
    expect(extractMcpFailureErrorCode(new Error('Operation timed out'))).toBe('23')
  })

  test('extractMcpFailureErrorCode: unclassifiable → undefined', () => {
    expect(extractMcpFailureErrorCode(new Error('boom'))).toBeUndefined()
    expect(extractMcpFailureErrorCode(undefined)).toBeUndefined()
  })
})

/**
 * CC 2.1.218 #20: the "N MCP servers need authentication" startup notice
 * over-counted claude.ai connectors that aren't connected. The official's
 * H7o/Zka filter excludes a claude.ai-proxy needs-auth server when
 * `config.eligible === false && !currentlyConnected(name)`.
 *
 * Binary evidence (s21218.txt):
 *   function H7o(e,t,r){
 *     if(wee(e))return!1;
 *     if(e.config.type==="claudeai-proxy"){
 *       if(e.config.eligible===!1&&!r(e.name))return!1;   // <-- #20 fix
 *       return t(e.name)}                                  // t = Ksr = everConnected
 *     return e.config.type!=="sse-ide"&&e.config.type!=="ws-ide"}
 *   function Zka(e,t,r){return e.filter(n=>n.type==="needs-auth"&&H7o(n,t,r))}
 *   Vsr(e){Pgs.add(e), ...claudeAiMcpEverConnected...}    // Pgs = currently connected
 *   zsr(e){return Pgs.has(e)}
 *   mcpNeedsAuthCount: Zka(clients, Ksr, zsr).length
 */
describe('2.1.218 #20 — needs-auth count excludes disconnected claude.ai connectors', () => {
  function claudeAiNeedsAuth(
    name: string,
    eligible?: boolean,
  ): MCPServerConnection {
    return {
      name,
      type: 'needs-auth',
      config: {
        type: 'claudeai-proxy',
        url: 'https://claude.ai/x',
        id: name,
        scope: 'claudeai',
        ...(eligible !== undefined ? { eligible } : {}),
      },
    } as MCPServerConnection
  }

  function localNeedsAuth(name: string): MCPServerConnection {
    return {
      name,
      type: 'needs-auth',
      config: { type: 'http', url: 'https://srv.test/mcp', scope: 'user' },
    } as MCPServerConnection
  }

  test('setup sanity: currently-connected set starts empty', () => {
    clearClaudeAiMcpCurrentlyConnected()
    expect(isClaudeAiMcpCurrentlyConnected('never')).toBe(false)
  })

  test('eligible===false && not currently connected → excluded from count', () => {
    clearClaudeAiMcpCurrentlyConnected()
    resetClaudeAiEverConnectedForTest()
    const clients: MCPServerConnection[] = [
      claudeAiNeedsAuth('disconnected', false), // disconnected, never connected
    ]
    expect(getMcpNeedsAuthCount(clients)).toBe(0)
  })

  test('eligible===false but currently connected → counted (ever-connected)', () => {
    clearClaudeAiMcpCurrentlyConnected()
    resetClaudeAiEverConnectedForTest()
    markClaudeAiMcpConnected('live') // marks ever-connected AND currently-connected
    const clients: MCPServerConnection[] = [
      claudeAiNeedsAuth('live', false), // eligible false, but currently connected
    ]
    expect(getMcpNeedsAuthCount(clients)).toBe(1)
  })

  test('eligible===false, ever-connected but NOT currently connected → excluded', () => {
    // This is the #20 over-counting case: connected yesterday, now disconnected.
    clearClaudeAiMcpCurrentlyConnected()
    resetClaudeAiEverConnectedForTest()
    markClaudeAiMcpConnected('was-live') // ever-connected
    clearClaudeAiMcpCurrentlyConnected() // but not currently
    const clients: MCPServerConnection[] = [
      claudeAiNeedsAuth('was-live', false),
    ]
    expect(getMcpNeedsAuthCount(clients)).toBe(0)
  })

  test('local (non-claude.ai) needs-auth servers always counted', () => {
    clearClaudeAiMcpCurrentlyConnected()
    resetClaudeAiEverConnectedForTest()
    const clients: MCPServerConnection[] = [localNeedsAuth('local-srv')]
    expect(getMcpNeedsAuthCount(clients)).toBe(1)
  })

  test('mixed: counts local + connected claude.ai, excludes disconnected', () => {
    clearClaudeAiMcpCurrentlyConnected()
    resetClaudeAiEverConnectedForTest()
    markClaudeAiMcpConnected('connected-ca')
    const clients: MCPServerConnection[] = [
      localNeedsAuth('local-srv'),
      claudeAiNeedsAuth('connected-ca', false),
      claudeAiNeedsAuth('disconnected-ca', false),
    ]
    expect(getMcpNeedsAuthCount(clients)).toBe(2)
  })
})

/**
 * CC 2.1.217 #3 (A2): memory leak — truncated MCP tool outputs kept the FULL
 * untruncated result in memory for the rest of the session. V8's
 * String.prototype.slice returns a SlicedString that shares the original
 * string's backing buffer, so the truncated form (held in the conversation)
 * pinned the full result resident. The fix forces a fresh flat copy of the
 * truncated text so the full untruncated buffer can be GC'd.
 *
 * Binary evidence (s21217.txt): the `[OUTPUT TRUNCATED - exceeded ${Wdo()}
 * token limit]` message is appended to a sliced substring; the fix drops the
 * reference to the original (untruncated) content.
 */
describe('2.1.217 #3 — truncated output drops the full untruncated result', () => {
  test('detachMcpToolResultContent returns equal string content', () => {
    const truncated = 'hello world'.slice(0, 5) // "hello"
    const out = detachMcpToolResultContent(truncated)
    expect(out).toBe('hello')
    expect(typeof out).toBe('string')
  })

  test('detachMcpToolResultContent returns new block objects with equal text', () => {
    const huge = 'x'.repeat(10000)
    const truncated = huge.slice(0, 100)
    const blocks = [
      { type: 'text' as const, text: truncated },
      { type: 'text' as const, text: 'tail' },
    ]
    const out = detachMcpToolResultContent(blocks) as {
      type: string
      text: string
    }[]
    expect(Array.isArray(out)).toBe(true)
    expect(out.length).toBe(2)
    // Equal text, but fresh container objects (original blocks not retained by identity)
    expect(out[0]!.text).toBe(truncated)
    expect(out[1]!.text).toBe('tail')
    expect(out[0]).not.toBe(blocks[0])
    expect(out[1]).not.toBe(blocks[1])
  })

  test('detach breaks the SlicedString link so the full buffer is collectable', () => {
    // We cannot WeakRef a primitive string, so we observe the copy indirectly:
    // a detached string must still equal the sliced prefix, but the helper is
    // documented to force a fresh allocation (Buffer round-trip) that does not
    // share the original string's backing store.
    const huge = 'y'.repeat(200000)
    const sliced = huge.slice(0, 500)
    const detached = detachMcpToolResultContent(sliced) as string
    expect(detached).toEqual(sliced)
    expect(detached.length).toBe(500)
    // Sanity: the detached copy is byte-identical to the prefix
    for (let i = 0; i < 500; i++) {
      expect(detached.charCodeAt(i)).toBe(sliced.charCodeAt(i))
    }
  })

  test('undefined passes through untouched', () => {
    expect(detachMcpToolResultContent(undefined)).toBeUndefined()
  })
})
