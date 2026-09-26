/**
 * CC 2.1.282 bullets (b)(c)(d) + CC 2.1.283 revert — anthropic-skills
 * reserved-namespace hardening.
 *
 * 2.1.283 changes pinned here (byte-extracted from the v2.1.283 linux-x64 ELF):
 *   - zAe   RESERVED_NAMESPACES = ["anthropic-skills"] — 282's second element
 *           "claude-ai" was REVERTED upstream (@197323150; the only
 *           `claude-ai:` string left in the ELF is embedded changelog text).
 *           claude-ai names load again and Skill(claude-ai:*) is an ordinary
 *           prefix rule.
 *   - _Mt   fallback reason is single-name: `uses "anthropic-skills", the
 *           names reserved ...` (no " or " join survives).
 *   - qe    held-back telemetry action map is BINARY — `renamed_allow_rule`
 *           removed (282: 2 hits → 283: 0); non-nonholder kinds emit
 *           `prefix_at_namespace_boundary`.
 *   - NEW packaging-name machinery (vdt/z$/d/JVn/dOo/uOo/le/w6/Be/fMe +
 *     rewritten ue deny matcher / ye allow classifier): Skill(anthropic-
 *     skills:<name>) deny rules also block plugin-delivered / synced skills
 *     under their packaging names; literal `skill:<name>` deny rules
 *     glob-match ordinary names and (without "*") packaging names.
 *   - checkPermissions order re-verified against v2.1.283 @210644300 region:
 *     deny(ue) → allow(ye, held-back tracking) → safe-props(en||Pge) →
 *     squatter(U=Bge&&jB&&!Bee) forced ask.
 *
 * 282 cluster symbols kept (renamed in 283): Bge plaid-harbor gate (282 Nfe),
 * jB isReservedName (282 wU), RWn isSquatter (282 dFn), Bee isSyncedSkillHolder
 * (282 iZ), kOe/nse/v$o/BGo loader drop + warn + telemetry, Se held-back rule
 * message (282 ue).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// OCC-97: snapshot real exports BEFORE mocking; restore in afterAll.
const actualGrowthbook = {
  ...(await import('../../../services/analytics/growthbook.js')),
}
const actualDebug = { ...(await import('../../../utils/debug.js')) }
const actualAnalytics = {
  ...(await import('../../../services/analytics/index.js')),
}

/** Drives the tengu_plaid_harbor gate (official Bge). */
let plaidHarbor: boolean | undefined // undefined → default true
let debugLogs: Array<{ message: string; level?: string }> = []
let events: Array<{ name: string; metadata: Record<string, unknown> }> = []

mock.module('../../../services/analytics/growthbook.js', () => ({
  ...actualGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: <T,>(
    feature: string,
    defaultValue: T,
  ): T =>
    feature === 'tengu_plaid_harbor' && plaidHarbor !== undefined
      ? (plaidHarbor as T)
      : defaultValue,
}))

mock.module('../../../utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    debugLogs.push({ message, level: opts?.level })
  },
}))

mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    events.push({ name, metadata: metadata ?? {} })
  },
}))

afterAll(() => {
  mock.module('../../../services/analytics/growthbook.js', () => ({
    ...actualGrowthbook,
  }))
  mock.module('../../../utils/debug.js', () => ({ ...actualDebug }))
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalytics,
  }))
})

const {
  RESERVED_NAMESPACES,
  RESERVED_NAMES_REASON_FALLBACK,
  ANTHROPIC_SKILLS_NAMESPACE,
  isPlaidHarborEnabled,
  hasReservedNamespacePrefix,
  reservedNamespaceOf,
  isReservedName,
  reservedNameReason,
  isSyncedSkillHolder,
  isSquatter,
  shouldRefuseReservedName,
  resetReservedNamesSessionState_FOR_TESTING,
  getRefusedReservedNames,
  reservedOffendingPath,
  warnReservedNameRefused,
  filterRefusedReservedNames,
  logReservedNamesRefusedTelemetry,
  logHeldBackRuleTelemetry,
  parseSkillRule,
  skillRuleMatchesPlain,
  skillRuleMatchesNamespaceAware,
  qualifyAnthropicSkillsName,
  unqualifyAnthropicSkillsName,
  selfQualifiedSkillName,
  packagingAliasOf,
  pluginPackagingNames,
  syncedPackagingNames,
  packagingNamesFor,
  globPatternMatches,
  renamedCandidate,
  denyMatchOrdinaryNames,
  skillDenyRuleMatches,
  matchSkillRuleForPermission,
  buildHeldBackRuleMessage,
  buildSquatterAskMessage,
  isReservedMcpServerName,
  reservedMcpServerSkillsMessage,
  reservedMcpPromptMessage,
} = await import('../reservedNames.js')

beforeEach(() => {
  plaidHarbor = undefined
  debugLogs = []
  events = []
  resetReservedNamesSessionState_FOR_TESTING()
})

const REASON_ANTHROPIC =
  'uses "anthropic-skills", a name reserved for the skills synced from your claude.ai account'
// Official _Mt @201087507 with the single-element zAe: `uses ${zAe.map(e=>
// `"${e}"`).join(" or ")}, the names reserved ...` — the " or " join has no
// second element to bind to, but the plural "the names" phrasing survives.
const REASON_FALLBACK =
  'uses "anthropic-skills", the names reserved for the skills synced from your claude.ai account'

describe('2.1.283 reserved namespaces: detection', () => {
  test('RESERVED_NAMESPACES matches official zAe (single element)', () => {
    expect([...RESERVED_NAMESPACES]).toEqual(['anthropic-skills'])
    expect(ANTHROPIC_SKILLS_NAMESPACE).toBe('anthropic-skills')
  })

  test('2.1.283 revert pin: claude-ai is NOT a reserved namespace', () => {
    // Official 283: `["anthropic-skills","claude-ai"]` has 0 hits;
    // `startsWith("claude-ai:")` has 0 hits. claude-ai names are ordinary.
    expect(RESERVED_NAMESPACES).not.toContain('claude-ai')
    expect(isReservedName('claude-ai')).toBe(false)
    expect(isReservedName('claude-ai:y')).toBe(false)
    expect(isReservedName('CLAUDE-AI:Y')).toBe(false)
    expect(reservedNamespaceOf('claude-ai:y')).toBeUndefined()
    expect(hasReservedNamespacePrefix('claude-ai:')).toBe(false)
  })

  test('plaid harbor gate defaults on, honors explicit false', () => {
    expect(isPlaidHarborEnabled()).toBe(true)
    plaidHarbor = false
    expect(isPlaidHarborEnabled()).toBe(false)
    plaidHarbor = true
    expect(isPlaidHarborEnabled()).toBe(true)
  })

  test('bare namespace and names inside it are reserved; case-insensitive', () => {
    expect(isReservedName('anthropic-skills')).toBe(true)
    expect(isReservedName('anthropic-skills:foo')).toBe(true)
    expect(isReservedName('ANTHROPIC-SKILLS:Y')).toBe(true)
    expect(isReservedName('Anthropic-Skills:Deep:X')).toBe(true)
    expect(reservedNamespaceOf('ANTHROPIC-SKILLS:Y')).toBe('anthropic-skills')
    expect(reservedNamespaceOf('  anthropic-skills:x  ')).toBe(
      'anthropic-skills',
    )
  })

  test('lookalikes outside the namespace are NOT reserved', () => {
    expect(isReservedName('anthropic-skillsx')).toBe(false)
    expect(isReservedName('anthropic-skillsX:foo')).toBe(false)
    expect(isReservedName('my-anthropic-skills:x')).toBe(false)
    expect(isReservedName('deploy')).toBe(false)
    expect(isReservedName('')).toBe(false)
    expect(reservedNamespaceOf('plain:skill')).toBeUndefined()
  })

  test('hasReservedNamespacePrefix only matches the "ns:" form', () => {
    expect(hasReservedNamespacePrefix('anthropic-skills:')).toBe(true)
    expect(hasReservedNamespacePrefix('anthropic-skills')).toBe(false)
    expect(hasReservedNamespacePrefix('anthropic-skills:x')).toBe(true)
  })

  test('reservedNameReason: singular for a resolvable name, single-name fallback otherwise', () => {
    expect(reservedNameReason('anthropic-skills:y')).toBe(REASON_ANTHROPIC)
    expect(reservedNameReason('anthropic-skills')).toBe(REASON_ANTHROPIC)
    // claude-ai no longer resolves → falls through to the fallback.
    expect(reservedNameReason('claude-ai:y')).toBe(REASON_FALLBACK)
    expect(reservedNameReason('innocent')).toBe(REASON_FALLBACK)
    expect(RESERVED_NAMES_REASON_FALLBACK).toBe(REASON_FALLBACK)
    // First resolvable name wins (official ULe scans in order).
    expect(reservedNameReason('innocent', 'anthropic-skills:a')).toBe(
      REASON_ANTHROPIC,
    )
  })
})

describe('2.1.283 reserved namespaces: squatter / refusal predicates', () => {
  test('synced-skill holders are never squatters', () => {
    const holder = { name: 'anthropic-skills:y', loadedFrom: 'syncedSkills' }
    expect(isSyncedSkillHolder(holder)).toBe(true)
    expect(isSquatter(holder)).toBe(false)
    const wrapper = {
      type: 'prompt',
      name: 'anthropic-skills:y',
      source: 'plugin',
      pluginInfo: {
        repository: 'anthropic-skills@inline',
        accountSkillsWrapper: true,
      },
    }
    expect(isSyncedSkillHolder(wrapper)).toBe(true)
    expect(isSquatter(wrapper)).toBe(false)
  })

  test('squatter detection covers name and display name', () => {
    expect(
      isSquatter({ type: 'prompt', name: 'anthropic-skills:x', source: 'user' }),
    ).toBe(true)
    expect(
      isSquatter({
        type: 'prompt',
        name: 'innocent',
        source: 'user',
        userFacingName: () => 'anthropic-skills:y',
      }),
    ).toBe(true)
    expect(isSquatter({ type: 'prompt', name: 'deploy', source: 'user' })).toBe(
      false,
    )
  })

  test('2.1.283 revert pin: claude-ai skills are not squatters and load again', () => {
    expect(isSquatter({ type: 'prompt', name: 'claude-ai:y', source: 'user' })).toBe(
      false,
    )
    expect(
      shouldRefuseReservedName({ type: 'prompt', name: 'claude-ai:y', source: 'user' }),
    ).toBe(false)
    expect(
      shouldRefuseReservedName({ type: 'prompt', name: 'CLAUDE-AI:Y', source: 'user' }),
    ).toBe(false)
  })

  test('shouldRefuseReservedName: plugin-sourced prompts are exempt', () => {
    const pluginPrompt = {
      type: 'prompt',
      name: 'anthropic-skills:y',
      source: 'plugin',
    }
    expect(shouldRefuseReservedName(pluginPrompt)).toBe(false)
    // Same reserved name from a non-plugin source IS refused.
    expect(
      shouldRefuseReservedName({ type: 'prompt', name: 'anthropic-skills:y', source: 'user' }),
    ).toBe(true)
    expect(shouldRefuseReservedName({ name: 'anthropic-skills:y' })).toBe(true)
    // Non-reserved names are never refused.
    expect(shouldRefuseReservedName({ type: 'prompt', name: 'deploy', source: 'user' })).toBe(
      false,
    )
    // Gate off → nothing refused.
    plaidHarbor = false
    expect(
      shouldRefuseReservedName({ type: 'prompt', name: 'anthropic-skills:y', source: 'user' }),
    ).toBe(false)
  })
})

describe('2.1.283 reserved namespaces: skill-rule matching (official ae/te/ye)', () => {
  test('parseSkillRule strips leading slash and decodes :* / " *" prefixes', () => {
    expect(parseSkillRule('deploy')).toEqual({ name: 'deploy' })
    expect(parseSkillRule('/deploy')).toEqual({ name: 'deploy' })
    expect(parseSkillRule('anthropic-skills:*')).toEqual({
      name: 'anthropic-skills:*',
      prefix: 'anthropic-skills',
    })
    expect(parseSkillRule('foo *')).toEqual({ name: 'foo *', prefix: 'foo' })
    // Parsing is namespace-agnostic — claude-ai:* is now simply an ordinary
    // prefix rule (283 revert).
    expect(parseSkillRule('/claude-ai:*')).toEqual({
      name: 'claude-ai:*',
      prefix: 'claude-ai',
    })
  })

  test('plain matching (official te) is prefix-blind to namespaces', () => {
    expect(skillRuleMatchesPlain('deploy', 'deploy')).toBe(true)
    expect(skillRuleMatchesPlain('deploy', 'deploy-x')).toBe(false)
    expect(skillRuleMatchesPlain('anthropic-skills:*', 'anthropic-skills:foo')).toBe(
      true,
    )
    // The boundary case: the prefix also string-matches lookalikes.
    expect(
      skillRuleMatchesPlain('anthropic-skills:*', 'anthropic-skillsX:foo'),
    ).toBe(true)
  })

  test('namespace-aware matching narrows reserved prefixes only', () => {
    // Non-reserved prefix: plain match AND the skill must not sit in a
    // reserved namespace.
    expect(skillRuleMatchesNamespaceAware('my:*', 'my:foo')).toBe(true)
    expect(skillRuleMatchesNamespaceAware('my:*', 'anthropic-skills:foo')).toBe(
      false,
    )
    // 2.1.283 revert: claude-ai is an ordinary namespace — an ordinary prefix
    // rule covers it again.
    expect(skillRuleMatchesNamespaceAware('my:*', 'claude-ai:foo')).toBe(false) // prefix differs
    expect(skillRuleMatchesNamespaceAware('claude-ai:*', 'claude-ai:foo')).toBe(
      true,
    )
    expect(
      skillRuleMatchesNamespaceAware('claude-ai:*', 'claude-aiX:foo'),
    ).toBe(true) // ordinary prefix rules string-match lookalikes
    // Bare reserved namespace prefix: only "ns:..." names match — the
    // lookalike "anthropic-skillsX:foo" no longer does.
    expect(
      skillRuleMatchesNamespaceAware('anthropic-skills:*', 'anthropic-skills:foo'),
    ).toBe(true)
    expect(
      skillRuleMatchesNamespaceAware('anthropic-skills:*', 'anthropic-skillsX:foo'),
    ).toBe(false)
    expect(
      skillRuleMatchesNamespaceAware('anthropic-skills:*', 'anthropic-skills'),
    ).toBe(false)
    // Prefix INSIDE a reserved namespace: exact prefix or "prefix:...".
    expect(
      skillRuleMatchesNamespaceAware(
        'anthropic-skills:foo:*',
        'anthropic-skills:foo',
      ),
    ).toBe(true)
    expect(
      skillRuleMatchesNamespaceAware(
        'anthropic-skills:foo:*',
        'anthropic-skills:foo:bar',
      ),
    ).toBe(true)
    expect(
      skillRuleMatchesNamespaceAware(
        'anthropic-skills:foo:*',
        'anthropic-skills:foobar',
      ),
    ).toBe(false)
    // No prefix → plain exact match.
    expect(skillRuleMatchesNamespaceAware('deploy', 'deploy')).toBe(true)
  })

  test('matchSkillRuleForPermission (official ye): gate off falls back to plain matching', () => {
    plaidHarbor = false
    expect(
      matchSkillRuleForPermission('anthropic-skills:*', 'anthropic-skills:foo'),
    ).toBe('allow')
    expect(
      matchSkillRuleForPermission('anthropic-skills:*', 'anthropic-skillsX:foo'),
    ).toBe('allow')
    expect(matchSkillRuleForPermission('deploy', 'other')).toBe('no-match')
  })

  test('ye: gate on — reserved names are held back, ordinary names allowed', () => {
    // Reserved name, non-holder, ns-aware + plain match → held-back-nonholder.
    expect(
      matchSkillRuleForPermission('anthropic-skills:*', 'anthropic-skills:foo'),
    ).toBe('held-back-nonholder')
    // Lookalike beyond the namespace boundary: plain matches, ns-aware does
    // not → held-back-boundary.
    expect(
      matchSkillRuleForPermission('anthropic-skills:*', 'anthropic-skillsX:foo'),
    ).toBe('held-back-boundary')
    // Synced holder IS allowed by the reserved rule.
    expect(
      matchSkillRuleForPermission('anthropic-skills:*', 'anthropic-skills:foo', {
        name: 'anthropic-skills:foo',
        loadedFrom: 'syncedSkills',
      }),
    ).toBe('allow')
    // Ordinary skill under an ordinary rule → allow.
    expect(matchSkillRuleForPermission('my:*', 'my:foo')).toBe('allow')
    expect(matchSkillRuleForPermission('deploy', 'deploy')).toBe('allow')
    // No relationship → no-match.
    expect(matchSkillRuleForPermission('deploy', 'build')).toBe('no-match')
    // Command-name candidate participates (official candidates list).
    expect(
      matchSkillRuleForPermission('my:*', 'invoked', { name: 'my:foo' }),
    ).toBe('allow')
  })

  test('2.1.283 revert pin: claude-ai rules are ordinary prefix rules', () => {
    // Exact rule for a claude-ai name: plain allow again (282 held it back).
    expect(matchSkillRuleForPermission('claude-ai:y', 'claude-ai:y')).toBe(
      'allow',
    )
    expect(matchSkillRuleForPermission('claude-ai:*', 'claude-ai:y')).toBe(
      'allow',
    )
    // The 282 "non-reserved prefix biting into the reserved namespace"
    // boundary case is gone — claude-ai is an ordinary namespace.
    expect(matchSkillRuleForPermission('claude:*', 'claude-ai:y')).toBe(
      'allow',
    )
  })

  test('renamed candidate (official fMe): synced prompt alias participates in allow matching', () => {
    const renamed = {
      type: 'prompt',
      name: 'anthropic-skills:new',
      loadedFrom: 'syncedSkills',
      aliases: ['old'],
      unqualifiedName: 'old',
    }
    expect(renamedCandidate(renamed)).toBe('old')
    expect(renamedCandidate(undefined)).toBeUndefined()
    // Not syncedSkills → no renamed candidate.
    expect(
      renamedCandidate({ ...renamed, loadedFrom: 'plugin' }),
    ).toBeUndefined()
    // unqualifiedName not in aliases → no candidate.
    expect(
      renamedCandidate({ ...renamed, aliases: ['other'] }),
    ).toBeUndefined()
    // The renamed candidate lets the holder's old-name rule allow (holder ⇒
    // reserved name is legitimately covered).
    expect(matchSkillRuleForPermission('old', 'new', renamed)).toBe('allow')
  })
})

describe('2.1.283 packaging-name machinery (official vdt/z$/d/JVn/dOo/uOo/le/w6)', () => {
  test('qualify / unqualify (official vdt / z$)', () => {
    expect(qualifyAnthropicSkillsName('foo')).toBe('anthropic-skills:foo')
    expect(qualifyAnthropicSkillsName('anthropic-skills:foo')).toBe(
      'anthropic-skills:foo',
    )
    expect(unqualifyAnthropicSkillsName('anthropic-skills:foo')).toBe('foo')
    expect(unqualifyAnthropicSkillsName('foo')).toBe('foo')
    expect(unqualifyAnthropicSkillsName('anthropic-skills:')).toBe('')
  })

  test('selfQualifiedSkillName (official d): only the non-reserved "X:X" form', () => {
    expect(selfQualifiedSkillName('foo:foo')).toBe('foo')
    expect(selfQualifiedSkillName('foo:bar')).toBeUndefined()
    expect(selfQualifiedSkillName('foo')).toBeUndefined()
    expect(selfQualifiedSkillName(':foo')).toBeUndefined()
    // The reserved namespace itself never self-qualifies (zAe.includes).
    expect(
      selfQualifiedSkillName('anthropic-skills:anthropic-skills'),
    ).toBeUndefined()
    // 283 revert interaction: "claude-ai:claude-ai" IS self-qualified now
    // (claude-ai left zAe).
    expect(selfQualifiedSkillName('claude-ai:claude-ai')).toBe('claude-ai')
  })

  test('packagingAliasOf (official JVn): "X:X" ↔ "anthropic-skills:X"', () => {
    expect(packagingAliasOf('foo:foo')).toBe('anthropic-skills:foo')
    expect(packagingAliasOf('anthropic-skills:foo')).toBe('foo:foo')
    // Reserved-qualified with a compound tail → no alias.
    expect(packagingAliasOf('anthropic-skills:foo:bar')).toBeUndefined()
    expect(packagingAliasOf('anthropic-skills:')).toBeUndefined()
    expect(packagingAliasOf('foo:bar')).toBeUndefined()
    expect(packagingAliasOf('deploy')).toBeUndefined()
  })

  test('pluginPackagingNames (official dOo)', () => {
    // Non-plugin delivery → no packaging names.
    expect(
      pluginPackagingNames({ name: 'foo:foo', loadedFrom: 'syncedSkills' }),
    ).toEqual([])
    expect(pluginPackagingNames({ name: 'foo:foo', source: 'user' })).toEqual([])
    // Self-qualified plugin skill "foo:foo".
    expect(
      pluginPackagingNames({ name: 'foo:foo', loadedFrom: 'plugin' }),
    ).toEqual(['anthropic-skills:foo', 'foo'])
    // Aliases ≠ extracted name are qualified and appended.
    expect(
      pluginPackagingNames({
        name: 'foo:foo',
        loadedFrom: 'plugin',
        aliases: ['foo', 'bar'],
      }),
    ).toEqual(['anthropic-skills:foo', 'foo', 'anthropic-skills:bar'])
    // Self-qualification via the DISPLAY name; tail === extracted → no tail
    // variants.
    expect(
      pluginPackagingNames({
        name: 'plug:deploy',
        loadedFrom: 'plugin',
        userFacingName: () => 'deploy:deploy',
      }),
    ).toEqual(['anthropic-skills:deploy', 'deploy'])
    // Display-name extraction with a DIFFERENT registered tail → qualified +
    // bare tail variants appended.
    expect(
      pluginPackagingNames({
        name: 'plug:run',
        loadedFrom: 'plugin',
        userFacingName: () => 'deploy:deploy',
      }),
    ).toEqual([
      'anthropic-skills:deploy',
      'deploy',
      'anthropic-skills:run',
      'run',
    ])
    // No self-qualified form anywhere → empty.
    expect(
      pluginPackagingNames({ name: 'plug:run', loadedFrom: 'plugin' }),
    ).toEqual([])
  })

  test('syncedPackagingNames (official uOo)', () => {
    // Wrong delivery or non-reserved name → empty.
    expect(syncedPackagingNames({ name: 'anthropic-skills:foo' })).toEqual([])
    expect(
      syncedPackagingNames({ name: 'foo', loadedFrom: 'syncedSkills' }),
    ).toEqual([])
    // Simple reserved tail → the self-qualified alias.
    expect(
      syncedPackagingNames({
        name: 'anthropic-skills:foo',
        loadedFrom: 'syncedSkills',
      }),
    ).toEqual(['foo:foo'])
    // Plugin delivery of a reserved-qualified name counts too.
    expect(
      syncedPackagingNames({ name: 'anthropic-skills:foo', loadedFrom: 'plugin' }),
    ).toEqual(['foo:foo'])
    // Compound tail → empty.
    expect(
      syncedPackagingNames({
        name: 'anthropic-skills:foo:bar',
        loadedFrom: 'syncedSkills',
      }),
    ).toEqual([])
    // A DIFFERENT reserved-qualified display name adds R:R / R:N / bare R.
    expect(
      syncedPackagingNames({
        name: 'anthropic-skills:foo',
        loadedFrom: 'syncedSkills',
        userFacingName: () => 'anthropic-skills:bar',
      }),
    ).toEqual(['foo:foo', 'bar:bar', 'bar:foo', 'bar'])
    // Same display tail as the name → no extra variants.
    expect(
      syncedPackagingNames({
        name: 'anthropic-skills:foo',
        loadedFrom: 'syncedSkills',
        userFacingName: () => 'anthropic-skills:foo',
      }),
    ).toEqual(['foo:foo'])
  })

  test('packagingNamesFor (official le, De exemption STAGED) concatenates both halves', () => {
    // dOo half empty for a reserved-qualified name; uOo half contributes.
    expect(
      packagingNamesFor({
        name: 'anthropic-skills:foo',
        loadedFrom: 'plugin',
      }),
    ).toEqual(['foo:foo'])
    // dOo half contributes for the self-qualified plugin form.
    expect(
      packagingNamesFor({ name: 'foo:foo', loadedFrom: 'plugin' }),
    ).toEqual(['anthropic-skills:foo', 'foo'])
    // Ordinary user skill → no packaging names.
    expect(packagingNamesFor({ name: 'deploy', source: 'user' })).toEqual([])
  })

  test('globPatternMatches (official w6): * → .*, metacharacters escaped, /s', () => {
    expect(globPatternMatches('foo*', 'foobar')).toBe(true)
    expect(globPatternMatches('foo', 'foobar')).toBe(false)
    expect(globPatternMatches('*', 'anything')).toBe(true)
    expect(globPatternMatches('*', '')).toBe(true)
    // Regex metacharacters are literal.
    expect(globPatternMatches('a.b', 'a.b')).toBe(true)
    expect(globPatternMatches('a.b', 'axb')).toBe(false)
    expect(globPatternMatches('a+b', 'a+b')).toBe(true)
    // /s flag: .* crosses newlines.
    expect(globPatternMatches('a*b', 'a\nb')).toBe(true)
    // Anchored: no substring matches.
    expect(globPatternMatches('bar', 'foobar')).toBe(false)
  })
})

describe('2.1.283 deny matcher (official ue) — ordinary + packaging names', () => {
  test('ordinary names (official Le): invoked, registered, display, aliases, unqualifiedName', () => {
    expect(denyMatchOrdinaryNames('invoked')).toEqual(['invoked'])
    expect(
      denyMatchOrdinaryNames('invoked', {
        type: 'prompt',
        name: 'reg',
        userFacingName: () => 'disp',
        aliases: ['a1'],
        unqualifiedName: 'uq',
      }),
    ).toEqual(['invoked', 'reg', 'disp', 'a1', 'uq'])
    // unqualifiedName is prompt-only.
    expect(
      denyMatchOrdinaryNames('invoked', {
        type: 'local-jsx',
        name: 'reg',
        unqualifiedName: 'uq',
      }),
    ).toEqual(['invoked', 'reg', 'reg'])
  })

  test('ordinary matching is unchanged from the 282 de subset', () => {
    expect(skillDenyRuleMatches('deploy', 'deploy')).toBe(true)
    expect(skillDenyRuleMatches('deploy:*', 'deploy:x')).toBe(true)
    expect(skillDenyRuleMatches('evil', 'invoked', { name: 'evil' })).toBe(true)
    expect(
      skillDenyRuleMatches('evil', 'invoked', {
        name: 'other',
        userFacingName: () => 'evil',
      }),
    ).toBe(true)
    expect(
      skillDenyRuleMatches('evil', 'invoked', {
        name: 'other',
        aliases: ['evil'],
      }),
    ).toBe(true)
    expect(skillDenyRuleMatches('good', 'bad', { name: 'other' })).toBe(false)
  })

  test('283 bullet: Skill(anthropic-skills:<name>) deny also blocks the plugin-delivered skill', () => {
    // A plugin delivering the self-qualified "foo:foo" skill carries the
    // packaging name "anthropic-skills:foo" — the deny rule blocks it.
    const pluginSkill = {
      type: 'prompt',
      name: 'foo:foo',
      loadedFrom: 'plugin',
      source: 'plugin',
    }
    expect(
      skillDenyRuleMatches('anthropic-skills:foo', 'foo:foo', pluginSkill),
    ).toBe(true)
    // A wildcard-prefix deny does NOT reach packaging names unless the prefix
    // IS the packaging name (official: prefix===name||yu(); yu() ≡ false in
    // OCC — documented deviation, fail-closed).
    expect(
      skillDenyRuleMatches('anthropic-skills:*', 'foo:foo', pluginSkill),
    ).toBe(false)
    // Prefix rule whose prefix IS the packaging name matches.
    expect(
      skillDenyRuleMatches('anthropic-skills:foo:*', 'foo:foo', pluginSkill),
    ).toBe(true)
    // Without the plugin delivery there are no packaging names → no deny.
    expect(
      skillDenyRuleMatches('anthropic-skills:foo', 'foo:foo', {
        type: 'prompt',
        name: 'foo:foo',
        source: 'user',
      }),
    ).toBe(false)
  })

  test('283 bullet: literal skill:<name> deny rules glob ordinary and packaging names', () => {
    const pluginSkill = {
      type: 'prompt',
      name: 'foo:foo',
      loadedFrom: 'plugin',
      source: 'plugin',
    }
    // Literal rule, no wildcard → packaging names are glob-matched too.
    expect(
      skillDenyRuleMatches('skill:anthropic-skills:foo', 'foo:foo', pluginSkill),
    ).toBe(true)
    // Literal rule WITH a wildcard → packaging glob is skipped (official
    // widens only via yu(), ≡ false), and the ordinary glob doesn't reach it.
    expect(
      skillDenyRuleMatches('skill:anthropic-skills:*', 'foo:foo', pluginSkill),
    ).toBe(false)
    // Ordinary-name globbing via the literal form.
    expect(skillDenyRuleMatches('skill:foo*', 'foobar')).toBe(true)
    expect(skillDenyRuleMatches('skill:foo:foo', 'foo:foo', pluginSkill)).toBe(
      true,
    )
    // Whitespace around the literal prefix is tolerated (Be = /^\s*skill\s*:(.*)$/s).
    expect(skillDenyRuleMatches(' skill : deploy ', 'deploy')).toBe(true)
  })

  test('synced skills: deny reaches the self-qualified alias and display-name variants', () => {
    const synced = {
      type: 'prompt',
      name: 'anthropic-skills:foo',
      loadedFrom: 'syncedSkills',
    }
    expect(skillDenyRuleMatches('foo:foo', 'anthropic-skills:foo', synced)).toBe(
      true,
    )
    const renamedDisplay = {
      ...synced,
      userFacingName: () => 'anthropic-skills:bar',
    }
    expect(
      skillDenyRuleMatches('bar:foo', 'anthropic-skills:foo', renamedDisplay),
    ).toBe(true)
    expect(
      skillDenyRuleMatches('bar', 'anthropic-skills:foo', renamedDisplay),
    ).toBe(true)
    expect(
      skillDenyRuleMatches('bar:bar', 'anthropic-skills:foo', renamedDisplay),
    ).toBe(true)
    // Unrelated deny → no match.
    expect(skillDenyRuleMatches('other', 'anthropic-skills:foo', synced)).toBe(
      false,
    )
  })

  test('unqualifiedName participates in ordinary deny matching (283 Le)', () => {
    expect(
      skillDenyRuleMatches('old', 'invoked', {
        type: 'prompt',
        name: 'other',
        unqualifiedName: 'old',
      }),
    ).toBe(true)
  })
})

describe('2.1.283 reserved namespaces: messages (official Se + squatter ask)', () => {
  test('nonholder message — not synced', () => {
    expect(
      buildHeldBackRuleMessage('anthropic-skills:*', 'anthropic-skills:foo', {
        kind: 'nonholder',
      }),
    ).toBe(
      'Skill(anthropic-skills:*) only covers skills synced from your claude.ai account. anthropic-skills:foo is not synced, so no rule for that name can pre-approve it; it needs approval each time.',
    )
  })

  test('nonholder message — plugin-sourced squatter names the plugin', () => {
    expect(
      buildHeldBackRuleMessage('anthropic-skills:*', 'anthropic-skills:y', {
        kind: 'nonholder',
        pluginName: 'my-plugin',
      }),
    ).toBe(
      'Skill(anthropic-skills:*) only covers skills synced from your claude.ai account. anthropic-skills:y comes from the plugin "my-plugin", so no rule for that name can pre-approve it; it needs approval each time.',
    )
  })

  test('boundary message — bare namespace prefix', () => {
    expect(
      buildHeldBackRuleMessage('anthropic-skills:*', 'anthropic-skillsX:foo', {
        kind: 'boundary',
      }),
    ).toBe(
      'Skill(anthropic-skills:*) only covers names starting with "anthropic-skills:". Add Skill(anthropic-skillsX:foo) to allow anthropic-skillsX:foo without asking.',
    )
  })

  test('boundary message — prefix inside a reserved namespace', () => {
    expect(
      buildHeldBackRuleMessage(
        'anthropic-skills:foo:*',
        'anthropic-skills:foobar',
        { kind: 'boundary' },
      ),
    ).toBe(
      'Skill(anthropic-skills:foo:*) only covers anthropic-skills:foo and names starting with "anthropic-skills:foo:". Add Skill(anthropic-skills:foobar) to allow anthropic-skills:foobar without asking.',
    )
  })

  test('boundary message — non-reserved rule against a reserved name', () => {
    expect(
      buildHeldBackRuleMessage('deploy', 'anthropic-skills:y', { kind: 'boundary' }),
    ).toBe(
      'Skill(deploy) does not cover "anthropic-skills:" names, which are reserved for skills synced from your claude.ai account. Add Skill(anthropic-skills:y) to allow anthropic-skills:y without asking.',
    )
  })

  test('squatter ask message — em dash join, byte-exact', () => {
    expect(buildSquatterAskMessage('deploy')).toBe('Execute skill: deploy')
    const reason = buildHeldBackRuleMessage(
      'anthropic-skills:*',
      'anthropic-skills:foo',
      { kind: 'nonholder' },
    )
    const message = buildSquatterAskMessage('anthropic-skills:foo', reason)
    expect(message).toBe(
      `Execute skill: anthropic-skills:foo — ${reason}`,
    )
    // The separator is U+2014 EM DASH (official bytes 342 200 224).
    expect(message.includes('—')).toBe(true)
  })
})

describe('2.1.283 reserved namespaces: loader refusal (official kOe/nse/v$o/BGo)', () => {
  test('reservedOffendingPath walks up to the offending namespace folder', () => {
    expect(
      reservedOffendingPath(
        '/proj/.claude/skills/anthropic-skills/x/SKILL.md',
        'anthropic-skills:x',
      ),
    ).toBe('/proj/.claude/skills/anthropic-skills')
    // Non-SKILL.md command file: start is the file itself, .md stripped.
    expect(
      reservedOffendingPath(
        '/proj/.claude/commands/anthropic-skills/y.md',
        'anthropic-skills:y',
      ),
    ).toBe('/proj/.claude/commands/anthropic-skills')
    // Name not reconstructible from ancestors → returns the start dir.
    expect(
      reservedOffendingPath('/proj/skills/a/b/SKILL.md', 'anthropic-skills:z'),
    ).toBe('/proj/skills/a/b')
  })

  test('folder skill anthropic-skills/x is dropped from load with the exact warn', () => {
    const entries = [
      {
        skill: { type: 'prompt', name: 'anthropic-skills:x', source: 'user' },
        filePath: '/proj/.claude/skills/anthropic-skills/x/SKILL.md',
      },
      { skill: { type: 'prompt', name: 'deploy', source: 'user' }, filePath: '/proj/.claude/skills/deploy/SKILL.md' },
    ]
    const kept = filterRefusedReservedNames(
      entries as Parameters<typeof filterRefusedReservedNames>[0],
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].skill.name).toBe('deploy')
    expect(debugLogs).toHaveLength(1)
    expect(debugLogs[0].level).toBe('warn')
    expect(debugLogs[0].message).toBe(
      `[skills] not loading "anthropic-skills:x" (/proj/.claude/skills/anthropic-skills): that name ${REASON_ANTHROPIC}; rename it`,
    )
    expect(getRefusedReservedNames()).toEqual([
      {
        name: 'anthropic-skills:x',
        path: '/proj/.claude/skills/anthropic-skills',
        change: 'path',
      },
    ])
  })

  test('command anthropic-skills:y via display name is dropped with the frontmatter-name warn', () => {
    const kept = filterRefusedReservedNames([
      {
        skill: {
          type: 'prompt',
          name: 'innocent',
          source: 'user',
          userFacingName: () => 'anthropic-skills:y',
        },
        filePath: '/proj/.claude/commands/innocent.md',
      },
    ] as Parameters<typeof filterRefusedReservedNames>[0])
    expect(kept).toHaveLength(0)
    expect(debugLogs[0].message).toBe(
      `[skills] not loading "anthropic-skills:y" (/proj/.claude/commands/innocent.md): that name ${REASON_ANTHROPIC}; change its name: line`,
    )
  })

  test('2.1.283 revert pin: claude-ai skills and commands load again', () => {
    const kept = filterRefusedReservedNames([
      {
        skill: { type: 'prompt', name: 'claude-ai:y', source: 'user' },
        filePath: '/proj/.claude/skills/claude-ai/y/SKILL.md',
      },
      {
        skill: {
          type: 'prompt',
          name: 'innocent',
          source: 'user',
          userFacingName: () => 'claude-ai:display',
        },
        filePath: '/proj/.claude/commands/innocent.md',
      },
    ] as Parameters<typeof filterRefusedReservedNames>[0])
    expect(kept).toHaveLength(2)
    expect(debugLogs).toHaveLength(0)
    expect(getRefusedReservedNames()).toEqual([])
  })

  test('plugin-sourced prompt with a reserved name still loads', () => {
    const kept = filterRefusedReservedNames([
      {
        skill: { type: 'prompt', name: 'anthropic-skills:y', source: 'plugin' },
        filePath: '/plugins/x/commands/y.md',
      },
    ] as Parameters<typeof filterRefusedReservedNames>[0])
    expect(kept).toHaveLength(1)
    expect(debugLogs).toHaveLength(0)
  })

  test('gate off → nothing refused', () => {
    plaidHarbor = false
    const kept = filterRefusedReservedNames([
      {
        skill: { type: 'prompt', name: 'anthropic-skills:y', source: 'user' },
        filePath: '/proj/.claude/skills/anthropic-skills/y/SKILL.md',
      },
    ] as Parameters<typeof filterRefusedReservedNames>[0])
    expect(kept).toHaveLength(1)
  })

  test('warn dedupes once per path/name/change; workflow label variant', () => {
    warnReservedNameRefused({
      name: 'anthropic-skills:y',
      path: '/p',
      change: 'path',
    })
    warnReservedNameRefused({
      name: 'anthropic-skills:y',
      path: '/p',
      change: 'path',
    })
    expect(debugLogs).toHaveLength(1)
    warnReservedNameRefused({
      name: 'anthropic-skills:z',
      path: '/q',
      change: 'workflow-name',
    })
    expect(debugLogs).toHaveLength(2)
    expect(debugLogs[1].message).toBe(
      `[skills] not loading workflow "anthropic-skills:z" (/q): that name ${REASON_ANTHROPIC}; rename it`,
    )
  })

  test('names_refused telemetry: once per session with ns/kind counters', () => {
    filterRefusedReservedNames([
      {
        skill: { type: 'prompt', name: 'anthropic-skills:x', source: 'user' },
        filePath: '/proj/.claude/skills/anthropic-skills/x/SKILL.md',
      },
      {
        skill: { type: 'prompt', name: 'anthropic-skills:y', source: 'project' },
        filePath: '/proj/.claude/skills/anthropic-skills/y/SKILL.md',
      },
    ] as Parameters<typeof filterRefusedReservedNames>[0])
    logReservedNamesRefusedTelemetry()
    logReservedNamesRefusedTelemetry()
    expect(events).toHaveLength(1)
    expect(events[0].name).toBe('skill_reserved_namespace')
    expect(events[0].metadata).toMatchObject({
      action: 'names_refused',
      refused: 2,
      ns_anthropic_skills: 2,
      kind_path: 2,
    })
    // 283 revert: no claude-ai refusals can occur, so no ns_claude_ai counter.
    expect(events[0].metadata.ns_claude_ai).toBeUndefined()
  })

  test('held-back telemetry: once per kind; 283 action map is binary', () => {
    logHeldBackRuleTelemetry('nonholder')
    logHeldBackRuleTelemetry('nonholder')
    logHeldBackRuleTelemetry('boundary')
    logHeldBackRuleTelemetry('renamed')
    expect(events).toHaveLength(3)
    expect(events[0].metadata).toMatchObject({
      action: 'nonholder_allow_rule',
      host_prompt: false,
    })
    expect(events[1].metadata).toMatchObject({
      action: 'prefix_at_namespace_boundary',
      host_prompt: false,
    })
    // 283 qe: `e==="nonholder"?"nonholder_allow_rule":
    // "prefix_at_namespace_boundary"` — 282's `renamed_allow_rule` action was
    // removed; the renamed kind reuses the boundary action (own claim key).
    expect(events[2].metadata).toMatchObject({
      action: 'prefix_at_namespace_boundary',
      host_prompt: false,
    })
    expect(typeof events[0].metadata.interactive).toBe('boolean')
  })
})

describe('2.1.283 reserved namespaces: MCP server-name gates', () => {
  test('server named anthropic-skills: skills refused; claude-ai servers list again (283 revert)', () => {
    expect(isReservedMcpServerName('anthropic-skills')).toBe(true)
    expect(isReservedMcpServerName('ANTHROPIC-SKILLS')).toBe(true)
    expect(isReservedMcpServerName('anthropic-skills-tools')).toBe(false)
    expect(isReservedMcpServerName('my-server')).toBe(false)
    // 2.1.283 revert pins.
    expect(isReservedMcpServerName('claude-ai')).toBe(false)
    expect(isReservedMcpServerName('CLAUDE-AI')).toBe(false)
    plaidHarbor = false
    expect(isReservedMcpServerName('anthropic-skills')).toBe(false)
  })

  test('skills funnel message is byte-exact', () => {
    expect(reservedMcpServerSkillsMessage('anthropic-skills')).toBe(
      `Skills not loaded: the server name ${REASON_ANTHROPIC}. Rename the server in your MCP configuration to load its skills and prompts; its tools are unaffected.`,
    )
  })

  test('per-prompt message is byte-exact (single-name fallback reason)', () => {
    expect(reservedMcpPromptMessage('mcp__anthropic-skills__summarize')).toBe(
      `Prompt 'mcp__anthropic-skills__summarize' not listed: the server name ${REASON_FALLBACK}. Rename the server in your MCP configuration to list its prompts.`,
    )
  })

  test('fetchMcpSkillsForClient stub logs the funnel message for reserved server names only', async () => {
    const mcpLogs: Array<{ server: string; message: string }> = []
    const actualLog = { ...(await import('../../../utils/log.js')) }
    mock.module('../../../utils/log.js', () => ({
      ...actualLog,
      logMCPDebug: (server: string, message: string) => {
        mcpLogs.push({ server, message })
      },
    }))
    try {
      const { fetchMcpSkillsForClient } = await import(
        '../../../skills/mcpSkills.js'
      )
      const reserved = await fetchMcpSkillsForClient({ name: 'anthropic-skills' })
      expect(reserved).toEqual([])
      expect(mcpLogs).toHaveLength(1)
      expect(mcpLogs[0].server).toBe('anthropic-skills')
      expect(mcpLogs[0].message).toBe(
        reservedMcpServerSkillsMessage('anthropic-skills'),
      )
      // 283 revert: a claude-ai server no longer triggers the funnel log.
      const reverted = await fetchMcpSkillsForClient({ name: 'claude-ai' })
      expect(reverted).toEqual([])
      expect(mcpLogs).toHaveLength(1)
      // A renamed (non-reserved) server does not trigger the funnel log.
      const renamed = await fetchMcpSkillsForClient({ name: 'my-anthropic-skills' })
      expect(renamed).toEqual([])
      expect(mcpLogs).toHaveLength(1)
    } finally {
      mock.module('../../../utils/log.js', () => ({ ...actualLog }))
    }
  })

  test('client prompt gate: reserved server drops prompts, tools untouched, claude-ai server lists prompts again', () => {
    // Mirrors the fetchCommandsForClient gate in src/services/mcp/client.ts:
    // each prompt becomes a Command whose display name is
    // `${client.name}:${prompt.name} (MCP)` and source is 'mcp'; the gate is
    // shouldRefuseReservedName per command (official rZe). Tools never pass
    // through this filter — only prompts do.
    const promptCommand = (serverName: string, promptName: string) => ({
      type: 'prompt',
      // client.ts: 'mcp__' + normalizeNameForMCP(client.name) + '__' + prompt
      // (normalizeNameForMCP keeps [a-zA-Z0-9_-], so dashes survive).
      name: `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__${promptName}`,
      source: 'mcp',
      userFacingName: () => `${serverName}:${promptName} (MCP)`,
    })
    const gate = (serverName: string, promptNames: string[]) => {
      const kept: string[] = []
      for (const promptName of promptNames) {
        const command = promptCommand(serverName, promptName)
        if (shouldRefuseReservedName(command)) {
          debugLogs.push({
            message: reservedMcpPromptMessage(command.name),
          })
          continue
        }
        kept.push(command.name)
      }
      return kept
    }

    expect(gate('anthropic-skills', ['summarize', 'review'])).toEqual([])
    expect(debugLogs).toHaveLength(2)
    expect(debugLogs[0].message).toBe(
      reservedMcpPromptMessage('mcp__anthropic-skills__summarize'),
    )
    // 283 revert: claude-ai server prompts are listed again.
    expect(gate('claude-ai', ['summarize', 'review'])).toEqual([
      'mcp__claude-ai__summarize',
      'mcp__claude-ai__review',
    ])
    expect(debugLogs).toHaveLength(2)
    expect(gate('my-anthropic-skills', ['summarize'])).toEqual([
      'mcp__my-anthropic-skills__summarize',
    ])
    expect(gate('github', ['list_prs'])).toEqual(['mcp__github__list_prs'])

    // Gate off → reserved server prompts list again.
    plaidHarbor = false
    expect(gate('anthropic-skills', ['summarize'])).toEqual([
      'mcp__anthropic-skills__summarize',
    ])
  })
})
