/**
 * CC 2.1.290 cluster E items #5/#6 — chunked NFKC/NFKD engine.
 *
 * Byte-faithful port of the official 2.1.290 linux-x64 chunked-normalize
 * module (chunk-z6am4wsr.js @202016511; public API `zTe` = NFKC, `lps` =
 * NFKD). Motivation (official): pathological `.normalize()` cost in JSC when
 * a string contains very long runs of combining characters (e.g. a malicious
 * MCP tool description) — the run is canonically ordered BY HAND first (which
 * keeps the platform normalizer in its fast path), and long strings are
 * normalized in 128-code-unit windows whose boundaries are placed at STARTER
 * code points, carrying trailing non-starters into the next window.
 *
 * Official verbatim source (minified names → local names in each docblock):
 *
 *   var L=new RegExp("[\\p{M}\\uFF9E\\uFF9F]{32,}","gu"),
 *       h=new RegExp("[\\p{M}\\uFF9E\\uFF9F]","u");
 *   var f=new Map,p=[],_=new Map;
 *   function g(e,n){return e!==n&&(e+n).normalize("NFD")===n+e}
 *   function I(e){...binary insertion into p...}
 *   function S(e){...cached per-codepoint NFKD codepoints...}
 *   var C=4096;
 *   function b(e,n){...chunked String.fromCodePoint re-encode...}
 *   function F(e){...canonical combining-order of one run...}
 *   function w(e){return e.length<32?e:e.replace(L,F)}
 *   var E=128;
 *   function A(e){...isStarter...}
 *   function T(e,n){...next window boundary at a starter...}
 *   function y(e){...start of trailing non-starter tail...}
 *   function m(e,n){...windowed normalize with non-starter carry...}
 *   function zTe(e){return m(e,"NFKC")}
 *   function lps(e){return m(e,"NFKD")}
 *
 * Constants are the official ones (never invented): window 128, combining-run
 * threshold 32, re-encode chunk 4096.
 */

/** Official `E=128` — normalize window size (UTF-16 code units). */
export const CHUNK_WINDOW_SIZE = 128

/** Official `L={32,}` — minimum run length that triggers manual ordering. */
export const COMBINING_RUN_MIN = 32

/** Official `C=4096` — `String.fromCodePoint` re-encode chunk size. */
export const RE_ENCODE_CHUNK_SIZE = 4096

/** Official `L` — a run of ≥32 combining marks (incl. halfwidth voiced marks). */
const COMBINING_RUN_PATTERN = /[\p{M}\uFF9E\uFF9F]{32,}/gu

/** Official `h` — a single combining mark. */
const COMBINING_CHAR_PATTERN = /[\p{M}\uFF9E\uFF9F]/u

/** Canonical-class sample slot discovered by binary insertion (official `p` entry). */
interface CombiningClassSample {
  order: number
  sample: string
}

/** Official `f` — codepoint → class sample (or null for starters). */
const combiningClassCache = new Map<number, CombiningClassSample | null>()

/** Official `p` — sorted class samples (order = canonical combining class rank). */
const combiningClassSamples: CombiningClassSample[] = []

/** Official `_` — codepoint → its NFKD decomposition as codepoints. */
const nfkdCodePointsCache = new Map<number, number[]>()

/** Official `g`: true when `a` canonically combines with `b` (in that order). */
function mayCombine(a: string, b: string): boolean {
  return a !== b && (a + b).normalize('NFD') === b + a
}

/**
 * Official `I(e)`: combining-class sample lookup with lazy discovery.
 * Returns the sample entry, or `null` when the codepoint is a starter
 * (class 0) — determined empirically via `g` against U+0334 / U+0345 probes
 * and binary insertion into the sorted `p` array.
 */
function combiningClassOf(
  codepoint: number,
): CombiningClassSample | null {
  const cached = combiningClassCache.get(codepoint)
  if (cached !== undefined) return cached
  const char = String.fromCodePoint(codepoint)
  let entry: CombiningClassSample | null = null
  if (
    char === '\u0334' ||
    mayCombine(char, '\u0334') ||
    mayCombine('\u0345', char)
  ) {
    let low = 0
    let high = combiningClassSamples.length
    while (low < high && entry === null) {
      const mid = (low + high) >> 1
      const sample = combiningClassSamples[mid]!
      if (mayCombine(char, sample.sample)) {
        low = mid + 1
      } else if (mayCombine(sample.sample, char)) {
        high = mid
      } else {
        entry = sample
      }
    }
    if (entry === null) {
      entry = { order: low, sample: char }
      combiningClassSamples.splice(low, 0, entry)
      for (let i = low + 1; i < combiningClassSamples.length; i++) {
        combiningClassSamples[i]!.order = i
      }
    }
  }
  combiningClassCache.set(codepoint, entry)
  return entry
}

/** Official `S(e)`: cached NFKD decomposition of one codepoint. */
function nfkdCodePoints(codepoint: number): number[] {
  let decomposition = nfkdCodePointsCache.get(codepoint)
  if (decomposition === undefined) {
    decomposition = Array.from(
      String.fromCodePoint(codepoint).normalize('NFKD'),
      char => char.codePointAt(0)!,
    )
    nfkdCodePointsCache.set(codepoint, decomposition)
  }
  return decomposition
}

/** Official `b(e,n)`: chunked re-encode (spread-safe 4096-codepoint slices). */
function reEncodeCodePoints(codepoints: Int32Array, count: number): string {
  let out = ''
  for (let i = 0; i < count; i += RE_ENCODE_CHUNK_SIZE) {
    out += String.fromCodePoint(
      ...codepoints.subarray(i, Math.min(i + RE_ENCODE_CHUNK_SIZE, count)),
    )
  }
  return out
}

/**
 * Official `F(e)`: canonical combining-order of one ≥32-mark run.
 * NFKD-decompose every codepoint, look up each combining class (-1 = starter),
 * then stable-counting-sort every maximal non-starter segment that is NOT
 * already in non-decreasing class order.
 */
function canonicallyOrderRun(run: string): string {
  let codepoints = new Int32Array(run.length + 16)
  let count = 0
  for (let i = 0; i < run.length; ) {
    const codepoint = run.codePointAt(i)!
    i += codepoint > 65535 ? 2 : 1
    for (const decomposed of nfkdCodePoints(codepoint)) {
      if (count === codepoints.length) {
        const grown = new Int32Array(codepoints.length * 2)
        grown.set(codepoints)
        codepoints = grown
      }
      codepoints[count++] = decomposed
      combiningClassOf(decomposed) // populate the class cache
    }
  }
  const classes = new Int16Array(count)
  for (let i = 0; i < count; i++) {
    classes[i] = combiningClassCache.get(codepoints[i]!)?.order ?? -1
  }
  const sorted = codepoints.slice(0, count)
  const offsets = new Int32Array(combiningClassSamples.length)
  for (let i = 0; i < count; ) {
    let j = i
    let inOrder = true
    while (j < count && classes[j]! >= 0) {
      inOrder &&= j === i || classes[j - 1]! <= classes[j]!
      j++
    }
    if (inOrder) {
      i = j + 1
      continue
    }
    offsets.fill(0)
    for (let k = i; k < j; k++) offsets[classes[k]!]++
    let base = i
    for (let k = 0; k < offsets.length; k++) {
      const seen = offsets[k]!
      offsets[k] = base
      base += seen
    }
    for (let k = i; k < j; k++) {
      sorted[offsets[classes[k]!]++] = codepoints[k]!
    }
    i = j
  }
  return reEncodeCodePoints(sorted, count)
}

/** Official `w(e)`: reorder every ≥32-mark combining run. */
function reorderCombiningRuns(value: string): string {
  return value.length < COMBINING_RUN_MIN
    ? value
    : value.replace(COMBINING_RUN_PATTERN, canonicallyOrderRun)
}

/** Official `A(e)`: is this codepoint a Unicode starter (class 0)? */
function isStarterCodePoint(codepoint: number): boolean {
  if (codepoint < 768) return true
  const cached = nfkdCodePointsCache.get(codepoint)
  if (
    cached === undefined &&
    !COMBINING_CHAR_PATTERN.test(String.fromCodePoint(codepoint))
  ) {
    return true
  }
  return combiningClassOf((cached ?? nfkdCodePoints(codepoint))[0]!) === null
}

/**
 * Official `T(e,n)`: next window boundary at/after `pos` — first a surrogate
 * repair, then skip forward while the codepoint is a non-starter.
 */
function nextWindowBoundary(value: string, pos: number): number {
  let boundary = pos
  if (
    boundary < value.length &&
    (value.charCodeAt(boundary) & 64512) === 56320 &&
    (value.charCodeAt(boundary - 1) & 64512) === 55296
  ) {
    boundary++
  }
  while (boundary < value.length) {
    const codepoint = value.codePointAt(boundary)!
    if (isStarterCodePoint(codepoint)) break
    boundary += codepoint > 65535 ? 2 : 1
  }
  return Math.min(boundary, value.length)
}

/** Official `y(e)`: start index of the trailing non-starter run. */
function trailingNonStarterStart(value: string): number {
  let n = value.length
  while (n > 0) {
    n--
    if (n > 0 && (value.charCodeAt(n) & 64512) === 56320 && (value.charCodeAt(n - 1) & 64512) === 55296) {
      n--
    }
    if (isStarterCodePoint(value.codePointAt(n)!)) return n
  }
  return 0
}

/**
 * Official `m(e,n)`: reorder runs, then normalize in 128-unit windows cut at
 * starter boundaries, carrying each window's trailing non-starters into the
 * next (so composition never sees a split cluster). The final window keeps
 * its whole normalized output.
 */
function windowedNormalize(value: string, form: 'NFKC' | 'NFKD'): string {
  const reordered = reorderCombiningRuns(value)
  if (reordered.length <= CHUNK_WINDOW_SIZE) return reordered.normalize(form)
  const parts: string[] = []
  let carry = ''
  for (let start = 0; start < reordered.length; ) {
    const end = nextWindowBoundary(reordered, start + CHUNK_WINDOW_SIZE)
    const normalized = (carry + reordered.slice(start, end)).normalize(form)
    const keep =
      end === reordered.length
        ? normalized.length
        : trailingNonStarterStart(normalized)
    parts.push(normalized.slice(0, keep))
    carry = normalized.slice(keep)
    start = end
  }
  return parts.join('')
}

/** Official `zTe(e)` — chunked NFKC. */
export function chunkedNFKC(value: string): string {
  return windowedNormalize(value, 'NFKC')
}

/** Official `lps(e)` — chunked NFKD. */
export function chunkedNFKD(value: string): string {
  return windowedNormalize(value, 'NFKD')
}
