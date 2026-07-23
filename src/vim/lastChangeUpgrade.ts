import type { Operator } from './types.js'
import type { RecordedChange } from './types.js'

/**
 * CC 2.1.216 #6 (b): on INSERT-exit, upgrade `lastChange` so `.` (dot-repeat)
 * can replay the just-typed text. Extracted from `useVimInput.switchToNormalMode`
 * as a pure function so the upgrade decision is unit-testable (the hook is not).
 *
 * Branches (mirror the official binary's insert-exit upgrade):
 * 1. `visualOp` + `change` → `visualChange` (carries span/linewise/typed text).
 * 2. `operator` + `change` → `operatorChange` (carries motion/count/typed text)
 *    so `.` re-deletes the motion range and re-inserts the text — BUT only when
 *    the recorded motion is a REAL motion, not the operator's own first char.
 *    `cc`/`S` are LINE-ops: `executeLineOp` records `motion: op[0]` (e.g. 'c')
 *    as a pseudo-motion. `resolveMotion('c')` is a no-op, so routing `cc` through
 *    `replayOperatorChange` would compute `from===to===cursor` → `setRegister("", false)`
 *    → silently clears the register (data-loss) and insert text without
 *    re-clearing the line. Line-ops therefore fall through to the `insert`
 *    branch (plain insert replay, register untouched) — restoring pre-#6b
 *    behavior for `cc`/`S` while keeping the correct `cw`/`C` operator replay.
 * 3. otherwise, if text was typed, record a plain `insert` for dot-repeat.
 *
 * @param last          The `lastChange` recorded by the operator that entered INSERT.
 * @param insertedText  The text typed during the INSERT session.
 * @returns The upgraded `lastChange` (or `undefined` to leave it unchanged).
 */
export function upgradeLastChangeOnInsertExit(
  last: RecordedChange | undefined,
  insertedText: string,
): RecordedChange | undefined {
  if (last?.type === 'visualOp' && last.op === 'change') {
    return {
      type: 'visualChange',
      span: last.span,
      linewise: last.linewise,
      text: insertedText,
    }
  }

  // `cw`/`C` (real motion) → operatorChange. `cc`/`S` (pseudo-motion === op[0])
  // must NOT upgrade here — fall through to `insert` to avoid clearing the
  // register via replayOperatorChange's no-op-motion path.
  if (
    last?.type === 'operator' &&
    last.op === 'change' &&
    isRealMotion(last.motion, last.op)
  ) {
    return {
      type: 'operatorChange',
      op: last.op,
      motion: last.motion,
      count: last.count,
      text: insertedText,
    }
  }

  if (insertedText) {
    return { type: 'insert', text: insertedText }
  }

  return undefined
}

/**
 * A `c`-operator's motion is "real" (suitable for `replayOperatorChange`) unless
 * it is the operator's own first char — which is how `executeLineOp` marks
 * line-ops (`cc`/`dd`/`yy`/`S`) with a pseudo-motion. `cw` ('w'), `C` ('$'),
 * `c$`, etc. are real motions; `cc`/`S` (motion 'c' === op 'change'[0]) are not.
 */
function isRealMotion(motion: string, op: Operator): boolean {
  return motion !== op[0]
}
