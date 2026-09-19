import { describe, expect, test } from 'bun:test'

// ripgrep.ts transitively reads MACRO.VERSION; mirror the cli.tsx polyfill.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { RipgrepSpawnResourceError } = await import('../ripgrep.js')

/** Build an ExecFileException-shaped spawn failure (code + syscall). */
function spawnError(code: unknown, syscall = 'spawn rg'): Error {
  const err = new Error(`spawn rg failed (${String(code)})`) as Error & {
    code?: unknown
    syscall?: unknown
  }
  err.code = code
  err.syscall = syscall
  return err
}

const PREFIX =
  'ripgrep could not start, so nothing was searched and matches may still exist: the operating system could not start it because '

/**
 * CC 2.1.278 (B1) — Grep/Glob reported "no matches" when ripgrep could not
 * START (EAGAIN/ENOMEM/EMFILE/ENFILE on the spawn syscall). Ported from the
 * official `Mu`/`XQ`/`zQ`/`c2`/`E` chain; the reason/advice strings below are
 * byte-copied from the v278 ELF. `from()` gates on rejectOnInputError so the
 * Glob/@-file callers (which intentionally pass none) keep their `[]` semantics.
 */
describe('2.1.278 B1 — RipgrepSpawnResourceError', () => {
  describe('constructor messages (byte-exact errno→reason+advice map)', () => {
    test('EAGAIN', () => {
      expect(new RipgrepSpawnResourceError('EAGAIN').message).toBe(
        `${PREFIX}a limit on processes or threads was reached (EAGAIN). Retry in a moment. If it keeps failing, tell the user that this machine has reached a limit on processes; closing other programs can help.`,
      )
    })

    test('ENOMEM', () => {
      expect(new RipgrepSpawnResourceError('ENOMEM').message).toBe(
        `${PREFIX}there is not enough memory (ENOMEM). Retry in a moment. If it keeps failing, tell the user that this machine is short of memory; closing other programs can help.`,
      )
    })

    test('EMFILE', () => {
      expect(new RipgrepSpawnResourceError('EMFILE').message).toBe(
        `${PREFIX}this Claude Code process has too many files open (EMFILE). Retry in a moment. If it keeps failing, tell the user that Claude Code needs a restart.`,
      )
    })

    test('ENFILE', () => {
      expect(new RipgrepSpawnResourceError('ENFILE').message).toBe(
        `${PREFIX}the system has too many files open (ENFILE). Retry in a moment. If it keeps failing, tell the user that this machine has too many files open; closing other programs can help.`,
      )
    })

    test('unknown errno falls back to the generic resource text (zQ)', () => {
      expect(new RipgrepSpawnResourceError('ESRCH').message).toBe(
        `${PREFIX}the system ran out of a resource (ESRCH). Retry in a moment. If it keeps failing, tell the user that this machine is short of a resource needed to start programs.`,
      )
    })

    test('carries the byte-exact error name', () => {
      expect(new RipgrepSpawnResourceError('EAGAIN').name).toBe(
        'RipgrepSpawnResourceError',
      )
    })
  })

  describe('from() detection gate', () => {
    test('returns an error for a resource errno on a spawn syscall when rejectOnInputError is true', () => {
      const result = RipgrepSpawnResourceError.from(spawnError('EAGAIN'), true)
      expect(result).toBeInstanceOf(RipgrepSpawnResourceError)
      expect(result?.message).toContain('(EAGAIN)')
    })

    test('accepts the bare "spawn" syscall prefix', () => {
      expect(
        RipgrepSpawnResourceError.from(spawnError('ENOMEM', 'spawn'), true),
      ).toBeInstanceOf(RipgrepSpawnResourceError)
    })

    test('returns undefined when rejectOnInputError is false (Glob/@-file semantics)', () => {
      expect(RipgrepSpawnResourceError.from(spawnError('EAGAIN'), false)).toBeUndefined()
    })

    test('returns undefined when rejectOnInputError is omitted', () => {
      expect(RipgrepSpawnResourceError.from(spawnError('EAGAIN'), undefined)).toBeUndefined()
    })

    test('returns undefined for a resource errno on a NON-spawn syscall', () => {
      expect(
        RipgrepSpawnResourceError.from(spawnError('EAGAIN', 'read'), true),
      ).toBeUndefined()
    })

    test('returns undefined for a non-resource errno (ENOENT) even on spawn', () => {
      expect(
        RipgrepSpawnResourceError.from(spawnError('ENOENT'), true),
      ).toBeUndefined()
    })

    test('returns undefined when code is numeric (extractErrnoCode requires a string)', () => {
      expect(RipgrepSpawnResourceError.from(spawnError(11), true)).toBeUndefined()
    })

    test('returns undefined when the error carries no code', () => {
      const err = new Error('no code') as Error & { syscall?: string }
      err.syscall = 'spawn rg'
      expect(RipgrepSpawnResourceError.from(err, true)).toBeUndefined()
    })

    test('returns undefined for a non-object throw', () => {
      expect(RipgrepSpawnResourceError.from('EAGAIN', true)).toBeUndefined()
      expect(RipgrepSpawnResourceError.from(null, true)).toBeUndefined()
      expect(RipgrepSpawnResourceError.from(undefined, true)).toBeUndefined()
    })
  })
})
