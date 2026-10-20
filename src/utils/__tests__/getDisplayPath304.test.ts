/**
 * CC 2.1.304 (changelog #17) — getDisplayPath unit tests.
 *
 * Official fix `Fo` (docs/gap-research-304/research-R5-cli-ux.md item #17):
 * a file outside the working directory must render as `~/…` or the full path
 * instead of `../../…`, and a path containing a NUL byte renders as
 * `Path hidden (unsupported characters)` (the literal exists in BOTH the
 * official 303 and 304 binaries; 304 adds its usage). `getDisplayPath`
 * (src/utils/file.ts) is OCC's equivalent helper — WP6 switched the naive
 * `relative(getCwd(), …)` display sites (FileWriteTool/UI, the FileEdit /
 * NotebookEdit rejected-edit messages, NotebookEditToolDiff) onto it and added
 * the NUL guard. This suite pins all four branches.
 *
 * Deterministic without module mocks: `runWithCwdOverride` pins getCwd() to a
 * FAKE_CWD that is NOT under the real home directory, so home paths exercise
 * the `~/…` branch rather than the inside-cwd branch. getDisplayPath does pure
 * path math (no fs access), so the referenced paths need not exist.
 */
import { describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join, sep } from 'path'
import { runWithCwdOverride } from '../cwd.js'
import { getDisplayPath } from '../file.js'

// getDisplayPath's transitive deps can read MACRO.VERSION at import time;
// mirror the cli.tsx polyfill like the other file/fs test suites.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// A cwd that is NOT under the real home dir, so $HOME paths fall into the
// `~/…` branch instead of the inside-cwd branch.
const FAKE_CWD = `${sep}tmp${sep}occ-getdisplaypath-304${sep}proj`

describe('CC 2.1.304 #17 getDisplayPath (official Fo)', () => {
  test('path inside cwd renders as a relative path (no ../../)', () => {
    // Arrange
    const inside = join(FAKE_CWD, 'src', 'foo.ts')

    // Act
    const out = runWithCwdOverride(FAKE_CWD, () => getDisplayPath(inside))

    // Assert
    expect(out).toBe(join('src', 'foo.ts'))
    expect(out.startsWith('..')).toBe(false)
  })

  test('path under $HOME but outside cwd renders with ~/… notation', () => {
    // Arrange
    const homePath = join(homedir(), 'occ-docs-304', 'report.pdf')

    // Act
    const out = runWithCwdOverride(FAKE_CWD, () => getDisplayPath(homePath))

    // Assert
    expect(out).toBe(`~${sep}occ-docs-304${sep}report.pdf`)
    expect(out.startsWith('..')).toBe(false)
  })

  test('path outside cwd and home renders as the full absolute path', () => {
    // Arrange
    const outside = `${sep}etc${sep}hosts`

    // Act
    const out = runWithCwdOverride(FAKE_CWD, () => getDisplayPath(outside))

    // Assert
    expect(out).toBe(outside)
  })

  test('path containing a NUL byte renders as the hidden placeholder', () => {
    // Arrange — expandPath() would THROW on a NUL byte; the guard must run
    // first so the placeholder is returned instead of an exception.
    const nulPath = `${sep}home${sep}testuser${sep}bad\0name.txt`

    // Act
    const out = runWithCwdOverride(FAKE_CWD, () => getDisplayPath(nulPath))

    // Assert
    expect(out).toBe('Path hidden (unsupported characters)')
  })
})
