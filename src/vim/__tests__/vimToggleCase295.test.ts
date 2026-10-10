import { describe, expect, test } from 'bun:test'
import { Cursor } from '../../utils/Cursor.js'
import { executeToggleCase, executeX } from '../operators.js'
import type { OperatorContext } from '../operators.js'
import type { RecordedChange } from '../types.js'

/**
 * CC 2.1.295 — vim `~` (toggleCase) cursor-clamp alignment.
 *
 * Official v295 `yn` (@225581736), byte-faithful reference:
 *   function yn(l,h){let O=h.cursor.measuredText.columns,x=h.text,
 *     I=h.cursor.offset,T=0;
 *     while(I<x.length&&x[I]!==`\n`&&T<l){...toggle grapheme, NFC...}
 *     if(T===0)return;
 *     let _=hi.fromText(x,O);h.setText(x),h.setOffset(A9(_,I)),
 *       h.recordChange({type:"toggleCase",count:l})}
 *   with A9 = KZ clamp (≡ OCC clampOffset) + snapOutOfPlaceholder fallback,
 *   KZ (@225586049): backs off a grapheme when the offset lands on '\n'
 *   (mid-text) or past the last grapheme at end-of-text.
 *
 * Fixes: `~` on the last char of a line no longer moves the cursor past it
 * (a following `x` still deletes), and `3~` near EOL stops at the newline
 * instead of running into the next line.
 */

type MockCtx = OperatorContext & {
  recordedChanges: RecordedChange[]
  readonly _text: string
  readonly _offset: number
}

function createMockCtx(text: string, offset = 0): MockCtx {
  const state = { text, offset, register: '', registerLinewise: false }
  const recordedChanges: RecordedChange[] = []
  let cursorCache: { text: string; offset: number; cursor: Cursor } | null =
    null
  return {
    get cursor() {
      if (
        !cursorCache ||
        cursorCache.text !== state.text ||
        cursorCache.offset !== state.offset
      ) {
        cursorCache = {
          text: state.text,
          offset: state.offset,
          cursor: Cursor.fromText(state.text, 80, state.offset),
        }
      }
      return cursorCache.cursor
    },
    get text() {
      return state.text
    },
    setText: (t: string) => {
      state.text = t
    },
    setOffset: (o: number) => {
      state.offset = o
    },
    enterInsert: () => {},
    getRegister: () => state.register,
    setRegister: (content: string, linewise: boolean) => {
      state.register = content
      state.registerLinewise = linewise
    },
    getLastFind: () => null,
    setLastFind: () => {},
    recordChange: (change: RecordedChange) => {
      recordedChanges.push(change)
    },
    recordedChanges,
    get _text() {
      return state.text
    },
    get _offset() {
      return state.offset
    },
  }
}

describe('vim 2.1.295 — ~ stops at EOL and clamps the cursor (official yn/A9)', () => {
  test('~ on the last char of a line keeps the cursor ON that char', () => {
    const ctx = createMockCtx('abc', 2)
    executeToggleCase(1, ctx)
    expect(ctx._text).toBe('abC')
    // Official A9/KZ: offset 3 is past the last grapheme at end-of-text →
    // clamped back to 2 (cursor stays on 'C').
    expect(ctx._offset).toBe(2)
    expect(ctx.recordedChanges).toEqual([{ type: 'toggleCase', count: 1 }])
  })

  test('x after ~ on the last char still deletes it', () => {
    const ctx = createMockCtx('abc', 2)
    executeToggleCase(1, ctx)
    executeX(1, ctx)
    expect(ctx._text).toBe('ab')
    expect(ctx._offset).toBe(1)
  })

  test('3~ near EOL toggles only to the newline and stays on the line', () => {
    const ctx = createMockCtx('ab\ncd', 0)
    executeToggleCase(3, ctx)
    // '\n' is never toggled or counted (official loop guard x[I]!==`\n`).
    expect(ctx._text).toBe('AB\ncd')
    // Raw offset 2 lands on '\n' → KZ backs off one grapheme → 1.
    expect(ctx._offset).toBe(1)
  })

  test('count larger than the line stops at EOL without crossing the newline', () => {
    const ctx = createMockCtx('ab', 0)
    executeToggleCase(5, ctx)
    expect(ctx._text).toBe('AB')
    expect(ctx._offset).toBe(1)
  })

  test('mid-line toggle advances the cursor normally', () => {
    const ctx = createMockCtx('hello world', 0)
    executeToggleCase(1, ctx)
    expect(ctx._text).toBe('Hello world')
    expect(ctx._offset).toBe(1)
  })

  test('uppercase toggles to lowercase', () => {
    const ctx = createMockCtx('Hello', 0)
    executeToggleCase(1, ctx)
    expect(ctx._text).toBe('hello')
    expect(ctx._offset).toBe(1)
  })

  test('toggled graphemes are NFC-normalized (ß → SS shifts the offset)', () => {
    const ctx = createMockCtx('aß', 1)
    executeToggleCase(1, ctx)
    expect(ctx._text).toBe('aSS')
    // Raw offset 3 → end-of-text clamp → 2.
    expect(ctx._offset).toBe(2)
  })

  test('cursor at end of text: no mutation, no recorded change', () => {
    const ctx = createMockCtx('abc', 3)
    executeToggleCase(1, ctx)
    expect(ctx._text).toBe('abc')
    expect(ctx._offset).toBe(3)
    expect(ctx.recordedChanges).toEqual([])
  })

  test('cursor on a newline: no mutation, no recorded change', () => {
    const ctx = createMockCtx('a\nb', 1)
    executeToggleCase(1, ctx)
    expect(ctx._text).toBe('a\nb')
    expect(ctx._offset).toBe(1)
    expect(ctx.recordedChanges).toEqual([])
  })

  test('multi-line buffer: ~ on the last char before \\n clamps back', () => {
    const ctx = createMockCtx('abcd\nefgh', 3)
    executeToggleCase(1, ctx)
    expect(ctx._text).toBe('abcD\nefgh')
    // Raw offset 4 lands on '\n' (preceded by 'D', not '\n') → back off → 3.
    expect(ctx._offset).toBe(3)
  })
})
