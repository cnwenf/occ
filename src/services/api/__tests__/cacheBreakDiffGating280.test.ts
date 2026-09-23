/**
 * OCC-134 security-review follow-up (M4) — cache-break diff writes must be
 * gated and permission-restricted.
 *
 * Official v2.1.278/2.1.280 NEVER assign the diffPath variable (@199399756 /
 * @200280074) — the plaintext diff file does not exist in the official builds;
 * only the summary log survives, and even that is gated by `eee()` (cowork ||
 * claude-desktop entrypoint || remote). OCC keeps the diff writer as a local
 * diagnostic, so the review asked for gating + permissions:
 *
 *   1. debug-mode gate (isDebugMode) — default OFF, nothing hits the disk;
 *   2. file mode 0o600, dir mode 0o700 (owner-only plaintext prompts);
 *   3. size cap MAX_CACHE_BREAK_DIFF_BYTES = 4_000_000 (official module
 *      constant `Qar` @199376912) with an explicit truncation marker;
 *   4. rotation to the 5 newest cache-break-*.diff files so repeated breaks
 *      cannot accumulate unbounded sensitive plaintext.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, rmSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDebugMode } from 'src/utils/debug.js'
import { getClaudeTempDir } from 'src/utils/permissions/filesystem.js'
import { writeCacheBreakDiffForTesting } from '../promptCacheBreakDetection.js'

const farm = mkdtempSync(join(tmpdir(), 'occ-cachediff-'))
const savedTmpDirEnv = process.env.CLAUDE_CODE_TMPDIR
const savedDebugEnv = process.env.DEBUG
process.env.CLAUDE_CODE_TMPDIR = farm
getClaudeTempDir.cache.clear?.()

const tempDir = getClaudeTempDir()

function setDebug(on: boolean): void {
  if (on) {
    process.env.DEBUG = '1'
  } else {
    delete process.env.DEBUG
  }
  isDebugMode.cache.clear?.()
}

function listDiffFiles(): string[] {
  // The dir only exists once a gated write created it — debug-off runs before
  // any mkdir, and "nothing on disk" is exactly what those runs must prove.
  try {
    return readdirSync(tempDir).filter(
      name => name.startsWith('cache-break-') && name.endsWith('.diff'),
    )
  } catch {
    return []
  }
}

beforeAll(() => {
  setDebug(false)
})

afterAll(() => {
  if (savedDebugEnv === undefined) {
    delete process.env.DEBUG
  } else {
    process.env.DEBUG = savedDebugEnv
  }
  isDebugMode.cache.clear?.()
  if (savedTmpDirEnv === undefined) {
    delete process.env.CLAUDE_CODE_TMPDIR
  } else {
    process.env.CLAUDE_CODE_TMPDIR = savedTmpDirEnv
  }
  getClaudeTempDir.cache.clear?.()
  rmSync(farm, { recursive: true, force: true })
})

describe('writeCacheBreakDiff — debug gate', () => {
  test('REGRESSION M4: debug OFF writes nothing to disk', async () => {
    setDebug(false)
    const result = await writeCacheBreakDiffForTesting(
      'system prompt v1',
      'system prompt v2',
    )
    expect(result).toBeUndefined()
    expect(listDiffFiles()).toEqual([])
  })

  test('debug ON writes the diff and returns its path', async () => {
    setDebug(true)
    const result = await writeCacheBreakDiffForTesting(
      'system prompt v1',
      'system prompt v2',
    )
    expect(typeof result).toBe('string')
    expect(result?.startsWith(tempDir)).toBe(true)
    const content = await readFile(result!, 'utf-8')
    expect(content).toContain('-system prompt v1')
    expect(content).toContain('+system prompt v2')
  })
})

describe('writeCacheBreakDiff — file permissions', () => {
  test('diff file is owner-only 0o600', async () => {
    setDebug(true)
    const result = await writeCacheBreakDiffForTesting('a', 'b')
    expect(result).toBeDefined()
    const stats = await stat(result!)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  test('temp dir is created owner-only 0o700', async () => {
    const stats = await stat(tempDir)
    expect(stats.mode & 0o777).toBe(0o700)
  })
})

describe('writeCacheBreakDiff — size cap (official `Qar` = 4_000_000)', () => {
  test('oversized diffs are truncated with an explicit marker', async () => {
    setDebug(true)
    // One giant added line: createPatch emits it verbatim, blowing past the cap.
    const huge = `line\n${'x'.repeat(4_200_000)}`
    const result = await writeCacheBreakDiffForTesting('line', huge)
    expect(result).toBeDefined()
    const content = await readFile(result!, 'utf-8')
    expect(content.length).toBeLessThanOrEqual(4_000_000 + 64)
    expect(content).toContain('[truncated: diff exceeded 4000000 bytes]')
  })
})

describe('writeCacheBreakDiff — rotation (5 newest kept)', () => {
  test('old cache-break diffs are pruned, newest survive', async () => {
    setDebug(true)
    // Start from a clean slate — files written by earlier tests have current
    // mtimes and would otherwise out-rank every seed.
    for (const name of listDiffFiles()) {
      rmSync(join(tempDir, name), { force: true })
    }
    // Seed 7 stale files with staggered mtimes, then trigger one more write.
    for (let i = 0; i < 7; i++) {
      const name = join(tempDir, `cache-break-seed${i}.diff`)
      writeFileSync(name, `stale ${i}`, { mode: 0o600 })
      const t = new Date(1_700_000_000_000 + i * 60_000)
      utimesSync(name, t, t)
    }
    const fresh = await writeCacheBreakDiffForTesting('p', 'q')
    expect(fresh).toBeDefined()

    const remaining = listDiffFiles()
    // 8 candidates -> exactly the 5 newest kept: the fresh write + seeds 3-6.
    expect(remaining.length).toBe(5)
    expect(remaining).toContain(fresh!.split('/').pop())
    expect(remaining).not.toContain('cache-break-seed0.diff')
    expect(remaining).not.toContain('cache-break-seed1.diff')
    expect(remaining).not.toContain('cache-break-seed2.diff')
    expect(remaining).toContain('cache-break-seed6.diff')
  })
})
