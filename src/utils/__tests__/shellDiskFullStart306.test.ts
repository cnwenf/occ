/**
 * CC 2.1.306 (#P5): Bash disk-full (ENOSPC/EDQUOT) start-failure message.
 *
 * Byte evidence (official linux-x64 ELFs, read-only):
 * - v306@249973898 (NEW catch branch, absent in v304@248500631 region):
 *   `if(Fa===void 0&&FSn(cs))return Ok(\`The command was not started: this
 *   computer's disk is full (${E(cs)}), so the file that captures command
 *   output could not be created. Nothing ran. If this is the user's own
 *   computer, tell them before deleting anything to make room.\`);`
 * - v306@237500817 (NEW predicate + errno set):
 *   `O_e=new Set(["ENOSPC","EDQUOT","ENFILE","EMFILE"]);
 *    function FSn(n){let e=E(n);return e==="ENOSPC"||e==="EDQUOT"}`
 * - Official exec structure (v306@~249969500): the output-capture-file open
 *   (`ji=await _$t(sr.path,"w")`) sits INSIDE the try, before spawn; `Fa`
 *   (child process) stays undefined when the open fails, so the catch's
 *   `Fa===void 0&&FSn(cs)` guard fires exactly on disk-full-before-start.
 *   The branch sits AFTER the e2big branch (`Ok(Fr,"e2big")`) and BEFORE the
 *   raw passthrough (`return Ok(d(cs))`).
 *
 * OCC port: Shell.ts — `isDiskFullError` (FSn), `DISK_EXHAUSTION_ERRNOS`
 * (O_e), `formatDiskFullStartError` (verbatim message), open moved inside the
 * try, catch branch added after isE2BIG.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as REAL_CHILD_PROCESS from 'child_process'
import * as REAL_FS_PROMISES from 'fs/promises'
import {
  DISK_EXHAUSTION_ERRNOS,
  exec,
  formatDiskFullStartError,
  isDiskFullError,
} from '../Shell.js'

const OFFICIAL_DISK_FULL_MESSAGE = (errName: string): string =>
  `The command was not started: this computer's disk is full (${errName}), so the file that captures command output could not be created. Nothing ran. If this is the user's own computer, tell them before deleting anything to make room.`

function makeErrnoError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, errno: -1 })
}

/** Minimal fake bash provider so exec() never touches real shell snapshots. */
async function installFakeBashProvider(): Promise<void> {
  await mock.module('../shell/bashProvider.js', () => ({
    createBashShellProvider: async (shellPath: string) => ({
      type: 'bash' as const,
      shellPath,
      detached: false,
      buildExecCommand: async (command: string) => ({
        commandString: command,
        cwdFilePath: '/tmp/occ-diskfull-test-cwd',
      }),
      getSpawnArgs: (commandString: string) => ['-c', commandString],
      getEnvironmentOverrides: async () => ({}),
    }),
  }))
}

async function installFailingOpen(
  failure: (path: string) => Error,
): Promise<{ spawnCalls: number }> {
  const counters = { spawnCalls: 0 }
  await mock.module('fs/promises', () => ({
    ...REAL_FS_PROMISES,
    open: (path: string) => Promise.reject(failure(path)),
  }))
  await mock.module('child_process', () => ({
    ...REAL_CHILD_PROCESS,
    spawn: (...args: unknown[]) => {
      counters.spawnCalls += 1
      return (REAL_CHILD_PROCESS.spawn as Function)(...args)
    },
  }))
  return counters
}

async function restoreMocks(): Promise<void> {
  await mock.module('fs/promises', () => ({ ...REAL_FS_PROMISES }))
  await mock.module('child_process', () => ({ ...REAL_CHILD_PROCESS }))
}

describe('CC 2.1.306 isDiskFullError (official FSn predicate)', () => {
  test('matches ENOSPC and EDQUOT errno codes only', () => {
    // Arrange
    const enospc = makeErrnoError('ENOSPC', 'no space left on device')
    const edquot = makeErrnoError('EDQUOT', 'disk quota exceeded')
    const eacces = makeErrnoError('EACCES', 'permission denied')
    const enfile = makeErrnoError('ENFILE', 'too many open files in system')
    const emfile = makeErrnoError('EMFILE', 'too many open files')

    // Act + Assert — official: `e==="ENOSPC"||e==="EDQUOT"` (code-based only)
    expect(isDiskFullError(enospc)).toBe(true)
    expect(isDiskFullError(edquot)).toBe(true)
    expect(isDiskFullError(eacces)).toBe(false)
    expect(isDiskFullError(enfile)).toBe(false)
    expect(isDiskFullError(emfile)).toBe(false)
  })

  test('returns false for errors without an errno code and non-objects', () => {
    expect(isDiskFullError(new Error('ENOSPC mentioned in text only'))).toBe(
      false,
    )
    expect(isDiskFullError('ENOSPC')).toBe(false)
    expect(isDiskFullError(null)).toBe(false)
    expect(isDiskFullError(undefined)).toBe(false)
  })

  test('DISK_EXHAUSTION_ERRNOS keeps the official O_e set verbatim', () => {
    // Official v306@237500817: O_e=new Set(["ENOSPC","EDQUOT","ENFILE","EMFILE"])
    expect([...DISK_EXHAUSTION_ERRNOS].sort()).toEqual(
      ['EDQUOT', 'EMFILE', 'ENFILE', 'ENOSPC'].sort(),
    )
  })

  test('formatDiskFullStartError embeds the errno name in the verbatim message', () => {
    expect(formatDiskFullStartError('ENOSPC')).toBe(
      OFFICIAL_DISK_FULL_MESSAGE('ENOSPC'),
    )
    expect(formatDiskFullStartError('EDQUOT')).toBe(
      OFFICIAL_DISK_FULL_MESSAGE('EDQUOT'),
    )
  })
})

describe('CC 2.1.306 exec() disk-full start-failure branch', () => {
  afterEach(async () => {
    await restoreMocks()
  })

  test('ENOSPC at output-capture-file creation returns the official message and never spawns', async () => {
    // Arrange
    await installFakeBashProvider()
    const counters = await installFailingOpen(path =>
      makeErrnoError('ENOSPC', `ENOSPC: no space left on device, open '${path}'`),
    )

    // Act
    const command = exec('echo hi', new AbortController().signal, 'bash')

    // Assert
    const shellCommand = await command
    const result = await shellCommand.result
    expect(counters.spawnCalls).toBe(0)
    expect(result.code).toBe(126)
    expect(result.stderr).toBe(OFFICIAL_DISK_FULL_MESSAGE('ENOSPC'))
  })

  test('EDQUOT at output-capture-file creation returns the official message', async () => {
    // Arrange
    await installFakeBashProvider()
    const counters = await installFailingOpen(path =>
      makeErrnoError('EDQUOT', `EDQUOT: disk quota exceeded, open '${path}'`),
    )

    // Act
    const shellCommand = await exec(
      'echo hi',
      new AbortController().signal,
      'bash',
    )
    const result = await shellCommand.result

    // Assert
    expect(counters.spawnCalls).toBe(0)
    expect(result.stderr).toBe(OFFICIAL_DISK_FULL_MESSAGE('EDQUOT'))
  })

  test('other errno at output-capture-file creation passes the raw error through unchanged', async () => {
    // Arrange
    await installFakeBashProvider()
    const rawMessage = 'EACCES: permission denied, open \'/x/output\''
    await installFailingOpen(() => makeErrnoError('EACCES', rawMessage))

    // Act
    const shellCommand = await exec(
      'echo hi',
      new AbortController().signal,
      'bash',
    )
    const result = await shellCommand.result

    // Assert — pre-existing generic passthrough (`Ok(d(cs))`) is untouched
    expect(result.code).toBe(126)
    expect(result.stderr).toBe(rawMessage)
  })
})
