import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearAllPluginCaches } from '../cacheUtils.js'
import {
  clearInstalledPluginsCache,
  getInMemoryInstalledPlugins,
  loadInstalledPluginsV2,
} from '../installedPluginsManager.js'

/**
 * CC 2.1.299 #082: `/reload-plugins` misses a plugin installed moments earlier
 * from another terminal. The refresh path (refreshActivePlugins →
 * clearAllCaches → clearAllPluginCaches → loadAllPlugins) reads the installed
 * set via getInMemoryInstalledPlugins(), which memoizes installed_plugins.json
 * for the process lifetime (both installedPluginsCacheV2 and the
 * inMemoryInstalledPlugins session snapshot). Before the fix,
 * clearAllPluginCaches() did NOT clear that memoization, so the freshly
 * installed plugin stayed invisible until a full restart.
 *
 * getPluginsDirectory() reads CLAUDE_CODE_PLUGIN_CACHE_DIR at call time, so
 * setting it before the first read redirects all IO to the sandbox.
 */

const sandbox = mkdtempSync(join(tmpdir(), 'occ-reload-plugins-299-'))
const savedCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = sandbox

const installedPluginsPath = join(sandbox, 'installed_plugins.json')

function writeInstalledPlugins(pluginIds: string[]): void {
  writeFileSync(
    installedPluginsPath,
    JSON.stringify({
      version: 2,
      plugins: Object.fromEntries(
        pluginIds.map(id => [
          id,
          [{ scope: 'user', installPath: join(sandbox, id), version: '1.0.0' }],
        ]),
      ),
    }),
    'utf-8',
  )
}

afterEach(() => {
  // Keep the module singletons from leaking the sandbox into other tests.
  clearInstalledPluginsCache()
})

afterAll(() => {
  if (savedCacheDir === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = savedCacheDir
  }
  rmSync(sandbox, { recursive: true, force: true })
})

describe('2.1.299 #082 — clearAllPluginCaches clears the installed-plugins memoization', () => {
  test('config written → cached read → mutated on disk → clearAllPluginCaches() → fresh value', () => {
    // Arrange: alpha installed on disk; warm both caches.
    writeInstalledPlugins(['alpha@market'])
    expect(Object.keys(loadInstalledPluginsV2().plugins)).toEqual([
      'alpha@market',
    ])
    expect(Object.keys(getInMemoryInstalledPlugins().plugins)).toEqual([
      'alpha@market',
    ])

    // Act: another terminal installs beta — mutate the file WITHOUT any
    // in-process write (bypasses saveInstalledPluginsV2's cache update).
    writeInstalledPlugins(['alpha@market', 'beta@market'])

    // Pre-fix behavior, pinned: memoized reads still see only alpha.
    expect(Object.keys(getInMemoryInstalledPlugins().plugins)).toEqual([
      'alpha@market',
    ])

    // The /reload-plugins path.
    clearAllPluginCaches()

    // Assert: both memoized readers now see beta.
    expect(Object.keys(getInMemoryInstalledPlugins().plugins).sort()).toEqual([
      'alpha@market',
      'beta@market',
    ])
    expect(Object.keys(loadInstalledPluginsV2().plugins).sort()).toEqual([
      'alpha@market',
      'beta@market',
    ])
  })

  test('removal on disk is also visible after clearAllPluginCaches()', () => {
    writeInstalledPlugins(['gamma@market'])
    expect(Object.keys(getInMemoryInstalledPlugins().plugins)).toContain(
      'gamma@market',
    )

    writeInstalledPlugins([])
    clearAllPluginCaches()

    expect(Object.keys(getInMemoryInstalledPlugins().plugins)).toEqual([])
  })
})
