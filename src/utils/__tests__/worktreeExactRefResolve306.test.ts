/**
 * Official Claude Code 2.1.306 (#P8) — bare-repo worktree base resolution +
 * unchanged-worktree cleanup.
 *
 * Part 1 (base resolution): the official `yot` resolver (v306 ELF @250451600)
 * gained an `exactRef` mode — the fetch-success call site (@250461300) now
 * resolves the FULL ref with `git show-ref --verify --hash
 * refs/remotes/origin/<default>` instead of relying on the shared abbrev
 * `git rev-parse --verify --quiet origin/<default>`, which in bare-repo
 * layouts can misresolve against the local HEAD or fail. Older git answers a
 * missing ref to `show-ref --verify` with exit 128 + `fatal: '<ref>' - not a
 * valid ref` — the official `ve` detection maps that shape to `name_missing`.
 * Every failure-catalog message now names the command actually run (`w` =
 * show-ref | rev-parse), and the origin_default name_missing phrase changed to
 * `found no such ref afterwards`. The `git worktree add` start-point peel
 * `${sha}^{commit}` is now UNCONDITIONAL (v306 `let Se=`${q}^{commit}``
 * @250462300).
 *
 * Part 2 (cleanup): the official cleanup bytes are identical v304↔v306 — the
 * leak ("agent worktrees sometimes not being cleaned up") is a downstream
 * effect of Part 1: a misresolved base left `headCommit` unset/misresolved,
 * and the AgentTool cleanup was gated entirely on `headCommit` being present.
 * OCC adds a fail-closed fallback (`shouldRemoveUnchangedAgentWorktree`):
 * when headCommit is missing, remove anyway only if the path is an EPHEMERAL
 * machine-generated slug AND `git status --porcelain` is clean.
 *
 * Harness: mock.module exec seam (snapshot real exports, override narrowly,
 * restore in afterAll — OCC-97 pattern from worktreeStartPoint300.test.ts) +
 * real-git temp dirs.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
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

// --- Mock seams: the exec seam records every git argv and can return a
// synthetic result per-test (null → delegate to the SNAPSHOTTED real runner);
// the debug seam captures logForDebugging for the official warn annotation. ---
const actualExec = await import('../execFileNoThrow.js')
const actualExecExports = { ...actualExec }
const actualDebug = await import('../debug.js')
const actualDebugExports = { ...actualDebug }

type SyntheticExecResult = {
  stdout: string
  stderr: string
  code: number
  error?: string
}
let execOverride: ((args: string[]) => SyntheticExecResult | null) | null = null
const capturedArgv: string[][] = []
type CapturedLog = { message: string; level: string | undefined }
const capturedLogs: CapturedLog[] = []

mock.module('../execFileNoThrow.js', () => ({
  ...actualExecExports,
  execFileNoThrowWithCwd: (file: string, args: string[], opts?: unknown) => {
    capturedArgv.push([...args])
    if (execOverride) {
      const synthetic = execOverride(args)
      if (synthetic) {
        return Promise.resolve(synthetic)
      }
    }
    // Call the SNAPSHOTTED real function (not `actualExec.*`, which mock.module
    // re-points at this very mock — calling it would recurse forever).
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
const {
  resolveGitRef,
  getOrCreateWorktree,
  shouldRemoveUnchangedAgentWorktree,
  isEphemeralWorktreePath,
} = await import('../worktree.js')
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
  execOverride = null
  capturedArgv.length = 0
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

// Official byte-exact fragments (mirrored from worktreeBaseResolve.ts source).
const MAY_NOT_BE_WORKING_MORE =
  'It may also be that the git that Claude Code runs (which may not be the one in your shell) is not working. Running git status in this repository may show more.'
const BASE_REF_HEAD_HINT =
  'To start worktrees from your current HEAD instead, set worktree.baseRef to "head" in Claude Code settings.'
const NOT_IN_GIT_REPO_MESSAGE =
  'Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
  'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.'

const ORIGIN_MAIN = 'refs/remotes/origin/main'
const FAKE_SHA = 'a'.repeat(40)

function makeResolveParams(overrides?: {
  exactRef?: boolean
  kind?: 'head_fallback' | 'fetch_head' | 'origin_default'
}) {
  const repo = initRepoWithCommit(makeTmpDir('occ-wt306-repo-'))
  return {
    params: {
      base: ORIGIN_MAIN,
      kind: 'origin_default' as const,
      failure: 'Failed to resolve base branch "origin/main"',
      cwd: repo,
      root: repo,
      ...overrides,
    },
    repo,
  }
}

async function captureThrownError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected resolveGitRef to throw, but it resolved')
}

describe('2.1.306 #P8 — resolveGitRef command shapes (official yot argv)', () => {
  test('exactRef runs show-ref --verify --hash on the FULL ref and returns the trimmed stdout', async () => {
    const { params } = makeResolveParams({ exactRef: true })
    execOverride = args =>
      args[0] === 'show-ref'
        ? { stdout: `${FAKE_SHA}\n`, stderr: '', code: 0 }
        : null

    const resolved = await resolveGitRef(params)

    expect(resolved).toBe(FAKE_SHA)
    expect(capturedArgv).toContainEqual([
      'show-ref',
      '--verify',
      '--hash',
      ORIGIN_MAIN,
    ])
  })

  test('the loose path keeps the abbrev rev-parse --verify --quiet shape', async () => {
    const { params } = makeResolveParams()
    execOverride = args =>
      args[0] === 'rev-parse'
        ? { stdout: `${FAKE_SHA}\n`, stderr: '', code: 0 }
        : null

    const resolved = await resolveGitRef(params)

    expect(resolved).toBe(FAKE_SHA)
    expect(capturedArgv).toContainEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      ORIGIN_MAIN,
    ])
  })

  test('exit 0 with empty stdout classifies as empty_answer and names show-ref', async () => {
    const { params } = makeResolveParams({ exactRef: true })
    execOverride = args =>
      args[0] === 'show-ref' ? { stdout: '  \n', stderr: '', code: 0 } : null

    const message = await captureThrownError(resolveGitRef(params))

    expect(message).toBe(
      'Failed to resolve base branch "origin/main": git show-ref succeeded but printed no commit id.',
    )
  })
})

describe('2.1.306 #P8 — resolveGitRef failure catalog (parameterized command word)', () => {
  test('the official ve shape (exactRef + exit 128 + canonical stderr) maps to name_missing with the v306 phrase', async () => {
    const { params } = makeResolveParams({ exactRef: true })
    execOverride = args =>
      args[0] === 'show-ref'
        ? {
            stdout: '',
            stderr: `fatal: '${ORIGIN_MAIN}' - not a valid ref`,
            code: 128,
          }
        : null

    const message = await captureThrownError(resolveGitRef(params))

    // v306 phrase: `found no such ref afterwards` (v304 said `returned no
    // commit for this ref afterwards`), command word = show-ref.
    expect(message).toBe(
      `Failed to resolve base branch "origin/main": the fetch from origin succeeded, but git show-ref found no such ref afterwards (for example in a single-branch clone of another branch, or a bare clone without a fetch refspec). ${BASE_REF_HEAD_HINT} ${MAY_NOT_BE_WORKING_MORE}`,
    )
    // Official `Je` annotation, byte-exact (emitted via logForDebugging).
    expect(
      capturedLogs.some(
        l =>
          l.level === 'warn' &&
          l.message ===
            'worktree base not resolved (base=origin_default, cause=name_missing, repo_confirmed=yes)',
      ),
    ).toBe(true)
  })

  test('modern git shape (exit 1, empty output) also classifies as name_missing', async () => {
    const { params } = makeResolveParams({ exactRef: true })
    execOverride = args =>
      args[0] === 'show-ref' ? { stdout: '', stderr: '', code: 1 } : null

    const message = await captureThrownError(resolveGitRef(params))

    expect(message).toBe(
      `Failed to resolve base branch "origin/main": the fetch from origin succeeded, but git show-ref found no such ref afterwards (for example in a single-branch clone of another branch, or a bare clone without a fetch refspec). ${BASE_REF_HEAD_HINT} ${MAY_NOT_BE_WORKING_MORE}`,
    )
  })

  test('the loose path defaults the command word to rev-parse (pre-306 callers stay byte-identical)', async () => {
    const { params } = makeResolveParams()
    execOverride = args =>
      args[0] === 'rev-parse' ? { stdout: '', stderr: '', code: 1 } : null

    const message = await captureThrownError(resolveGitRef(params))

    expect(message).toBe(
      `Failed to resolve base branch "origin/main": the fetch from origin succeeded, but git rev-parse found no such ref afterwards (for example in a single-branch clone of another branch, or a bare clone without a fetch refspec). ${BASE_REF_HEAD_HINT} ${MAY_NOT_BE_WORKING_MORE}`,
    )
  })

  test('a non-ve exit 128 classifies as git_refused and quotes the stderr line', async () => {
    const { params } = makeResolveParams({ exactRef: true })
    execOverride = args =>
      args[0] === 'show-ref'
        ? { stdout: '', stderr: 'fatal: some other problem', code: 128 }
        : null

    const message = await captureThrownError(resolveGitRef(params))

    expect(message).toBe(
      'Failed to resolve base branch "origin/main": git show-ref failed (git said “fatal: some other problem”).',
    )
  })

  test('a timeout classifies as timed_out and names show-ref', async () => {
    const { params } = makeResolveParams({ exactRef: true })
    execOverride = args =>
      args[0] === 'show-ref'
        ? { stdout: '', stderr: '', code: 124, error: 'timed out' }
        : null

    const message = await captureThrownError(resolveGitRef(params))

    expect(message).toBe(
      'Failed to resolve base branch "origin/main": git show-ref timed out.',
    )
  })

  test('no-repo stderr declines with the not-in-a-git-repo message (documented OCC deviation)', async () => {
    const { params } = makeResolveParams({ exactRef: true })
    execOverride = args =>
      args[0] === 'show-ref'
        ? {
            stdout: '',
            stderr: "fatal: not a git repository: 'refs/remotes/origin/main'",
            code: 128,
          }
        : null

    const message = await captureThrownError(resolveGitRef(params))

    expect(message).toBe(NOT_IN_GIT_REPO_MESSAGE)
  })
})

describe('2.1.306 #P8 — fetch-success end-to-end resolves the exact ref (real git)', () => {
  test('the worktree bases on origin/<default> via show-ref and the peeled sha start-point', async () => {
    const dir = makeTmpDir('occ-wt306-e2e-')
    const upstream = initRepoWithCommit(join(dir, 'upstream'), 'main')
    const repo = join(dir, 'repo')
    git(dir, 'clone', upstream, 'repo')

    const originSha = gitOut(repo, 'rev-parse', 'origin/main')
    // Delete the remote-tracking ref so the fs-only resolveRef fast path
    // (origin/<branch> already local → skip fetch) does NOT short-circuit;
    // the fetch must run and recreate the ref — the v306 exact-ref show-ref
    // resolution is what the fetch-success path must go through.
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/main')
    // A divergent LOCAL main proves the base comes from origin, not local HEAD.
    git(repo, 'checkout', '-B', 'main')
    git(
      repo,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@t',
      'commit',
      '--allow-empty',
      '-m',
      'local-only',
    )
    const localHead = gitOut(repo, 'rev-parse', 'HEAD')
    expect(localHead).not.toBe(originSha)

    setCwd(repo)
    resetGitFileWatcher()
    clearResolveGitDirCache()

    const result = await getOrCreateWorktree(repo, 'test-slug')

    // The exact-ref show-ref ran on the FULL remote-tracking ref.
    expect(capturedArgv).toContainEqual([
      'show-ref',
      '--verify',
      '--hash',
      'refs/remotes/origin/main',
    ])
    // The old shared abbrev path must NOT have run for origin/main (fetch
    // succeeded, so baseSha was already resolved).
    expect(capturedArgv).not.toContainEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'origin/main',
    ])
    // Unconditional v306 peel on the worktree-add start-point.
    const addArgv = capturedArgv.find(
      a => a[0] === 'worktree' && a[1] === 'add',
    )
    expect(addArgv?.[addArgv.length - 1]).toBe(`${originSha}^{commit}`)
    // headCommit is the ORIGIN sha (the v304 defect based on local HEAD).
    expect(result.headCommit).toBe(originSha)
    expect(gitOut(result.worktreePath, 'rev-parse', 'HEAD')).toBe(originSha)
  })
})

describe('2.1.306 #P8 — shouldRemoveUnchangedAgentWorktree (unchanged 必清)', () => {
  function makeWorktree(main: string, slug: string): string {
    const wtPath = join(dirnameOf(main), slug)
    git(main, 'worktree', 'add', '--detach', wtPath)
    return wtPath
  }

  function dirnameOf(path: string): string {
    return path.replace(/\/[^/]+$/, '')
  }

  test('headCommit present + unchanged worktree → remove', async () => {
    const dir = makeTmpDir('occ-wt306-clean-')
    const main = initRepoWithCommit(join(dir, 'main'))
    const head = gitOut(main, 'rev-parse', 'HEAD')
    const wtPath = makeWorktree(main, 'agent-a1b2c3d4')

    expect(
      await shouldRemoveUnchangedAgentWorktree({
        worktreePath: wtPath,
        headCommit: head,
      }),
    ).toBe(true)
  })

  test('headCommit present + dirty working tree → keep', async () => {
    const dir = makeTmpDir('occ-wt306-dirty-')
    const main = initRepoWithCommit(join(dir, 'main'))
    const head = gitOut(main, 'rev-parse', 'HEAD')
    const wtPath = makeWorktree(main, 'agent-a1b2c3d4')
    writeFileSync(join(wtPath, 'f.txt'), 'change')

    expect(
      await shouldRemoveUnchangedAgentWorktree({
        worktreePath: wtPath,
        headCommit: head,
      }),
    ).toBe(false)
  })

  test('headCommit present + new commit → keep', async () => {
    const dir = makeTmpDir('occ-wt306-commit-')
    const main = initRepoWithCommit(join(dir, 'main'))
    const head = gitOut(main, 'rev-parse', 'HEAD')
    const wtPath = makeWorktree(main, 'agent-a1b2c3d4')
    git(
      wtPath,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@t',
      'commit',
      '--allow-empty',
      '-m',
      'agent work',
    )

    expect(
      await shouldRemoveUnchangedAgentWorktree({
        worktreePath: wtPath,
        headCommit: head,
      }),
    ).toBe(false)
  })

  test('headCommit MISSING + ephemeral slug + status-clean → remove (v306 fallback)', async () => {
    const dir = makeTmpDir('occ-wt306-fallback-')
    const main = initRepoWithCommit(join(dir, 'main'))
    const wtPath = makeWorktree(main, 'agent-a1b2c3d4')

    expect(
      await shouldRemoveUnchangedAgentWorktree({ worktreePath: wtPath }),
    ).toBe(true)
  })

  test('headCommit MISSING + ephemeral slug + dirty → keep', async () => {
    const dir = makeTmpDir('occ-wt306-fbdirty-')
    const main = initRepoWithCommit(join(dir, 'main'))
    const wtPath = makeWorktree(main, 'agent-a1b2c3d4')
    writeFileSync(join(wtPath, 'f.txt'), 'change')

    expect(
      await shouldRemoveUnchangedAgentWorktree({ worktreePath: wtPath }),
    ).toBe(false)
  })

  test('headCommit MISSING + non-ephemeral (user-named) path → keep even when clean', async () => {
    const dir = makeTmpDir('occ-wt306-fbnamed-')
    const main = initRepoWithCommit(join(dir, 'main'))
    const wtPath = makeWorktree(main, 'my-feature')

    expect(
      await shouldRemoveUnchangedAgentWorktree({ worktreePath: wtPath }),
    ).toBe(false)
  })

  test('headCommit MISSING + ephemeral slug + git status fails → keep (fail-closed)', async () => {
    const dir = makeTmpDir('occ-wt306-fbgone-')
    const missing = join(dir, 'agent-a1111111')

    expect(
      await shouldRemoveUnchangedAgentWorktree({ worktreePath: missing }),
    ).toBe(false)
  })
})

describe('2.1.306 #P8 — isEphemeralWorktreePath slug patterns', () => {
  test('matches each EPHEMERAL_WORKTREE_PATTERNS shape via the basename', () => {
    expect(isEphemeralWorktreePath('/r/.claude/worktrees/agent-a1b2c3d4')).toBe(
      true,
    )
    expect(isEphemeralWorktreePath('wf_deadbeef-1a2-3')).toBe(true)
    expect(isEphemeralWorktreePath('wf-42')).toBe(true)
    expect(isEphemeralWorktreePath('bridge-foo_bar-baz')).toBe(true)
    expect(isEphemeralWorktreePath('job-my.task_x-1a2b3c4d')).toBe(true)
  })

  test('rejects near-misses and user-named slugs', () => {
    expect(isEphemeralWorktreePath('agent-a1b2c3d')).toBe(false) // 6 hex, not 7
    expect(isEphemeralWorktreePath('agent-a1b2c3d45')).toBe(false) // 8 hex, not 7
    expect(isEphemeralWorktreePath('Agent-a1b2c3d4')).toBe(false) // case-sensitive
    expect(isEphemeralWorktreePath('my-feature')).toBe(false)
    expect(isEphemeralWorktreePath('wf-deadbeef-1a2-3')).toBe(false)
  })
})
