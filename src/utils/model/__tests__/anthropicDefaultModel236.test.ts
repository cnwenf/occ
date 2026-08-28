import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Hermetic for credential-less environments (CI runners): under CI=true /
// NODE_ENV=test the auth guard (src/utils/auth.ts) demands ANTHROPIC_API_KEY
// or CLAUDE_CODE_OAUTH_TOKEN before credential resolution. This suite is
// offline model-resolution logic; seed a dummy key when none is present.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * 2.1.236 changelog #1: ANTHROPIC_DEFAULT_MODEL sets the model at session
 * start; /model selection still overrides it and persists across restarts
 * (unlike ANTHROPIC_MODEL). Ported from the official 2.1.236 binary
 * (resolver jxt + default chain N6/odt): the env default sits below
 * ANTHROPIC_MODEL and settings.model, above the subscriber-tier default.
 *
 * OCC-97 (Gap-97b) lesson: Bun mock.module registrations leak across test
 * files in the same worker — spread the real module and restore it in
 * afterAll.
 */
const actualSettingsModule = await import('../../settings/settings.js')

let mockedSettings: Record<string, unknown> = {}

mock.module('../../settings/settings.js', () => ({
  ...actualSettingsModule,
  getSettings_DEPRECATED: () => mockedSettings,
  getInitialSettings: () => mockedSettings,
}))

afterAll(() => {
  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsModule,
  }))
})

const {
  getDefaultMainLoopModel,
  getDefaultMainLoopModelSetting,
  getDefaultSonnetModel,
  getUserSpecifiedModelSetting,
  resolveAnthropicDefaultModel,
} = await import('../model.js')

// NOTE: getMainLoopModel is deliberately NOT imported here — another suite
// (todoToolsAvailability233) mock.modules model.js with a stub
// getMainLoopModel, and Bun evaluates test-file top-level imports while that
// registration may still be active (OCC-97 leak class). getDefaultMainLoopModel
// is not mocked anywhere and exercises the same parseUserSpecifiedModel path.

const ENV_KEY = 'ANTHROPIC_DEFAULT_MODEL'
const TEST_MODEL = 'claude-sonnet-5'

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
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

beforeEach(() => {
  mockedSettings = {}
  delete process.env[ENV_KEY]
  delete process.env.ANTHROPIC_MODEL
})

describe('2.1.236: resolveAnthropicDefaultModel guards (official jxt)', () => {
  test('returns undefined when the env var is unset', () => {
    expect(resolveAnthropicDefaultModel()).toBeUndefined()
  })

  test('returns undefined for empty or whitespace-only values', () => {
    withEnv({ [ENV_KEY]: '' }, () => {
      expect(resolveAnthropicDefaultModel()).toBeUndefined()
    })
    withEnv({ [ENV_KEY]: '   ' }, () => {
      expect(resolveAnthropicDefaultModel()).toBeUndefined()
    })
  })

  test('returns a valid concrete model unchanged', () => {
    withEnv({ [ENV_KEY]: TEST_MODEL }, () => {
      expect(resolveAnthropicDefaultModel()).toBe(TEST_MODEL)
    })
  })

  test('treats "default" and "inherit" as sentinels (case-insensitive, trimmed)', () => {
    for (const value of ['default', 'inherit', 'DEFAULT', ' Inherit ']) {
      withEnv({ [ENV_KEY]: value }, () => {
        expect(resolveAnthropicDefaultModel()).toBeUndefined()
      })
    }
  })

  test('rejects opusplan/haiku aliases, including with a [1m] suffix', () => {
    for (const value of ['opusplan', 'haiku', 'opusplan[1m]', 'OPUSPLAN']) {
      withEnv({ [ENV_KEY]: value }, () => {
        expect(resolveAnthropicDefaultModel()).toBeUndefined()
      })
    }
  })

  test('yields when enforceAvailableModels is active (env default is inert)', () => {
    mockedSettings = {
      enforceAvailableModels: true,
      availableModels: [TEST_MODEL],
    }
    withEnv({ [ENV_KEY]: TEST_MODEL }, () => {
      expect(resolveAnthropicDefaultModel()).toBeUndefined()
    })
  })

  test('rejects a model outside the availableModels allowlist', () => {
    mockedSettings = { availableModels: ['claude-opus-5'] }
    withEnv({ [ENV_KEY]: TEST_MODEL }, () => {
      expect(resolveAnthropicDefaultModel()).toBeUndefined()
    })
  })

  test('accepts a model inside the availableModels allowlist', () => {
    mockedSettings = { availableModels: [TEST_MODEL] }
    withEnv({ [ENV_KEY]: TEST_MODEL }, () => {
      expect(resolveAnthropicDefaultModel()).toBe(TEST_MODEL)
    })
  })
})

describe('2.1.236: default-chain wiring (official N6/odt position)', () => {
  test('env default becomes the default main loop model setting', () => {
    withEnv({ [ENV_KEY]: TEST_MODEL }, () => {
      expect(getDefaultMainLoopModelSetting()).toBe(TEST_MODEL)
    })
  })

  test('without the env var the tier default is unchanged', () => {
    expect(getDefaultMainLoopModelSetting()).toBe(getDefaultSonnetModel())
  })

  test('getDefaultMainLoopModel resolves the env default end to end', () => {
    withEnv({ [ENV_KEY]: TEST_MODEL }, () => {
      expect(getDefaultMainLoopModel()).toBe(TEST_MODEL)
    })
  })
})

describe('2.1.236: priority order (changelog: /model still overrides and persists)', () => {
  test('ANTHROPIC_MODEL outranks ANTHROPIC_DEFAULT_MODEL', () => {
    withEnv(
      { [ENV_KEY]: TEST_MODEL, ANTHROPIC_MODEL: 'claude-opus-5' },
      () => {
        expect(getUserSpecifiedModelSetting()).toBe('claude-opus-5')
      },
    )
  })

  test('persisted settings.model outranks ANTHROPIC_DEFAULT_MODEL', () => {
    mockedSettings = { model: 'claude-opus-5' }
    withEnv({ [ENV_KEY]: TEST_MODEL }, () => {
      expect(getUserSpecifiedModelSetting()).toBe('claude-opus-5')
    })
  })

  test('ANTHROPIC_MODEL outranks settings.model (regression guard)', () => {
    mockedSettings = { model: TEST_MODEL }
    withEnv({ ANTHROPIC_MODEL: 'claude-opus-5' }, () => {
      expect(getUserSpecifiedModelSetting()).toBe('claude-opus-5')
    })
  })
})
