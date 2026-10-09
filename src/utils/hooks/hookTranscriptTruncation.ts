import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import type { Message } from '../../types/message.js'
import { has1mContext, modelSupports1M } from '../context.js'
import { logForDebugging } from '../debug.js'
import { SYNTHETIC_MODEL, createUserMessage } from '../messages.js'
import { jsonStringify } from '../slowOperations.js'
import { getTokenCountFromUsage } from '../tokens.js'

/**
 * CC 2.1.294 (OCC-150): hook-evaluator transcript truncation.
 *
 * Verbatim port of the official 2.1.292–2.1.294 binary helpers (identical in
 * both; 292 names gfr/pfr/mfr/$pr-equiv, 294 names Hpr/Bpr/$pr — byte-verified
 * from the linux-x64 ELF, s294 chunk):
 *
 * - `Hpr(messages, model, ratio)` → truncateHookTranscript
 * - `$pr(messages)`               → tokenCountFromLastAssistantUsage
 * - `Bpr(turn)`                   → estimateTurnTokens
 * - `t1(messages)`                → groupMessagesIntoTurns
 * - `IO(message)`                 → isVirtualMessage
 * - `b3(content, n)`              → estimateContentTokens
 * - `CIn(block, n)`               → estimateContentBlockTokens
 * - `hd(str, n=4)`                → estimateStringTokens
 * - `Lo(lang)`                    → charsPerTokenForLanguage
 *
 * The Stop/SubagentStop prompt hook feeds the conversation transcript to the
 * evaluator model; without truncation a long session blows the evaluator's
 * context window and the hook dies with "Prompt is too long". The official
 * fix: when the last real assistant usage exceeds `budget = floor(window *
 * ratio)` (window = 1M for [1m]/1M-capable models else 200k, ratio 0.5),
 * keep whole turns from the end while they fit, and prepend a synthetic user
 * message telling the evaluator that the prefix was omitted.
 */

/** Official `KVe` — default evaluator context window (non-1M models). */
const EVALUATOR_CONTEXT_WINDOW = 200_000

/** Official `Mon` — default fraction of the window the transcript may use. */
export const HOOK_TRANSCRIPT_BUDGET_RATIO = 0.5

/** Official constant: images and non-text documents cost a flat estimate. */
const IMAGE_TOKEN_ESTIMATE = 2000

/** Official `hd(e,n=4)` — rough chars→tokens estimate. */
function estimateStringTokens(value: unknown, charsPerToken = 4): number {
  if (typeof value !== 'string') return 0
  return Math.round(value.length / charsPerToken)
}

/** Official `Lo(e)` — denser languages pack more chars per token. */
function charsPerTokenForLanguage(language: string): number {
  switch (language) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/** Official `b3(e,n)` — token estimate for message content (string or blocks). */
function estimateContentTokens(
  content: unknown,
  charsPerToken?: number,
): number {
  if (!content) return 0
  if (typeof content === 'string') return estimateStringTokens(content, charsPerToken)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) total += estimateContentBlockTokens(block, charsPerToken)
  return total
}

/** Official `CIn(e,n)` — per-content-block token estimate (2.1.294 @17301282). */
function estimateContentBlockTokens(
  block: unknown,
  charsPerToken?: number,
): number {
  if (typeof block === 'string') return estimateStringTokens(block, charsPerToken)
  if (typeof block !== 'object' || block === null) return 0
  const b = block as Record<string, any>
  if (b.type === 'text') return estimateStringTokens(b.text, charsPerToken)
  if (
    b.type === 'document' &&
    'source' in b &&
    typeof b.source === 'object' &&
    b.source !== null
  ) {
    const source = b.source as Record<string, any>
    if (source.type === 'text') {
      const language = (b.title as string | undefined)?.split('.').pop()?.toLowerCase() ?? ''
      const languageRate = charsPerTokenForLanguage(language)
      return estimateStringTokens(
        source.data,
        charsPerToken === undefined ? languageRate : Math.min(charsPerToken, languageRate),
      )
    }
    if (source.type === 'content') {
      if (typeof source.content === 'string') return estimateStringTokens(source.content, charsPerToken)
      if (Array.isArray(source.content))
        return estimateContentTokens(
          source.content.filter((entry: unknown) => typeof entry === 'object' && entry !== null),
          charsPerToken,
        )
    }
  }
  if (b.type === 'image' || b.type === 'document') return IMAGE_TOKEN_ESTIMATE
  if (b.type === 'tool_result') return estimateContentTokens(b.content, charsPerToken)
  if (b.type === 'tool_use')
    return estimateStringTokens(b.name + jsonStringify(b.input ?? {}), charsPerToken)
  if (b.type === 'thinking') return estimateStringTokens(b.thinking, charsPerToken)
  if (b.type === 'redacted_thinking') return estimateStringTokens(b.data, charsPerToken)
  return estimateStringTokens(jsonStringify(b), charsPerToken)
}

/** Official `IO(e)` — virtual messages attach to the surrounding turn. */
function isVirtualMessage(message: Message): boolean {
  return (message.type === 'user' || message.type === 'assistant') && message.isVirtual === true
}

/**
 * Official `t1(e)` — group a transcript into turns. A turn starts at each new
 * assistant message id (continuation chunks with the same id and
 * resumed-from-incomplete-thinking rows stay in the current turn); virtual
 * messages always join the current turn.
 */
function groupMessagesIntoTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = []
  let current: Message[] = []
  let lastAssistantId: string | undefined
  for (const message of messages) {
    if (isVirtualMessage(message)) {
      current.push(message)
      continue
    }
    if (
      message.type === 'assistant' &&
      message.message?.id !== lastAssistantId &&
      !message.resumedFromIncompleteThinking &&
      current.length > 0
    ) {
      turns.push(current)
      current = [message]
    } else {
      current.push(message)
    }
    if (message.type === 'assistant') lastAssistantId = message.message?.id
  }
  if (current.length > 0) turns.push(current)
  return turns
}

/**
 * Official `$pr(e)` — token count from the most recent real (non-synthetic,
 * metered) assistant usage record; 0 when the transcript has none.
 * NOTE: OCC messages never carry `isUnmetered` (field absent from OCC's
 * Message type) — the official `!== true` guard is kept for parity and is
 * vacuously true here.
 */
function tokenCountFromLastAssistantUsage(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (
      message.type === 'assistant' &&
      message.message &&
      'usage' in message.message &&
      message.message.model !== SYNTHETIC_MODEL &&
      message.isUnmetered !== true
    ) {
      return getTokenCountFromUsage(
        message.message.usage as Parameters<typeof getTokenCountFromUsage>[0],
      )
    }
  }
  return 0
}

/** Official `Bpr(e)` — estimated tokens for one turn (content-based; other rows by serialized length). */
function estimateTurnTokens(turn: Message[]): number {
  let total = 0
  for (const message of turn)
    total +=
      message.type === 'assistant' || message.type === 'user'
        ? estimateContentTokens(message.message?.content)
        : jsonStringify(message).length / 4
  return Math.ceil(total)
}

/**
 * Official `Hpr(e,n,r=Mon)` — truncate the hook evaluator's transcript copy to
 * `floor(window * ratio)` tokens, keeping whole turns from the end. Returns
 * the input unchanged when it already fits or when nothing would be dropped;
 * otherwise prepends a synthetic user message disclosing the omission.
 */
export function truncateHookTranscript(
  messages: Message[],
  model: string,
  ratio: number = HOOK_TRANSCRIPT_BUDGET_RATIO,
): Message[] {
  // Official: `vu(n)||Yw(n)?1e6:KVe` — [1m] tag or 1M-capable model → 1M.
  const window =
    has1mContext(model) || modelSupports1M(model) ? 1_000_000 : EVALUATOR_CONTEXT_WINDOW
  const budget = Math.floor(window * ratio)
  if (tokenCountFromLastAssistantUsage(messages) <= budget) return messages
  const turns = groupMessagesIntoTurns(messages)
  let accumulated = 0
  let firstKept = turns.length
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens = estimateTurnTokens(turns[i]!)
    // Always keep at least the last turn (official `w<h.length` guard).
    if (firstKept < turns.length && accumulated + turnTokens > budget) break
    accumulated += turnTokens
    firstKept = i
  }
  const kept = turns.slice(firstKept).flat()
  const dropped = messages.length - kept.length
  if (dropped <= 0) return messages
  logForDebugging(
    `Hooks: truncated Stop transcript ${messages.length}→${kept.length} msgs (budget ${budget}, model ${model})`,
  )
  logEvent('tengu_hook_prompt_transcript_truncated', {
    droppedMessages: dropped,
    keptMessages: kept.length,
    budget,
    evaluatorModel:
      model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  return [
    createUserMessage({
      content: `[Earlier conversation truncated to fit the hook evaluator's context window — ${dropped} earlier messages omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`,
    }),
    ...kept,
  ]
}
