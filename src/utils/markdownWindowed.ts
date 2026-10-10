import { Lexer, type Marked, type Token, type Tokens } from 'marked'

/**
 * CC 2.1.295 changelog #056 — windowed markdown lexer.
 *
 * Official changelog: "Fixed the terminal freezing, with ctrl+c ignored, when
 * a response ran to tens of thousands of lines."
 *
 * Byte-faithful port of the v295 windowed-lexing region recovered from the
 * official 2.1.295 linux-x64 binary (markdown module @214612389+; beautified
 * verbatim in /tmp/cc-153/md_v295_pretty.js lines 64-276). v294 lexed the
 * WHOLE response in one `marked.lexer(text)` call — marked's block rules
 * (paragraph, lheading, table, fences) re-scan the remaining buffer per
 * token, so a tens-of-thousands-of-lines reply is O(n²) regex work on the
 * render thread with ctrl+c unreachable. v295 keeps `marked.lexer` for
 * whole-text-safe inputs and otherwise lexes through a sliding 1000-line
 * window that only ever hands marked a bounded prefix.
 *
 * Entry decision (official `sXe`/`iXe`):
 * - `isWholeTextSafe(text)`: the first window (fence-adjusted) covers the
 *   whole text AND no line after the first fence match exceeds
 *   MAX_LINE_CHARS → use `marked.lexer(text)` unchanged (normal replies take
 *   this path; tokens are NOT marked `windowed`).
 * - Otherwise lex through `windowedLex` inside the lheading hold (the
 *   tokenizer extension swaps marked's unbounded lheading regex for the
 *   `{1,100}`-bounded one while held), then mark every produced token (and
 *   its children) `windowed:true` — links additionally `defanged:true`
 *   (official `y4n`; the defanged flag is consumed by the official's
 *   sanitize-family link renderer — reported separately, not wired here).
 *
 * The renderer side of the `windowed` flag is the PH wrapper in
 * src/utils/markdown.ts: windowed text tokens carry raw source (including
 * control bytes the normal inline tokenizer would have consumed), so their
 * rendered output gets OSC8/C1/bare-ESC stripped.
 *
 * Symbol map (official minified → OCC):
 *   _=WINDOW_LINES(1000)  fe=GIVEUP_WINDOW_LINES(16000)  he=CHARS_PER_LINE(100)
 *   Ve=PARAGRAPH_INLINE_PROBE(4000)  V=NEWLINE_LIMIT(100)  me=MAX_LINE_CHARS(100000)
 *   M=BLOCK_GFM  Te=CRLF  Ye=PARAGRAPH_PROBE("x\n")  Je=LEADING_NEWLINES
 *   et=TRAILING_NEWLINES  Y=BOUNDED_LHEADING  be=MARKED_ORIGINAL_LHEADING
 *   tt/J=createHoldCounter/lheadingHold  sXe=isWholeTextSafe  iXe=lexWithWindowing
 *   y4n=markWindowed  ke=childTokens  nt=windowedLex  rt=stepWindow
 *   st=windowForcesOversized  ot=tokenTexts  it=lexWindow  lt=fallbackWindow
 *   at=giveUpWindow  ct=shrinkListWindow  ye=takeParagraph  ee=paragraphOrGiveUp
 *   Le=isBoundedLheading  ut=paragraphFromSource  de=nextParagraphLines
 *   pt=windowTable  ft=declineTable  dt=tableRowsEnd  gt=appendedRowsLength
 *   te=singleTableToken  Ee=sliceRows  ht=limitToLastNewlines  mt=lastContentBoundary
 *   cNo=takenRawEquals  dNo=prefixLengthAtIndex  xe=takenPrefixLength
 *   C=lineSpanEnd  j=hasOversizedLine  ne=windowSlice  Tt=restAfterWindow
 *   we=headerRows  A=makeWindow  Q=giveUpAsParagraph  bt=emptyParagraph
 *   kt=paragraphToken  Se=textToken  yt=tableWithRows  Lt=listWithItems
 *   Re=isNotSpace  Ie=isBlankSeparated  re=isParagraph  se=isList  K=isTable
 *   D=joinRaw  Ft=countOccurrences
 */

/** Official `_` — window height in lines. */
export const WINDOW_LINES = 1000
/** Official `fe` — window height when growing after a give-up step. */
export const GIVEUP_WINDOW_LINES = 16000
/** Official `he` — per-line character budget for window scans. */
export const CHARS_PER_LINE = 100
/** Official `Ve` — inline-parse probe bound for takeParagraph. */
export const PARAGRAPH_INLINE_PROBE = 4000
/** Official `V` — max newlines kept when trimming taken tokens. */
export const NEWLINE_LIMIT = 100
/** Official `me = _ * he` — a line longer than this forces the window path. */
export const MAX_LINE_CHARS = WINDOW_LINES * CHARS_PER_LINE

/** Official `M = Lexer.rules.block.gfm` — marked's GFM block rules. */
const BLOCK_GFM = Lexer.rules.block.gfm

/** Official `Te` — CRLF/CR normalizer. */
const CRLF = /\r\n?/g
/** Official `Ye` — paragraph-rule probe prefix. */
const PARAGRAPH_PROBE = 'x\n'
/** Official `Je` — leading newline run. */
const LEADING_NEWLINES = /^\n*/
/** Official `et` — trailing newline run. */
const TRAILING_NEWLINES = /\n*$/
/**
 * Official `Y` — bounded lheading test used while the hold counter is up:
 * same shape as marked's original but the text-line repeat is capped at
 * NEWLINE_LIMIT so a huge non-heading can't backtrack `(?:[^\n]+\n)+?`.
 */
const BOUNDED_LHEADING = new RegExp(
  `^(?:[^\\n]+\\n){1,${NEWLINE_LIMIT}}? {0,3}(?:=+|-+) *(?:\\n|$)`,
)
/**
 * Official `be` — marked's original lheading rule, hardcoded verbatim in the
 * binary. Used when NOT held; matching it is behavior-identical to letting
 * marked's own lheading tokenizer run (a match returns `false` = fall through
 * to the original tokenizer, a miss returns `undefined` = no token, which
 * marked treats the same as its own rule missing).
 */
const MARKED_ORIGINAL_LHEADING = /^(?:[^\n]+\n)+? {0,3}(?:=+|-+) *(?:\n|$)/

/**
 * Official `tt()` — reentrancy counter. While > 0 the tokenizer extension's
 * lheading override uses the bounded regex.
 */
function createHoldCounter(): {
  isHeld(): boolean
  during<T>(fn: () => T): T
} {
  let held = 0
  return {
    isHeld: () => held > 0,
    during<T>(fn: () => T): T {
      held += 1
      try {
        return fn()
      } finally {
        held -= 1
      }
    },
  }
}

/** Official `J = tt()` — module singleton. */
export const lheadingHold = createHoldCounter()

/**
 * Official tokenizer-extension `lheading` predicate
 * (`(J.isHeld()?Y.test(e):be.test(e))`): true → the extension returns `false`
 * (fall through to marked's original tokenizer); false → `undefined`
 * (suppress). Wired in src/utils/markdown.ts configureMarked().
 */
export function lheadingMatchesOverride(src: string): boolean {
  return lheadingHold.isHeld()
    ? BOUNDED_LHEADING.test(src)
    : MARKED_ORIGINAL_LHEADING.test(src)
}

/** Official `A(e,t,n)` — window state: taken tokens + rest + window height. */
type WindowState = {
  taken: Token[]
  rest: string
  lines: number
}

/** Official `rt` return with the table-decline continuation state. */
type StepResult = WindowState & {
  declining?: { header: string; fromRow: string } | undefined
}

/** Token augmented by the official `y4n` marker pass. */
export type WindowedToken = Token & {
  windowed?: boolean
  defanged?: boolean
}

/** Official `D(e)` — concatenate token raws. */
function joinRaw(tokens: Token[]): string {
  return tokens.map(_ => _.raw).join('')
}

/** Official `Ft(e,t)` — substring occurrence count (no split allocation). */
function countOccurrences(text: string, sub: string): number {
  let count = 0
  for (let i = text.indexOf(sub); i >= 0; i = text.indexOf(sub, i + sub.length)) {
    count += 1
  }
  return count
}

/** Official `re/se/K` — token type predicates. */
function isParagraph(token: Token | undefined): token is Tokens.Paragraph {
  return token?.type === 'paragraph'
}
function isList(token: Token | undefined): token is Tokens.List {
  return token?.type === 'list'
}
function isTable(token: Token | undefined): token is Tokens.Table {
  return token?.type === 'table'
}

/** Official `Re(e)` / `Ie(e)`. */
function isNotSpace(token: Token): boolean {
  return token.type !== 'space'
}
function isBlankSeparated(token: Token): boolean {
  return token.type === 'space' || token.raw.endsWith('\n\n')
}

/** Official `C(e,t,n)` — end index of `lines` lines from `start`, character-
 * budgeted at lines * CHARS_PER_LINE so a huge single line can't be scanned. */
function lineSpanEnd(src: string, start: number, lines: number): number {
  let pos = start
  for (
    let i = 0;
    i < lines && pos < src.length && pos - start < lines * CHARS_PER_LINE;
    i++
  ) {
    const nl = src.indexOf('\n', pos)
    pos = nl === -1 ? src.length : nl + 1
  }
  return pos
}

/** Official `j(e)` — any line longer than MAX_LINE_CHARS? (index scan, no split) */
function hasOversizedLine(src: string): boolean {
  let pos = 0
  let found = false
  while (!found && pos < src.length) {
    const nl = src.indexOf('\n', pos)
    const end = nl === -1 ? src.length : nl
    found = end - pos > MAX_LINE_CHARS
    pos = end + 1
  }
  return found
}

/** Official `ne({rest,lines})` — the window slice: `lines` lines starting
 * after the first fence match (a leading complete fence block IS the window). */
function windowSlice({ rest, lines }: WindowState): string {
  return rest.slice(
    0,
    lineSpanEnd(rest, BLOCK_GFM.fences.exec(rest)?.[0].length ?? 0, lines),
  )
}

/** Official `Tt(e)` — rest after the current window. */
function restAfterWindow(state: WindowState): string {
  return state.rest.slice(windowSlice(state).length)
}

/** Official `A(e,t,n)`. */
function makeWindow(taken: Token[], rest: string, lines: number): WindowState {
  return { taken, rest, lines }
}

/** Official `Se(e)` — raw text token (no inline parsing). */
function textToken(text: string): Tokens.Text {
  return { type: 'text', raw: text, text, escaped: false } as Tokens.Text
}

/** Official `kt(e)` — whole-rest paragraph give-up token. */
function paragraphToken(text: string): Tokens.Paragraph {
  return {
    type: 'paragraph',
    raw: text,
    text,
    tokens: [textToken(text)],
  } as Tokens.Paragraph
}

/** Official `Q(e)` — give up: rest becomes one raw paragraph. */
function giveUpAsParagraph(rest: string): WindowState {
  return makeWindow([paragraphToken(rest)], '', WINDOW_LINES)
}

/** Official `bt()`. */
function emptyParagraph(): Tokens.Paragraph {
  return { type: 'paragraph', raw: '', text: '', tokens: [] } as Tokens.Paragraph
}

/** Official `yt(e,t,n)` / `Lt(e,t,n)` — retyped copies (no mutation of the
 * source token; matches official spread semantics). */
function tableWithRows(
  token: Tokens.Table,
  raw: string,
  rows: Tokens.TableCell[][],
): Tokens.Table {
  return { ...token, raw, rows }
}
function listWithItems(
  token: Tokens.List,
  raw: string,
  items: Tokens.ListItem[],
): Tokens.List {
  return { ...token, raw, items }
}

/** Official `we(e)` — a table's header rows (first two lines of raw). */
function headerRows(raw: string): string {
  return raw.slice(0, raw.indexOf('\n', raw.indexOf('\n') + 1) + 1)
}

/** Official `Ee(e,t)` — split into row slices of `linesPer` lines each. */
function sliceRows(src: string, linesPer: number): string[] {
  const rows: string[] = []
  for (let i = 0; i < src.length; i = lineSpanEnd(src, i, linesPer)) {
    rows.push(src.slice(i, lineSpanEnd(src, i, linesPer)))
  }
  return rows
}

/** Official `ke(e)` — child tokens of a container token. */
function childTokens(token: Token): Token[] {
  const hasTokens = 'tokens' in token
  if (isList(token)) return token.items
  if (isTable(token)) {
    return [...token.header, ...token.rows.flat()].flatMap(_ => _.tokens)
  }
  return hasTokens ? (token.tokens ?? []) : []
}

/** Official `te(e,t)` — lex `src` and keep it only when it is EXACTLY one
 * table token consuming the whole source. */
function singleTableToken(
  markedInstance: Marked,
  src: string,
): Tokens.Table | undefined {
  const [token] = hasOversizedLine(src) ? [] : markedInstance.lexer(src)
  return isTable(token) && token.raw.length === src.length
    ? token
    : undefined
}

/** Official `Le(e)` — a setext heading candidate whose text is bounded. */
function isBoundedLheading(src: string): boolean {
  return BOUNDED_LHEADING.test(src) && BLOCK_GFM.lheading.test(src)
}

/** Official `de(e,t)` — next paragraph-lines step (marked paragraph rule
 * probed against `probe + src` so the rule matches at position 0). */
function nextParagraphLines(
  src: string,
  probe: string,
): { nextLines: string; lineBreak: string; isOpen: boolean } {
  const end = lineSpanEnd(src, 0, WINDOW_LINES)
  const cut = src[end - 1] === '\n' ? end - 1 : end
  const matched = (
    BLOCK_GFM.paragraph.exec(
      probe + src.slice(0, lineSpanEnd(src, end, 1)),
    )?.[0] ?? probe
  ).slice(probe.length)
  const nextLines = matched.slice(0, cut)
  const isOpen = matched.length > cut
  const hasBreak =
    isOpen ||
    BLOCK_GFM.newline.exec(src.slice(nextLines.length))?.[0] === '\n'
  return { nextLines, lineBreak: hasBreak ? '\n' : '', isOpen }
}

/** Official `ut(e)` — accumulate the paragraph at the head of `src`. */
function paragraphFromSource(src: string): Tokens.Paragraph {
  const paragraph = emptyParagraph()
  let step = nextParagraphLines(src, '')
  while (step.nextLines !== '') {
    paragraph.text +=
      paragraph.raw === '' ? step.nextLines : `\n${step.nextLines}`
    paragraph.raw += step.nextLines + step.lineBreak
    step = nextParagraphLines(
      step.isOpen ? src.slice(paragraph.raw.length) : '',
      PARAGRAPH_PROBE,
    )
  }
  return paragraph
}

/** Official `ye(e,t)` — take the head paragraph; inline-parse its text only
 * when the text is small and line-safe, else emit a raw text token. */
function takeParagraph(
  markedInstance: Marked,
  rest: string,
): WindowState {
  const paragraph = paragraphFromSource(rest)
  const inlineSafe =
    lineSpanEnd(paragraph.text, 0, PARAGRAPH_INLINE_PROBE) ===
      paragraph.text.length && !hasOversizedLine(paragraph.text)
  return makeWindow(
    [
      {
        ...paragraph,
        tokens: inlineSafe
          ? new Lexer(markedInstance.defaults).inlineTokens(paragraph.text)
          : [textToken(paragraph.text)],
      },
    ],
    rest.slice(paragraph.raw.length),
    WINDOW_LINES,
  )
}

/** Official `ee=(e,t)`. */
function paragraphOrGiveUp(
  markedInstance: Marked,
  rest: string,
): WindowState {
  return isBoundedLheading(rest)
    ? giveUpAsParagraph(rest)
    : takeParagraph(markedInstance, rest)
}

/** Official `xe(e,t,n)` — how much of `rest` the first `count` taken tokens
 * account for (exact prefix, or rest minus a matched suffix); 0 = no fit. */
function takenPrefixLength(
  tokens: Token[],
  count: number,
  rest: string,
): number {
  const prefix = joinRaw(tokens.slice(0, count))
  const suffix = joinRaw(tokens.slice(count))
  const exact =
    prefix.length + suffix.length === rest.length || rest.startsWith(prefix)
  const endsWithSuffix = rest.endsWith(suffix)
  return exact ? prefix.length : endsWithSuffix ? rest.length - suffix.length : 0
}

/** Official `cNo=(e,t)` — exported parity helper: do the token raws join to
 * exactly `text`? */
export function takenRawEquals(tokens: Token[], text: string): boolean {
  return joinRaw(tokens) === text
}

/** Official `dNo(e,t,n)` — exported parity helper: prefix length at an
 * explicit split index. */
export function prefixLengthAtIndex(
  tokens: Token[],
  count: number,
  rest: string,
): number {
  const prefix = joinRaw(tokens.slice(0, count))
  const suffix = joinRaw(tokens.slice(count))
  const endsWithSuffix = rest.endsWith(suffix)
  return rest.startsWith(prefix)
    ? prefix.length
    : endsWithSuffix
      ? rest.length - suffix.length
      : 0
}

/** Official `mt(e)` — boundary index: the last non-space token when it is a
 * list, else the last non-space index (floor 0). */
function lastContentBoundary(tokens: Token[]): number {
  const last = tokens.findLastIndex(_ => _.raw.trim() !== '')
  return isList(tokens[last])
    ? last
    : Math.max(tokens.findLastIndex(isNotSpace), 0)
}

/** Official `ht(e,t)` — trim the taken count so at most NEWLINE_LIMIT
 * newlines are consumed per window, preferring a blank-separated boundary. */
function limitToLastNewlines(tokens: Token[], window: string): number {
  const boundary = lastContentBoundary(tokens)
  const floor =
    tokens.findLastIndex((_, i) => i < boundary && isBlankSeparated(_)) + 1
  let best = boundary
  let newlines = 0
  for (
    let i = tokens.length - 1;
    i >= floor && newlines <= NEWLINE_LIMIT;
    i--
  ) {
    newlines += countOccurrences(tokens[i]?.raw ?? '', '\n')
    best = newlines <= NEWLINE_LIMIT ? Math.min(best, i) : best
  }
  return (
    [floor, best].find(i => takenPrefixLength(tokens, i, window) > 0) ?? 0
  )
}

/** Official `ot(e)` — the texts of a token that can carry an oversized line. */
function tokenTexts(token: Token): string[] {
  const hasText =
    (isParagraph(token) || token.type === 'heading' || token.type === 'text') &&
    'text' in token &&
    typeof (token as { text?: unknown }).text === 'string'
  return isTable(token)
    ? [token.raw]
    : hasText
      ? [(token as { text: string }).text]
      : []
}

/** Official `st(e,t)` — does the window force an oversized line somewhere in
 * the token tree (any descendant's text/raw)? */
function windowForcesOversized(
  markedInstance: Marked,
  window: string,
): boolean {
  let tokens = hasOversizedLine(window)
    ? new Lexer(markedInstance.defaults).blockTokens(window)
    : []
  let found = false
  while (!found && tokens.length > 0) {
    found = tokens.some(_ => tokenTexts(_).some(hasOversizedLine))
    tokens = tokens.flatMap(childTokens)
  }
  return found
}

/** Official `gt(e,t)` — how many chars of `chunk` extend the table match. */
function appendedRowsLength(header: string, chunk: string): number {
  const matched = (BLOCK_GFM.table.exec(header + chunk)?.[0] ?? header).slice(
    header.length,
  )
  const trimmed = matched.replace(TRAILING_NEWLINES, '')
  return trimmed !== '' && matched.length > trimmed.length
    ? trimmed.length + 1
    : trimmed.length
}

/** Official `dt(e,t)` — end index of the table rows region in `rest`. */
function tableRowsEnd(header: string, rest: string): number {
  let end = header.length
  let growing = end < rest.length
  while (growing) {
    const chunk = rest.slice(end, lineSpanEnd(rest, end, WINDOW_LINES))
    const added = appendedRowsLength(header, chunk)
    end += added
    growing = added === chunk.length && end < rest.length
  }
  return end
}

/** Official `ft(e,t,n,r)` — the windowed table declined: fall back to a
 * paragraph step and carry a `declining` continuation so subsequent windows
 * recognize the still-growing table rows. */
function declineTable(
  markedInstance: Marked,
  header: string,
  rows: string[],
  rest: string,
): StepResult {
  const base = paragraphOrGiveUp(markedInstance, rest)
  const offset = header.length + rows.join('').length
  const short = rest.length - base.rest.length < offset
  const lastRowLines = short ? sliceRows(rows.at(-1) ?? '', 1) : []
  const maxLines = Math.floor(MAX_LINE_CHARS / header.length)
  const probeLines = lastRowLines.slice(0, maxLines)
  const firstBad = probeLines.findIndex(
    line => !singleTableToken(markedInstance, header + line),
  )
  const keep =
    firstBad >= 0
      ? firstBad
      : probeLines.length < lastRowLines.length
        ? probeLines.length
        : 0
  const fromRow = rest.slice(offset - probeLines.slice(keep).join('').length)
  return {
    ...base,
    declining: short ? { header, fromRow } : undefined,
  }
}

/** Official `pt(e,t,n)` — lex a growing table one row at a time inside the
 * window. */
function windowTable(
  markedInstance: Marked,
  tableToken: Tokens.Table,
  rest: string,
): StepResult {
  const header = headerRows(tableToken.raw)
  const rowsEnd = tableRowsEnd(header, rest)
  const rows = sliceRows(rest.slice(header.length, rowsEnd), WINDOW_LINES)
  const taken: Tokens.Table[] = []
  let exhausted = false
  while (!exhausted && taken.length < rows.length) {
    const token = singleTableToken(
      markedInstance,
      header + (rows[taken.length] ?? ''),
    )
    exhausted = token === undefined
    if (token) taken.push(token)
  }
  const consumedRaw =
    rest.slice(0, rowsEnd) + (LEADING_NEWLINES.exec(rest.slice(rowsEnd))?.[0] ?? '')
  return exhausted
    ? declineTable(markedInstance, header, rows.slice(0, taken.length + 1), rest)
    : makeWindow(
        [
          tableWithRows(
            tableToken,
            consumedRaw,
            taken.flatMap(_ => _.rows),
          ),
        ],
        rest.slice(consumedRaw.length),
        WINDOW_LINES,
      )
}

/** Official `ct(e,t)` — a lone list token: take all but its last item and
 * re-lex the rest later. */
function shrinkListWindow(
  state: WindowState,
  listToken: Tokens.List,
): WindowState {
  const items = listToken.items.slice(0, -1)
  const raw = joinRaw(items)
  return raw !== '' && state.rest.startsWith(raw)
    ? makeWindow(
        [listWithItems(listToken, raw, items)],
        state.rest.slice(raw.length),
        state.lines,
      )
    : giveUpAsParagraph(state.rest)
}

/** Official `at(e,t)` — give-up step: grow the window, shrink a lone list,
 * advance past the window, or fold the rest into one paragraph. */
function giveUpWindow(state: WindowState, tokens: Token[]): StepResult {
  const [first] = tokens
  const noContentBefore = tokens.findLastIndex(isNotSpace) <= 0
  const blankSeparated = noContentBefore && tokens.some(isBlankSeparated)
  const canGrow =
    state.lines < GIVEUP_WINDOW_LINES &&
    !(blankSeparated && isParagraph(first))
  const shrinkList = noContentBefore && isList(first)
  const advance =
    noContentBefore &&
    (first?.type === 'code' || (blankSeparated && first?.type !== 'html'))
  if (canGrow) return makeWindow([], state.rest, GIVEUP_WINDOW_LINES)
  if (shrinkList) return shrinkListWindow(state, first)
  if (advance) {
    return makeWindow(tokens, restAfterWindow(state), state.lines)
  }
  return giveUpAsParagraph(state.rest)
}

/** Official `lt(e,t,n)` — the window didn't lex cleanly: pick the recovery
 * path (paragraph / declining table / row-wise table / give-up). */
function fallbackWindow(
  markedInstance: Marked,
  state: StepResult,
  tokens: Token[],
): StepResult {
  const [first] = tokens
  const only = tokens.length === 1
  const paragraphNoHeading =
    only && isParagraph(first) && !isBoundedLheading(state.rest)
  const onlyTable = only && isTable(first)
  const header = headerRows(first?.raw ?? '')
  const fromRow = state.declining?.fromRow ?? state.rest
  const tableContinues =
    onlyTable &&
    header.length + fromRow.length <= state.rest.length &&
    // Official: `!te(e, l + c.slice(0, C(c, 0, 1)))` — header + FIRST line.
    !singleTableToken(
      markedInstance,
      header + fromRow.slice(0, lineSpanEnd(fromRow, 0, 1)),
    )
  if (paragraphNoHeading) return takeParagraph(markedInstance, state.rest)
  if (tableContinues) return paragraphOrGiveUp(markedInstance, state.rest)
  if (onlyTable) {
    return windowTable(markedInstance, first as Tokens.Table, state.rest)
  }
  return giveUpWindow(state, tokens)
}

/** Official `it(e,t,n)` — lex the window; keep the tokens that account for a
 * clean prefix of `rest`. */
function lexWindow(
  markedInstance: Marked,
  state: StepResult,
  window: string,
): StepResult {
  const tokens = markedInstance.lexer(window)
  const count =
    window.length === state.rest.length
      ? tokens.length
      : limitToLastNewlines(tokens, window)
  const prefixLen = takenPrefixLength(tokens, count, window)
  return prefixLen > 0
    ? makeWindow(tokens.slice(0, count), state.rest.slice(prefixLen), WINDOW_LINES)
    : fallbackWindow(markedInstance, state, tokens)
}

/** Official `rt(e,t)` — one window step. */
function stepWindow(
  markedInstance: Marked,
  state: StepResult,
): StepResult {
  const window = windowSlice(state)
  const { header = '', fromRow = state.rest } = state.declining ?? {}
  const continuesTable =
    window.length + fromRow.length <= state.rest.length &&
    window.startsWith(header)
  if (windowForcesOversized(markedInstance, window)) {
    return giveUpAsParagraph(state.rest)
  }
  return continuesTable
    ? paragraphOrGiveUp(markedInstance, state.rest)
    : lexWindow(markedInstance, state, window)
}

/** Official `nt(e,t)` — the windowed lex loop. */
export function windowedLex(
  markedInstance: Marked,
  text: string,
): Token[] {
  const out: Token[] = []
  let state: StepResult = makeWindow([], text.replace(CRLF, '\n'), WINDOW_LINES)
  while (state.rest !== '') {
    state = { declining: state.declining, ...stepWindow(markedInstance, state) }
    for (const token of state.taken) {
      const last = out.at(-1)
      // Official merges adjacent space tokens in place (the only mutation in
      // the region; both tokens are fresh lex output, not shared state).
      if (last?.type === 'space' && token.type === 'space') {
        ;(last as Tokens.Space).raw += token.raw
      } else {
        out.push(token)
      }
    }
  }
  return out
}

/** Official `y4n(e)` — mark every token (BFS through children) `windowed`;
 * links additionally `defanged`. */
export function markWindowed(tokens: Token[]): Token[] {
  const stack = [...tokens]
  for (let token = stack.pop(); token !== undefined; token = stack.pop()) {
    const isLink = token.type === 'link'
    Object.assign(token, isLink ? { windowed: true, defanged: true } : { windowed: true })
    for (const child of childTokens(token)) stack.push(child)
  }
  return tokens
}

/** Official `sXe(e)` — is whole-text lexing safe (first window covers
 * everything AND no oversized line after the first fence match)? */
export function isWholeTextSafe(text: string): boolean {
  const normalized = text.replace(CRLF, '\n')
  return (
    windowSlice(makeWindow([], normalized, WINDOW_LINES)).length ===
      normalized.length &&
    !hasOversizedLine(
      normalized.slice(BLOCK_GFM.fences.exec(normalized)?.[0].length ?? 0),
    )
  )
}

/** Official `iXe=(e,t)` — the v295 entry: whole-text lexer when safe,
 * otherwise the hold-guarded windowed lex with every token marked. */
export function lexWithWindowing(
  markedInstance: Marked,
  text: string,
): Token[] {
  return isWholeTextSafe(text)
    ? markedInstance.lexer(text)
    : markWindowed(lheadingHold.during(() => windowedLex(markedInstance, text)))
}
