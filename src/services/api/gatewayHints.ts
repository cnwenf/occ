/**
 * Gateway hint headers — official Claude Code 2.1.273 (byte-verified port).
 *
 * The official binary gained a "gateway hints" subsystem: a small set of
 * request headers that tell the first-party gateway (and, behind the
 * CLAUDE_CODE_GATEWAY_HINT_HEADERS env tri-bool, any endpoint) about
 * compaction state and per-tool durations, so server-side caching/routing
 * can react without inspecting the request body.
 *
 * Official symbols → OCC symbols (all logic recovered verbatim from the
 * 2.1.273 linux-x64 ELF):
 *   Lsr → CONTEXT_COMPACTED_GATEWAY_HEADER   ("x-cc-context-compacted")
 *   Fsr → COMPACTION_REQUEST_GATEWAY_HEADER  ("x-cc-compaction-request")
 *   $sr → COMPACTION_HEADER                  ("x-claude-code-compaction")
 *   Bsr → CONTEXT_COMPACTED_HEADER           ("x-claude-code-context-compacted")
 *   Usr → PREV_TOOL_DURATIONS_HEADER         ("x-claude-code-prev-tool-durations")
 *   spn → REQUEST_CLASS_HEADER               ("x-claude-code-request-class")
 *   ipn → AGENT_TYPE_HEADER                  ("x-claude-code-agent-type")
 *   eCs → MAX_TOOL_DURATION_ENTRIES (32), tCs → MAX_TOOL_DURATION_HEADER_BYTES (4096)
 *   WG  → BUILTIN_AGENT_QUERY_SOURCE_PREFIX ("agent:builtin:")
 *   Tle → isGatewayHintHeadersEnabled, fl → isFirstPartyAnthropicGateway
 *   dar → applyContextCompactedHeaders, far → applyPrevToolDurationsHeader
 *   Hsr → buildPrevToolDurationsHeader, nCs → sanitizeToolNameForHeader
 *   Fg  → toWellFormedString, afn → sanitizeHeaderValue
 *   ii  → classifyQuerySource, _fe → isMainThreadQuerySource
 *   YF  → shouldSendContextCompactedHeader (XF ≡ false in the binary)
 *   MLr → getRequestClassHeader, DLr → getAgentTypeHeader
 *   gkt → getCompactionKind
 *   I_t/kZn/AZn → arm/consume/forgetPendingContextCompacted
 *
 * Deviations (documented, no invented behavior):
 * - OCC has no Statsig: the official gate's final branch
 *   `return P("tengu_splendid_sutton", !1)` collapses to its default (false),
 *   exactly as every other gated feature in OCC.
 * - The official MLr/DLr read `n.agentType` from an always-present
 *   agentContext param; OCC's ALS getAgentContext() returns undefined on the
 *   main thread, so reads use optional chaining. Observable behavior is
 *   identical: the main thread never has agentType 'subagent'/'teammate'.
 * - The official sessionFlags store is per-session; OCC uses a module-level
 *   variable, matching the single-session-per-process CLI model (same as
 *   bootstrap/state.ts singletons).
 */

import type { AgentContext } from 'src/utils/agentContext.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/utils/envUtils.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from 'src/utils/model/providers.js'

// ---------------------------------------------------------------------------
// Header names + limits (official constants, verbatim values)
// ---------------------------------------------------------------------------

/** Official `Lsr` — gateway-only twin of CONTEXT_COMPACTED_HEADER. */
export const CONTEXT_COMPACTED_GATEWAY_HEADER = 'x-cc-context-compacted'
/** Official `Fsr` — gateway-only twin of COMPACTION_HEADER. */
export const COMPACTION_REQUEST_GATEWAY_HEADER = 'x-cc-compaction-request'
/** Official `$sr` — sent on the compaction request itself (gate-enabled). */
export const COMPACTION_HEADER = 'x-claude-code-compaction'
/** Official `Bsr` — sent on the first main request after a compaction. */
export const CONTEXT_COMPACTED_HEADER = 'x-claude-code-context-compacted'
/** Official `Usr` — previous turn's per-tool durations. */
export const PREV_TOOL_DURATIONS_HEADER = 'x-claude-code-prev-tool-durations'
/** Official `spn` — request classification (main/subagent/auxiliary/...). */
export const REQUEST_CLASS_HEADER = 'x-claude-code-request-class'
/** Official `ipn` — agent type / builtin agent name / 'custom' / 'teammate'. */
export const AGENT_TYPE_HEADER = 'x-claude-code-agent-type'

/** Official `eCs` — max tool-duration entries in the header. */
export const MAX_TOOL_DURATION_ENTRIES = 32
/** Official `tCs` — max header value length (sum of entries + separators). */
export const MAX_TOOL_DURATION_HEADER_BYTES = 4096
/** Official `WG` — querySource prefix for builtin agents. */
export const BUILTIN_AGENT_QUERY_SOURCE_PREFIX = 'agent:builtin:'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Official `{toolName, durationMs}` pair produced per completed tool. */
export type ToolDurationEntry = {
  toolName: string
  durationMs: number
}

/**
 * Official compaction kind wire values. `gkt(trigger, thresholdOrRequestId)`:
 * manual → 'manual'; auto with the second arg defined → 'auto'; auto without
 * → 'reactive'.
 */
export type CompactionRequestKind = 'manual' | 'auto' | 'reactive'

/** Official `ii()` return — request classification for REQUEST_CLASS_HEADER. */
export type QuerySourceClass = 'main' | 'subagent' | 'auxiliary'

// ---------------------------------------------------------------------------
// Gate (official Tle / fl)
// ---------------------------------------------------------------------------

/**
 * Official `fl()`: `return Pe()==="firstParty"&&Ko()` — first-party provider
 * AND the default api.anthropic.com base URL (Ko→IS→xw chain). Same predicate
 * OCC already uses for client-request-id injection (client.ts buildFetch).
 */
export function isFirstPartyAnthropicGateway(): boolean {
  return getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
}

/**
 * Official `Tle()`:
 *   let e = env.CLAUDE_CODE_GATEWAY_HINT_HEADERS   // O.triBool() parsed
 *   if (e !== undefined) return e
 *   if (fl()) return true
 *   if (Pe() !== "firstParty") return false
 *   return P("tengu_splendid_sutton", false)       // Statsig → false in OCC
 */
export function isGatewayHintHeadersEnabled(): boolean {
  const envOverride = parseTriBool(
    process.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS,
  )
  if (envOverride !== undefined) {
    return envOverride
  }
  if (isFirstPartyAnthropicGateway()) {
    return true
  }
  if (getAPIProvider() !== 'firstParty') {
    return false
  }
  // Official: Statsig gate default false. OCC has no Statsig → default.
  return false
}

/**
 * Official triBool env parser (`m=(n)=>{if(Oe(n))return!0;if(Ao(n))return!1;return}`):
 * truthy strings → true, falsy strings → false, anything else → undefined
 * (fall through to the next gate branch).
 */
export function parseTriBool(
  value: string | boolean | undefined,
): boolean | undefined {
  if (value === undefined) {
    return undefined
  }
  if (isEnvTruthy(value)) {
    return true
  }
  if (isEnvDefinedFalsy(value)) {
    return false
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Value sanitizers (official Fg / nCs / afn)
// ---------------------------------------------------------------------------

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Official `Fg(e)`: String.prototype.toWellFormed with regex fallback. */
export function toWellFormedString(value: string): string {
  if (typeof String.prototype.toWellFormed === 'function') {
    return value.toWellFormed()
  }
  return value.replace(LONE_SURROGATE_RE, '�')
}

/**
 * Official `nCs(e)`: `Fg(e).replace(/%|[;=, ]|[^\x20-\x7e]/gu, encodeURIComponent)`
 * — tool names go into a `name=ms;name=ms` header value, so the entry
 * separators (`;`, `=`, `,`, space), literal `%`, and non-ASCII/control
 * characters are percent-encoded.
 */
export function sanitizeToolNameForHeader(toolName: string): string {
  return toWellFormedString(toolName).replace(
    /%|[;=, ]|[^\x20-\x7e]/gu,
    encodeURIComponent,
  )
}

/**
 * Official `afn(e)`: `e.replace(/%|[^\x20-\x7e]/gu, encodeURIComponent)` —
 * generic header-value sanitizer (used for agent-type and agent-id values).
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/%|[^\x20-\x7e]/gu, encodeURIComponent)
}

// ---------------------------------------------------------------------------
// prev-tool-durations header (official Hsr)
// ---------------------------------------------------------------------------

/**
 * Official `Hsr(e)` verbatim: cap at `eCs` (32) entries, skip non-finite
 * durations, clamp+round to integer ms, and stop before the total value
 * length would exceed `tCs` (4096, separators counted). `undefined` when no
 * entry fits.
 */
export function buildPrevToolDurationsHeader(
  entries: readonly ToolDurationEntry[],
): string | undefined {
  const parts: string[] = []
  let length = 0
  for (const { toolName, durationMs } of entries) {
    if (parts.length >= MAX_TOOL_DURATION_ENTRIES) {
      break
    }
    if (!Number.isFinite(durationMs)) {
      continue
    }
    const ms = Math.max(0, Math.round(durationMs))
    const entry = `${sanitizeToolNameForHeader(toolName)}=${ms}`
    const separatorLength = parts.length > 0 ? 1 : 0
    if (length + separatorLength + entry.length > MAX_TOOL_DURATION_HEADER_BYTES) {
      break
    }
    length += separatorLength + entry.length
    parts.push(entry)
  }
  return parts.length > 0 ? parts.join(';') : undefined
}

// ---------------------------------------------------------------------------
// Query-source classification (official ii / _fe / YF / XF)
// ---------------------------------------------------------------------------

/**
 * Official `ii(e)` verbatim: undefined → undefined; repl_main_thread* / sdk →
 * 'main'; agent:* / hook_agent → 'subagent'; everything else → 'auxiliary'.
 */
export function classifyQuerySource(
  querySource: string | undefined,
): QuerySourceClass | undefined {
  if (querySource === undefined) {
    return undefined
  }
  if (querySource.startsWith('repl_main_thread') || querySource === 'sdk') {
    return 'main'
  }
  if (querySource.startsWith('agent:') || querySource === 'hook_agent') {
    return 'subagent'
  }
  return 'auxiliary'
}

/** Official `_fe(e)`: `return e===void 0||ii(e)==="main"`. */
export function isMainThreadQuerySource(querySource: string | undefined): boolean {
  return querySource === undefined || classifyQuerySource(querySource) === 'main'
}

/**
 * Official `YF(e,n,r)`: `return r===void 0&&_fe(e)&&!XF(e,n)` where
 * `XF(){return!1}` — so this reduces to agentId===undefined && main-thread
 * query source. The agentContext param is kept out of OCC's signature because
 * XF is constant-false in the shipped binary.
 */
export function shouldSendContextCompactedHeader(
  querySource: string | undefined,
  agentId: string | undefined,
): boolean {
  return agentId === undefined && isMainThreadQuerySource(querySource)
}

// ---------------------------------------------------------------------------
// Request-class / agent-type headers (official MLr / DLr)
// ---------------------------------------------------------------------------

/**
 * Official `MLr(e,n)`: undefined source → no header; 'compact' → 'compaction';
 * subagent running inside a workflow run → 'workflow'; else the `ii` class.
 * `n.agentType`/`n.workflowRunId` read with optional chaining (see file
 * header — OCC's ALS context is undefined on the main thread).
 */
export function getRequestClassHeader(
  querySource: string | undefined,
  agentContext: AgentContext | undefined,
): string | undefined {
  if (querySource === undefined) {
    return undefined
  }
  if (querySource === 'compact') {
    return 'compaction'
  }
  const querySourceClass = classifyQuerySource(querySource)
  if (
    querySourceClass === 'subagent' &&
    agentContext?.agentType === 'subagent' &&
    agentContext.workflowRunId
  ) {
    return 'workflow'
  }
  return querySourceClass
}

/**
 * Official `DLr(e,n)`: only for agent:* query sources; teammate context →
 * 'teammate'; `agent:builtin:<name>` → `<name>` (empty tail → undefined);
 * `agent:custom*` → 'custom'; else undefined.
 */
export function getAgentTypeHeader(
  querySource: string | undefined,
  agentContext: AgentContext | undefined,
): string | undefined {
  if (querySource === undefined || !querySource.startsWith('agent:')) {
    return undefined
  }
  if (agentContext?.agentType === 'teammate') {
    return 'teammate'
  }
  if (querySource.startsWith(BUILTIN_AGENT_QUERY_SOURCE_PREFIX)) {
    return (
      querySource.slice(BUILTIN_AGENT_QUERY_SOURCE_PREFIX.length) || undefined
    )
  }
  if (querySource.startsWith('agent:custom')) {
    return 'custom'
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Compaction kind (official gkt)
// ---------------------------------------------------------------------------

/**
 * Official `gkt(e,n)`: `return e==="manual"?"manual":n!==void 0?"auto":"reactive"`.
 * Used two ways in the binary:
 *  - compactionRequestKind for the compaction request itself:
 *    `gkt(trigger, thresholdSource)` — threshold-based auto compaction passes
 *    a defined thresholdSource ('auto'); the reactive/PTL path passes none
 *    ('reactive').
 *  - contextCompactedKind armed for the NEXT main request:
 *    `gkt(trigger, lastMainRequestId)` — an auto compaction that happens
 *    before any main-thread API response ('reactive') vs after ('auto').
 */
export function getCompactionKind(
  trigger: 'manual' | 'auto',
  definednessProbe: unknown,
): CompactionRequestKind {
  return trigger === 'manual'
    ? 'manual'
    : definednessProbe !== undefined
      ? 'auto'
      : 'reactive'
}

// ---------------------------------------------------------------------------
// Pending context-compacted store (official sessionFlags I_t / kZn / AZn)
// ---------------------------------------------------------------------------

let pendingContextCompacted: CompactionRequestKind | undefined

/** Official `I_t(e)` — armPendingContextCompacted. */
export function armPendingContextCompacted(
  kind: CompactionRequestKind,
): void {
  pendingContextCompacted = kind
}

/** Official `kZn()` — consumePendingContextCompacted (read + clear). */
export function consumePendingContextCompacted():
  | CompactionRequestKind
  | undefined {
  const kind = pendingContextCompacted
  pendingContextCompacted = undefined
  return kind
}

/** Official `AZn()` — forgetPendingContextCompacted (clear without send). */
export function forgetPendingContextCompacted(): void {
  pendingContextCompacted = undefined
}

// ---------------------------------------------------------------------------
// Header application (official dar / far)
// ---------------------------------------------------------------------------

/**
 * Official `dar(e,n,r)` verbatim: when either value is defined, set the
 * gateway-only twin (`x-cc-*`) if fl() (first-party gateway) and the
 * `x-claude-code-*` name if Tle() (gate enabled). Mutates the per-attempt
 * headers object, exactly like the official.
 */
export function applyContextCompactedHeaders(
  headers: Record<string, string>,
  contextCompactedKind: CompactionRequestKind | undefined,
  compactionRequestKind: CompactionRequestKind | undefined,
): void {
  if (contextCompactedKind === undefined && compactionRequestKind === undefined) {
    return
  }
  const firstPartyGateway = isFirstPartyAnthropicGateway()
  const hintsEnabled = isGatewayHintHeadersEnabled()
  if (contextCompactedKind !== undefined) {
    if (firstPartyGateway) {
      headers[CONTEXT_COMPACTED_GATEWAY_HEADER] = contextCompactedKind
    }
    if (hintsEnabled) {
      headers[CONTEXT_COMPACTED_HEADER] = contextCompactedKind
    }
  }
  if (compactionRequestKind !== undefined) {
    if (firstPartyGateway) {
      headers[COMPACTION_REQUEST_GATEWAY_HEADER] = compactionRequestKind
    }
    if (hintsEnabled) {
      headers[COMPACTION_HEADER] = compactionRequestKind
    }
  }
}

/** Official `far(e,n)` verbatim: gate-enabled → set the durations header. */
export function applyPrevToolDurationsHeader(
  headers: Record<string, string>,
  prevToolDurationsHeader: string | undefined,
): void {
  if (prevToolDurationsHeader !== undefined && isGatewayHintHeadersEnabled()) {
    headers[PREV_TOOL_DURATIONS_HEADER] = prevToolDurationsHeader
  }
}
