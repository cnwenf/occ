/**
 * Claude Code 2.1.296 (OCC-154 #023): the official pretty-print size
 * estimator + blowup gate for workflow results.
 *
 * Official surface (v296 ELF, md5 3c8749470f70a26efadf982b587e1548):
 *   - `Hps(e,i,n)` + private string-skipper `R(e,i)` @215076527 (exported
 *     from chunk-bcy16nn4.js; NEW in v296 — the estimator body pattern
 *     `t+=1+i*++r` has zero v295 hits).
 *   - Chunk constants `var D=500,z=8` @225605959 — `z` is the blowup
 *     multiplier used by the gate (`D` is unused on this path).
 *   - Completion writer `ajr` @225609040 (replaces v295's unconditional
 *     `Hjr` = `_(…,null,2)`):
 *       `c=_(d); Alo(i.outputFile, Hps(c,2,c.length*z) ? _(d,null,2) : c)`
 *
 * Why: indent-2 pretty-printing a ~20,000-deep nested result expands ~40 KB
 * of compact JSON into ~800 MB of text (changelog entry 23: "deeply nested
 * results writing huge task output files"). The estimator walks the COMPACT
 * string once, adding `1 + indent*depth` per bracket/comma at the current
 * nesting depth and 1 per colon — exact for typical payloads, and it exits
 * early as soon as the running estimate passes the budget.
 *
 * `Hps`/`R` below are byte-verbatim renames of the official minified code
 * (loop structure, charCodeAt comparisons, and the `--r`/`++r` pre-order
 * preserved). The official safe-stringify `_` is bytecode-only and NOT
 * replicated — call sites use JSON.stringify (see `stringifyResultGated`
 * for the documented undefined micro-divergence).
 */

/** Official `z=8` @225605959 — pretty budget = compact length × 8. */
export const PRETTY_BLOWUP_MULTIPLIER = 8

/** Indent passed at every official gate call site (`Hps(c,2,…)`). */
export const PRETTY_INDENT = 2

/**
 * Official `R(e,i)` @215076527 (verbatim) — return the index of the closing
 * quote of the JSON string that opens at index `i`, honoring backslash
 * escapes (an odd run of `\` before a quote means the quote is escaped).
 */
function skipJsonString(text: string, start: number): number {
  for (
    let quote = text.indexOf('"', start + 1);
    quote !== -1;
    quote = text.indexOf('"', quote + 1)
  ) {
    let backslashes = 0
    while (text.charCodeAt(quote - 1 - backslashes) === 92) {
      backslashes++
    }
    if (backslashes % 2 === 0) {
      return quote
    }
  }
  return text.length - 1
}

/**
 * Official `Hps(e,i,n)` @215076527 (verbatim):
 *   `function Hps(e,i,n){let t=e.length,r=0;
 *      for(let o=0;o<e.length&&t<=n;o++){let s=e.charCodeAt(o);
 *        if(s===34)o=R(e,o);
 *        else if(s===91||s===123){let u=e.charCodeAt(o+1);
 *          if(u===93||u===125)o++;else t+=1+i*++r}
 *        else if(s===93||s===125)t+=1+i*--r;
 *        else if(s===44)t+=1+i*r;
 *        else if(s===58)t++}
 *      return t<=n}`
 *
 * @param compact  the compact JSON text (official `e`)
 * @param indent   spaces per level (official `i`; always 2 at gate sites)
 * @param budget   max acceptable pretty length (official `n` = e.length*z)
 * @returns true when the indent-`indent` expansion is estimated to fit in
 *          `budget` characters.
 */
export function prettyPrintFits(
  compact: string,
  indent: number,
  budget: number,
): boolean {
  let estimate = compact.length
  let depth = 0
  for (let o = 0; o < compact.length && estimate <= budget; o++) {
    const code = compact.charCodeAt(o)
    if (code === 34) {
      o = skipJsonString(compact, o)
    } else if (code === 91 || code === 123) {
      const next = compact.charCodeAt(o + 1)
      if (next === 93 || next === 125) {
        o++
      } else {
        estimate += 1 + indent * ++depth
      }
    } else if (code === 93 || code === 125) {
      estimate += 1 + indent * --depth
    } else if (code === 44) {
      estimate += 1 + indent * depth
    } else if (code === 58) {
      estimate++
    }
  }
  return estimate <= budget
}

/**
 * The official `ajr` gate shape @225609040 applied to a workflow result:
 * compact-stringify once, expand to indent-2 only when the estimator says
 * the pretty form fits within compact length × `z`.
 *
 * DIVERGENCE (documented, ledger §7.6): when `JSON.stringify(value)`
 * returns `undefined` (top-level undefined/function/symbol — a payload the
 * official writer never sees because `d` is always an object literal), the
 * official would crash on `c.length`; OCC returns the string "undefined",
 * preserving this call site's pre-296 template-literal output rather than
 * inventing a guard the official lacks or crashing the mapper.
 */
export function stringifyResultGated(value: unknown): string {
  const compact = JSON.stringify(value)
  if (compact === undefined) {
    return String(compact)
  }
  return prettyPrintFits(
    compact,
    PRETTY_INDENT,
    compact.length * PRETTY_BLOWUP_MULTIPLIER,
  )
    ? JSON.stringify(value, null, PRETTY_INDENT)
    : compact
}
