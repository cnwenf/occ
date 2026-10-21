/**
 * Tool Search utilities for dynamically discovering deferred tools.
 *
 * When enabled, deferred tools (MCP and shouldDefer tools) are sent with
 * defer_loading: true and discovered via ToolSearchTool rather than being
 * loaded upfront.
 */

import { APIError } from '@anthropic-ai/sdk'
import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { isAPIErrorBodyType } from '../services/api/modelCallRetries.js'
import type { Tool } from '../Tool.js'
import {
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../tools/ToolSearchTool/prompt.js'
import type { Message } from '../types/message.js'
import {
  countToolDefinitionTokens,
  TOOL_TOKEN_COUNT_OVERHEAD,
} from './analyzeContext.js'
import { count } from './array.js'
import { getAnthropicApiKey, getAuthTokenSource } from './auth.js'
import { getMergedBetas, getToolSearchBetaHeader } from './betas.js'
import { getContextWindowForModel } from './context.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { logError } from './log.js'
import { getAPIProvider, getAPIProviderForStatsig } from './model/providers.js'
import { jsonStringify } from './slowOperations.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

/**
 * Default percentage of context window at which to auto-enable tool search.
 * When MCP tool descriptions exceed this percentage (in tokens), tool search is enabled.
 * Can be overridden via ENABLE_TOOL_SEARCH=auto:N where N is 0-100.
 */
const DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10 // 10%

/**
 * Parse auto:N syntax from ENABLE_TOOL_SEARCH env var.
 * Returns the percentage clamped to 0-100, or null if not auto:N format or not a number.
 */
function parseAutoPercentage(value: string): number | null {
  if (!value.startsWith('auto:')) return null

  const percentStr = value.slice(5)
  const percent = parseInt(percentStr, 10)

  if (isNaN(percent)) {
    logForDebugging(
      `Invalid ENABLE_TOOL_SEARCH value "${value}": expected auto:N where N is a number.`,
    )
    return null
  }

  // Clamp to valid range
  return Math.max(0, Math.min(100, percent))
}

/**
 * Check if ENABLE_TOOL_SEARCH is set to auto mode (auto or auto:N).
 */
function isAutoToolSearchMode(value: string | undefined): boolean {
  if (!value) return false
  return value === 'auto' || value.startsWith('auto:')
}

/**
 * Get the auto-enable percentage from env var or default.
 */
function getAutoToolSearchPercentage(): number {
  const value = process.env.ENABLE_TOOL_SEARCH
  if (!value) return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE

  if (value === 'auto') return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE

  const parsed = parseAutoPercentage(value)
  if (parsed !== null) return parsed

  return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE
}

/**
 * Approximate chars per token for MCP tool definitions (name + description + input schema).
 * Used as fallback when the token counting API is unavailable.
 */
const CHARS_PER_TOKEN = 2.5

/**
 * Get the token threshold for auto-enabling tool search for a given model.
 */
function getAutoToolSearchTokenThreshold(model: string): number {
  const betas = getMergedBetas(model)
  const contextWindow = getContextWindowForModel(model, betas)
  const percentage = getAutoToolSearchPercentage() / 100
  return Math.floor(contextWindow * percentage)
}

/**
 * Get the character threshold for auto-enabling tool search for a given model.
 * Used as fallback when the token counting API is unavailable.
 */
export function getAutoToolSearchCharThreshold(model: string): number {
  return Math.floor(getAutoToolSearchTokenThreshold(model) * CHARS_PER_TOKEN)
}

/**
 * Get the total token count for all deferred tools using the token counting API.
 * Memoized by deferred tool names — cache is invalidated when MCP servers connect/disconnect.
 * Returns null if the API is unavailable (caller should fall back to char heuristic).
 */
const getDeferredToolTokenCount = memoize(
  async (
    tools: Tools,
    getToolPermissionContext: () => Promise<ToolPermissionContext>,
    agents: AgentDefinition[],
    model: string,
  ): Promise<number | null> => {
    const deferredTools = tools.filter(t => isDeferredTool(t))
    if (deferredTools.length === 0) return 0

    try {
      const total = await countToolDefinitionTokens(
        deferredTools,
        getToolPermissionContext,
        { activeAgents: agents, allAgents: agents },
        model,
      )
      if (total === 0) return null // API unavailable
      return Math.max(0, total - TOOL_TOKEN_COUNT_OVERHEAD)
    } catch {
      return null // Fall back to char heuristic
    }
  },
  (tools: Tools) =>
    tools
      .filter(t => isDeferredTool(t))
      .map(t => t.name)
      .join(','),
)

/**
 * Tool search mode. Determines how deferrable tools (MCP + shouldDefer) are
 * surfaced:
 *   - 'tst': Tool Search Tool — deferred tools discovered via ToolSearchTool (always enabled)
 *   - 'tst-auto': auto — tools deferred only when they exceed threshold
 *   - 'standard': tool search disabled — all tools exposed inline
 */
export type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'

/**
 * Determines the tool search mode from ENABLE_TOOL_SEARCH.
 *
 *   ENABLE_TOOL_SEARCH    Mode
 *   auto / auto:1-99      tst-auto
 *   true / auto:0         tst
 *   false / auto:100      standard
 *   (unset)               tst (default: always defer MCP and shouldDefer tools)
 */
export function getToolSearchMode(): ToolSearchMode {
  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is a kill switch for beta API
  // features. Tool search emits defer_loading on tool definitions and
  // tool_reference content blocks — both require the API to accept a beta
  // header. When the kill switch is set, force 'standard' so no beta shapes
  // reach the wire, even if ENABLE_TOOL_SEARCH is also set. This is the
  // explicit escape hatch for proxy gateways that the heuristic in
  // isToolSearchEnabledOptimistic doesn't cover.
  // github.com/anthropics/claude-code/issues/20031
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return 'standard'
  }

  const value = process.env.ENABLE_TOOL_SEARCH

  // Handle auto:N syntax - check edge cases first
  const autoPercent = value ? parseAutoPercentage(value) : null
  if (autoPercent === 0) return 'tst' // auto:0 = always enabled
  if (autoPercent === 100) return 'standard'
  if (isAutoToolSearchMode(value)) {
    return 'tst-auto' // auto or auto:1-99
  }

  if (isEnvTruthy(value)) return 'tst'
  if (isEnvDefinedFalsy(process.env.ENABLE_TOOL_SEARCH)) return 'standard'
  return 'tst' // default: always defer MCP and shouldDefer tools
}

/**
 * Default patterns for models that do NOT support tool_reference.
 * New models are assumed to support tool_reference unless explicitly listed here.
 *
 * CC 2.1.295 changelog: "Fixed Claude 3 Opus and Claude 3.x Sonnet sessions
 * being offered tool search, which those models reject, where feature flags
 * are unavailable" — official binary verbatim:
 * `var Da=["claude-3-opus","claude-3-sonnet","claude-3-haiku"];
 *  function Bst(e){return!pPt(e??et(),Da)}`
 * where pPt is a substring-includes check (same semantics as
 * modelSupportsToolReference below). Note the substring semantics: e.g.
 * 'claude-3-5-sonnet' does NOT contain 'claude-3-sonnet', so 3.5 models stay
 * supported. OCC additionally keeps its pre-existing bare 'haiku' pattern
 * (OCC-conservative superset of the official list — documented deviation).
 */
const DEFAULT_UNSUPPORTED_MODEL_PATTERNS = [
  'haiku',
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
]

/**
 * Get the list of model patterns that do NOT support tool_reference.
 * Can be configured via GrowthBook for live updates without code changes.
 */
function getUnsupportedToolReferencePatterns(): string[] {
  try {
    // Try to get from GrowthBook for live configuration
    const patterns = getFeatureValue_CACHED_MAY_BE_STALE<string[] | null>(
      'tengu_tool_search_unsupported_models',
      null,
    )
    if (patterns && Array.isArray(patterns) && patterns.length > 0) {
      return patterns
    }
  } catch {
    // GrowthBook not ready, use defaults
  }
  return DEFAULT_UNSUPPORTED_MODEL_PATTERNS
}

// ---------------------------------------------------------------------------
// CC 2.1.306 (research-api.md #1/#2): tool-search refuse-recovery state
// machine — the FINAL v306 form, byte-verified from the official 2.1.306
// ELF (state machine @249522800; iSe cluster @248312563; Jmn @249494776;
// vf/Ff @238694176; sH/Cde @240979705/@240985860; MM/ch @245259380;
// _Eo @245260463; Nnn/eOs @245262243; nSe/GVe @248309267; GB @248317786;
// oM @248318728; vt @240811864; AA @238693262).
//
// The v304 form is REMOVED: the persisted `toolSearchRefusedAt` 1-day
// window (official `c`/`f`/`d`/`DUs`, `h`=86400000) and the custom-base-URL
// eligibility gate `zOe` have ZERO `toolSearchRefusedAt` string hits in the
// v306 binary (v304: 6). v306 recovery is per-request and one-shot via the
// retry run's rebuilt state (no persistence, no window, no `zOe`).
//
// Official pieces (minified → OCC):
//   UZ  → ToolSearchRefusedError   (the retry marker EF throws)
//   EF  → throwToolSearchRefused   (verbatim warn + throw)
//   Jmn → isTrueFirstParty
//   iSe/TQ/e5t/Mv/eOs/Nnn/MM/nSe/GB/oM/_Eo
//       → the isToolSearchBetaRefusalNamed classifier family
//   Ese (message-side conjuncts)
//       → isAnonymousToolSearchRefuseRecoveryEligible
//   L6 + Rse (named path) + N6 (anonymous path) orchestration
//       → the claude.ts retryToolSearchRefused handler (request-scoped
//         closure state Xo/Xp lives there)
//   hLe (body) → markToolSearchBetaHealed (the Cse one-shot latch and the
//         Q.toolSearchRefusal capture live in the claude.ts closure)
//   z_t() → getToolSearchBetaHeader() (betas.ts — the same 1P/3P header
//         split: jy()=aY()&&!u1() → advanced-tool-use-2025-11-20, else
//         tool-search-tool-2025-10-19)
//
// Chain-position equivalence: official wires Rse mid-chain and N6 LAST in
// the onApiError chain `ggt??fgt??hgt??igt??DO??Xj??OLe??xse??F6??N6` — the
// last position IS the official `!Fw(_r)&&!UF(_r)` expression (Fw/UF are the
// big ORs of every other recovery classifier; each maps to an earlier OCC
// withRetry handler or has no OCC surface). OCC keeps its single withRetry
// handler wired LAST (v304 shape), running the named check (Rse) first and
// the anonymous check (N6/Ese) second; the named tool-search-beta refusal
// texts match none of OCC's earlier handlers, so the ordering is
// behaviorally equivalent (documented deviation).
// ---------------------------------------------------------------------------

/**
 * Official `UZ` — the retry marker thrown by `EF` (throwToolSearchRefused).
 * The official `pgn` wrapper catches it and re-runs the API call with the
 * refusal captured (`Q.toolSearchRefusal = UZ.refusal`), which both feeds the
 * success-side heal (`hLe`) and makes the retry run one-shot (the official
 * rebuild gate `mo` requires `Q.toolSearchRefusal===void 0` — a second
 * refusal on the rebuilt request never re-enters recovery).
 */
export class ToolSearchRefusedError extends Error {
  /** The HTTP error that triggered the recovery (official `UZ.refusal`). */
  readonly refusal: APIError
  /** Official `declaredToolSearch` — the refused request declared tool search. */
  readonly declaredToolSearch: boolean

  constructor(refusal: APIError, declaredToolSearch: boolean) {
    super('tool search refused', { cause: refusal })
    this.refusal = refusal
    this.declaredToolSearch = declaredToolSearch
  }
}

/** Official `ch` — capability-rejected marker prefix inside API error text. */
const CAPABILITY_REJECTED_PREFIX = 'capability_rejected: '

/**
 * Official `MM` — does `message` contain `capability_rejected: ${token}` as a
 * whole token (the next character, if any, must not continue an identifier)?
 */
function findsCapabilityRejectedToken(message: string, token: string): boolean {
  const needle = `${CAPABILITY_REJECTED_PREFIX}${token}`
  let from = 0
  for (;;) {
    const at = message.indexOf(needle, from)
    if (at === -1) {
      return false
    }
    const after = message[at + needle.length]
    if (after === undefined || !/[A-Za-z0-9_:.-]/.test(after)) {
      return true
    }
    from = at + 1
  }
}

/**
 * Official `nSe` — the first line of the error's human-readable message,
 * preferring the structured body message and falling back to the flat
 * `.message` with any leading `NNN ` status prefix stripped.
 */
function getApiErrorFirstLine(error: APIError): string {
  const body = error.error as { error?: { message?: unknown } } | undefined
  const nested = body?.error?.message
  const text =
    typeof nested === 'string' ? nested : error.message.replace(/^\d{3} /, '')
  const newlineAt = text.indexOf('\n')
  return newlineAt === -1 ? text : text.slice(0, newlineAt)
}

/** Official `Nnn` — plain substring mention of the beta header. */
function mentionsBetaHeader(message: string, header: string): boolean {
  return message.includes(header) && /anthropic[-_]beta/.test(message)
}

/**
 * Official `eOs` — the message names the beta header either directly (`Nnn`)
 * or through a `capability_rejected: beta_header:<h>` token.
 */
function namesBetaRejected(message: string, header: string): boolean {
  return (
    mentionsBetaHeader(message, header) ||
    findsCapabilityRejectedToken(message, `beta_header:${header}`)
  )
}

/**
 * Official `e5t` — the "Unexpected value(s) `x`, `y` for the
 * `anthropic[-_]beta` header" first-line shape: the listed values include the
 * header, or the flat message carries the `beta_header:<h>` capability token.
 */
function namesBetaInUnexpectedValuesLine(
  error: APIError,
  header: string,
): boolean {
  const listed =
    /^Unexpected value\(s\) ((?:`[^`]+`(?:, )?)+) for the `anthropic[-_]beta`/.exec(
      getApiErrorFirstLine(error),
    )?.[1]
  return (
    listed?.includes(`\`${header}\``) === true ||
    findsCapabilityRejectedToken(error.message, `beta_header:${header}`)
  )
}

/**
 * Official `GB` — conversation-binding refusals (400s about messages not
 * created in this conversation / bound to a different one) look superficially
 * similar but are unrelated to the beta; excluded from tool-search recovery.
 */
function isConversationBindingRefusal(error: APIError): boolean {
  if (error.status !== 400) {
    return false
  }
  const lower = error.message.toLowerCase()
  return (
    lower.includes('not created in this conversation') ||
    lower.includes('bound to a different conversation')
  )
}

/** Official `_Eo` — thinking / redacted_thinking signature-problem texts. */
function mentionsThinkingSignatureProblem(message: string): boolean {
  const lower = message.toLowerCase().replaceAll('`', '')
  if (lower.includes('signature in thinking block')) {
    return true
  }
  if (lower.includes('invalid data in redacted_thinking block')) {
    return true
  }
  if (lower.includes('thinking.signature') && lower.includes('field required')) {
    return true
  }
  return (
    (lower.includes('thinking block') || lower.includes('redacted_thinking')) &&
    (lower.includes('cannot be modified') || lower.includes('invalid signature'))
  )
}

/** Official `oM` — thinking-signature refusals are excluded from recovery. */
function isThinkingSignatureRefusal(error: APIError): boolean {
  if (error.status !== 400) {
    return false
  }
  return (
    mentionsThinkingSignatureProblem(error.message) ||
    findsCapabilityRejectedToken(error.message, 'thinking_signature')
  )
}

/**
 * Official `iSe`/`TQ` (@248312563) — does this error NAME the tool-search
 * beta header as the thing it refused? An APIError whose message names the
 * header (the "Unexpected value(s) ..." first line via `e5t`, or — for
 * status 400 — the `Mv`/`eOs` mention-or-token path), and which is not a
 * conversation-binding (`GB`) or thinking-signature (`oM`) refusal.
 *
 * Official `TQ` also consults the per-beta `Z6t` classifier map; the v306
 * binary has NO tool-search entry in that map (its keys are
 * context_management / evict_on_complete / thinking-display records), so for
 * the tool-search header the lookup reduces to `e5t` — ported without the map
 * (documented). The official `n.header===null` guard is kept: callers pass
 * the request-scoped `toolSearchHeader`, which is null when tool search was
 * not declared.
 */
export function isToolSearchBetaRefusalNamed(
  error: unknown,
  betaHeader: string | null,
): boolean {
  if (!(error instanceof APIError) || betaHeader === null) {
    return false
  }
  if (isConversationBindingRefusal(error) || isThinkingSignatureRefusal(error)) {
    return false
  }
  return (
    namesBetaInUnexpectedValuesLine(error, betaHeader) ||
    (error.status === 400 && namesBetaRejected(error.message, betaHeader))
  )
}

/**
 * Official `vf`/`Ff` (@238694176, RAW form) — ANTHROPIC_BASE_URL unset, or
 * pointing at exactly the production first-party host. Deliberately NOT
 * providers.ts `isFirstPartyAnthropicBaseUrl`: that one ports the official
 * `Mi`/`Xo` variant (ant-internal assume-flag + api-staging superset), while
 * `Jmn` calls raw `vf` (documented deviation from the obvious mapping).
 */
function isRawFirstPartyBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    return ['api.anthropic.com'].includes(new URL(baseUrl).host)
  } catch {
    return false
  }
}

/**
 * Official `sH` (= `Cde()===null && ac()`, @240979705/@240985860) — signed in
 * as a claude.ai subscriber with no API key. Approximation (documented): OCC
 * has no OIDC profile-auth subsystem (`nv`/`Jet`/`OBr`), so `Cde()` maps to
 * getAnthropicApiKey() and `ac()` to the auth-token source being the claude.ai
 * subscriber OAuth form. Fail-closed via isTrueFirstParty's try/catch:
 * getAnthropicApiKey() THROWS in CI/test mode with no credential configured,
 * and the official `Jmn` catch → log + false absorbs that identically.
 */
function isSubscriberOauthForm(): boolean {
  return (
    getAnthropicApiKey() === null && getAuthTokenSource().source === 'claude.ai'
  )
}

/**
 * Official `Jmn` (@249494776) — "true first party": firstParty provider, no
 * ANTHROPIC_UNIX_SOCKET, raw first-party base URL, and not subscriber OAuth.
 * Gates the anonymous-refusal `defer_loading` message guard (Ese's
 * `!Jmn()||/\bdefer_loading\b/.test(to.message)` arm): on a genuine
 * first-party connection any refused 400/422 is trusted as the tool-search
 * refusal even when the message never mentions `defer_loading`; behind a
 * proxy the message must name the deferred-tools mechanism, so an arbitrary
 * gateway 400 does not trigger a false recovery.
 */
export function isTrueFirstParty(): boolean {
  try {
    return (
      getAPIProvider() === 'firstParty' &&
      process.env.ANTHROPIC_UNIX_SOCKET === undefined &&
      isRawFirstPartyBaseUrl() &&
      !isSubscriberOauthForm()
    )
  } catch (error) {
    logError(error as Error)
    return false
  }
}

/**
 * Official `Ese` message-side conjuncts — is this error eligible for the
 * ANONYMOUS refuse-recovery path (`N6`)? Official full form (@249522800):
 *
 *   `Ese=(to)=>{let _r=GVe(to);return L6(to)
 *     &&(!Jmn()||/\bdefer_loading\b/.test(to.message))
 *     &&(to.status===400||to.status===422)
 *     &&to.type!=="billing_error"&&!Fw(_r)&&!UF(_r)}`
 *
 * Port decisions (documented):
 * - `L6` (the request-scoped conjuncts: tool search was declared on the
 *   request, no partial message received yet, error is an APIError, no
 *   resume-incomplete-thinking) is enforced by the caller in claude.ts, where
 *   the request-scoped closure state lives.
 * - `GVe` (422→400 rewrite) feeds ONLY `Fw`/`UF` — the big ORs of every
 *   OTHER recovery classifier. In OCC those are the earlier `retry*Refused`
 *   handlers in withRetry's fatal-400 chain, which have already declined by
 *   the time this predicate is consulted (chain-position equivalence, see the
 *   section header), so the rewrite has nothing left to act on and is omitted.
 * - `to.type!=="billing_error"` uses OCC's isAPIErrorBodyType (superset of
 *   the official `.type` read: also covers nested body + message shapes).
 */
export function isAnonymousToolSearchRefuseRecoveryEligible(
  error: APIError,
): boolean {
  return (
    (!isTrueFirstParty() || /\bdefer_loading\b/.test(error.message)) &&
    (error.status === 400 || error.status === 422) &&
    !isAPIErrorBodyType(error, 'billing_error')
  )
}

/**
 * Official `EF` (@249522800) — the verbatim warn, then throw the retry
 * marker. Official warn text (copied byte-for-byte from the v306 binary):
 *
 *   `[ToolSearch] HTTP ${status} ${description}${header?` (${header})`:''};
 *    sending the request again without deferred tools.
 *    ENABLE_TOOL_SEARCH=false avoids the refused request`
 *   (+ a trailing `. Dropped first and now allowed again: ...` clause when
 *    the sticky-dropped-tools list `PO` is non-empty)
 *
 * The official also un-drops sticky-dropped tools (`for(let ni of PO)Jvt(dt,ni)`)
 * and flushes deferred-tool state (`if(gLe)a9o()`); OCC has neither subsystem
 * and `PO` is always empty, so the warn clause never renders and the
 * loop/flush are omitted (documented).
 *
 * The two official `description` values:
 * - named path (`Rse`): `refusing the tool search beta`
 * - anonymous path (`N6`): `that no other recovery took, on a request that
 *   declared deferred tools`
 */
export function throwToolSearchRefused(
  error: APIError,
  betaHeader: string | null,
  refusalDescription: string,
  declaredToolSearch: boolean,
): never {
  logForDebugging(
    `[ToolSearch] HTTP ${error.status} ${refusalDescription}${
      betaHeader ? ` (${betaHeader})` : ''
    }; sending the request again without deferred tools. ENABLE_TOOL_SEARCH=false avoids the refused request`,
    { level: 'warn' },
  )
  throw new ToolSearchRefusedError(error, declaredToolSearch)
}

/** Official `Rse`'s refusal description (named path), verbatim. */
export const TOOL_SEARCH_REFUSED_DESCRIPTION_NAMED =
  'refusing the tool search beta'

/** Official `N6`'s refusal description (anonymous path), verbatim. */
export const TOOL_SEARCH_REFUSED_DESCRIPTION_ANONYMOUS =
  'that no other recovery took, on a request that declared deferred tools'

/**
 * The system-reminder content the official `pgn` wrapper prepends to the
 * conversation when the refused request had declared tool search
 * (`${Pi}` = "ToolSearch" @242035159; text verbatim from the v306 binary).
 */
export const TOOL_SEARCH_REFUSED_REMINDER = `${TOOL_SEARCH_TOOL_NAME} is no longer available. Tools listed earlier as deferred that are still available are declared in full: call them directly.`

/** Official `LI` (@240811864) — plain conforming model-id shape. */
const BETA_HEAL_MODEL_PATTERN = /^[A-Za-z0-9._:[\]-]{1,100}$/

/** Official `UI` — model id with `@YYYYMMDD` snapshot suffix (optional `[Nm]`). */
const BETA_HEAL_MODEL_SNAPSHOT_PATTERN =
  /^[A-Za-z0-9._:[\]-]{1,91}@\d{8}(\[\d{1,3}[mM]\])?$/

/**
 * Official `vt` — telemetry model sanitizer: conforming ids pass through
 * (`Pn` is identity for strings), everything else is reported as the literal
 * 'nonconforming' (`b("nonconforming")` — same mapping as fileStateGuard.ts
 * `getModelBucket`'s `Pn`/`b` precedent).
 */
function sanitizeModelForBetaHealTelemetry(
  model: string | null | undefined,
): string | undefined {
  if (model == null) {
    return undefined
  }
  return BETA_HEAL_MODEL_PATTERN.test(model) ||
    BETA_HEAL_MODEL_SNAPSHOT_PATTERN.test(model)
    ? model
    : 'nonconforming'
}

/**
 * Official `hLe` body (@249522800) — success-side heal mark. Called after the
 * retry run that was sent WITHOUT the tool-search beta answers successfully.
 *
 * The official reads `Q.toolSearchRefusal` (the captured `UZ.refusal`) behind
 * the `Cse` one-shot latch; in OCC both live in the claude.ts handler closure,
 * and this function is the per-call body (the caller enforces the latch).
 * Official named branch `bn(_r,TQ(to,_r))` (re-arm the sticky beta drop so
 * the header is never sent again) and `bg(dt,_r)` have no OCC surface — the
 * drop already happened inline in the same retry run — so only the anonymous
 * debug log and the telemetry event remain (documented). `Ode([_r.header])`
 * reduces to the header string itself for the known tool-search betas.
 */
export function markToolSearchBetaHealed(
  refusal: APIError,
  model: string,
): void {
  try {
    const header = getToolSearchBetaHeader()
    const named = isToolSearchBetaRefusalNamed(refusal, header)
    if (!named) {
      logForDebugging(
        '[ToolSearch] the endpoint answered the request sent without tool search, so this conversation goes on without it',
      )
    }
    logEvent('tengu_beta_400_healed', {
      beta: header,
      model: sanitizeModelForBetaHealTelemetry(model),
      provider: getAPIProviderForStatsig(),
      status: refusal.status,
      unnamed: !named,
    })
  } catch (error) {
    logError(error as Error)
  }
}

/**
 * Check if a model supports tool_reference blocks (required for tool search).
 *
 * This uses a negative test: models are assumed to support tool_reference
 * UNLESS they match a pattern in the unsupported list. This ensures new
 * models work by default without code changes.
 *
 * Currently, Haiku models do NOT support tool_reference. This can be
 * updated via GrowthBook feature 'tengu_tool_search_unsupported_models'.
 *
 * CC 2.1.306 (research-api.md #1): back to the official v306 `Zae` form —
 * `return!0` after the patterns check. The v304 `return!d(e)` arm (persisted
 * refused window) is gone: the v306 binary has ZERO `toolSearchRefusedAt`
 * string hits (v304: 6), and recovery is now per-request/one-shot via the
 * retry run's rebuilt state, not via model support.
 *
 * @param model The model name to check
 * @returns true if the model supports tool_reference, false otherwise
 */
export function modelSupportsToolReference(model: string): boolean {
  const normalizedModel = model.toLowerCase()
  const unsupportedPatterns = getUnsupportedToolReferencePatterns()

  // Check if model matches any unsupported pattern
  for (const pattern of unsupportedPatterns) {
    if (normalizedModel.includes(pattern.toLowerCase())) {
      return false
    }
  }

  return true
}

/**
 * Check if tool search *might* be enabled (optimistic check).
 *
 * Returns true if tool search could potentially be enabled, without checking
 * dynamic factors like model support or threshold. Use this for:
 * - Including ToolSearchTool in base tools (so it's available if needed)
 * - Preserving tool_reference fields in messages (can be stripped later)
 * - Checking if ToolSearchTool should report itself as enabled
 *
 * Returns false only when tool search is definitively disabled (standard mode).
 *
 * For the definitive check that includes model support and threshold,
 * use isToolSearchEnabled().
 */
let loggedOptimistic = false

export function isToolSearchEnabledOptimistic(): boolean {
  const mode = getToolSearchMode()
  if (mode === 'standard') {
    if (!loggedOptimistic) {
      loggedOptimistic = true
      logForDebugging(
        `[ToolSearch:optimistic] mode=${mode}, ENABLE_TOOL_SEARCH=${process.env.ENABLE_TOOL_SEARCH}, result=false`,
      )
    }
    return false
  }

  // CC 2.1.304 (#58): the vprev (303) optimistic-disable branch for a custom
  // ANTHROPIC_BASE_URL (`!ENABLE_TOOL_SEARCH && firstParty &&
  // !isFirstPartyAnthropicBaseUrl()` → return false, with the "is not a
  // first-party Anthropic host" warn) was REMOVED by the official 304
  // (binary string count: vprev=2 → vver=0) and stays removed in 306. Tool
  // search is ON by default behind custom base URLs; an endpoint that refuses
  // it is handled by the v306 refuse-recovery state machine (this module's
  // isToolSearchBetaRefusalNamed / isAnonymousToolSearchRefuseRecoveryEligible
  // + the claude.ts retryToolSearchRefused handler): the refused request is
  // rebuilt and retried once WITHOUT tool search, for that request only —
  // v306 removed the v304 persisted 1-day window (toolSearchRefusedAt has
  // ZERO v306 binary string hits) and the ENABLE_TOOL_SEARCH / custom-base-URL
  // eligibility gate (`zOe`). ENABLE_TOOL_SEARCH=false still skips tool
  // search entirely (standard mode); =true always sends it when eligible —
  // and the recovery now runs in BOTH cases.

  if (!loggedOptimistic) {
    loggedOptimistic = true
    logForDebugging(
      `[ToolSearch:optimistic] mode=${mode}, ENABLE_TOOL_SEARCH=${process.env.ENABLE_TOOL_SEARCH}, result=true`,
    )
  }
  return true
}

/**
 * Check if ToolSearchTool is available in the provided tools list.
 * If ToolSearchTool is not available (e.g., disallowed via disallowedTools),
 * tool search cannot function and should be disabled.
 *
 * @param tools Array of tools with a 'name' property
 * @returns true if ToolSearchTool is in the tools list, false otherwise
 */
export function isToolSearchToolAvailable(
  tools: readonly { name: string }[],
): boolean {
  return tools.some(tool => toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME))
}

/**
 * Calculate total deferred tool description size in characters.
 * Includes name, description text, and input schema to match what's actually sent to the API.
 */
async function calculateDeferredToolDescriptionChars(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
): Promise<number> {
  const deferredTools = tools.filter(t => isDeferredTool(t))
  if (deferredTools.length === 0) return 0

  const sizes = await Promise.all(
    deferredTools.map(async tool => {
      const description = await tool.prompt({
        getToolPermissionContext,
        tools,
        agents,
      })
      const inputSchema = tool.inputJSONSchema
        ? jsonStringify(tool.inputJSONSchema)
        : tool.inputSchema
          ? jsonStringify(zodToJsonSchema(tool.inputSchema))
          : ''
      return tool.name.length + description.length + inputSchema.length
    }),
  )

  return sizes.reduce((total, size) => total + size, 0)
}

/**
 * Check if tool search (MCP tool deferral with tool_reference) is enabled for a specific request.
 *
 * This is the definitive check that includes:
 * - MCP mode (Tst, TstAuto, McpCli, Standard)
 * - Model compatibility (haiku doesn't support tool_reference)
 * - ToolSearchTool availability (must be in tools list)
 * - Threshold check for TstAuto mode
 *
 * Use this when making actual API calls where all context is available.
 *
 * @param model The model to check for tool_reference support
 * @param tools Array of available tools (including MCP tools)
 * @param getToolPermissionContext Function to get tool permission context
 * @param agents Array of agent definitions
 * @param source Optional identifier for the caller (for debugging)
 * @param autoHeld CC 2.1.300 #18 — official 7th param `S` (byte-verified
 *   from the v300 ELF @227142200: `async function Lfr(e,n,r,s,h,y,S=!1)`).
 *   TRUE when the conversation already declared ToolSearch (official query
 *   caller @227824350 passes `Q.recordedToolDescriptions?.has(Ci)` with
 *   `Ci="ToolSearch"` @219935042). In 'tst-auto' mode the flag short-circuits
 *   the threshold recompute with reason `auto_held` (v300: 2 hits @107850108
 *   & @227142599; v299: 0) so tool search cannot flip OFF mid-conversation —
 *   e.g. when MCP servers reconnect after resume and the deferred-tool token
 *   count momentarily drops below the threshold. The compact caller passes no
 *   hold (@227627600 region, 6 args) — compaction may legitimately re-decide.
 * @returns true if tool search should be enabled for this request
 */
export async function isToolSearchEnabled(
  model: string,
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  source?: string,
  autoHeld = false,
): Promise<boolean> {
  const mcpToolCount = count(tools, t => t.isMcp)

  // Helper to log the mode decision event
  function logModeDecision(
    enabled: boolean,
    mode: ToolSearchMode,
    reason: string,
    extraProps?: Record<string, number>,
  ): void {
    logEvent('tengu_tool_search_mode_decision', {
      enabled,
      mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      reason:
        reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // Log the actual model being checked, not the session's main model.
      // This is important for debugging subagent tool search decisions where
      // the subagent model (e.g., haiku) differs from the session model (e.g., opus).
      checkedModel:
        model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      mcpToolCount,
      userType: (process.env.USER_TYPE ??
        'external') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...extraProps,
    })
  }

  // Check if model supports tool_reference
  if (!modelSupportsToolReference(model)) {
    logForDebugging(
      `Tool search disabled for model '${model}': model does not support tool_reference blocks. ` +
        `This feature is only available on Claude Sonnet 4+, Opus 4+, and newer models.`,
    )
    logModeDecision(false, 'standard', 'model_unsupported')
    return false
  }

  // Check if ToolSearchTool is available (respects disallowedTools)
  if (!isToolSearchToolAvailable(tools)) {
    logForDebugging(
      `Tool search disabled: ToolSearchTool is not available (may have been disallowed via disallowedTools).`,
    )
    logModeDecision(false, 'standard', 'mcp_search_unavailable')
    return false
  }

  const mode = getToolSearchMode()

  switch (mode) {
    case 'tst':
      logModeDecision(true, mode, 'tst_enabled')
      return true

    case 'tst-auto': {
      // CC 2.1.300 #18 — official hold check FIRST inside the auto branch
      // (@227142517, byte-verified): `if(S)return t("Auto tool search
      // enabled: this conversation already declared ToolSearch"),
      // H(!0,V,"auto_held"),!0` — note the debug line carries NO
      // `[source:]` suffix (unlike the threshold branches below).
      if (autoHeld) {
        logForDebugging(
          'Auto tool search enabled: this conversation already declared ToolSearch',
        )
        logModeDecision(true, mode, 'auto_held')
        return true
      }

      const { enabled, debugDescription, metrics } = await checkAutoThreshold(
        tools,
        getToolPermissionContext,
        agents,
        model,
      )

      if (enabled) {
        logForDebugging(
          `Auto tool search enabled: ${debugDescription}` +
            (source ? ` [source: ${source}]` : ''),
        )
        logModeDecision(true, mode, 'auto_above_threshold', metrics)
        return true
      }

      logForDebugging(
        `Auto tool search disabled: ${debugDescription}` +
          (source ? ` [source: ${source}]` : ''),
      )
      logModeDecision(false, mode, 'auto_below_threshold', metrics)
      return false
    }

    case 'standard':
      logModeDecision(false, mode, 'standard_mode')
      return false
  }
}

/**
 * CC 2.1.300 #18 — conversation-scoped "ToolSearch declared" latch.
 *
 * Official hold flag (byte-verified): the query caller passes
 * `Q.recordedToolDescriptions?.has(Ci)` as the 7th arg `S` of `Lfr`
 * (@227824350/@227824419), where `Ci="ToolSearch"` (@219935042).
 * `recordedToolDescriptions` is the per-conversation Map of tool
 * descriptions actually sent to the API, recorded during tool-IR build
 * (`H1t(st,ir,{...,recorded:Q.recordedToolDescriptions,...})` in the
 * @227828656 region) — so once ToolSearch's description has gone out on
 * the wire, the auto-mode hold sticks for the rest of the conversation
 * (`auto_held` @227142599, new in v300; v299 has zero hits).
 *
 * Documented deviation: OCC has no recordedToolDescriptions ledger (#46
 * stays STAGED — name-memo only), so this module-level boolean mirrors the
 * per-conversation Map's `has("ToolSearch")` semantics. Per-process ≈
 * conversation lifetime — same deviation class as the module-level
 * refusedToolSchemas map (#36). Reset on /clear and resume via
 * clearSessionCaches (official per-conversation Q is fresh after process
 * restart; w3n @239179269 clears conversation-scoped API state on
 * transcript_cleared).
 */
let toolSearchDeclared = false

/** Arm the hold — call when ToolSearch's description actually goes out on the wire. */
export function noteToolSearchDeclared(): void {
  toolSearchDeclared = true
}

/** Official `Q.recordedToolDescriptions?.has(Ci)` — read by the query call site. */
export function isToolSearchDeclared(): boolean {
  return toolSearchDeclared
}

/** Conversation reset (/clear, resume) — official Q is per-conversation. */
export function resetToolSearchDeclared(): void {
  toolSearchDeclared = false
}

/**
 * Check if an object is a tool_reference block.
 * tool_reference is a beta feature not in the SDK types, so we need runtime checks.
 */
export function isToolReferenceBlock(obj: unknown): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_reference'
  )
}

/**
 * Type guard for tool_reference block with tool_name.
 */
function isToolReferenceWithName(
  obj: unknown,
): obj is { type: 'tool_reference'; tool_name: string } {
  return (
    isToolReferenceBlock(obj) &&
    'tool_name' in (obj as object) &&
    typeof (obj as { tool_name: unknown }).tool_name === 'string'
  )
}

/**
 * Type representing a tool_result block with array content.
 * Used for extracting tool_reference blocks from ToolSearchTool results.
 */
type ToolResultBlock = {
  type: 'tool_result'
  content: unknown[]
}

/**
 * Type guard for tool_result blocks with array content.
 */
function isToolResultBlockWithContent(obj: unknown): obj is ToolResultBlock {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_result' &&
    'content' in obj &&
    Array.isArray((obj as { content: unknown }).content)
  )
}

/**
 * Extract tool names from tool_reference blocks in message history.
 *
 * When dynamic tool loading is enabled, MCP tools are not predeclared in the
 * tools array. Instead, they are discovered via ToolSearchTool which returns
 * tool_reference blocks. This function scans the message history to find all
 * tool names that have been referenced, so we can include only those tools
 * in subsequent API requests.
 *
 * This approach:
 * - Eliminates the need to predeclare all MCP tools upfront
 * - Removes limits on total quantity of MCP tools
 *
 * Compaction replaces tool_reference-bearing messages with a summary, so it
 * snapshots the discovered set onto compactMetadata.preCompactDiscoveredTools
 * on the boundary marker; this scan reads it back. Snip instead protects the
 * tool_reference-carrying messages from removal.
 *
 * @param messages Array of messages that may contain tool_result blocks with tool_reference content
 * @returns Set of tool names that have been discovered via tool_reference blocks
 */
export function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  const discoveredTools = new Set<string>()
  let carriedFromBoundary = 0

  for (const msg of messages) {
    // Compact boundary carries the pre-compact discovered set. Inline type
    // check rather than isCompactBoundaryMessage — utils/messages.ts imports
    // from this file, so importing back would be circular.
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      const carried = (msg as any).compactMetadata?.preCompactDiscoveredTools as string[] | undefined
      if (carried) {
        for (const name of carried) discoveredTools.add(name)
        carriedFromBoundary += carried.length
      }
      continue
    }

    // Only user messages contain tool_result blocks (responses to tool_use)
    if (msg.type !== 'user') continue

    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      // tool_reference blocks only appear inside tool_result content, specifically
      // in results from ToolSearchTool. The API expands these references into full
      // tool definitions in the model's context.
      if (isToolResultBlockWithContent(block)) {
        for (const item of block.content) {
          if (isToolReferenceWithName(item)) {
            discoveredTools.add(item.tool_name)
          }
        }
      }
    }
  }

  if (discoveredTools.size > 0) {
    logForDebugging(
      `Dynamic tool loading: found ${discoveredTools.size} discovered tools in message history` +
        (carriedFromBoundary > 0
          ? ` (${carriedFromBoundary} carried from compact boundary)`
          : ''),
    )
  }

  return discoveredTools
}

export type DeferredToolsDelta = {
  addedNames: string[]
  /** Rendered lines for addedNames; the scan reconstructs from names. */
  addedLines: string[]
  removedNames: string[]
}

/**
 * Call-site discriminator for the tengu_deferred_tools_pool_change event.
 * The scan runs from several sites with different expected-prior semantics
 * (inc-4747):
 *   - attachments_main: main-thread getAttachments → prior=0 is a BUG on fire-2+
 *   - attachments_subagent: subagent getAttachments → prior=0 is EXPECTED
 *     (fresh conversation, initialMessages has no DTD)
 *   - compact_full: compact.ts passes [] → prior=0 is EXPECTED
 *   - compact_partial: compact.ts passes messagesToKeep → depends on what survived
 *   - reactive_compact: reactiveCompact.ts passes preservedMessages → same
 * Without this the 96%-prior=0 stat is dominated by EXPECTED buckets and
 * the real main-thread cross-turn bug (if any) is invisible in BQ.
 */
export type DeferredToolsDeltaScanContext = {
  callSite:
    | 'attachments_main'
    | 'attachments_subagent'
    | 'compact_full'
    | 'compact_partial'
    | 'reactive_compact'
  querySource?: string
}

/**
 * True → announce deferred tools via persisted delta attachments.
 * False → claude.ts keeps its per-call <available-deferred-tools>
 * header prepend (the attachment does not fire).
 */
export function isDeferredToolsDeltaEnabled(): boolean {
  return (
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  )
}

/**
 * Diff the current deferred-tool pool against what's already been
 * announced in this conversation (reconstructed by scanning for prior
 * deferred_tools_delta attachments). Returns null if nothing changed.
 *
 * A name that was announced but has since stopped being deferred — yet
 * is still in the base pool — is NOT reported as removed. It's now
 * loaded directly, so telling the model "no longer available" would be
 * wrong.
 */
export function getDeferredToolsDelta(
  tools: Tools,
  messages: Message[],
  scanContext?: DeferredToolsDeltaScanContext,
): DeferredToolsDelta | null {
  const announced = new Set<string>()
  let attachmentCount = 0
  let dtdCount = 0
  const attachmentTypesSeen = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    attachmentCount++
    attachmentTypesSeen.add(msg.attachment.type)
    if (msg.attachment.type !== 'deferred_tools_delta') continue
    dtdCount++
    for (const n of (msg.attachment as any).addedNames) announced.add(n)
    for (const n of (msg.attachment as any).removedNames) announced.delete(n)
  }

  const deferred: Tool[] = tools.filter(isDeferredTool)
  const deferredNames = new Set(deferred.map(t => t.name))
  const poolNames = new Set(tools.map(t => t.name))

  const added = deferred.filter(t => !announced.has(t.name))
  const removed: string[] = []
  for (const n of announced) {
    if (deferredNames.has(n)) continue
    if (!poolNames.has(n)) removed.push(n)
    // else: undeferred — silent
  }

  if (added.length === 0 && removed.length === 0) return null

  // Diagnostic for the inc-4747 scan-finds-nothing bug. Round-1 fields
  // (messagesLength/attachmentCount/dtdCount from #23167) showed 45.6% of
  // events have attachments-but-no-DTD, but those numbers are confounded:
  // subagent first-fires and compact-path scans have EXPECTED prior=0 and
  // dominate the stat. callSite/querySource/attachmentTypesSeen split the
  // buckets so the real main-thread cross-turn failure is isolable in BQ.
  logEvent('tengu_deferred_tools_pool_change', {
    addedCount: added.length,
    removedCount: removed.length,
    priorAnnouncedCount: announced.size,
    messagesLength: messages.length,
    attachmentCount,
    dtdCount,
    callSite: (scanContext?.callSite ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource: (scanContext?.querySource ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    attachmentTypesSeen: [...attachmentTypesSeen]
      .sort()
      .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return {
    addedNames: added.map(t => t.name).sort(),
    addedLines: added.map(formatDeferredToolLine).sort(),
    removedNames: removed.sort(),
  }
}

/**
 * Check whether deferred tools exceed the auto-threshold for enabling TST.
 * Tries exact token count first; falls back to character-based heuristic.
 */
async function checkAutoThreshold(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  model: string,
): Promise<{
  enabled: boolean
  debugDescription: string
  metrics: Record<string, number>
}> {
  // Try exact token count first (cached, one API call per toolset change)
  const deferredToolTokens = await getDeferredToolTokenCount(
    tools,
    getToolPermissionContext,
    agents,
    model,
  )

  if (deferredToolTokens !== null) {
    const threshold = getAutoToolSearchTokenThreshold(model)
    return {
      enabled: deferredToolTokens >= threshold,
      debugDescription:
        `${deferredToolTokens} tokens (threshold: ${threshold}, ` +
        `${getAutoToolSearchPercentage()}% of context)`,
      metrics: { deferredToolTokens, threshold },
    }
  }

  // Fallback: character-based heuristic when token API is unavailable
  const deferredToolDescriptionChars =
    await calculateDeferredToolDescriptionChars(
      tools,
      getToolPermissionContext,
      agents,
    )
  const charThreshold = getAutoToolSearchCharThreshold(model)
  return {
    enabled: deferredToolDescriptionChars >= charThreshold,
    debugDescription:
      `${deferredToolDescriptionChars} chars (threshold: ${charThreshold}, ` +
      `${getAutoToolSearchPercentage()}% of context) (char fallback)`,
    metrics: { deferredToolDescriptionChars, charThreshold },
  }
}
