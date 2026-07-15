import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fileReadCache } from '../fileReadCache.js'

/**
 * claude-code 2.1.208 #34: bound the file edit read cache to ~16 MB instead
 * of pinning up to 1,000 full files. Verifies the LRU evicts by total bytes.
 */
describe('2.1.208 #34 fileReadCache byte cap', () => {
  let tmpDir: string

  beforeEach(async () => {
    fileReadCache.clear()
    tmpDir = await mkdtemp(join(tmpdir(), 'occ-readcache-'))
  })

  afterEach(async () => {
    fileReadCache.clear()
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('returns cached content on a hit when mtime is unchanged', async () => {
    // Arrange
    const filePath = join(tmpDir, 'hit.txt')
    await writeFile(filePath, 'hello world')
    const first = fileReadCache.readFile(filePath)

    // Act
    const second = fileReadCache.readFile(filePath)

    // Assert
    expect(first.content).toBe('hello world')
    expect(second.content).toBe(first.content)
    expect(second.encoding).toBe(first.encoding)
    expect(fileReadCache.getStats().size).toBe(1)
  })

  test('invalidates on mtime change (re-reads from disk)', async () => {
    // Arrange
    const filePath = join(tmpDir, 'stale.txt')
    await writeFile(filePath, 'v1')
    fileReadCache.readFile(filePath)
    // Update the file (new mtime) — wait so mtimeMs differs reliably.
    await new Promise(r => setTimeout(r, 15))
    await writeFile(filePath, 'v2')

    // Act
    const after = fileReadCache.readFile(filePath)

    // Assert
    expect(after.content).toBe('v2')
  })

  test('evicts least-recently-used entries once total size exceeds 16 MB', async () => {
    // Arrange: four ~5 MB files = ~20 MB total (> 16 MB cap). The LRU must
    // evict the oldest (file1) to keep totalChars <= 16 MB.
    const fiveMb = 'a'.repeat(5 * 1024 * 1024)
    const paths: string[] = []
    for (let i = 0; i < 4; i++) {
      const p = join(tmpDir, `f${i}.txt`)
      await writeFile(p, fiveMb)
      paths.push(p)
    }

    // Act: read in order so file0 is the least-recently-used after the run.
    for (const p of paths) {
      fileReadCache.readFile(p)
    }

    // Assert
    const stats = fileReadCache.getStats()
    // 16 MB = 16 * 1024 * 1024 = 16777216 chars.
    expect(stats.totalChars).toBeLessThanOrEqual(16 * 1024 * 1024)
    // 20 MB > 16 MB so at least one entry was evicted.
    expect(stats.size).toBeLessThan(4)
    // The oldest (file0) is evicted; the most recent (file3) is retained.
    expect(stats.entries).not.toContain(paths[0])
    expect(stats.entries).toContain(paths[paths.length - 1])
  })
})
