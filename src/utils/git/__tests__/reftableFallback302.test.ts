/**
 * Official Claude Code 2.1.302 changelog #10 (version-detection half) —
 * reftable-aware ref resolution for plugin version detection.
 *
 * Symptom (pre-fix): a git plugin installed into a repo whose git defaults to
 * the reftable ref format (git >= 2.56 `init.refStorage=reftable`) shows
 * version "unknown" because OCC resolves refs by pure fs reads (loose ref
 * files + packed-refs), which don't exist under reftable — `<gitDir>/HEAD`
 * holds the sentinel `ref: refs/heads/.invalid` and `refs/heads/<branch>` is
 * a placeholder file.
 *
 * Official v302 shape (byte-verified, function `M4` @235158155):
 *   reftable check FIRST (`ubt` @235159663: `<gitDir>/HEAD` === sentinel)
 *   → `git show-ref --verify --hash --end-of-options <ref>` subprocess
 *   → validate full 40/64-hex sha (`$2`) → null on every failure mode;
 *   else the classic fs path (loose → packed-refs → commondir) unchanged.
 *
 * Local git is 2.43 (no native reftable support), so tests follow the task's
 * fixture strategy: a REAL repo whose `.git/HEAD` is overwritten with the
 * sentinel + a `.git/reftable/` dir. `show-ref` for real branch refs resolves
 * against that fixture with real git (verified empirically); the HEAD case
 * (which only reftable-capable git >= 2.46 can resolve through the sentinel)
 * is exercised through the exec seam with a fake show-ref HEAD response, the
 * same way official behavior would unfold on a real reftable repo. The exec
 * seam (worktreeStartPoint300.test.ts pattern) also proves NO subprocess is
 * spawned for classic files-backend repos (zero behavior change there).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
  git(path, 'init', '-b', branch)
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

/**
 * Turn a real repo's `.git` into a reftable-style fixture: HEAD overwritten
 * with the official sentinel (`ref: refs/heads/.invalid`) + a `reftable/`
 * dir. Loose branch refs stay intact so real git's `show-ref` still resolves
 * named refs — exactly the "detect the sentinel → invoke show-ref in a dir
 * where it resolves" strategy from the task spec.
 */
function makeReftableFixture(repoDir: string): { gitDir: string; sha: string } {
  const sha = gitOut(repoDir, 'rev-parse', 'HEAD')
  const gitDir = join(repoDir, '.git')
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/.invalid\n', 'utf-8')
  mkdirSync(join(gitDir, 'reftable'), { recursive: true })
  return { gitDir, sha }
}

// --- Exec seam (worktreeStartPoint300.test.ts pattern): snapshot real
// exports, record every spawn, optionally fake ONLY `show-ref ... HEAD`
// responses for a specific --git-dir, delegate everything else to the real
// runner. ---
const actualExec = await import('../../execFileNoThrow.js')
const actualExecExports = { ...actualExec }

type SpawnRecord = { file: string; args: string[] }
const spawnLog: SpawnRecord[] = []
let fakeShowRefHead: { gitDir: string; stdout: string; code: number } | null =
  null

mock.module('../../execFileNoThrow.js', () => ({
  ...actualExecExports,
  execFileNoThrowWithCwd: (file: string, args: string[], opts?: unknown) => {
    spawnLog.push({ file, args: [...args] })
    const gitDirIdx = args.indexOf('--git-dir')
    const isShowRefHead =
      args.includes('show-ref') && args[args.length - 1] === 'HEAD'
    if (
      fakeShowRefHead !== null &&
      isShowRefHead &&
      gitDirIdx !== -1 &&
      args[gitDirIdx + 1] === fakeShowRefHead.gitDir
    ) {
      return Promise.resolve({
        stdout: fakeShowRefHead.stdout,
        stderr: '',
        code: fakeShowRefHead.code,
      })
    }
    // Call the SNAPSHOTTED real function (live namespace binding would
    // recurse into this very mock).
    return actualExecExports.execFileNoThrowWithCwd(file, args, opts as never)
  },
}))

afterAll(() => {
  mock.module('../../execFileNoThrow.js', () => ({ ...actualExecExports }))
})

// Imported AFTER the mock so gitFilesystem/pluginVersioning bind the seam.
const {
  usesReftableRefStorage,
  resolveRef,
  getHeadForDir,
  clearResolveGitDirCache,
} = await import('../gitFilesystem.js')
const { calculatePluginVersion } = await import(
  '../../plugins/pluginVersioning.js'
)

function showRefSpawns(): SpawnRecord[] {
  return spawnLog.filter(r => r.args.includes('show-ref'))
}

beforeEach(() => {
  spawnLog.length = 0
  fakeShowRefHead = null
  clearResolveGitDirCache()
})

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

describe('2.1.302 #10 — reftable detection (official ubt + worktree.ts precedent)', () => {
  test('sentinel HEAD (ref: refs/heads/.invalid) → true', async () => {
    const dir = makeTmpDir('occ-rt-detect-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    const { gitDir } = makeReftableFixture(repo)
    expect(await usesReftableRefStorage(gitDir)).toBe(true)
  })

  test('classic files-backend HEAD → false', async () => {
    const dir = makeTmpDir('occ-rt-detect-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    expect(await usesReftableRefStorage(join(repo, '.git'))).toBe(false)
  })

  test('normal HEAD but <gitDir>/reftable/ dir present → true', async () => {
    const dir = makeTmpDir('occ-rt-detect-')
    const gitDir = join(dir, 'fake.git')
    mkdirSync(join(gitDir, 'reftable'), { recursive: true })
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf-8')
    expect(await usesReftableRefStorage(gitDir)).toBe(true)
  })

  test('nonexistent gitdir → false (never throws)', async () => {
    const dir = makeTmpDir('occ-rt-detect-')
    expect(await usesReftableRefStorage(join(dir, 'nope.git'))).toBe(false)
  })
})

describe('2.1.302 #10 — reftable resolver via real git show-ref', () => {
  test('fixture reftable gitdir resolves refs/heads/main to the real sha via show-ref', async () => {
    const dir = makeTmpDir('occ-rt-resolve-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    const { gitDir, sha } = makeReftableFixture(repo)

    const resolved = await resolveRef(gitDir, 'refs/heads/main')

    expect(resolved).toBe(sha)
    // Official M4 argv shape: show-ref --verify --hash --end-of-options <ref>
    const spawn = showRefSpawns()
    expect(spawn.length).toBe(1)
    const args = spawn[0]!.args
    expect(args).toContain('--git-dir')
    expect(args.slice(args.indexOf('show-ref'))).toEqual([
      'show-ref',
      '--verify',
      '--hash',
      '--end-of-options',
      'refs/heads/main',
    ])
  })

  test('missing ref under reftable → null (official null-on-failure, no throw)', async () => {
    const dir = makeTmpDir('occ-rt-resolve-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    const { gitDir } = makeReftableFixture(repo)
    expect(await resolveRef(gitDir, 'refs/heads/does-not-exist')).toBeNull()
  })

  test('HEAD under reftable on pre-reftable git → null, never garbage', async () => {
    // Real git 2.43 cannot see through the sentinel HEAD; official M4 returns
    // null when show-ref exits non-zero. (On reftable-capable git >= 2.46 the
    // same call resolves — covered by the fake-response tests below.)
    const dir = makeTmpDir('occ-rt-resolve-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    const { gitDir } = makeReftableFixture(repo)
    expect(await resolveRef(gitDir, 'HEAD')).toBeNull()
  })

  test('official ref guard: non-refs/ names and unsafe names return null without spawning', async () => {
    const dir = makeTmpDir('occ-rt-resolve-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    const { gitDir, sha } = makeReftableFixture(repo)

    // Not HEAD, no refs/ prefix → rejected pre-spawn (official M4 guard).
    expect(await resolveRef(gitDir, 'main')).toBeNull()
    // Unsafe ref name (shell metacharacters / traversal) → rejected pre-spawn.
    expect(await resolveRef(gitDir, 'refs/heads/..')).toBeNull()
    expect(await resolveRef(gitDir, 'refs/heads/x;rm -rf /')).toBeNull()
    expect(showRefSpawns().length).toBe(0)

    // Sanity: the same fixture still resolves a legitimate ref afterwards.
    expect(await resolveRef(gitDir, 'refs/heads/main')).toBe(sha)
  })

  test('getHeadForDir resolves through the sentinel when show-ref HEAD succeeds (fake reftable-capable git)', async () => {
    const dir = makeTmpDir('occ-rt-head-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    const { gitDir, sha } = makeReftableFixture(repo)
    fakeShowRefHead = { gitDir, stdout: `${sha}\n`, code: 0 }

    expect(await getHeadForDir(repo)).toBe(sha)
  })

  test('show-ref HEAD output is sha-validated: non-hex stdout → null', async () => {
    const dir = makeTmpDir('occ-rt-head-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    const { gitDir } = makeReftableFixture(repo)
    fakeShowRefHead = { gitDir, stdout: 'not-a-sha\n', code: 0 }

    expect(await getHeadForDir(repo)).toBeNull()
  })

  test('show-ref HEAD non-zero exit → null (official null-on-failure)', async () => {
    const dir = makeTmpDir('occ-rt-head-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    const { gitDir, sha } = makeReftableFixture(repo)
    fakeShowRefHead = { gitDir, stdout: `${sha}\n`, code: 128 }

    expect(await getHeadForDir(repo)).toBeNull()
  })
})

describe('2.1.302 #10 — classic repos keep the pure-fs path (zero behavior change)', () => {
  test('loose-ref repo resolves via fs with NO show-ref subprocess', async () => {
    const dir = makeTmpDir('occ-rt-classic-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    const gitDir = join(repo, '.git')
    const sha = gitOut(repo, 'rev-parse', 'HEAD')

    expect(await resolveRef(gitDir, 'refs/heads/main')).toBe(sha)
    expect(await getHeadForDir(repo)).toBe(sha)
    expect(showRefSpawns().length).toBe(0)
  })

  test('packed-refs repo resolves via fs with NO show-ref subprocess', async () => {
    const dir = makeTmpDir('occ-rt-classic-')
    const repo = initRepoWithCommit(join(dir, 'repo'))
    const gitDir = join(repo, '.git')
    git(repo, 'pack-refs', '--all')
    const sha = gitOut(repo, 'rev-parse', 'HEAD')

    expect(await resolveRef(gitDir, 'refs/heads/main')).toBe(sha)
    expect(await getHeadForDir(repo)).toBe(sha)
    expect(showRefSpawns().length).toBe(0)
  })
})

describe('2.1.302 #10 — calculatePluginVersion end-to-end under reftable', () => {
  test('plugin install dir in a reftable repo → short sha (12 chars), not "unknown"', async () => {
    const dir = makeTmpDir('occ-rt-e2e-')
    const repo = initRepoWithCommit(join(dir, 'plugin-repo'))
    const { gitDir, sha } = makeReftableFixture(repo)
    fakeShowRefHead = { gitDir, stdout: `${sha}\n`, code: 0 }

    // Pre-fix this returned 'unknown' (fs-only resolution found neither a
    // loose HEAD branch ref nor packed-refs under the sentinel gitdir).
    const version = await calculatePluginVersion(
      'demo-plugin@demo-market',
      './demo-plugin',
      undefined,
      repo,
    )

    expect(version).toBe(sha.slice(0, 12))
    expect(version).toHaveLength(12)
    expect(version).not.toBe('unknown')
  })

  test('manifest.version still wins over the git sha (precedence unchanged)', async () => {
    const dir = makeTmpDir('occ-rt-e2e-')
    const repo = initRepoWithCommit(join(dir, 'plugin-repo'))
    const { gitDir, sha } = makeReftableFixture(repo)
    fakeShowRefHead = { gitDir, stdout: `${sha}\n`, code: 0 }

    const version = await calculatePluginVersion(
      'demo-plugin@demo-market',
      './demo-plugin',
      { name: 'demo-plugin', version: '1.2.3' },
      repo,
    )

    expect(version).toBe('1.2.3')
  })
})
