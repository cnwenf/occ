import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import {
  CwdDeletedError,
  cwdMissingMessage,
  recoverCwdDeletedAtTurnStart,
  resetCwdTurnRecoveryForTesting,
  toCwdDeletedError,
} from '../cwdTurnRecovery.js'

/**
 * CC 2.1.281 changelog #028 — headless cwd-deleted recovery.
 * Byte-verified against the v281 ELF @215939600-215941150:
 * - `h6t` MissingWorkingDirectoryError / `sVn(e)` @206503737 message
 *   ("working directory no longer exists or is not accessible: <path>")
 * - `bh(e,r)` recovery: re-pin (`r.setCwd(e.path)`), warn line
 *   "[headless] working directory <path> no longer exists; the turn starts
 *   pinned to it" (markers v280=0 / v281=2), once-per-session
 *   `tengu_shell_set_cwd {success:false,missing_at_turn:true}` (official
 *   `axn` per-session pinned store), session-once user-visible warning
 *   "The session's working directory <path> no longer exists; shell commands
 *   cannot start there and relative file paths that use it will fail until
 *   it is restored."
 */
const MISSING_CWD = '/tmp/occ-cwd-deleted-281-test-dir'
const SESSION_KEY = 'test-session-cwd-281'

function warningMessage(path: string): string {
  return `The session's working directory ${path} no longer exists; shell commands cannot start there and relative file paths that use it will fail until it is restored.`
}

describe('2.1.281 #028 — CwdDeletedError + detection', () => {
  test('CwdDeletedError carries the official sVn message and the path', () => {
    // Act
    const error = new CwdDeletedError('/gone/dir')

    // Assert
    expect(error.message).toBe(
      'working directory no longer exists or is not accessible: /gone/dir',
    )
    expect(error.name).toBe('CwdDeletedError')
    expect(error.path).toBe('/gone/dir')
    expect(error).toBeInstanceOf(Error)
  })

  test('cwdMissingMessage matches official sVn @206503737 byte-for-byte', () => {
    // Assert
    expect(cwdMissingMessage('/x')).toBe(
      'working directory no longer exists or is not accessible: /x',
    )
  })

  test('toCwdDeletedError converts Shell.setCwd\'s `Path "<p>" does not exist` throw', () => {
    // Arrange — utils/Shell.ts:496 throws exactly this on realpath ENOENT
    const raw = new Error(`Path "${MISSING_CWD}" does not exist`)

    // Act
    const converted = toCwdDeletedError(raw, MISSING_CWD)

    // Assert
    expect(converted).toBeInstanceOf(CwdDeletedError)
    expect(converted!.path).toBe(MISSING_CWD)
    expect(converted!.cause).toBe(raw)
  })

  test('toCwdDeletedError passes CwdDeletedError through and rejects unrelated errors', () => {
    // Arrange
    const already = new CwdDeletedError(MISSING_CWD)

    // Assert
    expect(toCwdDeletedError(already, MISSING_CWD)).toBe(already)
    // a different path or a different error must NOT be treated as missing cwd
    expect(toCwdDeletedError(new Error('boom'), MISSING_CWD)).toBeNull()
    expect(
      toCwdDeletedError(
        new Error(`Path "${MISSING_CWD}" does not exist`),
        '/other/dir',
      ),
    ).toBeNull()
    expect(toCwdDeletedError('not-an-error', MISSING_CWD)).toBeNull()
  })
})

describe('2.1.281 #028 — recoverCwdDeletedAtTurnStart (binary bh)', () => {
  const savedCwd = getCwdState()

  beforeEach(() => {
    resetCwdTurnRecoveryForTesting()
  })

  afterEach(() => {
    // restore the module-level cwd so later test files see the original
    setCwdState(savedCwd)
    resetCwdTurnRecoveryForTesting()
  })

  test('re-pins the missing cwd via the state setter and returns the warning', () => {
    // Arrange
    setCwdState('/tmp')
    const error = new CwdDeletedError(MISSING_CWD)

    // Act
    const warning = recoverCwdDeletedAtTurnStart(error, SESSION_KEY)

    // Assert — re-pinned to the (missing) path so later tools report
    // consistently; warning text byte-matches the official template.
    expect(getCwdState()).toBe(MISSING_CWD)
    expect(warning).toBe(warningMessage(MISSING_CWD))
  })

  test('fires the user-visible warning ONCE per session (official axn pinned flag)', () => {
    // Arrange
    const error = new CwdDeletedError(MISSING_CWD)

    // Act
    const first = recoverCwdDeletedAtTurnStart(error, SESSION_KEY)
    const second = recoverCwdDeletedAtTurnStart(error, SESSION_KEY)

    // Assert — later turns of the SAME session get null (no repeat warning);
    // the re-pin + warn log still happen every turn (verified via getCwdState).
    expect(first).toBe(warningMessage(MISSING_CWD))
    expect(second).toBeNull()
    expect(getCwdState()).toBe(MISSING_CWD)
  })

  test('warns once per DISTINCT session (flag persists per session key)', () => {
    // Arrange
    const error = new CwdDeletedError(MISSING_CWD)

    // Act
    const sessionA = recoverCwdDeletedAtTurnStart(error, 'session-a')
    const sessionB = recoverCwdDeletedAtTurnStart(error, 'session-b')

    // Assert
    expect(sessionA).toBe(warningMessage(MISSING_CWD))
    expect(sessionB).toBe(warningMessage(MISSING_CWD))
  })

  test('does not throw when analytics are unavailable (official try/catch around logEvent)', () => {
    // Arrange
    const error = new CwdDeletedError(MISSING_CWD)

    // Act + Assert — OCC's analytics stub is a no-op; recovery must complete.
    expect(() =>
      recoverCwdDeletedAtTurnStart(error, 'analytics-session'),
    ).not.toThrow()
  })
})
