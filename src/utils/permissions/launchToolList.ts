/**
 * CC 2.1.295 changelog #037 (half 1) — "`--tools` and `--restricted` not
 * applying to built-in tools that register after launch".
 *
 * Before 2.1.295 the official CLI enforced `--tools` purely as a *startup
 * snapshot*: `literalToolsNarrowing()` diffed the requested list against the
 * tools known at launch and emitted a synthetic deny rule for every name that
 * was missing. A built-in that only materialised later (lazy module load,
 * eval-registered tool, host-injected native tool, ...) was never in that
 * launch-time universe, so no deny rule named it and it reached the model.
 *
 * 2.1.295 adds the complementary *positive* gate: the launch list itself is
 * frozen onto the permission context as `toolsKeptByLaunchList`
 * (v295 @222921207 — `...Y!==void 0&&{toolsKeptByLaunchList:Object.freeze([...Y])}`,
 * classified `"not_serialized"` @250317444) and every tool-pool build re-checks
 * it via the new exported predicate `isOutsideLaunchToolList`
 * (v295 chunk barrel @238500768; the v294 barrel @235777911 has no such
 * export, and the string `toolsKeptByLaunchList` occurs 0 times in v294 vs
 * 6 times in v295).
 *
 * Ported byte-faithfully from the official 2.1.295 linux-x64 bundle:
 *
 *   // v295 @214477161 — filterToolsByDenyRules (`Y5`), tail of the filter body
 *   return e.filter((d)=>{
 *     if(Ce(n,d,o,s)||d.mcpInfo?.effectiveMaxPermission==="blocked")return!1;
 *     if(!hTt(n,d))return!0;
 *     if(Ia().claim(`tool_outside_launch_list:${d.name}`))
 *       t(`${LS(d)} is not on this session's --tools list and no deny rule names it; withheld. Name it in --tools to offer it`,{level:"warn"}),
 *       i("tengu_tool_withheld_outside_launch_list",{toolName:Hn(LS(d))});
 *     return!1})
 *
 *   // v295 @214477596 — isOutsideLaunchToolList (`hTt`)
 *   function hTt({toolsKeptByLaunchList:e},n){return!(e===void 0||ky(n)||
 *     n.mcpInfo!==void 0||H2(n)||yre(n)||e.includes(n.name)||
 *     n.familyParentToolName!==void 0&&e.includes(n.familyParentToolName))}
 *
 *   // v295 @213206000 — `ky`
 *   function ky(e){return e.name?.startsWith("mcp__")||e.isMcp===!0}
 *
 *   // v295 @214476109 — telemetry-safe tool label (`LS`)
 *   function LS(e){if(e.name.startsWith(oV))return"skill_tool";          // oV="skill__" @211023980
 *     let n=String(Hn(e.name));if(n!==e.name)return n;                   // Hn @209552214
 *     if(e.mcpInfo!==void 0)return"mcp_tool";
 *     if(e.name.startsWith("eval_registered__"))return"eval_registered";
 *     if(e.uiTableKey!==void 0||e.name.includes("__"))return"dynamic_tool";
 *     return e.name}
 *
 *   // v295 @209552214 — `Hn` (telemetry name normalizer)
 *   function Hn(e){let n=Object.hasOwn(Va,e)?Va[e]:void 0;if(n)return En(n);
 *     if(e.startsWith("mcp__"))return b("mcp_tool");return En(e)}
 *
 * Documented OCC divergences (all are *absent machinery*, never re-invented):
 * - `H2(n)` — the `Symbol.for("claude-code.hostOnlyNativeTool")` marker
 *   (v295 @214475949). OCC has no host-only native tools (0 occurrences of
 *   `hostOnlyNativeTool` under src/), so the exemption is unreachable.
 * - `yre(n)` — `!n.mcpInfo && END_CONVERSATION_TOOL_NAME_SET.has(n.name)`
 *   (v295 @211469687). OCC ships no EndConversation tool.
 * - `n.familyParentToolName` — OCC has no tool families (0 occurrences).
 * - `e.uiTableKey` — OCC's Tool type has no `uiTableKey` (0 occurrences).
 * - `Va` — the official known-tool-name table behind `Hn`. OCC has no such
 *   table, so `Hn(x)` reduces to its two remaining branches: `mcp__` →
 *   `"mcp_tool"`, else the name verbatim. Because `LS` never returns an
 *   `mcp__`-prefixed string, `Hn(LS(d)) ≡ LS(d)`; the label is therefore
 *   computed once and reused for both the warning text and the event field.
 *
 * Half 2 of the changelog line ("deprecated tool names reaching tools outside
 * the caller's tool set") lives in the `toolAliases` / `aliasSources()`
 * proxy-expansion matcher (new `aliasSources` in v295: 0 → 5 occurrences;
 * `R`/`S`/`$co`/`GKe` @211469687+). OCC has no `toolAliases`, no
 * `aliasSources`, no `aliasSkillToolNames` and no proxy-expansion matcher, so
 * there is no code path for a deprecated name to reach through — STAGED, not
 * ported here.
 */

import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'

/** Structural view of a tool the launch-list gate needs (official `n` in `hTt`). */
export interface LaunchListToolRef {
  readonly name: string
  readonly isMcp?: boolean
  readonly mcpInfo?: unknown
}

/** Official `oV` — per-skill tool name prefix (v295 @211023980). */
const SKILL_TOOL_NAME_PREFIX = 'skill__'
const MCP_TOOL_NAME_PREFIX = 'mcp__'
const EVAL_REGISTERED_TOOL_NAME_PREFIX = 'eval_registered__'
/** Official `n.name.includes("__")` branch of `LS` — dynamic tool marker. */
const DYNAMIC_TOOL_NAME_MARKER = '__'

const SKILL_TOOL_LABEL = 'skill_tool'
const MCP_TOOL_LABEL = 'mcp_tool'
const EVAL_REGISTERED_LABEL = 'eval_registered'
const DYNAMIC_TOOL_LABEL = 'dynamic_tool'

/** Official claim key prefix: `tool_outside_launch_list:${d.name}` (@214477347). */
const WARNING_CLAIM_PREFIX = 'tool_outside_launch_list:'
const WITHHELD_EVENT_NAME = 'tengu_tool_withheld_outside_launch_list'

/**
 * Once-store ≡ official `Ia().claim(...)`: the warning + telemetry fire at
 * most once per tool name per process, no matter how many turns rebuild the
 * pool. Mirrors the `claimedSignals` pattern in
 * src/utils/model/unrecognizedModelSignal.ts.
 */
const claimedLaunchListWarnings = new Set<string>()

/** Test hook: clears the once-store so each test starts unclaimed. */
export function resetLaunchListWarningsForTesting(): void {
  claimedLaunchListWarnings.clear()
}

/**
 * Official `ky` (v295 @213206000) — name/flag based MCP detection. Kept
 * separate from services/mcp/utils.ts `isMcpTool` so this module stays free of
 * the MCP import graph (tools.ts imports it on the hot tool-pool path).
 */
function isMcpToolRef(tool: LaunchListToolRef): boolean {
  return tool.name?.startsWith(MCP_TOOL_NAME_PREFIX) || tool.isMcp === true
}

/**
 * Official `LS` (v295 @214476109) folded with `Hn` (v295 @209552214): a
 * telemetry-safe label that never leaks a dynamically generated tool name.
 */
export function launchListToolLabel(tool: LaunchListToolRef): string {
  if (tool.name.startsWith(SKILL_TOOL_NAME_PREFIX)) {
    return SKILL_TOOL_LABEL
  }
  if (isMcpToolRef(tool)) {
    return MCP_TOOL_LABEL
  }
  if (tool.mcpInfo !== undefined) {
    return MCP_TOOL_LABEL
  }
  if (tool.name.startsWith(EVAL_REGISTERED_TOOL_NAME_PREFIX)) {
    return EVAL_REGISTERED_LABEL
  }
  if (tool.name.includes(DYNAMIC_TOOL_NAME_MARKER)) {
    return DYNAMIC_TOOL_LABEL
  }
  return tool.name
}

/**
 * Official `hTt`, exported publicly as `isOutsideLaunchToolList`
 * (v295 barrel @238500768). True when the session was launched with `--tools`
 * and this tool is neither on that list nor in an exempt category.
 *
 * `toolsKeptByLaunchList === undefined` means "no positive launch list" — the
 * official sets it to `undefined` for the `default` preset
 * (`QHs` @222914830: `toolsKept: s||o.kept.includes("preset:default")?void 0:c`),
 * so preset sessions are never gated here.
 */
export function isOutsideLaunchToolList(
  permissionContext: ToolPermissionContext,
  tool: LaunchListToolRef,
): boolean {
  const kept = permissionContext.toolsKeptByLaunchList
  return !(
    kept === undefined ||
    isMcpToolRef(tool) ||
    tool.mcpInfo !== undefined ||
    kept.includes(tool.name)
  )
}

/**
 * Official tail of `Y5` / `filterToolsByDenyRules` (v295 @214477161). Runs
 * *after* the deny-rule filter so an explicit deny still wins silently; only
 * tools that no deny rule names but that fall outside the launch list are
 * withheld here, with a once-per-name warning and telemetry event.
 *
 * Pure with respect to its inputs (never mutates `tools` or the context); the
 * only state it touches is the module-level once-store.
 */
export function withholdToolsOutsideLaunchList<T extends LaunchListToolRef>(
  tools: readonly T[],
  permissionContext: ToolPermissionContext,
): T[] {
  return tools.filter(tool => {
    if (!isOutsideLaunchToolList(permissionContext, tool)) {
      return true
    }
    const claimKey = `${WARNING_CLAIM_PREFIX}${tool.name}`
    if (!claimedLaunchListWarnings.has(claimKey)) {
      claimedLaunchListWarnings.add(claimKey)
      const label = launchListToolLabel(tool)
      logForDebugging(
        `${label} is not on this session's --tools list and no deny rule names it; withheld. Name it in --tools to offer it`,
        { level: 'warn' },
      )
      logEvent(WITHHELD_EVENT_NAME, {
        toolName:
          label as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    return false
  })
}
