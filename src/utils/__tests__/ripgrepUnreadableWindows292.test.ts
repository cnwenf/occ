/**
 * CC 2.1.292 (C1) — RipgrepTargetUnreadableError WINDOWS errno mapping.
 *
 * Companion to ripgrepUnreadable292.test.ts (which covers the live posix/linux
 * mapping + the dispatch throw site). The zB constructor reads getPlatform() to
 * pick the permission class and the reason arm (byte-verified @208892821):
 *
 *   r = O()==="windows"
 *   n = r ? e===Ite(5) : e===Tte(13)||e===vte(1)         // permission class
 *   s = n ? "permission denied"
 *       : !r && e===_te(5) ? "input/output error"
 *       : !r && e===QB(2)  ? "the file Claude Code opened was not passed to ripgrep"
 *       : "an operating system error"
 *
 * So on WINDOWS the permission class is errno 5 (ERROR_ACCESS_DENIED) ONLY, and
 * the `!r &&` guards mean the posix input/output-error (5) and fd-not-passed (2)
 * arms NEVER render — 1/2/3/13 all fall through to "an operating system error".
 *
 * getPlatform is memoized and ripgrep.js binds it at import, so the platform
 * module is mocked BEFORE importing ripgrep.js and restored in afterAll
 * (convention + leakage hazard documented in fileToolMacosKernelPaths281.test.ts:
 * an unrestored platform stub leaks into every later suite in the worker).
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const actualPlatformModule = { ...(await import('../platform.js')) }
let platformMockActive = true
mock.module('../platform.js', () => ({
  ...actualPlatformModule,
  getPlatform: () => (platformMockActive ? 'windows' : actualPlatformModule.getPlatform()),
}))

const { RipgrepTargetUnreadableError } = await import('../ripgrep.js')

afterAll(() => {
  platformMockActive = false
  mock.module('../platform.js', () => ({ ...actualPlatformModule }))
})

const GUIDANCE =
  'Do not run a recursive search in the shell instead (for example grep -r, find or rg)'
const NOT_NO_MATCHES = 'This is not a "no matches" result.'
const PERMISSION_TAIL = `Tell the user that the path could not be read. ${GUIDANCE}.`
const RETRY_TAIL = `Run the search once more. If it fails again, tell the user that the search is failing. ${GUIDANCE}: it can also reach other files, which this tool is set to leave out.`

describe('2.1.292 C1 — RipgrepTargetUnreadableError taxonomy (windows)', () => {
  test('ERROR_ACCESS_DENIED (5) → permission denied class (windows n = e===Ite)', () => {
    const err = new RipgrepTargetUnreadableError(5)
    expect(err.name).toBe('RipgrepTargetUnreadableError')
    expect(err.message).toContain('(permission denied, os error 5)')
    expect(err.message).toContain(NOT_NO_MATCHES)
    expect(err.message).toContain(PERMISSION_TAIL)
  })

  test('errno 13 (posix EACCES) is NOT permission on windows → an operating system error', () => {
    const err = new RipgrepTargetUnreadableError(13)
    expect(err.message).toContain('(an operating system error, os error 13)')
    expect(err.message).toContain(RETRY_TAIL)
    expect(err.message).not.toContain('permission denied')
  })

  test('errno 1 (posix EPERM) is NOT permission on windows → an operating system error', () => {
    const err = new RipgrepTargetUnreadableError(1)
    expect(err.message).toContain('(an operating system error, os error 1)')
  })

  test('errno 2 on windows → an operating system error (the !r guard blocks the fd-not-passed arm)', () => {
    const err = new RipgrepTargetUnreadableError(2)
    expect(err.message).toContain('(an operating system error, os error 2)')
    expect(err.message).not.toContain('not passed to ripgrep')
  })

  test('errno 3 (ERROR_PATH_NOT_FOUND) → an operating system error', () => {
    const err = new RipgrepTargetUnreadableError(3)
    expect(err.message).toContain('(an operating system error, os error 3)')
  })
})
