/**
 * CC 2.1.275 (ITEM M1/M2/M3) — load-time integration tests for
 * loadTranscriptFile's new admission + attachment validation wiring.
 *
 * Covers the three 2.1.275 changelog fixes at the single load choke point
 * (all resume/preview/fork/rewind paths funnel through loadTranscriptFile):
 * - M3: a bare `null` JSONL line no longer aborts the WHOLE load (before the
 *   fix it threw inside isTranscriptMessage → outer catch → empty map); it is
 *   skipped and counted as a dropped row.
 * - M2: malformed user/assistant payloads (message:null, non-array content,
 *   junk content blocks) are dropped/stripped at load time with the official
 *   warn log; survivors pointing at dropped rows are re-chained.
 * - M1: attachment rows with missing/malformed payloads (official v276 `Lms`
 *   per-type validation) are dropped with the official error log.
 *
 * Byte-exact log templates (verified against the official v276 binary):
 *   warn  @200792324: `transcript load: removed ${r} malformed content block(s) from ${n} row(s) and dropped ${s} unreadable row(s)`
 *   error @199663065: `transcript load: dropped ${n} attachment entry|entries with a missing or malformed payload — the session transcript appears partially corrupt`
 *
 * Mock plumbing follows the OCC-97/129 convention (effortCap267.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Mock plumbing — installed BEFORE the module under test is imported so its
// live bindings resolve to the capture shim.
// ---------------------------------------------------------------------------

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
  // OCC-97 leak guard: re-pin the REAL function reference captured pre-mock.
  mockActive = false
  mock.module('../debug.js', () => ({
    ...actualDebugModule,
    logForDebugging: actualLogForDebugging,
  }))
})

const { loadTranscriptFile } = await import('../sessionStorage.js')

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

let tempDir = ''

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'occ-transcript-276-'))
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

beforeEach(() => {
  debugLines.length = 0
})

const SESSION_ID = randomUUID()

function baseFields(): Record<string, unknown> {
  return {
    cwd: tempDir,
    userType: 'external',
    sessionId: SESSION_ID,
    timestamp: '2026-09-19T00:00:00.000Z',
    version: '2.1.276',
    isSidechain: false,
  }
}

function userRow(
  uuid: UUID,
  parentUuid: UUID | null,
  content: unknown = 'hi',
): Record<string, unknown> {
  return {
    ...baseFields(),
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content },
  }
}

function assistantRow(
  uuid: UUID,
  parentUuid: UUID | null,
  content: unknown = [{ type: 'text', text: 'hello' }],
): Record<string, unknown> {
  return {
    ...baseFields(),
    type: 'assistant',
    uuid,
    parentUuid,
    message: { role: 'assistant', content },
  }
}

function attachmentRow(
  uuid: UUID,
  parentUuid: UUID | null,
  attachment: unknown,
): Record<string, unknown> {
  return {
    ...baseFields(),
    type: 'attachment',
    uuid,
    parentUuid,
    attachment,
  }
}

async function writeFixture(
  lines: Array<Record<string, unknown> | string>,
): Promise<string> {
  const filePath = join(tempDir, `${randomUUID()}.jsonl`)
  const body = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n')
  await writeFile(filePath, `${body}\n`, 'utf8')
  return filePath
}

function transcriptLoadLogs(): Array<{ message: string; level?: string }> {
  return debugLines.filter((line) =>
    line.message.startsWith('transcript load:'),
  )
}

const WARN_DROPPED_1 =
  'transcript load: removed 0 malformed content block(s) from 0 row(s) and dropped 1 unreadable row(s)'
const ERROR_ATTACHMENT_1 =
  'transcript load: dropped 1 attachment entry with a missing or malformed payload — the session transcript appears partially corrupt'

// ---------------------------------------------------------------------------
// M3 — bare null line / whole-load abort fix
// ---------------------------------------------------------------------------

describe('loadTranscriptFile — M3 bare null line', () => {
  test('loads successfully with a bare null line, counting it as a dropped row', async () => {
    // Arrange — before the fix, `null` threw inside isTranscriptMessage and
    // the outer catch emptied the WHOLE transcript.
    const u1 = randomUUID() as UUID
    const a1 = randomUUID() as UUID
    const filePath = await writeFixture([
      userRow(u1, null),
      'null',
      assistantRow(a1, u1),
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert
    expect(result.messages.size).toBe(2)
    expect(result.messages.has(u1)).toBe(true)
    expect(result.messages.has(a1)).toBe(true)
    expect(transcriptLoadLogs()).toEqual([
      { message: WARN_DROPPED_1, level: 'warn' },
    ])
  })

  test('counts multiple bare null lines in one warn log', async () => {
    // Arrange
    const u1 = randomUUID() as UUID
    const filePath = await writeFixture([
      'null',
      userRow(u1, null),
      'null',
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert
    expect(result.messages.size).toBe(1)
    expect(transcriptLoadLogs()).toEqual([
      {
        message:
          'transcript load: removed 0 malformed content block(s) from 0 row(s) and dropped 2 unreadable row(s)',
        level: 'warn',
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// M2 — malformed user/assistant payloads
// ---------------------------------------------------------------------------

describe('loadTranscriptFile — M2 malformed message payloads', () => {
  test('drops a user row whose message.content is a number', async () => {
    // Arrange
    const u1 = randomUUID() as UUID
    const bad = randomUUID() as UUID
    const filePath = await writeFixture([
      userRow(u1, null),
      userRow(bad, u1, 42),
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert
    expect(result.messages.has(bad)).toBe(false)
    expect(result.messages.has(u1)).toBe(true)
    expect(transcriptLoadLogs()).toEqual([
      { message: WARN_DROPPED_1, level: 'warn' },
    ])
  })

  test('drops a row with message:null', async () => {
    // Arrange
    const bad = randomUUID() as UUID
    const row = userRow(bad, null)
    row.message = null
    const filePath = await writeFixture([row])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert
    expect(result.messages.size).toBe(0)
    expect(transcriptLoadLogs()).toEqual([
      { message: WARN_DROPPED_1, level: 'warn' },
    ])
  })

  test('strips junk content blocks, keeps the row, and reports counts', async () => {
    // Arrange
    const a1 = randomUUID() as UUID
    const filePath = await writeFixture([
      assistantRow(a1, null, [{ type: 'text', text: 'ok' }, 'junk', null, {}]),
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert — row kept, junk stripped in place (official iFs mutation)
    expect(result.messages.size).toBe(1)
    const kept = result.messages.get(a1)
    expect(kept?.message).toBeDefined()
    expect((kept?.message as { content: unknown }).content).toEqual([
      { type: 'text', text: 'ok' },
    ])
    expect(transcriptLoadLogs()).toEqual([
      {
        message:
          'transcript load: removed 3 malformed content block(s) from 1 row(s) and dropped 0 unreadable row(s)',
        level: 'warn',
      },
    ])
  })

  test('drops an all-junk content row entirely', async () => {
    // Arrange
    const bad = randomUUID() as UUID
    const filePath = await writeFixture([
      assistantRow(bad, null, ['junk', null, {}]),
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert
    expect(result.messages.size).toBe(0)
    expect(transcriptLoadLogs()).toEqual([
      { message: WARN_DROPPED_1, level: 'warn' },
    ])
  })

  test('re-chains a child of a dropped row to the surviving grandparent', async () => {
    // Arrange — u1 (kept) → bad (message:null, dropped) → a2 (kept)
    const u1 = randomUUID() as UUID
    const bad = randomUUID() as UUID
    const a2 = randomUUID() as UUID
    const badRow = userRow(bad, u1)
    badRow.message = null
    const filePath = await writeFixture([
      userRow(u1, null),
      badRow,
      assistantRow(a2, bad),
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert — chain repaired to the nearest surviving ancestor
    expect(result.messages.size).toBe(2)
    expect(result.messages.get(a2)?.parentUuid).toBe(u1)
    expect(transcriptLoadLogs()).toEqual([
      { message: WARN_DROPPED_1, level: 'warn' },
    ])
  })

  test('terminates on a cycle in the dropped chain', async () => {
    // Arrange — x ↔ y drop-cycle (both message:null), survivor s → x
    const x = randomUUID() as UUID
    const y = randomUUID() as UUID
    const s = randomUUID() as UUID
    const rowX = userRow(x, y)
    rowX.message = null
    const rowY = userRow(y, x)
    rowY.message = null
    const filePath = await writeFixture([rowX, rowY, userRow(s, x)])

    // Act — must complete without hanging
    const result = await loadTranscriptFile(filePath)

    // Assert — cycle resolves to null
    expect(result.messages.size).toBe(1)
    expect(result.messages.get(s)?.parentUuid).toBeNull()
    expect(transcriptLoadLogs()).toEqual([
      {
        message:
          'transcript load: removed 0 malformed content block(s) from 0 row(s) and dropped 2 unreadable row(s)',
        level: 'warn',
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// M1 — attachment payload validation (official v276 Lms/xW)
// ---------------------------------------------------------------------------

describe('loadTranscriptFile — M1 attachment payload validation', () => {
  test('drops a task_reminder attachment with non-array content and logs the byte-exact error', async () => {
    // Arrange
    const u1 = randomUUID() as UUID
    const att = randomUUID() as UUID
    const filePath = await writeFixture([
      userRow(u1, null),
      attachmentRow(att, u1, { type: 'task_reminder', content: 'x' }),
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert
    expect(result.messages.has(att)).toBe(false)
    expect(result.messages.has(u1)).toBe(true)
    expect(transcriptLoadLogs()).toEqual([
      { message: ERROR_ATTACHMENT_1, level: 'error' },
    ])
  })

  test('drops a file attachment with null content', async () => {
    // Arrange
    const att = randomUUID() as UUID
    const filePath = await writeFixture([
      attachmentRow(att, null, { type: 'file', content: null }),
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert
    expect(result.messages.size).toBe(0)
    expect(transcriptLoadLogs()).toEqual([
      { message: ERROR_ATTACHMENT_1, level: 'error' },
    ])
  })

  test('pluralizes the error log for multiple dropped attachments', async () => {
    // Arrange
    const att1 = randomUUID() as UUID
    const att2 = randomUUID() as UUID
    const filePath = await writeFixture([
      attachmentRow(att1, null, { type: 'todo_reminder' }),
      attachmentRow(att2, null, { type: 'already_read_file' }),
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert
    expect(result.messages.size).toBe(0)
    expect(transcriptLoadLogs()).toEqual([
      {
        message:
          'transcript load: dropped 2 attachment entries with a missing or malformed payload — the session transcript appears partially corrupt',
        level: 'error',
      },
    ])
  })

  test('drops an attachment row with a non-object payload', async () => {
    // Arrange
    const att = randomUUID() as UUID
    const filePath = await writeFixture([
      attachmentRow(att, null, null),
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert — invalid per Lms head check (typeof !== object || null)
    expect(result.messages.size).toBe(0)
    expect(transcriptLoadLogs()).toEqual([
      { message: ERROR_ATTACHMENT_1, level: 'error' },
    ])
  })

  test('keeps well-formed v276 attachment payloads without any logs', async () => {
    // Arrange — one valid row per validated type (official default:true for
    // unknown types; OCC skill_listing has no `names` → valid via absence)
    const ids = Array.from({ length: 6 }, () => randomUUID() as UUID)
    const filePath = await writeFixture([
      attachmentRow(ids[0] as UUID, null, {
        type: 'invoked_skills',
        skills: [{ name: 'a' }],
      }),
      attachmentRow(ids[1] as UUID, ids[0] as UUID, {
        type: 'hook_success',
        content: 'ok',
      }),
      attachmentRow(ids[2] as UUID, ids[1] as UUID, {
        type: 'skill_listing',
        content: 'listing',
        skillCount: 2,
        isInitial: true,
      }),
      attachmentRow(ids[3] as UUID, ids[2] as UUID, {
        type: 'hook_additional_context',
        content: ['ctx-a', 'ctx-b'],
      }),
      attachmentRow(ids[4] as UUID, ids[3] as UUID, {
        type: 'task_reminder',
        content: [{ id: 't1' }],
        itemCount: 1,
      }),
      attachmentRow(ids[5] as UUID, ids[4] as UUID, {
        type: 'file',
        filename: '/tmp/x.txt',
        content: { type: 'text', file: { filePath: '/tmp/x.txt' } },
        displayPath: 'x.txt',
      }),
    ])

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert
    expect(result.messages.size).toBe(6)
    expect(transcriptLoadLogs()).toEqual([])
  })

  test('attachment drops do not pollute the admission warn log', async () => {
    // Arrange — admission gates only user/assistant; a dropped attachment
    // must produce ONLY the error log, never the warn log.
    const att = randomUUID() as UUID
    const filePath = await writeFixture([
      attachmentRow(att, null, { type: 'file', content: 42 }),
    ])

    // Act
    await loadTranscriptFile(filePath)

    // Assert
    const logs = transcriptLoadLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]?.level).toBe('error')
    expect(logs[0]?.message).not.toContain('unreadable row(s)')
  })
})

// ---------------------------------------------------------------------------
// Clean-load invariant
// ---------------------------------------------------------------------------

describe('loadTranscriptFile — clean transcripts are untouched', () => {
  test('a well-formed transcript loads with zero logs and byte-identical rows in file order', async () => {
    // Arrange
    const u1 = randomUUID() as UUID
    const a1 = randomUUID() as UUID
    const u2 = randomUUID() as UUID
    const rows = [
      userRow(u1, null, 'first prompt'),
      assistantRow(a1, u1, [{ type: 'text', text: 'first reply' }]),
      userRow(u2, a1, [{ type: 'text', text: 'second prompt' }]),
    ]
    const filePath = await writeFixture(rows)

    // Act
    const result = await loadTranscriptFile(filePath)

    // Assert — all rows present, insertion order = file order, content
    // byte-identical to the fixture, no admission/attachment logs at all.
    expect(result.messages.size).toBe(3)
    expect([...result.messages.keys()]).toEqual([u1, a1, u2])
    expect(result.messages.get(u1)).toEqual(
      JSON.parse(JSON.stringify(rows[0] as object)),
    )
    expect(result.messages.get(a1)).toEqual(
      JSON.parse(JSON.stringify(rows[1] as object)),
    )
    expect(result.messages.get(u2)).toEqual(
      JSON.parse(JSON.stringify(rows[2] as object)),
    )
    expect(transcriptLoadLogs()).toEqual([])
  })
})
