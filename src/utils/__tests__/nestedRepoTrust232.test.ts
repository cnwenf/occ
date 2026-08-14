import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _setGlobalConfigCacheForTesting,
  isPathTrusted,
  resetTrustDialogAcceptedCacheForTesting,
} from '../config.js'
import type { GlobalConfig } from '../config.js'

/**
 * 2.1.232 alignment — nested git repositories no longer inherit trust
 * from a trusted parent directory; each repository requires its own trust
 * confirmation (official bed/ved/v8e, bounded ancestor walk). These tests
 * exercise isPathTrusted against REAL tmpdir filesystems so the git-root
 * probes (findGitRootUncached / isGitRootForTrust) see actual .git dirs.
 *
 * Same NODE_ENV/cache-injection harness as trust.test.ts.
 */
function withTrustedProjects<T>(
  projects: Record<string, { hasTrustDialogAccepted?: boolean }>,
  fn: () => T,
): T {
  const savedEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const config: GlobalConfig = {
    projects,
  } as unknown as GlobalConfig
  _setGlobalConfigCacheForTesting(config)
  resetTrustDialogAcceptedCacheForTesting()
  try {
    return fn()
  } finally {
    _setGlobalConfigCacheForTesting(null)
    resetTrustDialogAcceptedCacheForTesting()
    process.env.NODE_ENV = savedEnv
  }
}

describe('2.1.232 — nested-repo trust boundary', () => {
  const tmpRoots: string[] = []

  const makeRoot = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tmpRoots.push(dir)
    return dir
  }
  const makeRepo = (dir: string): void => {
    mkdirSync(join(dir, '.git'), { recursive: true })
  }

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('nested repo does NOT inherit trust from its parent repo', () => {
    // Arrange: parent repo trusted; nested repo has its own .git
    const parent = makeRoot('occ-trust-parent-')
    const nested = join(parent, 'nested')
    makeRepo(parent)
    makeRepo(nested)

    // Act + Assert
    expect(
      withTrustedProjects(
        { [parent]: { hasTrustDialogAccepted: true } },
        () => isPathTrusted(nested),
      ),
    ).toBe(false)
  })

  test('same-repo child directory still inherits trust', () => {
    // Arrange: no .git in the child — same repository, walk may continue
    const parent = makeRoot('occ-trust-same-')
    const child = join(parent, 'packages', 'app')
    makeRepo(parent)
    mkdirSync(child, { recursive: true })

    // Act + Assert
    expect(
      withTrustedProjects(
        { [parent]: { hasTrustDialogAccepted: true } },
        () => isPathTrusted(child),
      ),
    ).toBe(true)
  })

  test('nested repo with its own trust entry is trusted', () => {
    // Arrange
    const parent = makeRoot('occ-trust-own-')
    const nested = join(parent, 'nested')
    makeRepo(parent)
    makeRepo(nested)

    // Act + Assert
    expect(
      withTrustedProjects(
        { [nested]: { hasTrustDialogAccepted: true } },
        () => isPathTrusted(nested),
      ),
    ).toBe(true)
  })

  test('non-git directory keeps the unbounded ancestor walk', () => {
    // Arrange: no .git anywhere → boundary is null → walk is unbounded
    const grand = makeRoot('occ-trust-nogit-')
    const deep = join(grand, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })

    // Act + Assert
    expect(
      withTrustedProjects(
        { [grand]: { hasTrustDialogAccepted: true } },
        () => isPathTrusted(deep),
      ),
    ).toBe(true)
  })

  test('symlinked .git is not a repo boundary (walk continues upward)', () => {
    // Arrange: OCC rejects symlinked .git as a root outright (stricter
    // subset of the official nXc symlink validation), so the nested dir has
    // no boundary of its own and inherits from the real parent repo.
    const parent = makeRoot('occ-trust-link-')
    const nested = join(parent, 'nested')
    makeRepo(parent)
    mkdirSync(nested, { recursive: true })
    symlinkSync(join(parent, '.git'), join(nested, '.git'))

    // Act + Assert
    expect(
      withTrustedProjects(
        { [parent]: { hasTrustDialogAccepted: true } },
        () => isPathTrusted(nested),
      ),
    ).toBe(true)
  })

  test('advisoryNoFsProbe walk ignores repo boundaries entirely', () => {
    // Arrange: nested repo present, but the advisory path must not probe fs
    const parent = makeRoot('occ-trust-adv-')
    const nested = join(parent, 'nested')
    makeRepo(parent)
    makeRepo(nested)

    // Act + Assert
    expect(
      withTrustedProjects(
        { [parent]: { hasTrustDialogAccepted: true } },
        () => isPathTrusted(nested, { advisoryNoFsProbe: true }),
      ),
    ).toBe(true)
  })
})
