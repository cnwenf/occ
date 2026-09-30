import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  linkSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import {
  getExternalClaudeMdIncludes,
  processMdRules,
  processMemoryFile,
} from '../claudemd.js'
import type { SettingSource } from '../settings/constants.js'

/**
 * CC 2.1.284 (security, OCC-101) — rules-walker external-escape gates.
 * Fixture-repo tests against the REAL loaders in claudemd.ts.
 *
 * Byte-verified against the official v2.1.284 linux-x64 ELF:
 *   O0e walker @205758070 · gate block @205758405 · per-entry en @205759353 ·
 *   linkedFrom tag @205759863 · bRn @205760223 · tet fs fallback @205761080 ·
 *   wet()=CN()!=="local-agent" @205762370 · jRe() @200707141 ·
 *   KRt collector @205771688 · i9/k8 User reject (v283 @203895369 ≡ v284
 *   @205757657 — pre-dates the delta, backfilled this round).
 *
 * Covered arms:
 *  - per-entry `if(en&&!Ce)continue` drop for escaping symlinked .md files
 *    and subdirectories (v283 parity — OCC's 2.1.282 port omitted it)
 *  - dir-level `De` drop (rules dir itself is an escaping symlink)
 *  - dir-level `Ne` drop (Project scope, `.claude` PARENT is an escaping
 *    symlink, grandparent under cwd) — new in v284
 *  - `We`/`kn` linkedFrom provenance tagging when external includes ARE
 *    allowed, and the `KRt` second collector branch feeding the approval
 *    dialog surface
 *  - i9 User-scope reject: top-level symlink / hardlinked regular file under
 *    the local-agent entrypoint
 */

const FIXTURE_SOURCES: SettingSource[] = [
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

let savedSources: SettingSource[]
let savedCwd: string
let savedAutoMemEnv: string | undefined
let savedEntrypoint: string | undefined
let root: string
let proj: string
let outside: string
let rulesDir: string

beforeEach(async () => {
  savedSources = getAllowedSettingSources()
  savedCwd = process.cwd()
  savedAutoMemEnv = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  setAllowedSettingSources(FIXTURE_SOURCES)

  // realpath the fixture root so originalCwd and resolved paths share one
  // canonical prefix on hosts where tmpdir itself is a symlink (macOS
  // /var → /private/var); Linux is unaffected.
  root = realpathSync(await mkdtemp(join(tmpdir(), 'occ-rules-escape-284-')))
  proj = join(root, 'proj')
  outside = join(root, 'outside')
  rulesDir = join(proj, '.claude', 'rules')
  mkdirSync(rulesDir, { recursive: true })
  mkdirSync(outside, { recursive: true })
  setOriginalCwd(proj)
})

afterEach(async () => {
  setAllowedSettingSources(savedSources)
  setOriginalCwd(savedCwd)
  if (savedAutoMemEnv === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  } else {
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = savedAutoMemEnv
  }
  if (savedEntrypoint === undefined) {
    delete process.env.CLAUDE_CODE_ENTRYPOINT
  } else {
    process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint
  }
  await rm(root, { recursive: true, force: true })
})

function writeOutsideRule(name: string, content: string): string {
  const target = join(outside, name)
  writeFileSync(target, content, 'utf8')
  return target
}

describe('CC 2.1.284 — processMdRules per-entry escape drop (en&&!Ce)', () => {
  test('drops an escaping symlinked .md entry when external includes are not allowed', async () => {
    // Arrange
    const target = writeOutsideRule('evil.md', 'EVIL RULE CONTENT')
    symlinkSync(target, join(rulesDir, 'link.md'))

    // Act
    const files = await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: new Set(),
      includeExternal: false,
      conditionalRule: false,
    })

    // Assert
    expect(files).toEqual([])
  })

  test('drops an escaping symlinked rules SUBDIRECTORY when not allowed', async () => {
    // Arrange
    const outsideRules = join(outside, 'rulesdir')
    mkdirSync(outsideRules, { recursive: true })
    writeFileSync(join(outsideRules, 'x.md'), 'ESCAPED SUBDIR RULE', 'utf8')
    symlinkSync(outsideRules, join(rulesDir, 'sub'))

    // Act
    const files = await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: new Set(),
      includeExternal: false,
      conditionalRule: false,
    })

    // Assert
    expect(files).toEqual([])
  })

  test('loads a NON-escaping symlinked .md entry unapproved and does not tag it', async () => {
    // Arrange — target inside the project (pathInOriginalCwd true → en false)
    const internal = join(proj, 'internal.md')
    writeFileSync(internal, 'INTERNAL RULE', 'utf8')
    symlinkSync(internal, join(rulesDir, 'link.md'))

    // Act
    const files = await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: new Set(),
      includeExternal: false,
      conditionalRule: false,
    })

    // Assert
    expect(files.length).toBe(1)
    expect(files[0]?.content).toContain('INTERNAL RULE')
    expect(files[0]?.linkedFrom).toBeUndefined()
    expect(getExternalClaudeMdIncludes(files)).toEqual([])
  })

  test('loads a plain .md file without linkedFrom (no regression)', async () => {
    // Arrange
    writeFileSync(join(rulesDir, 'plain.md'), 'PLAIN RULE', 'utf8')

    // Act
    const files = await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: new Set(),
      includeExternal: false,
      conditionalRule: false,
    })

    // Assert
    expect(files.length).toBe(1)
    expect(files[0]?.content).toContain('PLAIN RULE')
    expect(files[0]?.linkedFrom).toBeUndefined()
  })
})

describe('CC 2.1.284 — processMdRules dir-level escape drops (De/Ne)', () => {
  test('drops the whole walk when the rules dir itself is an escaping symlink (De arm)', async () => {
    // Arrange — .claude/rules → outside/rules
    const outsideRules = join(outside, 'rules')
    mkdirSync(outsideRules, { recursive: true })
    writeFileSync(join(outsideRules, 'a.md'), 'ESCAPED DIR RULE', 'utf8')
    rmSyncRulesDir()
    symlinkSync(outsideRules, rulesDir)

    // Act
    const files = await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: new Set(),
      includeExternal: false,
      conditionalRule: false,
    })

    // Assert
    expect(files).toEqual([])
  })

  test('drops when the .claude PARENT is an escaping symlink under cwd (Ne arm, new in v284)', async () => {
    // Arrange — proj/.claude → outside/dotclaude (rules dir itself is real
    // inside the target; grandparent proj is under originalCwd)
    const outsideDot = join(outside, 'dotclaude')
    mkdirSync(join(outsideDot, 'rules'), { recursive: true })
    writeFileSync(
      join(outsideDot, 'rules', 'n.md'),
      'PARENT ESCAPE RULE',
      'utf8',
    )
    rmSyncRulesDir()
    rmSyncDotClaude()
    symlinkSync(outsideDot, join(proj, '.claude'))

    // Act
    const files = await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: new Set(),
      includeExternal: false,
      conditionalRule: false,
    })

    // Assert
    expect(files).toEqual([])
  })
})

describe('CC 2.1.284 — linkedFrom provenance + KRt collector (allowed case)', () => {
  test('escaping symlinked .md loads when allowed and is tagged linkedFrom=canonical expected path (kn=Vt)', async () => {
    // Arrange
    const target = writeOutsideRule('evil.md', 'EVIL RULE CONTENT')
    const linkPath = join(rulesDir, 'link.md')
    symlinkSync(target, linkPath)

    // Act
    const files = await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: new Set(),
      includeExternal: true,
      conditionalRule: false,
    })

    // Assert
    expect(files.length).toBe(1)
    expect(files[0]?.content).toContain('EVIL RULE CONTENT')
    expect(files[0]?.linkedFrom).toBe(linkPath)
    // KRt second branch feeds the approval-dialog surface
    const externals = getExternalClaudeMdIncludes(files)
    expect(externals.length).toBe(1)
    expect(externals[0]?.parent).toBe(linkPath)
    expect(externals[0]?.path).toBe(files[0]?.path)
  })

  test('escaping symlinked RULES DIR loads children when allowed, tagged linkedFrom=rulesDir (We=De?e)', async () => {
    // Arrange
    const outsideRules = join(outside, 'rules')
    mkdirSync(outsideRules, { recursive: true })
    writeFileSync(join(outsideRules, 'a.md'), 'ESCAPED DIR RULE', 'utf8')
    rmSyncRulesDir()
    symlinkSync(outsideRules, rulesDir)

    // Act
    const files = await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: new Set(),
      includeExternal: true,
      conditionalRule: false,
    })

    // Assert
    expect(files.length).toBe(1)
    expect(files[0]?.content).toContain('ESCAPED DIR RULE')
    expect(files[0]?.linkedFrom).toBe(rulesDir)
    expect(getExternalClaudeMdIncludes(files).length).toBe(1)
  })

  test('User scope: escaping symlink loads when allowed but is NOT tagged (Pe=false, KRt excludes User)', async () => {
    // Arrange
    const target = writeOutsideRule('user-evil.md', 'USER ESCAPE RULE')
    symlinkSync(target, join(rulesDir, 'ulink.md'))

    // Act
    const files = await processMdRules({
      rulesDir,
      type: 'User',
      processedPaths: new Set(),
      includeExternal: true,
      conditionalRule: false,
    })

    // Assert — kn = We ?? (en&&Pe ? Vt : void 0); Pe is false for User
    expect(files.length).toBe(1)
    expect(files[0]?.linkedFrom).toBeUndefined()
    expect(getExternalClaudeMdIncludes(files)).toEqual([])
  })
})

describe('CC 2.1.284 — processMemoryFile User-scope reject (i9 backfill)', () => {
  test('local-agent entrypoint: top-level User symlink is rejected', async () => {
    // Arrange
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    const real = join(proj, 'real-user.md')
    writeFileSync(real, 'USER MEMORY', 'utf8')
    const link = join(proj, 'link-user.md')
    symlinkSync(real, link)

    // Act
    const files = await processMemoryFile(
      link,
      'User',
      new Set(),
      true, // s=true — official F = s && wet(); wet() is false in local-agent
      0,
    )

    // Assert
    expect(files).toEqual([])
  })

  test('local-agent entrypoint: hardlinked User file (nlink>1) is rejected', async () => {
    // Arrange
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    const real = join(proj, 'real-user.md')
    writeFileSync(real, 'USER MEMORY', 'utf8')
    const hard = join(proj, 'hard-user.md')
    linkSync(real, hard)

    // Act
    const files = await processMemoryFile(hard, 'User', new Set(), true, 0)

    // Assert
    expect(files).toEqual([])
  })

  test('normal entrypoint: the same User symlink loads (wet()=true)', async () => {
    // Arrange — CLAUDE_CODE_ENTRYPOINT unset in beforeEach
    const real = join(proj, 'real-user.md')
    writeFileSync(real, 'USER MEMORY', 'utf8')
    const link = join(proj, 'link-user.md')
    symlinkSync(real, link)

    // Act
    const files = await processMemoryFile(link, 'User', new Set(), true, 0)

    // Assert
    expect(files.length).toBe(1)
    expect(files[0]?.content).toContain('USER MEMORY')
  })

  test('local-agent entrypoint: depth>0 User symlink is NOT hit by the top-level arm', async () => {
    // Arrange — the reject's symlink arm requires depth===0 (official g===0);
    // an in-cwd target keeps the include-loop external gate out of play.
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    const real = join(proj, 'real-user.md')
    writeFileSync(real, 'USER MEMORY', 'utf8')
    const link = join(proj, 'link-user.md')
    symlinkSync(real, link)

    // Act
    const files = await processMemoryFile(link, 'User', new Set(), true, 1)

    // Assert
    expect(files.length).toBe(1)
    expect(files[0]?.content).toContain('USER MEMORY')
  })
})

describe('CC 2.1.284 — processMemoryFile include-walk external gate (i9 F-gate, P3-6)', () => {
  // SECURITY property: for User-scope memory under the local-agent
  // entrypoint, externalAllowed (official `F`) is false EVEN WHEN the caller
  // passed includeExternal=true — escaping @includes must still be dropped.
  // Official: `for(let Ce of ve){if(!TP(Ce)&&!F)continue;...}` (v284 i9
  // @205757900 region) gates on F, not on the raw includeExternal argument.
  function writeUserMemoryWithEscapingInclude(): {
    main: string
    secret: string
  } {
    const secret = writeOutsideRule('secret.md', 'ESCAPED SECRET CONTENT')
    const main = join(proj, 'user-memory.md')
    writeFileSync(main, `MAIN USER MEMORY\n\n@${secret}\n`, 'utf8')
    return { main, secret }
  }

  test('local-agent User scope: escaping @include is DROPPED even with includeExternal=true', async () => {
    // Arrange
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    const { main } = writeUserMemoryWithEscapingInclude()

    // Act — s=true (includeExternal), but F = s && wet() = false in local-agent
    const files = await processMemoryFile(main, 'User', new Set(), true, 0)

    // Assert — main file loads; the escaping include never enters the walk
    expect(files.length).toBe(1)
    expect(files[0]?.content).toContain('MAIN USER MEMORY')
    expect(files.some(f => f.content.includes('ESCAPED SECRET CONTENT'))).toBe(
      false,
    )
  })

  test('normal entrypoint User scope: the same escaping @include loads (F=true)', async () => {
    // Arrange — CLAUDE_CODE_ENTRYPOINT unset in beforeEach → wet()=true
    const { main } = writeUserMemoryWithEscapingInclude()

    // Act
    const files = await processMemoryFile(main, 'User', new Set(), true, 0)

    // Assert — parent first, then the included external file
    expect(files.length).toBe(2)
    expect(files[0]?.content).toContain('MAIN USER MEMORY')
    expect(files[1]?.content).toContain('ESCAPED SECRET CONTENT')
    expect(files[1]?.parent).toBe(main)
  })

  test('local-agent Project scope: escaping @include still loads (F keys on User scope only)', async () => {
    // Arrange
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    const { main } = writeUserMemoryWithEscapingInclude()

    // Act — F = s && (type !== 'User' || wet()) → true for Project
    const files = await processMemoryFile(main, 'Project', new Set(), true, 0)

    // Assert
    expect(files.length).toBe(2)
    expect(files[1]?.content).toContain('ESCAPED SECRET CONTENT')
  })

  test('includeExternal=false drops the escaping include for ANY scope (F conjunct)', async () => {
    // Arrange
    const { main } = writeUserMemoryWithEscapingInclude()

    // Act — normal entrypoint, but s=false → F=false
    const files = await processMemoryFile(main, 'Project', new Set(), false, 0)

    // Assert
    expect(files.length).toBe(1)
    expect(files.some(f => f.content.includes('ESCAPED SECRET CONTENT'))).toBe(
      false,
    )
  })

  test('an IN-CWD @include is unaffected by the external gate (local-agent User scope)', async () => {
    // Arrange — TP(Ce) true → the `!TP&&!F` drop does not fire
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
    const internal = join(proj, 'internal-include.md')
    writeFileSync(internal, 'INTERNAL INCLUDE CONTENT', 'utf8')
    const main = join(proj, 'user-memory.md')
    writeFileSync(main, `MAIN USER MEMORY\n\n@${internal}\n`, 'utf8')

    // Act
    const files = await processMemoryFile(main, 'User', new Set(), true, 0)

    // Assert
    expect(files.length).toBe(2)
    expect(files[1]?.content).toContain('INTERNAL INCLUDE CONTENT')
  })
})

// Fixture helpers — replace the pre-created real rules dir / .claude with a
// symlink for the dir-level escape tests.
function rmSyncRulesDir(): void {
  rmSync(rulesDir, { recursive: true, force: true })
}

function rmSyncDotClaude(): void {
  rmSync(join(proj, '.claude'), { recursive: true, force: true })
}
