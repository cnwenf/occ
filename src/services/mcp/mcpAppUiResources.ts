import { LIST_MCP_RESOURCES_TOOL_NAME } from '../../tools/ListMcpResourcesTool/prompt.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * MCP Apps UI-resource detection + list filtering (CC 2.1.281 #147).
 *
 * MCP Apps servers advertise UI resources (a `ui://` URI, or `text/html`
 * with a `profile=mcp-app` parameter) meant for host-side rendering, not
 * for the model. v2.1.281 keeps them out of every resource LIST surfaced to
 * the model (ListMcpResourcesTool, resource discovery, @-mention
 * suggestions) while read-by-URI (ReadMcpResourceTool) keeps working.
 *
 * Binary evidence (v2.1.281 linux-x64 ELF):
 * - Detector `XXe({uri, mimeType})` @207138863 with constants @207138146:
 *   `c="ui://"`, `_="mcp-app"`, `g=1024` (max mimeType length),
 *   `l="[!#$%&'*+.^_`|~0-9A-Za-z-]+"` (RFC token chars),
 *   `h=/^[ \t]*(l)\/(l)/` (type/subtype), sticky param regex
 *   `a=/[ \t\r\n]*;[ \t\r\n]*(?:(l)=(?:(l)|"((?:[^"\\]|\\.)*)")
 *   (?=[ \t\r\n]*(?:;|$)))?/y` — ported verbatim below.
 * - List filter + debug log @207460730: `p=r.filter((g)=>!XXe(g))` and the
 *   "left out of …'s list for the model … can still read them by URI"
 *   template with `X3="ListMcpResourcesTool"` @201977766 and
 *   `b1="ReadMcpResourceTool"` @200757099 (logger `t()` = debug-level log).
 * - Suggestion-surface filters @220778776/@220778996 (`.filter(dt=>!XXe(dt))`).
 * - Capability constants `Sfn="io.modelcontextprotocol/ui"`,
 *   `bfn="text/html;profile=mcp-app"` @200797306 belong to the
 *   CLAUDE_CODE_MCP_APPS_HOST capability negotiation, which OCC does not
 *   ship; only the detector is ported here.
 */

const UI_URI_SCHEME = 'ui://'
const MCP_APP_PROFILE_VALUE = 'mcp-app'
const MAX_MIME_TYPE_LENGTH = 1024

// RFC 9110 token characters, byte-identical to the v281 `l` constant.
const MIME_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+"
const MIME_TYPE_SUBTYPE_RE = new RegExp(`^[ \\t]*(${MIME_TOKEN})/(${MIME_TOKEN})`)
// Sticky parameter scanner, byte-identical to the v281 `a` constant. Group 1
// is the parameter name, group 2 an unquoted token value, group 3 a quoted
// (backslash-escaped) value.
const MIME_PARAM_RE = new RegExp(
  `[ \\t\\r\\n]*;[ \\t\\r\\n]*(?:(${MIME_TOKEN})=(?:(${MIME_TOKEN})|"((?:[^"\\\\]|\\\\.)*)")(?=[ \\t\\r\\n]*(?:;|$)))?`,
  'y',
)

export interface McpAppUiResourceCandidate {
  uri: string
  mimeType?: string
}

/**
 * True when a resource is an MCP Apps UI resource: a `ui://` URI (case
 * insensitive), or a `text/html` mimeType carrying a `profile=mcp-app`
 * parameter (parameter name/value case insensitive, quoted values
 * unescaped). Faithful port of the v281 `XXe` detector.
 */
export function isMcpAppUiResource({
  uri,
  mimeType,
}: McpAppUiResourceCandidate): boolean {
  if (uri.slice(0, UI_URI_SCHEME.length).toLowerCase() === UI_URI_SCHEME) {
    return true
  }
  if (mimeType === undefined || mimeType.length > MAX_MIME_TYPE_LENGTH) {
    return false
  }
  const typeMatch = MIME_TYPE_SUBTYPE_RE.exec(mimeType)
  if (
    typeMatch?.[1]?.toLowerCase() !== 'text' ||
    typeMatch[2]?.toLowerCase() !== 'html'
  ) {
    return false
  }
  MIME_PARAM_RE.lastIndex = typeMatch[0].length
  for (
    let paramMatch = MIME_PARAM_RE.exec(mimeType);
    paramMatch !== null;
    paramMatch = MIME_PARAM_RE.exec(mimeType)
  ) {
    const [, rawName, tokenValue, quotedValue] = paramMatch
    const value = tokenValue ?? quotedValue?.replace(/\\(.)/g, '$1')
    if (
      rawName?.toLowerCase() === 'profile' &&
      value?.toLowerCase() === MCP_APP_PROFILE_VALUE
    ) {
      return true
    }
  }
  return false
}

const READ_MCP_RESOURCE_TOOL_NAME = 'ReadMcpResourceTool'

/**
 * Filters MCP Apps UI resources out of a resource LIST and emits the
 * v281-exact debug log when anything was dropped. List surfaces only —
 * explicit read-by-URI paths must never call this (SEP-1865: reading a
 * `ui://` resource by URI keeps working).
 */
export function filterMcpAppUiResources<T extends McpAppUiResourceCandidate>(
  resources: readonly T[],
  serverName: string,
): T[] {
  const filtered = resources.filter(resource => !isMcpAppUiResource(resource))
  if (filtered.length < resources.length) {
    logForDebugging(
      `MCP server "${serverName}": ${resources.length - filtered.length} MCP Apps UI resource(s) left out of ${LIST_MCP_RESOURCES_TOOL_NAME}'s list for the model (a ui:// URI, or text/html with profile=mcp-app); ${READ_MCP_RESOURCE_TOOL_NAME} can still read them by URI`,
    )
  }
  return filtered
}
