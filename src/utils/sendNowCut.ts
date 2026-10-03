/**
 * CC 2.1.288 #59 — send-now cut signal + the `interruptedBySendNow` stamp.
 *
 * "Fixed the 'What should Claude do instead?' hint showing on the Interrupted
 * row after sending queued messages with ctrl+enter."
 *
 * Byte-faithful port of the official v2.1.288 binary logic (all offsets into
 * /tmp/cc-diff-288/v288/package/claude, verified with `dd`):
 *
 *   - `interruptForSubmit` @229515877 — ctrl+enter ("send now") records the
 *     AbortSignal it is about to abort with, BEFORE aborting, so the cut it
 *     causes is distinguishable from a user Esc interrupt:
 *       `this._sendNowCutSignal=h.signal,h.abort(fl("user-cancel"))`
 *     Signal IDENTITY is the discriminator: both paths abort with the same
 *     reason string `"user-cancel"`, so the reason cannot tell them apart.
 *   - `_stampSendNowCut(h,E)` @229515877:
 *       `return E===this._sendNowCutSignal&&h.type==="user"&&
 *               (h.toolUseResult===cZe||rk(h))?{...h,interruptedBySendNow:!0}:h`
 *   - `_applyMessage` @229522066 runs every inbound message through the stamp:
 *       `Pe=this._stampSendNowCut(h,this._snapshot.abortController?.signal)`
 *   - `cZe="User rejected tool use"` @200609235.
 *   - `rk` @200608890 / `Vfe` @200607726 — the interrupt-placeholder predicate:
 *     a user message whose content is a string starting with one of the `Vfe`
 *     prefixes, or an array where EVERY block is `text` (or an errored
 *     `tool_result`) starting with one of them.
 *
 * The stamp is read downstream by the row renderer
 * (`l.interruptedBySendNow===!0` @227595016 → `Lt.Provider` → `La()`
 * @227383175, which drops the hint) — see src/components/InterruptedByUser.tsx.
 *
 * Kept as a standalone pure module (no React) so it is unit-testable in
 * isolation, matching the sendNow.ts / escEscGate.ts convention.
 *
 * OCC divergences (documented — no invented behavior):
 *   - Official's `Vfe` list carries 8 prefixes; 3 of them ("[Tool call did not
 *     complete: …]" and two "[Tool call skipped: …]" variants) have ZERO hits in
 *     the OCC source tree (NO-SURFACE), so OCC's list is the 5 it does emit.
 *   - Official persists the flag through the message splitter `UEr`
 *     (@211321347: `...e.interruptedBySendNow===!0&&{interruptedBySendNow:!0}`).
 *     OCC renders per-content-block from the unsplit message
 *     (src/components/Message.tsx `case "user"`), so no splitter port is needed.
 */

import {
  CANCEL_MESSAGE,
  COPIED_SESSION_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  SESSION_ENDED_MESSAGE,
} from './messages.js'

/** Official `cZe` @200609235 — verbatim. */
export const USER_REJECTED_TOOL_USE = 'User rejected tool use'

let cachedInterruptMessagePrefixes: readonly string[] | null = null

/**
 * Official `Vfe` @200607726 — the interrupt-placeholder prefixes, restricted to
 * the entries OCC actually emits (see the module header for the 3 NO-SURFACE
 * omissions). All strings are reused from src/utils/messages.js so they stay
 * byte-identical to the official texts already verified there.
 *
 * LAZY ON PURPOSE. Building this array at module top level reads the
 * `messages.js` import bindings during this module's own evaluation, and the
 * OCC module graph contains an initialization cycle
 * (`messages.ts` → … → `query.ts` → `sendNowCut.ts` → `messages.ts`), so under
 * bun's ESM load order that read hits the TDZ and throws
 * `Cannot access 'INTERRUPT_MESSAGE' before initialization` — taking down every
 * test whose import chain reaches this file. Reading the live bindings from
 * inside a function defers the access until after all modules have finished
 * evaluating, which is both cycle-safe and exactly what the official predicate
 * does (`Vfe` is only touched when `rk(e)` runs, never at load time).
 */
export function getInterruptMessagePrefixes(): readonly string[] {
  if (cachedInterruptMessagePrefixes === null) {
    cachedInterruptMessagePrefixes = Object.freeze([
      INTERRUPT_MESSAGE,
      INTERRUPT_MESSAGE_FOR_TOOL_USE,
      SESSION_ENDED_MESSAGE,
      COPIED_SESSION_MESSAGE,
      CANCEL_MESSAGE,
    ])
  }
  return cachedInterruptMessagePrefixes
}

/** Minimal structural view of a message the stamp inspects. */
export type StampableMessage = {
  type: string
  toolUseResult?: unknown
  interruptedBySendNow?: boolean
  message?: {
    content?: unknown
    [key: string]: unknown
  }
  [key: string]: unknown
}

type ContentBlockLike = {
  type?: string
  text?: unknown
  content?: unknown
  is_error?: unknown
}

function startsWithInterruptPrefix(value: string): boolean {
  return getInterruptMessagePrefixes().some(prefix => value.startsWith(prefix))
}

/**
 * Official `rk` @200608890 — verbatim structure:
 *   `if(e.type!=="user")return!1;`
 *   `let n=e.message?.content;`
 *   `if(typeof n==="string")return Vfe.some((r)=>n.startsWith(r));`
 *   `if(!Array.isArray(n))return!1;`
 *   `return n.length>0&&n.every((r)=>{ let o=r?.type==="text"?r.text
 *     :r?.type==="tool_result"&&r.is_error===!0?r.content:void 0;
 *     return typeof o==="string"&&Vfe.some((i)=>o.startsWith(i)) })`
 */
export function isInterruptPlaceholderMessage(message: StampableMessage): boolean {
  if (message.type !== 'user') {
    return false
  }
  const content = message.message?.content
  if (typeof content === 'string') {
    return startsWithInterruptPrefix(content)
  }
  if (!Array.isArray(content)) {
    return false
  }
  return (
    content.length > 0 &&
    content.every((block: ContentBlockLike | null | undefined) => {
      const text =
        block?.type === 'text'
          ? block.text
          : block?.type === 'tool_result' && block.is_error === true
            ? block.content
            : undefined
      return typeof text === 'string' && startsWithInterruptPrefix(text)
    })
  )
}

/**
 * The send-now cut signal slot — official `this._sendNowCutSignal`. Created as
 * a factory + a shared default instance so the mutable slot stays isolated and
 * unit-testable (the same shape as heldClearedDraft.ts).
 */
export type SendNowCutSignalStore = {
  /** Official `this._sendNowCutSignal=h.signal` (interruptForSubmit @229515877). */
  stampSignal: (signal: AbortSignal) => void
  /** Official `E===this._sendNowCutSignal`. */
  isCutSignal: (signal: AbortSignal | null | undefined) => boolean
  /** Drops the recorded signal (test/reset affordance; official never clears it). */
  clearSignal: () => void
}

export function createSendNowCutSignalStore(): SendNowCutSignalStore {
  let recordedSignal: AbortSignal | null = null
  return {
    stampSignal(signal: AbortSignal): void {
      recordedSignal = signal
    },
    isCutSignal(signal: AbortSignal | null | undefined): boolean {
      return signal != null && signal === recordedSignal
    },
    clearSignal(): void {
      recordedSignal = null
    },
  }
}

/** The REPL-wide slot — mirrors the official per-runner `_sendNowCutSignal`. */
export const sendNowCutSignalStore: SendNowCutSignalStore =
  createSendNowCutSignalStore()

/** Records the signal a ctrl+enter send-now is about to abort with. */
export function stampSendNowCutSignal(signal: AbortSignal): void {
  sendNowCutSignalStore.stampSignal(signal)
}

/** Whether `signal` is the one the last ctrl+enter send-now cut with. */
export function isSendNowCutSignal(
  signal: AbortSignal | null | undefined,
): boolean {
  return sendNowCutSignalStore.isCutSignal(signal)
}

/** Test/reset affordance for the shared slot. */
export function clearSendNowCutSignal(): void {
  sendNowCutSignalStore.clearSignal()
}

/**
 * Official `_stampSendNowCut(h,E)` @229515877 — returns a NEW message with
 * `interruptedBySendNow: true` when the message arrived on the recorded
 * send-now signal and is a user tool-use rejection or interrupt placeholder;
 * otherwise returns the SAME object reference (no allocation, no mutation).
 */
export function stampSendNowCut<T extends StampableMessage>(
  message: T,
  signal: AbortSignal | null | undefined,
): T {
  const isSendNowCut =
    signal != null && sendNowCutSignalStore.isCutSignal(signal)
  if (!isSendNowCut) {
    return message
  }
  if (message.type !== 'user') {
    return message
  }
  const isRejection = message.toolUseResult === USER_REJECTED_TOOL_USE
  if (!isRejection && !isInterruptPlaceholderMessage(message)) {
    return message
  }
  return { ...message, interruptedBySendNow: true }
}
