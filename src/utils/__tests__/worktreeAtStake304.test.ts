/**
 * Official Claude Code 2.1.304 #30 — worktree-exit "at stake" subsystem
 * (`wV` / `QEn` / `G$r` / `nOt` / `tOt`, byte-recovered @249016065 — see
 * docs/gap-research-304/research-R6-env-misc.md #30).
 *
 * Unit tests for the pure git-command layer in src/utils/worktree.ts:
 * - countCommitsOnRefs (`wV`)     — rev-list --count with ^negative refs + --
 * - branchMissing (`QEn`)          — for-each-ref --count=1 empty → missing
 * - classifyWorktreeHead (`G$r`)   — symbolic-ref HEAD classifier (its_branch
 *   / another_branch / like_its_branch / detached / unreadable / null)
 * - computeWorktreeExitAtStake (`nOt`) — not_read fallback + onKeptBranch
 *   refinement
 * - formatAtStakePhrase (`tOt`)    — subtitle phrasing
 *
 * All git execution is mocked at the execFileNoThrowWithCwd seam; argv shapes
 * are asserted against the official command lines.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as REAL_EXEC_NS from '../execFileNoThrow.js'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// OCC-97 pattern: snapshot the real exports BEFORE mocking and restore them in
// afterAll — Bun's mock.module crosses file boundaries in the same worker, and
// the real-git worktree integration tests (worktreeCreateErrors299 etc.) must
// see the unmocked exec layer.
const REAL_EXEC_SNAPSHOT = { ...REAL_EXEC_NS }

type GitResult = { stdout: string; stderr: string; code: number }

const OK: GitResult = { stdout: '', stderr: '', code: 0 }
const FAIL: GitResult = { stdout: '', stderr: 'fatal: bad revision', code: 128 }

/** Per-test responder: args → git result. */
let gitImpl: (args: string[]) => GitResult = () => OK
const gitCalls: Array<{ args: string[]; cwd: string | undefined }> = []

await mock.module('../execFileNoThrow.js', () => ({
  ...REAL_EXEC_SNAPSHOT,
  execFileNoThrowWithCwd: async (
    _file: string,
    args: string[],
    opts?: { cwd?: string },
  ) => {
    gitCalls.push({ args, cwd: opts?.cwd })
    return { ...gitImpl(args), error: undefined }
  },
}))

const {
  countCommitsOnRefs,
  branchMissing,
  classifyWorktreeHead,
  computeWorktreeExitAtStake,
  formatAtStakePhrase,
} = await import('../worktree.js')

const SESSION = {
  worktreePath: '/repo/.claude/worktrees/wt',
  worktreeBranch: 'claude/wt',
  originalHeadCommit: 'base123',
  hookBased: false,
}

function lastArgs(): string[] {
  return gitCalls[gitCalls.length - 1]!.args
}

function findArgs(subcommand: string): string[][] {
  return gitCalls.filter(c => c.args[0] === subcommand).map(c => c.args)
}

/** Dispatch helpers for common argv shapes. */
function implBySubcommand(map: {
  [sub: string]: GitResult | ((args: string[]) => GitResult)
}): (args: string[]) => GitResult {
  return args => {
    const entry = map[args[0]!]
    if (entry === undefined) {
      return OK
    }
    return typeof entry === 'function' ? entry(args) : entry
  }
}

beforeEach(() => {
  gitImpl = () => OK
  gitCalls.length = 0
})

afterEach(() => {
  mock.restore()
})

afterAll(() => {
  // Restore the real exec layer for every later test file in this worker.
  mock.module('../execFileNoThrow.js', () => ({ ...REAL_EXEC_SNAPSHOT }))
})

// ---------------------------------------------------------------------------
// countCommitsOnRefs (`wV`)
// ---------------------------------------------------------------------------

describe('countCommitsOnRefs (official wV)', () => {
  test('counts positive refs minus ^negative refs with the official argv shape', async () => {
    // Arrange
    gitImpl = () => ({ stdout: '3\n', stderr: '', code: 0 })

    // Act
    const count = await countCommitsOnRefs(
      '/wt',
      ['refs/heads/b', 'HEAD'],
      ['base123'],
    )

    // Assert
    expect(count).toBe(3)
    expect(lastArgs()).toEqual([
      'rev-list',
      '--count',
      'refs/heads/b',
      'HEAD',
      '^base123',
      '--',
    ])
    expect(gitCalls[0]!.cwd).toBe('/wt')
  })

  test('returns null on git failure (fail-closed)', async () => {
    // Arrange
    gitImpl = () => FAIL

    // Act & Assert
    expect(await countCommitsOnRefs('/wt', ['HEAD'], ['base'])).toBeNull()
  })

  test('returns null on non-numeric stdout even with code 0', async () => {
    // Arrange
    gitImpl = () => ({ stdout: 'not-a-number\n', stderr: '', code: 0 })

    // Act & Assert
    expect(await countCommitsOnRefs('/wt', ['HEAD'], ['base'])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// branchMissing (`QEn`)
// ---------------------------------------------------------------------------

describe('branchMissing (official QEn)', () => {
  test('true when for-each-ref exits 0 with empty stdout and stderr', async () => {
    // Arrange
    gitImpl = () => OK

    // Act
    const missing = await branchMissing('/wt', 'claude/wt')

    // Assert
    expect(missing).toBe(true)
    expect(lastArgs()).toEqual([
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      'refs/heads/claude/wt',
    ])
  })

  test('false when the ref prints (branch exists)', async () => {
    // Arrange
    gitImpl = () => ({ stdout: 'refs/heads/claude/wt\n', stderr: '', code: 0 })

    // Act & Assert
    expect(await branchMissing('/wt', 'claude/wt')).toBe(false)
  })

  test('false when git fails (non-zero exit → unknown → not "missing")', async () => {
    // Arrange
    gitImpl = () => FAIL

    // Act & Assert
    expect(await branchMissing('/wt', 'claude/wt')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// classifyWorktreeHead (`G$r`)
// ---------------------------------------------------------------------------

describe('classifyWorktreeHead (official G$r)', () => {
  test('returns null for hook-based worktrees without any git call', async () => {
    // Act
    const result = await classifyWorktreeHead({ ...SESSION, hookBased: true })

    // Assert
    expect(result).toBeNull()
    expect(gitCalls.length).toBe(0)
  })

  test('returns null when no worktreeBranch is recorded', async () => {
    // Act
    const result = await classifyWorktreeHead({
      ...SESSION,
      worktreeBranch: undefined,
    })

    // Assert
    expect(result).toBeNull()
    expect(gitCalls.length).toBe(0)
  })

  test('its_branch: HEAD on the session branch, counts on refs/heads/<branch> vs baseline', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/claude/wt\n', stderr: '', code: 0 },
      'rev-list': { stdout: '2\n', stderr: '', code: 0 },
    })

    // Act
    const result = await classifyWorktreeHead(SESSION)

    // Assert
    expect(result).toEqual({ head: 'its_branch', commits: 2 })
    expect(lastArgs()).toEqual([
      'rev-list',
      '--count',
      'refs/heads/claude/wt',
      '^base123',
      '--',
    ])
  })

  test('its_branch without baseline: commits null and no rev-list call', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/claude/wt\n', stderr: '', code: 0 },
    })

    // Act
    const result = await classifyWorktreeHead({
      ...SESSION,
      originalHeadCommit: undefined,
    })

    // Assert
    expect(result).toEqual({ head: 'its_branch', commits: null })
    expect(findArgs('rev-list').length).toBe(0)
  })

  test('another_branch: HEAD moved off; counts our branch minus the other branch and baseline', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 },
      'rev-list': { stdout: '5\n', stderr: '', code: 0 },
    })

    // Act
    const result = await classifyWorktreeHead(SESSION)

    // Assert
    expect(result).toEqual({
      head: 'another_branch',
      branch: 'feature-x',
      commits: 5,
    })
    expect(lastArgs()).toEqual([
      'rev-list',
      '--count',
      'refs/heads/claude/wt',
      '^refs/heads/feature-x',
      '^base123',
      '--',
    ])
  })

  test('another_branch: failed count + our branch deleted → 0 (nothing can be lost through it)', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 },
      'rev-list': FAIL,
      // for-each-ref empty → branchMissing true.
    })

    // Act & Assert
    expect(await classifyWorktreeHead(SESSION)).toEqual({
      head: 'another_branch',
      branch: 'feature-x',
      commits: 0,
    })
  })

  test('another_branch: failed count + our branch still exists → null (fail-closed)', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 },
      'rev-list': FAIL,
      'for-each-ref': { stdout: 'refs/heads/claude/wt\n', stderr: '', code: 0 },
    })

    // Act & Assert
    expect(await classifyWorktreeHead(SESSION)).toEqual({
      head: 'another_branch',
      branch: 'feature-x',
      commits: null,
    })
  })

  test('detached: symbolic-ref exits 1 silently; counts branch OR HEAD beyond baseline', async () => {
    // Arrange — detached signature: symbolic-ref -q exits 1 with no output.
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: '', stderr: '', code: 1 },
      'rev-list': { stdout: '4\n', stderr: '', code: 0 },
    })

    // Act
    const result = await classifyWorktreeHead(SESSION)

    // Assert
    expect(result).toEqual({ head: 'detached', commits: 4 })
    expect(findArgs('symbolic-ref')[0]).toEqual(['symbolic-ref', '-q', 'HEAD'])
    expect(lastArgs()).toEqual([
      'rev-list',
      '--count',
      'refs/heads/claude/wt',
      'HEAD',
      '^base123',
      '--',
    ])
  })

  test('detached: branch count fails + branch deleted → falls back to HEAD-only count', async () => {
    // Arrange
    let revListCalls = 0
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: '', stderr: '', code: 1 },
      'rev-list': args => {
        revListCalls += 1
        if (revListCalls === 1) {
          expect(args).toContain('refs/heads/claude/wt')
          return FAIL
        }
        return { stdout: '1\n', stderr: '', code: 0 }
      },
      // for-each-ref default OK (empty) → branchMissing true.
    })

    // Act
    const result = await classifyWorktreeHead(SESSION)

    // Assert
    expect(result).toEqual({ head: 'detached', commits: 1 })
    expect(lastArgs()).toEqual([
      'rev-list',
      '--count',
      'HEAD',
      '^base123',
      '--',
    ])
  })

  test('detached: branch count fails + branch still exists → null (fail-closed)', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: '', stderr: '', code: 1 },
      'rev-list': FAIL,
      'for-each-ref': { stdout: 'refs/heads/claude/wt\n', stderr: '', code: 0 },
    })

    // Act & Assert
    expect(await classifyWorktreeHead(SESSION)).toEqual({
      head: 'detached',
      commits: null,
    })
  })

  test('like_its_branch: name compares equal under normalization → commits null (fail-closed)', async () => {
    // Arrange — official `hh()` normalizer is unrecoverable; OCC deviates to
    // case-insensitive comparison.
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/CLAUDE/WT\n', stderr: '', code: 0 },
      'rev-list': { stdout: '9\n', stderr: '', code: 0 },
    })

    // Act
    const result = await classifyWorktreeHead(SESSION)

    // Assert
    expect(result).toEqual({ head: 'like_its_branch', commits: null })
    expect(findArgs('rev-list').length).toBe(0)
  })

  test('unreadable: symbolic-ref succeeds with empty stdout', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: '', stderr: '', code: 0 },
    })

    // Act & Assert
    expect(await classifyWorktreeHead(SESSION)).toEqual({
      head: 'unreadable',
      commits: null,
    })
  })

  test('unreadable: symbolic-ref exits non-1 with stderr (not the detached signature)', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': FAIL,
    })

    // Act & Assert
    expect(await classifyWorktreeHead(SESSION)).toEqual({
      head: 'unreadable',
      commits: null,
    })
  })
})

// ---------------------------------------------------------------------------
// computeWorktreeExitAtStake (`nOt`)
// ---------------------------------------------------------------------------

describe('computeWorktreeExitAtStake (official nOt)', () => {
  test('hook worktree with no baseline → not_read, commits null, zero git calls', async () => {
    // Act
    const result = await computeWorktreeExitAtStake({
      ...SESSION,
      worktreeBranch: undefined,
      originalHeadCommit: undefined,
      hookBased: true,
    })

    // Assert
    expect(result).toEqual({ head: 'not_read', commits: null })
    expect(gitCalls.length).toBe(0)
  })

  test('not_read fallback counts HEAD vs baseline when classification is impossible', async () => {
    // Arrange — no worktreeBranch but a baseline exists (legacy session).
    gitImpl = implBySubcommand({
      'rev-list': { stdout: '7\n', stderr: '', code: 0 },
    })

    // Act
    const result = await computeWorktreeExitAtStake({
      ...SESSION,
      worktreeBranch: undefined,
    })

    // Assert
    expect(result).toEqual({ head: 'not_read', commits: 7 })
    expect(lastArgs()).toEqual([
      'rev-list',
      '--count',
      'HEAD',
      '^base123',
      '--',
    ])
  })

  test('its_branch classification passes through unchanged', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/claude/wt\n', stderr: '', code: 0 },
      'rev-list': { stdout: '2\n', stderr: '', code: 0 },
    })

    // Act & Assert
    expect(await computeWorktreeExitAtStake(SESSION)).toEqual({
      head: 'its_branch',
      commits: 2,
    })
  })

  test('another_branch with commits > 0 passes through (no kept-branch refinement)', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 },
      'rev-list': { stdout: '3\n', stderr: '', code: 0 },
    })

    // Act
    const result = await computeWorktreeExitAtStake(SESSION)

    // Assert
    expect(result).toEqual({
      head: 'another_branch',
      branch: 'feature-x',
      commits: 3,
    })
    // Only the classification rev-list ran — no kept-branch count.
    expect(findArgs('rev-list').length).toBe(1)
  })

  test('onKeptBranch refinement: clean own branch but kept branch holds commits', async () => {
    // Arrange — first rev-list (classification): our branch has 0 unbacked
    // commits; second rev-list (refinement): refs/heads/feature-x holds 4.
    let revListCalls = 0
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 },
      'rev-list': args => {
        revListCalls += 1
        if (revListCalls === 1) {
          expect(args).toEqual([
            'rev-list',
            '--count',
            'refs/heads/claude/wt',
            '^refs/heads/feature-x',
            '^base123',
            '--',
          ])
          return { stdout: '0\n', stderr: '', code: 0 }
        }
        expect(args).toEqual([
          'rev-list',
          '--count',
          'refs/heads/feature-x',
          '^base123',
          '--',
        ])
        return { stdout: '4\n', stderr: '', code: 0 }
      },
    })

    // Act
    const result = await computeWorktreeExitAtStake(SESSION)

    // Assert
    expect(result).toEqual({
      head: 'another_branch',
      branch: 'feature-x',
      commits: 0,
      onKeptBranch: 4,
    })
  })

  test('onKeptBranch refinement is fail-closed: kept-branch count null → onKeptBranch null', async () => {
    // Arrange
    let revListCalls = 0
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 },
      'rev-list': () => {
        revListCalls += 1
        return revListCalls === 1
          ? { stdout: '0\n', stderr: '', code: 0 }
          : FAIL
      },
    })

    // Act
    const result = await computeWorktreeExitAtStake(SESSION)

    // Assert
    expect(result).toEqual({
      head: 'another_branch',
      branch: 'feature-x',
      commits: 0,
      onKeptBranch: null,
    })
  })

  test('kept branch clean too (count 0) → plain another_branch, auto-remove allowed', async () => {
    // Arrange
    gitImpl = implBySubcommand({
      'symbolic-ref': { stdout: 'refs/heads/feature-x\n', stderr: '', code: 0 },
      'rev-list': { stdout: '0\n', stderr: '', code: 0 },
    })

    // Act
    const result = await computeWorktreeExitAtStake(SESSION)

    // Assert
    expect(result).toEqual({
      head: 'another_branch',
      branch: 'feature-x',
      commits: 0,
    })
    expect('onKeptBranch' in result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// formatAtStakePhrase (`tOt`)
// ---------------------------------------------------------------------------

describe('formatAtStakePhrase (official tOt)', () => {
  test('another_branch → "on <branch> that <other> doesn\'t have"', () => {
    expect(
      formatAtStakePhrase(
        { head: 'another_branch', branch: 'feature-x', commits: 2 },
        'claude/wt',
        'feature-x',
      ),
    ).toBe("on claude/wt that feature-x doesn't have")
  })

  test('like_its_branch → same "that <other> doesn\'t have" phrasing', () => {
    expect(
      formatAtStakePhrase(
        { head: 'like_its_branch', commits: null },
        'claude/wt',
        'CLAUDE/WT',
      ),
    ).toBe("on claude/wt that CLAUDE/WT doesn't have")
  })

  test('detached → "on <branch> or at the detached HEAD"', () => {
    expect(
      formatAtStakePhrase({ head: 'detached', commits: 1 }, 'claude/wt', 'x'),
    ).toBe('on claude/wt or at the detached HEAD')
  })

  test('its_branch / unreadable / not_read → plain "on <branch>"', () => {
    expect(
      formatAtStakePhrase({ head: 'its_branch', commits: 0 }, 'claude/wt', 'x'),
    ).toBe('on claude/wt')
    expect(
      formatAtStakePhrase({ head: 'unreadable', commits: null }, 'claude/wt', 'x'),
    ).toBe('on claude/wt')
    expect(
      formatAtStakePhrase({ head: 'not_read', commits: null }, 'claude/wt', 'x'),
    ).toBe('on claude/wt')
  })
})
