/**
 * Reactive compaction — WP-B (triage-T1.md Item 5, official v311
 * compact-after-long-context-refusal) + the dormant prompt-too-long reactive
 * path previously held by an auto-generated stub.
 *
 * Official v311 evidence (linux-x64 ELF, /tmp/cc-diff-311/v311/package/claude,
 * byte-verified via grep -aboF + dd):
 *   - z_e @250065637 — refusal text predicate over BOTH official strings.
 *   - SHr @250065765 — `fBe()&&e.isApiErrorMessage===!0&&e.errorDetails!==
 *     void 0&&z_e(e.errorDetails)`.
 *   - bd @257405921 — withhold detector: assistant + SHr + `contextWindow<=g6`
 *     (g6=200000 @242280618) + !RTt + aYn({hasAttempted:!1,querySource,
 *     aborted:!1}) + v6s(); try/catch → outcome "check_threw".
 *   - aYn @250564537 — `!hasAttempted && source!=="compact" (Qjt) &&
 *     !G2e(source) && of() && T$() && !aborted`; G2e set @248136498 =
 *     {prompt_suggestion, away_summary, agent_summary, hook_prompt}.
 *   - Latch @250042112 — first refusal clamps: `Ods(!0),
 *     a("tengu_1m_credits_clamp_activated",{})`.
 *   - Post-loop outcomes @257505460-257509900 — rapid_refill_breaker (yHr
 *     trips at >=3) / too_few_groups (aWs ≡ Tyt(e).length<2, Tyt=Gq over
 *     non-progress messages, Gq @250532078 starts a group per new assistant
 *     message.id) / aborted / still_refused @257509841 / not_compacted
 *     @257509857; success logs the bare event and transitions with
 *     `{reason:"reactive_compact_retry"}`.
 *
 * OCC deviations (see the WP-B final report):
 *   - The fBe() latch precondition of SHr is modeled by the `errorDetails`
 *     provenance marker that errors.ts's 1M-credits region attaches (only the
 *     API error handler sets it) — errors.ts stays free of new imports and the
 *     errors↔compact graph acyclic. The clamp latch itself lives here and is
 *     set (with the official event) on first detection.
 *   - RTt (true-1M-session check @242282843) omitted — redundant with the
 *     contextWindow<=200000 gate under OCC's single window source.
 *   - rapid_refill_breaker stays structurally wired (callers pass
 *     consecutiveRapidRefills) but OCC has no rapid-refill breaker, so the
 *     count is always 0 and the outcome is unreachable in practice.
 *   - hasPrecomputedSwap (official aYn disjunct) has no OCC counterpart —
 *     reduces to the !G2e(source) leg.
 */

import { APIUserAbortError } from '@anthropic-ai/sdk'

import type { AssistantMessage, Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { isPromptTooLongMessage } from '../api/errors.js'
import { isAutoCompactEnabled } from './autoCompact.js'
import { compactConversation, type CompactionResult } from './compact.js'

/** Official g6 @242280618 (`wot=200000,g6=200000,SK=1e6`). */
export const STANDARD_CONTEXT_WINDOW_TOKENS = 200000

/** Official yHr: the breaker trips at 3 consecutive rapid refills. */
export const RAPID_REFILL_BREAKER_THRESHOLD = 3

/** Official aWs @257506766 region: `Tyt(e).length<2` → too_few_groups. */
export const MIN_COMPACT_ROUND_GROUPS = 2

/** Official z_e @250065637 — both refusal strings, verbatim. */
const LONG_CONTEXT_CREDITS_REFUSAL_STRINGS = [
  'Extra usage is required for long context',
  'Usage credits are required for long context',
] as const

/** Official G2e @248136498 — sources excluded from reactive compaction. */
const REFUSAL_COMPACT_EXCLUDED_SOURCES: ReadonlySet<string> = new Set([
  'prompt_suggestion',
  'away_summary',
  'agent_summary',
  'hook_prompt',
])

/** Telemetry outcomes, verbatim from the official post-loop block. */
export type CompactAfterLongContextRefusalOutcome =
  | 'rapid_refill_breaker'
  | 'too_few_groups'
  | 'aborted'
  | 'still_refused'
  | 'not_compacted'

export type CompactAfterRefusalAttempt =
  | { kind: 'compacted'; result: CompactionResult }
  | { kind: 'skipped'; outcome: CompactAfterLongContextRefusalOutcome }

// ── Account clamp latch (official fBe/Ods @238772500/@250042112) ────────────

let longContext1mCreditsBlocked = false

export function isLongContext1mCreditsBlocked(): boolean {
  return longContext1mCreditsBlocked
}

export function markLongContext1mCreditsBlocked(): void {
  if (longContext1mCreditsBlocked) {
    return
  }
  longContext1mCreditsBlocked = true
  logEvent('tengu_1m_credits_clamp_activated', {})
}

/** Test-only reset — the official latch is process-lifetime scoped. */
export function resetLongContext1mCreditsBlocked(): void {
  longContext1mCreditsBlocked = false
}

// ── Detection (official z_e / SHr / aYn / bd) ────────────────────────────────

export function isLongContextCreditsRefusalText(text: string): boolean {
  return LONG_CONTEXT_CREDITS_REFUSAL_STRINGS.some(refusal =>
    text.includes(refusal),
  )
}

/**
 * Official SHr @250065765. The `fBe()` latch precondition is modeled by the
 * errorDetails provenance marker: only errors.ts's 1M-credits region attaches
 * the raw refusal text to an isApiErrorMessage assistant message.
 */
export function isLongContextCreditsRefusalMessage(message: Message): boolean {
  if (message.type !== 'assistant') {
    return false
  }
  if (message.isApiErrorMessage !== true) {
    return false
  }
  const details = (message as Message & { errorDetails?: unknown }).errorDetails
  return typeof details === 'string' && isLongContextCreditsRefusalText(details)
}

/** Official aYn @250564537 (hasPrecomputedSwap leg reduced — see header). */
export function isCompactAfterRefusalGateOpen(params: {
  hasAttempted: boolean
  querySource: string
  aborted: boolean
}): boolean {
  if (params.hasAttempted || params.aborted) {
    return false
  }
  // Official Qjt: the compact query source never reactively compacts.
  if (params.querySource === 'compact') {
    return false
  }
  if (REFUSAL_COMPACT_EXCLUDED_SOURCES.has(params.querySource)) {
    return false
  }
  // Official of(): auto-compact enabled config check.
  if (!isAutoCompactEnabled()) {
    return false
  }
  // Official T$(): remote sessions need tengu_reactive_compact_remote
  // (default false); local sessions pass.
  if (process.env.CLAUDE_CODE_REMOTE) {
    return getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_reactive_compact_remote',
      false,
    )
  }
  return true
}

/**
 * Official bd @257405921 — should the stream loop WITHHOLD this refusal
 * (`Jt=!0,ss=I`) so the post-loop compact-and-continue path can recover?
 * Never throws: the official try/catch logs outcome "check_threw" and
 * returns false.
 */
export function shouldWithholdLongContextCreditsRefusal(params: {
  message: Message
  contextWindow: number
  querySource: string
}): boolean {
  try {
    const shouldWithhold =
      isLongContextCreditsRefusalMessage(params.message) &&
      params.contextWindow <= STANDARD_CONTEXT_WINDOW_TOKENS &&
      isCompactAfterRefusalGateOpen({
        hasAttempted: false,
        querySource: params.querySource,
        aborted: false,
      }) &&
      // Official v6s @248135802 — kill-switch, default true.
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_linked_rose', true)
    if (shouldWithhold) {
      // ≡ Ods(!0) @250042112 — first refusal clamps the account latch.
      markLongContext1mCreditsBlocked()
    }
    return shouldWithhold
  } catch (error) {
    logEvent('tengu_compact_after_long_context_refusal', {
      outcome:
        'check_threw' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    logError(error)
    return false
  }
}

// ── Round-group counting (official Tyt/Gq @250532078) ────────────────────────

/**
 * Counts API-round groups the way official Gq does: progress messages are
 * filtered out first (Tyt), and an assistant message with a NEW message.id
 * closes the pending group (when non-empty) and starts a new one.
 */
export function countCompactRoundGroups(messages: Message[]): number {
  let groups = 0
  let lastAssistantId: string | undefined
  for (const message of messages) {
    if (message.type === 'progress') {
      continue
    }
    if (message.type === 'assistant') {
      const id = (message as AssistantMessage).message?.id
      // A NEW assistant message.id (after one was already seen) closes the
      // previous round and opens the next group — the official Gq boundary.
      if (lastAssistantId !== undefined && id !== lastAssistantId) {
        groups += 1
      }
      lastAssistantId = id
    }
    // The first non-progress message lazily opens group one.
    if (groups === 0) {
      groups = 1
    }
  }
  return groups
}

// ── Outcome classifiers (official post-loop block @257505460+) ───────────────

/**
 * Pre-attempt skips, in official order: rapid_refill_breaker (`!Zo&&at.action
 * ==="trip"`) → aborted → too_few_groups (`aYn({hasAttempted})&&aWs(H)`).
 * Undefined means "proceed to the compaction attempt".
 */
export function classifyCompactRefusalPrecheck(params: {
  hasAttempted: boolean
  aborted: boolean
  consecutiveRapidRefills: number
  roundGroups: number
}): CompactAfterLongContextRefusalOutcome | undefined {
  if (
    !params.hasAttempted &&
    params.consecutiveRapidRefills >= RAPID_REFILL_BREAKER_THRESHOLD
  ) {
    return 'rapid_refill_breaker'
  }
  if (params.aborted) {
    return 'aborted'
  }
  if (!params.hasAttempted && params.roundGroups < MIN_COMPACT_ROUND_GROUPS) {
    return 'too_few_groups'
  }
  return undefined
}

/** Official failure tail: `m(...,Ee?"still_refused":"not_compacted")`. */
export function classifyCompactRefusalFailure(params: {
  aborted: boolean
  hasAttempted: boolean
}): CompactAfterLongContextRefusalOutcome {
  if (params.aborted) {
    return 'aborted'
  }
  return params.hasAttempted ? 'still_refused' : 'not_compacted'
}

// ── The compaction attempt ───────────────────────────────────────────────────

export type CompactAfterRefusalParams = {
  hasAttempted: boolean
  querySource: string
  aborted: boolean
  /** OCC has no rapid-refill breaker — callers pass 0 (see header). */
  consecutiveRapidRefills: number
  messages: Message[]
  cacheSafeParams: CacheSafeParams
  customInstructions?: string
}

export type CompactAfterRefusalDeps = {
  compact?: typeof compactConversation
}

/**
 * Runs the prechecks, the gate, then ONE compaction attempt with the official
 * argument tuple (suppressFollowUpQuestions=true, isAutoCompact=true,
 * thresholdSource=undefined → compactionRequestKind 'reactive'). All failures
 * collapse to skipped outcomes — callers surface the withheld refusal.
 */
export async function tryCompactAfterLongContextRefusal(
  params: CompactAfterRefusalParams,
  deps: CompactAfterRefusalDeps = {},
): Promise<CompactAfterRefusalAttempt> {
  const precheck = classifyCompactRefusalPrecheck({
    hasAttempted: params.hasAttempted,
    aborted: params.aborted,
    consecutiveRapidRefills: params.consecutiveRapidRefills,
    roundGroups: countCompactRoundGroups(params.messages),
  })
  if (precheck !== undefined) {
    return { kind: 'skipped', outcome: precheck }
  }
  const failureOutcome = classifyCompactRefusalFailure({
    aborted: false,
    hasAttempted: params.hasAttempted,
  })
  if (
    !isCompactAfterRefusalGateOpen({
      hasAttempted: params.hasAttempted,
      querySource: params.querySource,
      aborted: params.aborted,
    })
  ) {
    return { kind: 'skipped', outcome: failureOutcome }
  }
  const compact = deps.compact ?? compactConversation
  try {
    const result = await compact(
      params.messages,
      params.cacheSafeParams.toolUseContext,
      params.cacheSafeParams,
      true,
      params.customInstructions,
      true,
      undefined,
      undefined,
    )
    if (!result) {
      return { kind: 'skipped', outcome: failureOutcome }
    }
    return { kind: 'compacted', result }
  } catch (error) {
    if (
      error instanceof APIUserAbortError ||
      params.cacheSafeParams.toolUseContext.abortController.signal.aborted
    ) {
      return { kind: 'skipped', outcome: 'aborted' }
    }
    logError(error)
    return { kind: 'skipped', outcome: failureOutcome }
  }
}

// ── Dormant prompt-too-long reactive path (un-stubbed) ───────────────────────

/**
 * Un-stub of the dormant REACTIVE_COMPACT-gated predicate: the official
 * isWithheldPromptTooLong withholds an API-error assistant message whose text
 * is the prompt-too-long sentinel, so the post-loop reactive compact can
 * recover it (query.ts's dormant branch).
 */
export function isWithheldPromptTooLong(message: Message): boolean {
  return (
    message.type === 'assistant' &&
    message.isApiErrorMessage === true &&
    isPromptTooLongMessage(message as AssistantMessage)
  )
}

/**
 * Un-stub of the dormant REACTIVE_COMPACT-gated reactive compact (official
 * lYn): gate + ONE compaction attempt, null on any failure. Same core as the
 * credits path minus the credits-specific rapid-refill precheck input.
 */
export async function tryReactiveCompact(params: {
  hasAttempted: boolean
  querySource: string
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}): Promise<CompactionResult | null> {
  const attempt = await tryCompactAfterLongContextRefusal({
    ...params,
    consecutiveRapidRefills: 0,
  })
  return attempt.kind === 'compacted' ? attempt.result : null
}

/**
 * Un-stub for the /compact command's reactive-only mode (dormant behind
 * feature('REACTIVE_COMPACT')). Reason strings match the consumer switch in
 * src/commands/compact/compact.ts.
 */
export async function reactiveCompactOnPromptTooLong(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  options: { customInstructions?: string; trigger?: string } = {},
): Promise<{
  ok: boolean
  reason?: 'too_few_groups' | 'aborted' | 'exhausted' | 'error' | 'media_unstrippable'
  result?: CompactionResult
}> {
  const attempt = await tryCompactAfterLongContextRefusal({
    hasAttempted: false,
    querySource: 'repl_main_thread',
    aborted: false,
    consecutiveRapidRefills: 0,
    messages,
    cacheSafeParams,
    customInstructions: options.customInstructions,
  })
  if (attempt.kind === 'compacted') {
    return { ok: true, result: attempt.result }
  }
  if (attempt.outcome === 'aborted') {
    return { ok: false, reason: 'aborted' }
  }
  if (attempt.outcome === 'too_few_groups') {
    return { ok: false, reason: 'too_few_groups' }
  }
  return { ok: false, reason: 'error' }
}

// ── Out-of-scope stubs (unchanged semantics) ─────────────────────────────────

/** Media-size recovery is out of WP-B scope — stays disabled. */
export const isWithheldMediaSizeError: (message?: Message) => boolean = () =>
  false

/** Reactive-only mode (CLAUDE_CODE_REMOTE) is not shipped by OCC. */
export const isReactiveOnlyMode: () => boolean = () => false

/**
 * The feature('REACTIVE_COMPACT') gated require in query.ts /
 * commands/compact stays dormant in the shipped build (REACTIVE_COMPACT ∉
 * FEATURE_ALLOWLIST); the credits-refusal path above is the live one and is
 * imported statically.
 */
export const isReactiveCompactEnabled: () => boolean = () => false
