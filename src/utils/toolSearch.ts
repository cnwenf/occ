/**
 * Tool Search utilities for dynamically discovering deferred tools.
 *
 * When enabled, deferred tools (MCP and shouldDefer tools) are sent with
 * defer_loading: true and discovered via ToolSearchTool rather than being
 * loaded upfront.
 */

import { createHash } from 'crypto'
import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
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
import { getMergedBetas } from './betas.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { getContextWindowForModel } from './context.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { normalizeModelStringForAPI } from './model/model.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from './model/providers.js'
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
// CC 2.1.304 (#58): tool search ON by default behind a custom
// ANTHROPIC_BASE_URL, with refuse-recovery. Port of the official vver module
// (byte-verified in docs/gap-research-304/research-R4-skills-hooks.md "#58"):
//   var h=86400000;
//   function zOe(){return!a.ENABLE_TOOL_SEARCH&&!l()&&Pe()==="firstParty"&&!Ri()}
//   function c(e){return S("sha256").update(`${a.ANTHROPIC_BASE_URL}\x00${Pn(e)}`)
//     .digest("hex").slice(0,24)}
//   function f(e){return typeof e==="number"&&Math.abs(Date.now()-e)<h}
//   function d(e){return zOe()&&f(ue().toolSearchRefusedAt?.[c(e)])}
//   function DUs(e,r){if(d(e))return;
//     t(`[ToolSearch] the endpoint set in ANTHROPIC_BASE_URL refused a request
//        for ${e} and answered it without tool search; ...`,{level:"warn"}),
//     Ae((o)=>f(o.toolSearchRefusedAt?.[c(e)])?o
//       :{...o,toolSearchRefusedAt:{...Cs(o.toolSearchRefusedAt,f),[c(e)]:Date.now()}},r)}
// OCC mapping: `Pn` = normalizeModelStringForAPI; `ue()`/`Ae()` =
// getGlobalConfig()/saveGlobalConfig() (same same-reference-skip updater
// semantics); `Cs(map, f)` = pruneRefusedEntries below. The official `zOe()`
// also checks `!l()` (a "force" override that consults ENABLE_TOOL_SEARCH and
// a settings-level tool-search override `iWo()`); OCC has no `force` value and
// no settings-level tool-search override, so `!process.env.ENABLE_TOOL_SEARCH`
// covers it (documented deviation).
// ---------------------------------------------------------------------------

/** Official `h` — the refused window TTL: one day in ms. */
const TOOL_SEARCH_REFUSED_TTL_MS = 86_400_000

/**
 * Official `zOe()` — whether the tool-search refuse-recovery (and the
 * persisted refused window) applies: ENABLE_TOOL_SEARCH unset/empty (no
 * explicit override), provider firstParty, and ANTHROPIC_BASE_URL is NOT a
 * first-party Anthropic host (a custom proxy/gateway).
 *
 * Explicit ENABLE_TOOL_SEARCH semantics (official recipe #5):
 *   - `=false` → getToolSearchMode() returns 'standard'; no tool search is
 *     ever sent, so the refused request is skipped entirely (and this
 *     predicate is false — recovery never runs).
 *   - `=true` (or `auto`/`auto:N`) → the user asserts their proxy supports
 *     tool_reference; tool search is always sent when otherwise eligible and
 *     this predicate is false, turning the recovery off.
 */
export function isToolSearchRefuseRecoveryEnabled(): boolean {
  return (
    !process.env.ENABLE_TOOL_SEARCH &&
    getAPIProvider() === 'firstParty' &&
    !isFirstPartyAnthropicBaseUrl()
  )
}

/** Official `c(e)` — persisted-config entry key for endpoint+model. */
function toolSearchRefusedKey(model: string): string {
  return createHash('sha256')
    .update(
      `${process.env.ANTHROPIC_BASE_URL}\0${normalizeModelStringForAPI(model)}`,
    )
    .digest('hex')
    .slice(0, 24)
}

/** Official `f(e)` — is a recorded refusal timestamp still fresh? */
function isRefusedAtFresh(refusedAt: unknown): boolean {
  return (
    typeof refusedAt === 'number' &&
    Math.abs(Date.now() - refusedAt) < TOOL_SEARCH_REFUSED_TTL_MS
  )
}

/** Official `Cs(map, f)` — prune expired entries when writing. */
function pruneRefusedEntries(
  refusedAt: Record<string, number> | undefined,
): Record<string, number> {
  const pruned: Record<string, number> = {}
  for (const [key, ts] of Object.entries(refusedAt ?? {})) {
    if (isRefusedAtFresh(ts)) {
      pruned[key] = ts
    }
  }
  return pruned
}

/**
 * Official `d(e)` — the endpoint+model is inside the refused window, so
 * tool search must be treated as unsupported there (Zae's `return!d(e)` arm
 * routes this through modelSupportsToolReference → `model_unsupported`).
 */
export function isToolSearchRefused(model: string): boolean {
  if (!isToolSearchRefuseRecoveryEnabled()) {
    return false
  }
  try {
    return isRefusedAtFresh(
      getGlobalConfig().toolSearchRefusedAt?.[toolSearchRefusedKey(model)],
    )
  } catch {
    return false
  }
}

/**
 * Official `DUs(e, r)` — record that the endpoint refused a tool-search
 * request for this model and answered it without tool search. No-op when the
 * window is already fresh (official `if(d(e))return`); otherwise warn-logs
 * the official text and writes `toolSearchRefusedAt[key]=Date.now()` through
 * saveGlobalConfig, pruning expired entries (official `Cs`) in the same write.
 */
export function recordToolSearchRefused(model: string): void {
  try {
    if (isToolSearchRefused(model)) {
      return
    }
    logForDebugging(
      `[ToolSearch] the endpoint set in ANTHROPIC_BASE_URL refused a request for ${model} and answered it without tool search; tool search stays off there for a day. ENABLE_TOOL_SEARCH=false skips the refused request; =true always sends tool search and turns this recovery off.`,
      { level: 'warn' },
    )
    const key = toolSearchRefusedKey(model)
    saveGlobalConfig(config => {
      if (isRefusedAtFresh(config.toolSearchRefusedAt?.[key])) {
        return config
      }
      return {
        ...config,
        toolSearchRefusedAt: {
          ...pruneRefusedEntries(config.toolSearchRefusedAt),
          [key]: Date.now(),
        },
      }
    })
  } catch (err) {
    logForDebugging(
      `[ToolSearch] failed to record tool-search refusal: ${String(err)}`,
      { level: 'error' },
    )
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
 * CC 2.1.304 (#58): official `Zae` — the patterns check is unchanged but the
 * final `return!0` became `return!d(e)`: an endpoint+model inside the
 * persisted refused window is treated as unsupported (downstream gate reason
 * `model_unsupported`), so a gateway that already refused tool search does
 * not get asked again for a day.
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

  // CC 2.1.304 (#58): official `return!d(e)` — refused within the last day
  // behind the current custom base URL counts as unsupported.
  return !isToolSearchRefused(model)
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
  // (binary string count: vprev=2 → vver=0). Tool search is now ON by default
  // behind custom base URLs; a gateway that refuses it is handled by the
  // refuse-recovery loop (isToolSearchRefuseRecoveryEnabled /
  // recordToolSearchRefused below and the claude.ts retryToolSearchRefused
  // handler) — the first 400/422 no other recovery claimed rebuilds the
  // request without tool search and keeps it off for that endpoint+model for
  // a day. ENABLE_TOOL_SEARCH=false skips the refused request entirely;
  // =true always sends tool search and turns the recovery off.

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
