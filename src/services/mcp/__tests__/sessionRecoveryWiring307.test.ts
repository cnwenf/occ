/**
 * claude-code 2.1.307 F-01 / 2.1.308 F-03 — wire the B3 session-recovery
 * renderer (official `z_`, renamed `ky` in v2.1.309) into the live
 * NON-retried session-expiry tool-result path, per non-retry REASON.
 *
 * Official call sites (linux ELF, byte-verified, never executed; v309
 * offsets, re-located by content — v307 equivalents in parens):
 *  - site 1, staged-SDK relay — `mcp_session_recovery` @277912896
 *    (@276618538): `ky({serverName:Se.serverName,error:ir,namesMcpCall:!1,
 *    detail:ir.message})` — no length cap (the `Qt`/`Jt` sanitizer inside
 *    `ky` bounds length).
 *  - site 2, mcp_call dispatch — `mcp_session_recovery` @277915059
 *    (@276620665): `At=ky({serverName:Se.serverName,error:ft,
 *    namesMcpCall:!0,detail:At}),ct(q,At.slice(0,2000).replace(
 *    /[\uD800-\uDBFF]$/,""))` — the " mcp_call" suffix + the 2000-char cap
 *    + trailing lone-high-surrogate strip.
 *  - `ky({serverName` has exactly 3 ELF hits: the definition @277681825
 *    (@276388222) plus those two relay sites — the renderer is relay-only
 *    in the official.
 *
 * Both official sites live in the CCR mcp_call / staged-SDK relay subsystem,
 * which OCC has NOT ported. OCC's live equivalent of the isError tool-result
 * production point is the fetchToolsForClient tool wrapper's non-retried
 * rethrow: toolExecution.ts catches it and surfaces `formatError(error)`
 * (= error.message) verbatim as the isError tool_result content. F-03 maps
 * OCC's two non-retry reasons onto the two official render shapes:
 * `may_have_run_no_retry` → site-1 shape (uncapped, no mcp_call suffix),
 * `session_retry_exhausted` → site-2 shape (mcp_call suffix, `.slice(0,2000)`
 * + lone-surrogate strip). These tests pin that the surfaced text is the
 * em-dash rendered `ky` output for BOTH kinds (connection_closed_http AND
 * session_expired_404), NOT the raw per-kind McpSessionExpiredError message,
 * while `instanceof` and the 'MCP session expired' telemetryMessage are
 * preserved.
 *
 * Also covers SEC-F1 (2.1.308): ensureConnectedClient's not-connected error
 * interpolates the Qt-sanitized server name, matching the official
 * `MCP server not connected: ${Qt(Se.serverName)}` precedent @277912512.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MCPServerConnection } from '../types.js'
import {
  renderSessionRecoveryDispatchText,
  renderSessionRecoveryResultText,
  sanitizeSessionRecoveryText,
} from '../sessionRecoveryText.js'
import { formatError } from '../../../utils/toolErrors.js'

// OCC-97 cross-file mock leak: the src/cli/handlers MCP suites each
// `mock.module('../client.js')` at their top level, and Bun evaluates every
// test file's top level before any afterAll restore runs — so a plain
// top-level `import { connectToServer } from '../client.js'` here binds the
// leaked fake (no `.cache`) and this suite crashes on `connectToServer.cache`.
// A cache-busted query specifier pulls a genuine, self-consistent client.js
// instance that no sibling mock intercepts (same remedy mcpGetDynamicScope285
// uses for config.js). All bindings come from that one instance, so the
// wrapper's internal connectToServer is the one this test seeds.
const {
  McpSessionExpiredError,
  connectToServer,
  ensureConnectedClient,
  fetchToolsForClient,
  getServerCacheKey,
} = await import('../client.js?occ-f01-real')

// ---------------------------------------------------------------------------
// Harness — a fake http connection whose callTool rejects with the SDK's
// transport-closed shape (code -32000 + "Connection closed"), driving the
// real callMCPTool → connection_closed_http classification → wrapper gate.
// The opts allow driving the OTHER classification branch instead: a 404 +
// JSON-RPC -32001 rejection on a connection WITH a sessionId classifies as
// session_expired_404 (mayHaveRun=false).
// ---------------------------------------------------------------------------

function connectionClosedError(): Error {
  return Object.assign(new Error('Connection closed'), { code: -32000 })
}

function staleSession404Error(): Error {
  // The StreamableHTTPError shape isMcpSessionExpiredError recognizes:
  // HTTP 404 + a JSON-RPC -32001 body in the message.
  return Object.assign(
    new Error(
      'HTTP 404: {"error":{"code":-32001,"message":"Session not found"}}',
    ),
    { code: 404 },
  )
}

interface FakeConnectionOpts {
  annotations?: Record<string, unknown>
  onCallTool?: () => void
  /** Override the callTool rejection (default: transport-closed shape). */
  callToolError?: () => Error
  /** When set, the fake carries `transport.sessionId` (staleness probe). */
  sessionId?: string
}

function makeFakeHttpConnection(
  name: string,
  opts: FakeConnectionOpts,
): MCPServerConnection {
  const config = {
    type: 'http',
    url: `https://${name}.invalid/mcp`,
    scope: 'user',
  }
  return {
    type: 'connected',
    name,
    capabilities: { tools: {} },
    config,
    ...(opts.sessionId === undefined
      ? {}
      : { transport: { sessionId: opts.sessionId } }),
    client: {
      request: async () => ({
        tools: [
          {
            name: 'danger',
            description: 'd',
            inputSchema: { type: 'object' },
            ...(opts.annotations === undefined
              ? {}
              : { annotations: opts.annotations }),
          },
        ],
      }),
      callTool: async () => {
        opts.onCallTool?.()
        throw opts.callToolError ? opts.callToolError() : connectionClosedError()
      },
    },
    cleanup: async () => {},
  } as unknown as MCPServerConnection
}

const RAW_HTTP_MESSAGE_FOR = (name: string): string =>
  `MCP server "${name}" connection closed before the tool call was answered. The tool may have run: check whether it did before running it again.`

// Official ky site-1 shape (namesMcpCall:!1, uncapped) — BIN309 @277912985.
const RENDERED_FOR = (name: string): string =>
  `MCP connection to ${name} closed during the call — send mcp_reconnect, and check whether the tool ran before retrying: ${RAW_HTTP_MESSAGE_FOR(name)}`

// Official ky site-2 shape (namesMcpCall:!0 + `.slice(0,2000).replace(
// /[\uD800-\uDBFF]$/,"")`) — BIN309 @277915112. Used for the
// session_retry_exhausted reason (2.1.308 F-03).
const RENDERED_DISPATCH_FOR = (name: string): string =>
  `MCP connection to ${name} closed during the call — send mcp_reconnect, and check whether the tool ran before retrying mcp_call: ${RAW_HTTP_MESSAGE_FOR(name)}`

const RAW_404_MESSAGE_FOR = (name: string): string =>
  `MCP server "${name}" session expired`

const RENDERED_404_DISPATCH_FOR = (name: string): string =>
  `MCP session expired for ${name} — send mcp_reconnect and retry mcp_call: ${RAW_404_MESSAGE_FOR(name)}`

interface Harness {
  callOnce: () => Promise<unknown>
  teardown: () => void
}

/**
 * Seeds the memoized connectToServer entry with the fake connection (so
 * ensureConnectedClient and clearServerCache never dial), neutralizes
 * cache.delete for the duration (clearServerCache runs mid-call and would
 * otherwise evict the seed before a retry attempt), and returns a function
 * that drives the real wrapper's call() end-to-end.
 */
async function makeHarness(
  name: string,
  opts: FakeConnectionOpts = {},
): Promise<Harness> {
  const fake = makeFakeHttpConnection(name, opts)
  const config = (fake as unknown as { config: unknown }).config
  const key = getServerCacheKey(name, config as never)
  const cache = connectToServer.cache as unknown as {
    set: (k: string, v: Promise<MCPServerConnection>) => unknown
    delete: (k: string) => unknown
  }
  const realDelete = cache.delete.bind(cache)
  // clearServerCache (invoked by the real session-expiry path) deletes the
  // seed; neutralize so the retry attempt's ensureConnectedClient re-hits it.
  cache.delete = () => true
  cache.set(key, Promise.resolve(fake))
  fetchToolsForClient.cache.delete(name)
  const tools = await fetchToolsForClient(fake)
  fetchToolsForClient.cache.delete(name)

  const tool = tools[0]!
  const context = {
    abortController: new AbortController(),
    setAppState: () => {},
    getAppState: () => undefined,
  }
  const parentMessage = { message: { content: [] } }

  return {
    callOnce: () =>
      tool.call(
        {} as never,
        context as never,
        undefined as never,
        parentMessage as never,
        undefined,
      ),
    teardown: () => {
      cache.delete = realDelete
      realDelete(key)
      fetchToolsForClient.cache.delete(name)
    },
  }
}

// ---------------------------------------------------------------------------
// Integration — the wrapper's non-retried rethrow surfaces the rendered text
// ---------------------------------------------------------------------------

describe('2.1.307 F-01 session-recovery renderer wiring', () => {
  test('a non-retried may-have-run expiry surfaces the em-dash rendered text, not the raw message', async () => {
    // Arrange — no annotations → not concurrency-safe → the official gate
    // (`!mayHaveRun || readOnlyHint || idempotentHint===!0`) refuses the retry.
    const name = 'srv-f01-noretry'
    const harness = await makeHarness(name)

    try {
      // Act
      let caught: unknown
      try {
        await harness.callOnce()
      } catch (error) {
        caught = error
      }

      // Assert — the thrown error keeps its identity/telemetry but carries
      // the official z_ rendered message (site-1 shape, namesMcpCall:false).
      expect(caught).toBeInstanceOf(McpSessionExpiredError)
      const expired = caught as {
        expiryKind: string
        mayHaveRun: boolean
        telemetryMessage: string
        message: string
      }
      expect(expired.expiryKind).toBe('connection_closed_http')
      expect(expired.mayHaveRun).toBe(true)
      expect(expired.telemetryMessage).toBe('MCP session expired')
      expect(expired.message).toBe(RENDERED_FOR(name))
      expect(expired.message).not.toBe(RAW_HTTP_MESSAGE_FOR(name))
      expect(expired.message).toContain('—')
      // The renderer agrees with the direct z_ port, and the live isError
      // tool-result producer (toolExecution's formatError) surfaces it verbatim.
      expect(expired.message).toBe(
        renderSessionRecoveryResultText({
          serverName: name,
          error: new McpSessionExpiredError(name, 'connection_closed_http'),
          namesMcpCall: false,
          detail: RAW_HTTP_MESSAGE_FOR(name),
        }),
      )
      expect(formatError(expired)).toBe(RENDERED_FOR(name))
    } finally {
      harness.teardown()
    }
  })

  test('a retry-exhausted expiry on a concurrency-safe tool surfaces the site-2 dispatch text', async () => {
    // Arrange — readOnlyHint tool: attempt 0 passes the gate and retries,
    // attempt 1 hits the cap → session_retry_exhausted → rendered with the
    // official ky SITE-2 shape (namesMcpCall:!0 + slice(0,2000) + trailing
    // lone-surrogate strip, BIN309 @277915112), NOT the uncapped site-1
    // shape (2.1.308 F-03).
    const name = 'srv-f01-exhausted'
    let callToolCalls = 0
    const harness = await makeHarness(name, {
      annotations: { readOnlyHint: true },
      onCallTool: () => {
        callToolCalls++
      },
    })

    try {
      // Act
      let caught: unknown
      try {
        await harness.callOnce()
      } catch (error) {
        caught = error
      }

      // Assert — identity/telemetry preserved; message is the site-2 render.
      expect(callToolCalls).toBe(2)
      expect(caught).toBeInstanceOf(McpSessionExpiredError)
      const expired = caught as { expiryKind: string; message: string }
      expect(expired.expiryKind).toBe('connection_closed_http')
      expect(expired.message).toBe(RENDERED_DISPATCH_FOR(name))
      expect(expired.message).not.toBe(RENDERED_FOR(name))
      expect(expired.message).toBe(
        renderSessionRecoveryDispatchText({
          serverName: name,
          error: new McpSessionExpiredError(name, 'connection_closed_http'),
          detail: RAW_HTTP_MESSAGE_FOR(name),
        }),
      )
      expect(formatError(caught)).toBe(RENDERED_DISPATCH_FOR(name))
    } finally {
      harness.teardown()
    }
  })

  test('a retry-exhausted session_expired_404 (mayHaveRun=false) drives the full retry→exhausted→site-2 wiring', async () => {
    // Arrange — 2.1.308 F-07: the mayHaveRun=false branch end-to-end. A
    // stale-session 404 (sessionId present at call entry → the official
    // staleness gate flips) passes the retry gate UNCONDITIONALLY at
    // attempt 0 (`!mayHaveRun`), retries, hits the cap at attempt 1 →
    // session_retry_exhausted → site-2 render of the "session expired for"
    // variant with the mcp_call suffix.
    const name = 'srv-f07-404'
    let callToolCalls = 0
    const harness = await makeHarness(name, {
      sessionId: 'stale-sid-1',
      callToolError: staleSession404Error,
      onCallTool: () => {
        callToolCalls++
      },
    })

    try {
      // Act
      let caught: unknown
      try {
        await harness.callOnce()
      } catch (error) {
        caught = error
      }

      // Assert — one retry happened (gate passed for mayHaveRun=false).
      expect(callToolCalls).toBe(2)
      expect(caught).toBeInstanceOf(McpSessionExpiredError)
      const expired = caught as {
        expiryKind: string
        mayHaveRun: boolean
        telemetryMessage: string
        message: string
      }
      expect(expired.expiryKind).toBe('session_expired_404')
      expect(expired.mayHaveRun).toBe(false)
      expect(expired.telemetryMessage).toBe('MCP session expired')
      expect(expired.message).toBe(RENDERED_404_DISPATCH_FOR(name))
      expect(expired.message).not.toBe(RAW_404_MESSAGE_FOR(name))
      expect(expired.message).toBe(
        renderSessionRecoveryDispatchText({
          serverName: name,
          error: new McpSessionExpiredError(name, 'session_expired_404'),
          detail: RAW_404_MESSAGE_FOR(name),
        }),
      )
      expect(formatError(caught)).toBe(RENDERED_404_DISPATCH_FOR(name))
    } finally {
      harness.teardown()
    }
  })

  test('renderSessionRecoveryResultText has at least one production importer (dead-code guard)', () => {
    // Arrange — walk src/, excluding test files and the defining module
    // (menuDescription307 pin-test precedent: the renderer must not regress
    // to zero production callers).
    const srcDir = join(import.meta.dir, '..', '..', '..')
    const productionFiles: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') {
            continue
          }
          walk(full)
        } else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          !/\.test\.(ts|tsx)$/.test(entry.name) &&
          full !== join(srcDir, 'services', 'mcp', 'sessionRecoveryText.ts')
        ) {
          productionFiles.push(full)
        }
      }
    }
    walk(srcDir)

    // Act
    const importers = productionFiles.filter(file =>
      readFileSync(file, 'utf8').includes('renderSessionRecoveryResultText'),
    )

    // Assert
    expect(importers.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// SEC-F1 (2.1.308) — ensureConnectedClient's not-connected error interpolates
// the raw client.name. The official sanitizes the name at the equivalent
// site: `MCP server not connected: ${Qt(Se.serverName)}` (BIN309
// @277912512; `Qt` = sanitizeSessionRecoveryText, @240114090). A hostile
// server name (lone surrogates, invisibles) must not reach the surfaced
// message / telemetry verbatim.
// ---------------------------------------------------------------------------

describe('2.1.308 SEC-F1 ensureConnectedClient sanitized server name', () => {
  test('interpolates the Qt-sanitized name into the not-connected error', async () => {
    // Arrange — seed a FAILED connection under a hostile name so
    // ensureConnectedClient hits the not-connected throw.
    const evilName = 'evil\u200Bsrv\uD800name'
    const config = {
      type: 'http',
      url: 'https://evil.invalid/mcp',
      scope: 'user',
    }
    const key = getServerCacheKey(evilName, config as never)
    const cache = connectToServer.cache as unknown as {
      set: (k: string, v: Promise<MCPServerConnection>) => unknown
      delete: (k: string) => unknown
    }
    cache.set(
      key,
      Promise.resolve({
        type: 'failed',
        name: evilName,
        config,
        error: 'dial failed',
      } as unknown as MCPServerConnection),
    )

    try {
      // Act
      let caught: unknown
      try {
        await ensureConnectedClient({ name: evilName, config } as never)
      } catch (error) {
        caught = error
      }

      // Assert — the message carries the sanitized name only.
      const message = (caught as Error).message
      expect(message).toBe(
        `MCP server "${sanitizeSessionRecoveryText(evilName)}" is not connected`,
      )
      expect(message).toBe('MCP server "evilsrvname" is not connected')
      expect(message).not.toContain('\u200B')
      expect(message).not.toContain('\uD800')
      expect((caught as { telemetryMessage?: string }).telemetryMessage).toBe(
        'MCP server not connected',
      )
    } finally {
      cache.delete(key)
    }
  })
})
