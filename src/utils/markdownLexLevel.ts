import type { Token } from 'marked'

/**
 * CC 2.1.290 cluster E item #1 — markdown lexer depth guard.
 *
 * Byte-faithful port of the official 2.1.290 linux-x64 guard region
 * (@216036381, verbatim):
 *
 *   var Y=/^[ \t>]+/gm,J=/[ \t]+/g,ee=/\n{3,}/g;function te(){let e=new WeakMap,
 *   t=(n)=>(e.get(n)??0)>=100;return{isAtMaxNesting:t,lexLevel:(n,r)=>{if(t(n))return;
 *   let l=e.get(n)??0;e.set(n,l+1);try{return r()}finally{e.set(n,l)}}}}var w=te(),
 *   H=(e)=>e.replace(Y,(t)=>t.replace(J," ").trimStart()).replace(ee,`\n\n`).trimEnd();
 *
 * Semantics (never invented — all from the binary):
 * - One WeakMap counter PER LEXER instance (sibling parses don't share depth).
 * - Cap 100 (`MAX_LEX_NESTING`); at cap `lexLevel` returns `undefined`
 *   WITHOUT running the tokenizer callback (marked then reports "no match").
 * - `finally` restores the previous level so sibling subtrees each get the
 *   full budget, and a throwing tokenizer doesn't wedge the counter.
 * - `H` (flattenNestedMarkdown): per-line `[ \t>]+` prefix → collapse `[ \t]+`
 *   runs to one space then `trimStart` (whitespace-only prefixes vanish;
 *   `>`-bearing prefixes keep their `>` chars — trimStart can't strip a
 *   leading '>'); `\n{3,}` → `\n\n`; `trimEnd`.
 *
 * The at-cap fallback `B` (@216038583) is also ported here so both halves of
 * the guard live in one module; configureMarked (src/utils/markdown.ts) wires
 * it into the paragraph/text tokenizer wrappers.
 */

/** Official `te()` cap — `(e.get(n)??0)>=100`. */
export const MAX_LEX_NESTING = 100

/** Official `Y` — per-line leading whitespace/quote run. */
const PREFIX_RUN = /^[ \t>]+/gm
/** Official `J` — whitespace runs inside the prefix. */
const SPACE_TAB_RUN = /[ \t]+/g
/** Official `ee` — 3+ consecutive newlines. */
const NEWLINE_RUN = /\n{3,}/g

export interface LexLevelGuard {
  /** Official `t`: true when this lexer is already at the nesting cap. */
  isAtMaxNesting(lexer: object): boolean
  /**
   * Official `lexLevel`: at cap → `undefined` (callback NOT run); otherwise
   * increment, run `tokenize()`, and restore the previous level in `finally`.
   */
  lexLevel<T>(lexer: object, tokenize: () => T): T | undefined
}

/** Official `te()` — fresh per-lexer depth guard. */
export function createLexLevelGuard(): LexLevelGuard {
  const levels = new WeakMap<object, number>()
  const isAtMaxNesting = (lexer: object): boolean =>
    (levels.get(lexer) ?? 0) >= MAX_LEX_NESTING
  return {
    isAtMaxNesting,
    lexLevel<T>(lexer: object, tokenize: () => T): T | undefined {
      if (isAtMaxNesting(lexer)) return undefined
      const level = levels.get(lexer) ?? 0
      levels.set(lexer, level + 1)
      try {
        return tokenize()
      } finally {
        levels.set(lexer, level)
      }
    },
  }
}

/** Official `w = te()` — the singleton the tokenizer extension uses. */
export const markdownLexGuard = createLexLevelGuard()

/** Official `H` — flatten nested list/blockquote source to (near-)plain text. */
export function flattenNestedMarkdown(src: string): string {
  return src
    .replace(PREFIX_RUN, match => match.replace(SPACE_TAB_RUN, ' ').trimStart())
    .replace(NEWLINE_RUN, '\n\n')
    .trimEnd()
}

/** The marked internals `B` needs from a tokenizer `this`. */
export interface FallbackTokenizer {
  lexer: {
    inline(src: string, tokens?: Token[]): Token[]
  }
  rules: {
    block: { list: RegExp }
    other: { blockquoteStart: RegExp }
  }
}

/** The token body `B` produces (paragraph/text wrappers add `type`). */
export interface MaxNestingFallbackToken {
  raw: string
  text: string
  tokens: Token[]
}

/**
 * Official `B` (@216038583, verbatim):
 *
 *   function B(e,t){if(!w.isAtMaxNesting(e.lexer)||!(e.rules.block.list.test(t)||
 *   e.rules.other.blockquoteStart.test(t)))return;let n=H(t);
 *   return{raw:t,text:n,tokens:e.lexer.inline(n)}}
 *
 * At cap AND the source still looks like a list/blockquote → flatten it and
 * parse the remainder as INLINE markdown (no further block recursion).
 * Otherwise `undefined` → the wrapper returns `false` → marked falls through
 * to the original tokenizer.
 */
export function maxNestingFallbackToken(
  tokenizer: FallbackTokenizer,
  src: string,
): MaxNestingFallbackToken | undefined {
  if (
    !markdownLexGuard.isAtMaxNesting(tokenizer.lexer) ||
    !(
      tokenizer.rules.block.list.test(src) ||
      tokenizer.rules.other.blockquoteStart.test(src)
    )
  ) {
    return undefined
  }
  const flat = flattenNestedMarkdown(src)
  return { raw: src, text: flat, tokens: tokenizer.lexer.inline(flat) }
}
