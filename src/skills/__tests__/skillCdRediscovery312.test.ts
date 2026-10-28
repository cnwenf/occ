/**
 * CC 2.1.312 item 5: per-directory skills discovery survives a `cd` deeper
 * into the repo. Skills dirs ABOVE the new cwd stay reachable and
 * `paths:`-conditional activation keeps matching.
 *
 * Official byte evidence (v312 linux-x64 ELF):
 *   - trigger `Sq` @251527988:
 *       let h=fe(),y=vN()?h:Ee(),S=h!==y&&ZG(h,y,!1)?ir(h):null,
 *           w=S!==null&&ir(y)===S?{cwd:h,workTree:S}:void 0,H=w===void 0?h:y,
 *           G=await eNo(e,[n],H,s,w); … mSn([n],H)
 *     — stable base H = ORIGINAL cwd (`Ee`) when the live cwd `h` moved but
 *     stayed inside the SAME git worktree (`ZG`=containment, `ir`=worktree
 *     root); the {cwd,workTree} context `w` is threaded into discovery, and
 *     conditional activation (`mSn`) matches relative to H, not the live cwd.
 *   - discovery `eNo` @251524152: for candidate dirs NOT below `ctx.cwd`, a
 *     three-state confirmation `fSn(dir,ctx.workTree,base)` → 1=confirmed
 *     (load), 0=gitignored (skip), undefined=unconfirmed → deferred via
 *     `deferredSkillDirs.set(dir, liveCwd)` + skip with
 *     `[skills] Skipped gitignored or unconfirmed skills dir: ${dir}`;
 *     a second symlink-target check logs
 *     `[skills] Skipped skills dir with an unconfirmed target: ${dir}`;
 *     stale deferrals (recorded under a different live cwd) are evicted and
 *     re-checked; the reset fn (`e2s`) clears deferredSkillDirs.
 *   - v311 (buggy) @251543607/@251540112: base = raw LIVE cwd — after a
 *     deeper cd, the upward walk is bounded by the new cwd (dirs above are
 *     unreachable) and `relative(liveCwd, file)` is `..`-prefixed → skipped.
 */
import { execFileSync } from 'child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

// worktree.ts transitively reads MACRO.VERSION; mirror the cli.tsx polyfill
// (loadSkillsDir imports chain into worktree-adjacent modules).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const {
  activateConditionalSkillsForPaths,
  clearDynamicSkills,
  clearSkillCaches,
  discoverSkillDirsForPaths,
  getConditionalSkillCount,
  getDeferredSkillDirs,
  getDynamicSkills,
  getSkillDirCommands,
  resolveSkillDiscoveryBase,
} = await import('../loadSkillsDir.js')
const {
  getCwdState,
  getOriginalCwd,
  setOriginalCwd,
  setCwdState,
} = await import('../../bootstrap/state.js')
const debug = await import('../../utils/debug.js')

let tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/** Init a repo with one commit. */
async function initRepo(prefix = 'occ-312cd-repo-'): Promise<string> {
  const repo = await makeTempDir(prefix)
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
  extraFrontmatter = '',
): Promise<void> {
  const dir = join(root, '.claude', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n${extraFrontmatter}---\n# ${name}\n`,
  )
}

/**
 * Standard fixture:
 *   repo/.claude/skills/cond-skill      (paths: deep/** — conditional)
 *   repo/deep/nested/.claude/skills/nested-foo   (per-dir, ABOVE the cd dest)
 *   repo/deep/nested/level.txt
 *   repo/deep/nested/sub/file.txt       (cd destination + trigger file)
 */
async function makeStandardRepo(): Promise<string> {
  const repo = await initRepo()
  await writeSkill(repo, 'cond-skill', 'paths: deep/**\n')
  await writeSkill(join(repo, 'deep', 'nested'), 'nested-foo')
  await mkdir(join(repo, 'deep', 'nested', 'sub'), { recursive: true })
  await writeFile(join(repo, 'deep', 'nested', 'level.txt'), 'x\n')
  await writeFile(join(repo, 'deep', 'nested', 'sub', 'file.txt'), 'x\n')
  return repo
}

let savedOriginalCwd: string
let savedCwd: string
let logSpy: ReturnType<typeof spyOn>

function loggedMessages(): string[] {
  return logSpy.mock.calls.map(c => String(c[0]))
}

beforeEach(() => {
  savedOriginalCwd = getOriginalCwd()
  savedCwd = getCwdState()
  logSpy = spyOn(debug, 'logForDebugging').mockImplementation(() => {})
})

afterEach(async () => {
  clearDynamicSkills()
  clearSkillCaches()
  logSpy.mockRestore()
  setOriginalCwd(savedOriginalCwd)
  setCwdState(savedCwd)
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('2.1.311 regression surface — live-cwd base breaks after a deeper cd', () => {
  test('discovery bounded by the deeper live cwd finds nothing above it, and paths: never matches (..-prefixed relative)', async () => {
    // Arrange — startup at the repo root loads the conditional skill.
    const repo = await makeStandardRepo()
    await getSkillDirCommands(repo)
    setOriginalCwd(repo)
    const deeper = join(repo, 'deep', 'nested', 'sub')
    setCwdState(deeper)

    // Act — the OLD (v311) caller shape: base = live cwd, no ctx.
    const dirs = await discoverSkillDirsForPaths(
      [join(deeper, 'file.txt')],
      getCwdState(),
    )
    const activated = activateConditionalSkillsForPaths(
      [join(repo, 'deep', 'nested', 'level.txt')],
      getCwdState(),
    )

    // Assert — the bug: dirs above the new cwd are unreachable and the
    // `..`-prefixed relative path never matches `deep/**`.
    expect(dirs).toEqual([])
    expect(activated).toEqual([])
    expect(getConditionalSkillCount()).toBe(1) // still pending
  })
})

describe('2.1.312 item 5 — stable discovery base (official Sq)', () => {
  test('resolveSkillDiscoveryBase returns the original cwd + worktree ctx after a cd inside the SAME worktree', async () => {
    // Arrange
    const repo = await makeStandardRepo()
    setOriginalCwd(repo)
    const deeper = join(repo, 'deep', 'nested', 'sub')
    setCwdState(deeper)

    // Act
    const { base, ctx } = resolveSkillDiscoveryBase()

    // Assert — H = original cwd; w = {cwd: live, workTree: root}
    expect(base).toBe(repo)
    expect(ctx).toEqual({ cwd: deeper, workTree: repo })
  })

  test('after a deeper cd, skills dirs above the new cwd stay reachable and paths: activation matches', async () => {
    // Arrange — startup at the repo root loads the conditional skill.
    const repo = await makeStandardRepo()
    await getSkillDirCommands(repo)
    setOriginalCwd(repo)
    const deeper = join(repo, 'deep', 'nested', 'sub')
    setCwdState(deeper)

    // Act — the NEW (v312) caller shape.
    const { base, ctx } = resolveSkillDiscoveryBase()
    const dirs = await discoverSkillDirsForPaths(
      [join(deeper, 'file.txt')],
      base,
      ctx,
    )
    const activated = activateConditionalSkillsForPaths(
      [join(repo, 'deep', 'nested', 'level.txt')],
      base,
    )

    // Assert
    expect(dirs).toContain(join(repo, 'deep', 'nested', '.claude', 'skills'))
    expect(activated).toContain('cond-skill')
    expect(getDynamicSkills().some(s => s.name === 'cond-skill')).toBe(true)
    expect(getConditionalSkillCount()).toBe(0)
  })

  test('cwd OUTSIDE the original worktree falls back to the live cwd (no cross-repo reach)', async () => {
    // Arrange — a second, unrelated git repo.
    const repo = await makeStandardRepo()
    const other = await initRepo('occ-312cd-other-')
    setOriginalCwd(repo)
    setCwdState(other)

    // Act
    const { base, ctx } = resolveSkillDiscoveryBase()
    const dirs = await discoverSkillDirsForPaths(
      [join(other, 'f.txt')],
      base,
      ctx,
    )

    // Assert — old behavior: base = live cwd, no ctx, no reach into `repo`.
    expect(base).toBe(other)
    expect(ctx).toBeUndefined()
    expect(dirs.some(d => d.startsWith(repo + '/'))).toBe(false)
  })

  test('no cd at all → base = live cwd = original cwd, ctx undefined (classic behavior preserved)', async () => {
    // Arrange
    const repo = await makeStandardRepo()
    setOriginalCwd(repo)
    setCwdState(repo)

    // Act
    const { base, ctx } = resolveSkillDiscoveryBase()
    const dirs = await discoverSkillDirsForPaths(
      [join(repo, 'deep', 'nested', 'sub', 'file.txt')],
      base,
      ctx,
    )

    // Assert
    expect(base).toBe(repo)
    expect(ctx).toBeUndefined()
    expect(dirs).toContain(join(repo, 'deep', 'nested', '.claude', 'skills'))
  })
})

describe('2.1.312 item 5 — three-state confirmation + deferredSkillDirs (official eNo/fSn)', () => {
  test('gitignored dir above ctx.cwd → skipped with the verbatim log and NOT deferred (state 0)', async () => {
    // Arrange
    const repo = await makeStandardRepo()
    await writeFile(join(repo, '.gitignore'), 'ignored/\n')
    await writeSkill(join(repo, 'ignored'), 'ig-skill')
    setOriginalCwd(repo)
    const deeper = join(repo, 'deep', 'nested', 'sub')
    setCwdState(deeper)

    // Act
    const { base, ctx } = resolveSkillDiscoveryBase()
    const dirs = await discoverSkillDirsForPaths(
      [join(repo, 'ignored', 'f.txt')],
      base,
      ctx,
    )

    // Assert
    const skillDir = join(repo, 'ignored', '.claude', 'skills')
    expect(dirs).not.toContain(skillDir)
    expect(getDeferredSkillDirs().has(skillDir)).toBe(false)
    expect(loggedMessages()).toContain(
      `[skills] Skipped gitignored or unconfirmed skills dir: ${skillDir}`,
    )
  })

  test('unconfirmed dir → deferred with the verbatim log; stale deferrals are evicted and re-checked when the live cwd moves; reset fns clear the map', async () => {
    // Arrange — a NON-git area: worktree confirmation cannot succeed
    // (git-root mismatch → unconfirmed → deferred, e.g. git unavailable).
    const plain = await makeTempDir('occ-312cd-plain-')
    const sub = join(plain, 'sub')
    const skillDir = join(sub, '.claude', 'skills')
    await mkdir(skillDir, { recursive: true })
    const live1 = join(plain, 'elsewhere')
    setCwdState(live1)
    const ctx = { cwd: sub, workTree: join(plain, 'no-such-worktree') }

    // Act — first trigger defers the dir, keyed by the live cwd.
    const dirs = await discoverSkillDirsForPaths(
      [join(sub, 'f.txt')],
      plain,
      ctx,
    )

    // Assert
    expect(dirs).toEqual([])
    expect(getDeferredSkillDirs().get(skillDir)).toBe(live1)
    expect(loggedMessages()).toContain(
      `[skills] Skipped gitignored or unconfirmed skills dir: ${skillDir}`,
    )

    // Act — live cwd moves; the next trigger evicts the stale deferral and
    // re-checks (still unconfirmed → re-deferred under the NEW live cwd).
    const live2 = join(plain, 'moved')
    setCwdState(live2)
    await discoverSkillDirsForPaths([join(sub, 'f.txt')], plain, ctx)

    // Assert
    expect(getDeferredSkillDirs().get(skillDir)).toBe(live2)
    expect(
      loggedMessages().filter(
        m =>
          m ===
          `[skills] Skipped gitignored or unconfirmed skills dir: ${skillDir}`,
      ).length,
    ).toBe(2)

    // Act / Assert — the cache reset clears the deferral map...
    clearSkillCaches()
    expect(getDeferredSkillDirs().size).toBe(0)

    // ...and after a full dynamic-state reset the seen-cache no longer
    // short-circuits, so the next trigger re-checks and re-defers the dir.
    clearDynamicSkills()
    await discoverSkillDirsForPaths([join(sub, 'f.txt')], plain, ctx)
    expect(getDeferredSkillDirs().size).toBe(1)
    clearDynamicSkills()
    expect(getDeferredSkillDirs().size).toBe(0)
  })

  test('symlinked skills dir with an unconfirmable target → skipped with the unconfirmed-target verbatim log', async () => {
    // Arrange — repo/deep/linked/.claude/skills symlinks OUT of the worktree.
    const repo = await makeStandardRepo()
    const outside = await makeTempDir('occ-312cd-outside-')
    await writeSkill(outside, 'outside-skill')
    await mkdir(join(repo, 'deep', 'linked', '.claude'), { recursive: true })
    await symlink(
      join(outside, '.claude', 'skills'),
      join(repo, 'deep', 'linked', '.claude', 'skills'),
    )
    const deeper = join(repo, 'deep', 'linked', 'sub')
    await mkdir(deeper, { recursive: true })
    setOriginalCwd(repo)
    setCwdState(deeper)

    // Act
    const { base, ctx } = resolveSkillDiscoveryBase()
    const dirs = await discoverSkillDirsForPaths(
      [join(deeper, 'f.txt')],
      base,
      ctx,
    )

    // Assert
    const linkedSkills = join(repo, 'deep', 'linked', '.claude', 'skills')
    expect(dirs).not.toContain(linkedSkills)
    expect(loggedMessages()).toContain(
      `[skills] Skipped skills dir with an unconfirmed target: ${linkedSkills}`,
    )
  })

  test('symlinked skills dir whose target IS confirmed inside the worktree still loads', async () => {
    // Arrange — repo/deep/linked2/.claude/skills → repo/target/.claude/skills
    const repo = await makeStandardRepo()
    await writeSkill(join(repo, 'target'), 'inner-skill')
    await mkdir(join(repo, 'deep', 'linked2', '.claude'), { recursive: true })
    await symlink(
      join(repo, 'target', '.claude', 'skills'),
      join(repo, 'deep', 'linked2', '.claude', 'skills'),
    )
    const deeper = join(repo, 'deep', 'linked2', 'sub')
    await mkdir(deeper, { recursive: true })
    setOriginalCwd(repo)
    setCwdState(deeper)

    // Act
    const { base, ctx } = resolveSkillDiscoveryBase()
    const dirs = await discoverSkillDirsForPaths(
      [join(deeper, 'f.txt')],
      base,
      ctx,
    )

    // Assert
    expect(dirs).toContain(join(repo, 'deep', 'linked2', '.claude', 'skills'))
  })
})
