/**
 * CC 2.1.307 PORT B6 — "/permissions Recently-denied rows show the command;
 * approvals name the command."
 *
 * Pure display builders for the recently-denied tab + Esc exit handler,
 * ported verbatim from the official v307 linux-x64 ELF:
 *
 * - Sanitizer chunk @242775400–242784700: `CS` (value sanitizer), `ga`
 *   (preview), `sbt`/`xze`/`mG` (label dedup + withheld numbering), `Uh`
 *   (combining-run collapse, O=8), `hpn` (2000-unit head + …), `mw`
 *   (needsGutter), `ha` (line-break → ), withheld marker `f`, `I`
 *   (fit-check via `re`), `k`/`v1o` (visible-width predicates).
 * - vi-chunk @239861800–239866800: `It`/`vt`/`Ir`/`Cr` code-point
 *   predicates, `Ct` (segment width), `Ot`/`vi` (control scrub), `bue`
 *   (tab stops, H_e=8), `jr` (line budgets: Te=4096, Ar=4064, ot=1024,
 *   Dr=4*Te², Nr=64*ot²), `xt`/`kt`/`Lr` (width stabilizer), `Tr`/`At`/`Fr`
 *   (grapheme-safe head truncation).
 * - Risky-code-point strip @242776139–242776661: `E`/`S`/`p`/`M` +
 *   `R=/\p{Default_Ignorable_Code_Point}/u`, `T=/\p{Cf}/u`.
 * - chunk-e16zaw2j @238485000–238498900: `re` = OCC
 *   truncateToDisplayLength (UTF-16 slice + lone-high-surrogate drop —
 *   byte-identical port already in src/services/mcp/displaySanitize.ts);
 *   `k9` (code-point counter), `I` (plural) = OCC `plural`.
 * - UI chunk (new307 @16921200): command truncator `Tr` (yd=8 rows,
 *   AS=200000 units), gutter `Gi`, `wgo` @274596849 (window: Gq=2,
 *   visible-1 rows), `s8r` @274806317 (oPo=6), `Eoe` @239851415, `pt`
 *   @239846016, `dM` @258951597 (parens variant), `$n` @36448041, footer
 *   strings from `Ji` (new307 @16921300–16927100).
 *
 * Deviations (documented, behavior-equivalent for the denial surface):
 * - `CS` string-only: the official non-string serializer branch (`h(n,
 *   {unitsRemaining, elementsRemaining})`) and `scrub:"key"`/`softWrap`
 *   options are unused by denials (always strings, never soft-wrapped).
 * - `bue` simplified to the plain path (`expandTabsToStops`): in the `Ud`
 *   pipeline ESC (27) and C1s (127–159) are already replaced with  by `It`
 *   before `bue` runs, so the ANSI-aware branch (`W3o`) is unreachable.
 * - `mf(text, cols, "wrap")` maps to OCC `wrapAnsi(text, cols)`.
 * - `c7` (identity display wrapper) dropped.
 */

import { truncateToDisplayLength } from '../../../services/mcp/displaySanitize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { wrapAnsi } from '../../../ink/wrapAnsi.js'
import { getGraphemeSegmenter } from '../../../utils/intl.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import { plural } from '../../../utils/stringUtils.js'
import type { AutoModeDenial } from '../../../utils/autoModeDenials.js'

// ---------------------------------------------------------------------------
// Constants (official minified names in comments)
// ---------------------------------------------------------------------------

/** Official `f` @242780776 — verbatim withheld-value marker. */
export const WITHHELD_MARKER =
  '(value cannot be shown in full — approval withheld; one-time options only)'

/** Official `pG`=2000 — default sanitizer unit budget. */
export const DEFAULT_SANITIZER_UNITS = 2000

/** Official `AS`=200000 — raised budget for labels/commands (W=1e4, j=64 unused). */
export const MAX_LABEL_UNITS = 200000

/** Official `yd`=8 — max visible rows for the focused command reveal. */
export const MAX_COMMAND_ROWS = 8

/** Official `Gq`=2 — minimum visible window rows (`wgo`). */
export const MIN_WINDOW_ROWS = 2

/** Official `bgo`=20 — minimum content width (`zEn`). */
export const MIN_WINDOW_WIDTH = 20

/** Official `Sgo`=6 — gutter columns subtracted from the terminal width (`zEn`). */
export const WINDOW_GUTTER_COLUMNS = 6

/** Official `oPo`=6 — minimum spare columns to append the hint (`s8r`). */
const HIDDEN_HINT_MIN_COLUMNS = 6

/** Denials listed in the Select before the official collapse kicks in. */
export const MAX_LISTED_DENIALS = 10

/** Official `H_e`=8 — tab stop width (`bue`). */
const TAB_STOP = 8

/** Official `Te`=4096 — per-line unit budget (`jr`). */
const LINE_UNIT_BUDGET = 4096

/** Official `Ar`=4064 — oversized-line head keep (`Fr`). */
const LINE_HEAD_KEEP = 4064

/** Official `ot`=1024 — over-budget fallback head (`jr`). */
const LINE_FALLBACK_UNITS = 1024

/** Official `Dr`=4*Te*Te — total squared-units budget across lines (`jr`). */
const TOTAL_LINE_BUDGET = 4 * LINE_UNIT_BUDGET * LINE_UNIT_BUDGET

/** Official `Nr`=64*ot*ot — fallback squared-units budget (`jr`). */
const TOTAL_FALLBACK_BUDGET = 64 * LINE_FALLBACK_UNITS * LINE_FALLBACK_UNITS

/** Official `O`=8 — combining-run limit before collapse (`Uh`). */
const COMBINING_RUN_LIMIT = 8

/** Official `mw` width threshold — lines wider than this need a gutter. */
const GUTTER_WIDTH_THRESHOLD = 80

/** Official `O0e` — pre-existing grapheme-budget marker detector. */
const GRAPHEME_MARKER_RE = /… \[\+\d+ graphemes\]/

/** Official trailing-marker matcher inside `jr`. */
const TRAILING_GRAPHEME_MARKER_RE = /… \[\+\d+ graphemes\]$/

/** Official whole-line marker test inside `jr`. */
const WHOLE_GRAPHEME_MARKER_RE = /^… \[\+\d+ graphemes\]$/

/** Official `R` — default-ignorable code points (risky strip). */
const DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/u

/** Official `T` — format characters (risky strip). */
const FORMAT_CHAR_RE = /\p{Cf}/u

/** Official `L` — combining marks (`v1o`). */
const COMBINING_MARK_RE = /\p{M}/u

/** Official inside `k` — variation selectors + Mongolian free variation selectors. */
const VARIATION_SELECTOR_RE = /[\uFE0E\uFE0F\u180B-\u180F]/gu

/** Official `ha` — line/paragraph separators collapsed to . */
const LINE_BREAK_RE = /[\n\r\u2028\u2029]/g

/** Official `o` inside `xze` — non-ASCII JSON escaping. */
const NON_ASCII_RE = /[\u007f-\uffff]/g

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Official `CS` result (string branch; `softWrap`/`scrub` unused). */
export type DenialValueResult =
  | { kind: 'full'; text: string; needsGutter: boolean }
  | { kind: 'withheld'; marker: string }

/** Official `sbt` row. */
export type DenialLabel = { text: string; withheld: boolean }

/** Official `ga`/`hpn` preview result. */
export type TextPreview = { text: string; needsGutter: boolean }

/** Official UI-chunk `Tr` result (command display). */
export type CommandDisplay = TextPreview & { cutChars: number }

/** Official `wgo` result. */
export type WindowedText = {
  text: string
  hiddenRows: number
  hiddenAbove: number
  nextStart: number
}

// ---------------------------------------------------------------------------
// Code-point predicates (official `It`/`vt`/`Ir`/`Cr`/`Ct`)
// ---------------------------------------------------------------------------

/** Official `It` @239862xxx: C0/C1 controls except TAB and LF. */
function isScrubbedControl(code: number): boolean {
  if (code === 9 || code === 10) return false
  return code < 32 || (code >= 127 && code <= 159)
}

/** Official `vt`: bidi control code points. */
function isBidiControl(code: number): boolean {
  return (
    code === 1564 ||
    (code >= 8234 && code <= 8238) ||
    (code >= 8294 && code <= 8297)
  )
}

/** Official `Ir`: the two variation selectors `Ot` drops entirely. */
function isVariationSelector(code: number): boolean {
  return code === 65038 || code === 65039
}

/** Official `Cr`: surrogate code units. */
function isSurrogate(code: number): boolean {
  return code >= 55296 && code <= 57343
}

/** Official `Ct`: expected width of one grapheme segment. */
function segmentWidth(segment: string): number {
  const code = segment.codePointAt(0) ?? 0
  if (segment.length === 1) {
    if (code <= 31) return 0
    if (isBidiControl(code)) return 1
  }
  const width = stringWidth(segment)
  return width === 0 ? 0 : width === 1 ? 1 : width
}

// ---------------------------------------------------------------------------
// Risky code-point strip (official `E`/`S`/`p`/`M`)
// ---------------------------------------------------------------------------

/** Official `M`: exempt code points kept verbatim despite `p` flagging them. */
function isRiskyStripExempt(code: number): boolean {
  return (
    (code >= 8204 && code <= 8207) ||
    code === 1564 ||
    (code >= 65024 && code <= 65039) ||
    (code >= 6155 && code <= 6159) ||
    code === 10240
  )
}

/** Official `p`: risky code point detector. */
function isRiskyCodePoint(ch: string, code: number): boolean {
  return (
    DEFAULT_IGNORABLE_RE.test(ch) ||
    ch === '\u2028' ||
    ch === '\u2029' ||
    ch === '\u2800' ||
    (code >= 55296 && code <= 57343) ||
    code === 1109742 ||
    FORMAT_CHAR_RE.test(ch)
  )
}

/** Official `E(n,S)`: replace risky (non-exempt) code points with . */
function stripRiskyCodePoints(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    out +=
      isRiskyCodePoint(ch, code) && !isRiskyStripExempt(code) ? '\uFFFD' : ch
  }
  return out
}

// ---------------------------------------------------------------------------
// Tab expansion (official `bue`, plain path — see module header deviation)
// ---------------------------------------------------------------------------

/** Official `bue(e,t=H_e)` simplified: expand tabs to 8-column stops. */
function expandTabsToStops(text: string, tabStop: number = TAB_STOP): string {
  if (!text.includes('\t')) return text
  let out = ''
  let column = 0
  for (const ch of text) {
    if (ch === '\t') {
      const pad = tabStop - (column % tabStop)
      out += ' '.repeat(pad)
      column += pad
      continue
    }
    if (ch === '\n') {
      out += ch
      column = 0
      continue
    }
    out += ch
    column += stringWidth(ch)
  }
  return out
}

// ---------------------------------------------------------------------------
// Width stabilizer (official `kt`/`Lr`/`xt`)
// ---------------------------------------------------------------------------

/** Official `kt`: every grapheme's measured delta matches its own width. */
function isWidthAdditive(text: string): boolean {
  let acc = ''
  let prev = 0
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    acc += segment
    const total = stringWidth(acc)
    const delta = total - prev
    prev = total
    if (delta !== segmentWidth(segment)) return false
  }
  return true
}

/** Official `Lr`: replace non-additive graphemes with . */
function replaceNonAdditiveSegments(text: string): string {
  let acc = ''
  let out = ''
  let prev = 0
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    acc += segment
    const total = stringWidth(acc)
    const delta = total - prev
    prev = total
    out += delta === segmentWidth(segment) ? segment : '\uFFFD'
  }
  return out
}

/** Official `xt`: ≤16 stabilization passes, then all- fallback. */
function stabilizeWidths(text: string): string {
  let current = text
  for (let pass = 0; pass < 16; pass++) {
    if (isWidthAdditive(current)) return current
    const next = replaceNonAdditiveSegments(current)
    if (next === current) break
    current = next
  }
  if (isWidthAdditive(current)) return current
  return [...getGraphemeSegmenter().segment(current)]
    .map(() => '\uFFFD')
    .join('')
}

// ---------------------------------------------------------------------------
// Grapheme-safe head truncation (official `Tr`/`At`/`Fr`)
// ---------------------------------------------------------------------------

/** Official `Tr`: accumulate graphemes while the UTF-16 length fits. */
function graphemeTruncate(text: string, maxUnits: number): string {
  let out = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    if (out.length + segment.length > maxUnits) break
    out += segment
  }
  return out
}

/** Official `At`: grapheme truncate; on empty head drop a split surrogate. */
function truncateAtUnits(text: string, maxUnits: number): string {
  const head = graphemeTruncate(text, maxUnits)
  if (head.length > 0) return head
  let cut = Math.min(maxUnits, text.length)
  const lastCode = text.charCodeAt(cut - 1)
  if (lastCode >= 55296 && lastCode <= 56319) cut -= 1
  return text.slice(0, cut)
}

/** Official `Fr(e)=At(e,Ar)`. */
function truncateLineHead(text: string): string {
  return truncateAtUnits(text, LINE_HEAD_KEEP)
}

/** Official grapheme counter `(o)=>[...La().segment(o)].length` in `jr`. */
function countGraphemes(text: string): number {
  return [...getGraphemeSegmenter().segment(text)].length
}

// ---------------------------------------------------------------------------
// Line budgets (official `jr`)
// ---------------------------------------------------------------------------

/** Official `jr`: per-line squared-length budgets with grapheme markers. */
function applyLineBudgets(text: string): string {
  let lineBudget = TOTAL_LINE_BUDGET
  let fallbackBudget = TOTAL_FALLBACK_BUDGET
  return text
    .split('\n')
    .map(line => {
      if (line === '') return line
      if (WHOLE_GRAPHEME_MARKER_RE.test(line)) return line
      const carried = line.match(TRAILING_GRAPHEME_MARKER_RE)
      const tail = carried ? carried[0] : ''
      const body = carried ? line.slice(0, line.length - tail.length) : line
      const oversized = body.length > LINE_UNIT_BUDGET
      const head = oversized ? truncateLineHead(body) : body
      const headMarker = oversized
        ? `… [+${countGraphemes(body.slice(head.length))} graphemes]`
        : ''
      const headLength = head.length + headMarker.length + tail.length
      const headCost = headLength * headLength
      if (headCost <= lineBudget) {
        lineBudget -= headCost
        return stabilizeWidths(head) + headMarker + tail
      }
      const fallback = truncateAtUnits(body, LINE_FALLBACK_UNITS)
      const fallbackMarker =
        fallback.length < body.length
          ? `… [+${countGraphemes(body.slice(fallback.length))} graphemes]`
          : ''
      const fallbackLength = fallback.length + fallbackMarker.length + tail.length
      const fallbackCost = fallbackLength * fallbackLength
      if (fallback.length > 0 && fallbackCost <= fallbackBudget) {
        fallbackBudget -= fallbackCost
        return stabilizeWidths(fallback) + fallbackMarker + tail
      }
      return `… [+${countGraphemes(body)} graphemes]` + tail
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Control scrub (official `Ot`/`vi`)
// ---------------------------------------------------------------------------

/** Official `Ot(e,n)`: drop VS, replace controls/bidi/surrogates, tabs, budgets. */
function scrubControlCodePoints(text: string, budgetLines: boolean): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (isVariationSelector(code)) continue
    out +=
      isScrubbedControl(code) || isBidiControl(code) || isSurrogate(code)
        ? '\uFFFD'
        : ch
  }
  const tabbed = expandTabsToStops(out)
  return budgetLines ? applyLineBudgets(tabbed) : tabbed
}

/** Official `vi(e)=Ot(e,!0)`. */
function sanitizeUnicode(text: string): string {
  return scrubControlCodePoints(text, true)
}

// ---------------------------------------------------------------------------
// Combining-run collapse (official `Uh`/`v1o`/`k`)
// ---------------------------------------------------------------------------

/** Official `k`: has visible width after dropping variation selectors. */
function hasVisibleWidth(ch: string): boolean {
  return stringWidth(ch.replace(VARIATION_SELECTOR_RE, '')) > 0
}

/** Official `v1o(n)=L.test(n)||!k(n)`. */
function isCombiningOrZeroWidth(ch: string): boolean {
  return COMBINING_MARK_RE.test(ch) || !hasVisibleWidth(ch)
}

/** Official `Uh`: runs longer than 8 combining/zero-width code points → . */
function collapseCombiningRuns(text: string): string {
  let out = ''
  let runLength = 0
  let overflowed = false
  for (const ch of text) {
    if (ch === '\n') {
      if (overflowed) {
        out += '\uFFFD'
        overflowed = false
      }
      out += ch
      runLength = 0
      continue
    }
    if (!isCombiningOrZeroWidth(ch)) {
      if (overflowed) {
        out += '\uFFFD'
        overflowed = false
      }
      out += ch
      runLength = 0
      continue
    }
    if (runLength < COMBINING_RUN_LIMIT) {
      out += ch
      runLength++
      continue
    }
    overflowed = true
  }
  return overflowed ? `${out}\uFFFD` : out
}

// ---------------------------------------------------------------------------
// Preview primitives (official `hpn`/`mw`/`I`/`ha`)
// ---------------------------------------------------------------------------

/** Official `hpn`: 2000-unit head (`re`), tabs → spaces, … when cut. */
function truncatePreview(text: string): string {
  const head = truncateToDisplayLength(text, DEFAULT_SANITIZER_UNITS)
  const noTabs = head.replace(/\t/g, ' ')
  return head === text ? noTabs : `${noTabs}…`
}

/** Official `mw(n)=n.includes("\n")||ae(n)>80`. */
function needsGutterFor(text: string): boolean {
  return text.includes('\n') || stringWidth(text) > GUTTER_WIDTH_THRESHOLD
}

/** Official `I(n,t=pG)=re(n,t)===n` — fits within the unit budget. */
function fitsInUnits(text: string, maxUnits: number): boolean {
  return truncateToDisplayLength(text, maxUnits) === text
}

/** Official `ha`: line/paragraph breaks → . */
function collapseLineBreaks(text: string): string {
  return text.replace(LINE_BREAK_RE, '\uFFFD')
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

/**
 * Official `CS` (string branch): fit-check → risky strip + control scrub +
 * tab replace → grapheme-marker guard → combining-run guard.
 */
export function sanitizeDenialValue(
  value: string,
  maxUnits: number = DEFAULT_SANITIZER_UNITS,
): DenialValueResult {
  if (!fitsInUnits(value, maxUnits)) {
    return { kind: 'withheld', marker: WITHHELD_MARKER }
  }
  const scrubbed = sanitizeUnicode(stripRiskyCodePoints(value)).replace(
    /\t/g,
    ' ',
  )
  if (GRAPHEME_MARKER_RE.test(scrubbed)) {
    return { kind: 'withheld', marker: WITHHELD_MARKER }
  }
  if (collapseCombiningRuns(scrubbed) !== scrubbed) {
    return { kind: 'withheld', marker: WITHHELD_MARKER }
  }
  return {
    kind: 'full',
    text: scrubbed,
    needsGutter: needsGutterFor(scrubbed),
  }
}

/** Official `ga(n)`: `{text: y(Ud(hpn(n))), needsGutter: mw(...)}`. */
export function previewDenialText(text: string): TextPreview {
  const preview = sanitizeUnicode(
    collapseCombiningRuns(
      sanitizeUnicode(stripRiskyCodePoints(truncatePreview(text))),
    ),
  )
  return { text: preview, needsGutter: needsGutterFor(preview) }
}

/**
 * Official Ji `nt`: per-row dim reason description. Empty reason → undefined;
 * otherwise `ha(ga(reason).text)` (line/paragraph breaks → replacement char)
 * then collapse all remaining whitespace runs to a single space and trim.
 */
export function denialReasonDescription(
  reason: string,
): string | undefined {
  if (!reason) return undefined
  return collapseLineBreaks(previewDenialText(reason).text)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Official UI-chunk `Tr(g)`: sanitize with AS; on withhold fall back to `ga` + cutChars. */
export function truncateCommand(command: string): CommandDisplay {
  const full = sanitizeDenialValue(command, MAX_LABEL_UNITS)
  if (full.kind !== 'withheld') {
    return { text: full.text, needsGutter: full.needsGutter, cutChars: 0 }
  }
  const head = truncateToDisplayLength(command, DEFAULT_SANITIZER_UNITS)
  return {
    ...previewDenialText(command),
    cutChars: countCodePoints(command.slice(head.length)),
  }
}

/** Official `k9` @238491847: count code points (astral pairs count once). */
export function countCodePoints(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 55296 && code <= 56319 && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 56320 && next <= 57343) i++
    }
    count++
  }
  return count
}

/** Official `Gi(g)`: the "… and N more character(s) not shown" gutter. */
export function commandCutGutter(cutChars: number): string {
  return `… and ${cutChars.toLocaleString('en-US')} more ${plural(cutChars, 'character')} not shown; approving grants the whole command`
}

/** Official `xze`: NFC-key collision → JSON-escaped forms + (#N) suffixes. */
function disambiguateLabels(
  values: readonly string[],
  transform: (value: string) => string,
): string[] {
  const keyGroups = new Map<string, Set<string>>()
  const keyOf = (value: string): string => transform(value).normalize('NFC')
  for (const value of values) {
    const key = keyOf(value)
    const group = keyGroups.get(key) ?? new Set<string>()
    group.add(value)
    keyGroups.set(key, group)
  }
  const escapeForm = (value: string): string => {
    const json = jsonStringify(
      truncateToDisplayLength(value, DEFAULT_SANITIZER_UNITS),
    )
    const escaped = json.replace(
      NON_ASCII_RE,
      ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    return escaped + (value.length > DEFAULT_SANITIZER_UNITS ? '…' : '')
  }
  const seen = new Map<string, Map<string, number>>()
  return values.map(value => {
    const key = keyOf(value)
    if ((keyGroups.get(key)?.size ?? 0) <= 1) return transform(value)
    const escaped = escapeForm(value)
    const group = seen.get(escaped) ?? new Map<string, number>()
    seen.set(escaped, group)
    const occurrence = group.get(value) ?? group.size + 1
    group.set(value, occurrence)
    return occurrence > 1 ? `${escaped} (#${occurrence})` : escaped
  })
}

/**
 * Official `sbt(n,t)`: sanitize each label; full ones get NFC-deduped
 * display text; withheld ones get `${marker} (#N)` in withheld order.
 */
export function sanitizeDenialLabels(
  labels: readonly string[],
  maxUnits: number = DEFAULT_SANITIZER_UNITS,
): DenialLabel[] {
  const results = labels.map(label => sanitizeDenialValue(label, maxUnits))
  const dedupTexts = new Map<string, string>()
  labels.forEach((label, index) => {
    const result = results[index]
    if (result.kind === 'full' && !dedupTexts.has(label)) {
      dedupTexts.set(
        label,
        collapseLineBreaks(result.text).replace(/\s+/g, ' ').trim(),
      )
    }
  })
  const fullValues = labels.filter((_, index) => results[index].kind === 'full')
  const disambiguated = disambiguateLabels(
    fullValues,
    label => dedupTexts.get(label) ?? '',
  )
  const out: DenialLabel[] = []
  let fullIndex = 0
  let withheldCount = 0
  for (const result of results) {
    if (result.kind === 'full') {
      out.push({ text: String(disambiguated[fullIndex++]), withheld: false })
    } else {
      withheldCount += 1
      out.push({ text: `${result.marker} (#${withheldCount})`, withheld: true })
    }
  }
  return out
}

/**
 * Official `$n` @36448041: approval meta message. Command-bearing denials
 * name the command (IN FULL when the sanitized form was cut); others use
 * their row label from the full denials list.
 */
export function denialsMetaMessage(
  granted: readonly AutoModeDenial[],
  allDenials: readonly AutoModeDenial[],
): string {
  const labels = sanitizeDenialLabels(
    allDenials.map(denial => denial.display),
    MAX_LABEL_UNITS,
  )
  const parts = granted.map(denial => {
    if (denial.command === undefined) {
      return labels[allDenials.indexOf(denial)]?.text
    }
    const display = truncateCommand(denial.command)
    return display.cutChars > 0 ? denial.command : display.text
  })
  return `Permission granted for: ${parts.join(', ')}. You may now retry ${granted.length === 1 ? 'this command' : 'these commands'} if you would like.`
}

/**
 * Official Ji footer `Z`: retry selection wins over approvals; 3 leading
 * spaces; '' when nothing selected.
 */
export function buildDenialsFooter(
  retryCount: number,
  approveCount: number,
): string {
  if (retryCount > 0) {
    return `   Esc will retry ${retryCount} denied ${plural(retryCount, 'call')}`
  }
  if (approveCount > 0) {
    return `   Esc will approve ${approveCount} denied ${plural(approveCount, 'call')}`
  }
  return ''
}

/**
 * Official `wgo` @274596849: wrap to `columns`, show at most
 * `max(2,maxRows)-1` lines from `start`; report hidden rows above/below and
 * the next window start (0 when the end is reached).
 */
export function windowWrappedText(
  text: string,
  columns: number,
  maxRows: number,
  start: number = 0,
): WindowedText {
  const wrapped = wrapAnsi(text, Math.max(1, columns)).split('\n')
  const visible = Math.max(MIN_WINDOW_ROWS, maxRows)
  if (wrapped.length <= visible) {
    return { text, hiddenRows: 0, hiddenAbove: 0, nextStart: 0 }
  }
  const shown = visible - 1
  const from = Math.min(Math.max(0, start), wrapped.length - shown)
  const window = wrapped.slice(from, from + shown)
  const hiddenRows = wrapped.length - from - window.length
  return {
    text: window.join('\n'),
    hiddenRows,
    hiddenAbove: from,
    nextStart: hiddenRows === 0 ? 0 : from + window.length,
  }
}

/** Official `Eoe(e,t="line")`: "… +N line(s)" ('' when N ≤ 0). */
export function hiddenLinesHint(count: number, unit: string = 'line'): string {
  if (count <= 0) return ''
  return `… +${count} ${plural(count, unit)}`
}

/** Official `pt` @239846016: grapheme-safe width truncation + …. */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return '…'
  let width = 0
  let out = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segmentW = stringWidth(segment)
    if (width + segmentW > maxWidth - 1) break
    out += segment
    width += segmentW
  }
  return `${out}…`
}

/** Official `s8r` @274806317: first fitting hidden-rows variant + hint. */
export function hiddenRowsGutter(params: {
  hiddenRows: number
  hiddenAbove: number
  hint: string
  columns: number
}): string {
  const { hiddenRows, hiddenAbove, hint, columns } = params
  const below = hiddenLinesHint(hiddenRows, 'line')
  const variants =
    hiddenAbove === 0
      ? [below]
      : hiddenRows === 0
        ? [
            `${hiddenLinesHint(hiddenAbove, 'line')} above`,
            `… +${hiddenAbove} above`,
            `↑${hiddenAbove}`,
          ]
        : [
            `${below}, +${hiddenAbove} above`,
            `… +${hiddenRows}, +${hiddenAbove} above`,
            `↑${hiddenAbove} ↓${hiddenRows}`,
          ]
  const chosen =
    variants.find(variant => stringWidth(variant) <= columns) ??
    truncateToWidth(variants.at(-1) ?? below, columns)
  const remaining = columns - stringWidth(chosen) - 1
  if (remaining < HIDDEN_HINT_MIN_COLUMNS || hint === '') return chosen
  return `${chosen} ${truncateToWidth(hint, remaining)}`
}

/** Official `dM({chord,action,parens:true})` with a resolved chord display. */
export function shortcutParenHint(chord: string, action: string): string {
  if (!chord) return ''
  return `(${chord} to ${action})`
}
