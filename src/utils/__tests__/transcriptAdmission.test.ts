/**
 * CC 2.1.275 (ITEM M2/M3) — unit tests for the transcript load-time
 * admission validator (`src/utils/transcriptAdmission.ts`), a port of the
 * official v276 `Vlr`/`iFs`/`Glr` (binary @200791900).
 *
 * Byte-exact warn template asserted below (official binary @200792324):
 *   `transcript load: removed ${r} malformed content block(s) from ${n} row(s) and dropped ${s} unreadable row(s)`
 * (the "(s)" suffixes are literal in the official — no pluralization helper).
 *
 * Mock plumbing follows the OCC-97/129 convention (effortCap267.test.ts):
 * capture real refs BEFORE mock.module, spread the real module, mockActive
 * flag, afterAll re-pin.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'

const actualDebugModule = await import('../debug.js')
const actualLogForDebugging = actualDebugModule.logForDebugging

const debugLines: Array<{ message: string; level?: string }> = []
let mockActive = true

mock.module('../debug.js', () => ({
  ...actualDebugModule,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    if (!mockActive) {
      return actualLogForDebugging(message, opts as never)
    }
    debugLines.push({ message, level: opts?.level })
  },
}))

afterAll(() => {
  // OCC-97 leak guard: bun live-patches the captured namespace, so restore by
  // re-pinning the REAL function reference captured before mocking.
  mockActive = false
  mock.module('../debug.js', () => ({
    ...actualDebugModule,
    logForDebugging: actualLogForDebugging,
  }))
})

const {
  classifyMessagePayload,
  createTranscriptAdmissionValidator,
  isPlainObjectValue,
  isValidContentBlock,
} = await import('../transcriptAdmission.js')

beforeEach(() => {
  debugLines.length = 0
})

function makeEntry(
  type: string,
  parentUuid: UUID | null = null,
  message?: unknown,
): {
  type: string
  uuid: UUID
  parentUuid: UUID | null
  message?: unknown
} {
  const entry: {
    type: string
    uuid: UUID
    parentUuid: UUID | null
    message?: unknown
  } = { type, uuid: randomUUID() as UUID, parentUuid }
  if (message !== undefined) {
    entry.message = message
  }
  return entry
}

describe('isPlainObjectValue (official `te` @190928642)', () => {
  test('accepts plain objects', () => {
    // Arrange
    const value = { a: 1 }

    // Act / Assert
    expect(isPlainObjectValue(value)).toBe(true)
  })

  test('rejects null, arrays, and non-objects', () => {
    // Arrange / Act / Assert
    expect(isPlainObjectValue(null)).toBe(false)
    expect(isPlainObjectValue([])).toBe(false)
    expect(isPlainObjectValue('str')).toBe(false)
    expect(isPlainObjectValue(42)).toBe(false)
    expect(isPlainObjectValue(undefined)).toBe(false)
  })
})

describe('isValidContentBlock (official `Glr`)', () => {
  test('accepts a plain object with a string type', () => {
    // Arrange
    const block = { type: 'text', text: 'hi' }

    // Act / Assert
    expect(isValidContentBlock(block)).toBe(true)
  })

  test('rejects strings, null, arrays, objects without type, and non-string type', () => {
    // Arrange / Act / Assert
    expect(isValidContentBlock('junk')).toBe(false)
    expect(isValidContentBlock(null)).toBe(false)
    expect(isValidContentBlock([{ type: 'text' }])).toBe(false)
    expect(isValidContentBlock({})).toBe(false)
    expect(isValidContentBlock({ type: 42 })).toBe(false)
    expect(isValidContentBlock(undefined)).toBe(false)
  })
})

describe('classifyMessagePayload (official `iFs`)', () => {
  test('drops when message is not a plain object', () => {
    // Arrange / Act / Assert
    expect(classifyMessagePayload(null)).toBe('drop')
    expect(classifyMessagePayload(42)).toBe('drop')
    expect(classifyMessagePayload('str')).toBe('drop')
    expect(classifyMessagePayload([])).toBe('drop')
    expect(classifyMessagePayload(undefined)).toBe('drop')
  })

  test('keeps a string content payload', () => {
    // Arrange
    const message = { role: 'user', content: 'hello' }

    // Act
    const verdict = classifyMessagePayload(message)

    // Assert
    expect(verdict).toBe('keep')
    expect(message.content).toBe('hello')
  })

  test('drops when content is missing or not string/array', () => {
    // Arrange / Act / Assert
    expect(classifyMessagePayload({ role: 'user' })).toBe('drop')
    expect(classifyMessagePayload({ content: 42 })).toBe('drop')
    expect(classifyMessagePayload({ content: { a: 1 } })).toBe('drop')
    expect(classifyMessagePayload({ content: null })).toBe('drop')
  })

  test('keeps an all-valid content array without mutating it', () => {
    // Arrange
    const blocks = [
      { type: 'text', text: 'a' },
      { type: 'tool_use', id: 'x' },
    ]
    const message = { role: 'assistant', content: blocks }

    // Act
    const verdict = classifyMessagePayload(message)

    // Assert
    expect(verdict).toBe('keep')
    expect(message.content).toBe(blocks) // same reference — no copy made
  })

  test('strips invalid blocks in place and returns the removed count', () => {
    // Arrange
    const valid = { type: 'text', text: 'ok' }
    const message: { role: string; content: unknown } = {
      role: 'assistant',
      content: [valid, 'junk', null, {}],
    }

    // Act
    const verdict = classifyMessagePayload(message)

    // Assert — official mutates content in place (e.content=r)
    expect(verdict).toBe(3)
    expect(message.content).toEqual([valid])
  })

  test('drops when every block is invalid', () => {
    // Arrange
    const message: { content: unknown } = { content: ['junk', null, {}] }

    // Act
    const verdict = classifyMessagePayload(message)

    // Assert — no mutation on full drop (official returns "drop" early)
    expect(verdict).toBe('drop')
    expect(message.content).toEqual(['junk', null, {}])
  })

  test('keeps an empty content array', () => {
    // Arrange — [].every(...) is vacuously true in the official
    const message = { content: [] as unknown[] }

    // Act / Assert
    expect(classifyMessagePayload(message)).toBe('keep')
  })
})

describe('createTranscriptAdmissionValidator().admit', () => {
  test('passes non-user/assistant rows through untouched', () => {
    // Arrange
    const validator = createTranscriptAdmissionValidator()
    const attachment = makeEntry('attachment', null, null)
    const system = makeEntry('system', null)

    // Act
    const admittedAttachment = validator.admit(attachment, new Map())
    const admittedSystem = validator.admit(system, new Map())
    validator.finish(new Map())

    // Assert — admitted despite unreadable message; nothing counted/logged
    expect(admittedAttachment).toBe(true)
    expect(admittedSystem).toBe(true)
    expect(debugLines).toEqual([])
  })

  test('keeps a well-formed user row and logs nothing on finish', () => {
    // Arrange
    const validator = createTranscriptAdmissionValidator()
    const user = makeEntry('user', null, { role: 'user', content: 'hi' })

    // Act
    const admitted = validator.admit(user, new Map())
    validator.finish(new Map())

    // Assert
    expect(admitted).toBe(true)
    expect(debugLines).toEqual([])
  })

  test('drops a user row with message:null and logs the byte-exact warn', () => {
    // Arrange
    const validator = createTranscriptAdmissionValidator()
    const user = makeEntry('user', null, null)

    // Act
    const admitted = validator.admit(user, new Map())
    validator.finish(new Map())

    // Assert
    expect(admitted).toBe(false)
    expect(debugLines).toEqual([
      {
        message:
          'transcript load: removed 0 malformed content block(s) from 0 row(s) and dropped 1 unreadable row(s)',
        level: 'warn',
      },
    ])
  })

  test('drops a row with non-array content and counts it', () => {
    // Arrange
    const validator = createTranscriptAdmissionValidator()
    const assistant = makeEntry('assistant', null, {
      role: 'assistant',
      content: 42,
    })

    // Act
    const admitted = validator.admit(assistant, new Map())
    validator.finish(new Map())

    // Assert
    expect(admitted).toBe(false)
    expect(debugLines[0]?.message).toContain('dropped 1 unreadable row(s)')
  })

  test('admits a row with stripped blocks and reports both counters', () => {
    // Arrange
    const validator = createTranscriptAdmissionValidator()
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }, 'junk', null, {}] as unknown[],
    }
    const assistant = makeEntry('assistant', null, message)

    // Act
    const admitted = validator.admit(assistant, new Map())
    validator.finish(new Map())

    // Assert
    expect(admitted).toBe(true)
    expect(message.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(debugLines).toEqual([
      {
        message:
          'transcript load: removed 3 malformed content block(s) from 1 row(s) and dropped 0 unreadable row(s)',
        level: 'warn',
      },
    ])
  })

  test('aggregates counts across multiple rows into one warn log', () => {
    // Arrange
    const validator = createTranscriptAdmissionValidator()
    const dropped = makeEntry('user', null, null)
    const stripped = makeEntry('assistant', null, {
      content: [{ type: 'text' }, 'junk', 'junk2'],
    })
    const messages = new Map<UUID, { parentUuid: UUID | null }>()

    // Act
    validator.admit(dropped, messages)
    validator.admit(stripped, messages)
    validator.noteUnreadableRow()
    validator.finish(messages)

    // Assert
    expect(debugLines).toEqual([
      {
        message:
          'transcript load: removed 2 malformed content block(s) from 1 row(s) and dropped 2 unreadable row(s)',
        level: 'warn',
      },
    ])
  })

  test('noteUnreadableRow counts bare-null rows in the dropped total', () => {
    // Arrange
    const validator = createTranscriptAdmissionValidator()

    // Act
    validator.noteUnreadableRow()
    validator.finish(new Map())

    // Assert
    expect(debugLines).toEqual([
      {
        message:
          'transcript load: removed 0 malformed content block(s) from 0 row(s) and dropped 1 unreadable row(s)',
        level: 'warn',
      },
    ])
  })

  test('keeps the row when admission throws unexpectedly (official catch{return!0})', () => {
    // Arrange — a hostile entry whose `type` getter throws
    const validator = createTranscriptAdmissionValidator()
    const hostile = {
      get type(): string {
        throw new Error('boom')
      },
      uuid: randomUUID() as UUID,
      parentUuid: null,
    }

    // Act
    const admitted = validator.admit(
      hostile as unknown as Parameters<
        typeof validator.admit
      >[0],
      new Map(),
    )
    validator.finish(new Map())

    // Assert — kept, nothing counted
    expect(admitted).toBe(true)
    expect(debugLines).toEqual([])
  })

  test('a dropped duplicate uuid already in the messages map still returns false', () => {
    // Arrange — official guard: an admitted row with the same uuid wins, the
    // dropped twin is not recorded for re-chaining (but still counted).
    const validator = createTranscriptAdmissionValidator()
    const uuid = randomUUID() as UUID
    const messages = new Map<UUID, { parentUuid: UUID | null }>([
      [uuid, { parentUuid: null }],
    ])
    const droppedTwin = {
      type: 'user',
      uuid,
      parentUuid: null,
      message: null,
    }

    // Act
    const admitted = validator.admit(droppedTwin, messages)
    validator.finish(messages)

    // Assert
    expect(admitted).toBe(false)
    expect(debugLines[0]?.message).toContain('dropped 1 unreadable row(s)')
  })
})

describe('createTranscriptAdmissionValidator().finish re-chaining (official `y`)', () => {
  test('re-chains a survivor whose parent was dropped to the surviving grandparent', () => {
    // Arrange
    const validator = createTranscriptAdmissionValidator()
    const parent = makeEntry('user', null, { role: 'user', content: 'hi' })
    const middle = makeEntry('assistant', parent.uuid, null) // dropped
    const child = makeEntry('user', middle.uuid, {
      role: 'user',
      content: 'next',
    })
    const messages = new Map<UUID, { parentUuid: UUID | null }>()

    // Act
    validator.admit(parent, messages)
    messages.set(parent.uuid, parent)
    const admittedMiddle = validator.admit(middle, messages)
    validator.admit(child, messages)
    messages.set(child.uuid, child)
    validator.finish(messages)

    // Assert
    expect(admittedMiddle).toBe(false)
    expect(messages.get(child.uuid)?.parentUuid).toBe(parent.uuid)
  })

  test('walks a multi-hop dropped chain to the nearest surviving ancestor', () => {
    // Arrange — A (kept) → B, C, D (all dropped, chained) → E (kept)
    const validator = createTranscriptAdmissionValidator()
    const a = makeEntry('user', null, { content: 'a' })
    const b = makeEntry('user', a.uuid, null)
    const c = makeEntry('user', b.uuid, null)
    const d = makeEntry('user', c.uuid, null)
    const e = makeEntry('user', d.uuid, { content: 'e' })
    const messages = new Map<UUID, { parentUuid: UUID | null }>()

    // Act
    for (const row of [a, b, c, d, e]) {
      if (validator.admit(row, messages)) {
        messages.set(row.uuid, row)
      }
    }
    validator.finish(messages)

    // Assert
    expect(messages.size).toBe(2)
    expect(messages.get(e.uuid)?.parentUuid).toBe(a.uuid)
  })

  test('re-chains to null when the dropped chain starts at the transcript root', () => {
    // Arrange — B dropped (parent null) → C kept (parent B)
    const validator = createTranscriptAdmissionValidator()
    const b = makeEntry('user', null, null)
    const c = makeEntry('user', b.uuid, { content: 'c' })
    const messages = new Map<UUID, { parentUuid: UUID | null }>()

    // Act
    validator.admit(b, messages)
    validator.admit(c, messages)
    messages.set(c.uuid, c)
    validator.finish(messages)

    // Assert
    expect(messages.get(c.uuid)?.parentUuid).toBeNull()
  })

  test('terminates on a cycle in the dropped chain and resolves to null', () => {
    // Arrange — X ↔ Y drop-cycle; survivor S points at X
    const validator = createTranscriptAdmissionValidator()
    const x = makeEntry('user', undefined as unknown as UUID, null)
    const y = makeEntry('user', x.uuid, null)
    x.parentUuid = y.uuid
    const s = makeEntry('user', x.uuid, { content: 's' })
    const messages = new Map<UUID, { parentUuid: UUID | null }>()

    // Act — must not infinite-loop
    validator.admit(x, messages)
    validator.admit(y, messages)
    validator.admit(s, messages)
    messages.set(s.uuid, s)
    validator.finish(messages)

    // Assert
    expect(messages.get(s.uuid)?.parentUuid).toBeNull()
    expect(debugLines[0]?.message).toContain('dropped 2 unreadable row(s)')
  })

  test('leaves survivors alone when the missing parent was never dropped', () => {
    // Arrange — parentUuid points at a uuid that simply never appeared
    const validator = createTranscriptAdmissionValidator()
    const orphan = makeEntry('user', randomUUID() as UUID, { content: 'o' })
    const dropped = makeEntry('user', null, null)
    const messages = new Map<UUID, { parentUuid: UUID | null }>()

    // Act
    validator.admit(dropped, messages)
    validator.admit(orphan, messages)
    messages.set(orphan.uuid, orphan)
    validator.finish(messages)

    // Assert — unchanged (official only rewrites parents present in the map)
    expect(messages.get(orphan.uuid)?.parentUuid).toBe(orphan.parentUuid)
  })

  test('logs when rows were dropped even with an empty messages map', () => {
    // Arrange
    const validator = createTranscriptAdmissionValidator()
    const dropped = makeEntry('user', null, null)

    // Act
    validator.admit(dropped, new Map())
    validator.finish(new Map())

    // Assert
    expect(debugLines).toHaveLength(1)
    expect(debugLines[0]?.message).toContain('dropped 1 unreadable row(s)')
  })
})
