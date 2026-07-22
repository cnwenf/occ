import { describe, expect, test } from 'bun:test'
import { checkWorktreeGitRedirect } from '../worktreeGitRedirectGuard.js'

/**
 * CC 2.1.216 #8: worktree-isolated subagents must not redirect git into the
 * shared/parent checkout (isolation escape) via `git -C` / `--git-dir` /
 * `--work-tree` / `GIT_DIR` / `GIT_WORK_TREE` / `--bare`.
 *
 * Reverse-engineered from the 2.1.216/2.1.217 ELF per `aligning-with-official-
 * binary`. OCC did not have this guard — a real divergence, now ported.
 */

const WORKTREE = '/tmp/wt'
const CWD = '/tmp/wt'
const SHARED = '/tmp/main'

describe('CC 2.1.216 #8 — worktree git-redirect guard', () => {
  describe('blocks redirects to the shared checkout (outside the worktree)', () => {
    test('git -C <shared> -> block', () => {
      const b = checkWorktreeGitRedirect(`git -C ${SHARED} status`, WORKTREE, CWD)
      expect(b).not.toBeNull()
      expect(b!.mechanism).toBe('-C')
      expect(b!.reason).toContain('shared checkout')
      expect(b!.reason).toContain('cannot verify')
    })

    test('git --git-dir <shared> -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git --git-dir ${SHARED}/.git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('--git-dir')
    })

    test('git --git-dir=<shared> (equals form) -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git --git-dir=${SHARED}/.git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('--git-dir')
    })

    test('git --work-tree <shared> -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git --work-tree ${SHARED} status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('--work-tree')
    })

    test('GIT_DIR=<shared> env-prefix -> block', () => {
      const b = checkWorktreeGitRedirect(
        `GIT_DIR=${SHARED}/.git git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_DIR')
    })

    test('GIT_WORK_TREE=<shared> env-prefix -> block', () => {
      const b = checkWorktreeGitRedirect(
        `GIT_WORK_TREE=${SHARED} git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_WORK_TREE')
    })

    test('redirect on the 2nd arm of an && list -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git -C ${WORKTREE} status && git -C ${SHARED} log`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('-C')
      expect(b!.reason).toContain('shared checkout')
    })
  })

  describe('blocks unverifiable targets', () => {
    test('glob target -> glob reason', () => {
      const b = checkWorktreeGitRedirect(
        `git -C ${SHARED}/* status`,
        WORKTREE,
        CWD,
      )
      expect(b).not.toBeNull()
      expect(b!.reason).toContain('glob pattern that expands at runtime')
      expect(b!.reason).toContain('spell out the literal path')
    })

    test('dynamic target ($VAR) -> computed-at-runtime reason', () => {
      const b = checkWorktreeGitRedirect(`git -C $HOME status`, WORKTREE, CWD)
      expect(b).not.toBeNull()
      expect(b!.reason).toContain('computed at runtime')
    })

    test('tilde target -> computed-at-runtime reason', () => {
      const b = checkWorktreeGitRedirect(`git -C ~/repo status`, WORKTREE, CWD)
      expect(b).not.toBeNull()
      expect(b!.reason).toContain('computed at runtime')
    })

    test('--bare -> unverifiable (no worktree to bound against)', () => {
      const b = checkWorktreeGitRedirect(`git --bare`, WORKTREE, CWD)
      expect(b!.mechanism).toBe('--bare')
      expect(b!.reason).toContain('cannot verify')
    })
  })

  describe('allows safe commands', () => {
    test('git -C <worktree-subdir> -> ok (inside the worktree)', () => {
      expect(
        checkWorktreeGitRedirect(`git -C ${WORKTREE}/sub status`, WORKTREE, CWD),
      ).toBeNull()
    })

    test('git -C <worktree itself> -> ok', () => {
      expect(
        checkWorktreeGitRedirect(`git -C ${WORKTREE} status`, WORKTREE, CWD),
      ).toBeNull()
    })

    test('plain git status (no redirect) -> ok', () => {
      expect(checkWorktreeGitRedirect('git status', WORKTREE, CWD)).toBeNull()
    })

    test('relative target inside worktree -> ok', () => {
      // cwd is the worktree; a relative subdir resolves inside it.
      expect(
        checkWorktreeGitRedirect('git -C ./sub status', WORKTREE, CWD),
      ).toBeNull()
    })

    test('non-git command -> ok (not guarded)', () => {
      expect(checkWorktreeGitRedirect(`ls ${SHARED}`, WORKTREE, CWD)).toBeNull()
    })

    test('non-git -C (e.g. grep -C) -> ok (not a git redirect)', () => {
      expect(
        checkWorktreeGitRedirect(`grep -C 2 pattern ${SHARED}`, WORKTREE, CWD),
      ).toBeNull()
    })
  })
})
