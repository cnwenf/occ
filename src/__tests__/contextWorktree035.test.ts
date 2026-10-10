import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOriginalCwd, setOriginalCwd } from '../bootstrap/state.js'
import { getGitStatusForWorktree } from '../context.js'
import { clearResolveGitDirCache } from '../utils/git/gitFilesystem.js'

/**
 * Official 2.1.295 #035: "Fixed subagents in their own linked worktree being
 * shown the parent session's git branch, status and recent commits."
 *
 * Binary mechanism (v295 git-status builder `dQn` @215537428): when the agent
 * cwd is a LINKED worktree of the session repo —
 *   Ge.gitDir!==Ge.commonDir && Ge.commonDir===Fe.commonDir && Ge.gitDir!==Fe.gitDir
 * — status/log/user.name run with {cwd: agentCwd} and the branch comes from
 * sse(pin.gitDir) (the worktree's OWN HEAD file), with detached → "HEAD".
 * Otherwise S stays null and the global (parent-session) path is used.
 *
 * These tests use REAL temporary git repositories (git init + git worktree
 * add) — no mocks — so the linked-worktree detection runs against genuine
 * .git-file / commondir structures.
 */

let savedOriginalCwd: string
const tempDirs: string[] = []

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeMainRepo(): string {
  const dir = makeTempDir('occ035-main-')
  git(['init', '-b', 'main'], dir)
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(['add', '.'], dir)
  git(
    [
      '-c',
      'user.name=OccTest',
      '-c',
      'user.email=occ@test.local',
      'commit',
      '-m',
      'base commit 035',
    ],
    dir,
  )
  // Parent-session dirty file — must NOT leak into the worktree status
  writeFileSync(join(dir, 'parent-dirty.txt'), 'parent dirty\n')
  return dir
}

function addLinkedWorktree(mainRepo: string, name: string, branch: string): string {
  const wt = join(mainRepo, '..', `${name}-wt`)
  tempDirs.push(wt)
  git(['worktree', 'add', '-b', branch, wt], mainRepo)
  return wt
}

beforeAll(() => {
  savedOriginalCwd = getOriginalCwd()
})

afterAll(() => {
  setOriginalCwd(savedOriginalCwd)
  clearResolveGitDirCache()
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('CC 2.1.295 #035: getGitStatusForWorktree', () => {
  test('linked worktree: shows the worktree branch, worktree dirty files and worktree commits — not the parent session snapshot', async () => {
    // Arrange — main repo on `main` with a parent-only dirty file; linked
    // worktree on `feature-x` with its own commit and its own dirty file
    const mainRepo = makeMainRepo()
    const wt = addLinkedWorktree(mainRepo, 'occ035-pos', 'feature-x')
    writeFileSync(join(wt, 'wt-file.txt'), 'wt\n')
    git(['add', 'wt-file.txt'], wt)
    git(
      [
        '-c',
        'user.name=OccTest',
        '-c',
        'user.email=occ@test.local',
        'commit',
        '-m',
        'worktree commit 035',
      ],
      wt,
    )
    writeFileSync(join(wt, 'wt-uncommitted.txt'), 'wt uncommitted\n')
    setOriginalCwd(mainRepo)
    clearResolveGitDirCache()

    // Act
    const result = await getGitStatusForWorktree(wt)

    // Assert — branch from the worktree's own HEAD (binary: sse(pin.gitDir))
    expect(result).not.toBeNull()
    expect(result!).toContain('Current branch: feature-x')
    // status ran with cwd=worktree (binary: it(Mt(),[...lQn],{cwd:S.cwd,...}))
    expect(result!).toContain('wt-uncommitted.txt')
    expect(result!).not.toContain('parent-dirty.txt')
    // log ran in the worktree — its own commit is present
    expect(result!).toContain('worktree commit 035')
    // shared message tail (binary: identical POe truncation + join)
    expect(result!).toContain(
      'This is the git status at the start of the conversation.',
    )
  })

  test('detached-HEAD linked worktree: branch renders as "HEAD" (binary: Te?.type==="branch"?Te.name:"HEAD")', async () => {
    // Arrange
    const mainRepo = makeMainRepo()
    const wt = join(mainRepo, '..', 'occ035-detached-wt')
    tempDirs.push(wt)
    git(['worktree', 'add', '--detach', wt, 'HEAD'], mainRepo)
    setOriginalCwd(mainRepo)
    clearResolveGitDirCache()

    // Act
    const result = await getGitStatusForWorktree(wt)

    // Assert
    expect(result).not.toBeNull()
    expect(result!).toContain('Current branch: HEAD')
  })

  test('same repo main checkout (gitDir === main gitDir): returns null so the caller keeps the global path', async () => {
    // Arrange — binary condition requires Ge.gitDir!==Fe.gitDir
    const mainRepo = makeMainRepo()
    setOriginalCwd(mainRepo)
    clearResolveGitDirCache()

    // Act
    const result = await getGitStatusForWorktree(mainRepo)

    // Assert
    expect(result).toBeNull()
  })

  test('unrelated repository (commonDir mismatch): returns null (binary: Ge.commonDir===Fe.commonDir)', async () => {
    // Arrange — two fully independent repos
    const mainRepo = makeMainRepo()
    const otherRepo = makeMainRepo()
    setOriginalCwd(mainRepo)
    clearResolveGitDirCache()

    // Act
    const result = await getGitStatusForWorktree(otherRepo)

    // Assert
    expect(result).toBeNull()
  })

  test('non-git directory: returns null (binary: Re===null → git_status_skipped_not_git)', async () => {
    // Arrange
    const mainRepo = makeMainRepo()
    const plainDir = makeTempDir('occ035-plain-')
    setOriginalCwd(mainRepo)
    clearResolveGitDirCache()

    // Act
    const result = await getGitStatusForWorktree(plainDir)

    // Assert
    expect(result).toBeNull()
  })
})
