import { describe, expect, test } from 'bun:test'
import { reviewNoteEnv } from '../reviewNote.js'

/**
 * CC 2.1.218 #8 — `/ultrareview` descriptive arguments run a branch review
 * with the text applied as a note to the findings.
 *
 * OCC already routes non-numeric args to branch mode (it never rejected
 * them); the missing piece is the note pass-through. The note is carried on
 * the `BUGHUNTER_REVIEW_NOTE` env var — the only OCC-controlled channel into
 * the cloud bughunter.
 */
describe('2.1.218 #8 — reviewNoteEnv', () => {
  test('descriptive free-text arg becomes a BUGHUNTER_REVIEW_NOTE', () => {
    const env = reviewNoteEnv('review my auth changes')
    expect(env).toEqual({ BUGHUNTER_REVIEW_NOTE: 'review my auth changes' })
  })

  test('descriptive arg is trimmed before note is set', () => {
    const env = reviewNoteEnv('   focus on the auth module   ')
    expect(env).toEqual({ BUGHUNTER_REVIEW_NOTE: 'focus on the auth module' })
  })

  test('pure PR number is NOT treated as a note (PR mode unaffected)', () => {
    expect(reviewNoteEnv('42')).toEqual({})
    expect(reviewNoteEnv('  007  ')).toEqual({})
  })

  test('empty argument produces no note overlay', () => {
    expect(reviewNoteEnv('')).toEqual({})
    expect(reviewNoteEnv('   ')).toEqual({})
  })

  test('mixed alphanumeric arg (not a pure PR number) is a note', () => {
    // A descriptive arg that happens to start with digits must still be a
    // note, not a PR number — the PR-number gate is strictly /^\d+$/.
    const env = reviewNoteEnv('401k migration review')
    expect(env).toEqual({ BUGHUNTER_REVIEW_NOTE: '401k migration review' })
  })
})
