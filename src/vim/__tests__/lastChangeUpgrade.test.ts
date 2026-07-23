import { describe, expect, test } from 'bun:test'
import { Cursor } from '../../utils/Cursor.js'
import { replayOperatorChange, type OperatorContext } from '../operators.js'
import { upgradeLastChangeOnInsertExit } from '../lastChangeUpgrade.js'
import type { Operator, RecordedChange } from '../types.js'

/**
 * CC 2.1.216 #6 (b) — regression guard for `cc`/`S` dot-repeat.
 *
 * PR #225 wired `c`-operator dot-repeat via an INSERT-exit upgrade to
 * `operatorChange`. The upgrade condition `last.op === 'change'` did not
 * distinguish real motions (`cw`='w', `C`='$') from the pseudo-motion that
 * `executeLineOp` records for line-ops (`cc`/`S` record `motion: op[0]`='c').
 * So `cc{text}<Esc>` upgraded to `operatorChange` with motion 'c', and `.`
 * called `replayOperatorChange('c',…)` → `resolveMotion('c')` is a no-op →
 * `from===to===cursor` → `setRegister("", false)` silently cleared the
 * register (data-loss) and inserted text without re-clearing the line.
 *
 * Fix: the upgrade helper skips `operator`+`change` when `motion === op[0]`
 * (line-op), so `cc`/`S` fall through to `insert` (register untouched).
 */

const ccRecord = (count = 1): RecordedChange => ({
  type: 'operator',
  op: 'change' as Operator,
  motion: 'c', // pseudo-motion === op[0] ('c'); set by executeLineOp
  count,
})
const cwRecord = (count = 1): RecordedChange => ({
  type: 'operator',
  op: 'change' as Operator,
  motion: 'w', // real motion
  count,
})
const CRecord = (): RecordedChange => ({
  type: 'operator',
  op: 'change' as Operator,
  motion: '$', // real motion (executeOperatorMotion('change','$',1))
  count: 1,
})

describe('CC 2.1.216 #6 (b) — cc/S dot-repeat regression guard', () => {
  describe('upgradeLastChangeOnInsertExit: line-ops do NOT upgrade to operatorChange', () => {
    test('cc + typed text → insert (NOT operatorChange) — register-safe replay', () => {
      const upgraded = upgradeLastChangeOnInsertExit(ccRecord(), 'X')
      expect(upgraded?.type).toBe('insert')
      if (upgraded?.type === 'insert') expect(upgraded.text).toBe('X')
    })

    test('S + typed text → insert (S is executeLineOp change, motion "c")', () => {
      // S dispatches to executeLineOp('change',…) → records motion: op[0]='c'
      const upgraded = upgradeLastChangeOnInsertExit(ccRecord(1), 'Y')
      expect(upgraded?.type).toBe('insert')
    })

    test('cc with NO typed text → undefined (no upgrade, no insert)', () => {
      // `cc<Esc>` with nothing typed: lastChange stays as-is (operator record),
      // neither upgraded nor turned into an empty insert.
      const upgraded = upgradeLastChangeOnInsertExit(ccRecord(), '')
      expect(upgraded).toBeUndefined()
    })

    test('cc with count > 1 still falls to insert (motion still "c")', () => {
      const upgraded = upgradeLastChangeOnInsertExit(ccRecord(3), 'Z')
      expect(upgraded?.type).toBe('insert')
    })
  })

  describe('upgradeLastChangeOnInsertExit: real-motion c-ops still upgrade', () => {
    test('cw + typed text → operatorChange (motion "w")', () => {
      const upgraded = upgradeLastChangeOnInsertExit(cwRecord(1), 'hi')
      expect(upgraded?.type).toBe('operatorChange')
      if (upgraded?.type === 'operatorChange') {
        expect(upgraded.motion).toBe('w')
        expect(upgraded.op).toBe('change')
        expect(upgraded.text).toBe('hi')
        expect(upgraded.count).toBe(1)
      }
    })

    test('C + typed text → operatorChange (motion "$")', () => {
      const upgraded = upgradeLastChangeOnInsertExit(CRecord(), 'hi')
      expect(upgraded?.type).toBe('operatorChange')
      if (upgraded?.type === 'operatorChange') expect(upgraded.motion).toBe('$')
    })

    test('cw with count > 1 carries the count into operatorChange', () => {
      const upgraded = upgradeLastChangeOnInsertExit(cwRecord(3), 'x')
      if (upgraded?.type === 'operatorChange') expect(upgraded.count).toBe(3)
    })
  })

  describe('upgradeLastChangeOnInsertExit: other branches unchanged', () => {
    test('visualOp+change → visualChange', () => {
      const last: RecordedChange = {
        type: 'visualOp',
        op: 'change',
        span: 5,
        linewise: false,
      } as RecordedChange
      const upgraded = upgradeLastChangeOnInsertExit(last, 'txt')
      expect(upgraded?.type).toBe('visualChange')
      if (upgraded?.type === 'visualChange') {
        expect(upgraded.span).toBe(5)
        expect(upgraded.text).toBe('txt')
      }
    })

    test('no last + typed text → insert', () => {
      const upgraded = upgradeLastChangeOnInsertExit(undefined, 'abc')
      expect(upgraded?.type).toBe('insert')
    })

    test('no last + no typed text → undefined', () => {
      expect(upgradeLastChangeOnInsertExit(undefined, '')).toBeUndefined()
    })
  })

  describe('bug mechanism: replayOperatorChange on a no-op (line-op) motion clears the register', () => {
    // Characterization proving WHY cc/S must not reach replayOperatorChange:
    // resolveMotion('c') is a no-op → from===to===cursor → setRegister("", false).
    // This test documents the data-loss mechanism the upgrade guard prevents.
    function createMockCtx(
      text: string,
      offset = 0,
    ): OperatorContext & { _register: string } {
      const state = { text, offset, register: 'PRESET-LINE\n' }
      const ctx = {
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
        enterInsert: () => {},
        getRegister: () => state.register,
        setRegister: (c: string) => {
          state.register = c
        },
        getLastFind: () => null,
        setLastFind: () => {},
        recordChange: () => {},
        get _register() {
          return state.register
        },
      } as unknown as OperatorContext & { _register: string }
      return ctx
    }

    test('replayOperatorChange("c", …) clears a preset register (the regression)', () => {
      const ctx = createMockCtx('hello world', 0)
      // Register preset to the line content `cc` would have yanked.
      expect(ctx._register).toBe('PRESET-LINE\n')
      // `.` if cc had upgraded to operatorChange(motion='c'):
      replayOperatorChange('c', 1, 'X', ctx)
      // The no-op motion → from===to → setRegister("", false) → DATA LOSS.
      expect(ctx._register).toBe('')
    })
  })
})
