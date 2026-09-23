/**
 * Pure-TypeScript port of vendor/file-index-src (Rust NAPI module).
 *
 * The native module wraps nucleo (https://github.com/helix-editor/nucleo) for
 * high-performance fuzzy file searching. This port reimplements the same API
 * and scoring behavior without native dependencies.
 *
 * Key API:
 *   new FileIndex()
 *   .loadFromFileList(fileList: string[]): void   — dedupe + index paths
 *   .search(query: string, limit: number): SearchResult[]
 *
 * Score semantics: lower = better. Score is position-in-results / result-count,
 * so the best match is 0.0. Paths containing "test" get a 1.05× penalty (capped
 * at 1.0) so non-test files rank slightly higher. Each result also carries the
 * highlight `positions` (needle-char offsets within the path).
 *
 * CC 2.1.280 (#074) name anchoring: when the greedy full-path match starts
 * before the basename AND incurred a gap penalty, the query is re-matched
 * inside the basename; the better of the two scores wins and `scanFrom`
 * records which anchoring won so highlight extraction starts at the right
 * offset. A file whose NAME contains the query therefore ranks above one that
 * only matches across its folder names.
 */

export type SearchResult = {
  path: string
  score: number
  /** Highlight offsets of the needle chars within `path` (UTF-16 indices). */
  positions: number[]
}

// nucleo-style scoring constants (approximating fzf-v2 / nucleo bonuses)
const SCORE_MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 6
const BONUS_CONSECUTIVE = 4
const BONUS_FIRST_CHAR = 8
const PENALTY_GAP_START = 3
const PENALTY_GAP_EXTENSION = 1

const TOP_LEVEL_CACHE_LIMIT = 100
const MAX_QUERY_LEN = 64
// Yield to event loop after this many ms of sync work. Chunk sizes are
// time-based (not count-based) so slow machines get smaller chunks and
// stay responsive — 5k paths is ~2ms on M-series but could be 15ms+ on
// older Windows hardware.
const CHUNK_MS = 4

// Reusable buffer: records where each needle char matched during the indexOf scan
const posBuf = new Int32Array(MAX_QUERY_LEN)
// Reusable buffer: match positions from the basename-anchored re-match (v280
// `nameMatchPositions`). Kept module-level like posBuf — both are per-call
// scratch, and search() never re-enters itself.
const namePosBuf = new Int32Array(MAX_QUERY_LEN)

export class FileIndex {
  private paths: string[] = []
  private lowerPaths: string[] = []
  private charBits: Int32Array = new Int32Array(0)
  private pathLens: Uint16Array = new Uint16Array(0)
  // Byte offset of each path's basename (just past the last `/` or `\`), and
  // the a–z bitmap of that basename only. v280 #074: the bitmap is an O(1)
  // precheck before attempting a basename-anchored re-match, and the offset
  // both gates it (only re-anchor when the full-path match started in the
  // directory portion) and seeds highlight extraction.
  private nameStarts: Uint16Array = new Uint16Array(0)
  private nameCharBits: Int32Array = new Int32Array(0)
  private topLevelCache: SearchResult[] | null = null
  // During async build, tracks how many paths have bitmap/lowerPath filled.
  // search() uses this to search the ready prefix while build continues.
  private readyCount = 0

  /**
   * Load paths from an array of strings.
   * This is the main way to populate the index — ripgrep collects files, we just search them.
   * Automatically deduplicates paths.
   */
  loadFromFileList(fileList: string[]): void {
    // Deduplicate and filter empty strings (matches Rust HashSet behavior)
    const seen = new Set<string>()
    const paths: string[] = []
    for (const line of fileList) {
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
    }

    this.buildIndex(paths)
  }

  /**
   * Async variant: yields to the event loop every ~8–12k paths so large
   * indexes (270k+ files) don't block the main thread for >10ms at a time.
   * Identical result to loadFromFileList.
   *
   * Returns { queryable, done }:
   *   - queryable: resolves as soon as the first chunk is indexed (search
   *     returns partial results). For a 270k-path list this is ~5–10ms of
   *     sync work after the paths array is available.
   *   - done: resolves when the entire index is built.
   */
  loadFromFileListAsync(fileList: string[]): {
    queryable: Promise<void>
    done: Promise<void>
  } {
    let markQueryable: () => void = () => {}
    const queryable = new Promise<void>(resolve => {
      markQueryable = resolve
    })
    const done = this.buildAsync(fileList, markQueryable)
    return { queryable, done }
  }

  private async buildAsync(
    fileList: string[],
    markQueryable: () => void,
  ): Promise<void> {
    const seen = new Set<string>()
    const paths: string[] = []
    let chunkStart = performance.now()
    for (let i = 0; i < fileList.length; i++) {
      const line = fileList[i]!
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
      // Check every 256 iterations to amortize performance.now() overhead
      if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
        await yieldToEventLoop()
        chunkStart = performance.now()
      }
    }

    this.resetArrays(paths)

    chunkStart = performance.now()
    let firstChunk = true
    for (let i = 0; i < paths.length; i++) {
      this.indexPath(i)
      if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
        this.readyCount = i + 1
        if (firstChunk) {
          markQueryable()
          firstChunk = false
        }
        await yieldToEventLoop()
        chunkStart = performance.now()
      }
    }
    this.readyCount = paths.length
    markQueryable()
  }

  private buildIndex(paths: string[]): void {
    this.resetArrays(paths)
    for (let i = 0; i < paths.length; i++) {
      this.indexPath(i)
    }
    this.readyCount = paths.length
  }

  private resetArrays(paths: string[]): void {
    const n = paths.length
    this.paths = paths
    this.lowerPaths = new Array(n)
    this.charBits = new Int32Array(n)
    this.pathLens = new Uint16Array(n)
    this.nameStarts = new Uint16Array(n)
    this.nameCharBits = new Int32Array(n)
    this.readyCount = 0
    this.topLevelCache = computeTopLevelEntries(paths, TOP_LEVEL_CACHE_LIMIT)
  }

  // Precompute: lowercase, a–z bitmap, length, basename offset + basename
  // bitmap. Bitmap gives O(1) rejection of paths missing any needle letter
  // (89% survival for broad queries like "test" → still a 10%+ free win;
  // 90%+ rejection for rare chars). Official v280 indexPath:
  //   if(g>=97&&g<=122)r|=1<<g-97,c|=1<<g-97;
  //   else if((g===47||g===92)&&d<s-1)i=d+1,c=0
  private indexPath(i: number): void {
    const lp = this.paths[i]!.toLowerCase()
    this.lowerPaths[i] = lp
    const len = lp.length
    this.pathLens[i] = len
    let bits = 0
    let nameStart = 0
    let nameBits = 0
    for (let j = 0; j < len; j++) {
      const c = lp.charCodeAt(j)
      if (c >= 97 && c <= 122) {
        bits |= 1 << (c - 97)
        nameBits |= 1 << (c - 97)
      } else if ((c === 47 || c === 92) && j < len - 1) {
        // Non-trailing separator: the next segment becomes the basename
        nameStart = j + 1
        nameBits = 0
      }
    }
    this.charBits[i] = bits
    // toLowerCase() can change string length (e.g. 'İ' → 2 chars); when it
    // did, lowercased offsets no longer align with the original path, so name
    // anchoring is disabled (official: `s===this.paths[e].length?i:0`).
    this.nameStarts[i] = len === this.paths[i]!.length ? nameStart : 0
    this.nameCharBits[i] = nameBits
  }

  /**
   * Search for files matching the query using fuzzy matching.
   * Returns top N results sorted by match score.
   */
  search(query: string, limit: number): SearchResult[] {
    if (limit <= 0) return []
    if (query.length === 0) {
      if (this.topLevelCache) {
        return this.topLevelCache
          .slice(0, limit)
          .map(({ path, score }) => ({ path, score, positions: [] }))
      }
      return []
    }

    // Smart case: lowercase query → case-insensitive; any uppercase → case-sensitive
    const caseSensitive = query !== query.toLowerCase()
    const needle = caseSensitive ? query : query.toLowerCase()
    const nLen = Math.min(needle.length, MAX_QUERY_LEN)
    const needleChars: string[] = new Array(nLen)
    let needleBitmap = 0
    for (let j = 0; j < nLen; j++) {
      const ch = needle.charAt(j)
      needleChars[j] = ch
      const cc = ch.charCodeAt(0)
      if (cc >= 97 && cc <= 122) needleBitmap |= 1 << (cc - 97)
    }

    // Upper bound on score assuming every match gets the max boundary bonus.
    // Used to reject paths whose gap penalties alone make them unable to beat
    // the current top-k threshold, before the charCodeAt-heavy boundary pass.
    const scoreCeiling =
      nLen * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32

    // Top-k: maintain a sorted-ascending array of the best `limit` matches.
    // Avoids O(n log n) sort of all matches when we only need `limit` of them.
    // pathIndex (not the path string) is stored so the results pass can
    // re-derive both the original-case path and its lowercase form, and
    // scanFrom carries which anchoring won for highlight extraction.
    const topK: {
      pathIndex: number
      fuzzScore: number
      scanFrom: number
    }[] = []
    let threshold = -Infinity

    const {
      paths,
      lowerPaths,
      charBits,
      pathLens,
      readyCount,
      nameStarts,
      nameCharBits,
    } = this

    outer: for (let i = 0; i < readyCount; i++) {
      // O(1) bitmap reject: path must contain every letter in the needle
      if ((charBits[i]! & needleBitmap) !== needleBitmap) continue

      const haystack = caseSensitive ? paths[i]! : lowerPaths[i]!

      // Fused indexOf scan: find positions (SIMD-accelerated in JSC/V8) AND
      // accumulate gap/consecutive terms inline. The greedy-earliest positions
      // found here are identical to what the charCodeAt scorer would find, so
      // we score directly from them — no second scan.
      let pos = haystack.indexOf(needleChars[0]!)
      if (pos === -1) continue
      posBuf[0] = pos
      let gapPenalty = 0
      let consecBonus = 0
      let prev = pos
      for (let j = 1; j < nLen; j++) {
        pos = haystack.indexOf(needleChars[j]!, prev + 1)
        if (pos === -1) continue outer
        posBuf[j] = pos
        const gap = pos - prev - 1
        if (gap === 0) consecBonus += BONUS_CONSECUTIVE
        else gapPenalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION
        prev = pos
      }

      // v280 #074 name anchoring: when the full-path match incurred a gap
      // penalty AND started before the basename AND the basename alone holds
      // every needle letter (bitmap precheck), greedily re-match the query
      // inside the basename. nameNet is its consecutive-minus-gap net, or
      // -Infinity when the basename can't hold the whole needle in order.
      const nameStart = nameStarts[i]!
      const nameNet =
        gapPenalty > 0 &&
        posBuf[0]! < nameStart &&
        (nameCharBits[i]! & needleBitmap) === needleBitmap
          ? matchNameAnchored(haystack, needleChars, nameStart, namePosBuf)
          : -Infinity

      // Gap-bound reject: if the best-case score (all boundary bonuses) minus
      // known gap penalties can't beat threshold, skip the boundary pass. The
      // v280 max() lets a name-anchored candidate survive on its stronger net.
      if (
        topK.length === limit &&
        scoreCeiling + Math.max(consecBonus - gapPenalty, nameNet) <= threshold
      ) {
        continue
      }

      // Boundary/camelCase scoring on the full-path positions.
      const path = paths[i]!
      const hLen = pathLens[i]!
      let score = consecBonus - gapPenalty + scoreBonusSum(path, posBuf, nLen)
      let scanFrom = 0

      // Name-anchored alternative: its own net plus its own boundary bonuses.
      // On a tie the name anchor wins (`>=`), matching the official scorer.
      if (nameNet !== -Infinity) {
        const nameScore = nameNet + scoreBonusSum(path, namePosBuf, nLen)
        if (nameScore >= score) {
          score = nameScore
          scanFrom = nameStart
        }
      }

      score += nLen * SCORE_MATCH + Math.max(0, 32 - (hLen >> 2))

      if (topK.length < limit) {
        topK.push({ pathIndex: i, fuzzScore: score, scanFrom })
        if (topK.length === limit) {
          topK.sort((a, b) => a.fuzzScore - b.fuzzScore)
          threshold = topK[0]!.fuzzScore
        }
      } else if (score > threshold) {
        let lo = 0
        let hi = topK.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (topK[mid]!.fuzzScore < score) lo = mid + 1
          else hi = mid
        }
        topK.splice(lo, 0, { pathIndex: i, fuzzScore: score, scanFrom })
        topK.shift()
        threshold = topK[0]!.fuzzScore
      }
    }

    // topK is ascending; reverse to descending (best first)
    topK.sort((a, b) => b.fuzzScore - a.fuzzScore)

    const matchCount = topK.length
    const denom = Math.max(matchCount, 1)
    const results: SearchResult[] = new Array(matchCount)

    for (let i = 0; i < matchCount; i++) {
      const pathIndex = topK[i]!.pathIndex
      const path = paths[pathIndex]!
      const lowerPath = lowerPaths[pathIndex]!
      const haystack = caseSensitive ? path : lowerPath

      // Highlight extraction re-walks the needle from the winning anchor's
      // offset (scanFrom): 0 for a full-path win, nameStart for a name-anchored
      // win. Starting at nameStart is what lands the highlights on the
      // basename instead of the scattered full-path match.
      const positions: number[] = new Array(nLen)
      let from = topK[i]!.scanFrom
      for (let j = 0; j < nLen; j++) {
        const at = haystack.indexOf(needleChars[j]!, from)
        positions[j] = at
        from = at + 1
      }
      // Lowercasing can shift offsets for non-ASCII (e.g. 'İ'); remap to the
      // original path's coordinates when the two lengths diverged.
      if (!caseSensitive && lowerPath.length !== path.length) {
        remapUnicodePositions(path, positions)
      }

      const positionScore = i / denom
      const finalScore = path.includes('test')
        ? Math.min(positionScore * 1.05, 1.0)
        : positionScore
      results[i] = { path, score: finalScore, positions }
    }

    return results
  }
}

/**
 * Boundary/camelCase bonus for a match at position `pos` in the original-case
 * path. `first` enables the start-of-string bonus (only for needle[0]).
 */
function scoreBonusAt(path: string, pos: number, first: boolean): number {
  if (pos === 0) return first ? BONUS_FIRST_CHAR : 0
  const prevCh = path.charCodeAt(pos - 1)
  if (isBoundary(prevCh)) return BONUS_BOUNDARY
  if (isLower(prevCh) && isUpper(path.charCodeAt(pos))) return BONUS_CAMEL
  return 0
}

/**
 * Sum of boundary/camelCase bonuses for a matched needle run. Official v280
 * `js(path, positions, nLen)` = `Ks(path,pos[0],true) + Σ Ks(path,pos[i],false)`.
 * `positions` is either the full-path match buffer (posBuf) or the basename
 * re-match buffer (namePosBuf) — the same scoring applies to both anchoring
 * modes, which is what makes their net scores directly comparable.
 */
function scoreBonusSum(
  path: string,
  positions: Int32Array,
  nLen: number,
): number {
  let sum = scoreBonusAt(path, positions[0]!, true)
  for (let j = 1; j < nLen; j++) {
    sum += scoreBonusAt(path, positions[j]!, false)
  }
  return sum
}

/**
 * Greedy re-match of the needle inside the basename only, starting at
 * `nameStart`. Official v280 `Zc(haystack, needleChars, nameStart, out)`:
 * walks each needle char in order via indexOf from `nameStart`, recording hit
 * offsets into `out`, and returns the consecutive-bonus-minus-gap-penalty net.
 * Returns -Infinity the moment a char is missing (needle doesn't fit in order
 * within the basename) so the caller keeps the full-path score.
 */
function matchNameAnchored(
  haystack: string,
  needleChars: string[],
  nameStart: number,
  outPositions: Int32Array,
): number {
  let net = 0
  let prev = nameStart - 1
  for (let j = 0; j < needleChars.length; j++) {
    const at = haystack.indexOf(needleChars[j]!, prev + 1)
    if (at === -1) return -Infinity
    outPositions[j] = at
    const gap = at - prev - 1
    if (j > 0) {
      net +=
        gap === 0
          ? BONUS_CONSECUTIVE
          : -(PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION)
    }
    prev = at
  }
  return net
}

/**
 * Remap highlight positions computed against the lowercased path back onto the
 * original path's UTF-16 offsets. Official v280 `od(path, positions)` (v278
 * `Wc`): only needed when toLowerCase() changed the string length (e.g. 'İ' →
 * 2 chars), which would otherwise shift every downstream offset. Mutates
 * `positions` in place.
 */
function remapUnicodePositions(path: string, positions: number[]): void {
  let srcIdx = 0
  let lowerIdx = 0
  let posIdx = 0
  while (posIdx < positions.length && srcIdx < path.length) {
    const cp = path.codePointAt(srcIdx)!
    const cpUnits = cp > 65535 ? 2 : 1
    const lowerLen = String.fromCodePoint(cp).toLowerCase().length
    while (
      posIdx < positions.length &&
      positions[posIdx]! < lowerIdx + lowerLen
    ) {
      positions[posIdx] = srcIdx
      posIdx++
    }
    srcIdx += cpUnits
    lowerIdx += lowerLen
  }
}

function isBoundary(code: number): boolean {
  // / \ - _ . space
  return (
    code === 47 || // /
    code === 92 || // \
    code === 45 || // -
    code === 95 || // _
    code === 46 || // .
    code === 32 // space
  )
}

function isLower(code: number): boolean {
  return code >= 97 && code <= 122
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export { CHUNK_MS }

/**
 * Extract unique top-level path segments, sorted by (length asc, then alpha asc).
 * Handles both Unix (/) and Windows (\) path separators.
 * Mirrors FileIndex::compute_top_level_entries in lib.rs.
 */
function computeTopLevelEntries(
  paths: string[],
  limit: number,
): SearchResult[] {
  const topLevel = new Set<string>()

  for (const p of paths) {
    // Split on first / or \ separator
    let end = p.length
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i)
      if (c === 47 || c === 92) {
        end = i
        break
      }
    }
    const segment = p.slice(0, end)
    if (segment.length > 0) {
      topLevel.add(segment)
      if (topLevel.size >= limit) break
    }
  }

  const sorted = Array.from(topLevel)
  sorted.sort((a, b) => {
    const lenDiff = a.length - b.length
    if (lenDiff !== 0) return lenDiff
    return a < b ? -1 : a > b ? 1 : 0
  })

  return sorted
    .slice(0, limit)
    .map(path => ({ path, score: 0.0, positions: [] as number[] }))
}

export default FileIndex
export type { FileIndex as FileIndexType }
