/**
 * CC 2.1.282 bullets (b)(c)(d) — anthropic-skills / claude-ai reserved
 * namespace hardening.
 *
 * Official cluster (v2.1.282 linux-x64 ELF, byte-extracted):
 *   - ITe   RESERVED_NAMESPACES = ["anthropic-skills","claude-ai"]
 *   - Nfe   plaid-harbor gate: x("tengu_plaid_harbor", true) !== false
 *   - wU    isReservedName (via Yot reservedNamespaceOf)
 *   - dFn   isSquatter; Xot shouldRefuseReservedName (plugin prompts exempt)
 *   - kOe/nse/v$o/BGo loader drop + warn + telemetry
 *   - le/W/ae/de/ke skill-rule parse/match/held-back classification
 *   - ue    held-back rule message; squatter ask `Execute skill: X — reason`
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

/** Drives the tengu_plaid_harbor gate (official Nfe). */
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

const REASON_CLAUDE_AI =
  'uses "claude-ai", a name reserved for the skills synced from your claude.ai account'
const REASON_ANTHROPIC =
  'uses "anthropic-skills", a name reserved for the skills synced from your claude.ai account'

describe('2.1.282 reserved namespaces: detection', () => {
  test('RESERVED_NAMESPACES matches official ITe', () => {
    expect([...RESERVED_NAMESPACES]).toEqual(['anthropic-skills', 'claude-ai'])
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
    expect(isReservedName('claude-ai')).toBe(true)
    expect(isReservedName('anthropic-skills:foo')).toBe(true)
    expect(isReservedName('claude-ai:y')).toBe(true)
    expect(isReservedName('CLAUDE-AI:Y')).toBe(true)
    expect(isReservedName('Anthropic-Skills:Deep:X')).toBe(true)
    expect(reservedNamespaceOf('CLAUDE-AI:Y')).toBe('claude-ai')
    expect(reservedNamespaceOf('  anthropic-skills:x  ')).toBe(
      'anthropic-skills',
    )
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
    expect(hasReservedNamespacePrefix('claude-ai:')).toBe(true)
    expect(hasReservedNamespacePrefix('claude-ai')).toBe(false)
    expect(hasReservedNamespacePrefix('anthropic-skills:x')).toBe(true)
  })

  test('reservedNameReason: singular for a resolvable name, plural fallback otherwise', () => {
    expect(reservedNameReason('claude-ai:y')).toBe(REASON_CLAUDE_AI)
    expect(reservedNameReason('anthropic-skills')).toBe(REASON_ANTHROPIC)
    expect(reservedNameReason('innocent')).toBe(
      'uses "anthropic-skills" or "claude-ai", the names reserved for the skills synced from your claude.ai account',
    )
    expect(RESERVED_NAMES_REASON_FALLBACK).toBe(
      'uses "anthropic-skills" or "claude-ai", the names reserved for the skills synced from your claude.ai account',
    )
    // First resolvable name wins (official AMe scans in order).
    expect(reservedNameReason('innocent', 'anthropic-skills:a')).toBe(
      REASON_ANTHROPIC,
    )
  })
})

describe('2.1.282 reserved namespaces: squatter / refusal predicates', () => {
  test('synced-skill holders are never squatters', () => {
    const holder = { name: 'claude-ai:y', loadedFrom: 'syncedSkills' }
    expect(isSyncedSkillHolder(holder)).toBe(true)
    expect(isSquatter(holder)).toBe(false)
    const wrapper = {
      type: 'prompt',
      name: 'claude-ai:y',
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
        userFacingName: () => 'claude-ai:y',
      }),
    ).toBe(true)
    expect(isSquatter({ type: 'prompt', name: 'deploy', source: 'user' })).toBe(
      false,
    )
  })

  test('shouldRefuseReservedName: plugin-sourced prompts are exempt', () => {
    const pluginPrompt = {
      type: 'prompt',
      name: 'claude-ai:y',
      source: 'plugin',
    }
    expect(shouldRefuseReservedName(pluginPrompt)).toBe(false)
    // Same reserved name from a non-plugin source IS refused.
    expect(
      shouldRefuseReservedName({ type: 'prompt', name: 'claude-ai:y', source: 'user' }),
    ).toBe(true)
    expect(shouldRefuseReservedName({ name: 'claude-ai:y' })).toBe(true)
    // Non-reserved names are never refused.
    expect(shouldRefuseReservedName({ type: 'prompt', name: 'deploy', source: 'user' })).toBe(
      false,
    )
    // Gate off → nothing refused.
    plaidHarbor = false
    expect(
      shouldRefuseReservedName({ type: 'prompt', name: 'claude-ai:y', source: 'user' }),
    ).toBe(false)
  })
})

describe('2.1.282 reserved namespaces: skill-rule matching (official le/W/ae/ke)', () => {
  test('parseSkillRule strips leading slash and decodes :* / " *" prefixes', () => {
    expect(parseSkillRule('deploy')).toEqual({ name: 'deploy' })
    expect(parseSkillRule('/deploy')).toEqual({ name: 'deploy' })
    expect(parseSkillRule('anthropic-skills:*')).toEqual({
      name: 'anthropic-skills:*',
      prefix: 'anthropic-skills',
    })
    expect(parseSkillRule('foo *')).toEqual({ name: 'foo *', prefix: 'foo' })
    expect(parseSkillRule('/claude-ai:*')).toEqual({
      name: 'claude-ai:*',
      prefix: 'claude-ai',
    })
  })

  test('plain matching (official W) is prefix-blind to namespaces', () => {
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

  test('namespace-aware matching (official ae) narrows reserved prefixes', () => {
    // Non-reserved prefix: plain match AND the skill must not sit in a
    // reserved namespace.
    expect(skillRuleMatchesNamespaceAware('my:*', 'my:foo')).toBe(true)
    expect(skillRuleMatchesNamespaceAware('my:*', 'claude-ai:foo')).toBe(false)
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

  test('matchSkillRuleForPermission (official ke): gate off falls back to plain matching', () => {
    plaidHarbor = false
    expect(
      matchSkillRuleForPermission('anthropic-skills:*', 'anthropic-skills:foo'),
    ).toBe('allow')
    expect(
      matchSkillRuleForPermission('anthropic-skills:*', 'anthropic-skillsX:foo'),
    ).toBe('allow')
    expect(matchSkillRuleForPermission('deploy', 'other')).toBe('no-match')
  })

  test('ke: gate on — reserved names are held back, ordinary names allowed', () => {
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
    // Exact rule for a reserved name: still held back for non-holders.
    expect(matchSkillRuleForPermission('claude-ai:y', 'claude-ai:y')).toBe(
      'held-back-nonholder',
    )
    // No relationship → no-match.
    expect(matchSkillRuleForPermission('deploy', 'build')).toBe('no-match')
    // A non-reserved prefix biting into the reserved namespace plain-matches
    // but fails ns-aware matching → boundary hold-back (never an allow).
    expect(matchSkillRuleForPermission('claude:*', 'claude-ai:y')).toBe(
      'held-back-boundary',
    )
    // Command-name candidate participates (official candidates list).
    expect(
      matchSkillRuleForPermission('my:*', 'invoked', { name: 'my:foo' }),
    ).toBe('allow')
  })

  test('skillDenyRuleMatches (official de subset): name, registered name, display name, aliases', () => {
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
})

describe('2.1.282 reserved namespaces: messages (official ue + squatter ask)', () => {
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
      buildHeldBackRuleMessage('claude-ai:*', 'claude-ai:y', {
        kind: 'nonholder',
        pluginName: 'my-plugin',
      }),
    ).toBe(
      'Skill(claude-ai:*) only covers skills synced from your claude.ai account. claude-ai:y comes from the plugin "my-plugin", so no rule for that name can pre-approve it; it needs approval each time.',
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
      buildHeldBackRuleMessage('deploy', 'claude-ai:y', { kind: 'boundary' }),
    ).toBe(
      'Skill(deploy) does not cover "claude-ai:" names, which are reserved for skills synced from your claude.ai account. Add Skill(claude-ai:y) to allow claude-ai:y without asking.',
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

describe('2.1.282 reserved namespaces: loader refusal (official kOe/nse/v$o/BGo)', () => {
  test('reservedOffendingPath walks up to the offending namespace folder', () => {
    expect(
      reservedOffendingPath(
        '/proj/.claude/skills/anthropic-skills/x/SKILL.md',
        'anthropic-skills:x',
      ),
    ).toBe('/proj/.claude/skills/anthropic-skills')
    // Non-SKILL.md command file: start is the file itself, .md stripped.
    expect(
      reservedOffendingPath('/proj/.claude/commands/claude-ai/y.md', 'claude-ai:y'),
    ).toBe('/proj/.claude/commands/claude-ai')
    // Name not reconstructible from ancestors → returns the start dir.
    expect(
      reservedOffendingPath('/proj/skills/a/b/SKILL.md', 'claude-ai:z'),
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

  test('command claude-ai:y via display name is dropped with the frontmatter-name warn', () => {
    const kept = filterRefusedReservedNames([
      {
        skill: {
          type: 'prompt',
          name: 'innocent',
          source: 'user',
          userFacingName: () => 'claude-ai:y',
        },
        filePath: '/proj/.claude/commands/innocent.md',
      },
    ] as Parameters<typeof filterRefusedReservedNames>[0])
    expect(kept).toHaveLength(0)
    expect(debugLogs[0].message).toBe(
      `[skills] not loading "claude-ai:y" (/proj/.claude/commands/innocent.md): that name ${REASON_CLAUDE_AI}; change its name: line`,
    )
  })

  test('plugin-sourced prompt with a reserved name still loads', () => {
    const kept = filterRefusedReservedNames([
      {
        skill: { type: 'prompt', name: 'claude-ai:y', source: 'plugin' },
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
        skill: { type: 'prompt', name: 'claude-ai:y', source: 'user' },
        filePath: '/proj/.claude/skills/claude-ai/y/SKILL.md',
      },
    ] as Parameters<typeof filterRefusedReservedNames>[0])
    expect(kept).toHaveLength(1)
  })

  test('warn dedupes once per path/name/change; workflow label variant', () => {
    warnReservedNameRefused({ name: 'claude-ai:y', path: '/p', change: 'path' })
    warnReservedNameRefused({ name: 'claude-ai:y', path: '/p', change: 'path' })
    expect(debugLogs).toHaveLength(1)
    warnReservedNameRefused({
      name: 'claude-ai:z',
      path: '/q',
      change: 'workflow-name',
    })
    expect(debugLogs).toHaveLength(2)
    expect(debugLogs[1].message).toBe(
      `[skills] not loading workflow "claude-ai:z" (/q): that name ${REASON_CLAUDE_AI}; rename it`,
    )
  })

  test('names_refused telemetry: once per session with ns/kind counters', () => {
    filterRefusedReservedNames([
      {
        skill: { type: 'prompt', name: 'anthropic-skills:x', source: 'user' },
        filePath: '/proj/.claude/skills/anthropic-skills/x/SKILL.md',
      },
      {
        skill: { type: 'prompt', name: 'claude-ai:y', source: 'project' },
        filePath: '/proj/.claude/skills/claude-ai/y/SKILL.md',
      },
    ] as Parameters<typeof filterRefusedReservedNames>[0])
    logReservedNamesRefusedTelemetry()
    logReservedNamesRefusedTelemetry()
    expect(events).toHaveLength(1)
    expect(events[0].name).toBe('skill_reserved_namespace')
    expect(events[0].metadata).toMatchObject({
      action: 'names_refused',
      refused: 2,
      ns_anthropic_skills: 1,
      ns_claude_ai: 1,
      kind_path: 2,
    })
  })

  test('held-back telemetry: once per kind with official action names', () => {
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

describe('2.1.282 reserved namespaces: MCP server-name gates', () => {
  test('server named claude-ai: skills refused with the exact funnel message', () => {
    expect(isReservedMcpServerName('claude-ai')).toBe(true)
    expect(isReservedMcpServerName('anthropic-skills')).toBe(true)
    expect(isReservedMcpServerName('CLAUDE-AI')).toBe(true)
    expect(isReservedMcpServerName('claude-ai-tools')).toBe(false)
    expect(isReservedMcpServerName('my-server')).toBe(false)
    plaidHarbor = false
    expect(isReservedMcpServerName('claude-ai')).toBe(false)
  })

  test('skills funnel message is byte-exact', () => {
    expect(reservedMcpServerSkillsMessage('claude-ai')).toBe(
      `Skills not loaded: the server name ${REASON_CLAUDE_AI}. Rename the server in your MCP configuration to load its skills and prompts; its tools are unaffected.`,
    )
  })

  test('per-prompt message is byte-exact (plural fallback reason)', () => {
    expect(reservedMcpPromptMessage('claude-ai:summarize')).toBe(
      "Prompt 'claude-ai:summarize' not listed: the server name uses \"anthropic-skills\" or \"claude-ai\", the names reserved for the skills synced from your claude.ai account. Rename the server in your MCP configuration to list its prompts.",
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
      const reserved = await fetchMcpSkillsForClient({ name: 'claude-ai' })
      expect(reserved).toEqual([])
      expect(mcpLogs).toHaveLength(1)
      expect(mcpLogs[0].server).toBe('claude-ai')
      expect(mcpLogs[0].message).toBe(reservedMcpServerSkillsMessage('claude-ai'))
      // A renamed (non-reserved) server does not trigger the funnel log.
      const renamed = await fetchMcpSkillsForClient({ name: 'my-claude-ai' })
      expect(renamed).toEqual([])
      expect(mcpLogs).toHaveLength(1)
    } finally {
      mock.module('../../../utils/log.js', () => ({ ...actualLog }))
    }
  })

  test('client prompt gate: reserved server drops prompts, tools untouched, renamed server lists prompts', () => {
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

    expect(gate('claude-ai', ['summarize', 'review'])).toEqual([])
    expect(debugLogs).toHaveLength(2)
    expect(debugLogs[0].message).toBe(
      reservedMcpPromptMessage('mcp__claude-ai__summarize'),
    )
    expect(gate('anthropic-skills', ['x'])).toEqual([])
    expect(gate('my-claude-ai', ['summarize'])).toEqual([
      'mcp__my-claude-ai__summarize',
    ])
    expect(gate('github', ['list_prs'])).toEqual(['mcp__github__list_prs'])

    // Gate off → reserved server prompts list again.
    plaidHarbor = false
    expect(gate('claude-ai', ['summarize'])).toEqual([
      'mcp__claude-ai__summarize',
    ])
  })
})
