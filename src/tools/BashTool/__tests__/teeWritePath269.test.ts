import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import {
  canonicalizePathCommandName,
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
 * Official Claude Code 2.1.269 (OCC-123 E43): `tee` became a path-validated
 * WRITE command. Binary v269 evidence:
 *
 * ```js
 * var vHo=new Set(["/dev/null","/dev/stdout","/dev/stderr","/dev/tty"]);
 * function EHo(e){return e.filter((n)=>!vHo.has(n))}
 * // PATH_EXTRACTORS:  tee:(e)=>EHo(py(e))   (py = filterOutFlags)
 * // ACTION_VERBS:     tee:"write to files in"
 * // operation type:   tee:"write"
 * var LHo=new Set(["rm","rmdir","tee"]);
 * function jU(e){if(!e)return e;let n=e.replace(/^.*[\\/]/,"");
 *   if(LHo.has(n))return n;
 *   return n.toLowerCase().replace(/\.exe$/,"")==="tee"?"tee":e}
 * ```
 *
 * `jU` canonicalization runs BEFORE the path-command lookup, so
 * `/usr/bin/tee`, `tee.exe`, `TEE.EXE` all validate as `tee`. Device sinks
 * are filtered out — `tee /dev/null` extracts ZERO paths and hits the
 * generic empty-paths passthrough (`Path validation passed for tee command`,
 * byte-identical to binary OHo's tee-specific string).
 */

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

describe('2.1.269 E43 canonicalizePathCommandName (binary jU)', () => {
  test('path-prefixed tee/rm/rmdir canonicalize to basename', () => {
    expect(canonicalizePathCommandName('/usr/bin/tee')).toBe('tee')
    expect(canonicalizePathCommandName('C:\\bin\\tee')).toBe('tee')
    expect(canonicalizePathCommandName('/bin/rm')).toBe('rm')
    expect(canonicalizePathCommandName('/usr/sbin/rmdir')).toBe('rmdir')
  })

  test('tee.exe / TEE.EXE canonicalize to tee (case-insensitive, .exe stripped)', () => {
    expect(canonicalizePathCommandName('tee.exe')).toBe('tee')
    expect(canonicalizePathCommandName('TEE.EXE')).toBe('tee')
    expect(canonicalizePathCommandName('C:\\bin\\Tee.exe')).toBe('tee')
  })

  test('non-canonical commands are returned unchanged (not basename-stripped)', () => {
    expect(canonicalizePathCommandName('cat')).toBe('cat')
    expect(canonicalizePathCommandName('/usr/bin/cat')).toBe('/usr/bin/cat')
    expect(canonicalizePathCommandName('rm.exe')).toBe('rm.exe')
    expect(canonicalizePathCommandName(undefined)).toBeUndefined()
  })
})

describe('2.1.269 E43 PATH_EXTRACTORS.tee — device sinks filtered (binary EHo)', () => {
  test('real destinations survive, device sinks drop', () => {
    expect(PATH_EXTRACTORS.tee(['-a', 'out.txt', '/dev/null'])).toEqual([
      'out.txt',
    ])
  })

  test('device-only invocation extracts zero paths', () => {
    expect(PATH_EXTRACTORS.tee(['/dev/null'])).toEqual([])
    expect(PATH_EXTRACTORS.tee(['-a', '/dev/stdout', '/dev/stderr'])).toEqual(
      [],
    )
  })

  test('all four official device paths are filtered; lookalikes are not', () => {
    expect(
      PATH_EXTRACTORS.tee([
        '/dev/null',
        '/dev/stdout',
        '/dev/stderr',
        '/dev/tty',
        '/dev/random',
        'null',
      ]),
    ).toEqual(['/dev/random', 'null'])
  })

  test('tee is a WRITE operation (COMMAND_OPERATION_TYPE)', () => {
    expect(COMMAND_OPERATION_TYPE.tee).toBe('write')
  })
})

describe('2.1.269 E43 checkPathConstraints — tee device passthrough', () => {
  test('tee /dev/null (device-only) passes through', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-tee269-wd-'))
    try {
      const r = checkPathConstraints(
        { command: 'echo hi | tee /dev/null' } as never,
        workdir,
        makeContext(workdir),
        false,
        [],
      )
      // checkPathConstraints aggregates per-command passthroughs into its
      // summary message (the per-command `Path validation passed for tee
      // command` string — binary OHo — is only observable when the tee
      // command is validated in isolation).
      expect(r.behavior).toBe('passthrough')
      expect((r as { message?: string }).message).toBe(
        'All path commands validated successfully',
      )
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  test('tee to a real file is a WRITE — default mode asks, acceptEdits in-workdir passes', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-tee269-wd-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'occ-tee269-out-'))
    try {
      const target = join(workdir, 'out.txt')
      const command = { command: `echo hi | tee ${target}` } as never

      // Default mode: a write-classified path command needs permission —
      // this is the point of the official v269 change (tee was previously
      // invisible to path validation).
      const defaultResult = checkPathConstraints(
        command,
        workdir,
        makeContext(workdir),
        false,
        [],
      )
      expect(defaultResult.behavior).toBe('ask')

      // acceptEdits mode: in-working-dir write auto-allows.
      const acceptResult = checkPathConstraints(
        command,
        workdir,
        { ...makeContext(workdir), mode: 'acceptEdits' },
        false,
        [],
      )
      expect(acceptResult.behavior).toBe('passthrough')
      expect((acceptResult as { message?: string }).message).toBe(
        'All path commands validated successfully',
      )

      // acceptEdits mode, target OUTSIDE the working dirs: still blocked,
      // with the official tee ACTION_VERB — "write to files in" (binary v269:
      // `tee:"write to files in"`).
      const outsideResult = checkPathConstraints(
        { command: `echo hi | tee ${join(outsideDir, 'x.txt')}` } as never,
        workdir,
        { ...makeContext(workdir), mode: 'acceptEdits' },
        false,
        [],
      )
      expect(outsideResult.behavior).toBe('ask')
      expect((outsideResult as { message?: string }).message).toContain(
        'may only write to files in',
      )
    } finally {
      rmSync(workdir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('path-prefixed /usr/bin/tee is validated as tee (canonicalization wired)', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-tee269-wd-'))
    try {
      const r = checkPathConstraints(
        { command: 'echo hi | /usr/bin/tee /dev/null' } as never,
        workdir,
        makeContext(workdir),
        false,
        [],
      )
      expect(r.behavior).toBe('passthrough')
      expect((r as { message?: string }).message).toBe(
        'All path commands validated successfully',
      )
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
