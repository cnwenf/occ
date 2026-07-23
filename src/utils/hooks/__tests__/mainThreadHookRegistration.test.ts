import { describe, expect, test, beforeEach, spyOn } from 'bun:test'
import type { HooksSettings } from '../../settings/types'
import { getGlobalConfig } from '../../config'

/**
 * CC 2.1.218 #23 (mainThread closure): the 'mainThread' surface in
 * skipFrontmatterHooksForUntrustedOrigin was dead — no caller passed
 * 'mainThread'. These tests verify the new main-thread registration path.
 *
 * Branch alignment to the official's if(t&&r)/if(t&&!r)/else shape:
 *   t = isAgentHooksOriginTrusted(agentDef)  (trusted-origin)
 *   r = hasFrontmatterHooks(agentDef.hooks) (has-registerable-hooks)
 *
 *   if (t && r)  → register hooks (isAgent: false — Stop stays Stop)
 *   if (t && !r) → noop (trusted but no hooks)
 *   else         → skipFrontmatterHooksForUntrustedOrigin(_, 'mainThread')
 *
 * The main-thread path mirrors the subagent path (runAgent.ts:636-668) but
 * passes isAgent=false so Stop hooks remain Stop (not SubagentStop).
 *
 * Observation strategy: registerFrontmatterHooks logs "Registered N frontmatter
 * hook(s) from <sourceName>" when it registers. skipFrontmatterHooksForUntrustedOrigin
 * logs "Skipping frontmatter hooks for main-thread agent '...'" when it skips.
 * We spy on logForDebugging to observe both side effects.
 */

const TRUSTED_HOOKS: HooksSettings = {
  Stop: [
    {
      matcher: '',
      hooks: [{ type: 'command', command: 'echo main-thread-stop' }],
    },
  ],
}

function makeAgentDef(overrides: {
  source?: string
  baseDir?: string
  hooks?: HooksSettings
  agentType?: string
}) {
  return {
    agentType: overrides.agentType ?? 'main-agent',
    whenToUse: 'Main session test agent',
    source: (overrides.source ?? 'projectSettings') as
      | 'projectSettings'
      | 'userSettings'
      | 'built-in'
      | 'plugin'
      | 'policySettings'
      | 'flagSettings'
      | 'localSettings',
    baseDir: overrides.baseDir,
    hooks: overrides.hooks,
    getSystemPrompt: () => '',
  }
}

function getDebugMessages(calls: unknown[][]): string[] {
  return calls.map(c => String(c[0]))
}

describe('CC 2.1.218 #23 mainThread: registerMainThreadAgentHooks', () => {
  beforeEach(() => {
    const config = getGlobalConfig()
    config.projects = {}
  })

  test('trusted + has hooks → registers (logForDebugging "Registered")', async () => {
    const { registerMainThreadAgentHooks } = await import(
      '../registerFrontmatterHooks'
    )
    const debug = await import('../../debug')
    const debugSpy = spyOn(debug, 'logForDebugging').mockImplementation(
      () => {},
    )

    const config = getGlobalConfig()
    config.projects = {
      '/trusted': { hasTrustDialogAccepted: true },
    }

    const agentDef = makeAgentDef({
      source: 'projectSettings',
      baseDir: '/trusted/.claude/agents',
      hooks: TRUSTED_HOOKS,
    })

    registerMainThreadAgentHooks(
      agentDef,
      () => ({} as any),
      'session-123',
      true,
    )

    const messages = getDebugMessages(debugSpy.mock.calls)
    // if (t && r) → register: "Registered N frontmatter hook(s) from main-thread agent 'main-agent'"
    expect(
      messages.some(m =>
        m.includes("Registered 1 frontmatter hook(s) from main-thread agent 'main-agent'"),
      ),
    ).toBe(true)
    // Must NOT skip
    expect(messages.some(m => m.includes('Skipping frontmatter hooks'))).toBe(
      false,
    )

    debugSpy.mockRestore()
  })

  test('trusted + no hooks → noop (no register, no skip)', async () => {
    const { registerMainThreadAgentHooks } = await import(
      '../registerFrontmatterHooks'
    )
    const debug = await import('../../debug')
    const debugSpy = spyOn(debug, 'logForDebugging').mockImplementation(
      () => {},
    )

    const config = getGlobalConfig()
    config.projects = {
      '/trusted': { hasTrustDialogAccepted: true },
    }

    const agentDef = makeAgentDef({
      source: 'projectSettings',
      baseDir: '/trusted/.claude/agents',
      hooks: undefined, // no hooks → if(t && !r) noop
    })

    registerMainThreadAgentHooks(
      agentDef,
      () => ({} as any),
      'session-123',
      true,
    )

    const messages = getDebugMessages(debugSpy.mock.calls)
    // if (t && !r) → noop: no register message, no skip message
    expect(messages.some(m => m.includes('Registered'))).toBe(false)
    expect(messages.some(m => m.includes('Skipping frontmatter hooks'))).toBe(
      false,
    )

    debugSpy.mockRestore()
  })

  test('untrusted + has hooks → skip with mainThread surface + telemetry', async () => {
    const { registerMainThreadAgentHooks } = await import(
      '../registerFrontmatterHooks'
    )
    const debug = await import('../../debug')
    const debugSpy = spyOn(debug, 'logForDebugging').mockImplementation(
      () => {},
    )

    // Untrusted folder — not in projects
    const config = getGlobalConfig()
    config.projects = {}

    const agentDef = makeAgentDef({
      source: 'projectSettings',
      baseDir: '/untrusted/.claude/agents',
      hooks: TRUSTED_HOOKS,
    })

    registerMainThreadAgentHooks(
      agentDef,
      () => ({} as any),
      'session-123',
      true,
    )

    const messages = getDebugMessages(debugSpy.mock.calls)
    // else (untrusted) → skip + telemetry with 'mainThread'
    expect(messages.some(m => m.includes('Skipping frontmatter hooks'))).toBe(
      true,
    )
    expect(messages.some(m => m.includes('main-thread agent'))).toBe(true)
    expect(messages.some(m => m.includes("'main-agent'"))).toBe(true)
    expect(messages.some(m => m.includes('trust key: /untrusted'))).toBe(true)
    // Must NOT register
    expect(messages.some(m => m.includes('Registered'))).toBe(false)

    debugSpy.mockRestore()
  })

  test('hooks blocked by policy → no register, no skip', async () => {
    const { registerMainThreadAgentHooks } = await import(
      '../registerFrontmatterHooks'
    )
    const debug = await import('../../debug')
    const debugSpy = spyOn(debug, 'logForDebugging').mockImplementation(
      () => {},
    )

    const config = getGlobalConfig()
    config.projects = {
      '/trusted': { hasTrustDialogAccepted: true },
    }

    const agentDef = makeAgentDef({
      source: 'projectSettings',
      baseDir: '/trusted/.claude/agents',
      hooks: TRUSTED_HOOKS,
    })

    // hooksAllowedByPolicy = false → noop
    registerMainThreadAgentHooks(
      agentDef,
      () => ({} as any),
      'session-123',
      false,
    )

    const messages = getDebugMessages(debugSpy.mock.calls)
    expect(messages.some(m => m.includes('Registered'))).toBe(false)
    expect(messages.some(m => m.includes('Skipping frontmatter hooks'))).toBe(
      false,
    )

    debugSpy.mockRestore()
  })

  test('admin-trusted source (plugin) + has hooks → registers', async () => {
    const { registerMainThreadAgentHooks } = await import(
      '../registerFrontmatterHooks'
    )
    const debug = await import('../../debug')
    const debugSpy = spyOn(debug, 'logForDebugging').mockImplementation(
      () => {},
    )

    // Plugin source is admin-trusted regardless of folder
    const agentDef = makeAgentDef({
      source: 'plugin',
      baseDir: '/anywhere',
      hooks: TRUSTED_HOOKS,
    })

    registerMainThreadAgentHooks(
      agentDef,
      () => ({} as any),
      'session-123',
      true,
    )

    const messages = getDebugMessages(debugSpy.mock.calls)
    expect(
      messages.some(m =>
        m.includes("Registered 1 frontmatter hook(s) from main-thread agent"),
      ),
    ).toBe(true)
    expect(messages.some(m => m.includes('Skipping frontmatter hooks'))).toBe(
      false,
    )

    debugSpy.mockRestore()
  })

  test('Stop hooks stay Stop (NOT SubagentStop) — main-thread isAgent=false', async () => {
    const { registerMainThreadAgentHooks } = await import(
      '../registerFrontmatterHooks'
    )
    const sessionHooks = await import('../sessionHooks')
    // Spy on addSessionHook but track the event arg
    const calls: unknown[][] = []
    const addHookSpy = spyOn(
      sessionHooks,
      'addSessionHook',
    ).mockImplementation((...args: unknown[]) => {
      calls.push(args)
    })

    const config = getGlobalConfig()
    config.projects = {
      '/trusted': { hasTrustDialogAccepted: true },
    }

    const agentDef = makeAgentDef({
      source: 'projectSettings',
      baseDir: '/trusted/.claude/agents',
      hooks: TRUSTED_HOOKS,
    })

    registerMainThreadAgentHooks(
      agentDef,
      () => ({} as any),
      'session-123',
      true,
    )

    // The 4th arg to addSessionHook is the targetEvent
    // addSessionHook(setAppState, sessionId, targetEvent, matcher, hook)
    // Wait — let me check the signature
    const events = calls.map(c => c[2]) // sessionId is index 1, event is index 2
    // Main-thread: Stop stays Stop (isAgent=false)
    expect(events).toContain('Stop')
    expect(events).not.toContain('SubagentStop')

    addHookSpy.mockRestore()
  })
})
