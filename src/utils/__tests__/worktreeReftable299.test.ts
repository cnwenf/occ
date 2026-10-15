/**
 * CC 2.1.299 #113 — `--worktree` sessions leave folders in `.git/worktrees`
 * under reftable ref storage.
 *
 * Official fix (v299 @221341800, `Kt`): under reftable, registration state
 * lives in the reftable tables — hand-deleting worktree ref files corrupts
 * them. The official drops the stale registration ONLY via git-native means
 * (`git worktree remove` / `git worktree prune`) after verifying the anchor is
 * really beneath `worktrees/<id>` and the repo really uses reftable.
 *
 * OCC port: OCC's cleanup is already git-native (`git worktree remove
 * --force`), so nothing hand-deletes ref files. The gap is that under reftable
 * a successful `remove` can still leave a stale `.git/worktrees/<id>`
 * registration behind (the official bug's exact surface). Fix: detect reftable
 * (`.git/reftable/` exists beneath the common dir) and follow the remove with
 * `git worktree prune` so git itself drops the stale registration whole.
 * Classic ref-storage repos are untouched (no extra prune, unchanged behavior).
 */
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const {
  isReftableGitDir,
  getReftableCommonDir,
  pruneWorktreesIfReftable,
} = await import('../worktree.js')

const tmpDirs: string[] = []

function makeFakeRepo(opts: { reftable: boolean; gitDirFileName?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'occ-reftable-'))
  tmpDirs.push(root)
  const gitDir = join(root, '.git')
  mkdirSync(gitDir, { recursive: true })
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true })
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  if (opts.reftable) {
    mkdirSync(join(gitDir, 'reftable'), { recursive: true })
    writeFileSync(join(gitDir, 'reftable', 'tables.list'), '')
  }
  return root
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('CC 2.1.299 #113: reftable detection', () => {
  test('isReftableGitDir returns true when <commonDir>/reftable is a directory', () => {
    // Arrange
    const root = makeFakeRepo({ reftable: true })

    // Act / Assert
    expect(isReftableGitDir(join(root, '.git'))).toBe(true)
  })

  test('isReftableGitDir returns false for a classic ref-storage git dir', () => {
    // Arrange
    const root = makeFakeRepo({ reftable: false })

    // Act / Assert
    expect(isReftableGitDir(join(root, '.git'))).toBe(false)
  })

  test('isReftableGitDir returns false for a nonexistent path', () => {
    expect(isReftableGitDir('/nonexistent/occ-reftable-test/.git')).toBe(false)
  })

  test('getReftableCommonDir resolves the common dir of a reftable repo', async () => {
    // Arrange
    const root = makeFakeRepo({ reftable: true })

    // Act
    const commonDir = await getReftableCommonDir(root)

    // Assert
    expect(commonDir).not.toBeNull()
    expect(commonDir!.endsWith('.git')).toBe(true)
  })

  test('getReftableCommonDir returns null for a classic repo (unchanged behavior)', async () => {
    // Arrange
    const root = makeFakeRepo({ reftable: false })

    // Act / Assert
    expect(await getReftableCommonDir(root)).toBeNull()
  })
})

describe('CC 2.1.299 #113: reftable-safe cleanup prune', () => {
  test('reftable layout: prune runs git-native `git worktree prune` (spy), never hand-deletes', async () => {
    // Arrange — fake repo whose common dir uses reftable.
    const root = makeFakeRepo({ reftable: true })
    const execCalls: Array<{ args: string[]; cwd?: string }> = []
    const fakeExec = ((_file: string, args: string[], opts?: { cwd?: string }) => {
      execCalls.push({ args, cwd: opts?.cwd })
      return Promise.resolve({ stdout: '', stderr: '', code: 0 })
    }) as never

    // Act
    const pruned = await pruneWorktreesIfReftable(root, fakeExec)

    // Assert — reftable-safe branch taken: exactly one git-native prune call;
    // the registration files still exist on disk (nothing hand-deleted).
    expect(pruned).toBe(true)
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]!.args).toEqual(['worktree', 'prune'])
    expect(isReftableGitDir(join(root, '.git'))).toBe(true)
  })

  test('classic layout: no prune is issued (behavior unchanged)', async () => {
    // Arrange
    const root = makeFakeRepo({ reftable: false })
    const execCalls: Array<{ args: string[] }> = []
    const fakeExec = ((_file: string, args: string[]) => {
      execCalls.push({ args })
      return Promise.resolve({ stdout: '', stderr: '', code: 0 })
    }) as never

    // Act
    const pruned = await pruneWorktreesIfReftable(root, fakeExec)

    // Assert
    expect(pruned).toBe(false)
    expect(execCalls).toHaveLength(0)
  })
})
