/**
 * CC 2.1.295 changelog #050 + #031 — the official markdown token sanitizer plus
 * the style-reset / invisible-strip helpers the link and image renderers
 * consume.
 *
 * > #050 - Fixed raw terminal hyperlink bytes in a reply or a teammate's
 * >        message being drawn as a clickable link with a hidden address
 * > #031 - Fixed a link address shown as text being hidden by a colour or
 * >        conceal style a reply left on, including where it wraps in a table
 * >        or a question preview
 *
 * Every constant and function below is a byte-faithful transcription of the
 * official 2.1.295 linux-x64 bundle (md5-verified ELF read through a PROT_READ
 * mmap — the binary was never executed). Marker -> offset map:
 *
 *   @220892664  vcn  sgrIntroducerSource
 *   @220892752  oe   CONTROL_BYTES               /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
 *   @220892786  xt   CONTROL_BYTES_EXCEPT_SGR    new RegExp(`(?!${vcn(";:")})${oe.source}`,"g")
 *   @220892845  _4n  stripControlBytes
 *   @220892889  Ecn  sanitizeMarkdownTokens
 *   @220894837  H    stripRenderInvisible
 *   @220894933  Fe   STYLE_RESET_BEFORE_ADDRESS  "\x1B[28m\x1B[39m\x1B[49m"
 *   @220895008  X    afterStyleReset
 *   @220895040  De   shownAddress
 *   @220895060  ue   shownAddressWithTitle
 *   @207266824  eC   isRenderInvisibleCodePoint
 *
 * `eC` is byte-identical in 2.1.294 (@205497960, where it is minified as `aI`)
 * and 2.1.295 already used it as `O` in the v294 link case
 * (`T=f?O(u??e.href):u??O(e.href)` @218404616). It is therefore NOT a
 * 294 -> 295 delta — it is a pre-existing OCC gap that #031 cannot be
 * transcribed without, because v295's `De(e.href,X(e))`, `g=m?f:H(f??e.href)`
 * and `B=S?z:m?H(e.href):g` all route the address through `H`.
 *
 * 2.1.294 had NONE of oe / xt / _4n / Ecn / Fe / X — verified by 0 hits for
 * `[28m`, `afterStyle` and `shownUrlStart` anywhere in the 2.1.294 ELF. That
 * absence is the delta this module ports.
 *
 * Official call sites (both ported):
 *
 *   TNt @220898004   `Ecn(iXe(Em,r)).map((o)=>PH(o,t,{...}))`
 *                    -> src/utils/markdown.ts applyMarkdown
 *   xn  @231692124   `Ecn(Vr(i))` on the synthetic-paragraph fast path and
 *                    `Ecn(zr(p?uNo:Em,i))` on the real lex, with the result
 *                    stored in the memo Map
 *                    -> src/components/Markdown.tsx cachedLexer
 *
 * Sanitizing at the lexer means the token cache stores already-clean tokens.
 * The second (render-time) call is then a no-op: `Ecn` gates the whole walk on
 * `oe.test(o.raw)`, and `raw` is itself one of the non-href string fields the
 * walk cleans, so a sanitized tree never re-enters it.
 *
 * DEVIATION (deliberate, documented): official `Ecn` mutates the token tree in
 * place via `Reflect.set` / `Object.assign` and returns the same array. OCC
 * returns a freshly built tree instead, per this repo's immutability rule. The
 * two are observably identical for every caller: both call sites consume the
 * return value, the clean tree is built before it escapes this module, and the
 * gate-not-tripped fast path returns the input array unchanged (identity
 * preserved), which is the overwhelmingly common case.
 */
import type { Token } from 'marked'

/** The ESC byte, spelled as an escape so this file stays pure ASCII. */
const ESCAPE = '\x1b'

/**
 * Official `vcn` @220892664 — `(e)=>`\\x1b\\[[0-9${e}]*m``. Builds the *regex
 * source* (not the bytes) for an SGR introducer whose parameter bytes come from
 * `e`; `Ecn`'s sibling `xt` instantiates it with `";:"` so both the `;` and the
 * `:` (used by ISO/IEC 8613 sub-parameters such as `4:3`) are accepted.
 */
export function sgrIntroducerSource(params: string): string {
  return `\\x1b\\[[0-9${params}]*m`
}

/**
 * Official `oe` @220892752 — every C0 and C1 control byte EXCEPT tab (0x09) and
 * LF (0x0a), which markdown text legitimately carries. No `g` flag, so the
 * `.test()` probes below are stateless (a `g` regex would advance `lastIndex`
 * between calls and flip the gate).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `oe` — the control-byte class IS the sanitizer's target
export const CONTROL_BYTES = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/**
 * Official `xt` @220892786 — `new RegExp(`(?!${vcn(";:")})${oe.source}`,"g")`.
 *
 * `oe` with a negative lookahead for an SGR introducer. Applied with `.replace`
 * it deletes every control byte that does NOT begin a `ESC [ <params> m`
 * sequence, so model-authored colour/bold styling survives while OSC 8
 * hyperlink bytes do not: the ESC of `ESC ] 8 ; ; URL BEL` fails the lookahead
 * and is deleted, and the BEL terminators are deleted outright — the residue is
 * inert visible text (`]8;;URLtext]8;;`) instead of a clickable link whose
 * address the reader never sees. That is changelog #050.
 */
export const CONTROL_BYTES_EXCEPT_SGR = new RegExp(
  `(?!${sgrIntroducerSource(';:')})${CONTROL_BYTES.source}`,
  'g',
)

/** Official `_4n`'s line-ending normalizer — `/\r\n?/g`. */
const CRLF_OR_CR = /\r\n?/g

/**
 * Official `_4n` @220892845 —
 * `(e)=>e.replace(/\r\n?/g,`\n`).replace(xt,"")`.
 *
 * CRLF/CR are folded to LF first so a CR can never survive as the byte that
 * returns the carriage to column 0 and lets later text overwrite a line.
 */
export function stripControlBytes(value: string): string {
  return value.replace(CRLF_OR_CR, '\n').replace(CONTROL_BYTES_EXCEPT_SGR, '')
}

/**
 * Official `eC` @207266824 — the narrow "invisible in a rendered line"
 * predicate the address helpers use. Distinct from (and much narrower than)
 * `isHiddenCodePoint` in src/utils/invisibleUnicode.ts, which is official `jn`
 * and backs the "removed N hidden characters" notice. Both exist upstream; they
 * are not interchangeable.
 */
export function isRenderInvisibleCodePoint(code: number): boolean {
  return (
    code <= 31 ||
    (code >= 127 && code <= 159) ||
    code === 173 ||
    code === 1564 ||
    (code >= 8203 && code <= 8207) ||
    code === 8232 ||
    code === 8233 ||
    (code >= 8234 && code <= 8238) ||
    (code >= 8288 && code <= 8297) ||
    (code >= 65024 && code <= 65039) ||
    code === 65279 ||
    (code >= 65529 && code <= 65531) ||
    code === 94180 ||
    (code >= 917504 && code <= 917999)
  )
}

/**
 * U+29C9 TWO JOINED SQUARES — official `H` keeps this one code point even
 * though `eC` would not have caught it anyway; the exclusion is verbatim.
 */
const KEEP_TWO_JOINED_SQUARES = 10697

/**
 * Official `H` @220894837 —
 * `(e)=>Array.from(e).filter((t)=>{let n=t.codePointAt(0)??0;
 *  return n!==10697&&!eC(n)}).join("")`.
 *
 * Drops every invisible code point from a string that is about to be shown as,
 * or used as, a link address. `Array.from` iterates code points, so surrogate
 * pairs are tested whole.
 */
export function stripRenderInvisible(value: string): string {
  return Array.from(value)
    .filter(grapheme => {
      const code = grapheme.codePointAt(0) ?? 0
      return code !== KEEP_TWO_JOINED_SQUARES && !isRenderInvisibleCodePoint(code)
    })
    .join('')
}

/**
 * Official `Fe` @220894933 — `"\x1B[28m\x1B[39m\x1B[49m"`: reveal (conceal
 * off), default foreground, default background. Emitted immediately before any
 * address that is drawn as text, so a colour or conceal style a reply left open
 * can no longer hide it. That is changelog #031.
 */
export const STYLE_RESET_BEFORE_ADDRESS = `${ESCAPE}[28m${ESCAPE}[39m${ESCAPE}[49m`

/** A marked token carrying the official 2.1.295 `afterStyle` flag. */
export type AfterStyleToken = {
  afterStyle?: boolean
}

/**
 * Official `X` @220895008 —
 * `(e)=>("afterStyle"in e)&&e.afterStyle===!0?Fe:""`.
 *
 * The reset is emitted only for tokens `sanitizeMarkdownTokens` flagged, i.e.
 * only when some non-href string in the same token tree still carries an ESC
 * after cleaning (a surviving SGR that could still be open at render time).
 */
export function afterStyleReset(token: Token): string {
  return 'afterStyle' in token &&
    (token as AfterStyleToken).afterStyle === true
    ? STYLE_RESET_BEFORE_ADDRESS
    : ''
}

/**
 * Official `De` @220895040 — `(e,t)=>`${t}${H(e)}``: the style reset followed
 * by the invisible-stripped address. Used by the image case and the mailto
 * branch of the link case.
 */
export function shownAddress(href: string, styleReset: string): string {
  return `${styleReset}${stripRenderInvisible(href)}`
}

/**
 * Official `ue` @220895060 — `(e,t,n="")=>`${t} (${H(e)}${n})``: the style
 * reset, then the invisible-stripped address wrapped in parentheses, then an
 * optional title suffix. Used by the image case and the mailto branch of the
 * link case when the token carries alt/link text of its own (so the address is
 * shown *after* that text, in parentheses) rather than as the whole output.
 * Official `pe` (`(e)=>ue(e,Fe)` @220895060) — the always-reset variant used by
 * the non-mailto title-as-drawn-address branch — is STAGED with that branch
 * (it needs the linkCap `m` gate; see the port report), so it is not added here.
 */
export function shownAddressWithTitle(
  href: string,
  styleReset: string,
  titleSuffix = '',
): string {
  return `${styleReset} (${stripRenderInvisible(href)}${titleSuffix})`
}

type UnknownRecord = Record<string, unknown>

function isTraversable(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/**
 * Official `Ecn` @220892889, verbatim control flow:
 *
 * ```js
 * function Ecn(e){
 *   let n=e.some((o)=>oe.test(o.raw))?[e]:[];
 *   for(let o of n)for(let[i,l]of Object.entries(o)){
 *     let c=typeof l==="string"&&i!=="href";
 *     if(typeof l==="object"&&l!==null)n.push(l);
 *     else if(c)Reflect.set(o,i,_4n(l))}
 *   let r=n.some((o)=>Object.entries(o).some(([i,l])=>
 *     i!=="href"&&typeof l==="string"&&l.includes("\x1B"))),
 *     s=n.filter((o)=>("type"in o)&&(o.type==="link"||o.type==="image"));
 *   for(let o of r?s:[])Object.assign(o,{afterStyle:!0});
 *   return e}
 * ```
 *
 * A breadth-first walk of everything reachable from the top-level token array.
 * Every string field is cleaned EXCEPT `href` — the address must reach the OSC 8
 * target intact, and it is separately hardened by `H` at the point it is drawn.
 * When any cleaned non-href string still contains an ESC (an SGR survived, so a
 * style may still be open), every link and image token in the tree is marked
 * `afterStyle:true` and the renderer answers with `Fe` before the address.
 *
 * The `oe.test(o.raw)` gate is what makes the render-time call cheap: `raw` is
 * itself cleaned, so an already-sanitized tree short-circuits here and the
 * caller's array is returned by identity.
 *
 * See the DEVIATION note in the file header: OCC builds and returns a fresh
 * tree rather than mutating the caller's tokens.
 */
export function sanitizeMarkdownTokens<T extends readonly Token[]>(
  tokens: T,
): T {
  if (!tokens.some(token => CONTROL_BYTES.test(token.raw))) {
    return tokens
  }

  const linkAndImageTokens: UnknownRecord[] = []
  let styleSurvived = false

  const sanitizeNode = (node: object): object => {
    if (Array.isArray(node)) {
      return node.map(entry => (isTraversable(entry) ? sanitizeNode(entry) : entry))
    }
    // Preserve the prototype: marked may hand back class instances, and
    // `Object.entries` only ever sees own enumerable properties.
    const copy = Object.create(Object.getPrototypeOf(node)) as UnknownRecord
    for (const [key, value] of Object.entries(node)) {
      if (isTraversable(value)) {
        Reflect.set(copy, key, sanitizeNode(value))
      } else if (typeof value === 'string' && key !== 'href') {
        const cleaned = stripControlBytes(value)
        if (cleaned.includes(ESCAPE)) styleSurvived = true
        Reflect.set(copy, key, cleaned)
      } else {
        Reflect.set(copy, key, value)
      }
    }
    const type = Reflect.get(copy, 'type')
    if (type === 'link' || type === 'image') {
      linkAndImageTokens.push(copy)
    }
    return copy
  }

  const sanitized = sanitizeNode(tokens as unknown as object) as T

  // Official `for(let o of r?s:[])Object.assign(o,{afterStyle:!0})` — applied to
  // this module's own freshly built clones, before they are returned.
  if (styleSurvived) {
    for (const token of linkAndImageTokens) {
      Reflect.set(token, 'afterStyle', true)
    }
  }
  return sanitized
}
