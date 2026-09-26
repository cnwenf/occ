/**
 * CC 2.1.283 — anthropic-skills reserved-namespace hardening after the
 * claude-ai revert, plus the 283 deny-matcher expansion.
 *
 * 2.1.283 REVERTED 282's "claude-ai" reservation (official zAe is back to
 * the single element ["anthropic-skills"] @197323070; the pge alias
 * transform and the 'renamed' held-back kind are gone). claude-ai:* names
 * load again and Skill(claude-ai:*) is an ordinary prefix rule.
 *
 * 283 also EXPANDED the deny matcher (official ue @210624361):
 *   - Be @210624663  `skill:<pattern>` rule form (/^\s*skill\s*:(.*)$/s)
 *   - w6 @196261877  glob wildcard matcher (escaped segments joined by .*)
 *   - Le @210624686  candidate split {ordinary, packaging}
 *   - dOo/uOo/le     plugin + synced packaging-alias expansion
 *   - yu / De        Desktop-host gate + untrusted-plugin filter — both
 *                    structurally false in OCC (forward-compat seams)
 *
 * Official cluster (v2.1.283 linux-x64 ELF, byte-extracted):
 *   - zAe   RESERVED_NAMESPACES = ["anthropic-skills"]
 *   - Bge   plaid-harbor gate: x("tengu_plaid_harbor", true) !== false
 *   - jB    isReservedName (via zat reservedNamespaceOf)
 *   - isSquatter; shouldRefuseReservedName (plugin prompts exempt)
 *   - kOe/nse/v$o/BGo loader drop + warn + telemetry
 *   - ae/te/ke/ye rule parse/match/permission classification
 *   - Se    held-back rule message; squatter ask `Execute skill: X — reason`
 *   - MCP server-name skills funnel + per-prompt filter messages
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
  skillRuleMatchesWildcard,
  denyMatchCandidates,
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
const REASON_FALLBACK =
  'uses "anthropic-skills", the names reserved for the skills synced from your claude.ai account'

describe('2.1.283 reserved namespaces: detection', () => {
  test('RESERVED_NAMESPACES matches official zAe (single element — claude-ai reverted)', () => {
    expect([...RESERVED_NAMESPACES]).toEqual(['anthropic-skills'])
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

  test('283 revert: claude-ai names are NOT reserved anymore', () => {
    expect(isReservedName('claude-ai')).toBe(false)
    expect(isReservedName('claude-ai:y')).toBe(false)
    expect(isReservedName('CLAUDE-AI:Y')).toBe(false)
    expect(reservedNamespaceOf('claude-ai:y')).toBeUndefined()
  })

  test('lookalikes outside the namespace are NOT reserved', () => {
    expect(isReservedName('anthropic-skillsx')).toBe(false)
    expect(isReservedName('anthropic-skillsX:foo')).toBe(false)
    expect(isReservedName('my-claude-ai:x')).toBe(false)
    expect(isReservedName('claude-aix')).toBe(false)
    expect(isReservedName('deploy')).toBe(false)
    expect(isReservedName('')).toBe(false)
    expect(reservedNamespaceOf('plain:skill')).toBeUndefined()
  })

  test('hasReservedNamespacePrefix only matches the "ns:" form', () => {
    expect(hasReservedNamespacePrefix('anthropic-skills:')).toBe(true)
    expect(hasReservedNamespacePrefix('anthropic-skills')).toBe(false)
    expect(hasReservedNamespacePrefix('anthropic-skills:x')).toBe(true)
    // 283 revert: claude-ai: is no longer a reserved prefix.
    expect(hasReservedNamespacePrefix('claude-ai:')).toBe(false)
  })

  test('reservedNameReason: singular for a resolvable name, plural fallback otherwise', () => {
    expect(reservedNameReason('anthropic-skills')).toBe(REASON_ANTHROPIC)
    expect(reservedNameReason('anthropic-skills:y')).toBe(REASON_ANTHROPIC)
    // claude-ai no longer resolves → plural fallback (283 revert).
    expect(reservedNameReason('claude-ai:y')).toBe(REASON_FALLBACK)
    expect(reservedNameReason('innocent')).toBe(REASON_FALLBACK)
    expect(RESERVED_NAMES_REASON_FALLBACK).toBe(REASON_FALLBACK)
    // First resolvable name wins (official scans in order).
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
      isSquatter({
        type: 'prompt',
        name: 'anthropic-skills:x',
        source: 'user',
      }),
    ).toBe(true)
    expect(
      isSquatter({
        type: 'prompt',
        name: 'innocent',
        source: 'user',
        userFacingName: () => 'anthropic-skills:y',
      }),
    ).toBe(true)
    expect(
      isSquatter({ type: 'prompt', name: 'deploy', source: 'user' }),
    ).toBe(false)
    // 283 revert: claude-ai names (incl. display names) are not squatters.
    expect(
      isSquatter({ type: 'prompt', name: 'claude-ai:y', source: 'user' }),
    ).toBe(false)
    expect(
      isSquatter({
        type: 'prompt',
        name: 'innocent',
        source: 'user',
        userFacingName: () => 'claude-ai:y',
      }),
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
      shouldRefuseReservedName({
        type: 'prompt',
        name: 'anthropic-skills:y',
        source: 'user',
      }),
    ).toBe(true)
    expect(shouldRefuseReservedName({ name: 'anthropic-skills:y' })).toBe(true)
    // Non-reserved names are never refused.
    expect(
      shouldRefuseReservedName({
        type: 'prompt',
        name: 'deploy',
        source: 'user',
      }),
    ).toBe(false)
    // 283 revert: claude-ai names are never refused, from any source.
    expect(
      shouldRefuseReservedName({
        type: 'prompt',
        name: 'claude-ai:y',
        source: 'user',
      }),
    ).toBe(false)
    // Gate off → nothing refused.
    plaidHarbor = false
    expect(
      shouldRefuseReservedName({
        type: 'prompt',
        name: 'anthropic-skills:y',
        source: 'user',
      }),
    ).toBe(false)
  })
})

describe('2.1.283 reserved namespaces: skill-rule matching (official ae/te/ke/ye)', () => {
  test('parseSkillRule strips leading slash and decodes :* / " *" prefixes', () => {
    expect(parseSkillRule('deploy')).toEqual({ name: 'deploy' })
    expect(parseSkillRule('/deploy')).toEqual({ name: 'deploy' })
    expect(parseSkillRule('anthropic-skills:*')).toEqual({
      name: 'anthropic-skills:*',
      prefix: 'anthropic-skills',
    })
    expect(parseSkillRule('foo *')).toEqual({ name: 'foo *', prefix: 'foo' })
    // Parsing itself is namespace-agnostic — claude-ai:* is an ordinary
    // prefix rule now (283 revert).
    expect(parseSkillRule('/claude-ai:*')).toEqual({
      name: 'claude-ai:*',
      prefix: 'claude-ai',
    })
  })

  test('plain matching (official te) is prefix-blind to namespaces', () => {
    expect(skillRuleMatchesPlain('deploy', 'deploy')).toBe(true)
    expect(skillRuleMatchesPlain('deploy', 'deploy-x')).toBe(false)
    expect(
      skillRuleMatchesPlain('anthropic-skills:*', 'anthropic-skills:foo'),
    ).toBe(true)
    // The boundary case: the prefix also string-matches lookalikes.
    expect(
      skillRuleMatchesPlain('anthropic-skills:*', 'anthropic-skillsX:foo'),
    ).toBe(true)
  })

  test('namespace-aware matching (official ke) narrows reserved prefixes', () => {
    // Non-reserved prefix: plain match AND the skill must not sit in a
    // reserved namespace.
    expect(skillRuleMatchesNamespaceAware('my:*', 'my:foo')).toBe(true)
    expect(skillRuleMatchesNamespaceAware('my:*', 'anthropic-skills:foo')).toBe(
      false,
    )
    // 283 revert: claude-ai:* names are ordinary — a non-reserved prefix
    // biting into them matches again (282: false, reserved-namespace veto).
    expect(skillRuleMatchesNamespaceAware('claude:*', 'claude-ai:foo')).toBe(
      true,
    )
    // Bare reserved namespace prefix: only "ns:..." names match — the
    // lookalike "anthropic-skillsX:foo" no longer does.
    expect(
      skillRuleMatchesNamespaceAware(
        'anthropic-skills:*',
        'anthropic-skills:foo',
      ),
    ).toBe(true)
    expect(
      skillRuleMatchesNamespaceAware(
        'anthropic-skills:*',
        'anthropic-skillsX:foo',
      ),
    ).toBe(false)
    expect(
      skillRuleMatchesNamespaceAware(
        'anthropic-skills:*',
        'anthropic-skills',
      ),
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
    // A non-reserved prefix biting into the reserved namespace plain-matches
    // but fails ns-aware matching → boundary hold-back (never an allow).
    expect(
      matchSkillRuleForPermission('anthropic:*', 'anthropic-skills:y'),
    ).toBe('held-back-boundary')
    // Command-name candidate participates (official candidates list).
    expect(
      matchSkillRuleForPermission('my:*', 'invoked', { name: 'my:foo' }),
    ).toBe('allow')
  })

  test('283 revert: Skill(claude-ai:*) is an ordinary prefix rule again', () => {
    // 282 held both of these back; 283 allows them.
    expect(matchSkillRuleForPermission('claude-ai:*', 'claude-ai:y')).toBe(
      'allow',
    )
    expect(matchSkillRuleForPermission('claude-ai:y', 'claude-ai:y')).toBe(
      'allow',
    )
    expect(matchSkillRuleForPermission('claude:*', 'claude-ai:y')).toBe(
      'allow',
    )
    // claude-ai names also no longer poison ordinary rules that cover them.
    expect(matchSkillRuleForPermission('my:*', 'my:claude-ai')).toBe('allow')
  })
})

describe('2.1.283 deny-matcher expansion (official ue/Be/w6/Le/le/dOo/uOo)', () => {
  test('wildcard matcher (official w6): anchored, escaped, multi-*', () => {
    expect(skillRuleMatchesWildcard('deploy', 'deploy')).toBe(true)
    expect(skillRuleMatchesWildcard('deploy', 'deploy-x')).toBe(false)
    expect(skillRuleMatchesWildcard('deploy*', 'deploy-x')).toBe(true)
    expect(skillRuleMatchesWildcard('*deploy', 'xdeploy')).toBe(true)
    expect(skillRuleMatchesWildcard('a*b*c', 'axxbyyc')).toBe(true)
    expect(skillRuleMatchesWildcard('*', 'anything')).toBe(true)
    // Regex metacharacters are literal, not wildcards.
    expect(skillRuleMatchesWildcard('a.b', 'a.b')).toBe(true)
    expect(skillRuleMatchesWildcard('a.b', 'axb')).toBe(false)
    expect(skillRuleMatchesWildcard('a+b?', 'a+b?')).toBe(true)
    expect(skillRuleMatchesWildcard('a+b?', 'aabx')).toBe(false)
  })

  test('skill: rule form (official Be): whitespace-tolerant, case-sensitive, /s', () => {
    expect(skillDenyRuleMatches('skill:evil*', 'evil-x')).toBe(true)
    expect(skillDenyRuleMatches('skill:evil*', 'good')).toBe(false)
    expect(skillDenyRuleMatches(' skill : evil ', 'evil')).toBe(true)
    // Uppercase "Skill:" does NOT match the Be form; it falls through to
    // plain matching, where the literal name "Skill:evil" matches nothing.
    expect(skillDenyRuleMatches('Skill:evil', 'evil')).toBe(false)
  })

  test('ordinary deny candidates: invoked name, registered name, display name, aliases, unqualifiedName', () => {
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
    // New in 283 (official Le): a prompt's unqualifiedName is a candidate.
    expect(
      skillDenyRuleMatches('evil', 'invoked', {
        type: 'prompt',
        name: 'other',
        unqualifiedName: 'evil',
      }),
    ).toBe(true)
    // ...but only for prompts.
    expect(
      skillDenyRuleMatches('evil', 'invoked', {
        type: 'local',
        name: 'other',
        unqualifiedName: 'evil',
      }),
    ).toBe(false)
    expect(skillDenyRuleMatches('good', 'bad', { name: 'other' })).toBe(false)
  })

  test('denyMatchCandidates (official Le) splits ordinary and packaging', () => {
    expect(denyMatchCandidates('invoked')).toEqual({
      ordinary: ['invoked'],
      packaging: [],
    })
    const { ordinary, packaging } = denyMatchCandidates('invoked', {
      type: 'prompt',
      name: 'reg',
      aliases: ['a1'],
      unqualifiedName: 'uq',
      userFacingName: () => 'disp',
    })
    expect(ordinary).toEqual(['invoked', 'reg', 'disp', 'a1', 'uq'])
    expect(packaging).toEqual([])
  })

  test('plugin packaging aliases (official dOo): self-namespaced plugin skills', () => {
    const command = {
      type: 'prompt',
      name: 'foo:foo',
      loadedFrom: 'plugin',
      aliases: ['foo', 'x'],
    }
    // The reserved form and the bare short name both deny.
    expect(skillDenyRuleMatches('anthropic-skills:foo', 'foo:foo', command)).toBe(
      true,
    )
    expect(skillDenyRuleMatches('foo', 'foo:foo', command)).toBe(true)
    // Aliases map into the reserved namespace (alias === short is skipped).
    expect(
      skillDenyRuleMatches('anthropic-skills:x', 'foo:foo', command),
    ).toBe(true)
    // The candidates split shows the full expansion.
    expect(denyMatchCandidates('foo:foo', command).packaging).toEqual([
      'anthropic-skills:foo',
      'foo',
      'anthropic-skills:x',
    ])
  })

  test('plugin packaging aliases: tail form when the display name unpacks differently', () => {
    const command = {
      type: 'prompt',
      name: 'foo:bar',
      loadedFrom: 'plugin',
      userFacingName: () => 'baz:baz',
    }
    // short = 'baz' (from the display name); tail = 'bar' ≠ short → both
    // tail forms join the packaging candidates.
    expect(denyMatchCandidates('foo:bar', command).packaging).toEqual([
      'anthropic-skills:baz',
      'baz',
      'anthropic-skills:bar',
      'bar',
    ])
    expect(skillDenyRuleMatches('bar', 'foo:bar', command)).toBe(true)
  })

  test('synced packaging aliases (official uOo): reserved-namespace skills', () => {
    const synced = {
      type: 'prompt',
      name: 'anthropic-skills:foo',
      loadedFrom: 'syncedSkills',
    }
    expect(denyMatchCandidates('invoked', synced).packaging).toEqual([
      'foo:foo',
    ])
    expect(
      skillDenyRuleMatches('foo:foo', 'invoked', synced),
    ).toBe(true)
    // A different display name inside the namespace adds its forms.
    const renamedDisplay = {
      ...synced,
      userFacingName: () => 'anthropic-skills:bar',
    }
    expect(
      denyMatchCandidates('invoked', renamedDisplay).packaging,
    ).toEqual(['foo:foo', 'bar:bar', 'bar:foo', 'bar'])
    expect(
      skillDenyRuleMatches('bar:foo', 'invoked', renamedDisplay),
    ).toBe(true)
    // Nested reserved names (short contains ':') produce no packaging forms.
    expect(
      denyMatchCandidates('invoked', {
        name: 'anthropic-skills:a:b',
        loadedFrom: 'syncedSkills',
      }).packaging,
    ).toEqual([])
  })

  test('packaging candidates: prefix rules only match when the prefix equals the candidate', () => {
    const command = {
      type: 'prompt',
      name: 'foo:foo',
      loadedFrom: 'plugin',
    }
    // Exact (prefix-free) rule → packaging match allowed.
    expect(
      skillDenyRuleMatches('anthropic-skills:foo', 'foo:foo', command),
    ).toBe(true)
    // Prefix rule 'anthropic-skills:*' plain-matches the packaging candidate
    // but prefix ≠ candidate → NO packaging match (official te-branch guard;
    // Desktop hosts would be exempt — isDesktopHostSession() ≡ false in OCC).
    expect(
      skillDenyRuleMatches('anthropic-skills:*', 'foo:foo', command),
    ).toBe(false)
  })

  test('skill: form wildcard patterns never reach packaging candidates (non-Desktop)', () => {
    const command = {
      type: 'prompt',
      name: 'foo:foo',
      loadedFrom: 'plugin',
    }
    // Wildcard-free skill: pattern matches the packaging alias...
    expect(
      skillDenyRuleMatches('skill:anthropic-skills:foo', 'foo:foo', command),
    ).toBe(true)
    // ...but a wildcard pattern does not (official: packaging only when the
    // pattern has no '*' or the session is a Desktop host — yu ≡ false).
    expect(
      skillDenyRuleMatches('skill:anthropic-skills:*', 'foo:foo', command),
    ).toBe(false)
    // Wildcard patterns still match ordinary candidates.
    expect(skillDenyRuleMatches('skill:foo:*', 'foo:foo', command)).toBe(true)
  })

  test('Desktop-host and untrusted-plugin seams are structurally false in OCC', async () => {
    const { isDesktopHostSession, isUntrustedPluginDelivery } = await import(
      '../reservedNames.js'
    )
    expect(isDesktopHostSession()).toBe(false)
    expect(
      isUntrustedPluginDelivery({ name: 'foo:foo', loadedFrom: 'plugin' }),
    ).toBe(false)
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
      buildHeldBackRuleMessage('deploy', 'anthropic-skills:y', {
        kind: 'boundary',
      }),
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
    expect(message).toBe(`Execute skill: anthropic-skills:foo — ${reason}`)
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
      {
        skill: { type: 'prompt', name: 'deploy', source: 'user' },
        filePath: '/proj/.claude/skills/deploy/SKILL.md',
      },
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

  test('283 revert: claude-ai:* skills load again, silently', () => {
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
          userFacingName: () => 'claude-ai:z',
        },
        filePath: '/proj/.claude/commands/innocent.md',
      },
    ] as Parameters<typeof filterRefusedReservedNames>[0])
    expect(kept).toHaveLength(2)
    expect(debugLogs).toHaveLength(0)
    expect(getRefusedReservedNames()).toEqual([])
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
        skill: {
          type: 'prompt',
          name: 'innocent',
          source: 'project',
          userFacingName: () => 'anthropic-skills:y',
        },
        filePath: '/proj/.claude/commands/innocent.md',
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
      kind_path: 1,
      kind_frontmatter_name: 1,
    })
    // 283 revert: no claude-ai namespace counter is emitted anymore.
    expect(events[0].metadata.ns_claude_ai).toBeUndefined()
  })

  test('held-back telemetry: once per kind with official action names (no renamed kind in 283)', () => {
    logHeldBackRuleTelemetry('nonholder')
    logHeldBackRuleTelemetry('nonholder')
    logHeldBackRuleTelemetry('boundary')
    expect(events).toHaveLength(2)
    expect(events[0].metadata).toMatchObject({
      action: 'nonholder_allow_rule',
      host_prompt: false,
    })
    expect(events[1].metadata).toMatchObject({
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
    // 283 revert: a server named claude-ai is ordinary again.
    expect(isReservedMcpServerName('claude-ai')).toBe(false)
    expect(isReservedMcpServerName('CLAUDE-AI')).toBe(false)
    expect(isReservedMcpServerName('my-server')).toBe(false)
    plaidHarbor = false
    expect(isReservedMcpServerName('anthropic-skills')).toBe(false)
  })

  test('skills funnel message is byte-exact', () => {
    expect(reservedMcpServerSkillsMessage('anthropic-skills')).toBe(
      `Skills not loaded: the server name ${REASON_ANTHROPIC}. Rename the server in your MCP configuration to load its skills and prompts; its tools are unaffected.`,
    )
  })

  test('per-prompt message is byte-exact (plural fallback reason)', () => {
    expect(reservedMcpPromptMessage('anthropic-skills:summarize')).toBe(
      `Prompt 'anthropic-skills:summarize' not listed: the server name ${REASON_FALLBACK}. Rename the server in your MCP configuration to list its prompts.`,
    )
  })

  test('fetchMcpSkillsForClient stub logs the funnel message for reserved server names', async () => {
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
      const reserved = await fetchMcpSkillsForClient({
        name: 'anthropic-skills',
      })
      expect(reserved).toEqual([])
      expect(mcpLogs).toHaveLength(1)
      expect(mcpLogs[0].server).toBe('anthropic-skills')
      expect(mcpLogs[0].message).toBe(
        reservedMcpServerSkillsMessage('anthropic-skills'),
      )
      // 283 revert: a claude-ai server does not trigger the funnel log.
      const claudeAi = await fetchMcpSkillsForClient({ name: 'claude-ai' })
      expect(claudeAi).toEqual([])
      expect(mcpLogs).toHaveLength(1)
    } finally {
      mock.module('../../../utils/log.js', () => ({ ...actualLog }))
    }
  })

  test('client prompt gate: reserved server drops prompts, tools untouched, claude-ai server lists prompts', () => {
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
    // 283 revert: claude-ai servers list their prompts again.
    expect(gate('claude-ai', ['summarize'])).toEqual([
      'mcp__claude-ai__summarize',
    ])
    expect(gate('my-claude-ai', ['summarize'])).toEqual([
      'mcp__my-claude-ai__summarize',
    ])
    expect(gate('github', ['list_prs'])).toEqual(['mcp__github__list_prs'])

    // Gate off → reserved server prompts list again.
    plaidHarbor = false
    expect(gate('anthropic-skills', ['summarize'])).toEqual([
      'mcp__anthropic-skills__summarize',
    ])
  })
})
