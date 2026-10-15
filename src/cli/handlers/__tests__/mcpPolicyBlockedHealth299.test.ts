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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScopedMcpServerConfig } from '../../../services/mcp/types.js'

/**
 * CC 2.1.299 #081 — `mcp list` / `mcp get` must REPORT a policy-blocked
 * server WITHOUT ever starting it.
 *
 * Official evidence (v299 binary, NEW — v296 connected unconditionally):
 *  - v299 health check `Ze` @254597341 gates BEFORE connecting:
 *      function Ze(u,o,m){try{let d=Ec(u,o);if(d)return{status:d===
 *      "project-approval"?ve:`${te.cross} ${E_(d,u,o).error}`};
 *      let p=await ge().connectToServer(u,o,void 0,m);…
 *    where `Ec` @225997128 (chunk-84yp45y8.js) returns "managed-policy" for
 *    allowedMcpServers/deniedMcpServers denials and `E_` @233435300 maps it
 *    to {error:a7, errorCode:"POLICY_BLOCKED"}, a7="Blocked by enterprise
 *    managed policy" (@222853870), te.cross = "✗".
 *  - v296 `Qe` @247893650: `await ge().connectToServer(u,o,void 0,m)` with NO
 *    policy gate — the bug: a denied server was spawned, then reported blocked.
 *
 * OCC implementation: checkMcpServerHealth in cli/handlers/mcp.tsx calls
 * filterMcpServersByPolicy (same helper print.ts uses, #080) BEFORE
 * connectToServer and returns MCP_POLICY_BLOCKED_LABEL
 * ('✗ Blocked by enterprise managed policy') for blocked servers.
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only what this test drives, restore after.
const actualMcpConfig = await import('../../../services/mcp/config.js')
const actualClient = await import('../../../services/mcp/client.js')
const actualUtils = await import('../../../services/mcp/utils.js')
const actualGraceful = await import('../../../utils/gracefulShutdown.js')
const actualSettings = await import('../../../utils/settings/settings.js')

let mockedAll: Record<string, ScopedMcpServerConfig> = {}
let connectCalls: string[] = []

mock.module('../../../services/mcp/config.js', () => ({
  ...actualMcpConfig,
  getMcpConfigByName: (name: string) => mockedAll[name],
  getAllMcpConfigs: async () => ({ servers: mockedAll }),
  getClaudeCodeMcpConfigs: async () => ({ servers: {} }),
  getMcpConfigsByScope: () => ({ servers: {} }),
}))

// Spy transport: records every connect attempt. The whole point of #081 is
// that a policy-denied server NEVER appears here.
mock.module('../../../services/mcp/client.js', () => ({
  ...actualClient,
  connectToServer: async (name: string, config: ScopedMcpServerConfig) => {
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
}))

// Deny 'denied-srv' via enterprise policy. filterMcpServersByPolicy →
// isMcpServerDenied → getMcpDenylistSettings → getInitialSettings.
mock.module('../../../utils/settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => ({
    deniedMcpServers: [{ serverName: 'denied-srv' }],
  }),
}))

// getProjectMcpServerStatus reads real settings — pin it (deterministic
// 'approved' so the pending-approval label can't mask the policy label).
mock.module('../../../services/mcp/utils.js', () => ({
  ...actualUtils,
  getProjectMcpServerStatus: () => 'approved',
}))

mock.module('../../../utils/gracefulShutdown.js', () => ({
  ...actualGraceful,
  gracefulShutdown: async () => {},
}))

// NOTE: `src/utils/config.js` is deliberately NOT mocked (OCC-97 cross-file
// leak hazard — see mcpCliDisplay285.test.ts for the full rationale). The
// per-test CLAUDE_CONFIG_DIR temp dir keeps the real global config empty.

const { mcpListHandler, mcpGetHandler } = await import('../mcp.js')

afterAll(() => {
  mock.module('../../../services/mcp/config.js', () => ({ ...actualMcpConfig }))
  mock.module('../../../services/mcp/client.js', () => ({ ...actualClient }))
  mock.module('../../../services/mcp/utils.js', () => ({ ...actualUtils }))
  mock.module('../../../utils/gracefulShutdown.js', () => ({
    ...actualGraceful,
  }))
  mock.module('../../../utils/settings/settings.js', () => ({
    ...actualSettings,
  }))
})

let configDir = ''
let savedConfigDir: string | undefined
let exitSpy: { mockRestore(): void }
let stdoutSpy: { mockRestore(): void }
let logSpy: { mockRestore(): void }
let stderrSpy: { mockRestore(): void }
let logs = ''
let stderr = ''

const DENIED_SERVER = {
  type: 'stdio',
  command: 'evil-denied-cmd',
  args: [],
  scope: 'user',
} as ScopedMcpServerConfig
const OK_SERVER = {
  type: 'stdio',
  command: 'node',
  args: ['ok-server.js'],
  scope: 'user',
} as ScopedMcpServerConfig

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'occ-mcp-081-'))
  process.env.CLAUDE_CONFIG_DIR = configDir

  mockedAll = {}
  connectCalls = []
  logs = ''
  stderr = ''

  exitSpy = spyOn(process, 'exit').mockImplementation((() =>
    undefined) as never)
  stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true)
  logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs += args.map(arg => String(arg)).join(' ') + '\n'
  })
  stderrSpy = spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => {
      stderr += args.map(arg => String(arg)).join(' ')
    },
  )
})

afterEach(() => {
  exitSpy.mockRestore()
  stdoutSpy.mockRestore()
  logSpy.mockRestore()
  stderrSpy.mockRestore()
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

describe('#081 mcpListHandler — blocked server reported, never started', () => {
  test('denied server renders the policy-blocked label with ZERO connect attempts', async () => {
    // Arrange
    mockedAll = { 'denied-srv': DENIED_SERVER, 'ok-srv': OK_SERVER }

    // Act
    await mcpListHandler()

    // Assert — blocked REPORTED (official `a7` text with the ✗ cross)…
    expect(logs).toContain('denied-srv')
    expect(logs).toContain('✗ Blocked by enterprise managed policy')
    // …and NEVER STARTED: zero connect attempts for the denied server,
    // while the allowed server still health-checks normally.
    expect(connectCalls).not.toContain('denied-srv')
    expect(connectCalls).toContain('ok-srv')
    expect(logs).toContain('ok-srv')
  })
})

describe('#081 mcpGetHandler — blocked server reported, never started', () => {
  test('`mcp get denied-srv` prints the blocked status without connecting', async () => {
    // Arrange
    mockedAll = { 'denied-srv': DENIED_SERVER, 'ok-srv': OK_SERVER }

    // Act
    await mcpGetHandler('denied-srv')

    // Assert
    expect(logs).toContain('denied-srv:')
    expect(logs).toContain('  Status: ✗ Blocked by enterprise managed policy')
    expect(connectCalls).not.toContain('denied-srv')
    expect(connectCalls).toHaveLength(0)
  })

  test('`mcp get ok-srv` still connects and reports healthy (no regression)', async () => {
    // Arrange
    mockedAll = { 'denied-srv': DENIED_SERVER, 'ok-srv': OK_SERVER }

    // Act
    await mcpGetHandler('ok-srv')

    // Assert
    expect(logs).toContain('  Status: ✔ Connected')
    expect(connectCalls).toEqual(['ok-srv'])
  })
})
