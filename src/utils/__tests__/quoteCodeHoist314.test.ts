import { describe, expect, test } from 'bun:test'
import type { Token, Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { applyMarkdown } from '../markdown.ts'
import {
  hoistQuoteOpeningBlock,
  renderBlockquoteWindowed,
} from '../markdownBlockquote.ts'

/**
 * CC 2.1.314 changelog #47 — "Fixed blank lines at the top of a code block
 * disappearing when the code block opens a quote."
 *
 * Official v314 evidence (byte-verified against the 2.1.314 linux-x64 ELF):
 *   - Hoist detector `Ve(e,t)` + `ELt(e,t)` @259564600 region (v314):
 *       function Ve(e,t){switch(e.type){case"space":return!0;case"code":
 *         return e.text===""&&(!e.lang||t?.supportsLanguage(e.lang)===!0);
 *         case"heading":return e.text==="";case"blockquote":
 *         return(e.tokens??[]).every((n)=>Ve(n,t));default:return!1}}
 *       function ELt(e,t){let n=e.tokens.findIndex((s)=>!Ve(s,t)),
 *         r=e.tokens[n],o=r?.type==="blockquote"?ELt(r,t):r?.type==="code"?r:
 *         void 0;return o&&{...e,tokens:[o,...e.tokens.slice(n+1)]}}
 *   - v312 counterpart `Ye(e)` @254948700 region (the pre-fix detector):
 *       function Ye(e){let t=e.tokens.findIndex((s)=>s.type!=="space"&&
 *         !(s.type==="code"&&s.text===""&&!s.lang)),n=e.tokens[t],
 *         r=n?.type==="blockquote"?Ye(n):n?.type==="code"&&n.text!==""?n:
 *         void 0;return r&&{...e,tokens:[r,...e.tokens.slice(t+1)]}}
 *   - Fix sites (v314): the blockquote component `Eo` renders
 *       `U=he.italic((E?L:L.replace(/^\n+/,"")).trimEnd())`  (E=ELt(p,m))
 *     where v312's `yo` had the UNCONDITIONAL strip
 *       `v=he.italic(H.map(Xs).join("").replace(/^\n+/,"").trimEnd())`;
 *     the list renderer `js` gates `(D?G:G.replace(/^\n+/,"")).trimEnd()`
 *     with `D=M.type==="blockquote"?ELt(M,c):void 0`; and formatToken's
 *     list_item per-child gate `x.type==="blockquote"&&G===void 0||x.type===
 *     "hr"||x.type==="table"?N.replace(/^\n+/,""):N` upgrades `Ye`→`ELt`.
 *
 * OCC seam: OCC renders assistant markdown through the official STRING path
 * (formatToken/renderBlockquoteWindowed) wrapped by Markdown.tsx's ANSI
 * batching — it has no port of the `Eo`/`js` components. The string path's
 * bar renderer already passes blank lines through unprefixed (official Nt,
 * byte-identical v312≡v314), so the code token's leading "\n" survives
 * rendering; what ate it in OCC were the unconditional leading-whitespace
 * strips: MarkdownBody's `nonTableContent.trim()` flush and list_item's
 * whole-join `.replace(/^(?:[ \t]*\n)+/,"")` (#084 adaptation). This port
 * adds the grounded `Ve`/`ELt` detector and gates those strips on it —
 * the component-path fix adapted to OCC's string-path architecture.
 * applyMarkdown's entry `.trim()` stays unconditional (official string entry
 * `TNt` = `.join("").trim()` in both versions — unfixed by design).
 */

const THEME = 'dark' as const

/** marked token factory helpers (hand-built tokens — pure detector tests). */
const code = (text: string, lang = ''): Tokens.Code =>
  ({ type: 'code', raw: '', text, lang, codeBlockStyle: undefined }) as Tokens.Code
const para = (text: string): Tokens.Paragraph =>
  ({ type: 'paragraph', raw: '', text, tokens: [] }) as unknown as Tokens.Paragraph
const space = (): Tokens.Space => ({ type: 'space', raw: '\n' }) as Tokens.Space
const heading = (text: string): Tokens.Heading =>
  ({ type: 'heading', raw: '', depth: 1, text, tokens: [] }) as unknown as Tokens.Heading
const quote = (...tokens: Token[]): Tokens.Blockquote =>
  ({ type: 'blockquote', raw: '', tokens }) as Tokens.Blockquote

describe('2.1.314 #47 hoistQuoteOpeningBlock (official Ve/ELt detector)', () => {
  test('hoists when the quote opens with a code block', () => {
    const q = quote(code('\ncode'))
    const hoisted = hoistQuoteOpeningBlock(q, null)
    expect(hoisted).toBeDefined()
    expect(hoisted?.tokens[0]?.type).toBe('code')
  })

  test('returns undefined when the quote opens with a paragraph (strip stays)', () => {
    expect(hoistQuoteOpeningBlock(quote(para('text')), null)).toBeUndefined()
  })

  test('skips space tokens before the opening code block and drops them', () => {
    const q = quote(space(), code('\ncode'), para('after'))
    const hoisted = hoistQuoteOpeningBlock(q, null)
    expect(hoisted).toBeDefined()
    // Official ELt rebuild: {...e, tokens:[o,...e.tokens.slice(n+1)]}
    expect(hoisted?.tokens.map(t => t.type)).toEqual(['code', 'paragraph'])
  })

  test('recurses into a nested opening blockquote', () => {
    const q = quote(quote(code('\ncode')))
    const hoisted = hoistQuoteOpeningBlock(q, null)
    expect(hoisted).toBeDefined()
    expect(hoisted?.tokens[0]?.type).toBe('blockquote')
  })

  test('skips empty headings (official Ve case"heading": text==="")', () => {
    const q = quote(heading(''), code('\ncode'))
    expect(hoistQuoteOpeningBlock(q, null)).toBeDefined()
  })

  test('empty lang-less code counts as empty (Ve case"code" text==="")', () => {
    // First NON-empty token decides: the empty code is skipped, paragraph
    // ends the scan → no hoist.
    const q = quote(code(''), para('text'))
    expect(hoistQuoteOpeningBlock(q, null)).toBeUndefined()
  })

  test('empty code WITH a lang needs highlight.supportsLanguage === true to count as empty', () => {
    // Official Ve: e.text===""&&(!e.lang||t?.supportsLanguage(e.lang)===!0).
    // Without a highlighter the lang'd empty code is NOT empty → it is the
    // first non-empty token and (being code) hoists.
    const q = quote(code('', 'js'), para('text'))
    expect(hoistQuoteOpeningBlock(q, null)).toBeDefined()
    const supporting = { supportsLanguage: (_: string) => true }
    expect(hoistQuoteOpeningBlock(q, supporting)).toBeUndefined()
    const rejecting = { supportsLanguage: (_: string) => false }
    expect(hoistQuoteOpeningBlock(q, rejecting)).toBeDefined()
  })

  test('all-empty nested quote counts as empty (Ve case"blockquote" every)', () => {
    const q = quote(quote(space(), heading('')), code('\ncode'))
    expect(hoistQuoteOpeningBlock(q, null)).toBeDefined()
  })

  test('quote of only empty tokens → undefined (findIndex -1)', () => {
    expect(hoistQuoteOpeningBlock(quote(space(), code('')), null)).toBeUndefined()
  })
})

describe('2.1.314 #47 string path — leading blank line of an opening code block', () => {
  test('renderBlockquoteWindowed passes the code token leading newline through (unchanged official Nt behavior)', () => {
    // The bar renderer itself is byte-identical v312≡v314 — blank lines pass
    // through unprefixed. This pins that the "\n" is present pre-trim.
    const out = renderBlockquoteWindowed(
      [code('\ncode')],
      0,
      (t: Token) => (t.type === 'code' ? `${t.text}\n` : ''),
    )
    expect(out.startsWith('\n')).toBe(true)
  })

  test('list_item keeps the leading blank line when the item opens with a hoisted code quote', () => {
    // Official v314 formatToken list_item gate: a blockquote child with an
    // ELt hoist does NOT get its leading newlines stripped. The #084
    // whole-join strip must not eat it either.
    const out = stripAnsi(
      applyMarkdown('para\n\n- > ```\n  >\n  > code\n  > ```\n', THEME),
    )
    expect(out).toBe('para\n\n\n▎ code')
  })

  test('list_item #084 strip still applies to non-quote leading blank lines', () => {
    // Regression guard: the CC 2.1.281 #084 pinned behavior is untouched.
    const out = stripAnsi(applyMarkdown('1.\n   text on next line\n', THEME))
    expect(out).toBe('1. text on next line')
  })

  test('plain quote (paragraph first) is unchanged', () => {
    const out = stripAnsi(applyMarkdown('> text\n>\n> more', THEME))
    expect(out).toBe('▎ text\n\n▎ more')
  })
})
