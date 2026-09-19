/**
 * CC 2.1.278 (ITEM D4) — resume-path row sanitizer (official `Gln`/`jln`
 * cluster, v277 binary; warn template `zln` byte-verified against the ELF).
 *
 * Changelog: "Fixed a crash when resuming a session whose saved history
 * contains an assistant message stored as a plain string."
 *
 * Covers (task spec):
 * - plain-string assistant row wrapped into [{type:'text',text:...}]
 * - blank/whitespace-only assistant string row dropped
 * - non-object content blocks filtered (invalid rows counted)
 * - the byte-exact "resume: ..." warn emitted (level 'warn')
 * - identity fast path + per-row throw keeps the row
 * - deserializeMessages integration (the resume pipeline choke point)
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Mock plumbing — installed BEFORE the modules under test are imported so
// their live bindings resolve to the capture shim (OCC-97/129 convention,
// sessionStorage.transcriptLoad276.test.ts).
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
  mockActive = false
  mock.module('../debug.js', () => ({
    ...actualDebugModule,
    logForDebugging: actualLogForDebugging,
  }))
})

const {
  classifyResumedRowPayload,
  formatResumeSanitizeWarn,
  sanitizeResumedRows,
} = await import('../transcriptAdmission.js')
const { deserializeMessages } = await import('../conversationRecovery.js')

type Row = { type: string; uuid?: string; message?: unknown }

function row(type: string, message: unknown): Row {
  return { type, uuid: randomUUID(), message }
}

describe('D4: classifyResumedRowPayload (official jln)', () => {
  test('wraps a non-blank assistant string into a text block (no citations)', () => {
    const message = { role: 'assistant', content: 'plain string answer' }
    const verdict = classifyResumedRowPayload('assistant', message)
    expect(verdict).toEqual({
      message,
      content: [{ type: 'text', text: 'plain string answer' }],
      droppedBlocks: 0,
      wrapped: true,
    })
    // Official wrap block has NO citations field.
    const wrapped = (verdict as { content: Array<Record<string, unknown>> })
      .content[0]!
    expect('citations' in wrapped).toBe(false)
  })

  test('drops a blank/whitespace-only assistant string', () => {
    expect(
      classifyResumedRowPayload('assistant', { role: 'assistant', content: '' }),
    ).toBe('drop')
    expect(
      classifyResumedRowPayload('assistant', {
        role: 'assistant',
        content: '   \n\t ',
      }),
    ).toBe('drop')
  })

  test('keeps a plain-string USER row untouched (only assistant wraps)', () => {
    expect(
      classifyResumedRowPayload('user', { role: 'user', content: 'hello' }),
    ).toBe('keep')
  })

  test('drops unreadable payloads (null / non-object message, non-array content)', () => {
    expect(classifyResumedRowPayload('assistant', null)).toBe('drop')
    expect(classifyResumedRowPayload('assistant', 'raw string')).toBe('drop')
    expect(
      classifyResumedRowPayload('assistant', {
        role: 'assistant',
        content: { nested: 'object' },
      }),
    ).toBe('drop')
  })

  test('filters non-object content blocks and counts them', () => {
    const verdict = classifyResumedRowPayload('assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'a' }, 'junk', 42, null, { type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
    })
    expect(verdict).toMatchObject({ droppedBlocks: 3, wrapped: false })
    expect((verdict as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
    ])
  })

  test('drops a row whose blocks are ALL invalid', () => {
    expect(
      classifyResumedRowPayload('assistant', {
        role: 'assistant',
        content: ['junk', 42],
      }),
    ).toBe('drop')
  })

  test('keeps a well-formed content array', () => {
    expect(
      classifyResumedRowPayload('assistant', {
        role: 'assistant',
        content: [{ type: 'text', text: 'fine' }],
      }),
    ).toBe('keep')
  })
})

describe('D4: formatResumeSanitizeWarn (official zln — byte-exact template)', () => {
  test('removed clause with pluralization', () => {
    expect(
      formatResumeSanitizeWarn('resume', {
        droppedBlocks: 2,
        cleanedRows: 1,
        wrappedRows: 0,
        droppedRows: 0,
      }),
    ).toBe('resume: removed 2 malformed content blocks from 1 row')
    expect(
      formatResumeSanitizeWarn('resume', {
        droppedBlocks: 1,
        cleanedRows: 1,
        wrappedRows: 0,
        droppedRows: 0,
      }),
    ).toBe('resume: removed 1 malformed content block from 1 row')
  })

  test('wrapped clause', () => {
    expect(
      formatResumeSanitizeWarn('resume', {
        droppedBlocks: 0,
        cleanedRows: 0,
        wrappedRows: 1,
        droppedRows: 0,
      }),
    ).toBe(
      'resume: wrapped the string content of 1 assistant row in a text block',
    )
    expect(
      formatResumeSanitizeWarn('resume', {
        droppedBlocks: 0,
        cleanedRows: 0,
        wrappedRows: 3,
        droppedRows: 0,
      }),
    ).toBe(
      'resume: wrapped the string content of 3 assistant rows in a text block',
    )
  })

  test('dropped clause', () => {
    expect(
      formatResumeSanitizeWarn('resume', {
        droppedBlocks: 0,
        cleanedRows: 0,
        wrappedRows: 0,
        droppedRows: 2,
      }),
    ).toBe('resume: dropped 2 unreadable rows')
    expect(
      formatResumeSanitizeWarn('resume', {
        droppedBlocks: 0,
        cleanedRows: 0,
        wrappedRows: 0,
        droppedRows: 1,
      }),
    ).toBe('resume: dropped 1 unreadable row')
  })

  test('all three clauses join with ", " in official order', () => {
    expect(
      formatResumeSanitizeWarn('resume', {
        droppedBlocks: 1,
        cleanedRows: 1,
        wrappedRows: 1,
        droppedRows: 1,
      }),
    ).toBe(
      'resume: removed 1 malformed content block from 1 row, wrapped the string content of 1 assistant row in a text block, dropped 1 unreadable row',
    )
  })
})

describe('D4: sanitizeResumedRows (official Gln)', () => {
  test('identity fast path: clean input returns the same array, no warn', () => {
    debugLines.length = 0
    const input = [
      row('user', { role: 'user', content: [{ type: 'text', text: 'hi' }] }),
      row('assistant', {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      }),
      row('system', { subtype: 'stop_hook_summary' }),
    ]
    expect(sanitizeResumedRows(input)).toBe(input)
    expect(debugLines).toHaveLength(0)
  })

  test('wraps string rows, drops blank/unreadable rows, filters junk blocks, warns once', () => {
    debugLines.length = 0
    const systemRow = row('system', { subtype: 'anything' })
    const wrapped = row('assistant', {
      role: 'assistant',
      id: 'msg_1',
      content: 'stored as a plain string',
    })
    const blank = row('assistant', { role: 'assistant', content: '   ' })
    const junk = row('assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'kept' }, 'bad-block'],
    })
    const unreadable = row('assistant', null)
    const result = sanitizeResumedRows([
      systemRow,
      wrapped,
      blank,
      junk,
      unreadable,
    ])
    // system passthrough (same ref), wrapped rebuilt, blank+unreadable gone,
    // junk filtered.
    expect(result[0]).toBe(systemRow)
    expect(result).toHaveLength(3)
    expect(result[1]!.message).toEqual({
      role: 'assistant',
      id: 'msg_1',
      content: [{ type: 'text', text: 'stored as a plain string' }],
    })
    // Original row not mutated (pure rebuild).
    expect((wrapped.message as { content: unknown }).content).toBe(
      'stored as a plain string',
    )
    expect(result[2]!.message).toMatchObject({
      content: [{ type: 'text', text: 'kept' }],
    })
    // Byte-exact warn: cleanedRows=1 (droppedBlocks=1), wrappedRows=1,
    // droppedRows=2 (blank + null-message).
    expect(debugLines).toEqual([
      {
        message:
          'resume: removed 1 malformed content block from 1 row, wrapped the string content of 1 assistant row in a text block, dropped 2 unreadable rows',
        level: 'warn',
      },
    ])
  })

  test('a per-row throw KEEPS the original row (official catch{return[y]})', () => {
    debugLines.length = 0
    const bomb = {
      type: 'assistant',
      uuid: randomUUID(),
      get message(): unknown {
        throw new Error('boom')
      },
    }
    const input = [bomb]
    const result = sanitizeResumedRows(input)
    expect(result).toBe(input)
    expect(result[0]).toBe(bomb)
    expect(debugLines).toHaveLength(0)
  })
})

describe('D4: deserializeMessages integration (resume pipeline)', () => {
  test('a plain-string assistant row survives resume wrapped in a text block', () => {
    debugLines.length = 0
    const serialized = [
      {
        type: 'user',
        uuid: randomUUID(),
        message: { role: 'user', content: 'tell me something' },
      },
      {
        type: 'assistant',
        uuid: randomUUID(),
        message: {
          role: 'assistant',
          id: 'msg_legacy',
          content: 'a legacy plain-string answer',
        },
      },
    ] as never[]
    let messages: Array<{ type: string; message?: { content?: unknown } }>
    expect(() => {
      messages = deserializeMessages(serialized) as never
    }).not.toThrow()
    const assistantRow = messages!.find(m => m.type === 'assistant')
    expect(assistantRow).toBeDefined()
    expect(assistantRow!.message!.content).toEqual([
      { type: 'text', text: 'a legacy plain-string answer' },
    ])
    expect(
      debugLines.some(
        line =>
          line.level === 'warn' &&
          line.message ===
            'resume: wrapped the string content of 1 assistant row in a text block',
      ),
    ).toBe(true)
  })
})
