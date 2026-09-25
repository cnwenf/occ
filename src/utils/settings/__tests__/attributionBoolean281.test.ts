/**
 * 2.1.281 PORT #005 tests: `attribution` input widened to `boolean | object`,
 * normalized AT PARSE TIME by the official transform+pipe chain.
 *
 * Binary evidence (v2.1.281 linux-x64 ELF):
 *   `attribution:Fe([O(),i],{error:(c)=>{...}}).transform((c)=>{if(typeof c
 *     !=="boolean")return c;return c?{}:{commit:"",pr:"",sessionUrl:!1}})
 *     .pipe(i).optional().describe('Customize attribution text...')`
 *   with the error callback emitting either the joined per-field branch
 *   issues or `Expected false, true, or an object such as { "commit": "",
 *   "pr": "" }, but received ${array|null|typeof input}`.
 *
 * Covers: schema normalization of false/true/object forms, the official union
 * error callback message, the formatZodError flattener (invalid_union at path
 * "attribution" → per-field issues), and the consumer hide-all path driven
 * through the REAL parse output (production consumers only ever see parsed
 * settings — `settings: result.data` in settings.ts — so booleans never reach
 * them; `attribution: false` arrives as `{commit:"",pr:"",sessionUrl:false}`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'
import { formatZodError } from '../validation.js'
import { SettingsSchema } from '../types.js'

/** Parse through the real schema — mirrors the production settings path. */
function parseSettings(input: Record<string, unknown>): Record<string, unknown> {
  const result = SettingsSchema().strict().safeParse(input)
  if (!result.success) {
    throw new Error(
      `test input should parse: ${JSON.stringify(input)} → ${result.error.message}`,
    )
  }
  return result.data as Record<string, unknown>
}

describe('2.1.281 #005: attribution boolean | object schema', () => {
  test('normalizes attribution: false to the hide-all object (official transform)', () => {
    const result = SettingsSchema().strict().safeParse({ attribution: false })
    expect(result.success).toBe(true)
    if (result.success) {
      // Binary transform: `return c?{}:{commit:"",pr:"",sessionUrl:!1}`
      expect(result.data.attribution).toEqual({
        commit: '',
        pr: '',
        sessionUrl: false,
      })
    }
  })

  test('normalizes attribution: true to the empty object (same as leaving it out)', () => {
    const result = SettingsSchema().strict().safeParse({ attribution: true })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.attribution).toEqual({})
    }
  })

  test('object form passes through the pipe target unchanged', () => {
    const result = SettingsSchema()
      .strict()
      .safeParse({
        attribution: { commit: 'C', pr: 'P', sessionUrl: false },
      })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.attribution).toEqual({
        commit: 'C',
        pr: 'P',
        sessionUrl: false,
      })
    }
  })

  test('invalid union value fails with the official readable message naming attribution', () => {
    const result = SettingsSchema().strict().safeParse({ attribution: 'nope' })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.length).toBe(1)
    expect(result.error.issues[0]!.path).toEqual(['attribution'])
    expect(result.error.issues[0]!.message).toBe(
      'Expected false, true, or an object such as { "commit": "", "pr": "" }, but received string',
    )
  })

  test('invalid union value null reports received null', () => {
    const result = SettingsSchema().strict().safeParse({ attribution: null })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]!.message).toContain('but received null')
  })

  test('object branch sub-issue surfaces through the union error message', () => {
    const result = SettingsSchema().strict().safeParse({
      attribution: { commit: 5 },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.length).toBe(1)
    expect(result.error.issues[0]!.path).toEqual(['attribution'])
    expect(result.error.issues[0]!.message).toBe(
      'commit: expected string, received number',
    )
  })

  test('formatZodError flattens attribution union sub-issues to attribution.commit', () => {
    const result = SettingsSchema().strict().safeParse({
      attribution: { commit: 5 },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    const errors = formatZodError(result.error, 'settings')
    expect(errors.length).toBe(1)
    expect(errors[0]!.path).toBe('attribution.commit')
    expect(errors[0]!.message).toBe('Expected string, but received number')
  })

  test('formatZodError keeps the single readable issue when no sub-issue has a path', () => {
    const result = SettingsSchema().strict().safeParse({ attribution: 'nope' })
    expect(result.success).toBe(false)
    if (result.success) return
    const errors = formatZodError(result.error, 'settings')
    expect(errors.length).toBe(1)
    expect(errors[0]!.path).toBe('attribution')
    expect(errors[0]!.message).toContain(
      'Expected false, true, or an object such as { "commit": "", "pr": "" }',
    )
  })
})

describe('2.1.281 #005: attribution consumers hide-all path', () => {
  let settingsOverride: Record<string, unknown> = {}
  // Passthrough flag: with it off (afterAll) a leaked getInitialSettings
  // closure delegates to the real settings stack instead of serving this
  // file's frozen override to every later file in the shared process.
  let settingsMockActive = true
  let attributionModule: typeof import('../../attribution.js')
  let actualSettingsModule: Record<string, unknown>

  beforeAll(async () => {
    // Snapshot via spread — a bare `await import()` namespace has LIVE
    // bindings that bun's mock.module patches, so delegating through it
    // would recurse into the mock itself (infinite loop).
    actualSettingsModule = { ...(await import('../settings.js')) }
    mock.module('../settings.js', () => ({
      ...actualSettingsModule,
      getInitialSettings: () =>
        settingsMockActive
          ? settingsOverride
          : (
              actualSettingsModule.getInitialSettings as () => Record<
                string,
                unknown
              >
            )(),
    }))
    attributionModule = await import('../../attribution.js')
  })

  afterAll(() => {
    settingsMockActive = false
    mock.module('../settings.js', () => actualSettingsModule)
  })

  test('getAttributionTexts returns empty commit and pr when attribution is false (normalized hide-all)', () => {
    settingsOverride = parseSettings({ attribution: false })
    expect(attributionModule.getAttributionTexts()).toEqual({
      commit: '',
      pr: '',
    })
  })

  test('getAttributionTexts keeps object-form behavior unchanged', () => {
    settingsOverride = parseSettings({ attribution: { commit: 'C', pr: 'P' } })
    expect(attributionModule.getAttributionTexts()).toEqual({
      commit: 'C',
      pr: 'P',
    })
  })

  test('getAttributionTexts object form falls back to defaults per field', () => {
    settingsOverride = parseSettings({ attribution: { pr: 'P' } })
    // OCC defaultCommit is '' (no co-author trailer by default)
    expect(attributionModule.getAttributionTexts()).toEqual({
      commit: '',
      pr: 'P',
    })
  })

  test('getAttributionTexts with attribution true normalizes to {} → OCC defaults (empty commit, Generated-with pr)', () => {
    settingsOverride = parseSettings({ attribution: true })
    // Official rLn(): the object branch (`g!==void 0&&gHr(g)`) takes
    // precedence over includeCoAuthoredBy — `{}` falls back to the defaults.
    const texts = attributionModule.getAttributionTexts()
    expect(texts.commit).toBe('')
    expect(texts.pr).toContain('Generated with')
  })

  test('getAttributionTexts with attribution true + includeCoAuthoredBy: true still takes the object branch', () => {
    settingsOverride = parseSettings({
      attribution: true,
      includeCoAuthoredBy: true,
    })
    const texts = attributionModule.getAttributionTexts()
    // OCC defaultCommit is '' even with includeCoAuthoredBy — the normalized
    // `{}` hits the attribution object branch before the deprecated flag.
    expect(texts.commit).toBe('')
    expect(texts.pr).toContain('Generated with')
  })

  test('getEnhancedPRAttribution returns empty string when attribution is false, even with includeCoAuthoredBy: true', async () => {
    settingsOverride = parseSettings({
      attribution: false,
      includeCoAuthoredBy: true,
    })
    // The #005 contract: normalized `pr: ""` + the official `!==void 0`
    // guard hides the PR attribution — the truthy-check reading would leak
    // the enhanced default here.
    const pr = await attributionModule.getEnhancedPRAttribution(() => {
      throw new Error('appState must not be read when attribution hides pr')
    })
    expect(pr).toBe('')
  })

  test('getSessionAttributionUrl returns null when attribution is false (normalized sessionUrl: false)', () => {
    settingsOverride = parseSettings({ attribution: false })
    expect(attributionModule.getSessionAttributionUrl()).toBeNull()
  })
})
