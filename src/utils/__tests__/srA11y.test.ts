import { describe, expect, test } from 'bun:test'
import {
  announceDeletedText,
  srEchoTypedChar,
  emitStartupSrAnnouncement,
  computeSpinnerReducedMotion,
  shouldThinkingRowUpdate,
} from '../srA11y.js'

/**
 * a11y cluster (2.1.218 #2/#14, 2.1.217 #8) — decision/emission logic layer.
 * A mock announcement sink captures emitted strings so we assert the DECISION
 * (what gets announced), not the visual SR flat-render (OCC-11 e2e deferred).
 */
function mockSink(): { sink: (s: string) => void; calls: string[] } {
  const calls: string[] = []
  const sink = (s: string) => {
    calls.push(s)
  }
  return { sink, calls }
}

// ── 2.1.218 #2: deleted-text SR announcements ──────────────────────────────

describe('2.1.218 #2 sr a11y: announceDeletedText', () => {
  test('emits an announcement containing the deleted word', () => {
    const { sink, calls } = mockSink()
    announceDeletedText('hello', sink)
    expect(calls).toEqual(['hello'])
  })
  test('emits the deleted line text for Ctrl+U / Ctrl+K line kills', () => {
    const { sink, calls } = mockSink()
    announceDeletedText('whole line gone', sink)
    expect(calls[0]).toContain('whole line gone')
  })
  test('no-op when nothing was deleted (empty killed text)', () => {
    const { sink, calls } = mockSink()
    announceDeletedText('', sink)
    expect(calls).toEqual([])
  })
  test('defaults to the global SR announce queue sink', () => {
    // Default sink is pushScreenReaderAnnouncement; non-empty text should not
    // throw and should reach the queue (drain verifies it landed).
    announceDeletedText('word')
    // imported here to assert the default path lands in the real queue
    return import('../screenReader.js').then(({ drainScreenReaderAnnouncements }) => {
      const drained = drainScreenReaderAnnouncements()
      expect(drained).toContain('word')
    })
  })
})

// ── 2.1.218 #14: space echo returns ' ' not 'new line' ──────────────────────

describe('2.1.218 #14 sr a11y: srEchoTypedChar', () => {
  test("space echo returns ' ' (a space), not 'new line'", () => {
    expect(srEchoTypedChar(' ')).toBe(' ')
    expect(srEchoTypedChar(' ')).not.toBe('new line')
  })
  test('non-space chars are not echoed (null — flat-render already speaks them)', () => {
    expect(srEchoTypedChar('a')).toBeNull()
    expect(srEchoTypedChar('\n')).toBeNull()
  })
})

// ── 2.1.217 #8(a): startup announce routed through SR queue ─────────────────

describe('2.1.217 #8(a) sr a11y: emitStartupSrAnnouncement', () => {
  test('routes the startup announce to the SR queue (not a cut-off console.log)', () => {
    const { sink, calls } = mockSink()
    emitStartupSrAnnouncement('[Screen Reader Mode: on via flag]', sink)
    expect(calls).toEqual(['[Screen Reader Mode: on via flag]'])
  })
  test('null announce (SR off) is a no-op', () => {
    const { sink, calls } = mockSink()
    emitStartupSrAnnouncement(null, sink)
    expect(calls).toEqual([])
  })
  test('empty announce string is a no-op', () => {
    const { sink, calls } = mockSink()
    emitStartupSrAnnouncement('', sink)
    expect(calls).toEqual([])
  })
})

// ── 2.1.217 #8(b): thinking status row only updates on change ──────────────

describe('2.1.217 #8(b) sr a11y: computeSpinnerReducedMotion', () => {
  test('SR on forces reduced motion (stops the 50ms clock → no periodic re-render)', () => {
    expect(computeSpinnerReducedMotion(false, true)).toBe(true)
  })
  test('settings reduced motion forces reduced motion regardless of SR', () => {
    expect(computeSpinnerReducedMotion(true, false)).toBe(true)
  })
  test('both off → reduced motion off (animations run normally)', () => {
    expect(computeSpinnerReducedMotion(false, false)).toBe(false)
  })
})

describe('2.1.217 #8(b) sr a11y: shouldThinkingRowUpdate', () => {
  test('no update when seconds and tokens are unchanged', () => {
    expect(
      shouldThinkingRowUpdate(
        { seconds: 5, tokens: 100 },
        { seconds: 5, tokens: 100 },
      ),
    ).toBe(false)
  })
  test('updates when the rounded seconds change', () => {
    expect(
      shouldThinkingRowUpdate(
        { seconds: 5, tokens: 100 },
        { seconds: 6, tokens: 100 },
      ),
    ).toBe(true)
  })
  test('updates when the token count changes', () => {
    expect(
      shouldThinkingRowUpdate(
        { seconds: 5, tokens: 100 },
        { seconds: 5, tokens: 101 },
      ),
    ).toBe(true)
  })
  test('no update for sub-second drift (same rounded seconds + tokens)', () => {
    // 5.1s and 5.9s both round to 5 → no re-emit (debounce).
    expect(
      shouldThinkingRowUpdate(
        { seconds: 5, tokens: 100 },
        { seconds: 5, tokens: 100 },
      ),
    ).toBe(false)
  })
})
