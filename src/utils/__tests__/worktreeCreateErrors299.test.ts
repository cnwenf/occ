/**
 * Official Claude Code 2.1.299 #146 + #147 — worktree creation error messages.
 *
 * #146: base commit doesn't resolve → the error says HOW the lookup ended
 * (cause: empty answer / timed out / name missing / exit 1 / git refused) and
 * the LIKELY reasons, per base kind (origin_default / fetch_head / head).
 * Byte-exact catalog ported from the official `DQt` (v299 ELF @225547600).
 *
 * #147: repo root whose `.git` is a file/symlink pointing at a BARE repository
 * → explanatory error (official throw @225552076, detector `aSs` @221606923).
 *
 * Integration tests run real git in temp dirs (same pattern as
 * worktreeReftable299.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  bareLayoutRootMessage,
  buildWorktreeBaseResolveFailureMessage,
  classifyRevParseCause,
  displayPathForError,
  gitFilePointsToBareRepository,
  pickDisplayStderrLine,
  quotedGitOutput,
  worktreeBaseKindFor,
} from '../git/worktreeBaseResolve.js'
import { getDefaultBranch } from '../git.js'
import { getOrCreateWorktree } from '../worktree.js'

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

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${result.stderr}`,
    )
  }
}

function initRepoWithCommit(path: string, branch = 'main'): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init')
  git(path, 'checkout', '-B', branch)
  git(path, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init')
  return path
}

// Official byte-exact fragments (mirrored from worktreeBaseResolve.ts source).
const MAY_NOT_BE_WORKING_MORE =
  'It may also be that the git that Claude Code runs (which may not be the one in your shell) is not working. Running git status in this repository may show more.'
const BASE_REF_HEAD_HINT =
  'To start worktrees from your current HEAD instead, set worktree.baseRef to "head" in Claude Code settings.'

describe('2.1.299 #146: classifyRevParseCause', () => {
  test('exit 0 with empty stdout classifies as empty_answer', () => {
    expect(
      classifyRevParseCause({ stdout: '', stderr: '', code: 0 }),
    ).toBe('empty_answer')
  })

  test('exit 1 with no output classifies as name_missing', () => {
    expect(
      classifyRevParseCause({ stdout: '', stderr: '', code: 1 }),
    ).toBe('name_missing')
  })

  test('exit 1 with stderr classifies as exit_1_with_output', () => {
    expect(
      classifyRevParseCause({ stdout: '', stderr: 'fatal: x', code: 1 }),
    ).toBe('exit_1_with_output')
  })

  test('exit 128 classifies as git_refused', () => {
    expect(
      classifyRevParseCause({ stdout: '', stderr: 'fatal: bad', code: 128 }),
    ).toBe('git_refused')
  })

  test('other exit codes classify as other_exit', () => {
    expect(
      classifyRevParseCause({ stdout: '', stderr: 'boom', code: 2 }),
    ).toBe('other_exit')
  })

  test('timeout error text classifies as timed_out (OCC adaptation)', () => {
    expect(
      classifyRevParseCause({
        stdout: '',
        stderr: '',
        code: 1,
        error: 'Command timed out after 100 ms',
      }),
    ).toBe('timed_out')
  })

  test('spawn failure classifies as not_completed (OCC adaptation)', () => {
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

describe('2.1.299 #146: failure message catalog (byte-exact official strings)', () => {
  const base = { repoConfirmed: true, stderrTrimmed: '', stdoutTrimmed: '' }

  test('empty_answer', () => {
    expect(
      buildWorktreeBaseResolveFailureMessage({
        ...base,
        cause: 'empty_answer',
        kind: 'origin_default',
      }),
    ).toBe('git rev-parse succeeded but printed no commit id.')
  })

  test('timed_out', () => {
    expect(
      buildWorktreeBaseResolveFailureMessage({
        ...base,
        cause: 'timed_out',
        kind: 'origin_default',
      }),
    ).toBe('git rev-parse timed out.')
  })

  test('not_completed', () => {
    expect(
      buildWorktreeBaseResolveFailureMessage({
        ...base,
        cause: 'not_completed',
        kind: 'origin_default',
      }),
    ).toBe('git failed to start, or was stopped before it finished.')
  })

  test('unconfirmed repo layout wins over exit-code causes', () => {
    expect(
      buildWorktreeBaseResolveFailureMessage({
        ...base,
        cause: 'name_missing',
        kind: 'origin_default',
        repoConfirmed: false,
      }),
    ).toBe(
      "Claude Code could not confirm that this repository's .git entry belongs to the folder it is in (for example a symlinked .git, or a .git file that points elsewhere), so no worktree can be made from it.",
    )
  })

  test('name_missing + origin_default includes the baseRef hint', () => {
    expect(
      buildWorktreeBaseResolveFailureMessage({
        ...base,
        cause: 'name_missing',
        kind: 'origin_default',
      }),
    ).toBe(
      `the fetch from origin succeeded, but git rev-parse returned no commit for this ref afterwards (for example in a single-branch clone of another branch, or a bare clone without a fetch refspec). ${BASE_REF_HEAD_HINT} ${MAY_NOT_BE_WORKING_MORE}`,
    )
  })

  test('name_missing + fetch_head', () => {
    expect(
      buildWorktreeBaseResolveFailureMessage({
        ...base,
        cause: 'name_missing',
        kind: 'fetch_head',
      }),
    ).toBe(
      `the fetch of the PR/MR succeeded, but git rev-parse returned no commit for FETCH_HEAD afterwards. ${MAY_NOT_BE_WORKING_MORE}`,
    )
  })

  test('name_missing + head fallback', () => {
    expect(
      buildWorktreeBaseResolveFailureMessage({
        ...base,
        cause: 'name_missing',
        kind: 'head_fallback',
      }),
    ).toBe(
      `git rev-parse returned no commit for HEAD (for example in a new repository, or on a branch without a commit yet), so Claude Code has nothing to base a worktree on. ${MAY_NOT_BE_WORKING_MORE}`,
    )
  })

  test('git_refused quotes the most diagnostic stderr line', () => {
    expect(
      buildWorktreeBaseResolveFailureMessage({
        ...base,
        cause: 'git_refused',
        kind: 'origin_default',
        stderrTrimmed: 'warning: meh\nfatal: not a git repository: nope',
      }),
    ).toBe(
      'git rev-parse failed (git said “fatal: not a git repository: nope”).',
    )
  })

  test('other_exit with unshowable output says "nothing"', () => {
    expect(
      buildWorktreeBaseResolveFailureMessage({
        ...base,
        cause: 'other_exit',
        kind: 'head_fallback',
      }),
    ).toBe('git rev-parse failed (git said nothing).')
  })

  test('kind derivation matches the official call-site ternary', () => {
    expect(worktreeBaseKindFor('HEAD')).toBe('head_fallback')
    expect(worktreeBaseKindFor('FETCH_HEAD')).toBe('fetch_head')
    expect(worktreeBaseKindFor('origin/main')).toBe('origin_default')
  })
})

describe('2.1.299 #146: stderr line picking + quoting', () => {
  test('prefers fatal/error lines over warnings', () => {
    expect(
      pickDisplayStderrLine('warning: a\nerror: b\nfatal: c'),
    ).toBe('error: b')
  })

  test('falls back to warning lines, then any non-empty line', () => {
    expect(pickDisplayStderrLine('noise\nwarning: w')).toBe('warning: w')
    expect(pickDisplayStderrLine('\n\nplain text\n')).toBe('plain text')
    expect(pickDisplayStderrLine('')).toBe('')
  })

  test('quotedGitOutput collapses whitespace and wraps in curly quotes', () => {
    expect(quotedGitOutput('  fatal:   bad\tref\n')).toBe('“fatal: bad ref”')
  })

  test('quotedGitOutput middle-truncates with head:60 tail:120', () => {
    const long = `fatal: ${'x'.repeat(300)}`
    const quoted = quotedGitOutput(long, { head: 60, tail: 120 })
    expect(quoted.startsWith('“fatal: ')).toBe(true)
    expect(quoted.includes('…')).toBe(true)
    expect(quoted.endsWith(`${'x'.repeat(120)}”`)).toBe(true)
    // head 60 + marker + tail 120 + two quotes
    expect(quoted.length).toBe(60 + 1 + 120 + 2)
  })

  test('quotedGitOutput returns empty for whitespace-only input', () => {
    expect(quotedGitOutput('  \n ')).toBe('')
  })

  test('displayPathForError hides control-character paths (official qB)', () => {
    expect(displayPathForError('/tmp/normal')).toBe('/tmp/normal')
    expect(displayPathForError('/tmp/ba\x01d')).toBe(
      'a path not shown here because it holds hidden or control characters',
    )
  })
})

describe('2.1.299 #147: bare-layout root detection', () => {
  test('normal repo (.git directory) is not a bare-layout root', async () => {
    const repo = initRepoWithCommit(makeTmpDir('occ-wt-normal-'))
    expect(await gitFilePointsToBareRepository(repo)).toBe(false)
  })

  test('linked worktree of a bare clone IS a bare-layout root', async () => {
    const dir = makeTmpDir('occ-wt-bare-')
    const seed = join(dir, 'seed')
    initRepoWithCommit(seed)
    git(dir, 'clone', '--bare', seed, 'bare.git')
    git(join(dir, 'bare.git'), 'worktree', 'add', '--detach', join(dir, 'wt'))
    const wt = join(dir, 'wt')
    expect(await gitFilePointsToBareRepository(wt)).toBe(true)
  })

  test('bareLayoutRootMessage is byte-exact with the official throw', () => {
    expect(bareLayoutRootMessage('/repo/wt')).toBe(
      "The .git in /repo/wt points to a bare repository, so Claude Code can't create a worktree from this directory. Start Claude Code in one of that repository's worktrees instead (git worktree add makes one).",
    )
  })
})

describe('2.1.299 #146/#147: getOrCreateWorktree integration (real git)', () => {
  test('unborn HEAD repo throws the head_fallback name_missing message', async () => {
    const repo = makeTmpDir('occ-wt-unborn-')
    git(repo, 'init')

    let message = ''
    try {
      await getOrCreateWorktree(repo, 'test-slug')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe(
      `Failed to resolve base branch "HEAD": git rev-parse returned no commit for HEAD (for example in a new repository, or on a branch without a commit yet), so Claude Code has nothing to base a worktree on. ${MAY_NOT_BE_WORKING_MORE}`,
    )
  })

  test('fetch succeeded but ref missing throws the origin_default message with the baseRef hint', async () => {
    const defaultBranch = await getDefaultBranch()
    const dir = makeTmpDir('occ-wt-origin-')
    const upstream = initRepoWithCommit(join(dir, 'upstream'), defaultBranch)
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    git(repo, 'init')
    // remote without a fetch refspec: `git fetch origin <branch>` succeeds but
    // creates no refs/remotes/origin/<branch> — the official single-branch /
    // missing-fetch-refspec scenario.
    git(repo, 'config', 'remote.origin.url', upstream)

    let message = ''
    try {
      await getOrCreateWorktree(repo, 'test-slug')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // The fetch only succeeds when upstream has the cached default branch —
    // initRepoWithCommit above guarantees that. Assert the origin_default text.
    expect(message).toBe(
      `Failed to resolve base branch "origin/${defaultBranch}": the fetch from origin succeeded, but git rev-parse returned no commit for this ref afterwards (for example in a single-branch clone of another branch, or a bare clone without a fetch refspec). ${BASE_REF_HEAD_HINT} ${MAY_NOT_BE_WORKING_MORE}`,
    )
  })

  test('bare-layout root throws the #147 message before any side effects', async () => {
    const dir = makeTmpDir('occ-wt-bareint-')
    const seed = join(dir, 'seed')
    initRepoWithCommit(seed)
    git(dir, 'clone', '--bare', seed, 'bare.git')
    git(join(dir, 'bare.git'), 'worktree', 'add', '--detach', join(dir, 'wt'))
    const wt = join(dir, 'wt')

    let message = ''
    try {
      await getOrCreateWorktree(wt, 'test-slug')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe(bareLayoutRootMessage(wt))
    // No .claude/worktrees dir was created — the check fires before mkdir.
    expect(existsSync(join(wt, '.claude'))).toBe(false)
  })
})
