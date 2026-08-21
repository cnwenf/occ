import { describe, expect, test } from 'bun:test'
import { Cursor } from '../Cursor.js'

/**
 * 2.1.238 `keybindingFlavor` (binary `deleteWORDBefore`): readline-flavored
 * Ctrl+W kills back to the previous WHITESPACE boundary (the whole WORD run),
 * whereas the classic `deleteWordBefore` kills back to the previous
 * word-boundary (Intl.Segmenter word-like segment). `deleteWORDBefore` is
 * selected when `keybindingFlavor === "readline"`.
 */
describe('Cursor.deleteWORDBefore (2.1.238 keybindingFlavor readline)', () => {
  test('returns unchanged cursor and empty killed at start of text', () => {
    const c = Cursor.fromText('hello', 80, 0)
    const { cursor, killed } = c.deleteWORDBefore()
    expect(killed).toBe('')
    expect(cursor.text).toBe('hello')
    expect(cursor.offset).toBe(0)
  })

  test('kills the whole WORD run across punctuation (readline)', () => {
    // readline treats only whitespace as a boundary, so the entire "foo-bar"
    // run is killed in one Ctrl+W (Intl.Segmenter splits "foo-bar" at "-").
    const c = Cursor.fromText('foo-bar', 80, 7)
    const { cursor, killed } = c.deleteWORDBefore()
    expect(killed).toBe('foo-bar')
    expect(cursor.text).toBe('')
    expect(cursor.offset).toBe(0)
  })

  test('classic deleteWordBefore kills only the last word across punctuation', () => {
    // Contrast: classic word-boundary kill stops at the "-" boundary, killing
    // only "bar" where readline kills the whole "foo-bar" run.
    const c = Cursor.fromText('foo-bar', 80, 7)
    const { cursor, killed } = c.deleteWordBefore()
    expect(killed).toBe('bar')
    expect(cursor.text).toBe('foo-')
  })

  test('kills the trailing word back to whitespace for plain words', () => {
    const c = Cursor.fromText('hello world', 80, 11)
    const { cursor, killed } = c.deleteWORDBefore()
    expect(killed).toBe('world')
    expect(cursor.text).toBe('hello ')
    expect(cursor.offset).toBe(6)
  })

  test('kills the whitespace plus the previous word when cursor starts a word', () => {
    // "foo bar" with cursor on 'b' (offset 4): readline Ctrl+W rubs out "foo "
    // (whitespace-delimited), leaving "bar".
    const c = Cursor.fromText('foo bar', 80, 4)
    const { cursor, killed } = c.deleteWORDBefore()
    expect(killed).toBe('foo ')
    expect(cursor.text).toBe('bar')
    expect(cursor.offset).toBe(0)
  })

  test('stops at the whitespace boundary, keeping earlier WORD runs', () => {
    const c = Cursor.fromText('a.b c.d', 80, 7)
    const { cursor, killed } = c.deleteWORDBefore()
    expect(killed).toBe('c.d')
    expect(cursor.text).toBe('a.b ')
    expect(cursor.offset).toBe(4)
  })

  test('kills only trailing whitespace when cursor sits after whitespace', () => {
    // "ab  " with cursor at the end (offset 4): prevWORD steps left off the
    // whitespace run to 'b', then kills back to the start of "ab".
    const c = Cursor.fromText('ab cd  ', 80, 7)
    const { cursor, killed } = c.deleteWORDBefore()
    expect(killed).toBe('cd  ')
    expect(cursor.text).toBe('ab ')
    expect(cursor.offset).toBe(3)
  })
})
