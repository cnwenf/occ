import type {
  RenderableMessage,
  SystemStopHookSummaryMessage,
} from '../types/message.js'
import {
  sanitizeHookLabel,
  sanitizeStopHookSummary,
} from './stopHookSummarySanitizer.js'

function isLabeledHookSummary(
  msg: RenderableMessage,
): msg is SystemStopHookSummaryMessage {
  return (
    msg.type === 'system' &&
    msg.subtype === 'stop_hook_summary' &&
    // Official 2.1.277 `Xot`: the label check goes through the sanitizer
    // (`T5e(h)!==void 0`) — a missing/non-string/empty-string hookLabel row
    // is treated as unlabeled instead of trusting the raw field.
    sanitizeHookLabel(msg) !== undefined
  )
}

/**
 * Collapses consecutive hook summary messages with the same hookLabel
 * (e.g. PostToolUse) into a single summary. This happens when parallel
 * tool calls each emit their own hook summary.
 */
export function collapseHookSummaries(
  messages: RenderableMessage[],
): RenderableMessage[] {
  const result: RenderableMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (isLabeledHookSummary(msg)) {
      const label = sanitizeHookLabel(msg)
      const group: SystemStopHookSummaryMessage[] = []
      while (i < messages.length) {
        const next = messages[i]!
        if (!isLabeledHookSummary(next) || sanitizeHookLabel(next) !== label)
          break
        group.push(next)
        i++
      }
      if (group.length === 1) {
        result.push(msg)
      } else {
        // Official 2.1.277 `lwe` merge: every folded field is read from the
        // SANITIZED rows (`we=Se.map(s$e)`) — a malformed hookInfos/hookCount
        // in any group member can no longer poison the merged summary or
        // throw. `hasOutput` stays read from the ORIGINAL rows (official
        // `Se.some((Ce)=>Ce.hasOutput)`).
        const sanitized = group.map(sanitizeStopHookSummary)
        result.push({
          ...msg,
          hookCount: sanitized.reduce((sum, m) => sum + m.hookCount, 0),
          hookInfos: sanitized.flatMap(m => m.hookInfos),
          hookErrors: sanitized.flatMap(m => m.hookErrors),
          hookAdditionalContext: sanitized.flatMap(
            m => m.hookAdditionalContext ?? [],
          ),
          preventedContinuation: sanitized.some(m => m.preventedContinuation),
          hasOutput: group.some(m => m.hasOutput),
          // Parallel tool calls' hooks overlap; max is closest to wall-clock.
          totalDurationMs: Math.max(
            ...sanitized.map(m => m.totalDurationMs ?? 0),
          ),
        })
      }
    } else {
      result.push(msg)
      i++
    }
  }

  return result
}
