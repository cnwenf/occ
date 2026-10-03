/**
 * CC 2.1.288 #59 — "Fixed the 'What should Claude do instead?' hint showing on
 * the Interrupted row after sending queued messages with ctrl+enter."
 *
 * Official binary evidence (docs/gap-research-288/cluster-e-ui-features.md §#59,
 * all offsets into /tmp/cc-diff-288/v288/package/claude — verified with dd):
 *
 *   - `interruptForSubmit` @229515877 records the AbortSignal it is about to
 *     abort with, BEFORE aborting:
 *       `this._sendNowCutSignal=h.signal,h.abort(fl("user-cancel"))`
 *     The signal IDENTITY is the discriminator — ctrl+enter and the Esc
 *     interrupt both abort with the same reason string `"user-cancel"`, so the
 *     reason alone cannot tell them apart.
 *   - `_stampSendNowCut(h,E)` @229515877:
 *       `return E===this._sendNowCutSignal&&h.type==="user"&&
 *               (h.toolUseResult===cZe||rk(h))?{...h,interruptedBySendNow:!0}:h`
 *     i.e. stamp only when (a) the message arrived on the recorded signal,
 *     (b) it is a user message, and (c) it is either a tool-use rejection
 *     (`cZe="User rejected tool use"` @200609235) or an interrupt placeholder
 *     (`rk` @200608890 — every text / errored-tool_result block starts with one
 *     of the `Vfe` interrupt prefixes @200607726).
 *   - `_applyMessage` @229522066 runs every message through the stamp:
 *       `Pe=this._stampSendNowCut(h,this._snapshot.abortController?.signal)`
 *
 * The stamp is what the row renderer later reads (`l.interruptedBySendNow===!0`
 * @227595016 → `Lt.Provider` → `La()` @227383175 suppresses the hint).
 *
 * OCC divergence (documented, no invented behavior): official's `Vfe` prefix
 * list also carries "[Tool call did not complete: …]" and "[Tool call skipped:
 * …]" variants that have ZERO hits in the OCC source tree (NO-SURFACE), so
 * OCC's `rk` analogue matches on the interrupt constants OCC actually emits
 * (`INTERRUPT_MESSAGE`, `INTERRUPT_MESSAGE_FOR_TOOL_USE`) plus the resume
 * placeholder family (`SESSION_ENDED_MESSAGE`, `COPIED_SESSION_MESSAGE`).
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  SESSION_ENDED_MESSAGE,
} from '../messages.js'
import {
  clearSendNowCutSignal,
  isSendNowCutSignal,
  stampSendNowCut,
  stampSendNowCutSignal,
  USER_REJECTED_TOOL_USE,
} from '../sendNowCut.js'

type StampedMessage = { type: string; interruptedBySendNow?: boolean } & Record<
  string,
  unknown
>

function userTextMessage(
  text: string,
  extra: Record<string, unknown> = {},
): StampedMessage {
  return {
    type: 'user',
    uuid: 'u-1',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  }
}

function makeSignal(): AbortSignal {
  return new AbortController().signal
}

describe('CC 2.1.288 #59 — send-now cut signal slot', () => {
  beforeEach(() => {
    clearSendNowCutSignal()
  })

  test('isSendNowCutSignal is false before anything is stamped', () => {
    expect(isSendNowCutSignal(makeSignal())).toBe(false)
  })

  test('stampSendNowCutSignal records the exact signal identity', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)
    expect(isSendNowCutSignal(signal)).toBe(true)
  })

  test('a different signal (the Esc interrupt) is NOT the send-now cut', () => {
    const sendNowSignal = makeSignal()
    const escSignal = makeSignal()
    stampSendNowCutSignal(sendNowSignal)
    expect(isSendNowCutSignal(escSignal)).toBe(false)
  })

  test('a newer send-now cut replaces the recorded signal', () => {
    const first = makeSignal()
    const second = makeSignal()
    stampSendNowCutSignal(first)
    stampSendNowCutSignal(second)
    expect(isSendNowCutSignal(first)).toBe(false)
    expect(isSendNowCutSignal(second)).toBe(true)
  })

  test('undefined / null signals never match', () => {
    stampSendNowCutSignal(makeSignal())
    expect(isSendNowCutSignal(undefined)).toBe(false)
    expect(isSendNowCutSignal(null)).toBe(false)
  })
})

describe('CC 2.1.288 #59 — _stampSendNowCut', () => {
  beforeEach(() => {
    clearSendNowCutSignal()
  })

  test('stamps interruptedBySendNow on the interrupt message from the send-now abort', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const message = userTextMessage(INTERRUPT_MESSAGE)
    const stamped = stampSendNowCut(message, signal)

    expect(stamped.interruptedBySendNow).toBe(true)
  })

  test('stamps the tool-use interrupt variant too', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const stamped = stampSendNowCut(
      userTextMessage(INTERRUPT_MESSAGE_FOR_TOOL_USE),
      signal,
    )

    expect(stamped.interruptedBySendNow).toBe(true)
  })

  test('does NOT stamp when the abort came from a different signal (Esc interrupt)', () => {
    const sendNowSignal = makeSignal()
    stampSendNowCutSignal(sendNowSignal)

    const message = userTextMessage(INTERRUPT_MESSAGE)
    const untouched = stampSendNowCut(message, makeSignal())

    expect(untouched.interruptedBySendNow).toBeUndefined()
    // Official returns `h` unchanged — identity preserved, no new object.
    expect(untouched).toBe(message)
  })

  test('does NOT stamp when no send-now cut was recorded at all', () => {
    const message = userTextMessage(INTERRUPT_MESSAGE)
    const untouched = stampSendNowCut(message, makeSignal())

    expect(untouched.interruptedBySendNow).toBeUndefined()
    expect(untouched).toBe(message)
  })

  test('does NOT stamp non-user messages', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const assistant = {
      type: 'assistant',
      uuid: 'a-1',
      message: { role: 'assistant', content: [{ type: 'text', text: INTERRUPT_MESSAGE }] },
    } as StampedMessage

    expect(stampSendNowCut(assistant, signal)).toBe(assistant)
  })

  test('does NOT stamp a user message that is not an interrupt or rejection', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const message = userTextMessage('please refactor the parser')

    expect(stampSendNowCut(message, signal)).toBe(message)
  })

  test('stamps the "User rejected tool use" toolUseResult case (cZe @200609235)', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const message = userTextMessage('some tool output', {
      toolUseResult: USER_REJECTED_TOOL_USE,
    })

    expect(stampSendNowCut(message, signal).interruptedBySendNow).toBe(true)
  })

  test('stamps an errored tool_result block carrying the interrupt text (rk @200608890)', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const message = {
      type: 'user',
      uuid: 'u-2',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't-1',
            is_error: true,
            content: INTERRUPT_MESSAGE_FOR_TOOL_USE,
          },
        ],
      },
    } as StampedMessage

    expect(stampSendNowCut(message, signal).interruptedBySendNow).toBe(true)
  })

  test('does NOT stamp a successful tool_result block carrying the interrupt text', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const message = {
      type: 'user',
      uuid: 'u-3',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't-1',
            is_error: false,
            content: INTERRUPT_MESSAGE,
          },
        ],
      },
    } as StampedMessage

    expect(stampSendNowCut(message, signal)).toBe(message)
  })

  test('stamps a string-content user message starting with an interrupt prefix', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const message = {
      type: 'user',
      uuid: 'u-4',
      message: { role: 'user', content: SESSION_ENDED_MESSAGE },
    } as StampedMessage

    expect(stampSendNowCut(message, signal).interruptedBySendNow).toBe(true)
  })

  test('stamps when EVERY block is an interrupt placeholder (rk `every`)', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const message = {
      type: 'user',
      uuid: 'u-5',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: INTERRUPT_MESSAGE },
          { type: 'text', text: CANCEL_MESSAGE },
        ],
      },
    } as StampedMessage

    expect(stampSendNowCut(message, signal).interruptedBySendNow).toBe(true)
  })

  test('does NOT stamp when only SOME blocks are interrupt placeholders', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const message = {
      type: 'user',
      uuid: 'u-6',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: INTERRUPT_MESSAGE },
          { type: 'text', text: 'real user content' },
        ],
      },
    } as StampedMessage

    expect(stampSendNowCut(message, signal)).toBe(message)
  })

  test('is immutable — the original message object is never mutated', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const message = userTextMessage(INTERRUPT_MESSAGE)
    const stamped = stampSendNowCut(message, signal)

    expect(stamped).not.toBe(message)
    expect(message.interruptedBySendNow).toBeUndefined()
    expect(stamped.interruptedBySendNow).toBe(true)
    // Official spread `{...h,interruptedBySendNow:!0}` keeps every other field.
    expect(stamped.uuid).toBe('u-1')
  })

  test('a message that already carries the flag is left byte-identical', () => {
    const signal = makeSignal()
    stampSendNowCutSignal(signal)

    const message = userTextMessage(INTERRUPT_MESSAGE, {
      interruptedBySendNow: true,
    })
    const stamped = stampSendNowCut(message, signal)

    expect(stamped).toEqual(message)
  })
})
