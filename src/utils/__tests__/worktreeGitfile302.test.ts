/**
 * Official Claude Code 2.1.302 #23 — worktree isolation under git ≥2.56 with a
 * stray `.git` FILE pointing at a nonexistent directory.
 *
 * Git ≥2.56 emits `fatal: gitfile does not point to a valid repository` when a
 * `.git` FILE's gitdir target doesn't exist. Official v301 classified that
 * stderr as "error" → worktree create/resume refused. Official v302 extended
 * the shared no-repo predicate (v301 `GWt` → v302 `pGt` @243939195):
 *
 *   function pGt(e){return/not a git repository/i.test(e)||/gitfile does not point to a valid repository/i.test(e)}
 *
 * so BOTH messages classify as "no-repo" → the worktree feature treats the
 * directory as not-a-repo (graceful decline) instead of a hard refusal.
 *
 * This machine's git is 2.43 (<2.56) and emits the OLD message for the stray
 * gitfile, so the integration test captures the REAL stderr and asserts only
 * the classification mapping — and both canonical messages are asserted
 * against the classifier directly, making the suite git-version-robust.
 *
 * Integration tests run real git in temp dirs (same pattern as
 * worktreeCreateErrors299.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import {
  classifyRevParseCause,
  isNoRepoGitStderr,
} from '../git/worktreeBaseResolve.js'
import { gitExe } from '../git.js'
import { getOrCreateWorktree } from '../worktree.js'

// The two canonical stderr texts (byte-exact git output for a `.git` FILE
// whose gitdir target doesn't exist):
// - git <2.56 (e.g. 2.43 on this machine): "not a git repository"
// - git ≥2.56: "gitfile does not point to a valid repository"
const GITFILE_STDERR_NEW_GIT =
  'fatal: gitfile does not point to a valid repository: /nonexistent/path'
const GITFILE_STDERR_OLD_GIT =
  'fatal: not a git repository: /nonexistent/path'
const UNRELATED_STDERR =
  'fatal: ambiguous argument "HEAD~99": unknown revision or path not in the working tree.'

const tmpDirs: string[] = []

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
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

/** Temp dir containing ONLY a stray `.git` FILE → nonexistent gitdir. */
function makeStrayGitfileDir(prefix: string): string {
  const dir = makeTmpDir(prefix)
  writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/path\n', 'utf-8')
  return dir
}

describe('2.1.302 #23: isNoRepoGitStderr (official v302 `pGt` predicate)', () => {
  test('git ≥2.56 stray-gitfile message is no-repo', () => {
    expect(isNoRepoGitStderr(GITFILE_STDERR_NEW_GIT)).toBe(true)
  })

  test('git <2.56 stray-gitfile message is no-repo (same class)', () => {
    expect(isNoRepoGitStderr(GITFILE_STDERR_OLD_GIT)).toBe(true)
  })

  test('matching is case-insensitive, like the official /i regexes', () => {
    expect(
      isNoRepoGitStderr('FATAL: GITFILE DOES NOT POINT TO A VALID REPOSITORY'),
    ).toBe(true)
    expect(isNoRepoGitStderr('Fatal: Not A Git Repository')).toBe(true)
  })

  test('unrelated git stderr is NOT no-repo', () => {
    expect(isNoRepoGitStderr(UNRELATED_STDERR)).toBe(false)
    expect(isNoRepoGitStderr('')).toBe(false)
    expect(isNoRepoGitStderr('fatal: bad revision abc123')).toBe(false)
  })
})

describe('2.1.302 #23: classifyRevParseCause no_repo class', () => {
  test('git ≥2.56 stray-gitfile stderr classifies as no_repo, not git_refused', () => {
    expect(
      classifyRevParseCause({
        stdout: '',
        stderr: GITFILE_STDERR_NEW_GIT,
        code: 128,
      }),
    ).toBe('no_repo')
  })

  test('git <2.56 stray-gitfile stderr classifies as the SAME no_repo class', () => {
    expect(
      classifyRevParseCause({
        stdout: '',
        stderr: GITFILE_STDERR_OLD_GIT,
        code: 128,
      }),
    ).toBe('no_repo')
  })

  test('regression: unrelated exit-128 stderr still classifies as git_refused', () => {
    expect(
      classifyRevParseCause({
        stdout: '',
        stderr: UNRELATED_STDERR,
        code: 128,
      }),
    ).toBe('git_refused')
  })

  test('regression: pre-existing cause mapping is unchanged', () => {
    // Same fixtures as worktreeCreateErrors299.test.ts (2.1.299 #146).
    expect(
      classifyRevParseCause({ stdout: '', stderr: '', code: 0 }),
    ).toBe('empty_answer')
    expect(
      classifyRevParseCause({ stdout: '', stderr: '', code: 1 }),
    ).toBe('name_missing')
    expect(
      classifyRevParseCause({ stdout: '', stderr: 'fatal: x', code: 1 }),
    ).toBe('exit_1_with_output')
    expect(
      classifyRevParseCause({ stdout: '', stderr: 'boom', code: 2 }),
    ).toBe('other_exit')
    expect(
      classifyRevParseCause({
        stdout: '',
        stderr: '',
        code: 1,
        error: 'Command timed out after 100 ms',
      }),
    ).toBe('timed_out')
    expect(
      classifyRevParseCause({
        stdout: '',
        stderr: '',
        code: 1,
        error: 'spawn git ENOENT',
      }),
    ).toBe('not_completed')
  })
})

describe('2.1.302 #23: real-git integration (stray `.git` FILE → nonexistent gitdir)', () => {
  test('the actual rev-parse probe used by worktree entry classifies a stray gitfile dir as no_repo', async () => {
    const dir = makeStrayGitfileDir('occ-wt302-probe-')

    // Exactly what getOrCreateWorktree's base-resolve runs (worktree.ts):
    // `git rev-parse --verify --quiet HEAD` under LC_ALL=C at the dir.
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      { cwd: dir, env: { ...process.env, LC_ALL: 'C' } },
    )

    // Real git must fail here (sanity: the dir is not a usable repo).
    expect(result.code).not.toBe(0)
    expect(result.stdout.trim()).toBe('')

    // This machine's git decides WHICH canonical message appears (2.43 → the
    // old one; ≥2.56 → the gitfile one). Assert only the classification
    // mapping so the test is git-version-robust.
    expect(classifyRevParseCause(result)).toBe('no_repo')

    // Git-version-robust complement: BOTH canonical messages classify the
    // same regardless of which one this machine's git emitted.
    expect(classifyRevParseCause({ ...result, stderr: GITFILE_STDERR_NEW_GIT })).toBe(
      'no_repo',
    )
    expect(classifyRevParseCause({ ...result, stderr: GITFILE_STDERR_OLD_GIT })).toBe(
      'no_repo',
    )
  })

  test('getOrCreateWorktree declines a stray-gitfile dir as not-a-git-repository, not as a base-resolve error', async () => {
    const dir = makeStrayGitfileDir('occ-wt302-create-')

    let message = ''
    try {
      await getOrCreateWorktree(dir, 'test-slug')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    // Graceful decline, same class as the plain not-in-a-git-repository case.
    expect(message).toContain('not in a git repository')
    // NOT the 2.1.299 base-resolve hard-error refusal (the v301 behavior).
    expect(message).not.toContain('Failed to resolve base branch')
  })
})
