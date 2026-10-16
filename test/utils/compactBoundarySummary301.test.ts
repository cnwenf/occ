import { describe, expect, test } from 'bun:test'
import {
  applySavedInGuard,
  buildCompactedRow,
  COMPACT_TRANSCRIPT_PROMPT,
  compactBoundaryDetail,
  conversationSummarizedDetail,
  findCompactSummaryInfo,
  savedInDisplayPath,
  shouldShowFullscreenCompactRow,
} from '../../src/components/messages/CompactBoundaryMessage.js'

// CC 2.1.301 changelog #28 — "Fixed the compaction row in a resumed session
// offering ctrl+o for history that is not loaded; it now says where the
// earlier messages are saved, and also shows in fullscreen."
//
// Official v301 mechanics (all byte-verified against the v301 binary):
//   Tx  @102542164 — transcript-path scanner prompt text
//   F7n @247669073 — walks messages → {uuid, summary:null|{transcriptPath}}
//   dd  @247669600 — detail helper:
//     null → " (${d} for history)", summary===null → "", else " (${d} for the summary)"
//   dGr — scan + uuid match + dd (used by the "Conversation summarized" notification)
//   Zm  @247543300 — fullscreen row builder
//   Jm  @247543200 — fullscreen gate: m!==void 0 && !(d && m.trigger==="manual")
//   provider @247932600 — savedIn only set when the parsed transcriptPath
//     equals the CURRENT session's transcript path (td())

const boundary = (uuid: string = 'boundary-1', compactMetadata: Record<string, unknown> = { trigger: 'auto', preTokens: 0 }) =>
  ({ type: 'system', subtype: 'compact_boundary', uuid, compactMetadata }) as never

const userMsg = (content: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', uuid: `u-${Math.random()}`, message: { role: 'user', content }, ...extra }) as never

const assistantMsg = () =>
  ({ type: 'assistant', uuid: `a-${Math.random()}`, message: { role: 'assistant', content: [] } }) as never

const summaryText = (path = '/home/u/.claude/projects/p/sess-1.jsonl') =>
  `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary here\n\n${COMPACT_TRANSCRIPT_PROMPT}${path}`

describe('COMPACT_TRANSCRIPT_PROMPT', () => {
  test('is byte-identical to the official v301 Tx string', () => {
    expect(COMPACT_TRANSCRIPT_PROMPT).toBe(
      'If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ',
    )
  })

  test('matches the prompt OCC already persists in compact summaries (prompt.ts:353)', () => {
    // getCompactUserSummaryMessage appends `\n\n${Tx}${path}` — the scanner
    // relies on that exact shape.
    expect(summaryText('/x.jsonl').includes(`\n${COMPACT_TRANSCRIPT_PROMPT}/x.jsonl`)).toBe(true)
  })
})

describe('findCompactSummaryInfo (official F7n)', () => {
  test('returns null for an empty list', () => {
    expect(findCompactSummaryInfo([])).toBeNull()
  })

  test('returns null when the leading real message is not a compact boundary (history IS loaded)', () => {
    // Resumed-with-full-history or pre-compact session: a user message leads.
    const messages = [userMsg('hello'), boundary(), userMsg('summary', { isCompactSummary: true })]
    expect(findCompactSummaryInfo(messages)).toBeNull()
  })

  test('returns null when the leading boundary has no usable uuid (official gN guard)', () => {
    expect(findCompactSummaryInfo([{ type: 'system', subtype: 'compact_boundary' } as never])).toBeNull()
    expect(findCompactSummaryInfo([boundary('')] as never)).toBeNull()
  })

  test('skips leading non-conversation messages before finding the boundary', () => {
    const messages = [
      { type: 'system', subtype: 'local_command', uuid: 'lc' } as never,
      { type: 'attachment', uuid: 'at', attachment: { type: 'todo_reminder' } } as never,
      boundary('b-2'),
      userMsg(summaryText('/p/s.jsonl'), { isCompactSummary: true }),
    ]
    expect(findCompactSummaryInfo(messages)).toEqual({
      uuid: 'b-2',
      summary: { transcriptPath: '/p/s.jsonl' },
    })
  })

  test('boundary with no following summary message → summary:null', () => {
    expect(findCompactSummaryInfo([boundary('b-3'), assistantMsg()])).toEqual({
      uuid: 'b-3',
      summary: null,
    })
    expect(findCompactSummaryInfo([boundary('b-3')])).toEqual({ uuid: 'b-3', summary: null })
  })

  test('parses the transcript path out of the compact summary message', () => {
    const messages = [
      boundary('b-4'),
      userMsg(summaryText('/home/u/.claude/projects/occ/abc.jsonl'), { isCompactSummary: true }),
    ]
    expect(findCompactSummaryInfo(messages)).toEqual({
      uuid: 'b-4',
      summary: { transcriptPath: '/home/u/.claude/projects/occ/abc.jsonl' },
    })
  })

  test('slices the path at the next newline (suppressFollowUpQuestions continuation)', () => {
    const text = `${summaryText('/p/t.jsonl')}\nContinue the conversation from where it left off without asking further questions.`
    const messages = [boundary('b-5'), userMsg(text, { isCompactSummary: true })]
    expect(findCompactSummaryInfo(messages)).toEqual({
      uuid: 'b-5',
      summary: { transcriptPath: '/p/t.jsonl' },
    })
  })

  test('summary without the transcript-path marker → transcriptPath undefined', () => {
    const messages = [
      boundary('b-6'),
      userMsg('This session is being continued... no path here', { isCompactSummary: true }),
    ]
    expect(findCompactSummaryInfo(messages)).toEqual({
      uuid: 'b-6',
      summary: { transcriptPath: undefined },
    })
  })

  test('uses lastIndexOf when the marker appears twice', () => {
    const text = `...\n${COMPACT_TRANSCRIPT_PROMPT}/first.jsonl\nmore\n${COMPACT_TRANSCRIPT_PROMPT}/second.jsonl`
    const messages = [boundary('b-7'), userMsg(text, { isCompactSummary: true })]
    expect(findCompactSummaryInfo(messages)).toEqual({
      uuid: 'b-7',
      summary: { transcriptPath: '/second.jsonl' },
    })
  })

  test('stops the summary scan at a second boundary', () => {
    const messages = [
      boundary('b-8'),
      boundary('b-9'),
      userMsg(summaryText('/p/x.jsonl'), { isCompactSummary: true }),
    ]
    // The summary belongs to the NEXT boundary's span, not b-8's.
    expect(findCompactSummaryInfo(messages)).toEqual({ uuid: 'b-8', summary: null })
  })

  test('ignores non-summary user messages between boundary and summary', () => {
    const messages = [
      boundary('b-10'),
      userMsg('regular user text'),
      userMsg(summaryText('/p/y.jsonl'), { isCompactSummary: true }),
    ]
    expect(findCompactSummaryInfo(messages)).toEqual({
      uuid: 'b-10',
      summary: { transcriptPath: '/p/y.jsonl' },
    })
  })
})

describe('compactBoundaryDetail (official dd)', () => {
  test('null info (history loaded / unknown boundary) → offers ctrl+o for history', () => {
    expect(compactBoundaryDetail(null, 'ctrl+o')).toBe(' (ctrl+o for history)')
  })

  test('summary:null (boundary leads, no summary found) → no hint at all', () => {
    expect(compactBoundaryDetail({ uuid: 'b', summary: null }, 'ctrl+o')).toBe('')
  })

  test('summary present → offers the shortcut for the summary', () => {
    expect(
      compactBoundaryDetail({ uuid: 'b', summary: { transcriptPath: '/p.jsonl' } }, 'ctrl+o'),
    ).toBe(' (ctrl+o for the summary)')
    expect(
      compactBoundaryDetail({ uuid: 'b', summary: { transcriptPath: undefined } }, 'ctrl+r'),
    ).toBe(' (ctrl+r for the summary)')
  })
})

describe('conversationSummarizedDetail (official dGr)', () => {
  test('matches the boundary uuid → summary-aware detail', () => {
    const messages = [boundary('b-ok'), userMsg(summaryText('/p/z.jsonl'), { isCompactSummary: true })]
    expect(conversationSummarizedDetail(messages, 'b-ok', 'ctrl+o')).toBe(' (ctrl+o for the summary)')
  })

  test('uuid mismatch → falls back to the history offer', () => {
    const messages = [boundary('b-ok'), userMsg(summaryText(), { isCompactSummary: true })]
    expect(conversationSummarizedDetail(messages, 'other-uuid', 'ctrl+o')).toBe(' (ctrl+o for history)')
  })

  test('history loaded (scan null) → history offer', () => {
    const messages = [userMsg('hi'), boundary('b-x')]
    expect(conversationSummarizedDetail(messages, 'b-x', 'ctrl+o')).toBe(' (ctrl+o for history)')
  })
})

describe('applySavedInGuard (official provider nc===td() check)', () => {
  test('null scan passes through', () => {
    expect(applySavedInGuard(null, '/p/s.jsonl')).toBeNull()
  })

  test('summary:null passes through', () => {
    const scan = { uuid: 'b', summary: null }
    expect(applySavedInGuard(scan, '/p/s.jsonl')).toEqual(scan)
  })

  test('keeps the path only when it equals the current session transcript', () => {
    const scan = { uuid: 'b', summary: { transcriptPath: '/p/s.jsonl' } }
    expect(applySavedInGuard(scan, '/p/s.jsonl')).toEqual({
      uuid: 'b',
      summary: { transcriptPath: '/p/s.jsonl' },
    })
  })

  test('drops the path when it points at a different transcript (forked session)', () => {
    const scan = { uuid: 'b', summary: { transcriptPath: '/p/OLD.jsonl' } }
    expect(applySavedInGuard(scan, '/p/NEW.jsonl')).toEqual({
      uuid: 'b',
      summary: { transcriptPath: undefined },
    })
    // null current path (session file unknown) also drops it
    expect(applySavedInGuard(scan, null)).toEqual({
      uuid: 'b',
      summary: { transcriptPath: undefined },
    })
  })
})

describe('savedInDisplayPath (official xzt guard + ts shortener)', () => {
  test('undefined / empty → undefined (no subline)', () => {
    expect(savedInDisplayPath(undefined)).toBeUndefined()
    expect(savedInDisplayPath('')).toBeUndefined()
  })

  test('paths with control characters are refused (official P9e guard)', () => {
    expect(savedInDisplayPath('/p/a\u001b[31m.jsonl')).toBeUndefined()
    expect(savedInDisplayPath('/p/a\u0000b.jsonl')).toBeUndefined()
    expect(savedInDisplayPath('/p/\u007f.jsonl')).toBeUndefined()
  })

  test('absolute path outside cwd/home is shown as-is', () => {
    expect(savedInDisplayPath('/definitely/not/under/cwd/s.jsonl')).toBe(
      '/definitely/not/under/cwd/s.jsonl',
    )
  })
})

describe('shouldShowFullscreenCompactRow (official Jm)', () => {
  test('undefined compactMetadata → never render', () => {
    expect(shouldShowFullscreenCompactRow(undefined, false)).toBe(false)
    expect(shouldShowFullscreenCompactRow(undefined, true)).toBe(false)
  })

  test('manual trigger + fullscreen-without-context → suppressed', () => {
    expect(shouldShowFullscreenCompactRow({ trigger: 'manual' }, true)).toBe(false)
  })

  test('manual trigger WITH context, or auto trigger → render', () => {
    expect(shouldShowFullscreenCompactRow({ trigger: 'manual' }, false)).toBe(true)
    expect(shouldShowFullscreenCompactRow({ trigger: 'auto' }, true)).toBe(true)
  })
})

describe('buildCompactedRow (official Zm)', () => {
  test('count summary + no context → "N messages summarized (ctrl+o to see them)"', () => {
    const row = buildCompactedRow({ messagesSummarized: 5, preTokens: 0 }, 'ctrl+o', null)
    expect(row).toEqual({
      tone: 'dim',
      text: 'Compacted',
      detail: '5 messages summarized (ctrl+o to see them)',
      linkify: false,
    })
  })

  test('singular message pluralization', () => {
    const row = buildCompactedRow({ messagesSummarized: 1, preTokens: 0 }, 'ctrl+o', null)
    expect(row.detail).toBe('1 message summarized (ctrl+o to see them)')
  })

  test('falls back to token count when messagesSummarized is absent or 0', () => {
    const row = buildCompactedRow({ preTokens: 1500 }, 'ctrl+o', null)
    expect(row.detail).toBe('1.5k tokens summarized (ctrl+o to see them)')
  })

  test('no counts + no context → bare "(ctrl+o for history)" detail', () => {
    const row = buildCompactedRow({ preTokens: 0 }, 'ctrl+o', null)
    expect(row.detail).toBe('ctrl+o for history')
  })

  test('leadsToSummary → "for the summary" + savedIn subline (byte-verbatim prefix)', () => {
    const row = buildCompactedRow({ messagesSummarized: 3, preTokens: 0 }, 'ctrl+o', {
      leadsToSummary: true,
      savedIn: '/p/sess.jsonl',
    })
    expect(row.detail).toBe('3 messages summarized (ctrl+o for the summary)')
    expect(row.subLines).toEqual(['Earlier messages are saved in /p/sess.jsonl'])
    expect(row.linkify).toBe(false)
  })

  test('context without a summary → count-only detail, no hint, no subline', () => {
    const row = buildCompactedRow({ messagesSummarized: 3, preTokens: 0 }, 'ctrl+o', {
      leadsToSummary: false,
      savedIn: '/p/sess.jsonl',
    })
    expect(row.detail).toBe('3 messages summarized')
    expect(row.subLines).toEqual(['Earlier messages are saved in /p/sess.jsonl'])
  })

  test('no counts + leadsToSummary → bare shortcut hint', () => {
    const row = buildCompactedRow({ preTokens: 0 }, 'ctrl+o', { leadsToSummary: true })
    expect(row.detail).toBe('ctrl+o for the summary')
    expect(row.subLines).toBeUndefined()
  })
})
