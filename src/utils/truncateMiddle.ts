/**
 * Middle-truncation utilities for oversized strings.
 *
 * Ported from official Claude Code 2.1.252 (OCC-112 Gap-112c / changelog
 * item 4): background task notifications carrying very large failure output
 * (e.g. git errors on a full disk) could push the conversation past the API
 * request size limit. The official queue caps task-notification string values
 * before enqueueing; the helpers below mirror the official truncator: keep
 * the first floor(cap/2) and last cap-floor(cap/2) characters, joined by a
 * "... [N characters truncated] ..." marker whose N folds in any nested
 * markers already present in the removed middle.
 */

/** Slack over the cap before truncation kicks in (official `f4t`). */
const TRUNCATION_SLACK = 1024

/** Char cap for task-notification values (official `dYn`). */
export const TASK_NOTIFICATION_CHAR_CAP = 100_000

const NESTED_MARKER_PATTERN =
  /\n\n\.\.\. \[(\d+) characters truncated\] \.\.\.\n\n/g

function truncationMarker(chars: number): string {
  return `\n\n... [${chars} characters truncated] ...\n\n`
}

/**
 * First `length` chars, never ending on a dangling high surrogate
 * (official `ce`).
 */
function sliceHead(value: string, length: number): string {
  if (length <= 0) return ''
  if (value.length <= length) return value
  const head = value.slice(0, length)
  const lastUnit = head.charCodeAt(length - 1)
  // 0xD800-0xDBFF: high surrogate — dropping it keeps the pair intact.
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? head.slice(0, -1) : head
}

/**
 * Last `length` chars, never starting on a dangling low surrogate
 * (official `kg`).
 */
function sliceTail(value: string, length: number): string {
  if (length <= 0) return ''
  if (value.length <= length) return value
  const tail = value.slice(-length)
  const firstUnit = tail.charCodeAt(0)
  // 0xDC00-0xDFFF: low surrogate — dropping it keeps the pair intact.
  return firstUnit >= 0xdc00 && firstUnit <= 0xdfff ? tail.slice(1) : tail
}

/**
 * Middle-truncate `value` to roughly `cap` characters (official `af` + `Cke`).
 * Values within `cap + slack` pass through untouched; otherwise the first
 * floor(cap/2) and last cap-floor(cap/2) characters survive and the marker
 * reports the total removed characters. Markers already present in the removed
 * middle are folded into that total (minus their own text length), so nested
 * truncations report honest cumulative counts.
 */
export function truncateMiddleWithMarker(value: string, cap: number): string {
  if (value.length <= cap + TRUNCATION_SLACK) {
    return value
  }
  const headLength = Math.floor(cap / 2)
  const tailLength = cap - headLength
  const head = sliceHead(value, headLength)
  const tail = sliceTail(value, tailLength)
  const removedMiddle = value.slice(headLength, value.length - tailLength)
  let removedChars = value.length - head.length - tail.length
  for (const match of removedMiddle.matchAll(NESTED_MARKER_PATTERN)) {
    const claimed = match[1]!.length <= 15 ? Number(match[1]) : Number.NaN
    if (Number.isSafeInteger(claimed) && claimed >= match[0].length) {
      removedChars += claimed - match[0].length
    }
  }
  return `${head}${truncationMarker(removedChars)}${tail}`
}
