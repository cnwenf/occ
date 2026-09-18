/**
 * claude-code 2.1.275 #11 (official changelog: "Fixed /rewind restoring
 * zero-filled/truncated file") — data-loss fix port.
 *
 * Reverse-engineered from the official v276 binary
 * (/tmp/cc-diff-276/v276/package/claude):
 *   - `var ivo=[100,200,400,800]` @197428145 — retry backoff schedule;
 *   - `bX=new Set(["EPERM","EBUSY","EACCES"])` @191305720 — retryable rename
 *     errno codes;
 *   - `jT(e)=\`${e}.tmp.${randomBytes(4).toString("hex")}\`` @191305759 —
 *     temp-copy naming (temp lives in the destination dir);
 *   - `mQe(g,L,MA.COPYFILE_EXCL)` @197428933 — exclusive temp copy;
 *   - `Error("FileHistory: backup copy is incomplete")` @197429010 —
 *     post-copy size verification failure (0 hits in v274 — v274 restored
 *     truncated/zero-filled backups silently);
 *   - `FileHistory: could not move the copied backup ... — rename still
 *     refused (...) after about 1.5 s of retries ...` @197429145 — exhausted
 *     rename-retry log.
 *
 * Coverage:
 *   1. truncated backup copy detected → byte-exact error → retried → success
 *      on a later attempt (temp+EXCL+rename, no debris);
 *   2. all retries exhausted → failure surfaces, destination unchanged;
 *   3. backup creation uses COPYFILE_EXCL and never overwrites an existing
 *      backup;
 *   4. batch /rewind restore: one failing file does not abort the others
 *      (Promise.allSettled);
 *   5. cross-session resume migration: hardlink-first, EXDEV → verified copy
 *      fallback, per-file isolation on exhaustion.
 *
 * Mock discipline (OCC-97): real temp dirs (mkdtemp) everywhere; only fs
 * failure injection is mocked, via a load-time snapshot of the real
 * fs/promises exports (the `import * as ns` namespace has LIVE bindings —
 * wrapping `ns.copyFile` would recurse). `mock.restore()` does NOT undo
 * `mock.module`, so the real module is restored by re-mocking with the
 * snapshot in afterAll.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { createHash } from 'crypto'
import { constants as fsConstants } from 'fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'fs/promises'
import * as REAL_FS_NS from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import type { LogOption } from 'src/types/logs.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import {
  copyFileHistoryForResume,
  COPY_RETRY_BACKOFF_MS,
  copyFileVerifiedAtomic,
  type FileHistorySnapshot,
  type FileHistoryState,
  fileHistoryRewind,
  fileHistoryTrackEdit,
} from '../fileHistory.js'

// ---------------------------------------------------------------------------
// fs/promises failure-injection harness
// ---------------------------------------------------------------------------

const REAL_FS: typeof REAL_FS_NS = { ...REAL_FS_NS }

type CopyFileArgs = [src: string, dest: string, mode?: number]

let copyFileFake: ((...args: CopyFileArgs) => Promise<void>) | null = null
let copyCalls: CopyFileArgs[] = []
let linkFake: ((src: string, dest: string) => Promise<void>) | null = null
let renameFake: ((src: string, dest: string) => Promise<void>) | null = null
let unlinkFake: ((path: string) => Promise<void>) | null = null

async function installFsFakes(): Promise<void> {
  await mock.module('fs/promises', () => ({
    ...REAL_FS,
    copyFile: async (...args: CopyFileArgs): Promise<void> => {
      copyCalls.push([args[0], args[1], args[2]])
      if (copyFileFake) return copyFileFake(...args)
      return REAL_FS.copyFile(...args)
    },
    link: async (src: string, dest: string): Promise<void> => {
      if (linkFake) return linkFake(src, dest)
      return REAL_FS.link(src, dest)
    },
    rename: async (src: string, dest: string): Promise<void> => {
      if (renameFake) return renameFake(src, dest)
      return REAL_FS.rename(src, dest)
    },
    unlink: async (path: string): Promise<void> => {
      if (unlinkFake) return unlinkFake(path)
      return REAL_FS.unlink(path)
    },
  }))
}

async function restoreRealFs(): Promise<void> {
  await mock.module('fs/promises', () => ({ ...REAL_FS }))
}

function errnoError(code: string, syscall: string): Error & { code: string } {
  return Object.assign(
    new Error(`${code.toLowerCase()}: ${syscall} failed`),
    { code },
  )
}

/** Temp-copy debris pattern from the official `jT` naming. */
const TEMP_DEBRIS_RE = /\.tmp\.[0-9a-f]{8}$/

async function expectNoTempDebris(dir: string): Promise<void> {
  const debris = (await readdir(dir)).filter(name => TEMP_DEBRIS_RE.test(name))
  expect(debris).toEqual([])
}

// ---------------------------------------------------------------------------
// Env + state scaffolding (mirrors fileHistory.rewindLinkSkip.test.ts)
// ---------------------------------------------------------------------------

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
const savedEnableSdk = process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
const savedDisable = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
let tmp = ''

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
        {
          backupFileName: v.backupFileName,
          version: v.version,
          backupTime: new Date(),
        },
      ]),
    ),
    timestamp: new Date(),
  } as FileHistorySnapshot
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
    for (const key of Object.keys(state) as (keyof FileHistoryState)[]) {
      ;(state as never as Record<string, unknown>)[key] =
        next[key as keyof FileHistoryState]
    }
  }
}
function makeResumeLog(
  previousSessionId: string,
  backups: Record<string, string>,
): LogOption {
  return {
    messages: [{ sessionId: previousSessionId }],
    fileHistorySnapshots: [
      {
        messageId: 'msg-prev' as never,
        trackedFileBackups: Object.fromEntries(
          Object.entries(backups).map(([trackedPath, backupFileName]) => [
            trackedPath,
            { backupFileName, version: 1, backupTime: new Date() },
          ]),
        ),
        timestamp: new Date(),
      },
    ],
  } as unknown as LogOption
}

beforeAll(async () => {
  await installFsFakes()
})

afterAll(async () => {
  await restoreRealFs()
})

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'occ-fh-restore275-'))
  process.env.CLAUDE_CONFIG_DIR = tmp
  // Ensure fileHistoryEnabled() is true in the test process.
  process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
  delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
})

afterEach(async () => {
  copyFileFake = null
  linkFake = null
  renameFake = null
  unlinkFake = null
  copyCalls = []
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

// ---------------------------------------------------------------------------
// 1. copyFileVerifiedAtomic — the core 2.1.275 fix
// ---------------------------------------------------------------------------

describe('2.1.275 #11 copyFileVerifiedAtomic', () => {
  test('detects a truncated copy, retries it, and lands full content with COPYFILE_EXCL', async () => {
    const src = join(tmp, 'src.bin')
    const dest = join(tmp, 'dest.bin')
    const full = 'X'.repeat(512)
    await writeFile(src, full)
    await writeFile(dest, 'ORIGINAL')

    let calls = 0
    copyFileFake = async (s, d, mode) => {
      calls++
      if (calls === 1) {
        // First attempt lands one byte short — the 2.1.274 silent-truncation
        // bug shape.
        await REAL_FS.writeFile(d, full.slice(0, 511))
        return
      }
      return REAL_FS.copyFile(s, d, mode)
    }

    await copyFileVerifiedAtomic(src, dest, 512, [1, 1, 1, 1])

    expect(await readFile(dest, 'utf8')).toBe(full)
    expect(calls).toBe(2)
    // Every copy attempt (both the temp copies) is exclusive.
    expect(copyCalls.length).toBe(2)
    for (const [, , mode] of copyCalls) {
      expect(mode).toBe(fsConstants.COPYFILE_EXCL)
    }
    await expectNoTempDebris(tmp)
  })

  test('exhausted retries reject with the byte-exact official error and leave the destination unchanged', async () => {
    const src = join(tmp, 'src.bin')
    const dest = join(tmp, 'dest.bin')
    await writeFile(src, 'Y'.repeat(64))
    await writeFile(dest, 'ORIGINAL')

    let calls = 0
    copyFileFake = async (_s, d) => {
      calls++
      // Truncated copy every time (one byte short) — the changelog's
      // zero-filled/truncated failure mode as seen by a size check.
      await REAL_FS.writeFile(d, '\0'.repeat(63))
    }

    const err = await copyFileVerifiedAtomic(src, dest, 64, [
      1, 1, 1, 1,
    ]).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    // Byte-exact official string (v276 @197429010), spelled literally here on
    // purpose so an accidental source drift fails the test.
    expect((err as Error).message).toBe(
      'FileHistory: backup copy is incomplete',
    )
    // 1 initial attempt + 4 retries on the [100,200,400,800]-shaped schedule.
    expect(calls).toBe(5)
    // Destination never saw a half-written copy (temp+rename discipline).
    expect(await readFile(dest, 'utf8')).toBe('ORIGINAL')
    await expectNoTempDebris(tmp)
  })

  test('default retry schedule is the official [100,200,400,800] ms', () => {
    expect([...COPY_RETRY_BACKOFF_MS]).toEqual([100, 200, 400, 800])
  })

  test('a retryable rename errno (EPERM) is retried on the schedule and then succeeds', async () => {
    const src = join(tmp, 'src.bin')
    const dest = join(tmp, 'dest.bin')
    await writeFile(src, 'Z'.repeat(16))
    await writeFile(dest, 'OLD')

    let renameCalls = 0
    renameFake = async (s, d) => {
      renameCalls++
      if (renameCalls <= 2) throw errnoError('EPERM', 'rename')
      return REAL_FS.rename(s, d)
    }

    await copyFileVerifiedAtomic(src, dest, 16, [1, 1, 1, 1])

    expect(await readFile(dest, 'utf8')).toBe('Z'.repeat(16))
    expect(renameCalls).toBe(3)
    await expectNoTempDebris(tmp)
  })

  test('rename EEXIST is treated as a successful concurrent placement (dest not clobbered)', async () => {
    const src = join(tmp, 'src.bin')
    const dest = join(tmp, 'dest.bin')
    await writeFile(src, 'DATA')
    await writeFile(dest, 'CONCURRENT')

    renameFake = async () => {
      throw errnoError('EEXIST', 'rename')
    }

    await copyFileVerifiedAtomic(src, dest, 4, [1])

    // Official `avo`: a rename EEXIST means another migrator already landed
    // the destination — success, and the existing file is never overwritten.
    expect(await readFile(dest, 'utf8')).toBe('CONCURRENT')
    await expectNoTempDebris(tmp)
  })

  test('a non-retryable copy error propagates immediately without burning the schedule', async () => {
    const src = join(tmp, 'src.bin')
    const dest = join(tmp, 'dest.bin')
    await writeFile(src, 'DATA')

    copyFileFake = async () => {
      throw errnoError('EIO', 'copyfile')
    }

    const err = await copyFileVerifiedAtomic(src, dest, 4, [1, 1, 1, 1]).catch(
      (e: unknown) => e,
    )

    expect((err as Error & { code: string }).code).toBe('EIO')
    expect(copyCalls.length).toBe(1)
    await expectNoTempDebris(tmp)
  })
})

// ---------------------------------------------------------------------------
// 2. Backup creation — COPYFILE_EXCL never overwrites an existing backup
// ---------------------------------------------------------------------------

describe('2.1.275 #11 backup creation exclusivity', () => {
  test('fileHistoryTrackEdit creates the v1 backup with COPYFILE_EXCL', async () => {
    const p = join(tmp, 'edit-me.txt')
    await writeFile(p, 'CONTENT')
    // Pre-create the backup dir so the lazy-mkdir ENOENT retry does not add a
    // second copyFile call — keeps the EXCL assertion on exactly one copy.
    await mkdir(dirname(backupPath(backupName(p, 1))), { recursive: true })
    const messageId = 'msg-excl-1'
    const state = buildState({}, [], messageId)

    await fileHistoryTrackEdit(makeUpdater(state), p, messageId as never)

    const bak = backupPath(backupName(p, 1))
    expect(await readFile(bak, 'utf8')).toBe('CONTENT')
    const backupCopies = copyCalls.filter(([, dest]) => dest === bak)
    expect(backupCopies.length).toBe(1)
    expect(backupCopies[0][2]).toBe(fsConstants.COPYFILE_EXCL)
    // State committed.
    expect(state.snapshots.at(-1)?.trackedFileBackups[p]).toBeDefined()
  })

  test('an existing backup is never overwritten: EXCL copy fails loudly on a create race', async () => {
    const p = join(tmp, 'racy.txt')
    await writeFile(p, 'CONTENT')
    const bak = backupPath(backupName(p, 1))
    await mkdir(dirname(bak), { recursive: true })

    // Simulate a concurrent creator: the stale-backup unlink succeeds, but
    // another writer re-lands the deterministic {hash}@v1 path before our
    // EXCL copy runs.
    unlinkFake = async target => {
      await REAL_FS.unlink(target).catch(() => {})
      if (target === bak) {
        await REAL_FS.writeFile(target, 'FOREIGN-BACKUP')
      }
    }

    const messageId = 'msg-excl-2'
    const state = buildState({}, [], messageId)
    // trackEdit catches per-file backup failures — it must not throw.
    await fileHistoryTrackEdit(makeUpdater(state), p, messageId as never)

    // The foreign backup survives untouched (v274-era plain copyFile would
    // have silently overwritten it).
    expect(await readFile(bak, 'utf8')).toBe('FOREIGN-BACKUP')
    // The EXCL copy was attempted and failed with EEXIST → no state commit.
    expect(
      copyCalls.some(([, dest, mode]) => dest === bak && mode === fsConstants.COPYFILE_EXCL),
    ).toBe(true)
    expect(state.snapshots.at(-1)?.trackedFileBackups[p]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. Batch /rewind restore — Promise.allSettled isolation
// ---------------------------------------------------------------------------

describe('2.1.275 #11 batch rewind restore', () => {
  test(
    'one file whose backup copy keeps truncating fails alone; the others still restore',
    async () => {
      const a = join(tmp, 'a.txt')
      const b = join(tmp, 'b.txt')
      const c = join(tmp, 'c.txt')
      await writeFile(a, 'A-CURRENT')
      await writeFile(b, 'B-CURRENT')
      await writeFile(c, 'C-CURRENT')

      const bakA = backupName(a, 1)
      const bakB = backupName(b, 1)
      const bakC = backupName(c, 1)
      await mkdir(join(tmp, 'file-history', getSessionId()), {
        recursive: true,
      })
      await writeFile(backupPath(bakA), 'A-BACKUP')
      await writeFile(backupPath(bakB), 'B-BACKUP')
      await writeFile(backupPath(bakC), 'C-BACKUP')
      const bBakPath = backupPath(bakB)

      copyFileFake = async (s, d, mode) => {
        if (s === bBakPath) {
          // Zero-filled copy of B's backup, every attempt.
          await REAL_FS.writeFile(d, '\0'.repeat(3))
          return
        }
        return REAL_FS.copyFile(s, d, mode)
      }

      const messageId = 'msg-batch'
      const state = buildState(
        {
          [a]: { backupFileName: bakA, version: 1 },
          [b]: { backupFileName: bakB, version: 1 },
          [c]: { backupFileName: bakC, version: 1 },
        },
        [a, b, c],
        messageId,
      )

      // Must not throw — B's exhausted retries are a per-file failure.
      await fileHistoryRewind(makeUpdater(state), messageId as never)

      expect(await readFile(a, 'utf8')).toBe('A-BACKUP')
      expect(await readFile(c, 'utf8')).toBe('C-BACKUP')
      // B is unchanged — never truncated, never zero-filled (the 2.1.274 bug).
      expect(await readFile(b, 'utf8')).toBe('B-CURRENT')
      // The backup source itself is untouched.
      expect(await readFile(bBakPath, 'utf8')).toBe('B-BACKUP')
      await expectNoTempDebris(tmp)
    },
    8000, // default [100,200,400,800] schedule ≈ 1.5 s for the failing file
  )
})

// ---------------------------------------------------------------------------
// 4. Cross-session resume migration (official `avo` + `lFt`)
// ---------------------------------------------------------------------------

describe('2.1.275 #11 cross-session backup migration', () => {
  test('an already-migrated backup is never overwritten (link EEXIST)', async () => {
    const prev = 'prev-session-exist'
    const tracked = join(tmp, 'tracked.txt')
    const name = backupName(tracked, 1)
    await mkdir(join(tmp, 'file-history', prev), { recursive: true })
    await writeFile(join(tmp, 'file-history', prev, name), 'OLD-SESSION-BACKUP')
    const cur = join(tmp, 'file-history', getSessionId())
    await mkdir(cur, { recursive: true })
    await writeFile(join(cur, name), 'FOREIGN')

    await copyFileHistoryForResume(makeResumeLog(prev, { [tracked]: name }))

    expect(await readFile(join(cur, name), 'utf8')).toBe('FOREIGN')
    expect(await readFile(join(tmp, 'file-history', prev, name), 'utf8')).toBe(
      'OLD-SESSION-BACKUP',
    )
  })

  test(
    'hardlink EXDEV falls back to a verified copy: truncated first attempt is retried to full content',
    async () => {
      const prev = 'prev-session-xdev'
      const tracked = join(tmp, 'tracked.txt')
      const name = backupName(tracked, 1)
      const content = 'W'.repeat(100)
      await mkdir(join(tmp, 'file-history', prev), { recursive: true })
      await writeFile(join(tmp, 'file-history', prev, name), content)
      const cur = join(tmp, 'file-history', getSessionId())

      linkFake = async () => {
        throw errnoError('EXDEV', 'link')
      }
      let calls = 0
      copyFileFake = async (s, d, mode) => {
        calls++
        if (calls === 1) {
          await REAL_FS.writeFile(d, '\0'.repeat(40))
          return
        }
        return REAL_FS.copyFile(s, d, mode)
      }

      await copyFileHistoryForResume(makeResumeLog(prev, { [tracked]: name }))

      // Fallback copy landed the full content despite the first truncated
      // attempt (v274 would have migrated the truncated bytes silently).
      expect(await readFile(join(cur, name), 'utf8')).toBe(content)
      expect(calls).toBe(2)
      await expectNoTempDebris(cur)
    },
    5000, // one real 100 ms backoff sleep
  )

  test(
    'an exhausted fallback copy fails only its own backup; siblings still migrate (allSettled isolation)',
    async () => {
      const prev = 'prev-session-iso'
      const trackedX = join(tmp, 'x.txt')
      const trackedY = join(tmp, 'y.txt')
      const nameX = backupName(trackedX, 1)
      const nameY = backupName(trackedY, 1)
      await mkdir(join(tmp, 'file-history', prev), { recursive: true })
      await writeFile(join(tmp, 'file-history', prev, nameX), 'XBAD')
      await writeFile(join(tmp, 'file-history', prev, nameY), 'YGOOD')
      const cur = join(tmp, 'file-history', getSessionId())
      const oldX = join(tmp, 'file-history', prev, nameX)

      linkFake = async () => {
        throw errnoError('EXDEV', 'link')
      }
      copyFileFake = async (s, d, mode) => {
        if (s === oldX) {
          // X's copy truncates on every attempt → schedule exhausted.
          await REAL_FS.writeFile(d, '\0'.repeat(2))
          return
        }
        return REAL_FS.copyFile(s, d, mode)
      }

      // Must resolve — the failure is per-file, not per-call.
      await copyFileHistoryForResume(
        makeResumeLog(prev, { [trackedX]: nameX, [trackedY]: nameY }),
      )

      // Y migrated fully.
      expect(await readFile(join(cur, nameY), 'utf8')).toBe('YGOOD')
      // X is absent — never landed half-written.
      const xStat = await lstat(join(cur, nameX)).catch(() => 'missing')
      expect(xStat).toBe('missing')
      await expectNoTempDebris(cur)
    },
    8000, // X burns the real [100,200,400,800] schedule ≈ 1.5 s
  )
})
