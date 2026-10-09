/**
 * Tests for the CC 2.1.295 `marketplace add` name refusal: a marketplace
 * whose name cannot form half of a `plugin@marketplace` id is refused at add
 * time, with the official message (binary-verbatim template; name capped at
 * 64 chars per official `je(ke, 64)`).
 */
import { describe, expect, test } from 'bun:test'
import {
  buildMarketplaceNameRefusalMessage,
  isValidPluginIdPart,
  PLUGIN_ID_PART_RULES_SENTENCE,
} from '../pluginIdentifier.js'

describe('isValidPluginIdPart (official mt/r0)', () => {
  test('accepts names starting with a letter or digit', () => {
    expect(isValidPluginIdPart('anthropic')).toBe(true)
    expect(isValidPluginIdPart('9lives')).toBe(true)
    expect(isValidPluginIdPart('a')).toBe(true)
  })

  test('accepts ".", "_" and "-" inside the name', () => {
    expect(isValidPluginIdPart('my.market_place-1')).toBe(true)
  })

  test('refuses names starting with ".", "_" or "-"', () => {
    expect(isValidPluginIdPart('.hidden')).toBe(false)
    expect(isValidPluginIdPart('_under')).toBe(false)
    expect(isValidPluginIdPart('-dash')).toBe(false)
  })

  test('refuses empty names', () => {
    expect(isValidPluginIdPart('')).toBe(false)
  })

  test('refuses names with characters outside the id alphabet', () => {
    expect(isValidPluginIdPart('has space')).toBe(false)
    expect(isValidPluginIdPart('has@at')).toBe(false)
    expect(isValidPluginIdPart('has/slash')).toBe(false)
    expect(isValidPluginIdPart('häs')).toBe(false)
  })

  test('enforces the official 128-character cap', () => {
    expect(isValidPluginIdPart('a'.repeat(128))).toBe(true)
    expect(isValidPluginIdPart('a'.repeat(129))).toBe(false)
  })
})

describe('PLUGIN_ID_PART_RULES_SENTENCE (official a3n)', () => {
  test('is byte-identical to the decompiled 2.1.295 sentence', () => {
    expect(PLUGIN_ID_PART_RULES_SENTENCE).toBe(
      'Each part of a plugin id (plugin@marketplace) may use only the letters a-z and A-Z, digits, ".", "_" and "-", and must start with a letter or digit.',
    )
  })
})

describe('buildMarketplaceNameRefusalMessage (official throw)', () => {
  test('is byte-identical to the decompiled 2.1.295 message', () => {
    expect(buildMarketplaceNameRefusalMessage('bad name')).toBe(
      'Cannot add marketplace "bad name": Claude Code cannot install plugins from a marketplace with this name. ' +
        'Each part of a plugin id (plugin@marketplace) may use only the letters a-z and A-Z, digits, ".", "_" and "-", and must start with a letter or digit. ' +
        'The name is set by "name" in the marketplace\'s marketplace.json; ask its maintainer to change it.',
    )
  })

  test('caps the displayed name at 64 characters (official je(ke, 64))', () => {
    const longName = 'n'.repeat(100)
    const message = buildMarketplaceNameRefusalMessage(longName)
    expect(message).toStartWith(
      `Cannot add marketplace "${'n'.repeat(64)}": Claude Code cannot install`,
    )
    expect(message).not.toContain(longName)
  })
})
