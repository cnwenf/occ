import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import {
  clearResolveGitDirCache,
  resetGitFileWatcher,
} from '../../../utils/git/gitFilesystem.js'

/**
 * CC 2.1.218 #8/#26 + 2.1.216 #32/#33 — `/ultrareview` characterization.
 *
 * Drives the REAL `launchRemoteReview` against a temp git repo (real git for
 * merge-base / diff / numstat). Only the cloud surfaces (teleport, RemoteAgentTask,
 * analytics, growthbook, detectRepository) are mocked — git + execFileNoThrow
 * run for real so the error paths exercise actual measurement.
 *
 * #8:  descriptive arg rides into teleport as BUGHUNTER_REVIEW_NOTE.
 * #26: recoverable errors return ContentBlockParam[] (model-visible, so
 *      Claude can correct the arg instead of retrying it unchanged).
 * #32: diff-too-large message shows configured limit + measured diff +
 *      largest contributing files.
 * #33: empty-diff message names the exact base ref.
 */

let tmpRepo = ''
let savedCwd = ''

// --- Cloud mocks (registered before importing the unit under test) -----------

let teleportCalls: Array<{ environmentVariables: Record<string, string> }>

mock.module('../../../tasks/RemoteAgentTask/RemoteAgentTask.js', () => ({
  checkRemoteAgentEligibility: async () => ({ eligible: true, errors: [] }),
  formatPreconditionError: (e: { type: string }) => e.type,
  registerRemoteAgentTask: () => {},
  getRemoteTaskSessionUrl: (id: string) => `https://example.invalid/s/${id}`,
}))

mock.module('../../../utils/teleport.js', () => ({
  teleportToRemote: async (opts: { environmentVariables: Record<string, string> }) => {
    teleportCalls.push({ environmentVariables: opts.environmentVariables ?? {} })
    // null session → triggers the diff-too-large path (#32)
    return null
  },
}))

mock.module('../../../utils/detectRepository.js', () => ({
  detectCurrentRepositoryWithHost: async () => null,
  detectCurrentRepository: async () => null,
  getCachedRepository: () => null,
  clearRepositoryCaches: () => undefined,
  parseGitRemote: () => null,
  parseGitHubRepository: () => null,
}))

mock.module('../../../services/analytics/index.js', () => ({
  logEvent: () => {},
}))

// GrowthBook mock: provide every named export transitive consumers
// (auth/usage/Tool) statically import, so module linking succeeds without
// a live GrowthBook. Feature-value getters return the supplied default.
mock.module('../../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: <T>(_feature: string, defaultValue: T): T => defaultValue,
  getFeatureValue_CACHED_WITH_REFRESH: <T>(_feature: string, defaultValue: T): T => defaultValue,
  getFeatureValue_DEPRECATED: <T>(_feature: string, defaultValue: T): T => defaultValue,
  getDynamicConfig_CACHED_MAY_BE_STALE: () => null,
  getDynamicConfig_BLOCKS_ON_INIT: async () => null,
  checkGate_CACHED_OR_BLOCKING: async () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  hasGrowthBookEnvOverride: () => false,
  initializeGrowthBook: async () => undefined,
  refreshGrowthBookAfterAuthChange: async () => undefined,
  resetGrowthBook: () => undefined,
  onGrowthBookRefresh: () => () => {},
}))

const { launchRemoteReview } = await import('../reviewRemote.js')

function git(args: string[]): void {
  execSync(`git ${args.join(' ')}`, { cwd: tmpRepo, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** `gitWatcher.reset()` clears the cached default-branch after chdir. */
async function resetGitCaches(): Promise<void> {
  clearResolveGitDirCache()
  resetGitFileWatcher()
}

function makeContext(): unknown {
  return { abortController: { signal: undefined } }
}

beforeEach(async () => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'occ-ultra-'))
  savedCwd = process.cwd()
  teleportCalls = []
  // Bare init with a single commit on main, plus an origin remote whose
  // refs/remotes/origin/HEAD points at main (so getDefaultBranch → 'main').
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 't@t'])
  git(['config', 'user.name', 't'])
  git(['config', 'commit.gpgsign', 'false'])
  // Empty initial commit so HEAD exists.
  git(['commit', '--allow-empty', '-m', 'base'])
  // Point origin at itself so default-branch detection resolves 'main'.
  git(['remote', 'add', 'origin', tmpRepo])
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  process.chdir(tmpRepo)
  await resetGitCaches()
})

afterEach(() => {
  process.chdir(savedCwd)
  if (tmpRepo) rmSync(tmpRepo, { recursive: true, force: true })
})

describe('2.1.216 #33 + 2.1.218 #26 — empty-diff names base ref + error is correctable', () => {
  test('no changes → ContentBlockParam[] whose text names the base ref', async () => {
    // On main with no changes vs HEAD: merge-base == HEAD, diff shortstat empty.
    const result = await launchRemoteReview(
      'review my auth changes',
      makeContext() as never,
      '',
    )
    expect(Array.isArray(result)).toBe(true)
    const block = (result as ContentBlockParam[])[0]
    expect(block.type).toBe('text')
    const text = (block as { text: string }).text
    // #33: exact base ref is named.
    expect(text).toContain('main')
    expect(text).toMatch(/No changes against/i)
    // #26: returned to the model (correctable), not thrown.
  })
})

describe('2.1.216 #32 — diff-too-large shows limit + measured diff + largest files', () => {
  test('changes present + teleport null → detailed diff-too-large message', async () => {
    // Make a branch with real changes so diff shortstat/numstat are non-empty.
    git(['checkout', '-b', 'feature'])
    // Write a tracked file with changes.
    const f1 = join(tmpRepo, 'src', 'big.ts')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(tmpRepo, 'src'), { recursive: true })
    writeFileSync(f1, 'export const x = 1\n'.repeat(10))
    git(['add', '.'])
    git(['commit', '-m', 'feat'])
    await resetGitCaches()

    const result = await launchRemoteReview(
      'review my auth changes',
      makeContext() as never,
      '',
    )
    const block = (result as ContentBlockParam[])[0] as { text: string }
    expect(block.text).toContain('diff is too large')
    expect(block.text).toContain('Configured limit:')
    expect(block.text).toContain('Measured diff:')
    expect(block.text).toContain('Largest contributing files:')
    expect(block.text).toContain('src/big.ts')
  })
})

describe('2.1.218 #8 — descriptive arg → BUGHUNTER_REVIEW_NOTE', () => {
  test('descriptive arg is passed as a review-note env var', async () => {
    git(['checkout', '-b', 'feature'])
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(tmpRepo, 'src'), { recursive: true })
    writeFileSync(join(tmpRepo, 'src', 'a.ts'), 'export const a = 1\n')
    git(['add', '.'])
    git(['commit', '-m', 'feat'])
    await resetGitCaches()

    await launchRemoteReview(
      'review my auth changes',
      makeContext() as never,
      '',
    )
    expect(teleportCalls.length).toBe(1)
    const env = teleportCalls[0].environmentVariables
    expect(env.BUGHUNTER_REVIEW_NOTE).toBe('review my auth changes')
    // Base branch SHA is still passed alongside the note.
    expect(env.BUGHUNTER_BASE_BRANCH).toBeTruthy()
  })

  test('pure PR number does NOT enter branch mode (PR mode → non-github → null)', async () => {
    // detectCurrentRepositoryWithHost is mocked to null → PR mode returns null.
    const result = await launchRemoteReview('42', makeContext() as never, '')
    expect(result).toBeNull()
    expect(teleportCalls.length).toBe(0)
  })
})
