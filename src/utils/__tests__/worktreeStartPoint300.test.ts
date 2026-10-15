/**
 * Official Claude Code 2.1.300 — worktree start-point pinning (#29) and
 * fetch-failure HEAD fallback from the launch checkout (#33).
 *
 * #29: `git worktree add` used to receive the base branch NAME as its
 * start-point. When a tag/branch was named like a commit id, git's DWIM
 * resolution could pick the wrong object. The official now pins the resolved
 * SHA with the `^{commit}` peel suffix (v300 add-argv @226752420:
 * `Q.push("--no-track","-B",h,s,H)` where `H=`${K}^{commit}``; the
 * `^{commit}` occurrence count rose 10 -> 13 from v299 to v300). OCC keeps its
 * existing argv (no `--no-track`) and only swaps the start-point NAME for the
 * peeled SHA — the pre-existing `--no-track` divergence is out of scope.
 *
 * #33: when the fetch of `origin/<default>` fails, the fallback base is now the
 * CURRENT checkout's HEAD (the directory the user launched from, `fromCwd`),
 * not the canonical repoRoot's. Official `Hen` @226745624 resolves HEAD with
 * `cwd = fromCwd ?? repoRoot`; the warn string is byte-exact (v300 @226752150,
 * em-dash U+2014): `[worktree] fetch of origin/<b> failed — basing worktree on
 * local HEAD`. Shares #29's `${sha}^{commit}` start-point mechanism.
 *
 * Integration tests run real git in temp dirs (same pattern as
 * worktreeCreateErrors299.test.ts). The exec seam captures the `worktree add`
 * argv then delegates to the real runner, so the SHA-peel syntax is exercised
 * against real git too.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

const tmpDirs: string[] = []
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${result.stderr}`,
    )
  }
}

function gitOut(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${result.stderr}`,
    )
  }
  return result.stdout.trim()
}

function initRepoWithCommit(path: string, branch = 'main'): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init')
  git(path, 'checkout', '-B', branch)
  git(
    path,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@t',
    'commit',
    '--allow-empty',
    '-m',
    'init',
  )
  return path
}

// --- Mock seams (OCC-97 pattern: snapshot real exports, override narrowly,
// restore in afterAll). The exec seam captures `worktree add` argv and
// delegates everything to the real runner; the debug seam captures
// logForDebugging so the #33 warn string can be asserted byte-exactly. ---
const actualExec = await import('../execFileNoThrow.js')
const actualExecExports = { ...actualExec }
const actualDebug = await import('../debug.js')
const actualDebugExports = { ...actualDebug }

let lastWorktreeAddArgv: string[] | null = null
type CapturedLog = { message: string; level: string | undefined }
const capturedLogs: CapturedLog[] = []

mock.module('../execFileNoThrow.js', () => ({
  ...actualExecExports,
  execFileNoThrowWithCwd: (file: string, args: string[], opts?: unknown) => {
    if (args[0] === 'worktree' && args[1] === 'add') {
      lastWorktreeAddArgv = [...args]
    }
    // Call the SNAPSHOTTED real function (not `actualExec.*`, which is a live
    // namespace binding that mock.module re-points at this very mock — calling
    // it would recurse forever).
    return actualExecExports.execFileNoThrowWithCwd(file, args, opts as never)
  },
}))

mock.module('../debug.js', () => ({
  ...actualDebugExports,
  logForDebugging: (
    message: string,
    opts: { level?: string } = { level: 'debug' },
  ): void => {
    capturedLogs.push({ message, level: opts?.level })
  },
}))

afterAll(() => {
  mock.module('../execFileNoThrow.js', () => ({ ...actualExecExports }))
  mock.module('../debug.js', () => ({ ...actualDebugExports }))
})

// Imported AFTER the mocks so worktree.js binds the mocked exec + debug.
const { getOrCreateWorktree } = await import('../worktree.js')
const { setCwd } = await import('../Shell.js')
const { getCwd } = await import('../cwd.js')
const { resetGitFileWatcher, clearResolveGitDirCache } = await import(
  '../git/gitFilesystem.js'
)

const ORIGINAL_CWD = getCwd()

afterEach(() => {
  setCwd(ORIGINAL_CWD)
  resetGitFileWatcher()
  clearResolveGitDirCache()
  lastWorktreeAddArgv = null
  capturedLogs.length = 0
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function startPointOf(argv: string[] | null): string {
  if (!argv) {
    throw new Error('worktree add was never invoked')
  }
  return argv[argv.length - 1]!
}

describe('2.1.300 #29 — worktree add start-point is the peeled base SHA', () => {
  test('origin/<default> fast path pins the peeled sha^{commit}, not the branch name', async () => {
    const dir = makeTmpDir('occ-wt-startpoint-')
    const upstream = initRepoWithCommit(join(dir, 'upstream'), 'main')
    const repo = join(dir, 'repo')
    git(dir, 'clone', upstream, 'repo')

    const originSha = gitOut(repo, 'rev-parse', 'origin/main')

    setCwd(repo)
    resetGitFileWatcher()
    clearResolveGitDirCache()

    const result = await getOrCreateWorktree(repo, 'test-slug')

    // #29: the start-point must be the peeled SHA, never the ref name.
    expect(startPointOf(lastWorktreeAddArgv)).toBe(`${originSha}^{commit}`)
    expect(startPointOf(lastWorktreeAddArgv)).not.toBe('origin/main')
    // Real git accepted `${sha}^{commit}` and the worktree landed on origin/main.
    expect(gitOut(result.worktreePath, 'rev-parse', 'HEAD')).toBe(originSha)
  })
})

describe('2.1.300 #33 — fetch-failure fallback bases on the launch checkout HEAD', () => {
  test('fromCwd HEAD wins over repoRoot HEAD when origin cannot be fetched', async () => {
    const dir = makeTmpDir('occ-wt-headfallback-')
    const main = initRepoWithCommit(join(dir, 'main'), 'main')
    // An origin whose URL does not exist -> `git fetch origin main` fails fast.
    git(main, 'remote', 'add', 'origin', join(dir, 'nonexistent-upstream.git'))

    // A linked worktree ("the current checkout") on its own commit B.
    const checkout = join(dir, 'checkout')
    git(main, 'worktree', 'add', '-B', 'feature', checkout)
    git(
      checkout,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@t',
      'commit',
      '--allow-empty',
      '-m',
      'B',
    )

    const mainHead = gitOut(main, 'rev-parse', 'HEAD')
    const checkoutHead = gitOut(checkout, 'rev-parse', 'HEAD')
    expect(mainHead).not.toBe(checkoutHead)

    setCwd(main)
    resetGitFileWatcher()
    clearResolveGitDirCache()

    const result = await getOrCreateWorktree(main, 'test-slug', {
      fromCwd: checkout,
    })

    // #33: the new worktree is based on the CURRENT checkout's HEAD (B), not
    // the canonical repoRoot's HEAD (A).
    expect(gitOut(result.worktreePath, 'rev-parse', 'HEAD')).toBe(checkoutHead)
    // Shares the #29 peeled-SHA start-point mechanism.
    expect(startPointOf(lastWorktreeAddArgv)).toBe(`${checkoutHead}^{commit}`)
    // Byte-exact official warn (v300 @226752150, em-dash U+2014).
    expect(
      capturedLogs.some(
        l =>
          l.level === 'warn' &&
          l.message ===
            '[worktree] fetch of origin/main failed — basing worktree on local HEAD',
      ),
    ).toBe(true)
  })

  test('without fromCwd the fallback resolves HEAD at repoRoot (no regression)', async () => {
    const dir = makeTmpDir('occ-wt-headfallback-nofrom-')
    const main = initRepoWithCommit(join(dir, 'main'), 'main')
    git(main, 'remote', 'add', 'origin', join(dir, 'nonexistent-upstream.git'))
    const mainHead = gitOut(main, 'rev-parse', 'HEAD')

    setCwd(main)
    resetGitFileWatcher()
    clearResolveGitDirCache()

    const result = await getOrCreateWorktree(main, 'test-slug')

    // fromCwd defaults to repoRoot, so the worktree is based on repoRoot HEAD.
    expect(gitOut(result.worktreePath, 'rev-parse', 'HEAD')).toBe(mainHead)
    expect(startPointOf(lastWorktreeAddArgv)).toBe(`${mainHead}^{commit}`)
  })
})
