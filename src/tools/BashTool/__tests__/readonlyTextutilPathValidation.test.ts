import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import {
  checkPathConstraints,
  COMMAND_OPERATION_TYPE,
  PATH_EXTRACTORS,
} from '../pathValidation.js'

// The permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (a build-time constant polyfilled in cli.tsx for runtime
// execution). Mirror that polyfill so the permission path works in tests.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * OCC-126 (self-acceptance security discovery — NOT an official-version port).
 *
 * These ten read-only text utilities were listed in READONLY_COMMANDS
 * (readOnlyValidation.ts) — so `BashTool.isReadOnly()` returned true and the
 * permission pipeline auto-allowed them at the read-only step — but they were
 * ABSENT from PATH_EXTRACTORS / COMMAND_OPERATION_TYPE. Because
 * `checkPathConstraints` (step 3 of `bashToolCheckPermission`) only validates
 * commands present in SUPPORTED_PATH_COMMANDS, an unrecognized command fell
 * straight through to `passthrough`, and the later read-only auto-allow (step
 * 7) then approved it WITHOUT a prompt — even when the file argument pointed
 * OUTSIDE the session's working directories.
 *
 * Concrete bypass (pre-fix): `fmt /etc/passwd` (or `tac`, `rev`, `fold`,
 * `expand`, `unexpand`, `comm`, `cmp`, `pr`, `tsort` on an outside path)
 * silently exfiltrated a file the user never approved a read for — the exact
 * guarantee `cat`/`head`/`tail` already enforce. The fix wires all ten into
 * PATH_EXTRACTORS (→ `filterOutFlags`, mirroring cat/head/tail) and
 * COMMAND_OPERATION_TYPE (→ `'read'`), so an outside-workdir argument now
 * returns `behavior: 'ask'` with the per-command ACTION_VERB message, while an
 * in-workdir argument still passes through (no false-positive prompt).
 *
 * `numfmt`/`readlink`/`realpath`/`basename`/`dirname` are deliberately EXCLUDED
 * (kept read-only-auto-allow only): their primary arguments are numbers or
 * command names, not file paths, so path-extracting them would false-positive
 * (e.g. `readlink -f /usr/bin/python` prompting on a binary that is not a
 * document read). See the SECURITY note in pathValidation.ts.
 */

const READ_ONLY_TEXTUTILS = [
  'tac',
  'rev',
  'fold',
  'expand',
  'unexpand',
  'fmt',
  'comm',
  'cmp',
  'pr',
  'tsort',
] as const

function makeContext(workdir?: string): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    additionalWorkingDirectories: new Map(
      workdir !== undefined
        ? [[workdir, { path: workdir, source: 'userSettings' as const }]]
        : [],
    ),
  }
}

describe('OCC-126 read-only text utils — registered as path-validated READ ops', () => {
  test('all ten are present in PATH_EXTRACTORS', () => {
    for (const cmd of READ_ONLY_TEXTUTILS) {
      expect(typeof PATH_EXTRACTORS[cmd]).toBe('function')
    }
  })

  test('all ten are classified as read operations (COMMAND_OPERATION_TYPE)', () => {
    for (const cmd of READ_ONLY_TEXTUTILS) {
      expect(COMMAND_OPERATION_TYPE[cmd]).toBe('read')
    }
  })

  test('PATH_EXTRACTORS uses filterOutFlags — drops flags, keeps file args', () => {
    // Single-file utilities: flag dropped, path kept.
    expect(PATH_EXTRACTORS.fmt(['-s', '/x/file.txt'])).toEqual(['/x/file.txt'])
    expect(PATH_EXTRACTORS.tac(['/x/a', '/x/b'])).toEqual(['/x/a', '/x/b'])
    // Two-file compare utilities keep both operands.
    expect(PATH_EXTRACTORS.cmp(['/x/a', '/x/b'])).toEqual(['/x/a', '/x/b'])
    expect(PATH_EXTRACTORS.comm(['-12', '/x/a', '/x/b'])).toEqual([
      '/x/a',
      '/x/b',
    ])
    // `--` ends flag filtering; later `-`-prefixed tokens are kept as paths.
    expect(PATH_EXTRACTORS.pr(['--', '-weird'])).toEqual(['-weird'])
  })
})

describe('OCC-126 checkPathConstraints — outside-workdir read now ASKS (was silent auto-allow)', () => {
  test('reading a file OUTSIDE the working dirs prompts for every util', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-ro126-wd-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'occ-ro126-out-'))
    try {
      const secret = join(outsideDir, 'secret.txt')
      for (const cmd of READ_ONLY_TEXTUTILS) {
        const r = checkPathConstraints(
          // comm/cmp take two operands; a single outside arg is enough to trip
          // the path check, and keeps the command shape uniform across utils.
          { command: `${cmd} ${secret}` } as never,
          workdir,
          makeContext(workdir),
          false,
          [],
        )
        expect(r.behavior).toBe('ask')
        // The block message names the command and cites the working-dir boundary.
        expect((r as { message?: string }).message).toContain('was blocked')
        expect((r as { message?: string }).message).toContain(
          'the allowed working directories',
        )
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('reading a file INSIDE the working dir passes through (no false positive)', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-ro126-wd-'))
    try {
      const inFile = join(workdir, 'notes.txt')
      for (const cmd of READ_ONLY_TEXTUTILS) {
        const r = checkPathConstraints(
          { command: `${cmd} ${inFile}` } as never,
          workdir,
          makeContext(workdir),
          false,
          [],
        )
        expect(r.behavior).toBe('passthrough')
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  test('a path-prefixed invocation (/usr/bin/fmt) is still validated', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-ro126-wd-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'occ-ro126-out-'))
    try {
      const r = checkPathConstraints(
        { command: `/usr/bin/fmt ${join(outsideDir, 'secret.txt')}` } as never,
        workdir,
        makeContext(workdir),
        false,
        [],
      )
      // Canonicalization is not applied to these (only tee/rm/rmdir), so the
      // path-prefixed form is an UNKNOWN command and falls through to
      // passthrough here. At the pipeline level it is ALSO not read-only
      // auto-allowed: the READONLY regexes are `^cmd`-anchored, so
      // `/usr/bin/fmt` does not match isReadOnly and instead falls to the
      // step-8 prompt ("requires approval"). Fail-closed, identical to
      // `/usr/bin/cat`. This assertion documents that boundary so a future
      // canonicalization change is caught.
      expect(r.behavior).toBe('passthrough')
    } finally {
      rmSync(workdir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
