import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { sep } from 'path'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { SuggestionItem } from '../../components/PromptInput/PromptInputFooterSuggestions.js'

/**
 * CC 2.1.276 (ITEM T): "Fixed @-mention file suggestions being buried below
 * MCP resources."
 *
 * Official v274 call sites (byte-extracted @207449268 / @207449350):
 *   `return(await nGn(g,f)).slice(0,S).map(I)`   // custom fileSuggestion cmd
 *   `return dxt(e,n),g.slice(0,S).map(I)`        // bare `@` / `@.` / `@./`
 * where `I(e,r)` writes `r` into `metadata.score` — `.map(I)` therefore used
 * the ARRAY INDEX (0..14) as the score.
 *
 * Official v276 replaces both with the normalizer (@208749909):
 *   `function k(e){let r=e.slice(0,_);return r.map((o,n)=>S(o,n/Math.max(r.length,1)))}`
 *
 * unifiedSuggestions.ts merges sources and sorts ASCENDING (lower = better)
 * with MCP/agent resources scored by Fuse.js around ~0.5, so v274's index
 * scores 1..14 sank every file suggestion except the first below them.
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only what these tests drive, restore.
// The real exports are snapshotted into plain objects BEFORE mocking — the
// imported namespace re-resolves to the mock, so referencing it inside a
// factory (or in the restore) would recurse / restore the mock.
const actualSettings = { ...(await import('../../utils/settings/settings.js')) }
const actualHooks = { ...(await import('../../utils/hooks.js')) }
const actualFsOperations = { ...(await import('../../utils/fsOperations.js')) }
const actualGit = { ...(await import('../../utils/git.js')) }
const actualRipgrep = { ...(await import('../../utils/ripgrep.js')) }

let mockedSettings: Record<string, unknown> = {}
let mockedCommandResults: string[] = []
let mockedDirEntries: Array<{ name: string; isDirectory: boolean }> = []

mock.module('../../utils/settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => mockedSettings,
}))

mock.module('../../utils/hooks.js', () => ({
  ...actualHooks,
  executeFileSuggestionCommand: async () => mockedCommandResults,
}))

// Bare-`@` listing reads the cwd through the fs abstraction.
const realFsImplementation = actualFsOperations.getFsImplementation()

mock.module('../../utils/fsOperations.js', () => ({
  ...actualFsOperations,
  getFsImplementation: () => ({
    ...realFsImplementation,
    readdir: async () =>
      mockedDirEntries.map(
        entry =>
          ({
            name: entry.name,
            isDirectory: () => entry.isDirectory,
          }) as never,
      ),
  }),
}))

// Keep the background index refresh side-effect free: no git repo, no
// ripgrep subprocess. It is not part of the path under test.
mock.module('../../utils/git.js', () => ({
  ...actualGit,
  findGitRoot: () => null,
}))

mock.module('../../utils/ripgrep.js', () => ({
  ...actualRipgrep,
  ripGrep: async () => [],
}))

afterAll(() => {
  mock.module('../../utils/settings/settings.js', () => ({ ...actualSettings }))
  mock.module('../../utils/hooks.js', () => ({ ...actualHooks }))
  mock.module('../../utils/fsOperations.js', () => ({ ...actualFsOperations }))
  mock.module('../../utils/git.js', () => ({ ...actualGit }))
  mock.module('../../utils/ripgrep.js', () => ({ ...actualRipgrep }))
})

const { generateFileSuggestions } = await import('../fileSuggestions.js')

afterEach(() => {
  mockedSettings = {}
  mockedCommandResults = []
  mockedDirEntries = []
})

function scoreOf(item: SuggestionItem): number {
  const metadata = item.metadata as { score?: number } | undefined
  return metadata?.score ?? Number.NaN
}

function useCustomCommand(): void {
  mockedSettings = { fileSuggestion: { type: 'command', command: 'picker' } }
}

/** Ascending merge used by unifiedSuggestions.ts (lower score = better). */
function mergeAscending(
  fileItems: SuggestionItem[],
  mcpScore: number,
): Array<{ kind: string; score: number }> {
  const scored = [
    ...fileItems.map(item => ({ kind: 'file' as const, score: scoreOf(item) })),
    { kind: 'mcp_resource' as const, score: mcpScore },
  ]
  return scored.sort((a, b) => a.score - b.score)
}

const MCP_RESOURCE_SCORE = 0.5

describe('2.1.276 ITEM T — custom fileSuggestion command scores', () => {
  test('normalizes scores into [0,1) instead of using the array index', async () => {
    // Arrange
    useCustomCommand()
    mockedCommandResults = ['a.ts', 'b.ts', 'c.ts', 'd.ts']

    // Act
    const items = await generateFileSuggestions('q')

    // Assert — v274 produced 0,1,2,3 (index as score).
    expect(items.map(item => item.displayText)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts',
    ])
    expect(items.map(scoreOf)).toEqual([0, 0.25, 0.5, 0.75])
  })

  test('first item scores best (0) and scores descend with rank', async () => {
    // Arrange
    useCustomCommand()
    mockedCommandResults = ['one', 'two', 'three']

    // Act
    const scores = (await generateFileSuggestions('q')).map(scoreOf)

    // Assert
    expect(scores[0]).toBe(0)
    expect(scores).toEqual([...scores].sort((a, b) => a - b))
    expect(scores.every(score => score >= 0 && score < 1)).toBe(true)
  })

  test('caps at MAX_SUGGESTIONS (15) and normalizes by the truncated length', async () => {
    // Arrange
    useCustomCommand()
    mockedCommandResults = Array.from({ length: 20 }, (_, i) => `file${i}.ts`)

    // Act
    const items = await generateFileSuggestions('q')

    // Assert — official slices FIRST, then divides by the capped length.
    expect(items).toHaveLength(15)
    expect(scoreOf(items[0]!)).toBe(0)
    expect(scoreOf(items[14]!)).toBeCloseTo(14 / 15, 10)
    expect(items.every(item => scoreOf(item) < 1)).toBe(true)
  })

  test('empty command result list yields an empty list (no NaN score)', async () => {
    // Arrange
    useCustomCommand()
    mockedCommandResults = []

    // Act
    const items = await generateFileSuggestions('q')

    // Assert — Math.max(len, 1) guards the divide-by-zero.
    expect(items).toEqual([])
  })

  test('file suggestions interleave with an MCP resource at 0.5', async () => {
    // Arrange
    useCustomCommand()
    mockedCommandResults = Array.from({ length: 10 }, (_, i) => `f${i}.ts`)

    // Act
    const items = await generateFileSuggestions('q')
    const merged = mergeAscending(items, MCP_RESOURCE_SCORE)

    // Assert — some file suggestions rank above the MCP resource and some
    // below. Under v274 index scores (1..9) EVERY file suggestion except the
    // first ranked below it.
    const mcpIndex = merged.findIndex(entry => entry.kind === 'mcp_resource')
    expect(mcpIndex).toBeGreaterThan(0)
    expect(mcpIndex).toBeLessThan(merged.length - 1)
  })
})

describe('2.1.276 ITEM T — bare @ / @. / @./ listing scores', () => {
  test.each(['', '.', './'])(
    'normalizes top-level listing scores for partial path %p',
    async partialPath => {
      // Arrange
      mockedDirEntries = [
        { name: 'src', isDirectory: true },
        { name: 'test', isDirectory: true },
        { name: 'README.md', isDirectory: false },
        { name: 'package.json', isDirectory: false },
      ]

      // Act
      const items = await generateFileSuggestions(partialPath, true)

      // Assert — v274 produced 0,1,2,3 here too.
      expect(items).toHaveLength(4)
      expect(items.map(scoreOf)).toEqual([0, 0.25, 0.5, 0.75])
      expect(items.map(item => item.displayText)).toEqual([
        `src${sep}`,
        `test${sep}`,
        'README.md',
        'package.json',
      ])
    },
  )

  test('caps a long top-level listing at 15 normalized items', async () => {
    // Arrange
    mockedDirEntries = Array.from({ length: 40 }, (_, i) => ({
      name: `dir${String(i).padStart(2, '0')}`,
      isDirectory: false,
    }))

    // Act
    const items = await generateFileSuggestions('', true)

    // Assert
    expect(items).toHaveLength(15)
    expect(scoreOf(items[14]!)).toBeCloseTo(14 / 15, 10)
  })

  test('empty directory yields an empty list', async () => {
    // Arrange
    mockedDirEntries = []

    // Act
    const items = await generateFileSuggestions('', true)

    // Assert
    expect(items).toEqual([])
  })
})
