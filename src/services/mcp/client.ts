import { feature } from 'src/utils/featureFlags.js'
import { Readable } from 'node:stream'
import {
  callMcpToolWithAutoBackground,
  getMcpAutoBackgroundMs,
  makeAppStateTaskRegistry,
  mcpBackgroundedMessage,
} from './autoBackground.js'
import {
  renderSessionRecoveryDispatchText,
  renderSessionRecoveryResultText,
  sanitizeSessionRecoveryText,
} from './sessionRecoveryText.js'
import { createCappedStderrAccumulator } from './stderrCap.js'
import type {
  Base64ImageSource,
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createFetchWithInit,
  type FetchLike,
  type Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  type ElicitRequestURLParams,
  type ElicitResult,
  ErrorCode,
  type JSONRPCMessage,
  type ListPromptsResult,
  ListPromptsResultSchema,
  type ListResourcesResult,
  ListResourcesResultSchema,
  ListRootsRequestSchema,
  type ListToolsResult,
  ListToolsResultSchema,
  McpError,
  type PromptMessage,
  type ResourceLink,
} from '@modelcontextprotocol/sdk/types.js'
import mapValues from 'lodash-es/mapValues.js'
import memoize from 'lodash-es/memoize.js'
import zipObject from 'lodash-es/zipObject.js'
import pMap from 'p-map'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { PRODUCT_URL } from '../../constants/product.js'
import type { AppState } from '../../state/AppState.js'
import {
  type Tool,
  type ToolCallProgress,
  toolMatchesName,
} from '../../Tool.js'
import { ListMcpResourcesTool } from '../../tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { type MCPProgress, MCPTool } from '../../tools/MCPTool/MCPTool.js'
import { createMcpAuthStubTools } from '../../tools/McpAuthTool/McpAuthTool.js'
import { ReadMcpResourceTool } from '../../tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { ReadMcpResourceDirTool } from '../../tools/ReadMcpResourceDirTool/ReadMcpResourceDirTool.js'
import { createAbortController } from '../../utils/abortController.js'
import { count } from '../../utils/array.js'
import { parseEnvInt } from '../../utils/envValidation.js'
import {
  checkAndRefreshOAuthTokenIfNeededBestEffort,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
} from '../../utils/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { detectCodeIndexingFromMcpServerName } from '../../utils/codeIndexing.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import {
  errorMessage,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../utils/errors.js'
import { getMCPUserAgent } from '../../utils/http.js'
import { maybeNotifyIDEConnected } from '../../utils/ide.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { readOwnOption } from '../../utils/plugins/optionKeySafety.js'
import {
  computePersistedLineStats,
  getBinaryBlobSavedMessage,
  getFormatDescription,
  getLargeOutputInstructions,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'
import {
  getContentSizeEstimate,
  type MCPToolResult,
  mcpContentNeedsTruncation,
  truncateMcpContentIfNeeded,
} from '../../utils/mcpValidation.js'
import { WebSocketTransport } from '../../utils/mcpWebSocketTransport.js'
import { memoizeWithLRU } from '../../utils/memoize.js'
import { getWebSocketTLSOptions } from '../../utils/mtls.js'
import {
  getProxyFetchOptions,
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
} from '../../utils/proxy.js'
import { recursivelySanitizeUnicode } from '../../utils/sanitization.js'
import {
  reservedMcpPromptMessage,
  shouldRefuseReservedName,
} from '../../utils/skills/reservedNames.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import {
  isPersistError,
  persistToolResult,
} from '../../utils/toolResultStorage.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  type ElicitationWaitingState,
  runElicitationHooks,
  runElicitationResultHooks,
} from './elicitationHandler.js'
import { isNetworkError, walkPaginatedList } from './listPagination.js'
import { filterMcpAppUiResources } from './mcpAppUiResources.js'
import {
  buildMcpToolName,
  getMcpServerNameCollisionKey,
  mcpInfoFromString,
} from './mcpStringUtils.js'
import { normalizeNameForMCP } from './normalization.js'
import { getMcpRoots } from './roots.js'
import { getLoggingSafeMcpBaseUrl, getProjectMcpServerStatus } from './utils.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? (
      require('../../skills/mcpSkills.js') as typeof import('../../skills/mcpSkills.js')
    ).fetchMcpSkillsForClient
  : null

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { AssistantMessage, Message } from 'src/types/message.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { classifyMcpToolForCollapse } from '../../tools/MCPTool/classifyForCollapse.js'
import { clearKeychainCache } from '../../utils/secureStorage/macOsKeychainHelpers.js'
import { sleep } from '../../utils/sleep.js'
import {
  ClaudeAuthProvider,
  hasMcpDiscoveryButNoToken,
  wrapFetchWithStepUpDetection,
} from './auth.js'
import { markClaudeAiMcpConnected } from './claudeai.js'
import { getAllMcpConfigs, isMcpServerDisabled } from './config.js'
import {
  McpCredentialStoreUnavailableError,
  isCredentialStoreUnavailableError,
} from './credentialStoreErrors.js'
import { getMcpServerHeaders } from './headersHelper.js'
import { SdkControlClientTransport } from './SdkControlTransport.js'
import {
  allSendsRanNothing,
  trackToolCallSends,
  type McpConnectionState,
  type ToolCallWatchdog,
} from './sendTracking.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  McpSdkServerConfig,
  McpStdioServerConfig,
  ScopedMcpServerConfig,
  ServerResource,
} from './types.js'

/**
 * Custom error class to indicate that an MCP tool call failed due to
 * authentication issues (e.g., expired OAuth token returning 401).
 * This error should be caught at the tool execution layer to update
 * the client's status to 'needs-auth'.
 */
export class McpAuthError extends Error {
  serverName: string
  constructor(serverName: string, message: string) {
    super(message)
    this.name = 'McpAuthError'
    this.serverName = serverName
  }
}

/**
 * claude-code 2.1.307 PORT B3 — session-expiry kinds (official `SO`
 * `expiryKind` values, linux ELF @241629553, byte-verified):
 *  - `session_expired_404` — server answered 404 + JSON-RPC -32001 for a
 *    session it no longer knows (the call definitively did not run).
 *  - `connection_closed_call_refused` — the connection closed before the
 *    call ran because the server refused it (malformed frame right after an
 *    auth challenge, or a session-expiry close where every send rejected
 *    pre-delivery).
 *  - `connection_closed_call_not_run` — the connection closed before the
 *    call ran (send tracking proves every tools/call send since the call's
 *    baseline rejected with a transport-level code).
 *  - `connection_closed_http` — the connection closed while the call was in
 *    flight; the tool MAY have run server-side.
 */
export type SessionExpiryKind =
  | 'session_expired_404'
  | 'connection_closed_call_refused'
  | 'connection_closed_call_not_run'
  | 'connection_closed_http'

/**
 * Thrown when an MCP session has expired / the connection closed mid-call and
 * the connection cache has been cleared. The caller should get a fresh client
 * via ensureConnectedClient and retry — but ONLY when the call provably did
 * not run, or the tool is safe to run twice (see
 * `shouldRetryAfterSessionRecovery`).
 *
 * 2.1.307 B3: official `SO extends R` (R = TelemetrySafeError base) with
 * verbatim per-kind messages and the `mayHaveRun` getter — true ONLY for
 * `connection_closed_http`:
 * `get mayHaveRun(){switch(this.expiryKind){case"session_expired_404":case"connection_closed_call_refused":case"connection_closed_call_not_run":return!1;case"connection_closed_http":return!0}}`
 */
export class McpSessionExpiredError extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  expiryKind: SessionExpiryKind

  constructor(
    serverName: string,
    expiryKind: SessionExpiryKind = 'session_expired_404',
  ) {
    super(
      expiryKind === 'connection_closed_http'
        ? `MCP server "${serverName}" connection closed before the tool call was answered. The tool may have run: check whether it did before running it again.`
        : expiryKind === 'connection_closed_call_not_run'
          ? `MCP server "${serverName}" connection closed before the tool call ran`
          : `MCP server "${serverName}" session expired`,
      'MCP session expired',
    )
    this.expiryKind = expiryKind
    this.name = 'McpSessionExpiredError'
  }

  get mayHaveRun(): boolean {
    switch (this.expiryKind) {
      case 'session_expired_404':
      case 'connection_closed_call_refused':
      case 'connection_closed_call_not_run':
        return false
      case 'connection_closed_http':
        return true
    }
    // Unreachable (the switch is exhaustive over SessionExpiryKind) —
    // lint-satisfying tail return; the official getter has no default.
    return false
  }
}

/**
 * The wrapper's non-retry reasons (the official `mcp_session_recovery`
 * named-counter pair emitted on the non-retried path — `Mt<1?
 * "may_have_run_no_retry":"session_retry_exhausted"` in the retry loop
 * catch, BIN309 @280496355 region).
 */
export type SessionRecoveryNonRetryReason =
  | 'may_have_run_no_retry'
  | 'session_retry_exhausted'

/**
 * 2.1.307 F-01 / 2.1.308 F-03 — the wrapper's live substitute for the
 * official `z_` (v309: `ky`) render sites. Officially, the renderer is
 * invoked at exactly two places (v2.1.309 linux ELF, byte-verified, never
 * executed; v307 equivalents in parens):
 *  - site 1, staged-SDK relay — `mcp_session_recovery` @277912896
 *    (@276618538): `ky({serverName:Se.serverName,error:ir,namesMcpCall:!1,
 *    detail:ir.message})` — UNCAPPED, no mcp_call suffix.
 *  - site 2, mcp_call dispatch — `mcp_session_recovery` @277915059
 *    (@276620665): `At=ky({serverName:Se.serverName,error:ft,
 *    namesMcpCall:!0,detail:At}),ct(q,At.slice(0,2000).replace(
 *    /[\uD800-\uDBFF]$/,""))` — mcp_call suffix + 2000-char cap + trailing
 *    lone-high-surrogate strip.
 *  - `ky` definition @277681825 (@276388222).
 * Both sites live in the CCR mcp_call / staged-SDK relay subsystem, which
 * OCC has NOT ported. OCC's live equivalent of the relay's
 * `{isError:!0,content:[{type:"text",text:ky({...})}]}` production point is
 * the tool wrapper's NON-retried session-expiry rethrow: toolExecution.ts
 * catches it and surfaces `formatError(error)` (= error.message) verbatim as
 * the isError tool_result text.
 *
 * F-03: the non-retry REASON picks the render shape —
 * `may_have_run_no_retry` → site-1 shape (renderSessionRecoveryResultText),
 * `session_retry_exhausted` → site-2 shape (renderSessionRecoveryDispatchText).
 * Officially the site choice is by calling subsystem (both sites catch every
 * non-retried `UO` reason), not by reason; OCC's single-rethrow-point mapping
 * is the closest live equivalent (documented deviation — see
 * sessionRecoveryText.ts).
 *
 * This subclass rewrites `message` to the rendered text while preserving
 * `instanceof McpSessionExpiredError`, `expiryKind`, `mayHaveRun` and the
 * 'MCP session expired' telemetryMessage. The raw per-kind class messages
 * above stay byte-pinned and untouched.
 */
export class McpSessionRecoveryTextError extends McpSessionExpiredError {
  constructor(
    serverName: string,
    original: McpSessionExpiredError,
    reason: SessionRecoveryNonRetryReason,
  ) {
    super(serverName, original.expiryKind)
    this.message =
      reason === 'session_retry_exhausted'
        ? renderSessionRecoveryDispatchText({
            serverName,
            error: original,
            detail: original.message,
          })
        : renderSessionRecoveryResultText({
            serverName,
            error: original,
            namesMcpCall: false,
            detail: original.message,
          })
  }
}

/**
 * 2.1.307 B3 — the official throw-site kind chain, extracted verbatim for
 * testability (linux ELF @279157850):
 * `ee?"session_expired_404":mZn(ue?.closeReason)||ue?.closeReason==="session expired"&&te?
 *  "connection_closed_call_refused":!K&&te?"connection_closed_call_not_run":"connection_closed_http"`
 * with `mZn(e){return e==="malformed message after an auth challenge"}`,
 * `te` = allSendsRanNothing(...), `K` = sessionId was undefined at call entry.
 */
export function classifySessionExpiryKind({
  isStaleSession,
  closeReason,
  ranNothing,
  sessionIdWasUndefined,
}: {
  isStaleSession: boolean
  closeReason: string | undefined
  ranNothing: boolean
  sessionIdWasUndefined: boolean
}): SessionExpiryKind {
  if (isStaleSession) {
    return 'session_expired_404'
  }
  if (
    closeReason === 'malformed message after an auth challenge' ||
    (closeReason === 'session expired' && ranNothing)
  ) {
    return 'connection_closed_call_refused'
  }
  if (!sessionIdWasUndefined && ranNothing) {
    return 'connection_closed_call_not_run'
  }
  return 'connection_closed_http'
}

/**
 * 2.1.307 B3 — the official retry-gate fragment, extracted verbatim for
 * testability (linux ELF @279114404):
 * `!ze.mayHaveRun||ee.isConcurrencySafe(te)||x.annotations?.idempotentHint===!0`
 * (`isConcurrencySafe` for an MCP tool is `annotations.readOnlyHint ?? false`).
 */
export function shouldRetryAfterSessionRecovery(
  annotations: { readOnlyHint?: boolean; idempotentHint?: boolean } | undefined,
  mayHaveRun: boolean,
): boolean {
  return (
    !mayHaveRun ||
    (annotations?.readOnlyHint ?? false) ||
    annotations?.idempotentHint === true
  )
}

/**
 * Thrown when an MCP tool returns `isError: true`. Carries the result's `_meta`
 * so SDK consumers can still receive it — per the MCP spec, `_meta` is on the
 * base Result type and is valid on error results.
 */
export class McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  constructor(
    message: string,
    telemetryMessage: string,
    readonly mcpMeta?: { _meta?: Record<string, unknown> },
  ) {
    super(message, telemetryMessage)
    this.name = 'McpToolCallError'
  }
}

/**
 * Detects whether an error is an MCP "Session not found" error (HTTP 404 + JSON-RPC code -32001).
 * Per the MCP spec, servers return 404 when a session ID is no longer valid.
 * We check both signals to avoid false positives from generic 404s (wrong URL, server gone, etc.).
 */
export function isMcpSessionExpiredError(error: Error): boolean {
  const httpStatus =
    'code' in error ? (error as Error & { code?: number }).code : undefined
  if (httpStatus !== 404) {
    return false
  }
  // The SDK embeds the response body text in the error message.
  // MCP servers return: {"error":{"code":-32001,"message":"Session not found"},...}
  // Check for the JSON-RPC error code to distinguish from generic web server 404s.
  return (
    error.message.includes('"code":-32001') ||
    error.message.includes('"code": -32001')
  )
}

/**
 * Default timeout for MCP tool calls (effectively infinite - ~27.8 hours).
 */
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000

/**
 * Ceiling for the `_meta["anthropic/maxResultSizeChars"]` override (claude-code
 * 2.1.91). An MCP tool may raise its persisted result-size limit up to 500K so
 * larger results (e.g. DB schemas) survive without truncation; values above
 * this are clamped. Mirrors v91's `Og1 = 500000`.
 */
export const MCP_MAX_RESULT_SIZE_CHARS_CEILING = 500_000

/**
 * Resolve an MCP tool's persisted result-size limit from its
 * `_meta["anthropic/maxResultSizeChars"]` override (claude-code 2.1.91).
 * A valid positive finite number is clamped to the 500K ceiling; anything
 * else falls back to the tool's default. Mirrors v91's
 * `A ? Math.min(O, Og1) : default`.
 */
export function resolveMcpMaxResultSizeChars(
  override: unknown,
  defaultValue: number,
): number {
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return Math.min(override, MCP_MAX_RESULT_SIZE_CHARS_CEILING)
  }
  return defaultValue
}

/**
 * Cap on MCP tool descriptions and server instructions sent to the model.
 * OpenAPI-generated MCP servers have been observed dumping 15-60KB of endpoint
 * docs into tool.description; this caps the p95 tail without losing the intent.
 *
 * claude-code 2.1.280 (#003): the cap became configurable per session via
 * `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` ("Added
 * CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH to change the 2,048-character cap on
 * MCP tool descriptions and server instructions for every MCP server in the
 * session"). Byte-verified in the 2.1.280 linux-x64 ELF:
 *
 *   t4e=2048                                                              // @197916615
 *   function lV(){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??t4e}    // @199142387
 *
 * The env-schema binding for this name is `ES=M.int({min:1,digitsOnly:!0})`
 * (namespace map @190802428 → factory call @190811950), and `M.int` parses as:
 *
 *   if(n?.digitsOnly && !/^[+-]?\d+$/.test(e.trim())) return;   // rejects 1e6 / 64_000 / 1,000
 *   let i=ac(e);                                                // parseInt(trimmed, 10)
 *   if(!Number.isFinite(i)) return;
 *   if(n?.min!==void 0 && i<n.min) return;                      // 0 / negatives rejected
 *   return i                                                    // no `max` → no upper clamp
 *
 * So: digits-only integers >= 1 are honored verbatim with NO upper clamp;
 * anything else (unset, empty, non-digit, sci-notation, separators, 0,
 * negative, NaN) falls back to the default through the `??`.
 *
 * CC 2.1.296 (#061): "Changed the default limit on MCP tool descriptions
 * sent up front and on MCP server instructions from 2,048 to 4,096
 * characters" (cl-296). The 296 getter keeps the same shape — binary
 * `Ax(e=!1){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??(e?sns:sxn)}`
 * @217807600-region — with the general-path constant (sxn, formerly
 * t4e/_Rn=2048) now 4096. The tool-search constant (sns≡Qts=16384, occ153
 * #112) is unchanged. Both surfaces (tool descriptions AND server
 * instructions) flow through this one constant in OCC —
 * truncateMcpDescription and truncateMcpServerInstructions — so the single
 * flip covers the whole changelog item.
 */
const DEFAULT_MAX_MCP_DESCRIPTION_LENGTH = 4096

/**
 * CC 2.1.295 item #112 — tool-search load path cap (binary `Qts=16384`
 * @213397142; `_Rn=2048,Qts=16384` is s295-only, s294 has neither token).
 * MCP tool descriptions LOADED THROUGH TOOL SEARCH are truncated at 16,384
 * chars instead of the general default (2,048 in s295; 4,096 since 296 per
 * #061) — the model explicitly asked for the tool, so it gets the fuller
 * description; the general (always-loaded) path keeps the default.
 */
const TOOL_SEARCH_MAX_MCP_DESCRIPTION_LENGTH = 16384

/**
 * Raw `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` env override, or undefined when
 * unset/invalid (the `a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??` half of the
 * official getter — parsing rules documented above).
 */
function getEnvMcpDescriptionLength(): number | undefined {
  const raw = process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH
  if (raw === undefined) {
    return undefined
  }
  // digitsOnly: reject anything that is not an integer literal. Unlike the
  // generic `M.int()` vars (which accept `1e6` / `64_000` via parseEnvInt's
  // notation branch), THIS var is bound with `digitsOnly:!0`.
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    return undefined
  }
  const parsed = parseEnvInt(raw)
  if (parsed === undefined || !Number.isFinite(parsed)) {
    return undefined
  }
  if (parsed < 1) {
    return undefined // min: 1
  }
  return parsed
}

/**
 * Effective MCP description/instruction cap (binary `mx`, 295 form
 * @~217055278: `mx(e=!1){return a.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH??
 * (e?Qts:_Rn)}`; s294's `UF(){return ...??X5o}` had NO branch — the
 * `loadedThroughToolSearch` parameter is the 295 delta). The env override
 * wins for BOTH load paths, exactly like the official `??`.
 *
 * Re-reads `process.env` on every call rather than memoizing: the official
 * getter is a lazy property over `process.env` that re-parses whenever the raw
 * string changes, so a mid-session env change takes effect on the next read.
 */
export function getMaxMcpDescriptionLength(
  loadedThroughToolSearch = false,
): number {
  return (
    getEnvMcpDescriptionLength() ??
    (loadedThroughToolSearch
      ? TOOL_SEARCH_MAX_MCP_DESCRIPTION_LENGTH
      : DEFAULT_MAX_MCP_DESCRIPTION_LENGTH)
  )
}

/**
 * Suffix appended to a truncated MCP description/instruction (binary `Qo`'s
 * `+"… [truncated]"` — U+2026 HORIZONTAL ELLIPSIS, one space, `[truncated]`).
 */
const MCP_DESCRIPTION_TRUNCATION_SUFFIX = '… [truncated]'

/**
 * Truncate one MCP description-like string to the effective cap.
 *
 * Byte-verified port of the 2.1.280 shared truncator (@223009548 `Qo`,
 * duplicate chunk copy @223182124 `Pr`):
 *
 *   function Qo(e,n,r){let s=lV();
 *     if(e.length<=s)return e;
 *     if(r!==void 0)te(r,`${n} truncated from ${e.length} to ${s} chars`);
 *     return re(e,s)+"… [truncated]"}
 *
 * `label` is the official message subject — `"Server instructions"` or
 * `` `Tool "${toolName}" description` `` (factory `xi`, @223078250:
 * `Ae=Qo(Le,`Tool "${q.name}" description`,e)`). When `serverName` is given the
 * official logs `${label} truncated from ${len} to ${cap} chars` at MCP debug
 * level before returning the truncated text.
 *
 * NOTE: the official slices with the surrogate-aware `re(e,n)` (@190617057),
 * which is NOT a 2.1.280 delta (identical in 2.1.278) and whose inner `Ie()`
 * normalizer is not byte-verified. OCC matches its observable contract: a cut
 * landing mid-surrogate-pair drops the trailing lone high surrogate instead of
 * emitting it into the prompt.
 *
 * Exported for direct unit testing (the official uses the same truncator from
 * the connect path, the tool factory and the `/mcp` tool-detail UI).
 */
export function truncateMcpDescription(
  text: string,
  label: string,
  serverName?: string,
  // CC 2.1.295 #112 — official truncator gained a cap parameter in 295:
  // `Jt(e,r,n,s=mx())` @243847045 (s294 `Qo` computed `let s=lV()` inline).
  // The factory passes `mx(!0)` (16384) for the tool-search variant; all
  // other call sites keep the default (env ?? 4096 since CC 2.1.296 #061).
  cap: number = getMaxMcpDescriptionLength(),
): string {
  const limit = cap
  if (text.length <= limit) {
    return text
  }
  if (serverName !== undefined) {
    logMCPDebug(
      serverName,
      `${label} truncated from ${text.length} to ${limit} chars`,
    )
  }
  return sliceSurrogateAware(text, limit) + MCP_DESCRIPTION_TRUNCATION_SUFFIX
}

/**
 * Surrogate-aware cut of an already-oversized string (the observable contract
 * of the official `re(e,n)` slicer): if the fixed-length cut landed between a
 * surrogate pair, the slice ends with a lone high surrogate (0xD800–0xDBFF) —
 * drop it so a broken UTF-16 code unit never reaches a prompt. BMP cuts (and
 * cuts that keep an astral char whole) pass through byte-identical.
 */
function sliceSurrogateAware(text: string, limit: number): string {
  const sliced = text.slice(0, limit)
  const lastCharCode = sliced.charCodeAt(sliced.length - 1)
  return lastCharCode >= 0xd800 && lastCharCode <= 0xdbff
    ? sliced.slice(0, -1)
    : sliced
}

/**
 * Server-instructions truncation (binary `Zo`, @223009523):
 *   function Zo(e,n){if(!e)return e;return Qo(e,"Server instructions",n)}
 * Falsy/absent instructions pass through untouched (no log, no suffix).
 */
export function truncateMcpServerInstructions(
  instructions: string | undefined,
  serverName: string,
): string | undefined {
  if (!instructions) {
    return instructions
  }
  return truncateMcpDescription(instructions, 'Server instructions', serverName)
}

/**
 * Gets the timeout for MCP tool calls in milliseconds.
 * Uses MCP_TOOL_TIMEOUT environment variable if set, otherwise defaults to ~27.8 hours.
 */
function getMcpToolTimeoutMs(): number {
  return (
    parseEnvInt(process.env.MCP_TOOL_TIMEOUT) ??
    DEFAULT_MCP_TOOL_TIMEOUT_MS
  )
}

import { isClaudeInChromeMCPServer } from '../../utils/claudeInChrome/common.js'

// Lazy: toolRendering.tsx pulls React/ink; only needed when Claude-in-Chrome MCP server is connected
/* eslint-disable @typescript-eslint/no-require-imports */
const claudeInChromeToolRendering =
  (): typeof import('../../utils/claudeInChrome/toolRendering.js') =>
    require('../../utils/claudeInChrome/toolRendering.js')
// Lazy: wrapper.tsx → hostAdapter.ts → executor.ts pulls both native modules
// (@ant/computer-use-input + @ant/computer-use-swift). Runtime-gated by
// GrowthBook tengu_malort_pedway (see gates.ts).
const computerUseWrapper = feature('CHICAGO_MCP')
  ? (): typeof import('../../utils/computerUse/wrapper.js') =>
      require('../../utils/computerUse/wrapper.js')
  : undefined
const isComputerUseMCPServer = feature('CHICAGO_MCP')
  ? (
      require('../../utils/computerUse/common.js') as typeof import('../../utils/computerUse/common.js')
    ).isComputerUseMCPServer
  : undefined

import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

const MCP_AUTH_CACHE_TTL_MS = 15 * 60 * 1000 // 15 min

type McpAuthCacheData = Record<string, { timestamp: number }>

function getMcpAuthCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'mcp-needs-auth-cache.json')
}

// Memoized so N concurrent isMcpAuthCached() calls during batched connection
// share a single file read instead of N reads of the same file. Invalidated
// on write (setMcpAuthCacheEntry) and clear (clearMcpAuthCache). Not using
// lodash memoize because we need to null out the cache, not delete by key.
let authCachePromise: Promise<McpAuthCacheData> | null = null

function getMcpAuthCache(): Promise<McpAuthCacheData> {
  if (!authCachePromise) {
    authCachePromise = readFile(getMcpAuthCachePath(), 'utf-8')
      .then(data => jsonParse(data) as McpAuthCacheData)
      .catch(() => ({}))
  }
  return authCachePromise
}

async function isMcpAuthCached(serverId: string): Promise<boolean> {
  const cache = await getMcpAuthCache()
  const entry = cache[serverId]
  if (!entry) {
    return false
  }
  return Date.now() - entry.timestamp < MCP_AUTH_CACHE_TTL_MS
}

// Serialize cache writes through a promise chain to prevent concurrent
// read-modify-write races when multiple servers return 401 in the same batch
let writeChain = Promise.resolve()

// Shared writer for BOTH cache mutators (set + remove) so the pair stays
// symmetric: mkdir-recursive before writeFile, matching setMcpAuthCacheEntry's
// long-standing behavior. Robustness only on the remove path — its write is
// gated on a successful read (so the dir normally exists), but a memoized read
// can outlive a config dir removed mid-session, and a bare writeFile would
// then ENOENT into the best-effort .catch and silently skip the rewrite.
async function writeMcpAuthCacheFile(cache: McpAuthCacheData): Promise<void> {
  const cachePath = getMcpAuthCachePath()
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, jsonStringify(cache))
}

function setMcpAuthCacheEntry(serverId: string): void {
  writeChain = writeChain
    .then(async () => {
      const cache = await getMcpAuthCache()
      cache[serverId] = { timestamp: Date.now() }
      await writeMcpAuthCacheFile(cache)
      // Invalidate the read cache so subsequent reads see the new entry.
      // Safe because writeChain serializes writes: the next write's
      // getMcpAuthCache() call will re-read the file with this entry present.
      authCachePromise = null
    })
    .catch(() => {
      // Best-effort cache write
    })
}

/**
 * claude-code 2.1.280 (#048): drop ONE server's `needs-auth` cache entry.
 *
 * "Fixed an MCP server re-added under the same name after `claude mcp remove`
 * still showing as needing authentication instead of reconnecting." The 15-min
 * TTL cache in `mcp-needs-auth-cache.json` is consulted by the connect path
 * (`isMcpAuthCached`) to skip servers that recently 401'd; without a per-key
 * removal, a server deleted and re-added inside the TTL inherits the stale
 * flag and is reported as `needs-auth` without ever reconnecting.
 *
 * Byte-verified in the 2.1.280 linux-x64 ELF (@223017165 `ln`; duplicate chunk
 * copy @223184732 `Ct`):
 *
 *   function ln(e,n){let r=jt(),s=r.authCacheWriteChain.then(async()=>{
 *     let d=await WAe(n);                       // memoized read; missing/corrupt file → {}
 *     if(!(e in d))return;                      // absent key → NO write at all
 *     if(delete d[e],N()&&n!==void 0){if(!await or(n,d))return}
 *     else await Kt().write(jAe(),S(d));        // rewrite mcp-needs-auth-cache.json
 *     i6e()                                     // invalidate the memoized read
 *   }).catch(()=>{});                           // never throws / never rejects
 *   return r.authCacheWriteChain=s,s}
 *
 * The function already existed in 2.1.278 (used by `mcp login`); the 2.1.280
 * delta is the NEW unconditional call from the `mcp remove` handler
 * (@219311718) — see `mcpRemoveHandler`. OCC has no config-publisher
 * (`N()&&n!==void 0`) branch, so this is the plain file-write path.
 *
 * Fail-safe by construction: chained on `writeChain` (no read-modify-write
 * race), no-ops without touching disk when the key is absent, tolerates a
 * missing/corrupt cache file (`getMcpAuthCache` already `.catch(() => ({}))`),
 * and swallows its own errors so `mcp remove` can never fail on cache cleanup.
 */
export function removeMcpAuthCacheEntry(serverId: string): Promise<void> {
  const next = writeChain
    .then(async () => {
      const cache = await getMcpAuthCache()
      if (!(serverId in cache)) {
        return
      }
      delete cache[serverId]
      await writeMcpAuthCacheFile(cache)
      // Invalidate the memoized read so the next isMcpAuthCached() re-reads the
      // file and no longer sees the removed entry.
      authCachePromise = null
    })
    .catch(() => {
      // Best-effort cache removal (binary `.catch(()=>{})`)
    })
  writeChain = next
  return next
}

export function clearMcpAuthCache(): void {
  authCachePromise = null
  void unlink(getMcpAuthCachePath()).catch(() => {
    // Cache file may not exist
  })
}

/**
 * @internal Test-only: drop the memoized needs-auth cache read WITHOUT unlinking
 * the file. Tests that point `CLAUDE_CONFIG_DIR` at a fresh temp dir per case
 * need the memo gone so the next read hits their own directory, but must not
 * delete a fixture they seeded on disk (which is what `clearMcpAuthCache` does).
 *
 * Deliberately named apart from `clearMcpAuthCache`: Bun's `mock.module` leaks
 * across test files in one worker (OCC-97), and
 * src/tools/McpAuthTool/__tests__/mcpAuthStubTools274.test.ts replaces the
 * `clearMcpAuthCache` export with a call counter, which silently defeats any
 * other file's memo reset. Precedent: `_resetErrorLogForTesting` in
 * src/utils/log.ts, `resetWebFetchCacheTtlForTesting` in
 * src/tools/WebFetchTool/cacheTtl.ts.
 */
export function _resetMcpAuthCacheForTesting(): void {
  authCachePromise = null
}

/**
 * Spread-ready analytics field for the server's base URL. Calls
 * getLoggingSafeMcpBaseUrl once (not twice like the inline ternary it replaces).
 * Typed as AnalyticsMetadata since the URL is query-stripped and safe to log.
 */
function mcpBaseUrlAnalytics(serverRef: ScopedMcpServerConfig): {
  mcpServerBaseUrl?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
} {
  const url = getLoggingSafeMcpBaseUrl(serverRef)
  return url
    ? {
        mcpServerBaseUrl:
          url as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }
    : {}
}

/**
 * Shared handler for sse/http/claudeai-proxy auth failures during connect:
 * emits tengu_mcp_server_needs_auth, caches the needs-auth entry, and returns
 * the needs-auth connection result.
 */
function handleRemoteAuthFailure(
  name: string,
  serverRef: ScopedMcpServerConfig,
  transportType: 'sse' | 'http' | 'claudeai-proxy',
): MCPServerConnection {
  logEvent('tengu_mcp_server_needs_auth', {
    transportType:
      transportType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...mcpBaseUrlAnalytics(serverRef),
  })
  const label: Record<typeof transportType, string> = {
    sse: 'SSE',
    http: 'HTTP',
    'claudeai-proxy': 'claude.ai proxy',
  }
  logMCPDebug(
    name,
    `Authentication required for ${label[transportType]} server`,
  )
  setMcpAuthCacheEntry(name)
  return { name, type: 'needs-auth', config: serverRef }
}

/**
 * Fetch wrapper for claude.ai proxy connections. Attaches the OAuth bearer
 * token and retries once on 401 via handleOAuth401Error (force-refresh).
 *
 * The Anthropic API path has this retry (withRetry.ts, grove.ts) to handle
 * memoize-cache staleness and clock drift. Without the same here, a single
 * stale token mass-401s every claude.ai connector and sticks them all in the
 * 15-min needs-auth cache.
 */
export function createClaudeAiProxyFetch(innerFetch: FetchLike): FetchLike {
  return async (url, init) => {
    const doRequest = async () => {
      // CC 2.1.301 (#9) P2 guard: this wrapper runs on EVERY claudeai-proxy
      // connector request (dozens of servers in parallel), so the 301
      // disk-full throw would mass-reject them with no catch in between.
      // Degrade ONLY that throw to the pre-301 `false` semantics — proceed
      // with the on-disk token; the 401 retry path below (handleOAuth401Error,
      // already .catch-guarded) remains the failure surface.
      await checkAndRefreshOAuthTokenIfNeededBestEffort('[mcp claudeai-proxy]')
      const currentTokens = getClaudeAIOAuthTokens()
      if (!currentTokens) {
        throw new Error('No claude.ai OAuth token available')
      }
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${currentTokens.accessToken}`)
      const response = await innerFetch(url, { ...init, headers })
      // Return the exact token that was sent. Reading getClaudeAIOAuthTokens()
      // again after the request is wrong under concurrent 401s: another
      // connector's handleOAuth401Error clears the memoize cache, so we'd read
      // the NEW token from keychain, pass it to handleOAuth401Error, which
      // finds same-as-keychain → returns false → skips retry. Same pattern as
      // bridgeApi.ts withOAuthRetry (token passed as fn param).
      return { response, sentToken: currentTokens.accessToken }
    }

    const { response, sentToken } = await doRequest()
    if (response.status !== 401) {
      return response
    }
    // handleOAuth401Error returns true only if the token actually changed
    // (keychain had a newer one, or force-refresh succeeded). Gate retry on
    // that — otherwise we double round-trip time for every connector whose
    // downstream service genuinely needs auth (the common case: 30+ servers
    // with "MCP server requires authentication but no OAuth token configured").
    const tokenChanged = await handleOAuth401Error(sentToken).catch(() => false)
    logEvent('tengu_mcp_claudeai_proxy_401', {
      tokenChanged:
        tokenChanged as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (!tokenChanged) {
      // ELOCKED contention: another connector may have won the lockfile and refreshed — check if token changed underneath us
      const now = getClaudeAIOAuthTokens()?.accessToken
      if (!now || now === sentToken) {
        return response
      }
    }
    try {
      return (await doRequest()).response
    } catch {
      // Retry itself failed (network error). Return the original 401 so the
      // outer handler can classify it.
      return response
    }
  }
}

// Minimal interface for WebSocket instances passed to mcpWebSocketTransport
type WsClientLike = {
  readonly readyState: number
  close(): void
  send(data: string): void
}

/**
 * Create a ws.WebSocket client with the MCP protocol.
 * Bun's ws shim types lack the 3-arg constructor (url, protocols, options)
 * that the real ws package supports, so we cast the constructor here.
 */
async function createNodeWsClient(
  url: string,
  options: Record<string, unknown>,
): Promise<WsClientLike> {
  const wsModule = await import('ws')
  const WS = wsModule.default as unknown as new (
    url: string,
    protocols: string[],
    options: Record<string, unknown>,
  ) => WsClientLike
  return new WS(url, ['mcp'], options)
}

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

function getConnectionTimeoutMs(): number {
  return parseEnvInt(process.env.MCP_TIMEOUT) ?? 30000
}

/**
 * Default timeout for individual MCP requests (auth, tool calls, etc.)
 */
const MCP_REQUEST_TIMEOUT_MS = 60000

/**
 * 2.1.206 alignment: resolve the per-server request timeout (ms) from config.
 * When `request_timeout_ms` is set on a server config, it overrides the 60s
 * per-HTTP-request default AND the default tool-call timeout for that server.
 * Matches official CC 2.1.206's per-server `request_timeout_ms` handling —
 * previously the field was silently ignored, causing long-running MCP tool
 * calls to time out at the 60s default in fresh sessions.
 *
 * Returns `undefined` when unset so callers can fall back to their own default.
 */
export function getServerRequestTimeoutMs(
  serverRef: ScopedMcpServerConfig,
): number | undefined {
  const t = (
    serverRef as { request_timeout_ms?: unknown }
  ).request_timeout_ms
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
    return t
  }
  return undefined
}

/**
 * MCP Streamable HTTP spec requires clients to advertise acceptance of both
 * JSON and SSE on every POST. Servers that enforce this strictly reject
 * requests without it (HTTP 406).
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sending-messages-to-the-server
 */
const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'

/**
 * Wraps a fetch function to apply a fresh timeout signal to each request.
 * This avoids the bug where a single AbortSignal.timeout() created at connection
 * time becomes stale after 60 seconds, causing all subsequent requests to fail
 * immediately with "The operation timed out." Uses a 60-second timeout.
 *
 * Also ensures the Accept header required by the MCP Streamable HTTP spec is
 * present on POSTs. The MCP SDK sets this inside StreamableHTTPClientTransport.send(),
 * but it is attached to a Headers instance that passes through an object spread here,
 * and some runtimes/agents have been observed dropping it before it reaches the wire.
 * See https://github.com/anthropics/claude-agent-sdk-typescript/issues/202.
 * Normalizing here (the last wrapper before fetch()) guarantees it is sent.
 *
 * GET requests are excluded from the timeout since, for MCP transports, they are
 * long-lived SSE streams meant to stay open indefinitely. (Auth-related GETs use
 * a separate fetch wrapper with its own timeout in auth.ts.)
 *
 * @param baseFetch - The fetch function to wrap
 */
/**
 * 2.1.139: cap MCP HTTP response bodies at 16MB, matching the official 2.1.200
 * binary (axios maxContentLength/maxBodyLength = 16777216). Defends against a
 * misbehaving server returning an enormous body that would exhaust memory.
 * Enforced two ways: (1) reject early if Content-Length exceeds the limit;
 * (2) wrap the body so a missing/lying Content-Length (chunked) still trips.
 * Applied to POST responses only — GET is the long-lived SSE stream (skipped
 * by the timeout above too), and the POST response is a buffered JSON-RPC
 * body, so buffering up to the cap is safe.
 */
const MAX_MCP_RESPONSE_BYTES = 16 * 1024 * 1024

/**
 * CC 2.1.299 #079 (anthropics/claude-code#99014): does this outbound POST body
 * contain NO JSON-RPC request? A request has `method` AND a defined `id`; a
 * notification has `method` but no `id`; a response has `result`/`error`.
 * Mirrors the SDK's own `hasRequests` filter in
 * StreamableHTTPClientTransport.send() (`messages.filter(msg => 'method' in
 * msg && 'id' in msg && msg.id !== undefined).length > 0`): when a batch has
 * zero requests, send() never consumes the response body as JSON-RPC — it only
 * does `await response.text()` to release the connection. Such a body carries
 * nothing the caller needs, so it must NOT be drained/capped.
 */
function postBodyHasNoRequests(body: unknown): boolean {
  if (typeof body !== 'string' || body.length === 0) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed]
  if (messages.length === 0) return false
  return !messages.some(
    m =>
      !!m &&
      typeof m === 'object' &&
      'method' in m &&
      'id' in m &&
      (m as { id?: unknown }).id !== undefined,
  )
}

async function capMcpResponseBody(response: Response): Promise<Response> {
  const contentLength = parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_MCP_RESPONSE_BYTES) {
    throw new Error(
      `MCP response body exceeds ${MAX_MCP_RESPONSE_BYTES} byte limit (${contentLength} bytes)`,
    )
  }
  const body = response.body
  if (!body) {
    return response
  }
  const reader = body.getReader()
  let received = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      received += value.byteLength
      if (received > MAX_MCP_RESPONSE_BYTES) {
        throw new Error(
          `MCP response body exceeds ${MAX_MCP_RESPONSE_BYTES} byte limit`,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const buf = new Uint8Array(received)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new Response(buf, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function wrapFetchWithTimeout(
  baseFetch: FetchLike,
  requestTimeoutMs: number = MCP_REQUEST_TIMEOUT_MS,
): FetchLike {
  return async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()

    // Skip timeout for GET requests - in MCP transports, these are long-lived SSE streams.
    // (OAuth discovery GETs in auth.ts use a separate createAuthFetch() with its own timeout.)
    if (method === 'GET') {
      return baseFetch(url, init)
    }

    // Normalize headers and guarantee the Streamable-HTTP Accept value. new Headers()
    // accepts HeadersInit | undefined and copies from plain objects, tuple arrays,
    // and existing Headers instances — so whatever shape the SDK handed us, the
    // Accept value survives the spread below as an own property of a concrete object.
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    if (!headers.has('accept')) {
      headers.set('accept', MCP_STREAMABLE_HTTP_ACCEPT)
    }

    // Use setTimeout instead of AbortSignal.timeout() so we can clearTimeout on
    // completion. AbortSignal.timeout's internal timer is only released when the
    // signal is GC'd, which in Bun is lazy — ~2.4KB of native memory per request
    // lingers for the full 60s even when the request completes in milliseconds.
    const controller = new AbortController()
    const timer = setTimeout(
      c =>
        c.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      requestTimeoutMs,
      controller,
    )
    timer.unref?.()

    const parentSignal = init?.signal
    const abort = () => controller.abort(parentSignal?.reason)
    parentSignal?.addEventListener('abort', abort)
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason)
    }

    const cleanup = () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abort)
    }

    try {
      const response = await baseFetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      })
      cleanup()
      // CC 2.1.299 #079 (anthropics/claude-code#99014): a NOTIFICATION (or
      // response) POST carries no request id, so the SDK's send() never reads
      // the reply body as JSON-RPC — it only `await response.text()`s to
      // release the connection. The timeout was just cleared above, so if we
      // drained such a body via capMcpResponseBody and the server never ends
      // it, the read loop would hang forever (the reported 30s+ stall/fail).
      // Cancel the body instead (cancel() resolves promptly even on a
      // never-ending stream) and hand back an empty-body response. Requests
      // (id'd messages) still go through capMcpResponseBody — their body is
      // the JSON-RPC/SSE payload the SDK fully awaits.
      if (postBodyHasNoRequests(init?.body)) {
        await response.body?.cancel().catch(() => {})
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      return capMcpResponseBody(response)
    } catch (error) {
      cleanup()
      throw error
    }
  }
}

export function getMcpServerConnectionBatchSize(): number {
  return parseEnvInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE) ?? 3
}

function getRemoteMcpServerConnectionBatchSize(): number {
  return (
    parseEnvInt(process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE) ??
    20
  )
}

function isLocalMcpServer(config: ScopedMcpServerConfig): boolean {
  return !config.type || config.type === 'stdio' || config.type === 'sdk'
}

// For the IDE MCP servers, we only include specific tools
const ALLOWED_IDE_TOOLS = ['mcp__ide__executeCode', 'mcp__ide__getDiagnostics']
function isIncludedMcpTool(tool: Tool): boolean {
  return (
    !tool.name.startsWith('mcp__ide__') || ALLOWED_IDE_TOOLS.includes(tool.name)
  )
}

/**
 * Generates the cache key for a server connection
 * @param name Server name
 * @param serverRef Server configuration
 * @returns Cache key string
 */
export function getServerCacheKey(
  name: string,
  serverRef: ScopedMcpServerConfig,
): string {
  return `${name}-${jsonStringify(serverRef)}`
}

// ---------------------------------------------------------------------------
// CC 2.1.295 (item 3): rapid-drop reconnect backoff for remote transports.
// The official `yDo` factory attaches a close handler to every connected
// REMOTE client (`le()`: type !== undefined && type !== 'stdio' &&
// type !== 'sdk') and redials it, applying a capped exponential hold-off
// when the transport keeps dropping soon after connecting:
//
//   lifetime   = max(0, now - connectionStart)
//   rapidDrops = lifetime < 10_000 ? (previous ?? 0) + 1 : 0    (nns = 1e4)
//   holdoff    = rapidDrops > 1 ? gnt(rapidDrops - 1) - lifetime : 0
//   gnt(a)     = min(30_000, 1000 * 2^(a-1))                    (w/h)
//   log: `${config.type} transport closed again soon after it connected:
//          reconnecting in ${holdoff}ms`
//
// The interactive REPL replaces client.onclose with its own reconnect loop
// (useManageMCPConnections), so this drives the shared/headless close path,
// which previously had NO redial and NO backoff at all.
// ---------------------------------------------------------------------------

/** Official `nns`: a drop within this connection lifetime counts as rapid. */
export const RAPID_DROP_THRESHOLD_MS = 10_000
/** Official `w`: base delay for the redial hold-off exponential. */
export const RECONNECT_BACKOFF_BASE_MS = 1_000
/** Official `h`: ceiling for the redial hold-off. */
export const RECONNECT_BACKOFF_CAP_MS = 30_000
/** Official `ie`/`ae`: wait up to 5×1s for an unsettled explicit dial. */
const UNSETTLED_DIAL_WAIT_ROUNDS = 5
const UNSETTLED_DIAL_WAIT_MS = 1_000

/** Rapid-drop counts keyed by server cache key (official: WeakMap + seed). */
const rapidDropCounts = new Map<string, number>()
const headlessRedialsInFlight = new Set<string>()
const explicitReconnectsInFlight = new Set<string>()
const activeHeadlessRedials = new Set<AbortController>()
let headlessRedialsCancelled = false

registerCleanup(async () => {
  headlessRedialsCancelled = true
  for (const controller of activeHeadlessRedials) {
    controller.abort()
  }
  activeHeadlessRedials.clear()
})

/** Official rapid-drop counting: increment only when the drop was rapid. */
export function nextRapidDropCount(
  previousCount: number,
  connectionLifetimeMs: number,
): number {
  return connectionLifetimeMs < RAPID_DROP_THRESHOLD_MS
    ? previousCount + 1
    : 0
}

/** Official `gnt`: capped exponential backoff min(capMs, baseMs·2^(a-1)). */
export function reconnectBackoffMs(attempt: number): number {
  return Math.min(
    RECONNECT_BACKOFF_CAP_MS,
    RECONNECT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
  )
}

/**
 * Official hold-off `T`: the backoff for attempt-1 minus the lifetime the
 * connection already managed, never before the second consecutive rapid
 * drop (attempt <= 1 reconnects immediately, as before).
 */
export function computeReconnectHoldoffMs(
  rapidDropAttempt: number,
  connectionLifetimeMs: number,
): number {
  if (rapidDropAttempt <= 1) return 0
  return Math.max(
    0,
    reconnectBackoffMs(rapidDropAttempt - 1) - connectionLifetimeMs,
  )
}

function scheduleHeadlessRemoteRedial(
  name: string,
  serverRef: ScopedMcpServerConfig,
  connectionLifetimeMs: number,
): void {
  if (headlessRedialsCancelled) return
  const key = getServerCacheKey(name, serverRef)
  const rapidDrops = nextRapidDropCount(
    rapidDropCounts.get(key) ?? 0,
    connectionLifetimeMs,
  )
  // dataflow-006: prune the entry when the count resets to zero (stable
  // connection) so the module-level Map doesn't grow unboundedly over a
  // long-lived REPL session.
  if (rapidDrops === 0) {
    rapidDropCounts.delete(key)
  } else {
    rapidDropCounts.set(key, rapidDrops)
  }

  const holdoffMs = computeReconnectHoldoffMs(rapidDrops, connectionLifetimeMs)
  if (holdoffMs > 0) {
    logMCPDebug(
      name,
      `${serverRef.type} transport closed again soon after it connected: reconnecting in ${holdoffMs}ms`,
    )
  }
  if (headlessRedialsInFlight.has(key)) return
  headlessRedialsInFlight.add(key)

  const abortController = new AbortController()
  activeHeadlessRedials.add(abortController)
  void (async () => {
    try {
      if (holdoffMs > 0) {
        await sleep(holdoffMs, abortController.signal, { unref: true })
      }
      // Let an in-flight explicit reconnect (reconnectMcpServerImpl) settle
      // so the background redial doesn't race it — the official waits up to
      // 5×1s on unsettled dials for the same server.
      for (
        let round = 0;
        round < UNSETTLED_DIAL_WAIT_ROUNDS &&
        explicitReconnectsInFlight.has(key);
        round++
      ) {
        await sleep(UNSETTLED_DIAL_WAIT_MS, abortController.signal, {
          unref: true,
        })
      }
      if (abortController.signal.aborted || headlessRedialsCancelled) return
      // dataflow-003: re-read the latest config so any changes made during the
      // holdoff window (e.g. URL rotation, header update) are picked up instead
      // of reconnecting with the stale serverRef captured at drop time.
      const { servers: latestServers } = await getAllMcpConfigs()
      // CC 2.1.299 #042-class hardening: own-property read only. A server
      // named after an Object.prototype member (`constructor`, `toString`, …)
      // that is ABSENT from the latest config must fall back to serverRef —
      // a raw `latestServers[name]` index read would pick up the inherited
      // prototype member (truthy) and redial with a bogus config object.
      const latestRef = readOwnOption(latestServers, name) ?? serverRef
      const redial = await connectToServer(name, latestRef)
      if (redial.type !== 'connected') {
        // Don't leave a failed background dial in the memo cache — the next
        // use should get a fresh dial, exactly like the lazy-redial behavior.
        connectToServer.cache.delete(getServerCacheKey(name, latestRef))
      }
    } catch (error) {
      connectToServer.cache.delete(key)
      logMCPDebug(name, `Background redial failed: ${errorMessage(error)}`)
    } finally {
      activeHeadlessRedials.delete(abortController)
      headlessRedialsInFlight.delete(key)
    }
  })()
}

/**
 * @internal Test-only: expose the rapidDropCounts map so dataflow-006 pruning
 * can be verified (key deleted when count resets to zero on a stable connection).
 * Precedent: `_resetMcpAuthCacheForTesting` above.
 */
export const _rapidDropCountsForTesting = rapidDropCounts

/**
 * @internal Test-only: expose the in-flight redial guard set so the redial
 * wiring integration probe can assert exactly-once scheduling and cleanup.
 */
export const _headlessRedialsInFlightForTesting = headlessRedialsInFlight

/**
 * @internal Test-only: expose the active redial AbortController set so the
 * redial wiring integration probe can assert cleanup after success/failure.
 */
export const _activeHeadlessRedialsForTesting = activeHeadlessRedials

/**
 * @internal Test-only: expose scheduleHeadlessRemoteRedial for integration
 * probes that verify the in-flight race guard, rapidDropCounts pruning, and
 * activeHeadlessRedials cleanup without needing a real MCP transport.
 */
export const _scheduleHeadlessRemoteRedialForTesting = scheduleHeadlessRemoteRedial

// ---------------------------------------------------------------------------
// claude-code 2.1.307 PORT B2 — MCP sleep-recovery (CONNECT_SUSPENDED redial).
// Official sources (linux ELF @278908635 + @279090513, byte-verified, never
// executed): `Hie="CONNECT_SUSPENDED"`, `z=10` (max redials), `aZs=1000`
// (suspend gap threshold), `CIt` timing capture, `RIt` awake-ms formatter,
// `Y0n` suspended classifier, `X0n` redial loop. The official timeout
// rejection carries `Object.assign(err,{code:"CONNECT_TIMEOUT"})` behind gate
// `tengu_mcp_connect_timeout_retry` (default true); the classifier is behind
// gate `tengu_mcp_connect_suspend_redial` (default true). OCC has no gate
// infra — both are default-true helpers/constants with the gate names noted.
// ---------------------------------------------------------------------------

/** Official `Hie` — errorCode for a sleep/clock-jump collapsed connect. */
export const CONNECT_SUSPENDED = 'CONNECT_SUSPENDED'

/** Code the official timeout rejection carries (`Object.assign(r,{code:...})`). */
export const CONNECT_TIMEOUT = 'CONNECT_TIMEOUT'

/** Official `aZs` — wall-vs-awake gap (ms) that indicates a suspend. */
export const SUSPEND_GAP_THRESHOLD_MS = 1000

/** Official `z` — suspended-connect redial cap. */
export const MAX_CONNECT_SUSPEND_REDIALS = 10

/**
 * Official `CIt` — connect-entry timing record: wall clock (`now()`) plus
 * monotonic (`monotonicNow()`, which does NOT advance while the machine
 * sleeps). `performance.now()` is OCC's monotonic clock.
 */
export interface ConnectTiming {
  wallStart: number
  awakeStart: number
}

export function captureConnectTiming(): ConnectTiming {
  return { wallStart: Date.now(), awakeStart: performance.now() }
}

/**
 * Official `RIt` — `${Math.round(now-wallStart)}ms, ${Math.round(monotonic-
 * awakeStart)}ms of it awake`.
 */
export function formatConnectTiming(
  timing: ConnectTiming,
  nowMs: number = Date.now(),
  awakeNowMs: number = performance.now(),
): string {
  return `${Math.round(nowMs - timing.wallStart)}ms, ${Math.round(
    awakeNowMs - timing.awakeStart,
  )}ms of it awake`
}

/**
 * Official gate `k("tengu_mcp_connect_suspend_redial",!0)`. OCC has no
 * Statsig/gate infra — default-true per the official default.
 */
function isMcpConnectSuspendRedialEnabled(): boolean {
  return true
}

/**
 * Official `Y0n` — classify a CONNECT_TIMEOUT as sleep-collapsed: when the
 * wall-elapsed minus awake-elapsed gap exceeds `SUSPEND_GAP_THRESHOLD_MS`
 * (strict `>`), the machine slept (or its clock jumped) mid-connect. Returns
 * the verbatim official suspended message, or undefined when not suspended.
 */
export function detectSuspendedConnect(
  name: string,
  timing: ConnectTiming,
  nowMs: number = Date.now(),
  awakeNowMs: number = performance.now(),
): string | undefined {
  if (
    !(
      nowMs - timing.wallStart - (awakeNowMs - timing.awakeStart) >
      SUSPEND_GAP_THRESHOLD_MS
    ) ||
    !isMcpConnectSuspendRedialEnabled()
  ) {
    return undefined
  }
  return `MCP server "${name}" connection timed out. Your computer went to sleep or its clock changed while connecting.`
}

// Official `Dr()` — module-level reconnect epoch. Bumped where OCC clears
// the memoized server cache out from under a POSSIBLY in-flight suspend-
// redial loop (clearServerCache, client onclose) so those loops abandon
// (`Dr()===s` loop guard): the cache was cleared underneath them, so their
// result is no longer the cache's problem. NOTE: not every
// `connectToServer.cache.delete` pairs with a bump — scheduleHeadlessRemoteRedial's
// failed-redial/catch deletes evict the redial's OWN settled failure with no
// loop still in flight, so they bump nothing (see dialWithSuspendRedial's
// F-10 note for the full eviction-site inventory).
let mcpReconnectEpoch = 0

export function getMcpReconnectEpoch(): number {
  return mcpReconnectEpoch
}

export function bumpMcpReconnectEpoch(): void {
  mcpReconnectEpoch++
}

/** Per-server-key dial generation — the redial loop's currency check `n()`. */
const dialGenerations = new Map<string, number>()

/**
 * Official `X0n` — the suspend-redial loop (@278908920, verbatim:
 * `async function X0n(e,n,r){let s=Dr(),a=await e(),c=0;while(c<z&&a.type===
 * "failed"&&a.errorCode===Hie&&n()&&Dr()===s)...if(c===0)return a;...else if(
 * f("mcp_connect_suspend_redial","slept_again"),c===z&&n())r();return a}`).
 * Runs `dial()` once, then redials while the result is a failed
 * CONNECT_SUSPENDED, under the cap of `MAX_CONNECT_SUSPEND_REDIALS`, the dial
 * is still current, and the reconnect epoch has not changed. At the cap with
 * the dial still current, calls `onFinalSuspendedFailure` — the official
 * `r()` is `$o(n,s,h)`, a plugin-source connection-state notification ONLY
 * (`if((r.type==="stdio"||r.type===void 0)&&r.pluginSource!==void 0)fo(...)`);
 * it does NOT touch the memoize cache, and the official `X0n` tail has NO
 * cache eviction. Counters g/f("mcp_connect_suspend_redial", …) map to
 * logEvent (OCC has no counter infra).
 */
export async function connectWithSuspendRedial<
  T extends { type: string; name?: string; errorCode?: string },
>(
  dial: () => Promise<T>,
  isCurrentDial: () => boolean,
  onFinalSuspendedFailure: () => void,
): Promise<T> {
  // Official `let s=Dr()` — captured synchronously at entry, before the first
  // await, so a bump racing the call is already visible to the loop check.
  const startEpoch = getMcpReconnectEpoch()
  let result = await dial()
  let redials = 0
  while (
    redials < MAX_CONNECT_SUSPEND_REDIALS &&
    result.type === 'failed' &&
    result.errorCode === CONNECT_SUSPENDED &&
    isCurrentDial() &&
    getMcpReconnectEpoch() === startEpoch
  ) {
    redials++
    logMCPDebug(
      result.name ?? '',
      `Connecting again after a sleep or a clock change (${redials} of at most ${MAX_CONNECT_SUSPEND_REDIALS})`,
    )
    result = await dial()
  }
  if (redials === 0) return result
  if (result.type !== 'failed') {
    // Official g("mcp_connect_suspend_redial") success counter.
    logEvent('mcp_connect_suspend_redial', {})
  } else if (result.errorCode !== CONNECT_SUSPENDED) {
    // Official f("mcp_connect_suspend_redial","failed").
    logEvent('mcp_connect_suspend_redial', {
      reason: 'failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  } else {
    // Official f("mcp_connect_suspend_redial","slept_again"), then
    // `c===z&&n()` → r() (persist the final failure at the cap).
    logEvent('mcp_connect_suspend_redial', {
      reason:
        'slept_again' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (redials === MAX_CONNECT_SUSPEND_REDIALS && isCurrentDial()) {
      onFinalSuspendedFailure()
    }
  }
  return result
}

interface ConnectServerStats {
  totalServers: number
  stdioCount: number
  sseCount: number
  httpCount: number
  sseIdeCount: number
  wsIdeCount: number
}

/**
 * TODO (ollie): The memoization here increases complexity by a lot, and im not sure it really improves performance
 * Attempts to connect to a single MCP server
 * @param name Server name
 * @param serverRef Scoped server configuration
 * @returns A wrapped client (either connected or failed)
 */
async function dialMcpServer(
  name: string,
  serverRef: ScopedMcpServerConfig,
  serverStats?: ConnectServerStats,
): Promise<MCPServerConnection> {
  // 2.1.307 B2: capture wall + monotonic starts (official `P=CIt(...)`) so
  // a connect timeout can distinguish an awake-server stall from a
  // sleep/clock-jump collapse.
  const connectTiming = captureConnectTiming()
  const connectStartTime = connectTiming.wallStart
    let inProcessServer:
      | { connect(t: Transport): Promise<void>; close(): Promise<void> }
      | undefined
    try {
      let transport

      // 2.1.307 B3: per-connection state (official `fe`) — records the
      // transport close reason, the tools/call send tracker (wired at connect
      // success for http/claudeai-proxy), and the in-flight call watchdogs.
      // Read by the tool-call session-expiry classifier to pick the
      // `expiryKind` (and thus whether the call may be retried).
      const connectionState: McpConnectionState = {
        activeCallWatchdogs: new Set<ToolCallWatchdog>(),
      }
      // The official onerror SyntaxError branch reads
      // `K?.authChallengeOpen===!0` off the server's auth provider; OCC
      // creates providers inside the sse/http branches, so hoist a reference.
      let authProviderRef: ClaudeAuthProvider | undefined

      // G12 (2.1.196): a project-scoped (.mcp.json) server that the user has
      // not trust-approved must NOT be spawned — `claude mcp list` / `claude
      // mcp get` health checks and `/mcp` operations surface "pending
      // approval" instead of launching the stdio subprocess. Return a
      // needs-approval connection result before creating any transport.
      if (
        serverRef.scope === 'project' &&
        getProjectMcpServerStatus(name) === 'pending'
      ) {
        return {
          name,
          type: 'needs-approval',
          config: serverRef,
        }
      }

      // CC 2.1.208 #43: a remote (sse/http/ws) server whose URL is empty or
      // whitespace should show as "not configured" in /mcp instead of throwing
      // `new URL("")` and surfacing a generic "failed" status. The binary's
      // `zcs()` classifier returns "unconfigured" when
      // `configErrorReason === "url_empty" || (!configError && "url" in config
      // && url.trim() === "")`. We short-circuit before any transport setup.
      if ('url' in serverRef && typeof serverRef.url === 'string' && serverRef.url.trim() === '') {
        return {
          name,
          type: 'unconfigured',
          config: serverRef,
        }
      }

      // If we have the session ingress JWT, we will connect via the session ingress rather than
      // to remote MCP's directly.
      const sessionIngressToken = getSessionIngressAuthToken()

      if (serverRef.type === 'sse') {
        // Create an auth provider for this server
        const authProvider = new ClaudeAuthProvider(name, serverRef)
        authProviderRef = authProvider

        // Get combined headers (static + dynamic)
        const combinedHeaders = await getMcpServerHeaders(name, serverRef)

        // Use the auth provider with SSEClientTransport
        const transportOptions: SSEClientTransportOptions = {
          authProvider,
          // Use fresh timeout per request to avoid stale AbortSignal bug.
          // Step-up detection wraps innermost so the 403 is seen before the
          // SDK's handler calls auth() → tokens().
          fetch: wrapFetchWithTimeout(
            wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
            getServerRequestTimeoutMs(serverRef),
          ),
          requestInit: {
            headers: {
              'User-Agent': getMCPUserAgent(),
              ...combinedHeaders,
            },
          },
        }

        // IMPORTANT: Always set eventSourceInit with a fetch that does NOT use the
        // timeout wrapper. The EventSource connection is long-lived (stays open indefinitely
        // to receive server-sent events), so applying a 60-second timeout would kill it.
        // The timeout is only meant for individual API requests (POST, auth refresh), not
        // the persistent SSE stream.
        transportOptions.eventSourceInit = {
          fetch: async (url: string | URL, init?: RequestInit) => {
            // Get auth headers from the auth provider
            const authHeaders: Record<string, string> = {}
            const tokens = await authProvider.tokens()
            if (tokens) {
              authHeaders.Authorization = `Bearer ${tokens.access_token}`
            }

            // CC 2.1.292 (occ149 P6): pass the target URL so a NO_PROXY match
            // bypasses the proxy (official Xi url-check).
            const proxyOptions = getProxyFetchOptions({ url: String(url) })
            // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
            return fetch(url, {
              ...init,
              ...proxyOptions,
              headers: {
                'User-Agent': getMCPUserAgent(),
                ...authHeaders,
                ...init?.headers,
                ...combinedHeaders,
                Accept: 'text/event-stream',
              },
            })
          },
        }

        transport = new SSEClientTransport(
          new URL(serverRef.url),
          transportOptions,
        )
        logMCPDebug(name, `SSE transport initialized, awaiting connection`)
      } else if (serverRef.type === 'sse-ide') {
        logMCPDebug(name, `Setting up SSE-IDE transport to ${serverRef.url}`)
        // IDE servers don't need authentication
        // TODO: Use the auth token provided in the lockfile
        // CC 2.1.292 (occ149 P6): transport target — NO_PROXY-aware.
        const proxyOptions = getProxyFetchOptions({ url: serverRef.url })
        const transportOptions: SSEClientTransportOptions =
          proxyOptions.dispatcher
            ? {
                eventSourceInit: {
                  fetch: async (url: string | URL, init?: RequestInit) => {
                    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
                    return fetch(url, {
                      ...init,
                      ...proxyOptions,
                      headers: {
                        'User-Agent': getMCPUserAgent(),
                        ...init?.headers,
                      },
                    })
                  },
                },
              }
            : {}

        transport = new SSEClientTransport(
          new URL(serverRef.url),
          Object.keys(transportOptions).length > 0
            ? transportOptions
            : undefined,
        )
      } else if (serverRef.type === 'ws-ide') {
        const tlsOptions = getWebSocketTLSOptions()
        const wsHeaders = {
          'User-Agent': getMCPUserAgent(),
          ...(serverRef.authToken && {
            'X-Claude-Code-Ide-Authorization': serverRef.authToken,
          }),
        }

        let wsClient: WsClientLike
        if (typeof Bun !== 'undefined') {
          // Bun's WebSocket supports headers/proxy/tls options but the DOM typings don't
          // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
          wsClient = new globalThis.WebSocket(serverRef.url, {
            protocols: ['mcp'],
            headers: wsHeaders,
            proxy: getWebSocketProxyUrl(serverRef.url),
            tls: tlsOptions || undefined,
          } as unknown as string[])
        } else {
          wsClient = await createNodeWsClient(serverRef.url, {
            headers: wsHeaders,
            agent: getWebSocketProxyAgent(serverRef.url),
            ...(tlsOptions || {}),
          })
        }
        transport = new WebSocketTransport(wsClient)
      } else if (serverRef.type === 'ws') {
        logMCPDebug(
          name,
          `Initializing WebSocket transport to ${serverRef.url}`,
        )

        const combinedHeaders = await getMcpServerHeaders(name, serverRef)

        const tlsOptions = getWebSocketTLSOptions()
        const wsHeaders = {
          'User-Agent': getMCPUserAgent(),
          ...(sessionIngressToken && {
            Authorization: `Bearer ${sessionIngressToken}`,
          }),
          ...combinedHeaders,
        }

        // Redact sensitive headers before logging
        const wsHeadersForLogging = mapValues(wsHeaders, (value, key) =>
          key.toLowerCase() === 'authorization' ? '[REDACTED]' : value,
        )

        logMCPDebug(
          name,
          `WebSocket transport options: ${jsonStringify({
            url: serverRef.url,
            headers: wsHeadersForLogging,
            hasSessionAuth: !!sessionIngressToken,
          })}`,
        )

        let wsClient: WsClientLike
        if (typeof Bun !== 'undefined') {
          // Bun's WebSocket supports headers/proxy/tls options but the DOM typings don't
          // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
          wsClient = new globalThis.WebSocket(serverRef.url, {
            protocols: ['mcp'],
            headers: wsHeaders,
            proxy: getWebSocketProxyUrl(serverRef.url),
            tls: tlsOptions || undefined,
          } as unknown as string[])
        } else {
          wsClient = await createNodeWsClient(serverRef.url, {
            headers: wsHeaders,
            agent: getWebSocketProxyAgent(serverRef.url),
            ...(tlsOptions || {}),
          })
        }
        transport = new WebSocketTransport(wsClient)
      } else if (serverRef.type === 'http') {
        logMCPDebug(name, `Initializing HTTP transport to ${serverRef.url}`)
        logMCPDebug(
          name,
          `Node version: ${process.version}, Platform: ${process.platform}`,
        )
        logMCPDebug(
          name,
          `Environment: ${jsonStringify({
            NODE_OPTIONS: process.env.NODE_OPTIONS || 'not set',
            UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || 'default',
            HTTP_PROXY: process.env.HTTP_PROXY || 'not set',
            HTTPS_PROXY: process.env.HTTPS_PROXY || 'not set',
            NO_PROXY: process.env.NO_PROXY || 'not set',
          })}`,
        )

        // Create an auth provider for this server
        const authProvider = new ClaudeAuthProvider(name, serverRef)
        authProviderRef = authProvider

        // Get combined headers (static + dynamic)
        const combinedHeaders = await getMcpServerHeaders(name, serverRef)

        // Check if this server has stored OAuth tokens. If so, the SDK's
        // authProvider will set Authorization — don't override with the
        // session ingress token (SDK merges requestInit AFTER authProvider).
        // CCR proxy URLs (ccr_shttp_mcp) have no stored OAuth, so they still
        // get the ingress token. See PR #24454 discussion.
        const hasOAuthTokens = !!(await authProvider.tokens())

        // Use the auth provider with StreamableHTTPClientTransport
        // CC 2.1.292 (occ149 P6): transport target — NO_PROXY-aware.
        const proxyOptions = getProxyFetchOptions({ url: serverRef.url })
        logMCPDebug(
          name,
          `Proxy options: ${proxyOptions.dispatcher ? 'custom dispatcher' : 'default'}`,
        )

        const transportOptions: StreamableHTTPClientTransportOptions = {
          authProvider,
          // Use fresh timeout per request to avoid stale AbortSignal bug.
          // Step-up detection wraps innermost so the 403 is seen before the
          // SDK's handler calls auth() → tokens().
          fetch: wrapFetchWithTimeout(
            wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
            getServerRequestTimeoutMs(serverRef),
          ),
          requestInit: {
            ...proxyOptions,
            headers: {
              'User-Agent': getMCPUserAgent(),
              ...(sessionIngressToken &&
                !hasOAuthTokens && {
                  Authorization: `Bearer ${sessionIngressToken}`,
                }),
              ...combinedHeaders,
            },
          },
        }

        // Redact sensitive headers before logging
        const headersForLogging = transportOptions.requestInit?.headers
          ? mapValues(
              transportOptions.requestInit.headers as Record<string, string>,
              (value, key) =>
                key.toLowerCase() === 'authorization' ? '[REDACTED]' : value,
            )
          : undefined

        logMCPDebug(
          name,
          `HTTP transport options: ${jsonStringify({
            url: serverRef.url,
            headers: headersForLogging,
            hasAuthProvider: !!authProvider,
            timeoutMs:
              getServerRequestTimeoutMs(serverRef) ?? MCP_REQUEST_TIMEOUT_MS,
          })}`,
        )

        transport = new StreamableHTTPClientTransport(
          new URL(serverRef.url),
          transportOptions,
        )
        logMCPDebug(name, `HTTP transport created successfully`)
      } else if (serverRef.type === 'sdk') {
        throw new Error('SDK servers should be handled in print.ts')
      } else if (serverRef.type === 'claudeai-proxy') {
        logMCPDebug(
          name,
          `Initializing claude.ai proxy transport for server ${serverRef.id}`,
        )

        const tokens = getClaudeAIOAuthTokens()
        if (!tokens) {
          throw new Error('No claude.ai OAuth token found')
        }

        const oauthConfig = getOauthConfig()
        const proxyUrl = `${oauthConfig.MCP_PROXY_URL}${oauthConfig.MCP_PROXY_PATH.replace('{server_id}', serverRef.id)}`

        logMCPDebug(name, `Using claude.ai proxy at ${proxyUrl}`)

        // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        const fetchWithAuth = createClaudeAiProxyFetch(globalThis.fetch)

        // CC 2.1.292 (occ149 P6): transport target — NO_PROXY-aware.
        const proxyOptions = getProxyFetchOptions({ url: proxyUrl })
        const transportOptions: StreamableHTTPClientTransportOptions = {
          // Wrap fetchWithAuth with fresh timeout per request
          fetch: wrapFetchWithTimeout(fetchWithAuth),
          requestInit: {
            ...proxyOptions,
            // CC 2.1.299 #152 (SECURITY): never follow HTTP redirects for the
            // claude.ai connector proxy / Anthropic-hosted MCP. Official
            // changelog: "Changed requests to claude.ai's connector proxy and
            // to Anthropic-hosted MCP servers to no longer follow HTTP
            // redirects; redirects by a connector's own server are unaffected."
            // Binary forensics (v299, new chunk exports {fle,qbn,Ybn} — v296
            // has none): the official wraps the proxy fetch in a cross-origin
            // redirect refuser (`Ybn(e)=(r)=>{if(!Uie(k1e(r),e))throw
            // Error("Refused a redirect to another origin")}` — that string
            // has 2 hits in v299, 0 in v296; also used as the axios
            // `beforeRedirect` hook in OAuth token revocation) and applies
            // header-carrying `fle` (forces `redirect:"manual"` + manual
            // ≤5-hop follow) to the user-server fetches.
            // OCC uses the SDK-honored requestInit path
            // instead: StreamableHTTPClientTransport spreads `requestInit`
            // into every fetch (streamableHttp.js:300/438), so redirect:
            // 'manual' achieves the same no-follow guarantee for the trusted
            // Anthropic endpoint. Plain user http/sse servers above are
            // deliberately UNCHANGED — a connector's own server keeps
            // following redirects (official parity).
            redirect: 'manual',
            headers: {
              'User-Agent': getMCPUserAgent(),
              'X-Mcp-Client-Session-Id': getSessionId(),
            },
          },
        }

        transport = new StreamableHTTPClientTransport(
          new URL(proxyUrl),
          transportOptions,
        )
        logMCPDebug(name, `claude.ai proxy transport created successfully`)
      } else if (
        ((serverRef as ScopedMcpServerConfig).type === 'stdio' || !(serverRef as ScopedMcpServerConfig).type) &&
        isClaudeInChromeMCPServer(name)
      ) {
        // Run the Chrome MCP server in-process to avoid spawning a ~325 MB subprocess
        const { createChromeContext } = await import(
          '../../utils/claudeInChrome/mcpServer.js'
        )
        const { createClaudeForChromeMcpServer } = await import(
          '@ant/claude-for-chrome-mcp'
        )
        const { createLinkedTransportPair } = await import(
          './InProcessTransport.js'
        )
        const context = createChromeContext((serverRef as McpStdioServerConfig).env)
        inProcessServer = createClaudeForChromeMcpServer(context)
        const [clientTransport, serverTransport] = createLinkedTransportPair()
        await inProcessServer.connect(serverTransport)
        transport = clientTransport
        logMCPDebug(name, `In-process Chrome MCP server started`)
      } else if (
        feature('CHICAGO_MCP') &&
        ((serverRef as ScopedMcpServerConfig).type === 'stdio' || !(serverRef as ScopedMcpServerConfig).type) &&
        isComputerUseMCPServer!(name)
      ) {
        // Run the Computer Use MCP server in-process — same rationale as
        // Chrome above. The package's CallTool handler is a stub; real
        // dispatch goes through wrapper.tsx's .call() override.
        const { createComputerUseMcpServerForCli } = await import(
          '../../utils/computerUse/mcpServer.js'
        )
        const { createLinkedTransportPair } = await import(
          './InProcessTransport.js'
        )
        inProcessServer = await createComputerUseMcpServerForCli()
        const [clientTransport, serverTransport] = createLinkedTransportPair()
        await inProcessServer.connect(serverTransport)
        transport = clientTransport
        logMCPDebug(name, `In-process Computer Use MCP server started`)
      } else if ((serverRef as ScopedMcpServerConfig).type === 'stdio' || !(serverRef as ScopedMcpServerConfig).type) {
        const stdioRef = serverRef as McpStdioServerConfig
        const finalCommand =
          process.env.CLAUDE_CODE_SHELL_PREFIX || stdioRef.command
        const finalArgs = process.env.CLAUDE_CODE_SHELL_PREFIX
          ? [[stdioRef.command, ...stdioRef.args].join(' ')]
          : stdioRef.args
        transport = new StdioClientTransport({
          command: finalCommand,
          args: finalArgs,
          env: {
            ...subprocessEnv(),
            // 2.1.139: MCP stdio servers receive CLAUDE_PROJECT_DIR, matching hooks.
            CLAUDE_PROJECT_DIR: getProjectRoot(),
            // 2.1.147: stdio MCP servers receive CLAUDECODE=1 (alongside the
            // CLAUDE_CODE_SESSION_ID already injected by subprocessEnv) so server
            // processes can detect they're running under Claude Code.
            CLAUDECODE: '1',
            ...stdioRef.env,
          } as Record<string, string>,
          stderr: 'pipe', // prevents error output from the MCP server from printing to the UI
        })
      } else {
        throw new Error(`Unsupported server type: ${(serverRef as ScopedMcpServerConfig).type}`)
      }

      // Set up stderr logging for stdio transport before connecting in case there are any stderr
      // outputs emitted during the connection start (this can be useful for debugging failed connections).
      // Store handler + stream references for cleanup to prevent memory leaks.
      const stderrAcc = createCappedStderrAccumulator()
      let stderrHandler: ((data: Buffer) => void) | undefined
      let stderrStream: Readable | undefined
      if (serverRef.type === 'stdio' || !serverRef.type) {
        const stdioTransport = transport as StdioClientTransport
        if (stdioTransport.stderr instanceof Readable) {
          stderrStream = stdioTransport.stderr
          stderrHandler = stderrAcc.handler
          // Cap stderr accumulation (head-retention, 64MB) to prevent unbounded
          // memory growth from a chatty/faulty stdio server (CC 2.1.208 #29).
          stderrStream.on('data', stderrHandler)
        }
      }

      const client = new Client(
        {
          name: 'claude-code',
          title: 'Claude Code',
          version: MACRO.VERSION ?? 'unknown',
          description: "Anthropic's agentic coding tool",
          websiteUrl: PRODUCT_URL,
        },
        {
          capabilities: {
            roots: {
              // Declare that the client will send notifications/roots/list_changed
              // when the set of roots changes (e.g. /add-dir). (2.1.203)
              listChanged: true,
            },
            // Empty object declares the capability. Sending {form:{},url:{}}
            // breaks Java MCP SDK servers (Spring AI) whose Elicitation class
            // has zero fields and fails on unknown properties.
            elicitation: {},
          },
        },
      )

      // Add debug logging for client events if available
      if (serverRef.type === 'http') {
        logMCPDebug(name, `Client created, setting up request handler`)
      }

      client.setRequestHandler(ListRootsRequestSchema, async () => {
        logMCPDebug(name, `Received ListRoots request from server`)
        return {
          roots: getMcpRoots(),
        }
      })

      // Add a timeout to connection attempts to prevent tests from hanging indefinitely
      logMCPDebug(
        name,
        `Starting connection with timeout of ${getConnectionTimeoutMs()}ms`,
      )

      // For HTTP transport, try a basic connectivity test first
      if (serverRef.type === 'http') {
        logMCPDebug(name, `Testing basic HTTP connectivity to ${serverRef.url}`)
        try {
          const testUrl = new URL(serverRef.url)
          logMCPDebug(
            name,
            `Parsed URL: host=${testUrl.hostname}, port=${testUrl.port || 'default'}, protocol=${testUrl.protocol}`,
          )

          // Log DNS resolution attempt
          if (
            testUrl.hostname === '127.0.0.1' ||
            testUrl.hostname === 'localhost'
          ) {
            logMCPDebug(name, `Using loopback address: ${testUrl.hostname}`)
          }
        } catch (urlError) {
          logMCPDebug(name, `Failed to parse URL: ${urlError}`)
        }
      }

      const connectPromise = client.connect(transport)
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timeoutId = setTimeout(() => {
          // 2.1.307 B2: official trigger log uses the awake-ms formatter —
          // `Connection timeout triggered after ${RIt(P)} (limit: ${B}ms)`.
          logMCPDebug(
            name,
            `Connection timeout triggered after ${formatConnectTiming(connectTiming)} (limit: ${getConnectionTimeoutMs()}ms)`,
          )
          if (inProcessServer) {
            inProcessServer.close().catch(() => {})
          }
          transport.close().catch(() => {})
          // 2.1.307 B2: the official rejection carries
          // `Object.assign(err,{code:"CONNECT_TIMEOUT"})` behind gate
          // `tengu_mcp_connect_timeout_retry` (default true — OCC has no gate
          // infra, so the code is always assigned). The outer catch keys the
          // suspended-connect classification off it.
          reject(
            Object.assign(
              new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                `MCP server "${name}" connection timed out after ${getConnectionTimeoutMs()}ms`,
                'MCP connection timeout',
              ),
              { code: CONNECT_TIMEOUT },
            ),
          )
        }, getConnectionTimeoutMs())

        // Clean up timeout if connect resolves or rejects
        connectPromise.then(
          () => {
            clearTimeout(timeoutId)
          },
          _error => {
            clearTimeout(timeoutId)
          },
        )
      })

      try {
        await Promise.race([connectPromise, timeoutPromise])
        const stderrCaptured = stderrAcc.getOutput()
        if (stderrCaptured) {
          logMCPError(name, `Server stderr: ${stderrCaptured}`)
          stderrAcc.reset() // Release accumulated string to prevent memory growth
        }
        // Connection succeeded — stop capturing stderr. Detach the listener and
        // resume the stream so it drains freely for the rest of the connection
        // lifetime instead of accumulating (capped or not) in memory. This is
        // the 2.1.208 fix for the MCP stdio stderr memory leak.
        if (stderrHandler && stderrStream) {
          stderrStream.off('data', stderrHandler)
          stderrStream.resume()
          stderrHandler = undefined
        }
        const elapsed = Date.now() - connectStartTime
        logMCPDebug(
          name,
          `Successfully connected (transport: ${serverRef.type || 'stdio'}) in ${elapsed}ms`,
        )
      } catch (error) {
        const elapsed = Date.now() - connectStartTime
        // 2.1.307 B1: a credential-store-unavailable failure is its own
        // error class (code CREDENTIAL_STORE_UNAVAILABLE) — surface it
        // directly instead of routing through needs-auth handling.
        if (isCredentialStoreUnavailableError(error)) {
          if (inProcessServer) {
            inProcessServer.close().catch(() => {})
          }
          transport.close().catch(() => {})
          throw error
        }
        // SSE-specific error logging
        if (serverRef.type === 'sse' && error instanceof Error) {
          logMCPDebug(
            name,
            `SSE Connection failed after ${elapsed}ms: ${jsonStringify({
              url: serverRef.url,
              error: error.message,
              errorType: error.constructor.name,
              stack: error.stack,
            })}`,
          )
          logMCPError(name, error)

          if (error instanceof UnauthorizedError) {
            return handleRemoteAuthFailure(name, serverRef, 'sse')
          }
        } else if (serverRef.type === 'http' && error instanceof Error) {
          const errorObj = error as Error & {
            cause?: unknown
            code?: string
            errno?: string | number
            syscall?: string
          }
          logMCPDebug(
            name,
            `HTTP Connection failed after ${elapsed}ms: ${error.message} (code: ${errorObj.code || 'none'}, errno: ${errorObj.errno || 'none'})`,
          )
          logMCPError(name, error)

          if (error instanceof UnauthorizedError) {
            return handleRemoteAuthFailure(name, serverRef, 'http')
          }
        } else if (
          serverRef.type === 'claudeai-proxy' &&
          error instanceof Error
        ) {
          logMCPDebug(
            name,
            `claude.ai proxy connection failed after ${elapsed}ms: ${error.message}`,
          )
          logMCPError(name, error)

          // StreamableHTTPError has a `code` property with the HTTP status
          const errorCode = (error as Error & { code?: number }).code
          if (errorCode === 401) {
            return handleRemoteAuthFailure(name, serverRef, 'claudeai-proxy')
          }
        } else if (
          serverRef.type === 'sse-ide' ||
          serverRef.type === 'ws-ide'
        ) {
          logEvent('tengu_mcp_ide_server_connection_failed', {
            connectionDurationMs: elapsed,
          })
        }
        if (inProcessServer) {
          inProcessServer.close().catch(() => {})
        }
        transport.close().catch(() => {})
        const stderrCaptured = stderrAcc.getOutput()
        if (stderrCaptured) {
          logMCPError(name, `Server stderr: ${stderrCaptured}`)
        }
        throw error
      }

      const capabilities = client.getServerCapabilities()
      const serverVersion = client.getServerVersion()
      const rawInstructions = client.getInstructions()
      // claude-code 2.1.280 (#003): the cap is env-configurable, so truncation
      // now runs through the shared `Zo`/`Qo` port instead of an inline slice.
      const instructions = truncateMcpServerInstructions(rawInstructions, name)

      // Log successful connection details
      logMCPDebug(
        name,
        `Connection established with capabilities: ${jsonStringify({
          hasTools: !!capabilities?.tools,
          hasPrompts: !!capabilities?.prompts,
          hasResources: !!capabilities?.resources,
          hasResourceSubscribe: !!capabilities?.resources?.subscribe,
          serverVersion: serverVersion || 'unknown',
        })}`,
      )
      logForDebugging(
        `[MCP] Server "${name}" connected with subscribe=${!!capabilities?.resources?.subscribe}`,
      )

      // Register default elicitation handler that returns cancel during the
      // window before registerElicitationHandler overwrites it in
      // onConnectionAttempt (useManageMCPConnections).
      client.setRequestHandler(ElicitRequestSchema, async request => {
        logMCPDebug(
          name,
          `Elicitation request received during initialization: ${jsonStringify(request)}`,
        )
        return { action: 'cancel' as const }
      })

      if (serverRef.type === 'sse-ide' || serverRef.type === 'ws-ide') {
        const ideConnectionDurationMs = Date.now() - connectStartTime
        logEvent('tengu_mcp_ide_server_connection_succeeded', {
          connectionDurationMs: ideConnectionDurationMs,
          serverVersion:
            serverVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        try {
          void maybeNotifyIDEConnected(client)
        } catch (error) {
          logMCPError(
            name,
            `Failed to send ide_connected notification: ${error}`,
          )
        }
      }

      // Enhanced connection drop detection and logging for all transport types
      const connectionStartTime = Date.now()
      let hasErrorOccurred = false
      // Set when cleanup() closes the client deliberately (server removal /
      // disable / shutdown) so the shared onclose doesn't schedule a redial.
      let intentionalClose = false

      // Store original handlers
      const originalOnerror = client.onerror
      const originalOnclose = client.onclose

      // The SDK's transport calls onerror on connection failures but doesn't call onclose,
      // which CC uses to trigger reconnection. We bridge this gap by tracking consecutive
      // terminal errors and manually closing after MAX_ERRORS_BEFORE_RECONNECT failures.
      let consecutiveConnectionErrors = 0
      const MAX_ERRORS_BEFORE_RECONNECT = 3

      // Guard against re-entry: close() aborts in-flight streams which may fire
      // onerror again before the close chain completes.
      let hasTriggeredClose = false

      // client.close() → transport.close() → transport.onclose → SDK's _onclose():
      // rejects all pending request handlers (so hung callTool() promises fail with
      // McpError -32000 "Connection closed") and then invokes our client.onclose
      // handler below (which clears the memo cache so the next call reconnects).
      // Calling client.onclose?.() directly would only clear the cache — pending
      // tool calls would stay hung.
      const closeTransportAndRejectPending = (reason: string) => {
        if (hasTriggeredClose) return
        hasTriggeredClose = true
        // 2.1.307 B3: official close fn records `closeReason=E` before the
        // verbatim `Closing transport (${E})` log — the session-expiry
        // classifier reads it back off the connection state.
        connectionState.closeReason = reason
        logMCPDebug(name, `Closing transport (${reason})`)
        void client.close().catch(e => {
          logMCPDebug(name, `Error during close: ${errorMessage(e)}`)
        })
      }

      // CC 2.1.295 (item 1): the terminal-connection-error classification now
      // uses the official `ua` network-error classifier (see listPagination.ts)
      // instead of substring matching on the message alone. Numeric error
      // codes/statuses (HTTP statuses, JSON-RPC codes — including negative
      // codes like ListPaginationExceeded) are never network errors, so a
      // SERVER error reply that merely mentions "ECONNRESET" no longer counts
      // toward dropping the connection.

      // Enhanced error handler with detailed logging
      client.onerror = (error: Error) => {
        const uptime = Date.now() - connectionStartTime
        hasErrorOccurred = true
        const transportType = serverRef.type || 'stdio'

        // Log the connection drop with context
        logMCPDebug(
          name,
          `${transportType.toUpperCase()} connection dropped after ${Math.floor(uptime / 1000)}s uptime`,
        )

        // Log specific error details for debugging
        if (error.message) {
          if (error.message.includes('ECONNRESET')) {
            logMCPDebug(
              name,
              `Connection reset - server may have crashed or restarted`,
            )
          } else if (error.message.includes('ETIMEDOUT')) {
            logMCPDebug(
              name,
              `Connection timeout - network issue or server unresponsive`,
            )
          } else if (error.message.includes('ECONNREFUSED')) {
            logMCPDebug(name, `Connection refused - server may be down`)
          } else if (error.message.includes('EPIPE')) {
            logMCPDebug(
              name,
              `Broken pipe - server closed connection unexpectedly`,
            )
          } else if (error.message.includes('EHOSTUNREACH')) {
            logMCPDebug(name, `Host unreachable - network connectivity issue`)
          } else if (error.message.includes('ESRCH')) {
            logMCPDebug(
              name,
              `Process not found - stdio server process terminated`,
            )
          } else if (error.message.includes('spawn')) {
            logMCPDebug(
              name,
              `Failed to spawn process - check command and permissions`,
            )
          } else {
            logMCPDebug(name, `Connection error: ${error.message}`)
          }
        }

        // For HTTP transports, detect session expiry (404 + JSON-RPC -32001)
        // and close the transport so pending tool calls reject and the next
        // call reconnects with a fresh session ID.
        // 2.1.307 B3: official branch additionally guards on
        // `Z.transport?.sessionId!==void 0` (a 404 on a connection that never
        // established a session is not a session expiry) and logs the verbatim
        // "server no longer recognizes session ID" text.
        if (
          (transportType === 'http' || transportType === 'claudeai-proxy') &&
          (transport as { sessionId?: unknown } | undefined)?.sessionId !==
            undefined &&
          isMcpSessionExpiredError(error)
        ) {
          logMCPDebug(
            name,
            `MCP session expired (server no longer recognizes session ID), triggering reconnection`,
          )
          closeTransportAndRejectPending('session expired')
          if (originalOnerror) {
            originalOnerror(error)
          }
          return
        }

        // 2.1.307 B3: official onerror branch (byte-verified, new307.txt):
        // `(U==="sse"||U==="http"||U==="claudeai-proxy")&&E instanceof SyntaxError`
        // → close with a reason the session-expiry classifier reads back:
        // `K?.authChallengeOpen===!0 && fe.activeCallWatchdogs.size<=1` →
        // "malformed message after an auth challenge" (the server sent an
        // HTML/non-JSON body right after a 401 challenge — the pending call
        // was refused), else "malformed JSON-RPC message (response
        // truncated)". The official also runs `je=!0` (OCC sets
        // hasErrorOccurred at the top of this handler) and `Ae()` (an
        // internal pending-request reset with no OCC counterpart — the
        // client.close() inside closeTransportAndRejectPending rejects all
        // pending SDK requests).
        if (
          (transportType === 'sse' ||
            transportType === 'http' ||
            transportType === 'claudeai-proxy') &&
          error instanceof SyntaxError
        ) {
          closeTransportAndRejectPending(
            authProviderRef?.authChallengeOpen === true &&
              connectionState.activeCallWatchdogs.size <= 1
              ? 'malformed message after an auth challenge'
              : 'malformed JSON-RPC message (response truncated)',
          )
          if (originalOnerror) {
            originalOnerror(error)
          }
          return
        }

        // For remote transports (SSE/HTTP), track terminal connection errors
        // and trigger reconnection via close if we see repeated failures.
        if (
          transportType === 'sse' ||
          transportType === 'http' ||
          transportType === 'claudeai-proxy'
        ) {
          // The SDK's StreamableHTTP transport fires this after exhausting its
          // own SSE reconnect attempts (default maxRetries: 2) — but it never
          // calls onclose, so pending callTool() promises hang indefinitely.
          // This is the definitive "transport gave up" signal.
          if (error.message.includes('Maximum reconnection attempts')) {
            closeTransportAndRejectPending('SSE reconnection exhausted')
            if (originalOnerror) {
              originalOnerror(error)
            }
            return
          }

          if (isNetworkError(error)) {
            consecutiveConnectionErrors++
            logMCPDebug(
              name,
              `Terminal connection error ${consecutiveConnectionErrors}/${MAX_ERRORS_BEFORE_RECONNECT}`,
            )

            if (consecutiveConnectionErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
              consecutiveConnectionErrors = 0
              closeTransportAndRejectPending('max consecutive terminal errors')
            }
          } else {
            // Non-terminal error (e.g., transient issue), reset counter
            consecutiveConnectionErrors = 0
          }
        }

        // Call original handler
        if (originalOnerror) {
          originalOnerror(error)
        }
      }

      // Enhanced close handler with connection drop context
      client.onclose = () => {
        const uptime = Date.now() - connectionStartTime
        const transportType = serverRef.type ?? 'unknown'

        logMCPDebug(
          name,
          `${transportType.toUpperCase()} connection closed after ${Math.floor(uptime / 1000)}s (${hasErrorOccurred ? 'with errors' : 'cleanly'})`,
        )

        // Clear the memoization cache so next operation reconnects
        const key = getServerCacheKey(name, serverRef)

        // Also clear fetch caches (keyed by server name). Reconnection
        // creates a new connection object; without clearing, the next
        // fetch would return stale tools/resources from the old connection.
        fetchToolsForClient.cache.delete(name)
        fetchResourcesForClient.cache.delete(name)
        fetchCommandsForClient.cache.delete(name)
        if (feature('MCP_SKILLS')) {
          fetchMcpSkillsForClient!.cache.delete(name)
        }

        connectToServer.cache.delete(key)
        // 2.1.307 B2: bump the reconnect epoch (official `Dr()`) — the cache
        // was just cleared under any in-flight suspend-redial loop, so its
        // result must no longer be re-persisted; the loop abandons.
        bumpMcpReconnectEpoch()
        logMCPDebug(name, `Cleared connection cache for reconnection`)

        // CC 2.1.295 (item 3): redial remote transports with rapid-drop
        // backoff so a flapping server can't trigger an uncapped reconnect
        // storm. Local (stdio/sdk) servers keep lazy-redial-on-next-use only.
        // Deliberate closes (cleanup: server removal/disable, shutdown) skip
        // the redial entirely.
        if (!intentionalClose && !isLocalMcpServer(serverRef)) {
          scheduleHeadlessRemoteRedial(name, serverRef, uptime)
        }

        if (originalOnclose) {
          originalOnclose()
        }
      }

      const cleanup = async () => {
        // Mark deliberate teardown so the shared onclose skips the 2.1.295
        // headless redial (item 3) for this client.
        intentionalClose = true
        // In-process servers (e.g. Chrome MCP) don't have child processes or stderr
        if (inProcessServer) {
          try {
            await inProcessServer.close()
          } catch (error) {
            logMCPDebug(name, `Error closing in-process server: ${error}`)
          }
          try {
            await client.close()
          } catch (error) {
            logMCPDebug(name, `Error closing client: ${error}`)
          }
          return
        }

        // Remove stderr event listener to prevent memory leaks. On a successful
        // connection the listener is already detached above, so this only runs
        // when the connection failed or is being torn down.
        if (stderrHandler && stderrStream) {
          stderrStream.off('data', stderrHandler)
        }

        // For stdio transports, explicitly terminate the child process with proper signals
        // NOTE: StdioClientTransport.close() only sends an abort signal, but many MCP servers
        // (especially Docker containers) need explicit SIGINT/SIGTERM signals to trigger graceful shutdown
        if (serverRef.type === 'stdio') {
          try {
            const stdioTransport = transport as StdioClientTransport
            const childPid = stdioTransport.pid

            if (childPid) {
              logMCPDebug(name, 'Sending SIGINT to MCP server process')

              // First try SIGINT (like Ctrl+C)
              try {
                process.kill(childPid, 'SIGINT')
              } catch (error) {
                logMCPDebug(name, `Error sending SIGINT: ${error}`)
                return
              }

              // Wait for graceful shutdown with rapid escalation (total 500ms to keep CLI responsive)
              await new Promise<void>((resolve, reject) => {
                (async () => {
                let resolved = false

                // Set up a timer to check if process still exists
                const checkInterval = setInterval(() => {
                  try {
                    // process.kill(pid, 0) checks if process exists without killing it
                    process.kill(childPid, 0)
                  } catch {
                    // Process no longer exists
                    if (!resolved) {
                      resolved = true
                      clearInterval(checkInterval)
                      clearTimeout(failsafeTimeout)
                      logMCPDebug(name, 'MCP server process exited cleanly')
                      resolve()
                    }
                  }
                }, 50)

                // Absolute failsafe: clear interval after 600ms no matter what
                const failsafeTimeout = setTimeout(() => {
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    logMCPDebug(
                      name,
                      'Cleanup timeout reached, stopping process monitoring',
                    )
                    resolve()
                  }
                }, 600)

                try {
                  // Wait 100ms for SIGINT to work (usually much faster)
                  await sleep(100)

                  if (!resolved) {
                    // Check if process still exists
                    try {
                      process.kill(childPid, 0)
                      // Process still exists, SIGINT failed, try SIGTERM
                      logMCPDebug(
                        name,
                        'SIGINT failed, sending SIGTERM to MCP server process',
                      )
                      try {
                        process.kill(childPid, 'SIGTERM')
                      } catch (termError) {
                        logMCPDebug(name, `Error sending SIGTERM: ${termError}`)
                        resolved = true
                        clearInterval(checkInterval)
                        clearTimeout(failsafeTimeout)
                        resolve()
                        return
                      }
                    } catch {
                      // Process already exited
                      resolved = true
                      clearInterval(checkInterval)
                      clearTimeout(failsafeTimeout)
                      resolve()
                      return
                    }

                    // Wait 400ms for SIGTERM to work (slower than SIGINT, often used for cleanup)
                    await sleep(400)

                    if (!resolved) {
                      // Check if process still exists
                      try {
                        process.kill(childPid, 0)
                        // Process still exists, SIGTERM failed, force kill with SIGKILL
                        logMCPDebug(
                          name,
                          'SIGTERM failed, sending SIGKILL to MCP server process',
                        )
                        try {
                          process.kill(childPid, 'SIGKILL')
                        } catch (killError) {
                          logMCPDebug(
                            name,
                            `Error sending SIGKILL: ${killError}`,
                          )
                        }
                      } catch {
                        // Process already exited
                        resolved = true
                        clearInterval(checkInterval)
                        clearTimeout(failsafeTimeout)
                        resolve()
                      }
                    }
                  }

                  // Final timeout - always resolve after 500ms max (total cleanup time)
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    clearTimeout(failsafeTimeout)
                    resolve()
                  }
                } catch {
                  // Handle any errors in the escalation sequence
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    clearTimeout(failsafeTimeout)
                    resolve()
                  }
                }
              })().then(resolve, reject)
              })
            }
          } catch (processError) {
            logMCPDebug(name, `Error terminating process: ${processError}`)
          }
        }

        // Close the client connection (which also closes the transport)
        try {
          await client.close()
        } catch (error) {
          logMCPDebug(name, `Error closing client: ${error}`)
        }
      }

      // Register cleanup for all transport types - even network transports might need cleanup
      // This ensures all MCP servers get properly terminated, not just stdio ones
      const cleanupUnregister = registerCleanup(cleanup)

      // Create the wrapped cleanup that includes unregistering
      const wrappedCleanup = async () => {
        cleanupUnregister?.()
        await cleanup()
      }

      const connectionDurationMs = Date.now() - connectStartTime
      logEvent('tengu_mcp_server_connection_succeeded', {
        connectionDurationMs,
        transportType: (serverRef.type ??
          'stdio') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        totalServers: serverStats?.totalServers,
        stdioCount: serverStats?.stdioCount,
        sseCount: serverStats?.sseCount,
        httpCount: serverStats?.httpCount,
        sseIdeCount: serverStats?.sseIdeCount,
        wsIdeCount: serverStats?.wsIdeCount,
        ...mcpBaseUrlAnalytics(serverRef),
      })
      // 2.1.307 B3: official connect-success wiring (byte-verified):
      // `if((r.type==="http"||r.type==="claudeai-proxy")&&Z.transport)
      //   fe.toolCallSends=rNn(Z.transport,so,fe.activeCallWatchdogs)`
      if (
        (serverRef.type === 'http' || serverRef.type === 'claudeai-proxy') &&
        transport
      ) {
        connectionState.toolCallSends = trackToolCallSends(
          transport,
          isMcpSessionExpiredError,
          connectionState.activeCallWatchdogs,
        )
      }
      return {
        name,
        client,
        type: 'connected' as const,
        capabilities: capabilities ?? {},
        serverInfo: serverVersion,
        instructions,
        config: serverRef,
        cleanup: wrappedCleanup,
        transport: transport as (Transport & { sessionId?: string }) | undefined,
        connectionState,
      }
    } catch (error) {
      // 2.1.307 B2: classify the failure code. The official timeout rejection
      // carries `code:"CONNECT_TIMEOUT"`; when the wall-vs-awake gap shows the
      // machine slept mid-connect, the official reclassifies
      // (`let M=le==="CONNECT_TIMEOUT"&&w!==void 0?Y0n(e,w):void 0;
      //   if(M!==void 0)le=Hie,ae=M`).
      let failureErrorCode: string | undefined =
        (error as { code?: unknown } | undefined)?.code === CONNECT_TIMEOUT
          ? CONNECT_TIMEOUT
          : extractMcpFailureErrorCode(error)
      let failureMessage = errorMessage(error)
      if (failureErrorCode === CONNECT_TIMEOUT) {
        const suspendedMessage = detectSuspendedConnect(name, connectTiming)
        if (suspendedMessage !== undefined) {
          failureErrorCode = CONNECT_SUSPENDED
          failureMessage = suspendedMessage
        }
      }
      const connectionDurationMs = Date.now() - connectStartTime
      logEvent('tengu_mcp_server_connection_failed', {
        connectionDurationMs,
        totalServers: serverStats?.totalServers || 1,
        stdioCount:
          serverStats?.stdioCount || (serverRef.type === 'stdio' ? 1 : 0),
        sseCount: serverStats?.sseCount || (serverRef.type === 'sse' ? 1 : 0),
        httpCount:
          serverStats?.httpCount || (serverRef.type === 'http' ? 1 : 0),
        sseIdeCount:
          serverStats?.sseIdeCount || (serverRef.type === 'sse-ide' ? 1 : 0),
        wsIdeCount:
          serverStats?.wsIdeCount || (serverRef.type === 'ws-ide' ? 1 : 0),
        transportType: (serverRef.type ??
          'stdio') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...mcpBaseUrlAnalytics(serverRef),
        // Official: `...le==="CONNECT_TIMEOUT"&&{reason:"timeout"},
        //            ...le===Hie&&{reason:"suspended"}`
        ...(failureErrorCode === CONNECT_TIMEOUT && { reason: 'timeout' }),
        ...(failureErrorCode === CONNECT_SUSPENDED && { reason: 'suspended' }),
      })
      // Official failure counter:
      // `f("mcp_connect",`${pe}_${r.type??"stdio"}`)` with pe =
      // ECONNREFUSED→mcp_connect_refused / CONNECT_SUSPENDED→
      // mcp_connect_suspended / message includes "timed out"→
      // mcp_connect_timeout / else mcp_connect_failed. OCC has no counter
      // infra — recorded via logEvent. (The ECONNREFUSED branch is kept for
      // fidelity even though OCC's extractor never emits it.)
      const connectFailureCounter =
        failureErrorCode === 'ECONNREFUSED'
          ? 'mcp_connect_refused'
          : failureErrorCode === CONNECT_SUSPENDED
            ? 'mcp_connect_suspended'
            : failureMessage.includes('timed out')
              ? 'mcp_connect_timeout'
              : 'mcp_connect_failed'
      logEvent('mcp_connect', {
        reason:
          `${connectFailureCounter}_${serverRef.type ?? 'stdio'}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      // Official awake-ms failure logs:
      // `Connection failed after ${RIt(P)}${le!==void 0?` (${le})`:""}: ${ae}`
      logMCPDebug(
        name,
        `Connection failed after ${formatConnectTiming(connectTiming)}${
          failureErrorCode !== undefined ? ` (${failureErrorCode})` : ''
        }: ${failureMessage}`,
      )
      logMCPError(
        name,
        `Connection failed${
          failureErrorCode !== undefined ? ` (${failureErrorCode})` : ''
        }: ${failureMessage}`,
      )

      if (inProcessServer) {
        inProcessServer.close().catch(() => {})
      }
      return {
        name,
        type: 'failed' as const,
        config: serverRef,
        error: failureMessage,
        // CC 2.1.218 #5: surface HTTP status / named failure code so
        // `mcp list`, `/mcp`, and the "configured MCP servers failed to
        // connect" warning can show HTTP status + error text. Mirrors the
        // binary's failed-client `errorCode` field consumed by `TQo`/`kbo`.
        // 2.1.307 B2 adds CONNECT_TIMEOUT / CONNECT_SUSPENDED to the surface.
        errorCode: failureErrorCode,
      }
    }
}

/**
 * 2.1.307 B2/F-10 — dial with the official suspend-redial wrapper (`X0n` via
 * the official memoize wrap `(e,r,[n,s,,h])=>X0n(e,r,()=>$o(n,s,h))`
 * @279092166/@279462930). The official cap-reached callback `$o` is a
 * plugin-source connection-state notification only — unported (OCC has no
 * plugin connection-state subscriber), so the third argument is a no-op.
 *
 * F-10: the official `X0n` tail performs NO memoize-cache eviction, and
 * neither does this wrapper. An earlier OCC-only tail delete fired exactly
 * when the dial was ABANDONED (generation superseded or epoch bumped mid-
 * loop) — i.e. precisely when a NEWER dial may already be memoized under the
 * same key, which the delete would wrongly evict. Abandoned suspended
 * failures now resolve only inside their orphaned promise. The FULL
 * inventory of `connectToServer.cache.delete` sites that evict a cached
 * (including failed) dial result:
 *  - `clearServerCache` — pairs its delete with `bumpMcpReconnectEpoch()`
 *    (an explicit clear abandons any in-flight suspend-redial loop).
 *  - the shared `client.onclose` handler — same delete+bump pairing (the
 *    cache was cleared under any in-flight loop, whose result must not be
 *    re-persisted).
 *  - `scheduleHeadlessRemoteRedial`'s failed-redial delete and its catch-
 *    path delete — NO epoch bump. Deliberate: each evicts only the background
 *    redial's OWN already-settled failure (so the next use dials fresh); no
 *    suspend-redial loop is still in flight for that result, and no newer
 *    dial can be wrongly evicted because a concurrent connectToServer call
 *    for the same key shares this redial's memoized promise rather than
 *    starting a second dial.
 */
async function dialWithSuspendRedial(
  name: string,
  serverRef: ScopedMcpServerConfig,
  serverStats?: ConnectServerStats,
): Promise<MCPServerConnection> {
  const key = getServerCacheKey(name, serverRef)
  const generation = (dialGenerations.get(key) ?? 0) + 1
  dialGenerations.set(key, generation)
  return connectWithSuspendRedial(
    () => dialMcpServer(name, serverRef, serverStats),
    // Official currency check `n()` — this dial is current until a newer dial
    // for the same server key supersedes it.
    () => dialGenerations.get(key) === generation,
    // Official `$o`: plugin-source notification only — unported, no-op.
    () => {},
  )
}

export const connectToServer = memoize(
  (
    name: string,
    serverRef: ScopedMcpServerConfig,
    serverStats?: ConnectServerStats,
  ): Promise<MCPServerConnection> =>
    dialWithSuspendRedial(name, serverRef, serverStats),
  getServerCacheKey,
)

/**
 * Clears the memoize cache for a specific server
 * @param name Server name
 * @param serverRef Server configuration
 */
export async function clearServerCache(
  name: string,
  serverRef: ScopedMcpServerConfig,
): Promise<void> {
  const key = getServerCacheKey(name, serverRef)

  try {
    const wrappedClient = await connectToServer(name, serverRef)

    if (wrappedClient.type === 'connected') {
      await wrappedClient.cleanup()
    }
  } catch {
    // Ignore errors - server might have failed to connect
  }

  // Clear from cache (both connection and fetch caches so reconnect
  // fetches fresh tools/resources/commands instead of stale ones)
  connectToServer.cache.delete(key)
  // 2.1.307 B2: bump the reconnect epoch (official `Dr()`) — an explicit
  // cache clear abandons any in-flight suspend-redial loop for this server.
  bumpMcpReconnectEpoch()
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
  if (feature('MCP_SKILLS')) {
    fetchMcpSkillsForClient!.cache.delete(name)
  }
}

/**
 * Ensures a valid connected client for an MCP server.
 * For most server types, uses the memoization cache if available, or reconnects
 * if the cache was cleared (e.g., after onclose). This ensures tool/resource
 * calls always use a valid connection.
 *
 * SDK MCP servers run in-process and are handled separately via setupSdkMcpClients,
 * so they are returned as-is without going through connectToServer.
 *
 * @param client The connected MCP server client
 * @returns Connected MCP server client (same or reconnected)
 * @throws Error if server cannot be connected
 */
export async function ensureConnectedClient(
  client: ConnectedMCPServer,
): Promise<ConnectedMCPServer> {
  // SDK MCP servers run in-process and are handled separately via setupSdkMcpClients
  if (client.config.type === 'sdk') {
    return client
  }

  const connectedClient = await connectToServer(client.name, client.config)
  if (connectedClient.type !== 'connected') {
    // 2.1.308 SEC-F1: sanitize the interpolated server name, matching the
    // official Qt-sanitizer precedent on the equivalent not-connected path —
    // `MCP server not connected: ${Qt(Se.serverName)}` (BIN309 @277912512;
    // `Qt` @240114090 = sanitizeSessionRecoveryText). A hostile server name
    // (lone surrogates, invisibles) must not reach the surfaced message or
    // telemetry verbatim.
    throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      `MCP server "${sanitizeSessionRecoveryText(client.name)}" is not connected`,
      'MCP server not connected',
    )
  }
  return connectedClient
}

/**
 * Compares two MCP server configurations to determine if they are equivalent.
 * Used to detect when a server needs to be reconnected due to config changes.
 */
export function areMcpConfigsEqual(
  a: ScopedMcpServerConfig,
  b: ScopedMcpServerConfig,
): boolean {
  // Quick type check first
  if (a.type !== b.type) return false

  // Compare by serializing - this handles all config variations
  // We exclude 'scope' from comparison since it's metadata, not connection config
  const { scope: _scopeA, ...configA } = a
  const { scope: _scopeB, ...configB } = b
  return jsonStringify(configA) === jsonStringify(configB)
}

// Max cache size for fetch* caches. Keyed by server name (stable across
// reconnects), bounded to prevent unbounded growth with many MCP servers.
const MCP_FETCH_CACHE_SIZE = 20

/**
 * Encode MCP tool input for the auto-mode security classifier.
 * Exported so the auto-mode eval scripts can mirror production encoding
 * for `mcp__*` tool stubs without duplicating this logic.
 */
export function mcpToolInputToAutoClassifierInput(
  input: Record<string, unknown>,
  toolName: string,
): string {
  const keys = Object.keys(input)
  return keys.length > 0
    ? keys.map(k => `${k}=${String(input[k])}`).join(' ')
    : toolName
}

/**
 * 2.1.132: retry tools/list on transient failure (official retries before
 * giving up + marking "tools fetch failed").
 * 2.1.144: follow pagination (nextCursor) — accumulate all pages.
 * 2.1.295 (item 2): delegated to the official paginated list walker —
 * repeated-cursor stop, 20-page cap, official [250, 500, 1000]ms transient
 * retry schedule, and tengu_mcp_list_paginated telemetry.
 */
async function requestToolsListWithRetry(
  client: Client,
  serverName: string,
): Promise<ListToolsResult> {
  const tools = (await walkPaginatedList(
    client,
    serverName,
    'tools/list',
    ListToolsResultSchema,
    result => (result as unknown as ListToolsResult).tools,
  )) as ListToolsResult['tools']
  return { tools } as ListToolsResult
}

export const fetchToolsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Tool[]> => {
    if (client.type !== 'connected') return []

    try {
      if (!client.capabilities?.tools) {
        return []
      }

      const result = await requestToolsListWithRetry(client.client, client.name)

      // Sanitize tool data from MCP server
      const toolsToProcess = recursivelySanitizeUnicode(result.tools)

      // Check if we should skip the mcp__ prefix for SDK MCP servers
      const skipPrefix =
        client.config.type === 'sdk' &&
        isEnvTruthy(process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX)

      // CC 2.1.285 (item 4) — binary factory call site (byte-identical in
      // BOTH versions, v285 @229107828 / v284 @231460727):
      //   serverAlwaysLoad:e.config.alwaysLoad===!0, scope:e.config.scope
      const serverAlwaysLoad =
        'alwaysLoad' in client.config && client.config.alwaysLoad === true
      const isDynamicScope = client.config.scope === 'dynamic'
      // CC 2.1.287 (#7) — binary factories On()@232967426 / La()@233273756:
      //   serverDefersAllTools:e.config.alwaysLoad===!1
      // A server configured with `alwaysLoad:false` defers ALL of its tools
      // behind tool search (the v287 `!g&&` gate prefix below).
      const serverDefersAllTools =
        'alwaysLoad' in client.config && client.config.alwaysLoad === false

      // Convert MCP tools to our Tool format
      return toolsToProcess
        .map((tool): Tool => {
          const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
          // claude-code 2.1.91: an MCP tool can override its result-size
          // persistence limit via _meta["anthropic/maxResultSizeChars"]
          // (capped at 500K) so larger results like DB schemas pass through
          // without truncation.
          const maxResultSizeOverride = tool._meta?.[
            'anthropic/maxResultSizeChars'
          ]
          // claude-code 2.1.280 (#003) — binary factory `xi` (@223078250):
          //   Le=y?.tools?.[q.name]??q.description??""            // raw
          //   Ae=Qo(Le,`Tool "${q.name}" description`,e)          // truncated, eagerly
          // `description()` returns the RAW text and `prompt()` the truncated
          // one, both computed once at list time (so the truncation notice is
          // logged once per tool, not once per prompt() call).
          const rawDescription = tool.description ?? ''
          const truncatedDescription = truncateMcpDescription(
            rawDescription,
            `Tool "${tool.name}" description`,
            client.name,
          )
          // CC 2.1.295 (#112) — the official factory (@243900141, dup
          // @244085866) now computes TWO eager truncation variants:
          //   _e=Jt(Re,`Tool "${q.name}" description`,e)          // env ?? default cap (2048 in s295; 4096 since 296 #061)
          //   ce=Jt(Re,`Tool "${q.name}" description`,e,mx(!0))   // env ?? 16384
          //   async prompt({loadedThroughToolSearch:Ee}){return Ee?ce:_e}
          // s294 computed only the single variant. The wider cap applies ONLY
          // when the tool is being sent because tool search discovered it
          // (official call site @217614375:
          // `loadedThroughToolSearch:bn&&ur(Kn)&&Nn(Kn,Cr)`); the general
          // always-loaded path keeps the default cap (4096 since 296 #061).
          const toolSearchTruncatedDescription = truncateMcpDescription(
            rawDescription,
            `Tool "${tool.name}" description`,
            client.name,
            getMaxMcpDescriptionLength(true),
          )
          // CC 2.1.285 (item 4) — binary v284 factory:
          //   alwaysLoad:h||k._meta?.["anthropic/alwaysLoad"]===!0
          // became in v285:
          //   alwaysLoad:h&&!(r==="dynamic"&&D._meta?.["anthropic/alwaysLoad"]===!1)
          //             ||D._meta?.["anthropic/alwaysLoad"]===!0
          // (h=serverAlwaysLoad, r=config.scope). A tool that lists its own
          // `_meta['anthropic/alwaysLoad']` as false now STAYS DEFERRED when
          // its dynamic-scope server (--mcp-config / Agent SDK / plugin) sets
          // `alwaysLoad`; explicit true always wins, and non-dynamic scopes
          // keep the server-level flag. (OCC previously applied only the
          // tool-level flag — the server-level `alwaysLoad` config was never
          // honored here, so the full v285 formula is ported.)
          const toolAlwaysLoadMeta = tool._meta?.['anthropic/alwaysLoad']
          return {
            ...MCPTool,
            // In skip-prefix mode, use the original name for model invocation so MCP tools
            // can override builtins by name. mcpInfo is used for permission checking.
            name: skipPrefix ? tool.name : fullyQualifiedName,
            mcpInfo: { serverName: client.name, toolName: tool.name },
            isMcp: true,
            maxResultSizeChars: resolveMcpMaxResultSizeChars(
              maxResultSizeOverride,
              MCPTool.maxResultSizeChars,
            ),
            // Collapse whitespace: _meta is open to external MCP servers, and
            // a newline here would inject orphan lines into the deferred-tool
            // list (formatDeferredToolLine joins on '\n').
            searchHint:
              typeof tool._meta?.['anthropic/searchHint'] === 'string'
                ? tool._meta['anthropic/searchHint']
                    .replace(/\s+/g, ' ')
                    .trim() || undefined
                : undefined,
            // CC 2.1.287 (#7) — binary v287 gate @232962174:
            //   alwaysLoad:!g&&(h&&!(r==="dynamic"&&U._meta?.["anthropic/alwaysLoad"]===!1)
            //             ||U._meta?.["anthropic/alwaysLoad"]===!0)
            // (g=serverDefersAllTools, h=serverAlwaysLoad, r=config.scope).
            // Server `alwaysLoad:false` ⇒ EVERY tool of that server defers
            // behind tool search — the !g&& prefix overrides even a tool-level
            // _meta['anthropic/alwaysLoad']===true. alwaysLoad:true/undefined
            // keep the v285 formula unchanged.
            alwaysLoad:
              !serverDefersAllTools &&
              ((serverAlwaysLoad &&
                !(isDynamicScope && toolAlwaysLoadMeta === false)) ||
                toolAlwaysLoadMeta === true),
            async description() {
              return rawDescription
            },
            async prompt(options?: unknown) {
              // CC 2.1.295 (#112) — official:
              //   async prompt({loadedThroughToolSearch:Ee}){return Ee?ce:_e}
              // Review-round wiring (OCC-153 acceptance): Tool.prompt's
              // options type (src/Tool.ts) now declares the flag and the
              // API-schema serializer (src/utils/api.ts) passes it, derived
              // as `options.loadedThroughToolSearch ?? (deferLoading &&
              // isMcp)` — the tool-search-discovered deferred MCP tools
              // serialized at claude.ts (`deferLoading:true`), mirroring the
              // official call-site gate @217614375
              // (`bn&&ur(Kn)&&Nn(Kn,Cr)`). The schema-cache key carries the
              // official `"LT:"` bit @215678602 when
              // `loadedThroughToolSearch===!0&&isMcp===!0`, so the default
              // (4096 since 296 #061) and 16384 variants never share a cache
              // entry. Non-tool-search callers keep the byte-identical
              // default-cap behavior.
              const loadedThroughToolSearch =
                typeof options === 'object' &&
                options !== null &&
                'loadedThroughToolSearch' in options &&
                Boolean(
                  (options as { loadedThroughToolSearch?: unknown })
                    .loadedThroughToolSearch,
                )
              return loadedThroughToolSearch
                ? toolSearchTruncatedDescription
                : truncatedDescription
            },
            isConcurrencySafe() {
              return tool.annotations?.readOnlyHint ?? false
            },
            isReadOnly() {
              return tool.annotations?.readOnlyHint ?? false
            },
            toAutoClassifierInput(input) {
              return mcpToolInputToAutoClassifierInput(input, tool.name)
            },
            isDestructive() {
              return tool.annotations?.destructiveHint ?? false
            },
            isOpenWorld() {
              return tool.annotations?.openWorldHint ?? false
            },
            isSearchOrReadCommand() {
              return classifyMcpToolForCollapse(client.name, tool.name)
            },
            inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
            async checkPermissions() {
              return {
                behavior: 'passthrough' as const,
                message: 'MCPTool requires permission.',
                suggestions: [
                  {
                    type: 'addRules' as const,
                    rules: [
                      {
                        toolName: fullyQualifiedName,
                        ruleContent: undefined,
                      },
                    ],
                    behavior: 'allow' as const,
                    destination: 'localSettings' as const,
                  },
                ],
              }
            },
            async call(
              args: Record<string, unknown>,
              context,
              _canUseTool,
              parentMessage,
              onProgress?: ToolCallProgress<MCPProgress>,
            ) {
              const toolUseId = extractToolUseId(parentMessage)
              const meta = toolUseId
                ? { 'claudecode/toolUseId': toolUseId }
                : {}

              // Emit progress when tool starts
              if (onProgress && toolUseId) {
                onProgress({
                  toolUseID: toolUseId,
                  data: {
                    type: 'mcp_progress',
                    status: 'started',
                    serverName: client.name,
                    toolName: tool.name,
                  },
                })
              }

              const startTime = Date.now()
              const MAX_SESSION_RETRIES = 1
              for (let attempt = 0; ; attempt++) {
                try {
                  const connectedClient = await ensureConnectedClient(client)

                  // 2.1.212: wrap the MCP tool call with the auto-background
                  // primitive. If the call exceeds the threshold (default
                  // 120000ms, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS), it moves to
                  // the background and the model sees a "moved to background"
                  // result immediately; the tool keeps running under its own
                  // AbortController and its result arrives later via the
                  // background-tasks system.
                  const autoBackgroundMs = getMcpAutoBackgroundMs()
                  const autoBackgroundOutcome = autoBackgroundMs > 0
                    ? await callMcpToolWithAutoBackground({
                        run: signal =>
                          callMCPToolWithUrlElicitationRetry({
                            client: connectedClient,
                            clientConnection: client,
                            tool: tool.name,
                            args,
                            meta,
                            signal,
                            setAppState: context.setAppState,
                            onProgress:
                              onProgress && toolUseId
                                ? progressData => {
                                    onProgress({
                                      toolUseID: toolUseId,
                                      data: progressData,
                                    })
                                  }
                                : undefined,
                            handleElicitation: context.handleElicitation,
                          }),
                        serverName: client.name,
                        toolName: tool.name,
                        toolUseId,
                        parentAbortController: context.abortController,
                        taskRegistry: makeAppStateTaskRegistry(
                          context.setAppState,
                        ),
                        autoBackgroundMs,
                        hasPendingElicitation: () =>
                          (context.getAppState()?.elicitation?.queue
                            ?.length ?? 0) > 0,
                        onBackgrounded: () => {
                          if (onProgress && toolUseId) {
                            onProgress({
                              toolUseID: toolUseId,
                              data: {
                                type: 'mcp_progress',
                                status: 'backgrounded',
                                serverName: client.name,
                                toolName: tool.name,
                                elapsedTimeMs: Date.now() - startTime,
                              },
                            })
                          }
                        },
                      })
                    : {
                        kind: 'settled' as const,
                        result: await callMCPToolWithUrlElicitationRetry({
                          client: connectedClient,
                          clientConnection: client,
                          tool: tool.name,
                          args,
                          meta,
                          signal: context.abortController.signal,
                          setAppState: context.setAppState,
                          onProgress:
                            onProgress && toolUseId
                              ? progressData => {
                                  onProgress({
                                    toolUseID: toolUseId,
                                    data: progressData,
                                  })
                                }
                              : undefined,
                          handleElicitation: context.handleElicitation,
                        }),
                      }

                  // 2.1.307 B3: official success-after-retry counter —
                  // `if(Et>0)g("mcp_session_recovery")` once the retried call
                  // settles without throwing.
                  if (attempt > 0) {
                    logEvent('mcp_session_recovery', {})
                  }

                  // Tool was moved to the background — return a backgrounded
                  // result so the model knows the task id and that the result
                  // will arrive later.
                  if (autoBackgroundOutcome.kind === 'backgrounded') {
                    if (onProgress && toolUseId) {
                      onProgress({
                        toolUseID: toolUseId,
                        data: {
                          type: 'mcp_progress',
                          status: 'backgrounded',
                          serverName: client.name,
                          toolName: tool.name,
                          elapsedTimeMs: Date.now() - startTime,
                        },
                      })
                    }
                    return {
                      data: mcpBackgroundedMessage(
                        tool.name,
                        Math.floor((Date.now() - startTime) / 1000),
                        autoBackgroundOutcome.task.mcpTaskId,
                      ),
                    }
                  }

                  const mcpResult = autoBackgroundOutcome.result

                  // Emit progress when tool completes successfully
                  if (onProgress && toolUseId) {
                    onProgress({
                      toolUseID: toolUseId,
                      data: {
                        type: 'mcp_progress',
                        status: 'completed',
                        serverName: client.name,
                        toolName: tool.name,
                        elapsedTimeMs: Date.now() - startTime,
                      },
                    })
                  }

                  return {
                    data: mcpResult.content,
                    ...((mcpResult._meta || mcpResult.structuredContent) && {
                      mcpMeta: {
                        ...(mcpResult._meta && {
                          _meta: mcpResult._meta,
                        }),
                        ...(mcpResult.structuredContent && {
                          structuredContent: mcpResult.structuredContent,
                        }),
                      },
                    }),
                  }
                } catch (error) {
                  // 2.1.307 B3: official retry gate (byte-verified @279114404):
                  // `ze instanceof SO&&Et<1&&(!ze.mayHaveRun||
                  //   ee.isConcurrencySafe(te)||x.annotations?.idempotentHint===!0)`
                  // — a may-have-run expiry is retried ONLY when the tool is
                  // concurrency-safe (readOnlyHint) or explicitly idempotent;
                  // otherwise the error surfaces with its per-kind message.
                  if (
                    error instanceof McpSessionExpiredError &&
                    attempt < MAX_SESSION_RETRIES &&
                    shouldRetryAfterSessionRecovery(
                      tool.annotations,
                      error.mayHaveRun,
                    )
                  ) {
                    // Official f("mcp_session_recovery", ze.expiryKind).
                    logEvent('mcp_session_recovery', {
                      reason:
                        error.expiryKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    logMCPDebug(
                      client.name,
                      `Retrying tool '${tool.name}' after session recovery`,
                    )
                    continue
                  }
                  if (error instanceof McpSessionExpiredError) {
                    // Official m("mcp_session_recovery",
                    //   Et<1?"may_have_run_no_retry":"session_retry_exhausted").
                    logEvent('mcp_session_recovery', {
                      reason: (attempt < MAX_SESSION_RETRIES
                        ? 'may_have_run_no_retry'
                        : 'session_retry_exhausted') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                  } else if (
                    attempt > 0 &&
                    !context.abortController.signal.aborted
                  ) {
                    // Official m("mcp_session_recovery","retry_failed_other").
                    logEvent('mcp_session_recovery', {
                      reason:
                        'retry_failed_other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                  }

                  // Emit progress when tool fails
                  if (onProgress && toolUseId) {
                    onProgress({
                      toolUseID: toolUseId,
                      data: {
                        type: 'mcp_progress',
                        status: 'failed',
                        serverName: client.name,
                        toolName: tool.name,
                        elapsedTimeMs: Date.now() - startTime,
                      },
                    })
                  }
                  // Wrap MCP SDK errors so telemetry gets useful context
                  // instead of just "Error" or "McpError" (the constructor
                  // name). MCP SDK errors are protocol-level messages and
                  // don't contain user file paths or code.
                  if (
                    error instanceof Error &&
                    !(
                      error instanceof
                      TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
                    )
                  ) {
                    const name = error.constructor.name
                    if (name === 'Error') {
                      throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                        error.message,
                        error.message.slice(0, 200),
                      )
                    }
                    // McpError has a numeric `code` with the JSON-RPC error
                    // code (e.g. -32000 ConnectionClosed, -32001 RequestTimeout)
                    if (
                      name === 'McpError' &&
                      'code' in error &&
                      typeof error.code === 'number'
                    ) {
                      throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                        error.message,
                        `McpError ${error.code}`,
                      )
                    }
                  }
                  // 2.1.307 F-01 / 2.1.308 F-03: a NON-retried session expiry
                  // surfaces as the official `ky` rendered text (relay-site
                  // substitute — see McpSessionRecoveryTextError), with the
                  // render shape chosen by the SAME reason expression as the
                  // telemetry above: may_have_run_no_retry → site-1 shape,
                  // session_retry_exhausted → site-2 dispatch shape. The
                  // official session_expired_no_retry counter belongs to the
                  // unported CCR relay sites and is deliberately NOT emitted
                  // here (no double telemetry). McpSessionExpiredError extends
                  // TelemetrySafeError, so the wrap branch above never runs
                  // for it — this is the only transform on the rethrow path.
                  if (error instanceof McpSessionExpiredError) {
                    throw new McpSessionRecoveryTextError(
                      client.name,
                      error,
                      attempt < MAX_SESSION_RETRIES
                        ? 'may_have_run_no_retry'
                        : 'session_retry_exhausted',
                    )
                  }
                  throw error
                }
              }
            },
            userFacingName() {
              // Prefer title annotation if available, otherwise use tool name
              const displayName = tool.annotations?.title || tool.name
              return `${client.name} - ${displayName} (MCP)`
            },
            ...(isClaudeInChromeMCPServer(client.name) &&
            (client.config.type === 'stdio' || !client.config.type)
              ? claudeInChromeToolRendering().getClaudeInChromeMCPToolOverrides(
                  tool.name,
                )
              : {}),
            ...(feature('CHICAGO_MCP') &&
            (client.config.type === 'stdio' || !client.config.type) &&
            isComputerUseMCPServer!(client.name)
              ? computerUseWrapper!().getComputerUseMCPToolOverrides(tool.name)
              : {}),
          }
        })
        .filter(isIncludedMcpTool)
    } catch (error) {
      logMCPError(client.name, `Failed to fetch tools: ${errorMessage(error)}`)
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)

export const fetchResourcesForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<ServerResource[]> => {
    if (client.type !== 'connected') return []

    try {
      if (!client.capabilities?.resources) {
        return []
      }

      // 2.1.144: follow pagination (nextCursor) for resources/list.
      // 2.1.295 (item 2): via the guarded paginated list walker (repeated-
      // cursor stop, 20-page cap, transient retry, list-paginated telemetry).
      const resources = (await walkPaginatedList(
        client.client,
        client.name,
        'resources/list',
        ListResourcesResultSchema,
        result => (result as unknown as ListResourcesResult).resources,
      )) as NonNullable<ListResourcesResult['resources']>

      if (!resources.length) return []

      // Add server name to each resource, then drop MCP Apps UI resources
      // (2.1.281 #147): a ui:// URI, or text/html with profile=mcp-app, is
      // for host-side rendering and is left out of the model's list.
      // Read-by-URI (resources/read) is unaffected.
      return filterMcpAppUiResources(
        resources.map(resource => ({
          ...resource,
          server: client.name,
        })),
        client.name,
      )
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to fetch resources: ${errorMessage(error)}`,
      )
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)

export const fetchCommandsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected') return []

    try {
      if (!client.capabilities?.prompts) {
        return []
      }

      // 2.1.144: follow pagination (nextCursor) for prompts/list.
      // 2.1.295 (item 2): via the guarded paginated list walker (repeated-
      // cursor stop, 20-page cap, transient retry, list-paginated telemetry).
      const allPrompts = (await walkPaginatedList(
        client.client,
        client.name,
        'prompts/list',
        ListPromptsResultSchema,
        result => (result as unknown as ListPromptsResult).prompts,
      )) as NonNullable<ListPromptsResult['prompts']>

      if (!allPrompts.length) return []

      // Sanitize prompt data from MCP server
      const promptsToProcess = recursivelySanitizeUnicode(allPrompts)

      // Convert MCP prompts to our Command format. CC 2.1.283 reserved-
      // namespace hardening (official rZe, zAe=["anthropic-skills"] only —
      // 2.1.282's second element "claude-ai" was reverted upstream): prompts
      // whose command is a reserved-namespace squatter are dropped — a server
      // named anthropic-skills makes every prompt displayName
      // ("<server>:<prompt> (MCP)") reserved. Each drop logs the byte-exact
      // per-prompt message via the MCP debug log. Tools are unaffected.
      const commands: Command[] = []
      for (const prompt of promptsToProcess) {
        const argNames = Object.values(prompt.arguments ?? {}).map(k => k.name)
        const command: Command = {
          type: 'prompt' as const,
          name: 'mcp__' + normalizeNameForMCP(client.name) + '__' + prompt.name,
          description: prompt.description ?? '',
          hasUserSpecifiedDescription: !!prompt.description,
          contentLength: 0, // Dynamic MCP content
          isEnabled: () => true,
          isHidden: false,
          isMcp: true,
          progressMessage: 'running',
          userFacingName() {
            // Use prompt.name (programmatic identifier) not prompt.title (display name)
            // to avoid spaces breaking slash command parsing
            return `${client.name}:${prompt.name} (MCP)`
          },
          argNames,
          source: 'mcp',
          async getPromptForCommand(args: string) {
            const argsArray = args.split(' ')
            try {
              const connectedClient = await ensureConnectedClient(client)
              const result = await connectedClient.client.getPrompt({
                name: prompt.name,
                arguments: zipObject(argNames, argsArray),
              })
              const transformed = await Promise.all(
                result.messages.map(message =>
                  transformResultContent(message.content, connectedClient.name),
                ),
              )
              return transformed.flat()
            } catch (error) {
              logMCPError(
                client.name,
                `Error running command '${prompt.name}': ${errorMessage(error)}`,
              )
              throw error
            }
          },
        }
        if (shouldRefuseReservedName(command)) {
          logMCPDebug(client.name, reservedMcpPromptMessage(command.name))
          continue
        }
        commands.push(command)
      }
      return commands
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to fetch commands: ${errorMessage(error)}`,
      )
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)

/**
 * Call an IDE tool directly as an RPC
 * @param toolName The name of the tool to call
 * @param args The arguments to pass to the tool
 * @param client The IDE client to use for the RPC call
 * @returns The result of the tool call
 */
export async function callIdeRpc(
  toolName: string,
  args: Record<string, unknown>,
  client: ConnectedMCPServer,
): Promise<string | ContentBlockParam[] | undefined> {
  const result = await callMCPTool({
    client,
    tool: toolName,
    args,
    signal: createAbortController().signal,
  })
  return result.content
}

/**
 * Note: This should not be called by UI components directly, they should use the reconnectMcpServer
 * function from useManageMcpConnections.
 * @param name Server name
 * @param config Server configuration
 * @returns Object containing the client connection and its resources
 */
export async function reconnectMcpServerImpl(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<{
  client: MCPServerConnection
  tools: Tool[]
  commands: Command[]
  resources?: ServerResource[]
}> {
  try {
    // Invalidate the keychain cache so we read fresh credentials from disk.
    // This is necessary when another process (e.g. the VS Code extension host)
    // has modified stored tokens (cleared auth, saved new OAuth tokens) and then
    // asks the CLI subprocess to reconnect.  Without this, the subprocess would
    // use stale cached data and never notice the tokens were removed.
    clearKeychainCache()

    await clearServerCache(name, config)
    // 2.1.295 (item 3): while an explicit reconnect is in flight, a pending
    // headless rapid-drop redial for the same server waits instead of racing
    // this dial (official `isControlReconnectInFlight` / unsettled-dial wait).
    const reconnectKey = getServerCacheKey(name, config)
    explicitReconnectsInFlight.add(reconnectKey)
    let client: MCPServerConnection
    try {
      client = await connectToServer(name, config)
    } finally {
      explicitReconnectsInFlight.delete(reconnectKey)
    }

    if (client.type !== 'connected') {
      return {
        client,
        tools: [],
        commands: [],
      }
    }

    if (config.type === 'claudeai-proxy') {
      markClaudeAiMcpConnected(name)
    }

    const supportsResources = !!client.capabilities?.resources

    const [tools, mcpCommands, mcpSkills, resources] = await Promise.all([
      fetchToolsForClient(client),
      fetchCommandsForClient(client),
      feature('MCP_SKILLS') && supportsResources
        ? fetchMcpSkillsForClient!(client)
        : Promise.resolve([]),
      supportsResources ? fetchResourcesForClient(client) : Promise.resolve([]),
    ])
    const commands = [...mcpCommands, ...mcpSkills]

    // Check if we need to add resource tools
    const resourceTools: Tool[] = []
    if (supportsResources) {
      // Only add resource tools if no other server has them
      const hasResourceTools = [
        ListMcpResourcesTool,
        ReadMcpResourceTool,
        ReadMcpResourceDirTool,
      ].some(tool => tools.some(t => toolMatchesName(t, tool.name)))
      if (!hasResourceTools) {
        resourceTools.push(
          ListMcpResourcesTool,
          ReadMcpResourceTool,
          ReadMcpResourceDirTool,
        )
      }
    }

    return {
      client,
      tools: [...tools, ...resourceTools],
      commands,
      resources: resources.length > 0 ? resources : undefined,
    }
  } catch (error) {
    // Handle errors gracefully - connection might have closed during fetch
    logMCPError(name, `Error during reconnection: ${errorMessage(error)}`)

    // Return with failed status
    return {
      client: { name, type: 'failed' as const, config },
      tools: [],
      commands: [],
    }
  }
}

// Replaced 2026-03: previous implementation ran fixed-size sequential batches
// (await batch 1 fully, then start batch 2). That meant one slow server in
// batch N held up ALL servers in batch N+1, even if the other 19 slots were
// idle. pMap frees each slot as soon as its server completes, so a single
// slow server only occupies one slot instead of blocking an entire batch
// boundary. Same concurrency ceiling, same results, better scheduling.
async function processBatched<T>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<void>,
): Promise<void> {
  await pMap(items, processor, { concurrency })
}

export async function getMcpToolsCommandsAndResources(
  onConnectionAttempt: (params: {
    client: MCPServerConnection
    tools: Tool[]
    commands: Command[]
    resources?: ServerResource[]
  }) => void,
  mcpConfigs?: Record<string, ScopedMcpServerConfig>,
): Promise<void> {
  let resourceToolsAdded = false

  const allConfigEntries = Object.entries(
    mcpConfigs ?? (await getAllMcpConfigs()).servers,
  )

  // Partition into disabled and active entries — disabled servers should
  // never generate HTTP connections or flow through batch processing
  const configEntries: typeof allConfigEntries = []
  for (const entry of allConfigEntries) {
    if (isMcpServerDisabled(entry[0])) {
      onConnectionAttempt({
        client: { name: entry[0], type: 'disabled', config: entry[1] },
        tools: [],
        commands: [],
      })
    } else {
      configEntries.push(entry)
    }
  }

  // Calculate transport counts for logging
  const totalServers = configEntries.length
  const stdioCount = count(configEntries, ([_, c]) => c.type === 'stdio')
  const sseCount = count(configEntries, ([_, c]) => c.type === 'sse')
  const httpCount = count(configEntries, ([_, c]) => c.type === 'http')
  const sseIdeCount = count(configEntries, ([_, c]) => c.type === 'sse-ide')
  const wsIdeCount = count(configEntries, ([_, c]) => c.type === 'ws-ide')

  // Split servers by type: local (stdio/sdk) need lower concurrency due to
  // process spawning, remote servers can connect with higher concurrency
  const localServers = configEntries.filter(([_, config]) =>
    isLocalMcpServer(config),
  )
  const remoteServers = configEntries.filter(
    ([_, config]) => !isLocalMcpServer(config),
  )

  const serverStats = {
    totalServers,
    stdioCount,
    sseCount,
    httpCount,
    sseIdeCount,
    wsIdeCount,
  }

  const processServer = async ([name, config]: [
    string,
    ScopedMcpServerConfig,
  ]): Promise<void> => {
    try {
      // Check if server is disabled - if so, just add it to state without connecting
      if (isMcpServerDisabled(name)) {
        onConnectionAttempt({
          client: {
            name,
            type: 'disabled',
            config,
          },
          tools: [],
          commands: [],
        })
        return
      }

      // Skip connection for servers that recently returned 401 (15min TTL),
      // or that we have probed before but hold no token for. The second
      // check closes the gap the TTL leaves open: without it, every 15min
      // we re-probe servers that cannot succeed until the user runs /mcp.
      // Each probe is a network round-trip for connect-401 plus OAuth
      // discovery, and print mode awaits the whole batch (main.tsx:3503).
      if (
        (config.type === 'claudeai-proxy' ||
          config.type === 'http' ||
          config.type === 'sse') &&
        ((await isMcpAuthCached(name)) ||
          ((config.type === 'http' || config.type === 'sse') &&
            hasMcpDiscoveryButNoToken(name, config)))
      ) {
        logMCPDebug(name, `Skipping connection (cached needs-auth)`)
        onConnectionAttempt({
          client: { name, type: 'needs-auth' as const, config },
          tools: createMcpAuthStubTools(name, config),
          commands: [],
        })
        return
      }

      const client = await connectToServer(name, config, serverStats)

      if (client.type !== 'connected') {
        onConnectionAttempt({
          client,
          tools:
            client.type === 'needs-auth'
              ? createMcpAuthStubTools(name, config)
              : [],
          commands: [],
        })
        return
      }

      if (config.type === 'claudeai-proxy') {
        markClaudeAiMcpConnected(name)
      }

      const supportsResources = !!client.capabilities?.resources

      const [tools, mcpCommands, mcpSkills, resources] = await Promise.all([
        fetchToolsForClient(client),
        fetchCommandsForClient(client),
        // Discover skills from skill:// resources
        feature('MCP_SKILLS') && supportsResources
          ? fetchMcpSkillsForClient!(client)
          : Promise.resolve([]),
        // Fetch resources if supported
        supportsResources
          ? fetchResourcesForClient(client)
          : Promise.resolve([]),
      ])
      const commands = [...mcpCommands, ...mcpSkills]

      // If this server resources and we haven't added resource tools yet,
      // include our resource tools with this client's tools
      const resourceTools: Tool[] = []
      if (supportsResources && !resourceToolsAdded) {
        resourceToolsAdded = true
        resourceTools.push(
          ListMcpResourcesTool,
          ReadMcpResourceTool,
          ReadMcpResourceDirTool,
        )
      }

      onConnectionAttempt({
        client,
        tools: [...tools, ...resourceTools],
        commands,
        resources: resources.length > 0 ? resources : undefined,
      })
    } catch (error) {
      // Handle errors gracefully - connection might have closed during fetch
      logMCPError(
        name,
        `Error fetching tools/commands/resources: ${errorMessage(error)}`,
      )

      // Still update with the client but no tools/commands
      onConnectionAttempt({
        client: { name, type: 'failed' as const, config },
        tools: [],
        commands: [],
      })
    }
  }

  // Process both groups concurrently, each with their own concurrency limits:
  // - Local servers (stdio/sdk): lower concurrency to avoid process spawning resource contention
  // - Remote servers: higher concurrency since they're just network connections
  await Promise.all([
    processBatched(
      localServers,
      getMcpServerConnectionBatchSize(),
      processServer,
    ),
    processBatched(
      remoteServers,
      getRemoteMcpServerConnectionBatchSize(),
      processServer,
    ),
  ])
}

/**
 * Bound an MCP connection batch wait, mirroring claude-code 2.1.89's per-server
 * `oq(connectionPromise, serverName)`:
 * - `MCP_CONNECTION_NONBLOCKING=true` → skip the wait entirely (print mode
 *   proceeds without MCP tools on turn 1; they stream in via onConnectionAttempt
 *   callbacks as servers connect in the background).
 * - Otherwise → race the connection vs 5s. On timeout, proceed (background
 *   connection continues; "bounded --mcp-config server connections at 5s
 *   instead of blocking on the slowest server").
 *
 * Applied at the batch await in main.tsx so the whole --mcp-config wait is
 * capped at 5s — observably equivalent to v89's per-server wrap under the
 * parallel Promise.all (the slowest server caps the batch either way).
 *
 * `connectionPromise` must never reject (callers .catch it to a log) so the
 * race's `.then(() => false)` branch can't throw.
 */
export const MCP_CONNECTION_TIMEOUT_MS = 5000

export type McpConnectionWaitResult = 'connected' | 'timed-out' | 'skipped'

/**
 * CC 2.1.288 (#69) — options for the first-turn prewait. `skipServerNames` is
 * the official `ga` option of the same name (@226009370:
 * `skipServerNames:he` destructured from the options bag and applied in the
 * per-client predicate `K=(It)=>…&&!he?.has(It.name)&&…`).
 */
export type McpConnectionWaitOptions = {
  /**
   * Servers the prewait must NOT block on (computeFirstTurnSkipServerNames).
   */
  skipServerNames?: ReadonlySet<string>
  /**
   * Names of the servers covered by `connectionPromise`. OCC races ONE merged
   * batch promise where the official subscribes to per-client store state, so
   * the skip can only short-circuit the wait when it covers the whole batch —
   * otherwise the batch is awaited unchanged (fail-safe: never skip a server
   * the caller still needs).
   */
  batchServerNames?: readonly string[]
}

export async function waitForMcpConnectionBatch(
  connectionPromise: Promise<unknown>,
  label: string,
  options?: McpConnectionWaitOptions,
): Promise<McpConnectionWaitResult> {
  if (isEnvTruthy(process.env.MCP_CONNECTION_NONBLOCKING)) {
    logMCPDebug(label, 'running fully async (MCP_CONNECTION_NONBLOCKING)')
    return 'skipped'
  }
  // CC 2.1.288 (#69): a first turn whose deferred servers are neither required
  // nor referenced proceeds without waiting for them. The connections keep
  // running in the background, so a later turn still sees the servers.
  const { skipServerNames, batchServerNames } = options ?? {}
  if (
    skipServerNames &&
    skipServerNames.size > 0 &&
    batchServerNames &&
    batchServerNames.length > 0 &&
    batchServerNames.every(name => skipServerNames.has(name))
  ) {
    logMCPDebug(
      label,
      `first-turn prewait skipped ${batchServerNames.length} deferred server(s); connecting in background`,
    )
    return 'skipped'
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    connectionPromise.then(() => false),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), MCP_CONNECTION_TIMEOUT_MS)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (timedOut) {
    logMCPDebug(
      label,
      `not ready after ${MCP_CONNECTION_TIMEOUT_MS}ms — proceeding; background connection continues`,
    )
    return 'timed-out'
  }
  return 'connected'
}

/**
 * Official `qh` (@226009370) — the shared empty skip set returned by every
 * bail-out branch of `$h`, so callers can compare identity in tests and never
 * allocate on the common "nothing to skip" path.
 */
export const EMPTY_SKIP_SERVER_NAMES: ReadonlySet<string> = new Set<string>()

/**
 * The subset of an MCP client entry the first-turn prewait reads. Structurally
 * satisfied by `MCPServerConnection`.
 */
export type McpPrewaitClient = {
  name: string
  type: string
  config: ScopedMcpServerConfig
}

export type FirstTurnPrewaitInput = {
  /** Official `clients:r` — the connection-store client entries. */
  clients: readonly McpPrewaitClient[]
  /** Official `messages:s` — the conversation the first turn was built from. */
  messages: readonly Message[]
  /**
   * Official `VPe()==="tst"`. Required (no default) so a caller can never skip
   * servers on a later turn by omission.
   */
  isFirstTurn: boolean
  /**
   * Official `requiredServerNames:n` — a thunk returning SEGMENT names
   * (`fF(name)`), not raw config keys.
   */
  requiredServerNames?: () => ReadonlySet<string>
}

/**
 * Official `fF` (@199725239):
 *   function fF(e){return as(`${$s(e)}x`)?.serverName??En(e)}
 * i.e. the collision key of the name, falling back to the normalized name.
 * OCC ports `as` as mcpInfoFromString / `$s` as getMcpPrefix (together
 * `getMcpServerNameCollisionKey`, official `Jd`) and `En` as normalizeNameForMCP.
 */
function getMcpServerNameSegment(serverName: string): string {
  return getMcpServerNameCollisionKey(serverName) ?? normalizeNameForMCP(serverName)
}

/** Official `qs` — tolerant "list of strings" read of an attachment field. */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Minimal port of the official conversation scan `uR` (@226009370). Returns the
 * set of MCP server names the conversation references, or `undefined` when the
 * answer cannot be trusted — which `$h` turns into "skip nothing".
 *
 * OCC divergence: the official seeds the set from `nY(e,…)` (its full
 * surfaced-name collector) and bails on three builtin tool names (`lR`); OCC
 * has neither, so it scans assistant `tool_use` names, `deferred_tools_delta`
 * attachment names, and `mcp__…` tokens in message text. Every divergence is
 * in the fail-safe direction: an over-broad scan keeps waiting on a server, it
 * never skips one that is actually referenced.
 */
function collectFirstTurnServerNames(
  messages: readonly Message[],
): Set<string> | undefined {
  const toolNames = new Set<string>()
  const scanText = (text: string): void => {
    for (const match of text.matchAll(/mcp__[\w.-]+/g)) {
      toolNames.add(match[0])
    }
  }
  for (const message of messages) {
    if (message.type === 'attachment') {
      const attachment = message.attachment as
        | { type?: string; addedNames?: unknown; wireHiddenNames?: unknown }
        | undefined
      if (attachment?.type === 'deferred_tools_delta') {
        for (const name of toStringList(attachment.addedNames)) {
          toolNames.add(name)
        }
        for (const name of toStringList(attachment.wireHiddenNames)) {
          toolNames.add(name)
        }
      }
      continue
    }
    const content = message.message?.content as unknown
    if (typeof content === 'string') {
      scanText(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown> | undefined>) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        toolNames.add(block.name)
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        scanText(block.text)
      }
    }
  }
  const serverNames = new Set<string>()
  for (const name of toolNames) {
    const info = mcpInfoFromString(name)
    if (info) {
      serverNames.add(info.serverName)
    } else if (name.startsWith('mcp__')) {
      // Official: `else if(lR.has(h)||h.startsWith("mcp__"))return` — an
      // MCP-looking name we cannot attribute to a server means the scan is
      // unreliable, so bail out and wait for everything.
      return undefined
    }
  }
  return serverNames
}

/**
 * CC 2.1.288 (#69) — port of the official `$h` (@226009370): on the FIRST turn
 * only, pending stdio servers configured `alwaysLoad:false` that are neither
 * required nor referenced by the first-turn messages go into `skipServerNames`
 * so the wait orchestrator does not block on them.
 *
 * Official gate: `if(g.length===0||!e()||VPe()!=="tst"||!Qh())return qh`.
 * OCC divergence: `policyAllows()` (`e`) and the deferral-active check (`Qh`)
 * have no OCC counterpart — OCC's deferral IS the `alwaysLoad:false` candidate
 * predicate (see serverDefersAllTools above), so a candidate that passes the
 * filter is by construction fully deferred.
 */
export function computeFirstTurnSkipServerNames({
  clients,
  messages,
  isFirstTurn,
  requiredServerNames,
}: FirstTurnPrewaitInput): ReadonlySet<string> {
  const candidates = clients.filter(client => {
    const config = client.config as { type?: string; alwaysLoad?: unknown }
    return (
      client.type === 'pending' &&
      config.alwaysLoad === false &&
      (config.type === undefined || config.type === 'stdio')
    )
  })
  if (candidates.length === 0 || !isFirstTurn) return EMPTY_SKIP_SERVER_NAMES

  let referenced: Set<string> | undefined
  try {
    referenced = collectFirstTurnServerNames(messages)
  } catch (error) {
    // Official (verbatim): `MCP prewait: reading the conversation failed: ${l(s)}`
    logForDebugging(
      `MCP prewait: reading the conversation failed: ${errorMessage(error)}`,
      { level: 'error' },
    )
    return EMPTY_SKIP_SERVER_NAMES
  }
  if (referenced === undefined) return EMPTY_SKIP_SERVER_NAMES

  const required = requiredServerNames?.() ?? EMPTY_SKIP_SERVER_NAMES
  return new Set(
    candidates
      .map(client => ({
        name: client.name,
        segment: getMcpServerNameSegment(client.name),
      }))
      .filter(
        entry => !required.has(entry.segment) && !referenced?.has(entry.segment),
      )
      .map(entry => entry.name),
  )
}

// Not memoized: called only 2-3 times at startup/reconfig. The inner work
// (connectToServer, fetch*ForClient) is already cached. Memoizing here by
// mcpConfigs object ref leaked — main.tsx creates fresh config objects each call.
export function prefetchAllMcpResources(
  mcpConfigs: Record<string, ScopedMcpServerConfig>,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
}> {
  return new Promise(resolve => {
    let pendingCount = 0
    let completedCount = 0

    pendingCount = Object.keys(mcpConfigs).length

    if (pendingCount === 0) {
      void resolve({
        clients: [],
        tools: [],
        commands: [],
      })
      return
    }

    const clients: MCPServerConnection[] = []
    const tools: Tool[] = []
    const commands: Command[] = []

    getMcpToolsCommandsAndResources(result => {
      clients.push(result.client)
      tools.push(...result.tools)
      commands.push(...result.commands)

      completedCount++
      if (completedCount >= pendingCount) {
        const commandsMetadataLength = commands.reduce((sum, command) => {
          const commandMetadataLength =
            command.name.length +
            (command.description ?? '').length +
            (command.argumentHint ?? '').length
          return sum + commandMetadataLength
        }, 0)
        logEvent('tengu_mcp_tools_commands_loaded', {
          tools_count: tools.length,
          commands_count: commands.length,
          commands_metadata_length: commandsMetadataLength,
        })

        void resolve({
          clients,
          tools,
          commands,
        })
      }
    }, mcpConfigs).catch(error => {
      logMCPError(
        'prefetchAllMcpResources',
        `Failed to get MCP resources: ${errorMessage(error)}`,
      )
      // Still resolve with empty results
      void resolve({
        clients: [],
        tools: [],
        commands: [],
      })
    })
  })
}

/**
 * Transform result content from an MCP tool or MCP prompt into message blocks
 */
export async function transformResultContent(
  resultContent: PromptMessage['content'],
  serverName: string,
): Promise<Array<ContentBlockParam>> {
  switch (resultContent.type) {
    case 'text':
      return [
        {
          type: 'text',
          text: resultContent.text,
        },
      ]
    case 'audio': {
      const audioData = resultContent as {
        type: 'audio'
        data: string
        mimeType?: string
      }
      return await persistBlobToTextBlock(
        Buffer.from(audioData.data, 'base64'),
        audioData.mimeType,
        serverName,
        `[Audio from ${serverName}] `,
      )
    }
    case 'image': {
      // Resize and compress image data, enforcing API dimension limits
      const imageBuffer = Buffer.from(String(resultContent.data), 'base64')
      const ext = resultContent.mimeType?.split('/')[1] || 'png'
      const resized = await maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        ext,
      )
      return [
        {
          type: 'image',
          source: {
            data: resized.buffer.toString('base64'),
            media_type:
              `image/${resized.mediaType}` as Base64ImageSource['media_type'],
            type: 'base64',
          },
        },
      ]
    }
    case 'resource': {
      const resource = resultContent.resource
      const prefix = `[Resource from ${serverName} at ${resource.uri}] `

      if ('text' in resource) {
        return [
          {
            type: 'text',
            text: `${prefix}${resource.text}`,
          },
        ]
      } else if ('blob' in resource) {
        const isImage = IMAGE_MIME_TYPES.has(resource.mimeType ?? '')

        if (isImage) {
          // Resize and compress image blob, enforcing API dimension limits
          const imageBuffer = Buffer.from(resource.blob, 'base64')
          const ext = resource.mimeType?.split('/')[1] || 'png'
          const resized = await maybeResizeAndDownsampleImageBuffer(
            imageBuffer,
            imageBuffer.length,
            ext,
          )
          const content: MessageParam['content'] = []
          if (prefix) {
            content.push({
              type: 'text',
              text: prefix,
            })
          }
          content.push({
            type: 'image',
            source: {
              data: resized.buffer.toString('base64'),
              media_type:
                `image/${resized.mediaType}` as Base64ImageSource['media_type'],
              type: 'base64',
            },
          })
          return content
        } else {
          return await persistBlobToTextBlock(
            Buffer.from(resource.blob, 'base64'),
            resource.mimeType,
            serverName,
            prefix,
          )
        }
      }
      return []
    }
    case 'resource_link': {
      const resourceLink = resultContent as ResourceLink
      let text = `[Resource link: ${resourceLink.name}] ${resourceLink.uri}`
      if (resourceLink.description) {
        text += ` (${resourceLink.description})`
      }
      return [
        {
          type: 'text',
          text,
        },
      ]
    }
    default:
      return []
  }
}

/**
 * Decode base64 binary content, write it to disk with the proper extension,
 * and return a small text block with the file path. Replaces the old behavior
 * of dumping raw base64 into the context.
 */
async function persistBlobToTextBlock(
  bytes: Buffer,
  mimeType: string | undefined,
  serverName: string,
  sourceDescription: string,
): Promise<Array<ContentBlockParam>> {
  const persistId = `mcp-${normalizeNameForMCP(serverName)}-blob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const result = await persistBinaryContent(bytes, mimeType, persistId)

  if ('error' in result) {
    return [
      {
        type: 'text',
        text: `${sourceDescription}Binary content (${mimeType || 'unknown type'}, ${bytes.length} bytes) could not be saved to disk: ${result.error}`,
      },
    ]
  }

  return [
    {
      type: 'text',
      text: getBinaryBlobSavedMessage(
        result.filepath,
        mimeType,
        result.size,
        sourceDescription,
      ),
    },
  ]
}

/**
 * Processes MCP tool result into a normalized format.
 */
export type MCPResultType = 'toolResult' | 'structuredContent' | 'contentArray'

export type TransformedMCPResult = {
  content: MCPToolResult
  type: MCPResultType
  schema?: string
}

/**
 * Generates a compact, jq-friendly type signature for a value.
 * e.g. "{title: string, items: [{id: number, name: string}]}"
 */
export function inferCompactSchema(value: unknown, depth = 2): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${inferCompactSchema(value[0], depth - 1)}]`
  }
  if (typeof value === 'object') {
    if (depth <= 0) return '{...}'
    const entries = Object.entries(value).slice(0, 10)
    const props = entries.map(
      ([k, v]) => `${k}: ${inferCompactSchema(v, depth - 1)}`,
    )
    const suffix = Object.keys(value).length > 10 ? ', ...' : ''
    return `{${props.join(', ')}${suffix}}`
  }
  return typeof value
}

export async function transformMCPResult(
  result: unknown,
  tool: string, // Tool name for validation (e.g., "search")
  name: string, // Server name for transformation (e.g., "slack")
): Promise<TransformedMCPResult> {
  if (result && typeof result === 'object') {
    if ('toolResult' in result) {
      return {
        content: String(result.toolResult),
        type: 'toolResult',
      }
    }

    if (
      'structuredContent' in result &&
      result.structuredContent !== undefined
    ) {
      return {
        content: jsonStringify(result.structuredContent),
        type: 'structuredContent',
        schema: inferCompactSchema(result.structuredContent),
      }
    }

    if ('content' in result && Array.isArray(result.content)) {
      const transformedContent = (
        await Promise.all(
          result.content.map(item => transformResultContent(item, name)),
        )
      ).flat()
      return {
        content: transformedContent,
        type: 'contentArray',
        schema: inferCompactSchema(transformedContent),
      }
    }
  }

  const errorMessage = `MCP server "${name}" tool "${tool}": unexpected response format`
  logMCPError(name, errorMessage)
  throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    errorMessage,
    'MCP tool unexpected response format',
  )
}

/**
 * CC 2.1.218 #5: classify a connection failure into the `errorCode` carried on
 * a `FailedMCPServer`. Returns a numeric HTTP status as a string ("401"),
 * "23" for a request timeout, or `undefined` when no classifiable code is
 * available. Mirrors the numeric branch of the binary's `TQo` extractor.
 */
export function extractMcpFailureErrorCode(error: unknown): string | undefined {
  if (!error) return undefined
  // 2.1.307 B1: the credential-store error carries its own stable string
  // code (official `FMt` transient classifier allowlists
  // "CREDENTIAL_STORE_UNAVAILABLE").
  if (error instanceof McpCredentialStoreUnavailableError) return error.code
  // StreamableHTTPError / fetch errors carry an HTTP status on `.code`.
  if (typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599) {
      return String(code)
    }
  }
  // OAuthError embeds the HTTP status in the message ("HTTP 401: …") when the
  // response body was unparseable (auth.ts:1298 note: SDK doesn't attach it).
  if (error instanceof Error) {
    const statusMatch = error.message.match(/^HTTP (\d{3}):/)
    if (statusMatch) return statusMatch[1]
    // Request timeout — the binary uses "23" for request-timed-out.
    if (/timed?\s*out|ETIMEDOUT|timeout/i.test(error.message)) return '23'
  }
  return undefined
}

/**
 * Check if MCP content contains any image blocks.
 * Used to decide whether to persist to file (images should use truncation instead
 * to preserve image compression and viewability).
 */
function contentContainsImages(content: MCPToolResult): boolean {
  if (!content || typeof content === 'string') {
    return false
  }
  return content.some(block => block.type === 'image')
}

/**
 * CC 2.1.217 #3 (A2): drop the full untruncated MCP tool result reference.
 *
 * `truncateMcpContent` returns a substring (`String.prototype.slice`) and new
 * text blocks whose `.text` is a sliced substring. V8 represents such a
 * substring as a `SlicedString` that shares the original (potentially huge)
 * string's backing character buffer — so as long as the truncated form is
 * held (in the conversation for the rest of the session), the full
 * untruncated result stays resident. This helper forces a fresh flat
 * allocation (Buffer round-trip) for every text string and rebuilds content
 * blocks as new objects, so the original full result and its buffer become
 * unreachable and can be GC'd.
 *
 * Matches the official 2.1.217 #3 fix: keep only the truncated form, drop the
 * reference to the full untruncated result.
 */
export function detachMcpToolResultContent(
  content: MCPToolResult,
): MCPToolResult {
  if (!content) return content
  if (typeof content === 'string') {
    // Buffer round-trip allocates a new string that does not share the
    // original SlicedString's backing store.
    return Buffer.from(content, 'utf8').toString('utf8')
  }
  // Rebuild the block array with fresh objects + flat-copied text so the
  // original blocks (and their sliced-text buffers) are not retained.
  return content.map(block => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return {
        ...block,
        text: Buffer.from(block.text, 'utf8').toString('utf8'),
      }
    }
    return { ...block }
  })
}

export async function processMCPResult(
  result: unknown,
  tool: string, // Tool name for validation (e.g., "search")
  name: string, // Server name for IDE check and transformation (e.g., "slack")
): Promise<MCPToolResult> {
  const { content, type, schema } = await transformMCPResult(result, tool, name)

  // IDE tools are not going to the model directly, so we don't need to
  // handle large output.
  if (name === 'ide') {
    return content
  }

  // Check if content needs truncation (i.e., is too large)
  if (!(await mcpContentNeedsTruncation(content))) {
    return content
  }

  const sizeEstimateTokens = getContentSizeEstimate(content)

  // If large output files feature is disabled, fall back to old truncation behavior
  if (isEnvDefinedFalsy(process.env.ENABLE_MCP_LARGE_OUTPUT_FILES)) {
    logEvent('tengu_mcp_large_result_handled', {
      outcome: 'truncated',
      reason: 'env_disabled',
      sizeEstimateTokens,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    // CC 2.1.217 #3: detach the truncated form so the full untruncated
    // result's backing buffer is not retained for the rest of the session.
    return detachMcpToolResultContent(
      await truncateMcpContentIfNeeded(content),
    )
  }

  // Save large output to file and return instructions for reading it
  // Content is guaranteed to exist at this point (we checked mcpContentNeedsTruncation)
  if (!content) {
    return content
  }

  // If content contains images, fall back to truncation - persisting images as JSON
  // defeats the image compression logic and makes them non-viewable
  if (contentContainsImages(content)) {
    logEvent('tengu_mcp_large_result_handled', {
      outcome: 'truncated',
      reason: 'contains_images',
      sizeEstimateTokens,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    // CC 2.1.217 #3: detach so the full untruncated result can be GC'd.
    return detachMcpToolResultContent(
      await truncateMcpContentIfNeeded(content),
    )
  }

  // Generate a unique ID for the persisted file (server__tool-timestamp)
  const timestamp = Date.now()
  const persistId = `mcp-${normalizeNameForMCP(name)}-${normalizeNameForMCP(tool)}-${timestamp}`
  // Convert to string for persistence (persistToolResult expects string or specific block types)
  const contentStr =
    typeof content === 'string' ? content : jsonStringify(content, null, 2)
  const persistResult = await persistToolResult(contentStr, persistId)

  if (isPersistError(persistResult)) {
    // If file save failed, fall back to returning truncated content info
    const contentLength = contentStr.length
    logEvent('tengu_mcp_large_result_handled', {
      outcome: 'truncated',
      reason: 'persist_failed',
      sizeEstimateTokens,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    return `Error: result (${contentLength.toLocaleString()} characters) exceeds maximum allowed tokens. Failed to save output to file: ${persistResult.error}. If this MCP server provides pagination or filtering tools, use them to retrieve specific portions of the data.`
  }

  logEvent('tengu_mcp_large_result_handled', {
    outcome: 'persisted',
    reason: 'file_saved',
    sizeEstimateTokens,
    persistedSizeChars: persistResult.originalSize,
  } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

  // CC 2.1.287 #29: compute the persisted content's line-shape stats ONLY for
  // plain-text results. Official gates the stats on `ie = type==="toolResult"
  // || unwrappedSingletonText !== undefined` and leaves them undefined for
  // JSON-persisted results, so the guidance says the file is JSON (Read's
  // offset/limit cannot split its one long line) instead of recommending
  // offset/limit paging. OCC has no singleton-text unwrap, so the gate is
  // `type === 'toolResult'`.
  const lineStats =
    type === 'toolResult' ? computePersistedLineStats(contentStr) : undefined

  const formatDescription = getFormatDescription(type, schema)
  return getLargeOutputInstructions(
    persistResult.filepath,
    persistResult.originalSize,
    formatDescription,
    undefined,
    lineStats,
  )
}

/**
 * Call an MCP tool, handling UrlElicitationRequiredError (-32042) by
 * displaying the URL elicitation to the user, waiting for the completion
 * notification, and retrying the tool call.
 */
type MCPToolCallResult = {
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}

/** @internal Exported for testing. */
export async function callMCPToolWithUrlElicitationRetry({
  client: connectedClient,
  clientConnection,
  tool,
  args,
  meta,
  signal,
  setAppState,
  onProgress,
  callToolFn = callMCPTool,
  handleElicitation,
}: {
  client: ConnectedMCPServer
  clientConnection: MCPServerConnection
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  setAppState: (f: (prev: AppState) => AppState) => void
  onProgress?: (data: MCPProgress) => void
  /** Injectable for testing. Defaults to callMCPTool. */
  callToolFn?: (opts: {
    client: ConnectedMCPServer
    tool: string
    args: Record<string, unknown>
    meta?: Record<string, unknown>
    signal: AbortSignal
    onProgress?: (data: MCPProgress) => void
  }) => Promise<MCPToolCallResult>
  /** Handler for URL elicitations when no hook handles them.
   * In print/SDK mode, delegates to structuredIO. In REPL, falls back to queue. */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
}): Promise<MCPToolCallResult> {
  const MAX_URL_ELICITATION_RETRIES = 3
  for (let attempt = 0; ; attempt++) {
    try {
      return await callToolFn({
        client: connectedClient,
        tool,
        args,
        meta,
        signal,
        onProgress,
      })
    } catch (error) {
      // The MCP SDK's Protocol creates plain McpError (not UrlElicitationRequiredError)
      // for error responses, so we check the error code instead of instanceof.
      if (
        !(error instanceof McpError) ||
        error.code !== ErrorCode.UrlElicitationRequired
      ) {
        throw error
      }

      // Limit the number of URL elicitation retries
      if (attempt >= MAX_URL_ELICITATION_RETRIES) {
        throw error
      }

      const errorData = error.data
      const rawElicitations =
        errorData != null &&
        typeof errorData === 'object' &&
        'elicitations' in errorData &&
        Array.isArray(errorData.elicitations)
          ? (errorData.elicitations as unknown[])
          : []

      // Validate each element has the required fields for ElicitRequestURLParams
      const elicitations = rawElicitations.filter(
        (e): e is ElicitRequestURLParams => {
          if (e == null || typeof e !== 'object') return false
          const obj = e as Record<string, unknown>
          return (
            obj.mode === 'url' &&
            typeof obj.url === 'string' &&
            typeof obj.elicitationId === 'string' &&
            typeof obj.message === 'string'
          )
        },
      )

      const serverName =
        clientConnection.type === 'connected'
          ? clientConnection.name
          : 'unknown'

      if (elicitations.length === 0) {
        logMCPDebug(
          serverName,
          `Tool '${tool}' returned -32042 but no valid elicitations in error data`,
        )
        throw error
      }

      logMCPDebug(
        serverName,
        `Tool '${tool}' requires URL elicitation (error -32042, attempt ${attempt + 1}), processing ${elicitations.length} elicitation(s)`,
      )

      // Process each URL elicitation from the error.
      // The completion notification handler (in registerElicitationHandler) sets
      // `completed: true` on the matching queue event; the dialog reacts to this flag.
      for (const elicitation of elicitations) {
        const { elicitationId } = elicitation

        // Run elicitation hooks — they can resolve URL elicitations programmatically
        const hookResponse = await runElicitationHooks(
          serverName,
          elicitation,
          signal,
        )
        if (hookResponse) {
          logMCPDebug(
            serverName,
            `URL elicitation ${elicitationId} resolved by hook: ${jsonStringify(hookResponse)}`,
          )
          if (hookResponse.action !== 'accept') {
            return {
              content: `URL elicitation was ${hookResponse.action === 'decline' ? 'declined' : hookResponse.action + 'ed'} by a hook. The tool "${tool}" could not complete because it requires the user to open a URL.`,
            }
          }
          // Hook accepted — skip the UI and proceed to retry
          continue
        }

        // Resolve the URL elicitation via callback (print/SDK mode) or queue (REPL mode).
        let userResult: ElicitResult
        if (handleElicitation) {
          // Print/SDK mode: delegate to structuredIO which sends a control request
          userResult = await handleElicitation(serverName, elicitation, signal)
        } else {
          // REPL mode: queue for ElicitationDialog with two-phase consent/waiting flow.
          // CC 2.1.288 (#80): this -32042 retry path ALWAYS carries an
          // elicitationId (validated above), so the official gate
          // `...e.mode==="url"&&r===void 0&&{userConfirmsCompletion:!0}`
          // (@234154439) leaves `userConfirmsCompletion` unset here — the
          // dialog keeps the " Accept  " label and the waiting phase driven by
          // onWaitingDismiss('retry').
          const waitingState: ElicitationWaitingState = {
            actionLabel: 'Retry now',
            showCancel: true,
          }
          userResult = await new Promise<ElicitResult>(resolve => {
            const onAbort = () => {
              void resolve({ action: 'cancel' })
            }
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })

            setAppState(prev => ({
              ...prev,
              elicitation: {
                queue: [
                  ...prev.elicitation.queue,
                  {
                    serverName,
                    requestId: `error-elicit-${elicitationId}`,
                    params: elicitation,
                    signal,
                    waitingState,
                    respond: result => {
                      // Phase 1 consent: accept is a no-op (doesn't resolve retry Promise)
                      if (result.action === 'accept') {
                        return
                      }
                      // Decline or cancel: resolve the retry Promise
                      signal.removeEventListener('abort', onAbort)
                      void resolve(result)
                    },
                    onWaitingDismiss: action => {
                      signal.removeEventListener('abort', onAbort)
                      if (action === 'retry') {
                        void resolve({ action: 'accept' })
                      } else {
                        void resolve({ action: 'cancel' })
                      }
                    },
                  },
                ],
              },
            }))
          })
        }

        // Run ElicitationResult hooks — they can modify or block the response
        const finalResult = await runElicitationResultHooks(
          serverName,
          userResult,
          signal,
          'url',
          elicitationId,
        )

        if (finalResult.action !== 'accept') {
          logMCPDebug(
            serverName,
            `User ${finalResult.action === 'decline' ? 'declined' : finalResult.action + 'ed'} URL elicitation ${elicitationId}`,
          )
          return {
            content: `URL elicitation was ${finalResult.action === 'decline' ? 'declined' : finalResult.action + 'ed'} by the user. The tool "${tool}" could not complete because it requires the user to open a URL.`,
          }
        }

        logMCPDebug(
          serverName,
          `Elicitation ${elicitationId} completed, retrying tool call`,
        )
      }

      // Loop back to retry the tool call
    }
  }
}

/**
 * CC 2.1.310 (#12) — official BIN310 constants region @243058412, verbatim:
 * `o8s` (question-unanswered arm, NEW in 310) and `cWr` (outcome-unknown arm,
 * pre-existing 309 baseline). Byte-verified via `grep -aboF` against the
 * 2.1.310 / 2.1.309 linux ELFs (o8s: 2/0 hits, cWr: 2/2 hits).
 */
export const MCP_QUESTION_UNANSWERED_MSG =
  "The server asked the user a question, and no answer came before the time limit. Do not call this tool again in this turn. Tell the user that the server's question got no answer, and wait for their reply."
export const MCP_OUTCOME_UNKNOWN_MSG =
  'The outcome is unknown: the call may have finished, may still be running, or may never have started. Check what it did before you repeat it.'

/**
 * CC 2.1.310 (#12) — the tool-call timeout rejection composition, verbatim
 * from the official setTimeout callback (BIN310 dd @278877100+2400):
 *
 *   let At=`MCP server "${Tt}" tool "${lt}" timed out after
 *           ${Math.floor(Ut/1000)}s`,
 *       Bt=$t.size>0,                     // in-flight sends for this call
 *       dt=(rt.openQuestions??0)>0,       // server question still open
 *       zt=[...dt?[o8s]:[],...Bt?[cWr]:[]];
 *   ft(Object.assign(new R(zt.length>0?`${At}. ${zt.join(" ")}`:At,
 *       "MCP tool timeout",Bt?BJn:dt?s8s:void 0),
 *       {mcpErrorSource:"downstream_unreachable"}))
 *
 * `$t` is officially the watchdog's own in-flight-sends Map (`Fe`, fed by the
 * requestSent/requestTaken/requestAnswered/requestNotRun answer-tracking
 * callbacks — a 309-era subsystem OCC has not ported). OCC's faithful analog
 * from the 2.1.307 B3 send tracking: a send is still in flight (outcome
 * unknown) when it was started and NOT definitively ran-nothing, i.e.
 * `ownSends.started > ownSends.ranNothing`.
 *
 * The official 3rd ctor arg lands on `this.errorClass` (official `R` class:
 * `constructor(n,e,t){...this.errorClass=t}`); OCC's TelemetrySafeError
 * (src/utils/errors.ts — outside this WP's file scope) has a 2-arg ctor, so
 * `errorClass` rides the same `Object.assign` as `mcpErrorSource`. Observable
 * shape is identical (undefined is assigned when neither arm fires, matching
 * the official `void 0`).
 */
export function buildMcpToolTimeoutRejection(
  name: string,
  tool: string,
  timeoutMs: number,
  watchdog: ToolCallWatchdog,
): TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS & {
  errorClass: string | undefined
  mcpErrorSource: string
} {
  const base = `MCP server "${name}" tool "${tool}" timed out after ${Math.floor(timeoutMs / 1000)}s`
  const hasInFlight =
    (watchdog.ownSends?.started ?? 0) > (watchdog.ownSends?.ranNothing ?? 0)
  const openQuestion = (watchdog.openQuestions ?? 0) > 0
  const parts = [
    ...(openQuestion ? [MCP_QUESTION_UNANSWERED_MSG] : []),
    ...(hasInFlight ? [MCP_OUTCOME_UNKNOWN_MSG] : []),
  ]
  const error =
    new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      parts.length > 0 ? `${base}. ${parts.join(' ')}` : base,
      'MCP tool timeout',
    )
  return Object.assign(error, {
    errorClass: hasInFlight
      ? 'mcp_call_unanswered'
      : openQuestion
        ? 'mcp_question_unanswered'
        : undefined,
    mcpErrorSource: 'downstream_unreachable',
  })
}

async function callMCPTool({
  client: { client, name, config, connectionState, transport },
  tool,
  args,
  meta,
  signal,
  onProgress,
}: {
  client: ConnectedMCPServer
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  onProgress?: (data: MCPProgress) => void
}): Promise<{
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}> {
  const toolStartTime = Date.now()
  let progressInterval: NodeJS.Timeout | undefined

  // 2.1.307 B3: official call-entry capture (`zt`, byte-verified):
  // `Pe=ae.transport?.sessionId===void 0` (staleness probe), watchdog
  // `Z={armedAt:0,offCriticalPath:C,toolUseId:...,ownSends:{started:0,
  // ranNothing:0}}` added to `fe.activeCallWatchdogs`, and the send-tracker
  // baseline `xe=ue?.toolCallSends?.started`. (OCC has no watchdog timer /
  // off-critical-path concept — armedAt stays 0, offCriticalPath false.)
  const sessionIdWasUndefined = transport?.sessionId === undefined
  const toolUseIdMeta = meta?.['claudecode/toolUseId']
  const callWatchdog: ToolCallWatchdog = {
    armedAt: 0,
    offCriticalPath: false,
    toolUseId: typeof toolUseIdMeta === 'string' ? toolUseIdMeta : undefined,
    ownSends: { started: 0, ranNothing: 0 },
  }
  connectionState?.activeCallWatchdogs.add(callWatchdog)
  const baselineSendsStarted = connectionState?.toolCallSends?.started

  try {
    logMCPDebug(name, `Calling MCP tool: ${tool}`)

    // Set up progress logging for long-running tools (every 30 seconds)
    progressInterval = setInterval(
      (startTime, name, tool) => {
        const elapsed = Date.now() - startTime
        const elapsedSeconds = Math.floor(elapsed / 1000)
        const duration = `${elapsedSeconds}s`
        logMCPDebug(name, `Tool '${tool}' still running (${duration} elapsed)`)
      },
      30000, // Log every 30 seconds
      toolStartTime,
      name,
      tool,
    )

    // Use Promise.race with our own timeout to handle cases where SDK's
    // internal timeout doesn't work (e.g., SSE stream breaks mid-request)
    // 2.1.206: per-server request_timeout_ms (if set) overrides the default
    // tool-call timeout, so a configured server honors its own limit. Falls
    // back to the env/default (MCP_TOOL_TIMEOUT or ~27.8h).
    const timeoutMs =
      getServerRequestTimeoutMs(config) ?? getMcpToolTimeoutMs()
    let timeoutId: NodeJS.Timeout | undefined

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        // CC 2.1.310 (#12): official passes (reject, server, tool, timeoutMs,
        // inFlightSends, watchdog) into the callback and composes the
        // two-arm rejection — see buildMcpToolTimeoutRejection.
        (reject, name, tool, timeoutMs, watchdog) => {
          reject(buildMcpToolTimeoutRejection(name, tool, timeoutMs, watchdog))
        },
        timeoutMs,
        reject,
        name,
        tool,
        timeoutMs,
        callWatchdog,
      )
    })

    const result = await Promise.race([
      client.callTool(
        {
          name: tool,
          arguments: args,
          _meta: meta,
        },
        CallToolResultSchema,
        {
          signal,
          timeout: timeoutMs,
          onprogress: onProgress
            ? sdkProgress => {
                onProgress({
                  type: 'mcp_progress',
                  status: 'progress',
                  serverName: name,
                  toolName: tool,
                  progress: sdkProgress.progress,
                  total: sdkProgress.total,
                  progressMessage: sdkProgress.message,
                })
              }
            : undefined,
        },
      ),
      timeoutPromise,
    ]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    })

    if ('isError' in result && result.isError) {
      let errorDetails = 'Unknown error'
      if (
        'content' in result &&
        Array.isArray(result.content) &&
        result.content.length > 0
      ) {
        const firstContent = result.content[0]
        if (
          firstContent &&
          typeof firstContent === 'object' &&
          'text' in firstContent
        ) {
          errorDetails = firstContent.text
        }
      } else if ('error' in result) {
        // Fallback for legacy error format
        errorDetails = String(result.error)
      }
      logMCPError(name, errorDetails)
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        errorDetails,
        'MCP tool returned error',
        '_meta' in result && result._meta ? { _meta: result._meta } : undefined,
      )
    }
    const elapsed = Date.now() - toolStartTime
    const duration =
      elapsed < 1000
        ? `${elapsed}ms`
        : elapsed < 60000
          ? `${Math.floor(elapsed / 1000)}s`
          : `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`

    logMCPDebug(name, `Tool '${tool}' completed successfully in ${duration}`)

    // Log code indexing tool usage
    const codeIndexingTool = detectCodeIndexingFromMcpServerName(name)
    if (codeIndexingTool) {
      logEvent('tengu_code_indexing_tool_used', {
        tool: codeIndexingTool as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        source:
          'mcp' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: true,
      })
    }

    const content = await processMCPResult(result, tool, name)
    return {
      content,
      _meta: result._meta as Record<string, unknown> | undefined,
      structuredContent: result.structuredContent as
        | Record<string, unknown>
        | undefined,
    }
  } catch (e) {
    // Clear intervals on error
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }

    const elapsed = Date.now() - toolStartTime

    if (e instanceof Error && e.name !== 'AbortError') {
      logMCPDebug(
        name,
        `Tool '${tool}' failed after ${Math.floor(elapsed / 1000)}s: ${e.message}`,
      )
    }

    // Check for 401 errors indicating expired/invalid OAuth tokens
    // The MCP SDK's StreamableHTTPError has a `code` property with the HTTP status
    if (e instanceof Error) {
      const errorCode = 'code' in e ? (e.code as number | undefined) : undefined
      if (errorCode === 401 || e instanceof UnauthorizedError) {
        logMCPDebug(
          name,
          `Tool call returned 401 Unauthorized - token may have expired`,
        )
        logEvent('tengu_mcp_tool_call_auth_error', {})
        throw new McpAuthError(
          name,
          `MCP server "${name}" requires re-authorization (token expired)`,
        )
      }

      // Check for session expiry — two error shapes can surface here:
      // 1. Direct 404 + JSON-RPC -32001 from the server (StreamableHTTPError)
      // 2. -32000 "Connection closed" (McpError) — the SDK closes the transport
      //    after the onerror handler fires, so the pending callTool() rejects
      //    with this derived error instead of the original 404.
      // In both cases, clear the connection cache so the next tool call
      // creates a fresh session.
      // 2.1.307 B3: official stale-session gate —
      // `ee=!(H.type==="http"&&_e===404&&Pe)&&so(G)`: a 404 session-not-found
      // on an http connection that NEVER had a session id is the server
      // refusing a fresh session (classified via closeReason below), not a
      // stale session.
      const httpErrorCode =
        'code' in e ? (e as Error & { code?: number }).code : undefined
      const isStaleSession =
        !(
          config.type === 'http' &&
          httpErrorCode === 404 &&
          sessionIdWasUndefined
        ) && isMcpSessionExpiredError(e)
      const isConnectionClosedOnHttp =
        'code' in e &&
        (e as Error & { code?: number }).code === -32000 &&
        e.message.includes('Connection closed') &&
        (config.type === 'http' || config.type === 'claudeai-proxy')
      if (isStaleSession || isConnectionClosedOnHttp) {
        // Official log — `(${ee?"stale session":"connection closed"})`.
        logMCPDebug(
          name,
          `MCP session expired during tool call (${isStaleSession ? 'stale session' : 'connection closed'}), clearing connection cache for re-initialization`,
        )
        logEvent('tengu_mcp_session_expired', {})
        await clearServerCache(name, config)
        // Official: `let te=oNn(ue?.toolCallSends,xe,Z.ownSends);
        //   throw new SO(q,<kind chain>)` — the send-tracking verdict picks
        // between call-refused / call-not-run / may-have-run kinds, which
        // decide whether the retry gate may re-run the tool.
        const ranNothing = allSendsRanNothing(
          connectionState?.toolCallSends,
          baselineSendsStarted,
          callWatchdog.ownSends,
        )
        throw new McpSessionExpiredError(
          name,
          classifySessionExpiryKind({
            isStaleSession,
            closeReason: connectionState?.closeReason,
            ranNothing,
            sessionIdWasUndefined,
          }),
        )
      }
    }

    // When the users hits esc, avoid logspew
    if (!(e instanceof Error) || e.name !== 'AbortError') {
      throw e
    }
    return { content: undefined }
  } finally {
    // Always clear intervals
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }
    // 2.1.307 B3: disarm the call watchdog so the send tracker no longer
    // attributes sends to this (finished) call.
    connectionState?.activeCallWatchdogs.delete(callWatchdog)
  }
}

function extractToolUseId(message: AssistantMessage): string | undefined {
  const firstBlock = (message.message.content as ContentBlockParam[] | undefined)?.[0]
  if (!firstBlock || typeof firstBlock === 'string' || firstBlock.type !== 'tool_use') {
    return undefined
  }
  return firstBlock.id
}

/**
 * Sets up SDK MCP clients by creating transports and connecting them.
 * This is used for SDK MCP servers that run in the same process as the SDK.
 *
 * @param sdkMcpConfigs - The SDK MCP server configurations
 * @param sendMcpMessage - Callback to send MCP messages through the control channel
 * @returns Connected clients, their tools, and transport map for message routing
 */
export async function setupSdkMcpClients(
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  sendMcpMessage: (
    serverName: string,
    message: JSONRPCMessage,
  ) => Promise<JSONRPCMessage>,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tool[]
}> {
  const clients: MCPServerConnection[] = []
  const tools: Tool[] = []

  // Connect to all servers in parallel
  const results = await Promise.allSettled(
    Object.entries(sdkMcpConfigs).map(async ([name, config]) => {
      const transport = new SdkControlClientTransport(name, sendMcpMessage)

      const client = new Client(
        {
          name: 'claude-code',
          title: 'Claude Code',
          version: MACRO.VERSION ?? 'unknown',
          description: "Anthropic's agentic coding tool",
          websiteUrl: PRODUCT_URL,
        },
        {
          capabilities: {},
        },
      )

      try {
        // Connect the client
        await client.connect(transport)

        // Get capabilities from the server
        const capabilities = client.getServerCapabilities()

        // Create the connected client object
        const connectedClient: MCPServerConnection = {
          type: 'connected',
          name,
          capabilities: capabilities || {},
          client,
          config: { ...config, scope: 'dynamic' as const },
          cleanup: async () => {
            await client.close()
          },
        }

        // Fetch tools if the server has them
        const serverTools: Tool[] = []
        if (capabilities?.tools) {
          try {
            const sdkTools = await fetchToolsForClient(connectedClient)
            serverTools.push(...sdkTools)
          } catch (toolsError) {
            // 2.1.132: tools/list failed but the server is connected — mark it
            // so /mcp shows "connected · tools fetch failed" instead of failing
            // the whole connection.
            logMCPError(name, `tools fetch failed: ${toolsError}`)
            ;(connectedClient as ConnectedMCPServer).toolsFetchError =
              toolsError instanceof Error
                ? toolsError.message
                : String(toolsError)
          }
        }

        return {
          client: connectedClient,
          tools: serverTools,
        }
      } catch (error) {
        // If connection fails, return failed server
        logMCPError(name, `Failed to connect SDK MCP server: ${error}`)
        return {
          client: {
            type: 'failed' as const,
            name,
            config: { ...config, scope: 'user' as const },
          },
          tools: [],
        }
      }
    }),
  )

  // Process results and collect clients and tools
  for (const result of results) {
    if (result.status === 'fulfilled') {
      clients.push(result.value.client)
      tools.push(...result.value.tools)
    }
    // If rejected (unexpected), the error was already logged inside the promise
  }

  return { clients, tools }
}
