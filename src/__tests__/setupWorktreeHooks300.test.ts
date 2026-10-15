/**
 * Official Claude Code 2.1.300 #24 — "Fixed plugin WorktreeCreate and
 * WorktreeRemove hooks not running when Claude Code starts with --worktree
 * (not yet with --tmux)."
 *
 * Mechanism (docs/gap-research-300/triage-T2.md §24): the plugin hook table
 * is populated by loadPluginHooks(), which in v299 only ran as a late
 * fire-and-forget prefetch — AFTER the --worktree block had already consulted
 * hasWorktreeCreateHook() and called createWorktreeForSession(). A
 * plugin-provided WorktreeCreate hook was therefore invisible at startup.
 * The official v300 awaits the plugin-hook load BEFORE worktree creation.
 * loadPluginHooks is lodash-memoized and setupPluginHookHotReload has a
 * hotReloadSubscribed guard, so the early await coexists safely with the
 * pre-existing late prefetch block.
 *
 * The --tmux variant is explicitly out of scope per the official entry
 * ("not yet with --tmux").
 *
 * Test strategy: real temp git repo; mock loadPluginHooks.js (record the
 * call) and worktree.js (createWorktreeForSession records, then throws a
 * sentinel). The sentinel lands in setup()'s worktree error path, which
 * calls process.exit(1) — also overridden to throw — aborting setup()
 * immediately after the ordering-relevant section, before the network tail
 * (checkForReleaseNotes) and the late prefetch block.
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
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  }
}

function initRepoWithCommit(path: string, branch = 'main'): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init')
  git(path, 'checkout', '-B', branch)
  git(path, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init')
  return path
}

class SentinelWorktreeError extends Error {}
class SentinelExit extends Error {
  constructor(readonly exitCode?: number) {
    super(`process.exit(${exitCode}) intercepted`)
  }
}

// --- Mock seams (OCC-97 pattern: snapshot real exports, override narrowly,
// restore in afterAll). ---
const actualLoadPluginHooks = await import('../utils/plugins/loadPluginHooks.js')
const actualLoadPluginHooksExports = { ...actualLoadPluginHooks }
const actualWorktree = await import('../utils/worktree.js')
const actualWorktreeExports = { ...actualWorktree }

const callOrder: string[] = []

mock.module('../utils/plugins/loadPluginHooks.js', () => ({
  ...actualLoadPluginHooksExports,
  loadPluginHooks: async (): Promise<void> => {
    callOrder.push('loadPluginHooks')
  },
  setupPluginHookHotReload: (): void => {},
}))

mock.module('../utils/worktree.js', () => ({
  ...actualWorktreeExports,
  createWorktreeForSession: async (): Promise<never> => {
    callOrder.push('createWorktreeForSession')
    // Abort setup() via its own error path (stderr + process.exit(1));
    // process.exit is overridden below to throw, so nothing after the
    // worktree block (network tail, late prefetch) ever runs.
    throw new SentinelWorktreeError('sentinel — abort setup() after the ordering-relevant section')
  },
}))

afterAll(() => {
  mock.module('../utils/plugins/loadPluginHooks.js', () => ({
    ...actualLoadPluginHooksExports,
  }))
  mock.module('../utils/worktree.js', () => ({ ...actualWorktreeExports }))
})

// Imported AFTER the mocks so setup.js binds the mocked modules.
const { setup } = await import('../setup.js')
const { setCwd } = await import('../utils/Shell.js')
const { getCwd } = await import('../utils/cwd.js')
const { getIsGit } = await import('../utils/git.js')
const { resetGitFileWatcher, clearResolveGitDirCache } = await import(
  '../utils/git/gitFilesystem.js'
)

const ORIGINAL_CWD = getCwd()
const realExit = process.exit
const realStderrWrite = process.stderr.write.bind(process.stderr)

afterEach(() => {
  process.exit = realExit
  process.stderr.write = realStderrWrite
  setCwd(ORIGINAL_CWD)
  resetGitFileWatcher()
  clearResolveGitDirCache()
  getIsGit.cache?.clear?.()
  callOrder.length = 0
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('2.1.300 #24 — plugin hooks load before --worktree creation', () => {
  test('loadPluginHooks is awaited before createWorktreeForSession', async () => {
    const dir = makeTmpDir('occ-setup-hooks300-')
    const repo = initRepoWithCommit(join(dir, 'repo'), 'main')

    getIsGit.cache?.clear?.()
    // Silence setup()'s error-path stderr noise.
    process.stderr.write = (() => true) as typeof process.stderr.write
    process.exit = ((code?: number): never => {
      throw new SentinelExit(code)
    }) as typeof process.exit

    let exitSeen = false
    try {
      await setup(repo, 'default' as never, false, true, 'test-slug', false)
    } catch (err) {
      if (err instanceof SentinelExit) {
        exitSeen = true
      } else {
        throw err
      }
    }

    // setup() aborted exactly at the mocked createWorktreeForSession error path.
    expect(exitSeen).toBe(true)
    // #24: the plugin hook table must be populated BEFORE the worktree
    // subsystem consults it (hasWorktreeCreateHook / createWorktreeForSession),
    // otherwise plugin WorktreeCreate/WorktreeRemove hooks never fire at startup.
    expect(callOrder).toEqual(['loadPluginHooks', 'createWorktreeForSession'])
  })
})
