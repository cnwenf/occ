import { LRUCache } from 'lru-cache'
import { detectFileEncoding } from './file.js'
import { getFsImplementation } from './fsOperations.js'

type CachedFileData = {
  content: string
  encoding: BufferEncoding
  mtime: number
}

// claude-code 2.1.208 #34: bound the file edit read cache by total bytes
// (~16 MB) instead of pinning up to 1,000 full files. Mirrors the official
// binary's read cache: an LRU with max=1000 entries, maxSize=16*1024*1024,
// and per-entry size = max(1, content.length). When total cached content
// exceeds 16 MB the least-recently-used entries are evicted, so a single huge
// file (or many large files) can no longer pin the cache indefinitely.
const MAX_ENTRIES = 1000
const MAX_CACHE_BYTES = 16 * 1024 * 1024

/**
 * A simple in-memory cache for file contents with automatic invalidation based on modification time.
 * This eliminates redundant file reads in FileEditTool operations.
 */
class FileReadCache {
  private cache: LRUCache<string, CachedFileData>

  constructor() {
    this.cache = new LRUCache<string, CachedFileData>({
      max: MAX_ENTRIES,
      maxSize: MAX_CACHE_BYTES,
      // Match the official size function: per-entry size is the character
      // length of the cached content (minimum 1). calculatedSize is therefore
      // reported as totalChars in getStats().
      sizeCalculation: data => Math.max(1, data.content.length),
    })
  }

  /**
   * Reads a file with caching. Returns both content and encoding.
   * Cache key includes file path and modification time for automatic invalidation.
   */
  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fs = getFsImplementation()

    // Get file stats for cache invalidation
    let stats
    try {
      stats = fs.statSync(filePath)
    } catch (error) {
      // File was deleted, remove from cache and re-throw
      this.cache.delete(filePath)
      throw error
    }

    const cacheKey = filePath
    // LRU recency is updated on get(), keeping hot entries alive.
    const cachedData = this.cache.get(cacheKey)

    // Check if we have valid cached data
    if (cachedData && cachedData.mtime === stats.mtimeMs) {
      return {
        content: cachedData.content,
        encoding: cachedData.encoding,
      }
    }

    // Cache miss or stale data - read the file
    const encoding = detectFileEncoding(filePath)
    const content = fs
      .readFileSync(filePath, { encoding })
      .replaceAll('\r\n', '\n')

    // Update cache. LRUCache evicts least-recently-used entries as needed to
    // keep both the entry count (max) and total size (maxSize) in bounds.
    this.cache.set(cacheKey, {
      content,
      encoding,
      mtime: stats.mtimeMs,
    })

    return { content, encoding }
  }

  /**
   * Clears the entire cache. Useful for testing or memory management.
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Removes a specific file from the cache.
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  /**
   * Gets cache statistics for debugging/monitoring.
   * `totalChars` is the sum of per-entry sizes (the LRU calculatedSize),
   * matching the official read cache's reported metric.
   */
  getStats(): { size: number; totalChars: number; entries: string[] } {
    return {
      size: this.cache.size,
      totalChars: this.cache.calculatedSize,
      entries: Array.from(this.cache.keys()),
    }
  }
}

// Export a singleton instance
export const fileReadCache = new FileReadCache()
