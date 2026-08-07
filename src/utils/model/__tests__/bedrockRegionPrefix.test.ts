import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * Gap-65-C (CC 2.1.224): the Bedrock region-prefix subsystem.
 *
 * Official 2.1.224 added ANTHROPIC_BEDROCK_REGION_PREFIX plus the jp/au/
 * us-gov cross-region prefixes. Byte-verified binary functions ported here:
 * - `hsr` — 7-entry prefix list (us/eu/apac/jp/au/us-gov/global)
 * - `cdc` — 6-entry env-var value enum (us/eu/apac/jp/au/global — no us-gov)
 * - `Upt` — deriveBedrockRegionPrefixFromRegion (region → prefix)
 * - `eur` — getEffectiveBedrockRegionPrefix (us-gov region wins over env,
 *           then env override, then derivation)
 * - `Fpt` — findFirstMatch with preferred-prefix preference
 * - `Koy` — getBedrockModelStrings flow (prefix-applied hardcoded fallback,
 *           three byte-verbatim diagnostics)
 * - `TUe` — getModelStrings interim path also carries the effective prefix
 */

// Mutable profile source — the mock.module factory below wires this into
// modelStrings.js's getBedrockInferenceProfiles import.
const profilesMock = mock(async (): Promise<string[]> => [])

// Load the REAL bedrock.js first: mock.module replaces the module in the
// registry, and a factory that spreads a never-loaded module gets an empty
// namespace. Spreading the loaded module keeps every other export (the pure
// functions under test) intact while swapping the profile fetch.
const realBedrock = require('../bedrock.js')

// Register the mock BEFORE requiring modelStrings.js so it sees the mocked
// inference-profile fetch.
mock.module('../bedrock.js', () => ({
  ...realBedrock,
  getBedrockInferenceProfiles: profilesMock,
}))

const {
  BEDROCK_REGION_PREFIX_ENV_VALUES,
  applyBedrockRegionPrefix,
  deriveBedrockRegionPrefixFromRegion,
  findFirstMatch,
  getBedrockRegionPrefix,
  getEffectiveBedrockRegionPrefix,
} = require('../bedrock.js') as typeof import('../bedrock.js')

const ENV_KEYS = [
  'ANTHROPIC_BEDROCK_REGION_PREFIX',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'CLAUDE_CODE_USE_BEDROCK',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test'
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ---------------------------------------------------------------------------
// deriveBedrockRegionPrefixFromRegion (CC 2.1.224 Upt)
// ---------------------------------------------------------------------------

describe('deriveBedrockRegionPrefixFromRegion (CC 2.1.224 Upt)', () => {
  test('maps AWS region prefixes to inference-profile prefixes', () => {
    expect(deriveBedrockRegionPrefixFromRegion('us-east-1')).toBe('us')
    expect(deriveBedrockRegionPrefixFromRegion('eu-west-1')).toBe('eu')
    expect(deriveBedrockRegionPrefixFromRegion('ap-northeast-1')).toBe('apac')
    expect(deriveBedrockRegionPrefixFromRegion('us-gov-west-1')).toBe('us-gov')
  })

  test('regions that match no known partition derive to global', () => {
    expect(deriveBedrockRegionPrefixFromRegion('sa-east-1')).toBe('global')
    expect(deriveBedrockRegionPrefixFromRegion('me-central-1')).toBe('global')
  })

  test('undefined region derives to global', () => {
    expect(deriveBedrockRegionPrefixFromRegion(undefined)).toBe('global')
  })

  test('us-gov check runs before the us check', () => {
    // Both start with "us" — order matters (official checks us-gov- first)
    expect(deriveBedrockRegionPrefixFromRegion('us-gov-east-1')).toBe('us-gov')
  })
})

// ---------------------------------------------------------------------------
// getEffectiveBedrockRegionPrefix (CC 2.1.224 eur)
// ---------------------------------------------------------------------------

describe('getEffectiveBedrockRegionPrefix (CC 2.1.224 eur)', () => {
  test('env override wins over the region-derived prefix', () => {
    process.env.ANTHROPIC_BEDROCK_REGION_PREFIX = 'eu'
    expect(getEffectiveBedrockRegionPrefix('us-east-1')).toBe('eu')
  })

  test('us-gov region ALWAYS yields us-gov, even with an env override', () => {
    // eur checks the region for us-gov- BEFORE reading the env var
    process.env.ANTHROPIC_BEDROCK_REGION_PREFIX = 'eu'
    expect(getEffectiveBedrockRegionPrefix('us-gov-west-1')).toBe('us-gov')
  })

  test('unset env falls back to region derivation', () => {
    delete process.env.ANTHROPIC_BEDROCK_REGION_PREFIX
    expect(getEffectiveBedrockRegionPrefix('eu-central-1')).toBe('eu')
    expect(getEffectiveBedrockRegionPrefix('us-west-2')).toBe('us')
  })

  test('an env value outside the 6-value enum is treated as unset', () => {
    // Official zod-validates against cdc at startup (invalid → unset).
    // OCC validates here; observable behavior must match.
    process.env.ANTHROPIC_BEDROCK_REGION_PREFIX = 'us-gov' // NOT in cdc
    expect(getEffectiveBedrockRegionPrefix('us-east-1')).toBe('us')
    process.env.ANTHROPIC_BEDROCK_REGION_PREFIX = 'garbage'
    expect(getEffectiveBedrockRegionPrefix('ap-south-1')).toBe('apac')
  })

  test('the env enum excludes us-gov but covers the other six hsr entries', () => {
    expect([...BEDROCK_REGION_PREFIX_ENV_VALUES]).toEqual([
      'us',
      'eu',
      'apac',
      'jp',
      'au',
      'global',
    ])
  })
})

// ---------------------------------------------------------------------------
// getBedrockRegionPrefix / applyBedrockRegionPrefix with the 7-entry list
// ---------------------------------------------------------------------------

describe('region prefix recognition (CC 2.1.224 hsr)', () => {
  test('recognizes jp, au, and us-gov prefixed profiles', () => {
    expect(getBedrockRegionPrefix('jp.anthropic.claude-opus-4-6-v1')).toBe(
      'jp',
    )
    expect(
      getBedrockRegionPrefix('au.anthropic.claude-sonnet-4-5-20250929-v1:0'),
    ).toBe('au')
    expect(
      getBedrockRegionPrefix('us-gov.anthropic.claude-sonnet-4-6-v1'),
    ).toBe('us-gov')
  })

  test('still recognizes us, eu, apac, global', () => {
    expect(getBedrockRegionPrefix('us.anthropic.claude-opus-4-6-v1')).toBe(
      'us',
    )
    expect(getBedrockRegionPrefix('eu.anthropic.claude-opus-4-6-v1')).toBe(
      'eu',
    )
    expect(getBedrockRegionPrefix('apac.anthropic.claude-opus-4-6-v1')).toBe(
      'apac',
    )
    expect(getBedrockRegionPrefix('global.anthropic.claude-opus-4-6-v1')).toBe(
      'global',
    )
  })

  test('us-gov. does not get swallowed by the us. entry (order check)', () => {
    // 'us-gov.anthropic.x' starts with "us" but the loop matches on
    // `${prefix}.anthropic.` — 'us-gov.' must win, not 'us.'
    const prefix = getBedrockRegionPrefix('us-gov.anthropic.claude-x-v1')
    expect(prefix).toBe('us-gov')
    expect(applyBedrockRegionPrefix('us-gov.anthropic.claude-x-v1', 'eu')).toBe(
      'eu.anthropic.claude-x-v1',
    )
  })
})

// ---------------------------------------------------------------------------
// findFirstMatch (CC 2.1.224 Fpt)
// ---------------------------------------------------------------------------

describe('findFirstMatch (CC 2.1.224 Fpt)', () => {
  const profiles = [
    'us.anthropic.claude-opus-4-6-v1',
    'eu.anthropic.claude-opus-4-6-v1',
    'anthropic.claude-sonnet-4-5-20250929-v1:0',
  ]

  test('prefers a profile carrying the preferred prefix', () => {
    expect(findFirstMatch(profiles, 'claude-opus-4-6', 'eu')).toBe(
      'eu.anthropic.claude-opus-4-6-v1',
    )
    expect(findFirstMatch(profiles, 'claude-opus-4-6', 'us')).toBe(
      'us.anthropic.claude-opus-4-6-v1',
    )
  })

  test('falls back to a plain substring match when no preferred-prefix profile exists', () => {
    expect(findFirstMatch(profiles, 'claude-opus-4-6', 'jp')).toBe(
      'us.anthropic.claude-opus-4-6-v1',
    )
  })

  test('without a preferred prefix behaves like the pre-224 search', () => {
    expect(findFirstMatch(profiles, 'claude-opus-4-6')).toBe(
      'us.anthropic.claude-opus-4-6-v1',
    )
  })

  test('returns null when nothing matches', () => {
    expect(findFirstMatch(profiles, 'claude-does-not-exist', 'eu')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getBedrockModelStrings flow (CC 2.1.224 Koy) — via ensureModelStringsInitialized
// ---------------------------------------------------------------------------

const { ensureModelStringsInitialized, getModelStrings } = require('../modelStrings.js') as typeof import('../modelStrings.js')
const {
  getModelStrings: getModelStringsState,
  resetStateForTests,
} = require('../../../bootstrap/state.js') as {
  getModelStrings: () => Record<string, string> | null
  resetStateForTests: () => void
}
const { CANONICAL_ID_TO_KEY } = require('../configs.js') as typeof import('../configs.js')

const OPUS_KEY = CANONICAL_ID_TO_KEY['claude-opus-4-6']
const SONNET_KEY = CANONICAL_ID_TO_KEY['claude-sonnet-4-5-20250929']

describe('getBedrockModelStrings (CC 2.1.224 Koy)', () => {
  beforeEach(async () => {
    if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    delete process.env.AWS_REGION
    delete process.env.AWS_DEFAULT_REGION

    // Drain any Bedrock fetch still pending in the shared sequential queue
    // from an earlier test file: model-defaults-207 fires
    // `void updateBedrockModelStrings()` (real fetch, no credentials, ~2s)
    // and its resolution would otherwise pollute STATE.modelStrings mid-test
    // here. With env unset this resolves to the builtin us.* strings, which
    // we then discard.
    await ensureModelStringsInitialized()
    resetStateForTests()
    profilesMock.mockClear()
  })

  test('profile lookup prefers the effective prefix; plain match is the fallback', async () => {
    // Arrange — env override eu on a us-east-1 account; profiles exist for
    // opus only in us.* and for sonnet only in eu.*
    process.env.ANTHROPIC_BEDROCK_REGION_PREFIX = 'eu'
    profilesMock.mockResolvedValueOnce([
      'us.anthropic.claude-opus-4-6-v1',
      'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    ])

    // Act
    await ensureModelStringsInitialized()
    const ms = getModelStringsState()!

    // Assert — sonnet got the eu-preferred profile; opus fell back to the
    // only matching profile (us.*), exactly the Fpt semantics
    expect(ms[SONNET_KEY]).toBe('eu.anthropic.claude-sonnet-4-5-20250929-v1:0')
    expect(ms[OPUS_KEY]).toBe('us.anthropic.claude-opus-4-6-v1')
  })

  test('failed profile fetch falls back to hardcoded models WITH the effective prefix applied', async () => {
    // Arrange — KZr applies the effective prefix to the hardcoded strings
    // BEFORE the fetch; on fetch failure those prefixed strings are returned
    process.env.ANTHROPIC_BEDROCK_REGION_PREFIX = 'eu'
    profilesMock.mockRejectedValueOnce(new Error('no credentials'))

    // Act
    await ensureModelStringsInitialized()
    const ms = getModelStringsState()!

    // Assert — builtin bedrock opus is us.anthropic.claude-opus-4-6-v1;
    // the eu effective prefix replaces the us. prefix
    expect(ms[OPUS_KEY]).toBe('eu.anthropic.claude-opus-4-6-v1')
  })

  test('no env override + us-east-1 keeps the builtin us.* strings when no profiles exist', async () => {
    // Arrange — effective == derived == 'us'; empty profile list
    delete process.env.ANTHROPIC_BEDROCK_REGION_PREFIX
    profilesMock.mockResolvedValueOnce([])

    // Act
    await ensureModelStringsInitialized()
    const ms = getModelStringsState()!

    // Assert
    expect(ms[OPUS_KEY]).toBe('us.anthropic.claude-opus-4-6-v1')
  })

  test('interim getModelStrings (fetch in flight) already carries the effective prefix (CC 2.1.224 TUe)', async () => {
    // Arrange — a fetch that never settles until we release it
    let releaseFetch!: (profiles: string[]) => void
    profilesMock.mockImplementationOnce(
      () =>
        new Promise<string[]>(resolve => {
          releaseFetch = resolve
        }),
    )
    process.env.ANTHROPIC_BEDROCK_REGION_PREFIX = 'eu'

    // Act — getModelStrings while the background fetch is still pending
    const interim = getModelStrings()

    // Assert — interim defaults are prefix-applied, not raw builtin strings
    expect(interim[OPUS_KEY]).toBe('eu.anthropic.claude-opus-4-6-v1')

    // Release the pending fetch so the sequential queue drains for later tests
    releaseFetch([])
    await ensureModelStringsInitialized()
  })
})
