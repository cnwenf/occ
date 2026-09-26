import { describe, expect, test } from 'bun:test'

import {
  MANAGED_ONLY_KEYS,
  stripManagedOnlyKeys,
} from '../managedOnlyKeys.js'
import { buildStrictPolicySchema } from '../policyStrictSchema.js'
import { SettingsSchema } from '../types.js'

/**
 * CC 2.1.283 managed-only model-governance keys — official `Ad`/`xy` strip
 * (@196774265 region) and the `Ko` strict-policy wrappers for
 * `deniedModels` (@196677430) + the `Qe` lock-table entry for
 * `availableModelsMatch` (@196433200–196436000, restrictive:"exact").
 * Pure schema tests — no settings mocks needed.
 */

type CollectedIssue = {
  path: string
  message: string
  statusOnly?: boolean
  substituted?: boolean
}

function parseWithStrictPolicySchema(data: unknown): {
  result: ReturnType<ReturnType<typeof buildStrictPolicySchema>['safeParse']>
  issues: CollectedIssue[]
} {
  const issues: CollectedIssue[] = []
  const schema = buildStrictPolicySchema(issue => {
    issues.push(issue as CollectedIssue)
  })
  return { result: schema.safeParse(data), issues }
}

describe('2.1.283 stripManagedOnlyKeys (official Ad)', () => {
  test('exposes exactly the two model-governance keys (OCC subset)', () => {
    expect(MANAGED_ONLY_KEYS).toEqual(['deniedModels', 'availableModelsMatch'])
  })

  test('strips both keys and warns with the official message', () => {
    // Arrange
    const data = {
      deniedModels: ['opus'],
      availableModelsMatch: 'exact',
      model: 'claude-sonnet-5',
    }

    // Act
    const { data: stripped, warnings } = stripManagedOnlyKeys(
      data,
      '/home/user/.claude/settings.json',
    )

    // Assert — `stripped` is typed as the full input shape (the strip is a
    // runtime delete), so narrow it for the structural comparison.
    expect(stripped).toEqual({ model: 'claude-sonnet-5' } as typeof stripped)
    expect(warnings).toEqual([
      {
        file: '/home/user/.claude/settings.json',
        path: 'deniedModels',
        message:
          '"deniedModels" is only honored from managed settings and was ignored here.',
        severity: 'warning',
      },
      {
        file: '/home/user/.claude/settings.json',
        path: 'availableModelsMatch',
        message:
          '"availableModelsMatch" is only honored from managed settings and was ignored here.',
        severity: 'warning',
      },
    ])
  })

  test('does not mutate the input (OCC immutability deviation from official delete)', () => {
    const data = { deniedModels: ['opus'], model: 'x' }
    stripManagedOnlyKeys(data, 'settings.json')
    expect(data).toEqual({ deniedModels: ['opus'], model: 'x' })
  })

  test('leaves documents without the keys untouched and silent', () => {
    const data = { model: 'claude-sonnet-5' }
    const { data: stripped, warnings } = stripManagedOnlyKeys(data, 'f.json')
    expect(stripped).toEqual(data)
    expect(warnings).toEqual([])
  })

  test('non-object input passes through with no warnings', () => {
    const { data, warnings } = stripManagedOnlyKeys(
      null as unknown as Record<string, unknown>,
      'f.json',
    )
    expect(data).toBeNull()
    expect(warnings).toEqual([])
  })
})

describe('2.1.283 strict policy schema: deniedModels wrapper (official Ko @196677430)', () => {
  test('accepts a valid string list unchanged', () => {
    const { result, issues } = parseWithStrictPolicySchema({
      deniedModels: ['claude-opus-5-5', 'opus'],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as { deniedModels?: string[] }).deniedModels).toEqual([
        'claude-opus-5-5',
        'opus',
      ])
    }
    expect(issues).toEqual([])
  })

  test('drops non-string entries individually with the type-based message', () => {
    const { result, issues } = parseWithStrictPolicySchema({
      deniedModels: ['claude-opus-5-5', 42, null, true],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as { deniedModels?: string[] }).deniedModels).toEqual([
        'claude-opus-5-5',
      ])
    }
    expect(issues.map(i => i.message)).toEqual([
      '"deniedModels" contained a non-string entry (number); the entry was ignored.',
      '"deniedModels" contained a non-string entry (null); the entry was ignored.',
      '"deniedModels" contained a non-string entry (boolean); the entry was ignored.',
    ])
    expect(issues.every(i => i.path === 'deniedModels')).toBe(true)
  })

  test('a wholly invalid value is ignored and blocks NO models (official field-level fail-open)', () => {
    const { result, issues } = parseWithStrictPolicySchema({
      deniedModels: 'claude-opus-5-5',
      availableModels: ['claude-sonnet-5'],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const data = result.data as { deniedModels?: unknown; availableModels?: string[] }
      expect(data.deniedModels).toBeUndefined()
      // The rest of the document still enforces.
      expect(data.availableModels).toEqual(['claude-sonnet-5'])
    }
    expect(issues).toEqual([
      {
        path: 'deniedModels',
        message:
          '"deniedModels" was present but is not a list of model names, so it was ignored and blocks no models until it is fixed.',
      },
    ])
  })
})

describe('2.1.283 strict policy schema: availableModelsMatch lock (official Qe restrictive:"exact")', () => {
  test('accepts both enum values', () => {
    for (const value of ['prefix', 'exact']) {
      const { result, issues } = parseWithStrictPolicySchema({
        availableModelsMatch: value,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(
          (result.data as { availableModelsMatch?: string }).availableModelsMatch,
        ).toBe(value)
      }
      expect(issues).toEqual([])
    }
  })

  test('an invalid value substitutes the restrictive value "exact" (fail-closed)', () => {
    const { result, issues } = parseWithStrictPolicySchema({
      availableModelsMatch: 'EXACT',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(
        (result.data as { availableModelsMatch?: string }).availableModelsMatch,
      ).toBe('exact')
    }
    // Record 1: the substitution. Record 2: the pre-existing 2.1.282
    // onlySubstitutes tail notice (the substituted key is this document's
    // only policy content — official `ct` tail-check behavior).
    expect(issues[0]).toEqual({
      path: 'availableModelsMatch',
      message:
        '"availableModelsMatch" was present but invalid; treating it as "exact" (its restrictive value) until it is fixed.',
      substituted: true,
    })
    expect(issues).toHaveLength(2)
    expect(issues[1]).toMatchObject({
      path: 'availableModelsMatch',
      onlySubstitutes: true,
      statusOnly: true,
    })
  })

  test('a non-string value substitutes "exact" as well', () => {
    const { result, issues } = parseWithStrictPolicySchema({
      availableModelsMatch: true,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(
        (result.data as { availableModelsMatch?: string }).availableModelsMatch,
      ).toBe('exact')
    }
    expect(issues).toHaveLength(2)
    expect(issues[0]!.message).toContain('treating it as "exact"')
  })
})

describe('2.1.283 base settings schema accepts the new managed keys', () => {
  test('valid governance document parses through SettingsSchema', () => {
    const parsed = SettingsSchema().safeParse({
      availableModelsMatch: 'exact',
      deniedModels: ['claude-opus-5-5'],
      availableModels: ['claude-opus-5', 'claude-sonnet-5'],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.availableModelsMatch).toBe('exact')
      expect(parsed.data.deniedModels).toEqual(['claude-opus-5-5'])
    }
  })

  test('an invalid availableModelsMatch value fails the base (non-policy) schema', () => {
    const parsed = SettingsSchema().safeParse({
      availableModelsMatch: 'fuzzy',
    })
    expect(parsed.success).toBe(false)
  })

  test('schema describe texts match the official base schema byte-for-byte', () => {
    const shape = SettingsSchema().shape
    expect(shape.availableModelsMatch.description).toBe(
      'How availableModels entries match model IDs. "prefix" (the default) lets an entry also allow any model ID that extends it, so "claude-opus-5" allows "claude-opus-5-5". "exact" keeps that matching but stops a model ID entry from allowing other versions: "claude-opus-5" allows Opus 5 and its dated and -fast IDs, but not Opus 5.5 or a later release until it is listed, and a -latest ID needs a -latest entry. Family aliases ("opus") still allow the whole family; aliases whose model depends on the release or settings (best, opusplan, default) are ignored. With "exact" and a list that names at least one model, the Default option also uses only a listed model; if none can be used, Claude Code will not start. Haiku background models, and hooks and other helper requests that pick their own model, are not restricted (deniedModels covers them; allowManagedHooksOnly limits hooks). Read from managed settings only.',
    )
    expect(shape.deniedModels.description).toBe(
      'Models users cannot select, even when availableModels allows them. A family alias ("opus") blocks that family. A model ID blocks that version in every spelling: dates, -fast and provider prefixes are ignored, so "claude-opus-5-5" blocks every Opus 5.5 ID but not Opus 5. An ID with no minor version ("claude-opus-5") also blocks later minor versions, as it allows them in availableModels. Aliases whose model depends on the release or settings (best, opusplan, default) are ignored. The Default option steps down past a blocked model; if the Default has no allowed model to step down to, Claude Code will not start. Read from managed settings only.',
    )
  })
})
