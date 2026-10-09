/**
 * CC 2.1.295 NFC-aware text insertion (official `insertText` @236618722 +
 * `jF` NFC-splice @236615963).
 *
 * Official behavior: the WHOLE value is NFC-normalized around the insertion
 * (`Z=L.normalize("NFC")`), the splice point is recomputed against the
 * normalized value (`he=H<L.length?H:Z.length`), and the insert is a
 * three-way NFC splice `jF(prefix, inserted, suffix)`. When NFC composition
 * changes the length (e.g. macOS NFD `é` pasted after a prefix so the
 * combining mark composes across the seam), the cursor `end` is advanced to
 * the end of any grapheme cluster that straddles the naive boundary — unless
 * the straddling range covers a placeholder-chip start (official `VIt`/`gNo`
 * guard), in which case the chip stays atomic.
 *
 * Without this, pasting NFD text mid-prompt lands the cursor one char too
 * far: the caller concatenates raw UTF-16 (`cursorOffset + text.length`),
 * then downstream NFC normalization shrinks the string under the cursor.
 */

import { getGraphemeSegmenter } from './intl.js'

/**
 * Placeholder-chip pattern — same source of truth as `Cursor.ts`
 * PLACEHOLDER_PATTERN (2.1.239 family; kept local because Cursor.ts does not
 * export it). Official v295 `ot` (@225530473) lists a partially different
 * chip set (`✦ Team setup guide` / `⧉ …` instead of `Audio`) — that
 * divergence is pre-existing in Cursor.ts and out of scope here; this guard
 * mirrors OCC's chip set so it stays coherent with snapOutOfPlaceholder.
 */
const PLACEHOLDER_PATTERN = String.raw`\[(?:Pasted text|Image|Audio|\.\.\.Truncated text) #\d+(?: \+\d+ lines)?\.*\]`
const PLACEHOLDER_START_RE = new RegExp(`^${PLACEHOLDER_PATTERN}`)

/** Official `gNo` (@225530473): `e[r]==="["&&$t.test(e.slice(r))`. */
function isPlaceholderStart(text: string, index: number): boolean {
  return text[index] === '[' && PLACEHOLDER_START_RE.test(text.slice(index))
}

/** Official `VIt` (@236615963 region): any placeholder start in [from, to). */
function spansPlaceholderStart(
  text: string,
  from: number,
  to: number,
): boolean {
  for (let i = from; i < to; i++) {
    if (isPlaceholderStart(text, i)) return true
  }
  return false
}

/**
 * Official `jF` (@236615963), byte-faithful:
 *
 *   H=A.normalize("NFC"); Z=(h+A).normalize("NFC"); he=(Z+L).normalize("NFC");
 *   Se=Z.length;
 *   if(Se!==h.length+H.length)
 *     for(let{index:Me,segment:De}of na().segment(he)){
 *       if(Me>=Se)break;
 *       let Oe=Me+De.length;
 *       if(Oe>Se&&!VIt(he,Se,Oe))Se=Oe}
 *   return{written:he,end:Se}
 */
export function nfcSplice(
  prefix: string,
  inserted: string,
  suffix: string,
): { written: string; end: number } {
  const normalizedInserted = inserted.normalize('NFC')
  const head = (prefix + inserted).normalize('NFC')
  const written = (head + suffix).normalize('NFC')
  let end = head.length
  if (end !== prefix.length + normalizedInserted.length) {
    for (const { index, segment } of getGraphemeSegmenter().segment(written)) {
      if (index >= end) break
      const segmentEnd = index + segment.length
      if (segmentEnd > end && !spansPlaceholderStart(written, end, segmentEnd)) {
        end = segmentEnd
      }
    }
  }
  return { written, end }
}

/**
 * Official `insertText` (@236618722), pure-function shape:
 *
 *   if(h==="")return #w(L,H),H;
 *   let Z=L.normalize("NFC"),he=H<L.length?H:Z.length,
 *       {written:Se,end:Me}=jF(Z.slice(0,he),h,Z.slice(he));
 *   return #w(Se,Me),he
 *
 * The new state is `(written, end)` — official sets the cursor to the splice
 * `end` (`Me`), not the returned `he`.
 */
export function nfcInsert(
  value: string,
  cursorOffset: number,
  inserted: string,
): { written: string; end: number } {
  if (inserted === '') {
    return { written: value, end: cursorOffset }
  }
  const normalized = value.normalize('NFC')
  const splitAt = cursorOffset < value.length ? cursorOffset : normalized.length
  return nfcSplice(
    normalized.slice(0, splitAt),
    inserted,
    normalized.slice(splitAt),
  )
}
