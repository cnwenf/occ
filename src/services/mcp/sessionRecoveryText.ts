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
 * WIRING (F-01 + 2.1.308 F-03): the official's two `z_`/`ky` call sites
 * both live in the CCR mcp_call / staged-SDK relay subsystem (v309
 * @277912896 + @277915059; v307 @276618538 + @276620665), which OCC has NOT
 * ported. OCC wires BOTH render shapes at its live equivalent — the
 * fetchToolsForClient tool wrapper's NON-retried McpSessionExpiredError
 * rethrow (client.ts `McpSessionRecoveryTextError`), which toolExecution.ts
 * surfaces verbatim as the isError tool_result text via `formatError`
 * (= error.message). The wrapper's non-retry REASON picks the shape:
 * `may_have_run_no_retry` → `renderSessionRecoveryResultText` (site-1,
 * `namesMcpCall:false`, no `.slice(0,2000)` cap — the `Jt`/`Qt` sanitizer
 * bounds length internally); `session_retry_exhausted` →
 * `renderSessionRecoveryDispatchText` (site-2, `namesMcpCall:true` +
 * 2000-char cap + trailing lone-high-surrogate strip).
 * The official `session_expired_no_retry` counter stays unwired with the
 * unported relay (the wrapper keeps its own may_have_run_no_retry /
 * session_retry_exhausted events). The `Jt`/`Qt` sanitizer is LIVE through
 * both renderers. (Documented deviation — see renderSessionRecoveryDispatchText.)
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

/** Official site-2 dispatch cap (`At.slice(0,2000)`). */
const SESSION_TEXT_DISPATCH_CAP = 2000

/**
 * Official site-2 tail strip — the 2000-char slice can cut a well-formed
 * surrogate pair in half, leaving a trailing lone HIGH surrogate
 * (`.replace(/[\uD800-\uDBFF]$/,"")`).
 */
const SESSION_TEXT_TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/

/**
 * 2.1.308 F-03 — the SECOND official `ky` render site (mcp_call dispatch),
 * byte-verified in the v2.1.309 ELF (never executed; v307 `z_` equivalents
 * in parens):
 *  - site 1 (staged-SDK relay, `mcp_session_recovery` @277912896 /
 *    @276618538): `ky({serverName:Se.serverName,error:ir,namesMcpCall:!1,
 *    detail:ir.message})` — UNCAPPED, no mcp_call suffix. That shape is
 *    `renderSessionRecoveryResultText` above.
 *  - site 2 (mcp_call dispatch, `mcp_session_recovery` @277915059 /
 *    @276620665): `At=ky({serverName:Se.serverName,error:ft,namesMcpCall:!0,
 *    detail:At}),ct(q,At.slice(0,2000).replace(/[\uD800-\uDBFF]$/,""))` —
 *    the rendered text is dispatched through this cap + trailing lone-high-
 *    surrogate strip. This helper is that post-render tail.
 *  - `ky` definition @277681825 (@276388222) — the template lives in
 *    `renderSessionRecoveryResultText`; only the flag/cap differ per site.
 *
 * Official site-2 detail is `At=wne(e,ft.message,"(detail withheld)")` with
 * `wne(r,e,s){return xf(r)?s:e}` — `xf` gates on the hosted-worker/remote-
 * bridge context (`Grr({hostedWorker:hln(r),transportPersists:...})`), which
 * OCC does not have, so the detail is always the raw message (documented
 * trim, same as F-01's site-1 wiring).
 *
 * WIRING: OCC maps its two non-retried telemetry reasons onto the two
 * official shapes at the single live rethrow point
 * (`McpSessionRecoveryTextError` in client.ts): `may_have_run_no_retry` →
 * site-1 shape, `session_retry_exhausted` → this site-2 shape. Officially
 * the site choice is by calling SUBSYSTEM (both sites catch every non-retried
 * `UO` reason), not by reason; OCC's single-point mapping is the closest
 * live equivalent and is a documented deviation.
 */
export function renderSessionRecoveryDispatchText({
  serverName,
  error,
  detail,
}: {
  serverName: string
  error: SessionRecoveryError
  detail: string
}): string {
  return renderSessionRecoveryResultText({
    serverName,
    error,
    namesMcpCall: true,
    detail,
  })
    .slice(0, SESSION_TEXT_DISPATCH_CAP)
    .replace(SESSION_TEXT_TRAILING_HIGH_SURROGATE, '')
}
