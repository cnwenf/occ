/**
 * Official `ne(t,n)` @243461xxx (v314): truncate a string to `max` chars
 * without splitting a surrogate pair at the cut point, then sanitize any
 * remaining lone surrogates via the official `hQt` @243462231 utf16le Buffer
 * round-trip (`Buffer.from(t,"utf16le").toString("utf16le")` replaces lone
 * surrogates with U+FFFD).
 *
 * Shared by the 2.1.314 item 70 history-search paste truncation
 * (`Ix=32768` cap) and the item 78 session-title description truncation
 * (`y=200` cap).
 */
export function truncateText(content: string, max: number): string {
  if (max <= 0) return ''
  if (content.length <= max) return content
  const sliced = content.slice(0, max)
  const lastCode = sliced.charCodeAt(max - 1)
  const withoutSplitPair =
    lastCode >= 0xd800 && lastCode <= 0xdbff ? sliced.slice(0, -1) : sliced
  return Buffer.from(withoutSplitPair, 'utf16le').toString('utf16le')
}

/**
 * Official `Ze(t,n)` @243463911 + `pr(t)` @243464345: the first line of a
 * string (everything before the first "\n"; the whole string when there is
 * none).
 */
export function firstLine(text: string): string {
  const index = text.indexOf('\n')
  return index === -1 ? text : text.slice(0, index)
}
