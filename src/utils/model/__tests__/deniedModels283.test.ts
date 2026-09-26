import { describe, expect, test } from 'bun:test'

import {
  deniedDescriptorBlocksModel,
  deniedEntryMatchesModel,
  describeDeniedDescriptor,
  familyMatchesByName,
  literalDeniedEntryWarning,
  parseDeniedModelEntry,
} from '../deniedModels.js'
import { parseModelDescriptor } from '../modelDescriptors.js'

/**
 * CC 2.1.283 `deniedModels` entry parsing — official `H5n` (@196738121),
 * `$h` (@196738974), `Bh`, `E$o`, `dr` (@198788643). Pure module: no
 * settings mocks required.
 */

describe('2.1.283 parseDeniedModelEntry (official H5n)', () => {
  test('parses a full model ID into a model rule with no warning', () => {
    // Arrange / Act
    const result = parseDeniedModelEntry('claude-opus-5-5')

    // Assert
    expect(result.entry).toEqual({
      kind: 'model',
      id: expect.objectContaining({ family: 'opus', major: 5, minor: 5 }),
    })
    expect(result.warning).toBeUndefined()
  })

  test('parses a bare family alias into a family rule', () => {
    const result = parseDeniedModelEntry('opus')
    expect(result.entry).toEqual({ kind: 'family', family: 'opus' })
    expect(result.warning).toBeUndefined()
  })

  test('treats the claude- family spelling as a literal (official H5n has no family retry)', () => {
    // Byte-verified: H5n's family check is O_(s) ONLY — unlike FUt (the
    // allowlist classifier), a "claude-"-prefixed family alias is NOT
    // retried, so it falls through to the literal rule + Bh warning.
    const result = parseDeniedModelEntry('claude-sonnet')
    expect(result.entry).toEqual({ kind: 'literal', value: 'claude-sonnet' })
    expect(result.warning).toBe(
      '"claude-sonnet" blocks only the exact model name "claude-sonnet"; other spellings of the same model are not blocked.',
    )
  })

  test('ignores an empty entry with the official warning', () => {
    const result = parseDeniedModelEntry('   ')
    expect(result.entry).toBeNull()
    expect(result.warning).toBe('An empty deniedModels entry was ignored.')
  })

  test('ignores release-dependent aliases (best/opusplan/default) with the official warning', () => {
    for (const alias of ['best', 'opusplan', 'default']) {
      const result = parseDeniedModelEntry(alias)
      expect(result.entry).toBeNull()
      expect(result.warning).toBe(
        `"${alias}" was ignored: it names a different model depending on the release and settings. Name the model instead, for example "claude-opus-5-5".`,
      )
    }
  })

  test('ignores the context-size suffix on an alias too (sonnet[1m])', () => {
    // Official F1 includes "sonnet[1m]" as a release-independent alias —
    // stripped to "sonnet" and treated as the family.
    const result = parseDeniedModelEntry('sonnet[1m]')
    expect(result.entry).toEqual({ kind: 'family', family: 'sonnet' })
  })

  test('retries with the claude- prefix for shorthand version entries', () => {
    const result = parseDeniedModelEntry('opus-4-5')
    expect(result.entry).toEqual({
      kind: 'model',
      id: expect.objectContaining({ family: 'opus', major: 4, minor: 5 }),
    })
  })

  test('warns that a no-minor ID blocks every minor of the major ($h prose)', () => {
    const result = parseDeniedModelEntry('claude-opus-5-20260101')
    expect(result.entry?.kind).toBe('model')
    // The date normalizes into the descriptor (trailer undefined), so the
    // official H5n trailer-ignored note fires for the trailing text.
    expect(result.warning).toBe(
      '"claude-opus-5-20260101" blocks every Opus 5.x model. "-20260101" is ignored.',
    )
  })

  test('warns that a minor ID blocks every spelling and snapshot', () => {
    const result = parseDeniedModelEntry('claude-opus-5-5-fast')
    expect(result.warning).toBe(
      '"claude-opus-5-5-fast" blocks Opus 5.5 in every spelling and snapshot. "-fast" is ignored.',
    )
  })

  test('notes context-size tags are ignored', () => {
    const result = parseDeniedModelEntry('claude-opus-5-5[1m]')
    expect(result.entry?.kind).toBe('model')
    expect(result.warning).toBe(
      '"claude-opus-5-5[1m]" blocks Opus 5.5 in every spelling and snapshot. Context-size tags such as [1m] are ignored: the entry blocks the model at every context size.',
    )
  })

  test('falls back to a literal rule for unrecognizable names, with the Bh warning', () => {
    const result = parseDeniedModelEntry('my-custom-model')
    expect(result.entry).toEqual({ kind: 'literal', value: 'my-custom-model' })
    expect(result.warning).toBe(
      '"my-custom-model" blocks only the exact model name "my-custom-model"; other spellings of the same model are not blocked.',
    )
  })
})

describe('2.1.283 literalDeniedEntryWarning hints (official Bh)', () => {
  test('suggests the hyphenated spelling for a dotted version', () => {
    const warning = literalDeniedEntryWarning('claude-opus-5.5', 'claude-opus-5.5')
    expect(warning).toContain('To block a version, write it with a hyphen: "claude-opus-5-5".')
  })

  test('suggests the model ID for family prose with a minor', () => {
    const warning = literalDeniedEntryWarning('opus 5.5', 'opus 5.5')
    expect(warning).toContain(
      'To block a version, write its model ID, for example "claude-opus-5-5".',
    )
  })

  test('explains major-only semantics for family prose without a minor', () => {
    const warning = literalDeniedEntryWarning('opus 5', 'opus 5')
    expect(warning).toContain(
      'To block only version 5, write "claude-opus-5-0"; "claude-opus-5" blocks every Opus 5.x model.',
    )
  })

  test('suggests the family for a one-typo alias (Damerau-Levenshtein 1)', () => {
    const warning = literalDeniedEntryWarning('opuz', 'opuz')
    expect(warning).toContain('If you meant the Opus family, write "opus".')
  })

  test('falls back to the family-list prose for other alphabetic literals', () => {
    const warning = literalDeniedEntryWarning('gpt-killer', 'gpt-killer')
    // Not alphabetic-only (hyphen) → plain base warning, no family hint.
    expect(warning).toBe(
      '"gpt-killer" blocks only the exact model name "gpt-killer"; other spellings of the same model are not blocked.',
    )
    const alphabetic = literalDeniedEntryWarning('mistral', 'mistral')
    expect(alphabetic).toContain(
      'To block a model family other than sonnet, opus, haiku or fable, list its versioned IDs.',
    )
  })
})

describe('2.1.283 describeDeniedDescriptor (official $h)', () => {
  test('major-only descriptor → "every <Family> <major>.x model"', () => {
    const descriptor = parseModelDescriptor('claude-haiku-4')
    expect(descriptor).not.toBeNull()
    expect(describeDeniedDescriptor(descriptor!)).toBe('every Haiku 4.x model')
  })

  test('minor descriptor → "<Family> <major>.<minor> in every spelling and snapshot"', () => {
    const descriptor = parseModelDescriptor('claude-sonnet-4-5')
    expect(describeDeniedDescriptor(descriptor!)).toBe(
      'Sonnet 4.5 in every spelling and snapshot',
    )
  })
})

describe('2.1.283 deniedDescriptorBlocksModel (official E$o)', () => {
  const rule = (id: string) => parseModelDescriptor(id)!
  const blocks = (ruleId: string, targetId: string) =>
    deniedDescriptorBlocksModel(rule(ruleId), rule(targetId))

  test('a minor rule blocks exactly that version, not the major sibling', () => {
    expect(blocks('claude-opus-5-5', 'claude-opus-5-5')).toBe(true)
    expect(blocks('claude-opus-5-5', 'claude-opus-5-5-fast')).toBe(true)
    expect(blocks('claude-opus-5-5', 'claude-opus-5')).toBe(false)
    expect(blocks('claude-opus-5-5', 'claude-opus-5-6')).toBe(false)
  })

  test('a no-minor rule blocks every later minor of the major', () => {
    expect(blocks('claude-opus-5', 'claude-opus-5')).toBe(true)
    expect(blocks('claude-opus-5', 'claude-opus-5-5')).toBe(true)
    expect(blocks('claude-opus-5', 'claude-opus-5-9')).toBe(true)
    expect(blocks('claude-opus-5', 'claude-opus-6')).toBe(false)
    expect(blocks('claude-opus-5', 'claude-sonnet-5')).toBe(false)
  })

  test('normalized -fast/-latest spellings are the same rule as the bare ID', () => {
    // Official describe: dates, -fast and provider prefixes are IGNORED —
    // "-fast" normalizes into the descriptor, so the rule blocks the whole
    // version in every spelling.
    expect(blocks('claude-opus-5-5-fast', 'claude-opus-5-5-fast')).toBe(true)
    expect(blocks('claude-opus-5-5-fast', 'claude-opus-5-5')).toBe(true)
    expect(blocks('claude-opus-5-5-fast', 'claude-opus-5-6')).toBe(false)
  })

  test('an UNNORMALIZED trailer rule blocks that trailer and its - extensions only', () => {
    expect(blocks('claude-opus-5-5-beta', 'claude-opus-5-5-beta')).toBe(true)
    expect(blocks('claude-opus-5-5-beta', 'claude-opus-5-5-beta-2')).toBe(true)
    expect(blocks('claude-opus-5-5-beta', 'claude-opus-5-5')).toBe(false)
  })
})

describe('2.1.283 deniedEntryMatchesModel (official OO)', () => {
  test('literal entries match only the exact normalized name', () => {
    const entry = { kind: 'literal', value: 'my-model' } as const
    expect(deniedEntryMatchesModel(entry, 'my-model', null)).toBe(true)
    expect(deniedEntryMatchesModel(entry, 'my-model-2', null)).toBe(false)
  })

  test('family entries match via descriptor and via the dr boundary scan', () => {
    const entry = { kind: 'family', family: 'opus' } as const
    expect(
      deniedEntryMatchesModel(entry, 'claude-opus-5', parseModelDescriptor('claude-opus-5')),
    ).toBe(true)
    // Provider spelling that parses to null descriptor still matches by name.
    expect(deniedEntryMatchesModel(entry, 'weird.opus.thing', null)).toBe(true)
    expect(deniedEntryMatchesModel(entry, 'claude-sonnet-5', parseModelDescriptor('claude-sonnet-5'))).toBe(false)
  })

  test('model entries require a parsed descriptor', () => {
    const entry = { kind: 'model', id: parseModelDescriptor('claude-opus-5-5')! } as const
    expect(
      deniedEntryMatchesModel(entry, 'claude-opus-5-5', parseModelDescriptor('claude-opus-5-5')),
    ).toBe(true)
    expect(deniedEntryMatchesModel(entry, 'claude-opus-5-5', null)).toBe(false)
  })
})

describe('2.1.283 familyMatchesByName (official dr @198788643)', () => {
  test('matches at segment boundaries in any provider spelling', () => {
    expect(familyMatchesByName('claude-opus-5-20260101', 'opus')).toBe(true)
    expect(familyMatchesByName('us.anthropic.claude-opus-5', 'opus')).toBe(true)
  })

  test('does not match inside a longer alphanumeric token', () => {
    expect(familyMatchesByName('opusplan', 'opus')).toBe(false)
    expect(familyMatchesByName('myopus', 'opus')).toBe(false)
    expect(familyMatchesByName('opusx', 'opus')).toBe(false)
  })

  test('matches when ANY occurrence is boundary-clean', () => {
    expect(familyMatchesByName('opusplan-opus', 'opus')).toBe(true)
  })
})
