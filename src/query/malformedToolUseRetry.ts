/**
 * B12 (official 2.1.307): unparseable tool-call retry — helper predicates
 * and constants ported byte-faithfully from the official 2.1.307
 * linux-x64 ELF (forensics dump /tmp/cc-diff-308/new307.txt):
 *
 * - `ti`/`df` leaked-invoke prefix + regex @6754500:
 *   `ti="antml:",df=new RegExp("<"+ti+"invoke\\b")`
 * - `iu` last-text-block leaked-invoke detector @6754634:
 *   `function iu(e){let o=e.flatMap((n)=>n.message.content).findLast(
 *    (n)=>n.type==="text")?.text??"";return df.test(o)}`
 * - `cf=2` retry cap + `oi(e){return e<cf}` can-retry @6754634
 * - `au` outcome classifier @6754634:
 *   `function au(e,o,n,r){if(e>0)return"succeeded";if(o==="tool_use"&&!n)
 *    return oi(r)?"malformed_again":"gave_up";if(o==="end_turn")
 *    return"end_turn";return"other"}`
 * - `Mhn` retry meta text @36317850
 * - exhausted error text (inline constant) @44483783
 *
 * The detection condition, tombstoning, retry transition
 * (`malformed_tool_use_retry`), exhausted terminal
 * (`malformed_tool_use_exhausted`), and both telemetry events
 * (`tengu_malformed_tool_use_response` @44483343,
 * `tengu_malformed_tool_use_retry_outcome` @44475072) live in src/query.ts.
 * Upstream changelog 2.1.307: "Improved recovery from unparseable tool
 * calls: Claude Code now retries the call up to twice before ending the
 * turn with an error".
 */

import type { Message } from '../types/message.js'

/** Official `ti` (@6754500) — provider tool-call tag prefix. */
const ANTML_PREFIX = 'antml:'

/** Official `df=new RegExp("<"+ti+"invoke\\b")` (@6754500). */
const LEAKED_INVOKE_RE = new RegExp(`<${ANTML_PREFIX}invoke\\b`)

/** Official `cf=2` (@6754634) — malformed tool call retried up to twice. */
export const MAX_MALFORMED_TOOL_USE_RETRIES = 2

/** Official `Mhn` (@36317850) — byte-exact retry meta message text. */
export const MALFORMED_TOOL_USE_RETRY_TEXT =
  'The previous response failed to produce a valid tool call. Please retry the tool call now.'

/** Official inline constant (@44483783) — byte-exact exhausted error text. */
export const MALFORMED_TOOL_USE_EXHAUSTED_TEXT =
  "The model's tool call could not be parsed (retry also failed)."

/** Official `oi(e){return e<cf}` (@6754634). */
export function canRetryMalformedToolUse(retryCount: number): boolean {
  return retryCount < MAX_MALFORMED_TOOL_USE_RETRIES
}

/**
 * Official `iu(e)` (@6754634) — true when the LAST text block across all of
 * the turn's assistant messages contains a leaked `<antml:invoke` tag (the
 * model emitted the tool call as prose instead of structured blocks).
 * Telemetry field `text_has_leaked_invoke`.
 */
export function textHasLeakedInvoke(assistantMessages: Message[]): boolean {
  const blocks = assistantMessages.flatMap(
    message => (message.message?.content ?? []) as unknown as unknown[],
  )
  const lastText = blocks.findLast(
    block => (block as { type?: string } | null)?.type === 'text',
  ) as { text?: string } | undefined
  return LEAKED_INVOKE_RE.test(lastText?.text ?? '')
}

/**
 * Official `au(e,o,n,r)` (@6754634) — outcome classifier for the
 * `tengu_malformed_tool_use_retry_outcome` event, evaluated on the response
 * that FOLLOWED a `malformed_tool_use_retry` transition:
 *   e = tool_use block count, o = last stop_reason (null default),
 *   n = last message isApiErrorMessage, r = malformedToolUseRetryCount.
 */
export function classifyMalformedToolUseRetryOutcome(
  toolUseBlockCount: number,
  stopReason: string | null,
  isApiErrorMessage: unknown,
  retryCount: number,
): 'succeeded' | 'malformed_again' | 'gave_up' | 'end_turn' | 'other' {
  if (toolUseBlockCount > 0) return 'succeeded'
  if (stopReason === 'tool_use' && !isApiErrorMessage) {
    return canRetryMalformedToolUse(retryCount) ? 'malformed_again' : 'gave_up'
  }
  if (stopReason === 'end_turn') return 'end_turn'
  return 'other'
}
