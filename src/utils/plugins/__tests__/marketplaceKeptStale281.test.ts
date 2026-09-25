import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test'
import { execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPluginsDirectory } from '../pluginDirectories.js'

// Isolated module instance (deliberately a distinct specifier).
//
// `pluginUrlRedaction275.test.ts` installs a process-global
// `mock.module('../marketplaceManager.js', …)` that stubs
// `loadKnownMarketplacesConfig` with its own fixture. Bun keeps that
// registration alive across test files in the same process, so a plain import
// here would read the other file's `git-market` fixture instead of the
// known_marketplaces.json this file sandboxes — the read-through tests below
// would then fail with "Marketplace 'kept-stale-mp' not found in
// configuration". A cache-busting query specifier gives this file its own
// unmocked instance of the module.
//
// The specifier is held in a variable so tsc does not try to resolve the query
// string (TS2307); the type is recovered from the literal specifier instead, so
// the destructured bindings stay fully typed.
type MarketplaceManagerModule = typeof import('../marketplaceManager.js')
const ISOLATED_MM_SPECIFIER = '../marketplaceManager.js?occ-kept-stale-281'
const {
  cacheMarketplaceFromGit,
  clearMarketplacesCache,
  getMarketplace,
  getMarketplacesCacheDir,
} = (await import(ISOLATED_MM_SPECIFIER)) as MarketplaceManagerModule

/**
 * CC 2.1.281 (#060): `known_marketplaces.json` must NOT be stamped `lastUpdated`
 * when a refresh could not reach the remote and
 * CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE kept the existing (stale) clone.
 *
 * The fix is a discriminated marker returned by the git-refresh helper: the
 * official returns `{kind:"kept-stale"}` from the KEEP branch (binary `sb`
 * @203674638) and callers gate the timestamp write on it —
 * `keptStaleClone:Ee?.kind==="kept-stale"` (@203686720),
 * `if(M?.kind!=="kept-stale")await q$e(e,n)` in refreshMarketplace
 * (@203707943), `if(!G){…lastUpdated…}` in the bulk path (@203703245), and
 * `({marketplace:M,keptStaleClone:N}=await Z$e(...))…if(!N)await q$e(e,n);return M`
 * in the getMarketplace read-through (@203699740). `q$e` @203668163 stamps
 * lastUpdated AND saves known_marketplaces.json.
 *
 * OCC mirrors this with `MarketplaceCacheResult` = `{kind:'refreshed'}` |
 * `{kind:'kept-stale'}`, surfaced as `keptStaleClone` on loadAndCacheMarketplace's
 * return. The first block pins the marker at its source
 * (`cacheMarketplaceFromGit`); the second pins the read-through stamp guard
 * end-to-end through `getMarketplace`. Real git remotes (file://) are used,
 * matching the adjacent cacheMarketplaceFromGit.test.ts /
 * marketplaceSwapSafety276.test.ts pattern. The read-through block sandboxes
 * CLAUDE_CODE_PLUGIN_CACHE_DIR per test (reservedNameImitation280.test.ts
 * pattern) so no real user config is touched and no sibling test file's
 * module-scope env assignment can leak in.
 */

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

const MP_NAME = 'kept-stale-mp'
const REMOTE_UNREACHABLE = 'file:///nonexistent/remote-xyz'
/** Sentinel timestamp pre-planted in known_marketplaces.json. */
const SENTINEL_LAST_UPDATED = '2020-01-01T00:00:00.000Z'
/** Frozen clock: also the value a genuine stamp would write. */
const FIXED_NOW = new Date('2026-09-25T12:00:00.000Z')
const FIXED_ISO = FIXED_NOW.toISOString()

function git(cwd: string, ...args: string[]): string {
  return execSync(`git ${args.join(' ')}`, { cwd, env: GIT_ENV }).toString()
}

// A normal repo we commit into, then a bare clone acts as the "remote". The repo
// carries a valid .claude-plugin/marketplace.json so the KEEP branch's
// hasMarketplaceManifest() gate is satisfied (2.1.276 ITEM 2).
function makeBareRemote(repoDir: string): string {
  git(repoDir, 'init', '--initial-branch=main')
  writeFileSync(join(repoDir, 'README.md'), 'v1\n')
  mkdirSync(join(repoDir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(repoDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: MP_NAME, owner: { name: 't' }, plugins: [] }),
  )
  git(repoDir, 'add', 'README.md', '.claude-plugin/marketplace.json')
  git(repoDir, 'commit', '-m', 'v1')
  const barePath = `${repoDir}.git`
  execSync(`git clone --bare "${repoDir}" "${barePath}"`, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return barePath
}

// Force `git pull` to fail by pointing origin at a non-existent remote, while
// the gitUrl ARGUMENT passed to cacheMarketplaceFromGit stays valid (so a
// no-KEEP re-clone can still succeed).
function corruptOriginUrl(cachePath: string, badUrl: string): void {
  execSync(`git remote set-url origin "${badUrl}"`, { cwd: cachePath })
}

describe('cacheMarketplaceFromGit: kept-stale marker (CC 2.1.281 #060)', () => {
  let workdir: string
  let remote: string
  let cachePath: string
  const savedEnv = process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'mm-kept-stale-281-'))
    const srcRepo = join(workdir, 'src')
    mkdirSync(srcRepo, { recursive: true })
    remote = makeBareRemote(srcRepo)
    cachePath = join(workdir, 'cache')
    delete process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
    rmSync(`${workdir}.git`, { recursive: true, force: true })
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE
    } else {
      process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE = savedEnv
    }
  })

  test('initial clone reports {kind:"refreshed"} (a real fetch — callers may stamp)', async () => {
    const result = await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    expect(result).toEqual({ kind: 'refreshed' })
    expect(existsSync(join(cachePath, 'README.md'))).toBe(true)
  })

  test('an up-to-date pull reports {kind:"refreshed"}', async () => {
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    // Second call against the still-valid origin: pull succeeds (no changes).
    const result = await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    expect(result).toEqual({ kind: 'refreshed' })
  })

  test('KEEP-on-failure with a valid existing clone reports {kind:"kept-stale"} and preserves the clone', async () => {
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    const sentinel = join(cachePath, 'SENTINEL_KEEP')
    writeFileSync(sentinel, 'kept')
    corruptOriginUrl(cachePath, REMOTE_UNREACHABLE)

    process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE = '1'
    const result = await cacheMarketplaceFromGit(`file://${remote}`, cachePath)

    // The marker callers gate the lastUpdated stamp on.
    expect(result).toEqual({ kind: 'kept-stale' })
    // The stale clone was kept (not rm'd / re-cloned).
    expect(existsSync(sentinel)).toBe(true)
    expect(existsSync(join(cachePath, 'README.md'))).toBe(true)
  })

  test('without KEEP, a failed pull re-clones and reports {kind:"refreshed"}', async () => {
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    const sentinel = join(cachePath, 'SENTINEL_RECLONE')
    writeFileSync(sentinel, 'temp')
    corruptOriginUrl(cachePath, REMOTE_UNREACHABLE)

    delete process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE
    const result = await cacheMarketplaceFromGit(`file://${remote}`, cachePath)

    // A genuine fresh fetch happened (sentinel gone), so stamping is correct.
    expect(result).toEqual({ kind: 'refreshed' })
    expect(existsSync(sentinel)).toBe(false)
    expect(existsSync(join(cachePath, 'README.md'))).toBe(true)
  })

  test('KEEP env set but the pull SUCCEEDS → {kind:"refreshed"} (marker keys off the failure, not the env)', async () => {
    await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE = '1'
    // Origin still valid → pull succeeds → KEEP branch never fires.
    const result = await cacheMarketplaceFromGit(`file://${remote}`, cachePath)
    expect(result).toEqual({ kind: 'refreshed' })
  })
})

/**
 * Read-through stamp guard (getMarketplace). The official guards this path too —
 * @203699740 destructures `keptStaleClone` off `Z$e` and writes
 * `if(!N)await q$e(e,n);return M`, so a kept-stale re-fetch serves the stale
 * catalog WITHOUT claiming a fresh timestamp.
 *
 * Setup note: for a `git` source loadAndCacheMarketplace clones into
 * `join(getMarketplacesCacheDir(), 'temp_' + Date.now())`. Freezing the clock
 * makes that path deterministic so we can pre-seed it with an existing clone
 * whose origin is unreachable — which is what routes the re-fetch down
 * `git pull` → KEEP → `{kind:'kept-stale'}` instead of a first-time clone.
 */
describe('getMarketplace read-through: kept-stale must not stamp lastUpdated (CC 2.1.281 #060)', () => {
  let workdir: string
  let remote: string
  let sandbox: string
  let savedCacheDir: string | undefined
  let savedSeedDir: string | undefined
  const savedEnv = process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE

  // Resolved per call (never at module scope) so a sibling test file's env
  // assignment cannot change which directory these point at.
  const knownFile = (): string =>
    join(getPluginsDirectory(), 'known_marketplaces.json')

  function writeKnownMarketplaces(config: Record<string, unknown>): void {
    mkdirSync(getPluginsDirectory(), { recursive: true })
    writeFileSync(knownFile(), JSON.stringify(config), 'utf-8')
  }

  function readLastUpdated(name: string): string | undefined {
    const raw = JSON.parse(readFileSync(knownFile(), 'utf-8')) as Record<
      string,
      { lastUpdated?: string }
    >
    return raw[name]?.lastUpdated
  }

  // A registry entry whose installLocation has no catalog: readCachedMarketplace
  // throws, so getMarketplace falls through to the source re-fetch we want to
  // exercise. lastUpdated is the sentinel we assert on.
  function registerWithMissingCache(): void {
    writeKnownMarketplaces({
      [MP_NAME]: {
        source: { source: 'git', url: `file://${remote}` },
        installLocation: join(workdir, 'missing-cache'),
        lastUpdated: SENTINEL_LAST_UPDATED,
      },
    })
  }

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'mm-kept-stale-rt-'))
    const srcRepo = join(workdir, 'src')
    mkdirSync(srcRepo, { recursive: true })
    remote = makeBareRemote(srcRepo)

    sandbox = mkdtempSync(join(tmpdir(), 'mm-kept-stale-sandbox-'))
    mkdirSync(join(sandbox, 'marketplaces'), { recursive: true })
    savedCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    savedSeedDir = process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = sandbox
    delete process.env.CLAUDE_CODE_PLUGIN_SEED_DIR

    delete process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE
    clearMarketplacesCache()
    setSystemTime(FIXED_NOW)
  })

  afterEach(() => {
    setSystemTime()
    clearMarketplacesCache()
    if (savedCacheDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = savedCacheDir
    }
    if (savedSeedDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = savedSeedDir
    }
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE
    } else {
      process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE = savedEnv
    }
    rmSync(workdir, { recursive: true, force: true })
    rmSync(`${workdir}.git`, { recursive: true, force: true })
    rmSync(sandbox, { recursive: true, force: true })
  })

  test('REGRESSION #060: a re-fetch that kept a stale clone serves it but leaves lastUpdated untouched', async () => {
    // Seed the deterministic git temp path so the re-fetch PULLs it.
    const seeded = join(getMarketplacesCacheDir(), `temp_${Date.now()}`)
    await cacheMarketplaceFromGit(`file://${remote}`, seeded)
    corruptOriginUrl(seeded, REMOTE_UNREACHABLE)

    process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE = '1'
    registerWithMissingCache()

    const marketplace = await getMarketplace(MP_NAME)

    // The kept (stale) clone was still served — the read-through succeeds.
    expect(marketplace.name).toBe(MP_NAME)
    // Nothing was fetched, so the timestamp must NOT have been rewritten.
    expect(readLastUpdated(MP_NAME)).toBe(SENTINEL_LAST_UPDATED)
  })

  test('control: a re-fetch that genuinely cloned DOES stamp lastUpdated (guard keys off the marker, not the env)', async () => {
    // No seeded temp dir → first-time clone from the valid source.url succeeds.
    // KEEP is set, proving the env alone does not suppress the stamp.
    process.env.CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE = '1'
    registerWithMissingCache()

    const marketplace = await getMarketplace(MP_NAME)

    expect(marketplace.name).toBe(MP_NAME)
    expect(readLastUpdated(MP_NAME)).toBe(FIXED_ISO)
    expect(readLastUpdated(MP_NAME)).not.toBe(SENTINEL_LAST_UPDATED)
  })
})
