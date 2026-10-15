import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import type { Command } from '../../../commands.js'
import type { ProcessUserInputContext } from '../processUserInput.js'
import type { HooksSettings } from '../../settings/types.js'

// Some transitively-imported modules read MACRO.VERSION at import/call time.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.299 #167 + #168: UserPromptSubmit hooks must run BEFORE
 * skill/custom-slash-command expansion. Expansion (getPromptForCommand →
 * executeShellCommandsInPrompt) executes embedded ```! cmd``` shell blocks,
 * so a blocking hook that runs afterwards cannot prevent them. Official
 * v299 runs the hooks on the fork-dispatch path before expansion, with
 * early returns for blocking/preventContinuation (@244494224 in the ELF).
 *
 * #168 (skill front-matter UserPromptSubmit hook must first fire on the NEXT
 * prompt) falls out of the same ordering: registerSkillHooks runs inside
 * expansion, so the hook that the invocation registers cannot retroactively
 * gate that same invocation.
 *
 * Both REPL (handlePromptSubmit.ts) and headless -p (QueryEngine.ts) route
 * through the single processUserInput choke point, so this ordering holds on
 * both paths.
 */

// Mock load order matters: permissions.ts transitively imports hooks.ts, so
// the hooksConfigSnapshot + config mocks MUST be registered before ANY module
// that pulls in hooks.ts is first loaded — otherwise hooks.ts keeps the real
// (empty) snapshot and no hook ever fires.
const actualSnapshotModule = await import('../../hooks/hooksConfigSnapshot.js')
const actualConfigModule = await import('../../config.js')

// Mutable UserPromptSubmit hook config seen by getHooksConfigFromSnapshot().
let mockedHooksConfig: HooksSettings | null = null

mock.module('../../hooks/hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
  shouldAllowManagedHooksOnly: () => false,
  shouldDisableAllHooksIncludingManaged: () => false,
}))
mock.module('../../config.js', () => ({
  ...actualConfigModule,
  checkHasTrustDialogAccepted: () => true,
}))

// Attachment extraction is mocked to a no-op generator so a minimal context
// stub works. NOTE: CLAUDE_CODE_SIMPLE can NOT be used for this here —
// executeHooks (hooks.ts:3464) skips ALL hooks when it is truthy, and hooks
// are exactly what this test exercises. createAttachmentMessage stays real
// (hook_additional_context messages flow through it).
const actualAttachments = await import('../../attachments.js')
mock.module('../../attachments.js', () => ({
  ...actualAttachments,
  getAttachmentMessages: async function* () {},
}))

// Spies on the embedded-shell execution inside expansion: a fake prompt
// command routes its body through the REAL executeShellCommandsInPrompt, and
// BashTool.call (the shell executor) is replaced by this spy.
const bashCallSpy = mock(
  async (_input: { command: string }, _ctx: unknown) => ({
    data: { stdout: 'EMBEDDED-SHELL-OUTPUT', stderr: '', interrupted: false },
  }),
)

const actualPermissions = await import('../../permissions/permissions.js')
const actualBashTool = await import('../../../tools/BashTool/BashTool.js')

mock.module('../../permissions/permissions.js', () => ({
  ...actualPermissions,
  hasPermissionsToUseTool: async () => ({ behavior: 'allow' }),
}))
mock.module('../../../tools/BashTool/BashTool.js', () => ({
  ...actualBashTool,
  BashTool: { ...actualBashTool.BashTool, call: bashCallSpy },
}))

afterAll(() => {
  mock.module('../../hooks/hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
  mock.module('../../config.js', () => ({ ...actualConfigModule }))
  mock.module('../../attachments.js', () => ({ ...actualAttachments }))
  mock.module('../../permissions/permissions.js', () => ({
    ...actualPermissions,
  }))
  mock.module('../../../tools/BashTool/BashTool.js', () => ({
    ...actualBashTool,
  }))
})

const { processUserInput } = await import('../processUserInput.js')
const { executeShellCommandsInPrompt } = await import(
  '../../promptShellExecution.js'
)
const { clearLoadedSkills } = await import('../../../skills/loadedSkillsTracker.js')

afterEach(() => {
  mockedHooksConfig = null
  clearLoadedSkills()
})

// --- Fixtures ---------------------------------------------------------------

/** Records which commands ran expansion (getPromptForCommand). */
const expansionCalls: string[] = []

function makePromptCommand(
  name: string,
  options: { withEmbeddedShell?: boolean; hooks?: HooksSettings } = {},
): Command {
  const { withEmbeddedShell = true, hooks } = options
  const body = withEmbeddedShell
    ? [`Skill body for ${name}.`, '```!', 'echo embedded-299', '```'].join('\n')
    : `Skill body for ${name}.`
  return {
    type: 'prompt',
    name,
    description: 'test stub command',
    userInvocable: true,
    source: 'userSettings',
    loadedFrom: 'skills',
    ...(hooks ? { hooks } : {}),
    async getPromptForCommand(_args: string, ctx: unknown) {
      expansionCalls.push(name)
      // Run the REAL embedded-shell expansion so the ```! block executes
      // through BashTool.call (spied) exactly like production.
      const expanded = await executeShellCommandsInPrompt(body, ctx, name)
      return [{ type: 'text', text: expanded }]
    },
  } as unknown as Command
}

function makeLocalCommand(name: string): Command {
  return {
    type: 'local',
    name,
    description: 'test stub local command',
    userInvocable: true,
    async load() {
      return {
        call: async () => ({ type: 'text', value: 'local-output' }),
      }
    },
  } as unknown as Command
}

function makeContext(commands: Command[]): ProcessUserInputContext {
  // Mutable so registerSkillHooks' functional setAppState updates land here.
  const appState: Record<string, unknown> = {
    toolPermissionContext: {
      mode: 'default',
      shouldAvoidPermissionPrompts: false,
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    sessionHooks: new Map(),
    ultraplanSessionUrl: undefined,
    ultraplanLaunching: false,
  }
  return {
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
    options: {
      commands,
      tools: [],
      isNonInteractiveSession: false,
    },
    messages: [],
    readFileState: {},
    nestedMemoryAttachmentTriggers: new Set(),
    loadedNestedMemoryPaths: new Set(),
    dynamicSkillDirTriggers: new Set(),
    discoveredSkillNames: new Set(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    onChangeAPIKey: () => {},
    setMessages: () => {},
  } as unknown as ProcessUserInputContext
}

const NOOP_SET_TOOL_JSX = () => {}

async function run(input: string, context: ProcessUserInputContext) {
  return processUserInput({
    input,
    mode: 'prompt',
    setToolJSX: NOOP_SET_TOOL_JSX,
    context,
  })
}

function messagesText(result: { messages: unknown[] }): string {
  return JSON.stringify(result.messages)
}

function userPromptSubmitHook(json: string): HooksSettings {
  return {
    UserPromptSubmit: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: `printf '%s' '${json}'` }],
      },
    ],
  } as HooksSettings
}

// --- Tests ------------------------------------------------------------------

describe('2.1.299 #167 — UserPromptSubmit hooks run before command expansion', () => {
  test('blocking hook prevents expansion: embedded ```! shell never executes', async () => {
    // Arrange
    mockedHooksConfig = userPromptSubmitHook(
      '{"decision":"block","reason":"blocked-by-299"}',
    )
    expansionCalls.length = 0
    bashCallSpy.mockClear()
    const command = makePromptCommand('stub-block-299')
    const context = makeContext([command])

    // Act
    const result = await run('/stub-block-299', context)

    // Assert — the shell block never ran and expansion never started.
    expect(bashCallSpy).not.toHaveBeenCalled()
    expect(expansionCalls).toEqual([])
    expect(result.shouldQuery).toBe(false)
    expect(messagesText(result)).toContain('blocked-by-299')
    expect(messagesText(result)).toContain('Original prompt: /stub-block-299')
  })

  test('no hooks: expansion runs and the embedded shell executes exactly once (regression)', async () => {
    // Arrange
    mockedHooksConfig = null
    expansionCalls.length = 0
    bashCallSpy.mockClear()
    const command = makePromptCommand('stub-ok-299')
    const context = makeContext([command])

    // Act
    const result = await run('/stub-ok-299', context)

    // Assert
    expect(expansionCalls).toEqual(['stub-ok-299'])
    expect(bashCallSpy).toHaveBeenCalledTimes(1)
    expect(result.shouldQuery).toBe(true)
    expect(messagesText(result)).toContain('EMBEDDED-SHELL-OUTPUT')
  })

  test('additionalContext from the pre-expansion hook pass still reaches the result', async () => {
    // Arrange
    mockedHooksConfig = userPromptSubmitHook(
      '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"CTX-299"}}',
    )
    expansionCalls.length = 0
    bashCallSpy.mockClear()
    const command = makePromptCommand('stub-ctx-299')
    const context = makeContext([command])

    // Act
    const result = await run('/stub-ctx-299', context)

    // Assert — expansion proceeded AND the hook context was preserved.
    expect(expansionCalls).toEqual(['stub-ctx-299'])
    expect(result.shouldQuery).toBe(true)
    expect(messagesText(result)).toContain('CTX-299')
    expect(messagesText(result)).toContain('hook_additional_context')
  })

  test('plain-text prompt with blocking hook still blocks (legacy post-base pass preserved)', async () => {
    // Arrange
    mockedHooksConfig = userPromptSubmitHook(
      '{"decision":"block","reason":"blocked-plain-299"}',
    )
    const context = makeContext([])

    // Act
    const result = await run('hello plain text', context)

    // Assert
    expect(result.shouldQuery).toBe(false)
    expect(messagesText(result)).toContain('blocked-plain-299')
    expect(messagesText(result)).toContain(
      'Original prompt: hello plain text',
    )
  })

  test('local-type command does not take the pre-expansion pass (scope preserved)', async () => {
    // Arrange — a blocking hook exists, but the command renders UI; it has no
    // expansion, so the reorder must not fire the hook before base.
    mockedHooksConfig = userPromptSubmitHook(
      '{"decision":"block","reason":"blocked-local-299"}',
    )
    expansionCalls.length = 0
    const command = makeLocalCommand('stub-local-299')
    const context = makeContext([command])

    // Act
    const result = await run('/stub-local-299', context)

    // Assert — local commands return shouldQuery:false from base, so the
    // legacy post-base hook pass never runs either: no block message at all.
    expect(result.shouldQuery).toBe(false)
    expect(messagesText(result)).not.toContain('blocked-local-299')
  })
})

describe('2.1.299 #168 — skill front-matter hook first fires on the NEXT prompt', () => {
  test('invoking prompt is NOT gated by the hook it registers; the next prompt IS', async () => {
    // Arrange — no global hooks; the skill carries its own UserPromptSubmit
    // hook in front-matter (registered during expansion via
    // registerSkillHooks).
    mockedHooksConfig = null
    expansionCalls.length = 0
    const skillHook = userPromptSubmitHook(
      '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"SKILL-HOOK-FIRED"}}',
    )
    const command = makePromptCommand('stub-hooks-168', {
      withEmbeddedShell: false,
      hooks: skillHook,
    })
    const context = makeContext([command])

    // Act 1 — invoke the skill. Expansion runs (registering the hook), but
    // the hook must NOT have fired for THIS prompt: hooks ran pre-expansion,
    // before the registration existed.
    const first = await run('/stub-hooks-168', context)
    expect(expansionCalls).toEqual(['stub-hooks-168'])
    expect(first.shouldQuery).toBe(true)
    expect(messagesText(first)).not.toContain('SKILL-HOOK-FIRED')

    // Act 2 — next plain prompt on the SAME context: the session hook is now
    // registered and fires via the legacy post-base pass.
    const second = await run('hello next prompt', context)
    expect(second.shouldQuery).toBe(true)
    expect(messagesText(second)).toContain('SKILL-HOOK-FIRED')
  })
})
