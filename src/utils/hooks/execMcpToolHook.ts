/**
 * 2.1.118: mcp_tool hook execution — a hook can invoke an MCP tool on an
 * already-configured server. Matches the official 2.1.200 binary (SWo),
 * plus the 2.1.281 connect-wait (binary `KRe` / `Pgo`).
 *
 * Flow (binary: SWo → 2.1.281 `KRe`):
 *   1. Resolve the MCP client context (toolUseContext.mcpClients, or the
 *      module-level fallback set by setMcpHookClientContext).
 *   2. Find the named server; re-resolve from the live accessor when a
 *      caller-provided snapshot didn't contain it.
 *   2b. 2.1.281 (#052): on a BLOCKING hook event, if the server is still
 *      `pending`, poll the live client list until it connects or the wait
 *      budget runs out — instead of skipping immediately.
 *   3. Skip with a warning if still not connected.
 *   4. Interpolate ${path} expressions in `input` against the hook input JSON.
 *   5. callTool({name, arguments}, {signal, timeout: remaining budget}).
 *   6. Flatten the result content to text (text blocks → text, others →
 *      `[${type}]`), joined by newlines.
 *
 * Error/warning wording is binary-exact (byte-verified against the official
 * 2.1.281 linux-x64 ELF).
 */

import type { MCPServerConnection } from '../../services/mcp/types.js'
import { logForDebugging } from '../debug.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { parseEnvInt } from '../envValidation.js'
import { jsonStringify } from '../slowOperations.js'
import { sleep } from '../sleep.js'
import type { MCPToolHook } from '../../schemas/hooks.js'
import type { HookEvent } from '../../entrypoints/agentSdkTypes.js'
import type { HookResultMessage } from '../../types/message.js'

// Module-level MCP client context getter (binary: sIr/aje; 2.1.281 `bk()`).
// Set by the MCP connection layer so mcp_tool hooks can resolve servers even
// for events that lack a toolUseContext (e.g. SessionStart). Undefined when no
// session has wired it up — mcp_tool hooks then skip with the binary-exact
// warning.
//
// 2.1.281: this is also the LIVE list the connect-wait polls. The binary's
// `Pgo()` re-reads `bk()` every tick because the list mutates as servers
// connect; when the accessor is not registered the wait declines immediately
// with the binary's "no live MCP client list tracks …" guard.
type McpClientContext = {
  mcpClients?: ReadonlyArray<MCPServerConnection>
}
let mcpClientContextGetter: (() => McpClientContext | undefined) | undefined

export type McpClientContextGetter = () => McpClientContext | undefined

export function setMcpHookClientContext(
  getter: McpClientContextGetter | undefined,
): void {
  mcpClientContextGetter = getter
}

export function getMcpHookClientContext(): McpClientContext | undefined {
  return mcpClientContextGetter?.()
}

/**
 * Raw registered accessor (identity, not invoked). Lets a registrant restore
 * the previous registration on teardown without clobbering a newer one —
 * e.g. a subagent QueryEngine closing while the parent REPL engine is live.
 */
export function getMcpHookClientContextGetter(): McpClientContextGetter | undefined {
  return mcpClientContextGetter
}

/**
 * 2.1.281 (#052) binary `TTt` @198876780 — hook events that never block the
 * agent loop. An `mcp_tool` hook on one of these keeps the pre-281 behavior
 * (skip immediately when the server isn't connected); every other event is
 * blocking and waits for a still-connecting server. Byte-verified: 19 members,
 * 0 hits in the 2.1.280 ELF.
 */
const NON_BLOCKING_HOOK_EVENTS: ReadonlySet<string> = new Set([
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
])

/** Binary `NIt` — connect-wait poll interval (ms). */
const CONNECT_WAIT_POLL_INTERVAL_MS = 50

/**
 * Binary `Ago` — once the pending server reports a `reconnectAttempt`, the
 * wait deadline is pulled in to at most this much longer (the "less if the
 * server is retrying" clause of the wait log).
 */
const CONNECT_WAIT_RETRY_CAP_MS = 5000

/** Binary `Rl()` default — MCP_TIMEOUT fallback (ms). */
const MCP_CONNECT_TIMEOUT_DEFAULT_MS = 30000

/** Binary `Rl()` clamp — the largest value setTimeout accepts. */
const MAX_TIMER_MS = 2147483647

/**
 * MCP connection timeout (binary `Rl()`): `MCP_TIMEOUT` in ms when positive,
 * clamped to the max timer value, else 30s. Bounds the connect wait so a hook
 * never outlives the connection attempt it is waiting on.
 */
function getMcpConnectTimeoutMs(): number {
  const configured = parseEnvInt(process.env.MCP_TIMEOUT)
  if (configured === undefined || configured <= 0) {
    return MCP_CONNECT_TIMEOUT_DEFAULT_MS
  }
  return Math.min(configured, MAX_TIMER_MS)
}

/**
 * Poll the LIVE client list until the named server leaves `pending`
 * (binary `Pgo(serverName, budgetMs, signal)`).
 *
 * Returns the resolved connection (connected / failed / …) as soon as the live
 * list reports one, or `undefined` when the budget expired, the signal aborted,
 * or no live list tracks the server at all — the caller distinguishes the last
 * case by how little time elapsed.
 */
async function waitForMcpServerToConnect(
  serverName: string,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<MCPServerConnection | undefined> {
  let deadline = Date.now() + budgetMs
  let retryCapped = false
  for (;;) {
    const current = getMcpHookClientContext()?.mcpClients?.find(
      client => client.name === serverName,
    )
    // Gone from the live list, or no longer connecting → stop polling.
    if (current === undefined || current.type !== 'pending') return current
    // A retrying server gets a shorter leash (once).
    if (!retryCapped && current.reconnectAttempt !== undefined) {
      deadline = Math.min(deadline, Date.now() + CONNECT_WAIT_RETRY_CAP_MS)
      retryCapped = true
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0 || signal?.aborted) return undefined
    await sleep(
      Math.min(CONNECT_WAIT_POLL_INTERVAL_MS, remainingMs),
      signal,
    )
  }
}

// Recursively interpolate ${path} expressions in the input object against the
// hook input JSON (binary: P8f). Dotted paths resolve into the JSON tree;
// unresolved / null → empty string; objects → JSON-stringified.
function interpolateInput(
  input: Record<string, unknown>,
  hookInputJson: unknown,
): Record<string, unknown> {
  const resolvePath = (path: string): unknown => {
    let cur: unknown = hookInputJson
    for (const key of path.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[key]
    }
    return cur
  }
  const interpolate = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(
        /\$\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g,
        (_match, path: string) => {
          const resolved = resolvePath(path)
          if (resolved === undefined || resolved === null) return ''
          return typeof resolved === 'object'
            ? jsonStringify(resolved)
            : String(resolved)
        },
      )
    }
    if (Array.isArray(value)) return value.map(interpolate)
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = interpolate(v)
      return out
    }
    return value
  }
  return interpolate(input) as Record<string, unknown>
}

export type McpToolHookResult = {
  message?: HookResultMessage
  outcome: 'success' | 'non_blocking_error'
  hook: MCPToolHook
}

/**
 * Execute an mcp_tool hook. Binary: SWo (2.1.200) → `KRe` (2.1.281).
 *
 * @param hook        The mcp_tool hook config (server, tool, input, timeout).
 * @param hookEvent   The hook event name (drives the "not available" warning
 *                    and, since 2.1.281, whether a still-connecting server is
 *                    waited for — blocking events wait, non-blocking skip).
 * @param jsonInput   The serialized hook input JSON (for ${path} interpolation).
 * @param signal      Parent abort signal.
 * @param timeoutMs   Default timeout (binary: Ep/Ua).
 * @param mcpClients  MCP clients from toolUseContext (optional; falls back to
 *                    the module-level context getter).
 */
export async function execMcpToolHook({
  hook,
  hookEvent,
  jsonInput,
  signal,
  timeoutMs,
  mcpClients,
}: {
  hook: MCPToolHook
  hookEvent: HookEvent
  jsonInput: string
  signal?: AbortSignal
  timeoutMs: number
  mcpClients?: ReadonlyArray<MCPServerConnection>
}): Promise<McpToolHookResult> {
  // 1. Resolve the MCP client context.
  const clients =
    mcpClients ?? getMcpHookClientContext()?.mcpClients
  if (!clients) {
    const msg = `mcp_tool hooks are not available for the '${hookEvent}' hook event (no MCP client context)`
    logForDebugging(`Hooks: mcp_tool hook skipped — ${msg}`, {
      level: 'warn',
    })
    return {
      outcome: 'non_blocking_error',
      hook,
    }
  }

  // The hook's whole budget (binary: `w` / deadline `M`) is started before the
  // connect wait so the wait consumes it rather than extending it.
  const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
  const deadline = Date.now() + hookTimeoutMs

  // 2. Find the named server; a caller-provided snapshot that lacks it is
  //    re-resolved against the live accessor (binary: `bk()?.find(...)`).
  let server = clients.find(c => c.name === hook.server)
  if (server === undefined && mcpClients !== undefined) {
    server = getMcpHookClientContext()?.mcpClients?.find(
      c => c.name === hook.server,
    )
  }

  // 2b. 2.1.281 (#052): a blocking event gives a configured-but-still-
  //     connecting server time to finish instead of skipping straight away.
  if (
    server?.type === 'pending' &&
    !NON_BLOCKING_HOOK_EVENTS.has(hookEvent)
  ) {
    const waitBudgetMs = Math.min(hookTimeoutMs, getMcpConnectTimeoutMs())
    logForDebugging(
      `Hooks: mcp_tool hook for ${hookEvent} is waiting up to ${waitBudgetMs}ms (less if the server is retrying) for MCP server '${hook.server}' to finish connecting`,
    )
    const waitStartedAt = Date.now()
    const resolved = await waitForMcpServerToConnect(
      hook.server,
      waitBudgetMs,
      signal,
    )
    if (signal?.aborted) {
      return { outcome: 'non_blocking_error', hook }
    }
    const waitedMs = Date.now() - waitStartedAt
    if (resolved) {
      server = resolved
      logForDebugging(
        `Hooks: MCP server '${hook.server}' is now ${resolved.type} after ${waitedMs}ms`,
      )
    } else {
      // Under one poll tick ⇒ the live list never tracked the server, so we
      // never actually waited (binary: `Pe < NIt`).
      logForDebugging(
        waitedMs < CONNECT_WAIT_POLL_INTERVAL_MS
          ? `Hooks: no live MCP client list tracks '${hook.server}'; not waiting for it`
          : `Hooks: stopped waiting for MCP server '${hook.server}' after ${waitedMs}ms; it has not connected`,
        { level: 'warn' },
      )
    }
  }

  // 3. Must be connected by now.
  if (!server || server.type !== 'connected') {
    const msg = `MCP server '${hook.server}' not connected`
    logForDebugging(`Hooks: mcp_tool hook skipped — ${msg}`, {
      level: 'warn',
    })
    return {
      outcome: 'non_blocking_error',
      hook,
    }
  }

  // 4. Interpolate ${path} in input against the hook input JSON.
  let parsedInput: unknown
  try {
    parsedInput = jsonInput ? JSON.parse(jsonInput) : undefined
  } catch {
    parsedInput = undefined
  }
  const args = hook.input
    ? interpolateInput(hook.input, parsedInput)
    : {}

  // 5. callTool with combined abort + the REMAINING budget (binary:
  //    `G = M - Date.now()`; an exhausted budget aborts before calling).
  const timeout = deadline - Date.now()
  if (timeout <= 0) {
    return { outcome: 'non_blocking_error', hook }
  }
  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(
    signal,
    { timeoutMs: timeout },
  )

  try {
    logForDebugging(
      `Hooks: mcp_tool calling ${hook.server}/${hook.tool} with ${Object.keys(args).length} arg(s)`,
    )
    const result = await server.client.callTool(
      { name: hook.tool, arguments: args },
      undefined,
      { signal: combinedSignal, timeout },
    )
    cleanup()
    // 6. Flatten content to text (binary: text→text, others→[type]).
    const body = Array.isArray((result as { content?: unknown[] }).content)
      ? (result as { content: Array<{ type: string; text?: string }> }).content
          .map(m => (m.type === 'text' ? m.text ?? '' : `[${m.type}]`))
          .join('\n')
      : ''
    return {
      outcome: 'success',
      hook,
      message: body
        ? ({
            type: 'attachment',
            attachment: {
              type: 'hook_success',
              hookName: `mcp_tool:${hook.server}/${hook.tool}`,
              toolUseID: '',
              hookEvent,
              content: body,
              stdout: body,
              stderr: '',
              exitCode: 0,
            },
          } as HookResultMessage)
        : undefined,
    }
  } catch (error) {
    cleanup()
    const msg =
      error instanceof Error ? error.message : String(error)
    logForDebugging(`Hooks: mcp_tool hook error: ${msg}`, {
      level: 'error',
    })
    return {
      outcome: 'non_blocking_error',
      hook,
    }
  }
}
