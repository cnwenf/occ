/**
 * CC 2.1.299 #081 — the SUBAGENT MCP start path must honor the enterprise
 * policy gate BEFORE spawning: a frontmatter `mcpServers` entry denied via
 * allowedMcpServers/deniedMcpServers is skipped, never connected.
 *
 * Official evidence (v299 binary, NEW — v296 connected unconditionally):
 *  - v299 health check `Ze` @254597341 gates BEFORE connecting:
 *    `let d=Ec(u,o);if(d)return{status:…}` — `Ec` @225997128 returns
 *    "managed-policy" for policy denials; the server is reported blocked and
 *    NEVER spawned. v296's `Qe` @247893650 called `connectToServer` with no
 *    gate at all.
 *
 * OCC implementation: runAgent.ts initializeAgentMcpServers calls
 * filterMcpServersByPolicy (same helper print.ts #080 and the mcp.tsx health
 * check use) before connectToServer, logs a warn and `continue`s on a block.
 * This covers BOTH string references (getMcpConfigByName is unfiltered) and
 * inline `{name: config}` frontmatter servers (which bypass every other
 * policy-filtered lookup).
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDefinition } from '../loadAgentsDir.js'

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE importing runAgent so its transitive
// imports resolve to the stubs (same harness as forkPermissionModeWiring285).
// ---------------------------------------------------------------------------

const realQueryModule = await import('../../../query.js')
mock.module('../../../query.js', () => ({
  ...realQueryModule,
  // Intentionally empty async generator — this suite never runs the query
  // loop; only initializeAgentMcpServers is exercised.
  query: async function* () {},
}))

const realHooksModule = await import('../../../utils/hooks.js')
mock.module('../../../utils/hooks.js', () => ({
  ...realHooksModule,
  executeSubagentStartHooks: async function* () {
    // No hooks configured — yields nothing.
  },
}))

const realClientModule = await import('../../../services/mcp/client.js')
const realConfigModule = await import('../../../services/mcp/config.js')
const realSettingsModule = await import('../../../utils/settings/settings.js')

let connectCalls: string[] = []

const DENIED_CONFIG = {
  type: 'stdio',
  command: 'evil-denied-cmd',
  args: [],
  scope: 'user',
}
const OK_CONFIG = {
  type: 'stdio',
  command: 'node',
  args: ['ok-server.js'],
  scope: 'user',
}

mock.module('../../../services/mcp/client.js', () => ({
  ...realClientModule,
  connectToServer: async (name: string, config: unknown) => {
    connectCalls.push(name)
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

mock.module('../../../services/mcp/config.js', () => ({
  ...realConfigModule,
  getMcpConfigByName: (name: string) => {
    if (name === 'denied-srv') {
      return DENIED_CONFIG
    }
    if (name === 'ok-srv') {
      return OK_CONFIG
    }
    return undefined
  },
}))

// Deny 'denied-srv' via enterprise policy — filterMcpServersByPolicy →
// isMcpServerDenied → getMcpDenylistSettings → getInitialSettings.
mock.module('../../../utils/settings/settings.js', () => ({
  ...realSettingsModule,
  getInitialSettings: () => ({
    deniedMcpServers: [{ serverName: 'denied-srv' }],
  }),
}))

const { initializeAgentMcpServers } = await import('../runAgent.js')

afterAll(() => {
  // OCC-97: module mocks are process-global — always restore.
  mock.module('../../../query.js', () => realQueryModule)
  mock.module('../../../utils/hooks.js', () => realHooksModule)
  mock.module('../../../services/mcp/client.js', () => realClientModule)
  mock.module('../../../services/mcp/config.js', () => realConfigModule)
  mock.module('../../../utils/settings/settings.js', () => realSettingsModule)
})

let configDir = ''
let savedConfigDir: string | undefined

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'occ-agent-081-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  connectCalls = []
})

afterEach(() => {
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

function makeAgent(mcpServers: unknown[]): AgentDefinition {
  return {
    agentType: 'test-agent',
    whenToUse: 'policy-gate unit test',
    source: 'user',
    mcpServers,
    getSystemPrompt: () => '',
  } as unknown as AgentDefinition
}

describe('#081 initializeAgentMcpServers — policy-denied servers never start', () => {
  test('a denied string-referenced server is skipped with zero connects', async () => {
    // Arrange
    const agent = makeAgent(['denied-srv'])

    // Act
    const result = await initializeAgentMcpServers(agent, [])

    // Assert — nothing connected, nothing returned
    expect(connectCalls).toHaveLength(0)
    expect(result.clients).toHaveLength(0)
    expect(result.tools).toHaveLength(0)
    await result.cleanup()
  })

  test('a denied INLINE frontmatter server is skipped too (bypass path closed)', async () => {
    // Arrange — inline `{name: config}` entries never pass through
    // getMcpConfigByName; the gate must still catch them by name.
    const agent = makeAgent([
      { 'denied-srv': { type: 'stdio', command: 'evil', args: [] } },
    ])

    // Act
    const result = await initializeAgentMcpServers(agent, [])

    // Assert
    expect(connectCalls).toHaveLength(0)
    expect(result.clients).toHaveLength(0)
    await result.cleanup()
  })

  test('an allowed server still connects (no regression)', async () => {
    // Arrange
    const agent = makeAgent(['ok-srv'])

    // Act
    const result = await initializeAgentMcpServers(agent, [])

    // Assert
    expect(connectCalls).toEqual(['ok-srv'])
    expect(result.clients).toHaveLength(1)
    expect(result.clients[0]?.name).toBe('ok-srv')
    await result.cleanup()
  })

  test('mixed list: only the allowed server starts', async () => {
    // Arrange
    const agent = makeAgent(['denied-srv', 'ok-srv'])

    // Act
    const result = await initializeAgentMcpServers(agent, [])

    // Assert
    expect(connectCalls).toEqual(['ok-srv'])
    expect(result.clients).toHaveLength(1)
    await result.cleanup()
  })
})
