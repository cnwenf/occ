/**
 * Official Claude Code 2.1.300 #29 (symptom 2) + #33 (setup wiring).
 *
 * #29: "Fixed --worktree sessions sometimes starting from the wrong commit
 * when a tag or branch was named like a commit ID, AND THEIR STARTING GIT
 * STATUS NAMING A BRANCH OTHER THAN THE NEW WORKTREE'S." OCC's GitFileWatcher
 * (src/utils/git/gitFilesystem.ts) lazily pins its gitDir on first access
 * (resolveGitDir() from getCwd()) and caches branch/status values until
 * something dirties them. When setup() starts with --worktree, any git query
 * before the chdir pins the watcher to the ORIGINAL checkout; after
 * process.chdir(worktreePath) the stale pinned gitDir + clean cache keep
 * serving the original branch name. Fix: resetGitFileWatcher() in setup.ts
 * after the chdir block, so the first git status names the new worktree's
 * branch. (Symptom 1 — the wrong start commit — is the `${sha}^{commit}`
 * start-point peel, covered by worktreeStartPoint300.test.ts.)
 *
 * #33: "Fixed --worktree failing in a worktree of a bare repository when
 * origin's default branch can't be fetched; the fallback base is now the
 * CURRENT CHECKOUT's HEAD, not the main repository's." Official `Hen`
 * @226745624 resolves HEAD with `cwd = fromCwd ?? repoRoot`. setup() must
 * therefore thread the pre-chdir launch directory through
 * createWorktreeForSession → getOrCreateWorktree as `fromCwd`. This test
 * asserts the wiring: createWorktreeForSession receives fromCwd equal to the
 * cwd at worktree-block entry (the HEAD-resolution semantics themselves are
 * covered against real git in worktreeStartPoint300.test.ts).
 *
 * Strategy: real main repo + real linked worktree; mock worktree.js
 * (createWorktreeForSession captures options and returns a session pointing
 * at the real linked worktree), sessionStorage.js (saveWorktreeState throws
 * a sentinel — aborting setup() right after the chdir/reset section, before
 * the disk-write tail and network), and loadPluginHooks.js (no-op
 * hermeticity). The watcher is pre-pinned with getBranch() at the main
 * checkout to reproduce symptom 2; after the aborted setup(), getBranch()
 * must name the worktree's branch.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
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
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  }
}

function gitOut(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  }
  return result.stdout.trim()
}

function initRepoWithCommit(path: string, branch = 'main'): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init')
  git(path, 'checkout', '-B', branch)
  git(path, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init')
  return path
}

class SentinelAbort extends Error {}

// --- Mock seams (OCC-97 pattern: snapshot real exports, override narrowly,
// restore in afterAll). ---
const actualWorktree = await import('../utils/worktree.js')
const actualWorktreeExports = { ...actualWorktree }
const actualSessionStorage = await import('../utils/sessionStorage.js')
const actualSessionStorageExports = { ...actualSessionStorage }
const actualLoadPluginHooks = await import('../utils/plugins/loadPluginHooks.js')
const actualLoadPluginHooksExports = { ...actualLoadPluginHooks }

let capturedOptions: { prNumber?: number; fromCwd?: string } | undefined
let fakeSession: Record<string, unknown> | null = null

mock.module('../utils/worktree.js', () => ({
  ...actualWorktreeExports,
  createWorktreeForSession: async (
    _sessionId: string,
    _slug: string,
    _tmuxSessionName?: string,
    options?: { prNumber?: number; fromCwd?: string },
  ): Promise<Record<string, unknown>> => {
    capturedOptions = options
    if (!fakeSession) {
      throw new Error('test harness: fakeSession not configured')
    }
    return fakeSession
  },
}))

mock.module('../utils/sessionStorage.js', () => ({
  ...actualSessionStorageExports,
  saveWorktreeState: (): never => {
    // Abort setup() right after the chdir/reset section — before the
    // disk-write tail, background jobs, and the network release-notes fetch.
    throw new SentinelAbort('sentinel — abort setup() after the chdir/reset section')
  },
}))

mock.module('../utils/plugins/loadPluginHooks.js', () => ({
  ...actualLoadPluginHooksExports,
  loadPluginHooks: async (): Promise<void> => {},
  setupPluginHookHotReload: (): void => {},
}))

afterAll(() => {
  mock.module('../utils/worktree.js', () => ({ ...actualWorktreeExports }))
  mock.module('../utils/sessionStorage.js', () => ({ ...actualSessionStorageExports }))
  mock.module('../utils/plugins/loadPluginHooks.js', () => ({
    ...actualLoadPluginHooksExports,
  }))
})

// Imported AFTER the mocks so setup.js binds the mocked modules.
const { setup } = await import('../setup.js')
const { setCwd } = await import('../utils/Shell.js')
const { getCwd } = await import('../utils/cwd.js')
const { getIsGit, getBranch } = await import('../utils/git.js')
const { resetGitFileWatcher, clearResolveGitDirCache } = await import(
  '../utils/git/gitFilesystem.js'
)

const ORIGINAL_CWD = getCwd()
const ORIGINAL_PROCESS_CWD = process.cwd()
const realStderrWrite = process.stderr.write.bind(process.stderr)

afterEach(() => {
  // setup() really chdir'd into the worktree — escape before removing tmpDirs.
  process.chdir(ORIGINAL_PROCESS_CWD)
  process.stderr.write = realStderrWrite
  setCwd(ORIGINAL_CWD)
  resetGitFileWatcher()
  clearResolveGitDirCache()
  getIsGit.cache?.clear?.()
  capturedOptions = undefined
  fakeSession = null
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('2.1.300 #29/#33 — setup() --worktree chdir resets git branch state and threads fromCwd', () => {
  test('after the chdir the branch cache names the new worktree branch, and createWorktreeForSession receives fromCwd', async () => {
    const dir = makeTmpDir('occ-setup-branchreset-')
    const main = initRepoWithCommit(join(dir, 'main'), 'main')
    const wt = join(dir, 'wt')
    git(main, 'worktree', 'add', '-B', 'worktree-test', wt)
    const mainHead = gitOut(main, 'rev-parse', 'HEAD')

    setCwd(main)
    const cwdBefore = getCwd()
    resetGitFileWatcher()
    clearResolveGitDirCache()
    getIsGit.cache?.clear?.()

    // Symptom-2 setup: pre-pin the watcher at the original checkout — any
    // git status/branch query before the chdir caches branch 'main' against
    // main's gitDir.
    expect(await getBranch()).toBe('main')

    fakeSession = {
      originalCwd: cwdBefore,
      worktreePath: wt,
      worktreeName: 'test-slug',
      worktreeBranch: 'worktree-test',
      originalBranch: 'main',
      originalHeadCommit: mainHead,
      sessionId: 'test-session',
    }

    process.stderr.write = (() => true) as typeof process.stderr.write
    let abortSeen = false
    try {
      await setup(main, 'default' as never, false, true, 'test-slug', false)
    } catch (err) {
      if (err instanceof SentinelAbort) {
        abortSeen = true
      } else {
        throw err
      }
    }

    // setup() ran the chdir block, then aborted at saveWorktreeState.
    expect(abortSeen).toBe(true)
    expect(getCwd()).toBe(realpathSync(wt))

    // #29 symptom 2: the first git status after the chdir must name the new
    // worktree's branch, not the stale pre-chdir one. If the watcher reset
    // were placed AFTER saveWorktreeState, the sentinel would preempt it and
    // this assertion would fail — enforcing the reset's placement.
    expect(await getBranch()).toBe('worktree-test')

    // #33 wiring: the pre-chdir launch directory is threaded through as
    // fromCwd so the fetch-failure fallback can resolve the CURRENT
    // checkout's HEAD (official Hen @226745624: cwd = fromCwd ?? repoRoot).
    expect(capturedOptions?.fromCwd).toBe(cwdBefore)
  })
})
