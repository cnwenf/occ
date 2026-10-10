import type { BoundedHljs } from './hljsBound.js'

/**
 * CC 2.1.295 changelog #091 — grammar regex patch tables (Layer B).
 *
 * Byte-faithful port of the v295 patch region recovered from the official
 * 2.1.295 linux-x64 binary and RE-VERIFIED against the 2.1.296 binary: the
 * whole hl limit/bound/grammar-patch region is byte-identical between v295
 * (binary offset 214669064) and v296 (binary offset 215403358) — 10,358
 * bytes, and NONE of the 5 minifier renames (y4t/XCn/q7r/K7r/Y7r, all
 * Layer A) touches this file's symbols. Every Layer B identifier cited here
 * is unchanged in v296 (walker `V`, field list `q=["begin","end","match",
 * "illegal"]`, replacement lookup `Q`, unfreeze helper `_`, constants
 * Nr=1000 rr=1000 br=16 Hr=1000 Ir=12 vr=1500 Dr=1e4 Gr=16, pair tables
 * er/tr/M/or/nr/ir/sr/ar/pr/gr/mr/lr and the language map `ur`, registration
 * wrapper `O` — v296 verbatim: `var O=(r,e)=>(o)=>{let n=e(o);try{return
 * V(n,new Map([...tr,...ur.get(r)??[]]))}catch{return e(o)}}`, immediately
 * followed by the registerLanguage machinery `var jr=/^[a-z0-9][a-z0-9_+#.-]
 * {0,63}$/,zr=16;function Zr(r){return r.default??r}class dr{hljs=null;...`).
 *
 * Layer A (hljsLimit.ts) rejects pathological INPUTS; Layer B fixes the
 * pathological GRAMMAR REGEXES themselves — catastrophic-backtracking
 * patterns (`(.|\n)*?` heredocs/raw strings, unbounded `)+` fn-title
 * repeats, `.*?` link scans) are replaced with bounded / anchored
 * equivalents applied as [oldSource, newSource] pairs. A pair whose `old`
 * doesn't match the installed grammar's regex source is a designed no-op
 * (Q returns the original), so the table is safe across hljs versions.
 *
 * Wiring divergence (documented): the official patches at registration time —
 * `O(name, loader)` wraps each language loader and V-patches the returned
 * definition (`try{return V(n,new Map([...tr,...ur.get(r)??[]]))}catch{return
 * e(o)}` — on patch failure it re-invokes the UNPATCHED loader). OCC cannot
 * wrap the vendored loaders (cli-highlight + two hljs generations install
 * eagerly), so `applyGrammarPatches` V-patches the STORED (still uncompiled —
 * both hljs 10.7.3 and 11.x compile lazily inside highlight(), verified by
 * forensics: registerLanguage stores the raw definition tree; compileLanguage
 * runs only at highlight time) getLanguage() trees once inside
 * loadCliHighlight(), before any highlight call — timing-equivalent to the
 * official. The official's catch-fallback re-invokes the loader to restore an
 * unpatched tree; in-place patching cannot un-patch, but V/Q are built not to
 * throw (Q try/catches every RegExp construction, the walker skips
 * non-objects and cycles), and the per-language try/catch below still
 * isolates any unforeseen failure to one language.
 *
 * Symbol map (official minified → OCC):
 *   q=PATCHED_FIELDS  Q=replaceFrom  _=unfrozen  V=patchGrammarInPlace
 *   Nr=HANDLEBARS_BRACKET_LIMIT(1000)  rr=CSHARP_GENERIC_LIMIT(1000)
 *   br=INI_SEGMENT_REPEAT_LIMIT(16)    Hr=RUBY_HEREDOC_LINE_LIMIT(1000)
 *   Ir=CSHARP_TYPE_REPEAT_LIMIT(12)    vr=PERL_REPEAT_LIMIT(1500)
 *   Dr=RUST_RAW_STRING_LIMIT(10000)    Gr=C_FN_TITLE_REPEAT_LIMIT(16)
 *   T=fnTitlePair  er=C_PATCHES  tr=GLOBAL_PROSE_PATCHES  M=CPP_PATCHES
 *   or=CSHARP_PATCHES  nr=HANDLEBARS_PATCHES  ir=INI_PATCHES
 *   sr=MARKDOWN_FENCE_PATCHES  ar=MARKDOWN_LINK_PATCHES  pr=PERL_PATCHES
 *   gr=PYTHON_PATCHES  mr=RUBY_PATCHES  lr=RUST_PATCHES
 *   ur=LANGUAGE_PATCHES  O=official registration wrapper (see divergence)
 */

const HANDLEBARS_BRACKET_LIMIT = 1000
const CSHARP_GENERIC_LIMIT = 1000
const INI_SEGMENT_REPEAT_LIMIT = 16
const RUBY_HEREDOC_LINE_LIMIT = 1000
const CSHARP_TYPE_REPEAT_LIMIT = 12
const PERL_REPEAT_LIMIT = 1500
const RUST_RAW_STRING_LIMIT = 10000
const C_FN_TITLE_REPEAT_LIMIT = 16

/** Official `q` — grammar-node fields carrying regexes. */
const PATCHED_FIELDS = ['begin', 'end', 'match', 'illegal'] as const

type RegexField = string | RegExp | Array<string | RegExp>

type GrammarNode = {
  begin?: RegexField
  end?: RegexField
  match?: RegexField
  illegal?: RegexField
  contains?: unknown[]
  variants?: unknown[]
  starts?: unknown
  [key: string]: unknown
}

/** Official `Q(r)` — builds the field replacer from the [old,new] map; a
 * miss (or an invalid replacement source) returns the original untouched. */
function replaceFrom(
  patches: Map<string, string>,
): (value: string | RegExp) => string | RegExp {
  return value => {
    const replacement = patches.get(
      typeof value === 'string' ? value : value.source,
    )
    try {
      return replacement === undefined ? value : new RegExp(replacement)
    } catch {
      return value
    }
  }
}

/** Official `_(r)` — shallow-copy frozen nodes so patching can't throw in
 * strict mode. */
function unfrozen(value: unknown): unknown {
  return typeof value === 'object' && value !== null && Object.isFrozen(value)
    ? { ...(value as object) }
    : value
}

/** Official `V(r,e)` — walk the grammar tree (cycle-guarded stack) and
 * replace every begin/end/match/illegal regex found in the patch map. */
function patchGrammarInPlace(
  grammar: object,
  patches: Map<string, string>,
): object {
  const seen = new Set<unknown>()
  const stack: unknown[] = [grammar]
  const patch = replaceFrom(patches)
  while (stack.length > 0) {
    const node = stack.pop()
    if (!(typeof node === 'object' && node !== null) || seen.has(node)) {
      continue
    }
    seen.add(node)
    const rec = node as GrammarNode
    for (const field of PATCHED_FIELDS) {
      const value = rec[field]
      if (value !== undefined && value !== null) {
        rec[field] = Array.isArray(value) ? value.map(patch) : patch(value)
      }
    }
    if (rec.contains) rec.contains = rec.contains.map(unfrozen)
    if (rec.variants) rec.variants = rec.variants.map(unfrozen)
    if (rec.starts) rec.starts = unfrozen(rec.starts)
    stack.push(...(rec.contains ?? []), ...(rec.variants ?? []), rec.starts)
  }
  return grammar
}

/** Official `T(r)` — c/cpp function-title pair factory: the unbounded
 * `(...)+` return-type repeat becomes `{1,16}` with a lookahead anchor. */
const fnTitlePair = (guard: string): [string, string] => [
  String.raw`(${guard}(decltype\(auto\)|(?:[a-zA-Z_]\w*::)?[a-zA-Z_]\w*` +
    String.raw`(?:<[^<>]+>)?)[\*&\s]+)+` +
    String.raw`(?:[a-zA-Z_]\w*::)?[a-zA-Z]\w*\s*\(`,
  String.raw`(?=[a-zA-Z_])` +
    String.raw`(?:(?=decltype\(auto\))|(?<!${guard}[a-zA-Z_]\w*?))` +
    String.raw`(${guard}(decltype\(auto\)|(?:[a-zA-Z_]\w*::)?[a-zA-Z_]\w*` +
    String.raw`(?:<[^<>]+>)?)[\*&\s]+){1,${C_FN_TITLE_REPEAT_LIMIT}}` +
    String.raw`(?:[a-zA-Z_]\w*::)?[a-zA-Z]\w*\s*\(`,
]

/** Official `er=[T("")]` — c. */
const C_PATCHES: Array<[string, string]> = [fnTitlePair('')]

/** Official `tr` — global prose patches applied to EVERY language: the
 * {3} prose-word repeat gets a `(?<! )` anchor, and the TODO-lookahead gets
 * a bounded optional-space prefix. */
const GLOBAL_PROSE_PATCHES: Array<[string, string]> = [
  [
    String.raw`[ ]+((?:I|a|is|so|us|to|at|if|in|it|on|` +
      String.raw`[A-Za-z]+['](d|ve|re|ll|t|s|n)|[A-Za-z]+[-][a-z]+|` +
      String.raw`[A-Za-z][a-z]{2,})[.]?[:]?([.][ ]|[ ])){3}`,
    String.raw`(?<! )[ ]+((?:I|a|is|so|us|to|at|if|in|it|on|` +
      String.raw`[A-Za-z]+['](d|ve|re|ll|t|s|n)|[A-Za-z]+[-][a-z]+|` +
      String.raw`[A-Za-z][a-z]{2,})[.]?[:]?([.][ ]|[ ])){3}`,
  ],
  [
    String.raw`[ ]*(?=(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):)`,
    String.raw`(?:(?<! )[ ]+)?(?=(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):)`,
  ],
]

/** Official `M=[T("(?!struct)")]` — cpp / arduino. */
const CPP_PATCHES: Array<[string, string]> = [fnTitlePair('(?!struct)')]

/** Official `or` — csharp: bounded type-repeat `{1,12}` + bounded generic
 * interior `<[^=]{1,1000}?>` with lookahead anchors. */
const CSHARP_PATCHES: Array<[string, string]> = [
  [
    String.raw`([a-zA-Z]\w*(<[a-zA-Z]\w*(\s*,\s*[a-zA-Z]\w*)*>)?(\[\])?\s+)+` +
      String.raw`[a-zA-Z]\w*\s*(<[^=]+>\s*)?\(`,
    String.raw`(?=[a-zA-Z])(?<![a-zA-Z]\w*?)` +
      String.raw`([a-zA-Z]\w*(<[a-zA-Z]\w*(\s*,\s*[a-zA-Z]\w*)*>)?(\[\])?\s+)` +
      String.raw`{1,${CSHARP_TYPE_REPEAT_LIMIT}}[a-zA-Z]\w*\s*` +
      String.raw`(<[^=]{1,${CSHARP_GENERIC_LIMIT}}?>\s*)?\(`,
  ],
  [
    String.raw`[a-zA-Z]\w*\s*(<[^=]+>\s*)?\(`,
    String.raw`[a-zA-Z]\w*\s*` +
      String.raw`(<[^=]{1,${CSHARP_GENERIC_LIMIT}}?>\s*)?\(`,
  ],
]

/** Official `nr` — handlebars: `[^\]]+\]` bracket interiors bounded to
 * {1,1000} (built by replaceAll over the two path/subexpression forms). */
const HANDLEBARS_PATCHES: Array<[string, string]> = [
  String.raw`(?:\.|\.\/|\/)?(?:""|"[^"]+"|''|'[^']+'|\[\]|\[[^\]]+\]|` +
    String.raw`[^\s!"#%&'()*+,.\/;<=>@\[\\\]^` +
    '`' +
    String.raw`{|}~]+)(?:(\.|\/)(?:""|"[^"]+"|''|'[^']+'|\[\]|\[[^\]]+\]|` +
    String.raw`[^\s!"#%&'()*+,.\/;<=>@\[\\\]^` +
    '`' +
    String.raw`{|}~]+))*`,
  String.raw`(\[\]|\[[^\]]+\]|[^\s!"#%&'()*+,.\/;<=>@\[\\\]^` +
    '`' +
    String.raw`{|}~]+)(?==)`,
].map(source => [
  source,
  source.replaceAll(
    String.raw`[^\]]+\]`,
    String.raw`[^\]]{1,${HANDLEBARS_BRACKET_LIMIT}}\]`,
  ),
])

/** Official `ir` — ini: dotted key segments bounded `{0,16}` with
 * lookbehind anchors. */
const INI_PATCHES: Array<[string, string]> = [
  [
    String.raw`(?:[A-Za-z0-9_-]+|"(\\"|[^"])*"|'[^']*')` +
      String.raw`(\s*\.\s*(?:[A-Za-z0-9_-]+|"(\\"|[^"])*"|'[^']*'))*` +
      String.raw`(?=\s*=\s*[^#\s])`,
    String.raw`(?:(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+|` +
      String.raw`(?<!\\)"(\\"|[^"])*"|'[^']*')` +
      String.raw`(\s*\.\s*(?:[A-Za-z0-9_-]+|"(\\"|[^"])*"|'[^']*'))` +
      String.raw`{0,${INI_SEGMENT_REPEAT_LIMIT}}` +
      String.raw`(?=\s*=\s*[^#\s])`,
  ],
]

/** Official `sr` — markdown fences: `(.|\n)*?` between fence markers becomes
 * a single-character-class `[^\r\u2028\u2029]*?` (linear, no dot/newline
 * alternation backtracking). Forensic note: the backtick-fence `old` matches
 * the hljs v10.7.3 source string exactly; the v11 form differs and the pair
 * is a designed no-op there. */
const MARKDOWN_FENCE_PATCHES: Array<[string, string]> = [
  [
    '(`{3,})[^`](.|\\n)*?\\1`*[ ]*',
    '(`{3,})[^`][^\\r\\u2028\\u2029]*?\\1`*[ ]*',
  ],
  [
    String.raw`(~{3,})[^~](.|\n)*?\1~*[ ]*`,
    String.raw`(~{3,})[^~][^\r\u2028\u2029]*?\1~*[ ]*`,
  ],
]

/** Official `ar` — markdown inline links: `\[.*?\]\(.*?\)`-style scans get
 * rewritten with lookahead-captured groups so the bracket/paren interior is
 * matched once instead of re-scanned per backtrack step. Matches both hljs
 * v10 and v11 markdown sources (forensically verified). */
const MARKDOWN_LINK_PATCHES: Array<[string, string]> = [
  [String.raw`\[.*?\]\(.*?\)`, String.raw`\[(?=(.*?\]\())\1.*?\)`],
  [
    String.raw`\[.+?\]\(((data|javascript|mailto):|(?:http|ftp)s?:\/\/).*?\)`,
    String.raw`\[(?=(.+?\]\(((data|javascript|mailto):|(?:http|ftp)s?:\/\/)))` +
      String.raw`\1.*?\)`,
  ],
  [
    String.raw`\[.+?\]\([A-Za-z][A-Za-z0-9+.-]*:\/\/.*?\)`,
    String.raw`\[(?=(.+?\]\([A-Za-z][A-Za-z0-9+.-]*:\/\/))\1.*?\)`,
  ],
  [
    String.raw`\[.+?\]\([./?&#].*?\)`,
    String.raw`\[(?=(.+?\]\([./?&#]))\1.*?\)`,
  ],
]

/** Official `pr` — perl: every `(?:\\.|[^\\\/])*?` quote-interior repeat is
 * bounded to `{0,1500}?` (built by replaceAll over the 9 s///, tr///, y///,
 * m//, qr// forms). */
const PERL_PATCHES: Array<[string, string]> = [
  String.raw`(?:s|tr|y)(!|\/|\||\?|'|"|#)(?:\\.|[^\\\/])*?\1` +
    String.raw`(?:\\.|[^\\\/])*?\1[dualxmsipngr]{0,12}`,
  String.raw`(?:s|tr|y)\((?:\\.|[^\\\/])*?\)\(` +
    String.raw`(?:\\.|[^\\\/])*?\)[dualxmsipngr]{0,12}`,
  String.raw`(?:s|tr|y)\[(?:\\.|[^\\\/])*?\]\[` +
    String.raw`(?:\\.|[^\\\/])*?\][dualxmsipngr]{0,12}`,
  String.raw`(?:s|tr|y)\{(?:\\.|[^\\\/])*?\}\{` +
    String.raw`(?:\\.|[^\\\/])*?\}[dualxmsipngr]{0,12}`,
  String.raw`(?:(?:m|qr)?)\/(?:\\.|[^\\\/])*?\/[dualxmsipngr]{0,12}`,
  String.raw`(?:m|qr)(!|\/|\||\?|'|"|#)(?:\\.|[^\\\/])*?\1` +
    String.raw`[dualxmsipngr]{0,12}`,
  String.raw`(?:m|qr)\((?:\\.|[^\\\/])*?\)[dualxmsipngr]{0,12}`,
  String.raw`(?:m|qr)\[(?:\\.|[^\\\/])*?\][dualxmsipngr]{0,12}`,
  String.raw`(?:m|qr)\{(?:\\.|[^\\\/])*?\}[dualxmsipngr]{0,12}`,
].map(source => [source, source.replaceAll(')*?', `){0,${PERL_REPEAT_LIMIT}}?`)])

/** Official `gr` — python numeric literal: `0+(_?0)*` (zero-run then more
 * zeros — quadratic on `000…`) collapses to `0(_?0)*`. */
const PYTHON_PATCHES: Array<[string, string]> = [
  [
    String.raw`\b([1-9](_?[0-9])*|0+(_?0)*)[lLjJ]?(?=\b|and|as|assert|async|` +
      'await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|10|not|or|pass|raise|return|try|while|with|yield)',
    String.raw`\b([1-9](_?[0-9])*|0(_?0)*)[lLjJ]?(?=\b|and|as|assert|async|` +
      'await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|10|not|or|pass|raise|return|try|while|with|yield)',
  ],
]

/** Official `mr` — ruby heredoc: the `(?:[^\n]*\n)*?` line skip is bounded
 * to `{0,1000}?` and `\s*` becomes `[^\S\n]*` (no newline eating). Matches
 * neither installed hljs generation's ruby source exactly (forensics) —
 * designed no-op via Q. */
const RUBY_PATCHES: Array<[string, string]> = [
  [
    String.raw`<<[-~]?'?(?=(\w+)(?=\W)[^\n]*\n(?:[^\n]*\n)*?\s*\1\b)`,
    String.raw`<<[-~]?'?(?=(\w+)(?=\W)[^\n]*\n(?:[^\n]*\n)` +
      String.raw`{0,${RUBY_HEREDOC_LINE_LIMIT}}?[^\S\n]*\1\b)`,
  ],
]

/** Official `lr` — rust raw strings: `(.|\n)*?` interior becomes
 * `[^]{0,10000}?`. Matches the hljs v11 rust source (verified); no-op on
 * v10. */
const RUST_PATCHES: Array<[string, string]> = [
  [
    String.raw`b?r(#*)"(.|\n)*?"\1(?!#)`,
    String.raw`b?r(#*)"[^]{0,${RUST_RAW_STRING_LIMIT}}?"\1(?!#)`,
  ],
]

/** Official `ur` — per-language patch tables. */
const LANGUAGE_PATCHES = new Map<string, Array<[string, string]>>([
  ['arduino', CPP_PATCHES],
  ['c', C_PATCHES],
  ['cpp', CPP_PATCHES],
  ['csharp', CSHARP_PATCHES],
  ['handlebars', HANDLEBARS_PATCHES],
  ['ini', INI_PATCHES],
  ['markdown', [...MARKDOWN_LINK_PATCHES, ...MARKDOWN_FENCE_PATCHES]],
  ['perl', PERL_PATCHES],
  ['python', PYTHON_PATCHES],
  ['ruby', RUBY_PATCHES],
  ['rust', RUST_PATCHES],
])

/**
 * OCC adaptation of the official registration wrapper `O(r,e)` — apply the
 * global prose patches plus the language's own table to every REGISTERED
 * grammar in place (the trees are still uncompiled at this point; see the
 * wiring-divergence note in the file header). Call once per hljs instance in
 * loadCliHighlight(), after installHighlightBounds.
 */
export function applyGrammarPatches(hljs: BoundedHljs): void {
  for (const name of hljs.listLanguages()) {
    const grammar = hljs.getLanguage(name)
    if (grammar === undefined) continue
    try {
      patchGrammarInPlace(
        grammar,
        new Map([
          ...GLOBAL_PROSE_PATCHES,
          ...(LANGUAGE_PATCHES.get(name) ?? []),
        ]),
      )
    } catch {
    }
  }
}
