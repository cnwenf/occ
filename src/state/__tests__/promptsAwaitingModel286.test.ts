import { beforeEach, describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import {
  _resetPromptsAwaitingModelForTesting,
  awaitModelForMessages,
  getPromptsAwaitingModelSnapshot,
  isQueuedCommandAttachment,
  messageAwaitingKey,
  shouldAwaitModelForDispatch,
  subscribeToPromptsAwaitingModel,
} from '../promptsAwaitingModel.js'

/**
 * CC 2.1.286 (item 55) — "Changed prompts sent while nothing is running or
 * queued to show in the normal text color right away instead of gray".
 *
 * Official v286 binary forensics (all offsets into
 * /tmp/cc-diff-286/v286/package/claude unless noted; v285 =
 * /tmp/cc-diff-286/v285/package/claude):
 *
 *   - v285 turn-append gray gate @224563299:
 *       `if(zNr(),hDo(),M)this.stream.awaitModelFor(h)`
 *     — gated on `M` (fresh-turn flag) alone, 14-param run @224560782
 *     (`run=async(h,v,M,N,X,ye,Se,Pe,Me,Oe,Ke,Ge,Ne,lt)=>`). Every
 *     fresh-turn dispatch went gray.
 *   - v286 turn-append gray gate @225818516:
 *       `if(pBr(),X$o(),L&&mt)this.stream.awaitModelFor(h)`
 *     — `mt` is run's NEW 15th param (`run=async(h,v,L,...,dt,mt=!1)=>`
 *     @225815961), fed by dispatcher `xZe` as `ht=Ge==="queued"`
 *     (@225767067, `Ge` = inputSource) at `await gt(...,so,ht)`
 *     (@225772771).
 *   - REPL input dispatcher `qH` @225758818: a typed submit calls
 *     `xZe({inputSource:h.inputSource??"typed",queuedCommands:[nn],...})`
 *     @225766364 (`inputSource:"typed"` has 0 hits in v285 — TRUE-NEW);
 *     the queued drain calls `xZe({inputSource:"queued",...})` @225759170.
 *   - The runner class `LJ` @225790494 makes 3 internal `this.run(...)`
 *     calls (reply-on-resume @225829271, launch-prompt @225831322,
 *     direct-run @225832059) each passing 5 args → `mt` defaults false →
 *     no gray.
 *   - The applyEvent attachment branch
 *     `if(h.type==="attachment")this.stream.awaitModelFor([h])` is
 *     byte-identical v285 @224558227 / v286 @225813406 — queued_command
 *     attachment events always go gray regardless of dispatch source.
 *
 * Semantics: idle typed send → mt=false → no awaitModelFor → the prompt
 * renders in normal color immediately. Busy typed send → enqueued →
 * drained with inputSource "queued" → mt=true → gray until message_start.
 *
 * OCC wiring note (WIRED — review G3 fix): REPL.tsx's onQuery callback takes
 * `isQueuedDispatch?: boolean` as its 9th param (official `mt=!1` @225815961)
 * and the turn-append calls `awaitModelForMessages(newMessages,
 * isQueuedDispatch === true)`. Only the queued drain sets it:
 * executeQueuedInput wraps its onQuery via makeQueuedDispatchOnQuery
 * (src/utils/messageQueueManager.ts) — the analog of the official dispatcher
 * appending `ht=Ge==="queued"` @225767067 as run's final arg. Typed submits
 * and every other onQuery caller pass ≤8 args → flag undefined → no gray.
 * Dispatch-chain tests: src/utils/__tests__/queuedDrainGray286.test.ts.
 */

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const KEY_A = UUID_A.slice(0, 24)
const KEY_B = UUID_B.slice(0, 24)

function makeMessage(overrides: Partial<Message>): Message {
  return { uuid: UUID_A, type: 'user', ...overrides } as Message
}

function makeUserMessage(uuid: string = UUID_A): Message {
  return makeMessage({ type: 'user', uuid: uuid as Message['uuid'] })
}

function makeQueuedCommandAttachment(uuid: string): Message {
  return makeMessage({
    type: 'attachment',
    uuid,
    attachment: { type: 'queued_command', content: 'do the thing' },
  } as Partial<Message>)
}

beforeEach(() => {
  _resetPromptsAwaitingModelForTesting()
})

describe('shouldAwaitModelForDispatch — official v286 gate `L&&mt` @225818516', () => {
  test('fresh turn + queued dispatch → await (mt=true)', () => {
    expect(shouldAwaitModelForDispatch(true, true)).toBe(true)
  })

  test('fresh turn + typed dispatch → do NOT await (mt=false, the v286 changelog item)', () => {
    expect(shouldAwaitModelForDispatch(true, false)).toBe(false)
  })

  test('non-fresh turn + queued dispatch → do NOT await (L=false)', () => {
    expect(shouldAwaitModelForDispatch(false, true)).toBe(false)
  })

  test('non-fresh turn + typed dispatch → do NOT await', () => {
    expect(shouldAwaitModelForDispatch(false, false)).toBe(false)
  })
})

describe('isQueuedCommandAttachment — applyEvent attachment arm (unchanged v285↔v286)', () => {
  test('queued_command attachment → true', () => {
    expect(isQueuedCommandAttachment(makeQueuedCommandAttachment(UUID_A))).toBe(true)
  })

  test('user message → false', () => {
    expect(isQueuedCommandAttachment(makeUserMessage())).toBe(false)
  })

  test('other attachment type → false', () => {
    const other = makeMessage({
      type: 'attachment',
      attachment: { type: 'file' },
    } as Partial<Message>)
    expect(isQueuedCommandAttachment(other)).toBe(false)
  })

  test('attachment with no attachment payload → false', () => {
    const bare = makeMessage({ type: 'attachment' })
    expect(isQueuedCommandAttachment(bare)).toBe(false)
  })
})

describe('awaitModelForMessages — v286 default (typed/idle dispatch, mt=false)', () => {
  test('user messages are NOT marked when the flag is omitted (normal color right away)', () => {
    // Arrange
    const snapshotBefore = getPromptsAwaitingModelSnapshot()
    let notifyCount = 0
    subscribeToPromptsAwaitingModel(() => {
      notifyCount++
    })

    // Act
    awaitModelForMessages([makeUserMessage()])

    // Assert — no publish at all: same snapshot identity, no notify, empty set
    expect(getPromptsAwaitingModelSnapshot()).toBe(snapshotBefore)
    expect(notifyCount).toBe(0)
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel.size).toBe(0)
  })

  test('user messages are NOT marked when the flag is explicitly false', () => {
    // Arrange / Act
    awaitModelForMessages([makeUserMessage(UUID_A), makeUserMessage(UUID_B)], false)

    // Assert
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel.size).toBe(0)
  })

  test('queued_command attachment IS marked even without the flag (official attachment branch is unconditional)', () => {
    // Arrange / Act — applyEvent: `if(h.type==="attachment")this.stream.awaitModelFor([h])`
    // byte-identical v285 @224558227 / v286 @225813406.
    awaitModelForMessages([makeQueuedCommandAttachment(UUID_A)])

    // Assert
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel.has(KEY_A)).toBe(true)
  })

  test('mixed batch without the flag → only the attachment key is marked', () => {
    // Arrange / Act
    awaitModelForMessages([
      makeUserMessage(UUID_A),
      makeQueuedCommandAttachment(UUID_B),
    ])

    // Assert
    const awaiting = getPromptsAwaitingModelSnapshot().promptsAwaitingModel
    expect(awaiting.has(KEY_A)).toBe(false)
    expect(awaiting.has(KEY_B)).toBe(true)
    expect(awaiting.size).toBe(1)
  })
})

describe('awaitModelForMessages — v286 queued dispatch (mt=true, official `L&&mt`)', () => {
  test('user messages ARE marked when dispatched from the queue', () => {
    // Arrange / Act — mirrors the queued drain: xZe({inputSource:"queued"})
    // → ht=true → `if(pBr(),X$o(),L&&mt)this.stream.awaitModelFor(h)`.
    awaitModelForMessages([makeUserMessage(UUID_A), makeUserMessage(UUID_B)], true)

    // Assert
    const awaiting = getPromptsAwaitingModelSnapshot().promptsAwaitingModel
    expect(awaiting.has(KEY_A)).toBe(true)
    expect(awaiting.has(KEY_B)).toBe(true)
    expect(awaiting.size).toBe(2)
  })

  test('meta / tool-result user messages stay unmarked even on queued dispatch', () => {
    // Arrange
    const meta = makeMessage({ type: 'user', uuid: UUID_B, isMeta: true })
    const toolResult = makeMessage({
      type: 'user',
      uuid: UUID_B,
      toolUseResult: { type: 'tool_result' },
    } as Partial<Message>)

    // Act
    awaitModelForMessages([meta, toolResult], true)

    // Assert
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel.size).toBe(0)
  })

  test('messages without a usable uuid are skipped on queued dispatch', () => {
    // Arrange — official key extraction HU @215279748 requires CD @215279627.
    const noUuid = { type: 'user' } as unknown as Message

    // Act
    awaitModelForMessages([noUuid], true)

    // Assert
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel.size).toBe(0)
  })

  test('queued dispatch unions with keys already awaiting (never mutates the published set)', () => {
    // Arrange
    awaitModelForMessages([makeQueuedCommandAttachment(UUID_A)])
    const snapshotAfterFirst = getPromptsAwaitingModelSnapshot()

    // Act
    awaitModelForMessages([makeUserMessage(UUID_B)], true)

    // Assert
    const awaiting = getPromptsAwaitingModelSnapshot().promptsAwaitingModel
    expect(awaiting.has(KEY_A)).toBe(true)
    expect(awaiting.has(KEY_B)).toBe(true)
    expect(getPromptsAwaitingModelSnapshot()).not.toBe(snapshotAfterFirst)
    expect(snapshotAfterFirst.promptsAwaitingModel.size).toBe(1)
  })
})

describe('v285→v286 behavior delta (regression pin)', () => {
  test('v285 gate was `M` alone — this module now requires the queued flag for user messages', () => {
    // The observable delta: with the default flag, a plain user-message batch
    // that v285 would have grayed (M truthy → awaitModelFor) is a no-op in
    // v286 (mt=false → gate `L&&mt` short-circuits). messageAwaitingKey
    // still extracts the key, so the ONLY reason nothing is marked is the
    // dispatch gate.
    const user = makeUserMessage(UUID_A)
    expect(messageAwaitingKey(user)).toBe(KEY_A)

    awaitModelForMessages([user])
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel.has(KEY_A)).toBe(false)

    awaitModelForMessages([user], true)
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel.has(KEY_A)).toBe(true)
  })
})
