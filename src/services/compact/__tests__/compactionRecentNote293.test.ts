import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendPreservedMessagesNote,
  applyPreservedMessagesNote,
  getCompactUserSummaryMessage,
  PRESERVED_RECENT_MESSAGES_NOTE,
} from '../prompt.js'

/**
 * Official Claude Code 2.1.293 changelog entry #4 — compaction "own last
 * actions before compaction treated as after".
 *
 * vver binary @214875400 (byte-verified via /bin/grep -aboF + dd):
 *
 *   var iJt="The messages after this summary are the most recent messages
 *   from before compaction, kept verbatim. The summary was written without
 *   seeing them, so something it says has not happened yet may already have
 *   happened in them.";
 *   function gJt(e){let{content:n}=e.message;return{...e,message:{...e.message,
 *     content:typeof n==="string"?`${n}\n\n${iJt}`:[...n,{type:"text",text:iJt}]}}}
 *
 * Application gate (vver @214897600 commit path):
 *   vt=Ne.length>0?n.summaryMessages.map(gJt):n.summaryMessages
 * — only when preserved tail messages exist, only on the reactive/session-memory
 * compact commit path. Full/partial compact paths do NOT get the note.
 *
 * 293 also DELETES the dead 292 branch: `if(n?.recentMessagesPreserved)g+=
 * "\n\nRecent messages are preserved verbatim."` (0 hits for both the sentence
 * and `recentMessagesPreserved` in the 293 binary). OCC kept that dead branch
 * alive (prompt.ts 4th param + sessionMemoryCompact passing true) — removed here.
 */

// Byte-for-byte copy of official 2.1.293 `iJt`.
const OFFICIAL_IJT_NOTE =
  'The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them.'

// Built by concatenation so this test file never contains the removed
// sentence as a contiguous literal (keeps grep-level assertions clean).
const REMOVED_292_SENTENCE = `${'Recent messages are preserved verbatim'}.`
const REMOVED_292_PARAM = `recentMessages${'Preserved'}`

function makeUserMessage(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: 'user' as const,
    uuid: 'aaaa1111-2222-3333-4444-555566667777',
    isCompactSummary: true as const,
    message: { role: 'user', content },
    ...extra,
  }
}

describe('2.1.293 #4 — PRESERVED_RECENT_MESSAGES_NOTE constant (iJt)', () => {
  test('byte-equals the official 2.1.293 iJt note', () => {
    expect(PRESERVED_RECENT_MESSAGES_NOTE).toBe(OFFICIAL_IJT_NOTE)
  })
})

describe('2.1.293 #4 — appendPreservedMessagesNote mirrors official gJt', () => {
  test('string content: appends "\\n\\n" + note (exact gJt string branch)', () => {
    // Arrange
    const msg = makeUserMessage('Summary:\nEarlier work happened.')

    // Act
    const result = appendPreservedMessagesNote(msg)

    // Assert — `${n}\n\n${iJt}` verbatim
    expect(result.message.content).toBe(
      `Summary:\nEarlier work happened.\n\n${OFFICIAL_IJT_NOTE}`,
    )
  })

  test('array content: pushes {type:"text",text:note} as last block (exact gJt array branch)', () => {
    // Arrange
    const blocks = [
      { type: 'text' as const, text: 'part one' },
      { type: 'text' as const, text: 'part two' },
    ]
    const msg = makeUserMessage(blocks)

    // Act
    const result = appendPreservedMessagesNote(msg)

    // Assert — `[...n,{type:"text",text:iJt}]` verbatim; note is LAST
    const content = result.message.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(3)
    expect(content[0]).toEqual({ type: 'text', text: 'part one' })
    expect(content[1]).toEqual({ type: 'text', text: 'part two' })
    expect(content[2]).toEqual({ type: 'text', text: OFFICIAL_IJT_NOTE })
  })

  test('preserves all other message fields and does not mutate the original (immutable spread)', () => {
    // Arrange
    const msg = makeUserMessage('original', { isVisibleInTranscriptOnly: true })
    const before = JSON.parse(JSON.stringify(msg))

    // Act
    const result = appendPreservedMessagesNote(msg)

    // Assert — {...e, message:{...e.message, ...}} keeps uuid/type/flags
    expect(result.uuid).toBe(msg.uuid)
    expect(result.type).toBe('user')
    expect(result.isCompactSummary).toBe(true)
    expect(result.isVisibleInTranscriptOnly).toBe(true)
    expect(result).not.toBe(msg)
    expect(result.message).not.toBe(msg.message)
    // Original untouched
    expect(JSON.parse(JSON.stringify(msg))).toEqual(before)
  })
})

describe('2.1.293 #4 — application gate (vt=Ne.length>0?map(gJt):summaryMessages)', () => {
  test('applies the note to EVERY summary message when preserved tail exists', () => {
    // Arrange
    const summaryMessages = [makeUserMessage('s1'), makeUserMessage('s2')]
    const messagesToKeep = [{ uuid: 'keep-1' }, { uuid: 'keep-2' }]

    // Act
    const result = applyPreservedMessagesNote(summaryMessages, messagesToKeep)

    // Assert — every summary message got the note, original bodies preserved
    expect(result).toHaveLength(2)
    expect(String(result[0]!.message.content)).toBe(`s1\n\n${OFFICIAL_IJT_NOTE}`)
    expect(String(result[1]!.message.content)).toBe(`s2\n\n${OFFICIAL_IJT_NOTE}`)
    // Input array not mutated in place
    expect(String(summaryMessages[0]!.message.content)).toBe('s1')
  })

  test('does NOT apply the note when messagesToKeep is empty (pass-through, same array)', () => {
    // Arrange
    const summaryMessages = [makeUserMessage('s1')]

    // Act
    const result = applyPreservedMessagesNote(summaryMessages, [])

    // Assert — official returns n.summaryMessages unchanged
    expect(result).toBe(summaryMessages)
    expect(String(result[0]!.message.content)).not.toContain(OFFICIAL_IJT_NOTE)
  })
})

describe('2.1.293 #4 — getCompactUserSummaryMessage: dead 292 branch deleted', () => {
  test('signature has exactly 3 parameters (4th recentMessagesPreserved param gone)', () => {
    expect(getCompactUserSummaryMessage.length).toBe(3)
  })

  test('old 292 sentence is never emitted for ANY argument combination', () => {
    const combos: Array<[string, boolean | undefined, string | undefined, ...boolean[]]> = [
      ['summary text', undefined, undefined],
      ['summary text', true, undefined],
      ['summary text', false, undefined],
      ['summary text', undefined, '/tmp/transcript.jsonl'],
      ['summary text', true, '/tmp/transcript.jsonl'],
      ['summary text', false, '/tmp/transcript.jsonl'],
      // Even a smuggled legacy 4th positional arg must not resurrect it
      ['summary text', true, '/tmp/transcript.jsonl', true],
      ['summary text', false, undefined, true],
    ]
    for (const combo of combos) {
      const out = (getCompactUserSummaryMessage as (...a: unknown[]) => string)(...combo)
      expect(out).not.toContain(REMOVED_292_SENTENCE)
      // The builder itself never contains the new note either — official `v3`
      // builds the summary; `gJt` attaches the note at commit time only.
      expect(out).not.toContain(OFFICIAL_IJT_NOTE)
    }
  })

  test('note attaches AFTER the builder suffixes (official position: end of summary message content)', () => {
    // Arrange — builder output with transcript suffix + SM-truncation-style suffix
    const built = getCompactUserSummaryMessage(
      'summary text',
      true,
      '/tmp/transcript.jsonl',
    )
    const withOccSuffix = `${built}\n\nSome session memory sections were truncated for length.`
    const msg = makeUserMessage(withOccSuffix)

    // Act
    const result = appendPreservedMessagesNote(msg)

    // Assert — note is the very last text; transcript sentence comes before it
    const content = String(result.message.content)
    expect(content.endsWith(OFFICIAL_IJT_NOTE)).toBe(true)
    expect(content.indexOf('read the full transcript at:')).toBeLessThan(
      content.indexOf(OFFICIAL_IJT_NOTE),
    )
    expect(content.indexOf('Some session memory sections were truncated')).toBeLessThan(
      content.indexOf(OFFICIAL_IJT_NOTE),
    )
  })
})

describe('2.1.293 #4 — grep-level: old sentence/param gone, new wiring present', () => {
  const compactDir = join(import.meta.dir, '..')

  function listSourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__') continue
        out.push(...listSourceFiles(full))
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
        out.push(full)
      }
    }
    return out
  }

  test('no source file under src/services/compact contains the removed 292 sentence or param', () => {
    for (const file of listSourceFiles(compactDir)) {
      const src = readFileSync(file, 'utf8')
      expect(src).not.toContain(REMOVED_292_SENTENCE)
      expect(src).not.toContain(REMOVED_292_PARAM)
    }
  })

  test('sessionMemoryCompact.ts wires the note gate (gJt equivalent) on the commit path', () => {
    const src = readFileSync(join(compactDir, 'sessionMemoryCompact.ts'), 'utf8')
    expect(src).toContain('applyPreservedMessagesNote')
    // Old live caller passing `true` as the 4th arg is gone
    expect(src).not.toContain(REMOVED_292_PARAM)
  })

  test('prompt.ts carries the verbatim official note constant', () => {
    const src = readFileSync(join(compactDir, 'prompt.ts'), 'utf8')
    expect(src).toContain(OFFICIAL_IJT_NOTE)
  })

  test('full/partial compact paths (compact.ts) do NOT attach the note (official scope)', () => {
    const src = readFileSync(join(compactDir, 'compact.ts'), 'utf8')
    expect(src).not.toContain('appendPreservedMessagesNote')
    expect(src).not.toContain('applyPreservedMessagesNote')
  })
})
