/**
 * Vim Operator Functions
 *
 * Pure functions for executing vim operators (delete, change, yank, etc.)
 */

import { Cursor } from '../utils/Cursor.js'
import { firstGrapheme, lastGrapheme } from '../utils/intl.js'
import { countCharInString } from '../utils/stringUtils.js'
import {
  isInclusiveMotion,
  isLinewiseMotion,
  resolveMotion,
} from './motions.js'
import { findTextObject } from './textObjects.js'
import type {
  CaseOp,
  FindType,
  Operator,
  RecordedChange,
  TextObjScope,
} from './types.js'

/**
 * Context for operator execution.
 */
export type OperatorContext = {
  cursor: Cursor
  text: string
  setText: (text: string) => void
  setOffset: (offset: number) => void
  enterInsert: (offset: number) => void
  getRegister: () => string
  setRegister: (content: string, linewise: boolean) => void
  getLastFind: () => { type: FindType; char: string } | null
  setLastFind: (type: FindType, char: string) => void
  recordChange: (change: RecordedChange) => void
}

/**
 * Execute an operator with a simple motion.
 *
 * CC 2.1.281 #081/#082 (binary `ht` @209867921):
 * - linewise motions (j/k/G/gg) now operate on WHOLE lines (fixes dj/dk
 *   deleting only the part of each line around the cursor).
 * - zero-width targets no longer silently no-op for `0`/`^` and for
 *   `cw`/`cW` at end of buffer: yank clears the register charwise, change
 *   enters INSERT at the cursor (fixes d0/c0/y0 and #082's cw-at-EOF bug).
 * - a zero-width operator range clears the register (change/yank) and, for
 *   change, enters INSERT.
 */
export function executeOperatorMotion(
  op: Operator,
  motion: string,
  count: number,
  ctx: OperatorContext,
): void {
  const target = resolveMotion(motion, ctx.cursor, count)

  // v281 `ht`: linewise-motion branch — whole lines from cursor to target.
  if (isLinewiseMotion(motion)) {
    const fromLine = getLineIndex(ctx.text, ctx.cursor.offset)
    const toLine = getLineIndex(ctx.text, target.offset)
    if (toLine !== fromLine) {
      const yankOffset = Math.min(ctx.cursor.offset, target.offset)
      applyLinewiseOperator(op, fromLine, toLine, ctx, yankOffset)
      recordUnlessYank(ctx, { type: 'operator', op, motion, count })
    }
    return
  }

  // v281 `ht`: zero-width branch — replaces the bare `target.equals` return.
  if (target.equals(ctx.cursor) && !isInclusiveMotion(motion)) {
    const isCwEnd =
      op === 'change' &&
      (motion === 'w' || motion === 'W') &&
      count > 0 &&
      ctx.cursor.isAtEnd()
    if (motion === '0' || motion === '^' || isCwEnd) {
      if (op === 'yank') {
        ctx.setRegister('', false)
      } else if (op === 'change') {
        ctx.enterInsert(ctx.cursor.offset)
      }
      recordUnlessYank(ctx, { type: 'operator', op, motion, count })
    }
    return
  }

  const range = getOperatorRange(ctx.cursor, target, motion, op, count)
  if (range.from === range.to) {
    if (op === 'change' || op === 'yank') {
      ctx.setRegister('', false)
    }
    if (op === 'change') {
      ctx.enterInsert(range.from)
      recordUnlessYank(ctx, { type: 'operator', op, motion, count })
    }
    return
  }

  applyOperator(op, range.from, range.to, ctx, range.linewise)
  recordUnlessYank(ctx, { type: 'operator', op, motion, count })
}

/**
 * Execute an operator with a find motion.
 */
export function executeOperatorFind(
  op: Operator,
  findType: FindType,
  char: string,
  count: number,
  ctx: OperatorContext,
): void {
  const targetOffset = ctx.cursor.findCharacter(char, findType, count)
  if (targetOffset === null) return

  const target = new Cursor(ctx.cursor.measuredText, targetOffset)
  const range = getOperatorRangeForFind(ctx.cursor, target, findType)

  applyOperator(op, range.from, range.to, ctx)
  ctx.setLastFind(findType, char)
  ctx.recordChange({ type: 'operatorFind', op, find: findType, char, count })
}

/**
 * Execute an operator with a text object.
 */
export function executeOperatorTextObj(
  op: Operator,
  scope: TextObjScope,
  objType: string,
  count: number,
  ctx: OperatorContext,
): void {
  const range = findTextObject(
    ctx.text,
    ctx.cursor.offset,
    objType,
    scope === 'inner',
  )
  if (!range) return

  applyOperator(op, range.start, range.end, ctx)
  ctx.recordChange({ type: 'operatorTextObj', op, objType, scope, count })
}

/**
 * Execute a line operation (dd, cc, yy, S, Y).
 *
 * CC 2.1.281 #081 piece 3 (binary `bt`): count-linewise — from the cursor's
 * line through `count - 1` lines below it, whole lines, via the shared
 * linewise operator. Replaces the v280-era char-offset line walk (which
 * mis-deleted when `count` exceeded the remaining lines or when the cursor
 * sat mid-line).
 */
export function executeLineOp(
  op: Operator,
  count: number,
  ctx: OperatorContext,
): void {
  if (count < 1) return
  const fromLine = getLineIndex(ctx.text, ctx.cursor.offset)
  applyLinewiseOperator(op, fromLine, fromLine + count - 1, ctx)
  recordUnlessYank(ctx, { type: 'operator', op, motion: op[0]!, count })
}

/**
 * Execute substitute char (s command). 2.1.211: `s` in NORMAL mode.
 * Deletes count chars at cursor (stopping at newline), then enters insert.
 * Binary: `fPo(e,t)` — delete chars, recordChange type "substitute", enterInsert.
 */
export function executeSubstitute(count: number, ctx: OperatorContext): void {
  const from = ctx.cursor.offset

  // Advance by graphemes, stopping at end-of-text or newline
  // Binary: `imp(e,t)` — `for(let n=0;n<t&&!r.isAtEnd();n++){if(text[r.offset]==="\n")break;r=r.right()}`
  let endCursor = ctx.cursor
  for (let i = 0; i < count && !endCursor.isAtEnd(); i++) {
    if (ctx.text[endCursor.offset] === '\n') break
    endCursor = endCursor.right()
  }
  const to = endCursor.offset

  if (to > from) {
    const deleted = ctx.text.slice(from, to)
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to)
    ctx.setRegister(deleted, false)
    ctx.setText(newText)
  }
  ctx.recordChange({ type: 'substitute', count })
  ctx.enterInsert(from)
}

/**
 * Execute delete character (x command).
 */
export function executeX(count: number, ctx: OperatorContext): void {
  const from = ctx.cursor.offset

  if (from >= ctx.text.length) return

  // Advance by graphemes, not code units
  let endCursor = ctx.cursor
  for (let i = 0; i < count && !endCursor.isAtEnd(); i++) {
    endCursor = endCursor.right()
  }
  const to = endCursor.offset

  const deleted = ctx.text.slice(from, to)
  const newText = ctx.text.slice(0, from) + ctx.text.slice(to)

  ctx.setRegister(deleted, false)
  ctx.setText(newText)
  const maxOff = Math.max(
    0,
    newText.length - (lastGrapheme(newText).length || 1),
  )
  ctx.setOffset(Math.min(from, maxOff))
  ctx.recordChange({ type: 'x', count })
}

/**
 * Execute replace character (r command).
 */
export function executeReplace(
  char: string,
  count: number,
  ctx: OperatorContext,
): void {
  let offset = ctx.cursor.offset
  let newText = ctx.text

  for (let i = 0; i < count && offset < newText.length; i++) {
    const graphemeLen = firstGrapheme(newText.slice(offset)).length || 1
    newText =
      newText.slice(0, offset) + char + newText.slice(offset + graphemeLen)
    offset += char.length
  }

  ctx.setText(newText)
  ctx.setOffset(Math.max(0, offset - char.length))
  ctx.recordChange({ type: 'replace', char, count })
}

/**
 * Execute toggle case (~ command).
 */
export function executeToggleCase(count: number, ctx: OperatorContext): void {
  const startOffset = ctx.cursor.offset

  if (startOffset >= ctx.text.length) return

  let newText = ctx.text
  let offset = startOffset
  let toggled = 0

  while (offset < newText.length && toggled < count) {
    const grapheme = firstGrapheme(newText.slice(offset))
    const graphemeLen = grapheme.length

    const toggledGrapheme =
      grapheme === grapheme.toUpperCase()
        ? grapheme.toLowerCase()
        : grapheme.toUpperCase()

    newText =
      newText.slice(0, offset) +
      toggledGrapheme +
      newText.slice(offset + graphemeLen)
    offset += toggledGrapheme.length
    toggled++
  }

  ctx.setText(newText)
  // Cursor moves to position after the last toggled character
  // At end of line, cursor can be at the "end" position
  ctx.setOffset(offset)
  ctx.recordChange({ type: 'toggleCase', count })
}

/**
 * Execute join lines (J command).
 */
export function executeJoin(count: number, ctx: OperatorContext): void {
  const text = ctx.text
  const lines = text.split('\n')
  const { line: currentLine } = ctx.cursor.getPosition()

  if (currentLine >= lines.length - 1) return

  const linesToJoin = Math.min(count, lines.length - currentLine - 1)
  let joinedLine = lines[currentLine]!
  const cursorPos = joinedLine.length

  for (let i = 1; i <= linesToJoin; i++) {
    const nextLine = (lines[currentLine + i] ?? '').trimStart()
    if (nextLine.length > 0) {
      if (!joinedLine.endsWith(' ') && joinedLine.length > 0) {
        joinedLine += ' '
      }
      joinedLine += nextLine
    }
  }

  const newLines = [
    ...lines.slice(0, currentLine),
    joinedLine,
    ...lines.slice(currentLine + linesToJoin + 1),
  ]

  const newText = newLines.join('\n')
  ctx.setText(newText)
  ctx.setOffset(getLineStartOffset(newLines, currentLine) + cursorPos)
  ctx.recordChange({ type: 'join', count })
}

/**
 * Execute paste (p/P command).
 */
export function executePaste(
  after: boolean,
  count: number,
  ctx: OperatorContext,
): void {
  const register = ctx.getRegister()
  if (!register) return

  const isLinewise = register.endsWith('\n')
  const content = isLinewise ? register.slice(0, -1) : register

  if (isLinewise) {
    const text = ctx.text
    const lines = text.split('\n')
    const { line: currentLine } = ctx.cursor.getPosition()

    const insertLine = after ? currentLine + 1 : currentLine
    const contentLines = content.split('\n')
    const repeatedLines: string[] = []
    for (let i = 0; i < count; i++) {
      repeatedLines.push(...contentLines)
    }

    const newLines = [
      ...lines.slice(0, insertLine),
      ...repeatedLines,
      ...lines.slice(insertLine),
    ]

    const newText = newLines.join('\n')
    ctx.setText(newText)
    ctx.setOffset(getLineStartOffset(newLines, insertLine))
  } else {
    const textToInsert = content.repeat(count)
    const insertPoint =
      after && ctx.cursor.offset < ctx.text.length
        ? ctx.cursor.measuredText.nextOffset(ctx.cursor.offset)
        : ctx.cursor.offset

    const newText =
      ctx.text.slice(0, insertPoint) +
      textToInsert +
      ctx.text.slice(insertPoint)
    const lastGr = lastGrapheme(textToInsert)
    const newOffset = insertPoint + textToInsert.length - (lastGr.length || 1)

    ctx.setText(newText)
    ctx.setOffset(Math.max(insertPoint, newOffset))
  }
  // CC 2.1.216 #6 (b): record paste for dot-repeat. Previously paste was
  // the only operator that never called recordChange, so `.` after p/P
  // did nothing.
  ctx.recordChange({ type: 'paste', after, count, linewise: isLinewise })
}

/**
 * Execute indent (>> command).
 */
export function executeIndent(
  dir: '>' | '<',
  count: number,
  ctx: OperatorContext,
): void {
  const text = ctx.text
  const lines = text.split('\n')
  const { line: currentLine } = ctx.cursor.getPosition()
  const linesToAffect = Math.min(count, lines.length - currentLine)
  const indent = '  ' // Two spaces

  for (let i = 0; i < linesToAffect; i++) {
    const lineIdx = currentLine + i
    const line = lines[lineIdx] ?? ''

    if (dir === '>') {
      lines[lineIdx] = indent + line
    } else if (line.startsWith(indent)) {
      lines[lineIdx] = line.slice(indent.length)
    } else if (line.startsWith('\t')) {
      lines[lineIdx] = line.slice(1)
    } else {
      // Remove as much leading whitespace as possible up to indent length
      let removed = 0
      let idx = 0
      while (
        idx < line.length &&
        removed < indent.length &&
        /\s/.test(line[idx]!)
      ) {
        removed++
        idx++
      }
      lines[lineIdx] = line.slice(idx)
    }
  }

  const newText = lines.join('\n')
  const currentLineText = lines[currentLine] ?? ''
  const firstNonBlank = (currentLineText.match(/^\s*/)?.[0] ?? '').length

  ctx.setText(newText)
  ctx.setOffset(getLineStartOffset(lines, currentLine) + firstNonBlank)
  ctx.recordChange({ type: 'indent', dir, count })
}

/**
 * Execute open line (o/O command).
 */
export function executeOpenLine(
  direction: 'above' | 'below',
  ctx: OperatorContext,
): void {
  const text = ctx.text
  const lines = text.split('\n')
  const { line: currentLine } = ctx.cursor.getPosition()

  const insertLine = direction === 'below' ? currentLine + 1 : currentLine
  const newLines = [
    ...lines.slice(0, insertLine),
    '',
    ...lines.slice(insertLine),
  ]

  const newText = newLines.join('\n')
  ctx.setText(newText)
  ctx.enterInsert(getLineStartOffset(newLines, insertLine))
  ctx.recordChange({ type: 'openLine', direction })
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Calculate the offset of a line's start position.
 */
function getLineStartOffset(lines: string[], lineIndex: number): number {
  return lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0)
}

/**
 * 0-based index of the logical line containing `offset`.
 * v281 binary `gt(text, offset)` — count of '\n' before the offset.
 */
function getLineIndex(text: string, offset: number): number {
  return countCharInString(text.slice(0, offset), '\n')
}

/**
 * Clamp a post-mutation offset the way v281 binary `Vee(text, offset)` does:
 * back off a trailing grapheme when the offset lands on a newline (mid-text)
 * or past the last grapheme at end-of-text.
 */
function clampOffset(text: string, offset: number): number {
  if (text[offset] === '\n' && offset > 0 && text[offset - 1] !== '\n') {
    return offset - (lastGrapheme(text.slice(0, offset)).length || 1)
  }
  if (offset >= text.length && !text.endsWith('\n')) {
    return Math.max(0, text.length - (lastGrapheme(text).length || 1))
  }
  return offset
}

/**
 * Offset of the first non-blank (not space/tab) char on `cursor`'s logical
 * line; for blank lines, the line end (or start when empty).
 * v281 binary `lo(cursor)`.
 */
function firstNonBlankOffsetInLine(cursor: Cursor): number {
  const start = cursor.startOfLogicalLine().offset
  const end = cursor.endOfLogicalLine().offset
  const idx = cursor.text.slice(start, end).search(/[^ \t]/)
  return cursor.measuredText.snapToGraphemeBoundary(
    idx === -1 ? Math.max(start, end - 1) : start + idx,
  )
}

/**
 * Record a change for dot-repeat unless it is a yank.
 * v281 binary `et(ctx, change)` — yanks are not replayable changes.
 */
function recordUnlessYank(ctx: OperatorContext, change: RecordedChange): void {
  if ('op' in change && change.op === 'yank') return
  ctx.recordChange(change)
}

/** v281 binary `VFe(ch)` — `/\s/.test(ch)`. */
function isWhitespaceChar(ch: string): boolean {
  return /\s/.test(ch)
}

/**
 * Apply an operator to WHOLE logical lines `[fromLine, toLine]` (either
 * order). Register always gets the affected lines each suffixed with '\n'
 * (linewise). yank keeps the text and restores the cursor near `yankOffset`
 * (default: start of the first affected line); delete removes the lines and
 * places the cursor at the first surviving line (or clamped end of text);
 * change replaces the lines with one empty line and enters INSERT there.
 *
 * v281 binary `dn(op, fromLine, toLine, ctx, yankOffset?)` — shared by the
 * linewise-motion branch (`ht`), the G/gg operators (`un`/`fn`), and
 * count-linewise ops (`bt`).
 */
function applyLinewiseOperator(
  op: Operator,
  fromLine: number,
  toLine: number,
  ctx: OperatorContext,
  yankOffset?: number,
): void {
  const lines = ctx.text.split('\n')
  const first = Math.min(fromLine, toLine)
  const endExclusive = Math.min(Math.max(fromLine, toLine) + 1, lines.length)
  const before = lines.slice(0, first)
  const after = lines.slice(endExclusive)
  const firstLineStart = getLineStartOffset(lines, first)
  const registerContent = lines
    .slice(first, endExclusive)
    .map((line) => line + '\n')
    .join('')
  ctx.setRegister(registerContent, true)

  if (op === 'yank') {
    const offset = clampOffset(ctx.text, yankOffset ?? firstLineStart)
    ctx.setOffset(ctx.cursor.snapOutOfPlaceholder(offset, 'start'))
  } else if (op === 'delete') {
    const newText = [...before, ...after].join('\n')
    ctx.setText(newText)
    ctx.setOffset(
      after.length > 0 ? firstLineStart : clampOffset(newText, newText.length),
    )
  } else if (op === 'change') {
    ctx.setText([...before, '', ...after].join('\n'))
    ctx.enterInsert(firstLineStart)
  }
}

/**
 * Compute the operator range for cursor→target.
 *
 * CC 2.1.281 #082 (binary `ks` @209871429 — rewritten vs v280 `Dn`):
 * - the linewise-motion branch moved to `executeOperatorMotion` (ht), so
 *   this function is charwise-only now (plus the cw linewise promotion).
 * - cw/cW starting on whitespace runs to end-of-line, capped at the next
 *   word, and promotes to linewise when only blanks precede the cursor.
 * - cw/cW with the cursor on a word's LAST letter before whitespace/EOL
 *   changes only that letter (the `wordEnd = wordCursor` correction — the
 *   #082 "cw eats the next word at end of line" fix).
 * - inclusive motions no longer extend past a newline at the range end.
 */
function getOperatorRange(
  cursor: Cursor,
  target: Cursor,
  motion: string,
  op: Operator,
  count: number,
): { from: number; to: number; linewise: boolean } {
  let from = Math.min(cursor.offset, target.offset)
  let to = Math.max(cursor.offset, target.offset)
  let linewise = false

  const isCw = op === 'change' && (motion === 'w' || motion === 'W')
  const charAtCursor = cursor.text[cursor.offset]
  // v281 `ks` F-gate: cursor sits on a space/tab/newline (outside a chip).
  const startsOnBlank =
    (charAtCursor === ' ' ||
      charAtCursor === '\t' ||
      charAtCursor === '\n') &&
    cursor.snapOutOfPlaceholder(cursor.offset, 'start') === cursor.offset

  if (isCw && startsOnBlank) {
    // v281: cw-on-blank behaves like c$ bounded by the count-th word's line.
    let wordCursor = cursor
    for (let i = 0; i < count - 1; i++) {
      const next =
        motion === 'w' ? wordCursor.nextVimWord() : wordCursor.nextWORD()
      if (next.offset === wordCursor.offset) break
      wordCursor = next
    }
    to = Math.min(to, wordCursor.endOfLogicalLine().offset)
    if (to > from && cursor.text[to - 1] === '\n') {
      to -= 1
      const lineStart = cursor.startOfLogicalLine().offset
      if (/^[ \t]*$/.test(cursor.text.slice(lineStart, from))) {
        from = lineStart
        linewise = true
      }
    }
  } else if (isCw) {
    // For cw with count, move forward (count-1) words, then find that end.
    let wordCursor = cursor
    for (let i = 0; i < count - 1; i++) {
      wordCursor =
        motion === 'w' ? wordCursor.nextVimWord() : wordCursor.nextWORD()
    }
    let wordEnd =
      motion === 'w' ? wordCursor.endOfVimWord() : wordCursor.endOfWORD()
    const afterWordCursor = cursor.measuredText.nextOffset(wordCursor.offset)
    const nextWord =
      motion === 'w' ? wordCursor.nextVimWord() : wordCursor.nextWORD()
    // v281 #082 Y=W correction: cursor on the last letter of a word that is
    // followed by whitespace/EOL/next-word-start → change just that letter.
    if (
      (afterWordCursor >= cursor.text.length ||
        isWhitespaceChar(cursor.text[afterWordCursor] ?? '') ||
        nextWord.offset === afterWordCursor) &&
      !isWhitespaceChar(cursor.text[cursor.offset] ?? '') &&
      !isWhitespaceChar(cursor.text[wordCursor.offset] ?? '')
    ) {
      wordEnd = wordCursor
    }
    to = cursor.measuredText.nextOffset(wordEnd.offset)
  } else if (
    isInclusiveMotion(motion) &&
    cursor.offset <= target.offset &&
    cursor.text[to] !== '\n'
  ) {
    to = cursor.measuredText.nextOffset(to)
  }

  // Word motions can land inside a placeholder chip ([Pasted text #N],
  // [Image #N], [Audio #N], [...Truncated text #N...]); extend the range to
  // cover the whole chip so dw/cw/yw never leave a partial placeholder.
  from = cursor.snapOutOfPlaceholder(from, 'start')
  to = cursor.snapOutOfPlaceholder(to, 'end')

  return { from, to, linewise }
}

/**
 * Get the range for a find-based operator.
 * Note: _findType is unused because Cursor.findCharacter already adjusts
 * the offset for t/T motions. All find types are treated as inclusive here.
 */
function getOperatorRangeForFind(
  cursor: Cursor,
  target: Cursor,
  _findType: FindType,
): { from: number; to: number } {
  const from = Math.min(cursor.offset, target.offset)
  const maxOffset = Math.max(cursor.offset, target.offset)
  const to = cursor.measuredText.nextOffset(maxOffset)
  return { from, to }
}

function applyOperator(
  op: Operator,
  from: number,
  to: number,
  ctx: OperatorContext,
  linewise: boolean = false,
): void {
  let content = ctx.text.slice(from, to)
  // Ensure linewise content ends with newline for paste detection
  if (linewise && !content.endsWith('\n')) {
    content = content + '\n'
  }
  ctx.setRegister(content, linewise)

  if (op === 'yank') {
    ctx.setOffset(from)
  } else if (op === 'delete') {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to)
    ctx.setText(newText)
    const maxOff = Math.max(
      0,
      newText.length - (lastGrapheme(newText).length || 1),
    )
    ctx.setOffset(Math.min(from, maxOff))
  } else if (op === 'change') {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to)
    ctx.setText(newText)
    ctx.enterInsert(from)
  }
}

/**
 * Execute `<op>G` (operator + G motion).
 *
 * CC 2.1.281 #081 piece 1 (binary `un` @209877832):
 * - `count === 0` is now the "no count typed" convention (call sites pass
 *   `countTyped ? count : 0`), fixing `1G` jumping to the last line.
 * - no `target.equals(cursor)` early return — `dG` on the last line still
 *   deletes that line.
 * - the span is LINEWISE (whole lines, cursor line → target line), fixing
 *   `dG` only deleting the part of the first/last line.
 */
export function executeOperatorG(
  op: Operator,
  count: number,
  ctx: OperatorContext,
): void {
  const target =
    count === 0 ? ctx.cursor.startOfLastLine() : ctx.cursor.goToLine(count)
  applyLinewiseOperator(
    op,
    getLineIndex(ctx.text, ctx.cursor.offset),
    getLineIndex(ctx.text, target.offset),
    ctx,
    Math.min(ctx.cursor.offset, firstNonBlankOffsetInLine(target)),
  )
  recordUnlessYank(ctx, { type: 'operator', op, motion: 'G', count })
}

/**
 * Execute `<op>gg` (operator + gg motion).
 *
 * CC 2.1.281 #081 piece 1 (binary `fn`): same linewise span as `un`, but
 * keeps the `count === 1` "no count typed" convention (gg defaults to the
 * first line).
 */
export function executeOperatorGg(
  op: Operator,
  count: number,
  ctx: OperatorContext,
): void {
  const target =
    count === 1 ? ctx.cursor.startOfFirstLine() : ctx.cursor.goToLine(count)
  applyLinewiseOperator(
    op,
    getLineIndex(ctx.text, ctx.cursor.offset),
    getLineIndex(ctx.text, target.offset),
    ctx,
    Math.min(ctx.cursor.offset, firstNonBlankOffsetInLine(target)),
  )
  recordUnlessYank(ctx, { type: 'operator', op, motion: 'gg', count })
}

// ============================================================================
// Visual Mode Operators
// ============================================================================

/**
 * Calculate the [from, to) offset range of a visual selection.
 *
 * char-wise: inclusive of the cursor char → [min(anchor,cursor), nextOffset(max)]
 * line-wise: full logical lines → [lineStart(min), lineEnd(max)]
 *
 * Matches the binary's Kcr(anchor, cursor, linewise).
 */
export function getVisualRange(
  anchor: number,
  cursor: Cursor,
  linewise: boolean,
): { from: number; to: number } {
  const from = Math.min(anchor, cursor.offset)
  const maxOff = Math.max(anchor, cursor.offset)
  if (!linewise) {
    return { from, to: cursor.measuredText.nextOffset(maxOff) }
  }
  const text = cursor.text
  // Start of the logical line containing 'from'
  let lineStart = from
  if (from > 0) {
    const idx = text.lastIndexOf('\n', from - 1)
    lineStart = idx === -1 ? 0 : idx + 1
  }
  // End of the logical line containing 'maxOff' (include the newline)
  const nextNl = text.indexOf('\n', maxOff)
  const lineEnd = nextNl === -1 ? text.length : nextNl + 1
  return { from: lineStart, to: lineEnd }
}

/**
 * Count graphemes (char-wise) or lines (line-wise) in the selected content.
 * Stored as the `span` field for dot-repeat replay.
 */
export function getVisualSpan(text: string, linewise: boolean): number {
  if (linewise) return countCharInString(text, '\n')
  let count = 0
  let pos = 0
  while (pos < text.length) {
    const g = firstGrapheme(text.slice(pos))
    pos += g.length || 1
    count++
  }
  return count
}

/**
 * Reconstruct a visual range from a stored span (for dot-repeat).
 * Starts at the current cursor and extends `span` graphemes (char-wise)
 * or `span` lines (line-wise).
 */
function getVisualRangeFromSpan(
  span: number,
  linewise: boolean,
  ctx: OperatorContext,
): { from: number; to: number } {
  const text = ctx.text
  if (linewise) {
    const lineStart = ctx.cursor.startOfLogicalLine().offset
    let end = lineStart
    for (let i = 0; i < span; i++) {
      const nl = text.indexOf('\n', end)
      if (nl === -1) {
        end = text.length
        break
      }
      end = nl + 1
    }
    return { from: lineStart, to: end }
  }
  const from = ctx.cursor.offset
  let to = from
  for (let i = 0; i < span && to < text.length; i++) {
    to = ctx.cursor.measuredText.nextOffset(to)
  }
  return { from, to }
}

/**
 * Apply an operator (delete/change/yank) over a visual selection.
 *
 * Linewise delete/change are handled specially (matching the binary's gKl);
 * char-wise and linewise-yank fall through to the regular applyOperator.
 */
export function executeVisualOperator(
  op: Operator,
  anchor: number,
  ctx: OperatorContext,
  linewise: boolean,
): void {
  const range = getVisualRange(anchor, ctx.cursor, linewise)
  const content = ctx.text.slice(range.from, range.to)
  const span = getVisualSpan(content, linewise)

  // Linewise change: delete full lines, leave one empty line, enter insert
  if (linewise && op === 'change') {
    let yanked = content
    if (!yanked.endsWith('\n')) yanked += '\n'
    ctx.setRegister(yanked, true)
    const before = ctx.text.slice(0, range.from)
    const after = ctx.text.slice(range.to)
    const hasAfter = after !== ''
    ctx.setText(before + (hasAfter ? '\n' : '') + after)
    ctx.enterInsert(range.from)
    ctx.recordChange({ type: 'visualChange', span, linewise, text: '' })
    return
  }

  // Linewise delete: delete full lines, adjusting for trailing newline
  if (linewise && op === 'delete') {
    let yanked = content
    if (!yanked.endsWith('\n')) yanked += '\n'
    ctx.setRegister(yanked, true)
    let start = range.from
    if (
      range.to === ctx.text.length &&
      range.from > 0 &&
      ctx.text[range.from - 1] === '\n'
    ) {
      start -= 1
    }
    const newText = ctx.text.slice(0, start) + ctx.text.slice(range.to)
    ctx.setText(newText)
    const maxOff = Math.max(
      0,
      newText.length - (lastGrapheme(newText).length || 1),
    )
    ctx.setOffset(Math.min(start, maxOff))
    ctx.recordChange({ type: 'visualOp', op, span, linewise })
    return
  }

  // char-wise (all ops) + linewise yank → reuse applyOperator
  applyOperator(op, range.from, range.to, ctx, linewise)
  if (op !== 'yank') {
    ctx.recordChange({ type: 'visualOp', op, span, linewise })
  }
}

/**
 * Replace every character in the visual selection with `char`.
 */
export function executeVisualReplace(
  char: string,
  anchor: number,
  ctx: OperatorContext,
  linewise: boolean,
): void {
  const range = getVisualRange(anchor, ctx.cursor, linewise)
  if (range.from >= range.to) return
  const content = ctx.text.slice(range.from, range.to)
  const span = getVisualSpan(content, linewise)

  // Count graphemes in the selection to repeat the replacement char
  let count = getVisualSpan(content, false)
  const replacement = char.repeat(count)

  const newText =
    ctx.text.slice(0, range.from) + replacement + ctx.text.slice(range.to)
  ctx.setText(newText)
  ctx.setOffset(range.from)
  ctx.recordChange({ type: 'visualReplace', char, span, linewise })
}

/**
 * Toggle / lowercase / uppercase every character in the visual selection.
 */
export function executeVisualCase(
  op: CaseOp,
  anchor: number,
  ctx: OperatorContext,
  linewise: boolean,
): void {
  const range = getVisualRange(anchor, ctx.cursor, linewise)
  if (range.from >= range.to) return
  const content = ctx.text.slice(range.from, range.to)
  const span = getVisualSpan(content, linewise)

  let transformed = ''
  let pos = 0
  while (pos < content.length) {
    const g = firstGrapheme(content.slice(pos))
    pos += g.length || 1
    if (op === 'toggle') {
      transformed += g === g.toUpperCase() ? g.toLowerCase() : g.toUpperCase()
    } else if (op === 'lower') {
      transformed += g.toLowerCase()
    } else {
      transformed += g.toUpperCase()
    }
  }

  const newText =
    ctx.text.slice(0, range.from) + transformed + ctx.text.slice(range.to)
  ctx.setText(newText)
  ctx.setOffset(range.from)
  ctx.recordChange({ type: 'visualCase', op, span, linewise })
}

// ============================================================================
// Visual Dot-Repeat Replays
// ============================================================================

/**
 * Replay a visual operator (delete/yank) for dot-repeat.
 */
export function replayVisualOp(
  op: Operator,
  span: number,
  linewise: boolean,
  ctx: OperatorContext,
): void {
  const range = getVisualRangeFromSpan(span, linewise, ctx)
  if (range.from === range.to) return
  applyOperator(op, range.from, range.to, ctx, linewise)
}

/**
 * Replay a visual change for dot-repeat: re-select the same span, delete it,
 * and insert the previously-typed text.
 *
 * TODO(#081/#082 piece 4 — STAGED per triage-D.md): v281 wraps the replay
 * context in `ae()` (@209889188, dispatched @209890886) which additionally
 * guards `!`-filter/shell-mode dot-repeat. Deliberately NOT ported this round.
 */
export function replayVisualChange(
  span: number,
  linewise: boolean,
  text: string,
  ctx: OperatorContext,
): void {
  const range = getVisualRangeFromSpan(span, linewise, ctx)
  if (range.from === range.to && !text) return
  const content = ctx.text.slice(range.from, range.to)
  let yanked = content
  if (text && !yanked.endsWith('\n')) yanked += '\n'
  ctx.setRegister(yanked, !!text)
  const after = ctx.text.slice(range.to)
  const newAfter = text && after !== '' ? '\n' + after : after
  const newText = ctx.text.slice(0, range.from) + text + newAfter
  ctx.setText(newText)
  const lastGr = lastGrapheme(text)
  ctx.setOffset(
    Math.max(range.from, range.from + text.length - (lastGr.length || 1)),
  )
}

/**
 * CC 2.1.216 #6 (b): Replay a `c`-operator change for dot-repeat.
 * Re-resolves the motion to get the range, yanks the old content into the
 * register, deletes the range, and inserts the previously-typed text —
 * without entering INSERT mode (unlike the original `applyOperator` call).
 *
 * CC 2.1.281: linewise motions (j/k/G/gg) now replay through the whole-line
 * path — mirroring v281's `ht` linewise branch → `dn(change)` with the `ae()`
 * enterInsert wrapper (which splices the recorded text at the insert offset).
 */
export function replayOperatorChange(
  motion: string,
  count: number,
  text: string,
  ctx: OperatorContext,
): void {
  const target = resolveReplayTarget(motion, count, ctx.cursor)

  if (isLinewiseMotion(motion)) {
    const fromLine = getLineIndex(ctx.text, ctx.cursor.offset)
    const toLine = getLineIndex(ctx.text, target.offset)
    if (fromLine === toLine && !text) return
    const insertCtx = wrapEnterInsertWithText(ctx, text)
    applyLinewiseOperator('change', fromLine, toLine, insertCtx)
    return
  }

  if (target.equals(ctx.cursor) && !text) return
  const range = getOperatorRange(ctx.cursor, target, motion, 'change', count)
  const content = ctx.text.slice(range.from, range.to)
  ctx.setRegister(content, range.linewise)
  const newText = ctx.text.slice(0, range.from) + text + ctx.text.slice(range.to)
  ctx.setText(newText)
  const lastGr = lastGrapheme(text)
  ctx.setOffset(
    Math.max(range.from, range.from + text.length - (lastGr.length || 1)),
  )
}

/**
 * Resolve a motion target for dot-repeat. `G`/`gg` use the operator count
 * conventions (v281 `un`: `count === 0` means "no count typed"; `fn`:
 * `count === 1`) — `resolveMotion('G')` would ignore the count and always
 * jump to the last line.
 */
function resolveReplayTarget(
  motion: string,
  count: number,
  cursor: Cursor,
): Cursor {
  if (motion === 'G') {
    return count === 0 ? cursor.startOfLastLine() : cursor.goToLine(count)
  }
  if (motion === 'gg') {
    return count === 1 ? cursor.startOfFirstLine() : cursor.goToLine(count)
  }
  return resolveMotion(motion, cursor, count)
}

/**
 * Return a copy of `ctx` whose `enterInsert(offset)` splices `text` in at
 * `offset` instead of switching modes — the OCC adaptation of v281's `ae()`
 * dot-replay context wrapper. `setText` is intercepted so the splice sees
 * the post-delete text even when the underlying context snapshots it.
 */
function wrapEnterInsertWithText(
  ctx: OperatorContext,
  text: string,
): OperatorContext {
  let currentText = ctx.text
  return {
    ...ctx,
    setText: (next: string) => {
      currentText = next
      ctx.setText(next)
    },
    enterInsert: (offset: number) => {
      const newText =
        currentText.slice(0, offset) + text + currentText.slice(offset)
      ctx.setText(newText)
      const lastGr = lastGrapheme(text)
      ctx.setOffset(
        text
          ? Math.max(offset, offset + text.length - (lastGr.length || 1))
          : offset,
      )
    },
  }
}

/**
 * Replay a visual replace for dot-repeat.
 */
export function replayVisualReplace(
  char: string,
  span: number,
  linewise: boolean,
  ctx: OperatorContext,
): void {
  const range = getVisualRangeFromSpan(span, linewise, ctx)
  if (range.from === range.to) return
  const content = ctx.text.slice(range.from, range.to)
  const count = getVisualSpan(content, false)
  const replacement = char.repeat(count)
  const newText =
    ctx.text.slice(0, range.from) + replacement + ctx.text.slice(range.to)
  ctx.setText(newText)
  ctx.setOffset(range.from)
}

/**
 * Replay a visual case operation for dot-repeat.
 */
export function replayVisualCase(
  op: CaseOp,
  span: number,
  linewise: boolean,
  ctx: OperatorContext,
): void {
  const range = getVisualRangeFromSpan(span, linewise, ctx)
  if (range.from === range.to) return
  const content = ctx.text.slice(range.from, range.to)
  let transformed = ''
  let pos = 0
  while (pos < content.length) {
    const g = firstGrapheme(content.slice(pos))
    pos += g.length || 1
    if (op === 'toggle') {
      transformed += g === g.toUpperCase() ? g.toLowerCase() : g.toUpperCase()
    } else if (op === 'lower') {
      transformed += g.toLowerCase()
    } else {
      transformed += g.toUpperCase()
    }
  }
  const newText =
    ctx.text.slice(0, range.from) + transformed + ctx.text.slice(range.to)
  ctx.setText(newText)
  ctx.setOffset(range.from)
}

/**
 * Paste the register over the visual selection (replaces the selection).
 */
export function executeVisualPaste(
  anchor: number,
  ctx: OperatorContext,
  linewise: boolean,
): void {
  const register = ctx.getRegister()
  if (!register) return
  const range = getVisualRange(anchor, ctx.cursor, linewise)
  const regLinewise = register.endsWith('\n')
  const content = regLinewise ? register.slice(0, -1) : register

  if (regLinewise) {
    // Line-wise paste: replace selection lines with register lines
    const newText =
      ctx.text.slice(0, range.from) + content + '\n' + ctx.text.slice(range.to)
    ctx.setText(newText)
    ctx.setOffset(range.from)
  } else {
    // Char-wise paste: replace selection characters
    const newText =
      ctx.text.slice(0, range.from) + content + ctx.text.slice(range.to)
    ctx.setText(newText)
    const lastGr = lastGrapheme(content)
    ctx.setOffset(
      Math.max(range.from, range.from + content.length - (lastGr.length || 1)),
    )
  }
}

/**
 * Join all lines within the visual selection.
 */
export function executeVisualJoin(
  anchor: number,
  ctx: OperatorContext,
): void {
  const range = getVisualRange(anchor, ctx.cursor, false)
  const section = ctx.text.slice(range.from, range.to)
  const joined = section.split('\n').map((l) => l.trimStart()).join(' ')
  const newText =
    ctx.text.slice(0, range.from) + joined + ctx.text.slice(range.to)
  ctx.setText(newText)
  ctx.setOffset(range.from)
}

/**
 * Indent (> or <) all lines within the visual selection.
 */
export function executeVisualIndent(
  dir: '>' | '<',
  anchor: number,
  ctx: OperatorContext,
): void {
  const range = getVisualRange(anchor, ctx.cursor, true)
  const text = ctx.text
  const lines = text.split('\n')
  // Calculate which lines are in the range
  let lineStart = 0
  let startLine = 0
  for (let i = 0; i < lines.length; i++) {
    if (lineStart === range.from) {
      startLine = i
      break
    }
    if (lineStart > range.from) {
      startLine = i
      break
    }
    startLine = i
    lineStart += lines[i].length + 1
  }
  let endLine = startLine
  let pos = range.from
  for (let i = startLine; i < lines.length; i++) {
    pos += lines[i].length
    if (pos >= range.to - 1) {
      endLine = i
      break
    }
    pos += 1 // newline
    endLine = i
  }
  const indent = '  '
  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i] ?? ''
    if (dir === '>') {
      lines[i] = indent + line
    } else if (line.startsWith(indent)) {
      lines[i] = line.slice(indent.length)
    } else if (line.startsWith('\t')) {
      lines[i] = line.slice(1)
    }
  }
  const newText = lines.join('\n')
  ctx.setText(newText)
  const firstLineText = lines[startLine] ?? ''
  const firstNonBlank = (firstLineText.match(/^\s*/)?.[0] ?? '').length
  ctx.setOffset(range.from + firstNonBlank)
}
