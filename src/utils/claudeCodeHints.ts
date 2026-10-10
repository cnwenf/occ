/**
 * Claude Code hints protocol.
 *
 * CLIs and SDKs running under Claude Code can emit a self-closing
 * `<claude-code-hint />` tag to stderr (merged into stdout by the shell
 * tools). The harness scans tool output for these tags, strips them before
 * the output reaches the model, and surfaces an install prompt to the
 * user — no inference, no proactive execution.
 *
 * This file provides both the parser and a small module-level store for
 * the pending hint. The store is a single slot (not a queue) — we surface
 * at most one prompt per session, so there's no reason to accumulate.
 * React subscribes via useSyncExternalStore.
 *
 * 2.1.296 alignment: extraction is now a line-walking scanner (official
 * `Oct`/`v1n`), not a multiline regex. A tag is only recognized when it
 * occupies its whole line (modulo leading/trailing spaces/tabs and the
 * U+2028/U+2029 line separators); tags spanning newlines or embedded in a
 * larger line of log text are left alone. Lines longer than 1024 chars
 * never count as hints but ARE still stripped from model-visible output.
 * This file also exports `stripHintTagLines` (official `lL`) — the sanitizer
 * applied to hook stdout/stderr/output so hint tags can't ride through the
 * hook side channel.
 *
 * See docs/claude-code-hints.md for the vendor-facing spec.
 */

import { logForDebugging } from './debug.js'
import { createSignal } from './signal.js'

export type ClaudeCodeHintType = 'plugin'

export type ClaudeCodeHint = {
  /** Spec version declared by the emitter. Unknown versions are dropped. */
  v: number
  /** Hint discriminator. v1 defines only `plugin`. */
  type: ClaudeCodeHintType
  /**
   * Hint payload. For `type: 'plugin'`: a `name@marketplace` slug
   * matching the form accepted by `parsePluginIdentifier`.
   */
  value: string
  /**
   * First token of the shell command that produced this hint. Shown in the
   * install prompt so the user can spot a mismatch between the tool that
   * emitted the hint and the plugin it recommends.
   */
  sourceCommand: string
}

/** Spec versions this harness understands. Official `h1n`. */
const SUPPORTED_VERSIONS = new Set([1])

/** Hint types this harness understands at the supported versions. Official `_1n`. */
const SUPPORTED_TYPES = new Set<string>(['plugin'])

/** Official `Zw` — the tag-open sequence every scan keys off of. */
const HINT_TAG_OPEN = '<claude-code-hint'

/** Official `Pct` — max chars for one candidate hint-tag line/match. */
const HINT_LINE_MAX_CHARS = 1024

/**
 * Official `k1n` — whole-line tag test used by the hook-output sanitizer.
 * Applied to a trimmed line; the body may not contain `>`, `\r` or `\n`.
 */
const HINT_TAG_LINE_RE = /^[ \t]*<claude-code-hint[ \t][^>\r\n]*\/>[ \t]*$/

/**
 * Official `S1n` — a plugin hint value must be a `name@marketplace` slug
 * with two conservative identifier halves (max 64 chars each).
 */
const PLUGIN_HINT_VALUE_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Attribute matcher (official `b1n`). Accepts `key="value"` and `key=value`
 * (terminated by whitespace or the `/>` closing sequence). Values containing
 * whitespace or `"` must use the quoted form. The quoted form does not
 * support escape sequences; raise the spec version if that becomes necessary.
 */
const ATTR_RE = /(\w+)=(?:"([^"]*)"|([^\s/>]+))/g

/** Char codes for space and tab (official `bPe`). */
function isSpaceOrTab(code: number): boolean {
  return code === 32 || code === 9
}

/** Char codes for U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR (official `Act`). */
function isUnicodeLineBoundary(code: number): boolean {
  return code === 8232 || code === 8233
}

type HintTagMatch = {
  /** Inclusive start (line offset) of the stripped range — spaces/tabs before the tag are absorbed. */
  start: number
  /** Exclusive end (line offset) of the stripped range — spaces/tabs after `>` are absorbed. */
  end: number
  /** Attribute text between `<claude-code-hint ` and `/>`. */
  body: string
}

/**
 * Official `v1n` — find whole-line hint tags inside one logical line
 * (already split on `\n`/`\r`; U+2028/U+2029 act as boundaries here).
 * A tag matches only when the character after the tag name is a space/tab,
 * the tag closes with `/>`, the line ends (or a Unicode line separator
 * follows) after the closing `>` (modulo spaces/tabs), and nothing but
 * spaces/tabs precedes the `<` (modulo a leading Unicode line separator).
 */
function findTagMatchesInLine(line: string): HintTagMatch[] {
  const matches: HintTagMatch[] = []
  let open = line.indexOf(HINT_TAG_OPEN)
  while (open !== -1) {
    const close = line.indexOf('>', open)
    if (close === -1) break
    let end = close + 1
    while (isSpaceOrTab(line.charCodeAt(end))) end++
    if (
      line[close - 1] === '/' &&
      (end === line.length || isUnicodeLineBoundary(line.charCodeAt(end)))
    ) {
      // The `>` may belong to a later tag-open on the same line — walk each
      // candidate open before it and take the first that forms a valid tag.
      for (
        let candidate = open;
        candidate !== -1 && candidate < close;
        candidate = line.indexOf(
          HINT_TAG_OPEN,
          candidate + HINT_TAG_OPEN.length,
        )
      ) {
        const bodyStart = candidate + HINT_TAG_OPEN.length + 1
        let start = candidate
        while (isSpaceOrTab(line.charCodeAt(start - 1))) start--
        if (
          isSpaceOrTab(line.charCodeAt(bodyStart - 1)) &&
          bodyStart < close &&
          (start === 0 || isUnicodeLineBoundary(line.charCodeAt(start - 1)))
        ) {
          matches.push({
            start,
            end,
            body: line.slice(bodyStart, close - 1),
          })
          break
        }
      }
    }
    open = line.indexOf(HINT_TAG_OPEN, close + 1)
  }
  return matches
}

/**
 * Official `Oct` — walk every logical line (split on `\n` and `\r`) that
 * contains the tag-open sequence, remove whole-line tag ranges (including
 * the spaces/tabs absorbed around them) from the returned text, and invoke
 * `onTag(rawMatch, body)` for each. Stripping happens regardless of what
 * the callback decides — an over-long or invalid tag line is still removed
 * from model-visible output, it just isn't recorded as a hint.
 */
function walkHintTagLines(
  text: string,
  onTag?: (rawMatch: string, body: string) => void,
): string {
  let out = ''
  let copiedUntil = 0
  let lineCursor = 0
  // Cached next-newline / next-carriage-return indices; -1 = none remain,
  // -2 = not yet computed (faithful to the official sentinel values).
  let nextLf = -2
  let nextCr = -2
  for (
    let idx = text.indexOf(HINT_TAG_OPEN);
    idx !== -1;
    idx = text.indexOf(HINT_TAG_OPEN, lineCursor)
  ) {
    const since = text.slice(lineCursor, idx)
    const lineStart =
      lineCursor +
      Math.max(since.lastIndexOf('\n'), since.lastIndexOf('\r')) +
      1
    if (nextLf !== -1 && nextLf < idx) nextLf = text.indexOf('\n', idx)
    if (nextCr !== -1 && nextCr < idx) nextCr = text.indexOf('\r', idx)
    const lineEnd = Math.min(
      nextLf === -1 ? text.length : nextLf,
      nextCr === -1 ? text.length : nextCr,
    )
    const line = text.slice(lineStart, lineEnd)
    for (const match of findTagMatchesInLine(line)) {
      out += text.slice(copiedUntil, lineStart + match.start)
      copiedUntil = lineStart + match.end
      onTag?.(line.slice(match.start, match.end), match.body)
    }
    lineCursor = lineEnd
  }
  return out + text.slice(copiedUntil)
}

/**
 * Official `Ctr` — whole-line hint-tag test for the hook-output sanitizer.
 * Lines longer than the cap are never treated as tags (they stay in hook
 * output verbatim).
 */
function isHintTagLine(line: string): boolean {
  if (line.length > HINT_LINE_MAX_CHARS || !line.includes(HINT_TAG_OPEN)) {
    return false
  }
  return HINT_TAG_LINE_RE.test(line)
}

/**
 * Official `lL` — drop whole-line hint tags from hook stdout/stderr/output
 * before the text can reach the model through the hook side channel. Splits
 * on `\n` only (a trailing `\r` from CRLF output is removed by `trim()`),
 * does NOT collapse the blank lines left behind — collapsing belongs to the
 * extraction path, not to this filter. Fast path returns the input string
 * itself when it contains no tag-open sequence.
 */
export function stripHintTagLines(text: string): string {
  if (!text.includes(HINT_TAG_OPEN)) return text
  return text
    .split('\n')
    .filter(line => !isHintTagLine(line.trim()))
    .join('\n')
}

/**
 * Scan shell tool output for hint tags, returning the parsed hints and
 * the output with hint tag lines removed. The stripped output is what the
 * model sees — hints are a harness-only side channel.
 *
 * Official `Mct` (2.1.296): line-based scan via `walkHintTagLines`; tags
 * must occupy their whole line; over-long (>1024 chars) tag lines are
 * stripped but dropped as hints; plugin values must be `name@marketplace`
 * slugs; runs of 3+ newlines introduced by stripping collapse to two when
 * anything was stripped or recorded.
 *
 * @param output - Raw command output (stdout with stderr interleaved).
 * @param command - The command that produced the output; its first
 *   whitespace-separated token is recorded as `sourceCommand`.
 */
export function extractClaudeCodeHints(
  output: string,
  command: string,
): { hints: ClaudeCodeHint[]; stripped: string } {
  // Fast path: no tag open sequence → no work, no allocation.
  if (!output.includes(HINT_TAG_OPEN)) {
    return { hints: [], stripped: output }
  }

  const sourceCommand = firstCommandToken(command)
  const hints: ClaudeCodeHint[] = []

  const strippedRaw = walkHintTagLines(output, (rawMatch, body) => {
    if (rawMatch.length > HINT_LINE_MAX_CHARS) {
      logForDebugging('[claudeCodeHints] dropped over-long hint line')
      return
    }
    const attrs = parseAttrs(body)
    const v = Number(attrs.v)
    const { type, value } = attrs

    if (!SUPPORTED_VERSIONS.has(v)) {
      logForDebugging(
        `[claudeCodeHints] dropped hint with unsupported v=${attrs.v}`,
      )
      return
    }
    if (!type || !SUPPORTED_TYPES.has(type)) {
      logForDebugging(
        `[claudeCodeHints] dropped hint with unsupported type=${type}`,
      )
      return
    }
    if (!value) {
      logForDebugging('[claudeCodeHints] dropped hint with empty value')
      return
    }
    if (type === 'plugin' && !PLUGIN_HINT_VALUE_RE.test(value)) {
      logForDebugging(
        '[claudeCodeHints] dropped plugin hint whose value is not name@marketplace',
      )
      return
    }

    hints.push({ v, type: type as ClaudeCodeHintType, value, sourceCommand })
  })

  // Removing a tag leaves the surrounding newlines behind. Collapse runs of
  // blank lines introduced by the strip so the model-visible output doesn't
  // grow vertical whitespace (official: applied when hints were recorded or
  // the text changed).
  const stripped =
    hints.length > 0 || strippedRaw !== output
      ? strippedRaw.replace(/\n{3,}/g, '\n\n')
      : strippedRaw

  return { hints, stripped }
}

function parseAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of tagBody.matchAll(ATTR_RE)) {
    attrs[m[1]!] = m[2] ?? m[3] ?? ''
  }
  return attrs
}

function firstCommandToken(command: string): string {
  const trimmed = command.trim()
  const spaceIdx = trimmed.search(/\s/)
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
}

// ============================================================================
// Pending-hint store (useSyncExternalStore interface)
//
// Single-slot: write wins if the slot is already full (a CLI that emits on
// every invocation would otherwise pile up). The dialog is shown at most
// once per session; after that, setPendingHint becomes a no-op.
//
// Callers should gate before writing (installed? already shown? cap hit?) —
// see maybeRecordPluginHint in hintRecommendation.ts for the plugin-type
// gate. This module stays plugin-agnostic so future hint types can reuse
// the same store.
// ============================================================================

let pendingHint: ClaudeCodeHint | null = null
let shownThisSession = false
const pendingHintChanged = createSignal()
const notify = pendingHintChanged.emit

/** Raw store write. Callers should gate first (see module comment). */
export function setPendingHint(hint: ClaudeCodeHint): void {
  if (shownThisSession) return
  pendingHint = hint
  notify()
}

/** Clear the slot without flipping the session flag — for rejected hints. */
export function clearPendingHint(): void {
  if (pendingHint !== null) {
    pendingHint = null
    notify()
  }
}

/** Flip the once-per-session flag. Call only when a dialog is actually shown. */
export function markShownThisSession(): void {
  shownThisSession = true
}

export const subscribeToPendingHint = pendingHintChanged.subscribe

export function getPendingHintSnapshot(): ClaudeCodeHint | null {
  return pendingHint
}

export function hasShownHintThisSession(): boolean {
  return shownThisSession
}

/** Test-only reset. */
export function _resetClaudeCodeHintStore(): void {
  pendingHint = null
  shownThisSession = false
}

export const _test = {
  parseAttrs,
  firstCommandToken,
  isHintTagLine,
  findTagMatchesInLine,
  walkHintTagLines,
}
