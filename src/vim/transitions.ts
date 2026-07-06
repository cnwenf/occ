/**
 * Vim State Transition Table
 *
 * This is the scannable source of truth for state transitions.
 * To understand what happens in any state, look up that state's transition function.
 */

import { resolveMotion } from './motions.js'
import {
  executeIndent,
  executeJoin,
  executeLineOp,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorG,
  executeOperatorGg,
  executeOperatorMotion,
  executeOperatorTextObj,
  executePaste,
  executeReplace,
  executeToggleCase,
  executeVisualCase,
  executeVisualOperator,
  executeVisualReplace,
  executeX,
  type OperatorContext,
} from './operators.js'
import { findTextObject } from './textObjects.js'
import {
  type CaseOp,
  type CommandState,
  FIND_KEYS,
  type FindType,
  isOperatorKey,
  isTextObjScopeKey,
  isVisualKindKey,
  MAX_VIM_COUNT,
  OPERATORS,
  type Operator,
  SIMPLE_MOTIONS,
  TEXT_OBJ_SCOPES,
  TEXT_OBJ_TYPES,
  type TextObjScope,
} from './types.js'

/**
 * Context passed to transition functions.
 */
export type TransitionContext = OperatorContext & {
  onUndo?: () => void
  onDotRepeat?: () => void
  /**
   * Opens reverse history search. Called when '/' is pressed in NORMAL idle
   * mode (2.1.152+). Matches the binary's `P.key==="/"&&a` dispatch.
   */
  onHistorySearch?: () => void
}

/**
 * Result of a transition.
 */
export type TransitionResult = {
  next?: CommandState
  execute?: () => void
}

/**
 * Result of a VISUAL-mode transition.
 *
 * - `next` + optional `move`: stay in VISUAL, update command, move cursor
 *   (extends the selection).
 * - `exit`: leave VISUAL mode after performing an action on the selection.
 * - `toggleKind`: switch char↔line, or exit if same kind.
 */
export type VisualTransitionResult =
  | { next: CommandState; move?: () => void }
  | { exit: 'operator'; op: Operator; forceLinewise?: boolean }
  | { exit: 'replace'; char: string }
  | { exit: 'case'; op: CaseOp }
  | { exit: 'paste' }
  | { exit: 'join' }
  | { exit: 'swap' }
  | { exit: 'indent'; dir: '>' | '<'; count: number }
  | { exit: 'selectRange'; start: number; end: number }
  | { exit: 'toggleKind'; key: 'v' | 'V' }

/**
 * Main transition function. Dispatches based on current state type.
 */
export function transition(
  state: CommandState,
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  switch (state.type) {
    case 'idle':
      return fromIdle(input, ctx)
    case 'count':
      return fromCount(state, input, ctx)
    case 'operator':
      return fromOperator(state, input, ctx)
    case 'operatorCount':
      return fromOperatorCount(state, input, ctx)
    case 'operatorFind':
      return fromOperatorFind(state, input, ctx)
    case 'operatorTextObj':
      return fromOperatorTextObj(state, input, ctx)
    case 'find':
      return fromFind(state, input, ctx)
    case 'g':
      return fromG(state, input, ctx)
    case 'operatorG':
      return fromOperatorG(state, input, ctx)
    case 'replace':
      return fromReplace(state, input, ctx)
    case 'indent':
      return fromIndent(state, input, ctx)
  }
}

// ============================================================================
// Shared Input Handling
// ============================================================================

/**
 * Handle input that's valid in both idle and count states.
 * Returns null if input is not recognized.
 */
function handleNormalInput(
  input: string,
  count: number,
  ctx: TransitionContext,
): TransitionResult | null {
  if (isOperatorKey(input)) {
    return { next: { type: 'operator', op: OPERATORS[input], count } }
  }

  if (SIMPLE_MOTIONS.has(input)) {
    return {
      execute: () => {
        const target = resolveMotion(input, ctx.cursor, count)
        ctx.setOffset(target.offset)
      },
    }
  }

  if (FIND_KEYS.has(input)) {
    return { next: { type: 'find', find: input as FindType, count } }
  }

  if (input === 'g') return { next: { type: 'g', count } }
  if (input === 'r') return { next: { type: 'replace', count } }
  if (input === '>' || input === '<') {
    return { next: { type: 'indent', dir: input, count } }
  }
  if (input === '~') {
    return { execute: () => executeToggleCase(count, ctx) }
  }
  if (input === 'x') {
    return { execute: () => executeX(count, ctx) }
  }
  if (input === 'J') {
    return { execute: () => executeJoin(count, ctx) }
  }
  if (input === 'p' || input === 'P') {
    return { execute: () => executePaste(input === 'p', count, ctx) }
  }
  if (input === 'D') {
    return { execute: () => executeOperatorMotion('delete', '$', 1, ctx) }
  }
  if (input === 'C') {
    return { execute: () => executeOperatorMotion('change', '$', 1, ctx) }
  }
  if (input === 'Y') {
    return { execute: () => executeLineOp('yank', count, ctx) }
  }
  if (input === 'G') {
    return {
      execute: () => {
        // count=1 means no count given, go to last line
        // otherwise go to line N
        if (count === 1) {
          ctx.setOffset(ctx.cursor.startOfLastLine().offset)
        } else {
          ctx.setOffset(ctx.cursor.goToLine(count).offset)
        }
      },
    }
  }
  if (input === '.') {
    return { execute: () => ctx.onDotRepeat?.() }
  }
  if (input === ';' || input === ',') {
    return { execute: () => executeRepeatFind(input === ',', count, ctx) }
  }
  if (input === 'u') {
    return { execute: () => ctx.onUndo?.() }
  }
  if (input === 'i') {
    return { execute: () => ctx.enterInsert(ctx.cursor.offset) }
  }
  if (input === 'I') {
    return {
      execute: () =>
        ctx.enterInsert(ctx.cursor.firstNonBlankInLogicalLine().offset),
    }
  }
  if (input === 'a') {
    return {
      execute: () => {
        const newOffset = ctx.cursor.isAtEnd()
          ? ctx.cursor.offset
          : ctx.cursor.right().offset
        ctx.enterInsert(newOffset)
      },
    }
  }
  if (input === 'A') {
    return {
      execute: () => ctx.enterInsert(ctx.cursor.endOfLogicalLine().offset),
    }
  }
  if (input === 'o') {
    return { execute: () => executeOpenLine('below', ctx) }
  }
  if (input === 'O') {
    return { execute: () => executeOpenLine('above', ctx) }
  }

  return null
}

/**
 * Handle operator input (motion, find, text object scope).
 * Returns null if input is not recognized.
 */
function handleOperatorInput(
  op: Operator,
  count: number,
  input: string,
  ctx: TransitionContext,
): TransitionResult | null {
  if (isTextObjScopeKey(input)) {
    return {
      next: {
        type: 'operatorTextObj',
        op,
        count,
        scope: TEXT_OBJ_SCOPES[input],
      },
    }
  }

  if (FIND_KEYS.has(input)) {
    return {
      next: { type: 'operatorFind', op, count, find: input as FindType },
    }
  }

  if (SIMPLE_MOTIONS.has(input)) {
    return { execute: () => executeOperatorMotion(op, input, count, ctx) }
  }

  if (input === 'G') {
    return { execute: () => executeOperatorG(op, count, ctx) }
  }

  if (input === 'g') {
    return { next: { type: 'operatorG', op, count } }
  }

  return null
}

// ============================================================================
// Transition Functions - One per state type
// ============================================================================

function fromIdle(input: string, ctx: TransitionContext): TransitionResult {
  // 0 is line-start motion, not a count prefix
  if (/[1-9]/.test(input)) {
    return { next: { type: 'count', digits: input } }
  }
  if (input === '0') {
    return {
      execute: () => ctx.setOffset(ctx.cursor.startOfLogicalLine().offset),
    }
  }
  // 2.1.152: '/' in NORMAL idle opens reverse history search.
  // Binary: `if(L.command.type==="idle"&&P.key==="/"&&a){a(),...return}`
  if (input === '/' && ctx.onHistorySearch) {
    return { execute: () => ctx.onHistorySearch?.() }
  }

  const result = handleNormalInput(input, 1, ctx)
  if (result) return result

  return {}
}

function fromCount(
  state: { type: 'count'; digits: string },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (/[0-9]/.test(input)) {
    const newDigits = state.digits + input
    const count = Math.min(parseInt(newDigits, 10), MAX_VIM_COUNT)
    return { next: { type: 'count', digits: String(count) } }
  }

  const count = parseInt(state.digits, 10)
  const result = handleNormalInput(input, count, ctx)
  if (result) return result

  return { next: { type: 'idle' } }
}

function fromOperator(
  state: { type: 'operator'; op: Operator; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  // dd, cc, yy = line operation
  if (input === state.op[0]) {
    return { execute: () => executeLineOp(state.op, state.count, ctx) }
  }

  if (/[0-9]/.test(input)) {
    return {
      next: {
        type: 'operatorCount',
        op: state.op,
        count: state.count,
        digits: input,
      },
    }
  }

  const result = handleOperatorInput(state.op, state.count, input, ctx)
  if (result) return result

  return { next: { type: 'idle' } }
}

function fromOperatorCount(
  state: {
    type: 'operatorCount'
    op: Operator
    count: number
    digits: string
  },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (/[0-9]/.test(input)) {
    const newDigits = state.digits + input
    const parsedDigits = Math.min(parseInt(newDigits, 10), MAX_VIM_COUNT)
    return { next: { ...state, digits: String(parsedDigits) } }
  }

  const motionCount = parseInt(state.digits, 10)
  const effectiveCount = state.count * motionCount
  const result = handleOperatorInput(state.op, effectiveCount, input, ctx)
  if (result) return result

  return { next: { type: 'idle' } }
}

function fromOperatorFind(
  state: {
    type: 'operatorFind'
    op: Operator
    count: number
    find: FindType
  },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  return {
    execute: () =>
      executeOperatorFind(state.op, state.find, input, state.count, ctx),
  }
}

function fromOperatorTextObj(
  state: {
    type: 'operatorTextObj'
    op: Operator
    count: number
    scope: TextObjScope
  },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (TEXT_OBJ_TYPES.has(input)) {
    return {
      execute: () =>
        executeOperatorTextObj(state.op, state.scope, input, state.count, ctx),
    }
  }
  return { next: { type: 'idle' } }
}

function fromFind(
  state: { type: 'find'; find: FindType; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  return {
    execute: () => {
      const result = ctx.cursor.findCharacter(input, state.find, state.count)
      if (result !== null) {
        ctx.setOffset(result)
        ctx.setLastFind(state.find, input)
      }
    },
  }
}

function fromG(
  state: { type: 'g'; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (input === 'j' || input === 'k') {
    return {
      execute: () => {
        const target = resolveMotion(`g${input}`, ctx.cursor, state.count)
        ctx.setOffset(target.offset)
      },
    }
  }
  if (input === 'g') {
    // If count provided (e.g., 5gg), go to that line. Otherwise go to first line.
    if (state.count > 1) {
      return {
        execute: () => {
          const lines = ctx.text.split('\n')
          const targetLine = Math.min(state.count - 1, lines.length - 1)
          let offset = 0
          for (let i = 0; i < targetLine; i++) {
            offset += (lines[i]?.length ?? 0) + 1 // +1 for newline
          }
          ctx.setOffset(offset)
        },
      }
    }
    return {
      execute: () => ctx.setOffset(ctx.cursor.startOfFirstLine().offset),
    }
  }
  return { next: { type: 'idle' } }
}

function fromOperatorG(
  state: { type: 'operatorG'; op: Operator; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (input === 'j' || input === 'k') {
    return {
      execute: () =>
        executeOperatorMotion(state.op, `g${input}`, state.count, ctx),
    }
  }
  if (input === 'g') {
    return { execute: () => executeOperatorGg(state.op, state.count, ctx) }
  }
  // Any other input cancels the operator
  return { next: { type: 'idle' } }
}

function fromReplace(
  state: { type: 'replace'; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  // Backspace/Delete arrive as empty input in literal-char states. In vim,
  // r<BS> cancels the replace; without this guard, executeReplace("") would
  // delete the character under the cursor instead.
  if (input === '') return { next: { type: 'idle' } }
  return { execute: () => executeReplace(input, state.count, ctx) }
}

function fromIndent(
  state: { type: 'indent'; dir: '>' | '<'; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (input === state.dir) {
    return { execute: () => executeIndent(state.dir, state.count, ctx) }
  }
  return { next: { type: 'idle' } }
}

// ============================================================================
// Visual Mode Transitions
// ============================================================================

/**
 * Main visual transition function. Dispatches based on command state type.
 *
 * In VISUAL mode, motions return `{next, move}` — the `move` function extends
 * the selection by moving the cursor. Operators return `{exit, ...}` which the
 * hook uses to perform the action and leave VISUAL mode.
 */
export function transitionVisual(
  state: CommandState,
  input: string,
  ctx: TransitionContext,
): VisualTransitionResult {
  switch (state.type) {
    case 'idle':
      return fromVisualIdle(input, ctx)
    case 'count':
      return fromVisualCount(state, input, ctx)
    case 'find':
      return fromVisualFind(state, input, ctx)
    case 'g':
      return fromVisualG(state, input, ctx)
    case 'replace':
      // Backspace/Delete arrive as empty input; cancel the replace.
      if (input === '') return { next: { type: 'idle' } }
      return { exit: 'replace', char: input }
    case 'textObject':
      return fromVisualTextObject(state, input, ctx)
    default:
      return { next: { type: 'idle' } }
  }
}

/**
 * Handle input valid in both visual idle and visual count states.
 * Returns null if input is not recognized.
 */
function handleVisualOperatorInput(
  input: string,
  count: number,
  ctx: TransitionContext,
): VisualTransitionResult | null {
  // Operators (d/c/y) — exit and apply over the visual range
  if (isOperatorKey(input)) {
    return { exit: 'operator', op: OPERATORS[input] }
  }
  // x = delete char-wise, s = change char-wise
  if (input === 'x') return { exit: 'operator', op: 'delete' }
  if (input === 's') return { exit: 'operator', op: 'change' }
  // X/D = delete line-wise, C/S/R = change line-wise
  if (input === 'X' || input === 'D') {
    return { exit: 'operator', op: 'delete', forceLinewise: true }
  }
  if (input === 'C' || input === 'S' || input === 'R') {
    return { exit: 'operator', op: 'change', forceLinewise: true }
  }
  if (input === 'Y') {
    return { exit: 'operator', op: 'yank', forceLinewise: true }
  }
  // r = replace mode (await next char)
  if (input === 'r') return { next: { type: 'replace', count } }
  // Case operations
  if (input === '~') return { exit: 'case', op: 'toggle' }
  if (input === 'u') return { exit: 'case', op: 'lower' }
  if (input === 'U') return { exit: 'case', op: 'upper' }
  // Paste over selection
  if (input === 'p' || input === 'P') return { exit: 'paste' }
  // Indent
  if (input === '>' || input === '<') {
    return { exit: 'indent', dir: input, count }
  }
  // Toggle visual kind (v↔V) or exit if same
  if (input === 'v' || input === 'V') {
    return { exit: 'toggleKind', key: input }
  }
  // Swap anchor and cursor
  if (input === 'o') return { exit: 'swap' }
  // Join lines
  if (input === 'J') return { exit: 'join' }

  // Text object scope (i/a) — await the text object type key
  if (isTextObjScopeKey(input)) {
    return {
      next: {
        type: 'textObject',
        scope: TEXT_OBJ_SCOPES[input],
        count,
      },
    }
  }

  // Motions — move cursor (extends selection), stay in VISUAL
  if (SIMPLE_MOTIONS.has(input)) {
    return {
      next: { type: 'idle' },
      move: () => {
        const target = resolveMotion(input, ctx.cursor, count)
        ctx.setOffset(target.offset)
      },
    }
  }

  // Find motions — await the character
  if (FIND_KEYS.has(input)) {
    return { next: { type: 'find', find: input as FindType, count } }
  }

  // g prefix
  if (input === 'g') return { next: { type: 'g', count } }

  return null
}

function fromVisualIdle(
  input: string,
  ctx: TransitionContext,
): VisualTransitionResult {
  if (/[1-9]/.test(input)) {
    return { next: { type: 'count', digits: input } }
  }
  if (input === '0') {
    return {
      next: { type: 'idle' },
      move: () => ctx.setOffset(ctx.cursor.startOfLogicalLine().offset),
    }
  }
  return handleVisualOperatorInput(input, 1, ctx) ?? { next: { type: 'idle' } }
}

function fromVisualCount(
  state: { type: 'count'; digits: string },
  input: string,
  ctx: TransitionContext,
): VisualTransitionResult {
  if (/[0-9]/.test(input)) {
    const newDigits = state.digits + input
    const count = Math.min(parseInt(newDigits, 10), MAX_VIM_COUNT)
    return { next: { type: 'count', digits: String(count) } }
  }
  const count = parseInt(state.digits, 10)
  return (
    handleVisualOperatorInput(input, count, ctx) ?? { next: { type: 'idle' } }
  )
}

function fromVisualFind(
  state: { type: 'find'; find: FindType; count: number },
  input: string,
  ctx: TransitionContext,
): VisualTransitionResult {
  return {
    next: { type: 'idle' },
    move: () => {
      const result = ctx.cursor.findCharacter(input, state.find, state.count)
      if (result !== null) {
        ctx.setOffset(result)
        ctx.setLastFind(state.find, input)
      }
    },
  }
}

function fromVisualG(
  state: { type: 'g'; count: number },
  input: string,
  ctx: TransitionContext,
): VisualTransitionResult {
  if (input === 'j' || input === 'k') {
    return {
      next: { type: 'idle' },
      move: () => {
        const target = resolveMotion(`g${input}`, ctx.cursor, state.count)
        ctx.setOffset(target.offset)
      },
    }
  }
  if (input === 'g') {
    return {
      next: { type: 'idle' },
      move: () => {
        if (state.count > 1) {
          const lines = ctx.text.split('\n')
          const targetLine = Math.min(state.count - 1, lines.length - 1)
          let offset = 0
          for (let i = 0; i < targetLine; i++) {
            offset += (lines[i]?.length ?? 0) + 1
          }
          ctx.setOffset(offset)
        } else {
          ctx.setOffset(ctx.cursor.startOfFirstLine().offset)
        }
      },
    }
  }
  return { next: { type: 'idle' } }
}

function fromVisualTextObject(
  state: { type: 'textObject'; scope: TextObjScope; count: number },
  input: string,
  ctx: TransitionContext,
): VisualTransitionResult {
  if (TEXT_OBJ_TYPES.has(input)) {
    const range = findTextObject(
      ctx.text,
      ctx.cursor.offset,
      input,
      state.scope === 'inner',
    )
    if (range) {
      return { exit: 'selectRange', start: range.start, end: range.end }
    }
  }
  return { next: { type: 'idle' } }
}

// ============================================================================
// Helper functions for special commands
// ============================================================================

function executeRepeatFind(
  reverse: boolean,
  count: number,
  ctx: TransitionContext,
): void {
  const lastFind = ctx.getLastFind()
  if (!lastFind) return

  // Determine the effective find type based on reverse
  let findType = lastFind.type
  if (reverse) {
    // Flip the direction
    const flipMap: Record<FindType, FindType> = {
      f: 'F',
      F: 'f',
      t: 'T',
      T: 't',
    }
    findType = flipMap[findType]
  }

  const result = ctx.cursor.findCharacter(lastFind.char, findType, count)
  if (result !== null) {
    ctx.setOffset(result)
  }
}
