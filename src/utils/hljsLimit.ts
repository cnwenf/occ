import type { BoundedHljs } from './hljsBound.js'

/**
 * CC 2.1.295 changelog #091 — highlight LIMIT plugin (Layer A).
 *
 * Official changelog: "Fixed the terminal freezing for seconds or minutes
 * while syntax highlighting code with very long lines, long runs of blank
 * lines, or unclosed strings and heredocs."
 *
 * Byte-faithful port of the official guard recovered from the 2.1.295
 * linux-x64 binary (hl module) and RE-VERIFIED against the 2.1.296 binary:
 * the whole limit/bound/grammar-patch region — `var S=50000;var R=16000`
 * through the Layer-B `O` wrapper's close `catch{return e(o)}}` — is
 * byte-identical between v295 (binary offset 214669064) and v296 (binary
 * offset 215403358): 10,358 bytes, positional token mapping shows EXACTLY 5
 * minifier renames and zero logic change (`y4t→_Yt`, `XCn→HRn`, `q7r→y7r`,
 * `K7r→_7r`, `Y7r→b7r`; punctuation/number skeleton identical, all string /
 * regex literals identical). Evidence below cites the v296 identifiers:
 * constants `S=50000;R=16000;N=20000;H=8000;I=8000;v=20000;D=20000`, prose
 * set `E` (119 names), weighted rule `d=new Map([["markdown",[P,C]]])` with
 * `P="[`~<"`, `C=/<(?:script|style)(?=\s|>)/iu`, `_Yt=256`, `HRn=16000000`,
 * and functions W/x/j/y7r/_7r/A/J/F/b7r/B.
 *
 * The 2.1.289 bounded emitter (hljsBound.ts, Layer B of that fix) caps WORK
 * performed by the emitter, but a grammar can still spend seconds in pure
 * REGEX backtracking on a long line before a single token is emitted — the
 * budget never gets charged. Layer A is a `before:highlight` plugin that
 * rejects the code up front when its shape is pathological for the grammar
 * that will run on it:
 *   - global fast path: code length <= 8000 AND unweighted long-line excess
 *     <= 16M → always allowed, no grammar walk;
 *   - otherwise resolve the EFFECTIVE grammar (walking subLanguage chains —
 *     an xml fence's javascript body is judged as javascript), then require
 *     length <= that grammar's cap (default 50000; asciidoc 16000, gcode/sas/
 *     wren 20000, http/nestedtext 8000) AND grammar-weighted long-line
 *     excess <= 16M. Markdown's excess weights ONLY prose chars "`~<" per
 *     char, unless the code looks htmlish (`<script|<style`) — then ALL
 *     chars count, because markdown's fences/sub-grammars take over.
 * The throw is a HighlightLimitError; the caller (cliHighlight.ts's
 * withPlainFallback) degrades to plain text exactly like HighlightBoundError.
 *
 * Symbol map (official minified v296 → OCC; v295 name in parens when the
 * 295→296 minifier renamed it):
 *   S=DEFAULT_LENGTH_LIMIT(50000)   u=LANGUAGE_LENGTH_LIMITS
 *   G=GLOBAL_FAST_PATH_LENGTH(8000) E=PROSE_GRAMMARS(119)
 *   w=LENGTH_GUARDED_LANGUAGES      _Yt(y4t)=LONG_LINE_CHARS(256)
 *   HRn(XCn)=LONG_LINE_EXCESS_LIMIT(16M)
 *   C=HTMLISH_TEST  P=PROSE_CHARS  d=WEIGHT_RULES
 *   k=LINE_TOKEN_RE                 W=countChars    x=longLineExcess
 *   j=proseCharsFor                 y7r(q7r)=grammarLongLineExcess
 *   _7r(K7r)=fitsGrammarLimit       A=HighlightLimitError
 *   J=fitsGlobalFastLimit           F=childGrammars
 *   b7r(Y7r)=effectiveGrammar       B=makeHighlightLimitPlugin
 */

/** Official `S` — default per-grammar code-length cap. */
export const DEFAULT_LENGTH_LIMIT = 50000
/** Official `u` — tighter per-language length caps. */
export const LANGUAGE_LENGTH_LIMITS = new Map<string, number>([
  ['asciidoc', 16000],
  ['gcode', 20000],
  ['http', 8000],
  ['nestedtext', 8000],
  ['sas', 20000],
  ['wren', 20000],
])
/** Official `G=Math.min(S,...u.values())` — global fast-path length (8000). */
export const GLOBAL_FAST_PATH_LENGTH = Math.min(
  DEFAULT_LENGTH_LIMIT,
  ...LANGUAGE_LENGTH_LIMITS.values(),
)
/** Official `E` — grammars treated as prose (regex-heavy, length-guarded). */
export const PROSE_GRAMMARS = new Set<string>([
  'abnf',
  'accesslog',
  'ada',
  'angelscript',
  'applescript',
  'arcade',
  'arduino',
  'asciidoc',
  'aspectj',
  'autohotkey',
  'awk',
  'bash',
  'brainfuck',
  'c',
  'cal',
  'clojure',
  'clojure-repl',
  'coffeescript',
  'cos',
  'cpp',
  'crmsh',
  'crystal',
  'csharp',
  'css',
  'dart',
  'delphi',
  'django',
  'dns',
  'dockerfile',
  'dos',
  'dsconfig',
  'dts',
  'dust',
  'elixir',
  'erb',
  'erlang',
  'excel',
  'fsharp',
  'gams',
  'gauss',
  'gcode',
  'go',
  'graphql',
  'groovy',
  'haml',
  'handlebars',
  'haskell',
  'http',
  'ini',
  'java',
  'javascript',
  'jboss-cli',
  'julia',
  'julia-repl',
  'kotlin',
  'latex',
  'leaf',
  'less',
  'livecodeserver',
  'livescript',
  'llvm',
  'markdown',
  'matlab',
  'mipsasm',
  'mojolicious',
  'monkey',
  'moonscript',
  'nestedtext',
  'nginx',
  'nim',
  'nix',
  'node-repl',
  'nsis',
  'objectivec',
  'ocaml',
  'parser3',
  'perl',
  'pgsql',
  'php',
  'php-template',
  'pony',
  'powershell',
  'processing',
  'profile',
  'properties',
  'protobuf',
  'puppet',
  'python',
  'python-repl',
  'qml',
  'r',
  'reasonml',
  'roboconf',
  'routeros',
  'ruby',
  'rust',
  'sas',
  'scala',
  'scheme',
  'scilab',
  'scss',
  'shell',
  'smali',
  'smalltalk',
  'sml',
  'stan',
  'stata',
  'stylus',
  'swift',
  'tap',
  'tcl',
  'tp',
  'twig',
  'typescript',
  'vbnet',
  'vbscript',
  'vbscript-html',
  'verilog',
  'wren',
  'x86asm',
  'xl',
  'xml',
  'xquery',
  'yaml',
  'zephir',
])
/** Official `w=new Set([...u.keys(),...E])` — every length-guarded language. */
export const LENGTH_GUARDED_LANGUAGES = new Set<string>([
  ...LANGUAGE_LENGTH_LIMITS.keys(),
  ...PROSE_GRAMMARS,
])
/** Official `_Yt` (v295 `y4t`) — lines longer than this accrue excess cost. */
export const LONG_LINE_CHARS = 256
/** Official `HRn` (v295 `XCn`) — max total long-line excess cost. */
export const LONG_LINE_EXCESS_LIMIT = 16_000_000
/** Official `C` — "looks like html" probe for the markdown weight rule. */
const HTMLISH_TEST = /<(?:script|style)(?=\s|>)/iu
/** Official `P` — chars markdown prose actually weights (fence/inline/code). */
const PROSE_CHARS = '`~<'
/** Official `d=new Map([["markdown",[P,C]]])` — per-language weight rules:
 * `[chars, htmlishTest]`; weight only `chars` unless the test matches. */
const WEIGHT_RULES = new Map<string, [string, RegExp]>([
  ['markdown', [PROSE_CHARS, HTMLISH_TEST]],
])
/** Official `k` — splits text into whitespace runs and non-newline runs so
 * "long lines" (and long blank runs' surrounding tokens) are measured per
 * token, not per whole text. */
const LINE_TOKEN_RE = /\s+|[^\n]+/g

/** Official `W(r,e)` — length of `text`, or the count of its chars that are
 * included in `chars` (undefined chars ⇒ plain length). */
function countChars(text: string, chars: string | undefined): number {
  let total = 0
  for (const ch of chars === undefined ? '' : text) {
    total += chars?.includes(ch) === true ? 1 : 0
  }
  return chars === undefined ? text.length : total
}

/** Official `x(r,e)` — long-line excess cost: sum over tokens longer than
 * LONG_LINE_CHARS of countChars(token) × token.length. */
function longLineExcess(text: string, chars: string | undefined): number {
  let excess = 0
  if (text.length <= LONG_LINE_CHARS) return excess
  for (const [token] of text.matchAll(LINE_TOKEN_RE)) {
    const isLongLine = token.length > LONG_LINE_CHARS
    excess += isLongLine ? countChars(token, chars) * token.length : 0
  }
  return excess
}

/** Official `j(r,e)` — the weight char-class for `language`, or undefined
 * (weight everything) when there's no rule or the htmlish probe matched. */
function proseCharsFor(
  text: string,
  language: string | undefined,
): string | undefined {
  const rule = language === undefined ? undefined : WEIGHT_RULES.get(language)
  return rule === undefined || rule[1].test(text) ? undefined : rule[0]
}

/** Official `y7r(r,e)` (v295 `q7r`) — grammar-weighted long-line excess
 * (prose grammars over LONG_LINE_CHARS only). */
function grammarLongLineExcess(
  text: string,
  language: string | undefined,
): number {
  return language !== undefined &&
    PROSE_GRAMMARS.has(language) &&
    text.length > LONG_LINE_CHARS
    ? longLineExcess(text, proseCharsFor(text, language))
    : 0
}

/** Official `_7r=(r,e)=>r.length<=(u.get(e)??S)&&y7r(r,e)<=HRn` (v295
 * `K7r`/`q7r`/`XCn`). */
function fitsGrammarLimit(
  text: string,
  language: string | undefined,
): boolean {
  const limit =
    (language === undefined ? undefined : LANGUAGE_LENGTH_LIMITS.get(language)) ??
    DEFAULT_LENGTH_LIMIT
  return text.length <= limit && grammarLongLineExcess(text, language) <= LONG_LINE_EXCESS_LIMIT
}

/** Official `A` — thrown when a code block's shape is pathological for the
 * grammar that would highlight it. */
export class HighlightLimitError extends Error {
  constructor() {
    super('this text is too long, or its lines are, for a grammar')
    this.name = 'HighlightLimitError'
  }
}

/** Official `J=(r)=>r.length<=G&&x(r,void 0)<=HRn` (v295 `XCn`) —
 * grammar-independent fast path: short code with no extreme long-line cost
 * always passes. */
function fitsGlobalFastLimit(text: string): boolean {
  return (
    text.length <= GLOBAL_FAST_PATH_LENGTH &&
    longLineExcess(text, undefined) <= LONG_LINE_EXCESS_LIMIT
  )
}

type GrammarNode = {
  subLanguage?: unknown
  contains?: unknown[]
  variants?: unknown[]
  starts?: unknown
}

/** Official `F(r,e)` — the direct children of a grammar node: subLanguage
 * grammar objects, contains, variants, and starts. */
function childGrammars(hljs: BoundedHljs, node: object): unknown[] {
  const rec = node as GrammarNode
  const sub = 'subLanguage' in rec ? rec.subLanguage : undefined
  return [
    ...([sub ?? []] as unknown[])
      .flat()
      .filter((s): s is string => typeof s === 'string')
      .map(s => hljs.getLanguage(s)),
    ...(rec.contains ?? []),
    ...('variants' in rec ? rec.variants ?? [] : []),
    ...('starts' in rec ? [rec.starts] : []),
  ]
}

/**
 * Official `b7r(r,e)` (v295 `Y7r`) — resolve the EFFECTIVE grammar name for
 * `language`: walk subLanguage chains (depth-first, cycle-guarded) until
 * reaching a length-guarded language. An empty `subLanguage: []`
 * ("auto-detect against everything") resolves to the first guarded
 * non-weighted grammar. Returns the original name when nothing guarded is
 * reachable.
 */
function effectiveGrammar(
  hljs: BoundedHljs,
  language: string | undefined,
): string | undefined {
  const byGrammar = new Map<object, string>(
    [...LENGTH_GUARDED_LANGUAGES].flatMap(name => {
      const grammar = hljs.getLanguage(name)
      return grammar === undefined ? [] : [[grammar, name] as const]
    }),
  )
  const seen = new Set<unknown>()
  const stack: unknown[] =
    language !== undefined && LENGTH_GUARDED_LANGUAGES.has(language)
      ? []
      : [hljs.getLanguage(language)]
  let current = language
  while (stack.length > 0) {
    const node = stack.pop()
    if (typeof node !== 'object' || node === null || seen.has(node)) continue
    const rec = node as GrammarNode
    const resolved =
      'subLanguage' in rec &&
      Array.isArray(rec.subLanguage) &&
      rec.subLanguage.length === 0
        ? ([...byGrammar.values()].find(name => !WEIGHT_RULES.has(name)) ??
          byGrammar.values().next().value)
        : byGrammar.get(node)
    if (resolved !== undefined && !WEIGHT_RULES.has(resolved)) return resolved
    current = resolved ?? current
    seen.add(node)
    stack.push(...(resolved === undefined ? childGrammars(hljs, node) : []))
  }
  return current
}

/**
 * Official `B(r)` — the `before:highlight` limit plugin. Rejects code whose
 * length or long-line shape exceeds the effective grammar's limits (after
 * the global fast path).
 */
export function makeHighlightLimitPlugin(hljs: BoundedHljs): Record<string, unknown> {
  return {
    'before:highlight': (args: { code: string; language?: string }) => {
      if (
        !fitsGlobalFastLimit(args.code) &&
        !fitsGrammarLimit(args.code, effectiveGrammar(hljs, args.language))
      ) {
        throw new HighlightLimitError()
      }
    },
  }
}
