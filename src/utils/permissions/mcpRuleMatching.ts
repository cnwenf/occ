/**
 * CC 2.1.299 #065 + #158 + #159 (one official change) — MCP permission-rule
 * matching against the WHOLE normalized server name.
 *
 * Changelog evidence (changelog-299.txt lines 67, 160, 161):
 * - "Fixed deny and ask rules for an MCP server (`mcp__<server>`) not applying
 *   when the server's normalized name contains a double underscore" (#065)
 * - "Changed MCP allow rules to reach only the server they name: `mcp__a` no
 *   longer allows a server named `a__b` or `a_`; write `mcp__<server>__*` with
 *   the server's whole normalized name" (#158)
 * - "Changed agent `tools:` lists to take only the named MCP server's tools;
 *   list a server whose name contains `__` as `mcp__<whole name>__*`" (#159)
 *
 * Binary evidence (official v299 linux-x64 ELF, NEVER executed; grep -aboF +
 * dd). The dedicated MCP string module @215236100:
 *
 *   var oX="mcp__";
 *   function oo(e){let n=e.split("__"),[r,t,...s]=n;if(r!=="mcp"||!t)return null;
 *     let o=s.length>0?s.join("__"):void 0;return{serverName:t,toolName:o}}
 *   function po(e){return`${oX}${vn(e)}__`}
 *   function fA(e){return oo(`${po(e)}x`)?.serverName??vn(e)}
 *   function zs(e,n){return`${po(e)}${vn(n)}`}
 *   function jc(e){return e.mcpInfo?zs(e.mcpInfo.serverName,e.mcpInfo.toolName):e.name}
 *   function YIo(e){let n=oo(e);if(n===null)return()=>!1;
 *     let r=n.toolName===void 0||n.toolName==="*",
 *         t=n.toolName!==void 0&&TE(n.toolName)?n.toolName:void 0,s;
 *     return(o)=>o!==null&&n.serverName===o.serverName&&
 *       (r||o.toolName!==void 0&&t!==void 0&&(s??=dqn(t))(o.toolName))}
 *   function IOr(e,n){return YIo(e)(oo(n))}
 *   function aXe(e){if(e.mcpInfo){let{serverName:r}=e.mcpInfo;
 *       return[`${oX}${vn(r)}`,`${oX}${fA(r)}`]}
 *     let n=[];if(!e.name.startsWith(oX))return n;
 *     for(let r=e.name.indexOf("__",oX.length);r!==-1;r=e.name.indexOf("__",r+1))
 *       n.push(e.name.slice(0,r));
 *     return n}
 *   function XIo(e,n){return(n.mcpInfo?[`${oX}${vn(n.mcpInfo.serverName)}`]:aXe(n))
 *     .every((r)=>e===r||e.startsWith(`${r}__`))}
 *   function lXe(e,n){return IOr(e,jc(n))&&XIo(e,n)}
 *
 * The rule matcher `S` @219828700 (MCP-relevant tail):
 *
 *   let c=i.coversMcpTool(m.mcpInfo());   // = IOr(ruleName, oo(jc(tool)))
 *   if(n.ruleBehavior==="allow"){
 *     if(!c)return!1;
 *     if(XIo(n.ruleValue.toolName,e))return!0;
 *     return zFn(n.ruleValue,e),!1
 *   }
 *   return c||j(n)&&m.mcpServerRuleNames().includes(n.ruleValue.toolName)
 *   // j(rule) = rule.source!=="mcpServerPolicy" && toolName.startsWith("mcp__")
 *
 * and the dedup'd warning `zFn` @219823300:
 *
 *   function zFn(e,n){let o=e.toolName;if(M.has(o))return;M.add(o),
 *     t(n.mcpInfo?`Allow rule "${o}" does not allow the tools named
 *       "${po(n.mcpInfo.serverName)}<tool>": they belong to another MCP server
 *       than the rule names. To allow them, use "${po(n.mcpInfo.serverName)}*".`
 *       :`Allow rule "${o}" does not allow "${n.name}": the name reads as more
 *       than one MCP server's. To allow it, use the tool's full name.`,
 *       {level:"warn"})}
 *
 * Wildcard matcher `h`/`dqn` + `TE` @214865374:
 *
 *   function TE(e){return e.includes("*")}
 *   function h(e){let n=e.split("*"),t=n[0]??"";if(n.length===1)return(i)=>t===i;
 *     let r=n.at(-1)??"",o,s=[];return(i)=>{let a=i.length-r.length;
 *       if(a<t.length||!i.startsWith(t)||!i.endsWith(r))return!1;
 *       o??=n.slice(1,-1).filter((l)=>l!=="");let u=t.length;
 *       for(let[l,f]of o.entries()){let g=(s[l]??=x(f))(i,u,a);
 *         if(g===-1)return!1;u=g+f.length}return!0}}
 *   function dqn(e){return h(e)}
 *
 * SEMANTIC NOTES (official asymmetry, deliberate):
 * - ALLOW rules are strict: the name-level parse must cover the tool AND the
 *   rule must be unambiguous for the tool's WHOLE server name (XIo). `mcp__a`
 *   does NOT allow server `a__b` (its canonical name `mcp__a__b__tool` parses
 *   as server "a" — ambiguous) nor server `a_` (canonical `mcp__a___tool`).
 * - DENY/ASK rules are fail-safe and may over-reach: the name-level parse
 *   alone covers them (`c`), OR the rule equals one of the tool's whole-name
 *   server candidates (aXe) — which is what makes `mcp__a__b` deny/ask the
 *   tools of a server literally named `a__b` (#065; the name parse of the rule
 *   alone would misread it as server "a", tool "b").
 *
 * `vn` = normalizeNameForMCP, `oo` = mcpInfoFromString, `po` = getMcpPrefix,
 * `zs` = buildMcpToolName, `jc` = getToolNameForPermissionCheck,
 * `fA` = getMcpServerNameCollisionKey ?? normalizeNameForMCP — all imported
 * read-only from src/services/mcp (owned by another work package).
 */
import {
  getMcpPrefix,
  getMcpServerNameCollisionKey,
  getToolNameForPermissionCheck,
  mcpInfoFromString,
} from '../../services/mcp/mcpStringUtils.js'
import { normalizeNameForMCP } from '../../services/mcp/normalization.js'
import { logForDebugging } from '../debug.js'

/** Official `oX`. */
const MCP_RULE_PREFIX = 'mcp__'

export type McpRuleToolLike = {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}

export type McpRuleLike = {
  source: string
  ruleBehavior: string
  ruleValue: { toolName: string }
}

/** Official `TE` — a rule name is a wildcard pattern when it holds a star. */
function containsWildcard(pattern: string): boolean {
  return pattern.includes('*')
}

/**
 * Official `x(f)` — bounded segment search: find `segment` in `value` starting
 * at/after `from`, wholly before `limit`; -1 when absent. (The official helper
 * is a minified closure; this is its observable contract inside `h`.)
 */
function findSegmentBounded(
  segment: string,
): (value: string, from: number, limit: number) => number {
  return (value, from, limit) => {
    const index = value.indexOf(segment, from)
    return index !== -1 && index + segment.length <= limit ? index : -1
  }
}

/** Official `h`/`dqn` — build a matcher for a `*`-wildcard pattern. */
function buildWildcardMatcher(pattern: string): (value: string) => boolean {
  const parts = pattern.split('*')
  const prefix = parts[0] ?? ''
  if (parts.length === 1) {
    return value => prefix === value
  }
  const suffix = parts.at(-1) ?? ''
  let middle: string[] | undefined
  const segmentFinders: Array<(value: string, from: number, limit: number) => number> = []
  return (value: string): boolean => {
    const limit = value.length - suffix.length
    if (limit < prefix.length || !value.startsWith(prefix) || !value.endsWith(suffix)) {
      return false
    }
    middle ??= parts.slice(1, -1).filter(part => part !== '')
    let cursor = prefix.length
    for (const [index, segment] of middle.entries()) {
      const finder = (segmentFinders[index] ??= findSegmentBounded(segment))
      const found = finder(value, cursor, limit)
      if (found === -1) {
        return false
      }
      cursor = found + segment.length
    }
    return true
  }
}

/** Official `YIo(ruleName)` — matcher over a parsed tool name. */
function buildRuleCoversParsedName(
  ruleToolName: string,
): (
  parsed: ReturnType<typeof mcpInfoFromString>,
) => boolean {
  const rule = mcpInfoFromString(ruleToolName)
  if (rule === null) {
    return () => false
  }
  const serverWide = rule.toolName === undefined || rule.toolName === '*'
  const toolPattern =
    rule.toolName !== undefined && containsWildcard(rule.toolName)
      ? rule.toolName
      : undefined
  let wildcardMatcher: ((value: string) => boolean) | undefined
  return parsed =>
    parsed !== null &&
    rule.serverName === parsed.serverName &&
    (serverWide ||
      (parsed.toolName !== undefined &&
        toolPattern !== undefined &&
        (wildcardMatcher ??= buildWildcardMatcher(toolPattern))(
          parsed.toolName,
        )))
}

/** Official `IOr(ruleName, canonicalToolName)`. */
export function ruleCoversMcpToolName(
  ruleToolName: string,
  canonicalToolName: string,
): boolean {
  return buildRuleCoversParsedName(ruleToolName)(
    mcpInfoFromString(canonicalToolName),
  )
}

/** Official `fA` — round-trip server name with the vn fallback. */
function getWholeServerName(serverName: string): string {
  return getMcpServerNameCollisionKey(serverName) ?? normalizeNameForMCP(serverName)
}

/** Official `aXe` — whole-name server-level candidates for a tool. */
export function getMcpServerRuleNames(tool: McpRuleToolLike): string[] {
  if (tool.mcpInfo) {
    const { serverName } = tool.mcpInfo
    return [
      `${MCP_RULE_PREFIX}${normalizeNameForMCP(serverName)}`,
      `${MCP_RULE_PREFIX}${getWholeServerName(serverName)}`,
    ]
  }
  const names: string[] = []
  if (!tool.name.startsWith(MCP_RULE_PREFIX)) {
    return names
  }
  for (
    let index = tool.name.indexOf('__', MCP_RULE_PREFIX.length);
    index !== -1;
    index = tool.name.indexOf('__', index + 1)
  ) {
    names.push(tool.name.slice(0, index))
  }
  return names
}

/** Official `XIo` — the rule reaches only the tool's whole-named server. */
export function ruleReachesWholeNamedServer(
  ruleToolName: string,
  tool: McpRuleToolLike,
): boolean {
  const candidates = tool.mcpInfo
    ? [`${MCP_RULE_PREFIX}${normalizeNameForMCP(tool.mcpInfo.serverName)}`]
    : getMcpServerRuleNames(tool)
  return candidates.every(
    candidate =>
      ruleToolName === candidate ||
      ruleToolName.startsWith(`${candidate}__`),
  )
}

/** Official `lXe` — the allow-rule matcher reused by agent tools: lists. */
export function mcpAllowRuleReachesTool(
  ruleToolName: string,
  tool: McpRuleToolLike,
): boolean {
  return (
    ruleCoversMcpToolName(ruleToolName, getToolNameForPermissionCheck(tool)) &&
    ruleReachesWholeNamedServer(ruleToolName, tool)
  )
}

/** Official `zFn` dedup set (`M`), per-process. Exported reset for tests. */
const warnedAllowRuleNames = new Set<string>()

export function resetAllowRuleWarningsForTesting(): void {
  warnedAllowRuleNames.clear()
}

/** Official `zFn` @219823300 — warn once per rule name. */
function warnAllowRuleDoesNotReachTool(
  ruleToolName: string,
  tool: McpRuleToolLike,
): void {
  if (warnedAllowRuleNames.has(ruleToolName)) {
    return
  }
  warnedAllowRuleNames.add(ruleToolName)
  if (tool.mcpInfo) {
    const prefix = getMcpPrefix(tool.mcpInfo.serverName)
    logForDebugging(
      `Allow rule "${ruleToolName}" does not allow the tools named "${prefix}<tool>": they belong to another MCP server than the rule names. To allow them, use "${prefix}*".`,
      { level: 'warn' },
    )
    return
  }
  logForDebugging(
    `Allow rule "${ruleToolName}" does not allow "${tool.name}": the name reads as more than one MCP server's. To allow it, use the tool's full name.`,
    { level: 'warn' },
  )
}

/**
 * Official `S` matcher tail @219828700 — decide whether a whole-tool rule
 * (no ruleContent) matches `tool` on the MCP dimension. Returns false for
 * non-MCP rules/tools (oo → null → covers false), so callers can use it as
 * the MCP fallback after the exact-name check.
 *
 * The official deny/ask branch also excludes `source==="mcpServerPolicy"`
 * (dynamic http/sse per-tool policies); OCC has no mcpServerPolicy rule
 * source, so the guard has no OCC-side effect and is omitted.
 */
export function mcpRuleMatchesTool(
  tool: McpRuleToolLike,
  rule: McpRuleLike,
): boolean {
  const ruleToolName = rule.ruleValue.toolName
  const covers = ruleCoversMcpToolName(
    ruleToolName,
    getToolNameForPermissionCheck(tool),
  )
  if (rule.ruleBehavior === 'allow') {
    if (!covers) {
      return false
    }
    if (ruleReachesWholeNamedServer(ruleToolName, tool)) {
      return true
    }
    warnAllowRuleDoesNotReachTool(ruleToolName, tool)
    return false
  }
  return (
    covers ||
    (ruleToolName.startsWith(MCP_RULE_PREFIX) &&
      getMcpServerRuleNames(tool).includes(ruleToolName))
  )
}
