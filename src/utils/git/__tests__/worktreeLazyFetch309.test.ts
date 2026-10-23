/**
 * Official Claude Code 2.1.309 changelog item 56 — worktree lazy-fetch
 * hardening + partial-clone pre-fetch.
 *
 * Source of truth: BIN309 lazy-fetch module @252742600..@252780600 (byte-verified
 * via read-only forensics; binary never executed). Official symbols → OCC names
 * are mapped in the filedoc of ../worktreeLazyFetch.ts (with the 7 declared
 * deviations). These tests pin:
 *   - the verbatim constants (W1r/G1r/Lst/z1r/RGr/ase/g6r/oli/Kn),
 *   - yne's env shape (GIT_NO_LAZY_FETCH:"1" + GIT_ALLOW_PROTOCOL:"/"),
 *   - Dst/Mxe remote-name safety + display,
 *   - Cke/zXe/SF hidden-char guards,
 *   - yO+sA stderr sanitization (ANSI strip + credential redaction),
 *   - yxo partial-clone detection against REAL temp git repos (incl. the
 *     `key\nvalue\0` --null get-regexp format),
 *   - J1r/eGr config reads,
 *   - QPn missing-object enumeration against a real repo with a deleted blob,
 *   - Fst's byte-verbatim diagnostics (both branches) + detector regex,
 *   - ZPn's branch table (gate / no-promisor / sandboxed),
 *   - $st bounded prefetch (early return, no-URL diagnostic, fetch-failure
 *     diagnostic against an unreachable local promisor URL).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ALTERNATE_REFS_ARGS,
  ALTERNATE_REFS_COMMAND,
  DEFAULT_FETCH_BUDGET_MINUTES,
  FETCH_RETRY_SLACK,
  GIT_UPLOAD_PACK_DEFAULT,
  LAZY_FETCH_FAILURE_RE,
  LIST_MISSING_MAX_BUFFER,
  MORE_OBJECTS_THAN_LISTABLE,
  PARTIAL_CLONE_CONFIG_RE,
  RESUME_FETCH_BUDGET_MINUTES,
  computePartialCloneContext,
  containsHiddenOrControlChars,
  detectPartialClone,
  displayRemoteName,
  displaySubmodulePath,
  formatLazyFetchFailure,
  guardHiddenChars,
  isEagerBalloonEnabled,
  isSafeRemoteName,
  isWorktreeFetchSandboxed,
  lazyFetchEnv,
  listMissingObjects,
  prefetchMissingObjects,
  promisorDisplayList,
  promisorRemoteHasUrl,
  remoteUploadPackArg,
  sanitizeGitStderr,
} from '../worktreeLazyFetch.js'

// -- temp-repo helpers (same convention as branchNotARepo309.test.ts) ---------

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

function git(dir: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

function initRepoWithCommit(): { dir: string; blob: string; commit: string } {
  const dir = makeTempDir('lazyfetch-')
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  Bun.write(join(dir, 'f.txt'), 'hello\n')
  git(dir, ['add', 'f.txt'])
  git(dir, ['commit', '-qm', 'c1'])
  const blob = git(dir, ['rev-parse', 'HEAD:f.txt']).trim()
  const commit = git(dir, ['rev-parse', 'HEAD']).trim()
  return { dir, blob, commit }
}

function deleteLooseObject(dir: string, oid: string): void {
  rmSync(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), {
    force: true,
  })
}

// -- constants (verbatim from BIN309) -----------------------------------------

describe('item 56 — verbatim constants', () => {
  test('G1r/Lst/z1r/W1r/RGr/ase are byte-verbatim', () => {
    expect(LIST_MISSING_MAX_BUFFER).toBe(67_108_864)
    expect(MORE_OBJECTS_THAN_LISTABLE).toBe(
      'more objects are missing than can be listed',
    )
    expect(DEFAULT_FETCH_BUDGET_MINUTES).toBe(10)
    expect(FETCH_RETRY_SLACK).toBe(2)
    expect(RESUME_FETCH_BUDGET_MINUTES).toBe(2)
    expect(GIT_UPLOAD_PACK_DEFAULT).toBe('--upload-pack=git-upload-pack')
  })

  test('g6r alternate-refs command + oli args are verbatim and frozen', () => {
    expect(ALTERNATE_REFS_COMMAND).toBe(
      'f() { git --git-dir="$1" for-each-ref --format=\'%(objectname)\'; }; f',
    )
    expect(ALTERNATE_REFS_ARGS).toEqual([
      '-c',
      `core.alternateRefsCommand=${ALTERNATE_REFS_COMMAND}`,
    ])
    expect(Object.isFrozen(ALTERNATE_REFS_ARGS)).toBe(true)
  })

  test('Kn partial-clone config regex source is verbatim', () => {
    expect(PARTIAL_CLONE_CONFIG_RE.source).toBe(
      '^remote\\.(.*)\\.(promisor|partialclonefilter)$',
    )
    expect(PARTIAL_CLONE_CONFIG_RE.flags).toContain('s')
  })

  test('Fst detector regex matches the three official stderr shapes', () => {
    expect(LAZY_FETCH_FAILURE_RE.test("fatal: lazy fetching disabled")).toBe(
      true,
    )
    expect(
      LAZY_FETCH_FAILURE_RE.test(
        'error: could not fetch 0123456789abcdef0123456789abcdef01234567 from promisor remote',
      ),
    ).toBe(true)
    expect(LAZY_FETCH_FAILURE_RE.test("fatal: transport 'ssh' not allowed")).toBe(
      true,
    )
    expect(LAZY_FETCH_FAILURE_RE.test('fatal: some unrelated failure')).toBe(
      false,
    )
  })
})

// -- yne / Dst / Mxe ----------------------------------------------------------

describe('item 56 — lazyFetchEnv (official yne)', () => {
  test('inForce → GIT_NO_LAZY_FETCH:"1" + GIT_ALLOW_PROTOCOL:"/"', () => {
    expect(lazyFetchEnv({ inForce: true })).toEqual({
      GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: '/',
    })
  })

  test('not inForce → undefined (no env overlay)', () => {
    expect(lazyFetchEnv({ inForce: false })).toBeUndefined()
  })
})

describe('item 56 — remote-name safety (official Dst/Mxe)', () => {
  test('isSafeRemoteName accepts alnum-leading . _ / @ + - names', () => {
    expect(isSafeRemoteName('origin')).toBe(true)
    expect(isSafeRemoteName('my-remote_2.x')).toBe(true)
    expect(isSafeRemoteName('a/b+c@d')).toBe(true)
  })

  test('isSafeRemoteName rejects leading dash, empty, spaces, shell chars', () => {
    expect(isSafeRemoteName('-origin')).toBe(false)
    expect(isSafeRemoteName('')).toBe(false)
    expect(isSafeRemoteName('or igin')).toBe(false)
    expect(isSafeRemoteName('or;igin')).toBe(false)
    expect(isSafeRemoteName('$(evil)')).toBe(false)
  })

  test('displayRemoteName quotes safe names; verbatim refusal otherwise', () => {
    expect(displayRemoteName('origin')).toBe('"origin"')
    expect(displayRemoteName('-x')).toBe(
      '(name not shown: it does not begin with a letter or digit, or has characters other than letters, digits and . _ / @ + -)',
    )
  })
})

// -- Cke / zXe / SF -----------------------------------------------------------

describe('item 56 — hidden-char guards (official Cke/zXe/SF)', () => {
  test('containsHiddenOrControlChars flags C0, DEL, C1, invisible chars', () => {
    expect(containsHiddenOrControlChars('plain text')).toBe(false)
    expect(containsHiddenOrControlChars('a\u0000b')).toBe(true)
    expect(containsHiddenOrControlChars('a\u001bb')).toBe(true)
    expect(containsHiddenOrControlChars('a\u007fb')).toBe(true)
    expect(containsHiddenOrControlChars('a\u0085b')).toBe(true)
    expect(containsHiddenOrControlChars('a\u200bb')).toBe(true)
  })

  test('guardHiddenChars passes clean text, hides dirty text with label', () => {
    expect(guardHiddenChars('line1\nline2', "git's error")).toBe(
      'line1\nline2',
    )
    expect(guardHiddenChars('a\u0000b', "git's error")).toBe(
      "git's error is not shown here because it holds hidden or control characters",
    )
  })

  test('displaySubmodulePath (official SF) hides control-char paths', () => {
    expect(displaySubmodulePath('sub/mod')).toBe('sub/mod')
    expect(displaySubmodulePath('sub\u001b/mod')).toBe(
      'a path not shown here because it holds hidden or control characters',
    )
  })
})

// -- promisorDisplayList (official Q1r) ----------------------------------------

describe('item 56 — promisorDisplayList (official Q1r)', () => {
  test('null/undefined detection → empty list', () => {
    expect(promisorDisplayList(null)).toEqual([])
    expect(promisorDisplayList(undefined)).toEqual([])
  })

  test('no extension → remotes as-is', () => {
    expect(
      promisorDisplayList({ extension: null, remotes: ['a', 'b'] }),
    ).toEqual(['a', 'b'])
  })

  test('extension moves to the end, deduped', () => {
    expect(
      promisorDisplayList({ extension: 'b', remotes: ['a', 'b'] }),
    ).toEqual(['a', 'b'])
    expect(promisorDisplayList({ extension: 'c', remotes: ['a'] })).toEqual([
      'a',
      'c',
    ])
  })
})

// -- sanitizeGitStderr (deviation #6: yO+sA) -----------------------------------

describe('item 56 — sanitizeGitStderr', () => {
  test('strips ANSI sequences', () => {
    expect(sanitizeGitStderr('a\u001b[31mred\u001b[0mb')).toBe('aredb')
  })

  test('redacts URL credentials so stderr cannot leak tokens', () => {
    expect(
      sanitizeGitStderr(
        'fatal: unable to access https://user:secret@example.com/repo/',
      ),
    ).toBe('fatal: unable to access https://example.com/repo/')
  })

  test('trims surrounding whitespace', () => {
    expect(sanitizeGitStderr('  boom\n')).toBe('boom')
  })
})

// -- gates ---------------------------------------------------------------------

describe('item 56 — gates', () => {
  test('isEagerBalloonEnabled returns the safe default true (q1r safe:!0)', () => {
    expect(isEagerBalloonEnabled()).toBe(true)
  })

  test('isWorktreeFetchSandboxed returns a boolean without throwing', () => {
    expect(typeof isWorktreeFetchSandboxed()).toBe('boolean')
  })
})

// -- real-repo git interactions (yxo / J1r / eGr / QPn) ------------------------

describe('item 56 — detectPartialClone against real repos (official yxo)', () => {
  test('plain repo → null (confirmed not a partial clone)', async () => {
    const { dir } = initRepoWithCommit()
    expect(await detectPartialClone(dir)).toBeNull()
  })

  test('promisor + extensions.partialclone → detected', async () => {
    const { dir } = initRepoWithCommit()
    git(dir, ['config', 'remote.origin.promisor', 'true'])
    git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
    git(dir, ['config', 'extensions.partialclone', 'origin'])
    expect(await detectPartialClone(dir)).toEqual({
      extension: 'origin',
      remotes: ['origin'],
    })
  })

  test('partialclonefilter alone → promisor without extension', async () => {
    const { dir } = initRepoWithCommit()
    git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
    expect(await detectPartialClone(dir)).toEqual({
      extension: null,
      remotes: ['origin'],
    })
  })

  test('falsy promisor value is not a promisor', async () => {
    const { dir } = initRepoWithCommit()
    git(dir, ['config', 'remote.origin.promisor', 'false'])
    expect(await detectPartialClone(dir)).toEqual({
      extension: null,
      remotes: [],
    })
  })
})

describe('item 56 — promisorRemoteHasUrl / remoteUploadPackArg (J1r/eGr)', () => {
  test('url set → true; promisor without url → false', async () => {
    const { dir } = initRepoWithCommit()
    git(dir, ['config', 'remote.origin.url', '/tmp/does-not-matter.git'])
    expect(await promisorRemoteHasUrl(dir, 'origin')).toBe(true)
    expect(await promisorRemoteHasUrl(dir, 'other')).toBe(false)
  })

  test('uploadpack unset → undefined; set → --upload-pack=<value>', async () => {
    const { dir } = initRepoWithCommit()
    expect(await remoteUploadPackArg(dir, 'origin')).toBeUndefined()
    git(dir, ['config', '--local', 'remote.origin.uploadpack', '/bin/true'])
    expect(await remoteUploadPackArg(dir, 'origin')).toBe(
      '--upload-pack=/bin/true',
    )
  })
})

describe('item 56 — listMissingObjects against real repos (official QPn)', () => {
  test('complete repo → empty list', async () => {
    const { dir, commit } = initRepoWithCommit()
    expect(await listMissingObjects(dir, commit)).toEqual([])
  })

  test('deleted blob → its OID listed (before first space)', async () => {
    const { dir, blob, commit } = initRepoWithCommit()
    deleteLooseObject(dir, blob)
    expect(await listMissingObjects(dir, commit)).toEqual([blob])
  })

  test('unknown commit → diagnostic string, never throws', async () => {
    const { dir } = initRepoWithCommit()
    const result = await listMissingObjects(dir, 'deadbeefdeadbeef')
    expect(typeof result).toBe('string')
  })
})

// -- Fst verbatim diagnostics ---------------------------------------------------

describe('item 56 — formatLazyFetchFailure (official Fst, verbatim)', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01'
  const short = 'abcdef012345'

  test('stderr without the detector shapes → empty string', () => {
    expect(formatLazyFetchFailure('fatal: reference is not a tree', {}, sha)).toBe(
      '',
    )
  })

  test('non-submodule branch is byte-verbatim', () => {
    expect(formatLazyFetchFailure('fatal: lazy fetching disabled', {}, sha)).toBe(
      `\nThis checkout ran with git's on-demand fetching switched off, and git needed an object this repository does not have. If the repository is a partial clone, run "git archive -o objects.tar ${short}" (git fetches the commit's missing files — in a sparse checkout, the whole tree's; delete objects.tar afterwards) in its main checkout and try again; otherwise check it with "git fsck".`,
    )
  })

  test('missing baseCommit → "<the base commit>" placeholder', () => {
    const text = formatLazyFetchFailure('fatal: lazy fetching disabled')
    expect(text).toContain('git archive -o objects.tar <the base commit>')
  })

  test('submodule branch is byte-verbatim (unreachable in the bounded port)', () => {
    const text = formatLazyFetchFailure(
      'fatal: lazy fetching disabled',
      { submodule: 'sub/mod' },
      sha,
    )
    expect(text).toContain(
      `This repository is a git submodule, and its git folder, "sub/mod", is kept inside the superproject's git folder`,
    )
    expect(text).toContain(
      `Then fetch the missing objects for commit ${short} in the submodule yourself and try again.`,
    )
  })
})

// -- ZPn branch table -----------------------------------------------------------

describe('item 56 — computePartialCloneContext (official ZPn, non-submodule branch)', () => {
  test('plain repo (no promisors) → inForce true, empty promisors', async () => {
    const { dir } = initRepoWithCommit()
    // Official: H.length===0 → {inForce:!0,promisors:H} regardless of sandbox.
    expect(
      await computePartialCloneContext(dir, () => false),
    ).toEqual({ inForce: true, promisors: [] })
  })

  test('promisor repo + sandboxed → inForce true with promisor list', async () => {
    const { dir } = initRepoWithCommit()
    git(dir, ['config', 'remote.origin.promisor', 'true'])
    git(dir, ['config', 'extensions.partialclone', 'origin'])
    expect(await computePartialCloneContext(dir, () => true)).toEqual({
      inForce: true,
      promisors: ['origin'],
    })
  })

  test('promisor repo + NOT sandboxed → lazy fetch stays on (YPn)', async () => {
    const { dir } = initRepoWithCommit()
    git(dir, ['config', 'remote.origin.promisor', 'true'])
    git(dir, ['config', 'extensions.partialclone', 'origin'])
    expect(await computePartialCloneContext(dir, () => false)).toEqual({
      inForce: false,
      promisors: [],
    })
  })
})

// -- $st bounded prefetch --------------------------------------------------------

describe('item 56 — prefetchMissingObjects (official $st, bounded)', () => {
  test('empty promisors → immediate success, no git calls', async () => {
    const { dir, commit } = initRepoWithCommit()
    expect(
      await prefetchMissingObjects(dir, commit, {
        inForce: true,
        promisors: [],
      }),
    ).toEqual({ failure: null, fetches: 0 })
  })

  test('complete repo → success without fetching', async () => {
    const { dir, commit } = initRepoWithCommit()
    git(dir, ['config', 'remote.origin.url', '/nonexistent/repo.git'])
    expect(
      await prefetchMissingObjects(dir, commit, {
        inForce: true,
        promisors: ['origin'],
      }),
    ).toEqual({ failure: null, fetches: 0 })
  })

  test('missing blob + promisor without URL → verbatim no-URL diagnostic', async () => {
    const { dir, blob, commit } = initRepoWithCommit()
    deleteLooseObject(dir, blob)
    const result = await prefetchMissingObjects(dir, commit, {
      inForce: true,
      promisors: ['origin'],
    })
    expect(result.fetches).toBe(0)
    expect(result.failure).toBe(
      `This repository is a partial clone, but its promisor remote "origin" has no URL in the repository's git config (remote.origin.url is not set), so the object needed for commit ${commit.slice(0, 12)} could not be fetched. Set it with "git config remote.origin.url <url>" and try again.`,
    )
  })

  test('missing blob + unreachable promisor URL → fetch-failure diagnostic, failed fetch not counted', async () => {
    const { dir, blob, commit } = initRepoWithCommit()
    deleteLooseObject(dir, blob)
    git(dir, ['config', 'remote.origin.url', '/nonexistent/repo.git'])
    const result = await prefetchMissingObjects(dir, commit, {
      inForce: true,
      promisors: ['origin'],
    })
    // Official: the failed attempt is un-counted (Se--) and the failing remote
    // is dropped, so the loop ends with fetches back at 0.
    expect(result.fetches).toBe(0)
    expect(result.failure).not.toBeNull()
    const failure = result.failure as string
    expect(failure).toContain(
      `This repository is a partial clone, and an object needed for commit ${commit.slice(0, 12)} could not be fetched from its promisor remote "origin" before checking it out (Claude Code checks worktrees out with git's on-demand fetching switched off).`,
    )
    expect(failure).toContain('(for example "git fetch origin")')
    expect(failure).toContain('git said: ')
  })
})
