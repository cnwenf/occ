import { describe, expect, test } from 'bun:test'
import { Cursor } from '../../utils/Cursor.js'
import {
  executeLineOp,
  executeOperatorG,
  executeOperatorGg,
  executeOperatorMotion,
  replayOperatorChange,
} from '../operators.js'
import type { OperatorContext } from '../operators.js'
import { transition } from '../transitions.js'
import type { RecordedChange } from '../types.js'

// CC 2.1.281 #081/#082 — vim operator engine port.
// Verified against the official v281 linux-x64 ELF:
//   ht (executeOperatorMotion) @209867921, un (G op) @209877832,
//   fn (gg op), dn (linewise op), bt (count-linewise op),
//   ks (getOperatorRange) @209871429, et (record-skip-yank) @209871186,
//   lo (first-nonblank), Vee (clampOffset), gt (lineIdx),
//   Fe (dot-repeat dispatch), ae (visualChange wrapper @209889188 — STAGED).
// Pieces: (1) G/gg count===0 convention + linewise spans, (2) generic op path
// linewise-motion + zero-width branches, (3) count-linewise ops (3dd).
// Piece 4 (visualChange `!`-guard) is STAGED per triage — not tested here.

/**
 * Mock OperatorContext that tracks text, offset, register (+linewise flag),
 * enterInsert calls, and recorded changes. Same pattern as
 * vimDotRepeat.test.ts, extended for the v281 operator paths.
 */
type MockCtx = OperatorContext & {
  recordedChanges: RecordedChange[]
  readonly _text: string
  readonly _offset: number
  readonly _register: string
  readonly _registerLinewise: boolean
  readonly _insertOffset: number
}

function createMockCtx(text: string, offset = 0): MockCtx {
  const state = {
    text,
    offset,
    register: '',
    registerLinewise: false,
    insertOffset: -1,
  }
  const recordedChanges: RecordedChange[] = []
  // Cache the Cursor while (text, offset) are unchanged: Cursor.equals
  // compares measuredText identity, and the real hook hands the operators a
  // single Cursor instance — a fresh Cursor per access would make every
  // `target.equals(ctx.cursor)` check false.
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
}

describe('CC 2.1.281 #081 — G/gg operators: count convention + linewise spans', () => {
  test('1G goes to line 1 (not last line)', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 9)
    const result = transition({ type: 'count', digits: '1' }, 'G', ctx)
    result.execute?.()
    expect(ctx._offset).toBe(0)
  })

  test('G with no count goes to last line', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 0)
    const result = transition({ type: 'idle' }, 'G', ctx)
    result.execute?.()
    expect(ctx._offset).toBe(8)
  })

  test('3G goes to line 3 (typed count via goToLine)', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 0)
    const result = transition({ type: 'count', digits: '3' }, 'G', ctx)
    result.execute?.()
    expect(ctx._offset).toBe(8)
  })

  test('dG from mid-line deletes whole lines through the last line', () => {
    // v280 bug: charwise range deleted only part of the cursor/target lines.
    const ctx = createMockCtx('one\ntwo\nthree', 5)
    executeOperatorG('delete', 0, ctx)
    expect(ctx._text).toBe('one')
    expect(ctx._register).toBe('two\nthree\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx.recordedChanges).toEqual([
      { type: 'operator', op: 'delete', motion: 'G', count: 0 },
    ])
  })

  test('dG on the last line still deletes that line (no equals early-return)', () => {
    const ctx = createMockCtx('a\nb', 2)
    executeOperatorG('delete', 0, ctx)
    expect(ctx._text).toBe('a')
    expect(ctx._register).toBe('b\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._offset).toBe(0)
  })

  test('d1G from line 2 deletes whole lines 1..2 (countTyped=true)', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 5)
    const result = transition(
      { type: 'operator', op: 'delete', count: 1, countTyped: true },
      'G',
      ctx,
    )
    result.execute?.()
    expect(ctx._text).toBe('three')
    expect(ctx._register).toBe('one\ntwo\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._offset).toBe(0)
  })

  test('dG via transition with no typed count passes count 0 (targets last line)', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 5)
    const result = transition(
      { type: 'operator', op: 'delete', count: 1, countTyped: false },
      'G',
      ctx,
    )
    result.execute?.()
    expect(ctx._text).toBe('one')
    expect(ctx._register).toBe('two\nthree\n')
  })

  test('dgg deletes whole lines from the first line through the cursor line', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 9)
    executeOperatorGg('delete', 1, ctx)
    expect(ctx._text).toBe('')
    expect(ctx._register).toBe('one\ntwo\nthree\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._offset).toBe(0)
    expect(ctx.recordedChanges).toEqual([
      { type: 'operator', op: 'delete', motion: 'gg', count: 1 },
    ])
  })

  test('yG yanks whole lines linewise and keeps the cursor at min offset', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 5)
    executeOperatorG('yank', 0, ctx)
    expect(ctx._text).toBe('one\ntwo\nthree')
    expect(ctx._register).toBe('two\nthree\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._offset).toBe(5)
    // v281 `et`: yanks are not recorded for dot-repeat.
    expect(ctx.recordedChanges).toHaveLength(0)
  })

  test('cgg changes whole lines from the first through the cursor line', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 5)
    executeOperatorGg('change', 1, ctx)
    expect(ctx._text).toBe('\nthree')
    expect(ctx._insertOffset).toBe(0)
    expect(ctx._register).toBe('one\ntwo\n')
    expect(ctx._registerLinewise).toBe(true)
  })
})

describe('CC 2.1.281 #081 — generic op path: linewise motions (dj/dk)', () => {
  test('dj from mid-line deletes both whole lines', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 1)
    executeOperatorMotion('delete', 'j', 1, ctx)
    expect(ctx._text).toBe('three')
    expect(ctx._register).toBe('one\ntwo\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._offset).toBe(0)
    expect(ctx.recordedChanges).toEqual([
      { type: 'operator', op: 'delete', motion: 'j', count: 1 },
    ])
  })

  test('dk deletes whole lines upward', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 9)
    executeOperatorMotion('delete', 'k', 1, ctx)
    expect(ctx._text).toBe('one')
    expect(ctx._register).toBe('two\nthree\n')
    expect(ctx._registerLinewise).toBe(true)
    // Deleting to EOF: cursor lands on the last grapheme (binary `Vee`).
    expect(ctx._offset).toBe(2)
  })

  test('dj on the last line is a no-op and records nothing', () => {
    const ctx = createMockCtx('one\ntwo', 5)
    executeOperatorMotion('delete', 'j', 1, ctx)
    expect(ctx._text).toBe('one\ntwo')
    expect(ctx._register).toBe('')
    expect(ctx.recordedChanges).toHaveLength(0)
  })

  test('yj yanks whole lines linewise without touching the text', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 1)
    executeOperatorMotion('yank', 'j', 1, ctx)
    expect(ctx._text).toBe('one\ntwo\nthree')
    expect(ctx._register).toBe('one\ntwo\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._offset).toBe(1)
    expect(ctx.recordedChanges).toHaveLength(0)
  })

  test('cj replaces both whole lines with an empty line and enters insert', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 1)
    executeOperatorMotion('change', 'j', 1, ctx)
    expect(ctx._text).toBe('\nthree')
    expect(ctx._insertOffset).toBe(0)
  })

  test('2dj deletes three whole lines (count multiplies the motion)', () => {
    const ctx = createMockCtx('l1\nl2\nl3\nl4', 0)
    executeOperatorMotion('delete', 'j', 2, ctx)
    expect(ctx._text).toBe('l4')
    expect(ctx._register).toBe('l1\nl2\nl3\n')
  })
})

describe('CC 2.1.281 #082 — generic op path: zero-width targets', () => {
  test('c0 at column 0 enters insert mode (was a silent no-op)', () => {
    const ctx = createMockCtx('hello', 0)
    executeOperatorMotion('change', '0', 1, ctx)
    expect(ctx._text).toBe('hello')
    expect(ctx._insertOffset).toBe(0)
    expect(ctx.recordedChanges).toEqual([
      { type: 'operator', op: 'change', motion: '0', count: 1 },
    ])
  })

  test('y0 at column 0 clears the register charwise (was a silent no-op)', () => {
    const ctx = createMockCtx('hello', 0)
    ctx.setRegister('stale', true)
    executeOperatorMotion('yank', '0', 1, ctx)
    expect(ctx._register).toBe('')
    expect(ctx._registerLinewise).toBe(false)
    expect(ctx.recordedChanges).toHaveLength(0)
  })

  test('y0 from mid-line yanks the text before the cursor', () => {
    const ctx = createMockCtx('hello', 3)
    executeOperatorMotion('yank', '0', 1, ctx)
    expect(ctx._text).toBe('hello')
    expect(ctx._register).toBe('hel')
    expect(ctx._registerLinewise).toBe(false)
  })

  test('d0 at column 0 changes nothing but records for dot-repeat', () => {
    const ctx = createMockCtx('hello', 0)
    executeOperatorMotion('delete', '0', 1, ctx)
    expect(ctx._text).toBe('hello')
    expect(ctx.recordedChanges).toEqual([
      { type: 'operator', op: 'delete', motion: '0', count: 1 },
    ])
  })

  test('c^ at the first non-blank enters insert mode', () => {
    const ctx = createMockCtx('  hello', 2)
    executeOperatorMotion('change', '^', 1, ctx)
    expect(ctx._text).toBe('  hello')
    expect(ctx._insertOffset).toBe(2)
  })

  test('cw at end of buffer enters insert without deleting (isCwEnd)', () => {
    const ctx = createMockCtx('hello', 5)
    executeOperatorMotion('change', 'w', 1, ctx)
    expect(ctx._text).toBe('hello')
    expect(ctx._insertOffset).toBe(5)
    expect(ctx.recordedChanges).toEqual([
      { type: 'operator', op: 'change', motion: 'w', count: 1 },
    ])
  })

  test('dw at end of buffer is a no-op (isCwEnd is change-only)', () => {
    const ctx = createMockCtx('hello', 5)
    executeOperatorMotion('delete', 'w', 1, ctx)
    expect(ctx._text).toBe('hello')
    expect(ctx.recordedChanges).toHaveLength(0)
  })
})

describe('CC 2.1.281 #082 — getOperatorRange (ks) rewrite: cw corrections', () => {
  test('cw at end-of-line changes only to EOL (does not eat next word)', () => {
    const ctx = createMockCtx('hello world\nnext', 10)
    executeOperatorMotion('change', 'w', 1, ctx)
    expect(ctx._text).toBe('hello worl\nnext')
    expect(ctx._insertOffset).toBe(10)
    expect(ctx._register).toBe('d')
    expect(ctx._registerLinewise).toBe(false)
  })

  test('cw on the last letter of a mid-buffer word changes only that letter', () => {
    const ctx = createMockCtx('hello world\nnext', 4)
    executeOperatorMotion('change', 'w', 1, ctx)
    expect(ctx._text).toBe('hell world\nnext')
    expect(ctx._insertOffset).toBe(4)
    expect(ctx._register).toBe('o')
  })

  test('cw on whitespace changes the blank run only (not the next word)', () => {
    const ctx = createMockCtx('a   b\nnext', 1)
    executeOperatorMotion('change', 'w', 1, ctx)
    expect(ctx._text).toBe('ab\nnext')
    expect(ctx._insertOffset).toBe(1)
    expect(ctx._register).toBe('   ')
  })

  test('cw mid-word keeps the classic whole-word change', () => {
    const ctx = createMockCtx('hello world', 0)
    executeOperatorMotion('change', 'w', 1, ctx)
    expect(ctx._text).toBe(' world')
    expect(ctx._insertOffset).toBe(0)
    expect(ctx._register).toBe('hello')
  })

  test('2cw changes two whole words', () => {
    const ctx = createMockCtx('one two three', 0)
    executeOperatorMotion('change', 'w', 2, ctx)
    expect(ctx._text).toBe(' three')
    expect(ctx._register).toBe('one two')
  })

  test('dw mid-line deletes the word plus trailing space (unchanged)', () => {
    const ctx = createMockCtx('hello world', 0)
    executeOperatorMotion('delete', 'w', 1, ctx)
    expect(ctx._text).toBe('world')
    expect(ctx._register).toBe('hello ')
  })

  test('de stops at the word end (inclusive, no newline extension)', () => {
    const ctx = createMockCtx('hello\nworld', 0)
    executeOperatorMotion('delete', 'e', 1, ctx)
    expect(ctx._text).toBe('\nworld')
    expect(ctx._register).toBe('hello')
  })

  test('d$ stops before the newline (inclusive $ with newline guard)', () => {
    const ctx = createMockCtx('hello\nworld', 1)
    executeOperatorMotion('delete', '$', 1, ctx)
    expect(ctx._text).toBe('h\nworld')
    expect(ctx._register).toBe('ello')
  })
})

describe('CC 2.1.281 #081 — count-linewise ops (bt): dd/cc/yy', () => {
  test('3dd deletes 3 whole lines', () => {
    const ctx = createMockCtx('l1\nl2\nl3\nl4', 0)
    executeLineOp('delete', 3, ctx)
    expect(ctx._text).toBe('l4')
    expect(ctx._register).toBe('l1\nl2\nl3\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._offset).toBe(0)
    expect(ctx.recordedChanges).toEqual([
      { type: 'operator', op: 'delete', motion: 'd', count: 3 },
    ])
  })

  test('3dd from the middle of line 2 still deletes whole lines', () => {
    const ctx = createMockCtx('l1\nl2\nl3\nl4', 4)
    executeLineOp('delete', 3, ctx)
    expect(ctx._text).toBe('l1')
    expect(ctx._register).toBe('l2\nl3\nl4\n')
    // Deleting to EOF: cursor lands on the last grapheme (binary `Vee`).
    expect(ctx._offset).toBe(1)
  })

  test('dd count past EOF clamps to the remaining lines', () => {
    const ctx = createMockCtx('l1\nl2', 0)
    executeLineOp('delete', 5, ctx)
    expect(ctx._text).toBe('')
    expect(ctx._register).toBe('l1\nl2\n')
  })

  test('dd on the last line removes it without leaving a trailing newline', () => {
    const ctx = createMockCtx('a\nb', 2)
    executeLineOp('delete', 1, ctx)
    expect(ctx._text).toBe('a')
    expect(ctx._register).toBe('b\n')
    expect(ctx._offset).toBe(0)
  })

  test('2yy yanks 2 lines linewise without modifying the text', () => {
    const ctx = createMockCtx('l1\nl2\nl3', 3)
    executeLineOp('yank', 2, ctx)
    expect(ctx._text).toBe('l1\nl2\nl3')
    expect(ctx._register).toBe('l2\nl3\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._offset).toBe(3)
    expect(ctx.recordedChanges).toHaveLength(0)
  })

  test('cc clears the cursor line and enters insert there', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 5)
    executeLineOp('change', 1, ctx)
    expect(ctx._text).toBe('one\n\nthree')
    expect(ctx._insertOffset).toBe(4)
    expect(ctx._register).toBe('two\n')
    expect(ctx.recordedChanges).toEqual([
      { type: 'operator', op: 'change', motion: 'c', count: 1 },
    ])
  })

  test('2cc replaces two lines with one empty line and enters insert', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 1)
    executeLineOp('change', 2, ctx)
    expect(ctx._text).toBe('\nthree')
    expect(ctx._insertOffset).toBe(0)
  })

  test('count 0 is a no-op (bt guard)', () => {
    const ctx = createMockCtx('one\ntwo', 0)
    executeLineOp('delete', 0, ctx)
    expect(ctx._text).toBe('one\ntwo')
    expect(ctx.recordedChanges).toHaveLength(0)
  })
})

describe('CC 2.1.281 — dot-repeat of the rewritten operator paths', () => {
  test('replaying a recorded dG (count 0) deletes to the last line again', () => {
    const record: RecordedChange = {
      type: 'operator',
      op: 'delete',
      motion: 'G',
      count: 0,
    }
    const ctx = createMockCtx('one\ntwo\nthree', 5)
    // Fe dispatch: motion === 'G' → executeOperatorG with the recorded count.
    if (record.type !== 'operator') throw new Error('unreachable')
    executeOperatorG(record.op, record.count, ctx)
    expect(ctx._text).toBe('one')
    expect(ctx._register).toBe('two\nthree\n')
  })

  test('replayOperatorChange with linewise motion j replaces whole lines', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 1)
    replayOperatorChange('j', 1, 'X', ctx)
    expect(ctx._text).toBe('X\nthree')
    expect(ctx._register).toBe('one\ntwo\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._offset).toBe(0)
  })

  test('replayOperatorChange resolves recorded G with count 0 to the last line', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 5)
    replayOperatorChange('G', 0, 'Z', ctx)
    expect(ctx._text).toBe('one\nZ')
    expect(ctx._register).toBe('two\nthree\n')
    expect(ctx._registerLinewise).toBe(true)
    expect(ctx._offset).toBe(4)
  })

  test('replayOperatorChange resolves recorded gg (count 1) to the first line', () => {
    const ctx = createMockCtx('one\ntwo\nthree', 9)
    replayOperatorChange('gg', 1, 'Q', ctx)
    expect(ctx._text).toBe('Q')
    expect(ctx._register).toBe('one\ntwo\nthree\n')
    expect(ctx._registerLinewise).toBe(true)
  })

  test('replayOperatorChange charwise cw still splices the typed text', () => {
    const ctx = createMockCtx('hello world', 0)
    replayOperatorChange('w', 1, 'bye', ctx)
    expect(ctx._text).toBe('bye world')
    expect(ctx._register).toBe('hello')
  })
})
