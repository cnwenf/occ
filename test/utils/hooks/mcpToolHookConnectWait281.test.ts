import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { MCPServerConnection } from '../../../src/services/mcp/types.js'
import type { MCPToolHook } from '../../../src/schemas/hooks.js'

/**
 * CC 2.1.281 (#052): `mcp_tool` hooks on a BLOCKING hook event must give a
 * configured-but-still-connecting MCP server time to finish connecting instead
 * of skipping immediately.
 *
 * Byte-verified against the official 2.1.281 linux-x64 ELF
 * (/tmp/cc-diff-281/vver/package/claude); 0 hits for every one of these
 * strings in the 2.1.280 ELF:
 *
 *   `KRe()` wait block @202571803:
 *     if (N?.type === "pending" && !TTt.has(n)) {
 *       let ve = Math.min(w, Rl())
 *       t(`Hooks: mcp_tool hook for ${n} is waiting up to ${ve}ms (less if the
 *          server is retrying) for MCP server '${e.server}' to finish connecting`)
 *       let Ee = Date.now(), xe = await Pgo(e.server, ve, g)
 *       if (g?.aborted) return {ok:!1, body:"", aborted:!0}
 *       let Pe = Date.now() - Ee
 *       if (xe) N = xe, t(`Hooks: MCP server '${e.server}' is now ${xe.type} after ${Pe}ms`)
 *       else t(Pe < NIt
 *              ? `Hooks: no live MCP client list tracks '${e.server}'; not waiting for it`
 *              : `Hooks: stopped waiting for MCP server '${e.server}' after ${Pe}ms; it has not connected`,
 *            {level:"warn"})
 *     }
 *
 *   `Pgo()` poll loop + constants @202573286:
 *     var NIt = 50, Ago = 5000
 *     for (;;) {
 *       let h = bk()?.find(w => w.name === e)
 *       if (h === void 0 || h.type !== "pending") return h
 *       if (!g && h.reconnectAttempt !== void 0) s = Math.min(s, Date.now() + Ago), g = true
 *       let _ = s - Date.now()
 *       if (_ <= 0 || r?.aborted) return
 *       await Z(Math.min(NIt, _), r)
 *     }
 *
 *   `TTt` non-blocking-event set @198876780 (19 members).
 *   `Rl()` MCP connect timeout @ (MCP_TIMEOUT > 0 ? min(_, 2^31-1) : 30000).
 *   `Es(e) => e.type === "connected" || e.type === "cached"` @193498344.
 */

// ---- debug-log capture (OCC-97 mock-leak discipline: spread + restore) ----

const debugCalls: Array<{ message: string; level: string }> = []

const actualDebug = { ...(await import('../../../src/utils/debug.js')) }
mock.module('../../../src/utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    debugCalls.push({ message, level: opts?.level ?? 'debug' })
  },
}))

afterAll(() => {
  mock.module('../../../src/utils/debug.js', () => ({ ...actualDebug }))
})

const { execMcpToolHook, setMcpHookClientContext } = await import(
  '../../../src/utils/hooks/execMcpToolHook.js'
)

// ---- fixtures ----

/** Binary `TTt` @198876780 — verbatim, in ELF order. */
const NON_BLOCKING_EVENTS = [
  'Notification',
  'SessionStart',
  'SessionEnd',
  'Setup',
  'StopFailure',
  'SubagentStart',
  'PostToolUseFailure',
  'PostCompact',
  'PostModelSwitch',
  'PermissionDenied',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'MessageDisplay',
  'StatusLine',
  'FileSuggestion',
] as const

const BLOCKING_EVENT = 'PreToolUse'

type CallToolFn = (params: unknown, schema: unknown, opts: unknown) => Promise<unknown>

function pendingServer(
  name: string,
  extra: { reconnectAttempt?: number } = {},
): MCPServerConnection {
  return {
    name,
    type: 'pending',
    config: {},
    ...extra,
  } as unknown as MCPServerConnection
}

function connectedServer(name: string, callTool: CallToolFn): MCPServerConnection {
  return {
    name,
    type: 'connected',
    config: {},
    capabilities: {},
    cleanup: async () => {},
    client: { callTool },
  } as unknown as MCPServerConnection
}

function failedServer(name: string): MCPServerConnection {
  return { name, type: 'failed', config: {} } as unknown as MCPServerConnection
}

function mcpHook(server: string, timeout?: number): MCPToolHook {
  return {
    type: 'mcp_tool',
    server,
    tool: 'do_thing',
    ...(timeout === undefined ? {} : { timeout }),
  } as unknown as MCPToolHook
}

function okCallTool(seen: unknown[], body = 'tool-ok'): CallToolFn {
  return async (params) => {
    seen.push(params)
    return { content: [{ type: 'text', text: body }] }
  }
}

/** Replace the contents of a live client list in place (it's a live list). */
function setLiveClients(live: MCPServerConnection[], next: MCPServerConnection[]): void {
  live.splice(0, live.length, ...next)
}

function findDebug(fragment: string): { message: string; level: string } | undefined {
  return debugCalls.find((entry) => entry.message.includes(fragment))
}

const DEFAULT_TIMEOUT_MS = 60_000

let savedMcpTimeout: string | undefined

beforeEach(() => {
  savedMcpTimeout = process.env.MCP_TIMEOUT
  debugCalls.length = 0
})

afterEach(() => {
  if (savedMcpTimeout === undefined) delete process.env.MCP_TIMEOUT
  else process.env.MCP_TIMEOUT = savedMcpTimeout
  setMcpHookClientContext(undefined)
  debugCalls.length = 0
})

// ---- tests ----

describe('CC 2.1.281 #052 mcp_tool connect wait — blocking events', () => {
  test('waits for a pending server and runs the tool once the live list reports it connected', async () => {
    const seen: unknown[] = []
    const live: MCPServerConnection[] = [pendingServer('srv')]
    setMcpHookClientContext(() => ({ mcpClients: live }))
    const flip = setTimeout(
      () => setLiveClients(live, [connectedServer('srv', okCallTool(seen))]),
      120,
    )

    const result = await execMcpToolHook({
      hook: mcpHook('srv'),
      hookEvent: BLOCKING_EVENT,
      jsonInput: '{}',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      // Caller snapshot is stale-pending: only the LIVE list can observe the flip.
      mcpClients: [pendingServer('srv')],
    })
    clearTimeout(flip)

    expect(result.outcome).toBe('success')
    expect(seen.length).toBe(1)
    expect(findDebug('is waiting up to')).toBeDefined()
    expect(
      debugCalls.some((entry) =>
        /^Hooks: MCP server 'srv' is now connected after \d+ms$/.test(entry.message),
      ),
    ).toBe(true)
  })

  test('wait budget is min(hook timeout, MCP connect timeout) with binary-exact wording', async () => {
    process.env.MCP_TIMEOUT = '500'
    const live: MCPServerConnection[] = [pendingServer('srv')]
    setMcpHookClientContext(() => ({ mcpClients: live }))

    await execMcpToolHook({
      hook: mcpHook('srv'),
      hookEvent: BLOCKING_EVENT,
      jsonInput: '{}',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      mcpClients: [pendingServer('srv')],
    })

    expect(findDebug('is waiting up to')?.message).toBe(
      `Hooks: mcp_tool hook for ${BLOCKING_EVENT} is waiting up to 500ms (less if the server is retrying) for MCP server 'srv' to finish connecting`,
    )
  })

  test('a per-hook timeout bounds the wait below the MCP connect timeout', async () => {
    process.env.MCP_TIMEOUT = '5000'
    const live: MCPServerConnection[] = [pendingServer('srv')]
    setMcpHookClientContext(() => ({ mcpClients: live }))

    await execMcpToolHook({
      hook: mcpHook('srv', 1), // 1s in the hook config
      hookEvent: BLOCKING_EVENT,
      jsonInput: '{}',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      mcpClients: [pendingServer('srv')],
    })

    expect(findDebug('is waiting up to')?.message).toContain('is waiting up to 1000ms')
  })

  test('no live MCP client list ⇒ declines to wait with the binary guard message', async () => {
    // Accessor not registered (OCC's MCP layer does not wire it yet): the poll
    // resolves to nothing on the first tick, i.e. under one 50ms interval.
    setMcpHookClientContext(undefined)
    const started = Date.now()

    const result = await execMcpToolHook({
      hook: mcpHook('srv'),
      hookEvent: BLOCKING_EVENT,
      jsonInput: '{}',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      mcpClients: [pendingServer('srv')],
    })
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(50)
    expect(result.outcome).toBe('non_blocking_error')
    expect(findDebug('no live MCP client list tracks')).toEqual({
      message: `Hooks: no live MCP client list tracks 'srv'; not waiting for it`,
      level: 'warn',
    })
    // Falls through to the pre-existing skip warning, wording unchanged.
    expect(findDebug('not connected')).toEqual({
      message: `Hooks: mcp_tool hook skipped — MCP server 'srv' not connected`,
      level: 'warn',
    })
  })

  test('a server that never connects exhausts the budget and warns "it has not connected"', async () => {
    process.env.MCP_TIMEOUT = '120'
    const live: MCPServerConnection[] = [pendingServer('srv')]
    setMcpHookClientContext(() => ({ mcpClients: live }))
    const started = Date.now()

    const result = await execMcpToolHook({
      hook: mcpHook('srv'),
      hookEvent: BLOCKING_EVENT,
      jsonInput: '{}',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      mcpClients: [pendingServer('srv')],
    })
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(3000)
    expect(result.outcome).toBe('non_blocking_error')
    const warn = findDebug('it has not connected')
    expect(warn?.level).toBe('warn')
    expect(warn?.message).toMatch(
      /^Hooks: stopped waiting for MCP server 'srv' after \d+ms; it has not connected$/,
    )
  })

  test('a retrying server caps the wait at 5000ms (binary `Ago`) even with a 60s connect timeout', async () => {
    process.env.MCP_TIMEOUT = '60000'
    const live: MCPServerConnection[] = [pendingServer('srv', { reconnectAttempt: 1 })]
    setMcpHookClientContext(() => ({ mcpClients: live }))
    const started = Date.now()

    const result = await execMcpToolHook({
      hook: mcpHook('srv'),
      hookEvent: BLOCKING_EVENT,
      jsonInput: '{}',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      mcpClients: [pendingServer('srv')],
    })
    const elapsed = Date.now() - started

    expect(result.outcome).toBe('non_blocking_error')
    // Bounded by Ago=5000, not by min(60000, 60000).
    expect(elapsed).toBeGreaterThanOrEqual(4900)
    expect(elapsed).toBeLessThan(9000)
    expect(findDebug('it has not connected')).toBeDefined()
  }, 15_000)

  test('the wait stops as soon as the live list reports a non-pending state (failed)', async () => {
    const live: MCPServerConnection[] = [pendingServer('srv')]
    setMcpHookClientContext(() => ({ mcpClients: live }))
    const flip = setTimeout(() => setLiveClients(live, [failedServer('srv')]), 80)

    const result = await execMcpToolHook({
      hook: mcpHook('srv'),
      hookEvent: BLOCKING_EVENT,
      jsonInput: '{}',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      mcpClients: [pendingServer('srv')],
    })
    clearTimeout(flip)

    expect(result.outcome).toBe('non_blocking_error')
    expect(
      debugCalls.some((entry) =>
        /^Hooks: MCP server 'srv' is now failed after \d+ms$/.test(entry.message),
      ),
    ).toBe(true)
    expect(findDebug('not connected')).toBeDefined()
  })

  test('an abort during the wait skips the tool call', async () => {
    process.env.MCP_TIMEOUT = '5000'
    const seen: unknown[] = []
    const live: MCPServerConnection[] = [pendingServer('srv')]
    setMcpHookClientContext(() => ({ mcpClients: live }))
    const controller = new AbortController()
    const abort = setTimeout(() => controller.abort(), 80)

    const result = await execMcpToolHook({
      hook: mcpHook('srv'),
      hookEvent: BLOCKING_EVENT,
      jsonInput: '{}',
      signal: controller.signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      mcpClients: [pendingServer('srv')],
    })
    clearTimeout(abort)

    expect(result.outcome).toBe('non_blocking_error')
    expect(seen.length).toBe(0)
    setLiveClients(live, [connectedServer('srv', okCallTool(seen))])
    expect(seen.length).toBe(0)
  })

  test('a server missing from the caller snapshot is re-resolved from the live list', async () => {
    const seen: unknown[] = []
    const live: MCPServerConnection[] = [connectedServer('srv', okCallTool(seen))]
    setMcpHookClientContext(() => ({ mcpClients: live }))

    const result = await execMcpToolHook({
      hook: mcpHook('srv'),
      hookEvent: BLOCKING_EVENT,
      jsonInput: '{}',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      mcpClients: [connectedServer('other', okCallTool([]))],
    })

    expect(result.outcome).toBe('success')
    expect(seen.length).toBe(1)
    expect(findDebug('is waiting up to')).toBeUndefined()
  })

  test('an already-connected server never waits (no regression)', async () => {
    const seen: unknown[] = []
    const server = connectedServer('srv', okCallTool(seen, 'already-up'))
    setMcpHookClientContext(() => ({ mcpClients: [server] }))

    const result = await execMcpToolHook({
      hook: mcpHook('srv'),
      hookEvent: BLOCKING_EVENT,
      jsonInput: '{}',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      mcpClients: [server],
    })

    expect(result.outcome).toBe('success')
    expect(result.message?.type).toBe('attachment')
    expect(findDebug('is waiting up to')).toBeUndefined()
    expect(seen.length).toBe(1)
  })
})

describe('CC 2.1.281 #052 mcp_tool connect wait — non-blocking events (binary `TTt`)', () => {
  // Every member of the v281 TTt set keeps the pre-281 immediate skip.
  for (const event of NON_BLOCKING_EVENTS) {
    test(`${event} skips immediately without waiting`, async () => {
      process.env.MCP_TIMEOUT = '5000'
      const live: MCPServerConnection[] = [pendingServer('srv')]
      setMcpHookClientContext(() => ({ mcpClients: live }))
      const started = Date.now()

      const result = await execMcpToolHook({
        hook: mcpHook('srv'),
        hookEvent: event,
        jsonInput: '{}',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        mcpClients: [pendingServer('srv')],
      })
      const elapsed = Date.now() - started

      expect(elapsed).toBeLessThan(50)
      expect(result.outcome).toBe('non_blocking_error')
      expect(findDebug('is waiting up to')).toBeUndefined()
      expect(findDebug('no live MCP client list tracks')).toBeUndefined()
      expect(findDebug('not connected')).toEqual({
        message: `Hooks: mcp_tool hook skipped — MCP server 'srv' not connected`,
        level: 'warn',
      })
    })
  }

  test('the TTt set has exactly the 19 v281 members', () => {
    expect(NON_BLOCKING_EVENTS.length).toBe(19)
  })
})
