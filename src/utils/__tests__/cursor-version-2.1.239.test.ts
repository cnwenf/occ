import { describe, expect, test } from 'bun:test'
import { Cursor, MeasuredText } from '../Cursor.js'

/**
 * 2.1.239 catch-up unit tests (OCC-102). Covers the four landed clusters:
 *
 *  1. Placeholder family — imageRef* helpers converge to the official
 *     placeholder family (Pasted/Image/Audio/Truncated), all chip-aware
 *     movement and kills treat chips atomically.
 *  2. killRange rework — every kill routes through killRange with
 *     placeholder snapping at both endpoints.
 *  3. Readline word-boundary system — MeasuredText.getReadlineWordBoundaries
 *     + forwardWord/backwardWord/killWord/backwardKillWord.
 *  4. keybindingFlavor expansion — readline-vs-classic dispatch at the
 *     Cursor layer (hook-level dispatch is covered by the
 *     version-2.1.239-keybinding-flavor e2e).
 */

const CHIP_PASTED = '[Pasted text #1]'
const CHIP_PASTED_LINES = '[Pasted text #2 +10 lines]'
const CHIP_IMAGE = '[Image #3]'
const CHIP_AUDIO = '[Audio #4]'
const CHIP_TRUNCATED = '[...Truncated text #5 +50 lines...]'

// ── 1. placeholder family ───────────────────────────────────────────────────

describe('2.1.239 placeholder family: left()/right() hop every chip type', () => {
  for (const chip of [
    CHIP_PASTED,
    CHIP_PASTED_LINES,
    CHIP_IMAGE,
    CHIP_AUDIO,
    CHIP_TRUNCATED,
  ]) {
    test(`left() at the end of ${chip} hops to its start`, () => {
      const c = Cursor.fromText(chip, 80, chip.length)
      expect(c.left().offset).toBe(0)
    })
    test(`right() at the start of ${chip} hops to its end`, () => {
      const c = Cursor.fromText(chip, 80, 0)
      expect(c.right().offset).toBe(chip.length)
    })
  }

  test('placeholderContaining finds a chip strictly containing the offset', () => {
    const text = `abc ${CHIP_IMAGE} def`
    const chipStart = 4
    const c = Cursor.fromText(text, 80, chipStart + 3)
    const chip = c.placeholderContaining(chipStart + 3)
    expect(chip).toEqual({ start: chipStart, end: chipStart + CHIP_IMAGE.length })
  })

  test('placeholderContaining returns null at chip boundaries (not strictly inside)', () => {
    const text = `abc ${CHIP_IMAGE} def`
    const c = Cursor.fromText(text, 80, 4)
    expect(c.placeholderContaining(4)).toBeNull()
    expect(c.placeholderContaining(4 + CHIP_IMAGE.length)).toBeNull()
  })

  test('snapOutOfPlaceholder snaps inside-chip offsets to the requested boundary', () => {
    const text = `abc ${CHIP_IMAGE} def`
    const c = Cursor.fromText(text, 80, 0)
    const inside = 4 + 3
    expect(c.snapOutOfPlaceholder(inside, 'start')).toBe(4)
    expect(c.snapOutOfPlaceholder(inside, 'end')).toBe(4 + CHIP_IMAGE.length)
    // Outside any chip: unchanged
    expect(c.snapOutOfPlaceholder(1, 'start')).toBe(1)
  })

  test('placeholderEndingAt/placeholderStartingAt detect chip edges', () => {
    const text = `${CHIP_AUDIO}x`
    const c = Cursor.fromText(text, 80, 0)
    expect(c.placeholderEndingAt(CHIP_AUDIO.length)).toEqual({
      start: 0,
      end: CHIP_AUDIO.length,
    })
    expect(c.placeholderStartingAt(0)).toEqual({
      start: 0,
      end: CHIP_AUDIO.length,
    })
    expect(c.placeholderEndingAt(3)).toBeNull()
    expect(c.placeholderStartingAt(3)).toBeNull()
  })
})

describe('2.1.239 placeholder family: chip-aware word movement', () => {
  test('nextWord() at the start of a chip jumps the whole chip', () => {
    const text = `hello ${CHIP_IMAGE} world`
    const chipStart = 6
    const c = Cursor.fromText(text, 80, chipStart)
    expect(c.nextWord().offset).toBe(chipStart + CHIP_IMAGE.length)
  })

  test('nextWord() from inside a chip jumps to the chip end', () => {
    const text = `hello ${CHIP_IMAGE} world`
    const c = Cursor.fromText(text, 80, 9)
    expect(c.nextWord().offset).toBe(6 + CHIP_IMAGE.length)
  })

  test('prevWord() at the end of a chip jumps back over the chip', () => {
    const text = `hello ${CHIP_PASTED} world`
    const chipEnd = 6 + CHIP_PASTED.length
    const c = Cursor.fromText(text, 80, chipEnd)
    expect(c.prevWord().offset).toBe(6)
  })

  test('deleteTokenBefore() removes a full chip when cursor sits at its start', () => {
    for (const chip of [CHIP_PASTED, CHIP_IMAGE, CHIP_AUDIO, CHIP_TRUNCATED]) {
      const text = `a ${chip} b`
      const chipStart = 2
      const c = Cursor.fromText(text, 80, chipStart)
      const next = c.deleteTokenBefore()
      expect(next).not.toBeNull()
      // chip + trailing space removed atomically
      expect(next!.text).toBe('a b')
    }
  })

  test('deleteTokenBefore() matches the Audio placeholder variant (2.1.239 pattern)', () => {
    const text = `x ${CHIP_AUDIO} `
    // Cursor right after the chip's closing bracket (token end). Backward
    // token delete removes the chip itself; surrounding spaces are kept
    // (official `n.index + n[1].length` semantics).
    const c = Cursor.fromText(text, 80, 2 + CHIP_AUDIO.length)
    const next = c.deleteTokenBefore()
    expect(next).not.toBeNull()
    expect(next!.text).toBe('x  ')
  })
})

// ── 2. killRange rework ─────────────────────────────────────────────────────

describe('2.1.239 killRange: placeholder snapping at both endpoints', () => {
  test('a kill range inside a chip expands to the whole chip', () => {
    const text = `abc ${CHIP_IMAGE} def`
    const c = Cursor.fromText(text, 80, 0)
    const { cursor, killed } = c.killRange(4 + 2, 4 + 5) // both inside chip
    expect(killed).toBe(CHIP_IMAGE)
    expect(cursor.text).toBe('abc  def')
    expect(cursor.offset).toBe(4)
  })

  test('a kill range outside chips is unchanged', () => {
    const c = Cursor.fromText('hello world', 80, 0)
    const { cursor, killed } = c.killRange(6, 11)
    expect(killed).toBe('world')
    expect(cursor.text).toBe('hello ')
  })

  test('deleteToLineEnd from inside a chip removes the whole chip', () => {
    const text = `x${CHIP_IMAGE} rest`
    const c = Cursor.fromText(text, 80, 1 + 3) // inside chip
    const { cursor, killed } = c.deleteToLineEnd()
    expect(killed).toBe(`${CHIP_IMAGE} rest`)
    expect(cursor.text).toBe('x')
    expect(cursor.offset).toBe(1)
  })

  test('deleteWordBefore kills the whole chip when cursor is right after it', () => {
    const text = `foo ${CHIP_IMAGE}`
    const c = Cursor.fromText(text, 80, text.length)
    const { cursor, killed } = c.deleteWordBefore()
    // prevWord lands inside/at the chip; killRange snaps the start to the
    // chip start so the chip dies atomically.
    expect(killed).toBe(CHIP_IMAGE)
    expect(cursor.text).toBe('foo ')
  })

  test('deleteWordAfter kills the whole chip when cursor is right before it', () => {
    const text = `${CHIP_IMAGE} bar`
    const c = Cursor.fromText(text, 80, 0)
    const next = c.deleteWordAfter()
    expect(next.text).toBe(' bar')
  })

  test('killRange with equal endpoints deletes nothing', () => {
    const c = Cursor.fromText('abc', 80, 1)
    const { cursor, killed } = c.killRange(1, 1)
    expect(killed).toBe('')
    expect(cursor.text).toBe('abc')
    expect(cursor.offset).toBe(1)
  })
})

// ── 3. readline word-boundary system ────────────────────────────────────────

describe('2.1.239 MeasuredText.getReadlineWordBoundaries', () => {
  test('punctuation delimits readline words (foo-bar → foo, bar)', () => {
    const mt = new MeasuredText('foo-bar baz', 80)
    expect(mt.getReadlineWordBoundaries()).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ])
  })

  test('whitespace-only text has no readline words', () => {
    const mt = new MeasuredText('   ', 80)
    expect(mt.getReadlineWordBoundaries()).toEqual([])
  })

  test('combining vowel signs stay attached to their base consonant', () => {
    // Devanagari \u0915 (letter KA) + \u093F (vowel sign I, \p{M}): one
    // grapheme cluster, one readline word covering both code units. NFC does
    // not compose this pair, so the combining-mark tail is exercised.
    const mt = new MeasuredText('\u0915\u093f', 80)
    const boundaries = mt.getReadlineWordBoundaries()
    expect(boundaries).toEqual([{ start: 0, end: 2 }])
  })

  test('boundaries are cached (same array identity on second call)', () => {
    const mt = new MeasuredText('hello world', 80)
    expect(mt.getReadlineWordBoundaries()).toBe(mt.getReadlineWordBoundaries())
  })
})

describe('2.1.239 forwardWord/backwardWord (readline word movement)', () => {
  test('forwardWord stops at each readline word end', () => {
    const c = Cursor.fromText('foo-bar baz', 80, 0)
    expect(c.forwardWord().offset).toBe(3) // after foo
    expect(c.forwardWord().forwardWord().offset).toBe(7) // after bar
    expect(c.forwardWord().forwardWord().forwardWord().offset).toBe(11) // after baz
  })

  test('backwardWord stops at each readline word start', () => {
    const c = Cursor.fromText('foo-bar baz', 80, 11)
    expect(c.backwardWord().offset).toBe(8) // baz start
    expect(c.backwardWord().backwardWord().offset).toBe(4) // bar start
    expect(c.backwardWord().backwardWord().backwardWord().offset).toBe(0) // foo start
  })

  test('forwardWord hops chips atomically', () => {
    const text = `${CHIP_IMAGE} foo`
    const c = Cursor.fromText(text, 80, 0)
    expect(c.forwardWord().offset).toBe(CHIP_IMAGE.length)
  })

  test('backwardWord hops chips atomically', () => {
    const text = `foo ${CHIP_IMAGE}`
    const c = Cursor.fromText(text, 80, text.length)
    expect(c.backwardWord().offset).toBe(4)
  })

  test('forwardWord at end / backwardWord at start are no-ops', () => {
    const cEnd = Cursor.fromText('abc', 80, 3)
    expect(cEnd.forwardWord().offset).toBe(3)
    const cStart = Cursor.fromText('abc', 80, 0)
    expect(cStart.backwardWord().offset).toBe(0)
  })
})

describe('2.1.239 killWord/backwardKillWord', () => {
  test('killWord kills the readline word after the cursor', () => {
    const c = Cursor.fromText('foo-bar baz', 80, 0)
    const { cursor, killed } = c.killWord()
    expect(killed).toBe('foo')
    expect(cursor.text).toBe('-bar baz')
    expect(cursor.offset).toBe(0)
  })

  test('backwardKillWord kills the readline word before the cursor', () => {
    const c = Cursor.fromText('foo-bar', 80, 7)
    const { cursor, killed } = c.backwardKillWord()
    expect(killed).toBe('bar')
    expect(cursor.text).toBe('foo-')
    expect(cursor.offset).toBe(4)
  })

  test('killWord over a chip removes the whole chip', () => {
    const text = `${CHIP_IMAGE} bar`
    const c = Cursor.fromText(text, 80, 0)
    const { cursor, killed } = c.killWord()
    expect(killed).toBe(CHIP_IMAGE)
    expect(cursor.text).toBe(' bar')
  })

  test('killWord at end of text kills nothing', () => {
    const c = Cursor.fromText('abc', 80, 3)
    const { cursor, killed } = c.killWord()
    expect(killed).toBe('')
    expect(cursor.text).toBe('abc')
  })

  test('backwardKillWord at start of text kills nothing', () => {
    const c = Cursor.fromText('abc', 80, 0)
    const { cursor, killed } = c.backwardKillWord()
    expect(killed).toBe('')
    expect(cursor.text).toBe('abc')
  })
})

// ── 4. flavor contrast at the Cursor layer ──────────────────────────────────

describe('2.1.239 keybindingFlavor contrast: readline vs classic word units', () => {
  test('readline Alt+D (killWord) kills one readline word; classic Alt+D (deleteWordAfter) kills to the next Segmenter word start', () => {
    // In "foo-bar", readline killWord kills exactly "foo" (punctuation
    // delimits readline words); classic deleteWordAfter kills through to the
    // next Segmenter word START ("bar"), taking the "-" with it.
    const readline = Cursor.fromText('foo-bar', 80, 0).killWord()
    const classic = Cursor.fromText('foo-bar', 80, 0).deleteWordAfter()
    expect(readline.killed).toBe('foo')
    expect(readline.cursor.text).toBe('-bar')
    expect(classic.text).toBe('bar')
  })

  test('readline backwardKillWord stops at punctuation; readline Ctrl+W (deleteWORDBefore) stops at whitespace', () => {
    const readlineWordKill = Cursor.fromText('foo-bar', 80, 7).backwardKillWord()
    const wordKill = Cursor.fromText('foo-bar', 80, 7).deleteWORDBefore()
    expect(readlineWordKill.killed).toBe('bar') // punctuation delimits
    expect(wordKill.killed).toBe('foo-bar') // whitespace delimits
  })

  test('classic Ctrl+W (deleteWordBefore) still kills the Segmenter word', () => {
    const { killed } = Cursor.fromText('foo-bar', 80, 7).deleteWordBefore()
    expect(killed).toBe('bar')
  })
})
