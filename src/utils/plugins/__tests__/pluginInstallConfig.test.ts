/**
 * Tests for pluginInstallConfig.ts — the official 2.1.285
 * `claude plugin install --config` parse/route core (changelog item 10).
 * User-facing strings are asserted byte-identical to the decompiled v285
 * functions `j` / `Z` / `B` / `P` (@222230700–222233300).
 */

import { describe, expect, test } from 'bun:test'
import {
  PluginInstallConfigError,
  buildUnreadRemoteSuffix,
  parseConfigPair,
  pluralize,
  routeConfigPairs,
} from '../pluginInstallConfig.js'

const READABLE = { unreadable: [], remoteCount: 0 }

describe('pluralize (official P)', () => {
  test('picks the singular form for 1 and the default plural otherwise', () => {
    expect(pluralize(1, 'option')).toBe('option')
    expect(pluralize(2, 'option')).toBe('options')
  })

  test('honors an explicit two-form plural', () => {
    expect(pluralize(1, 'server is', 'servers are')).toBe('server is')
    expect(pluralize(2, 'server is', 'servers are')).toBe('servers are')
  })
})

describe('parseConfigPair (official j)', () => {
  test('splits at the first equals sign only', () => {
    // Act
    const result = parseConfigPair('srv.url=https://x?a=b')

    // Assert
    expect(result).toEqual({ key: 'srv.url', raw: 'https://x?a=b' })
  })

  test('allows an empty value', () => {
    expect(parseConfigPair('key=')).toEqual({ key: 'key', raw: '' })
  })

  test('refuses a pair with no equals sign', () => {
    // Act & Assert — byte-exact message
    expect(() => parseConfigPair('novalue')).toThrow(
      '--config expects KEY=VALUE, got "novalue". Use --config key=value (repeatable).',
    )
  })

  test('refuses an empty key', () => {
    expect(() => parseConfigPair('=v')).toThrow(
      '--config expects KEY=VALUE, got "=v". Use --config key=value (repeatable).',
    )
  })

  test('carries the machine reason', () => {
    // Act
    let caught: unknown
    try {
      parseConfigPair('novalue')
    } catch (error) {
      caught = error
    }

    // Assert
    expect(caught).toBeInstanceOf(PluginInstallConfigError)
    expect((caught as PluginInstallConfigError).reason).toBe(
      '--config pair has no key',
    )
  })
})

describe('buildUnreadRemoteSuffix (official B)', () => {
  test('is empty when every bundle was read locally', () => {
    expect(buildUnreadRemoteSuffix(READABLE)).toBe('')
  })

  test('explains unreadable bundles with the em-dash debug hint', () => {
    // Act
    const suffix = buildUnreadRemoteSuffix({
      unreadable: ['mystery.mcpb'],
      remoteCount: 0,
    })

    // Assert — capitalized first letter, wrapped in parens with a period
    expect(suffix).toBe(
      ' (The bundled mystery.mcpb could not be read, so its keys are unknown — re-run with --debug-file <path> to log why.)',
    )
  })

  test('explains remote bundles with singular/plural agreement and the arrow path', () => {
    expect(buildUnreadRemoteSuffix({ unreadable: [], remoteCount: 1 })).toBe(
      ' (1 bundled server is fetched from a URL at session start and can only be configured in Claude Code (/plugin → Installed → Configure).)',
    )
    expect(buildUnreadRemoteSuffix({ unreadable: [], remoteCount: 2 })).toBe(
      ' (2 bundled servers are fetched from a URL at session start and can only be configured in Claude Code (/plugin → Installed → Configure).)',
    )
  })

  test('joins both clauses with a semicolon, capitalizing only the first', () => {
    // Act
    const suffix = buildUnreadRemoteSuffix({
      unreadable: ['mystery.mcpb'],
      remoteCount: 1,
    })

    // Assert
    expect(suffix).toBe(
      ' (The bundled mystery.mcpb could not be read, so its keys are unknown — re-run with --debug-file <path> to log why; 1 bundled server is fetched from a URL at session start and can only be configured in Claude Code (/plugin → Installed → Configure).)',
    )
  })

  test('folds ASCII apostrophes in unreadable names (vt sanitizer)', () => {
    // Act
    const suffix = buildUnreadRemoteSuffix({
      unreadable: ["srv's.mcpb"],
      remoteCount: 0,
    })

    // Assert — capitalized "The" (B capitalizes the joined clause)
    expect(suffix).toContain('The bundled srv’s.mcpb could not be read')
  })
})

describe('routeConfigPairs (official Z)', () => {
  test('routes a plugin userConfig key verbatim into pluginPairs', () => {
    // Arrange
    const bundles = [{ serverName: 'srv', schema: { key: {} } }]

    // Act
    const routed = routeConfigPairs(
      ['tok=abc'],
      { tok: { type: 'string' } },
      bundles,
      READABLE,
    )

    // Assert
    expect(routed.pluginPairs).toEqual(['tok=abc'])
    expect(routed.bundlePairs.size).toBe(0)
  })

  test('routes a prefixed bundle key, re-joining field=raw', () => {
    // Arrange
    const bundles = [{ serverName: 'srv', schema: { url: {} } }]

    // Act
    const routed = routeConfigPairs(
      ['srv.url=https://x?a=b'],
      undefined,
      bundles,
      READABLE,
    )

    // Assert
    expect(routed.pluginPairs).toEqual([])
    expect(routed.bundlePairs.get('srv')).toEqual(['url=https://x?a=b'])
  })

  test('routes a bare key when exactly one readable bundle declares it', () => {
    // Arrange
    const bundles = [{ serverName: 'srv', schema: { key: {} } }]

    // Act
    const routed = routeConfigPairs(['key=v'], undefined, bundles, READABLE)

    // Assert
    expect(routed.bundlePairs.get('srv')).toEqual(['key=v'])
  })

  test('accumulates multiple pairs per server in order', () => {
    // Arrange
    const bundles = [{ serverName: 'srv', schema: { a: {}, b: {} } }]

    // Act
    const routed = routeConfigPairs(
      ['srv.a=1', 'srv.b=2', 'tok=x'],
      { tok: {} },
      bundles,
      READABLE,
    )

    // Assert
    expect(routed.pluginPairs).toEqual(['tok=x'])
    expect(routed.bundlePairs.get('srv')).toEqual(['a=1', 'b=2'])
  })

  test('refuses a bare key when any bundle is unreadable or remote', () => {
    // Arrange
    const bundles = [{ serverName: 'srv', schema: { key: {} } }]

    // Act & Assert — byte-exact message + B suffix
    expect(() =>
      routeConfigPairs(['key=v'], undefined, bundles, {
        unreadable: ['mystery.mcpb'],
        remoteCount: 0,
      }),
    ).toThrow(
      '--config key "key" must name its server, because a bundled MCP server whose keys are unknown may declare it too; use srv.key.' +
        ' (The bundled mystery.mcpb could not be read, so its keys are unknown — re-run with --debug-file <path> to log why.)',
    )
  })

  test('allows a bare key with unreadable bundles only for prefixed use', () => {
    // Arrange — the prefixed form is unambiguous, so it still routes
    const bundles = [{ serverName: 'srv', schema: { key: {} } }]

    // Act
    const routed = routeConfigPairs(['srv.key=v'], undefined, bundles, {
      unreadable: ['mystery.mcpb'],
      remoteCount: 0,
    })

    // Assert
    expect(routed.bundlePairs.get('srv')).toEqual(['key=v'])
  })

  test('refuses a key declared by more than one bundled server', () => {
    // Arrange
    const bundles = [
      { serverName: 'a', schema: { key: {} } },
      { serverName: 'b', schema: { key: {} } },
    ]

    // Act & Assert — candidates joined with " or ", no B suffix
    expect(() =>
      routeConfigPairs(['key=v'], undefined, bundles, READABLE),
    ).toThrow(
      '--config key "key" is declared by more than one bundled MCP server; use a.key or b.key.',
    )
  })

  test('carries the ambiguity machine reason', () => {
    // Arrange
    const bundles = [
      { serverName: 'a', schema: { key: {} } },
      { serverName: 'b', schema: { key: {} } },
    ]

    // Act
    let caught: unknown
    try {
      routeConfigPairs(['key=v'], undefined, bundles, READABLE)
    } catch (error) {
      caught = error
    }

    // Assert
    expect((caught as PluginInstallConfigError).reason).toBe(
      '--config key is ambiguous between bundled servers',
    )
  })

  test('refuses an undeclared key, listing known plugin and bundle keys', () => {
    // Arrange
    const bundles = [{ serverName: 'srv', schema: { key: {} } }]

    // Act & Assert — plugin keys unquoted, bundle keys sanitized, comma-joined
    expect(() =>
      routeConfigPairs(['bogus=v'], { tok: {} }, bundles, READABLE),
    ).toThrow(
      "--config key \"bogus\" isn't declared in this plugin's userConfig or by its bundled MCP servers. Known keys: tok, srv.key.",
    )
  })

  test('omits the bundled-server clause when the plugin has no bundles', () => {
    // Act & Assert
    expect(() =>
      routeConfigPairs(['bogus=v'], { tok: {} }, [], READABLE),
    ).toThrow(
      "--config key \"bogus\" isn't declared in this plugin's userConfig. Known keys: tok.",
    )
  })

  test('omits the Known-keys clause when nothing is declared anywhere', () => {
    // Act & Assert
    expect(() =>
      routeConfigPairs(['bogus=v'], undefined, [], READABLE),
    ).toThrow("--config key \"bogus\" isn't declared in this plugin's userConfig.")
  })

  test('appends the B suffix to the undeclared refusal when bundles are unread', () => {
    // Act & Assert
    expect(() =>
      routeConfigPairs(['bogus=v'], { tok: {} }, [], {
        unreadable: [],
        remoteCount: 1,
      }),
    ).toThrow(
      "--config key \"bogus\" isn't declared in this plugin's userConfig. Known keys: tok." +
        ' (1 bundled server is fetched from a URL at session start and can only be configured in Claude Code (/plugin → Installed → Configure).)',
    )
  })

  test('refuses a prefixed key whose field the named server does not declare', () => {
    // Arrange
    const bundles = [{ serverName: 'srv', schema: { key: {} } }]

    // Act & Assert — "srv.other" matches neither prefixed nor bare
    expect(() =>
      routeConfigPairs(['srv.other=v'], undefined, bundles, READABLE),
    ).toThrow("--config key \"srv.other\" isn't declared in this plugin's userConfig or by its bundled MCP servers. Known keys: srv.key.")
  })
})
