/**
 * Tests for pluginSettingsKeyResolution.ts — the portable half of the
 * official 2.1.285 fix: "`claude plugin disable`/`enable` with a full
 * `name@marketplace` id changing a settings entry in another letter case
 * instead of the installed plugin's own".
 */

import { describe, expect, test } from 'bun:test'
import {
  findStoredPluginKey,
  foldPluginSettingsKey,
  matchesPluginIdCaseInsensitive,
  planEnabledPluginsWrite,
  resolveEnabledPluginsKey,
} from '../pluginSettingsKeyResolution.js'

describe('matchesPluginIdCaseInsensitive (official sf)', () => {
  test('matches ids differing only in letter case', () => {
    // Act & Assert
    expect(matchesPluginIdCaseInsensitive('Foo@Bar', 'foo@bar')).toBe(true)
    expect(matchesPluginIdCaseInsensitive('foo@bar', 'foo@bar')).toBe(true)
  })

  test('does not match different ids', () => {
    // Act & Assert
    expect(matchesPluginIdCaseInsensitive('foo@bar', 'foo@baz')).toBe(false)
    expect(matchesPluginIdCaseInsensitive('foo', 'foo@bar')).toBe(false)
  })
})

describe('foldPluginSettingsKey (official Uo)', () => {
  test('NFC-normalizes and lowercases', () => {
    // Arrange — "café" spelled NFD (e + combining acute), uppercase C
    const decomposed = 'Café@Mkt'

    // Act & Assert
    expect(foldPluginSettingsKey(decomposed)).toBe('café@mkt')
    expect(foldPluginSettingsKey('Foo@Bar')).toBe('foo@bar')
  })
})

describe('findStoredPluginKey (official AA)', () => {
  test('prefers the exact spelling over a case variant', () => {
    // Arrange
    const keys = ['plug@mkt', 'Plug@Mkt', 'other@mkt']

    // Act & Assert
    expect(findStoredPluginKey(keys, 'plug@mkt')).toBe('plug@mkt')
    expect(findStoredPluginKey(keys, 'Plug@Mkt')).toBe('Plug@Mkt')
  })

  test('falls back to the first case-insensitive match', () => {
    // Arrange
    const keys = ['plug@mkt', 'other@mkt']

    // Act & Assert
    expect(findStoredPluginKey(keys, 'PLUG@MKT')).toBe('plug@mkt')
  })

  test('returns undefined when the id is not stored in any case', () => {
    // Act & Assert
    expect(findStoredPluginKey(['other@mkt'], 'plug@mkt')).toBeUndefined()
    expect(findStoredPluginKey([], 'plug@mkt')).toBeUndefined()
  })
})

describe('resolveEnabledPluginsKey', () => {
  test('resolves the stored key of the installed plugin entry', () => {
    // Arrange — settings stored the plugin in lowercase
    const enabledPlugins = { 'plug@mkt': true, 'other@mkt': false }

    // Act & Assert — disable/enable with another letter case must find
    // the plugin's OWN entry, not miss and create a duplicate
    expect(resolveEnabledPluginsKey(enabledPlugins, 'Plug@Mkt')).toBe('plug@mkt')
    expect(resolveEnabledPluginsKey(enabledPlugins, 'plug@mkt')).toBe('plug@mkt')
    expect(resolveEnabledPluginsKey(enabledPlugins, 'nope@mkt')).toBeUndefined()
    expect(resolveEnabledPluginsKey(undefined, 'plug@mkt')).toBeUndefined()
  })
})

describe('planEnabledPluginsWrite (official Ke sweep, alias-free)', () => {
  test('writing an id nulls out stored case-variant duplicates', () => {
    // Arrange — the 2.1.284 bug left BOTH keys behind
    const enabledPlugins = { 'plug@mkt': true }

    // Act
    const plan = planEnabledPluginsWrite(enabledPlugins, 'Plug@Mkt')

    // Assert
    expect(plan.written).toBe('Plug@Mkt')
    expect(plan.replaced).toEqual(['plug@mkt'])
  })

  test('an exact-spelling write replaces nothing', () => {
    // Arrange
    const enabledPlugins = { 'plug@mkt': true, 'other@mkt': false }

    // Act
    const plan = planEnabledPluginsWrite(enabledPlugins, 'plug@mkt')

    // Assert
    expect(plan).toEqual({ written: 'plug@mkt', replaced: [] })
  })

  test('unrelated keys are untouched and empty records are safe', () => {
    // Act & Assert
    expect(planEnabledPluginsWrite(undefined, 'plug@mkt')).toEqual({
      written: 'plug@mkt',
      replaced: [],
    })
    expect(
      planEnabledPluginsWrite({ 'PLUG@other': true }, 'plug@mkt').replaced,
    ).toEqual([])
  })
})
