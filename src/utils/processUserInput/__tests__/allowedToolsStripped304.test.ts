// CC 2.1.304 #61 — a skill's allowed-tools are STRIPPED when its declared
// hooks were kept out of the session (org plugins-only policy, or the #60
// bounds ledger refused them), and the official model-facing `kt` notice is
// appended as an isMeta user message alongside the skill body.
//
// Official reference (docs/gap-research-304/research-R4-skills-hooks.md #61):
//   ae = e.hooks !== void 0 && !N           (policy kept hooks out)
//   w  = yt(...)                            (bounds unfit reason, #60)
//   O  = ge!==void 0 || w!==void 0 || ae ? [] : Hu(r)   (strip allowed-tools)
//   ...w!==void 0||ae&&!v ? [Re({content:Ol(kt),isMeta:!0})] : []
// (ge = MCP-skill verification path — no OCC analogue; v = preload flag —
// no OCC analogue on this path.)
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// Some transitively-imported modules read MACRO.VERSION at import/call time.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const actualConfigModule = await import('../../config.js')
mock.module('../../config.js', () => ({
  ...actualConfigModule,
  checkHasTrustDialogAccepted: () => true,
}))

// Attachment extraction mocked to a no-op generator so the minimal context
// stub works; createAttachmentMessage stays real (command_permissions flows
// through it). Same pattern as hooksBeforeExpansion299.test.ts.
const actualAttachments = await import('../../attachments.js')
mock.module('../../attachments.js', () => ({
  ...actualAttachments,
  getAttachmentMessages: async function* () {},
}))

// Mutable org plugins-only policy so each test picks the policy branch.
let policyRestrictedToPluginOnly = false
let policySourceAdminTrusted = false
const actualPolicy = await import('../../settings/pluginOnlyPolicy.js')
mock.module('../../settings/pluginOnlyPolicy.js', () => ({
  ...actualPolicy,
  isRestrictedToPluginOnly: () => policyRestrictedToPluginOnly,
  isSourceAdminTrusted: () => policySourceAdminTrusted,
}))

afterAll(() => {
  // Bun test runs every file in ONE process, and restoring a mock.module does
  // NOT rebind importers that were cached while the mock was active — e.g.
  // processSlashCommand.tsx keeps calling the closures below for the rest of
  // the run (hooksBeforeExpansion299.test.ts observed this: a stale
  // isRestrictedToPluginOnly()===true silently blocked its skill-hook
  // registration). Reset the closure variables to the production defaults so
  // any stale reference behaves exactly like the real module.
  policyRestrictedToPluginOnly = false
  policySourceAdminTrusted = false
  mock.module('../../config.js', () => ({ ...actualConfigModule }))
  mock.module('../../attachments.js', () => ({ ...actualAttachments }))
  mock.module('../../settings/pluginOnlyPolicy.js', () => ({ ...actualPolicy }))
})

const { processPromptSlashCommand } = await import('../processSlashCommand.js')
const { clearLoadedSkills } = await import(
  '../../../skills/loadedSkillsTracker.js'
)
const { getSessionId } = await import('../../../bootstrap/state.js')
const { parseToolListFromCLI } = await import(
  '../../permissions/permissionSetup.js'
)
const {
  resetSkillHooksLedgerForTesting,
  SKILL_HOOKS_KEPT_OUT_NOTICE,
  SKILL_MATCHER_CHARS_BOUND,
} = await import('../../hooks/registerSkillHooks.js')

type Command = import('../../../types/command.js').Command
type AnyContext = Parameters<typeof processPromptSlashCommand>[3]
type SlashResult = Awaited<ReturnType<typeof processPromptSlashCommand>>

function makeContext() {
  // Mutable so registerSkillHooks' functional setAppState updates land here.
  const appState: Record<string, unknown> = { sessionHooks: new Map() }
  const context = {
    abortController: new AbortController(),
    agentId: undefined,
    getAppState: () => appState,
    setAppState: (updater: unknown) => {
      const next =
        typeof updater === 'function'
          ? (updater as (prev: unknown) => unknown)(appState)
          : updater
      Object.assign(appState, next)
    },
    messages: [],
  } as unknown as AnyContext
  return { appState, context }
}

function makeSkillCommand(overrides: Record<string, unknown> = {}): Command {
  return {
    type: 'prompt',
    name: 'skill-61',
    description: 'test skill for #61',
    userInvocable: true,
    source: 'userSettings',
    loadedFrom: 'skills',
    allowedTools: ['Bash'],
    async getPromptForCommand() {
      return [{ type: 'text', text: 'Skill body instructions.' }]
    },
    ...overrides,
  } as unknown as Command
}

const FITTING_HOOKS = {
  PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo check' }] },
  ],
}

function overBoundsHooks() {
  return {
    PreToolUse: [
      {
        // One matcher over the 16384-char bound → #60 refuses with 'characters'
        matcher: 'x'.repeat(SKILL_MATCHER_CHARS_BOUND + 1),
        hooks: [{ type: 'command', command: 'echo never' }],
      },
    ],
  }
}

function sessionStore(appState: Record<string, unknown>) {
  return (appState.sessionHooks as Map<string, unknown>).get(getSessionId())
}

function messagesJson(result: SlashResult): string {
  return JSON.stringify(result.messages)
}

function findNoticeMessage(result: SlashResult) {
  return result.messages.find(
    m =>
      m.type === 'user' &&
      JSON.stringify(
        (m as { message?: { content?: unknown } }).message?.content ?? '',
      ).includes(SKILL_HOOKS_KEPT_OUT_NOTICE),
  ) as { type: string; isMeta?: boolean } | undefined
}

async function runSkill(command: Command, context: AnyContext) {
  return processPromptSlashCommand('skill-61', '', [command], context)
}

beforeEach(() => {
  resetSkillHooksLedgerForTesting()
  policyRestrictedToPluginOnly = false
  policySourceAdminTrusted = false
})

afterEach(() => {
  clearLoadedSkills()
})

describe('allowed-tools stripped when hooks were kept out (CC 2.1.304 #61)', () => {
  test('org plugins-only policy kept hooks out: allowedTools stripped, kt notice appended, nothing registered', async () => {
    // Arrange
    policyRestrictedToPluginOnly = true
    policySourceAdminTrusted = false
    const command = makeSkillCommand({ hooks: FITTING_HOOKS })
    const { appState, context } = makeContext()

    // Act
    const result = await runSkill(command, context)

    // Assert — official `O = ... ae ? [] : Hu(r)`
    expect(result.allowedTools).toEqual([])
    expect(messagesJson(result)).toContain(SKILL_HOOKS_KEPT_OUT_NOTICE)
    // The policy branch never calls registerSkillHooks at all
    expect(sessionStore(appState)).toBeUndefined()
  })

  test('#60 bounds-unfit hooks: allowedTools stripped, kt notice appended, nothing registered', async () => {
    // Arrange — policy allows hooks, but the matcher blows the char bound
    const command = makeSkillCommand({ hooks: overBoundsHooks() })
    const { appState, context } = makeContext()

    // Act
    const result = await runSkill(command, context)

    // Assert — official `O = ... w!==void 0 ? [] : Hu(r)`
    expect(result.allowedTools).toEqual([])
    expect(messagesJson(result)).toContain(SKILL_HOOKS_KEPT_OUT_NOTICE)
    expect(sessionStore(appState)).toBeUndefined()
  })

  test('fitting hooks under an allowed policy: allowedTools granted, no notice, hooks registered', async () => {
    // Arrange
    const command = makeSkillCommand({ hooks: FITTING_HOOKS })
    const { appState, context } = makeContext()

    // Act
    const result = await runSkill(command, context)

    // Assert
    expect(result.allowedTools).toEqual(parseToolListFromCLI(['Bash']))
    expect(result.allowedTools.length).toBeGreaterThan(0)
    expect(messagesJson(result)).not.toContain(SKILL_HOOKS_KEPT_OUT_NOTICE)
    const store = sessionStore(appState) as
      | { hooks: { PreToolUse?: unknown[] } }
      | undefined
    expect(store?.hooks.PreToolUse).toHaveLength(1)
  })

  test('skill without hooks keeps its allowed-tools grant and gets no notice', async () => {
    // Arrange — command.hooks === undefined → hooksKeptOutByPolicy is false
    const command = makeSkillCommand()
    const { appState, context } = makeContext()

    // Act
    const result = await runSkill(command, context)

    // Assert
    expect(result.allowedTools).toEqual(parseToolListFromCLI(['Bash']))
    expect(messagesJson(result)).not.toContain(SKILL_HOOKS_KEPT_OUT_NOTICE)
    expect(sessionStore(appState)).toBeUndefined()
  })

  test('trusted admin source keeps hooks (and tools) even under the plugins-only policy', async () => {
    // Arrange — official `N`: !isRestrictedToPluginOnly || isSourceAdminTrusted
    policyRestrictedToPluginOnly = true
    policySourceAdminTrusted = true
    const command = makeSkillCommand({ hooks: FITTING_HOOKS })
    const { appState, context } = makeContext()

    // Act
    const result = await runSkill(command, context)

    // Assert
    expect(result.allowedTools).toEqual(parseToolListFromCLI(['Bash']))
    expect(messagesJson(result)).not.toContain(SKILL_HOOKS_KEPT_OUT_NOTICE)
    expect(sessionStore(appState)).toBeDefined()
  })

  test('the kt notice is an isMeta user message carrying the verbatim official text', async () => {
    // Arrange
    policyRestrictedToPluginOnly = true
    const command = makeSkillCommand({ hooks: FITTING_HOOKS })
    const { context } = makeContext()

    // Act
    const result = await runSkill(command, context)

    // Assert — official `Re({content:Ol(kt),isMeta:!0})`
    const notice = findNoticeMessage(result)
    expect(notice).toBeDefined()
    expect(notice!.type).toBe('user')
    expect(notice!.isMeta).toBe(true)
    // Byte-equality with the official string is asserted here, not just containment
    expect(
      messagesJson(result).includes(JSON.stringify(SKILL_HOOKS_KEPT_OUT_NOTICE)),
    ).toBe(true)
  })
})
