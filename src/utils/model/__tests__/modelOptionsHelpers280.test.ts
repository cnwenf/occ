import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Hermetic for credential-less environments (CI runners): under CI=true /
// NODE_ENV=test the auth guard (src/utils/auth.ts) demands ANTHROPIC_API_KEY
// or CLAUDE_CODE_OAUTH_TOKEN before credential resolution. This suite is
// offline model-resolution logic; seed a dummy key when none is present.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * OCC-135 (2.1.280 /model picker alignment): unit tests for the ported
 * picker-row helper machinery in modelOptions.ts — the byte-verified official
 * functions qt (stripTrailing1mTag), Xn (stripAll1mTags), Pc (pickerFamily),
 * fi (isFableModelValue), Rv (fableRowKey), zr (modelRowsValueEqual), and
 * F5t (findMatchingOptionValue).
 *
 * getModelOptions-level wiring is covered by modelOptionsTierWiring280.test.ts
 * and opus55Launch280.test.ts; this file pins the helpers in isolation so a
 * regression in row identity (e.g. the A/B tail-row match that removes the
 * duplicate "Custom model" row, or the Fable alias↔concrete key match) fails
 * here with a precise signal.
 *
 * OCC-97 (Gap-97b) lesson: Bun mock.module registrations leak across test
 * files in the same worker — snapshot the real module exports BEFORE mocking
 * and restore them in afterAll.
 */
const actualSettingsModule = await import('../../settings/settings.js')
const actualSettingsExports = { ...actualSettingsModule }

let mockedSettings: Record<string, unknown> = {}

mock.module('../../settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettings_DEPRECATED: () => mockedSettings,
  getInitialSettings: () => mockedSettings,
}))

afterAll(() => {
  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
})

// Import the PRODUCTION module under test AFTER the mocks are registered.
const {
  stripTrailing1mTag,
  stripAll1mTags,
  pickerFamily,
  isFableModelValue,
  fableRowKey,
  modelRowsValueEqual,
  findMatchingOptionValue,
} = await import('../modelOptions.js')
const { resetModelStringsForTestingOnly } = await import(
  'src/bootstrap/state.js'
)

type Row = {
  value: string | null
  label: string
  description: string
}

function row(value: string | null): Row {
  return { value, label: '', description: '' }
}

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

beforeEach(() => {
  mockedSettings = {}
  for (const k of [
    'ANTHROPIC_DEFAULT_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_CUSTOM_MODEL_OPTION',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT',
    'CLAUDE_CODE_3P_PROBE_WROTE_OPUS_DEFAULT',
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
  resetModelStringsForTestingOnly()
})

describe('stripTrailing1mTag (official qt)', () => {
  test('strips one trailing [1m] tag', () => {
    expect(stripTrailing1mTag('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
  })

  test('strips only ONE trailing tag (doubled suffix keeps one)', () => {
    expect(stripTrailing1mTag('claude-opus-5-5[1m][1m]')).toBe(
      'claude-opus-5-5[1m]',
    )
  })

  test('leaves values without a trailing tag unchanged', () => {
    expect(stripTrailing1mTag('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(stripTrailing1mTag('claude-x[1m]y')).toBe('claude-x[1m]y')
  })

  test('is case-insensitive on the tag', () => {
    expect(stripTrailing1mTag('claude-opus-5-5[1M]')).toBe('claude-opus-5-5')
  })
})

describe('stripAll1mTags (official Xn)', () => {
  test('strips every [1m] tag, anywhere in the value', () => {
    expect(stripAll1mTags('a[1m]b[1m]')).toBe('ab')
    expect(stripAll1mTags('claude-opus-5-5[1m][1m]')).toBe('claude-opus-5-5')
  })

  test('is case-insensitive', () => {
    expect(stripAll1mTags('x[1M]y[1m]')).toBe('xy')
  })

  test('leaves untagged values unchanged', () => {
    expect(stripAll1mTags('claude-sonnet-5')).toBe('claude-sonnet-5')
  })
})

describe('pickerFamily (official Pc)', () => {
  test('classifies each family by case-insensitive substring', () => {
    expect(pickerFamily('claude-fable-5-1')).toBe('fable')
    expect(pickerFamily('claude-opus-5-5[1m]')).toBe('opus')
    expect(pickerFamily('sonnet')).toBe('sonnet')
    expect(pickerFamily('claude-haiku-4-5')).toBe('haiku')
    expect(pickerFamily('CLAUDE-OPUS-5')).toBe('opus')
  })

  test('checks fable before the other families (official branch order)', () => {
    expect(pickerFamily('opus-fable-hybrid')).toBe('fable')
  })

  test('returns null for custom (non-Claude) values', () => {
    expect(pickerFamily('qwen3.8-max')).toBeNull()
    expect(pickerFamily('gpt-4o')).toBeNull()
  })
})

describe('isFableModelValue (official fi)', () => {
  test('accepts the fable alias, its [1m] form, and concrete claude-fable-* ids', () => {
    expect(isFableModelValue('fable')).toBe(true)
    expect(isFableModelValue('fable[1m]')).toBe(true)
    expect(isFableModelValue('claude-fable-5')).toBe(true)
    expect(isFableModelValue('claude-fable-5-1')).toBe(true)
  })

  test('is case-SENSITIVE (official strict equality + substring)', () => {
    expect(isFableModelValue('FABLE')).toBe(false)
    expect(isFableModelValue('Claude-Fable-5')).toBe(false)
  })

  test('rejects non-fable values', () => {
    expect(isFableModelValue('claude-opus-5-5')).toBe(false)
    expect(isFableModelValue('qwen3.8-max')).toBe(false)
  })
})

describe('fableRowKey (official Rv)', () => {
  test('alias rows key on the resolved default fable model (clean env → claude-fable-5-1)', () => {
    expect(fableRowKey('fable')).toBe('claude-fable-5-1')
    expect(fableRowKey('fable[1m]')).toBe('claude-fable-5-1')
  })

  test('tracks ANTHROPIC_DEFAULT_FABLE_MODEL when it is a claude-fable-* id', () => {
    withEnv({ ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5' }, () => {
      expect(fableRowKey('fable')).toBe('claude-fable-5')
    })
  })

  test('falls back to the fable:* wildcard when the default is not fable-family', () => {
    withEnv({ ANTHROPIC_DEFAULT_FABLE_MODEL: 'qwen3.8-max' }, () => {
      expect(fableRowKey('fable')).toBe('fable:*')
      expect(fableRowKey('fable[1m]')).toBe('fable:*')
    })
  })

  test('concrete values key on the captured firstParty fable id', () => {
    expect(fableRowKey('claude-fable-5')).toBe('claude-fable-5')
    expect(fableRowKey('claude-fable-5-1')).toBe('claude-fable-5-1')
    // Provider-prefixed and version/date-suffixed forms still capture the id.
    expect(fableRowKey('us.anthropic.claude-fable-5')).toBe('claude-fable-5')
    expect(fableRowKey('claude-fable-5-1@20260101')).toBe('claude-fable-5-1')
    expect(fableRowKey('claude-fable-5-1[1m]')).toBe('claude-fable-5-1')
  })

  test('returns undefined for non-fable values', () => {
    expect(fableRowKey('claude-opus-5-5')).toBeUndefined()
    expect(fableRowKey('qwen3.8-max')).toBeUndefined()
  })
})

describe('modelRowsValueEqual (official zr)', () => {
  test('identical values match by the strict first arm', () => {
    expect(modelRowsValueEqual(row('sonnet'), row('sonnet'))).toBe(true)
    expect(modelRowsValueEqual(row(null), row(null))).toBe(true)
  })

  test('null vs string never matches', () => {
    expect(modelRowsValueEqual(row(null), row('sonnet'))).toBe(false)
  })

  test('fable alias matches the concrete default fable row via Rv keys', () => {
    expect(
      modelRowsValueEqual(row('fable'), row('claude-fable-5-1')),
    ).toBe(true)
  })

  test('wildcard default fable makes the alias match ANY concrete fable row', () => {
    withEnv({ ANTHROPIC_DEFAULT_FABLE_MODEL: 'qwen3.8-max' }, () => {
      expect(
        modelRowsValueEqual(row('fable'), row('claude-fable-5-1')),
      ).toBe(true)
    })
  })

  test('1M variants of a 1M-capable family are the same row (opus/sonnet merge)', () => {
    expect(modelRowsValueEqual(row('opus'), row('opus[1m]'))).toBe(true)
    expect(modelRowsValueEqual(row('sonnet'), row('sonnet[1m]'))).toBe(true)
  })

  test('1M variant of a non-1M family is a DIFFERENT row (haiku)', () => {
    // Parsed bases are equal, has1mContext differs, and haiku does not
    // support 1M → official zr returns false.
    expect(modelRowsValueEqual(row('haiku'), row('haiku[1m]'))).toBe(false)
  })

  test('different families never match', () => {
    expect(modelRowsValueEqual(row('opus'), row('sonnet'))).toBe(false)
    expect(modelRowsValueEqual(row('opus'), row('claude-fable-5-1'))).toBe(
      false,
    )
  })

  test('custom value matches the alias row it resolves to (A/B tail-row case)', () => {
    // A/B env shape: ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3.8-max makes the
    // 'opus' row parse to the custom value, so the official tail zr probe
    // matches and no duplicate "Custom model" row is appended.
    withEnv({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-max' }, () => {
      expect(
        modelRowsValueEqual(row('opus'), row('qwen3.8-max')),
      ).toBe(true)
      // ...but a [1m]-tagged custom value stays distinct (no 1M support).
      expect(
        modelRowsValueEqual(row('opus'), row('qwen3.8-max[1m]')),
      ).toBe(false)
    })
  })

  test('unrelated custom values do not match', () => {
    expect(modelRowsValueEqual(row('opus'), row('gpt-4o'))).toBe(false)
    expect(
      modelRowsValueEqual(row('qwen3.8-max'), row('gpt-4o')),
    ).toBe(false)
  })
})

describe('findMatchingOptionValue (official F5t)', () => {
  const options = [row('sonnet'), row('opus'), row('claude-fable-5-1'), row('haiku')]

  test('strict value match wins first and returns the value itself', () => {
    expect(findMatchingOptionValue(options, 'opus')).toBe('opus')
    expect(findMatchingOptionValue(options, 'claude-fable-5-1')).toBe(
      'claude-fable-5-1',
    )
  })

  test('falls back to the zr family-aware probe (alias → 1M variant row)', () => {
    // No 'opus[1m]' row exists, but zr matches it to the 'opus' row.
    expect(findMatchingOptionValue(options, 'opus[1m]')).toBe('opus')
  })

  test('matches a concrete fable id to the alias-resolved fable row family', () => {
    withEnv({ ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5' }, () => {
      // Options list carries the concrete default; a stale 'fable' setting
      // resolves onto it via the shared Rv key.
      const fableOptions = [row('sonnet'), row('claude-fable-5')]
      expect(findMatchingOptionValue(fableOptions, 'fable')).toBe(
        'claude-fable-5',
      )
    })
  })

  test('matches a custom value onto the alias row it resolves to (A/B picker focus case)', () => {
    withEnv({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-max' }, () => {
      expect(findMatchingOptionValue(options, 'qwen3.8-max')).toBe('opus')
    })
  })

  test('returns undefined when no row matches', () => {
    expect(findMatchingOptionValue(options, 'gpt-4o')).toBeUndefined()
  })

  test('returns undefined for an empty options list', () => {
    expect(findMatchingOptionValue([], 'sonnet')).toBeUndefined()
  })
})
