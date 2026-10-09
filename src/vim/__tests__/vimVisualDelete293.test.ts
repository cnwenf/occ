import { describe, expect, test } from 'bun:test'
import { Cursor } from '../../utils/Cursor.js'
import { executeVisualOperator, replayVisualOp } from '../operators.js'
import type { OperatorContext } from '../operators.js'
import type { RecordedChange } from '../types.js'

/**
 * CC 2.1.293 #36 — vim `V+d` cursor placement + dot-replay guard.
 *
 * (a) Linewise-delete cursor: 292 `ho` ended with a plain clamp
 *     `Math.min(from, newText.length - lastGrapheme)`. vver `bo` (report §36,
 *     verbatim) instead computes:
 *       U = to < text.length                     // hasTextAfter
 *       W = text.slice(0, L) + text.slice(to)     // newText
 *       K = U ? from : Rt(W, W.length)            // base (Rt = last-line start)
 *       j = W.indexOf('\n', K); z = j === -1 ? W.length : j
 *       q = $t(W.slice(K, z))                     // first non-blank (#35 helper)
 *       setOffset(K + q)
 *     (the placeholder branch `_o`/`f7` is N/A — OCC vim has no placeholders).
 *
 * (b) Dot-replay guard: vprev `if(from===to)return` -> vver `xo`
 *     `if(I===k&&!(O&&x.text.length>0))return` — a linewise replay proceeds on
 *     an empty span-range as long as text exists.
 */

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

describe('CC 2.1.293 #36a — V+d lands on the first non-blank', () => {
  test('deleting the first line lands on the first non-blank of the next line', () => {
    const ctx = createMockCtx('aa\n  bb\ncc', 0)
    executeVisualOperator('delete', 0, ctx, true)
    expect(ctx._text).toBe('  bb\ncc')
    expect(ctx._offset).toBe(2) // base 0 + $t("  bb") 2; the old clamp gave 0
    expect(ctx._text[ctx._offset]).toBe('b')
  })

  test('deleting the first line toward an indented last line lands on its non-blank', () => {
    const ctx = createMockCtx('x\n   ind', 0)
    executeVisualOperator('delete', 0, ctx, true)
    expect(ctx._text).toBe('   ind')
    expect(ctx._offset).toBe(3) // base 0 + $t("   ind") 3; the old clamp gave 0
    expect(ctx._text[ctx._offset]).toBe('i')
  })

  test('deleting the last line (no text after) lands on the new last-line start', () => {
    const ctx = createMockCtx('aa\nbb', 3) // cursor on "bb"
    executeVisualOperator('delete', 3, ctx, true)
    expect(ctx._text).toBe('aa')
    // base = Rt(newText, len) = 0, + $t("aa") 0 = 0; the old clamp gave 1
    expect(ctx._offset).toBe(0)
  })
})

describe('CC 2.1.293 #36b — linewise dot-replay guard', () => {
  test('an empty span-range linewise replay proceeds when text exists', () => {
    const ctx = createMockCtx('hello\nworld', 0)
    ctx.setRegister('SENTINEL', false)
    replayVisualOp('delete', 0, true, ctx)
    // It did NOT early-return: applyOperator ran and set the linewise register.
    expect(ctx._register).toBe('\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._text).toBe('hello\nworld') // an empty range deletes nothing
  })

  test('an empty span-range linewise replay is a no-op when the buffer is empty', () => {
    const ctx = createMockCtx('', 0)
    ctx.setRegister('SENTINEL', false)
    replayVisualOp('delete', 0, true, ctx)
    expect(ctx._register).toBe('SENTINEL') // guard: text.length === 0 -> return
  })

  test('a charwise empty-range replay still returns (regression)', () => {
    const ctx = createMockCtx('hello', 0)
    ctx.setRegister('SENTINEL', false)
    replayVisualOp('delete', 0, false, ctx)
    expect(ctx._register).toBe('SENTINEL')
    expect(ctx._text).toBe('hello')
  })
})

describe('CC 2.1.293 #36 — end-to-end V+d then `.` deletes the cursor line', () => {
  test('V+d a line, move, `.` deletes the new cursor line', () => {
    const ctx = createMockCtx('aa\nbb\ncc', 0)
    executeVisualOperator('delete', 0, ctx, true) // V+d the "aa" line
    expect(ctx._text).toBe('bb\ncc')
    const rec = ctx.recordedChanges.at(-1) as
      | Extract<RecordedChange, { type: 'visualOp' }>
      | undefined
    expect(rec?.type).toBe('visualOp')
    expect(rec?.span).toBe(1)
    ctx.setOffset(3) // move onto the "cc" line
    replayVisualOp(rec!.op, rec!.span, rec!.linewise, ctx) // `.`
    expect(ctx._text).toBe('bb\n') // the "cc" line is deleted
  })
})
