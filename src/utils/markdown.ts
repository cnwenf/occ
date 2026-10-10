import chalk from 'chalk'
import { marked, Tokenizer, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { color } from '../components/design-system/color.js'
import { stringWidth } from '../ink/stringWidth.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import type { CliHighlight } from './cliHighlight.js'
import { logForDebugging } from './debug.js'
import { createHyperlink } from './hyperlink.js'
import { renderBlockquoteWindowed } from './markdownBlockquote.js'
import {
  markdownLexGuard,
  maxNestingFallbackToken,
} from './markdownLexLevel.js'
import {
  afterStyleReset,
  sanitizeMarkdownTokens,
  shownAddress,
  shownAddressWithTitle,
  stripRenderInvisible,
} from './markdownSanitize.js'
import {
  lheadingMatchesOverride,
  lexWithWindowing,
  type WindowedToken,
} from './markdownWindowed.js'
import { stripPromptXMLTags } from './messages.js'
import type { ThemeName } from './theme.js'

// Use \n unconditionally — os.EOL is \r\n on Windows, and the extra \r
// breaks the character-to-segment mapping in applyStylesToWrappedText,
// causing styled text to shift right.
const EOL = '\n'

/**
 * CC 2.1.295 #031 — official mailto detector `/^mailto:/i` @220900053 (the link
 * case). Case-insensitive per the official binary, so `MAILTO:` is handled the
 * same as `mailto:`; the pre-port OCC check was a case-sensitive
 * `startsWith('mailto:')`.
 */
const MAILTO_SCHEME = /^mailto:/i

/**
 * CC 2.1.290 render-catch fallback message — byte-exact from the official
 * 2.1.290 linux-x64 binary string table (em-dash U+2014, verified via the
 * UTF-8 bytes e2 80 94):
 * "markdown rendering exceeded the stack — input is too deeply nested"
 */
export const MARKDOWN_STACK_FALLBACK_MESSAGE =
  'markdown rendering exceeded the stack — input is too deeply nested'

// CC 2.1.290 guard (official `z` extension @216038583): the blockquote/list/
// emStrong wrappers call the PRISTINE prototype tokenizers captured here.
// `marked.use({tokenizer})` wraps the default tokenizer instance (not the
// prototype), and the wrapper's `false` return makes marked fall through to
// that instance's own method — which is the wrapped one — so capturing the
// prototype originals keeps the guard wrappers from recursing into themselves.
// Official: `se/oe/ie = AIe.prototype.{blockquote,list,emStrong}`.
const originalBlockquote = Tokenizer.prototype.blockquote
const originalList = Tokenizer.prototype.list
const originalEmStrong = Tokenizer.prototype.emStrong

let markedConfigured = false

export function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true

  marked.use({
    tokenizer: {
      // Disable strikethrough parsing - the model often uses ~ for "approximate"
      // (e.g., ~100) and rarely intends actual strikethrough formatting.
      // (The official 290 `z` extension replaces `del` with a strict custom
      // `~~...~~` tokenizer; OCC keeps its documented disable divergence —
      // out of scope for this guard port.)
      del() {
        return undefined
      },
      // CC 2.1.290 cluster E item #1 — depth-guarded recursive tokenizers.
      // Official verbatim (@216038583):
      //   blockquote(e){return this.rules.other.blockquoteStart.test(e)
      //     ?w.lexLevel(this.lexer,()=>se.call(this,e)):void 0}
      blockquote(src) {
        return this.rules.other.blockquoteStart.test(src)
          ? markdownLexGuard.lexLevel(this.lexer, () =>
              originalBlockquote.call(this, src),
            )
          : undefined
      },
      //   list(e){return this.rules.block.list.test(e)
      //     ?w.lexLevel(this.lexer,()=>oe.call(this,e)):void 0}
      list(src) {
        return this.rules.block.list.test(src)
          ? markdownLexGuard.lexLevel(this.lexer, () =>
              originalList.call(this, src),
            )
          : undefined
      },
      //   emStrong(e,t,n){return this.rules.inline.emStrongLDelim.test(e)
      //     ?w.lexLevel(this.lexer,()=>ie.call(this,e,t,n)):void 0}
      emStrong(src, maskedSrc, prevChar) {
        return this.rules.inline.emStrongLDelim.test(src)
          ? markdownLexGuard.lexLevel(this.lexer, () =>
              originalEmStrong.call(this, src, maskedSrc, prevChar),
            )
          : undefined
      },
      // CC 2.1.295 changelog #056 — bounded lheading while windowed-lexing.
      // Official verbatim (Ke extension, md_v295_pretty.js:433):
      //   lheading(e){return(J.isHeld()?Y.test(e):be.test(e))?!1:void0}
      // `false` = fall through to marked's original tokenizer; `undefined` =
      // no token (marked moves to the next rule). While the windowed lexer's
      // hold counter is up, the test is the {1,100}-bounded regex so a huge
      // non-heading can't backtrack `(?:[^\n]+\n)+?`; when not held the test
      // is marked's original regex, so behavior is identical to having no
      // override at all.
      lheading(src) {
        return lheadingMatchesOverride(src) ? false : undefined
      },
      // At-cap flattening fallback. Official verbatim:
      //   paragraph(e){let t=B(this,e);return t?{type:"paragraph",...t}:!1}
      //   text(e){let t=B(this,e);return t?{type:"text",...t}:!1}
      // `false` = marked's "fall through to the original tokenizer" signal;
      // B short-circuits on a cheap WeakMap read when below the cap.
      paragraph(src) {
        const flat = maxNestingFallbackToken(this, src)
        return flat ? { type: 'paragraph', ...flat } : false
      },
      text(src) {
        const flat = maxNestingFallbackToken(this, src)
        return flat ? { type: 'text', ...flat } : false
      },
    },
  })
}

export function applyMarkdown(
  content: string,
  theme: ThemeName,
  highlight: CliHighlight | null = null,
): string {
  configureMarked()
  try {
    // CC 2.1.295 changelog #056 + #050/#031 — official TNt entry @220898004:
    //   TNt(e,t,n){Wft();let r=qK(e),s=sXe(r)&&ow();
    //     return Ecn(iXe(Em,r)).map((o)=>PH(o,t,{...,linkCap:s})).join("").trim()}
    // The whole-text `marked.lexer` call is replaced by the windowed entry
    // (`iXe` → lexWithWindowing); `Ecn` → sanitizeMarkdownTokens wraps that lex
    // BEFORE rendering (#050: raw OSC 8 hyperlink bytes in a reply or a
    // teammate's message are neutralized to inert text on BOTH the windowed and
    // the whole-text-safe path — `Ecn` wraps `iXe`, which covers both); and every
    // top-level token renders through the PH wrapper. The official's linkCap
    // (`s=sXe(r)&&ow()` → the `qt` scheme validator) is a separate feature and
    // stays STAGED (see the port report).
    return sanitizeMarkdownTokens(
      lexWithWindowing(marked, stripPromptXMLTags(content)),
    )
      .map(_ => renderTokenWindowed(_, theme, highlight, 0))
      .join('')
      .trim()
  } catch (error) {
    // CC 2.1.290 render catch: a stack overflow anywhere in lex/format
    // degrades to the official fallback message as plain text instead of
    // crashing the caller. RangeError ONLY — every other error rethrows.
    if (error instanceof RangeError) {
      return MARKDOWN_STACK_FALLBACK_MESSAGE
    }
    throw error
  }
}

// CC 2.1.295 changelog #056 — official PH wrapper regexes
// (md_v295_pretty.js:346, verbatim):
//   Ue=/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g
//   Mt=/\x9d|\x1b(?!\[)/   Dt=/\x9d/g   Wt=/\x1b(?!\[)/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `Ue` — the OSC 8 ESC/BEL bytes ARE the wrapper's match target
const OSC8_SEQUENCE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `Mt` — the C1/bare-ESC control bytes ARE the wrapper's match target
const WINDOWED_CONTROL_TEST = /\x9d|\x1b(?!\[)/
const C1_OSC_TERMINATOR = /\x9d/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `Wt` — the bare-ESC control byte IS the wrapper's match target
const BARE_ESCAPE = /\x1b(?!\[)/g

/**
 * Official `PH(e,t,n)` — render one token; when it came from the windowed
 * lexer (`windowed:true`) and its rendered output carries OSC8 / C1 /
 * bare-ESC bytes (raw source the normal inline path would have consumed),
 * strip them. Applied at the official's two PH sites: the top-level entry
 * map and the blockquote `draw` callback.
 */
function renderTokenWindowed(
  token: Token,
  theme: ThemeName,
  highlight: CliHighlight | null,
  quotesAround: number,
): string {
  const rendered = formatToken(
    token,
    theme,
    0,
    null,
    null,
    highlight,
    null,
    quotesAround,
  )
  return 'windowed' in token &&
    (token as WindowedToken).windowed === true &&
    WINDOWED_CONTROL_TEST.test(rendered)
    ? rendered
        .replace(OSC8_SEQUENCE, '')
        .replace(C1_OSC_TERMINATOR, '')
        .replace(BARE_ESCAPE, '')
    : rendered
}

/**
 * Domain bounds of an ordered list, mirrored from the official v281 `a6n`
 * @205766744 region (`{first: e.start === "" ? 1 : e.start,
 * last: first + e.items.length - 1}`) — the letter/roman conversions in
 * getListNumber are only valid inside these bounds (official `ce` guards:
 * letters need first >= 1; romans need first >= 1 AND last <= 3999).
 */
export type OrderedListMeta = {
  first: number
  last: number
}

export function formatToken(
  token: Token,
  theme: ThemeName,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  highlight: CliHighlight | null = null,
  orderedListMeta: OrderedListMeta | null = null,
  // Official Ut option `quotesAround:w=0` (CC 2.1.295 #067): how many
  // blockquote levels an ancestor already drew bars for. Threaded through
  // list/list_item; consumed ONLY by the blockquote case as `around`.
  quotesAround = 0,
): string {
  switch (token.type) {
    case 'blockquote':
      // CC 2.1.295 changelog #067 — official case"blockquote":
      //   return Me(e.tokens??[], w, (u,f)=>PH(u,t,{listDepth:0,
      //     orderedListNumber:null, parent:null, highlight:i, glueProse:!1,
      //     linkCap:k, screenReader:c, promptMode:d, quotesAround:f}))
      // Row-group renderer: classic per-line dim-bar+italic below depth 6,
      // one-shot capped bar prefix (max 16) at depth >= 6 — no per-level
      // re-split/re-join blowup on deeply nested quotes. Blank lines pass
      // through unchanged (official Nt; resolves OCC's old blank→bar
      // divergence). linkCap/screenReader/promptMode are sanitize/UI-family
      // options OCC's serializer doesn't carry — reported, not invented.
      return renderBlockquoteWindowed(
        token.tokens ?? [],
        quotesAround,
        (child, depth) => renderTokenWindowed(child, theme, highlight, depth),
      )
    case 'code': {
      // CC 2.1.280 changelog #071: fenced code blocks that don't name a
      // language are colored like inline code. Official v280 @202965215
      // (formatToken case"code"; 0 hits in v278) prepends:
      //   let s=e.lang??"";if(!s&&e.codeBlockStyle!=="indented")
      //     return e.text.replace(/\S(?:.*\S)?/g,Et("permission",t))+T;
      // The regex paints each line's span from its first to its last
      // non-space char (`.` crosses spaces but not newlines) with the same
      // 'permission' theme color the codespan case uses below, preserving
      // leading/trailing whitespace (including newlines) around each span.
      // Indented blocks (marked sets codeBlockStyle:'indented' only for
      // those; fenced blocks have it undefined) fall through to the normal
      // path. Sits BEFORE the no-highlight early return, matching official
      // order.
      const lang = token.lang ?? ''
      if (!lang && token.codeBlockStyle !== 'indented') {
        return (
          token.text.replace(/\S(?:.*\S)?/g, color('permission', theme)) + EOL
        )
      }
      if (!highlight) {
        return token.text + EOL
      }
      let language = 'plaintext'
      if (token.lang) {
        if (highlight.supportsLanguage(token.lang)) {
          language = token.lang
        } else {
          logForDebugging(
            `Language not supported while highlighting code, falling back to plaintext: ${token.lang}`,
          )
        }
      }
      try {
        return highlight.highlight(token.text, { language }) + EOL
      } catch {
        // CC 2.1.289 changelog #2 — official v289 renderer catch (s289.txt
        // @37062551): `catch{return e.lang=null,[[D(t),i]]}` (v288 had no
        // memo). A block whose highlighting blew the budget (or threw for
        // any other reason) renders as plain text, and the lang=null memo
        // keeps subsequent renders of the SAME token from re-attempting it.
        // (OCC's cliHighlight wrapper already catches HighlightBoundError
        // centrally with a persistent cross-render failure memo; this mirrors
        // the official call-site catch for any other highlighter passed in.)
        token.lang = null
        return token.text + EOL
      }
    }
    case 'codespan': {
      // inline code
      return color('permission', theme)(token.text)
    }
    case 'em':
      return chalk.italic(
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, parent, highlight))
          .join(''),
      )
    case 'strong':
      return chalk.bold(
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, parent, highlight))
          .join(''),
      )
    case 'heading':
      switch (token.depth) {
        case 1: // h1
          return (
            chalk.bold.italic.underline(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        case 2: // h2
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        default: // h3+
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
      }
    case 'hr':
      return '---'
    case 'image': {
      // CC 2.1.295 #050/#031 — official case"image" @220900053 (verbatim):
      //   {if(!e.text&&!e.title)return De(e.href,X(e));
      //    let u=e.title?` "${e.title}"`:"",f=ue(e.href,X(e),u);
      //    return e.text?`${e.text}${f}`:f.replace(" (","(")}
      // The pre-port bare `return token.href` is replaced: an image address
      // drawn as text now carries the afterStyleReset (De/ue → Fe) so a colour
      // or conceal style a reply left open can no longer hide it (#031), and is
      // invisible-stripped (H).
      const styleReset = afterStyleReset(token) // X(e)
      if (!token.text && !token.title) {
        return shownAddress(token.href, styleReset) // De(e.href,X(e))
      }
      const titleSuffix = token.title ? ` "${token.title}"` : '' // u
      const address = shownAddressWithTitle(token.href, styleReset, titleSuffix) // f=ue(...)
      return token.text ? `${token.text}${address}` : address.replace(' (', '(')
    }
    case 'link': {
      // CC 2.1.295 #031 (+#050) — official case"link" @220900053+. The
      // #031-critical routing is ported: `T=X(e)` (afterStyleReset) is threaded
      // as createHyperlink's `shownUrlStart` so a style reset precedes any
      // address DRAWN AS TEXT, and an address shown as text is invisible-
      // stripped (H). The mailto branch is a faithful port (De/ue/H/X).
      // STAGED (beyond #031/#050 — the separate linkCap + defanged-marker
      // features, each needing infrastructure this port must not invent):
      //   • `qt` per-link scheme validator @220904589 (needs the lRn/Kz/qe/
      //     qoo/cfr URL subsystem) + `k` linkCap gate → OCC's `m` collapses to
      //     supportsHyperlinks() (createHyperlink's own gate).
      //   • `Ikr` claude.ai URL detection @207262927 and the `x&&S` branch.
      //   • `yEo`/`Qd` (U+29C9 TWO JOINED SQUARES) defanged-marker prefixing
      //     @208124049 and the `m&&S&&Z` title-as-drawn-address (`pe`) branch.
      //   • rw's fuller unsupported-terminal `${text}${reset} (${url})` form
      //     @220883281 (needs PBr url-matches-text @220883649 + the exact `dn`
      //     normalizer = Bun.stripANSI @206632589; OCC uses strip-ansi, an
      //     equivalent). See the port report for exact reasons + offsets.
      const styleReset = afterStyleReset(token) // T = X(e)
      const titleSuffix = token.title ? ` ("${token.title}")` : '' // u
      // Official mailto branch (verbatim):
      //   if(/^mailto:/i.test(e.href)){let I=e.href.replace(/^mailto:/i,""),F=X(e);
      //     return(e.text&&e.text!==H(I)?`${e.text}${ue(I,F)}`:De(I,F))+u}
      if (MAILTO_SCHEME.test(token.href)) {
        const email = token.href.replace(MAILTO_SCHEME, '') // I
        const strippedEmail = stripRenderInvisible(email) // H(I)
        const body =
          token.text && token.text !== strippedEmail
            ? `${token.text}${shownAddressWithTitle(email, styleReset)}` // ue(I,F)
            : shownAddress(email, styleReset) // De(I,F)
        return body + titleSuffix
      }
      // Extract display text from the link's child tokens (official `y`).
      const linkText = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, token, highlight))
        .join('')
      // Official `L=dn(y)`; `dn(e)=Bun.stripANSI(e)` @206632589 ≡ OCC's stripAnsi.
      const plainLinkText = stripAnsi(linkText)
      // Official `S=Boolean(L&&L!==e.href)` — text differs from the address.
      const hasMeaningfulText = Boolean(
        plainLinkText && plainLinkText !== token.href,
      )
      // OCC `m` analog: no linkCap/qt, so a link is hyperlinkable iff the
      // terminal supports OSC 8. Official `g=m?f:H(f??e.href)` — the address is
      // invisible-stripped only when it will be DRAWN AS TEXT (m false); an
      // OSC 8 target keeps the raw href so it reaches the link intact.
      const isHyperlinkable = supportsHyperlinks()
      const address = isHyperlinkable
        ? token.href
        : stripRenderInvisible(token.href)
      const hyperlinkOptions = {
        shownUrlStart: styleReset, // #031: reset before a drawn-as-text address
        supportsHyperlinks: isHyperlinkable,
      }
      const drawn = hasMeaningfulText
        ? createHyperlink(address, linkText, hyperlinkOptions)
        : createHyperlink(address, undefined, hyperlinkOptions)
      return drawn + titleSuffix
    }
    case 'list': {
      // Official v281 `a6n` @205766744: `{first: start === "" ? 1 : start,
      // last: first + items.length - 1}`. Threaded down so getListNumber can
      // apply the official `ce` domain guards for letter/roman conversion.
      const start = token.start === '' ? 1 : token.start
      const listMeta: OrderedListMeta | null = token.ordered
        ? { first: start, last: start + token.items.length - 1 }
        : null
      return token.items
        .map((_: Token, index: number) =>
          formatToken(
            _,
            theme,
            listDepth,
            token.ordered ? start + index : null,
            token,
            highlight,
            listMeta,
            // CC 2.1.295 #067 — thread the ancestor blockquote depth
            quotesAround,
          ),
        )
        .join('')
    }
    case 'list_item': {
      // Drop marked v17's `checkbox` child token — the "[ ] "/"[x] " marker is
      // rendered from the list_item's task/checked flags in the text case below
      // (official single-sink behavior: the official's older marked stripped
      // the checkbox during tokenization, so its serializer never saw one).
      // Letting it through would leak its raw ("[ ] ") before the bullet, and
      // its rendered '' would still pick up a spurious indent at depth > 0.
      // CC 2.1.281 #085 (official v281 `Jmn` @205766829): normalize a
      // bare-number list item (`- 316.`) so its numeric text is not fed to
      // getListNumber's letter/roman conversion.
      const item = token.tokens
        ? normalizeNumericListItem(token as Tokens.ListItem)
        : token
      // CC 2.1.281 #084 (official v281 @205762134 region): v280 stripped
      // leading newlines only inside the `bullet + EOL + content` branch
      // (`L.replace(/^\n+/,"")`); v281 strips the joined inner content BEFORE
      // the branch decision (`R = join().replace(/^\n+/,""); return L||b ?
      // prefix+marker+EOL+R : R`), so the plain return path also loses the
      // extra blank line produced by items whose text starts on the next
      // line (marked emits a leading `space` token). OCC's older-generation
      // serializer has a single return path and prefixes every child with
      // the depth indent — so a leading blank child line can be "\n" or
      // "  \n"; the adapted strip removes all leading whitespace-only lines.
      const inner = (item.tokens ?? [])
        .filter(_ => _.type !== 'checkbox')
        .map(
          _ =>
            `${'  '.repeat(listDepth)}${formatToken(_, theme, listDepth + 1, orderedListNumber, item, highlight, orderedListMeta, quotesAround)}`,
        )
        .join('')
        .replace(/^(?:[ \t]*\n)+/, '')
      return inner
    }
    case 'paragraph':
      return (
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, null, highlight))
          .join('') + EOL
      )
    case 'space':
      return EOL
    case 'br':
      return EOL
    case 'text':
      if (parent?.type === 'link') {
        // Already inside a markdown link — the link handler will wrap this
        // in an OSC 8 hyperlink. Linkifying here would nest a second OSC 8
        // sequence, and terminals honor the innermost one, overriding the
        // link's actual href.
        return token.text
      }
      if (parent?.type === 'list_item') {
        const bullet =
          orderedListNumber === null
            ? '-'
            : getListNumber(listDepth, orderedListNumber, orderedListMeta) + '.'
        // Official Fk serializer text case (binary @197018715):
        //   `${l.task&&f?`[${l.checked?"x":" "}] `:""}${p}${E}`
        // with f = this token is tokens[0] of the list_item — the task marker
        // renders inline from the list_item's task/checked flags. The
        // official's older marked stripped the GFM checkbox into those flags
        // and emitted no checkbox child; marked v17 emits one (filtered in the
        // list_item case above), so "first child" here means the first
        // non-checkbox sibling.
        const taskParent = parent as Tokens.ListItem
        const firstContent = (taskParent.tokens ?? []).find(
          _ => _.type !== 'checkbox',
        )
        const taskMarker =
          taskParent.task && firstContent === token
            ? ` [${taskParent.checked ? 'x' : ' '}]`
            : ''
        return `${bullet}${taskMarker} ${token.tokens ? token.tokens.map(_ => formatToken(_, theme, listDepth, orderedListNumber, token, highlight)).join('') : linkifyIssueReferences(token.text)}${EOL}`
      }
      return linkifyIssueReferences(token.text)
    case 'table': {
      const tableToken = token as Tokens.Table

      // Helper function to get the text content that will be displayed (after stripAnsi)
      function getDisplayText(tokens: Token[] | undefined): string {
        return stripAnsi(
          tokens
            ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
            .join('') ?? '',
        )
      }

      // Determine column widths based on displayed content (without formatting)
      const columnWidths = tableToken.header.map((header, index) => {
        let maxWidth = stringWidth(getDisplayText(header.tokens))
        for (const row of tableToken.rows) {
          const cellLength = stringWidth(getDisplayText(row[index]?.tokens))
          maxWidth = Math.max(maxWidth, cellLength)
        }
        return Math.max(maxWidth, 3) // Minimum width of 3
      })

      // Format header row
      let tableOutput = '| '
      tableToken.header.forEach((header, index) => {
        const content =
          header.tokens
            ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
            .join('') ?? ''
        const displayText = getDisplayText(header.tokens)
        const width = columnWidths[index]!
        const align = tableToken.align?.[index]
        tableOutput +=
          padAligned(content, stringWidth(displayText), width, align) + ' | '
      })
      tableOutput = tableOutput.trimEnd() + EOL

      // Add separator row
      tableOutput += '|'
      columnWidths.forEach(width => {
        // Always use dashes, don't show alignment colons in the output
        const separator = '-'.repeat(width + 2) // +2 for spaces on each side
        tableOutput += separator + '|'
      })
      tableOutput += EOL

      // Format data rows
      tableToken.rows.forEach(row => {
        tableOutput += '| '
        row.forEach((cell, index) => {
          const content =
            cell.tokens
              ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
              .join('') ?? ''
          const displayText = getDisplayText(cell.tokens)
          const width = columnWidths[index]!
          const align = tableToken.align?.[index]
          tableOutput +=
            padAligned(content, stringWidth(displayText), width, align) + ' | '
        })
        tableOutput = tableOutput.trimEnd() + EOL
      })

      return tableOutput + EOL
    }
    case 'escape':
      // Markdown escape: \) → ), \\ → \, etc.
      return token.text
    case 'html':
      // Official 2.1.270 serializer (binary offset 197023577, minified Fk):
      // `case"html":return e.text` — raw HTML text is rendered verbatim (e.g.
      // `<style>` in "Usage: /output-style <style>"). OCC previously dropped
      // html tokens, silently swallowing angle-bracket text.
      return token.text
    case 'def':
    case 'del':
      // Link definitions are not rendered (official: `case"def":return""`).
      // del tokens never reach here in OCC — configureMarked disables the
      // strikethrough tokenizer (documented divergence; the official uses a
      // strict `~~...~~` regex tokenizer + strikethrough render instead).
      return ''
    case 'checkbox':
      // marked v17 emits a standalone `checkbox` child token for GFM task
      // items; the official's older marked folded the marker into
      // list_item.task/checked instead (binary @190612249). Checkbox policy:
      // the marker is rendered once, from the parent list_item's flags (text
      // case above); the child token itself renders nothing. The list_item
      // case filters these out already — this arm keeps the policy explicit
      // for any other path and prevents the official `default: return raw`
      // fallback from leaking "[ ] " into the output.
      return ''
  }
  // Official default: `return e.raw` — unhandled token types fall back to the
  // raw markdown source rather than being dropped.
  return token.raw
}

// Matches owner/repo#NNN style GitHub issue/PR references. The qualified form
// is unambiguous — bare #NNN was removed because it guessed the current repo
// and was wrong whenever the assistant discussed a different one.
// Owner segment disallows dots (GitHub usernames are alphanumerics + hyphens
// only) so hostnames like docs.github.io/guide#42 don't false-positive. Repo
// segment allows dots (e.g. cc.kurs.web). Lookbehind is avoided — it defeats
// YARR JIT in JSC.
const ISSUE_REF_PATTERN =
  /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g

/**
 * Replaces owner/repo#123 references with clickable hyperlinks to GitHub.
 */
function linkifyIssueReferences(text: string): string {
  if (!supportsHyperlinks()) {
    return text
  }
  return text.replace(
    ISSUE_REF_PATTERN,
    (_match, prefix, repo, num) =>
      prefix +
      createHyperlink(
        `https://github.com/${repo}/issues/${num}`,
        `${repo}#${num}`,
      ),
  )
}

function numberToLetter(n: number): string {
  let result = ''
  while (n > 0) {
    n--
    result = String.fromCharCode(97 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function numberToRoman(n: number): string {
  let result = ''
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral
      n -= value
    }
  }
  return result
}

function getListNumber(
  listDepth: number,
  orderedListNumber: number,
  listMeta: OrderedListMeta | null,
): string {
  // CC 2.1.281 #085 side-fix — official `ce` (v280 @202972475 ≡ v281
  // @205767145 region, byte-identical): the letter/roman conversions are
  // domain-guarded by the list's first/last item numbers:
  //   case 2: first >= 1 ? numberToLetter(n) : n.toString()
  //   case 3: first >= 1 && last <= 3999 ? numberToRoman(n) : n.toString()
  // (numberToLetter(0) is "" and roman numerals cannot represent > 3999;
  // out-of-domain lists fall back to plain numbers). OCC previously had no
  // guards. Missing meta also falls back to plain numbers.
  switch (listDepth) {
    case 0:
    case 1:
      return orderedListNumber.toString()
    case 2:
      return listMeta !== null && listMeta.first >= 1
        ? numberToLetter(orderedListNumber)
        : orderedListNumber.toString()
    case 3:
      return listMeta !== null &&
        listMeta.first >= 1 &&
        listMeta.last <= 3999
        ? numberToRoman(orderedListNumber)
        : orderedListNumber.toString()
    default:
      return orderedListNumber.toString()
  }
}

/**
 * CC 2.1.281 changelog #085: bulleted lists of plain numbers (`- 316.`) were
 * re-parsed by marked as a nested ordered list with a single content-less
 * item, so the number was dropped (or, at deeper nesting, converted to
 * letter/roman garbage). Official v281 `Jmn` @205766829 (absent from v280;
 * called at the list_item case entry `h=e.tokens?Jmn(e):e` @205762134):
 *
 *   function Jmn(e){let t=e.tokens.map((n)=>{
 *     if(n.type!=="list"||!n.ordered)return n;
 *     let r=[];for(let l of n.items){
 *       let s=/^ *(\d{1,9}[.)])/.exec(l.raw)?.[1];
 *       if(l.tokens.length>0||s===void 0)return n;r.push(s)}
 *     let o=r.join("\n");return{type:"text",raw:o,text:o}});
 *     return t.every((n,r)=>n===e.tokens[r])?e:{...e,tokens:t}}
 *
 * For every child of the list_item that is an ordered list whose items are
 * ALL bare number markers with no content tokens, replace that misparsed list
 * with a single text token holding the markers joined by newlines. The
 * immutability guard (official, required): when no child changed, return the
 * ORIGINAL object — callers must be able to rely on referential equality.
 *
 * Exported for testing.
 */
export function normalizeNumericListItem(
  item: Tokens.ListItem,
): Tokens.ListItem {
  const tokens = item.tokens.map(child => {
    if (child.type !== 'list' || !child.ordered) {
      return child
    }
    const markers: string[] = []
    for (const nestedItem of child.items) {
      const marker = /^ *(\d{1,9}[.)])/.exec(nestedItem.raw)?.[1]
      if (nestedItem.tokens.length > 0 || marker === undefined) {
        return child
      }
      markers.push(marker)
    }
    const text = markers.join('\n')
    return { type: 'text', raw: text, text } as Token
  })
  return tokens.every((t, i) => t === item.tokens[i])
    ? item
    : { ...item, tokens }
}

/**
 * Pad `content` to `targetWidth` according to alignment. `displayWidth` is the
 * visible width of `content` (caller computes this, e.g. via stringWidth on
 * stripAnsi'd text, so ANSI codes in `content` don't affect padding).
 */
export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}
