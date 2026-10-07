import { createHash } from 'crypto'
import type { Tool } from '../../Tool.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { logForDebugging } from 'src/utils/debug.js'

/**
 * CC 2.1.292 (occ149 P1): byte-faithful port of the official `o9e` MCP
 * tool-name filter (@219151099, module export `export{Ypt,vun,o9e,Eun}`):
 *
 *   var $Qe=200,B6r=128;                                    // @210585642
 *   var C=256,d=Ge(new Set,(s)=>s.clear());
 *   function o9e(s){let e=new Map,r=s.filter((n)=>{
 *     if(!n.mcpInfo)return!0;
 *     if(n.mcpInfo.hiddenFromModel===!0)return!1;
 *     if(n.name.length<=B6r)return!0;
 *     if(d.size<C&&!d.has(n.name)){d.add(n.name);
 *       let{serverName:a}=n.mcpInfo;
 *       e.set(a,(e.get(a)??0)+1),
 *       Wo(a,`Tool "${n.name}" is not sent to Claude: its name has
 *         ${n.name.length} characters and the API accepts at most ${B6r}`)}
 *     return!1});
 *     for(let[n,a]of e)i("tengu_mcp_degraded",
 *       {reason:b("tool_name_too_long"),skippedCount:a,mcpServerKeyHash:BP(n)});
 *     return r}
 *
 * Semantics: MCP tools whose full `server__tool` name exceeds 128 characters
 * are silently dropped from the API request (the Anthropic API rejects longer
 * tool names) — with a warn-once-per-name notice (dedupe Set capped at 256
 * names), a per-server skip count, and one `tengu_mcp_degraded` telemetry
 * event per affected server. Non-MCP tools always pass. The
 * `hiddenFromModel === true` branch belongs to the official `_meta.ui.visibility`
 * feature (toolsKeptFromModel) which OCC does not implement — the check is
 * kept for faithfulness and is inert until mcpInfo ever carries the flag.
 *
 * Deviation (documented in docs/upstream-version-gap-occ149-2026-10.md):
 * the official `Wo(serverName, message)` surfaces the warning in the /mcp
 * status UI; OCC has no per-server runtime warning store, so the message text
 * goes to the debug log verbatim instead.
 */

/** Official `B6r=128` — the API's maximum tool-name length. */
export const MCP_TOOL_NAME_MAX_LENGTH = 128

/** Official `C=256` — cap on the warn-once dedupe Set. */
const WARN_DEDUPE_CAP = 256

/** Official `d=Ge(new Set,(s)=>s.clear())` — session-lifetime dedupe Set. */
const warnedToolNames = new Set<string>()

/** Test-only reset for the module-level dedupe Set (official `s.clear()`). */
export function resetMcpToolNameWarningCache(): void {
  warnedToolNames.clear()
}

/**
 * Official `BP(n)` — hashed server key for telemetry (server names are
 * user-controlled data; analytics metadata must not carry them verbatim).
 * The official BP implementation is not extractable from the minified chunk;
 * OCC uses its established sha256-hex-16 convention (see hashMcpConfig in
 * src/services/mcp/utils.ts).
 */
function hashMcpServerKey(serverName: string): string {
  return createHash('sha256').update(serverName).digest('hex').slice(0, 16)
}

/**
 * Official `o9e` — filter the tool list about to be sent to the API.
 * Returns a NEW array (never mutates the input).
 */
export function filterMcpToolsForApi(tools: Tool[]): Tool[] {
  const skippedPerServer = new Map<string, number>()
  const kept = tools.filter(tool => {
    if (!tool.mcpInfo) {
      return true
    }
    if (tool.mcpInfo.hiddenFromModel === true) {
      return false
    }
    if (tool.name.length <= MCP_TOOL_NAME_MAX_LENGTH) {
      return true
    }
    if (
      warnedToolNames.size < WARN_DEDUPE_CAP &&
      !warnedToolNames.has(tool.name)
    ) {
      warnedToolNames.add(tool.name)
      const { serverName } = tool.mcpInfo
      skippedPerServer.set(
        serverName,
        (skippedPerServer.get(serverName) ?? 0) + 1,
      )
      // Official Wo(serverName, message) — see deviation note above.
      logForDebugging(
        `Tool "${tool.name}" is not sent to Claude: its name has ${tool.name.length} characters and the API accepts at most ${MCP_TOOL_NAME_MAX_LENGTH}`,
      )
    }
    return false
  })
  for (const [serverName, skippedCount] of skippedPerServer) {
    logEvent('tengu_mcp_degraded', {
      reason:
        'tool_name_too_long' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      skippedCount,
      mcpServerKeyHash: hashMcpServerKey(serverName),
    })
  }
  return kept
}
