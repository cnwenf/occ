/**
 * CC 2.1.283 — SkillTool.checkPermissions integration for the reserved
 * anthropic-skills namespace hardening (after the claude-ai revert) and the
 * 283 deny-matcher expansion.
 *
 * Official order (byte-extracted from BOTH the v2.1.282 ELF @208603xxx and the
 * v2.1.283 ELF @210645xxx — unchanged by the revert): deny(ue, with the 283
 * skill:/wildcard/packaging expansion) → allow(ye, held-back tracking:
 * nonholder overwrites, boundary first-wins) → safe-props auto-allow →
 * squatter ask (suppressAlwaysAllowRule + `Execute skill: X — reason`) →
 * default ask with suggestions. A squatter is a reserved-name skill that is
 * NOT synced from the user's claude.ai account; it can never be pre-approved
 * by a Skill(...) rule and asks every time with suppressAlwaysAllowRule:true
 * so the UI cannot persist an allow rule.
 *
 * 283 revert: claude-ai:* skills are ordinary again — Skill(claude-ai:*)
 * allows them like any other prefix rule (flipped tests below).
 *
 * The test skills carry an `allowedTools` property so they fail the
 * safe-properties auto-allow (which legitimately precedes the squatter check
 * in the official order) and reach the ask paths. The RT② pinning tests below
 * cover the complementary case: a squatter with ONLY safe properties is
 * auto-allowed silently — official-order parity, byte-verified against the
 * official ELF (see the ORDER NOTE in SkillTool.ts checkPermissions).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { Command } from '../../../types/command.js'

// OCC-97: snapshot real exports BEFORE mocking; restore in afterAll.
const actualCommands = { ...(await import('../../../commands.js')) }
const actualGrowthbook = {
  ...(await import('../../../services/analytics/growthbook.js')),
}

/** Command list returned by the mocked getCommands, set per test. */
let mockedCommands: Command[] = []
/** Drives tengu_plaid_harbor (official Bge); undefined → default true. */
let plaidHarbor: boolean | undefined

function skillCommand(name: string, source = 'user'): Command {
  return {
    type: 'prompt',
    name,
    source,
    description: '',
    // Unsafe property → skips the safe-properties auto-allow so the ask /
    // squatter paths are reachable.
    allowedTools: ['Bash(echo:*)'],
    getPromptForCommand: async () => '',
  } as unknown as Command
}

mock.module('../../../commands.js', () => ({
  ...actualCommands,
  getCommands: async () => mockedCommands,
}))

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

afterAll(() => {
  mock.module('../../../commands.js', () => ({ ...actualCommands }))
  mock.module('../../../services/analytics/growthbook.js', () => ({
    ...actualGrowthbook,
  }))
})

const { SkillTool } = await import('../SkillTool.js')

function makeContext(allowRules: string[] = [], denyRules: string[] = []) {
  const permissionContext = {
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: { userSettings: allowRules },
    alwaysDenyRules: { userSettings: denyRules },
  }
  return {
    getAppState: () => ({
      toolPermissionContext: permissionContext,
      mcp: { commands: [] },
    }),
  } as unknown as ToolUseContext
}

async function checkPermissions(
  skill: string,
  context: ToolUseContext,
): Promise<Record<string, unknown>> {
  const decision = await SkillTool.checkPermissions(
    { skill, args: '' },
    context,
  )
  return decision as unknown as Record<string, unknown>
}

const HELD_NONHOLDER =
  'Skill(anthropic-skills:*) only covers skills synced from your claude.ai account. anthropic-skills:foo is not synced, so no rule for that name can pre-approve it; it needs approval each time.'
const HELD_BOUNDARY =
  'Skill(anthropic-skills:*) only covers names starting with "anthropic-skills:". Add Skill(anthropic-skillsX:foo) to allow anthropic-skillsX:foo without asking.'

beforeEach(() => {
  mockedCommands = []
  plaidHarbor = undefined
})

describe('2.1.283 SkillTool.checkPermissions reserved-namespace hardening', () => {
  test('squatter + Skill(anthropic-skills:*) rule → ask, suppressAlwaysAllowRule, exact message', async () => {
    mockedCommands = [skillCommand('anthropic-skills:foo')]
    const decision = await checkPermissions(
      'anthropic-skills:foo',
      makeContext(['Skill(anthropic-skills:*)']),
    )
    expect(decision.behavior).toBe('ask')
    expect(decision.suppressAlwaysAllowRule).toBe(true)
    expect(decision.message).toBe(
      `Execute skill: anthropic-skills:foo — ${HELD_NONHOLDER}`,
    )
    expect(decision.decisionReason).toEqual({
      type: 'other',
      reason: HELD_NONHOLDER,
    })
    // The squatter ask must NOT offer add-rule suggestions (nothing can be
    // persisted for a reserved name).
    expect(decision.suggestions).toBeUndefined()
  })

  test('squatter without any rule → ask, suppressAlwaysAllowRule, bare message', async () => {
    mockedCommands = [skillCommand('anthropic-skills:y')]
    const decision = await checkPermissions('anthropic-skills:y', makeContext([]))
    expect(decision.behavior).toBe('ask')
    expect(decision.suppressAlwaysAllowRule).toBe(true)
    expect(decision.message).toBe('Execute skill: anthropic-skills:y')
    expect(decision.decisionReason).toBeUndefined()
  })

  test('squatter detection is case-insensitive', async () => {
    mockedCommands = [skillCommand('ANTHROPIC-SKILLS:y')]
    const decision = await checkPermissions('ANTHROPIC-SKILLS:y', makeContext([]))
    expect(decision.behavior).toBe('ask')
    expect(decision.suppressAlwaysAllowRule).toBe(true)
  })

  test('283 revert: Skill(claude-ai:*) is an ordinary prefix rule → allow', async () => {
    // 282 held this back as a reserved-name squatter; 283 reverted the
    // claude-ai reservation (zAe single element), so the rule pre-approves.
    mockedCommands = [skillCommand('claude-ai:y')]
    const decision = await checkPermissions(
      'claude-ai:y',
      makeContext(['Skill(claude-ai:*)']),
    )
    expect(decision.behavior).toBe('allow')
    expect(decision.decisionReason).toMatchObject({ type: 'rule' })
    expect(decision.suppressAlwaysAllowRule).toBeUndefined()
  })

  test('283 revert: claude-ai skill without a rule → default ask with suggestions (no suppression)', async () => {
    mockedCommands = [skillCommand('claude-ai:y')]
    const decision = await checkPermissions('claude-ai:y', makeContext([]))
    expect(decision.behavior).toBe('ask')
    expect(decision.message).toBe('Execute skill: claude-ai:y')
    expect(decision.suppressAlwaysAllowRule).toBeUndefined()
    expect(Array.isArray(decision.suggestions)).toBe(true)
  })

  test('gate off → reserved rule allows like plain matching (no squatter ask)', async () => {
    plaidHarbor = false
    mockedCommands = [skillCommand('anthropic-skills:foo')]
    const decision = await checkPermissions(
      'anthropic-skills:foo',
      makeContext(['Skill(anthropic-skills:*)']),
    )
    expect(decision.behavior).toBe('allow')
    expect(decision.suppressAlwaysAllowRule).toBeUndefined()
  })

  test('boundary lookalike: plain-matching rule is held back but the ask keeps suggestions', async () => {
    mockedCommands = [skillCommand('anthropic-skillsX:foo')]
    const decision = await checkPermissions(
      'anthropic-skillsX:foo',
      makeContext(['Skill(anthropic-skills:*)']),
    )
    expect(decision.behavior).toBe('ask')
    // NOT a squatter (the name is outside the reserved namespace) — the user
    // may persist a rule for it, so suggestions stay and no suppression.
    expect(decision.suppressAlwaysAllowRule).toBeUndefined()
    expect(Array.isArray(decision.suggestions)).toBe(true)
    expect(decision.message).toBe(
      `Execute skill: anthropic-skillsX:foo — ${HELD_BOUNDARY}`,
    )
    expect(decision.decisionReason).toEqual({
      type: 'other',
      reason: HELD_BOUNDARY,
    })
  })

  test('non-reserved skills are unaffected: exact rule allows', async () => {
    mockedCommands = [skillCommand('deploy')]
    const decision = await checkPermissions(
      'deploy',
      makeContext(['Skill(deploy)']),
    )
    expect(decision.behavior).toBe('allow')
    expect(decision.decisionReason).toMatchObject({ type: 'rule' })
  })

  test('non-reserved skills are unaffected: no rule → default ask with suggestions', async () => {
    mockedCommands = [skillCommand('my-plugin:build')]
    const decision = await checkPermissions('my-plugin:build', makeContext([]))
    expect(decision.behavior).toBe('ask')
    expect(decision.message).toBe('Execute skill: my-plugin:build')
    expect(decision.suppressAlwaysAllowRule).toBeUndefined()
    expect(Array.isArray(decision.suggestions)).toBe(true)
  })

  test('plugin-sourced prompt with a reserved name: held back, not squatter-suppressed', async () => {
    // Official Xot: plugin prompts legitimately hold reserved names — the
    // loader keeps them. At permission time a matching rule still can't
    // pre-approve a non-holder reserved name (ye holds it back), but with no
    // squatter status the ask keeps suggestions.
    mockedCommands = [skillCommand('anthropic-skills:helper', 'plugin')]
    const decision = await checkPermissions(
      'anthropic-skills:helper',
      makeContext(['Skill(anthropic-skills:*)']),
    )
    expect(decision.behavior).toBe('ask')
  })

  test('RT② pinning: squatter with ONLY safe properties is auto-allowed before the squatter ask (official-order parity)', async () => {
    // Official checkPermissions (byte-extracted from the v2.1.282 AND
    // v2.1.283 ELFs — identical order): the safe-properties auto-allow
    // `if(a?.type==="prompt"&&(je(a)||Pfe(s)))return{behavior:"allow",...}`
    // (283: `en(l)||Pge(n)`) fires BEFORE the squatter computation
    // `N=Nfe()&&wU(l)&&!(a!==void 0&&iZ(a))` (283: `U=Bge()&&jB(a)&&...`)
    // and its forced ask with suppressAlwaysAllowRule. So a squatted
    // reserved-namespace skill whose frontmatter carries ONLY safe properties
    // (no allowedTools) is silently auto-allowed — the hole exists in the
    // official binary itself, and OCC mirrors the official order rather than
    // inventing extra hardening. This test pins the parity: any reorder
    // (ours or upstream's) must flip it deliberately. All other squatter
    // tests above inject allowedTools precisely to bypass this branch and
    // exercise the ask paths.
    const safeSquatter = {
      type: 'prompt',
      name: 'anthropic-skills:innocent',
      source: 'user',
      description: '',
      getPromptForCommand: async () => '',
    } as unknown as Command
    mockedCommands = [safeSquatter]
    const decision = await checkPermissions(
      'anthropic-skills:innocent',
      makeContext([]),
    )
    expect(decision.behavior).toBe('allow')
    expect(decision.suppressAlwaysAllowRule).toBeUndefined()
    expect(decision.decisionReason).toBeUndefined()
  })

  test('RT② boundary: one unsafe property (allowedTools) drops the squatter into the forced ask', async () => {
    const unsafeSquatter = {
      type: 'prompt',
      name: 'anthropic-skills:innocent',
      source: 'user',
      description: '',
      allowedTools: ['Bash(echo:*)'],
      getPromptForCommand: async () => '',
    } as unknown as Command
    mockedCommands = [unsafeSquatter]
    const decision = await checkPermissions(
      'anthropic-skills:innocent',
      makeContext([]),
    )
    expect(decision.behavior).toBe('ask')
    expect(decision.suppressAlwaysAllowRule).toBe(true)
    expect(decision.message).toBe('Execute skill: anthropic-skills:innocent')
  })

  test('deny rules still win over everything', async () => {
    mockedCommands = [skillCommand('anthropic-skills:foo')]
    const decision = await checkPermissions(
      'anthropic-skills:foo',
      makeContext(
        ['Skill(anthropic-skills:*)'],
        ['Skill(anthropic-skills:foo)'],
      ),
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toBe('Skill execution blocked by permission rules')
  })

  test('283 deny expansion: skill:<pattern> wildcard deny rule', async () => {
    // Official Be form inside the rule content: Skill(skill:evil*) denies
    // any invocation whose candidates match the wildcard pattern evil*.
    mockedCommands = [skillCommand('evil-x')]
    const decision = await checkPermissions(
      'evil-x',
      makeContext(['Skill(evil*)'], ['Skill(skill:evil*)']),
    )
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toBe('Skill execution blocked by permission rules')
    // A non-matching invocation is unaffected by the deny rule.
    mockedCommands = [skillCommand('good')]
    const allowed = await checkPermissions(
      'good',
      makeContext(['Skill(good)'], ['Skill(skill:evil*)']),
    )
    expect(allowed.behavior).toBe('allow')
  })

  test('283 deny expansion: packaging alias denies a self-namespaced plugin skill', async () => {
    // Official dOo/le: a plugin-delivered "foo:foo" skill is also deniable
    // under its packaging alias "anthropic-skills:foo" (the exact-rule form;
    // prefix rules do not reach packaging candidates on non-Desktop hosts).
    const pluginCommand = {
      type: 'prompt',
      name: 'foo:foo',
      source: 'plugin',
      loadedFrom: 'plugin',
      description: '',
      allowedTools: ['Bash(echo:*)'],
      getPromptForCommand: async () => '',
    } as unknown as Command
    mockedCommands = [pluginCommand]
    const denied = await checkPermissions(
      'foo:foo',
      makeContext([], ['Skill(anthropic-skills:foo)']),
    )
    expect(denied.behavior).toBe('deny')
    // The prefix form does NOT deny (packaging candidates require an exact
    // rule — official te-branch prefix guard, yu ≡ false in OCC).
    const notDenied = await checkPermissions(
      'foo:foo',
      makeContext([], ['Skill(anthropic-skills:*)']),
    )
    expect(notDenied.behavior).not.toBe('deny')
  })

  test('leading slash is stripped before matching', async () => {
    mockedCommands = [skillCommand('anthropic-skills:foo')]
    const decision = await checkPermissions(
      '/anthropic-skills:foo',
      makeContext([]),
    )
    expect(decision.behavior).toBe('ask')
    expect(decision.suppressAlwaysAllowRule).toBe(true)
    expect(decision.message).toBe('Execute skill: anthropic-skills:foo')
  })
})
