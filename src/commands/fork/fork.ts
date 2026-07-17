import { randomUUID } from 'crypto'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  getTranscriptPathForSession,
  saveCustomTitle,
} from '../../utils/sessionStorage.js'
import { deriveForkName } from './name.js'
import { writeForkPointer } from './pointer.js'

/**
 * /fork — spawn a background agent that inherits the full conversation.
 *
 * 2.1.118: writes a `fork-context-ref` POINTER to the fork's session file and
 * hydrates the prefix on demand (see ./pointer.ts), instead of copying the
 * full parent conversation. The fork inherits the parent's conversation
 * context but keeps its tool output out of the parent's context.
 *
 * 2.1.212 delta: the fork is now a named, recognizable row in the agent view.
 * A `custom-title` entry (the `custom-title` field at binary offset 135647888,
 * sibling of the `Forked session` + ` (fork)` output strings) is written to
 * the fork's session file, named after the directive (or the first prompt
 * when the session has no title) via `deriveForkName` — changelog P2 #39. The
 * in-session output gains the ` (fork)` suffix: `Forked session <id> (fork)`.
 *
 * Official error when there is no first turn:
 *   "Cannot fork before the first conversation turn"
 */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
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
  const forkPath = getTranscriptPathForSession(forkedSessionId)
  await writeForkPointer({
    forkedSessionId,
    parentSessionId: getSessionId(),
    parentLastUuid: lastChain.uuid,
    agentId: context.agentId,
  })
  // 2.1.212: name the fork after the directive (or first prompt) and write a
  // `custom-title` entry so the fork is a recognizable row in the agent view.
  // `source: 'auto'` — derived (non-user) title, mirrors the official
  // `deriveForkName` + `custom-title` field in the 2.1.212 binary.
  const forkName = deriveForkName(args, messages)
  await saveCustomTitle(forkedSessionId, forkName, forkPath, 'auto')
  onDone(`Forked session ${forkedSessionId} (fork)`, { display: 'system' })
  return null
}
