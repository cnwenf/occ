/**
 * claude-code 2.1.309 item 27 (=F-12): a skill in an `--add-dir` folder was
 * unreachable when another skill already held its name. Official 309 offers
 * it as `<folder>:<name>` with a scoped description, and logs when the
 * qualified name itself would be ambiguous.
 *
 * Official surface (BIN309, skills chunk):
 *   - collision/offering merge loop @251,216,800 (kt/ct/mt ambiguity guard +
 *     `[skills] <name> is not offered: another skill would share the name`)
 *   - `Tdr` (folder label) / `CTe` (folder root) / `jln` (from-suffix) /
 *     `vdr` (qualified copy) / `Yln` (offerability gate) @251,220,700
 *   - `D8t`/`Abe` (workspace-root-relative label) @250,658,038
 *   - `EM(e,n)=`${e}:${n}`` qualifier; `xTe` refusal recorder @252,292,039
 *     (≡ OCC warnReservedNameRefused); `vz` name gate @249,964,807
 *     (≡ !isSkillNameOffered(q) || (isReservedName(q) && !isPlaidHarborEnabled()))
 *   - `hft` fallback-skill gate @249,938,013
 *
 * 308 comparison: the 308 predecessor (`sar` @BIN308:250,317,700) returned a
 * null folder label for out-of-workspace folders — that IS the bug; 309's
 * `Tdr` adds the `D8t` basename-style fallback.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setAdditionalDirectoriesForClaudeMd } from '../../bootstrap/state.js'
import * as growthbook from '../../services/analytics/growthbook.js'
import type { Command } from '../../types/command.js'
import * as debug from '../../utils/debug.js'
import {
  getRefusedReservedNames,
  resetReservedNamesSessionState_FOR_TESTING,
} from '../../utils/skills/reservedNames.js'
import {
  applyFolderQualifiedOffering,
  clearSkillCaches,
  getSkillDirCommands,
  qualifiedSkillName,
  skillFolderLabel,
  skillFolderRoot,
  workspaceFolderLabel,
} from '../loadSkillsDir.js'

const CWD = '/w/proj'

function stubSkill(
  name: string,
  skillRoot: string | undefined,
  opts: { fallback?: boolean; description?: string } = {},
): Command {
  return {
    type: 'prompt',
    name,
    description: opts.description ?? `${name} description`,
    skillRoot,
    fallback: opts.fallback === true,
    userFacingName: () => name,
    source: 'projectSettings',
    loadedFrom: 'skills',
  } as unknown as Command
}

function namesOf(skills: readonly Command[]): string[] {
  return skills.map(s => s.name)
}

let logSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  setAdditionalDirectoriesForClaudeMd([])
  resetReservedNamesSessionState_FOR_TESTING()
  logSpy = spyOn(debug, 'logForDebugging').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  setAdditionalDirectoriesForClaudeMd([])
  resetReservedNamesSessionState_FOR_TESTING()
})

describe('2.1.309 item 27 folder-label helpers (official CTe/Tdr/D8t)', () => {
  test('skillFolderRoot cuts the skillRoot before the last /.claude/ segment', () => {
    expect(skillFolderRoot(stubSkill('foo', '/add/bar/.claude/skills'))).toBe(
      '/add/bar',
    )
    expect(skillFolderRoot(stubSkill('foo', '/add/bar/.claude/skills/nested'))).toBe(
      '/add/bar/.claude/skills/nested'.slice(
        0,
        '/add/bar/.claude/skills/nested'.lastIndexOf('/.claude/'),
      ),
    )
    // no /.claude/ segment or no skillRoot → null
    expect(skillFolderRoot(stubSkill('foo', '/plain/dir'))).toBeNull()
    expect(skillFolderRoot(stubSkill('foo', undefined))).toBeNull()
  })

  test('skillFolderLabel: cwd-workspace folder → null; inside-cwd → relative label; outside → workspace-root label', () => {
    setAdditionalDirectoriesForClaudeMd(['/add/bar'])
    // the folder IS the cwd → null (official Tdr s==="" branch)
    expect(skillFolderLabel(stubSkill('foo', `${CWD}/.claude/skills`), CWD)).toBeNull()
    // nested under cwd → relative label with / separators
    expect(skillFolderLabel(stubSkill('foo', `${CWD}/sub/.claude/skills`), CWD)).toBe(
      'sub',
    )
    // outside cwd, registered add-dir → D8t basename label
    expect(skillFolderLabel(stubSkill('foo', '/add/bar/.claude/skills'), CWD)).toBe(
      'bar',
    )
    // outside cwd, subfolder of a registered add-dir → basename + remainder
    expect(
      skillFolderLabel(stubSkill('foo', '/add/bar/sub/.claude/skills'), CWD),
    ).toBe('bar/sub')
    // outside cwd, not under any workspace root → null (Abe no match)
    expect(skillFolderLabel(stubSkill('foo', '/else/where/.claude/skills'), CWD)).toBeNull()
  })

  test('workspaceFolderLabel disambiguates same-basename roots as parent/base', () => {
    setAdditionalDirectoriesForClaudeMd(['/a1/bar', '/a2/bar'])
    expect(workspaceFolderLabel('/a1/bar')).toBe('a1/bar')
    expect(workspaceFolderLabel('/a2/bar')).toBe('a2/bar')
    setAdditionalDirectoriesForClaudeMd(['/a1/bar'])
    expect(workspaceFolderLabel('/a1/bar')).toBe('bar')
    expect(workspaceFolderLabel('/not/a/root')).toBeNull()
  })

  test('qualifiedSkillName joins folder and name with a colon (official EM)', () => {
    expect(qualifiedSkillName('bar', 'foo')).toBe('bar:foo')
  })
})

describe('2.1.309 item 27 applyFolderQualifiedOffering (official bt loop)', () => {
  test('triage regression: cwd skill foo + add-dir bar skill foo → both offered, second as bar:foo with the scoped description', () => {
    setAdditionalDirectoriesForClaudeMd(['/add/bar'])
    const cwdSkill = stubSkill('foo', `${CWD}/.claude/skills`)
    const addSkill = stubSkill('foo', '/add/bar/.claude/skills')
    const offered = applyFolderQualifiedOffering([cwdSkill, addSkill], CWD)
    expect(namesOf(offered)).toEqual(['foo', 'bar:foo'])
    // the unscoped twin is untouched
    expect(offered[0]).toBe(cwdSkill)
    const qualified = offered[1]!
    expect(qualified.description).toBe(
      'foo description (scoped to bar/ — use this instead of the unscoped "foo" skill when the files being changed are under bar/)',
    )
    expect(qualified.userFacingName?.()).toBe('bar:foo')
    expect((qualified as { unqualifiedName?: string }).unqualifiedName).toBe('foo')
    expect(qualified.aliases).toBeUndefined()
    // the original object is not mutated (immutable copy)
    expect(addSkill.name).toBe('foo')
    expect(addSkill.description).toBe('foo description')
  })

  test('an unconflicted add-dir skill keeps its name and gains the from-suffix (official jln)', () => {
    setAdditionalDirectoriesForClaudeMd(['/add/bar'])
    const addSkill = stubSkill('baz', '/add/bar/.claude/skills')
    const offered = applyFolderQualifiedOffering([addSkill], CWD)
    expect(namesOf(offered)).toEqual(['baz'])
    expect(offered[0]!.description).toBe(
      'baz description (from bar/.claude/skills — applies when working on files under bar/)',
    )
  })

  test('cwd-workspace skills are completely untouched', () => {
    const cwdSkill = stubSkill('foo', `${CWD}/.claude/skills`)
    const offered = applyFolderQualifiedOffering([cwdSkill], CWD)
    expect(offered).toEqual([cwdSkill])
    expect(offered[0]!.description).toBe('foo description')
  })

  test('two add-dir folders producing the same label → neither qualified name is offered, both logged (official kt/mt guard)', () => {
    // D8t disambiguates same-basename roots as parent/base, so an mt collision
    // needs two roots whose parent basenames ALSO match: /x/twin/bar and
    // /y/twin/bar both label as "twin/bar".
    setAdditionalDirectoriesForClaudeMd(['/x/twin/bar', '/y/twin/bar'])
    const cwdSkill = stubSkill('foo', `${CWD}/.claude/skills`)
    const add1 = stubSkill('foo', '/x/twin/bar/.claude/skills')
    const add2 = stubSkill('foo', '/y/twin/bar/.claude/skills')
    const offered = applyFolderQualifiedOffering([cwdSkill, add1, add2], CWD)
    expect(namesOf(offered)).toEqual(['foo'])
    const logs = logSpy.mock.calls.map(c => String(c[0]))
    expect(
      logs.filter(l =>
        l.includes(
          '[skills] twin/bar:foo is not offered: another skill would share the name',
        ),
      ),
    ).toHaveLength(2)
  })

  test('an add-dir label colliding with an inside-cwd qualified name → not offered, logged (official ct guard)', () => {
    setAdditionalDirectoriesForClaudeMd(['/add/sub'])
    const addSkill = stubSkill('foo', '/add/sub/.claude/skills')
    const nestedCwdSkill = stubSkill('foo', `${CWD}/sub/.claude/skills`)
    // add-dir skill first: the ct guard fires before the in-cwd twin claims sub:foo
    const offered = applyFolderQualifiedOffering([addSkill, nestedCwdSkill], CWD)
    expect(namesOf(offered)).toEqual(['sub:foo'])
    expect(offered[0]!.skillRoot).toBe(`${CWD}/sub/.claude/skills`)
    const logs = logSpy.mock.calls.map(c => String(c[0]))
    expect(
      logs.some(l =>
        l.includes(
          '[skills] sub:foo is not offered: another skill would share the name',
        ),
      ),
    ).toBe(true)
  })

  test('fallback skills never take a qualified name and stay shadowed by a real skill of the same name (official hft branch)', () => {
    setAdditionalDirectoriesForClaudeMd(['/add/bar'])
    const real = stubSkill('foo', `${CWD}/.claude/skills`)
    const fallback = stubSkill('foo', '/add/bar/.claude/skills', {
      fallback: true,
    })
    const offered = applyFolderQualifiedOffering([fallback, real], CWD)
    expect(namesOf(offered)).toEqual(['foo'])
    expect(offered[0]).toBe(real)
  })

  test('an unconflicted fallback skill keeps its name (from-suffix allowed, qualification not)', () => {
    setAdditionalDirectoriesForClaudeMd(['/add/bar'])
    const fallback = stubSkill('solo', '/add/bar/.claude/skills', {
      fallback: true,
    })
    const offered = applyFolderQualifiedOffering([fallback], CWD)
    expect(namesOf(offered)).toEqual(['solo'])
    expect(offered[0]!.description).toBe(
      'solo description (from bar/.claude/skills — applies when working on files under bar/)',
    )
  })

  test('a reserved qualified name is refused with the xTe recorder, not offered', () => {
    const gateSpy = spyOn(
      growthbook,
      'getFeatureValue_CACHED_MAY_BE_STALE',
    ).mockReturnValue(false) // tengu_plaid_harbor off → reserved gate live
    try {
      setAdditionalDirectoriesForClaudeMd(['/add/anthropic-skills'])
      const cwdSkill = stubSkill('foo', `${CWD}/.claude/skills`)
      const addSkill = stubSkill('foo', '/add/anthropic-skills/.claude/skills')
      const offered = applyFolderQualifiedOffering([cwdSkill, addSkill], CWD)
      expect(namesOf(offered)).toEqual(['foo'])
      const refusals = getRefusedReservedNames()
      expect(
        refusals.some(
          r =>
            r.name === 'anthropic-skills:foo' &&
            r.path === '/add/anthropic-skills/.claude/skills' &&
            r.change === 'path',
        ),
      ).toBe(true)
    } finally {
      gateSpy.mockRestore()
    }
  })

  test('a name-unsafe folder label nulls the qualification (vz bad-name lane) → the colliding skill is dropped silently', () => {
    setAdditionalDirectoriesForClaudeMd(['/add/b<ad'])
    const cwdSkill = stubSkill('foo', `${CWD}/.claude/skills`)
    const addSkill = stubSkill('foo', '/add/b<ad/.claude/skills')
    const offered = applyFolderQualifiedOffering([cwdSkill, addSkill], CWD)
    expect(namesOf(offered)).toEqual(['foo'])
    const logs = logSpy.mock.calls.map(c => String(c[0]))
    expect(
      logs.some(l => l.includes('is not offered: another skill would share')),
    ).toBe(false)
  })

  test('first-wins: a second unlabelled skill sharing a name is dropped once the name is offered', () => {
    const a = stubSkill('foo', `${CWD}/.claude/skills`)
    const b = stubSkill('foo', '/else/where/.claude/skills') // no workspace root → no label
    const offered = applyFolderQualifiedOffering([a, b], CWD)
    expect(namesOf(offered)).toEqual(['foo'])
    expect(offered[0]).toBe(a)
  })
})

describe('2.1.309 item 27 getSkillDirCommands integration (real fs)', () => {
  let base: string
  let projDir: string
  let addDir: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'occ-309-item27-'))
    projDir = join(base, 'proj')
    addDir = join(base, 'add')
    for (const [root, body] of [
      [projDir, 'project body'],
      [addDir, 'add-dir body'],
    ] as const) {
      const skillDir = join(root, '.claude', 'skills', 'foo')
      await mkdir(skillDir, { recursive: true })
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---\ndescription: foo skill in ${root === projDir ? 'proj' : 'add'}\n---\n${body}\n`,
      )
    }
    setAdditionalDirectoriesForClaudeMd([addDir])
    clearSkillCaches()
  })

  afterEach(async () => {
    clearSkillCaches()
    setAdditionalDirectoriesForClaudeMd([])
    await rm(base, { recursive: true, force: true })
  })

  test('skill foo in cwd + skill foo in --add-dir folder add → both reachable, second as add:foo', async () => {
    const skills = await getSkillDirCommands(projDir)
    const names = namesOf(skills)
    expect(names).toContain('foo')
    expect(names).toContain('add:foo')
    const qualified = skills.find(s => s.name === 'add:foo')!
    expect(qualified.description).toContain('scoped to add/')
    expect(qualified.userFacingName?.()).toBe('add:foo')
    const plain = skills.find(s => s.name === 'foo')!
    expect(plain.description).toBe('foo skill in proj')
  })
})
