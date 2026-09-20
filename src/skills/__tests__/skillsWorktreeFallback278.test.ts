import { execFileSync } from 'child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'

/**
 * CC 2.1.278 (OCC-132 P3-3): project skills in a worktree session resolve
 * LIVE from the main repo via the official worktree fallback — NOT via a
 * creation-time snapshot.
 *
 * Official binary evidence: the skills loader `URo` runs
 *   g=await eZ("skills",e); IMe(g,"skills",e)
 * where `IMe` adds the main repo's `.claude/<subdir>` when the worktree lacks
 * its own (same fallback the markdown loaders use; dedup guard per
 * anthropics/claude-code#29599/#28182/#26992). The official worktree setup
 * (`Uje`) has NO dedicated skills copy.
 *
 * OCC previously shipped an inferred `copyUntrackedProjectSkills` snapshot at
 * worktree creation (D15) — removed in favor of the official runtime
 * fallback, which also fixes the debt symptom (snapshot never refreshed:
 * skills added to the main repo after creation were invisible to the
 * worktree session).
 */

// worktree.ts transitively reads MACRO.VERSION; mirror the cli.tsx polyfill
// (loadSkillsDir imports chain into worktree-adjacent modules).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { addWorktreeMainRepoFallback } = await import(
  '../../utils/markdownConfigLoader.js'
)
const { getSkillDirCommands } = await import('../loadSkillsDir.js')

let tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/** Init a repo with one commit (worktree add requires a HEAD). */
async function initRepoWithCommit(): Promise<string> {
  const repo = await makeTempDir('occ-skillfb-repo-')
  git(['init', '-q'], repo)
  await writeFile(join(repo, 'README.md'), '# repo\n')
  git(['add', 'README.md'], repo)
  git(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'],
    repo,
  )
  return repo
}

async function writeSkill(
  root: string,
  name: string,
  description: string,
): Promise<void> {
  const dir = join(root, '.claude', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  )
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('2.1.278 IMe — addWorktreeMainRepoFallback (unit)', () => {
  test('adds the main repo .claude/skills when the worktree lacks its own', async () => {
    // Arrange — a real git worktree (`.git` file → findGitRoot stops there).
    const repo = await initRepoWithCommit()
    const wt = join(await makeTempDir('occ-skillfb-wt-'), 'wt')
    git(['worktree', 'add', '-q', wt, '-b', 'wt-branch'], repo)

    // Act
    const dirs = addWorktreeMainRepoFallback([], 'skills', wt)

    // Assert — main repo's skills dir appended (no existence check, official
    // `IMe` semantics — downstream loaders tolerate a missing dir).
    expect(dirs).toContain(join(repo, '.claude', 'skills'))
  })

  test('does NOT add the main repo copy when the worktree has its own .claude/skills', async () => {
    // Arrange — tracked skills are materialized by `git worktree add`.
    const repo = await initRepoWithCommit()
    await writeSkill(repo, 'tracked-skill', 'tracked')
    git(['add', '.claude'], repo)
    git(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'skill'],
      repo,
    )
    const wt = join(await makeTempDir('occ-skillfb-wt-'), 'wt')
    git(['worktree', 'add', '-q', wt, '-b', 'wt-branch'], repo)
    const own = [join(wt, '.claude', 'skills')]

    // Act
    const dirs = addWorktreeMainRepoFallback(own, 'skills', wt)

    // Assert — dedup guard (#29599): no duplicate main-repo entry.
    expect(dirs).toEqual(own)
  })

  test('is a no-op outside a worktree (canonical root == git root)', async () => {
    // Arrange
    const repo = await initRepoWithCommit()

    // Act
    const dirs = addWorktreeMainRepoFallback(['x'], 'skills', repo)

    // Assert
    expect(dirs).toEqual(['x'])
  })
})

describe('2.1.278 URo — skills loader resolves worktree sessions live', () => {
  test('untracked main-repo skill loads in a worktree session (no creation-time copy)', async () => {
    // Arrange — skill exists ONLY in the main repo working tree (untracked),
    // so `git worktree add` does not materialize it in the worktree.
    const repo = await initRepoWithCommit()
    await writeSkill(repo, 'demo-wt-live', 'live-resolved demo skill')
    const wt = join(await makeTempDir('occ-skillfb-wt-'), 'wt')
    git(['worktree', 'add', '-q', wt, '-b', 'wt-branch'], repo)

    // Act
    const commands = await getSkillDirCommands(wt)

    // Assert — resolved at runtime from the main repo via the fallback.
    expect(commands.some(c => c.name === 'demo-wt-live')).toBe(true)
  })

  test('skill added to the main repo AFTER worktree creation is visible (debt: no stale snapshot)', async () => {
    // Arrange — create the worktree first, then add the skill to the main
    // repo. The old creation-time snapshot would never see it.
    const repo = await initRepoWithCommit()
    const wt = join(await makeTempDir('occ-skillfb-wt-'), 'wt')
    git(['worktree', 'add', '-q', wt, '-b', 'wt-branch'], repo)
    await writeSkill(repo, 'demo-wt-late', 'added after worktree creation')

    // Act — fresh session cwd (memoize keys on cwd).
    const commands = await getSkillDirCommands(wt)

    // Assert
    expect(commands.some(c => c.name === 'demo-wt-late')).toBe(true)
  })

  test('worktree with its own tracked skills does not duplicate them from the main repo', async () => {
    // Arrange
    const repo = await initRepoWithCommit()
    await writeSkill(repo, 'demo-wt-tracked', 'tracked skill')
    git(['add', '.claude'], repo)
    git(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'skill'],
      repo,
    )
    const wt = join(await makeTempDir('occ-skillfb-wt-'), 'wt')
    git(['worktree', 'add', '-q', wt, '-b', 'wt-branch'], repo)

    // Act
    const commands = await getSkillDirCommands(wt)

    // Assert — exactly one entry (worktree's own copy; fallback not added).
    expect(
      commands.filter(c => c.name === 'demo-wt-tracked').length,
    ).toBe(1)
  })
})
