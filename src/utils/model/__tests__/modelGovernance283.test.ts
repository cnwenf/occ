import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// Hermetic for credential-less environments (CI runners) — same seed as
// anthropicDefaultModel236.test.ts.
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * CC 2.1.283 managed model governance enforcement — official `qhe` (deny
 * oracle), `Iqn` (fail-closed), `xO`/`PO`/`p_` (exact matching inside `Vr`),
 * `__`/`h_`/`TH` (exact-block + messages), and the Default step-down.
 *
 * Settings are mocked per the OCC convention (anthropicDefaultModel236):
 * snapshot the real module BEFORE mock.module, restore in afterAll.
 */
const actualSettingsModule = await import('../../settings/settings.js')
const actualSettingsExports = { ...actualSettingsModule }

let mockedPolicy: Record<string, unknown> | null = null
let mockedMerged: Record<string, unknown> = {}
let settingsThrow = false

mock.module('../../settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettings_DEPRECATED: () => {
    if (settingsThrow) throw new Error('settings unreadable')
    return mockedMerged
  },
  getInitialSettings: () => mockedMerged,
  getSettingsForSource: (source: string) => {
    if (settingsThrow) throw new Error('settings unreadable')
    return source === 'policySettings' ? mockedPolicy : null
  },
  getEnforceAvailableModels: () => Boolean(mockedMerged.enforceAvailableModels),
}))

afterAll(() => {
  mock.module('../../settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
})

/**
 * Heal the OCC-97 leak class BEFORE importing the modules under test:
 * validateModel281.test.ts registers `mock.module('../modelAllowlist.js',
 * { isModelAllowed: () => true })` at its top level, Bun may load that file
 * before this one regardless of runner order, and neither its afterAll
 * `mock.restore()` nor a re-registration in afterAll undoes the leak in time
 * (module top-levels all run before any test body). A `?query` specifier
 * forces a fresh evaluation of the REAL modelAllowlist — which binds the
 * settings mock installed above — and re-registering the plain path points
 * every later import (and, via Bun's in-place namespace patching, every
 * already-loaded importer such as model.js) back at the real exports.
 * The specifier is built at runtime so tsc does not try to resolve the
 * `?query` cache-buster as a module name.
 */
const allowlistHealSpecifier = `../modelAllowlist.js?${'gov283heal'}`
const freshModelAllowlist = (await import(
  allowlistHealSpecifier
)) as typeof import('../modelAllowlist.js')
mock.module('../modelAllowlist.js', () => ({ ...freshModelAllowlist }))

const {
  getPolicyDeniedGovernance,
  hasDeniedModelsPolicy,
  isExactAvailableModelsMatch,
  isModelDeniedByPolicy,
  resetDeniedEntriesMemoForTest,
} = await import('../modelGovernance.js')
const {
  enforceManagedModelGovernanceStartupGate,
  getManagedModelGovernanceBlockMessage,
  isBlockedByExactAvailableModels,
  isModelBlockedByGovernance,
} = await import('../modelGovernanceMessages.js')
const { isModelAllowed } = await import('../modelAllowlist.js')
const { getEnforcedDefaultModel, getDefaultMainLoopModel } = await import('../model.js')
const {
  availableModelsExactEntryWarnings,
  collectManagedModelGovernanceWarnings,
  deniedModelsEntryWarnings,
} = await import('../modelGovernanceWarnings.js')

beforeEach(() => {
  mockedPolicy = null
  mockedMerged = {}
  settingsThrow = false
  resetDeniedEntriesMemoForTest()
})

describe('2.1.283 getPolicyDeniedGovernance session-level parse cache (official TO "cached")', () => {
  test('same deniedModels array identity reuses the parsed entries (no re-parse)', () => {
    const denied = ['claude-opus-5-5', 'opus']
    mockedPolicy = { deniedModels: denied }
    const first = getPolicyDeniedGovernance()
    const second = getPolicyDeniedGovernance()
    // Memoized: the entries array is the identical object, not a fresh parse.
    expect(second.entries).toBe(first.entries)
    expect(first.entries.length).toBe(2)
  })

  test('a settings reload (new array identity) re-parses', () => {
    mockedPolicy = { deniedModels: ['claude-opus-5-5'] }
    const first = getPolicyDeniedGovernance()
    mockedPolicy = { deniedModels: ['claude-opus-5-5', 'claude-sonnet-5'] }
    const second = getPolicyDeniedGovernance()
    expect(second.entries).not.toBe(first.entries)
    expect(second.entries.length).toBe(2)
  })

  test('cached and uncached paths agree on the deny oracle', () => {
    mockedPolicy = { deniedModels: ['claude-opus-5-5'] }
    expect(isModelDeniedByPolicy('claude-opus-5-5')).toBe(true)
    expect(isModelDeniedByPolicy('claude-opus-5-5')).toBe(true)
    expect(isModelDeniedByPolicy('claude-sonnet-5')).toBe(false)
  })
})

describe('2.1.283 isModelDeniedByPolicy (official qhe)', () => {
  test('a model ID blocks that version in every spelling', () => {
    mockedPolicy = { deniedModels: ['claude-opus-5-5'] }
    expect(isModelDeniedByPolicy('claude-opus-5-5')).toBe(true)
    expect(isModelDeniedByPolicy('claude-opus-5-5-fast')).toBe(true)
    expect(isModelDeniedByPolicy('claude-opus-5-5-20260101')).toBe(true)
    expect(isModelDeniedByPolicy('us.anthropic.claude-opus-5-5')).toBe(true)
    expect(isModelDeniedByPolicy('claude-opus-5-5[1m]')).toBe(true)
    // Sibling versions are NOT blocked.
    expect(isModelDeniedByPolicy('claude-opus-5')).toBe(false)
    expect(isModelDeniedByPolicy('claude-opus-5-6')).toBe(false)
    expect(isModelDeniedByPolicy('claude-sonnet-4-5')).toBe(false)
  })

  test('a no-minor ID also blocks later minors', () => {
    mockedPolicy = { deniedModels: ['claude-opus-5'] }
    expect(isModelDeniedByPolicy('claude-opus-5')).toBe(true)
    expect(isModelDeniedByPolicy('claude-opus-5-5')).toBe(true)
    expect(isModelDeniedByPolicy('claude-opus-5-9-fast')).toBe(true)
    expect(isModelDeniedByPolicy('claude-opus-6')).toBe(false)
  })

  test('a family alias blocks the whole family', () => {
    mockedPolicy = { deniedModels: ['opus'] }
    expect(isModelDeniedByPolicy('claude-opus-4-5')).toBe(true)
    expect(isModelDeniedByPolicy('claude-opus-5-5')).toBe(true)
    expect(isModelDeniedByPolicy('claude-sonnet-5')).toBe(false)
    expect(isModelDeniedByPolicy('claude-haiku-4-5')).toBe(false)
  })

  test('release-dependent aliases are ignored (block nothing)', () => {
    mockedPolicy = { deniedModels: ['best', 'opusplan', 'default'] }
    expect(isModelDeniedByPolicy('claude-opus-5-5')).toBe(false)
    expect(isModelDeniedByPolicy('claude-sonnet-5')).toBe(false)
  })

  test('literal entries block only the exact name', () => {
    mockedPolicy = { deniedModels: ['my-custom-model'] }
    expect(isModelDeniedByPolicy('my-custom-model')).toBe(true)
    expect(isModelDeniedByPolicy('my-custom-model-v2')).toBe(false)
  })

  test('no policy / empty list denies nothing', () => {
    expect(isModelDeniedByPolicy('claude-opus-5-5')).toBe(false)
    mockedPolicy = { deniedModels: [] }
    expect(isModelDeniedByPolicy('claude-opus-5-5')).toBe(false)
    expect(hasDeniedModelsPolicy()).toBe(false)
  })

  test('hasDeniedModelsPolicy reports effective entries only', () => {
    mockedPolicy = { deniedModels: ['best'] } // all ignored
    expect(hasDeniedModelsPolicy()).toBe(false)
    mockedPolicy = { deniedModels: ['opus'] }
    expect(hasDeniedModelsPolicy()).toBe(true)
  })

  test('fail-CLOSED: an unreadable policy read reports "denied policy present"', () => {
    settingsThrow = true
    // Official Iqn catch → true; the Vr prologue catch → blocks.
    expect(hasDeniedModelsPolicy()).toBe(true)
    expect(isModelAllowed('claude-opus-5-5')).toBe(false)
  })
})

describe('2.1.283 denied beats allowed (official Vr prologue)', () => {
  test('a denied model is blocked even when availableModels allows it', () => {
    mockedMerged = { availableModels: ['claude-opus-5-5', 'claude-sonnet-5'] }
    mockedPolicy = {
      availableModels: ['claude-opus-5-5', 'claude-sonnet-5'],
      deniedModels: ['claude-opus-5-5'],
    }
    expect(isModelAllowed('claude-opus-5-5')).toBe(false)
    expect(isModelAllowed('claude-sonnet-5')).toBe(true)
  })

  test('a denied family beats a family allowlist entry', () => {
    mockedMerged = { availableModels: ['opus', 'claude-sonnet-5'] }
    mockedPolicy = { deniedModels: ['opus'] }
    expect(isModelAllowed('claude-opus-5-5')).toBe(false)
    expect(isModelAllowed('claude-sonnet-5')).toBe(true)
  })

  test('with no availableModels at all, deniedModels still blocks', () => {
    mockedPolicy = { deniedModels: ['claude-opus-5-5'] }
    expect(isModelAllowed('claude-opus-5-5')).toBe(false)
    expect(isModelAllowed('claude-sonnet-5')).toBe(true)
  })
})

describe('2.1.283 availableModelsMatch exact (official xO + Vr exact tiers)', () => {
  test('prefix (default): an entry also allows extending IDs', () => {
    mockedMerged = { availableModels: ['claude-opus-5'] }
    expect(isExactAvailableModelsMatch()).toBe(false)
    expect(isModelAllowed('claude-opus-5')).toBe(true)
    expect(isModelAllowed('claude-opus-5-5')).toBe(true)
    expect(isModelAllowed('claude-opus-5-20260101')).toBe(true)
  })

  test('exact: a model ID entry stops allowing other versions', () => {
    mockedMerged = { availableModels: ['claude-opus-5'] }
    mockedPolicy = {
      availableModels: ['claude-opus-5'],
      availableModelsMatch: 'exact',
    }
    expect(isExactAvailableModelsMatch()).toBe(true)
    expect(isModelAllowed('claude-opus-5')).toBe(true)
    expect(isModelAllowed('claude-opus-5-20260101')).toBe(true)
    expect(isModelAllowed('claude-opus-5-fast')).toBe(true)
    expect(isModelAllowed('claude-opus-5-5')).toBe(false)
    expect(isModelAllowed('claude-opus-6')).toBe(false)
  })

  test('exact: a -latest ID needs a -latest entry', () => {
    mockedMerged = { availableModels: ['claude-opus-5-5'] }
    mockedPolicy = {
      availableModels: ['claude-opus-5-5'],
      availableModelsMatch: 'exact',
    }
    expect(isModelAllowed('claude-opus-5-5-latest')).toBe(false)
    mockedMerged = { availableModels: ['claude-opus-5-5-latest'] }
    mockedPolicy = {
      availableModels: ['claude-opus-5-5-latest'],
      availableModelsMatch: 'exact',
    }
    expect(isModelAllowed('claude-opus-5-5-latest')).toBe(true)
    expect(isModelAllowed('claude-opus-5-5')).toBe(false)
  })

  test('exact: family aliases still allow the whole family', () => {
    mockedMerged = { availableModels: ['opus'] }
    mockedPolicy = { availableModels: ['opus'], availableModelsMatch: 'exact' }
    expect(isModelAllowed('claude-opus-5-5')).toBe(true)
    expect(isModelAllowed('claude-opus-99-1')).toBe(true)
    expect(isModelAllowed('claude-sonnet-5')).toBe(false)
  })

  test('exact: an all-ignored list blocks every model', () => {
    mockedMerged = { availableModels: ['best', 'default'] }
    mockedPolicy = {
      availableModels: ['best', 'default'],
      availableModelsMatch: 'exact',
    }
    expect(isModelAllowed('claude-opus-5-5')).toBe(false)
    expect(isModelAllowed('claude-sonnet-5')).toBe(false)
  })
})

describe('2.1.283 isBlockedByExactAvailableModels / isModelBlockedByGovernance (official __ / h_)', () => {
  test('false unless the policy requests exact matching', () => {
    mockedPolicy = { availableModels: ['claude-opus-5'] }
    expect(isBlockedByExactAvailableModels('claude-opus-5-5')).toBe(false)
  })

  test('false when the exact list names no real model', () => {
    mockedPolicy = { availableModels: ['best'], availableModelsMatch: 'exact' }
    expect(isBlockedByExactAvailableModels('claude-opus-5-5')).toBe(false)
  })

  test('true for a model the exact list does not allow', () => {
    mockedPolicy = { availableModels: ['claude-opus-5'], availableModelsMatch: 'exact' }
    expect(isBlockedByExactAvailableModels('claude-opus-5-5')).toBe(true)
    expect(isBlockedByExactAvailableModels('claude-opus-5')).toBe(false)
  })

  test('h_ = denied OR exact-blocked', () => {
    mockedPolicy = { deniedModels: ['claude-sonnet-5'] }
    expect(isModelBlockedByGovernance('claude-sonnet-5')).toBe(true)
    expect(isModelBlockedByGovernance('claude-opus-5-5')).toBe(false)
    mockedPolicy = { availableModels: ['claude-opus-5'], availableModelsMatch: 'exact' }
    expect(isModelBlockedByGovernance('claude-opus-5-5')).toBe(true)
  })
})

describe('2.1.283 getManagedModelGovernanceBlockMessage (official TH)', () => {
  test('null when the model is not governance-blocked', () => {
    mockedPolicy = { deniedModels: ['claude-opus-5-5'] }
    expect(getManagedModelGovernanceBlockMessage('claude-sonnet-5')).toBeNull()
    expect(getManagedModelGovernanceBlockMessage('claude-sonnet-5', 'switch')).toBeNull()
  })

  test('denied default: byte-exact start and switch messages', () => {
    // Pins re-extracted byte-exact from the official 2.1.283 ELF
    // (md5 b5afa8208e39db13e13e89449b1825f2, TH @198791411) for the OCC-98
    // acceptance fix: BOTH branches share the `, and none of the models…`
    // tail; the switch branch has NO stray `}` after `"deniedModels"` (the
    // earlier pin copied the minified nested-template close as literal text).
    mockedPolicy = { deniedModels: ['claude-opus-5-5'] }
    expect(getManagedModelGovernanceBlockMessage('claude-opus-5-5', 'start')).toBe(
      `Claude Code can't start: your organization's managed settings block the default model (claude-opus-5-5) in "deniedModels", and none of the models they allow can be used as the default instead. Ask your administrator to update "deniedModels" or "availableModels".`,
    )
    expect(getManagedModelGovernanceBlockMessage('claude-opus-5-5', 'switch')).toBe(
      `Can't switch to the default model: your organization's managed settings block it (claude-opus-5-5) in "deniedModels", and none of the models they allow can be used as the default instead. Ask your administrator to update "deniedModels" or "availableModels".`,
    )
  })

  test('exact-allowlist default: byte-exact start and switch messages', () => {
    mockedPolicy = { availableModels: ['claude-opus-5'], availableModelsMatch: 'exact' }
    expect(getManagedModelGovernanceBlockMessage('claude-opus-5-5', 'start')).toBe(
      `Claude Code can't start: your organization allows only the models listed in "availableModels", and none of them can be used as the default model (claude-opus-5-5 isn't listed). Ask your administrator to update "availableModels".`,
    )
    expect(getManagedModelGovernanceBlockMessage('claude-opus-5-5', 'switch')).toBe(
      `Can't switch to the default model: your organization allows only the models listed in "availableModels", and none of them can be used as the default model (claude-opus-5-5 isn't listed). Ask your administrator to update "availableModels".`,
    )
  })

  test('unreadable managed settings: null at start, retry message on switch', () => {
    settingsThrow = true
    expect(getManagedModelGovernanceBlockMessage('claude-opus-5-5', 'start')).toBeNull()
    expect(getManagedModelGovernanceBlockMessage('claude-opus-5-5', 'switch')).toBe(
      "Can't switch to the default model: Claude Code couldn't read your organization's managed settings to check which models they allow. Restart Claude Code; if this keeps happening, ask your administrator to check the managed settings.",
    )
  })

  test('the model name is sanitized for the message (official ub)', () => {
    mockedPolicy = { deniedModels: ['my model'] }
    // Literal deny entry matches the raw name; ub strips the space.
    expect(getManagedModelGovernanceBlockMessage('my model', 'start')).toBe(
      `Claude Code can't start: your organization's managed settings block the default model (mymodel) in "deniedModels", and none of the models they allow can be used as the default instead. Ask your administrator to update "deniedModels" or "availableModels".`,
    )
  })
})

describe('2.1.283 Default step-down past denied models (official ZO path via getEnforcedDefaultModel)', () => {
  test('steps to the first allowed entry when the first is denied', () => {
    mockedMerged = {
      enforceAvailableModels: true,
      availableModels: ['claude-opus-5-5', 'claude-sonnet-5'],
    }
    mockedPolicy = { deniedModels: ['claude-opus-5-5'] }
    expect(getEnforcedDefaultModel('claude-opus-5-5')).toBe('claude-sonnet-5')
  })

  test('steps down under exact matching too', () => {
    mockedMerged = {
      enforceAvailableModels: true,
      availableModels: ['claude-opus-5', 'claude-sonnet-5'],
    }
    mockedPolicy = {
      availableModels: ['claude-opus-5', 'claude-sonnet-5'],
      availableModelsMatch: 'exact',
      deniedModels: ['claude-opus-5'],
    }
    expect(getEnforcedDefaultModel('claude-opus-5')).toBe('claude-sonnet-5')
  })
})

describe('2.1.283 governance warning collectors (official z5n / V5n / Xi)', () => {
  test('deniedModelsEntryWarnings: one warning per flagged entry, deny order kept', () => {
    const warnings = deniedModelsEntryWarnings({
      deniedModels: ['best', 'claude-opus-5-5', '', 'opus'],
    })
    expect(warnings).toEqual([
      {
        file: 'managed settings',
        path: 'deniedModels',
        message:
          '"best" was ignored: it names a different model depending on the release and settings. Name the model instead, for example "claude-opus-5-5".',
        severity: 'warning',
        statusOnly: true,
      },
      {
        file: 'managed settings',
        path: 'deniedModels',
        message: 'An empty deniedModels entry was ignored.',
        severity: 'warning',
        statusOnly: true,
      },
    ])
  })

  test('availableModelsExactEntryWarnings: only under exact matching', () => {
    expect(
      availableModelsExactEntryWarnings({ availableModels: ['best'] }),
    ).toEqual([])
    const warnings = availableModelsExactEntryWarnings({
      availableModelsMatch: 'exact',
      availableModels: ['best', 'claude-opus-5.5'],
    })
    // Plain literals stay silent (official Yh bare return); the dotted
    // version literal gets the hyphen hint.
    expect(warnings.map(w => w.path)).toEqual(['availableModels', 'availableModels'])
    expect(warnings[0]!.message).toContain('was ignored, because "availableModelsMatch" is "exact"')
    expect(warnings[1]!.message).toBe(
      '"claude-opus-5.5" in availableModels allows only a model named exactly "claude-opus-5.5". To allow a version, write it with a hyphen: "claude-opus-5-5".',
    )
  })

  test('a bare family alias warns alone but is quiet when narrowed', () => {
    const alone = availableModelsExactEntryWarnings({
      availableModelsMatch: 'exact',
      availableModels: ['opus'],
    })
    expect(alone).toHaveLength(1)
    expect(alone[0]!.message).toContain('allows every Opus model, including future releases')
    const narrowed = availableModelsExactEntryWarnings({
      availableModelsMatch: 'exact',
      availableModels: ['opus', 'claude-opus-4-5'],
    })
    expect(narrowed).toEqual([])
  })

  test('collectManagedModelGovernanceWarnings merges deny warnings first', () => {
    const warnings = collectManagedModelGovernanceWarnings({
      availableModelsMatch: 'exact',
      availableModels: ['best'],
      deniedModels: ['opusplan'],
    })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]!.path).toBe('deniedModels')
    expect(warnings[1]!.path).toBe('availableModels')
  })

  test('null/undefined policy yields no warnings', () => {
    expect(collectManagedModelGovernanceWarnings(null)).toEqual([])
    expect(collectManagedModelGovernanceWarnings(undefined)).toEqual([])
  })
})

/**
 * OCC-98 acceptance #10 (P2) reproducer — the confirmed HIGH fail-open:
 * a deny-only policy (`deniedModels`, no `availableModels` /
 * `enforceAvailableModels`) plus ZERO user model config resolved the tier
 * default through `enforceDefaultModelAllowlist`'s
 * `if (!getEnforceAvailableModels()) return setting` first line without ever
 * consulting the deny oracle. The fix wires the official 2.1.283 startup gate
 * (`Bn=TH(je)` @212235442 → hx red-stderr print + $i exit(1)) as
 * `enforceManagedModelGovernanceStartupGate`, called from src/main.tsx on the
 * resolved initial model. These tests assert the gate closes the default
 * path: deny-only + zero config MUST exit(1) with the official start message
 * (not silently pass), and a non-matching deny policy MUST NOT.
 */
describe('2.1.283 startup gate — deny-only default-path closure (OCC-98 #10 reproducer)', () => {
  // Hermetic against the RUNNER's own env: this repo's CI hosts and dev
  // machines export model overrides (e.g. ANTHROPIC_DEFAULT_OPUS_MODEL) and
  // provider switches that would rewrite the tier default away from the
  // canonical Claude model the deny entries name.
  const ENV_KEYS = [
    'ANTHROPIC_DEFAULT_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_MODEL',
    'USER_TYPE',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_MANTLE',
    'CLAUDE_CODE_USE_VERTEX',
  ] as const
  let savedEnv: Record<string, string | undefined> = {}
  let exitSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>
  let exitCode: number | undefined

  // Constructed RegExp, not a literal — keeps biome's
  // noControlCharactersInRegex off an intentional ANSI-color strip.
  const ansiRe = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g')
  const stripAnsi = (value: unknown): string => String(value).replace(ansiRe, '')

  beforeEach(() => {
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    exitCode = undefined
    // Official $i → nn: process.exit(1). The spy throws so the gate's
    // "exit" is observable as a control-flow interruption in-process.
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code
      throw new Error(`process.exit(${code})`)
    }) as never)
    errorSpy = spyOn(console, 'error').mockImplementation((() => {}) as never)
  })

  afterEach(() => {
    mock.restore()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  test('deny-only policy + zero config: the resolved default IS denied and the gate exits(1) with the official start message', () => {
    // The confirmed fail-open shape: ONLY deniedModels in policySettings,
    // zero user model config anywhere.
    mockedPolicy = { deniedModels: ['opus', 'sonnet', 'haiku', 'fable'] }
    mockedMerged = {}

    // Pre-fix fact: default resolution itself never consults the deny
    // oracle — whatever the tier default is, it comes back denied.
    const resolvedDefault = getDefaultMainLoopModel()
    expect(isModelDeniedByPolicy(resolvedDefault)).toBe(true)

    // Post-fix contract: the startup gate refuses to let it through.
    expect(() => enforceManagedModelGovernanceStartupGate(resolvedDefault)).toThrow(
      'process.exit(1)',
    )
    expect(exitCode).toBe(1)
    expect(exitSpy).toHaveBeenCalledTimes(1)

    // Official hx: red message on stderr via console.error; message is TH's
    // 'start' branch, byte-verbatim including the shared tail.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const printed = stripAnsi(errorSpy.mock.calls[0]![0])
    expect(printed).toContain(
      "Claude Code can't start: your organization's managed settings block the default model",
    )
    expect(printed).toContain('in "deniedModels"')
    expect(printed).toContain(
      ', and none of the models they allow can be used as the default instead. Ask your administrator to update "deniedModels" or "availableModels".',
    )
    // And it equals exactly what TH('start') returns for this model.
    expect(printed).toBe(
      stripAnsi(getManagedModelGovernanceBlockMessage(resolvedDefault, 'start') ?? ''),
    )
  })

  test('deny-only policy naming only the default family (opus): gate exits(1)', () => {
    mockedPolicy = { deniedModels: ['opus'] }
    mockedMerged = {}
    const resolvedDefault = getDefaultMainLoopModel()
    // Zero-config on the CI seed (firstParty PAYG key) resolves an Opus
    // default; guard so the assertion stays meaningful if tiers change.
    expect(isModelDeniedByPolicy(resolvedDefault)).toBe(true)
    expect(() => enforceManagedModelGovernanceStartupGate(resolvedDefault)).toThrow(
      'process.exit(1)',
    )
    expect(exitCode).toBe(1)
  })

  test('negative control: a deny policy that does NOT match the default starts clean (no exit, no stderr)', () => {
    mockedPolicy = { deniedModels: ['my-custom-model'] } // literal entry only
    mockedMerged = {}
    const resolvedDefault = getDefaultMainLoopModel()
    expect(isModelDeniedByPolicy(resolvedDefault)).toBe(false)
    expect(() => enforceManagedModelGovernanceStartupGate(resolvedDefault)).not.toThrow()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('no policy at all: gate is a no-op (zero-config unaffected)', () => {
    mockedPolicy = null
    mockedMerged = {}
    expect(() =>
      enforceManagedModelGovernanceStartupGate(getDefaultMainLoopModel()),
    ).not.toThrow()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
