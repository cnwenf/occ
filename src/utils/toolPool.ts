import { feature } from 'src/utils/featureFlags.js'
import partition from 'lodash-es/partition.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { COORDINATOR_MODE_ALLOWED_TOOLS } from '../constants/tools.js'
import { getMcpPrefix } from '../services/mcp/mcpStringUtils.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { isMcpTool } from '../services/mcp/utils.js'
import {
  MCP_AUTH_TOOL_SUFFIX,
  MCP_COMPLETE_AUTH_TOOL_SUFFIX,
} from '../tools/McpAuthTool/mcpAuthStubShared.js'
import type { Tool, ToolPermissionContext, Tools } from '../Tool.js'

// MCP tool name suffixes for PR activity subscription. These are lightweight
// orchestration actions the coordinator calls directly rather than delegating
// to workers. Matched by suffix since the MCP server name prefix may vary.
const PR_ACTIVITY_TOOL_SUFFIXES = [
  'subscribe_pr_activity',
  'unsubscribe_pr_activity',
]

export function isPrActivitySubscriptionTool(name: string): boolean {
  return PR_ACTIVITY_TOOL_SUFFIXES.some(suffix => name.endsWith(suffix))
}

// Dead code elimination: conditional imports for feature-gated modules
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Filters a tool array to the set allowed in coordinator mode.
 * Shared between the REPL path (mergeAndFilterTools) and the headless
 * path (main.tsx) so both stay in sync.
 *
 * PR activity subscription tools are always allowed since subscription
 * management is orchestration.
 */
export function applyCoordinatorToolFilter(tools: Tools): Tools {
  return tools.filter(
    t =>
      COORDINATOR_MODE_ALLOWED_TOOLS.has(t.name) ||
      isPrActivitySubscriptionTool(t.name),
  )
}

/**
 * Pure function that merges tool pools and applies coordinator mode filtering.
 *
 * Lives in a React-free file so print.ts can import it without pulling
 * react/ink into the SDK module graph. The useMergedTools hook delegates
 * to this function inside useMemo.
 *
 * @param initialTools - Extra tools to include (built-in + startup MCP from props).
 * @param assembled - Tools from assembleToolPool (built-in + MCP, deduped).
 * @param mode - The permission context mode.
 * @returns Merged, deduplicated, and coordinator-filtered tool array.
 */
export function mergeAndFilterTools(
  initialTools: Tools,
  assembled: Tools,
  mode: ToolPermissionContext['mode'],
): Tools {
  // Merge initialTools on top - they take precedence in deduplication.
  // initialTools may include built-in tools (from getTools() in REPL.tsx) which
  // overlap with assembled tools. uniqBy handles this deduplication.
  // Partition-sort for prompt-cache stability (same as assembleToolPool):
  // built-ins must stay a contiguous prefix for the server's cache policy.
  const [mcp, builtIn] = partition(
    uniqBy([...initialTools, ...assembled], 'name'),
    isMcpTool,
  )
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  const tools = [...builtIn.sort(byName), ...mcp.sort(byName)]

  if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
    if (coordinatorModeModule.isCoordinatorMode()) {
      return applyCoordinatorToolFilter(tools)
    }
  }

  return tools
}

/**
 * Connection states in which a tracked-but-unreachable server keeps its
 * frozen auth stubs (P3-3): the server is NOT connected (so its frozen real
 * tools are stale and must go), but the user must still be able to call
 * `mcp__<server>__authenticate` / `mcp__<server>__complete_authentication`
 * to recover. In every other state the live store fully owns the prefix.
 */
const AUTH_STUB_PRESERVING_STATES: ReadonlySet<MCPServerConnection['type']> =
  new Set<MCPServerConnection['type']>(['failed', 'disabled'])

/**
 * Minimal client shape accepted from the live stores:
 * `appState.mcp.clients` (MCPServerConnection[]) and the headless
 * SerializedClient[] both carry `name` + connection `type`.
 */
export interface McpLiveClientState {
  readonly name: string
  readonly type?: MCPServerConnection['type']
}

/** Minimal tool shape accepted from the live tool lists (Tool / SerializedTool). */
export interface McpLiveToolRef {
  readonly name?: string
}

/** True when a tool name is one of the two MCP OAuth recovery stubs. */
function isMcpAuthStubName(name: string): boolean {
  return (
    name.endsWith(`__${MCP_AUTH_TOOL_SUFFIX}`) ||
    name.endsWith(`__${MCP_COMPLETE_AUTH_TOOL_SUFFIX}`)
  )
}

/**
 * CC 2.1.274 Gap-128b: make the frozen startup `initialTools` prop defer to
 * live MCP state once the connection manager owns a server.
 *
 * main.tsx captures the startup MCP tools (including the needs-auth stubs
 * `mcp__<server>__authenticate` / `mcp__<server>__complete_authentication`)
 * into the REPL's session-constant `initialTools` prop, and
 * mergeAndFilterTools gives initialTools dedup precedence. Without this
 * filter, a mid-session state transition that REPLACES a server's tools in
 * appState.mcp.tools (e.g. the OAuth continuation's prefix swap after a
 * successful authentication) can never remove the frozen startup entries —
 * the official 2.1.274 REPL's next-turn tool list contains ONLY the real
 * tools after auth (behaviorally verified; the stubs are gone).
 *
 * The connection manager seeds `appState.mcp.clients` and
 * `appState.mcp.tools` atomically (useManageMCPConnections updateServer →
 * flushPendingUpdates), so a client entry's presence means the live store is
 * authoritative for that server's tools — including the empty set after a
 * disconnect/disable (no ghost tools from the frozen prop).
 *
 * P3-3 refinement — per server prefix, exactly one of:
 * 1. Live tool set NON-empty → drop ALL frozen tools with that prefix
 *    (live state wins; this is the post-auth stub-removal case).
 * 2. Live tool set EMPTY and client `type` is 'failed' or 'disabled' →
 *    KEEP the frozen auth stubs (the user must retain the recovery entry
 *    `mcp__<server>__authenticate` after a failed reconnect flushed the
 *    live tools to []) but DROP the frozen real tools (stale — the server
 *    is not actually connected).
 * 3. Otherwise (live empty, any other state) → drop all frozen tools with
 *    that prefix.
 *
 * Pure + React-free: shared by the REPL (useMergedTools/computeTools) and the
 * headless path (print.ts buildAllTools). Never mutates its inputs.
 *
 * @param initialTools - Frozen startup tools (built-in + startup MCP).
 * @param liveClients - Servers currently tracked in appState.mcp.clients
 *   (name + connection `type`).
 * @param liveTools - Live tool list for those servers (appState.mcp.tools).
 * @returns initialTools filtered by the per-prefix authority rule above.
 */
export function deferInitialMcpToolsToLiveState(
  initialTools: Tools,
  liveClients: readonly McpLiveClientState[],
  liveTools: readonly McpLiveToolRef[] = [],
): Tools {
  if (liveClients.length === 0) {
    return initialTools
  }
  const clientsWithPrefix = liveClients.map(client => ({
    prefix: getMcpPrefix(client.name),
    type: client.type,
  }))
  const allPrefixes = clientsWithPrefix.map(entry => entry.prefix)
  const prefixesWithLiveTools = new Set(
    clientsWithPrefix
      .filter(({ prefix }) => liveTools.some(t => t.name?.startsWith(prefix)))
      .map(({ prefix }) => prefix),
  )
  // Rule 2: failed/disabled with an empty live tool set — frozen auth stubs
  // survive for these prefixes; everything else under the prefix is dropped.
  const stubPreservingPrefixes = new Set(
    clientsWithPrefix
      .filter(
        ({ prefix, type }) =>
          type !== undefined &&
          AUTH_STUB_PRESERVING_STATES.has(type) &&
          !prefixesWithLiveTools.has(prefix),
      )
      .map(({ prefix }) => prefix),
  )
  return initialTools.filter(tool => {
    const name = tool.name
    if (name === undefined) {
      return true
    }
    for (const prefix of stubPreservingPrefixes) {
      if (name.startsWith(prefix) && isMcpAuthStubName(name)) {
        return true
      }
    }
    return !allPrefixes.some(prefix => name.startsWith(prefix))
  })
}
