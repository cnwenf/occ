/**
 * CC 2.1.296 #050 — Git-Bash/Cygwin drive-letter translation for the
 * dangerous-removal analyzer (official `zwr`/`qpt`/`qwr`/`Xun`/`wwe` block,
 * v296 ELF md5 3c8749470f70a26efadf982b587e1548 @218709361 + qpt @207109251).
 *
 * Changelog entry 50: "Windows: Fixed `rm -rf /c/Users/<name>` in Git Bash
 * not asking in bypass permissions mode." The translation half: v295 tested
 * only the raw POSIX-ish form against the critical-path predicate, so the
 * Git-Bash home form never matched on Windows; v296 translates `/c/…`,
 * `\c\…`, `/cygdrive/c/…` and UNC device forms (`\\?\C:\…`,
 * `\\localhost\C$\…`) to `C:\…` and re-tests (official `Xun(e,n)` shape:
 * original first, translated second, never both when the original matches).
 *
 * getPlatform is memoized and gitBashPaths.js binds it at import, so the
 * platform module is mocked BEFORE importing the module under test and
 * restored in afterAll (convention + leakage hazard documented in
 * fileToolMacosKernelPaths281.test.ts / ripgrepUnreadableWindows292.test.ts).
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const actualPlatformModule = { ...(await import('../../platform.js')) }
let platformMockActive = true
mock.module('../../platform.js', () => ({
  ...actualPlatformModule,
  getPlatform: () =>
    platformMockActive ? 'windows' : actualPlatformModule.getPlatform(),
}))

const {
  translateGitBashPathToWindows,
  checkWithGitBashTranslation,
  isDangerousRemovalPathWindowsAware,
} = await import('../gitBashPaths.js')

afterAll(() => {
  platformMockActive = false
  mock.module('../../platform.js', () => ({ ...actualPlatformModule }))
})

describe('2.1.296 #050: translateGitBashPathToWindows (official qwr)', () => {
  test('translates /c/Users/name to C:\\Users\\name (changelog form)', () => {
    expect(translateGitBashPathToWindows('/c/Users/name')).toBe(
      'C:\\Users\\name',
    )
  })

  test('translates the /cygdrive/d/… form', () => {
    expect(translateGitBashPathToWindows('/cygdrive/d/x/y')).toBe('D:\\x\\y')
  })

  test('translates backslash-form \\c\\foo (official zwr [\\\\/] class)', () => {
    expect(translateGitBashPathToWindows('\\c\\foo')).toBe('C:\\foo')
  })

  test('bare drive /c maps to C:\\ (empty rest → single backslash)', () => {
    expect(translateGitBashPathToWindows('/c')).toBe('C:\\')
    expect(translateGitBashPathToWindows('/cygdrive/c')).toBe('C:\\')
  })

  test('uppercases a lowercase drive letter', () => {
    expect(translateGitBashPathToWindows('/d/x')).toBe('D:\\x')
  })

  test('flips forward slashes in the tail to backslashes', () => {
    expect(translateGitBashPathToWindows('/c/Users/x/proj dir')).toBe(
      'C:\\Users\\x\\proj dir',
    )
  })

  test('normalizes UNC device paths first (official qpt pre-step)', () => {
    // \\?\C:\x → C:\x and \\localhost\C$\x → C:\x; qpt's output is returned
    // WITHOUT the drive-letter step (official `if(n!==e)return n`).
    expect(translateGitBashPathToWindows('\\\\?\\C:\\x')).toBe('C:\\x')
    expect(translateGitBashPathToWindows('\\\\localhost\\C$\\x')).toBe('C:\\x')
  })

  test('returns undefined for non-drive-letter paths (no slash-flip fallback)', () => {
    // Unlike posixPathToWindowsPath, qwr ONLY translates the matched forms:
    // '/usr' has a multi-char first segment (zwr lookahead fails), 'C:\x' is
    // already Windows form, '' and 'relative/x' have no leading separator.
    expect(translateGitBashPathToWindows('/usr')).toBeUndefined()
    expect(translateGitBashPathToWindows('C:\\x')).toBeUndefined()
    expect(translateGitBashPathToWindows('relative/x')).toBeUndefined()
    expect(translateGitBashPathToWindows('')).toBeUndefined()
  })

  test('non-windows platforms never translate (official O() guard)', () => {
    platformMockActive = false
    try {
      expect(translateGitBashPathToWindows('/c/Users/name')).toBeUndefined()
    } finally {
      platformMockActive = true
    }
  })
})

describe('2.1.296 #050: checkWithGitBashTranslation (official Xun)', () => {
  test('short-circuits on the original form without translating', () => {
    const seen: string[] = []
    const result = checkWithGitBashTranslation('/usr', candidate => {
      seen.push(candidate)
      return true
    })
    expect(result).toBe(true)
    expect(seen).toEqual(['/usr'])
  })

  test('re-tests the translated form when the original misses', () => {
    const seen: string[] = []
    const result = checkWithGitBashTranslation('/c/Users', candidate => {
      seen.push(candidate)
      return candidate === 'C:\\Users'
    })
    expect(result).toBe(true)
    expect(seen).toEqual(['/c/Users', 'C:\\Users'])
  })

  test('returns false when neither form matches', () => {
    expect(
      checkWithGitBashTranslation('/tmp/x', () => false),
    ).toBe(false)
  })
})

describe('2.1.296 #050: isDangerousRemovalPathWindowsAware (official wwe)', () => {
  test('windows: Git-Bash drive forms reach the critical-path predicate', () => {
    // '/c' → 'C:\' → drive-root arm; '/c/Users' → 'C:\Users' → drive-child
    // arm; '/cygdrive/c/Windows' → 'C:\Windows' → drive-child arm.
    expect(isDangerousRemovalPathWindowsAware('/c')).toBe(true)
    expect(isDangerousRemovalPathWindowsAware('/c/Users')).toBe(true)
    expect(isDangerousRemovalPathWindowsAware('/cygdrive/c/Windows')).toBe(true)
  })

  test('windows: already-Windows critical forms still match (original arm)', () => {
    expect(isDangerousRemovalPathWindowsAware('C:\\Users')).toBe(true)
    expect(isDangerousRemovalPathWindowsAware('C:\\')).toBe(true)
  })

  test('windows: benign Git-Bash paths stay false', () => {
    expect(isDangerousRemovalPathWindowsAware('/c/Users/name/proj')).toBe(false)
    expect(isDangerousRemovalPathWindowsAware('/d/work/tmp')).toBe(false)
  })

  test('linux: behavior is exactly the untranslated predicate', () => {
    platformMockActive = false
    try {
      expect(isDangerousRemovalPathWindowsAware('/usr')).toBe(true)
      expect(isDangerousRemovalPathWindowsAware('/tmp/x')).toBe(false)
      // On linux the Git-Bash form is just an ordinary absolute path —
      // '/c/Users' has parent '/c' ≠ '/' so it is NOT dangerous here.
      expect(isDangerousRemovalPathWindowsAware('/c/Users')).toBe(false)
    } finally {
      platformMockActive = true
    }
  })
})
