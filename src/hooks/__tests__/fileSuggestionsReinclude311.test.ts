import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.311 (ITEM 11): `.ignore`/`.rgignore` negation re-includes for the
 * @-file picker.
 *
 * Official v311 (byte-verified in the 2.1.311 linux-x64 binary):
 * - state factory @263867357: `ignoreReincludeGlobs:[],lastReincludedFiles:[],
 *   reincludeRetryAtMs:0`, reset in `fvo` @263867910.
 * - loader @263869500 derives per ignore file with `U(b, relDir)` over the
 *   SAME filtered pattern list fed to `ig.add`, then
 *   `ignoreReincludeGlobs = hasNegation ? [...augmentations, ...rules] : []`.
 * - `U` @263869960 / `M` / `W` / `q` — bare-name negations gain a
 *   `**\/name/**` augmentation, non-negations become `!rule` exclusions.
 * - fetch `ae` @263877300: `w5(["--files","--hidden",...globs.flatMap(u=>
 *   ["--glob",u]),...Q],".",AbortSignal.timeout(1e4),{cwd:...,rejectOnPartial:!0})`
 *   with `Q=[".git",".svn",".hg",".bzr",".jj",".sl"].flatMap(d=>["--glob",`!${d}`])`,
 *   cacheGeneration-guarded writes, failure log
 *   `[FileIndex] .ignore re-include listing failed: ${msg}` + `se=300000`
 *   backoff (@263874800), failure RETURNS `lastReincludedFiles`.
 * - merge: git untracked + sorted normalized re-included files (plain append,
 *   no dedup), log ALWAYS carries `(${n} re-included by .ignore)`.
 *
 * The behavioral fixture uses a REAL git repo + REAL rg (delegated through a
 * mocked `ripGrep` that records the args and spawns the real binary the same
 * way `ripGrep` does: `[...args, target]`).
 */

const execFileAsync = promisify(execFileCb)

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Snapshot the real modules into plain objects BEFORE mocking, restore in
// afterAll, and import the module under test only AFTER the mocks are up.
const actualSettings = { ...(await import('../../utils/settings/settings.js')) }
const actualConfig = { ...(await import('../../utils/config.js')) }
const actualCwd = { ...(await import('../../utils/cwd.js')) }
const actualGit = { ...(await import('../../utils/git.js')) }
const actualDebug = { ...(await import('../../utils/debug.js')) }
const actualRipgrep = { ...(await import('../../utils/ripgrep.js')) }
const actualMarkdownConfigLoader = {
  ...(await import('../../utils/markdownConfigLoader.js')),
}

let repoRoot = ''
let rgMode: 'success' | 'fail' = 'success'
let rgCalls: Array<{ args: string[]; target: string }> = []
let capturedLogs: string[] = []

async function findRgBinary(): Promise<string> {
  const { stdout } = await execFileAsync('which', ['rg'])
  return stdout.trim()
}

const rgBinaryPromise = findRgBinary()

mock.module('../../utils/settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => ({ respectGitignore: true }),
}))

mock.module('../../utils/config.js', () => ({
  ...actualConfig,
  getGlobalConfig: () => ({}),
}))

mock.module('../../utils/cwd.js', () => ({
  ...actualCwd,
  getCwd: () => repoRoot,
}))

mock.module('../../utils/git.js', () => ({
  ...actualGit,
  findGitRoot: () => repoRoot,
}))

mock.module('../../utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string) => {
    capturedLogs.push(message)
  },
}))

mock.module('../../utils/markdownConfigLoader.js', () => ({
  ...actualMarkdownConfigLoader,
  CLAUDE_CONFIG_DIRECTORIES: [],
  loadMarkdownFilesForSubdir: async () => [],
}))

mock.module('../../utils/ripgrep.js', () => ({
  ...actualRipgrep,
  ripGrep: async (args: string[], target: string) => {
    rgCalls.push({ args: [...args], target })
    if (rgMode === 'fail') {
      throw new Error('rg boom')
    }
    // Mirror the real ripGrep spawn shape: `[...args, target]`.
    const rgBinary = await rgBinaryPromise
    const { stdout } = await execFileAsync(rgBinary, [...args, target], {
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout.split('\n').filter(Boolean)
  },
}))

afterAll(() => {
  mock.module('../../utils/settings/settings.js', () => ({ ...actualSettings }))
  mock.module('../../utils/config.js', () => ({ ...actualConfig }))
  mock.module('../../utils/cwd.js', () => ({ ...actualCwd }))
  mock.module('../../utils/git.js', () => ({ ...actualGit }))
  mock.module('../../utils/debug.js', () => ({ ...actualDebug }))
  mock.module('../../utils/markdownConfigLoader.js', () => ({
    ...actualMarkdownConfigLoader,
  }))
  mock.module('../../utils/ripgrep.js', () => ({ ...actualRipgrep }))
})

const fileSuggestions = await import('../fileSuggestions.js')
const {
  clearFileSuggestionCaches,
  generateFileSuggestions,
  getPathsForSuggestions,
} = fileSuggestions

type Derivation = {
  hasNegation: boolean
  augmentations: string[]
  rules: string[]
}

function derive(patterns: string[], relDir: string): Derivation {
  const fn = (
    fileSuggestions as unknown as {
      deriveIgnoreReincludeGlobs?: (p: string[], r: string) => Derivation
    }
  ).deriveIgnoreReincludeGlobs
  if (typeof fn !== 'function') {
    throw new Error('deriveIgnoreReincludeGlobs is not exported')
  }
  return fn(patterns, relDir)
}

function reincludeState(): {
  ignoreReincludeGlobs: string[]
  lastReincludedFiles: string[]
  reincludeRetryAtMs: number
} {
  const fn = (
    fileSuggestions as unknown as {
      _getReincludeStateForTesting?: () => {
        ignoreReincludeGlobs: string[]
        lastReincludedFiles: string[]
        reincludeRetryAtMs: number
      }
    }
  )._getReincludeStateForTesting
  if (typeof fn !== 'function') {
    throw new Error('_getReincludeStateForTesting is not exported')
  }
  return fn()
}

let savedGitEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  await rgBinaryPromise
  // Keep the fixture repo hermetic from the user's git identity/config.
  savedGitEnv = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
  }
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  process.env.GIT_AUTHOR_NAME = 'occ-test'
  process.env.GIT_AUTHOR_EMAIL = 'occ-test@example.com'
  process.env.GIT_COMMITTER_NAME = 'occ-test'
  process.env.GIT_COMMITTER_EMAIL = 'occ-test@example.com'

  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'occ-reinclude311-')))
  const git = async (...args: string[]) => {
    await execFileAsync('git', args, { cwd: repoRoot })
  }
  await git('init', '-b', 'main')
  writeFileSync(join(repoRoot, 'tracked.txt'), 'tracked\n')
  writeFileSync(join(repoRoot, '.gitignore'), 'reinclude-me\nstill-ignored.txt\n')
  await git('add', 'tracked.txt', '.gitignore')
  await git('commit', '-m', 'fixture')
  // Gitignored files (file-level patterns, so rg --glob whitelisting applies).
  writeFileSync(join(repoRoot, 'reinclude-me'), 'want me\n')
  writeFileSync(join(repoRoot, 'still-ignored.txt'), 'not me\n')
  // The v311 trigger: an .ignore negation re-including a gitignored file.
  writeFileSync(join(repoRoot, '.ignore'), '!reinclude-me\n')
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedGitEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  if (repoRoot) {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

async function pollUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

describe('2.1.311 ITEM 11 — deriveIgnoreReincludeGlobs (official U/M/W/q)', () => {
  test('bare-name negation gains the **/name/** augmentation', () => {
    expect(derive(['!reinclude-me'], '')).toEqual({
      hasNegation: true,
      augmentations: ['**/reinclude-me/**'],
      rules: ['reinclude-me'],
    })
  })

  test('path negation gains the dir/** augmentation without the **/ prefix', () => {
    expect(derive(['!build/keep.txt'], '')).toEqual({
      hasNegation: true,
      augmentations: ['build/keep.txt/**'],
      rules: ['build/keep.txt'],
    })
  })

  test('a negation already ending in ** gains no augmentation', () => {
    expect(derive(['!dir/**'], '')).toEqual({
      hasNegation: true,
      augmentations: [],
      rules: ['dir/**'],
    })
  })

  test('non-negated patterns become !rule exclusions alongside negations', () => {
    expect(derive(['build', '!keep'], '')).toEqual({
      hasNegation: true,
      augmentations: ['**/keep/**'],
      rules: ['!build', 'keep'],
    })
  })

  test('patterns anchor under a non-empty relative directory', () => {
    expect(derive(['!x'], 'sub')).toEqual({
      hasNegation: true,
      augmentations: ['sub/**/x/**'],
      rules: ['sub/**/x'],
    })
  })

  test('the relative directory is glob-escaped (official W)', () => {
    expect(derive(['!x'], 'a*b')).toEqual({
      hasNegation: true,
      augmentations: ['a\\*b/**/x/**'],
      rules: ['a\\*b/**/x'],
    })
  })

  test('an absolute pattern concatenates onto the relative directory', () => {
    expect(derive(['!/x'], 'sub')).toEqual({
      hasNegation: true,
      augmentations: ['sub/x/**'],
      rules: ['sub/x'],
    })
  })

  test('comments and empty lines are skipped', () => {
    expect(derive(['# comment', '', '!k'], '')).toEqual({
      hasNegation: true,
      augmentations: ['**/k/**'],
      rules: ['k'],
    })
  })

  test('a trailing backslash-space is preserved (no trimEnd)', () => {
    expect(derive(['!a\\ '], '')).toEqual({
      hasNegation: true,
      augmentations: ['**/a\\ /**'],
      rules: ['a\\ '],
    })
  })

  test('no negation anywhere → hasNegation false', () => {
    expect(derive(['build'], '')).toEqual({
      hasNegation: false,
      augmentations: [],
      rules: ['!build'],
    })
  })

  test('a bare "!" negation with empty body is skipped', () => {
    expect(derive(['!'], '')).toEqual({
      hasNegation: false,
      augmentations: [],
      rules: [],
    })
  })

  test('trailing slashes are stripped for the augmentation but kept in the rule', () => {
    expect(derive(['!build/'], '')).toEqual({
      hasNegation: true,
      augmentations: ['**/build/**'],
      rules: ['build/'],
    })
  })
})

describe('2.1.311 ITEM 11 — .ignore negation re-include behavior', () => {
  test('a gitignored file re-included by .ignore appears in suggestions', async () => {
    rgMode = 'success'
    rgCalls = []
    capturedLogs = []
    clearFileSuggestionCaches()

    await getPathsForSuggestions()
    const found = await pollUntil(async () => {
      const items = await generateFileSuggestions('reinclude-me')
      return items.some(item => item.displayText.includes('reinclude-me'))
    }, 4000)

    expect(found).toBe(true)

    // The re-included file must NOT drag its still-ignored sibling along.
    const sibling = await generateFileSuggestions('still-ignored')
    expect(
      sibling.some(item => item.displayText.includes('still-ignored')),
    ).toBe(false)

    // Official fetch args, verbatim (@263877300 + Q @263872950).
    expect(rgCalls.length).toBeGreaterThan(0)
    expect(rgCalls[0]!.args).toEqual([
      '--files',
      '--hidden',
      '--glob',
      '**/reinclude-me/**',
      '--glob',
      'reinclude-me',
      '--glob',
      '!.git',
      '--glob',
      '!.svn',
      '--glob',
      '!.hg',
      '--glob',
      '!.bzr',
      '--glob',
      '!.jj',
      '--glob',
      '!.sl',
    ])
    // OCC deviation: ripGrep has no cwd option, so repoRoot is the target
    // instead of "." with cwd=repoRoot.
    expect(rgCalls[0]!.target).toBe(repoRoot)

    // v311 log format ALWAYS carries the re-include suffix.
    expect(
      capturedLogs.some(log =>
        /\[FileIndex\] background untracked fetch: \d+ files \(\d+ re-included by \.ignore\)/.test(
          log,
        ),
      ),
    ).toBe(true)

    const state = reincludeState()
    expect(state.ignoreReincludeGlobs).toEqual([
      '**/reinclude-me/**',
      'reinclude-me',
    ])
    expect(state.lastReincludedFiles).toContain('reinclude-me')
    expect(state.reincludeRetryAtMs).toBe(0)
  })

  test('rg failure logs verbatim, sets the 5-minute backoff, and blocks refetch', async () => {
    rgMode = 'fail'
    rgCalls = []
    capturedLogs = []
    clearFileSuggestionCaches()

    await getPathsForSuggestions()
    const sawFailureLog = await pollUntil(
      async () =>
        capturedLogs.some(log =>
          log.startsWith('[FileIndex] .ignore re-include listing failed: '),
        ),
      4000,
    )
    expect(sawFailureLog).toBe(true)
    expect(
      capturedLogs.some(
        log =>
          log.startsWith('[FileIndex] .ignore re-include listing failed: ') &&
          log.includes('rg boom'),
      ),
    ).toBe(true)

    // The merge still ran — git untracked succeeded, re-include contributed 0.
    expect(
      capturedLogs.some(log =>
        /\[FileIndex\] background untracked fetch: \d+ files \(0 re-included by \.ignore\)/.test(
          log,
        ),
      ),
    ).toBe(true)

    // Backoff: retryAt ≈ now + 300000 (official `se` @263874800).
    const state = reincludeState()
    expect(state.reincludeRetryAtMs).toBeGreaterThan(Date.now() + 290_000)
    expect(state.lastReincludedFiles).toEqual([])

    // While the backoff is active, a second refresh must NOT re-invoke rg.
    const callsBefore = rgCalls.length
    await getPathsForSuggestions()
    await pollUntil(
      async () =>
        capturedLogs.filter(log =>
          log.startsWith('[FileIndex] background untracked fetch:'),
        ).length >= 2,
      4000,
    )
    expect(rgCalls.length).toBe(callsBefore)
  })
})
