import { createHash } from 'crypto'
import { mkdir, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getSessionId } from 'src/bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { pruneSupersededBackups, type FileHistorySnapshot } from '../fileHistory.js'

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * claude-code 2.1.208 #35: prune superseded file-history backups when
 * snapshots overflow MAX_SNAPSHOTS, bounding checkpoint disk usage.
 */

// Mirrors fileHistory.ts getBackupFileName + resolveBackupPath so the test can
// create/delete the exact on-disk files the pruner will target.
function backupName(filePath: string, version: number): string {
  return (
    createHash('sha256').update(filePath).digest('hex').slice(0, 16) +
    `@v${version}`
  )
}
function backupPath(name: string): string {
  return join(getClaudeConfigHomeDir(), 'file-history', getSessionId(), name)
}
function snapshot(
  backups: Record<string, { backupFileName: string | null; version: number }>,
): FileHistorySnapshot {
  return {
    messageId: crypto.randomUUID() as never,
    trackedFileBackups: Object.fromEntries(
      Object.entries(backups).map(([k, v]) => [
        k,
        { backupFileName: v.backupFileName, version: v.version, backupTime: new Date() },
      ]),
    ),
    timestamp: new Date(),
  } as FileHistorySnapshot
}

describe('2.1.208 #35 pruneSupersededBackups', () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tmpConfig: string

  beforeEach(() => {
    tmpConfig = '' // set in each test so mkdtemp runs first
  })

  afterEach(async () => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    if (tmpConfig) await rm(tmpConfig, { recursive: true, force: true })
  })

  async function withTmpConfig<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    tmpConfig = await (await import('fs/promises')).mkdtemp(
      join(await import('os').then(m => m.tmpdir()), 'occ-fh-prune-'),
    )
    process.env.CLAUDE_CONFIG_DIR = tmpConfig
    return fn()
  }

  test('deletes superseded backups but keeps v1, still-referenced, and non-matching names', async () => {
    await withTmpConfig(async () => {
      // Arrange
      // A: version 2, only in evicted -> deleted
      const pathA = '/proj/a.txt'
      const nameA = backupName(pathA, 2)
      // B: version 1, only in evicted -> KEPT (v1 baseline never pruned)
      const pathB = '/proj/b.txt'
      const nameB = backupName(pathB, 1)
      // C: version 3, in BOTH evicted and kept -> KEPT (still referenced)
      const pathC = '/proj/c.txt'
      const nameC = backupName(pathC, 3)
      // D: version 2, only in evicted, but name does NOT match the backup
      //    regex -> KEPT (safety guard)
      const nameD = 'foreign-name.txt'

      const dir = join(getClaudeConfigHomeDir(), 'file-history', getSessionId())
      await mkdir(dir, { recursive: true })
      for (const name of [nameA, nameB, nameC, nameD]) {
        await writeFile(join(dir, name), `content for ${name}`)
      }

      const evicted = [
        snapshot({
          [pathA]: { backupFileName: nameA, version: 2 },
          [pathB]: { backupFileName: nameB, version: 1 },
          [pathC]: { backupFileName: nameC, version: 3 },
          ['/proj/d.txt']: { backupFileName: nameD, version: 2 },
        }),
      ]
      const kept = [snapshot({ [pathC]: { backupFileName: nameC, version: 3 } })]

      // Act
      await pruneSupersededBackups(evicted, kept)

      // Assert
      expect(await pathExists(backupPath(nameA))).toBe(false) // superseded
      expect(await pathExists(backupPath(nameB))).toBe(true) // v1 kept
      expect(await pathExists(backupPath(nameC))).toBe(true) // still referenced
      expect(await pathExists(backupPath(nameD))).toBe(true) // safety: non-matching name
    })
  })

  test('keeps everything when no backups are superseded', async () => {
    await withTmpConfig(async () => {
      // Arrange
      const pathX = '/proj/x.txt'
      const nameX = backupName(pathX, 2)
      const dir = join(getClaudeConfigHomeDir(), 'file-history', getSessionId())
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, nameX), 'x')

      const evicted = [snapshot({ [pathX]: { backupFileName: nameX, version: 2 } })]
      const kept = [snapshot({ [pathX]: { backupFileName: nameX, version: 2 } })]

      // Act
      await pruneSupersededBackups(evicted, kept)

      // Assert
      expect(await pathExists(backupPath(nameX))).toBe(true)
    })
  })

  test('tolerates a missing backup file on disk (ENOENT ignored)', async () => {
    await withTmpConfig(async () => {
      // Arrange: evicted references a backup that never existed on disk.
      const pathGone = '/proj/gone.txt'
      const nameGone = backupName(pathGone, 2)
      const evicted = [
        snapshot({ [pathGone]: { backupFileName: nameGone, version: 2 } }),
      ]
      const kept: FileHistorySnapshot[] = []

      // Act + Assert: does not throw, and a co-existing superseded file IS deleted.
      const pathReal = '/proj/real.txt'
      const nameReal = backupName(pathReal, 2)
      const dir = join(getClaudeConfigHomeDir(), 'file-history', getSessionId())
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, nameReal), 'real')
      const evicted2 = [
        snapshot({
          [pathGone]: { backupFileName: nameGone, version: 2 },
          [pathReal]: { backupFileName: nameReal, version: 2 },
        }),
      ]
      await expect(pruneSupersededBackups(evicted2, kept)).resolves.toBeUndefined()
      expect(await pathExists(backupPath(nameReal))).toBe(false)
    })
  })

  test('null backupFileName entries (file-did-not-exist markers) are skipped', async () => {
    await withTmpConfig(async () => {
      // Arrange: an evicted snapshot with a null backup marker + a real v2 to delete.
      const pathNull = '/proj/null.txt'
      const pathReal = '/proj/real.txt'
      const nameReal = backupName(pathReal, 2)
      const dir = join(getClaudeConfigHomeDir(), 'file-history', getSessionId())
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, nameReal), 'real')
      const evicted = [
        snapshot({
          [pathNull]: { backupFileName: null, version: 2 },
          [pathReal]: { backupFileName: nameReal, version: 2 },
        }),
      ]

      // Act
      await pruneSupersededBackups(evicted, [])

      // Assert: real superseded file deleted; null marker did not throw.
      expect(await pathExists(backupPath(nameReal))).toBe(false)
    })
  })
})
