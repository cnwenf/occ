/**
 * Screen-reader flat-render helpers — faithful port of the official
 * claude-code 2.1.206 Ink SR render path (binary: `mPr` root→lines serializer,
 * `iHh` box serializer, `R0c`/`oHh` text sanitizer, `mIi` cursor-node offset,
 * `Sv`/`c2n`/`u2n`/`uRe` ANSI cursor movers, `Nu` counter, `YG`/`Pt` wrappers).
 *
 * These are pure functions over the Ink DOM tree (src/ink/dom.ts). The DOM has
 * `nodeName`, `childNodes`, `style.flexDirection`, `isHidden`, `yogaNode`,
 * `nodeValue`, and (added in this port) `accessibility` — matching the fields
 * the binary's `mPr`/`mIi` walk. When `accessibility` is unset, `mPr` falls
 * back to the node's text content (ink-text/ink-virtual-text/ink-link), so the
 * SR render produces flat text even before any component sets accessibility
 * labels.
 */
import type { DOMNode, DOMElement, AccessibilityProps } from './dom.js'
import { LayoutDisplay } from './layout/node.js'
import { drainScreenReaderAnnouncements } from '../utils/screenReader.js'
import { stringWidth } from './stringWidth.js'
import { wrapAnsi } from './wrapAnsi.js'

// ───────────────────────── Text sanitization (binary: oHh, R0c, fs) ─────────

/**
 * Control characters + bidi/annotation marks that must not reach the flat SR
 * output (binary: `oHh`). Matches C0 controls (except \t \n), DEL+C1, LRE/RLE
 * etc., and isolate marks.
 */
const CONTROL_OR_BIDI = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u202a-\u202e\u2066-\u2069]/

/**
 * Strip ANSI escapes from a single line (binary: `fs(e){return Bun.stripANSI(e)}`).
 */
function stripAnsiLine(line: string): string {
  return typeof Bun !== 'undefined' && typeof Bun.stripANSI === 'function'
    ? Bun.stripANSI(line)
    : line
}

/**
 * Sanitize text for screen-reader output (binary: `R0c`). Fast-path returns the
 * string unchanged when it has no control/bidi chars. Otherwise: strip ANSI per
 * line, then drop C0 controls (keeping tab/newline), drop DEL+C1, and replace
 * bidi/annotation marks with U+FFFD so they don't perturb the screen reader's
 * speech direction.
 */
export function sanitizeSrText(value: string): string {
  if (!CONTROL_OR_BIDI.test(value)) return value
  const stripped = value.split('\n').map(stripAnsiLine).join('\n')
  let out = ''
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i)
    if (code < 32) {
      if (code === 9 || code === 10) out += stripped[i]
    } else if (code === 127 || (code >= 128 && code <= 159)) {
      // drop DEL + C1 controls
    } else if (code === 1564 || (code >= 8234 && code <= 8238) || (code >= 8294 && code <= 8297)) {
      out += '\uFFFD'
    } else {
      out += stripped[i]
    }
  }
  return out
}

// ───────────────────────── ANSI cursor movers (binary: Sv, c2n, u2n, uRe) ───

/** CSI prefix (binary: `RHi = Yie + String.fromCharCode(SZ.CSI)` = ESC + "["). */
const CSI = '\x1b['

/**
 * Build a CSI sequence (binary: `Sv(...e)`). No args → bare CSI; one arg →
 * `CSI<param>`; multiple → `CSI<p1>;…;<pn-1><final>`.
 */
function csi(...params: (string | number)[]): string {
  if (params.length === 0) return CSI
  if (params.length === 1) return `${CSI}${params[0]}`
  const leading = params.slice(0, -1)
  const final = params[params.length - 1]
  return `${CSI}${leading.join(';')}${final}`
}

/** Cursor to column `col` (1-based) (binary: `c2n(e){return Sv(e,"G")}`). */
function cursorToColumn(col: number): string {
  return csi(col, 'G')
}

/** Cursor up N lines (binary: `j_c(e=1){return e===0?"":Sv(e,"A")}`). */
function cursorUp(n: number = 1): string {
  return n === 0 ? '' : csi(n, 'A')
}

/** Cursor down N lines (binary: `DHi(e=1){return Sv(e,"B")}`). */
function cursorDown(n: number = 1): string {
  return n === 0 ? '' : csi(n, 'B')
}

/** Cursor forward (right) N cols (binary: `Q_h(e=1){return Sv(e,"C")}`). */
function cursorForward(n: number = 1): string {
  return n === 0 ? '' : csi(n, 'C')
}

/** Cursor back (left) N cols (binary: `Z_h(e=1){return Sv(e,"D")}`). */
function cursorBack(n: number = 1): string {
  return n === 0 ? '' : csi(n, 'D')
}

/**
 * Erase `count` lines upward from the current position, parking at column 1 of
 * the topmost erased line (binary: `u2n`). Emits `\x1b[2K` (erase whole line)
 * per line with `\x1b[1A` (cursor up) between, ending with `\x1b[G` (col 1).
 */
function eraseLinesUp(count: number): string {
  if (count <= 0) return ''
  let out = ''
  for (let i = 0; i < count; i++) {
    out += csi(2, 'K') // erase entire line
    if (i < count - 1) out += cursorUp(1)
  }
  out += csi('G') // CHA to column 1 (no param → default 1)
  return out
}

/**
 * Relative cursor move (binary: `uRe(e,t)`): `e` = horizontal delta (neg=left),
 * `t` = vertical delta (neg=up). Used by the SR diff to navigate between the
 * previous park position and the diff start.
 */
function moveCursor(horizontalDelta: number, verticalDelta: number): string {
  let out = ''
  if (horizontalDelta < 0) out += cursorBack(-horizontalDelta)
  else if (horizontalDelta > 0) out += cursorForward(horizontalDelta)
  if (verticalDelta < 0) out += cursorUp(-verticalDelta)
  else if (verticalDelta > 0) out += cursorDown(verticalDelta)
  return out
}

// ───────────────────────── Misc helpers (binary: Nu, YG, Pt) ───────────────

/** Count occurrences of `needle` in `str` from `fromIndex` (binary: `Nu`). */
export function countOccurrences(
  str: string,
  needle: string,
  fromIndex: number = 0,
): number {
  let count = 0
  let idx = str.indexOf(needle, fromIndex)
  while (idx !== -1) {
    count++
    idx = str.indexOf(needle, idx + 1)
  }
  return count
}

/**
 * Wrap a string to `columns` (binary: `YG(e,t,r)`). Uses `Bun.wrapAnsi` (via
 * OCC's wrapAnsi) — same primitive as the official. The binary additionally
 * runs an SGR-state-preservation fixup (`Ayh`/`Qgc`) for colored text that
 * breaks across wrap boundaries; that sub-detail is deferred (SR output is
 * flat text — color continuation across wraps is a minor fidelity edge case,
 * not a correctness issue). Hard-wrap is honored.
 */
function wrapLine(
  text: string,
  columns: number,
  options: { trim?: boolean; hard?: boolean },
): string {
  if (!(columns > 0)) return text
  return wrapAnsi(text, columns, options as { trim?: boolean; hard?: boolean })
}

// ───────────────────────── DOM → flat text (binary: mPr, iHh) ──────────────

function isDOMNode(value: unknown): value is DOMNode {
  return value !== null && typeof value === 'object' && 'nodeName' in value
}

/**
 * Serialize a box's children to flat text, joining per flex direction
 * (binary: `iHh(e,t)`). Column → newline-joined; row → space-joined; reversed
 * directions reverse child order. Empty child serializations are skipped.
 */
function serializeBox(node: DOMElement, inheritedRole?: string): string {
  const dir = node.style.flexDirection ?? 'row'
  const isColumn = dir === 'column' || dir === 'column-reverse'
  const isReversed = dir === 'row-reverse' || dir === 'column-reverse'
  const separator = isColumn ? '\n' : ' '
  const parts: string[] = []
  for (const child of node.childNodes) {
    if (!isDOMNode(child)) continue
    const serialized = serializeNode(child, inheritedRole)
    if (serialized !== '') parts.push(serialized)
  }
  if (isReversed) parts.reverse()
  return parts.join(separator)
}

/**
 * Serialize a DOM node to flat screen-reader text (binary: `mPr(e,t)`).
 *
 * - `#text` → sanitized nodeValue.
 * - `accessibility.hidden` / `isHidden` / `display:none` → "".
 * - `accessibility.label` (set) → sanitized label (replaces child text).
 * - `ink-text`/`ink-virtual-text`/`ink-link` → concatenated child text.
 * - `ink-box`/`ink-root` → `serializeBox`.
 * - `accessibility.state` (truthy flags) → prefixed `(flag, …) `.
 * - `accessibility.role` (≠ inherited) → prefixed `role: `.
 */
export function serializeNode(node: DOMNode, inheritedRole?: string): string {
  if (node.nodeName === '#text') {
    return sanitizeSrText((node as { nodeValue: string }).nodeValue)
  }
  const element = node as DOMElement
  const a11y: AccessibilityProps | undefined = element.accessibility
  if (a11y?.hidden) return ''
  if (element.isHidden || element.yogaNode?.getDisplay() === LayoutDisplay.None) {
    return ''
  }
  let text = ''
  if (a11y?.label !== undefined) {
    text = sanitizeSrText(a11y.label)
  } else if (
    element.nodeName === 'ink-text' ||
    element.nodeName === 'ink-virtual-text' ||
    element.nodeName === 'ink-link'
  ) {
    for (const child of element.childNodes) {
      if (isDOMNode(child)) text += serializeNode(child, a11y?.role ?? inheritedRole)
    }
  } else if (element.nodeName === 'ink-box' || element.nodeName === 'ink-root') {
    text = serializeBox(element, a11y?.role ?? inheritedRole)
  }
  if (a11y?.state) {
    const active = Object.keys(a11y.state).filter(k => a11y.state[k])
    if (active.length > 0) text = `(${active.join(', ')}) ${text}`
  }
  if (a11y?.role && a11y.role !== inheritedRole) {
    text = `${a11y.role}: ${text}`
  }
  return text
}

// ──────────────────── Cursor-node offset (binary: mIi) ─────────────────────

/**
 * Find the flat-text offset of the cursor declaration's target node within the
 * serialized root (binary: `mIi(e,t,r)`). Returns the character offset of the
 * target node, or `null` if it isn't reachable in the SR text. Mirrors `mPr`'s
 * walk: skips hidden/display-none nodes, doesn't descend into nodes with an
 * accessibility label (their text is opaque), and accumulates child text
 * lengths plus separator counts.
 */
export function findCursorOffset(
  root: DOMElement,
  target: DOMElement,
  inheritedRole?: string,
): number | null {
  if (root === target) return 0
  if (root.nodeName === '#text') return null
  const a11y = root.accessibility
  if (a11y?.hidden) return null
  if (root.isHidden || root.yogaNode?.getDisplay() === LayoutDisplay.None) {
    return null
  }
  if (a11y?.label !== undefined) return null
  if (
    root.nodeName === 'ink-text' ||
    root.nodeName === 'ink-virtual-text' ||
    root.nodeName === 'ink-link'
  ) {
    return null
  }
  if (root.nodeName !== 'ink-box' && root.nodeName !== 'ink-root') return null
  const role = a11y?.role ?? inheritedRole
  let prefix = 0
  if (a11y?.state) {
    const active = Object.keys(a11y.state).filter(k => a11y.state[k])
    if (active.length > 0) prefix += `(${active.join(', ')}) `.length
  }
  if (a11y?.role && a11y.role !== inheritedRole) {
    prefix += `${a11y.role}: `.length
  }
  const dir = root.style.flexDirection ?? 'row'
  const isColumn = dir === 'column' || dir === 'column-reverse'
  const isReversed = dir === 'row-reverse' || dir === 'column-reverse'
  // Separator length between non-empty serialized children (binary: `c`).
  const separatorLen = isColumn ? 1 : 1
  const visited: { node: DOMElement; out: string }[] = []
  for (const child of root.childNodes) {
    if (!isDOMNode(child)) continue
    const out = serializeNode(child, role)
    if (out !== '') visited.push({ node: child as DOMElement, out })
  }
  if (isReversed) visited.reverse()
  let acc = prefix
  for (const entry of visited) {
    const childOffset = findCursorOffset(entry.node, target, role)
    if (childOffset !== null) return acc + childOffset
    acc += entry.out.length + separatorLen
  }
  return null
}

// ──────────────────── Exported render-diff entry (binary: onRenderScreenReader) ─

export type ScreenReaderPark = { row: number; col: number }

export type CursorDeclaration = {
  node: DOMElement
  relativeX: number
  relativeY: number
} | null

/**
 * State carried across SR renders (binary: the `prevScreenReaderLines` +
 * `prevScreenReaderPark` fields on `F6t`).
 */
export class ScreenReaderDiffState {
  prevLines: string[] = []
  prevPark: ScreenReaderPark = { row: 0, col: 0 }

  reset(): void {
    this.prevLines = []
    this.prevPark = { row: 0, col: 0 }
  }
}

/**
 * Compute the terminal "park" position for the declared cursor, in
 * (wrapped-)line/col coordinates (binary: `computeScreenReaderPark`).
 * Returns null when there's no cursor declaration or the target isn't
 * reachable.
 */
export function computeScreenReaderPark(
  rootNode: DOMElement,
  serialized: string,
  lineStarts: number[],
  wrappedLines: string[],
  columns: number,
  cursorDeclaration: CursorDeclaration,
): ScreenReaderPark | null {
  if (cursorDeclaration === null) return null
  const offset = findCursorOffset(rootNode, cursorDeclaration.node)
  if (offset === null) return null
  const upTo = serialized.slice(0, offset)
  const row = countOccurrences(upTo, '\n') + cursorDeclaration.relativeY
  if (row < 0 || row >= lineStarts.length) return null
  const lineStart = upTo.lastIndexOf('\n') + 1
  const colInLine =
    (cursorDeclaration.relativeY === 0
      ? stringWidth(upTo.slice(lineStart))
      : 0) + cursorDeclaration.relativeX
  const colRows = columns > 0 ? Math.floor(colInLine / columns) : 0
  const wrapRow = Math.min(lineStarts[row] + colRows, wrappedLines.length - 1)
  const col = columns > 0 ? colInLine % columns : colInLine
  return { row: Math.max(0, wrapRow), col: Math.max(0, col) }
}

/**
 * Flat line-diff render for screen-reader mode (binary: `onRenderScreenReader`).
 *
 * Serializes the root → flat text → wraps to columns → diffs against the
 * previous frame's lines → emits only the changed tail: cursor moves from the
 * previous park to the diff start, erases the replaced lines, writes the new
 * lines, then parks at the new cursor position. Writes the diff to `write`.
 * Returns the updated diff state (new prevLines + prevPark) for the caller to
 * store.
 */
export function renderScreenReaderDiff(
  rootNode: DOMElement,
  columns: number,
  state: ScreenReaderDiffState,
  cursorDeclaration: CursorDeclaration,
  write: (data: string) => void,
): ScreenReaderDiffState {
  const serialized = serializeNode(rootNode)
  const logicalLines = serialized === '' ? [] : serialized.split('\n')
  // Wrap each logical line to the terminal width and trimEnd each wrapped row.
  const wrappedLines: string[] = []
  const lineStarts: number[] = []
  for (const line of logicalLines) {
    lineStarts.push(wrappedLines.length)
    if (line === '') {
      wrappedLines.push('')
    } else {
      const wrapped = wrapLine(line, columns, { trim: false, hard: true })
      for (const part of wrapped.split('\n')) wrappedLines.push(part.trimEnd())
    }
  }

  // Park is computed against the pre-announce wrappedLines (binary:
  // `i=this.computeScreenReaderPark(e,o,n,t)` runs before the drain loop).
  const parkResult = computeScreenReaderPark(
    rootNode,
    serialized,
    lineStarts,
    wrappedLines,
    columns,
    cursorDeclaration,
  )

  // 2.1.210 #30: drain the SR announce queue and append each entry to the
  // wrapped-lines array (binary: `for(let x of uxc()){let k=GKn(x);...}`).
  // Announce strings (e.g. `[manual mode on]` from Shift+Tab mode-cycle) are
  // sanitized, wrapped to columns, and appended after the serialized content.
  // `announceInsert` (= binary `s`) marks the first appended announce line;
  // the diff forces re-emit from there so the screen reader speaks the announce.
  let announceInsert = -1
  for (const announceStr of drainScreenReaderAnnouncements()) {
    const sanitized = sanitizeSrText(announceStr)
    if (sanitized === '') continue
    for (const row of sanitized.split('\n')) {
      if (announceInsert === -1) announceInsert = wrappedLines.length
      if (row === '') {
        wrappedLines.push('')
      } else {
        const wrapped = wrapLine(row, columns, { trim: false, hard: true })
        for (const part of wrapped.split('\n')) wrappedLines.push(part.trimEnd())
      }
    }
  }

  const prev = state.prevLines
  // lastLineIdx + park fallback use the post-announce wrappedLines (binary:
  // `l=Math.max(0,n.length-1),c=i??{row:l,col:Nt(n[l]??"")}`).
  const lastLineIdx = Math.max(0, wrappedLines.length - 1)
  const park =
    parkResult ?? {
      row: lastLineIdx,
      col: stringWidth(wrappedLines[lastLineIdx] ?? ''),
    }

  // Common-prefix length with the previous frame.
  let l = 0
  const c = Math.min(prev.length, wrappedLines.length)
  while (l < c && prev[l] === wrappedLines[l]) l++

  // Force the diff to re-emit from the announce insertion point (binary:
  // `if(s!==-1&&u>s)u=s`). Without this, announce lines that happen to match
  // the previous frame's tail would be skipped, and the screen reader would
  // not speak them.
  if (announceInsert !== -1 && l > announceInsert) l = announceInsert

  const unchanged = l === prev.length && l === wrappedLines.length
  const parkUnchanged =
    park.row === state.prevPark.row && park.col === state.prevPark.col
  if (unchanged && parkUnchanged) return state

  const prevLastLine = Math.max(0, prev.length - 1)
  // If the previous park wasn't at the last prev line, move from there to the
  // last prev line first (binary: `m = d.row!==f?uRe(0,f-d.row):""`).
  const returnToBottom =
    state.prevPark.row !== prevLastLine
      ? moveCursor(0, prevLastLine - state.prevPark.row)
      : ''
  // Erase the replaced trailing lines (binary: `u2n(i.length-l)`).
  const erase = eraseLinesUp(prev.length - l)
  const newTail = wrappedLines.slice(l).join('\n')

  let body: string
  if (unchanged) {
    body = ''
  } else if (l === prev.length) {
    // Only appended lines (binary: `l===i.length` → `l>0?"\n"+y:y`).
    body = l > 0 ? `\n${newTail}` : newTail
  } else if (l === wrappedLines.length) {
    // Only removed lines (binary: `l===n.length` → `l>0?g+uRe(0,-1):g`).
    body = l > 0 ? erase + moveCursor(0, -1) : erase
  } else {
    // Both added and removed (binary: `_ = g+y`).
    body = erase + newTail
  }

  // Move from the diff end to the new park (binary:
  // `v = c2n(a.col+1) + (a.row!==s ? uRe(0,a.row-s) : "")`).
  const toPark =
    cursorToColumn(park.col + 1) +
    (park.row !== lastLineIdx ? moveCursor(0, park.row - lastLineIdx) : '')

  write(returnToBottom + body + toPark)

  state.prevLines = wrappedLines
  state.prevPark = park
  return state
}
