import { randomUUID } from 'crypto'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  getTranscriptPathForSession,
  saveCustomTitle,
} from '../../utils/sessionStorage.js'
import { deriveForkName } from './name.js'
import { writeForkPointer } from './pointer.js'
import { formatForkConfirmation } from './confirmation.js'

/**
 * /fork — spawn a background agent that inherits the full conversation.
 *
 * 2.1.118: writes a `fork-context-ref` POINTER to the fork's session file and
 * hydrates the prefix on demand (see ./pointer.ts), instead of copying the
 * full parent conversation. The fork inherits the parent's conversation
 * context but keeps its tool output out of the parent's context.
 *
 * 2.1.212 delta: the fork is now a named, recognizable row in the agent view.
 * A `custom-title` entry is written to the fork's session file, named after
 * the directive via `deriveForkName` (the official `uwd`) — changelog P2 #39.
 *
 * 2.1.216 #30: the in-session confirmation is now one line carrying the new
 * session's name, the `claude attach` id, and a note when the copy shares
 * your checkout — see `formatForkConfirmation`. (Replaces the 2.1.212
 * `Forked session <id> (fork)` row.)
 *
 * Mirrors the official `iNy` handler order:
 *  1. directive required — `Usage: /fork <directive>` and exit when absent;
 *  2. fork body — `Cannot fork before the first conversation turn` when there
 *     is no first turn to branch from;
 *  3. write the `fork-context-ref` pointer + the `custom-title` entry;
 *  4. emit the one-line `formatForkConfirmation(…)` row.
 *
 * The `custom-title` `source` follows the official `/branch` `awd`→`wne`
 * contract (`f = s ? "user" : "auto"`): `"user"` when a directive is provided,
 * `"auto"` only when the name is derived (no directive). Because step 1
 * rejects an absent directive, the reachable path is `"user"`; the `"auto"`
 * branch is retained for parity with `awd`.
 */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const directive = (args ?? '').trim()

  // 1. Directive is required (official `iNy`: `if(!n) return Usage`).
  if (!directive) {
    onDone('Usage: /fork <directive>', { display: 'system' })
    return null
  }

  const messages = context.messages
  // 2. The fork branches from the last chain-participant message — there must
  //    be a first turn to fork from.
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

  // 3. Name the fork after the directive (official `uwd`) and write a
  //    `custom-title` entry so the fork is a recognizable row in the agent
  //    view. `source` mirrors `/branch` `awd`'s `f = s ? "user" : "auto"`.
  const forkName = deriveForkName(directive)
  const source = directive ? 'user' : 'auto'
  await saveCustomTitle(forkedSessionId, forkName, forkPath, source)

  // 4. Emit the one-line confirmation (2.1.216 #30): the fork's name, the
  //    `claude attach` id, and a note when the copy shares your checkout.
  //    OCC's /fork does not spin up a separate worktree for the copy (the
  //    live background-session dispatch is deferred — see
  //    docs/upstream-version-gap-occ9.md), so the copy always shares the
  //    parent's checkout and the note is shown.
  const sharesCheckout = true
  onDone(
    formatForkConfirmation(forkName, forkedSessionId, sharesCheckout),
    { display: 'system' },
  )
  return null
}
