/**
 * CC 2.1.292 (C1) — RipgrepTargetUnreadableError.
 *
 * Before this port, an unreadable search target (e.g. a `chmod 000` directory)
 * made ripgrep exit 2 with a single-line `rg: <target>: ... (os error N)`
 * stderr and NO result lines. OCC's collector resolved `[]` for that, so
 * Grep/Glob reported "No files found" / "No matches found" for a search that
 * never ran — the exact misreport the official `zB` class fixes.
 *
 * Official verbatim (v292 ELF, byte offsets confirmed against the shipped
 * linux-x64 binary):
 *   @208892821  class zB (RipgrepTargetUnreadableError) + the errno constants
 *               `vte=1,QB=2,_te=5,Tte=13,wte=20,Cte=2,Ate=3,Ite=5`
 *   @208906460  the throw site inside the ripgrep result callback:
 *     if(s?.rejectOnInputError&&S.code===2
 *        &&ee.every((le)=>le.endsWith('"type":"summary"}'))
 *        &&w.startsWith(`rg: ${r}: `)&&!w.trimEnd().includes(`\n`)){
 *       let le=Number(/\(os error (\d+)\)\s*$/.exec(w)?.[1]),
 *           he=r!==oir&&(O()==="windows"?[Cte,Ate]:[QB,wte]).includes(le);
 *       if(!Number.isNaN(le)&&!he){g(new zB(le));return}}
 *
 * Dispatch order in the same callback (official): EAGAIN retry → XB
 * (RipgrepUsageError) → zB → stdinSourceFailed → uf (spawn resource) → JB
 * (output too large) → rir (timeout) → resolve. OCC has no stdin lane, so
 * stdinSourceFailed is absent; zB is inserted between XB and uf.
 *
 * fd-3 pin lane (`oir="/proc/self/fd/3"`, `inheritFd`, the `e===2` "not passed
 * to ripgrep" arm's real trigger) is STAGED — the constant and the message arm
 * are ported verbatim for taxonomy parity, but no target ever equals oir yet,
 * so the ENOENT/ENOTDIR exemption always applies and the fd-pin arm is
 * unreachable in practice (matches official gating: the pin is
 * flag/platform-conditional).
 *
 * The execFile path is exercised for real via a fake `rg` on PATH (the
 * embedded/argv0 branch is unreachable under `bun test`). getRipgrepConfig is
 * memoized on first use, so the module is imported AFTER PATH is shadowed.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// ---------------------------------------------------------------------------
// Test double for `rg`
// ---------------------------------------------------------------------------

const FAKE_RG_SOURCE = `#!/usr/bin/env bun
const argv = process.argv.slice(2)
const mode = process.env.FAKE_RG_MODE || 'nomatch'
const errno = Number(process.env.FAKE_RG_ERRNO || '13')
const target = argv[argv.length - 1] ?? '.'

const DETAILS = {
  1: 'Operation not permitted',
  2: 'No such file or directory',
  5: 'Input/output error',
  13: 'Permission denied',
  20: 'Not a directory',
}
const detail = DETAILS[errno] || 'OS error'

if (mode === 'nomatch') {
  process.exit(1)
}

if (mode === 'unreadable') {
  // Single-line stderr, exit 2 — the zB trigger shape.
  process.stderr.write(\`rg: \${target}: \${detail} (os error \${errno})\\n\`)
  process.exit(2)
}

if (mode === 'unreadable-multiline') {
  // TWO stderr lines — the zB single-line guard must NOT fire.
  process.stderr.write(\`rg: \${target}: \${detail} (os error \${errno})\\n\`)
  process.stderr.write(\`rg: \${target}/nested: \${detail} (os error \${errno})\\n\`)
  process.exit(2)
}

process.stderr.write('unknown FAKE_RG_MODE: ' + mode + '\\n')
process.exit(9)
`

const sandboxDir = mkdtempSync(join(tmpdir(), 'occ-rg-unreadable-'))
const fakeBinDir = join(sandboxDir, 'bin')
const fakeRgPath = join(fakeBinDir, 'rg')

mkdirSync(fakeBinDir, { recursive: true })
writeFileSync(fakeRgPath, FAKE_RG_SOURCE, { mode: 0o755 })
chmodSync(fakeRgPath, 0o755)
const originalPath = process.env.PATH
process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`

// ---------------------------------------------------------------------------
// Modules under test (imported AFTER PATH is shadowed so getRipgrepConfig
// memoizes the fake `rg` as the system-mode command).
// ---------------------------------------------------------------------------

const { ripGrep, RipgrepTargetUnreadableError } = await import('../ripgrep.js')
const { glob } = await import('../glob.js')

/** Minimal empty ToolPermissionContext for glob(). */
function emptyPermissionContext(): any {
  const emptyRules = { settings: [], cliArg: [], command: [], session: [] }
  return {
    mode: 'ask',
    alwaysAllowRules: emptyRules,
    alwaysDenyRules: emptyRules,
    denyRules: emptyRules,
    additionalDirectories: [],
    additionalWorkingDirectories: new Map(),
    hasFlaggedPermissions: false,
  }
}

const GUIDANCE =
  'Do not run a recursive search in the shell instead (for example grep -r, find or rg)'
const NOT_NO_MATCHES = 'This is not a "no matches" result.'
const PERMISSION_TAIL = `Tell the user that the path could not be read. ${GUIDANCE}.`
const RETRY_TAIL = `Run the search once more. If it fails again, tell the user that the search is failing. ${GUIDANCE}: it can also reach other files, which this tool is set to leave out.`

function runFakeRg(mode: string, errno?: number): void {
  process.env.FAKE_RG_MODE = mode
  if (errno !== undefined) process.env.FAKE_RG_ERRNO = String(errno)
}

afterAll(() => {
  process.env.PATH = originalPath
  delete process.env.FAKE_RG_MODE
  delete process.env.FAKE_RG_ERRNO
})

/**
 * The zB message is fully determined by (errno, platform). On linux the
 * permission class is errno 13 (EACCES) or 1 (EPERM); 5 is I/O; 2 is the
 * fd-not-passed arm; everything else is "an operating system error".
 */
function expectedZbMessage(errno: number): string {
  const isPermission = errno === 13 || errno === 1
  const reason = isPermission
    ? 'permission denied'
    : errno === 5
      ? 'input/output error'
      : errno === 2
        ? 'the file Claude Code opened was not passed to ripgrep'
        : 'an operating system error'
  const tail = isPermission ? PERMISSION_TAIL : RETRY_TAIL
  return `Search failed: ripgrep could not read the path it was given (${reason}, os error ${errno}), so nothing was searched. ${NOT_NO_MATCHES} ${tail}`
}

// ---------------------------------------------------------------------------
// zB error taxonomy — constructor messages (posix / linux)
// ---------------------------------------------------------------------------

describe('2.1.292 C1 — RipgrepTargetUnreadableError taxonomy (posix)', () => {
  test('EACCES (13) → permission denied + tell-user guidance', () => {
    const err = new RipgrepTargetUnreadableError(13)
    expect(err.name).toBe('RipgrepTargetUnreadableError')
    expect(err.message).toBe(expectedZbMessage(13))
    expect(err.message).toContain('(permission denied, os error 13)')
    expect(err.message).toContain(NOT_NO_MATCHES)
    expect(err.message).toContain(PERMISSION_TAIL)
  })

  test('EPERM (1) → permission denied class (posix e===13||e===1)', () => {
    const err = new RipgrepTargetUnreadableError(1)
    expect(err.message).toBe(expectedZbMessage(1))
    expect(err.message).toContain('(permission denied, os error 1)')
    expect(err.message).toContain(PERMISSION_TAIL)
  })

  test('EIO (5) → input/output error + retry-once guidance', () => {
    const err = new RipgrepTargetUnreadableError(5)
    expect(err.message).toBe(expectedZbMessage(5))
    expect(err.message).toContain('(input/output error, os error 5)')
    expect(err.message).toContain('Run the search once more.')
    expect(err.message).toContain(RETRY_TAIL)
  })

  test('ENOENT (2) → the fd-not-passed arm (fd-pin lane message, staged)', () => {
    const err = new RipgrepTargetUnreadableError(2)
    expect(err.message).toBe(expectedZbMessage(2))
    expect(err.message).toContain(
      '(the file Claude Code opened was not passed to ripgrep, os error 2)',
    )
  })

  test('unmodelled errno → an operating system error + retry-once guidance', () => {
    const err = new RipgrepTargetUnreadableError(99)
    expect(err.message).toBe(expectedZbMessage(99))
    expect(err.message).toContain('(an operating system error, os error 99)')
    expect(err.message).toContain(RETRY_TAIL)
  })
})

// ---------------------------------------------------------------------------
// zB dispatch — the unreadable-target throw site through ripGrep()
// ---------------------------------------------------------------------------

describe('2.1.292 C1 — RipgrepTargetUnreadableError dispatch (Grep lane)', () => {
  test('EACCES target + rejectOnInputError → rejects with zB (verbatim message)', async () => {
    // Arrange — exit 2, single-line `rg: <target>: ... (os error 13)` stderr.
    runFakeRg('unreadable', 13)

    // Act
    const error = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    ).then(
      lines => {
        throw new Error(`expected rejection, resolved ${JSON.stringify(lines)}`)
      },
      (e: unknown) => e,
    )

    // Assert
    expect(error).toBeInstanceOf(RipgrepTargetUnreadableError)
    expect((error as Error).name).toBe('RipgrepTargetUnreadableError')
    expect((error as Error).message).toBe(expectedZbMessage(13))
  })

  test('EIO target → rejects with the input/output-error + retry-once arm', async () => {
    runFakeRg('unreadable', 5)
    const error = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    ).then(
      () => {
        throw new Error('expected rejection')
      },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(RipgrepTargetUnreadableError)
    expect((error as Error).message).toBe(expectedZbMessage(5))
  })

  test('ENOENT (2) is exempt without an fd pin → resolves [] (existence-check territory)', async () => {
    // Arrange — bare ENOENT stays "no matches" per the `r!==oir` exemption.
    runFakeRg('unreadable', 2)

    // Act
    const lines = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    )

    // Assert
    expect(lines).toEqual([])
  })

  test('ENOTDIR (20) is exempt without an fd pin → resolves []', async () => {
    runFakeRg('unreadable', 20)
    const lines = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    )
    expect(lines).toEqual([])
  })

  test('multi-line stderr does NOT trigger zB (single-line guard)', async () => {
    // Arrange — a recursive walk emits one error line per unreadable entry;
    // that is partial-success territory, not the single-target zB case.
    runFakeRg('unreadable-multiline', 13)

    // Act
    const lines = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    )

    // Assert — resolves (no zB); the model sees an empty result, not a throw.
    expect(lines).toEqual([])
  })

  test('without rejectOnInputError, an unreadable target keeps [] semantics (Glob/@-file callers)', async () => {
    // Arrange
    runFakeRg('unreadable', 13)

    // Act — no options: the caller did not opt into input-error rejection.
    const lines = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
    )

    // Assert
    expect(lines).toEqual([])
  })

  test('exit 1 (genuine no matches) still resolves [] — zB does not over-fire', async () => {
    runFakeRg('nomatch')
    const lines = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    )
    expect(lines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Glob parity — glob() threads rejectOnInputError so it gets the same zB
// ---------------------------------------------------------------------------

describe('2.1.292 C1 — Glob parity (unreadable target)', () => {
  test('glob() over an unreadable dir rejects with zB (not a silent empty file list)', async () => {
    // Arrange
    runFakeRg('unreadable', 13)

    // Act
    const error = await glob(
      '*',
      sandboxDir,
      { limit: 100, offset: 0 },
      new AbortController().signal,
      emptyPermissionContext(),
    ).then(
      result => {
        throw new Error(`expected rejection, resolved ${JSON.stringify(result)}`)
      },
      (e: unknown) => e,
    )

    // Assert
    expect(error).toBeInstanceOf(RipgrepTargetUnreadableError)
    expect((error as Error).message).toBe(expectedZbMessage(13))
  })

  test('glob() over an exempt ENOENT target resolves an empty file list', async () => {
    runFakeRg('unreadable', 2)
    const result = await glob(
      '*',
      sandboxDir,
      { limit: 100, offset: 0 },
      new AbortController().signal,
      emptyPermissionContext(),
    )
    expect(result.files).toEqual([])
    expect(result.truncated).toBe(false)
  })
})
