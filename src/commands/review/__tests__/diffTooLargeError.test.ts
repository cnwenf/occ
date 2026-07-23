import { describe, expect, test } from 'bun:test'
import {
  collectDiffTooLargeStats,
  configuredDiffLimitBytes,
  DEFAULT_BUNDLE_MAX_BYTES,
  formatDiffTooLargeError,
  parseNumstatTopFiles,
  parseShortstat,
  type DiffTooLargeDeps,
} from '../diffTooLargeError.js'

/**
 * CC 2.1.216 #32 — `/ultrareview` diff-too-large error must show configured
 * limits, measured diff size, and largest contributing files.
 */

describe('2.1.216 #32 — formatDiffTooLargeError', () => {
  test('shows configured limit, measured diff size, and largest files', () => {
    const msg = formatDiffTooLargeError({
      configuredLimitBytes: 100 * 1024 * 1024,
      stats: {
        filesChanged: 42,
        insertions: 9000,
        deletions: 1200,
        largestFiles: [
          { path: 'src/big.ts', linesChanged: 9800 },
          { path: 'vendor/gen.ts', linesChanged: 4200 },
        ],
      },
    })
    expect(msg).toContain('diff is too large')
    expect(msg).toContain('Configured limit:')
    expect(msg).toMatch(/100 MB/) // configured limit in MB
    expect(msg).toContain('Measured diff:')
    expect(msg).toContain('42 files changed')
    expect(msg).toContain('9000 insertions(+)')
    expect(msg).toContain('1200 deletions(-)')
    expect(msg).toContain('Largest contributing files:')
    expect(msg).toContain('src/big.ts')
    expect(msg).toContain('9800 changed lines')
    expect(msg).toContain('vendor/gen.ts')
    expect(msg).toContain('`/ultrareview <PR#>`')
  })

  test('omits largest-files section when there are none', () => {
    const msg = formatDiffTooLargeError({
      configuredLimitBytes: 100 * 1024 * 1024,
      stats: { filesChanged: 1, insertions: 2, deletions: 3, largestFiles: [] },
    })
    expect(msg).not.toContain('Largest contributing files')
  })
})

describe('2.1.216 #32 — parseShortstat', () => {
  test('parses the standard shortstat summary line', () => {
    const s = parseShortstat(' 42 files changed, 9000 insertions(+), 1200 deletions(-)')
    expect(s).toEqual({ filesChanged: 42, insertions: 9000, deletions: 1200 })
  })

  test('handles singular form (1 file/insertion/deletion)', () => {
    const s = parseShortstat(' 1 file changed, 1 insertion(+), 1 deletion(-)')
    expect(s).toEqual({ filesChanged: 1, insertions: 1, deletions: 1 })
  })

  test('returns zeros on a non-matching line', () => {
    const s = parseShortstat('')
    expect(s).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
  })
})

describe('2.1.216 #32 — parseNumstatTopFiles', () => {
  test('parses numstat, sums added+deleted, sorts largest-first, caps at 5', () => {
    const stdout = [
      '10\t5\tsrc/a.ts',
      '300\t200\tsrc/big.ts',
      '1\t1\tsrc/tiny.ts',
      '5000\t5000\tvendor/gen.ts',
      '2\t2\tsrc/b.ts',
      '8\t8\tsrc/c.ts',
      '3\t3\tsrc/d.ts',
    ].join('\n')
    const rows = parseNumstatTopFiles(stdout)
    expect(rows.length).toBe(5)
    expect(rows[0]).toEqual({ path: 'vendor/gen.ts', linesChanged: 10000 })
    expect(rows[1]).toEqual({ path: 'src/big.ts', linesChanged: 500 })
    expect(rows[2]).toEqual({ path: 'src/c.ts', linesChanged: 16 })
    expect(rows[3]).toEqual({ path: 'src/a.ts', linesChanged: 15 })
    expect(rows[4]).toEqual({ path: 'src/d.ts', linesChanged: 6 })
  })

  test('skips binary (- -) and malformed rows', () => {
    const stdout = ['-\t-\tbinary.bin', 'notanumber', '5\t5\tok.ts'].join('\n')
    const rows = parseNumstatTopFiles(stdout)
    expect(rows).toEqual([{ path: 'ok.ts', linesChanged: 10 }])
  })
})

describe('2.1.216 #32 — collectDiffTooLargeStats (mocked exec)', () => {
  const deps: DiffTooLargeDeps = {
    exec: async (args: string[]) => {
      if (args[0] === 'diff' && args[1] === '--shortstat') {
        return {
          stdout: ' 3 files changed, 150 insertions(+), 50 deletions(-)',
          code: 0,
        }
      }
      if (args[0] === 'diff' && args[1] === '--numstat') {
        return { stdout: '100\t50\tsrc/big.ts\n5\t5\tsrc/small.ts', code: 0 }
      }
      return { stdout: '', code: 1 }
    },
  }

  test('measures files/insertions/deletions from shortstat', async () => {
    const stats = await collectDiffTooLargeStats('abc123', deps)
    expect(stats.filesChanged).toBe(3)
    expect(stats.insertions).toBe(150)
    expect(stats.deletions).toBe(50)
  })

  test('collects largest contributing files from numstat', async () => {
    const stats = await collectDiffTooLargeStats('abc123', deps)
    expect(stats.largestFiles[0]).toEqual({ path: 'src/big.ts', linesChanged: 150 })
    expect(stats.largestFiles[1]).toEqual({ path: 'src/small.ts', linesChanged: 10 })
  })

  test('returns zeros when git fails', async () => {
    const failingDeps: DiffTooLargeDeps = {
      exec: async () => ({ stdout: '', code: 1 }),
    }
    const stats = await collectDiffTooLargeStats('abc123', failingDeps)
    expect(stats.filesChanged).toBe(0)
    expect(stats.insertions).toBe(0)
    expect(stats.deletions).toBe(0)
    expect(stats.largestFiles).toEqual([])
  })
})

describe('2.1.216 #32 — configuredDiffLimitBytes', () => {
  test('falls back to the default 100 MB bundle limit', () => {
    // GrowthBook not initialized in tests → default applies.
    expect(configuredDiffLimitBytes()).toBe(DEFAULT_BUNDLE_MAX_BYTES)
    expect(configuredDiffLimitBytes()).toBe(100 * 1024 * 1024)
  })
})
