/**
 * Acceptance Finding ⑤ — linked-worktree reftable resolution via the COMMON dir.
 *
 * Symptom (pre-fix): inside a LINKED worktree of a reftable repo,
 * `resolveRef(<per-worktree-gitdir>, ref)` returned null for every ref
 * (including HEAD's branch). The reftable check ran only against the
 * per-worktree gitdir — which carries no `reftable/` dir and holds the
 * classic-looking `ref: refs/heads/<branch>` HEAD that `git worktree add`
 * wrote — and the common-dir fallback re-read loose/packed refs only, never
 * re-checking reftable. Per gitreftable(5) the reftable store lives in
 * `$GIT_COMMON_DIR/reftable`, so detection (and the show-ref fallback) must
 * be re-run against the common dir.
 *
 * Fixture strategy (task-sanctioned fallback): local git is 2.43.0 — reftable
 * needs git >= 2.46 (`git init --ref-format=reftable` / `git refs migrate`),
 * so a real reftable store cannot be created or read here. All PATH plumbing
 * is REAL git: `git init` + `git worktree add` produce the actual `.git`
 * pointer file, `worktrees/<name>/gitdir` + `commondir` files and per-worktree
 * HEAD. The common dir is then converted to reftable shape by hand (sentinel
 * HEAD + `reftable/` store dir; loose refs deleted so the pure-fs path can
 * only return null — exactly a real reftable repo's on-disk state). ONLY the
 * lowest-level reftable-read seam (`git show-ref` subprocess, which git 2.43
 * cannot serve for reftable) is mocked at the execFileNoThrowWithCwd boundary;
 * the mock answers from a recorded sha map, simulating a reftable-capable
 * git >= 2.46 reading $GIT_COMMON_DIR/reftable. Everything under test —
 * pointer walk, commondir resolution, reftable detection, fallback ordering —
 * runs against the real filesystem.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
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

function commitEmpty(cwd: string, message: string): void {
  git(
    cwd,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@t',
    'commit',
    '--allow-empty',
    '-m',
    message,
  )
}

type WorktreeFixture = {
  mainRepo: string
  linkedWt: string
  /** Common git dir — the reftable store's home ($GIT_COMMON_DIR). */
  commonGitDir: string
  /** Per-worktree git dir (main/.git/worktrees/linked-wt). */
  wtGitDir: string
  wtSha: string
  mainSha: string
}

/**
 * Real `git init` + `git worktree add -b wt-branch`, then a second commit on
 * main so mainSha !== wtSha (proves each ref resolves to ITS OWN sha, not a
 * shared fixture constant).
 */
function makeWorktreeFixture(dir: string): WorktreeFixture {
  const mainRepo = join(dir, 'main-repo')
  const linkedWt = join(dir, 'linked-wt')
  mkdirSync(mainRepo, { recursive: true })
  git(mainRepo, 'init', '-b', 'main')
  commitEmpty(mainRepo, 'init')
  git(mainRepo, 'worktree', 'add', '-b', 'wt-branch', linkedWt)
  const wtSha = gitOut(linkedWt, 'rev-parse', 'HEAD')
  commitEmpty(mainRepo, 'second')
  const mainSha = gitOut(mainRepo, 'rev-parse', 'HEAD')
  return {
    mainRepo,
    linkedWt,
    commonGitDir: join(mainRepo, '.git'),
    wtGitDir: join(mainRepo, '.git', 'worktrees', 'linked-wt'),
    wtSha,
    mainSha,
  }
}

/**
 * Convert the fixture's COMMON dir to reftable shape (gitreftable(5)):
 * sentinel HEAD + `reftable/` store, loose refs deleted (a real reftable repo
 * keeps refs ONLY in the binary store). The per-worktree gitdir is left
 * exactly as git wrote it: real HEAD symref, `gitdir`, `commondir` — no
 * reftable markers, which is the gap this fix closes.
 */
function makeCommonDirReftable(fx: WorktreeFixture): void {
  writeFileSync(
    join(fx.commonGitDir, 'HEAD'),
    'ref: refs/heads/.invalid\n',
    'utf-8',
  )
  mkdirSync(join(fx.commonGitDir, 'reftable', 'tables'), { recursive: true })
  // Shape only — the store is binary and OCC never parses it (resolution
  // goes through the show-ref seam, mocked below).
  writeFileSync(
    join(fx.commonGitDir, 'reftable', 'tables.tab'),
    'tab-placeholder.ref\n',
    'utf-8',
  )
  rmSync(join(fx.commonGitDir, 'refs'), { recursive: true, force: true })
}

// --- Exec seam (reftableFallback302.test.ts pattern): snapshot real exports,
// record every spawn, fake ONLY show-ref responses whose --git-dir is the
// reftable store's common dir (simulating reftable-capable git >= 2.46
// reading $GIT_COMMON_DIR/reftable), delegate everything else to the real
// runner. Path resolution stays 100% real. ---
const actualExec = await import('../../execFileNoThrow.js')
const actualExecExports = { ...actualExec }

type SpawnRecord = { file: string; args: string[] }
const spawnLog: SpawnRecord[] = []
let fakeReftableStore: { gitDir: string; refs: Map<string, string> } | null =
  null

mock.module('../../execFileNoThrow.js', () => ({
  ...actualExecExports,
  execFileNoThrowWithCwd: (file: string, args: string[], opts?: unknown) => {
    spawnLog.push({ file, args: [...args] })
    const gitDirIdx = args.indexOf('--git-dir')
    if (
      fakeReftableStore !== null &&
      args.includes('show-ref') &&
      gitDirIdx !== -1 &&
      args[gitDirIdx + 1] === fakeReftableStore.gitDir
    ) {
      const ref = args[args.length - 1]
      const sha = fakeReftableStore.refs.get(ref)
      if (sha !== undefined) {
        return Promise.resolve({ stdout: `${sha}\n`, stderr: '', code: 0 })
      }
      return Promise.resolve({
        stdout: '',
        stderr: `fatal: '${ref}' - not a valid ref`,
        code: 1,
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

// Imported AFTER the mock so gitFilesystem binds the seam.
const {
  resolveRef,
  getHeadForDir,
  readWorktreeHeadSha,
  usesReftableRefStorage,
  getCommonDir,
  clearResolveGitDirCache,
} = await import('../gitFilesystem.js')

function showRefSpawns(): SpawnRecord[] {
  return spawnLog.filter(r => r.args.includes('show-ref'))
}

function armReftableStore(fx: WorktreeFixture): void {
  fakeReftableStore = {
    gitDir: fx.commonGitDir,
    refs: new Map([
      ['refs/heads/wt-branch', fx.wtSha],
      ['refs/heads/main', fx.mainSha],
    ]),
  }
}

beforeEach(() => {
  spawnLog.length = 0
  fakeReftableStore = null
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

describe('Finding ⑤ — linked worktree of a reftable repo resolves through $GIT_COMMON_DIR', () => {
  test('fixture shape: per-worktree gitdir looks classic, common dir is reftable', async () => {
    const dir = makeTmpDir('occ-rt-wt-shape-')
    const fx = makeWorktreeFixture(dir)
    makeCommonDirReftable(fx)

    // Real git plumbing: .git pointer, gitdir/commondir files as git wrote them.
    expect(readFileSync(join(fx.linkedWt, '.git'), 'utf-8').trim()).toBe(
      `gitdir: ${fx.wtGitDir}`,
    )
    expect(readFileSync(join(fx.wtGitDir, 'commondir'), 'utf-8').trim()).toBe(
      '../..',
    )
    expect(await getCommonDir(fx.wtGitDir)).toBe(fx.commonGitDir)
    // The per-worktree gitdir holds the real HEAD git worktree add wrote and
    // has NO reftable marker — detection there is false (the gap).
    expect(readFileSync(join(fx.wtGitDir, 'HEAD'), 'utf-8').trim()).toBe(
      'ref: refs/heads/wt-branch',
    )
    expect(await usesReftableRefStorage(fx.wtGitDir)).toBe(false)
    expect(await usesReftableRefStorage(fx.commonGitDir)).toBe(true)
  })

  test("refs/heads/wt-branch resolves from the linked worktree via a common-dir show-ref", async () => {
    const dir = makeTmpDir('occ-rt-wt-ref-')
    const fx = makeWorktreeFixture(dir)
    makeCommonDirReftable(fx)
    armReftableStore(fx)

    // Pre-fix: null — per-worktree detection missed and the common-dir
    // fallback read loose/packed refs only (absent under reftable).
    const resolved = await resolveRef(fx.wtGitDir, 'refs/heads/wt-branch')

    expect(resolved).toBe(fx.wtSha)
    const spawns = showRefSpawns()
    expect(spawns.length).toBe(1)
    const args = spawns[0]!.args
    // The stitch: show-ref runs against the COMMON dir, never the per-worktree gitdir.
    expect(args[args.indexOf('--git-dir') + 1]).toBe(fx.commonGitDir)
    expect(args.slice(args.indexOf('show-ref'))).toEqual([
      'show-ref',
      '--verify',
      '--hash',
      '--end-of-options',
      'refs/heads/wt-branch',
    ])
    expect(spawnLog.filter(r => r.args.includes(fx.wtGitDir)).length).toBe(0)
  })

  test('a main-repo branch also resolves via the common dir (distinct sha)', async () => {
    const dir = makeTmpDir('occ-rt-wt-main-')
    const fx = makeWorktreeFixture(dir)
    makeCommonDirReftable(fx)
    armReftableStore(fx)

    expect(await resolveRef(fx.wtGitDir, 'refs/heads/main')).toBe(fx.mainSha)
    expect(fx.mainSha).not.toBe(fx.wtSha)
  })

  test('HEAD resolves inside the linked worktree (resolveRef, getHeadForDir, readWorktreeHeadSha)', async () => {
    const dir = makeTmpDir('occ-rt-wt-head-')
    const fx = makeWorktreeFixture(dir)
    makeCommonDirReftable(fx)
    armReftableStore(fx)

    // HEAD as a ref: per-worktree HEAD file symref → refs/heads/wt-branch →
    // common-dir reftable stitch. Pre-fix: null.
    expect(await resolveRef(fx.wtGitDir, 'HEAD')).toBe(fx.wtSha)
    // cwd-based entry (walks the real .git pointer file). Pre-fix: null.
    expect(await getHeadForDir(fx.linkedWt)).toBe(fx.wtSha)
    // Worktree-specific entry (reads the .git pointer directly). Pre-fix: null.
    expect(await readWorktreeHeadSha(fx.linkedWt)).toBe(fx.wtSha)
  })

  test('unknown ref → null (show-ref non-zero, official null-on-failure)', async () => {
    const dir = makeTmpDir('occ-rt-wt-miss-')
    const fx = makeWorktreeFixture(dir)
    makeCommonDirReftable(fx)
    armReftableStore(fx)

    expect(await resolveRef(fx.wtGitDir, 'refs/heads/nope')).toBeNull()
    // The miss still went through the common-dir show-ref seam.
    expect(showRefSpawns().length).toBe(1)
  })
})

describe('Finding ⑤ — classic linked worktrees keep the pure-fs common-dir fallback', () => {
  test('no reftable anywhere → refs resolve from common loose refs with ZERO show-ref spawns', async () => {
    const dir = makeTmpDir('occ-rt-wt-classic-')
    const fx = makeWorktreeFixture(dir)
    // No reftable conversion — plain files-backend main + linked worktree.

    expect(await usesReftableRefStorage(fx.commonGitDir)).toBe(false)
    expect(await resolveRef(fx.wtGitDir, 'refs/heads/main')).toBe(fx.mainSha)
    expect(await resolveRef(fx.wtGitDir, 'refs/heads/wt-branch')).toBe(fx.wtSha)
    expect(await getHeadForDir(fx.linkedWt)).toBe(fx.wtSha)
    expect(showRefSpawns().length).toBe(0)
  })
})
