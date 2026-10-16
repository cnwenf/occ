/**
 * CC 2.1.301 (occ160 WP-B) — RipgrepAbnormalExitError.
 *
 * Changelog: "Fixed Grep and Glob reporting no matches when the search
 * program failed unexpectedly before returning any results; they now return
 * an error saying the search failed."
 *
 * Before this port, ripgrep exiting with an UNEXPECTED code (not 0 success,
 * 1 no-matches, 2 usage/target error, not ABORT_ERR, not a timeout signal,
 * not a buffer overflow, not a spawn-resource errno, not an external kill)
 * with zero result lines resolved `[]`, so Grep rendered "No matches found"
 * and Glob rendered "No files found" for a search that never really ran.
 *
 * Official verbatim (v301 linux-x64 ELF; BOTH the class name and the message
 * have 0 hits in the v300 ELF — new in 2.1.301):
 *   @108889808  message string table entry (ends "…set to leave out.")
 *   @108890200  telemetry label "ripgrep unexpected exit with no results"
 *   @223101247  `class FU extends x{constructor(){super('The search failed…',
 *               "ripgrep unexpected exit with no results");
 *               this.name="RipgrepAbnormalExitError"}}`
 *   @223117565  throw site in the shared result handler:
 *     if(w.code!==2&&w.code!=="ABORT_ERR"){
 *       let le=UU.has(E(w)??"");
 *       if(q||K||Z||le||AU(R)) t("rg failed …",{level:"error"});
 *       else{ let pe=re.length===0&&s?.rejectOnInputError&&w.code!=="ECHILD"
 *               ?r.aborted?IU(r):new FU:void 0;
 *             if(l(wGo(…)),pe!==void 0){y(pe);return}}}
 *   @223100653  `Yse=new Set(["SIGHUP","SIGINT","SIGPIPE"])` (external kill)
 *   @223100962  `IU` — aborted race → AbortError (`qe`, @216473104) or the
 *               standard timeout error.
 *
 * Naming caution (string-table trap): the v301 string table lists the new
 * message right after `RipgrepOutputError` (@108889780), but the code site
 * proves `RipgrepOutputError` (binary `p_`) is the PRE-EXISTING output-
 * collection error (identical in v300 @108834328) — the new class is
 * `RipgrepAbnormalExitError`. The exit-2 usage error (`RipgrepUsageError`,
 * v300 `BU` / v301 `MU`) is byte-identical between versions → untouched.
 *
 * The execFile path is exercised for real via a fake `rg` on PATH (same
 * harness as ripgrepUnreadable292.test.ts; getRipgrepConfig memoizes on
 * first use, so the module is imported AFTER PATH is shadowed).
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
const mode = process.env.FAKE_RG_MODE || 'nomatch'

if (mode === 'match') {
  process.stdout.write('a.txt:1:hello\\nb.txt:2:world\\n')
  process.exit(0)
}
if (mode === 'nomatch') {
  process.exit(1)
}
if (mode === 'exit3') {
  // Unexpected exit code, zero results — the 2.1.301 fix shape.
  process.exit(3)
}
if (mode === 'exit3-partial') {
  // Unexpected exit code AFTER emitting results — pe requires zero lines.
  process.stdout.write('a.txt:1:hello\\nb.txt:2:world\\n')
  process.exit(3)
}
if (mode === 'usage') {
  process.stderr.write('rg: regex parse error: unrecognized escape sequence\\n')
  process.exit(2)
}
if (mode === 'sighup') {
  // External kill — binary Z arm (SIGHUP/SIGINT/SIGPIPE), not unexpected exit.
  process.kill(process.pid, 'SIGHUP')
}
process.stderr.write('unknown FAKE_RG_MODE: ' + mode + '\\n')
process.exit(9)
`

const sandboxDir = mkdtempSync(join(tmpdir(), 'occ-rg-abnormal-'))
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

const {
  ripGrep,
  RipgrepAbnormalExitError,
  RipgrepTimeoutError,
  SearchPatternError,
  abortedSearchRejection,
} = await import('../ripgrep.js')
const { glob } = await import('../glob.js')
const { AbortError } = await import('../errors.js')

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

function runFakeRg(mode: string): void {
  process.env.FAKE_RG_MODE = mode
}

afterAll(() => {
  process.env.PATH = originalPath
  delete process.env.FAKE_RG_MODE
})

// Byte-verbatim from the v301 ELF (@108889808 string table, confirmed
// against the `class FU` constructor in the code region @223101270).
const VERBATIM_MESSAGE =
  'The search failed, so this is not a "no matches" result: matches may exist. What happened to the search program (ripgrep) is not known, and no results were read. Run the search once more. If it fails again, tell the user that searches are failing. Do not run a recursive search in the shell instead (for example grep -r, find or rg): it can reach what this tool is set to leave out.'

// ---------------------------------------------------------------------------
// Class taxonomy — constructor shape
// ---------------------------------------------------------------------------

describe('2.1.301 WP-B — RipgrepAbnormalExitError taxonomy', () => {
  test('carries the byte-exact error name', () => {
    expect(new RipgrepAbnormalExitError().name).toBe(
      'RipgrepAbnormalExitError',
    )
  })

  test('carries the byte-verbatim official message', () => {
    expect(new RipgrepAbnormalExitError().message).toBe(VERBATIM_MESSAGE)
  })
})

// ---------------------------------------------------------------------------
// Dispatch — Grep lane (ripGrep with rejectOnInputError, as GrepTool passes)
// ---------------------------------------------------------------------------

describe('2.1.301 WP-B — unexpected-exit dispatch (Grep lane)', () => {
  test('unexpected exit code with zero results + rejectOnInputError → rejects with the verbatim error', async () => {
    // Arrange — exit 3, empty stdout: the changelog's failure shape.
    runFakeRg('exit3')

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
    expect(error).toBeInstanceOf(RipgrepAbnormalExitError)
    expect((error as Error).name).toBe('RipgrepAbnormalExitError')
    expect((error as Error).message).toBe(VERBATIM_MESSAGE)
  })

  test('without rejectOnInputError the unexpected exit keeps [] semantics (gate parity with spawn-resource/usage ports)', async () => {
    // Arrange
    runFakeRg('exit3')

    // Act — no options: the caller did not opt into input-error rejection.
    const lines = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
    )

    // Assert
    expect(lines).toEqual([])
  })

  test('unexpected exit AFTER emitting results resolves the partial lines (pe requires zero results)', async () => {
    // Arrange — binary `re.length===0` gate: partial results are kept.
    runFakeRg('exit3-partial')

    // Act
    const lines = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    )

    // Assert
    expect(lines).toEqual(['a.txt:1:hello', 'b.txt:2:world'])
  })

  test('external kill (SIGHUP) with zero results rejects on Bun — the binary Z arm checks code===undefined but Bun delivers code:null (faithful parity)', async () => {
    // Arrange — binary `Z = w.code===void 0 && (w.signal===void 0 ||
    // Yse.has(w.signal))` (@223100653). Probe-verified: Bun's
    // node:child_process execFile shim delivers `code: null` (not undefined)
    // for signal-killed children, so the official-on-Bun ALSO takes the
    // unmodeled arm for a SIGHUP kill with zero results — semantically
    // correct: the search failed, it is not a "no matches" result. The Z
    // exemption is ported byte-faithfully (`=== undefined`) and only catches
    // errors constructed without a code field.
    runFakeRg('sighup')

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
    expect(error).toBeInstanceOf(RipgrepAbnormalExitError)
    expect((error as Error).message).toBe(VERBATIM_MESSAGE)
  })
})

// ---------------------------------------------------------------------------
// No-regression — the pre-existing arms must be untouched
// ---------------------------------------------------------------------------

describe('2.1.301 WP-B — no regression on existing arms', () => {
  test('exit 1 with empty output (genuine no matches) still resolves [] → GrepTool renders "No matches found"', async () => {
    runFakeRg('nomatch')
    const lines = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    )
    expect(lines).toEqual([])
  })

  test('exit 0 with matches resolves the parsed lines', async () => {
    runFakeRg('match')
    const lines = await ripGrep(
      ['-e', 'x'],
      sandboxDir,
      new AbortController().signal,
      { rejectOnInputError: true },
    )
    expect(lines).toEqual(['a.txt:1:hello', 'b.txt:2:world'])
  })

  test('exit 2 usage error still rejects with SearchPatternError (RipgrepUsageError — byte-identical v300↔v301, unchanged)', async () => {
    runFakeRg('usage')
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
    expect(error).toBeInstanceOf(SearchPatternError)
    expect((error as Error).name).toBe('RipgrepUsageError')
    expect((error as Error).message).toContain(
      'Search failed — ripgrep rejected the pattern, glob, or file type without searching:',
    )
  })
})

// ---------------------------------------------------------------------------
// Glob parity — glob() threads rejectOnInputError (changelog: Grep AND Glob)
// ---------------------------------------------------------------------------

describe('2.1.301 WP-B — Glob parity', () => {
  test('glob() over an unexpected exit rejects with RipgrepAbnormalExitError (not a silent empty file list)', async () => {
    // Arrange
    runFakeRg('exit3')

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
    expect(error).toBeInstanceOf(RipgrepAbnormalExitError)
    expect((error as Error).message).toBe(VERBATIM_MESSAGE)
  })

  test('glob() over a genuine no-match (exit 1) still resolves an empty file list', async () => {
    runFakeRg('nomatch')
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

// ---------------------------------------------------------------------------
// Aborted race — binary IU (@223100962): the aborted arm of the new ternary
// ---------------------------------------------------------------------------

describe('2.1.301 WP-B — abortedSearchRejection (binary IU)', () => {
  test('aborted with a non-timeout reason → AbortError (binary `new qe`)', () => {
    // Arrange
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))

    // Act
    const error = abortedSearchRejection(controller.signal)

    // Assert
    expect(error).toBeInstanceOf(AbortError)
    expect(error.name).toBe('AbortError')
  })

  test('aborted with a TimeoutError reason → RipgrepTimeoutError', () => {
    // Arrange — AbortSignal.timeout() rejects with a DOMException named
    // 'TimeoutError'; mirror the shape.
    const controller = new AbortController()
    controller.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))

    // Act
    const error = abortedSearchRejection(controller.signal)

    // Assert
    expect(error).toBeInstanceOf(RipgrepTimeoutError)
    expect(error.message).toMatch(
      /Ripgrep search timed out after (20|60) seconds\./,
    )
    expect(
      (error as unknown as { partialResults: string[] }).partialResults,
    ).toEqual([])
  })

  test('not aborted → RipgrepTimeoutError (IU falls through to the timeout arm)', () => {
    const error = abortedSearchRejection(new AbortController().signal)
    expect(error).toBeInstanceOf(RipgrepTimeoutError)
  })
})
