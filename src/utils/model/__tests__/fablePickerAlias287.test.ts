import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ModelOption } from '../modelOptions.js'

// Hermetic for credential-less environments (CI runners): under CI=true /
// NODE_ENV=test the auth guard (src/utils/auth.ts) demands ANTHROPIC_API_KEY
// or CLAUDE_CODE_OAUTH_TOKEN before credential resolution. This suite is
// offline model-resolution logic; seed a dummy key when none is present.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * 2.1.287 CL:18 — "Fixed picking Fable in /model on a claude.ai login saving
 * the current version's id, so your saved default now follows the newest
 * Fable like Opus and Sonnet do."
 *
 * Official delta (byte-verified, v286 `U8` @203061451 → v287 `U3`
 * @205079818): the ENTIRE change is `value:e` → `value:"fable"` in the Fable
 * picker-row builder. OCC's equivalent is the module-private
 * `getFablePickerRow(model, fastMode)` in src/utils/model/modelOptions.ts,
 * reached in production only through `getModelOptions()` (the Fable
 * post-step `ui(s,VG(OHe(),e))`, modelOptions.ts:1414-1417), so these tests
 * drive that production entry rather than the private builder.
 *
 * Pinned here:
 *  1. the inserted Fable row's `value` is the family ALIAS `'fable'` for
 *     every concrete version id the default-fable resolver can hand back
 *     (claude-fable-5-1, claude-fable-5, an env-pinned custom id) — the
 *     saved setting therefore follows the newest Fable, matching how the
 *     first-party Opus/Sonnet rows already store 'opus'/'sonnet'
 *     (getOpus55Option / getSonnet55Option);
 *  2. `description` / `descriptionForModel` still carry the marketing name
 *     derived from the concrete `model` argument (only `value` changed);
 *  3. the untouched tail-insert custom-pin path (official `YG`/`fi(E)`
 *     branch, modelOptions.ts:1432-1442) still rewrites a family-matched
 *     row's value in place to the user's pinned concrete model.
 *
 * OCC-97 (Gap-97b) lesson: Bun mock.module registrations leak across test
 * files in the same worker — snapshot the real module exports BEFORE mocking
 * and restore them in afterAll.
 */
const actualAuthModule = await import('../../auth.js')
const actualAuthExports = { ...actualAuthModule }
const actualSettingsModule = await import('../../settings/settings.js')
const actualSettingsExports = { ...actualSettingsModule }
const actualConfigModule = await import('../../config.js')
const actualConfigExports = { ...actualConfigModule }

const subState = {
  max: false,
  pro: false,
  team: false,
  teamPremium: false,
  claudeAi: false,
  type: null as string | null,
}

let mockedSettings: Record<string, unknown> = {}
let mockedGlobalConfig: Record<string, unknown> = {}

mock.module('../../auth.js', () => ({
  ...actualAuthExports,
  isMaxSubscriber: () => subState.max,
  isProSubscriber: () => subState.pro,
  isTeamSubscriber: () => subState.team,
  isTeamPremiumSubscriber: () => subState.teamPremium,
  isClaudeAISubscriber: () => subState.claudeAi,
  getSubscriptionType: () => subState.type,
}))

mock.module('../../settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettings_DEPRECATED: () => mockedSettings,
  getInitialSettings: () => mockedSettings,
}))

mock.module('../../config.js', () => ({
  ...actualConfigExports,
  getGlobalConfig: () => mockedGlobalConfig,
}))

afterAll(() => {
  mock.module('../../auth.js', () => ({ ...actualAuthExports }))
  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
  mock.module('../../config.js', () => ({ ...actualConfigExports }))
})

// Import the PRODUCTION module under test AFTER the mocks are registered.
const { getModelOptions, isFableModelValue } = await import(
  '../modelOptions.js'
)
const {
  resetModelStringsForTestingOnly,
  setMainLoopModelOverride,
  setInitialMainLoopModel,
} = await import('src/bootstrap/state.js')

const FABLE_BLURB = 'Most capable for your hardest and longest-running tasks'

function withEnv(
  env: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function fableRow(): ModelOption | undefined {
  return getModelOptions().find(
    opt => typeof opt.value === 'string' && isFableModelValue(opt.value),
  )
}

beforeEach(() => {
  subState.max = false
  subState.pro = false
  subState.team = false
  subState.teamPremium = false
  // CL:18 is about a claude.ai login: subscriber → no pricing suffix, so the
  // description assertions below are deterministic regardless of the runner's
  // cost table.
  subState.claudeAi = true
  subState.type = 'pro'
  mockedSettings = {}
  mockedGlobalConfig = {}
  setMainLoopModelOverride(undefined)
  setInitialMainLoopModel(null)
  for (const k of [
    'ANTHROPIC_DEFAULT_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_CUSTOM_MODEL_OPTION',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_DISABLE_1M_CONTEXT',
    'CLAUDE_CODE_DISABLE_FAST_MODE',
    'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'USER_TYPE',
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  setMainLoopModelOverride(undefined)
  setInitialMainLoopModel(null)
  resetModelStringsForTestingOnly()
})

describe('2.1.287 CL:18 — Fable picker row stores the family alias, not the version id', () => {
  test('stores value "fable" for the clean-env default Fable (claude-fable-5-1)', () => {
    // Arrange: firstParty + claude.ai subscriber, no pinned Fable version.
    const row = fableRow()

    // Act / Assert: the post-step row carries the ALIAS, not the concrete id.
    expect(row).toBeDefined()
    expect(row?.value).toBe('fable')
    expect(row?.label).toBe('Fable')
    // The v286 (pre-fix) behavior pinned the version id — guard against it.
    expect(row?.value).not.toBe('claude-fable-5-1')
  })

  test('stores value "fable" for every concrete Fable version id the resolver can return', () => {
    // Arrange / Act / Assert: the alias is independent of the `model` arg.
    for (const pinned of [
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-fable-6',
      'claude-mythos-5-1',
    ]) {
      withEnv({ ANTHROPIC_DEFAULT_FABLE_MODEL: pinned }, () => {
        expect(fableRow()?.value).toBe('fable')
      })
    }
  })

  test('keeps description/descriptionForModel derived from the concrete model arg', () => {
    // Arrange / Act / Assert: 5.1 default → "Fable 5.1" marketing name.
    withEnv({ ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1' }, () => {
      const row = fableRow()
      expect(row?.value).toBe('fable')
      expect(row?.description).toBe(`Fable 5.1 · ${FABLE_BLURB}`)
      expect(row?.descriptionForModel).toBe(
        'Fable 5.1 - most capable for your hardest and longest-running tasks',
      )
    })

    // Arrange / Act / Assert: 5 default → "Fable 5" marketing name (only the
    // wording tracks the version; `value` stays the alias).
    withEnv({ ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5' }, () => {
      const row = fableRow()
      expect(row?.value).toBe('fable')
      expect(row?.description).toBe(`Fable 5 · ${FABLE_BLURB}`)
      expect(row?.descriptionForModel).toBe(
        'Fable 5 - most capable for your hardest and longest-running tasks',
      )
    })
  })

  test('stores value "fable" for a non-subscriber too (pricing suffix does not change the alias)', () => {
    // Arrange: API-key login → getFablePricingSuffix path instead of "".
    subState.claudeAi = false
    subState.type = null

    // Act
    const row = fableRow()

    // Assert
    expect(row?.value).toBe('fable')
    expect(row?.label).toBe('Fable')
    expect(row?.description.startsWith(`Fable 5.1 · ${FABLE_BLURB}`)).toBe(true)
  })

  test('matches the first-party Opus/Sonnet rows, which already store the family alias', () => {
    // Arrange: Max subscriber → premium list carries an explicit 'opus' row.
    subState.max = true
    subState.type = 'max'

    // Act
    const values = getModelOptions()
      .map(opt => opt.value)
      .filter((v): v is string => typeof v === 'string')

    // Assert: Fable is no longer the odd one out — every family row is an alias.
    expect(values).toContain('fable')
    expect(values).toContain('sonnet')
    expect(values).toContain('haiku')
    expect(values.some(v => v.startsWith('claude-fable-'))).toBe(false)
  })

  test('tail-insert custom pin still rewrites the family row value to the pinned concrete model (official YG/fi(E), untouched)', () => {
    // Arrange: the user's saved model is a concrete Fable version, which no
    // longer matches any row value now that the row stores the alias.
    setInitialMainLoopModel('claude-fable-5-1')

    // Act
    const options = getModelOptions()
    const fableRows = options.filter(
      opt => typeof opt.value === 'string' && isFableModelValue(opt.value),
    )

    // Assert: the family-matched row was rewritten in place (label kept), and
    // no duplicate Fable row was appended.
    expect(fableRows).toHaveLength(1)
    expect(fableRows[0]?.value).toBe('claude-fable-5-1')
    expect(fableRows[0]?.label).toBe('Fable')
  })
})
