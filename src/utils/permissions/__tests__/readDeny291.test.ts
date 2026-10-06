import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAllowedSettingSources,
  getCwdState,
  setAllowedSettingSources,
  setCwdState,
  setOriginalCwd,
} from '../../../bootstrap/state.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
} from '../../../Tool.js'
import type { PermissionRule } from '../../../types/permissions.js'
import type { SettingSource } from '../../settings/constants.js'
import { resetSettingsCache } from '../../settings/settingsCache.js'

// MACRO.VERSION polyfill (read via getBundledSkillsRoot in the permission path).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Unit coverage for `src/utils/permissions/readDeny.ts` — the shared
 * Read-deny predicate module extracted for CC 2.1.290 cluster B.
 *
 * Official counterparts (byte-verified; see
 * docs/gap-research-291/cluster-b-read-deny-mentions.md):
 *  - `Drr`/`sy`  — `Kn(ctx,"read","deny").size>0` gate → `hasReadDenyRules`
 *  - `aje`+`bge(Sge(path),ctx)` — every-spelling deny → `isFileReadDenied`
 *  - `f1({strictPersistedTrust:!0}).filter(deny)` → `loadPersistedReadDenyRules`
 *  - `N2` @210758348 — immutable per-source merge → `extendContextWith…`
 *  - `igs` @210758348 — persisted-only context → `getPersistedReadDenyContext`
 *
 * The @-mention / paste / instruction-file surfaces that consume these are
 * covered by their own suites (attachmentsDirDeny291, imagePasteDeny291,
 * usePasteHandlerDeny291, claudemdReadDeny291); this file pins the primitives.
 */

// projectSettings + localSettings drive the fixtures; userSettings excluded so
// ~/.claude rules can't pollute assertions (convention: claudemdReadDeny291).
const FIXTURE_SOURCES: SettingSource[] = [
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, count only the spelling-resolution entry point.
const actualFsOperations = await import('../../fsOperations.js')
// Hold the ORIGINAL function reference: the module namespace object is the same
// one mock.module rebinds, so calling `actualFsOperations.getPaths…` from inside
// the wrapper would recurse into the wrapper itself.
const actualGetPathsForPermissionCheck =
  actualFsOperations.getPathsForPermissionCheck
let spellingResolutionCalls = 0

mock.module('../../fsOperations.js', () => ({
  ...actualFsOperations,
  getPathsForPermissionCheck: (inputPath: string) => {
    spellingResolutionCalls += 1
    return actualGetPathsForPermissionCheck(inputPath)
  },
}))

const {
  hasReadDenyRules,
  isFileReadDenied,
  loadPersistedReadDenyRules,
  extendContextWithPersistedReadDenyRules,
  getPersistedReadDenyContext,
  resetPersistedReadDenyContextForTesting,
} = await import('../readDeny.js')

afterAll(() => {
  mock.module('../../fsOperations.js', () => ({ ...actualFsOperations }))
})

let tmpDir: string
let repoDir: string
let savedSources: SettingSource[]
let savedCwd: string
let savedCwdState: string

beforeAll(() => {
  savedSources = getAllowedSettingSources()
  savedCwd = process.cwd()
  savedCwdState = getCwdState()
  setAllowedSettingSources(FIXTURE_SOURCES)
})

afterAll(() => {
  setAllowedSettingSources(savedSources)
  setOriginalCwd(savedCwd)
  setCwdState(savedCwdState)
  resetSettingsCache()
})

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'occ-readden-291-')))
  repoDir = join(tmpDir, 'repo')
  mkdirSync(repoDir, { recursive: true })
  setOriginalCwd(repoDir)
  setCwdState(repoDir)
  resetSettingsCache()
  resetPersistedReadDenyContextForTesting()
  spellingResolutionCalls = 0
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── fixture helpers ────────────────────────────────────────────────────────

/** A context whose deny rules come from `ruleValues`, keyed by one source. */
function contextWithDenyRules(
  ruleValues: readonly string[],
  source: PermissionRule['source'] = 'userSettings',
): ToolPermissionContext {
  const base = getEmptyToolPermissionContext()
  return ruleValues.length === 0
    ? base
    : {
        ...base,
        alwaysDenyRules: { ...base.alwaysDenyRules, [source]: [...ruleValues] },
      }
}

/** Write `<repo>/.claude/settings.json` and drop the settings caches. */
function stageProjectSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(repoDir, '.claude'), { recursive: true })
  writeFileSync(
    join(repoDir, '.claude', 'settings.json'),
    JSON.stringify(settings),
    'utf-8',
  )
  resetSettingsCache()
  resetPersistedReadDenyContextForTesting()
}

function stageFile(relPath: string, content: string): string {
  const full = join(repoDir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf-8')
  return full
}

function stageLink(relPath: string, target: string): string {
  const full = join(repoDir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  symlinkSync(target, full)
  return full
}

// Absolute-path deny rules need the doubled leading slash: a single `/` is
// settings-dir-relative and silently matches nothing (recorded trap, gap doc).
function absoluteDenyRule(path: string): string {
  return `Read(/${path}/**)`
}

// ─── hasReadDenyRules (official Drr / sy deny-rule arm) ─────────────────────

describe('hasReadDenyRules', () => {
  test('returns false for an empty permission context', () => {
    expect(hasReadDenyRules(getEmptyToolPermissionContext())).toBe(false)
  })

  test('returns false when the only deny rules belong to another tool', () => {
    const context = contextWithDenyRules(['Bash(rm:*)'])

    expect(hasReadDenyRules(context)).toBe(false)
  })

  test('returns true when a Read deny rule is present', () => {
    const context = contextWithDenyRules([absoluteDenyRule('/tmp/whatever')])

    expect(hasReadDenyRules(context)).toBe(true)
  })
})

// ─── isFileReadDenied (official aje + bge(Sge(path), ctx)) ──────────────────

describe('isFileReadDenied', () => {
  test('denies a path matched on its surface spelling', () => {
    const secret = stageFile('secret/token.txt', 'top secret')
    const context = contextWithDenyRules([
      absoluteDenyRule(join(repoDir, 'secret')),
    ])

    expect(isFileReadDenied(secret, context)).toBe(true)
  })

  test('denies a symlink whose landing is covered but whose surface spelling is not', () => {
    const secret = stageFile('secret/token.txt', 'top secret')
    const link = stageLink('innocent/link.txt', secret)
    const context = contextWithDenyRules([
      absoluteDenyRule(join(repoDir, 'secret')),
    ])

    // Pre-2.1.289 behavior matched only `link` and allowed the read.
    expect(isFileReadDenied(link, context)).toBe(true)
  })

  test('allows a path no deny rule covers', () => {
    const allowed = stageFile('public/readme.txt', 'hello')
    const context = contextWithDenyRules([
      absoluteDenyRule(join(repoDir, 'secret')),
    ])

    expect(isFileReadDenied(allowed, context)).toBe(false)
  })

  test('skips the spelling resolution entirely when no Read deny rule exists', () => {
    const secret = stageFile('secret/token.txt', 'top secret')
    const context = contextWithDenyRules(['Bash(rm:*)'])

    expect(isFileReadDenied(secret, context)).toBe(false)
    // Official aje(ctx) short-circuit: no read-deny rule ⇒ no fs syscalls.
    expect(spellingResolutionCalls).toBe(0)
  })

  test('short-circuits without resolving spellings once the surface spelling matches', () => {
    const secret = stageFile('secret/token.txt', 'top secret')
    const context = contextWithDenyRules([
      absoluteDenyRule(join(repoDir, 'secret')),
    ])

    expect(isFileReadDenied(secret, context)).toBe(true)
    // The surface arm already decided — the fs syscalls are skipped.
    expect(spellingResolutionCalls).toBe(0)
  })

  test('resolves spellings when a Read deny rule exists and the surface does not match', () => {
    const allowed = stageFile('public/readme.txt', 'hello')
    const context = contextWithDenyRules([
      absoluteDenyRule(join(repoDir, 'secret')),
    ])

    expect(isFileReadDenied(allowed, context)).toBe(false)
    expect(spellingResolutionCalls).toBeGreaterThan(0)
  })
})

// ─── loadPersistedReadDenyRules (official f1({strictPersistedTrust:!0})) ────

describe('loadPersistedReadDenyRules', () => {
  test('returns only the deny rules persisted on disk', () => {
    stageProjectSettings({
      permissions: {
        deny: ['Read(//etc/shadow)', 'Bash(rm -rf:*)'],
        allow: ['Read(//tmp/**)'],
      },
    })

    const rules = loadPersistedReadDenyRules()

    expect(rules.map(rule => rule.ruleBehavior)).toEqual(['deny', 'deny'])
    expect(rules.map(rule => rule.source)).toEqual([
      'projectSettings',
      'projectSettings',
    ])
  })

  test('returns an empty list when nothing is persisted', () => {
    expect(loadPersistedReadDenyRules()).toEqual([])
  })
})

// ─── extendContextWithPersistedReadDenyRules (official N2) ──────────────────

describe('extendContextWithPersistedReadDenyRules', () => {
  const rule = (
    ruleContent: string,
    source: PermissionRule['source'] = 'projectSettings',
  ): PermissionRule => ({
    source,
    ruleBehavior: 'deny',
    ruleValue: { toolName: 'Read', ruleContent },
  })

  test('never mutates the context it is given', () => {
    const input = getEmptyToolPermissionContext()
    const before = JSON.stringify(input)

    const extended = extendContextWithPersistedReadDenyRules(input, [
      rule('//tmp/a/**'),
    ])

    expect(JSON.stringify(input)).toBe(before)
    expect(extended).not.toBe(input)
    expect(extended.alwaysDenyRules.projectSettings).toEqual([
      'Read(//tmp/a/**)',
    ])
  })

  test('de-duplicates a rule value already present for that source', () => {
    const input = contextWithDenyRules(['Read(//tmp/a/**)', 'Read(//tmp/a/**)'], 'projectSettings')

    const extended = extendContextWithPersistedReadDenyRules(input, [
      rule('//tmp/a/**'),
      rule('//tmp/a/**'),
    ])

    expect(extended.alwaysDenyRules.projectSettings).toEqual([
      'Read(//tmp/a/**)',
      'Read(//tmp/a/**)',
    ])
  })

  test('keys merged rules by their own source', () => {
    const extended = extendContextWithPersistedReadDenyRules(
      getEmptyToolPermissionContext(),
      [rule('//tmp/a/**', 'projectSettings'), rule('//tmp/b/**', 'policySettings')],
    )

    expect(extended.alwaysDenyRules.projectSettings).toEqual(['Read(//tmp/a/**)'])
    expect(extended.alwaysDenyRules.policySettings).toEqual(['Read(//tmp/b/**)'])
  })
})

// ─── getPersistedReadDenyContext (official igs) ─────────────────────────────

describe('getPersistedReadDenyContext', () => {
  test('carries the persisted deny rules and denies a covered path', () => {
    const secret = stageFile('secret/token.txt', 'top secret')
    stageProjectSettings({
      permissions: { deny: [absoluteDenyRule(join(repoDir, 'secret'))] },
    })

    const context = getPersistedReadDenyContext()

    expect(hasReadDenyRules(context)).toBe(true)
    expect(isFileReadDenied(secret, context)).toBe(true)
  })

  test('returns the identical memoized object while the rule set is unchanged', () => {
    stageProjectSettings({
      permissions: { deny: [absoluteDenyRule(join(repoDir, 'secret'))] },
    })

    const first = getPersistedReadDenyContext()
    const second = getPersistedReadDenyContext()

    // Identity matters: matchingRuleForInput caches compiled matchers by
    // rules-object identity, so a fresh object per probe would rebuild them.
    expect(second).toBe(first)
  })

  test('yields a new context once the persisted rules change', () => {
    stageProjectSettings({
      permissions: { deny: [absoluteDenyRule(join(repoDir, 'secret'))] },
    })
    const first = getPersistedReadDenyContext()

    stageProjectSettings({
      permissions: {
        deny: [
          absoluteDenyRule(join(repoDir, 'secret')),
          absoluteDenyRule(join(repoDir, 'private')),
        ],
      },
    })
    const second = getPersistedReadDenyContext()

    expect(second).not.toBe(first)
    expect(second.alwaysDenyRules.projectSettings).toHaveLength(2)
  })

  test('resetPersistedReadDenyContextForTesting drops the memo', () => {
    stageProjectSettings({
      permissions: { deny: [absoluteDenyRule(join(repoDir, 'secret'))] },
    })
    const first = getPersistedReadDenyContext()

    resetPersistedReadDenyContextForTesting()
    const second = getPersistedReadDenyContext()

    expect(second).not.toBe(first)
    expect(second.alwaysDenyRules).toEqual(first.alwaysDenyRules)
  })
})
