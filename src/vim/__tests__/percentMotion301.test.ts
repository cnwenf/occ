import { describe, expect, test } from 'bun:test'
import { Cursor } from '../../utils/Cursor.js'
import { isInclusiveMotion, resolveMotion } from '../motions.js'
import { executeOperatorMotion } from '../operators.js'
import type { OperatorContext } from '../operators.js'
import { transition } from '../transitions.js'
import type { RecordedChange } from '../types.js'

// CC 2.1.301 (occ160 WP-D) — vim `%` motion port.
// Verified against the official v301 linux-x64 ELF (byte-forensics):
//   z  (resolveMotion count guard)      @236316959: `if(t==="%"&&r!==1)return e`
//   ln (applySingleMotion case "%")     @236317723: `case"%":{let r=fn(y5o(e.text),e.offset);return r===null?e:new di(e.measuredText,r)}`
//   fn (findMatchingBracket)            @236317800 region (verbatim):
//     `function fn(t,e){let r=t.indexOf("\n",e),n=r===-1?t.length:r,
//      s=t.slice(e,n).search(/[()[\]{}]/);if(s===-1)return null;
//      let o=e+s,i=ne(t,o,t[o],!1);if(!i)return null;
//      return i.start===o?i.end-1:i.start}`
//   He (isInclusiveMotion)              `"eE$%".includes(t)`
//   q  (operator guard)                 @236318544: `if(e==="%"&&s.equals(n.cursor))return;`
//   y5o/mt/Nt (pill blanking)           @236281883

/**
 * Mock OperatorContext — same pattern as vimOperators281.test.ts (cursor
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

function offsetOf(text: string, offset: number, key = '%', count = 1): number {
  return resolveMotion(key, Cursor.fromText(text, 80, offset), count).offset
}

describe('CC 2.1.301 % motion — forward/backward jumps for ()[]{}', () => {
  test('jumps from ( to ) and back', () => {
    expect(offsetOf('(ab)', 0)).toBe(3)
    expect(offsetOf('(ab)', 3)).toBe(0)
  })

  test('jumps from [ to ] and back', () => {
    expect(offsetOf('[ab]', 0)).toBe(3)
    expect(offsetOf('[ab]', 3)).toBe(0)
  })

  test('jumps from { to } and back', () => {
    expect(offsetOf('{ab}', 0)).toBe(3)
    expect(offsetOf('{ab}', 3)).toBe(0)
  })

  test('finds the first bracket at or after the cursor on the line', () => {
    // official `fn`: `t.slice(e,n).search(...)` — scan starts AT the cursor
    expect(offsetOf('ab(cd)', 0)).toBe(5)
    expect(offsetOf('ab(cd)', 1)).toBe(5)
    expect(offsetOf('ab(cd)', 2)).toBe(5)
  })

  test('empty pair: ( at cursor jumps to adjacent )', () => {
    expect(offsetOf('()', 0)).toBe(1)
    expect(offsetOf('()', 1)).toBe(0)
  })

  test('nested pairs resolve to their own partner', () => {
    // a(b(c)d)  → indices: ( =1, ( =3, ) =5, ) =7
    const text = 'a(b(c)d)'
    expect(offsetOf(text, 1)).toBe(7)
    expect(offsetOf(text, 3)).toBe(5)
    expect(offsetOf(text, 5)).toBe(3)
    expect(offsetOf(text, 7)).toBe(1)
  })

  test('matching works across lines once the bracket is found', () => {
    // bracket SCAN is line-scoped; the pair search (findTextObject) is not
    expect(offsetOf('a(\nb)', 0)).toBe(4)
  })

  test('no bracket on the line → no movement', () => {
    expect(offsetOf('abc', 0)).toBe(0)
    expect(offsetOf('abc', 2)).toBe(2)
  })

  test('bracket scan does not cross into the next line', () => {
    // the ( on line 2 must not be seen from line 1 → no movement
    expect(offsetOf('ab\nc(d)', 0)).toBe(0)
  })

  test('unmatched bracket → no movement', () => {
    expect(offsetOf('a(b', 1)).toBe(1)
    expect(offsetOf('a)b', 1)).toBe(1)
  })

  test('count !== 1 makes % a complete no-op (official z guard)', () => {
    expect(offsetOf('(ab)', 0, '%', 2)).toBe(0)
    expect(offsetOf('(ab)', 0, '%', 3)).toBe(0)
  })

  test('% is an inclusive motion (official He = "eE$%")', () => {
    expect(isInclusiveMotion('%')).toBe(true)
    expect(isInclusiveMotion('e')).toBe(true)
    expect(isInclusiveMotion('h')).toBe(false)
  })

  test('placeholder pills are blanked before the scan (official y5o)', () => {
    // "[Pasted text #1]" is 16 chars; blanked → its own [ ] must not match.
    // First real bracket is ( at offset 17 → partner ) at 19.
    const text = '[Pasted text #1] (x)'
    expect(offsetOf(text, 0)).toBe(19)
    // a pill sitting between the brackets does not break the match
    const text2 = '(a [Image #1] b)'
    expect(offsetOf(text2, 0)).toBe(15)
    expect(offsetOf(text2, 15)).toBe(0)
  })
})

describe('CC 2.1.301 % with operators — d% / c% / y%', () => {
  test('d% deletes through the partner bracket (inclusive)', () => {
    const ctx = createMockCtx('x(ab)y', 1)
    const result = transition({ type: 'operator', op: 'delete', count: 1, countTyped: false }, '%', ctx)
    result.execute?.()
    expect(ctx._text).toBe('xy')
    expect(ctx._register).toBe('(ab)')
    expect(ctx.recordedChanges).toEqual([
      { type: 'operator', op: 'delete', motion: '%', count: 1 },
    ])
  })

  test('y% yanks through the partner bracket', () => {
    const ctx = createMockCtx('x(ab)y', 1)
    const result = transition({ type: 'operator', op: 'yank', count: 1, countTyped: false }, '%', ctx)
    result.execute?.()
    expect(ctx._text).toBe('x(ab)y')
    expect(ctx._register).toBe('(ab)')
    expect(ctx.recordedChanges).toEqual([]) // yank is not recorded for dot
  })

  test('c% deletes and enters INSERT', () => {
    const ctx = createMockCtx('x(ab)y', 1)
    const result = transition({ type: 'operator', op: 'change', count: 1, countTyped: false }, '%', ctx)
    result.execute?.()
    expect(ctx._text).toBe('xy')
    expect(ctx._insertOffset).toBe(1)
  })

  test('d% with no match is a silent no-op (official q guard @236318544)', () => {
    const ctx = createMockCtx('abc', 1)
    ctx.setRegister('preset', false)
    const result = transition({ type: 'operator', op: 'delete', count: 1, countTyped: false }, '%', ctx)
    result.execute?.()
    expect(ctx._text).toBe('abc')
    expect(ctx._offset).toBe(1)
    expect(ctx._register).toBe('preset') // register untouched
    expect(ctx._insertOffset).toBe(-1)
    expect(ctx.recordedChanges).toEqual([])
  })

  test('c% with no match does NOT enter INSERT (guard precedes zero-width branch)', () => {
    const ctx = createMockCtx('abc', 1)
    const result = transition({ type: 'operator', op: 'change', count: 1, countTyped: false }, '%', ctx)
    result.execute?.()
    expect(ctx._insertOffset).toBe(-1)
    expect(ctx._text).toBe('abc')
  })

  test('d2% is a no-op (count guard + operator guard)', () => {
    const ctx = createMockCtx('(ab)', 0)
    executeOperatorMotion('delete', '%', 2, ctx)
    expect(ctx._text).toBe('(ab)')
    expect(ctx.recordedChanges).toEqual([])
  })

  test('executeOperatorMotion direct: d% from closer to opener', () => {
    const ctx = createMockCtx('(ab)', 3)
    executeOperatorMotion('delete', '%', 1, ctx)
    expect(ctx._text).toBe('')
    expect(ctx._register).toBe('(ab)')
  })
})

describe('CC 2.1.301 % standalone motion via transition()', () => {
  test('% in NORMAL idle moves the cursor to the partner bracket', () => {
    const ctx = createMockCtx('(ab)', 0)
    const result = transition({ type: 'idle' }, '%', ctx)
    result.execute?.()
    expect(ctx._offset).toBe(3)
  })

  test('% with no match leaves the cursor alone', () => {
    const ctx = createMockCtx('abc', 2)
    const result = transition({ type: 'idle' }, '%', ctx)
    result.execute?.()
    expect(ctx._offset).toBe(2)
  })
})
