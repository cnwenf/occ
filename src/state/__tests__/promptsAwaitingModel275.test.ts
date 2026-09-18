import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { Message } from '../../types/message.js'
import {
  AWAITING_KEY_PREFIX_LENGTH,
  EMPTY_AWAITING_SET,
  _resetPromptsAwaitingModelForTesting,
  awaitModelForMessages,
  getPromptsAwaitingModelSnapshot,
  hasUsableUuid,
  isAwaitingEligibleMessage,
  isAwaitingUserMessage,
  markModelReceived,
  messageAwaitingKey,
  promptsAwaitingModelStore,
  selectIsAwaitingModel,
  subscribeToPromptsAwaitingModel,
} from '../promptsAwaitingModel.js'

/**
 * CC 2.1.275 (ITEM O follow-up): "sent and queued messages show in gray
 * until the model receives them".
 *
 * Byte-faithful port verified against the official 2.1.276 binary
 * (/tmp/cc-diff-276/v276/package/claude):
 *   - dx=24 prefix length       @200654898
 *   - CD uuid validation        @215279627
 *   - HU key extraction         @215279748
 *   - awaitModelFor             @217174519
 *   - markModelReceived         @217174696
 *   - $Qo awaiting filter       @217178523 (I3 @192437952)
 *   - RWt shared empty set      @217171099
 *   - Pb hook / qet context     @215281997 / @215281980
 *   - rtt dimmed color logic    @215137852
 *   - applyEvent clear points   @217198853
 *   - providers                 @216027683-216028109
 *
 * No react testing library in this repo — pure store/selector functions are
 * tested directly and the React wiring via source-level assertions (the
 * established idiom, see src/hooks/__tests__/vimModeSwitchFromValue276.test.ts).
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

function readSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

const UUID_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const UUID_B = 'ffffffff-1111-2222-3333-444455556666'

function makeMessage(
  overrides: Partial<Omit<Message, 'uuid'>> & { uuid?: string },
): Message {
  return {
    type: 'user',
    uuid: UUID_A,
    ...overrides,
  } as unknown as Message
}

beforeEach(() => {
  _resetPromptsAwaitingModelForTesting()
})

// ---------------------------------------------------------------------------
// Key extraction (CD @215279627 / HU @215279748 / dx @200654898)
// ---------------------------------------------------------------------------

describe('AWAITING_KEY_PREFIX_LENGTH (dx @200654898)', () => {
  test('is 24', () => {
    expect(AWAITING_KEY_PREFIX_LENGTH).toBe(24)
  })
})

describe('hasUsableUuid (CD @215279627)', () => {
  test('accepts an object with a non-empty string uuid', () => {
    expect(hasUsableUuid({ uuid: UUID_A })).toBe(true)
  })

  test('rejects non-objects and null', () => {
    expect(hasUsableUuid(null)).toBe(false)
    expect(hasUsableUuid(undefined)).toBe(false)
    expect(hasUsableUuid('some-string')).toBe(false)
    expect(hasUsableUuid(42)).toBe(false)
  })

  test('rejects an object without a uuid property', () => {
    expect(hasUsableUuid({ type: 'user' })).toBe(false)
  })

  test('rejects empty-string and non-string uuids', () => {
    expect(hasUsableUuid({ uuid: '' })).toBe(false)
    expect(hasUsableUuid({ uuid: 123 })).toBe(false)
    expect(hasUsableUuid({ uuid: undefined })).toBe(false)
  })
})

describe('messageAwaitingKey (HU @215279748)', () => {
  test('returns the first 24 characters of the uuid', () => {
    expect(messageAwaitingKey({ uuid: UUID_A })).toBe(
      UUID_A.slice(0, AWAITING_KEY_PREFIX_LENGTH),
    )
    expect(messageAwaitingKey({ uuid: UUID_A })).toBe('aaaaaaaa-bbbb-cccc-dddd-')
  })

  test('returns the whole uuid when shorter than the prefix length', () => {
    expect(messageAwaitingKey({ uuid: 'short' })).toBe('short')
  })

  test('returns undefined for an unusable uuid', () => {
    expect(messageAwaitingKey({ uuid: '' })).toBeUndefined()
    expect(messageAwaitingKey(null)).toBeUndefined()
    expect(messageAwaitingKey({ uuid: undefined })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Eligibility filter ($Qo @217178523 / I3 @192437952)
// ---------------------------------------------------------------------------

describe('isAwaitingUserMessage (I3 @192437952)', () => {
  test('accepts a plain user message', () => {
    expect(isAwaitingUserMessage(makeMessage({ type: 'user' }))).toBe(true)
  })

  test('rejects meta user messages', () => {
    expect(
      isAwaitingUserMessage(makeMessage({ type: 'user', isMeta: true })),
    ).toBe(false)
  })

  test('rejects user messages carrying a toolUseResult (tool_result echoes)', () => {
    expect(
      isAwaitingUserMessage(
        makeMessage({ type: 'user', toolUseResult: { ok: true } }),
      ),
    ).toBe(false)
  })

  test('rejects non-user message types', () => {
    expect(isAwaitingUserMessage(makeMessage({ type: 'assistant' }))).toBe(false)
    expect(isAwaitingUserMessage(makeMessage({ type: 'system' }))).toBe(false)
  })
})

describe('isAwaitingEligibleMessage ($Qo @217178523)', () => {
  test('accepts queued_command attachments', () => {
    expect(
      isAwaitingEligibleMessage(
        makeMessage({
          type: 'attachment',
          attachment: { type: 'queued_command', prompt: 'hi' },
        }),
      ),
    ).toBe(true)
  })

  test('rejects other attachment types', () => {
    expect(
      isAwaitingEligibleMessage(
        makeMessage({
          type: 'attachment',
          attachment: { type: 'todo_reminder' },
        }),
      ),
    ).toBe(false)
  })

  test('accepts plain user messages and rejects assistant/system', () => {
    expect(isAwaitingEligibleMessage(makeMessage({ type: 'user' }))).toBe(true)
    expect(
      isAwaitingEligibleMessage(makeMessage({ type: 'assistant' })),
    ).toBe(false)
    expect(isAwaitingEligibleMessage(makeMessage({ type: 'system' }))).toBe(
      false,
    )
  })
})

// ---------------------------------------------------------------------------
// Store semantics (awaitModelFor @217174519 / markModelReceived @217174696)
// ---------------------------------------------------------------------------

describe('awaitModelForMessages (awaitModelFor @217174519)', () => {
  test('registers the 24-char uuid prefix of eligible messages', () => {
    awaitModelForMessages([makeMessage({ type: 'user', uuid: UUID_A })])
    const snapshot = getPromptsAwaitingModelSnapshot()
    expect(snapshot.promptsAwaitingModel.has(UUID_A.slice(0, 24))).toBe(true)
    expect(snapshot.promptsAwaitingModel.size).toBe(1)
  })

  test('is a no-op when no message is eligible (same snapshot, no notify)', () => {
    const before = getPromptsAwaitingModelSnapshot()
    let notified = 0
    const unsubscribe = subscribeToPromptsAwaitingModel(() => {
      notified += 1
    })
    awaitModelForMessages([
      makeMessage({ type: 'assistant', uuid: UUID_A }),
      makeMessage({ type: 'user', isMeta: true, uuid: UUID_B }),
    ])
    unsubscribe()
    expect(getPromptsAwaitingModelSnapshot()).toBe(before)
    expect(notified).toBe(0)
  })

  test('is a no-op for an empty message list', () => {
    const before = getPromptsAwaitingModelSnapshot()
    awaitModelForMessages([])
    expect(getPromptsAwaitingModelSnapshot()).toBe(before)
  })

  test('skips eligible messages whose uuid is unusable', () => {
    const before = getPromptsAwaitingModelSnapshot()
    awaitModelForMessages([
      makeMessage({ type: 'user', uuid: '' }),
    ])
    expect(getPromptsAwaitingModelSnapshot()).toBe(before)
  })

  test('publishes the union with previously awaiting keys (immutable new Set)', () => {
    awaitModelForMessages([makeMessage({ type: 'user', uuid: UUID_A })])
    const first = getPromptsAwaitingModelSnapshot()
    awaitModelForMessages([makeMessage({ type: 'user', uuid: UUID_B })])
    const second = getPromptsAwaitingModelSnapshot()
    expect(second.promptsAwaitingModel.size).toBe(2)
    expect(second.promptsAwaitingModel.has(UUID_A.slice(0, 24))).toBe(true)
    expect(second.promptsAwaitingModel.has(UUID_B.slice(0, 24))).toBe(true)
    // Old snapshot untouched — immutable publish, never mutate in place.
    expect(first.promptsAwaitingModel.size).toBe(1)
    expect(second.promptsAwaitingModel).not.toBe(first.promptsAwaitingModel)
  })

  test('notifies subscribers exactly once per publishing call', () => {
    let notified = 0
    const unsubscribe = subscribeToPromptsAwaitingModel(() => {
      notified += 1
    })
    awaitModelForMessages([
      makeMessage({ type: 'user', uuid: UUID_A }),
      makeMessage({ type: 'user', uuid: UUID_B }),
    ])
    expect(notified).toBe(1)
    unsubscribe()
    awaitModelForMessages([makeMessage({ type: 'user', uuid: UUID_B })])
    expect(notified).toBe(1)
  })
})

describe('markModelReceived (@217174696)', () => {
  test('clears every awaiting key at once', () => {
    awaitModelForMessages([
      makeMessage({ type: 'user', uuid: UUID_A }),
      makeMessage({ type: 'user', uuid: UUID_B }),
    ])
    markModelReceived()
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel.size).toBe(0)
  })

  test('is a no-op when already empty (same snapshot, no notify)', () => {
    const before = getPromptsAwaitingModelSnapshot()
    let notified = 0
    const unsubscribe = subscribeToPromptsAwaitingModel(() => {
      notified += 1
    })
    markModelReceived()
    markModelReceived()
    unsubscribe()
    expect(getPromptsAwaitingModelSnapshot()).toBe(before)
    expect(notified).toBe(0)
  })

  test('publishes the shared empty-set constant (RWt @217171099)', () => {
    awaitModelForMessages([makeMessage({ type: 'user', uuid: UUID_A })])
    markModelReceived()
    expect(getPromptsAwaitingModelSnapshot().promptsAwaitingModel).toBe(
      EMPTY_AWAITING_SET,
    )
  })

  test('notifies subscribers when it actually clears', () => {
    awaitModelForMessages([makeMessage({ type: 'user', uuid: UUID_A })])
    let notified = 0
    const unsubscribe = subscribeToPromptsAwaitingModel(() => {
      notified += 1
    })
    markModelReceived()
    unsubscribe()
    expect(notified).toBe(1)
  })
})

describe('promptsAwaitingModelStore (stream-store shape, Pb consumer @215281997)', () => {
  test('exposes subscribe/getSnapshot and getSnapshot mirrors the module getter', () => {
    expect(typeof promptsAwaitingModelStore.subscribe).toBe('function')
    expect(typeof promptsAwaitingModelStore.getSnapshot).toBe('function')
    expect(promptsAwaitingModelStore.getSnapshot()).toBe(
      getPromptsAwaitingModelSnapshot(),
    )
  })

  test('getSnapshot is stable between publishes (useSyncExternalStore contract)', () => {
    const first = promptsAwaitingModelStore.getSnapshot()
    const second = promptsAwaitingModelStore.getSnapshot()
    expect(first).toBe(second)
  })
})

// ---------------------------------------------------------------------------
// Pure selector (Pb membership test @215281997)
// ---------------------------------------------------------------------------

describe('selectIsAwaitingModel (Pb selector @215281997)', () => {
  test('is false for a null snapshot (no store in context)', () => {
    expect(selectIsAwaitingModel(null, UUID_A.slice(0, 24))).toBe(false)
  })

  test('is false for an undefined key (no messageId prop)', () => {
    awaitModelForMessages([makeMessage({ type: 'user', uuid: UUID_A })])
    expect(
      selectIsAwaitingModel(getPromptsAwaitingModelSnapshot(), undefined),
    ).toBe(false)
  })

  test('is false while the set is empty', () => {
    expect(
      selectIsAwaitingModel(
        { promptsAwaitingModel: EMPTY_AWAITING_SET },
        UUID_A.slice(0, 24),
      ),
    ).toBe(false)
  })

  test('is true only for registered keys', () => {
    awaitModelForMessages([makeMessage({ type: 'user', uuid: UUID_A })])
    const snapshot = getPromptsAwaitingModelSnapshot()
    expect(selectIsAwaitingModel(snapshot, UUID_A.slice(0, 24))).toBe(true)
    expect(selectIsAwaitingModel(snapshot, UUID_B.slice(0, 24))).toBe(false)
  })

  test('flips back to false after markModelReceived', () => {
    awaitModelForMessages([makeMessage({ type: 'user', uuid: UUID_A })])
    markModelReceived()
    expect(
      selectIsAwaitingModel(
        getPromptsAwaitingModelSnapshot(),
        UUID_A.slice(0, 24),
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Source-level wiring assertions (repo idiom — no react testing library)
// ---------------------------------------------------------------------------

describe('AwaitingModelContext wiring (qet @215281980 / Pb @215281997)', () => {
  const source = readSource('src/context/AwaitingModelContext.tsx')

  test('context defaults to null (qet=Xt(null))', () => {
    expect(source).toContain(
      'React.createContext<AwaitingModelContextValue>(null)',
    )
  })

  test('hook implements the official "every" short-circuit and key check', () => {
    expect(source).toContain("const store = contextValue === 'every' ? null : contextValue")
    expect(source).toContain('messageAwaitingKey({ uuid: messageId })')
    expect(source).toContain('useSyncExternalStore')
    expect(source).toContain("return contextValue === 'every' || isAwaiting === true")
  })
})

describe('HighlightedThinkingText dimming (rtt @215137852)', () => {
  const source = readSource('src/components/messages/HighlightedThinkingText.tsx')

  test('accepts the awaitingModel prop and derives dimmed = isQueued || awaitingModel', () => {
    expect(source).toContain('awaitingModel?: boolean')
    expect(source).toContain(
      'const isAwaitingModel = awaitingModel === undefined ? false : awaitingModel',
    )
    expect(source).toContain('const dimmed = isQueued || isAwaitingModel')
  })

  test('brief path dims You-label and body via dimmed', () => {
    expect(source).toContain('const t2 = dimmed ? "subtle" : "briefLabelYou"')
    expect(source).toContain('const t6 = dimmed ? "subtle" : "text"')
  })

  test('non-brief path dims body segments to inactive (official M color)', () => {
    expect(source).toContain('const bodyColor = dimmed ? "inactive" : "text"')
    expect(source).toContain('$[31] !== bodyColor')
    expect(source).toContain('$[32] !== bodyColor')
    expect(source).not.toContain('color="text"')
  })

  test('memo cache was grown for the new dependency slots', () => {
    expect(source).toContain('_c(33)')
  })
})

describe('messageId threading (Message → UserTextMessage → UserPromptMessage)', () => {
  test('Message.tsx passes message.uuid to both text and attachment branches', () => {
    const source = readSource('src/components/Message.tsx')
    const uuidPasses = source.split('messageId={message.uuid}').length - 1
    expect(uuidPasses).toBe(2)
    expect(source).toContain('$[20] !== message.uuid')
    expect(source).toContain('$[94] !== message.uuid')
    expect(source).toContain('_c(21)')
    expect(source).toContain('_c(95)')
  })

  test('AttachmentMessage forwards messageId in the queued_command case', () => {
    const source = readSource('src/components/messages/AttachmentMessage.tsx')
    expect(source).toContain('messageId?: string')
    expect(source).toContain('messageId={messageId}')
  })

  test('UserTextMessage forwards messageId to UserPromptMessage', () => {
    const source = readSource('src/components/messages/UserTextMessage.tsx')
    expect(source).toContain('messageId?: string')
    expect(source).toContain('_c(50)')
    expect(source).toContain('$[49] !== messageId')
    expect(source).toContain(
      '<UserPromptMessage addMargin={addMargin} param={param} isTranscriptMode={isTranscriptMode} timestamp={timestamp} messageId={messageId} />',
    )
  })

  test('UserPromptMessage resolves awaitingModel via the hook and passes it down', () => {
    const source = readSource('src/components/messages/UserPromptMessage.tsx')
    expect(source).toContain('messageId?: string')
    expect(source).toContain('const awaitingModel = useAwaitingModel(messageId)')
    expect(source).toContain('awaitingModel={awaitingModel}')
    expect(source).toContain(
      "import { useAwaitingModel } from '../../context/AwaitingModelContext.js'",
    )
  })
})

describe('REPL wiring (applyEvent @217198853 / turn-append @217203761 / reset @217177965)', () => {
  const source = readSource('src/screens/REPL.tsx')

  test('registers sent messages BEFORE appending them to the transcript', () => {
    const registerIdx = source.indexOf('awaitModelForMessages(newMessages)')
    const appendIdx = source.indexOf(
      'setMessages(oldMessages => [...oldMessages, ...newMessages])',
    )
    expect(registerIdx).toBeGreaterThan(-1)
    expect(appendIdx).toBeGreaterThan(-1)
    expect(registerIdx).toBeLessThan(appendIdx)
  })

  test('onQueryEvent registers attachment events and clears on message_start/assistant', () => {
    expect(source).toContain('awaitModelForMessages([event as MessageType])')
    const messageStartIdx = source.indexOf(
      ".event?.type === 'message_start'",
    )
    expect(messageStartIdx).toBeGreaterThan(-1)
    const afterStart = source.slice(messageStartIdx, messageStartIdx + 300)
    expect(afterStart).toContain('markModelReceived()')
    expect(source).toContain("} else if (event.type === 'assistant') {\n      markModelReceived();")
  })

  test('resetLoadingState pairs the placeholder clear with markModelReceived', () => {
    const startIdx = source.indexOf('const resetLoadingState = useCallback(() => {')
    const endIdx = source.indexOf('}, [pickNewSpinnerTip]);', startIdx)
    expect(startIdx).toBeGreaterThan(-1)
    expect(endIdx).toBeGreaterThan(startIdx)
    const body = source.slice(startIdx, endIdx)
    const placeholderIdx = body.indexOf('setUserInputOnProcessing(undefined);')
    const clearIdx = body.indexOf('markModelReceived();')
    expect(placeholderIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(placeholderIdx)
  })

  test('providers: store around both transcript areas, "every" around the placeholder echo', () => {
    const storeProviders =
      source.split(
        '<AwaitingModelContext.Provider value={promptsAwaitingModelStore}>',
      ).length - 1
    expect(storeProviders).toBe(2)
    const everyProviders =
      source.split('<AwaitingModelContext.Provider value="every">').length - 1
    expect(everyProviders).toBe(1)
    // The "every" provider must wrap the processing-placeholder echo.
    const everyIdx = source.indexOf('<AwaitingModelContext.Provider value="every">')
    const placeholderIdx = source.indexOf('text: placeholderText,', everyIdx)
    expect(placeholderIdx).toBeGreaterThan(everyIdx)
  })
})
