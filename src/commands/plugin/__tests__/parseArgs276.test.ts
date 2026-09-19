import { describe, expect, test } from 'bun:test'
import {
  formatInstallFromSourceCommand,
  getPluginInstallCompletions,
  parsePluginArgs,
} from '../parseArgs.js'
import { getInitialViewState } from '../PluginSettings.js'

/**
 * claude-code 2.1.275 ITEM 1: `/plugin install <plugin> --marketplace <source>`
 * offer-to-add flow. Ports the official parser chunk (@208179468), completion
 * entry (@208192104) and router (jy@224148318). All user-facing strings are
 * asserted byte-exact against the official 2.1.276 binary.
 */

const USAGE = 'Usage: /plugin install <plugin> --marketplace <source>'

describe('parsePluginArgs: --marketplace flag (official o()@208179468)', () => {
  test('separate-flag form parses to install-from-source', () => {
    expect(parsePluginArgs('install myplugin --marketplace owner/repo')).toEqual({
      type: 'install-from-source',
      plugin: 'myplugin',
      marketplaceSource: 'owner/repo',
    })
  })

  test('inline --marketplace= form parses to install-from-source', () => {
    expect(parsePluginArgs('install myplugin --marketplace=https://example.com/mp.git')).toEqual({
      type: 'install-from-source',
      plugin: 'myplugin',
      marketplaceSource: 'https://example.com/mp.git',
    })
  })

  test('flag order does not matter and `i` alias works', () => {
    expect(parsePluginArgs('i --marketplace owner/repo myplugin')).toEqual({
      type: 'install-from-source',
      plugin: 'myplugin',
      marketplaceSource: 'owner/repo',
    })
  })

  test('missing source → byte-exact usage error', () => {
    expect(parsePluginArgs('install myplugin --marketplace')).toEqual({
      type: 'usage-error',
      message: `--marketplace needs a marketplace source (owner/repo or a URL). ${USAGE}`,
    })
    // A following flag does not count as the source.
    expect(parsePluginArgs('install myplugin --marketplace --other')).toEqual({
      type: 'usage-error',
      message: `--marketplace needs a marketplace source (owner/repo or a URL). ${USAGE}`,
    })
  })

  test('wrong plugin-name count → byte-exact usage error', () => {
    expect(parsePluginArgs('install --marketplace owner/repo')).toEqual({
      type: 'usage-error',
      message: `--marketplace needs exactly one plugin name. ${USAGE}`,
    })
    expect(parsePluginArgs('install a b --marketplace owner/repo')).toEqual({
      type: 'usage-error',
      message: `--marketplace needs exactly one plugin name. ${USAGE}`,
    })
  })

  test('plugin@marketplace combined with --marketplace → byte-exact conflict error', () => {
    expect(parsePluginArgs('install plug@mp --marketplace owner/repo')).toEqual({
      type: 'usage-error',
      message: `Name the marketplace once: <plugin>@<marketplace>, or ${USAGE.slice(7)}`,
    })
  })
})

describe('parsePluginArgs: install target parsing (official Que order)', () => {
  test('plugin@marketplace splits at the LAST @ (scoped names work)', () => {
    expect(parsePluginArgs('install plugin@market')).toEqual({
      type: 'install',
      plugin: 'plugin',
      marketplace: 'market',
    })
    expect(parsePluginArgs('install @scope/plugin@market')).toEqual({
      type: 'install',
      plugin: '@scope/plugin',
      marketplace: 'market',
    })
  })

  test('leading @ with a slash is a scoped plugin, not a marketplace', () => {
    expect(parsePluginArgs('install @scope/plugin')).toEqual({
      type: 'install',
      plugin: '@scope/plugin',
    })
  })

  test('URL/path-looking target is still treated as a marketplace', () => {
    expect(parsePluginArgs('install https://example.com/mp.git')).toEqual({
      type: 'install',
      marketplace: 'https://example.com/mp.git',
    })
    expect(parsePluginArgs('install owner/repo')).toEqual({
      type: 'install',
      marketplace: 'owner/repo',
    })
  })

  test('bare name and empty args keep the old shapes', () => {
    expect(parsePluginArgs('install myplugin')).toEqual({
      type: 'install',
      plugin: 'myplugin',
    })
    expect(parsePluginArgs('install')).toEqual({ type: 'install' })
  })
})

describe('router: getInitialViewState (official jy@224148318)', () => {
  test('usage-error routes to the menu (message seeds result)', () => {
    expect(getInitialViewState({ type: 'usage-error', message: 'boom' })).toEqual({
      type: 'menu',
    })
  })

  test('install-from-source routes to the add-marketplace offer with the plugin pinned', () => {
    expect(
      getInitialViewState({
        type: 'install-from-source',
        plugin: 'myplugin',
        marketplaceSource: 'owner/repo',
      }),
    ).toEqual({
      type: 'add-marketplace',
      initialValue: 'owner/repo',
      confirmAdd: { plugin: 'myplugin', linkOrigin: false },
    })
  })

  test('marketplace add with a target offers confirmation (linkOrigin)', () => {
    expect(
      getInitialViewState({ type: 'marketplace', action: 'add', target: 'owner/repo' }),
    ).toEqual({
      type: 'add-marketplace',
      initialValue: 'owner/repo',
      confirmAdd: { linkOrigin: true },
    })
  })

  test('bare marketplace add opens the plain input form', () => {
    expect(getInitialViewState({ type: 'marketplace', action: 'add', target: '' })).toEqual({
      type: 'add-marketplace',
      initialValue: '',
    })
  })
})

describe('completion entry (official @208192104, byte-exact)', () => {
  test('offers --marketplace once a plugin name is completed', () => {
    expect(getPluginInstallCompletions(['install', 'myplugin'], '-')).toEqual([
      {
        value: '--marketplace',
        description: 'Install from a marketplace source, adding it first',
      },
    ])
    expect(getPluginInstallCompletions(['i', 'myplugin'], '--m')).toEqual([
      {
        value: '--marketplace',
        description: 'Install from a marketplace source, adding it first',
      },
    ])
  })

  test('no offer when the official condition does not hold', () => {
    // Empty current token.
    expect(getPluginInstallCompletions(['install', 'myplugin'], '')).toEqual([])
    // No argument completed yet.
    expect(getPluginInstallCompletions(['install'], '-')).toEqual([])
    // Target was a marketplace, not a plugin.
    expect(getPluginInstallCompletions(['install', 'owner/repo'], '-')).toEqual([])
    // plugin@marketplace already names the marketplace.
    expect(getPluginInstallCompletions(['install', 'plug@mp'], '-')).toEqual([])
    // Not an install subcommand.
    expect(getPluginInstallCompletions(['manage', 'x'], '-')).toEqual([])
  })
})

describe('formatInstallFromSourceCommand (official fEr@208179468)', () => {
  test('renders the canonical command byte-exactly', () => {
    expect(
      formatInstallFromSourceCommand({
        plugin: 'myplugin',
        marketplaceSource: 'owner/repo',
      }),
    ).toBe('/plugin install myplugin --marketplace owner/repo')
  })
})
