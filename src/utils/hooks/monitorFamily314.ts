/**
 * claude-code 2.1.314 item 33 — Monitor→Bash hook "family" machinery.
 *
 *   "Fixed hooks matching Bash not running on shell commands started by the
 *    Monitor tool; such hooks can block or ask, but not approve or rewrite
 *    those commands."
 *
 * Every export below is a byte-verified port of a NEW v314 helper (v312 has
 * zero hits for `matcherMetThroughOtherName` / `which can deny or ask but not
 * allow` / `names Monitor`; its `throughFamilyOnly` served only the pre-existing
 * MCP stand-in machinery, which OCC does not ship). Official minified symbols
 * and linux-x64 ELF offsets are quoted per function.
 *
 * OCC reductions vs the official (documented, not invented):
 * - `cnt` = `Zso(e)` aliases + `hz` family name; `Zso` (@244044665) reads
 *   `y().otherDenyOrAskNames` — the MCP deny/ask stand-in registry. OCC has no
 *   stand-in surface, so Zso≡[] and cnt reduces to the hz name alone.
 * - `wxe`'s mcp__ prefix special-case is retained verbatim for parity.
 */

/** Official `Os` — v314 ELF @248904623: `Os="Monitor"`. */
export const FAMILY_SOURCE_TOOL_NAME = 'Monitor'

/** Official `Fe` — v314 ELF @246440654: `Fe="Bash"`. */
export const FAMILY_TARGET_TOOL_NAME = 'Bash'

/**
 * Official `$Fr` — v314 ELF @253917406, verbatim:
 *   function $Fr(e){return typeof e==="object"&&e!==null&&"command"in e&&
 *     typeof e.command==="string"&&e.command!==""?e.command:void 0}
 */
export function extractFamilyCommand(toolInput: unknown): string | undefined {
  return typeof toolInput === 'object' &&
    toolInput !== null &&
    'command' in toolInput &&
    typeof (toolInput as { command: unknown }).command === 'string' &&
    (toolInput as { command: string }).command !== ''
    ? (toolInput as { command: string }).command
    : undefined
}

/**
 * Official `hz` — v314 ELF @253917627, verbatim:
 *   function hz(e,n){return e===Os&&$Fr(n)!==void 0?Fe:void 0}
 *
 * The Monitor tool's shell-command calls belong to the "Bash" family; ws-only
 * monitors (no command) do not.
 */
export function familyCallName(
  toolName: string | undefined,
  toolInput: unknown,
): string | undefined {
  return toolName === FAMILY_SOURCE_TOOL_NAME &&
    extractFamilyCommand(toolInput) !== undefined
    ? FAMILY_TARGET_TOOL_NAME
    : undefined
}

/** Minimal structural view of a hook input (official helpers are structural). */
type FamilyHookInput = {
  hook_event_name?: string
  tool_name?: string
  tool_input?: unknown
  [key: string]: unknown
}

/**
 * Official `vU` — v314 ELF @256569705, verbatim:
 *   function vU(e){return(e.hook_event_name==="PreToolUse"||
 *     e.hook_event_name==="PermissionRequest")&&"tool_input"in e?
 *     e.tool_input:void 0}
 *
 * Only these two events expose tool_input to the family machinery.
 */
export function hookInputToolInputForFamily(
  hookInput: FamilyHookInput,
): unknown {
  return (hookInput.hook_event_name === 'PreToolUse' ||
    hookInput.hook_event_name === 'PermissionRequest') &&
    'tool_input' in hookInput
    ? hookInput.tool_input
    : undefined
}

/**
 * Official `cnt` — v314 ELF @256569635, verbatim:
 *   function cnt(e,n){let r=hz(e,n),s=Zso(e);return r===void 0?s:[...s,r]}
 *
 * OCC reduction: `Zso` (MCP deny/ask stand-in aliases) is always empty here,
 * so the family-name list is just the hz name (or nothing).
 */
export function familyNamesForCall(
  toolName: string | undefined,
  toolInput: unknown,
): string[] {
  const familyName = familyCallName(toolName, toolInput)
  return familyName === undefined ? [] : [familyName]
}

/**
 * Official `wxe` — v314 ELF @256569840, verbatim:
 *   function wxe(e,n,r){let s=cnt(e,r);return n===void 0||
 *     !/\(\?<?!|\[\^/.test(n)?s:s.filter((h)=>n.includes(h.startsWith("mcp__")?
 *     h.slice(0,h.indexOf("__",5)+2):h))}
 *
 * A matcher using negative syntax (`(?!`, `(?<!`, `[^`) only family-matches when
 * the family name appears TEXTUALLY in the matcher — a negative lookahead that
 * merely regex-matches "Bash" is not enough.
 */
export function familyNamesForMatcher(
  familyNames: string[],
  matcher: string | undefined,
): string[] {
  return matcher === undefined || !/\(\?<?!|\[\^/.test(matcher)
    ? familyNames
    : familyNames.filter(name =>
        matcher.includes(
          name.startsWith('mcp__')
            ? name.slice(0, name.indexOf('__', 5) + 2)
            : name,
        ),
      )
}

/**
 * Official `e0t` — v314 ELF @253917438, verbatim:
 *   function e0t(e){let n=$Fr(e);if(n===void 0)return;return typeof e==="object"&&
 *     e!==null&&"description"in e&&typeof e.description==="string"?
 *     {command:n,description:e.description}:{command:n}}
 *
 * Reduces a Monitor tool_input to the Bash-family shape {command, description?}.
 */
export function toFamilyToolInput(
  toolInput: unknown,
): { command: string; description?: string } | undefined {
  const command = extractFamilyCommand(toolInput)
  if (command === undefined) {
    return undefined
  }
  return typeof toolInput === 'object' &&
    toolInput !== null &&
    'description' in toolInput &&
    typeof (toolInput as { description: unknown }).description === 'string'
    ? {
        command,
        description: (toolInput as { description: string }).description,
      }
    : { command }
}

/**
 * Official `Pxn` — v314 ELF @256566700, verbatim:
 *   function Pxn(e){if(!("tool_name"in e)||!("tool_input"in e))return;
 *     let n=hz(e.tool_name,vU(e)),r=e0t(e.tool_input);
 *     return n===void 0||r===void 0?void 0:{...e,tool_name:n,tool_input:r}}
 *
 * Rewrites a Monitor hook input into its Bash-family form (new object — the
 * original is never mutated).
 */
export function toFamilyHookInput<T extends FamilyHookInput>(
  hookInput: T,
): T | undefined {
  if (!('tool_name' in hookInput) || !('tool_input' in hookInput)) {
    return undefined
  }
  const familyName = familyCallName(
    hookInput.tool_name,
    hookInputToolInputForFamily(hookInput),
  )
  const familyToolInput = toFamilyToolInput(hookInput.tool_input)
  return familyName === undefined || familyToolInput === undefined
    ? undefined
    : ({
        ...hookInput,
        tool_name: familyName,
        tool_input: familyToolInput,
      } as T)
}

/** The two per-matched-hook flags (official spread @256595900). */
export type FamilyMatchFlags = {
  throughFamilyOnly?: boolean
  matcherMetThroughOtherName?: boolean
}

/**
 * Official `jN` — v314 ELF @256567045, verbatim:
 *   function jN(e,n){return e.throughFamilyOnly===!0&&
 *     e.matcherMetThroughOtherName===!0?Pxn(n):void 0}
 *
 * The stdin/JSON transform applies ONLY when both flags are set (matcher met
 * the call through the family name AND the hook may not allow/rewrite). The
 * if-condition-only path (throughFamilyOnly alone) still receives the original
 * Monitor input but is decision-stripped.
 */
export function familyHookInputForMatched<T extends FamilyHookInput>(
  flags: FamilyMatchFlags,
  hookInput: T,
): T | undefined {
  return flags.throughFamilyOnly === true &&
    flags.matcherMetThroughOtherName === true
    ? toFamilyHookInput(hookInput)
    : undefined
}
