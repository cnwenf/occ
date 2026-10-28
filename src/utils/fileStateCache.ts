import { LRUCache } from 'lru-cache'
import { normalize } from 'path'
import { countCharInString } from './stringUtils.js'

export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  // True when this entry was populated by auto-injection (e.g. CLAUDE.md) and
  // the injected content did not match disk (stripped HTML comments, stripped
  // frontmatter, truncated MEMORY.md). The model has only seen a partial view,
  // so this entry never counts as a full read (isFullReadOfFileState is false)
  // and the 2.1.228 staleness content-match path cannot use it; recovery then
  // requires the edit to still apply plus a read-auto-allowed path (Mwt).
  // `content` here holds the RAW disk bytes (for getChangedFiles diffing),
  // not what the model saw.
  isPartialView?: boolean
  // CC 2.1.295 (official FileState field, consumed via k4): true when the
  // model never saw this entry's content — seeded from a Bash read whose
  // output was persisted/truncated (gvn 5th param undefined), from a
  // grep-family spec (content shown as matches, not the whole file), from
  // Write/Edit reseeds whose prior state was not a trusted full read, or
  // from resume-time Edit disk re-extraction (queryHelpers). Flagged entries
  // never satisfy the trusted-full-read predicate (k4 ≡
  // isFileStateFullyTrusted in fileStateGuard.ts), so the Read dedupe stub
  // and the at-mention already_read_file shortcut re-send the content
  // instead of claiming the file is already in context.
  contentNotInModelContext?: boolean
}

// Default max entries for read file state caches
export const READ_FILE_STATE_CACHE_SIZE = 100

// Default size limit for file state caches (25MB)
// This prevents unbounded memory growth from large file contents
const DEFAULT_MAX_CACHE_SIZE_BYTES = 25 * 1024 * 1024

/**
 * CC 2.1.312 (item 4) — official CR @244818957 (byte-verified):
 *   `function CR(e){if((e.offset??1)>1||e.isPartialView)return!1;
 *     if(e.limit===void 0)return!0;
 *     return e.content!==""&&Lt(e.content,"\n")+1<e.limit}`
 * ≡ fileStateGuard.isFullReadOfFileState. Inlined here (not imported) because
 * fileStateGuard.ts imports this module for the FileState type and pulling the
 * guard module into this leaf would invert the dependency; the two spellings
 * are kept in lockstep by the startOnlyGuard312 tests.
 */
function isFullReadEntry(state: FileState): boolean {
  if ((state.offset ?? 1) > 1 || state.isPartialView) {
    return false
  }
  if (state.limit === undefined) {
    return true
  }
  return (
    state.content !== '' &&
    countCharInString(state.content, '\n') + 1 < state.limit
  )
}

/**
 * CC 2.1.312 (item 4) — official Yoe @244818076 (byte-verified):
 *   `function Yoe(e){return e!==void 0&&CR(e)&&!e.contentNotInModelContext}`
 * ≡ fileStateGuard.isFileStateFullyTrusted (same inlining rationale as above).
 */
function isTrustedFullReadEntry(state: FileState | undefined): boolean {
  return (
    state !== undefined &&
    isFullReadEntry(state) &&
    !state.contentNotInModelContext
  )
}

/**
 * A file state cache that normalizes all path keys before access.
 * This ensures consistent cache hits regardless of whether callers pass
 * relative vs absolute paths with redundant segments (e.g. /foo/../bar)
 * or mixed path separators on Windows (/ vs \).
 */
export class FileStateCache {
  private cache: LRUCache<string, FileState>

  /**
   * CC 2.1.312 (item 4) — official Sa @244819043 `startOnly=new Set`:
   * eviction-proof set of paths whose content was CUT when seeded from
   * context (nested CLAUDE.md / @-include head cut). Deliberately NOT part
   * of the LRU: evicting the read-state entry must not lose the Write block
   * (the pre-312 regression). Official markStartOnly/holdsOnlyStartOf use
   * rn = `normalize` from "path" (@244818705 chunk import) — the same
   * normalization this cache's get/set use.
   */
  private startOnly = new Set<string>()

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: value => Math.max(1, Buffer.byteLength(value.content)),
    })
  }

  get(key: string): FileState | undefined {
    return this.cache.get(normalize(key))
  }

  /** Official Sa.markStartOnly @244819043: `this.startOnly.add(rn(e))`. */
  markStartOnly(key: string): void {
    this.startOnly.add(normalize(key))
  }

  /** Official Sa.startOnlyPaths @244819043: `return[...this.startOnly]`. */
  startOnlyPaths(): string[] {
    return [...this.startOnly]
  }

  /**
   * Official Sa.holdsOnlyStartOf @244819043 (byte-verified):
   *   `holdsOnlyStartOf(e){let n=rn(e);
   *      return this.startOnly.has(n)&&!Yoe(this.cache.get(n))}`
   * True while the path is marked AND the cached entry is not a trusted full
   * read (Yoe @244818076 ≡ isTrustedFullReadEntry above) — a later whole-file
   * Read in one call clears the block, eviction keeps it.
   */
  holdsOnlyStartOf(key: string): boolean {
    const normalized = normalize(key)
    return (
      this.startOnly.has(normalized) &&
      !isTrustedFullReadEntry(this.cache.get(normalized))
    )
  }

  set(key: string, value: FileState): this {
    this.cache.set(normalize(key), value)
    return this
  }

  has(key: string): boolean {
    return this.cache.has(normalize(key))
  }

  delete(key: string): boolean {
    return this.cache.delete(normalize(key))
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }

  get max(): number {
    return this.cache.max
  }

  get maxSize(): number {
    return this.cache.maxSize
  }

  get calculatedSize(): number {
    return this.cache.calculatedSize
  }

  keys(): Generator<string> {
    return this.cache.keys()
  }

  entries(): Generator<[string, FileState]> {
    return this.cache.entries()
  }

  dump(): ReturnType<LRUCache<string, FileState>['dump']> {
    return this.cache.dump()
  }

  load(entries: ReturnType<LRUCache<string, FileState>['dump']>): void {
    this.cache.load(entries)
  }
}

/**
 * Factory function to create a size-limited FileStateCache.
 * Uses LRUCache's built-in size-based eviction to prevent memory bloat.
 * Note: Images are not cached (see FileReadTool) so size limit is mainly
 * for large text files, notebooks, and other editable content.
 */
export function createFileStateCacheWithSizeLimit(
  maxEntries: number,
  maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES,
): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}

// Helper function to convert cache to object (used by compact.ts)
export function cacheToObject(
  cache: FileStateCache,
): Record<string, FileState> {
  return Object.fromEntries(cache.entries())
}

// Helper function to get all keys from cache (used by several components)
export function cacheKeys(cache: FileStateCache): string[] {
  return Array.from(cache.keys())
}

// Helper function to clone a FileStateCache
// Preserves size limit configuration from the source cache
// CC 2.1.312 (item 4) — official clone Gue @244820696 also copies the
// startOnly set: `r.load(s);for(let h of e.startOnlyPaths())r.markStartOnly(h)`.
export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  const cloned = createFileStateCacheWithSizeLimit(cache.max, cache.maxSize)
  cloned.load(cache.dump())
  for (const startOnlyPath of cache.startOnlyPaths()) {
    cloned.markStartOnly(startOnlyPath)
  }
  return cloned
}

// Merge two file state caches, with more recent entries (by timestamp) overriding older ones
// CC 2.1.312 (item 4): the official merge X7s(e,n) = Gue(e) + timestamp-newer
// sets from n, so the merged cache inherits ONLY the first cache's startOnly
// marks — this matches (cloneFileStateCache now carries them over).
export function mergeFileStateCaches(
  first: FileStateCache,
  second: FileStateCache,
): FileStateCache {
  const merged = cloneFileStateCache(first)
  for (const [filePath, fileState] of second.entries()) {
    const existing = merged.get(filePath)
    // Only override if the new entry is more recent
    if (!existing || fileState.timestamp > existing.timestamp) {
      merged.set(filePath, fileState)
    }
  }
  return merged
}
