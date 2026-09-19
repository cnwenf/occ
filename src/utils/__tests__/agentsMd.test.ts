import { afterEach, describe, expect, test } from 'bun:test'
import {
  AGENTS_LOADED_NOTICE_PREFIX,
  AGENTS_NAMES,
  CLAUDE_NAMES,
  DEFAULT_MODE,
  FEATURE_NAME,
  INSTRUCTION_FILES_DESCRIPTION,
  INSTRUCTION_FILES_TITLE,
  LEGACY_MODE_MAP,
  LOAD_EVENT,
  MODES,
  MODE_EVENT,
  NESTED_EVENT,
  PLUGIN_DESCRIPTION,
  PLUGIN_NAME,
  WALK_FAILED_REASON,
  absoluteOf,
  chainRootOf,
  isAgentsMdFeatureAvailable,
  isBelow,
  isClaudeFileOnWalk,
  isKeptWithoutInstructionType,
  isLoadedClaudeFile,
  legacyModeOf,
  loadCountsOf,
  loadMarkOf,
  modeOf,
  nestedFrame,
  normalSpellingOf,
  outsideClaudeDirs,
  projectDirOf,
  resolveInstructionMode,
  unseenFiles,
  withProjectFiles,
  type InstructionFile,
} from '../agentsMd.js'

/**
 * CC 2.1.277 `agents-md` plugin — pure-logic unit tests.
 *
 * Every constant and helper in src/utils/agentsMd.ts is byte-copied from the
 * official 2.1.277 linux-x64 ELF (plugin region ~222427200–222436600). These
 * tests pin the exact strings/modes/precedence so a future edit can't silently
 * drift from the binary.
 */

function f(
  path: string,
  type: InstructionFile['type'],
  content = 'x',
  parent?: string,
): InstructionFile {
  return parent === undefined
    ? { path, type, content }
    : { path, type, content, parent }
}

describe('agentsMd — byte-copied constants (ELF verbatim)', () => {
  test('MODES is the official 4-mode array in order', () => {
    expect(MODES).toEqual([
      'claude-md',
      'claude-md-or-agents-md',
      'claude-md-and-agents-md',
      'managed-only',
    ])
  })

  test('DEFAULT_MODE is claude-md-or-agents-md', () => {
    expect(DEFAULT_MODE).toBe('claude-md-or-agents-md')
  })

  test('AGENTS_NAMES / CLAUDE_NAMES match the binary', () => {
    expect(AGENTS_NAMES).toEqual(['AGENTS.md', '.claude/AGENTS.md'])
    expect(CLAUDE_NAMES).toEqual([
      'CLAUDE.md',
      '.claude/CLAUDE.md',
      'CLAUDE.local.md',
    ])
  })

  test('legacy projectInstructions → mode map matches `be`', () => {
    expect(LEGACY_MODE_MAP).toEqual({
      none: 'managed-only',
      claude: 'claude-md',
      'agents-fallback': 'claude-md-or-agents-md',
      both: 'claude-md-and-agents-md',
    })
  })

  test('event names + feature + walk-failed reason match the binary', () => {
    expect(FEATURE_NAME).toBe('agents_md')
    expect(LOAD_EVENT).toBe('agents_md_load')
    expect(MODE_EVENT).toBe('agents_md_mode')
    expect(NESTED_EVENT).toBe('agents_md_nested')
    expect(WALK_FAILED_REASON).toBe('walk_failed')
    expect(PLUGIN_NAME).toBe('agents-md')
  })

  test('notice prefix matches the binary', () => {
    expect(AGENTS_LOADED_NOTICE_PREFIX).toBe(
      'no CLAUDE.md found; AGENTS.md loaded: ',
    )
  })

  test('setting title is "Project instructions"', () => {
    expect(INSTRUCTION_FILES_TITLE).toBe('Project instructions')
  })

  test('setting description is byte-identical to the ELF USER_CONFIG `re`', () => {
    expect(INSTRUCTION_FILES_DESCRIPTION).toBe(
      `"claude-md": CLAUDE.md only, loaded by the engine as today. "claude-md-or-agents-md" (default): a project with no CLAUDE.md of its own gets its AGENTS.md files instead, loaded exactly where and how CLAUDE.md would be. "claude-md-and-agents-md": AGENTS.md files are loaded beside CLAUDE.md (a file CLAUDE.md already imports or links to is not loaded twice). "managed-only": the project's and your own instruction files are dropped; the organization's managed CLAUDE.md and memory stay.`,
    )
  })

  test('plugin description is byte-identical to the ELF `H`', () => {
    expect(PLUGIN_DESCRIPTION).toBe(
      'AGENTS.md as project instructions: by default loaded where the project has no CLAUDE.md; by its instructionFiles option, loaded beside CLAUDE.md, left out, or with the project instructions dropped',
    )
  })
})

describe('agentsMd — modeOf (he)', () => {
  test('returns each valid mode unchanged', () => {
    for (const m of MODES) expect(modeOf(m)).toBe(m)
  })
  test('coerces undefined / unknown to the default', () => {
    expect(modeOf(undefined)).toBe(DEFAULT_MODE)
    expect(modeOf('garbage')).toBe(DEFAULT_MODE)
    expect(modeOf(42)).toBe(DEFAULT_MODE)
  })
})

describe('agentsMd — legacyModeOf (Fe)', () => {
  test('maps each legacy value', () => {
    expect(legacyModeOf('none')).toBe('managed-only')
    expect(legacyModeOf('claude')).toBe('claude-md')
    expect(legacyModeOf('agents-fallback')).toBe('claude-md-or-agents-md')
    expect(legacyModeOf('both')).toBe('claude-md-and-agents-md')
  })
  test('undefined passes through', () => {
    expect(legacyModeOf(undefined)).toBeUndefined()
  })
  test('unknown string / non-string falls back to claude-md', () => {
    expect(legacyModeOf('nope')).toBe('claude-md')
    expect(legacyModeOf(7)).toBe('claude-md')
  })
})

describe('agentsMd — resolveInstructionMode (qe prelude)', () => {
  test('no settings → default mode, legacy unset', () => {
    const r = resolveInstructionMode({})
    expect(r.mode).toBe('claude-md-or-agents-md')
    expect(r.legacyHonoured).toBe(false)
    expect(r.legacyUnset).toBe(true)
  })
  test('instructionFiles set → wins, legacy unset', () => {
    const r = resolveInstructionMode({ instructionFiles: 'claude-md' })
    expect(r.mode).toBe('claude-md')
    expect(r.legacyUnset).toBe(true)
  })
  test('legacy only (instructionFiles at default) → honoured', () => {
    const r = resolveInstructionMode({ projectInstructions: 'both' })
    expect(r.mode).toBe('claude-md-and-agents-md')
    expect(r.legacyHonoured).toBe(true)
    expect(r.legacyUnset).toBe(false)
  })
  test('both set (instructionFiles non-default) → instructionFiles wins, legacy ignored', () => {
    const r = resolveInstructionMode({
      instructionFiles: 'managed-only',
      projectInstructions: 'both',
    })
    expect(r.mode).toBe('managed-only')
    expect(r.legacyHonoured).toBe(false)
    expect(r.legacyUnset).toBe(false)
  })
  test('invalid instructionFiles → default; legacy then honoured', () => {
    const r = resolveInstructionMode({
      instructionFiles: 'bogus',
      projectInstructions: 'none',
    })
    // modeOf('bogus') → default → legacy honoured → managed-only
    expect(r.mode).toBe('managed-only')
    expect(r.legacyHonoured).toBe(true)
  })
})

describe('agentsMd — path helpers', () => {
  test('normalSpellingOf (p): backslashes → slash, strip trailing slash', () => {
    expect(normalSpellingOf('a\\b\\')).toBe('a/b')
    expect(normalSpellingOf('/p/')).toBe('/p')
    expect(normalSpellingOf('/')).toBe('/')
  })
  test('isBelow (D): strict descendant', () => {
    expect(isBelow('/p/sub', '/p')).toBe(true)
    expect(isBelow('/p', '/p')).toBe(false)
    expect(isBelow('/other', '/p')).toBe(false)
  })
  test('projectDirOf (O): strips /.claude/ or last segment', () => {
    expect(projectDirOf('/p/CLAUDE.md')).toBe('/p')
    expect(projectDirOf('/p/.claude/CLAUDE.md')).toBe('/p')
    expect(projectDirOf('/p/sub/file.md')).toBe('/p/sub')
    expect(projectDirOf('/CLAUDE.md')).toBe('/')
  })
  test('chainRootOf (S): walks parent chain, cycle-safe', () => {
    const byPath = new Map<string, InstructionFile>([
      ['/p/a.md', f('/p/a.md', 'Project', 'a')],
      ['/p/b.md', f('/p/b.md', 'Project', 'b', '/p/a.md')],
    ])
    expect(chainRootOf(byPath.get('/p/b.md')!, byPath)).toBe('/p/a.md')
    // cycle
    const cyc = new Map<string, InstructionFile>([
      ['/x', f('/x', 'Project', 'x', '/y')],
      ['/y', f('/y', 'Project', 'y', '/x')],
    ])
    expect(chainRootOf(cyc.get('/x')!, cyc)).toBe('/y')
  })
  test('absoluteOf (ce): ~ expansion + relative join', () => {
    expect(absoluteOf('~/x', '/cwd', '/home/u')).toBe('/home/u/x')
    expect(absoluteOf('~', '/cwd', '/home/u')).toBe('/home/u')
    expect(absoluteOf('/abs/x', '/cwd', '/home/u')).toBe('/abs/x')
    expect(absoluteOf('rel/x', '/cwd', '/home/u')).toBe('/cwd/rel/x')
  })
})

describe('agentsMd — CLAUDE-file predicates', () => {
  test('isClaudeFileOnWalk (ge): root-level project CLAUDE-named at/above root', () => {
    expect(isClaudeFileOnWalk(f('/p/CLAUDE.md', 'Project'), '/p')).toBe(true)
    expect(isClaudeFileOnWalk(f('/p/.claude/CLAUDE.md', 'Project'), '/p')).toBe(
      true,
    )
    expect(isClaudeFileOnWalk(f('/p/AGENTS.md', 'Project'), '/p')).toBe(false)
    expect(isClaudeFileOnWalk(f('/p/CLAUDE.md', 'User'), '/p')).toBe(false)
    expect(
      isClaudeFileOnWalk(f('/p/CLAUDE.md', 'Project', 'x', '/imp'), '/p'),
    ).toBe(false)
  })
  test('isLoadedClaudeFile: CLAUDE-named project/local, not imports, not rules', () => {
    expect(isLoadedClaudeFile(f('/p/CLAUDE.md', 'Project'))).toBe(true)
    expect(isLoadedClaudeFile(f('/p/CLAUDE.local.md', 'Local'))).toBe(true)
    expect(isLoadedClaudeFile(f('/p/AGENTS.md', 'Project'))).toBe(false)
    expect(isLoadedClaudeFile(f('/p/.claude/rules/x.md', 'Project'))).toBe(false)
    expect(isLoadedClaudeFile(f('/p/CLAUDE.md', 'Project', 'x', '/imp'))).toBe(
      false,
    )
    expect(isLoadedClaudeFile(f('/p/CLAUDE.md', 'User'))).toBe(false)
  })
  test('isKeptWithoutInstructionType (ye): managed-only keeps managed+memory', () => {
    expect(isKeptWithoutInstructionType('Managed')).toBe(true)
    expect(isKeptWithoutInstructionType('AutoMem')).toBe(true)
    expect(isKeptWithoutInstructionType('TeamMem')).toBe(true)
    expect(isKeptWithoutInstructionType('Project')).toBe(false)
    expect(isKeptWithoutInstructionType('Local')).toBe(false)
    expect(isKeptWithoutInstructionType('User')).toBe(false)
  })
})

describe('agentsMd — unseenFiles (J) dedup', () => {
  test('keeps candidates unseen by path and by project/local content', () => {
    const existing = [f('/p/CLAUDE.md', 'Project', 'SHARED')]
    const candidates = [
      f('/p/AGENTS.md', 'Project', 'NEW'),
      f('/p/CLAUDE.md', 'Project', 'other'), // same path → dropped
      f('/p/.claude/AGENTS.md', 'Project', 'SHARED'), // same content → dropped
    ]
    const out = unseenFiles(candidates, existing)
    expect(out.map(o => o.path)).toEqual(['/p/AGENTS.md'])
  })
  test('empty existing → all candidates kept', () => {
    const out = unseenFiles([f('/p/AGENTS.md', 'Project', 'A')], [])
    expect(out).toHaveLength(1)
  })
})

describe('agentsMd — withProjectFiles (Ee) + insertion order', () => {
  test('empty new files → existing unchanged (identity)', () => {
    const existing = [f('/p/CLAUDE.md', 'Project')]
    expect(withProjectFiles(existing, [])).toBe(existing)
  })
  test('AGENTS inserted after project CLAUDE.md, before memory', () => {
    const existing = [
      f('/m/managed.md', 'Managed'),
      f('/u/CLAUDE.md', 'User'),
      f('/p/CLAUDE.md', 'Project'),
      f('/mem/memory.md', 'AutoMem'),
    ]
    const merged = withProjectFiles(existing, [f('/p/AGENTS.md', 'Project')])
    expect(merged.map(m => m.path)).toEqual([
      '/m/managed.md',
      '/u/CLAUDE.md',
      '/p/CLAUDE.md',
      '/p/AGENTS.md',
      '/mem/memory.md',
    ])
  })
  test('with no project file, AGENTS lands before memory', () => {
    const existing = [
      f('/m/managed.md', 'Managed'),
      f('/u/CLAUDE.md', 'User'),
      f('/mem/memory.md', 'AutoMem'),
    ]
    const merged = withProjectFiles(existing, [f('/p/AGENTS.md', 'Project')])
    expect(merged.map(m => m.path)).toEqual([
      '/m/managed.md',
      '/u/CLAUDE.md',
      '/p/AGENTS.md',
      '/mem/memory.md',
    ])
  })
})

describe('agentsMd — nestedFrame (ue) + outsideClaudeDirs (xe)', () => {
  test('nestedFrame is the official `Contents of …` frame', () => {
    expect(nestedFrame({ path: '/p/sub/AGENTS.md', content: 'BODY' })).toBe(
      'Contents of /p/sub/AGENTS.md:\n\nBODY',
    )
  })
  test('outsideClaudeDirs drops AGENTS dirs that also hold a CLAUDE file', () => {
    const agents = [{ dir: '/a' }, { dir: '/b' }]
    const claude = [{ dir: '/a' }]
    expect(outsideClaudeDirs(agents, claude)).toEqual([{ dir: '/b' }])
  })
})

describe('agentsMd — telemetry rows (Ie / we)', () => {
  test('loadCountsOf splits files vs imports + sums content', () => {
    const files = [
      f('/p/AGENTS.md', 'Project', 'abc'),
      f('/p/sub/AGENTS.md', 'Project', 'de', '/p/AGENTS.md'),
    ]
    const c = loadCountsOf(files, true, false)
    expect(c).toEqual({
      fileCount: 1,
      importCount: 1,
      totalContentLength: 5,
      isYielded: true,
      isWalkFailed: false,
    })
  })
  test('loadMarkOf ok / sad', () => {
    expect(loadMarkOf({ isWalkFailed: false })).toEqual({
      feature: 'agents_md',
      kind: 'ok',
    })
    expect(loadMarkOf({ isWalkFailed: true })).toEqual({
      feature: 'agents_md',
      kind: 'sad',
      reason: 'walk_failed',
    })
  })
})

describe('agentsMd — provider gate isAgentsMdFeatureAvailable', () => {
  const KEYS = [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]
  afterEach(() => {
    for (const k of KEYS) delete process.env[k]
  })
  test('available by default (first-party)', () => {
    expect(isAgentsMdFeatureAvailable()).toBe(true)
  })
  test('hidden on Bedrock', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(isAgentsMdFeatureAvailable()).toBe(false)
  })
  test('hidden on Vertex', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    expect(isAgentsMdFeatureAvailable()).toBe(false)
  })
  test('hidden on Foundry', () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
    expect(isAgentsMdFeatureAvailable()).toBe(false)
  })
})
