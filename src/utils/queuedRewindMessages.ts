/**
 * CC 2.1.290 — `/rewind` lists prompts queued while Claude was still working.
 *
 * Byte-faithful port of the official 2.1.290/2.1.291 `LMe` transform
 * (changelog-entries-290.txt:20: "Fixed `/rewind` not listing a prompt sent
 * while Claude was still working"). Official symbol map (linux-x64 ELF):
 *
 *   LMe(h) @232117xxx (NEW in 290; cc289 `vht` @228917878 passed messages
 *     straight through):
 *       function LMe(h){let k=new Set;for(let J of h)if(J.type==="user")
 *       k.add(J.uuid);let N=!1,H=h.map((J,he)=>{...});return N?H:h}
 *     — maps undelivered queued_command prompt attachments into virtual user
 *     messages, dedups by uuid against existing user rows, identity-returns
 *     the input array when nothing changed.
 *   Rln(e,o) @217805353 (NEW, exported): attachment →
 *     {uuid: source_uuid || row uuid, content: prompt, isMeta, origin:
 *     b3(origin, commandMode)}; skips forwarded-intent attachments (`yte`).
 *   tU(e) @204690011: queued_command branch =
 *     e.attachment.type==="queued_command" && n_(e.attachment.origin) &&
 *     e.attachment.verifiedSlackHumanTurn!==!0 (try/catch → false).
 *   n_(e) @204689971: e?.kind==="human" — strict; the official enqueue path
 *     stamps origin:{kind:"human"} on keyboard prompts (@232019514
 *     `uuid:so,origin:{kind:"human"}`).
 *   nNe(h,he) @229151684 (NEW): tool_use/tool_result split guard for IN-PLACE
 *     synthesis — N/A for OCC (see adaptation note below), so not ported.
 *   Content guard: Array.isArray(content) && some(block => typeof block !==
 *     "object" || block === null) → skip.
 *   Re(...) = createUserMessage({content, uuid, timestamp, imagePasteIds,
 *     origin}) — the synthesized virtual row factory.
 *   Restore chain: xMe @232103682 (lastIndexOf → i2r uuid fallback),
 *     i2r @210039574 (findIndex row.uuid → findIndex E(row)=source_uuid),
 *     E/G @210039160 (queued_command attachment source_uuid reader) — the
 *     official resolves a restore onto the synthesized row's uuid back to the
 *     attachment row, truncates the transcript there (which CONSUMES the
 *     queued prompt) and prefills the draft with its text.
 *
 * OCC adaptation (structural, behavior-identical):
 *   - OCC keeps queued prompts in the module-level `commandQueue`
 *     (messageQueueManager.ts), not transcript attachment rows. The transform
 *     therefore APPENDS synthesized rows after the real messages — queued
 *     prompts are always newer than every transcript row. Because synthesis
 *     never lands mid-array, the official `nNe` tool-call-split guard is
 *     structurally inapplicable and omitted.
 *   - OCC's QueuedCommand convention is `origin === undefined` = human
 *     (keyboard) — see textInputTypes.ts. The official stamps
 *     {kind:"human"} at enqueue instead; undefined maps onto that stamp.
 *     `bridgeOrigin: true` (OCC's structural marker for remote-sourced
 *     input, which the official excludes via its strict n_ origin check)
 *     is excluded as well.
 *   - `verifiedSlackHumanTurn` and `forwardedIntent` (yte) have no OCC
 *     counterpart (Slack / remote-intent machinery) — N/A.
 *   - OCC queue entries carry no timestamp; createUserMessage defaults to
 *     now, which is chronologically correct for an undelivered prompt.
 *   - Restore consumption: the official truncation removes the attachment
 *     row (dequeuing the prompt). The OCC equivalent removes the queue entry
 *     via `findQueuedCommandForMessage` + messageQueueManager `remove()` in
 *     the RewindMessageSelector wrapper (nSt analogue), then the standard
 *     handleRestoreMessage path prefills the draft (rewindConversationTo's
 *     lastIndexOf is -1 for a synthesized row → no transcript truncation,
 *     which is correct: nothing after the queued prompt was delivered).
 */
import type { Message, MessageOrigin } from '../types/message.js'
import {
  getImagePasteIds,
  type QueuedCommand,
} from '../types/textInputTypes.js'
import { createUserMessage } from './messages.js'

/**
 * Synthesized-row → queue-entry side table (official resolves via the
 * attachment row's source_uuid; OCC queue entries may lack a uuid, so the
 * mapping is kept by object identity). WeakMap: no retention of rewound
 * rows, no mutation of the message objects.
 */
const queuedCommandBySyntheticMessage = new WeakMap<Message, QueuedCommand>()

/**
 * Official `n_(e){return e?.kind==="human"}` @204689971, adapted to OCC's
 * `undefined = human (keyboard)` QueuedCommand origin convention.
 */
function isHumanQueueOrigin(origin: MessageOrigin | undefined): boolean {
  if (origin === undefined || origin === null) return true
  if (typeof origin !== 'object') return false
  return (origin as { kind?: unknown }).kind === 'human'
}

/**
 * Official `tU(e)` @204690011 (queued_command branch) + the LMe
 * `commandMode!=="prompt"` and `Se.isMeta` skips, folded into one predicate.
 */
function isListableQueuedPrompt(cmd: QueuedCommand): boolean {
  try {
    return (
      cmd.mode === 'prompt' &&
      !cmd.isMeta &&
      !cmd.bridgeOrigin &&
      isHumanQueueOrigin(cmd.origin)
    )
  } catch {
    return false
  }
}

/** Official LMe content guard: array content with a non-object/null block. */
function hasMalformedContent(value: QueuedCommand['value']): boolean {
  return (
    Array.isArray(value) &&
    value.some(block => typeof block !== 'object' || block === null)
  )
}

/**
 * Official `LMe(h)` — returns `messages` extended with virtual user rows for
 * every undelivered human-typed queued prompt, or the IDENTICAL array
 * reference when nothing qualifies (official `return N?H:h`).
 */
export function withQueuedPromptMessages(
  messages: Message[],
  queue: readonly QueuedCommand[],
): Message[] {
  if (queue.length === 0) return messages

  // Official: let k=new Set; for(let J of h) if(J.type==="user") k.add(J.uuid)
  const userUuids = new Set<string>()
  for (const message of messages) {
    if (message.type === 'user') userUuids.add(message.uuid)
  }

  const synthesized: Message[] = []
  for (const cmd of queue) {
    if (!isListableQueuedPrompt(cmd)) continue
    if (hasMalformedContent(cmd.value)) continue
    // Official dedup: k.has(Se.uuid) — a prompt delivered while the selector
    // was open already exists as a real user row; skip (and k.add after).
    if (cmd.uuid !== undefined && userUuids.has(cmd.uuid)) continue

    const message = createUserMessage({
      content: cmd.value,
      ...(cmd.uuid !== undefined && { uuid: cmd.uuid }),
      imagePasteIds: getImagePasteIds(cmd.pastedContents),
      origin: cmd.origin,
    })
    userUuids.add(message.uuid)
    queuedCommandBySyntheticMessage.set(message, cmd)
    synthesized.push(message)
  }

  return synthesized.length > 0 ? [...messages, ...synthesized] : messages
}

/**
 * The queue entry a synthesized virtual row was created from (undefined for
 * real transcript messages). The RewindMessageSelector restore path uses
 * this to consume the queued prompt — the OCC equivalent of the official
 * transcript truncation removing the queued_command attachment row.
 */
export function findQueuedCommandForMessage(
  message: Message,
): QueuedCommand | undefined {
  return queuedCommandBySyntheticMessage.get(message)
}
