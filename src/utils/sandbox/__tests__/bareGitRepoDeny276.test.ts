import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  computeBareGitRepoDenyPaths,
  scrubPlantedBareGitRepoPaths,
} from '../sandbox-adapter.js'

/**
 * 2.1.276 ITEM L — sandboxed commands could not write to project
 * directories named `hooks/` or `config/`.
 *
 * Pre-fix OCC denied ANY existing hooks/config entry unconditionally (the
 * official v274 bug) and additionally queued absent hooks/config for
 * rmSync-recursive post-command scrubbing (an OCC-specific data-loss risk).
 * v276 gates the deny on positive bare-repo evidence and never scrubs
 * absent hooks/config. Fixtures here are real temp dirs — no mocks.
 */

const fixtureRoots: string[] = []

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-bare-git-276-'))
  fixtureRoots.push(dir)
  return dir
}

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('2.1.276 ITEM L — computeBareGitRepoDenyPaths', () => {
  test('plain hooks/ and config/ project dirs are NOT denied (the changelog fix)', () => {
    // Arrange
    const dir = makeFixtureDir()
    mkdirSync(join(dir, 'hooks'))
    mkdirSync(join(dir, 'config'))

    // Act
    const result = computeBareGitRepoDenyPaths([dir])

    // Assert
    expect(result.denyWrite).not.toContain(join(dir, 'hooks'))
    expect(result.denyWrite).not.toContain(join(dir, 'config'))
    expect(result.denyWrite).not.toContain(join(dir, 'config.lock'))
  })

  test('HEAD + objects + refs markers are all denied', () => {
    // Arrange
    const dir = makeFixtureDir()
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(dir, 'objects'))
    mkdirSync(join(dir, 'refs'))

    // Act
    const result = computeBareGitRepoDenyPaths([dir])

    // Assert
    expect(result.denyWrite).toContain(join(dir, 'HEAD'))
    expect(result.denyWrite).toContain(join(dir, 'objects'))
    expect(result.denyWrite).toContain(join(dir, 'refs'))
    // Present markers never queue for scrubbing
    expect(result.scrubPaths).not.toContain(join(dir, 'HEAD'))
    expect(result.scrubPaths).not.toContain(join(dir, 'objects'))
    expect(result.scrubPaths).not.toContain(join(dir, 'refs'))
  })

  test('a present HEAD marker also denies plain hooks/ and config/ dirs', () => {
    // Arrange — bare-repo evidence gates the ordinary dirs back to denied
    const dir = makeFixtureDir()
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(dir, 'hooks'))
    mkdirSync(join(dir, 'config'))

    // Act
    const result = computeBareGitRepoDenyPaths([dir])

    // Assert
    expect(result.denyWrite).toContain(join(dir, 'hooks'))
    expect(result.denyWrite).toContain(join(dir, 'config'))
  })

  test('a broken HEAD symlink into refs/ counts as bare-repo evidence', () => {
    // Arrange — real bare repos can carry HEAD → refs/... symlinks
    const dir = makeFixtureDir()
    symlinkSync('refs/heads/main', join(dir, 'HEAD'))
    mkdirSync(join(dir, 'hooks'))

    // Act
    const result = computeBareGitRepoDenyPaths([dir])

    // Assert: statSync(HEAD) throws (broken link) → scrub-queued, but the
    // refs/ symlink target still gates hooks/ to denied.
    expect(result.scrubPaths).toContain(join(dir, 'HEAD'))
    expect(result.denyWrite).toContain(join(dir, 'hooks'))
  })

  test('a config FILE denies config and config.lock', () => {
    // Arrange — a real git config file is bare-repo evidence on its own
    const dir = makeFixtureDir()
    writeFileSync(join(dir, 'config'), '[core]\n')

    // Act
    const result = computeBareGitRepoDenyPaths([dir])

    // Assert
    expect(result.denyWrite).toContain(join(dir, 'config'))
    expect(result.denyWrite).toContain(join(dir, 'config.lock'))
  })

  test('hooks/ containing a .git dir denies only hooks/.git, not hooks itself', () => {
    // Arrange — a nested checkout inside hooks/ stays writable except .git
    const dir = makeFixtureDir()
    mkdirSync(join(dir, 'hooks', '.git'), { recursive: true })

    // Act
    const result = computeBareGitRepoDenyPaths([dir])

    // Assert
    expect(result.denyWrite).toContain(join(dir, 'hooks', '.git'))
    expect(result.denyWrite).not.toContain(join(dir, 'hooks'))
  })

  test('absent hooks/config are NOT queued for scrubbing', () => {
    // Arrange — the pre-fix data-loss risk: absent hooks/config were
    // scrub-queued and rmSync-recursive'd if the command created them
    const dir = makeFixtureDir()

    // Act
    const result = computeBareGitRepoDenyPaths([dir])

    // Assert
    expect(result.scrubPaths).not.toContain(join(dir, 'hooks'))
    expect(result.scrubPaths).not.toContain(join(dir, 'config'))
    // Absent markers + absent .git are still scrub-queued (plant defense)
    expect(result.scrubPaths).toContain(join(dir, 'HEAD'))
    expect(result.scrubPaths).toContain(join(dir, 'objects'))
    expect(result.scrubPaths).toContain(join(dir, 'refs'))
    expect(result.scrubPaths).toContain(join(dir, '.git'))
  })

  test('scans every directory when cwd differs from originalCwd', () => {
    // Arrange
    const dirA = makeFixtureDir()
    const dirB = makeFixtureDir()
    writeFileSync(join(dirA, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(dirB, 'config'), '[core]\n')

    // Act
    const result = computeBareGitRepoDenyPaths([dirA, dirB])

    // Assert
    expect(result.denyWrite).toContain(join(dirA, 'HEAD'))
    expect(result.denyWrite).not.toContain(join(dirA, 'config'))
    expect(result.denyWrite).toContain(join(dirB, 'config'))
    expect(result.denyWrite).toContain(join(dirB, 'config.lock'))
    expect(result.denyWrite).not.toContain(join(dirB, 'HEAD'))
  })
})

describe('2.1.276 ITEM L — scrubPlantedBareGitRepoPaths', () => {
  test('a non-empty hooks/ dir created after config time is NOT deleted', () => {
    // Arrange — config-time scan saw no hooks/; the "command" then creates
    // a real hooks dir with content
    const dir = makeFixtureDir()
    const result = computeBareGitRepoDenyPaths([dir])
    mkdirSync(join(dir, 'hooks'))
    writeFileSync(join(dir, 'hooks', 'pre-commit'), '#!/bin/sh\n')

    // Act
    scrubPlantedBareGitRepoPaths(result.scrubPaths)

    // Assert — hooks was never scrub-queued, so the scrub cannot touch it
    expect(existsSync(join(dir, 'hooks', 'pre-commit'))).toBe(true)
  })

  test('a planted empty .git dir is scrubbed', () => {
    // Arrange
    const dir = makeFixtureDir()
    const result = computeBareGitRepoDenyPaths([dir])
    expect(result.scrubPaths).toContain(join(dir, '.git'))
    mkdirSync(join(dir, '.git'))

    // Act
    scrubPlantedBareGitRepoPaths(result.scrubPaths)

    // Assert
    expect(existsSync(join(dir, '.git'))).toBe(false)
  })

  test('a planted NON-empty .git dir is left in place (never recursive)', () => {
    // Arrange
    const dir = makeFixtureDir()
    const result = computeBareGitRepoDenyPaths([dir])
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'config'), '[core]\n')

    // Act
    scrubPlantedBareGitRepoPaths(result.scrubPaths)

    // Assert
    expect(existsSync(join(dir, '.git', 'config'))).toBe(true)
  })

  test('a planted HEAD file is scrubbed; a planted non-empty objects/ dir is not', () => {
    // Arrange
    const dir = makeFixtureDir()
    const result = computeBareGitRepoDenyPaths([dir])
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(dir, 'objects', 'pack'), { recursive: true })
    writeFileSync(join(dir, 'objects', 'pack', 'x.idx'), 'data')

    // Act
    scrubPlantedBareGitRepoPaths(result.scrubPaths)

    // Assert — plain file removed; non-empty dir survives (hardened vs
    // official kWt, which rmSync-recursive's planted objects/refs)
    expect(existsSync(join(dir, 'HEAD'))).toBe(false)
    expect(existsSync(join(dir, 'objects', 'pack', 'x.idx'))).toBe(true)
  })

  test('a planted EMPTY objects/ dir is scrubbed', () => {
    // Arrange
    const dir = makeFixtureDir()
    const result = computeBareGitRepoDenyPaths([dir])
    mkdirSync(join(dir, 'objects'))

    // Act
    scrubPlantedBareGitRepoPaths(result.scrubPaths)

    // Assert
    expect(existsSync(join(dir, 'objects'))).toBe(false)
  })

  test('scrubbing absent paths is a silent no-op', () => {
    // Arrange
    const dir = makeFixtureDir()
    const result = computeBareGitRepoDenyPaths([dir])

    // Act — nothing was planted; must not throw
    expect(() => scrubPlantedBareGitRepoPaths(result.scrubPaths)).not.toThrow()

    // Assert
    expect(existsSync(join(dir, 'HEAD'))).toBe(false)
  })
})
