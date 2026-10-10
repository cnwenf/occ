// Repo-convention MACRO polyfill (must run before toolExecution.js loads).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { describe, expect, test } from 'bun:test'

const {
  isGitCommitCommandShape,
  readGitHeadState,
  resolveGitCommitInfo,
} = await import('../toolExecution.js')

/**
 * CC 2.1.296 (#044): OTel `git_commit_id` for commits made via
 * `git commit -q` and `git -C <dir> commit` (changelog: these forms went
 * unrecorded in telemetry tool_details).
 *
 * Official 296 gate + flow (ev-otelgit296.txt):
 *   `R7t(e,n)=xd()&&(e.name===Bash||e.name===PowerShell)&&typeof n==="object"
 *     &&n!==null&&"command"in n&&typeof n.command==="string"&&Oss(n.command)`
 *   pre:  `Ur=await ZTo(uo)`            (HEAD state at session cwd, before)
 *   post: `Ka=await Mss(String(gr.data.stdout),cwd,ui?Ur:void 0)`
 *         with `ui=!backgroundTaskId&&!interrupted`
 *   set:  `ts.git_commit_id=Ka.commitId; if(Ka.branch)ts.git_branch=Ka.branch`
 *
 * `Oss`/`ZTo`/`Mss` definitions are NOT in the evidence. OCC's documented
 * adaptation (toolExecution.ts): the command-shape matcher mirrors OCC's
 * established `gitCmdRe` tolerance pattern (interspersed `-c`/`-C <arg>` and
 * `--k=v` global options), and the post-resolution keeps the stdout
 * `[branch sha]` parse first (parseGitCommitId) with the pre/post HEAD-state
 * diff as the fallback that makes the quiet (`-q`, empty stdout) form
 * visible — the same mechanism the official pre-state read implies.
 */

describe('2.1.296 #044 — isGitCommitCommandShape (official Oss half of R7t)', () => {
  test('plain `git commit` matches', () => {
    expect(isGitCommitCommandShape('git commit -m "x"')).toBe(true)
  })

  test('the quiet form `git commit -q` matches (changelog case 1)', () => {
    expect(isGitCommitCommandShape('git commit -q')).toBe(true)
    expect(isGitCommitCommandShape('git commit -q -m "msg"')).toBe(true)
  })

  test('the global-option form `git -C <dir> commit` matches (changelog case 2)', () => {
    expect(isGitCommitCommandShape('git -C /some/repo commit')).toBe(true)
    expect(isGitCommitCommandShape('git -C ../other commit -m "y"')).toBe(true)
  })

  test('interspersed config/global flags before the subcommand match', () => {
    expect(
      isGitCommitCommandShape('git -c user.name=x -c user.email=y commit -m z'),
    ).toBe(true)
    expect(
      isGitCommitCommandShape('git --git-dir=/d --work-tree=/w commit'),
    ).toBe(true)
    expect(isGitCommitCommandShape('git -C /x -c a=b commit -q')).toBe(true)
  })

  test('a commit inside a compound command line matches (\\b prefix)', () => {
    expect(isGitCommitCommandShape('cd repo && git commit -q')).toBe(true)
  })

  test('non-commit git commands do not match', () => {
    expect(isGitCommitCommandShape('git push origin main')).toBe(false)
    expect(isGitCommitCommandShape('git checkout -b feat')).toBe(false)
    expect(isGitCommitCommandShape('git status')).toBe(false)
  })

  test('non-git commands do not match', () => {
    expect(isGitCommitCommandShape('ls -la')).toBe(false)
    expect(isGitCommitCommandShape('notgit commit')).toBe(false)
    expect(isGitCommitCommandShape('gitcommit')).toBe(false)
    expect(isGitCommitCommandShape('git commitx')).toBe(false)
  })
})

describe('2.1.296 #044 — readGitHeadState (official ZTo analog, session cwd)', () => {
  // Hermetic via the injectable exec seam: dedicated mock.module test files
  // (execFileNoThrow mockers) are process-global in bun and would otherwise
  // flip real-git spawns to code 1 depending on shard composition.
  const NEW_SHA = 'b'.repeat(40)

  function fakeGitExec(overrides: {
    head?: { code: number; stdout: string }
    branch?: { code: number; stdout: string }
  }) {
    return (async (_cmd: string, args: string[]) => {
      if (args.includes('HEAD') && !args.includes('--abbrev-ref')) {
        const h = overrides.head ?? { code: 0, stdout: `${NEW_SHA}\n` }
        return { code: h.code, stdout: h.stdout, stderr: '' }
      }
      const b = overrides.branch ?? { code: 0, stdout: 'feature/x\n' }
      return { code: b.code, stdout: b.stdout, stderr: '' }
    }) as never
  }

  test('reads the HEAD sha + branch from the git rev-parse pair', async () => {
    // Arrange / Act
    const state = await readGitHeadState(fakeGitExec({}))

    // Assert — a full 40-hex sha; branch name trimmed.
    expect(state).toBeDefined()
    expect(state?.headSha).toBe(NEW_SHA)
    expect(state?.branch).toBe('feature/x')
  })

  test('detached HEAD (literal "HEAD" branch) leaves branch undefined', async () => {
    const state = await readGitHeadState(
      fakeGitExec({ branch: { code: 0, stdout: 'HEAD\n' } }),
    )
    expect(state?.headSha).toBe(NEW_SHA)
    expect(state?.branch).toBeUndefined()
  })

  test('both rev-parses failing (not a git repo) → undefined', async () => {
    const state = await readGitHeadState(
      fakeGitExec({
        head: { code: 128, stdout: '' },
        branch: { code: 128, stdout: '' },
      }),
    )
    expect(state).toBeUndefined()
  })
})

describe('2.1.296 #044 — resolveGitCommitInfo (official Mss analog)', () => {
  test('stdout `[branch sha]` parse wins (plain non-quiet commit, pre-296 path)', async () => {
    // Arrange
    const stdout = '[main 0123abc] my commit message\n 1 file changed'

    // Act
    const info = await resolveGitCommitInfo(stdout, undefined)

    // Assert
    expect(info).toEqual({ commitId: '0123abc' })
  })

  test('root-commit stdout form parses too', async () => {
    // Arrange
    const stdout = '[main (root-commit) 9abcdef) msg'
    const wellFormed = '[main (root-commit) 9abcdef0] msg'

    // Act / Assert — the regex requires a closing `]` after the sha.
    expect(await resolveGitCommitInfo(stdout, undefined)).toBeUndefined()
    expect(await resolveGitCommitInfo(wellFormed, undefined)).toEqual({
      commitId: '9abcdef0',
    })
  })

  test('empty stdout (`git commit -q`) with NO pre-state → undefined (no post spawn, official ui gate)', async () => {
    // Arrange / Act — preState undefined mirrors background/interrupted runs
    // where the official passes `ui?Ur:void 0` → void 0.
    const info = await resolveGitCommitInfo('', undefined)

    // Assert
    expect(info).toBeUndefined()
  })

  // The HEAD-diff tests inject a fake git exec (hermetic — see the seam note
  // in the readGitHeadState block above).
  const POST_SHA = 'c'.repeat(40)
  const fakePostExec = ((async (_cmd: string, args: string[]) => {
    if (args.includes('HEAD') && !args.includes('--abbrev-ref')) {
      return { code: 0, stdout: `${POST_SHA}\n`, stderr: '' }
    }
    return { code: 0, stdout: 'main\n', stderr: '' }
  }) as never)

  test('empty stdout with a stale pre-state resolves via the HEAD diff (the #044 fix)', async () => {
    // Arrange — a pre-state sha that cannot equal the post-commit HEAD.
    const stale = { headSha: 'deadbeef'.repeat(5), branch: 'stale-branch' }

    // Act
    const info = await resolveGitCommitInfo('', stale, fakePostExec)

    // Assert — the new HEAD sha is reported as the commit id.
    expect(info).toBeDefined()
    expect(info?.commitId).toBe(POST_SHA)
    expect(info?.commitId).toMatch(/^[0-9a-f]{40}$/)
  })

  test('root-commit shape: pre-state without headSha resolves through the diff', async () => {
    // Arrange — pre HEAD unreadable (fresh repo), post HEAD present.
    const preRoot = { headSha: undefined, branch: undefined }

    // Act
    const info = await resolveGitCommitInfo('', preRoot, fakePostExec)

    // Assert
    expect(info?.commitId).toBe(POST_SHA)
  })

  test('unchanged HEAD (failed/aborted commit) → undefined', async () => {
    // Arrange — pre-state IS the post HEAD, so the diff finds no change.
    const current = { headSha: POST_SHA, branch: 'main' }

    // Act
    const info = await resolveGitCommitInfo('', current, fakePostExec)

    // Assert
    expect(info).toBeUndefined()
  })

  test('branch travels with the diff-resolved commit id (official `if(Ka.branch)ts.git_branch`)', async () => {
    // Arrange
    const stale = { headSha: 'deadbeef'.repeat(5) }

    // Act
    const info = await resolveGitCommitInfo('', stale, fakePostExec)

    // Assert — the post-state branch name rides along with the commit id.
    expect(info?.branch).toBe('main')
  })
})
