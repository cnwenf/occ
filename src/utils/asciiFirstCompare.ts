/**
 * ASCII-first name comparator — CC 2.1.293 changelog entry #46.
 *
 * Official binary (`ZCe` @204175795, byte-verified), verbatim:
 *
 * ```js
 * var f=/^[\x00-\x7f]*$/;
 * function ZCe(t,n){let e=f.test(t);if(e!==f.test(n))return e?-1:1;
 *   if(e)return t.localeCompare(n);if(t===n)return 0;return t<n?-1:1}
 * ```
 *
 * Names announced to the model (agent listings, MCP server instruction pools)
 * previously sorted with plain `localeCompare`, which interleaves non-ASCII
 * names among ASCII ones by locale collation (e.g. `Ünicorn` before `zeta`) and
 * varies by machine locale. The official 2.1.293 comparator partitions instead:
 *
 * 1. pure-ASCII names always sort before any name containing a non-ASCII code
 *    point (returns exactly -1 / 1);
 * 2. inside the ASCII partition, ordering is `localeCompare` — note this drops
 *    the `sensitivity: 'base'` option OCC used to pass, mirroring the binary;
 * 3. otherwise ordering is UTF-16 code-unit (`<`), with 0 for equal strings.
 *
 * Sites switched to it upstream (6) and their OCC counterparts (4) are listed
 * in docs/gap-research-293/triage-293.md §46.
 */

/** Matches strings made entirely of ASCII code points (`\x00`–`\x7f`). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: official binary-verbatim ASCII partition regex `f` (v293 `ZCe` @204175795) — the C0 range IS the check
const ASCII_ONLY = /^[\x00-\x7f]*$/

/**
 * Compare two names ASCII-first, matching official `ZCe`.
 * Suitable as an `Array.prototype.sort` comparator.
 */
export function compareNamesAsciiFirst(a: string, b: string): number {
  const aIsAscii = ASCII_ONLY.test(a)
  if (aIsAscii !== ASCII_ONLY.test(b)) return aIsAscii ? -1 : 1
  if (aIsAscii) return a.localeCompare(b)
  if (a === b) return 0
  return a < b ? -1 : 1
}
