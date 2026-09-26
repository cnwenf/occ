import { describe, expect, test } from 'bun:test'

import {
  classifyAvailableModelsEntry,
  entryMatchesDescriptorExact,
  exactMatchEntryWarning,
  literalAllowEntryWarning,
  prefixEntryAllowsModelExact,
} from '../availableModelsMatch.js'
import { parseModelDescriptor } from '../modelDescriptors.js'
import { parseUserSpecifiedModel } from '../model.js'

/**
 * CC 2.1.283 `availableModelsMatch` entry classification + exact-match
 * semantics — official `FUt` (@196740264), `T$o`, `PO`, `ql`, `Yh`. Pure
 * module: resolver functions are injected, no settings mocks required.
 */

const resolveAlias = (value: string): string => parseUserSpecifiedModel(value)
const resolveAliasEnvFree = (_value: string): string | null => null

describe('2.1.283 classifyAvailableModelsEntry (official FUt)', () => {
  test('classifies bare and claude-prefixed family aliases', () => {
    expect(classifyAvailableModelsEntry('opus')).toEqual({
      kind: 'family',
      family: 'opus',
    })
    expect(classifyAvailableModelsEntry('claude-haiku')).toEqual({
      kind: 'family',
      family: 'haiku',
    })
  })

  test('classifies full model IDs with the latest flag', () => {
    const plain = classifyAvailableModelsEntry('claude-opus-5-5')
    expect(plain.kind).toBe('model')
    if (plain.kind === 'model') {
      expect(plain.latest).toBe(false)
      expect(plain.id.family).toBe('opus')
      expect(plain.id.major).toBe(5)
      expect(plain.id.minor).toBe(5)
    }
    const latest = classifyAvailableModelsEntry('claude-opus-5-5-latest')
    expect(latest.kind).toBe('model')
    if (latest.kind === 'model') {
      expect(latest.latest).toBe(true)
    }
  })

  test('classifies shorthand version entries via the claude- prefix retry', () => {
    const shorthand = classifyAvailableModelsEntry('opus-4-5')
    expect(shorthand.kind).toBe('model')
    if (shorthand.kind === 'model') {
      expect(shorthand.spelling).toBe('claude-opus-4-5')
    }
  })

  test('ignores empty entries and release-dependent aliases', () => {
    expect(classifyAvailableModelsEntry('  ')).toEqual({ kind: 'ignored' })
    expect(classifyAvailableModelsEntry('best')).toEqual({ kind: 'ignored' })
    expect(classifyAvailableModelsEntry('opusplan')).toEqual({ kind: 'ignored' })
    expect(classifyAvailableModelsEntry('default')).toEqual({ kind: 'ignored' })
  })

  test('falls back to literal for unrecognizable names', () => {
    expect(classifyAvailableModelsEntry('my-custom-model')).toEqual({
      kind: 'literal',
      value: 'my-custom-model',
    })
  })

  test('normalizes case and the [1m] suffix', () => {
    const onem = classifyAvailableModelsEntry('Claude-Opus-5-5[1m]')
    expect(onem.kind).toBe('model')
    if (onem.kind === 'model') {
      expect(onem.spelling).toBe('claude-opus-5-5')
    }
  })
})

describe('2.1.283 prefixEntryAllowsModelExact (official PO) — exact vs prefix semantics', () => {
  const allows = (model: string, entry: string) =>
    prefixEntryAllowsModelExact(model, entry, resolveAlias, resolveAliasEnvFree)

  test('a model ID entry allows its own version, dated and -fast IDs', () => {
    expect(allows('claude-opus-5', 'claude-opus-5')).toBe(true)
    expect(allows('claude-opus-5-20260101', 'claude-opus-5')).toBe(true)
    expect(allows('claude-opus-5-fast', 'claude-opus-5')).toBe(true)
  })

  test('a model ID entry does NOT allow other versions under exact', () => {
    expect(allows('claude-opus-5-5', 'claude-opus-5')).toBe(false)
    expect(allows('claude-opus-6', 'claude-opus-5')).toBe(false)
    expect(allows('claude-opus-4-8', 'claude-opus-5')).toBe(false)
  })

  test('a -latest model needs a -latest entry', () => {
    expect(allows('claude-opus-5-5-latest', 'claude-opus-5-5')).toBe(false)
    expect(allows('claude-opus-5-5-latest', 'claude-opus-5-5-latest')).toBe(true)
  })

  test('family alias entries still allow the whole family', () => {
    expect(allows('claude-opus-5-5', 'opus')).toBe(true)
    expect(allows('claude-opus-99-1', 'claude-opus')).toBe(true)
  })

  test('literal and ignored entries never allow via the prefix tier', () => {
    expect(allows('my-custom-model', 'my-custom-model')).toBe(false)
    expect(allows('claude-opus-5', 'best')).toBe(false)
  })

  test('alias inputs are display-resolved before the descriptor check', () => {
    // Hermetic: parseUserSpecifiedModel is env/settings-dependent, so inject
    // a fixed resolver (PO takes the resolvers as parameters — official
    // passes Tt/ALr through the same way).
    const fixedResolve = (value: string): string =>
      value === 'sonnet' ? 'claude-sonnet-4-6' : value
    expect(
      prefixEntryAllowsModelExact(
        'sonnet',
        'claude-sonnet-4-6',
        fixedResolve,
        resolveAliasEnvFree,
      ),
    ).toBe(true)
    expect(
      prefixEntryAllowsModelExact(
        'sonnet',
        'claude-sonnet-4-5',
        fixedResolve,
        resolveAliasEnvFree,
      ),
    ).toBe(false)
  })

  test('provider spellings resolve through the descriptor grammar', () => {
    expect(allows('us.anthropic.claude-opus-5-5', 'claude-opus-5-5')).toBe(true)
    expect(allows('us.anthropic.claude-opus-5-6', 'claude-opus-5-5')).toBe(false)
  })
})

describe('2.1.283 entryMatchesDescriptorExact (official T$o)', () => {
  const entryOf = (raw: string) => {
    const classification = classifyAvailableModelsEntry(raw)
    if (classification.kind !== 'model') throw new Error('not a model entry')
    return classification
  }

  test('same version + identical UNNORMALIZED trailer required', () => {
    expect(
      entryMatchesDescriptorExact(
        entryOf('claude-opus-5'),
        parseModelDescriptor('claude-opus-5')!,
        false,
      ),
    ).toBe(true)
    // -fast normalizes away (trailer undefined) — official describe: an exact
    // entry "allows Opus 5 and its dated and -fast IDs".
    expect(
      entryMatchesDescriptorExact(
        entryOf('claude-opus-5'),
        parseModelDescriptor('claude-opus-5-fast')!,
        false,
      ),
    ).toBe(true)
    expect(
      entryMatchesDescriptorExact(
        entryOf('claude-opus-5'),
        parseModelDescriptor('claude-opus-5-beta')!,
        false,
      ),
    ).toBe(false)
    expect(
      entryMatchesDescriptorExact(
        entryOf('claude-opus-5-beta'),
        parseModelDescriptor('claude-opus-5-beta')!,
        false,
      ),
    ).toBe(true)
  })

  test('-latest target only passes with a -latest entry', () => {
    expect(
      entryMatchesDescriptorExact(
        entryOf('claude-opus-5-5'),
        parseModelDescriptor('claude-opus-5-5-latest')!,
        true,
      ),
    ).toBe(false)
    expect(
      entryMatchesDescriptorExact(
        entryOf('claude-opus-5-5-latest'),
        parseModelDescriptor('claude-opus-5-5-latest')!,
        true,
      ),
    ).toBe(true)
  })

  test('legacy version-first and version-last spellings never cross-match', () => {
    expect(
      entryMatchesDescriptorExact(
        entryOf('claude-3-5-sonnet'),
        parseModelDescriptor('claude-sonnet-3-5')!,
        false,
      ),
    ).toBe(false)
  })
})

describe('2.1.283 exactMatchEntryWarning (official ql)', () => {
  test('model entries never warn', () => {
    expect(exactMatchEntryWarning('claude-opus-5-5', ['claude-opus-5-5'])).toBeUndefined()
  })

  test('empty entries warn with the official message', () => {
    expect(exactMatchEntryWarning('', [''])).toBe(
      'An empty availableModels entry was ignored.',
    )
  })

  test('release-dependent aliases warn with the canonical example', () => {
    const warning = exactMatchEntryWarning('best', ['best', 'claude-opus-5-5'])
    expect(warning).toBe(
      '"best" in availableModels was ignored, because "availableModelsMatch" is "exact" and this name means a different model depending on the release and settings. List the model IDs you want to allow instead, for example "claude-opus-5-5".',
    )
  })

  test('a bare family wildcard warns even under exact', () => {
    const warning = exactMatchEntryWarning('opus', ['opus'])
    expect(warning).toBe(
      '"opus" in availableModels allows every Opus model, including future releases, even though "availableModelsMatch" is "exact". To allow only some versions, list their model IDs instead, for example "claude-opus-5-5".',
    )
  })

  test('a family alias narrowed by specific entries does NOT warn', () => {
    expect(
      exactMatchEntryWarning('opus', ['opus', 'claude-opus-4-5']),
    ).toBeUndefined()
  })

  test('literal entries only warn when Yh has a fix hint (bare return otherwise)', () => {
    // Byte-verified official Yh @196742485: ends with a bare `return` — a
    // plain literal entry under exact produces NO warning (unlike the
    // deniedModels Bh, which always renders its base sentence).
    expect(exactMatchEntryWarning('my-model', ['my-model'])).toBeUndefined()
    expect(exactMatchEntryWarning('claude-opus-5.5', ['claude-opus-5.5'])).toBe(
      '"claude-opus-5.5" in availableModels allows only a model named exactly "claude-opus-5.5". To allow a version, write it with a hyphen: "claude-opus-5-5".',
    )
    expect(exactMatchEntryWarning('sonnet 4.5', ['sonnet 4.5'])).toBe(
      '"sonnet 4.5" in availableModels allows only a model named exactly "sonnet 4.5". To allow a version, write its model ID, for example "claude-sonnet-4-5".',
    )
  })
})

describe('2.1.283 literalAllowEntryWarning hints (official Yh)', () => {
  test('dotted version gets the hyphen hint', () => {
    expect(literalAllowEntryWarning('claude-opus-5.5', 'claude-opus-5.5')).toContain(
      'To allow a version, write it with a hyphen: "claude-opus-5-5".',
    )
  })

  test('family prose gets the model-ID hint', () => {
    expect(literalAllowEntryWarning('sonnet 4.5', 'sonnet 4.5')).toContain(
      'To allow a version, write its model ID, for example "claude-sonnet-4-5".',
    )
  })

  test('plain literals return undefined (official Yh ends with a bare return)', () => {
    expect(literalAllowEntryWarning('my-model', 'my-model')).toBeUndefined()
  })
})
