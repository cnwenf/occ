import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsOperations } from '../../fsOperations.js'
import { cacheMarketplaceFromGit } from '../marketplaceManager'

/**
 * claude-code 2.1.276 ITEM 2 (data-loss fix, official CM@200211580):
 * cacheMarketplaceFromGit used to `rm` the live marketplace copy before
 * re-cloning, so any failed fetch destroyed the cache. The ported official
 * order clones into a uniquely-named staging sibling and swaps atomically
 * (live → .bak, staging → live, delete .bak only after success). These tests
 * pin the four guarantees from the port spec:
 *   1. failed fetch leaves the live copy intact
 *   2. successful update swaps atomically with no leftovers
 *   3. only owned (`<basename>..clone*`) temp dirs are cleaned
 *   4. a rename failure during the swap restores the backup
 *
 * Real git remotes (file://) are used, matching the adjacent
 * cacheMarketplaceFromGit.test.ts pattern; fs.rename is spied at the module
 * boundary for the failure simulation and restored afterwards.
 */

function git(cwd: string, ...args: string[]): string {
  return execSync(`git ${args.join(' ')}`, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).toString()
}

function makeBareRemote(repoDir: string): string {
  git(repoDir, 'init', '--initial-branch=main')
  writeFileSync(join(repoDir, 'README.md'), 'v1\n')
  mkdirSync(join(repoDir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(repoDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'swap-mp', owner: { name: 't' }, plugins: [] }),
  )
  git(repoDir, 'add', 'README.md', '.claude-plugin/marketplace.json')
  git(repoDir, 'commit', '-m', 'v1')
  const barePath = `${repoDir}.git`
  execSync(`git clone --bare "${repoDir}" "${barePath}"`, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return barePath
}

function corruptOriginUrl(cachePath: string, badUrl: string): void {
  execSync(`git remote set-url origin "${badUrl}"`, { cwd: cachePath })
}

/** Sibling names of cachePath that look like swap temps. */
function swapTemps(workdir: string): string[] {
  return readdirSync(workdir).filter(
    name => name.startsWith('cache..clone') || name === 'cache.bak',
  )
}

describe('cacheMarketplaceFromGit: swap-based re-clone safety (2.1.276 ITEM 2)', () => {
  let workdir: string
  let remote: string
  let cachePath: string

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'mmswap-'))
    const srcRepo = join(workdir, 'src')
    mkdirSync(srcRepo, { recursive: true })
    remote = makeBareRemote(srcRepo)
    cachePath = join(workdir, 'cache')
    delete process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
    rmSync(`${workdir}.git`, { recursive: true, force: true })
    delete process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE
  })

  test('failed re-clone leaves the live copy intact and cleans up staging', async () => {
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    const sentinel = join(cachePath, 'SENTINEL_INTACT')
    writeFileSync(sentinel, 'live')
    corruptOriginUrl(cachePath, 'file:///nonexistent/remote-xyz')

    // Pull fails AND the re-clone URL is bad → the old rm-first code destroyed
    // the cache here; the swap order must keep it untouched.
    await expect(
      cacheMarketplaceFromGit('file:///nonexistent/remote-xyz', cachePath),
    ).rejects.toThrow('Failed to clone marketplace repository:')

    expect(existsSync(sentinel)).toBe(true)
    expect(existsSync(join(cachePath, 'README.md'))).toBe(true)
    expect(swapTemps(workdir)).toEqual([])
  })

  test('successful update swaps atomically with no backup/staging leftovers', async () => {
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    const sentinel = join(cachePath, 'SENTINEL_SWAP')
    writeFileSync(sentinel, 'stale')
    corruptOriginUrl(cachePath, 'file:///nonexistent/remote-xyz')

    // Pull fails (corrupt origin) but the gitUrl arg is valid → swap re-clone.
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath)

    expect(existsSync(join(cachePath, 'README.md'))).toBe(true)
    expect(existsSync(join(cachePath, '.claude-plugin', 'marketplace.json'))).toBe(true)
    // The swapped-in clone is fresh — the sentinel lived only in the old copy.
    expect(existsSync(sentinel)).toBe(false)
    // Backup deleted only after the replacement was verified in place.
    expect(swapTemps(workdir)).toEqual([])
  })

  test('only owned staging temps are cleaned; unrelated siblings untouched', async () => {
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    // Leftover from a crashed previous run (matches the owned prefix)…
    const leftover = join(workdir, 'cache..clone-deadbeef0000')
    mkdirSync(leftover, { recursive: true })
    writeFileSync(join(leftover, 'junk'), 'x')
    // …and an unrelated sibling that must NOT be touched.
    const unrelated = join(workdir, 'unrelated-dir')
    mkdirSync(unrelated, { recursive: true })
    writeFileSync(join(unrelated, 'keep'), 'y')
    corruptOriginUrl(cachePath, 'file:///nonexistent/remote-xyz')

    await cacheMarketplaceFromGit(`file://${remote}`, cachePath)

    expect(existsSync(leftover)).toBe(false)
    expect(existsSync(join(unrelated, 'keep'))).toBe(true)
    expect(swapTemps(workdir)).toEqual([])
  })

  test('rename failure during the swap restores the backup (live copy kept)', async () => {
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    const sentinel = join(cachePath, 'SENTINEL_RESTORE')
    writeFileSync(sentinel, 'precious')
    corruptOriginUrl(cachePath, 'file:///nonexistent/remote-xyz')

    const realRename = NodeFsOperations.rename
    const eperm = Object.assign(new Error('EPERM: operation not permitted'), {
      code: 'EPERM',
      errno: -1,
    })
    // Fail ONLY the staging → live move; the live → backup and backup → live
    // (restore) renames must go through.
    const renameSpy = spyOn(NodeFsOperations, 'rename').mockImplementation(
      async (oldPath: string, newPath: string) => {
        if (oldPath.includes('..clone-') && newPath === cachePath) {
          throw eperm
        }
        return realRename(oldPath, newPath)
      },
    )

    try {
      await expect(
        cacheMarketplaceFromGit(`file://${remote}`, cachePath),
      ).rejects.toThrow(
        `Failed to move the new marketplace clone into place at ${cachePath}`,
      )
    } finally {
      renameSpy.mockRestore()
    }

    // Backup was restored over the live path — data-loss is impossible.
    expect(existsSync(sentinel)).toBe(true)
    expect(existsSync(join(cachePath, 'README.md'))).toBe(true)
    expect(swapTemps(workdir)).toEqual([])
  })
})
