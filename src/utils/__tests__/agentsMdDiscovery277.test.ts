import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.277 `agents-md` — discovery integration tests.
 *
 * Exercises the REAL getMemoryFiles() path (src/utils/claudemd.ts +
 * applyAgentsMdInstructionMode) against real filesystem fixtures. Only
 * getInitialSettings() is mocked (to control instructionFiles /
 * projectInstructions per case) — following the repo's established
 * mock.module template (snapshot actuals BEFORE mocking, restore in
 * afterAll, dynamic-import the module under test AFTER registration).
 */

// Snapshot the actual settings module BEFORE mocking (mock.module leaks
// across files in the same worker — restore in afterAll).
const actualSettings = { ...(await import('../settings/settings.js')) }
const baseSettings = actualSettings.getInitialSettings()

let mockInstructionFiles: unknown
let mockProjectInstructions: unknown

mock.module('../settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => ({
    ...baseSettings,
    instructionFiles: mockInstructionFiles,
    projectInstructions: mockProjectInstructions,
  }),
}))

const {
  getMemoryFiles,
  resetGetMemoryFilesCache,
  getLastAgentsMdNotice,
  getLastAgentsMdDeprecation,
} = await import('../claudemd.js')
const {
  getAllowedSettingSources,
  setAllowedSettingSources,
  setOriginalCwd,
} = await import('../../bootstrap/state.js')

import type { SettingSource } from '../settings/constants.js'
import type { MemoryFileInfo } from '../claudemd.js'

// projectSettings + localSettings drive the fixture; userSettings excluded so
// ~/.claude memory can't pollute assertions; policySettings/flagSettings kept.
const FIXTURE_SOURCES: SettingSource[] = [
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

let savedSources: SettingSource[]
let savedCwd: string
let savedAutoMemEnv: string | undefined
let tmpDir: string

beforeAll(() => {
  savedSources = getAllowedSettingSources()
  savedCwd = process.cwd()
  savedAutoMemEnv = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  // Deterministic: keep AutoMem out of the loaded set.
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  setAllowedSettingSources(FIXTURE_SOURCES)
})

afterAll(async () => {
  mock.module('../settings/settings.js', () => ({ ...actualSettings }))
  setAllowedSettingSources(savedSources)
  setOriginalCwd(savedCwd)
  if (savedAutoMemEnv === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  } else {
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = savedAutoMemEnv
  }
  delete process.env.CLAUDE_CODE_USE_BEDROCK
})

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-agentsmd-'))
  mockInstructionFiles = undefined
  mockProjectInstructions = undefined
  setOriginalCwd(tmpDir)
  resetGetMemoryFilesCache()
})

afterEach(async () => {
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  await rm(tmpDir, { recursive: true, force: true })
})

function projectOwnPaths(files: MemoryFileInfo[]): string[] {
  return files
    .filter(f => f.type === 'Project' || f.type === 'Local')
    .map(f => f.path)
}

describe('CC 2.1.277 agents-md — discovery via getMemoryFiles()', () => {
  test('default or-mode: only AGENTS.md → loaded as Project + one-shot notice', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Agents instructions\n')
    const files = await getMemoryFiles()
    const agents = join(tmpDir, 'AGENTS.md')
    expect(projectOwnPaths(files)).toContain(agents)
    const loaded = files.find(f => f.path === agents)
    expect(loaded?.type).toBe('Project')
    expect(loaded?.content).toContain('Agents instructions')
    expect(getLastAgentsMdNotice()).toBe(
      `no CLAUDE.md found; AGENTS.md loaded: ${agents}`,
    )
  })

  test('default or-mode: both present → CLAUDE.md wins, AGENTS.md NOT loaded', async () => {
    await writeFile(join(tmpDir, 'CLAUDE.md'), '# Claude instructions\n')
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Agents instructions\n')
    const files = await getMemoryFiles()
    const paths = projectOwnPaths(files)
    expect(paths).toContain(join(tmpDir, 'CLAUDE.md'))
    expect(paths).not.toContain(join(tmpDir, 'AGENTS.md'))
  })

  test('default or-mode: neither present → no project instruction files', async () => {
    const files = await getMemoryFiles()
    const fromFixture = projectOwnPaths(files).filter(p =>
      p.startsWith(tmpDir),
    )
    expect(fromFixture).toEqual([])
  })

  test('claude-md mode: AGENTS.md-only fixture → NOT loaded', async () => {
    mockInstructionFiles = 'claude-md'
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Agents instructions\n')
    const files = await getMemoryFiles()
    expect(projectOwnPaths(files)).not.toContain(join(tmpDir, 'AGENTS.md'))
  })

  test('claude-md-and-agents-md mode: both loaded beside each other', async () => {
    mockInstructionFiles = 'claude-md-and-agents-md'
    await writeFile(join(tmpDir, 'CLAUDE.md'), '# Claude instructions\n')
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Agents instructions\n')
    await mkdir(join(tmpDir, '.claude'), { recursive: true })
    await writeFile(join(tmpDir, '.claude', 'AGENTS.md'), '# Dot agents\n')
    const files = await getMemoryFiles()
    const paths = files.map(f => f.path)
    const claudeIdx = paths.indexOf(join(tmpDir, 'CLAUDE.md'))
    const agentsIdx = paths.indexOf(join(tmpDir, 'AGENTS.md'))
    const dotAgentsIdx = paths.indexOf(join(tmpDir, '.claude', 'AGENTS.md'))
    expect(claudeIdx).toBeGreaterThanOrEqual(0)
    expect(agentsIdx).toBeGreaterThan(claudeIdx)
    expect(dotAgentsIdx).toBeGreaterThan(agentsIdx)
    expect(files[agentsIdx]?.type).toBe('Project')
  })

  test('managed-only mode: project/local/user instruction files dropped', async () => {
    mockInstructionFiles = 'managed-only'
    await writeFile(join(tmpDir, 'CLAUDE.md'), '# Claude instructions\n')
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Agents instructions\n')
    const files = await getMemoryFiles()
    expect(
      files.filter(f => ['Project', 'Local', 'User'].includes(f.type)),
    ).toEqual([])
  })

  test('legacy projectInstructions "both" honoured → both loaded + deprecation notice', async () => {
    mockProjectInstructions = 'both'
    await writeFile(join(tmpDir, 'CLAUDE.md'), '# Claude instructions\n')
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Agents instructions\n')
    const files = await getMemoryFiles()
    const paths = projectOwnPaths(files)
    expect(paths).toContain(join(tmpDir, 'CLAUDE.md'))
    expect(paths).toContain(join(tmpDir, 'AGENTS.md'))
    expect(getLastAgentsMdDeprecation()).toBe(
      'option projectInstructions in settings is honoured for now, read as instructionFiles claude-md-and-agents-md; set instructionFiles to claude-md-and-agents-md and remove projectInstructions',
    )
  })

  test('legacy ignored when instructionFiles set → deprecation notice', async () => {
    mockInstructionFiles = 'claude-md'
    mockProjectInstructions = 'both'
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Agents instructions\n')
    const files = await getMemoryFiles()
    expect(projectOwnPaths(files)).not.toContain(join(tmpDir, 'AGENTS.md'))
    expect(getLastAgentsMdDeprecation()).toBe(
      'option projectInstructions in settings is not read: instructionFiles claude-md is set; remove projectInstructions',
    )
  })

  test('ancestor walk: parent-dir AGENTS.md discovered from nested cwd', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Parent agents\n')
    const sub = join(tmpDir, 'sub')
    await mkdir(sub, { recursive: true })
    setOriginalCwd(sub)
    const files = await getMemoryFiles()
    const loaded = files.find(f => f.path === join(tmpDir, 'AGENTS.md'))
    expect(loaded?.type).toBe('Project')
    expect(loaded?.content).toContain('Parent agents')
  })

  test('provider gate: on Bedrock the AGENTS.md pass is skipped', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Agents instructions\n')
    const files = await getMemoryFiles()
    expect(projectOwnPaths(files)).not.toContain(join(tmpDir, 'AGENTS.md'))
  })
})

/**
 * OCC-132 P3-6 (docs/upstream-version-gap-occ132.md §7): resetGetMemoryFilesCache()
 * clears the agents-md test-seam values (claudemd.ts:1339-1340), but no test
 * asserted it — the two clearing lines were mutation-deletable. These seed a
 * real notice / deprecation through getMemoryFiles(), reset, and assert both
 * seams read back undefined. Deleting either clearing line fails the matching
 * test below.
 */
describe('OCC-132 P3-6: resetGetMemoryFilesCache clears the agents-md seams', () => {
  test('reset clears the last AGENTS.md notice seam', async () => {
    // Seed: AGENTS.md-only fixture → getMemoryFiles() sets lastAgentsMdNotice.
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Agents instructions\n')
    await getMemoryFiles()
    expect(getLastAgentsMdNotice()).toBe(
      `no CLAUDE.md found; AGENTS.md loaded: ${join(tmpDir, 'AGENTS.md')}`,
    )

    resetGetMemoryFilesCache()

    expect(getLastAgentsMdNotice()).toBeUndefined()
  })

  test('reset clears the projectInstructions deprecation seam', async () => {
    // Seed: legacy projectInstructions 'both' → getMemoryFiles() sets
    // lastAgentsMdDeprecation.
    mockProjectInstructions = 'both'
    await writeFile(join(tmpDir, 'CLAUDE.md'), '# Claude instructions\n')
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Agents instructions\n')
    await getMemoryFiles()
    expect(getLastAgentsMdDeprecation()).toBeDefined()

    resetGetMemoryFilesCache()

    expect(getLastAgentsMdDeprecation()).toBeUndefined()
  })
})
