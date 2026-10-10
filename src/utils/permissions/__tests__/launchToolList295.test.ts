import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { LaunchListToolRef } from '../launchToolList.js'

/**
 * CC 2.1.295 changelog #037 (half 1) — `--tools` must also apply to built-in
 * tools that register AFTER launch.
 *
 * The pre-fix official behaviour (v294) enforced `--tools` only through a
 * startup deny-rule snapshot: a tool that did not exist when the permission
 * context was built could never be named by a deny rule, so it reached the
 * model. v295 adds the positive `toolsKeptByLaunchList` field (v295 @222921207)
 * and the `isOutsideLaunchToolList` predicate (v295 @214477596, exported at
 * @238500768), which `filterToolsByDenyRules` (v295 @214477161) consults on
 * every pool build.
 *
 * These tests pin the ported predicate, the exemption set, the once-per-name
 * warning/telemetry claim store, and the late-registration scenario itself.
 */

// E-9/P2: snapshot real export values into plain objects BEFORE mocking —
// `await import()` namespaces are live bindings that become the fake once
// mock.module() installs, which would make the afterAll restore re-spread
// the fake (pattern: headlessCostRestore277.test.ts).
const actualDebug = { ...(await import('../../debug.js')) }
const actualAnalytics = {
  ...(await import('../../../services/analytics/index.js')),
}

const warnMessages: string[] = []
const loggedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []

mock.module('../../debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string, options?: { level?: string }) => {
    warnMessages.push(`${options?.level ?? 'debug'}:${message}`)
  },
}))

mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (eventName: string, metadata: Record<string, unknown>) => {
    loggedEvents.push({ name: eventName, metadata })
  },
}))

const {
  isOutsideLaunchToolList,
  launchListToolLabel,
  resetLaunchListWarningsForTesting,
  withholdToolsOutsideLaunchList,
} = await import('../launchToolList.js')

afterAll(() => {
  mock.module('../../debug.js', () => ({ ...actualDebug }))
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalytics,
  }))
})

function contextWith(
  toolsKeptByLaunchList?: readonly string[],
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...(toolsKeptByLaunchList === undefined ? {} : { toolsKeptByLaunchList }),
  }
}

function toolRef(
  name: string,
  overrides: Partial<LaunchListToolRef> = {},
): LaunchListToolRef {
  return { name, ...overrides }
}

beforeEach(() => {
  resetLaunchListWarningsForTesting()
  warnMessages.length = 0
  loggedEvents.length = 0
})

describe('2.1.295 #037 isOutsideLaunchToolList', () => {
  test('never gates a session that was launched without a positive tool list', () => {
    // Arrange — `--tools default` / no `--tools` at all: toolsKeptByLaunchList
    // stays undefined (official QHs returns `toolsKept: void 0` for presets).
    const context = contextWith(undefined)

    // Act / Assert
    expect(isOutsideLaunchToolList(context, toolRef('WebFetch'))).toBe(false)
  })

  test('keeps a built-in tool that is named on the launch list', () => {
    // Arrange
    const context = contextWith(['Bash', 'Read'])

    // Act / Assert
    expect(isOutsideLaunchToolList(context, toolRef('Bash'))).toBe(false)
    expect(isOutsideLaunchToolList(context, toolRef('Read'))).toBe(false)
  })

  test('flags a built-in tool that is absent from the launch list', () => {
    // Arrange
    const context = contextWith(['Bash', 'Read'])

    // Act / Assert
    expect(isOutsideLaunchToolList(context, toolRef('WebFetch'))).toBe(true)
  })

  test('flags every built-in tool when the launch list is empty', () => {
    // Arrange — `--tools ""` disables all built-ins.
    const context = contextWith([])

    // Act / Assert
    expect(isOutsideLaunchToolList(context, toolRef('Bash'))).toBe(true)
    expect(isOutsideLaunchToolList(context, toolRef('Read'))).toBe(true)
  })

  test('exempts a tool carrying mcpInfo', () => {
    // Arrange
    const context = contextWith(['Bash'])
    const mcpTool = toolRef('anything', {
      mcpInfo: { serverName: 'github', toolName: 'create_issue' },
    })

    // Act / Assert
    expect(isOutsideLaunchToolList(context, mcpTool)).toBe(false)
  })

  test('exempts a tool whose name uses the mcp__ prefix', () => {
    // Arrange — official `ky`: name-based MCP detection (v295 @213206000).
    const context = contextWith(['Bash'])

    // Act / Assert
    expect(
      isOutsideLaunchToolList(context, toolRef('mcp__github__create_issue')),
    ).toBe(false)
  })

  test('exempts a tool carrying the isMcp flag', () => {
    // Arrange
    const context = contextWith(['Bash'])

    // Act / Assert
    expect(
      isOutsideLaunchToolList(context, toolRef('server_tool', { isMcp: true })),
    ).toBe(false)
  })
})

describe('2.1.295 #037 withholdToolsOutsideLaunchList', () => {
  test('withholds a tool that registered after the launch list was frozen', () => {
    // Arrange — turn 1 pool: only Bash and Read existed at launch.
    const context = contextWith(['Bash', 'Read'])
    const launchPool = [toolRef('Bash'), toolRef('Read')]
    // Turn 2 pool: a late-registering built-in appeared.
    const laterPool = [...launchPool, toolRef('MonitorTool')]

    // Act
    const turnOne = withholdToolsOutsideLaunchList(launchPool, context)
    const turnTwo = withholdToolsOutsideLaunchList(laterPool, context)

    // Assert — the late tool is withheld even though no deny rule names it.
    expect(turnOne.map(t => t.name)).toEqual(['Bash', 'Read'])
    expect(turnTwo.map(t => t.name)).toEqual(['Bash', 'Read'])
  })

  test('passes every tool through when no launch list was set', () => {
    // Arrange
    const context = contextWith(undefined)
    const pool = [toolRef('Bash'), toolRef('WebFetch'), toolRef('MonitorTool')]

    // Act
    const kept = withholdToolsOutsideLaunchList(pool, context)

    // Assert
    expect(kept.map(t => t.name)).toEqual([
      'Bash',
      'WebFetch',
      'MonitorTool',
    ])
  })

  test('does not mutate the input array', () => {
    // Arrange
    const context = contextWith(['Bash'])
    const pool = [toolRef('Bash'), toolRef('WebFetch')]

    // Act
    withholdToolsOutsideLaunchList(pool, context)

    // Assert
    expect(pool.map(t => t.name)).toEqual(['Bash', 'WebFetch'])
  })

  test('warns and reports telemetry exactly once per withheld tool name', () => {
    // Arrange
    const context = contextWith(['Bash'])
    const pool = [toolRef('Bash'), toolRef('WebFetch')]

    // Act — three consecutive pool builds (three turns).
    withholdToolsOutsideLaunchList(pool, context)
    withholdToolsOutsideLaunchList(pool, context)
    withholdToolsOutsideLaunchList(pool, context)

    // Assert
    expect(warnMessages).toHaveLength(1)
    expect(warnMessages[0]).toStartWith('warn:')
    expect(warnMessages[0]).toContain(
      'WebFetch is not on this session\'s --tools list',
    )
    expect(warnMessages[0]).toContain('Name it in --tools to offer it')
    expect(loggedEvents).toHaveLength(1)
    expect(loggedEvents[0]?.name).toBe(
      'tengu_tool_withheld_outside_launch_list',
    )
    expect(loggedEvents[0]?.metadata).toEqual({ toolName: 'WebFetch' })
  })

  test('claims each withheld tool name separately', () => {
    // Arrange
    const context = contextWith(['Bash'])
    const pool = [toolRef('WebFetch'), toolRef('MonitorTool')]

    // Act
    withholdToolsOutsideLaunchList(pool, context)
    withholdToolsOutsideLaunchList(pool, context)

    // Assert
    expect(warnMessages).toHaveLength(2)
    expect(loggedEvents).toHaveLength(2)
  })

  test('emits no warning when the launch list is not narrowing anything', () => {
    // Arrange
    const context = contextWith(undefined)

    // Act
    withholdToolsOutsideLaunchList([toolRef('WebFetch')], context)

    // Assert
    expect(warnMessages).toHaveLength(0)
    expect(loggedEvents).toHaveLength(0)
  })
})

describe('2.1.295 #037 launchListToolLabel (official LS + Hn)', () => {
  test('labels a per-skill tool as skill_tool', () => {
    expect(launchListToolLabel(toolRef('skill__my_skill'))).toBe('skill_tool')
  })

  test('labels an mcp__ prefixed tool as mcp_tool', () => {
    expect(launchListToolLabel(toolRef('mcp__github__create_issue'))).toBe(
      'mcp_tool',
    )
  })

  test('labels a tool carrying mcpInfo as mcp_tool', () => {
    expect(
      launchListToolLabel(
        toolRef('issue_creator', {
          mcpInfo: { serverName: 'github', toolName: 'create_issue' },
        }),
      ),
    ).toBe('mcp_tool')
  })

  test('labels an eval-registered tool as eval_registered', () => {
    expect(launchListToolLabel(toolRef('eval_registered__42'))).toBe(
      'eval_registered',
    )
  })

  test('labels a double-underscore tool as dynamic_tool', () => {
    expect(launchListToolLabel(toolRef('plugin__some_tool'))).toBe(
      'dynamic_tool',
    )
  })

  test('passes a plain built-in name through verbatim', () => {
    expect(launchListToolLabel(toolRef('Bash'))).toBe('Bash')
  })

  test('reports the bucketed label, not the raw name, for a withheld dynamic tool', () => {
    // Arrange
    const context = contextWith(['Bash'])

    // Act
    withholdToolsOutsideLaunchList([toolRef('plugin__some_tool')], context)

    // Assert — the raw generated name never reaches the log or telemetry.
    expect(warnMessages[0]).toContain('dynamic_tool is not on this session')
    expect(warnMessages[0]).not.toContain('plugin__some_tool')
    expect(loggedEvents[0]?.metadata).toEqual({ toolName: 'dynamic_tool' })
  })
})
