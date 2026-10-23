/**
 * Official Claude Code 2.1.309 changelog item 20 — branch detection reports a
 * `not_a_repo` sentinel for a folder that is not a git repository, so the
 * remote-control status line never renders the literal `HEAD` for a non-repo.
 *
 * Source of truth: BIN309 branch-detection sentinel `not_a_repo` @121672596,
 * adjacent to `--abbrev-ref` @121672618 / `default_branch` / `push_remote` /
 * `visibility_cache` (byte-verified; binary never executed). Official `zl`
 * (@258128100) returns `y("not_a_repo")` (branch null) when the path is not a
 * repo, distinct from a detached HEAD which still reports `HEAD`.
 *
 * OCC pre-fix bug: `computeBranch` (gitFilesystem.ts) returned the literal
 * 'HEAD' for a non-repo, and the bridge status line renders any truthy string,
 * so a non-git folder showed "HEAD". Fix: detection returns NOT_A_REPO_BRANCH;
 * the public getBranch translates the sentinel to '' (renderers omit it).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  NOT_A_REPO_BRANCH,
  deriveBranch,
  isNotARepoBranch,
  readGitHead,
  resolveGitDir,
  toPublicBranch,
} from '../gitFilesystem.js'

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

describe('item 20 — not_a_repo sentinel', () => {
  test('sentinel is the byte-verbatim official string', () => {
    expect(NOT_A_REPO_BRANCH).toBe('not_a_repo')
  })

  test('isNotARepoBranch recognizes only the sentinel', () => {
    expect(isNotARepoBranch('not_a_repo')).toBe(true)
    expect(isNotARepoBranch('HEAD')).toBe(false)
    expect(isNotARepoBranch('main')).toBe(false)
    expect(isNotARepoBranch('')).toBe(false)
    expect(isNotARepoBranch(null)).toBe(false)
    expect(isNotARepoBranch(undefined)).toBe(false)
  })

  test('toPublicBranch maps the sentinel to empty, leaves real values', () => {
    expect(toPublicBranch('not_a_repo')).toBe('')
    expect(toPublicBranch('HEAD')).toBe('HEAD')
    expect(toPublicBranch('main')).toBe('main')
    expect(toPublicBranch('')).toBe('')
  })
})

describe('item 20 — deriveBranch decision (pure seam)', () => {
  test('null gitDir (not a repo) → sentinel, NOT HEAD', () => {
    expect(deriveBranch(null, null)).toBe(NOT_A_REPO_BRANCH)
  })

  test('repo with unreadable/unborn HEAD → HEAD', () => {
    expect(deriveBranch('/x/.git', null)).toBe('HEAD')
  })

  test('repo on a branch → branch name', () => {
    expect(deriveBranch('/x/.git', { type: 'branch', name: 'feature' })).toBe(
      'feature',
    )
  })

  test('repo detached HEAD → HEAD', () => {
    expect(deriveBranch('/x/.git', { type: 'detached', sha: 'abc123' })).toBe(
      'HEAD',
    )
  })
})

describe('item 20 — fs-backed regression (real non-git cwd)', () => {
  test('a non-git folder resolves to null gitDir → public branch is empty', async () => {
    const dir = makeTempDir('occ-notrepo-')
    const gitDir = await resolveGitDir(dir)
    expect(gitDir).toBeNull()
    const head = gitDir ? await readGitHead(gitDir) : null
    const branch = deriveBranch(gitDir, head)
    expect(branch).toBe(NOT_A_REPO_BRANCH)
    // The observable fix: the status line renders nothing (empty), not 'HEAD'.
    expect(toPublicBranch(branch)).toBe('')
  })

  test('a real git repo on a branch reports the branch name (not the sentinel)', async () => {
    const dir = makeTempDir('occ-repo-')
    const init = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
    if (init.status !== 0) {
      // git unavailable in this environment — skip without failing.
      return
    }
    const gitDir = await resolveGitDir(dir)
    expect(gitDir).not.toBeNull()
    const head = gitDir ? await readGitHead(gitDir) : null
    const branch = deriveBranch(gitDir, head)
    expect(isNotARepoBranch(branch)).toBe(false)
    expect(branch).not.toBe('HEAD')
    expect(branch.length).toBeGreaterThan(0)
  })
})
