import { execFileSync } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

// worktree.ts transitively reads MACRO.VERSION; mirror the cli.tsx polyfill.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { copyUntrackedProjectSkills } = await import('../worktree.js')

const SKILL_REL = '.claude/skills/demo/SKILL.md'

/**
 * CC 2.1.278 (D15) — project skills from the main repo don't load in
 * `--worktree` sessions when `.claude/skills` is untracked. `git worktree add`
 * materializes only TRACKED files and `.worktreeinclude` copies only GITIGNORED
 * ones, so an untracked-but-not-ignored `.claude/skills/` falls through both.
 *
 * NOTE: this is an INFERRED OCC fix (the official `Uje` worktree setup has no
 * dedicated skills copy — its skills resolve at runtime from originalCwd), so
 * there are no official strings to byte-match; the tests assert the copy
 * semantics: untracked+not-ignored copied, gitignored skipped, tracked skipped.
 */
describe('2.1.278 D15 — worktree untracked project-skills copy', () => {
  let repoRoot: string
  let worktreePath: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'occ-wt-repo-'))
    worktreePath = await mkdtemp(join(tmpdir(), 'occ-wt-tree-'))
    execFileSync('git', ['init', '-q'], { cwd: repoRoot })
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    await rm(worktreePath, { recursive: true, force: true })
  })

  test('copies an untracked (non-ignored) skill file into the worktree, preserving its relative path', async () => {
    // Arrange
    const skillDir = join(repoRoot, '.claude', 'skills', 'demo')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# demo skill\n')

    // Act
    const copied = await copyUntrackedProjectSkills(repoRoot, worktreePath)

    // Assert
    expect(copied).toEqual([SKILL_REL])
    const dest = join(worktreePath, '.claude', 'skills', 'demo', 'SKILL.md')
    expect(await readFile(dest, 'utf-8')).toBe('# demo skill\n')
  })

  test('copies multiple untracked skill files', async () => {
    // Arrange
    for (const name of ['alpha', 'beta']) {
      const dir = join(repoRoot, '.claude', 'skills', name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), `# ${name}\n`)
    }

    // Act
    const copied = await copyUntrackedProjectSkills(repoRoot, worktreePath)

    // Assert
    expect(copied.sort()).toEqual([
      '.claude/skills/alpha/SKILL.md',
      '.claude/skills/beta/SKILL.md',
    ])
  })

  test('does NOT copy a gitignored skill file (left to .worktreeinclude)', async () => {
    // Arrange
    await writeFile(join(repoRoot, '.gitignore'), '.claude/skills/\n')
    const skillDir = join(repoRoot, '.claude', 'skills', 'ignored')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# ignored\n')

    // Act
    const copied = await copyUntrackedProjectSkills(repoRoot, worktreePath)

    // Assert — --exclude-standard drops ignored paths
    expect(copied).toEqual([])
  })

  test('does NOT copy a TRACKED skill file (git worktree already materializes it)', async () => {
    // Arrange
    const skillDir = join(repoRoot, '.claude', 'skills', 'tracked')
    await mkdir(skillDir, { recursive: true })
    const skillFile = join(skillDir, 'SKILL.md')
    await writeFile(skillFile, '# tracked\n')
    execFileSync('git', ['add', '.claude/skills/tracked/SKILL.md'], {
      cwd: repoRoot,
    })

    // Act
    const copied = await copyUntrackedProjectSkills(repoRoot, worktreePath)

    // Assert — --others excludes indexed files
    expect(copied).toEqual([])
  })

  test('returns [] when there is no .claude/skills directory', async () => {
    // Act
    const copied = await copyUntrackedProjectSkills(repoRoot, worktreePath)

    // Assert
    expect(copied).toEqual([])
  })

  test('returns [] when repoRoot is not a git repository (non-zero ls-files)', async () => {
    // Arrange — a plain temp dir with a skills file but no .git
    const plain = await mkdtemp(join(tmpdir(), 'occ-wt-plain-'))
    try {
      const skillDir = join(plain, '.claude', 'skills', 'demo')
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, 'SKILL.md'), '# demo\n')

      // Act
      const copied = await copyUntrackedProjectSkills(plain, worktreePath)

      // Assert — git ls-files fails (code != 0) → no copy, no throw
      expect(copied).toEqual([])
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})
