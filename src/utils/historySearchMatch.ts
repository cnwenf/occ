import { expandPastedTextRefs, parseReferences } from '../history.js'
import type { PastedContent } from './config.js'
import { truncateText } from './textTruncate.js'

/**
 * CC 2.1.314 item 70: Ctrl+R history search matches text inside collapsed
 * `[Pasted text]` pills.
 *
 * Ported from the official v314 inline-search helpers (byte-verified):
 *   - `Ix=32768` — per-paste truncation cap applied before expansion (`uKo`).
 *   - `ne(t,n)` — truncate to n, drop a trailing lone high surrogate, then
 *     sanitize lone surrogates via a utf16le Buffer round-trip (`hQt`).
 *   - `uKo(e,n)` — rewrite text pastes to their truncated copy, then expand
 *     pills (`Rfe` = expandPastedTextRefs).
 *   - `M1e(h,x,D)` — cursor: last lowercase match in the value, else the index
 *     of the last pill whose text content contains the query, else end of
 *     value.
 */

export const SEARCH_PASTE_CONTENT_MAX = 32768

/**
 * Official `ne(t,n)` — truncate for search without splitting a surrogate pair
 * at the cut point, then sanitize lone surrogates via hQt's utf16le Buffer
 * round-trip. Shared implementation lives in `textTruncate.ts` (also used by
 * the 2.1.314 item 78 title-description truncation).
 */
export function truncateForSearch(content: string, max: number): string {
  return truncateText(content, max)
}

/**
 * Official `uKo(e,n)`: expand `[Pasted text #N]` pills in `display` after
 * capping each text paste at SEARCH_PASTE_CONTENT_MAX chars. Image pastes
 * are passed through untouched (expandPastedTextRefs skips non-text refs).
 */
export function expandPillsForSearch(
  display: string,
  pastedContents: Record<number, PastedContent>,
): string {
  const truncated: Record<number, PastedContent> = {}
  for (const [id, content] of Object.entries(pastedContents)) {
    truncated[Number(id)] =
      content.type === 'text'
        ? {
            ...content,
            content: truncateForSearch(content.content, SEARCH_PASTE_CONTENT_MAX),
          }
        : content
  }
  return expandPastedTextRefs(display, truncated)
}

/**
 * Official v314 inline-search predicate:
 * `Ho.toLowerCase().includes(yn)||uKo(Ho,Co).toLowerCase().includes(yn)`.
 * The official lowercases the query once outside the loop (`yn=We.toLowerCase()`);
 * lowercasing here instead is result-identical and keeps callers safe.
 */
export function historyEntryMatchesQuery(
  display: string,
  pastedContents: Record<number, PastedContent>,
  query: string,
): boolean {
  const q = query.toLowerCase()
  return (
    display.toLowerCase().includes(q) ||
    expandPillsForSearch(display, pastedContents).toLowerCase().includes(q)
  )
}

/**
 * Official `M1e(h,x,D)` cursor placement. `value` is the mode-prefix-stripped
 * display (kI ≈ getValueFromInput); the query is lowercased internally (the
 * official receives it pre-lowercased — identical results).
 * The `!Ce.unavailable` guard from the official is implicit here: OCC's
 * resolved HistoryEntry records only contain pastes with available content
 * (unresolvable ones are dropped in logEntryToHistoryEntry).
 */
export function findSearchCursorPosition(
  value: string,
  pastedContents: Record<number, PastedContent>,
  query: string,
): number {
  const q = query.toLowerCase()
  const direct = value.toLowerCase().lastIndexOf(q)
  if (direct !== -1) return direct
  const pill = parseReferences(value).findLast(ref => {
    const content = pastedContents[ref.id]
    return (
      content?.type === 'text' && content.content.toLowerCase().includes(q)
    )
  })
  return pill ? pill.index : value.length
}
