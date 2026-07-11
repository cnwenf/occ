import { describe, expect, test } from 'bun:test'
import { computeNewMessagesPillText } from '../FullscreenLayout.js'

// 2.1.206 #23: pill chord display + truncation. Mirrors the binary's J8s
// logic: macOS+default → "(click) ↓"; rebound → "(chord) ↓"; else "↓";
// truncate to columns-2, falling back to bare base text.
describe('2.1.206 #23 computeNewMessagesPillText', () => {
  test('count=0 non-macOS default chord → "Jump to bottom ↓"', () => {
    expect(
      computeNewMessagesPillText({
        count: 0,
        bottomChord: 'ctrl+End',
        platform: 'linux',
        columns: 80,
      }),
    ).toBe('Jump to bottom ↓')
  })

  test('count>1 non-macOS default chord → "N new messages ↓"', () => {
    expect(
      computeNewMessagesPillText({
        count: 3,
        bottomChord: 'ctrl+End',
        platform: 'linux',
        columns: 80,
      }),
    ).toBe('3 new messages ↓')
  })

  test('count=1 uses singular "message"', () => {
    expect(
      computeNewMessagesPillText({
        count: 1,
        bottomChord: 'ctrl+End',
        platform: 'linux',
        columns: 80,
      }),
    ).toBe('1 new message ↓')
  })

  test('rebound chord (non-macOS) → "(chord) ↓"', () => {
    expect(
      computeNewMessagesPillText({
        count: 2,
        bottomChord: 'cmd+↓',
        platform: 'linux',
        columns: 80,
      }),
    ).toBe('2 new messages (cmd+↓) ↓')
  })

  test('macOS + default chord → "(click) ↓" (clickable pill hint)', () => {
    expect(
      computeNewMessagesPillText({
        count: 2,
        bottomChord: 'ctrl+End',
        platform: 'macos',
        columns: 80,
      }),
    ).toBe('2 new messages (click) ↓')
  })

  test('macOS + rebound chord → "(chord) ↓" (rebound overrides macOS-default branch)', () => {
    expect(
      computeNewMessagesPillText({
        count: 2,
        bottomChord: 'cmd+↓',
        platform: 'macos',
        columns: 80,
      }),
    ).toBe('2 new messages (cmd+↓) ↓')
  })

  test('raw fallback chord "ctrl+end" (no keybinding context) treated as default', () => {
    // useShortcutDisplay returns the raw fallback "ctrl+end" when the
    // keybinding context is unavailable; lowercase compare must still
    // recognize it as the default (no rebound chord shown).
    expect(
      computeNewMessagesPillText({
        count: 1,
        bottomChord: 'ctrl+end',
        platform: 'linux',
        columns: 80,
      }),
    ).toBe('1 new message ↓')
  })

  test('macOS + count=0 + default → "Jump to bottom (click) ↓"', () => {
    expect(
      computeNewMessagesPillText({
        count: 0,
        bottomChord: 'ctrl+End',
        platform: 'macos',
        columns: 80,
      }),
    ).toBe('Jump to bottom (click) ↓')
  })

  test('wide terminal returns full text including rebound chord', () => {
    const result = computeNewMessagesPillText({
      count: 5,
      bottomChord: 'cmd+shift+end',
      platform: 'linux',
      columns: 100,
    })
    expect(result).toBe('5 new messages (cmd+shift+end) ↓')
  })

  test('narrow terminal truncates full → falls back to "baseText ↓"', () => {
    // full = "2 new messages (cmd+↓) ↓" (~24 cells); withArrow = "2 new messages ↓" (16).
    // columns=20 → budget=18 → full(24) doesn't fit, withArrow(16) fits.
    const result = computeNewMessagesPillText({
      count: 2,
      bottomChord: 'cmd+↓',
      platform: 'linux',
      columns: 20,
    })
    expect(result).toBe('2 new messages ↓')
  })

  test('very narrow terminal → bare base text (?? baseText fallback)', () => {
    // No candidate fits columns-2; the ?? baseText arm returns base text
    // regardless of width (no further truncation, matching the binary).
    const result = computeNewMessagesPillText({
      count: 2,
      bottomChord: 'cmd+↓',
      platform: 'linux',
      columns: 5,
    })
    expect(result).toBe('2 new messages')
  })

  test('macOS "(click)" pill also truncates to base text on narrow terminals', () => {
    const result = computeNewMessagesPillText({
      count: 2,
      bottomChord: 'ctrl+End',
      platform: 'macos',
      columns: 5,
    })
    expect(result).toBe('2 new messages')
  })
})
