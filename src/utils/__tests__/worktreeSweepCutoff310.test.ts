/**
 * Official Claude Code 2.1.310 changelog item 3 — the stale-agent-worktree
 * sweep must never run with an invalid cutoff.
 *
 * Failure mode being pinned (triage-T1 item 3): a huge `cleanupPeriodDays`
 * overflows `days * 8.64e7` to Infinity → Invalid Date → `cutoffMs` is NaN →
 * EVERY comparison against NaN is false, so the `mtimeMs >= cutoffMs` keep-skip
 * never fires and the sweep deletes even the NEWEST ephemeral worktrees.
 *
 * Official 310 evidence (byte-verified, binary never executed):
 *  - BIN310 @258251237: `function _e(e){let r=new Date(Date.now()-e*24*60*60*1000);
 *    return Number.isNaN(r.getTime())?null:r}` — guarded helper returns null.
 *  - BIN310 @258283561: `let O=kS();if(O!==null){...let A=await vAo(O,g,!1);
 *    if(A>0)a("tengu_worktree_cleanup",{removed:A});...}` — the official
 *    orchestrator never invokes the sweep (`vAo`) with a null cutoff, and `vAo`
 *    itself keeps the `if(Se>=S)continue` direction for VALID cutoffs.
 * OCC mirrors this: null cutoff → return 0 (skip); NaN cutoffMs → return 0
 * (defense in depth, triage step 4); the per-entry keep comparison is written
 * in the fail-safe direction `!(mtimeMs < cutoffMs)` (logically identical to
 * the official `mtimeMs >= cutoffMs` for all real timestamps, but KEEPS
 * entries instead of deleting them if a NaN ever slipped through).
 *
 * Integration tests run real git in temp dirs (same pattern as
 * worktreeCreateErrors299.test.ts / worktreeLazyFetch309.test.ts).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from '../cwd.js'
import { cleanupStaleAgentWorktrees } from '../worktree.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

const tmpDirs: string[] = []

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

/**
 * Repo with a pushed commit (so the sweep's `rev-list HEAD --not --remotes`
 * unpushed-check passes) and two registered ephemeral agent worktrees:
 * `agent-a1111111` aged 40 days (stale) and `agent-a2222222` fresh (recent).
 */
function makeRepoWithOldAndNewAgentWorktrees(): {
  repo: string
  oldPath: string
  newPath: string
} {
  const repo = makeTmpDir('occ-wt-sweep-310-')
  git(repo, ['init', '-q', '-b', 'master', '.'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])

  const origin = makeTmpDir('occ-wt-sweep-origin-310-')
  git(origin, ['init', '-q', '--bare', '.'])
  git(repo, ['remote', 'add', 'origin', origin])

  writeFileSync(join(repo, 'f.txt'), 'hello\n')
  git(repo, ['add', 'f.txt'])
  git(repo, ['commit', '-qm', 'c1'])
  git(repo, ['push', '-q', 'origin', 'master'])

  const worktreesRoot = join(repo, '.claude', 'worktrees')
  const oldPath = join(worktreesRoot, 'agent-a1111111')
  const newPath = join(worktreesRoot, 'agent-a2222222')
  git(repo, ['worktree', 'add', '-q', oldPath, '-b', 'worktree-agent-a1111111'])
  git(repo, ['worktree', 'add', '-q', newPath, '-b', 'worktree-agent-a2222222'])

  const fortyDaysAgo = (Date.now() - 40 * MS_PER_DAY) / 1000
  utimesSync(oldPath, fortyDaysAgo, fortyDaysAgo)
  const now = Date.now() / 1000
  utimesSync(newPath, now, now)

  return { repo, oldPath, newPath }
}

function sweep(repo: string, cutoffDate: Date | null): Promise<number> {
  return runWithCwdOverride(repo, () => cleanupStaleAgentWorktrees(cutoffDate))
}

describe('2.1.310 cleanupStaleAgentWorktrees — cutoff guard', () => {
  test('valid cutoff deletes the stale worktree and keeps the recent one', async () => {
    const { repo, oldPath, newPath } = makeRepoWithOldAndNewAgentWorktrees()

    const removed = await sweep(repo, new Date(Date.now() - 30 * MS_PER_DAY))

    expect(removed).toBe(1)
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(newPath)).toBe(true)
    // The stale worktree's branch is deleted alongside it; the fresh one stays.
    const branches = git(repo, ['branch', '--format=%(refname:short)'])
    expect(branches).not.toContain('worktree-agent-a1111111')
    expect(branches).toContain('worktree-agent-a2222222')
  })

  test('null cutoff skips the sweep entirely — deletes nothing (official `if(O!==null)` shape)', async () => {
    const { repo, oldPath, newPath } = makeRepoWithOldAndNewAgentWorktrees()

    const removed = await sweep(repo, null)

    expect(removed).toBe(0)
    expect(existsSync(oldPath)).toBe(true)
    expect(existsSync(newPath)).toBe(true)
  })

  test('Invalid Date (NaN) cutoff skips the sweep — the 2.1.309 hazard that deleted RECENT worktrees', async () => {
    const { repo, oldPath, newPath } = makeRepoWithOldAndNewAgentWorktrees()

    const removed = await sweep(repo, new Date(Number.NaN))

    expect(removed).toBe(0)
    expect(existsSync(oldPath)).toBe(true)
    expect(existsSync(newPath)).toBe(true)
  })
})
