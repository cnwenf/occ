import { describe, expect, test } from 'bun:test'
import { checkWorktreeGitRedirect } from '../worktreeGitRedirectGuard.js'

/**
 * CC 2.1.274 S2 — behavioral evidence for the official changelog entry
 * "Fixed worktree-isolated sessions accepting Bash commands with certain
 * nested shell expansions; these are now refused".
 *
 * Verdict: NO-OP for OCC — the 2.1.216 #8 guard (`isDynamicTarget` fails
 * closed on `$`, backtick, `$(`, `~`, plus the eval/source/bash -c/stdin-fed
 * wrapper blocks) already refuses every nested-expansion vector probed
 * against the official 274 delta. Forensics:
 * docs/upstream-version-gap-occ127.md Part II.
 *
 * Fixture constants mirror worktreeGitRedirectGuard.test.ts.
 */

const WORKTREE = '/tmp/wt'
const CWD = '/tmp/wt'
const SHARED = '/tmp/main'

describe('2.1.274 S2: nested shell expansions in worktree git redirects → refused', () => {
  test('git -C $(echo <shared>) → block (dynamic target)', () => {
    const b = checkWorktreeGitRedirect(
      `git -C $(echo ${SHARED}) status`,
      WORKTREE,
      CWD,
    )
    expect(b).not.toBeNull()
    expect(b!.mechanism).toBe('-C')
  })

  test('git -C "$(pwd)/../main" (quoted expansion) → block', () => {
    const b = checkWorktreeGitRedirect(
      'git -C "$(pwd)/../main" status',
      WORKTREE,
      CWD,
    )
    expect(b).not.toBeNull()
    expect(b!.mechanism).toBe('-C')
  })

  test('git -C $(echo $(pwd)) (NESTED expansion — the 274 vector) → block', () => {
    const b = checkWorktreeGitRedirect(
      'git -C $(echo $(pwd)) status',
      WORKTREE,
      CWD,
    )
    expect(b).not.toBeNull()
    expect(b!.mechanism).toBe('-C')
  })

  test('git --git-dir=$(pwd)/../.git → block', () => {
    const b = checkWorktreeGitRedirect(
      'git --git-dir=$(pwd)/../.git status',
      WORKTREE,
      CWD,
    )
    expect(b).not.toBeNull()
    expect(b!.mechanism).toBe('--git-dir')
  })

  test('backtick form git -C `pwd` → block', () => {
    const b = checkWorktreeGitRedirect('git -C `pwd` status', WORKTREE, CWD)
    expect(b).not.toBeNull()
  })

  test('eval-wrapped redirect → block (eval wrapper)', () => {
    const b = checkWorktreeGitRedirect(
      `eval "git -C ${SHARED} status"`,
      WORKTREE,
      CWD,
    )
    expect(b).not.toBeNull()
  })

  test('bash -c wrapped redirect → block (wrapper command)', () => {
    const b = checkWorktreeGitRedirect(
      `bash -c "git -C ${SHARED} status"`,
      WORKTREE,
      CWD,
    )
    expect(b).not.toBeNull()
  })

  test('direct shared-checkout redirect (no expansion) → block', () => {
    const b = checkWorktreeGitRedirect(
      `git -C ${SHARED} status`,
      WORKTREE,
      CWD,
    )
    expect(b).not.toBeNull()
    expect(b!.mechanism).toBe('-C')
  })

  test('plain git status inside the worktree → allowed (no false positive)', () => {
    expect(checkWorktreeGitRedirect('git status', WORKTREE, CWD)).toBeNull()
  })

  test('git -C <inside worktree> → allowed (no false positive)', () => {
    expect(
      checkWorktreeGitRedirect(`git -C ${WORKTREE}/sub status`, WORKTREE, CWD),
    ).toBeNull()
  })
})
