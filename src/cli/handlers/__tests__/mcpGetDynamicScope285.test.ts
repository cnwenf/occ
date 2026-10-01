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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScopedMcpServerConfig } from '../../../services/mcp/types.js'

/**
 * CC 2.1.285 item 5 / changelog #101 — REAL-seed regression test for the
 * E2E-001 acceptance finding: `occ mcp get <dynamic-scope-server>` returned
 * not-found for every dynamic-scope (--mcp-config / plugin / SDK) server,
 * because mcpGetHandler resolved the name through `getMcpConfigByName`
 * (file-backed scopes only) while `mcp list` renders `getAllMcpConfigs()`
 * (which includes dynamic-scope plugin servers). The v285 sanitize branch
 * (`isStdioConfig(server) && !MCP_FILE_BACKED_SCOPES.has(server.scope)` →
 * command/args/env redaction) was therefore unreachable in real execution,
 * and the not-found suggester recommended the exact name it claimed absent.
 *
 * This suite seeds an inline plugin EXACTLY like the reviewer's repro
 * (`--plugin-dir <dir>/e2e-plugin` with a `.mcp.json` exposing a leaky stdio
 * server) and drives the REAL handlers against the REAL config lookup —
 * `services/mcp/config.js` is deliberately NOT mocked here (that mock seam is
 * what let the gap ship green in mcpCliDisplay285.test.ts). Only the health
 * probe (`connectToServer`) and `gracefulShutdown` are stubbed so the test
 * doesn't spawn subprocesses or exit the runner.
 */

// OCC-97 leak guard: Bun runs test files sequentially in ONE worker and
// `mock.module` registrations persist across files — an earlier sibling's
// config.js mock (mcpCliDisplay285's `getAllMcpConfigs: async () => ({
// servers: mockedAll })`) is still registered when this file loads, and its
// afterAll "restore" does NOT take effect for later files (empirically
// verified). That stale mock would poison the REAL lookup this suite exists
// to exercise. Re-registering config.js at THIS file's top level overrides
// the stale mock; the cache-busted query import pulls a fresh, genuine copy
// of the real module (a no-op identity swap when config.js is not mocked).
const realMcpConfig = await import(
  '../../../services/mcp/config.js?occ-e2e-001-real'
)
mock.module('../../../services/mcp/config.js', () => ({ ...realMcpConfig }))

// The health checker would spawn the seeded stdio command — report connected
// instead (same stub the sibling display suite uses; NOT a config-lookup mock).
const actualClient = await import('../../../services/mcp/client.js')
const actualGraceful = await import('../../../utils/gracefulShutdown.js')

mock.module('../../../services/mcp/client.js', () => ({
  ...actualClient,
  connectToServer: async (name: string, config: ScopedMcpServerConfig) => ({
    type: 'connected',
    name,
    config,
    capabilities: {},
    client: {},
    cleanup: async () => {},
  }),
}))

mock.module('../../../utils/gracefulShutdown.js', () => ({
  ...actualGraceful,
  gracefulShutdown: async () => {},
}))

// REAL modules under test — no config.js / utils.js / pluginLoader mocks.
const { mcpGetHandler, mcpListHandler } = await import('../mcp.js')
const { getAllMcpConfigs } = await import('../../../services/mcp/config.js')
const { setInlinePlugins } = await import('../../../bootstrap/state.js')
const { clearPluginCache } = await import(
  '../../../utils/plugins/pluginLoader.js'
)
const { clearAuthoredUnexpandedRegistry } = await import(
  '../../../services/mcp/redaction.js'
)

const PLUGIN_NAME = 'e2e-plugin'
const PLUGIN_SERVER = `plugin:${PLUGIN_NAME}:leaky_mcpjson`
const LEAKY_COMMAND = 'node'
const LEAKY_ARGS = '/opt/leakpath/server.js'
const LEAKY_ENV_KEY = 'sk-leak-e2e-001-secret'
const LEAKY_ENV_PASSWORD = 'hunter2-leak-e2e-001'

let baseDir = ''
let savedEnv: Record<string, string | undefined> = {}
let exitSpy: { mockRestore(): void }
let stdoutSpy: { mockRestore(): void }
let logSpy: { mockRestore(): void }
let stderrSpy: { mockRestore(): void }
let exitCodes: Array<number | string | undefined> = []
let logs = ''
let stderr = ''

/** Seed `<baseDir>/plugins/e2e-plugin` the way the reviewer's repro did. */
function seedInlinePlugin(): string {
  const pluginRoot = join(baseDir, 'plugins', PLUGIN_NAME)
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: PLUGIN_NAME,
      version: '1.0.0',
      description: 'E2E-001 seed plugin (leaky stdio .mcp.json server)',
    }),
  )
  writeFileSync(
    join(pluginRoot, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        leaky_mcpjson: {
          type: 'stdio',
          command: LEAKY_COMMAND,
          args: [LEAKY_ARGS],
          env: {
            API_KEY: LEAKY_ENV_KEY,
            PASSWORD: LEAKY_ENV_PASSWORD,
          },
        },
      },
    }),
  )
  return pluginRoot
}

beforeEach(() => {
  savedEnv = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    ENABLE_CLAUDEAI_MCP_SERVERS: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,
    CLAUDE_CODE_SAFE_MODE: process.env.CLAUDE_CODE_SAFE_MODE,
  }
  baseDir = mkdtempSync(join(tmpdir(), 'occ-mcp-get-dynamic-285-'))
  process.env.CLAUDE_CONFIG_DIR = join(baseDir, 'cfg')
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  // Keep the claude.ai connector fetch (network) out of getAllMcpConfigs.
  process.env.ENABLE_CLAUDEAI_MCP_SERVERS = '0'
  // Safe mode skips ALL plugin loading — must be off for the seed to load.
  delete process.env.CLAUDE_CODE_SAFE_MODE

  // Same wiring main.tsx's preAction hook does for `--plugin-dir`.
  setInlinePlugins([seedInlinePlugin()])
  clearPluginCache('mcpGetDynamicScope285 seed')
  clearAuthoredUnexpandedRegistry()

  exitCodes = []
  logs = ''
  stderr = ''
  exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code)
    return undefined
  }) as never)
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
  // Don't leak inline-plugin state (or its memoized load result) into sibling
  // suites sharing this Bun worker (OCC-97).
  setInlinePlugins([])
  clearPluginCache('mcpGetDynamicScope285 teardown')
  clearAuthoredUnexpandedRegistry()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  rmSync(baseDir, { recursive: true, force: true })
})

afterAll(() => {
  mock.module('../../../services/mcp/client.js', () => ({ ...actualClient }))
  mock.module('../../../utils/gracefulShutdown.js', () => ({
    ...actualGraceful,
  }))
  setInlinePlugins([])
  clearPluginCache('mcpGetDynamicScope285 afterAll')
})

describe('E2E-001 — mcp get resolves dynamic-scope servers (real lookup, seeded plugin)', () => {
  test('mcpGetHandler resolves a plugin .mcp.json server and redacts its stdio command/args/env', async () => {
    // Act — the REAL getAllMcpConfigs path inside mcpGetHandler must find the
    // dynamic-scope plugin server (previously: not-found, exit 1).
    await mcpGetHandler(PLUGIN_SERVER)

    // Assert (a) — resolved, not the not-found path
    expect(stderr).not.toContain('No MCP server named')
    expect(exitCodes).not.toContain(1)
    expect(logs).toContain(`${PLUGIN_SERVER}:`)
    expect(logs).toContain('  Scope: Dynamic config (from command line)')
    expect(logs).toContain('  Status: ✔ Connected')

    // Assert (b) — the v285 sanitize branch is now reachable: stdio
    // command → type label, args → [], env values → [REDACTED] (names kept).
    expect(logs).toContain('  Type: stdio')
    expect(logs).toContain('  Command: stdio')
    expect(logs).toContain('    API_KEY=[REDACTED]')
    expect(logs).toContain('    PASSWORD=[REDACTED]')
    expect(logs).not.toContain(LEAKY_ARGS)
    expect(logs).not.toContain(LEAKY_ENV_KEY)
    expect(logs).not.toContain(LEAKY_ENV_PASSWORD)
    expect(logs).toContain(
      `To remove this server, run: occ mcp remove "${PLUGIN_SERVER}" -s dynamic`,
    )
  })

  test('mcp list and mcp get see the same server set', async () => {
    // Arrange — the shared full-scope source both commands must consult.
    const { servers } = await getAllMcpConfigs()
    expect(Object.keys(servers)).toContain(PLUGIN_SERVER)
    expect(servers[PLUGIN_SERVER]?.scope).toBe('dynamic')

    // Act — list renders the dynamic-scope plugin server…
    await mcpListHandler()
    expect(logs).toContain(`${PLUGIN_SERVER}:`)

    // …and get resolves the very same name (the E2E-001 divergence).
    logs = ''
    await mcpGetHandler(PLUGIN_SERVER)

    // Assert
    expect(logs).toContain(`${PLUGIN_SERVER}:`)
    expect(stderr).not.toContain('No MCP server named')
    expect(exitCodes).not.toContain(1)
  })

  test('a genuinely absent name still fails with not-found + Did-you-mean', async () => {
    // Act — one character off the seeded plugin server's name.
    await mcpGetHandler(`${PLUGIN_SERVER}n`)

    // Assert — the not-found + suggester behavior is preserved, and the
    // suggestion no longer names a server the lookup claims is absent.
    expect(stderr).toContain(
      `No MCP server named "${PLUGIN_SERVER}n". Did you mean "${PLUGIN_SERVER}"?`,
    )
    expect(exitCodes[0]).toBe(1)
    expect(logs).not.toContain('  Scope:')
  })
})

/**
 * OCC-103 R2 (P3-c): the hoisted getAllMcpConfigs() made every successful
 * `mcp get` unconditionally await fetchClaudeAIMcpConfigsIfEligible (up to
 * FETCH_TIMEOUT_MS=5000 for claude.ai-OAuth users). mcpGetHandler now resolves
 * the LOCAL no-network set first (getClaudeCodeMcpConfigs — file-backed +
 * plugin dynamic scope) and only falls back to the full-scope fetch when the
 * name is NOT found. Both directions are pinned with a call counter on the
 * claudeai module seam (restored per-test — OCC-97 mock-leak discipline).
 * The pair is self-verifying: if Bun failed to propagate the mid-file
 * mock.module into the already-loaded config.js, the not-found test's
 * `calls === 1` assertion would fail loudly rather than silently pass.
 */
describe('OCC-103 R2 P3-c — mcp get pays the claude.ai connector fetch only on the not-found path', () => {
  async function withFetchCounter(
    fn: (calls: () => number) => Promise<void>,
  ): Promise<void> {
    const actualClaudeai = await import('../../../services/mcp/claudeai.js')
    let calls = 0
    mock.module('../../../services/mcp/claudeai.js', () => ({
      ...actualClaudeai,
      fetchClaudeAIMcpConfigsIfEligible: async () => {
        calls++
        return {}
      },
    }))
    try {
      await fn(() => calls)
    } finally {
      mock.module('../../../services/mcp/claudeai.js', () => actualClaudeai)
    }
  }

  test('server resolves locally → ZERO connector fetch invocations (success path is network-free)', async () => {
    await withFetchCounter(async calls => {
      await mcpGetHandler(PLUGIN_SERVER)
      expect(logs).toContain(`${PLUGIN_SERVER}:`)
      expect(exitCodes).not.toContain(1)
      expect(calls()).toBe(0)
    })
  })

  test('absent name → falls back to the full-scope resolve (exactly ONE fetch), not-found behavior preserved', async () => {
    await withFetchCounter(async calls => {
      await mcpGetHandler(`${PLUGIN_SERVER}n`)
      expect(calls()).toBe(1)
      expect(stderr).toContain(`No MCP server named "${PLUGIN_SERVER}n".`)
      expect(exitCodes[0]).toBe(1)
    })
  })
})
