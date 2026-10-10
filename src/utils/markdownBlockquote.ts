import chalk from 'chalk'
import type { Token } from 'marked'
import stripAnsi from 'strip-ansi'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'

/**
 * CC 2.1.295 changelog #067 — windowed blockquote renderer.
 *
 * Official changelog: "Fixed replies whose quotes nest deeper every few lines
 * freezing the terminal for seconds and using gigabytes of memory."
 *
 * Byte-faithful port of the v295 blockquote region recovered from the
 * official 2.1.295 linux-x64 binary (markdown module; beautified verbatim in
 * /tmp/cc-153/md_v295_pretty.js lines 315-340).
 *
 * Mechanism: the pre-v295 renderer (still OCC's old blockquote case in
 * markdown.ts before this port) rendered a nested blockquote by rendering
 * its children, then splitting EVERY line and re-prefixing a bar per level —
 * O(depth × lines) string re-joins per level, i.e. quadratic in nesting
 * depth. A reply that gains one `>` every few lines nests hundreds deep and
 * froze the terminal for seconds while allocating gigabytes of intermediate
 * strings. The v295 renderer works on ROW GROUPS ({rows, isDone}) instead:
 * - depth < CLASSIC_QUOTE_DEPTH_LIMIT (6): classic per-line dim-bar + italic
 *   (official `Nt`) — byte-identical output to the old single-level render,
 *   EXCEPT blank lines now pass through unchanged (official behavior; OCC's
 *   old blank→bar divergence is resolved by this port).
 * - depth >= 6: ONE-SHOT capped prefix (official `Ot`) — all ancestor bars
 *   are drawn at once (capped at MAX_QUOTE_BARS=16), and the group is marked
 *   `isDone` so ancestors pass it through untouched. No per-level re-split.
 *
 * Symbol map (official minified → OCC):
 *   _t=CLASSIC_QUOTE_DEPTH_LIMIT(6)  At=MAX_QUOTE_BARS(16)  W=NL('\n')
 *   ie=openGroup  Oe=ensureTrailingNewline  Ae=closedGroups  Ce=hasVisibleText
 *   Nt=renderClassicQuoteRows  Ne=barPrefix  Ot=renderCappedQuoteRows
 *   Ct=flattenGroups  Pe=renderQuoteLevel  Me=renderBlockquoteWindowed
 *   ge=chalk  dn=stripAnsi  _Eo=BLOCKQUOTE_BAR
 */

/** Official `_t` — depths below this render the classic per-line style. */
export const CLASSIC_QUOTE_DEPTH_LIMIT = 6
/** Official `At` — hard cap on drawn bar count at deep levels. */
export const MAX_QUOTE_BARS = 16

const NL = '\n'

/** Official `{rows, isDone}` — a group of rendered lines. `isDone` groups
 * are complete (already bar-prefixed) and pass through ancestor levels
 * untouched. */
export type RowGroup = { rows: string; isDone: boolean }

/** Official render context: `around` = the depth the render started at
 * (bars already drawn by ancestors), `draw` = child-token renderer. */
export type QuoteContext = {
  around: number
  draw: (token: Token, depth: number) => string
}

/** Official `ie=(e)=>({rows:e,isDone:!1})`. */
const openGroup = (rows: string): RowGroup => ({ rows, isDone: false })

/** Official `Oe`. */
const ensureTrailingNewline = (text: string): string =>
  text === '' || text.endsWith(NL) ? text : text + NL

/** Official `Ae=(e)=>e===""?[]:[ie(e)]`. */
const closedGroups = (text: string): RowGroup[] =>
  text === '' ? [] : [openGroup(text)]

/** Official `Ce=(e)=>dn(e).trim()!==""`. */
const hasVisibleText = (text: string): boolean =>
  stripAnsi(text).trim() !== ''

/** Official `Nt(e)` — classic depth render: per-line dim bar + italic;
 * blank lines pass through unchanged. */
export function renderClassicQuoteRows(rows: string): RowGroup {
  const bar = chalk.dim(BLOCKQUOTE_BAR)
  return openGroup(
    rows
      .split(NL)
      .map(line =>
        hasVisibleText(line) ? `${bar} ${chalk.italic(line)}` : line,
      )
      .join(NL),
  )
}

/** Official `Ne(e)` — `count` bars as one dim prefix (trailing space when
 * non-empty). */
function barPrefix(count: number): string {
  const bars = `${BLOCKQUOTE_BAR} `.repeat(Math.max(0, count)).trimEnd()
  return bars === '' ? '' : `${chalk.dim(bars)} `
}

/** Official `Ot(e,t,n)` — deep-level one-shot render: draw all remaining
 * bars (capped) once; only the outermost level (around===0) italics the text. */
function renderCappedQuoteRows(rows: string, depth: number, ctx: QuoteContext): RowGroup {
  const extra = Math.min(depth + 1, MAX_QUOTE_BARS) - ctx.around
  const isOuter = ctx.around === 0
  const outer = barPrefix(isOuter ? 1 : extra)
  const inner = barPrefix(isOuter ? extra - 1 : 0)
  const style = isOuter ? chalk.italic : (text: string) => text
  return {
    rows: ensureTrailingNewline(rows)
      .split(NL)
      .map(line => (hasVisibleText(line) ? outer + style(inner + line) : line))
      .join(NL),
    isDone: true,
  }
}

/** Official `Ct(e)` — flush pending open rows around each done group. */
function flattenGroups(groups: RowGroup[]): RowGroup[] {
  const out: RowGroup[] = []
  let pending = ''
  for (const group of groups) {
    if (group.isDone) {
      out.push(...closedGroups(ensureTrailingNewline(pending)), group)
      pending = ''
    } else {
      pending += group.rows
    }
  }
  return [...out, ...closedGroups(pending)]
}

/** Official `Pe(e,t,n)` — recurse blockquote children; non-blockquote
 * children render via `draw` at depth+1. */
function renderQuoteLevel(
  tokens: Token[],
  depth: number,
  ctx: QuoteContext,
): RowGroup[] {
  const style =
    depth < CLASSIC_QUOTE_DEPTH_LIMIT
      ? renderClassicQuoteRows
      : (rows: string) => renderCappedQuoteRows(rows, depth, ctx)
  return flattenGroups(
    tokens.flatMap(token =>
      token.type === 'blockquote'
        ? renderQuoteLevel(token.tokens ?? [], depth + 1, ctx)
        : [openGroup(ctx.draw(token, depth + 1))],
    ),
  ).map(group => (group.isDone ? group : style(group.rows)))
}

/** Official `Me=(e,t,n)=>Pe(e,t,{around:t,draw:n}).map((r)=>r.rows).join("")`
 * — the blockquote case entry: render a blockquote's child tokens nested
 * `around` levels deep. */
export function renderBlockquoteWindowed(
  tokens: Token[],
  around: number,
  draw: QuoteContext['draw'],
): string {
  return renderQuoteLevel(tokens, around, { around, draw })
    .map(group => group.rows)
    .join('')
}
