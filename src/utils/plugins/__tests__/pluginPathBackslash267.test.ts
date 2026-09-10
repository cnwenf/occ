import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { validatePathWithinBase } from '../pluginInstallationHelpers.js'

/**
 * CC 2.1.267 security fix (changelog #8, Gap-121b): marketplace/plugin entry
 * paths containing a backslash could bypass the lexical containment check on
 * macOS/Linux — POSIX resolve() treats '\' as a literal filename character,
 * so 'foo\..\..\evil' resolves INSIDE the base directory textually, while
 * downstream consumers (e.g. `git sparse-checkout set --cone` in the subdir
 * install path) normalize backslashes cross-platform and escape.
 *
 * Official fix adds `M()!=="windows"&&n.includes("\\")` to the
 * suspicious-path predicate (v267 `tue`; the v266 `FCe` lacked the clause).
 * OCC mirrors it at the single containment choke point
 * `validatePathWithinBase`, which every plugin component path flows through
 * (pluginInstallationHelpers.ts:461, pluginLoader.ts copyDir + rename).
 *
 * Byte evidence: forensics/scratch (OCC-121, v267 linux-x64 ELF).
 */

const BASE = join('/tmp', 'occ-121b-base')

describe('2.1.267: backslash containment guard (Gap-121b)', () => {
  test('rejects a relative path containing a backslash on non-Windows', () => {
    // Arrange — this path resolves textually inside BASE on POSIX, so ONLY
    // the new backslash clause can stop it.
    const relativePath = 'plugins\\..\\..\\evil.md'

    // Act / Assert
    expect(() => validatePathWithinBase(BASE, relativePath)).toThrow(
      'Path traversal detected: "plugins\\..\\..\\evil.md" would escape the base directory',
    )
  })

  test('rejects even a single literal backslash with no traversal intent', () => {
    // The official predicate is unconditional on backslash presence for
    // non-Windows — it does not try to decide whether the backslash is
    // "harmless". Mirror that: fail closed.
    expect(() => validatePathWithinBase(BASE, 'my\\plugin.md')).toThrow(
      /Path traversal detected/,
    )
  })

  test('rejects a leading-backslash absolute-style path', () => {
    expect(() => validatePathWithinBase(BASE, '\\etc\\passwd')).toThrow(
      /Path traversal detected/,
    )
  })

  test('still accepts a clean POSIX relative path', () => {
    // Act
    const resolved = validatePathWithinBase(BASE, './commands/hello.md')

    // Assert
    expect(resolved).toBe(join(BASE, 'commands/hello.md'))
  })

  test('still rejects dot-dot traversal without backslashes (pre-existing guard)', () => {
    expect(() => validatePathWithinBase(BASE, './../evil.md')).toThrow(
      /Path traversal detected/,
    )
  })

  test('guard is platform-scoped: only active when not win32', () => {
    // Sanity: the guard mirrors official `M()!=="windows"`. On this (POSIX)
    // test host process.platform !== 'win32', so backslashes are rejected —
    // asserted above. This test documents that Windows behavior is
    // intentionally unchanged (backslashes are legitimate separators there
    // and the lexical containment check still applies).
    expect(process.platform).not.toBe('win32')
  })
})
