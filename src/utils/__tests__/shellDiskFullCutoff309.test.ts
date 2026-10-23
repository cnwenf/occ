/**
 * CC 2.1.309 (triage-T3 item 46 / forensics F-7): disk-full diagnostics for
 * command output capture — the cut-off message (official `tco`) and the
 * probe-write helper (official `SFo`).
 *
 * Byte evidence (official 2.1.309 linux-x64 ELF, read-only dd):
 * - @249267000+ (`tco(e,n)` full body): statfs(dirname(e),{bigint:true}) →
 *   `H=w.bavail*w.bsize/(1024n*1024n)`, `y=H>=0n&&w.blocks>0n`;
 *   `y&&H<10n` → "Disk full: this computer's volume holding ${r} (Claude
 *   Code's temporary directory) has ${H} MB free, ${h} ${j9}";
 *   `y&&w.files>0n&&w.ffree<1000n` → "Nearly out of inodes: … has ${w.ffree}
 *   free inodes, so creating files there may fail and the command may have
 *   failed for that reason. ${j9}"; `if(y&&!n)return null`; probe `SFo(e)`:
 *   EDQUOT → "Disk quota used up: a test write beside this command's output
 *   file, …", ENOSPC → "Disk full: a test write beside this command's output
 *   file, …", else null. `r=Quo(bp(),jNe())` (join(tmpRoot, claude-uid)),
 *   `s=n?"whatever this command printed was lost":"this command's output may
 *   be cut short"`, `h=\`so ${s} and its own writes may have failed with "No
 *   space left on device".\``
 * - @249266879 (`j9` remedy const, verbatim): "Free space on that volume, or
 *   restart Claude Code with CLAUDE_CODE_TMPDIR set to a directory on another
 *   one, then retry. If this is the user's own computer, tell them before
 *   deleting anything to make room." (`eco=5000` = size-poll interval, N-A)
 * - @245635768 (`SFo` probe): `${e}.${Tt(6).toString("hex")}.probe`, open
 *   {exclusive:!0,windowsFlags:"wx"} (open failure → null), write
 *   `Rt=new Uint8Array([10])`, catch → errno name, finally unlink with debug
 *   log `probeTaskOutputWrite: could not delete ${n}: ${d(i)}`
 * - @249271400 (caller, official ShellCommand exit path):
 *   `else if(this.taskOutput.stdoutToFile&&e!==0&&!(n&&e===H9)){let w=await
 *   tco(this.taskOutput.path,r==="");if(w)s.stdout=r?\`${w}\n${r}\`:w}`
 *   (H9=137; n=status was "killed"; r=accumulated stdout)
 *
 * OCC port: Shell.ts — `DISK_FULL_REMEDY` (j9), `checkTaskOutputDiskFull`
 * (tco), `probeTaskOutputWrite` (SFo). Structural deviation (declared at the
 * code site): the official caller sits in the ShellCommand exit path
 * (#handleExit), but ShellCommand.ts is outside this work package's file
 * list — OCC wires the identical gate in Shell.ts exec() by augmenting
 * `shellCommand.result` (file mode, code!==0, not killed-with-137).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as CHILD_PROCESS_NAMESPACE from 'child_process'
import * as FS_PROMISES_NAMESPACE from 'fs/promises'

// Snapshot the REAL exports by value BEFORE mock.module patches the live
// namespace bindings (precedent: hookStdioFlags285RealChild.test.ts) —
// delegating to the namespace after mocking would recurse into the mock, and
// restoring from the patched namespace would leak it across files.
const REAL_CHILD_PROCESS = { ...CHILD_PROCESS_NAMESPACE }
const REAL_FS_PROMISES = { ...FS_PROMISES_NAMESPACE }
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DISK_FULL_REMEDY,
  checkTaskOutputDiskFull,
  exec,
  probeTaskOutputWrite,
} from '../Shell.js'
import { getClaudeTempDirName } from '../permissions/filesystem.js'
import { getTmpRootDir } from '../tmpDirBackstop.js'

const CLAUDE_TEMP_DIR = join(getTmpRootDir(), getClaudeTempDirName())

const LOST_PHRASE = 'whatever this command printed was lost'
const CUT_SHORT_PHRASE = "this command's output may be cut short"

type StatfsBigint = {
  bavail: bigint
  bsize: bigint
  blocks: bigint
  files: bigint
  ffree: bigint
}

function statfsFixture({
  freeMb,
  files = 1000000n,
  ffree = 500000n,
}: {
  freeMb: bigint
  files?: bigint
  ffree?: bigint
}): StatfsBigint {
  const bsize = 4096n
  return {
    bavail: (freeMb * 1024n * 1024n) / bsize,
    bsize,
    blocks: 1000000000n,
    files,
    ffree,
  }
}

function installStatfsMock(impl: (path: string) => Promise<StatfsBigint>): void {
  mock.module('fs/promises', () => ({
    ...REAL_FS_PROMISES,
    statfs: (path: string, opts: unknown) =>
      opts === undefined ? REAL_FS_PROMISES.statfs(path as never) : impl(path),
  }))
}

function makeErrnoError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, errno: -1 })
}

/**
 * Fake FileHandle whose write fails with the given errno — the official SFo
 * classifies the WRITE failure (`try{await i.write(Rt)}` → outer catch →
 * errno); an OPEN failure returns null instead (inner `catch{return null}`),
 * so errno tests must fail the write, not the open.
 */
function fakeFailingWriteHandle(code: string): object {
  return {
    write: () =>
      Promise.reject(
        makeErrnoError(code, `${code}: write failed (probe test)`),
      ),
    close: () => Promise.resolve(),
  }
}

afterEach(async () => {
  await mock.module('fs/promises', () => ({ ...REAL_FS_PROMISES }))
  await mock.module('child_process', () => ({ ...REAL_CHILD_PROCESS }))
})

describe('CC 2.1.309 item 46 — DISK_FULL_REMEDY (official j9)', () => {
  test('matches the official remedy text verbatim', () => {
    // Official @249266879
    expect(DISK_FULL_REMEDY).toBe(
      "Free space on that volume, or restart Claude Code with CLAUDE_CODE_TMPDIR set to a directory on another one, then retry. If this is the user's own computer, tell them before deleting anything to make room.",
    )
  })
})

describe('CC 2.1.309 item 46 — checkTaskOutputDiskFull (official tco)', () => {
  const OUTPUT_FILE = join(tmpdir(), 'occ-309-cutoff', 'task-output.txt')

  test('reports the volume disk-full message when <10 MB free (cut-short phrasing)', async () => {
    // Arrange
    installStatfsMock(async () => statfsFixture({ freeMb: 5n }))

    // Act
    const message = await checkTaskOutputDiskFull(OUTPUT_FILE, false)

    // Assert — verbatim official template
    expect(message).toBe(
      `Disk full: this computer's volume holding ${CLAUDE_TEMP_DIR} (Claude Code's temporary directory) has 5 MB free, so ${CUT_SHORT_PHRASE} and its own writes may have failed with "No space left on device". ${DISK_FULL_REMEDY}`,
    )
  })

  test('uses the lost-output phrasing when the output was lost', async () => {
    // Arrange
    installStatfsMock(async () => statfsFixture({ freeMb: 0n }))

    // Act
    const message = await checkTaskOutputDiskFull(OUTPUT_FILE, true)

    // Assert
    expect(message).toBe(
      `Disk full: this computer's volume holding ${CLAUDE_TEMP_DIR} (Claude Code's temporary directory) has 0 MB free, so ${LOST_PHRASE} and its own writes may have failed with "No space left on device". ${DISK_FULL_REMEDY}`,
    )
  })

  test('reports the inode exhaustion message when ffree < 1000', async () => {
    // Arrange
    installStatfsMock(async () =>
      statfsFixture({ freeMb: 5000n, files: 100000n, ffree: 999n }),
    )

    // Act
    const message = await checkTaskOutputDiskFull(OUTPUT_FILE, false)

    // Assert
    expect(message).toBe(
      `Nearly out of inodes: this computer's volume holding ${CLAUDE_TEMP_DIR} (Claude Code's temporary directory) has 999 free inodes, so creating files there may fail and the command may have failed for that reason. ${DISK_FULL_REMEDY}`,
    )
  })

  test('returns null without probing when the volume is healthy and output was not lost', async () => {
    // Arrange
    let probeAttempts = 0
    await mock.module('fs/promises', () => ({
      ...REAL_FS_PROMISES,
      statfs: (path: string, opts: unknown) =>
        opts === undefined
          ? REAL_FS_PROMISES.statfs(path as never)
          : Promise.resolve(statfsFixture({ freeMb: 5000n })),
      open: (path: string, ...rest: unknown[]) => {
        if (String(path).endsWith('.probe')) probeAttempts += 1
        return (REAL_FS_PROMISES.open as Function)(path, ...rest)
      },
    }))

    // Act
    const message = await checkTaskOutputDiskFull(OUTPUT_FILE, false)

    // Assert — official `if(y&&!n)return null`
    expect(message).toBeNull()
    expect(probeAttempts).toBe(0)
  })

  test('probes beside the output file when output was lost, ENOSPC probe → disk-full message', async () => {
    // Arrange — healthy statfs, but the probe write fails with ENOSPC
    const dir = mkdtempSync(join(tmpdir(), 'occ-309-probe-'))
    const outputFile = join(dir, 'task-output.txt')
    await mock.module('fs/promises', () => ({
      ...REAL_FS_PROMISES,
      statfs: (path: string, opts: unknown) =>
        opts === undefined
          ? REAL_FS_PROMISES.statfs(path as never)
          : Promise.resolve(statfsFixture({ freeMb: 5000n })),
      open: (path: string, ...rest: unknown[]) => {
        if (String(path).endsWith('.probe')) {
          return Promise.resolve(fakeFailingWriteHandle('ENOSPC'))
        }
        return (REAL_FS_PROMISES.open as Function)(path, ...rest)
      },
    }))

    // Act
    const message = await checkTaskOutputDiskFull(outputFile, true)

    // Assert
    expect(message).toBe(
      `Disk full: a test write beside this command's output file, on the volume holding ${CLAUDE_TEMP_DIR} (Claude Code's temporary directory), failed with ENOSPC (the volume, or the user's quota on it, has no space left), so ${LOST_PHRASE} and its own writes may have failed with "No space left on device". ${DISK_FULL_REMEDY}`,
    )

    // Cleanup
    rmSync(dir, { recursive: true, force: true })
  })

  test('EDQUOT probe → disk-quota message with its own remedy text', async () => {
    // Arrange — official `if(y&&!n)return null`: with output NOT lost the
    // probe only runs when statfs is implausible/failed, so statfs rejects
    // here and the failing probe write supplies the EDQUOT classification.
    const dir = mkdtempSync(join(tmpdir(), 'occ-309-probe-'))
    const outputFile = join(dir, 'task-output.txt')
    await mock.module('fs/promises', () => ({
      ...REAL_FS_PROMISES,
      statfs: () => Promise.reject(new Error('statfs unsupported')),
      open: (path: string, ...rest: unknown[]) => {
        if (String(path).endsWith('.probe')) {
          return Promise.resolve(fakeFailingWriteHandle('EDQUOT'))
        }
        return (REAL_FS_PROMISES.open as Function)(path, ...rest)
      },
    }))

    // Act
    const message = await checkTaskOutputDiskFull(outputFile, false)

    // Assert — official EDQUOT variant has its own remedy sentence (not j9)
    expect(message).toBe(
      `Disk quota used up: a test write beside this command's output file, on the volume holding ${CLAUDE_TEMP_DIR} (Claude Code's temporary directory), failed with EDQUOT, so ${CUT_SHORT_PHRASE} and its own writes may have failed with "Disk quota exceeded". Delete files there that are no longer needed, or restart Claude Code with CLAUDE_CODE_TMPDIR set to a directory on another volume, then retry. If this is the user's own computer, tell them before deleting anything to make room.`,
    )

    // Cleanup
    rmSync(dir, { recursive: true, force: true })
  })

  test('statfs failure falls through to the probe; successful probe → null', async () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'occ-309-probe-'))
    const outputFile = join(dir, 'task-output.txt')
    await mock.module('fs/promises', () => ({
      ...REAL_FS_PROMISES,
      statfs: () => Promise.reject(new Error('statfs unsupported')),
    }))

    // Act
    const message = await checkTaskOutputDiskFull(outputFile, false)

    // Assert — real probe write succeeds on this volume, then unlinks
    expect(message).toBeNull()
    const leftovers = await REAL_FS_PROMISES.readdir(dir)
    expect(leftovers.filter(name => name.endsWith('.probe'))).toEqual([])

    // Cleanup
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('CC 2.1.309 item 46 — probeTaskOutputWrite (official SFo)', () => {
  test('returns null on a successful probe write and leaves no probe file behind', async () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'occ-309-probe-'))
    const outputFile = join(dir, 'task-output.txt')

    // Act
    const errno = await probeTaskOutputWrite(outputFile)

    // Assert
    expect(errno).toBeNull()
    const leftovers = await REAL_FS_PROMISES.readdir(dir)
    expect(leftovers.filter(name => name.endsWith('.probe'))).toEqual([])

    // Cleanup
    rmSync(dir, { recursive: true, force: true })
  })

  test('returns the errno name when the probe WRITE fails', async () => {
    // Arrange — official SFo: open failure returns null (inner catch); only a
    // failed write is classified by errno, so the fake handle's write rejects.
    const dir = mkdtempSync(join(tmpdir(), 'occ-309-probe-'))
    const outputFile = join(dir, 'task-output.txt')
    await mock.module('fs/promises', () => ({
      ...REAL_FS_PROMISES,
      open: (path: string, ...rest: unknown[]) => {
        if (String(path).endsWith('.probe')) {
          return Promise.resolve(fakeFailingWriteHandle('EDQUOT'))
        }
        return (REAL_FS_PROMISES.open as Function)(path, ...rest)
      },
    }))

    // Act
    const errno = await probeTaskOutputWrite(outputFile)

    // Assert
    expect(errno).toBe('EDQUOT')

    // Cleanup
    rmSync(dir, { recursive: true, force: true })
  })

  test('returns null when the probe open itself fails (official inner catch)', async () => {
    // Arrange — official SFo: `try{i=await N(n,{exclusive:!0,…})}catch{return null}`
    const dir = mkdtempSync(join(tmpdir(), 'occ-309-probe-'))
    const outputFile = join(dir, 'task-output.txt')
    await mock.module('fs/promises', () => ({
      ...REAL_FS_PROMISES,
      open: (path: string, ...rest: unknown[]) => {
        if (String(path).endsWith('.probe')) {
          return Promise.reject(
            makeErrnoError('ENOSPC', `ENOSPC: no space left on device, open '${path}'`),
          )
        }
        return (REAL_FS_PROMISES.open as Function)(path, ...rest)
      },
    }))

    // Act
    const errno = await probeTaskOutputWrite(outputFile)

    // Assert — open failure is NOT classified; the probe reports null
    expect(errno).toBeNull()

    // Cleanup
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('CC 2.1.309 item 46 — exec() wiring (official exit-path gate)', () => {
  async function installFakeBashProvider(): Promise<void> {
    await mock.module('../shell/bashProvider.js', () => ({
      createBashShellProvider: async (shellPath: string) => ({
        type: 'bash' as const,
        shellPath,
        detached: false,
        buildExecCommand: async (command: string) => ({
          commandString: command,
          cwdFilePath: '/tmp/occ-309-cutoff-cwd',
        }),
        getSpawnArgs: (commandString: string) => ['-c', commandString],
        getEnvironmentOverrides: async () => ({}),
      }),
    }))
  }

  test('failed file-mode command gets the disk-full diagnostic prepended to stdout', async () => {
    // Arrange — the volume holding the task-output dir reports <10 MB free
    await installFakeBashProvider()
    installStatfsMock(async () => statfsFixture({ freeMb: 2n }))

    // Act
    const shellCommand = await exec('exit 3', new AbortController().signal, 'bash')
    const result = await shellCommand.result

    // Assert — official: stdout was empty → `s.stdout=w`
    expect(result.code).toBe(3)
    expect(result.stdout).toBe(
      `Disk full: this computer's volume holding ${CLAUDE_TEMP_DIR} (Claude Code's temporary directory) has 2 MB free, so ${LOST_PHRASE} and its own writes may have failed with "No space left on device". ${DISK_FULL_REMEDY}`,
    )
  })

  test('successful command stdout is untouched', async () => {
    // Arrange
    await installFakeBashProvider()
    installStatfsMock(async () => statfsFixture({ freeMb: 2n }))

    // Act
    const shellCommand = await exec('echo ok-309', new AbortController().signal, 'bash')
    const result = await shellCommand.result

    // Assert — official gate `e!==0` skips the diagnostic on success
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ok-309\n')
  })

  test('failed command on a healthy volume gets no diagnostic', async () => {
    // Arrange
    await installFakeBashProvider()
    installStatfsMock(async () => statfsFixture({ freeMb: 5000n }))

    // Act
    const shellCommand = await exec('echo partial; exit 3', new AbortController().signal, 'bash')
    const result = await shellCommand.result

    // Assert
    expect(result.code).toBe(3)
    expect(result.stdout).toBe('partial\n')
  })
})
