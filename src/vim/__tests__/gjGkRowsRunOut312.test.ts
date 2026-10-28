import { describe, expect, test } from 'bun:test'
import { Cursor } from '../../utils/Cursor.js'
import { executeOperatorMotion } from '../operators.js'
import type { OperatorContext } from '../operators.js'
import { transition } from '../transitions.js'
import type { RecordedChange } from '../types.js'

// CC 2.1.312 changelog item 14 — vim `d`/`c`/`y` with a `gj`/`gk` count
// larger than the wrapped rows left must ONLY MOVE the cursor (like Vim),
// never delete/change/yank.
//
// Verified against the official v312 linux-x64 ELF (byte-forensics):
//   q  (executeOperatorMotion)  @259579735:
//     `function q(t,e,r,n){if(e==="gj"||e==="gk"){let u=le(e,r,n);
//      if(u.rowsRunOut){n.setOffset(rQ(n.cursor,u.offset));return}}...`
//   le (gj/gk target helper)    @259587549:
//     `c=(t==="gj"?o.length-1-i:i)<e` where
//       o = n.measuredText.getWrappedLines(),
//       i = n.getPosition().line,
//       e = count.
//     NOTE the STRICT `<`: a count exactly equal to the rows left is NOT
//     rowsRunOut — the operator proceeds normally.
//   rQ (clamp + placeholder snap) @259587778 region:
//     `function rQ(t,e,r=t.text){let n=Ale(r,e);
//      return t.snapOutOfPlaceholder(n,"start")===n?n:e}`
//     Ale = the clamp OCC already ports as `clampOffset` in operators.ts
//     (same body, verified @259586709); the snap-fallback shape is the one
//     executeToggleCase already uses.
//
// rowsRunOut is NEW in v312 (0 hits in v311, 4 in v312).

/**
 * Mock OperatorContext — same pattern as percentMotion301.test.ts (cursor
 * identity cached so `target.equals(ctx.cursor)` behaves like the real hook).
 */
function createMockCtx(text: string, offset = 0) {
  const state = {
    text,
    offset,
    register: '',
    registerLinewise: false,
    insertOffset: -1,
  }
  const recordedChanges: RecordedChange[] = []
  let cursorCache: { text: string; offset: number; cursor: Cursor } | null =
    null
  const ctx: OperatorContext & {
    recordedChanges: RecordedChange[]
    readonly _text: string
    readonly _offset: number
    readonly _register: string
    readonly _registerLinewise: boolean
    readonly _insertOffset: number
  } = {
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
    enterInsert: (o: number) => {
      state.insertOffset = o
    },
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
    get _insertOffset() {
      return state.insertOffset
    },
  }
  return ctx
}

/** Feed keystrokes through the real transition() state machine. */
function feedKeys(ctx: ReturnType<typeof createMockCtx>, keys: string[]): void {
  let state: Parameters<typeof transition>[0] = { type: 'idle' }
  for (const key of keys) {
    const result = transition(state, key, ctx)
    result.execute?.()
    state = result.next ?? { type: 'idle' }
  }
}

describe('CC 2.1.312 gj/gk rowsRunOut — operator only moves the cursor', () => {
  test('d9gj with fewer rows left keeps the text and only moves the cursor', () => {
    const ctx = createMockCtx('aa\nbb', 0)
    feedKeys(ctx, ['d', '9', 'g', 'j'])
    expect(ctx._text).toBe('aa\nbb') // nothing deleted
    expect(ctx._offset).toBe(3) // moved to the last line
    expect(ctx._register).toBe('') // register untouched
    expect(ctx.recordedChanges).toEqual([]) // nothing recorded for dot-repeat
  })

  test('c9gj with fewer rows left keeps the text and does NOT enter INSERT', () => {
    const ctx = createMockCtx('aa\nbb', 0)
    feedKeys(ctx, ['c', '9', 'g', 'j'])
    expect(ctx._text).toBe('aa\nbb')
    expect(ctx._offset).toBe(3)
    expect(ctx._insertOffset).toBe(-1) // mode stays NORMAL
    expect(ctx.recordedChanges).toEqual([])
  })

  test('y9gj with fewer rows left keeps the text and does NOT yank', () => {
    const ctx = createMockCtx('aa\nbb', 0)
    feedKeys(ctx, ['y', '9', 'g', 'j'])
    expect(ctx._text).toBe('aa\nbb')
    expect(ctx._offset).toBe(3)
    expect(ctx._register).toBe('') // no yank
    expect(ctx.recordedChanges).toEqual([])
  })

  test('d9gk mirror: from line 1, rows run out upward → only moves to line 0', () => {
    // cursor on "b" of "bb" (offset 4, column 1) to exercise column clamping
    const ctx = createMockCtx('aa\nbb', 4)
    feedKeys(ctx, ['d', '9', 'g', 'k'])
    expect(ctx._text).toBe('aa\nbb')
    expect(ctx._offset).toBe(1) // gk preserves column 1 → line 0, offset 1
    expect(ctx._register).toBe('')
    expect(ctx.recordedChanges).toEqual([])
  })

  test('CONTROL strict <: d1gj (rows left 1, count 1 → NOT rowsRunOut) still deletes', () => {
    // official formula: rowsRunOut = (wrappedLineCount - 1 - line) < count
    // → (2 - 1 - 0) < 1 is FALSE → the operator proceeds normally.
    const ctx = createMockCtx('aa\nbb', 0)
    feedKeys(ctx, ['d', '1', 'g', 'j'])
    expect(ctx._text).toBe('bb')
    expect(ctx._register).toBe('aa\n')
    expect(ctx._offset).toBe(0)
    expect(ctx.recordedChanges).toEqual([
      { type: 'operator', op: 'delete', motion: 'gj', count: 1 },
    ])
  })

  test('CONTROL strict <: d2gj on a 3-line buffer (rows left 2, count 2) still deletes', () => {
    // (3 - 1 - 0) < 2 is FALSE → proceeds.
    const ctx = createMockCtx('aa\nbb\ncc', 0)
    feedKeys(ctx, ['d', '2', 'g', 'j'])
    expect(ctx._text).toBe('cc')
    expect(ctx._register).toBe('aa\nbb\n')
  })

  test('motion-only 9gj (no operator) still just moves the cursor', () => {
    const ctx = createMockCtx('aa\nbb', 0)
    feedKeys(ctx, ['9', 'g', 'j'])
    expect(ctx._text).toBe('aa\nbb')
    expect(ctx._offset).toBe(3)
    expect(ctx.recordedChanges).toEqual([])
  })

  test('executeOperatorMotion direct: y9gj does not touch a preset register', () => {
    const ctx = createMockCtx('aa\nbb', 0)
    ctx.setRegister('preset', false)
    executeOperatorMotion('yank', 'gj', 9, ctx)
    expect(ctx._text).toBe('aa\nbb')
    expect(ctx._register).toBe('preset')
    expect(ctx._offset).toBe(3)
  })

  test('gk on line 0 with a huge count: rowsRunOut → move only (no-op move)', () => {
    const ctx = createMockCtx('aa\nbb', 0)
    ctx.setRegister('preset', false)
    executeOperatorMotion('delete', 'gk', 9, ctx)
    expect(ctx._text).toBe('aa\nbb')
    expect(ctx._register).toBe('preset')
    expect(ctx._offset).toBe(0)
    expect(ctx.recordedChanges).toEqual([])
  })
})
