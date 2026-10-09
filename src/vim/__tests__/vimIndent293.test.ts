import { describe, expect, test } from 'bun:test'
import { Cursor } from '../../utils/Cursor.js'
import { executeIndent, executeVisualIndent } from '../operators.js'
import type { OperatorContext } from '../operators.js'
import type { RecordedChange } from '../types.js'

// CC 2.1.293 #35 — vim `>>`/`<<` cursor placement on all-whitespace lines.
//
// Official vver `vn`/`go`/`ho` replaced the 292 "caret-star-slash" leading-
// whitespace regex cursor placement with a grapheme-walk helper `$t(l)`
// (report §35, verbatim):
//
//   function $t(l){let h=0;for(let{segment:O,index:x}of ba().segment(l))
//     if(h=x,O!==" "&&O!=="\t")break;return h}
//
// On an all-whitespace line the old leading-whitespace regex matched the WHOLE
// line, so the cursor was placed PAST end-of-line (a following `x` then deleted
// nothing). `$t` returns the index of the LAST grapheme instead, keeping the
// cursor on the line. `$t` is applied to the POST-indent line (the report's
// spaces-only example — offset == middle-line-start + 4 after indenting 3→5
// spaces — only holds for the post-indent text).
//
// NOTE: these are line comments (not a block comment) on purpose — the ported
// regex literal `/^\s*​/` would otherwise contain a `*/` that closes the block.

type MockCtx = OperatorContext & {
  recordedChanges: RecordedChange[]
  readonly _text: string
  readonly _offset: number
  readonly _register: string
  readonly _registerLinewise: boolean
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
    setRegister: (c: string, l: boolean) => {
      state.register = c
      state.registerLinewise = l
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
    get _register() {
      return state.register
    },
    get _registerLinewise() {
      return state.registerLinewise
    },
  }
}

describe('CC 2.1.293 #35 — >>/<< keep the cursor on all-whitespace lines', () => {
  test('>> on a spaces-only line lands on the last grapheme, not past EOL', () => {
    const ctx = createMockCtx('a\n   \nb', 2) // middle line = 3 spaces
    executeIndent('>', 1, ctx)
    expect(ctx._text).toBe('a\n     \nb') // indented 3 -> 5 spaces
    // middle-line-start (2) + $t("     ") (4) = 6; the 292 /^\s*/ gave 7 (the '\n')
    expect(ctx._offset).toBe(6)
    expect(ctx._text[ctx._offset]).toBe(' ') // cursor ON the line -> `x` deletes a space
  })

  test('<< on a spaces-only line lands on the last grapheme, not past EOL', () => {
    const ctx = createMockCtx('a\n   \nb', 2)
    executeIndent('<', 1, ctx)
    expect(ctx._text).toBe('a\n \nb') // 3 spaces -> 1 space
    // line-start (2) + $t(" ") (0) = 2; the 292 /^\s*/ gave 3 (the '\n')
    expect(ctx._offset).toBe(2)
    expect(ctx._text[ctx._offset]).toBe(' ')
  })

  test('>> with leading spaces still lands on the first non-blank (regression)', () => {
    const ctx = createMockCtx('  x\ny', 0)
    executeIndent('>', 1, ctx)
    expect(ctx._text).toBe('    x\ny')
    expect(ctx._offset).toBe(4) // $t("    x") = 4 (identical to the old /^\s*/ length)
    expect(ctx._text[ctx._offset]).toBe('x')
  })

  test('>> on an empty line keeps the cursor on the (now indented) line', () => {
    const ctx = createMockCtx('a\n\nb', 2)
    executeIndent('>', 1, ctx)
    expect(ctx._text).toBe('a\n  \nb') // "" -> "  "
    // $t("  ") = 1 -> line-start (2) + 1 = 3 (2nd space); the 292 /^\s*/ gave 4 (the '\n')
    expect(ctx._offset).toBe(3)
    expect(ctx._text[ctx._offset]).toBe(' ')
  })

  test('visual-line > on a spaces-only line lands on the last grapheme', () => {
    const ctx = createMockCtx('a\n   \nb', 2)
    executeVisualIndent('>', 2, ctx) // anchor == cursor, both on the middle line
    expect(ctx._text).toBe('a\n     \nb')
    // range.from (2) + $t("     ") (4) = 6; the 292 /^\s*/ gave 7
    expect(ctx._offset).toBe(6)
    expect(ctx._text[ctx._offset]).toBe(' ')
  })
})
