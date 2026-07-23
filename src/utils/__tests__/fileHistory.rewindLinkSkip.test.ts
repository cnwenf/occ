import { createHash } from 'crypto'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getSessionId } from 'src/bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import {
  checkRewindDestinationSafety,
  type FileHistorySnapshot,
  type FileHistoryState,
  fileHistoryRewind,
  REWIND_SKIP_REASON,
} from '../fileHistory.js'

// Mirrors fileHistory.ts getBackupFileName + resolveBackupPath so the test can
// place the exact on-disk backup files the rewinder will read.
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
  messageId: string,
): FileHistorySnapshot {
  return {
    messageId: messageId as never,
    trackedFileBackups: Object.fromEntries(
      Object.entries(backups).map(([k, v]) => [
        k,
        { backupFileName: v.backupFileName, version: v.version, backupTime: new Date() },
      ]),
    ),
    timestamp: new Date(),
  } as FileHistorySnapshot
}

/**
 * claude-code 2.1.216 #36: /rewind no longer restores or deletes files
 * through symlinks or hard links at tracked paths, and reports how many
 * paths were skipped. Reverse-engineered from the official 2.1.216 binary:
 *   - z4g(filePath) safety gate: lstat → isSymbolicLink → "destination is a
 *     symlink"; !isFile → "destination is not a regular file"; nlink>1 →
 *     "destination is hard-linked (nlink=N)"; ELOOP/ENOTDIR → "destination
 *     path does not resolve (CODE)"; ENOENT falls through (safe to
 *     create/restore).
 *   - applySnapshot skips refused paths, logs
 *     tengu_file_history_rewind_restore_file_failed, and the rewind flow
 *     reports: `Warning: N tracked path[s] skipped: <reason>. Run with
 *     --debug for the paths.`
 */
describe('2.1.216 #36 /rewind link skip', () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  const savedEnableSdk = process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
  const savedDisable = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  let tmp: string
  let origCwd: string
  let stderrSpy: string[]
  let origStderrWrite: typeof process.stderr.write

  beforeEach(() => {
    tmp = '' // assigned in withTmp
    origCwd = process.cwd()
  })

  afterEach(async () => {
    if (origStderrWrite) process.stderr.write = origStderrWrite
    process.chdir(origCwd)
    for (const [k, v] of Object.entries({
      CLAUDE_CONFIG_DIR: savedConfigDir,
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: savedEnableSdk,
      CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: savedDisable,
    })) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  async function withTmp<T>(fn: () => Promise<T>): Promise<T> {
    tmp = await mkdtemp(join(await import('os').then(m => m.tmpdir()), 'occ-fh-link-'))
    process.env.CLAUDE_CONFIG_DIR = tmp
    // Ensure fileHistoryEnabled() is true in the test process.
    process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
    delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    stderrSpy = []
    origStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: any) => {
      stderrSpy.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }) as typeof process.stderr.write
    return fn()
  }

  function buildState(
    backups: Record<string, { backupFileName: string | null; version: number }>,
    tracked: string[],
    messageId: string,
  ): FileHistoryState {
    return {
      snapshots: [snapshot(backups, messageId)],
      trackedFiles: new Set(tracked),
      snapshotSequence: 1,
    } as FileHistoryState
  }

  function makeUpdater(state: FileHistoryState) {
    return (updater: (prev: FileHistoryState) => FileHistoryState): void => {
      const next = updater(state)
      // reflect no-op / mutations back onto the local state object
      for (const key of Object.keys(state) as (keyof FileHistoryState)[]) {
        ;(state as any)[key] = next[key]
      }
    }
  }

  describe('checkRewindDestinationSafety', () => {
    test('regular file is safe', async () => {
      await withTmp(async () => {
        const p = join(tmp, 'regular.txt')
        await writeFile(p, 'hi')
        const r = await checkRewindDestinationSafety(p)
        expect(r.verdict).toBe('safe')
      })
    })

    test('symlink is refused', async () => {
      await withTmp(async () => {
        const target = join(tmp, 'target.txt')
        await writeFile(target, 't')
        const linkP = join(tmp, 'link.txt')
        await symlink(target, linkP)
        const r = await checkRewindDestinationSafety(linkP)
        expect(r.verdict).toBe('refused')
        expect(r.detail).toBe('destination is a symlink')
      })
    })

    test('hardlink (nlink>1) is refused', async () => {
      await withTmp(async () => {
        const a = join(tmp, 'a.txt')
        const b = join(tmp, 'b.txt')
        await writeFile(a, 'h')
        await link(a, b) // hard link → nlink=2
        const r = await checkRewindDestinationSafety(a)
        expect(r.verdict).toBe('refused')
        expect(r.detail).toContain('destination is hard-linked')
        expect(r.detail).toContain('nlink=2')
      })
    })

    test('missing path (ENOENT) falls through to safe', async () => {
      await withTmp(async () => {
        const p = join(tmp, 'nope.txt')
        const r = await checkRewindDestinationSafety(p)
        expect(r.verdict).toBe('safe')
      })
    })
  })

  describe('fileHistoryRewind skip + reporting', () => {
    test('symlink at a tracked path is skipped (target untouched) and reported', async () => {
      await withTmp(async () => {
        const target = join(tmp, 'target.txt')
        await writeFile(target, 'TARGET-ORIGINAL')
        const linkP = join(tmp, 'link.txt')
        await symlink(target, linkP)
        const regular = join(tmp, 'regular.txt')
        await writeFile(regular, 'CURRENT')

        // Backups on disk.
        const linkBak = backupName(linkP, 1)
        const regBak = backupName(regular, 1)
        await mkdir(join(tmp, 'file-history', getSessionId()), {
          recursive: true,
        })
        await writeFile(backupPath(linkBak), 'BACKUP-LINK')
        await writeFile(backupPath(regBak), 'BACKUP-REGULAR')

        const messageId = 'msg-1'
        const state = buildState(
          {
            [linkP]: { backupFileName: linkBak, version: 1 },
            [regular]: { backupFileName: regBak, version: 1 },
          },
          [linkP, regular],
          messageId,
        )

        await fileHistoryRewind(makeUpdater(state), messageId as never)

        // Regular file restored from backup.
        expect(await readFile(regular, 'utf8')).toBe('BACKUP-REGULAR')
        // Symlink still a symlink (not replaced).
        const st = await lstat(linkP)
        expect(st.isSymbolicLink()).toBe(true)
        // Symlink target NOT written through the link.
        expect(await readFile(target, 'utf8')).toBe('TARGET-ORIGINAL')
        // Skip reported on stderr with the official message.
        const out = stderrSpy.join('')
        expect(out).toContain('Warning: 1 tracked path was skipped')
        expect(out).toContain(REWIND_SKIP_REASON)
        expect(out).toContain('Run with --debug for the paths.')
      })
    })

    test('hardlink at a tracked path is skipped', async () => {
      await withTmp(async () => {
        const a = join(tmp, 'a.txt')
        const b = join(tmp, 'b.txt')
        await writeFile(a, 'HARD-CURRENT')
        await link(a, b) // hard link → nlink=2

        const bak = backupName(a, 1)
        await mkdir(join(tmp, 'file-history', getSessionId()), {
          recursive: true,
        })
        await writeFile(backupPath(bak), 'BACKUP-HARD')

        const messageId = 'msg-2'
        const state = buildState(
          { [a]: { backupFileName: bak, version: 1 } },
          [a],
          messageId,
        )

        await fileHistoryRewind(makeUpdater(state), messageId as never)

        // Untouched.
        expect(await readFile(a, 'utf8')).toBe('HARD-CURRENT')
        expect(await readFile(b, 'utf8')).toBe('HARD-CURRENT')
        const st = await lstat(a)
        expect(st.nlink).toBe(2)
        const out = stderrSpy.join('')
        expect(out).toContain('1 tracked path was skipped')
      })
    })

    test('normal file restores with no skip warning', async () => {
      await withTmp(async () => {
        const regular = join(tmp, 'regular.txt')
        await writeFile(regular, 'CURRENT')

        const bak = backupName(regular, 1)
        await mkdir(join(tmp, 'file-history', getSessionId()), {
          recursive: true,
        })
        await writeFile(backupPath(bak), 'BACKUP-REGULAR')

        const messageId = 'msg-3'
        const state = buildState(
          { [regular]: { backupFileName: bak, version: 1 } },
          [regular],
          messageId,
        )

        await fileHistoryRewind(makeUpdater(state), messageId as never)

        expect(await readFile(regular, 'utf8')).toBe('BACKUP-REGULAR')
        // No skip warning when nothing was skipped.
        const out = stderrSpy.join('')
        expect(out).not.toContain('skipped')
      })
    })
  })
})
