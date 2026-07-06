import { generateAwaySummary } from '../../services/awaySummary.js'
import type { LocalCommandCall } from '../../types/command.js'

const NOTHING_TO_RECAP = 'Nothing to recap yet — send a message first.'

/**
 * /recap — generate a one-line session recap on demand.
 *
 * Uses the same away-summary generator as the "while you were away" card
 * (services/awaySummary.ts), invoked manually rather than on terminal blur.
 * Mirrors the official 2.1.x /recap command (thinClientDispatch: "post-text").
 */
export const call: LocalCommandCall = async (_args, context) => {
  const messages = context.messages ?? []
  if (messages.length === 0) {
    return { type: 'text', value: NOTHING_TO_RECAP }
  }

  const signal = context.abortController?.signal ?? new AbortController().signal
  const text = await generateAwaySummary(messages, signal)
  if (!text) {
    return { type: 'text', value: NOTHING_TO_RECAP }
  }
  return { type: 'text', value: text }
}
