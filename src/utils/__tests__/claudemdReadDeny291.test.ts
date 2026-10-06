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
import { join, resolve } from 'node:path'
import {
  getAllowedSettingSources,
  getCwdState,
  setAllowedSettingSources,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
} from '../../Tool.js'
import type { SettingSource } from '../settings/constants.js'
import { resetSettingsCache } from '../settings/settingsCache.js'

// MACRO.VERSION polyfill (read via getBundledSkillsRoot in the permission path).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.290 changelog (security) — cluster B4:
 *   "Fixed a project `CLAUDE.md`, rule or `AGENTS.md` symlinked outside the
 *    working directories loading under `permissions.blockReadsOutsideWorking
 *    Directories` or a `Read` deny rule."
 *
 * Official v290 mechanism (byte-verified; see
 * docs/gap-research-291/cluster-b-read-deny-mentions.md §B4):
 *  - `N2`/`igs` @210758348 extend a permission context with the PERSISTED deny
 *    rules read from disk (`f1({strictPersistedTrust:!0})` filtered to
 *    `ruleBehavior==="deny"`) — instruction files load at startup, where no
 *    live engine context exists.
 *  - `Bkt` @210755603 classifies a candidate as
 *    `"unsettled" | "denied" | "outside"`.
 *  - `lSt` @210758400 logs the withheld file
 *    (`Instruction file not loaded: ${path} (${dSt[reason]})`) with
 *    `dSt = { denied: "a Read deny rule covers it",
 *             outside: "it's read from outside your working directories, where
 *                      reads are blocked",
 *             unsettled: "where it leads couldn't be worked out" }`.
 *
 * OCC port scope (per the gap doc's 判定): the **deny arm** only.
 *  - `outside` arm: N-A (`blockReadsOutsideWorkingDirectories` / `--restricted`
 *    are absent from OCC — grep-proven, staged since OCC-107/108).
 *  - `unsettled` arm: behaviorally a NO-OP (the 2.1.282 fail-closed
 *    `shouldRefuseMemorySymlink` already refuses unresolvable links); only the
 *    log wording is aligned here.
 *
 * All four loader entry points named by the gap doc funnel through
 * `safelyReadMemoryFileAsync`, and each is exercised below:
 *   getMemoryFiles (project walk) · processMdRules (.claude/rules) ·
 *   applyAgentsMdInstructionMode (AGENTS.md mode) · getMemoryFilesForNestedDirectory.
 */

// projectSettings + localSettings drive the fixtures; userSettings excluded so
// ~/.claude memory/rules can't pollute assertions (convention: memorySymlinkRefusal282).
const FIXTURE_SOURCES: SettingSource[] = [
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

// Official reason strings (dSt), verbatim.
const REASON_DENIED = 'a Read deny rule covers it'
const REASON_UNSETTLED = "where it leads couldn't be worked out"

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only logForDebugging, and restore after.
const actualDebug = await import('../debug.js')
let debugLogs: string[] = []

mock.module('../debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    debugLogs.push(`${opts?.level ?? 'debug'}:${message}`)
  },
}))

const {
  getMemoryFiles,
  getMemoryFilesForNestedDirectory,
  processMdRules,
  processMemoryFile,
  resetGetMemoryFilesCache,
  safelyReadMemoryFileAsyncForTesting,
} = await import('../claudemd.js')
const {
  extendContextWithPersistedReadDenyRules,
  getPersistedReadDenyContext,
  isFileReadDenied,
} = await import('../permissions/readDeny.js')

afterAll(() => {
  mock.module('../debug.js', () => ({ ...actualDebug }))
})

let tmpDir: string
let repoDir: string
let savedSources: SettingSource[]
let savedCwd: string
let savedCwdState: string
let savedAutoMemEnv: string | undefined

beforeAll(() => {
  savedSources = getAllowedSettingSources()
  savedCwd = process.cwd()
  savedCwdState = getCwdState()
  savedAutoMemEnv = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  // Deterministic: keep AutoMem out of the loaded set.
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  setAllowedSettingSources(FIXTURE_SOURCES)
})

afterAll(() => {
  setAllowedSettingSources(savedSources)
  setOriginalCwd(savedCwd)
  setCwdState(savedCwdState)
  resetSettingsCache()
  if (savedAutoMemEnv === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  } else {
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = savedAutoMemEnv
  }
})

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'occ-claudemd-deny291-')))
  repoDir = join(tmpDir, 'repo')
  mkdirSync(repoDir, { recursive: true })
  setOriginalCwd(repoDir)
  setCwdState(repoDir)
  resetSettingsCache()
  resetGetMemoryFilesCache()
  debugLogs = []
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── fixture helpers ────────────────────────────────────────────────────────

/** Write `<repo>/.claude/settings.json` and drop the settings caches. */
function stageProjectSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(repoDir, '.claude'), { recursive: true })
  writeFileSync(
    join(repoDir, '.claude', 'settings.json'),
    JSON.stringify(settings),
    'utf-8',
  )
  resetSettingsCache()
}

function stageDenyRules(
  deny: string[],
  extra: Record<string, unknown> = {},
): void {
  stageProjectSettings({ ...extra, permissions: { deny } })
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

/** Parsed `Instruction file not loaded: <path> (<reason>)` diagnostics. */
function notLoadedEntries(): Array<{ level: string; path: string; reason: string }> {
  const re =
    /^(\w+):Instruction file not loaded: (.+) \((a Read deny rule covers it|where it leads couldn't be worked out|it's read from outside your working directories, where reads are blocked)\)$/
  const out: Array<{ level: string; path: string; reason: string }> = []
  for (const line of debugLogs) {
    const m = re.exec(line)
    if (m) {
      out.push({ level: m[1] ?? '', path: m[2] ?? '', reason: m[3] ?? '' })
    }
  }
  return out
}

function expectNotLoaded(expectedPath: string, reason: string): void {
  const entries = notLoadedEntries()
  expect(
    entries.some(
      e => e.reason === reason && resolve(e.path) === resolve(expectedPath),
    ),
  ).toBe(true)
}

function expectNoNotLoadedLogs(): void {
  expect(notLoadedEntries()).toEqual([])
}

// ─── unit: persisted deny context (official N2/igs analog) ──────────────────

describe('CC 2.1.290 B4 — persisted Read-deny context (N2/igs)', () => {
  test('deny rules are read off disk into alwaysDenyRules, keyed by source', () => {
    stageDenyRules(['Read(CLAUDE.md)'])
    const ctx = getPersistedReadDenyContext()
    expect(ctx.alwaysDenyRules.projectSettings).toContain('Read(CLAUDE.md)')
    expect(isFileReadDenied(join(repoDir, 'CLAUDE.md'), ctx)).toBe(true)
  })

  test('allow/ask rules are NOT imported as deny rules', () => {
    stageProjectSettings({
      permissions: {
        allow: ['Read(allowed.md)'],
        ask: ['Read(askme.md)'],
        deny: ['Read(denied.md)'],
      },
    })
    const ctx = getPersistedReadDenyContext()
    expect(ctx.alwaysDenyRules.projectSettings).toEqual(['Read(denied.md)'])
    expect(isFileReadDenied(join(repoDir, 'allowed.md'), ctx)).toBe(false)
    expect(isFileReadDenied(join(repoDir, 'askme.md'), ctx)).toBe(false)
    expect(isFileReadDenied(join(repoDir, 'denied.md'), ctx)).toBe(true)
  })

  test('no settings file → empty deny context, nothing denied', () => {
    const ctx = getPersistedReadDenyContext()
    expect(isFileReadDenied(join(repoDir, 'CLAUDE.md'), ctx)).toBe(false)
  })

  test('extendContextWithPersistedReadDenyRules is immutable + merges rules', () => {
    stageDenyRules(['Read(CLAUDE.md)'])
    const base: ToolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: { userSettings: ['Read(user.md)'] },
    }
    const extended = extendContextWithPersistedReadDenyRules(base)

    expect(extended).not.toBe(base)
    // Input untouched.
    expect(base.alwaysDenyRules).toEqual({ userSettings: ['Read(user.md)'] })
    // Both the live and the persisted rules are enforced in the copy.
    expect(extended.alwaysDenyRules.userSettings).toContain('Read(user.md)')
    expect(extended.alwaysDenyRules.projectSettings).toContain('Read(CLAUDE.md)')
    expect(isFileReadDenied(join(repoDir, 'CLAUDE.md'), extended)).toBe(true)
  })
})

// ─── integration: project CLAUDE.md walk ────────────────────────────────────

describe('CC 2.1.290 B4 — project CLAUDE.md under a Read deny rule', () => {
  test('denied project CLAUDE.md is not loaded + exact official log line', async () => {
    const claudeMd = stageFile('CLAUDE.md', '# DENIED-MARKER-291\n')
    stageDenyRules(['Read(CLAUDE.md)'])

    const files = await processMemoryFile(
      claudeMd,
      'Project',
      new Set<string>(),
      true,
    )
    expect(files).toEqual([])
    expectNotLoaded(claudeMd, REASON_DENIED)
  })

  test('CLAUDE.md symlink denied at the LANDING is not loaded', async () => {
    const secret = stageFile(
      join('..', 'outside-secret.md'),
      'OUTSIDE-SECRET-291\n',
    )
    const link = stageLink('CLAUDE.md', secret)
    stageDenyRules([`Read(//${secret})`])

    const files = await processMemoryFile(
      link,
      'Project',
      new Set<string>(),
      true,
    )
    expect(files).toEqual([])
    expectNotLoaded(link, REASON_DENIED)
  })

  test('benign CLAUDE.md loads when the deny rule covers something else', async () => {
    const claudeMd = stageFile('CLAUDE.md', '# BENIGN-MARKER-291\n')
    stageDenyRules(['Read(some-other.md)'])

    const files = await processMemoryFile(
      claudeMd,
      'Project',
      new Set<string>(),
      true,
    )
    expect(files.map(f => f.path)).toContain(claudeMd)
    expect(files.map(f => f.content).join('\n')).toContain('BENIGN-MARKER-291')
    expectNoNotLoadedLogs()
  })

  test('no deny rules at all → unchanged load (no false positive)', async () => {
    const claudeMd = stageFile('CLAUDE.md', '# NO-RULES-291\n')
    const files = await processMemoryFile(
      claudeMd,
      'Project',
      new Set<string>(),
      true,
    )
    expect(files.map(f => f.path)).toContain(claudeMd)
    expectNoNotLoadedLogs()
  })

  test('getMemoryFiles: denied CLAUDE.md absent, benign .claude/CLAUDE.md kept', async () => {
    stageFile('CLAUDE.md', '# DENIED-MARKER-291\n')
    const inner = stageFile(join('.claude', 'CLAUDE.md'), 'INNER-OK-291\n')
    // Root-anchored: only <repo>/CLAUDE.md is covered (gitignore semantics —
    // the unanchored `Read(CLAUDE.md)` would match at any depth).
    stageDenyRules(['Read(/CLAUDE.md)'])
    resetGetMemoryFilesCache()

    const files = await getMemoryFiles()
    const projectPaths = files
      .filter(f => f.type === 'Project' || f.type === 'Local')
      .map(f => f.path)
    expect(projectPaths).not.toContain(join(repoDir, 'CLAUDE.md'))
    expect(projectPaths).toContain(inner)
    const content = files.map(f => f.content).join('\n')
    expect(content).not.toContain('DENIED-MARKER-291')
    expect(content).toContain('INNER-OK-291')
    expectNotLoaded(join(repoDir, 'CLAUDE.md'), REASON_DENIED)
  })

  test('unanchored Read(CLAUDE.md) withholds every depth (gitignore semantics)', async () => {
    stageFile('CLAUDE.md', '# DENIED-TOP-291\n')
    stageFile(join('.claude', 'CLAUDE.md'), '# DENIED-INNER-291\n')
    stageDenyRules(['Read(CLAUDE.md)'])
    resetGetMemoryFilesCache()

    const files = await getMemoryFiles()
    const projectPaths = files
      .filter(f => f.type === 'Project' || f.type === 'Local')
      .map(f => f.path)
    expect(projectPaths).not.toContain(join(repoDir, 'CLAUDE.md'))
    expect(projectPaths).not.toContain(join(repoDir, '.claude', 'CLAUDE.md'))
    const content = files.map(f => f.content).join('\n')
    expect(content).not.toContain('DENIED-TOP-291')
    expect(content).not.toContain('DENIED-INNER-291')
  })
})

// ─── integration: .claude/rules walker ──────────────────────────────────────

describe('CC 2.1.290 B4 — .claude/rules walker skips denied entries', () => {
  async function walkRules(): Promise<
    Awaited<ReturnType<typeof processMdRules>>
  > {
    return processMdRules({
      rulesDir: join(repoDir, '.claude', 'rules'),
      type: 'Project',
      processedPaths: new Set<string>(),
      includeExternal: true,
      conditionalRule: false,
    })
  }

  test('denied rule file skipped, sibling still loads', async () => {
    const good = stageFile(join('.claude', 'rules', 'good.md'), 'RULE-GOOD-291\n')
    const denied = stageFile(
      join('.claude', 'rules', 'x.md'),
      'RULE-DENIED-291\n',
    )
    stageDenyRules(['Read(.claude/rules/x.md)'])

    const files = await walkRules()
    const paths = files.map(f => f.path)
    expect(paths).toContain(good)
    expect(paths).not.toContain(denied)
    expect(files.map(f => f.content).join('\n')).not.toContain('RULE-DENIED-291')
    expectNotLoaded(denied, REASON_DENIED)
  })

  test('glob deny over the rules dir skips every entry', async () => {
    stageFile(join('.claude', 'rules', 'a.md'), 'RULE-A-291\n')
    stageFile(join('.claude', 'rules', 'b.md'), 'RULE-B-291\n')
    stageDenyRules(['Read(.claude/rules/*.md)'])

    const files = await walkRules()
    expect(files).toEqual([])
  })
})

// ─── integration: AGENTS.md instruction mode ────────────────────────────────

describe('CC 2.1.290 B4 — AGENTS.md mode honours Read deny rules', () => {
  test('denied AGENTS.md is not merged into the instruction set', async () => {
    stageFile('AGENTS.md', '# AGENTS-DENIED-291\n')
    const inner = stageFile(join('.claude', 'CLAUDE.md'), 'INNER-OK-291\n')
    stageDenyRules(['Read(AGENTS.md)'], {
      instructionFiles: 'claude-md-and-agents-md',
    })
    resetGetMemoryFilesCache()

    const files = await getMemoryFiles()
    const projectPaths = files
      .filter(f => f.type === 'Project' || f.type === 'Local')
      .map(f => f.path)
    expect(projectPaths).not.toContain(join(repoDir, 'AGENTS.md'))
    expect(projectPaths).toContain(inner)
    expect(files.map(f => f.content).join('\n')).not.toContain(
      'AGENTS-DENIED-291',
    )
    expectNotLoaded(join(repoDir, 'AGENTS.md'), REASON_DENIED)
  })
})

// ─── integration: nested-directory memory ───────────────────────────────────

describe('CC 2.1.290 B4 — getMemoryFilesForNestedDirectory', () => {
  test('denied nested CLAUDE.md skipped, benign sibling loads', async () => {
    const nested = join(repoDir, 'packages', 'sub')
    mkdirSync(join(nested, '.claude'), { recursive: true })
    writeFileSync(join(nested, 'CLAUDE.md'), '# NESTED-DENIED-291\n', 'utf-8')
    const nestedInner = join(nested, '.claude', 'CLAUDE.md')
    writeFileSync(nestedInner, 'NESTED-INNER-OK-291\n', 'utf-8')
    stageDenyRules([`Read(//${join(nested, 'CLAUDE.md')})`])

    const files = await getMemoryFilesForNestedDirectory(
      nested,
      join(nested, 'index.ts'),
      new Set<string>(),
    )
    const paths = files.map(f => f.path)
    expect(paths).not.toContain(join(nested, 'CLAUDE.md'))
    expect(paths).toContain(nestedInner)
    expect(files.map(f => f.content).join('\n')).not.toContain(
      'NESTED-DENIED-291',
    )
    expectNotLoaded(join(nested, 'CLAUDE.md'), REASON_DENIED)
  })
})

// ─── regression: unsettled (fail-closed) arm keeps working ──────────────────

describe('CC 2.1.290 B4 — unsettled arm wording + fail-closed regression', () => {
  test('chokepoint: unresolvable link refused with the official wording', async () => {
    const link = stageLink('CLAUDE.md', join(repoDir, 'nowhere', 'CLAUDE.md'))
    stageDenyRules(['Read(unrelated.md)'])

    // The read-site chokepoint (AutoMem/TeamMem callers + the last-line gate
    // for every loader) — processMemoryFile refuses this shape earlier at its
    // own 2.1.282 gate, so the unsettled wording is asserted here directly.
    const { info, includePaths } = await safelyReadMemoryFileAsyncForTesting(
      link,
      'Project',
    )
    expect(info).toBeNull()
    expect(includePaths).toEqual([])
    expectNotLoaded(link, REASON_UNSETTLED)
  })

  test('chokepoint: denied path refused before any read', async () => {
    const claudeMd = stageFile('CLAUDE.md', '# DENIED-MARKER-291\n')
    stageDenyRules(['Read(CLAUDE.md)'])

    const { info } = await safelyReadMemoryFileAsyncForTesting(
      claudeMd,
      'Project',
    )
    expect(info).toBeNull()
    expectNotLoaded(claudeMd, REASON_DENIED)
  })

  test('dangling symlink via processMemoryFile is still refused (regression)', async () => {
    const link = stageLink('CLAUDE.md', join(repoDir, 'nowhere.md'))
    const files = await processMemoryFile(
      link,
      'Project',
      new Set<string>(),
      true,
    )
    expect(files).toEqual([])
  })

  test('existing 2.1.282 containment diagnostic is preserved', async () => {
    const link = stageLink('CLAUDE.md', join(repoDir, 'nowhere.md'))
    await processMemoryFile(link, 'Project', new Set<string>(), true)
    expect(
      debugLogs.some(l => l.includes('2.1.282 memory containment: skipped')),
    ).toBe(true)
  })
})
