import chalk from 'chalk'
import { marked, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { color } from '../components/design-system/color.js'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'
import { stringWidth } from '../ink/stringWidth.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import type { CliHighlight } from './cliHighlight.js'
import { logForDebugging } from './debug.js'
import { createHyperlink } from './hyperlink.js'
import { stripPromptXMLTags } from './messages.js'
import type { ThemeName } from './theme.js'

// Use \n unconditionally — os.EOL is \r\n on Windows, and the extra \r
// breaks the character-to-segment mapping in applyStylesToWrappedText,
// causing styled text to shift right.
const EOL = '\n'

let markedConfigured = false

export function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true

  // Disable strikethrough parsing - the model often uses ~ for "approximate"
  // (e.g., ~100) and rarely intends actual strikethrough formatting
  marked.use({
    tokenizer: {
      del() {
        return undefined
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
  return marked
    .lexer(stripPromptXMLTags(content))
    .map(_ => formatToken(_, theme, 0, null, null, highlight))
    .join('')
    .trim()
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
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, null, highlight))
        .join('')
      // Prefix each line with a dim vertical bar. Keep text italic but at
      // normal brightness — chalk.dim is nearly invisible on dark themes.
      // Render the bar on every line — including blank lines between
      // paragraphs — so the left bar is continuous across the whole blockquote.
      const bar = chalk.dim(BLOCKQUOTE_BAR)
      return inner
        .split(EOL)
        .map(line =>
          stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : bar,
        )
        .join(EOL)
    }
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
      return highlight.highlight(token.text, { language }) + EOL
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
    case 'image':
      return token.href
    case 'link': {
      // Prevent mailto links from being displayed as clickable links
      if (token.href.startsWith('mailto:')) {
        // Extract email from mailto: link and display as plain text
        const email = token.href.replace(/^mailto:/, '')
        return email
      }
      // Extract display text from the link's child tokens
      const linkText = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, token, highlight))
        .join('')
      const plainLinkText = stripAnsi(linkText)
      // If the link has meaningful display text (different from the URL),
      // show it as a clickable hyperlink. In terminals that support OSC 8,
      // users see the text and can hover/click to see the URL.
      if (plainLinkText && plainLinkText !== token.href) {
        return createHyperlink(token.href, linkText)
      }
      // When the display text matches the URL (or is empty), just show the URL
      return createHyperlink(token.href)
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
            `${'  '.repeat(listDepth)}${formatToken(_, theme, listDepth + 1, orderedListNumber, item, highlight, orderedListMeta)}`,
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
