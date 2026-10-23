/**
 * claude-code 2.1.307 F-01 — wire the B3 session-recovery renderer (official
 * `z_`) into the live NON-retried session-expiry tool-result path.
 *
 * Official call sites (linux ELF, byte-verified, never executed):
 *  - staged SDK relay @276618538: `catch(mr){if(mr instanceof kk)
 *    ae.markNeedsAuth(mr.serverName);if(mr instanceof SO)return
 *    m("mcp_session_recovery","session_expired_no_retry"),{isError:!0,
 *    content:[{type:"text",text:z_({serverName:we.serverName,error:mr,
 *    namesMcpCall:!1,detail:mr.message})}]};throw mr}` — no length cap (the
 *    `Jt` sanitizer inside `z_` bounds length).
 *  - mcp_call dispatch @276620665: `z_({...namesMcpCall:!0,detail:At})` then
 *    `.slice(0,2000).replace(/[\uD800-\uDBFF]$/,"")`.
 *  - `z_({serverName` has exactly 3 ELF hits: the definition @276388222 plus
 *    those two relay sites — the renderer is relay-only in the official.
 *
 * Both official sites live in the CCR mcp_call / staged-SDK relay subsystem,
 * which OCC has NOT ported. OCC's live equivalent of the isError tool-result
 * production point is the fetchToolsForClient tool wrapper's non-retried
 * rethrow: toolExecution.ts catches it and surfaces `formatError(error)`
 * (= error.message) verbatim as the isError tool_result content. These tests
 * pin that the surfaced text is the em-dash rendered `z_` output, NOT the raw
 * per-kind McpSessionExpiredError message, while `instanceof` and the
 * 'MCP session expired' telemetryMessage are preserved.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MCPServerConnection } from '../types.js'
import { renderSessionRecoveryResultText } from '../sessionRecoveryText.js'
import { formatError } from '../../../utils/toolErrors.js'

// OCC-97 cross-file mock leak: the src/cli/handlers MCP suites each
// `mock.module('../client.js')` at their top level, and Bun evaluates every
// test file's top level before any afterAll restore runs — so a plain
// top-level `import { connectToServer } from '../client.js'` here binds the
// leaked fake (no `.cache`) and this suite crashes on `connectToServer.cache`.
// A cache-busted query specifier pulls a genuine, self-consistent client.js
// instance that no sibling mock intercepts (same remedy mcpGetDynamicScope285
// uses for config.js). All four bindings come from that one instance, so the
// wrapper's internal connectToServer is the one this test seeds.
const {
  McpSessionExpiredError,
  connectToServer,
  fetchToolsForClient,
  getServerCacheKey,
} = await import('../client.js?occ-f01-real')

// ---------------------------------------------------------------------------
// Harness — a fake http connection whose callTool rejects with the SDK's
// transport-closed shape (code -32000 + "Connection closed"), driving the
// real callMCPTool → connection_closed_http classification → wrapper gate.
// ---------------------------------------------------------------------------

function connectionClosedError(): Error {
  return Object.assign(new Error('Connection closed'), { code: -32000 })
}

function makeFakeHttpConnection(
  name: string,
  opts: { annotations?: Record<string, unknown>; onCallTool?: () => void },
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
        throw connectionClosedError()
      },
    },
    cleanup: async () => {},
  } as unknown as MCPServerConnection
}

const RAW_HTTP_MESSAGE_FOR = (name: string): string =>
  `MCP server "${name}" connection closed before the tool call was answered. The tool may have run: check whether it did before running it again.`

const RENDERED_FOR = (name: string): string =>
  `MCP connection to ${name} closed during the call — send mcp_reconnect, and check whether the tool ran before retrying: ${RAW_HTTP_MESSAGE_FOR(name)}`

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
  opts: { annotations?: Record<string, unknown>; onCallTool?: () => void } = {},
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

  test('a retry-exhausted expiry on a concurrency-safe tool also surfaces the rendered text', async () => {
    // Arrange — readOnlyHint tool: attempt 0 passes the gate and retries,
    // attempt 1 hits the cap → session_retry_exhausted → still z_-rendered
    // (the official relay renders EVERY non-retried SO it receives).
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

      // Assert
      expect(callToolCalls).toBe(2)
      expect(caught).toBeInstanceOf(McpSessionExpiredError)
      expect((caught as Error).message).toBe(RENDERED_FOR(name))
      expect(formatError(caught)).toBe(RENDERED_FOR(name))
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
