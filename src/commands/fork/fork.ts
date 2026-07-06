import { randomUUID } from 'crypto'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import { writeForkPointer } from './pointer.js'

/**
 * /fork — spawn a background agent that inherits the full conversation.
 *
 * 2.1.118: writes a `fork-context-ref` POINTER to the fork's session file and
 * hydrates the prefix on demand (see ./pointer.ts), instead of copying the
 * full parent conversation. The fork inherits the parent's conversation
 * context but keeps its tool output out of the parent's context.
 *
 * Official error when there is no first turn:
 *   "Cannot fork before the first conversation turn"
 */
export const call: LocalJSXCommandCall = async (onDone, context, _args) => {
  const messages = context.messages
  // The fork branches from the last chain-participant message.
  const lastChain = [...messages].reverse().find((m) => m.type !== 'progress')
  if (!lastChain?.uuid) {
    onDone('Cannot fork before the first conversation turn', {
      display: 'system',
    })
    return null
  }
  const forkedSessionId = randomUUID()
  await writeForkPointer({
    forkedSessionId,
    parentSessionId: getSessionId(),
    parentLastUuid: lastChain.uuid,
    agentId: context.agentId,
  })
  onDone(`Forked session ${forkedSessionId}`, { display: 'system' })
  return null
}
