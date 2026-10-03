import { feature } from 'src/utils/featureFlags.js'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  getSessionAutoCompactWindow,
  resolveAutoCompactWindow,
} from '../../utils/autoCompactWindow.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
// CC 2.1.288 #65 — auto mode classifier overflow now compacts (LFo consumer,
// ojt finalize, TY not-run handler).
import {
  consumeClassifierOverflowForCompaction,
  finalizeOverflowCompaction,
  reportOverflowCompactionNotRun,
} from '../../utils/permissions/classifierOverflowPending.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  ERROR_MESSAGE_USER_ABORT,
  isPreCompactBlockError,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

// Returns the context window size minus the max output tokens for the model
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  const contextWindow = getContextWindowForModel(model, getSdkBetas())

  // Gap-288 #79 (official 2.1.288 `Dw`/`TK`): the effective window is the
  // shared resolver's `window` — env CLAUDE_CODE_AUTO_COMPACT_WINDOW takes
  // precedence over everything ("/autocompact" refuses to change the setting
  // while it is set), then the session override (per-model aggregate, a bare
  // number from the --autocompact flag, or undefined for auto). The resolver
  // caps to the model's native window — the official "capped to model limit"
  // behavior.
  const { window } = resolveAutoCompactWindow(
    model,
    contextWindow,
    getSessionAutoCompactWindow(),
  )

  return window - reservedTokensForSummary
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used as a circuit breaker to stop retrying when the context is
  // irrecoverably over the limit (e.g., prompt_too_long).
  consecutiveFailures?: number
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// CC 2.1.288 #65 — official `GJn` set (yHr guard `V$e(g)` @209126458):
// query sources for which a pending classifier-overflow compaction cannot
// run (canCompact=false → the consumer reports skipped/unavailable).
const NON_COMPACTABLE_OVERFLOW_QUERY_SOURCES: ReadonlySet<string> = new Set([
  'prompt_suggestion',
  'away_summary',
  'agent_summary',
  'hook_prompt',
])

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  const autocompactThreshold =
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  // Override for easier testing of autocompact
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

/**
 * Port of official 2.1.235 `kRa()`: true only when auto-compact was
 * *explicitly* turned off by the user — not when an env var disables it
 * and not when it is merely on by default. Used by the context-limit
 * error to append the actionable "auto-compact is off" hint (official
 * `qLl` suffix at the "Context limit reached" render site).
 *
 * Official chain: `if(PBp())return!1;let e=Vd("autoCompactEnabled",!0);
 * if(e.value)return!1;if(e.source==="userSettings")return!0;
 * if(e.source==="legacyGlobalConfig")return eT().includes("userSettings");
 * return!1` — OCC reads `autoCompactEnabled` only from the user-scoped
 * global config (~/.claude.json), which corresponds to the official
 * userSettings/legacyGlobalConfig sources, so an explicit false is user
 * intent. Project/local settings cannot carry the key (not in the OCC
 * settings schema), matching the official "other sources return false".
 */
export function isAutoCompactExplicitlyOff(): boolean {
  // Official PBp(): env-disabled sessions get no hint (the primary
  // continue-hint already reflects the env state).
  if (
    isEnvTruthy(process.env.DISABLE_COMPACT) ||
    isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)
  ) {
    return false
  }
  return getGlobalConfig().autoCompactEnabled === false
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is ant-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  //
  // Consult isContextCollapseEnabled (not the raw gate) so the
  // CLAUDE_CONTEXT_COLLAPSE env override is honored here too. require()
  // inside the block breaks the init-time cycle (this file exports
  // getEffectiveContextWindowSize which collapse's index imports).
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  // CC 2.1.288 #65 — official yHr head (@209126458):
  // `V=LFo(n,e,!K&&Df()&&g!==void 0&&!WO(g)&&!V$e(g)&&!qan(g,r,H))`
  // The consumer runs BEFORE the DISABLE_COMPACT early return and primes
  // canCompact for the permissions-side registry. `qan` (reactive-compact
  // routing) is identically false in OCC (REACTIVE_COMPACT is off), and the
  // official `WO(g)` ("compact") guard extends to OCC's forked
  // session_memory/compact sources — they re-enter autoCompactIfNeeded
  // sharing the parent's registry key, so running the consumer there would
  // spuriously clear the parent's pending mid-compaction.
  const compactDisabled = isEnvTruthy(process.env.DISABLE_COMPACT)
  const overflowPending =
    querySource === 'compact' || querySource === 'session_memory'
      ? undefined
      : consumeClassifierOverflowForCompaction(
          toolUseContext,
          messages,
          !compactDisabled &&
            isAutoCompactEnabled() &&
            querySource !== undefined &&
            !NON_COMPACTABLE_OVERFLOW_QUERY_SOURCES.has(querySource),
        )

  if (compactDisabled) {
    return { wasCompacted: false }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  // Without this, sessions where context is irrecoverably over the limit
  // hammer the API with doomed compaction attempts on every turn.
  // Official v288: a pending classifier-overflow compaction BYPASSES the
  // breaker (`if(V===void 0&&h?.consecutiveFailures!==void 0&&...)`).
  if (
    overflowPending === undefined &&
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )

  // Official v288: `if(!(V!==void 0||await OFo(...)))return{kind:"not_needed"}`
  // — a pending classifier-overflow FORCES compaction below the threshold.
  if (overflowPending === undefined && !shouldCompact) {
    return { wasCompacted: false }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // Reset lastSummarizedMessageId since session memory compaction prunes messages
    // and the old message UUID will no longer exist after the REPL replaces messages
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // Reset cache read baseline so the post-compact drop isn't flagged as a
    // break. compactConversation does this internally; SM-compact doesn't.
    // BQ 2026-03-01: missing this made 20% of tengu_prompt_cache_break events
    // false positives (systemPromptChanged=true, timeSinceLastAssistantMsg=-1).
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      // CC 2.1.288 #65 — official ojt: append the VHt reminder + emit the
      // compacted telemetry when this compaction satisfied a pending
      // classifier-overflow request.
      compactionResult: overflowPending
        ? finalizeOverflowCompaction(
            toolUseContext,
            overflowPending,
            sessionMemoryResult,
          )
        : sessionMemoryResult,
    }
  }

  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // Suppress user questions for autocompact
      undefined, // No custom instructions for autocompact
      true, // isAutoCompact
      recompactionInfo,
      // Official 2.1.273: threshold-triggered auto-compaction passes a DEFINED
      // thresholdSource into `gkt(trigger, thresholdSource)` → classifies the
      // compaction request as 'auto' (only definedness reaches the wire; the
      // string value itself is never sent). This path is reached only after
      // shouldAutoCompact() confirmed a token-threshold breach, so the marker
      // is always defined here — matching the official `r?.thresholdSource`.
      'auto-compact-threshold',
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      // CC 2.1.288 #65 — official ojt: append the VHt reminder + emit the
      // compacted telemetry when this compaction satisfied a pending
      // classifier-overflow request.
      compactionResult: overflowPending
        ? finalizeOverflowCompaction(
            toolUseContext,
            overflowPending,
            compactionResult,
          )
        : compactionResult,
      // Reset failure count on success
      consecutiveFailures: 0,
    }
  } catch (error) {
    // 2.1.105: a PreCompact hook block is intentional — continue uncompacted
    // without counting it as a failure (circuit breaker must not trip).
    if (isPreCompactBlockError(error)) {
      logForDebugging(
        `autocompact: compaction blocked by PreCompact hook; continuing uncompacted`,
      )
      // CC 2.1.288 #65 — official TY: `if(V)TY(n,V,{kind:"skipped",reason:"hook_blocked"})`
      if (overflowPending) {
        reportOverflowCompactionNotRun(toolUseContext, overflowPending, {
          kind: 'skipped',
          reason: 'hook_blocked',
        })
      }
      return {
        wasCompacted: false,
        consecutiveFailures: tracking?.consecutiveFailures ?? 0,
      }
    }
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // CC 2.1.288 #65 — official TY failure routing (@209126458 catch block):
    // `Ne=gP(Fe,rR)` (user abort) → failed/aborted (retryable, epoch NOT
    // spent); `ze=V!==void 0&&gP(Fe,u_e)` (too few messages) →
    // failed/too_few_groups; otherwise failed/error.
    if (overflowPending) {
      reportOverflowCompactionNotRun(toolUseContext, overflowPending, {
        kind: 'failed',
        reason: hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)
          ? 'aborted'
          : hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
            ? 'too_few_groups'
            : 'error',
      })
    }
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts.
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
