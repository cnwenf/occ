/**
 * Vim Motion Functions
 *
 * Pure functions for resolving vim motions to cursor positions.
 */

import { Cursor } from '../utils/Cursor.js'
import { findTextObject } from './textObjects.js'

/**
 * CC 2.1.301 (occ160 WP-D): official `mt`/`Nt`/`y5o` pill-blanking
 * (@236281883, byte-verbatim):
 *   mt="(?:\\[(?:Pasted text|Image|\\.\\.\\.Truncated text|✦ Team setup
 *       guide) #\\d+(?: \\+\\d+ lines)?\\.*\\]|\\[⧉ [^\\]\\n]+\\])"
 *   function y5o(e){return e.replace(Nt,(r)=>" ".repeat(r.length))}
 * Placeholder chips are length-preservingly replaced with spaces before the
 * `%` bracket scan so brackets inside chips are not matched. DIVERGENCE:
 * OCC's chip family is `src/utils/Cursor.ts` PLACEHOLDER_PATTERN (2.1.239,
 * includes Audio; no "✦ Team setup guide"/"⧉" chips — those surfaces do not
 * exist in OCC). Cursor.ts does not export its pattern and is out of the
 * WP-D cluster, so the pattern is duplicated here.
 */
const VIM_PLACEHOLDER_PATTERN = String.raw`\[(?:Pasted text|Image|Audio|\.\.\.Truncated text) #\d+(?: \+\d+ lines)?\.*\]`
const VIM_PLACEHOLDER_GLOBAL_RE = new RegExp(VIM_PLACEHOLDER_PATTERN, 'g')

function blankPlaceholderChips(text: string): string {
  return text.replace(
    VIM_PLACEHOLDER_GLOBAL_RE,
    match => ' '.repeat(match.length),
  )
}

/**
 * CC 2.1.301 (occ160 WP-D): official `fn` findMatchingBracket (@236317723
 * region, byte-verbatim):
 *   function fn(t,e){let r=t.indexOf("\n",e),n=r===-1?t.length:r,
 *     s=t.slice(e,n).search(/[()[\]{}]/);if(s===-1)return null;
 *     let o=e+s,i=ne(t,o,t[o],!1);if(!i)return null;
 *     return i.start===o?i.end-1:i.start}
 * Scans the logical line from the cursor for the first bracket char; if the
 * bracket opens a pair, jumps to its closer (`end-1`, the around-range end
 * is exclusive); if it closes a pair, jumps to its opener (`start`). `ne` is
 * OCC's findTextObject (textObjects.ts findBracketObject is the port of the
 * official backward-then-forward depth scan). No bracket on the line or no
 * matching pair → null → no movement.
 */
function findMatchingBracket(text: string, offset: number): number | null {
  const newlineIdx = text.indexOf('\n', offset)
  const lineEnd = newlineIdx === -1 ? text.length : newlineIdx
  const found = text.slice(offset, lineEnd).search(/[()[\]{}]/)
  if (found === -1) return null
  const bracketOffset = offset + found
  const range = findTextObject(
    text,
    bracketOffset,
    text[bracketOffset] as string,
    false,
  )
  if (!range) return null
  return range.start === bracketOffset ? range.end - 1 : range.start
}

/**
 * Resolve a motion to a target cursor position.
 * Does not modify anything - pure calculation.
 */
export function resolveMotion(
  key: string,
  cursor: Cursor,
  count: number,
): Cursor {
  // CC 2.1.301 (occ160 WP-D): official `z` resolveMotion (@236316959,
  // byte-verbatim): `if(t==="%"&&r!==1)return e` — a count makes `%` a
  // complete no-op (matching bracket is not a repeatable motion).
  if (key === '%' && count !== 1) return cursor
  let result = cursor
  for (let i = 0; i < count; i++) {
    const next = applySingleMotion(key, result)
    if (next.equals(result)) break
    result = next
  }
  return result
}

/**
 * Apply a single motion step.
 */
function applySingleMotion(key: string, cursor: Cursor): Cursor {
  switch (key) {
    case 'h':
      return cursor.left()
    case 'l':
      return cursor.right()
    case 'j':
      return cursor.downLogicalLine()
    case 'k':
      return cursor.upLogicalLine()
    case 'gj':
      return cursor.down()
    case 'gk':
      return cursor.up()
    case 'w':
      return cursor.nextVimWord()
    case 'b':
      return cursor.prevVimWord()
    case 'e':
      return cursor.endOfVimWord()
    case 'W':
      return cursor.nextWORD()
    case 'B':
      return cursor.prevWORD()
    case 'E':
      return cursor.endOfWORD()
    case '0':
      return cursor.startOfLogicalLine()
    case '^':
      return cursor.firstNonBlankInLogicalLine()
    case '$':
      return cursor.endOfLogicalLine()
    case 'G':
      return cursor.startOfLastLine()
    case ' ':
      // 2.1.128: Space in NORMAL mode moves cursor right, matching vi/vim.
      return cursor.right()
    // CC 2.1.301 (occ160 WP-D): official `ln` applySingleMotion (@236317723,
    // byte-verbatim):
    //   case"%":{let r=fn(y5o(e.text),e.offset);
    //            return r===null?e:new di(e.measuredText,r)}
    // No match → the SAME cursor (no movement); match → new cursor at the
    // partner bracket. The scan runs on pill-blanked text (y5o) but offsets
    // carry over 1:1 because blanking is length-preserving.
    case '%': {
      const target = findMatchingBracket(
        blankPlaceholderChips(cursor.text),
        cursor.offset,
      )
      return target === null ? cursor : new Cursor(cursor.measuredText, target)
    }
    default:
      return cursor
  }
}

/**
 * Check if a motion is inclusive (includes character at destination).
 */
export function isInclusiveMotion(key: string): boolean {
  // CC 2.1.301 (occ160 WP-D): official `He` (@236317800 region,
  // byte-verbatim): `function He(t){return"eE$%".includes(t)}` — "%" joins
  // the inclusive set so `d%`/`y%` delete/yank through the partner bracket.
  return 'eE$%'.includes(key)
}

/**
 * Check if a motion is linewise (operates on full lines when used with operators).
 * Note: gj/gk are characterwise exclusive per `:help gj`, not linewise.
 */
export function isLinewiseMotion(key: string): boolean {
  return 'jkG'.includes(key) || key === 'gg'
}
