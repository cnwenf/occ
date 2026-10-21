/**
 * CC 2.1.305 — compaction headTruncated notice ("earliest part … NOT covered
 * by this summary").
 *
 * Official 2.1.305 changelog: compaction that left the oldest messages out
 * now tells the model about it. OCC's truncateHeadForPTLRetry drops oldest
 * API-round groups on prompt-too-long retries; before this port Claude was
 * never told the summary doesn't cover them.
 *
 * Byte evidence (v306 linux-x64 ELF, read-only forensics — never executed):
 * composer `EZ` @~249154251 (dd window verified):
 *   `if(n?.headTruncated)h+=\`\n\nNote: the earliest part of the conversation
 *    was too large to include and is NOT covered by this summary${
 *    n.transcriptPath&&!ee()?" (the full transcript mentioned above still
 *    has it)":""}. If the task turns out to depend on something from that
 *    part, say so plainly rather than guessing at it.\``
 * Placement: appended AFTER the transcriptPath line and BEFORE the
 * suppressFollowUpQuestions continuation. Call sites pass
 * `headTruncated:Wt>0` (Wt = PTL head-truncation retry count).
 * OCC has no RC-withheld-summary gate (`ee()`), so the parenthetical
 * condition reduces to `transcriptPath` — the same guard that gates the
 * transcript line above the note ("mentioned above" stays accurate).
 *
 * Style mirrors compactionRecentNote293.test.ts / toolNamesUsed304.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCompactUserSummaryMessage } from '../prompt.js'

/** Byte-verbatim from v306 `EZ` @249154327 — parenthetical variant. */
const NOTE_WITH_TRANSCRIPT =
  '\n\nNote: the earliest part of the conversation was too large to include and is NOT covered by this summary (the full transcript mentioned above still has it). If the task turns out to depend on something from that part, say so plainly rather than guessing at it.'

/** Same note, no transcriptPath → official omits the parenthetical. */
const NOTE_WITHOUT_TRANSCRIPT =
  '\n\nNote: the earliest part of the conversation was too large to include and is NOT covered by this summary. If the task turns out to depend on something from that part, say so plainly rather than guessing at it.'

const NOTE_BODY_MARKER = 'NOT covered by this summary'
const TRANSCRIPT_PATH = '/tmp/occ-305-transcript.jsonl'

describe('CC 2.1.305 — getCompactUserSummaryMessage headTruncated note (official EZ)', () => {
  test('headTruncated=true WITH transcriptPath appends the note including the parenthetical', () => {
    // Arrange / Act
    const out = getCompactUserSummaryMessage(
      'summary text',
      false,
      TRANSCRIPT_PATH,
      undefined,
      true,
    )

    // Assert — byte-exact note, and it follows the transcript line
    // ("mentioned above" must actually be above).
    expect(out.endsWith(NOTE_WITH_TRANSCRIPT)).toBe(true)
    expect(out).toContain(`read the full transcript at: ${TRANSCRIPT_PATH}`)
    expect(out.indexOf('read the full transcript at:')).toBeLessThan(
      out.indexOf(NOTE_BODY_MARKER),
    )
  })

  test('headTruncated=true WITHOUT transcriptPath appends the note without the parenthetical', () => {
    // Arrange / Act
    const out = getCompactUserSummaryMessage(
      'summary text',
      false,
      undefined,
      undefined,
      true,
    )

    // Assert
    expect(out.endsWith(NOTE_WITHOUT_TRANSCRIPT)).toBe(true)
    expect(out).not.toContain('the full transcript mentioned above still has it')
  })

  test('headTruncated=false or undefined emits NO note', () => {
    // Arrange — every transcriptPath combination must stay note-free.
    const flags = [undefined, false] as const
    for (const flag of flags) {
      for (const transcriptPath of [undefined, TRANSCRIPT_PATH]) {
        // Act
        const out = getCompactUserSummaryMessage(
          'summary text',
          false,
          transcriptPath,
          undefined,
          flag,
        )

        // Assert
        expect(out).not.toContain(NOTE_BODY_MARKER)
      }
    }
  })

  test('official ordering: note lands BEFORE the suppressFollowUpQuestions continuation', () => {
    // Arrange / Act — official `EZ`: transcriptPath line → headTruncated note
    // → `if(n?.suppressFollowUpQuestions)` continuation.
    const out = getCompactUserSummaryMessage(
      'summary text',
      true,
      TRANSCRIPT_PATH,
      undefined,
      true,
    )

    // Assert
    const transcriptIdx = out.indexOf('read the full transcript at:')
    const noteIdx = out.indexOf(NOTE_BODY_MARKER)
    const continueIdx = out.indexOf(
      'Continue the conversation from where it left off',
    )
    expect(transcriptIdx).toBeGreaterThan(-1)
    expect(noteIdx).toBeGreaterThan(transcriptIdx)
    expect(continueIdx).toBeGreaterThan(noteIdx)
  })

  test('toolNamesUsed tag placement is unaffected by the new param', () => {
    // Arrange / Act — 2.1.304 #6 tag still renders between header and summary.
    const out = getCompactUserSummaryMessage(
      'summary text',
      false,
      TRANSCRIPT_PATH,
      ['Bash', 'Read'],
      true,
    )

    // Assert
    expect(out).toContain('Bash')
    expect(out.indexOf('Bash')).toBeLessThan(out.indexOf('summary text'))
    expect(out.endsWith(NOTE_WITH_TRANSCRIPT)).toBe(true)
  })
})

describe('CC 2.1.305 — grep-level: headTruncated threading from the PTL retry loops', () => {
  const compactDir = join(import.meta.dir, '..')

  test('both compact.ts call sites pass `ptlAttempts > 0` (official `headTruncated:Wt>0`)', () => {
    // Arrange — full compact (compactConversation, retry loop ~:501) and
    // partial compact (partialCompactConversation, retry loop ~:948).
    const src = readFileSync(join(compactDir, 'compact.ts'), 'utf8')

    // Act — every getCompactUserSummaryMessage( call in compact.ts must end
    // with the ptlAttempts-derived flag as its last argument.
    const callSites = src.match(
      /getCompactUserSummaryMessage\([\s\S]*?ptlAttempts > 0,\s*\)/g,
    )

    // Assert
    expect(callSites).not.toBeNull()
    expect(callSites!.length).toBe(2)
    // No unthreaded call site remains in compact.ts.
    const allCallSites = src.match(/getCompactUserSummaryMessage\(/g)
    expect(allCallSites!.length).toBe(2)
  })

  test('prompt.ts composer gates the note on headTruncated (official EZ shape)', () => {
    // Arrange
    const src = readFileSync(join(compactDir, 'prompt.ts'), 'utf8')

    // Assert
    expect(src).toContain('headTruncated?: boolean')
    expect(src).toContain('if (headTruncated) {')
    expect(src).toContain(NOTE_BODY_MARKER)
  })
})
