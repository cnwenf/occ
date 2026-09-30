/**
 * Tests for pluginFolderCollision.ts — the official 2.1.285 plugin install
 * id-collision refusal (changelog item 12). Covers the platform case-fold,
 * cache/data folder model, holder detection, and the byte-exact refusal
 * messages per surface.
 */

import { describe, expect, test } from 'bun:test'
import { getProjectRoot } from '../../../bootstrap/state.js'
import {
  type FolderHolder,
  PluginFolderHeldError,
  buildFolderHeldMessage,
  detectFolderCollision,
  explainIdDifference,
  findFolderHolders,
  foldPathForComparison,
  hasNoInstallations,
  marketplaceOf,
  pathsCollide,
  pluginCacheFolderName,
  sharesFoldersWith,
} from '../pluginFolderCollision.js'

describe('foldPathForComparison (official f1/iC)', () => {
  test('folds case on windows and macos only', () => {
    // Arrange
    const path = 'cache/C/A-B'

    // Act & Assert
    expect(foldPathForComparison(path, 'win32')).toBe('cache/c/a-b')
    expect(foldPathForComparison(path, 'darwin')).toBe('cache/c/a-b')
    expect(foldPathForComparison(path, 'linux')).toBe('cache/C/A-B')
  })

  test('strips zero-width and bidi invisibles before folding', () => {
    // Arrange — ZWNJ after "c", RLO inside "a-b"
    const withInvisibles = 'CACHE/C‌/A‮-B'

    // Act
    const folded = foldPathForComparison(withInvisibles, 'darwin')

    // Assert
    expect(folded).toBe('cache/c/a-b')
  })
})

describe('pluginCacheFolderName (official jst("",id))', () => {
  test('sanitizes marketplace and name into cache/<mkt>/<name>', () => {
    // Act & Assert — "." is not in [a-zA-Z0-9-_] so it becomes "-"
    expect(pluginCacheFolderName('a.b@c')).toBe('cache/c/a-b')
    expect(pluginCacheFolderName('a-b@c')).toBe('cache/c/a-b')
  })

  test('falls back to "unknown" marketplace and full id name', () => {
    // Act & Assert
    expect(pluginCacheFolderName('solo')).toBe('cache/unknown/solo')
  })

  test('splits at the LAST @ like the official gc/Bx normalization', () => {
    // Act & Assert
    expect(pluginCacheFolderName('name@with@market')).toBe(
      'cache/market/name-with',
    )
  })
})

describe('sharesFoldersWith (official I7t)', () => {
  test('"a.b@c" and "a-b@c" share the cache folder on every platform', () => {
    // Act & Assert
    expect(sharesFoldersWith('a.b@c', 'a-b@c', 'linux')).toBe('folder')
    expect(sharesFoldersWith('a.b@c', 'a-b@c', 'darwin')).toBe('folder')
  })

  test('capitals-only ids collide on win32/darwin but not linux', () => {
    // Act & Assert
    expect(sharesFoldersWith('A.B@C', 'a.b@c', 'win32')).toBe('folder')
    expect(sharesFoldersWith('A.B@C', 'a.b@c', 'darwin')).toBe('folder')
    expect(sharesFoldersWith('A.B@C', 'a.b@c', 'linux')).toBeNull()
  })

  test('reports "data" when only the data dirs collide (@ written as -)', () => {
    // Arrange — cache paths differ (cache/b-c/a vs cache/c/a-b) but the
    // sanitized full ids both fold to "a-b-c"
    // Act & Assert
    expect(sharesFoldersWith('a@b-c', 'a-b@c', 'linux')).toBe('data')
  })

  test('distinct ids do not collide', () => {
    // Act & Assert
    expect(sharesFoldersWith('alpha@shop', 'beta@shop', 'darwin')).toBeNull()
    expect(sharesFoldersWith('a.b@c', 'x.y@z', 'win32')).toBeNull()
  })
})

describe('pathsCollide / marketplaceOf / explainIdDifference', () => {
  test('pathsCollide compares under the platform fold (official A7t)', () => {
    expect(pathsCollide('data/A-B', 'data/a-b', 'darwin')).toBe(true)
    expect(pathsCollide('data/A-B', 'data/a-b', 'linux')).toBe(false)
  })

  test('marketplaceOf extracts the trailing marketplace (official gc)', () => {
    expect(marketplaceOf('name@mkt')).toBe('mkt')
    expect(marketplaceOf('name@')).toBeUndefined()
    expect(marketplaceOf('name')).toBeUndefined()
  })

  test('explainIdDifference flags punctuation/capitals/atSign (official ear)', () => {
    // Act & Assert
    expect(explainIdDifference('a-b@c', 'a.b@c', 'folder')).toEqual({
      capitals: false,
      punctuation: true,
      atSign: false,
    })
    expect(explainIdDifference('A-B@C', 'a.b@c', 'folder')).toEqual({
      capitals: true,
      punctuation: true,
      atSign: false,
    })
    expect(explainIdDifference('a@b-c', 'a-b@c', 'data')).toEqual({
      capitals: false,
      punctuation: false,
      atSign: true,
    })
  })
})

describe('hasNoInstallations / findFolderHolders (official mze/O7t)', () => {
  const registry = {
    'a-b@c': [{ scope: 'user' }],
    'solo@shop': [{ scope: 'project', projectPath: '/proj' }],
  }

  test('an installed id is never a refusal candidate', () => {
    expect(hasNoInstallations(registry, 'a-b@c')).toBe(false)
    expect(hasNoInstallations(registry, 'a.b@c')).toBe(true)
  })

  test('the primary plugin directory id is exempt', () => {
    // Arrange
    const id = 'something@anthropic-plugin-directory'

    // Act & Assert
    expect(hasNoInstallations(registry, id)).toBe(false)
    expect(findFolderHolders(registry, id)).toEqual([])
  })

  test('finds installed holders of a colliding folder with their scopes', () => {
    // Act
    const holders = findFolderHolders(registry, 'a.b@c')

    // Assert
    expect(holders).toEqual([
      { id: 'a-b@c', shares: 'folder', installations: [{ scope: 'user' }] },
    ])
  })

  test('returns no holders when the candidate is itself installed', () => {
    // Act & Assert
    expect(findFolderHolders(registry, 'a-b@c')).toEqual([])
  })
})

describe('detectFolderCollision (official x7t)', () => {
  test('prefers an installed holder over a same-install twin', () => {
    // Arrange
    const registry = { 'a-b@c': [{ scope: 'user' }] }

    // Act
    const collision = detectFolderCollision(['a.b@c'], ['a-b@c'], registry)

    // Assert
    expect(collision?.sharedWith).toBe('installed')
    expect(collision?.pluginId).toBe('a.b@c')
  })

  test('reports a same-install twin when nothing is installed yet', () => {
    // Act
    const collision = detectFolderCollision(['a.b@c'], ['a-b@c'], {})

    // Assert
    expect(collision).toEqual({
      pluginId: 'a.b@c',
      sharedWith: 'same-install',
      twin: 'a-b@c',
      shares: 'folder',
    })
  })

  test('returns null when no candidate collides', () => {
    // Act & Assert
    expect(detectFolderCollision(['alpha@shop'], ['beta@shop'], {})).toBeNull()
  })
})

describe('buildFolderHeldMessage (official Ist)', () => {
  const holders: FolderHolder[] = [
    { id: 'a-b@c', shares: 'folder', installations: [{ scope: 'user' }] },
  ]

  test('cli single-holder message is byte-identical to the official', () => {
    // Act
    const message = buildFolderHeldMessage({
      refused: 'a.b@c',
      askedFor: 'a.b@c',
      sharedWith: 'installed',
      holders,
      surface: 'cli',
    })

    // Assert
    expect(message).toBe(
      '"a.b@c" was not installed: it would share its folder with "a-b@c", ' +
        'which is installed, because the two ids differ only in "." and "-". ' +
        'Only one of the two can be installed. To install "a.b@c" instead, ' +
        'first run `occ plugin uninstall a-b@c`. Uninstalling a plugin also ' +
        'deletes its saved data.',
    )
  })

  test('same-install twins get the maintainer message', () => {
    // Act
    const message = buildFolderHeldMessage({
      refused: 'a.b@c',
      askedFor: 'a.b@c',
      sharedWith: 'same-install',
      twin: 'a-b@c',
      shares: 'folder',
      surface: 'cli',
    })

    // Assert
    expect(message).toBe(
      '"a.b@c" was not installed: it would share its folder with "a-b@c", ' +
        'which the same install brings along, because the two ids differ ' +
        "only in \".\" and \"-\". Only the marketplace's maintainer can fix " +
        'this, by renaming one of them.',
    )
  })

  test('data-only collisions phrase the difference via "@" and "."', () => {
    // Act
    const message = buildFolderHeldMessage({
      refused: 'a@b-c',
      askedFor: 'a@b-c',
      sharedWith: 'same-install',
      twin: 'a-b@c',
      shares: 'data',
      surface: 'cli',
    })

    // Assert
    expect(message).toContain('would share its saved data with')
    expect(message).toContain(
      'are the same once "@" and "." are written as "-"',
    )
  })

  test('managed installations defer to the administrator', () => {
    // Arrange
    const managed: FolderHolder[] = [
      { id: 'a-b@c', shares: 'folder', installations: [{ scope: 'managed' }] },
    ]

    // Act
    const message = buildFolderHeldMessage({
      refused: 'a.b@c',
      askedFor: 'a.b@c',
      sharedWith: 'installed',
      holders: managed,
      surface: 'cli',
    })

    // Assert
    expect(message).toContain('which your organization installed')
    expect(message).toContain('Ask your administrator.')
    expect(message).not.toContain('uninstall')
  })

  test('notice surface leads with the uninstall step', () => {
    // Act
    const message = buildFolderHeldMessage({
      refused: 'a.b@c',
      askedFor: 'a.b@c',
      sharedWith: 'installed',
      holders,
      surface: 'notice',
    })

    // Assert
    expect(message.startsWith('First uninstall "a-b@c" in /plugin, to install "a.b@c" instead.')).toBe(true)
    expect(message).toContain("If /plugin asks, let it delete the plugin's saved data")
  })

  test('ui surface suggests the scope for non-user installations', () => {
    // Arrange — a local-scope install in the CURRENT project, so the message
    // shows the "at local scope" suffix (not the other-project phrasing)
    const localHolders: FolderHolder[] = [
      {
        id: 'a-b@c',
        shares: 'folder',
        installations: [{ scope: 'local', projectPath: getProjectRoot() }],
      },
    ]

    // Act
    const message = buildFolderHeldMessage({
      refused: 'a.b@c',
      askedFor: 'a.b@c',
      sharedWith: 'installed',
      holders: localHolders,
      surface: 'ui',
    })

    // Assert — scope suffix shown, and the data-deletion note uses "When it asks"
    expect(message).toContain('uninstall "a-b@c" at local scope')
    expect(message).toContain('When it asks, let it delete')
  })

  test('non-shell-safe holder ids fall back to the plain uninstall text', () => {
    // Arrange — space fails the official h2 guard /^\w[\w.@-]*$/
    const oddHolders: FolderHolder[] = [
      { id: 'bad id@c', shares: 'folder', installations: [{ scope: 'user' }] },
    ]

    // Act
    const message = buildFolderHeldMessage({
      refused: 'bad-id@c',
      askedFor: 'bad-id@c',
      sharedWith: 'installed',
      holders: oddHolders,
      surface: 'cli',
    })

    // Assert
    expect(message).toContain('first uninstall "bad id@c".')
    expect(message).not.toContain('run `occ')
  })
})

describe('PluginFolderHeldError (official FPt)', () => {
  test('carries the validation category and the holder list', () => {
    // Arrange
    const holders: FolderHolder[] = [
      { id: 'a-b@c', shares: 'folder', installations: [{ scope: 'user' }] },
    ]

    // Act
    const error = new PluginFolderHeldError('refused', holders)

    // Assert
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PluginFolderHeldError')
    expect(error.pluginCommandErrorCategory).toBe('validation')
    expect(error.holders).toBe(holders)
  })
})
