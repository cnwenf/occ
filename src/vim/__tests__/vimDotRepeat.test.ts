import { test, expect, describe } from 'bun:test'
import { Cursor } from '../../utils/Cursor.js'
import { executePaste, replayOperatorChange } from '../operators.js'
import type { OperatorContext } from '../operators.js'
import type { RecordedChange } from '../types.js'

// CC 2.1.216 #6 (b): vim dot-repeat of `c`-operators and paste.
// Two bugs: (1) executePaste never called recordChange, so `.` after p/P
// did nothing; (2) c-operator's inserted text was not captured for
// dot-repeat, so `.` after `cw{text}<Esc>` re-deleted but didn't re-insert.

/**
 * Minimal mock OperatorContext for testing pure operator functions.
 * Tracks text, offset, register, and recorded changes.
 */
function createMockCtx(
  text: string,
  offset = 0,
): OperatorContext & {
  recordedChanges: RecordedChange[]
  _text: string
  _offset: number
  _register: string
} {
  const state = { text, offset, register: '' }
  const recordedChanges: RecordedChange[] = []
  const ctx: OperatorContext & {
    recordedChanges: RecordedChange[]
    _text: string
    _offset: number
    _register: string
  } = {
    get cursor() {
      return Cursor.fromText(state.text, 80, state.offset)
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
    enterInsert: (_o: number) => {},
    getRegister: () => state.register,
    setRegister: (c: string, _l: boolean) => {
      state.register = c
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
  }
  return ctx
}

describe('CC 2.1.216 #6 (b) — vim dot-repeat: paste + c-operator', () => {
  describe('executePaste records change for dot-repeat', () => {
    test('charwise paste records a paste-type change', () => {
      const ctx = createMockCtx('hello world', 5)
      ctx.setRegister('xyz', false)
      executePaste(true, 1, ctx)
      expect(ctx.recordedChanges).toHaveLength(1)
      expect(ctx.recordedChanges[0].type).toBe('paste')
      const change = ctx.recordedChanges[0] as {
        type: 'paste'
        after: boolean
        count: number
        linewise: boolean
      }
      expect(change.after).toBe(true)
      expect(change.count).toBe(1)
      expect(change.linewise).toBe(false)
    })

    test('linewise paste records linewise=true', () => {
      const ctx = createMockCtx('line1\nline2', 5)
      ctx.setRegister('pasted\n', true)
      executePaste(true, 1, ctx)
      expect(ctx.recordedChanges).toHaveLength(1)
      expect(ctx.recordedChanges[0].type).toBe('paste')
      const change = ctx.recordedChanges[0] as {
        type: 'paste'
        linewise: boolean
      }
      expect(change.linewise).toBe(true)
    })

    test('paste with count > 1 records the count', () => {
      const ctx = createMockCtx('hello', 0)
      ctx.setRegister('x', false)
      executePaste(false, 3, ctx)
      expect(ctx.recordedChanges).toHaveLength(1)
      const change = ctx.recordedChanges[0] as {
        type: 'paste'
        count: number
      }
      expect(change.count).toBe(3)
    })

    test('paste with empty register does not record (nothing happened)', () => {
      const ctx = createMockCtx('hello', 0)
      // Empty register → executePaste returns early
      executePaste(true, 1, ctx)
      // Even if it returns early, no change should be recorded (nothing to replay)
      // Note: the fix calls recordChange after the early return guard, so
      // if register is empty, no change is recorded.
      expect(ctx.recordedChanges).toHaveLength(0)
    })
  })

  describe('replayOperatorChange re-deletes range and re-inserts text', () => {
    test('cw + "hi" → dot-repeat deletes word and inserts "hi"', () => {
      // Text: "hello world", cursor at 0, motion "w" deletes "hello"
      // replayOperatorChange should delete "hello" and insert "hi"
      const ctx = createMockCtx('hello world', 0)
      replayOperatorChange('w', 1, 'hi', ctx)
      // After replay: "hi world"
      expect(ctx._text).toBe('hi world')
    })

    test('cw + empty text → dot-repeat deletes word only', () => {
      const ctx = createMockCtx('hello world', 0)
      replayOperatorChange('w', 1, '', ctx)
      // After replay: " world" (just the deletion, no insertion)
      expect(ctx._text).toBe(' world')
    })

    test('replay sets the register with deleted content', () => {
      const ctx = createMockCtx('hello world', 0)
      replayOperatorChange('w', 1, 'hi', ctx)
      // The deleted content ("hello") should be in the register
      expect(ctx._register).toBe('hello')
    })

    test('replay positions cursor on last char of inserted text', () => {
      const ctx = createMockCtx('hello world', 0)
      replayOperatorChange('w', 1, 'hi', ctx)
      // Cursor on last char of "hi" (offset 1 = 'i'), matching
      // replayVisualChange's lastGrapheme-based offset formula.
      expect(ctx._offset).toBe(1)
    })
  })
})
