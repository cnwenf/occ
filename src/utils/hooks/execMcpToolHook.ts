/**
 * 2.1.118: mcp_tool hook execution — a hook can invoke an MCP tool on an
 * already-configured server. Matches the official 2.1.200 binary (SWo).
 *
 * Flow (binary: SWo):
 *   1. Resolve the MCP client context (toolUseContext.mcpClients, or the
 *      module-level fallback set by setMcpHookClientContext).
 *   2. Find the named server; skip with a warning if not connected.
 *   3. Interpolate ${path} expressions in `input` against the hook input JSON.
 *   4. callTool({name, arguments}, {signal, timeout}).
 *   5. Flatten the result content to text (text blocks → text, others →
 *      `[${type}]`), joined by newlines.
 *
 * Error wording is binary-exact (grep-verified against claude.strings).
 */

import type { ConnectedMCPServer } from '../../services/mcp/types.js'
import { logForDebugging } from '../debug.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { jsonStringify } from '../slowOperations.js'
import type { MCPToolHook } from '../../schemas/hooks.js'
import type { HookEvent } from '../../entrypoints/agentSdkTypes.js'
import type { HookResultMessage } from '../../types/message.js'

// Module-level MCP client context getter (binary: sIr/aje). Set by the MCP
// connection layer so mcp_tool hooks can resolve servers even for events
// that lack a toolUseContext (e.g. SessionStart). Undefined when no session
// has wired it up — mcp_tool hooks then skip with the binary-exact warning.
type McpClientContext = {
  mcpClients?: ReadonlyArray<ConnectedMCPServer>
}
let mcpClientContextGetter: (() => McpClientContext | undefined) | undefined

export function setMcpHookClientContext(
  getter: (() => McpClientContext | undefined) | undefined,
): void {
  mcpClientContextGetter = getter
}

export function getMcpHookClientContext(): McpClientContext | undefined {
  return mcpClientContextGetter?.()
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
 * Execute an mcp_tool hook. Binary: SWo(e, t, n, r, o, s).
 *
 * @param hook        The mcp_tool hook config (server, tool, input, timeout).
 * @param hookEvent   The hook event name (used in the "not available" warning).
 * @param jsonInput   The serialized hook input JSON (for ${path} interpolation).
 * @param signal      Parent abort signal.
 * @param timeoutMs   Default timeout (binary: Ep).
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
  mcpClients?: ReadonlyArray<ConnectedMCPServer>
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

  // 2. Find the named server; must be connected.
  const server = clients.find(c => c.name === hook.server)
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

  // 3. Interpolate ${path} in input against the hook input JSON.
  let parsedInput: unknown
  try {
    parsedInput = jsonInput ? JSON.parse(jsonInput) : undefined
  } catch {
    parsedInput = undefined
  }
  const args = hook.input
    ? interpolateInput(hook.input, parsedInput)
    : {}

  // 4. callTool with combined abort + timeout.
  const timeout = hook.timeout ? hook.timeout * 1000 : timeoutMs
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
    // 5. Flatten content to text (binary: text→text, others→[type]).
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
