import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'

// Hermetic for credential-less environments (CI runners): under CI=true /
// NODE_ENV=test the auth guard (src/utils/auth.ts) demands ANTHROPIC_API_KEY
// or CLAUDE_CODE_OAUTH_TOKEN before credential resolution. This suite is
// offline model-resolution logic; seed a dummy key when none is present.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * P3-7 acceptance follow-up (2.1.280 #001 opus-4-5→opus-5-5 launch +
 * #078 Pro/Team default-model promotion): PRODUCTION-ENTRY wiring test for
 * `useMainLoopModel` — the live main-loop hook every REPL surface
 * (REPL.tsx, PromptInput, StatusLine, LogoV2, …) reads the API model from.
 *
 * opus55Launch280.test.ts pins the pure functions (getDefaultOpusModel,
 * parseUserSpecifiedModel, getDefaultMainLoopModelSetting, isOpusDefaultTier)
 * in isolation. Nothing pinned the hook that actually calls them: deleting
 * the `parseUserSpecifiedModel(...)` wrapper or the
 * `?? getDefaultMainLoopModelSetting()` fallback in useMainLoopModel.ts kept
 * the whole suite green while the live main loop regressed. These tests
 * drive the REAL hook through a REAL React mount (ink render via
 * renderIsolated280, same harness as fastFooterLabel280.test.tsx) so the
 * production call sites are load-bearing: remove either and a test fails.
 *
 * Migration semantics as implemented (read from source, not guessed):
 * - the 'opus' alias and the null/default path resolve to claude-opus-5-5
 *   (#001 default-Opus switch, per getDefaultOpusModel);
 * - explicit LEGACY pins claude-opus-4-0/4-1 are remapped to the current
 *   Opus default (claude-opus-5-5) by parseUserSpecifiedModel's
 *   isLegacyOpusFirstParty gate;
 * - an explicit 'claude-opus-4-5' full-name pin is NOT in the legacy remap
 *   list and passes through untouched (negative case).
 *
 * OCC-97 (Gap-97b) lesson: Bun mock.module registrations leak across test
 * files in the same worker — snapshot the real module exports BEFORE mocking
 * and restore them in afterAll.
 */
const actualAuthModule = await import('../../utils/auth.js')
const actualAuthExports = { ...actualAuthModule }
const actualSettingsModule = await import('../../utils/settings/settings.js')
const actualSettingsExports = { ...actualSettingsModule }

const subState = {
  max: false,
  pro: false,
  team: false,
  teamPremium: false,
  claudeAi: false,
  type: null as string | null,
}

let mockedSettings: Record<string, unknown> = {}

mock.module('../../utils/auth.js', () => ({
  ...actualAuthExports,
  isMaxSubscriber: () => subState.max,
  isProSubscriber: () => subState.pro,
  isTeamSubscriber: () => subState.team,
  isTeamPremiumSubscriber: () => subState.teamPremium,
  isClaudeAISubscriber: () => subState.claudeAi,
  getSubscriptionType: () => subState.type,
}))

mock.module('../../utils/settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettings_DEPRECATED: () => mockedSettings,
  getInitialSettings: () => mockedSettings,
  getEnforceAvailableModels: () =>
    Boolean(mockedSettings.enforceAvailableModels),
}))

afterAll(() => {
  mock.module('../../utils/auth.js', () => ({ ...actualAuthExports }))
  mock.module('../../utils/settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
})

// Import the PRODUCTION modules under test AFTER the mocks are registered.
const { useMainLoopModel } = await import('../useMainLoopModel.js')
const { AppStateProvider } = await import('../../state/AppState.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
type AppState = import('../../state/AppStateStore.js').AppState
const { renderToStringIsolated } = await import(
  '../../components/CustomSelect/__tests__/renderIsolated280.js'
)
const { resetModelStringsForTestingOnly } = await import(
  'src/bootstrap/state.js'
)

// Probe component: calls the real hook during a real ink/React render and
// captures its return value. Rendering null keeps the assertion on the hook
// output, not on ink text layout.
let capturedModel: string | null = null

function MainLoopModelProbe(): null {
  capturedModel = useMainLoopModel()
  return null
}

async function runHook(stateOverrides: Partial<AppState>): Promise<string> {
  capturedModel = null
  await renderToStringIsolated(
    <AppStateProvider
      initialState={{ ...getDefaultAppState(), ...stateOverrides }}
    >
      <MainLoopModelProbe />
    </AppStateProvider>,
    80,
  )
  if (capturedModel === null) {
    throw new Error(
      'useMainLoopModel never ran — the probe component did not render',
    )
  }
  return capturedModel
}

function resetSubs(): void {
  subState.max = false
  subState.pro = false
  subState.team = false
  subState.teamPremium = false
  subState.claudeAi = false
  subState.type = null
}

beforeEach(() => {
  resetSubs()
  mockedSettings = {}
  for (const k of [
    'ANTHROPIC_DEFAULT_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT',
    'CLAUDE_CODE_3P_PROBE_WROTE_OPUS_DEFAULT',
    'CLAUDE_CODE_DISABLE_1M_CONTEXT',
    'CLAUDE_CODE_DISABLE_FAST_MODE',
    'CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP',
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
  // getModelStrings()/initModelStrings caches provider-derived strings in the
  // session-global bootstrap/state singleton — reset so per-provider env in
  // one test can't leak into the next (same seam as opus55Launch280).
  resetModelStringsForTestingOnly()
})

describe('useMainLoopModel wiring — 2.1.280 #001 opus→5.5 switch through the live hook', () => {
  test("stored 'opus' alias resolves to claude-opus-5-5 via the hook (parseUserSpecifiedModel call site)", async () => {
    const model = await runHook({ mainLoopModel: 'opus' })
    expect(model).toBe('claude-opus-5-5')
  })

  test('stored legacy claude-opus-4-1 pin is migrated to claude-opus-5-5 via the hook (legacy-remap gate)', async () => {
    const model = await runHook({ mainLoopModel: 'claude-opus-4-1' })
    expect(model).toBe('claude-opus-5-5')
  })

  test('negative: stored claude-opus-4-5 full-name pin passes through untouched', async () => {
    // claude-opus-4-5 is NOT in LEGACY_OPUS_FIRSTPARTY — an explicit 4.5 pin
    // is a deliberate user choice and the migration must not rewrite it.
    const model = await runHook({ mainLoopModel: 'claude-opus-4-5' })
    expect(model).toBe('claude-opus-4-5')
  })

  test('negative: a non-opus stored model is untouched', async () => {
    const model = await runHook({ mainLoopModel: 'claude-sonnet-4-6' })
    expect(model).toBe('claude-sonnet-4-6')
  })

  test("mainLoopModelForSession wins over mainLoopModel (?? precedence in the hook body)", async () => {
    const model = await runHook({
      mainLoopModel: 'opus',
      mainLoopModelForSession: 'haiku',
    })
    expect(model).toContain('haiku')
    expect(model).not.toContain('opus')
  })
})

describe('useMainLoopModel wiring — 2.1.280 #078 default-model promotion through the live hook', () => {
  test('null stored model on Pro → claude-opus-5-5 (getDefaultMainLoopModelSetting fallback call site)', async () => {
    subState.pro = true
    subState.claudeAi = true
    subState.type = 'pro'
    const model = await runHook({ mainLoopModel: null })
    expect(model).toBe('claude-opus-5-5')
  })

  test('null stored model on Team Standard → claude-opus-5-5[1m]', async () => {
    subState.team = true
    subState.claudeAi = true
    subState.type = 'team'
    const model = await runHook({ mainLoopModel: null })
    expect(model).toBe('claude-opus-5-5[1m]')
  })

  test('null stored model on Max → claude-opus-5-5[1m]', async () => {
    subState.max = true
    subState.claudeAi = true
    subState.type = 'max'
    const model = await runHook({ mainLoopModel: null })
    expect(model).toBe('claude-opus-5-5[1m]')
  })

  test('null stored model on TeamPremium → claude-opus-5-5[1m]', async () => {
    subState.teamPremium = true
    subState.claudeAi = true
    subState.type = 'team_premium'
    const model = await runHook({ mainLoopModel: null })
    expect(model).toBe('claude-opus-5-5[1m]')
  })

  test('null stored model on PAYG → Sonnet default (no promotion)', async () => {
    const model = await runHook({ mainLoopModel: null })
    expect(model).toContain('claude-sonnet')
    expect(model).not.toContain('opus')
  })
})
