/**
 * Surrogate-safe string slicer.
 *
 * CC 2.1.309 (item 16): official 309 replaced the raw `.slice(0, a)` in the
 * persisted-output preview builder with the shared surrogate-safe slicer.
 * Official `fe`/`re` body — byte-identical in BIN309 @278224106 and BIN308
 * @277377970 (the utility pre-existed; 309 only changed the preview call
 * site, `mht` @247455011 `{preview:re(e,i),hasMore:!0}` vs 308 `Bmt`'s raw
 * `e.slice(0,a)` @246552671):
 *
 *   function fe(e,t){if(t<=0)return"";return e.length<=t?e:
 *     e.slice(0,t).replace(/[\uD800-\uDBFF]$/,"")}
 *
 * Cutting at an arbitrary UTF-16 index can leave a trailing lone high
 * surrogate; JSON.stringify escapes it to a lone \udXXX and parsers (jq,
 * transcript readers) choke on the unpaired code unit. Stripping the
 * trailing high surrogate keeps output JSON-round-trip-stable.
 *
 * Structural deviation: official minified `fe`/`re` → OCC `safeSlice`
 * (shared util file), semantics byte-faithful.
 */

/**
 * Returns `str` truncated to at most `maxChars` UTF-16 code units, dropping a
 * trailing lone high surrogate when the cut lands mid surrogate pair.
 * Returns `''` when `maxChars <= 0` and `str` unchanged when it already fits.
 */
export function safeSlice(str: string, maxChars: number): string {
  if (maxChars <= 0) {
    return ''
  }
  return str.length <= maxChars
    ? str
    : str.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, '')
}
