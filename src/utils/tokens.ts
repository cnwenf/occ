import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { roughTokenCountEstimationForMessages } from '../services/tokenEstimation.js'
import type { AssistantMessage, ContentItem, Message } from '../types/message.js'
import {
  isCompactBoundaryMessage,
  SYNTHETIC_MESSAGES,
  SYNTHETIC_MODEL,
} from './messages.js'
import { jsonStringify } from './slowOperations.js'

export function getTokenUsage(message: Message): Usage | undefined {
  if (
    message?.type === 'assistant' &&
    message.message &&
    'usage' in message.message &&
    !(
      Array.isArray(message.message.content) &&
      (message.message.content as ContentItem[])[0]?.type === 'text' &&
      SYNTHETIC_MESSAGES.has((message.message.content as Array<ContentItem & { text: string }>)[0]!.text)
    ) &&
    message.message.model !== SYNTHETIC_MODEL
  ) {
    return message.message.usage as Usage
  }
  return undefined
}

/**
 * Get the API response id for an assistant message with real (non-synthetic) usage.
 * Used to identify split assistant records that came from the same API response —
 * when parallel tool calls are streamed, each content block becomes a separate
 * AssistantMessage record, but they all share the same message.id.
 */
function getAssistantMessageId(message: Message): string | undefined {
  if (
    message?.type === 'assistant' &&
    'id' in message.message &&
    message.message.model !== SYNTHETIC_MODEL
  ) {
    return message.message.id
  }
  return undefined
}

/**
 * Calculate total context window tokens from an API response's usage data.
 * Includes input_tokens + cache tokens + output_tokens.
 *
 * This represents the full context size at the time of that API call.
 * Use tokenCountWithEstimation() when you need context size from messages.
 */
export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}

/**
 * Gap-288 #9 — official v2.1.288 token walk-back cluster
 * (`s7n`/`ca`/`pa`/`Dpe`/`Ax`/`Nwt`/`Fwt`/`Am`).
 *
 * v288 walks back past assistant messages whose token usage sums to ZERO
 * (input + cache_creation + cache_read === 0, official `Nwt`) instead of
 * stopping at the first message that merely HAS a `usage` object. A zero-usage
 * reply (e.g. a server-side tool-loop turn reporting 0 top-level tokens) no
 * longer measures as 0 context — which previously let `shouldAutoCompact` skip
 * and the next request hit "Prompt is too long".
 *
 * Symbol map (official → OCC):
 *   s7n = sumInputTokens              Dpe = normalizeUsage
 *   ca  = isSkippedIterationType      pa  = isValidUsageIteration
 *   Ax  = getTokenCountFromUsageNormalized   Nwt = isZeroTokenUsage
 *   Fwt = findTokenAnchor             Am  = tokenCountWithEstimation
 */

/** The four numeric token fields after `Dpe` normalization (all present). */
type NormalizedUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

/**
 * Loose view of a usage object: the Stainless `BetaUsage` type does not yet
 * carry `iterations`, so it is read through this shape (cast like
 * finalContextTokensFromLastResponse / advisor.ts).
 */
type UsageShape = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  iterations?: unknown
}

/**
 * Official `Ae` (the numeric-field validator inside `pa`) is unrecoverable from
 * the binary (minified-name collision); interpreted as a finite-number check,
 * which rejects NaN/Infinity so a malformed iteration cannot poison the sum.
 * DIVERGENCE (documented): exact official `Ae` body unknown.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Official `s7n` — the input-side token sum (input + cache_creation + cache_read). */
function sumInputTokens(usage: NormalizedUsage): number {
  return (
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  )
}

/** Official `ca` — iteration types skipped when normalizing usage. */
function isSkippedIterationType(iteration: unknown): boolean {
  if (typeof iteration !== 'object' || iteration === null) {
    return false
  }
  const { type } = iteration as { type?: unknown }
  return type === 'advisor_message' || type === 'compaction'
}

/** Official `pa` — a valid usage iteration (real message with a non-zero sum). */
function isValidUsageIteration(iteration: unknown): boolean {
  if (typeof iteration !== 'object' || iteration === null) {
    return false
  }
  const n = iteration as Record<string, unknown>
  if (n.type !== 'message' && n.type !== 'fallback_message') {
    return false
  }
  return (
    isFiniteNumber(n.input_tokens) &&
    isFiniteNumber(n.output_tokens) &&
    isFiniteNumber(n.cache_creation_input_tokens) &&
    isFiniteNumber(n.cache_read_input_tokens) &&
    n.input_tokens + n.cache_creation_input_tokens + n.cache_read_input_tokens >
      0
  )
}

/**
 * Official `Dpe` — normalize a usage object. Defaults the four fields to 0;
 * when the top-level input sum is NON-ZERO and `iterations` is present, prefers
 * the last non-skipped valid iteration (server-side tool loops report only the
 * first turn at the top level — the final context window lives in the last
 * iteration). A zero top-level sum returns the base zeros WITHOUT reading
 * iterations — that is exactly the `Nwt` skip case `Fwt` walks past (binary
 * guard verified: `if(s7n(n)===0||!Array.isArray(e.iterations))return n`).
 */
function normalizeUsage(usage: UsageShape): NormalizedUsage {
  const base: NormalizedUsage = {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  }
  if (sumInputTokens(base) === 0 || !Array.isArray(usage.iterations)) {
    return base
  }
  const candidate = usage.iterations.findLast(
    iteration => !isSkippedIterationType(iteration),
  )
  if (!isValidUsageIteration(candidate)) {
    return base
  }
  const normalized = candidate as NormalizedUsage
  return {
    input_tokens: normalized.input_tokens,
    output_tokens: normalized.output_tokens,
    cache_creation_input_tokens: normalized.cache_creation_input_tokens,
    cache_read_input_tokens: normalized.cache_read_input_tokens,
  }
}

/** Official `Ax` — full context tokens from a usage object (normalized input sum + output). */
function getTokenCountFromUsageNormalized(usage: UsageShape): number {
  const normalized = normalizeUsage(usage)
  return sumInputTokens(normalized) + normalized.output_tokens
}

/** Official `Nwt` — true when a usage object carries zero input-side tokens. */
function isZeroTokenUsage(usage: UsageShape): boolean {
  return sumInputTokens(normalizeUsage(usage)) === 0
}

type TokenAnchor = { tokens: number; anchorIndex: number }

/**
 * Official `Fwt` — find the token anchor: walking back from the end, a compact
 * boundary anchors with {tokens:0} (everything before it was summarized away);
 * otherwise the last assistant message with NON-ZERO usage anchors, extended
 * back over same-`message.id` sibling records (parallel-tool-call splits) so
 * every interleaved tool_result lands in the estimation slice.
 */
function findTokenAnchor(messages: readonly Message[]): TokenAnchor | null {
  let n = messages.length - 1
  while (n >= 0) {
    const message = messages[n]
    if (message && isCompactBoundaryMessage(message)) {
      return { tokens: 0, anchorIndex: n }
    }
    const usage = message ? getTokenUsage(message) : undefined
    if (message && usage && !isZeroTokenUsage(usage as UsageShape)) {
      const responseId = getAssistantMessageId(message)
      if (responseId) {
        let h = n - 1
        while (h >= 0) {
          const prior = messages[h]
          const priorId = prior ? getAssistantMessageId(prior) : undefined
          if (priorId === responseId) {
            n = h
          } else if (priorId !== undefined) {
            break
          }
          h--
        }
      }
      return {
        tokens: getTokenCountFromUsageNormalized(usage as UsageShape),
        anchorIndex: n,
      }
    }
    n--
  }
  return null
}

export function tokenCountFromLastAPIResponse(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return getTokenCountFromUsage(usage)
    }
    i--
  }
  return 0
}

/**
 * Final context window size from the last API response's usage.iterations[-1].
 * Used for task_budget.remaining computation across compaction boundaries —
 * the server's budget countdown is context-based, so remaining decrements by
 * the pre-compact final window, not billing spend. See monorepo
 * api/api/sampling/prompt/renderer.py:292 for the server-side computation.
 *
 * Falls back to top-level input_tokens + output_tokens when iterations is
 * absent (no server-side tool loops, so top-level usage IS the final window).
 * Both paths exclude cache tokens to match #304930's formula.
 */
export function finalContextTokensFromLastResponse(
  messages: Message[],
): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      // Stainless types don't include iterations yet — cast like advisor.ts:43
      const iterations = (
        usage as {
          iterations?: Array<{
            input_tokens: number
            output_tokens: number
          }> | null
        }
      ).iterations
      if (iterations && iterations.length > 0) {
        const last = iterations.at(-1)!
        return last.input_tokens + last.output_tokens
      }
      // No iterations → no server tool loop → top-level usage IS the final
      // window. Match the iterations path's formula (input + output, no cache)
      // rather than getTokenCountFromUsage — #304930 defines final window as
      // non-cache input + output. Whether the server's budget countdown
      // (renderer.py:292 calculate_context_tokens) counts cache the same way
      // is an open question; aligning with the iterations path keeps the two
      // branches consistent until that's resolved.
      return usage.input_tokens + usage.output_tokens
    }
    i--
  }
  return 0
}

/**
 * Get only the output_tokens from the last API response.
 * This excludes input context (system prompt, tools, prior messages).
 *
 * WARNING: Do NOT use this for threshold comparisons (autocompact, session memory).
 * Use tokenCountWithEstimation() instead, which measures full context size.
 * This function is only useful for measuring how many tokens Claude generated
 * in a single response, not how full the context window is.
 */
export function messageTokenCountFromLastAPIResponse(
  messages: Message[],
): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return usage.output_tokens
    }
    i--
  }
  return 0
}

export type ContextUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export function getCurrentUsage(messages: Message[]): ContextUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      }
    }
  }
  return null
}

/**
 * Memoized context-usage read for the context-usage indicator (StatusLine).
 *
 * 2.1.203 perf fix: the context-usage indicator no longer re-analyzes the
 * transcript after every turn. StatusLine re-runs its update callback on
 * refresh-interval ticks, permission-mode changes, and model changes — all
 * of which can fire while the transcript is unchanged. Without a cache, each
 * of those ticks re-walked the message array to re-derive the same usage.
 *
 * Cache key = (messageCount, lastAssistantMessageId): the usage the
 * indicator displays comes from the last usage-bearing assistant message,
 * so when both the message count and the last assistant id are stable the
 * result is guaranteed identical. Recomputes only when the transcript
 * actually changes.
 */
let _contextUsageCacheKey: string | null = null
let _contextUsageCacheValue: ContextUsage | null = null

export function getCachedContextUsage(
  messages: Message[],
  lastAssistantMessageId: string | null,
): ContextUsage | null {
  const key = `${messages.length}:${lastAssistantMessageId ?? ''}`
  if (key === _contextUsageCacheKey) {
    return _contextUsageCacheValue
  }
  _contextUsageCacheKey = key
  _contextUsageCacheValue = getCurrentUsage(messages)
  return _contextUsageCacheValue
}

/** Reset the context-usage memo cache. For unit tests only. */
export function _resetContextUsageCacheForTesting(): void {
  _contextUsageCacheKey = null
  _contextUsageCacheValue = null
}

export function doesMostRecentAssistantMessageExceed200k(
  messages: Message[],
): boolean {
  const THRESHOLD = 200_000

  const lastAsst = messages.findLast(m => m.type === 'assistant')
  if (!lastAsst) return false
  const usage = getTokenUsage(lastAsst)
  return usage ? getTokenCountFromUsage(usage) > THRESHOLD : false
}

/**
 * Calculate the character content length of an assistant message.
 * Used for spinner token estimation (characters / 4 ≈ tokens).
 * This is used when subagent streaming events are filtered out and we
 * need to count content from completed messages instead.
 *
 * Counts the same content that handleMessageFromStream would count via deltas:
 * - text (text_delta)
 * - thinking (thinking_delta)
 * - redacted_thinking data
 * - tool_use input (input_json_delta)
 * Note: signature_delta is excluded from streaming counts (not model output).
 */
export function getAssistantMessageContentLength(
  message: AssistantMessage,
): number {
  let contentLength = 0
  const content = message.message?.content
  if (!Array.isArray(content)) return contentLength
  for (const block of content as ContentItem[]) {
    if (block.type === 'text') {
      contentLength += (block as ContentItem & { text: string }).text.length
    } else if (block.type === 'thinking') {
      contentLength += (block as ContentItem & { thinking: string }).thinking.length
    } else if (block.type === 'redacted_thinking') {
      contentLength += (block as ContentItem & { data: string }).data.length
    } else if (block.type === 'tool_use') {
      contentLength += jsonStringify((block as ContentItem & { input: unknown }).input).length
    }
  }
  return contentLength
}

/**
 * Get the current context window size in tokens.
 *
 * This is the CANONICAL function for measuring context size when checking
 * thresholds (autocompact, session memory init, etc.). Uses the last API
 * response's token count (input + output + cache) plus estimates for any
 * messages added since.
 *
 * Always use this instead of:
 * - Cumulative token counting (which double-counts as context grows)
 * - messageTokenCountFromLastAPIResponse (which only counts output_tokens)
 * - tokenCountFromLastAPIResponse (which doesn't estimate new messages)
 *
 * Implementation note on parallel tool calls: when the model makes multiple
 * tool calls in one response, the streaming code emits a SEPARATE assistant
 * record per content block (all sharing the same message.id and usage), and
 * the query loop interleaves each tool_result immediately after its tool_use.
 * So the messages array looks like:
 *   [..., assistant(id=A), user(result), assistant(id=A), user(result), ...]
 * If we stop at the LAST assistant record, we only estimate the one tool_result
 * after it and miss all the earlier interleaved tool_results — which will ALL
 * be in the next API request. To avoid undercounting, findTokenAnchor walks
 * back to the FIRST sibling with the same message.id so every interleaved
 * tool_result is included in the rough estimate.
 *
 * Gap-288 #9 (official `Am`): the anchor is found by `findTokenAnchor`
 * (official `Fwt`), which SKIPS zero-usage assistant messages and handles the
 * compact-boundary case; when no anchor exists (no real usage, no boundary) it
 * falls back to a rough estimate over the whole transcript.
 */
export function tokenCountWithEstimation(messages: readonly Message[]): number {
  const anchor = findTokenAnchor(messages)
  if (!anchor) {
    return roughTokenCountEstimationForMessages(
      messages as Parameters<typeof roughTokenCountEstimationForMessages>[0],
    )
  }
  return (
    anchor.tokens +
    roughTokenCountEstimationForMessages(
      messages.slice(
        anchor.anchorIndex + 1,
      ) as Parameters<typeof roughTokenCountEstimationForMessages>[0],
    )
  )
}
