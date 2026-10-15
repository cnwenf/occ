/**
 * CC 2.1.299 follow-up — reserved prototype MCP server names (`__proto__`
 * and friends) in agent frontmatter are SKIPPED before any registration or
 * connect, with a byte-exact warning.
 *
 * Official evidence (v299 ELF @225906218, grep -aboF + dd; NEVER executed):
 *   let[h,y]=s[0];
 *   if(EBe(h)){t(`[Agent: ${e.agentType}] Skipping reserved MCP server name
 *     '${h}' in frontmatter`,{level:"warn"});continue}
 *   let S=Mye(y.type);...
 * i.e. the guard sits AFTER the "expected exactly one key" check and BEFORE
 * the transport check / any config building — a reserved name never becomes
 * an inline client (prototype-pollution hardening for the `n[h]={...}` map).
 *
 * EBe = isReservedPrototypeMcpServerName (src/services/mcp/mcpStringUtils.ts,
 * read-only import — owned by the MCP work package).
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import type { AgentDefinition } from '../loadAgentsDir.js'

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE importing runAgent so its transitive
// imports resolve to the stubs (same harness as mcpPolicyBlockedSubagent299).
// ---------------------------------------------------------------------------

const realQueryModule = await import('../../../query.js')
mock.module('../../../query.js', () => ({
  ...realQueryModule,
  query: async function* () {},
}))

const realHooksModule = await import('../../../utils/hooks.js')
mock.module('../../../utils/hooks.js', () => ({
  ...realHooksModule,
  executeSubagentStartHooks: async function* () {},
}))

const realClientModule = await import('../../../services/mcp/client.js')

let connectCalls: Array<{ name: string; config: unknown }> = []

mock.module('../../../services/mcp/client.js', () => ({
  ...realClientModule,
  connectToServer: async (name: string, config: unknown) => {
    connectCalls.push({ name, config })
    return {
      type: 'connected',
      name,
      config,
      capabilities: {},
      client: {},
      cleanup: async () => {},
    }
  },
  fetchToolsForClient: async () => [],
}))

const { initializeAgentMcpServers } = await import('../runAgent.js')
const debug = await import('../../../utils/debug.js')

afterAll(() => {
  // Module mocks are process-global — always restore.
  mock.module('../../../query.js', () => realQueryModule)
  mock.module('../../../utils/hooks.js', () => realHooksModule)
  mock.module('../../../services/mcp/client.js', () => realClientModule)
})

function makeAgent(mcpServers: unknown[]): AgentDefinition {
  return {
    agentType: 'test-agent',
    whenToUse: 'reserved-name guard unit test',
    source: 'user',
    mcpServers,
    getSystemPrompt: () => '',
  } as unknown as AgentDefinition
}

let logs: { message: string; level?: string }[] = []
let spy: ReturnType<typeof spyOn> | undefined

beforeEach(() => {
  logs = []
  connectCalls = []
  spy = spyOn(debug, 'logForDebugging').mockImplementation(
    (message: string, opts?: { level?: string }) => {
      logs.push({ message, level: opts?.level })
      return undefined as never
    },
  )
})

afterEach(() => {
  spy?.mockRestore()
})

describe('CC 2.1.299 follow-up: reserved MCP server names in agent frontmatter', () => {
  test('__proto__ inline server → skipped with the byte-exact warn, never connected', async () => {
    // Arrange — computed key so the literal does NOT set the prototype.
    const agent = makeAgent([
      { ['__proto__']: { type: 'stdio', command: 'evil', args: [] } },
    ])

    // Act
    const result = await initializeAgentMcpServers(agent, [])

    // Assert — byte-exact official message (@225906218); nothing connected,
    // no clients/tools returned.
    expect(logs).toContainEqual({
      message:
        "[Agent: test-agent] Skipping reserved MCP server name '__proto__' in frontmatter",
      level: 'warn',
    })
    expect(connectCalls).toHaveLength(0)
    expect(result.clients).toHaveLength(0)
    expect(result.tools).toHaveLength(0)
    await result.cleanup()
  })

  test('a normal inline server still registers and connects (no regression)', async () => {
    // Arrange
    const agent = makeAgent([
      { 'ok-inline': { type: 'stdio', command: 'node', args: ['ok.js'] } },
    ])

    // Act
    const result = await initializeAgentMcpServers(agent, [])

    // Assert
    expect(connectCalls).toHaveLength(1)
    expect(connectCalls[0]!.name).toBe('ok-inline')
    expect(result.clients).toHaveLength(1)
    expect(
      logs.some(entry => entry.message.includes('Skipping reserved MCP server')),
    ).toBe(false)
    await result.cleanup()
  })

  test('mixed list: reserved entry skipped, sibling entry still connects', async () => {
    // Arrange
    const agent = makeAgent([
      { ['__defineGetter__']: { type: 'stdio', command: 'evil2', args: [] } },
      { 'ok-inline': { type: 'stdio', command: 'node', args: ['ok.js'] } },
    ])

    // Act
    const result = await initializeAgentMcpServers(agent, [])

    // Assert — the predicate covers the whole reserved family: an
    // Object.prototype member whose normalized name breaks the mcp__server__
    // round-trip parse (`__defineGetter__` → empty segments), not just
    // __proto__.
    expect(logs).toContainEqual({
      message:
        "[Agent: test-agent] Skipping reserved MCP server name '__defineGetter__' in frontmatter",
      level: 'warn',
    })
    expect(connectCalls.map(call => call.name)).toEqual(['ok-inline'])
    expect(result.clients).toHaveLength(1)
    await result.cleanup()
  })
})
