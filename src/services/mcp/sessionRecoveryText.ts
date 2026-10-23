/**
 * claude-code 2.1.307 PORT B3 — session-recovery tool-result text.
 *
 * Byte-verified port of the official 2.1.307 linux ELF symbols (never
 * executed):
 *  - `z_({serverName,error,namesMcpCall,detail})` @276388380 — the verbatim
 *    isError tool-result text for an `McpSessionExpiredError` that was NOT
 *    retried (official caller:
 *    `m("mcp_session_recovery","session_expired_no_retry")` then
 *    `{isError:!0,content:[{type:"text",text:z_({...namesMcpCall:!1,
 *    detail:mr.message})}]}`). Em dash is U+2014; `namesMcpCall` appends
 *    `" mcp_call"` before the colon.
 *  - `Jt` @239037125 — the display sanitizer used for BOTH interpolated
 *    fields: non-string → `""`; pre-slice at 4096; then `rrr` (lone
 *    surrogates removed, invisibles removed — to EMPTY, unlike
 *    displaySanitize.ts's strip-to-SPACE family — iterated to a fixpoint with
 *    a 64-pass cap, returning `""` if no fixpoint); then truncate to 1024
 *    display length (official `re` = displaySanitize.ts
 *    `truncateToDisplayLength`).
 *
 * NOT wired into a tool-result renderer yet: the official call site lives in
 * the print/SDK result path (src/cli/print.ts), which is off-limits for this
 * change set (concurrent edits). The renderer is implemented + exported +
 * unit-tested here so the wiring is a one-line import for whoever owns that
 * file. (Documented deviation.)
 */
import { truncateToDisplayLength } from './displaySanitize.js'

/** Official `tt` — surrogate pairs, lone high, lone low. */
const SESSION_TEXT_SURROGATE_PATTERN =
  /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF]|[\uDC00-\uDFFF]/g

/** Official `ve` — invisibles (Cc/Cf/Zl/Zp/default-ignorable/braille-blank) + non-space Zs. */
const SESSION_TEXT_INVISIBLE_PATTERN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]|(?!\u0020)\p{Zs}/gu

/** Official `Jt` input pre-slice cap. */
const SESSION_TEXT_INPUT_CAP = 4096

/** Official `Jt` output display-length cap. */
const SESSION_TEXT_DISPLAY_MAX = 1024

/** Official `rrr` fixpoint iteration cap. */
const SESSION_TEXT_FIXPOINT_PASSES = 64

/** Official `nt` — lone surrogates removed; well-formed pairs kept. */
function stripLoneSurrogates(value: string): string {
  return value.replace(
    SESSION_TEXT_SURROGATE_PATTERN,
    match => (match.length === 2 ? match : ''),
  )
}

/**
 * Official `rrr` — strip surrogates + invisibles to EMPTY, iterating to a
 * fixpoint (removal can expose NEW lone surrogates or invisibles). If no
 * fixpoint is reached within 64 passes, the official returns `""`.
 */
function stripToFixpoint(value: string): string {
  if (typeof value !== 'string') return ''
  let current = value
  for (let pass = 0; pass < SESSION_TEXT_FIXPOINT_PASSES; pass++) {
    const next = stripLoneSurrogates(current).replace(
      SESSION_TEXT_INVISIBLE_PATTERN,
      '',
    )
    if (next === current) return next
    current = next
  }
  return ''
}

/** Official `Jt` — full sanitizer pipeline (see module header). */
export function sanitizeSessionRecoveryText(input: unknown): string {
  if (typeof input !== 'string') return ''
  return truncateToDisplayLength(
    stripToFixpoint(
      input.length > SESSION_TEXT_INPUT_CAP
        ? input.slice(0, SESSION_TEXT_INPUT_CAP)
        : input,
    ),
    SESSION_TEXT_DISPLAY_MAX,
  )
}

/** Structural view of `McpSessionExpiredError` (avoids a client.ts cycle). */
export interface SessionRecoveryError {
  mayHaveRun: boolean
  expiryKind: string
}

/**
 * Official `z_` — verbatim template:
 * `${mayHaveRun ? `MCP connection to ${h} closed during the call — send
 * mcp_reconnect, and check whether the tool ran before retrying${S}` :
 * `MCP ${expiryKind==="connection_closed_call_not_run" ? "connection closed
 * before the call ran on" : "session expired for"} ${h} — send
 * mcp_reconnect and retry${S}`}: ${Jt(detail)}`
 */
export function renderSessionRecoveryResultText({
  serverName,
  error,
  namesMcpCall,
  detail,
}: {
  serverName: string
  error: SessionRecoveryError
  namesMcpCall: boolean
  detail: string
}): string {
  const safeName = sanitizeSessionRecoveryText(serverName)
  const callSuffix = namesMcpCall ? ' mcp_call' : ''
  return `${
    error.mayHaveRun
      ? `MCP connection to ${safeName} closed during the call — send mcp_reconnect, and check whether the tool ran before retrying${callSuffix}`
      : `MCP ${
          error.expiryKind === 'connection_closed_call_not_run'
            ? 'connection closed before the call ran on'
            : 'session expired for'
        } ${safeName} — send mcp_reconnect and retry${callSuffix}`
  }: ${sanitizeSessionRecoveryText(detail)}`
}
