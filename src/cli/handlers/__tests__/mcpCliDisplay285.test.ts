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
 * CC 2.1.285 items 5–8 — `claude mcp list` / `get` / `remove` / `login` /
 * `logout` CLI display behavior, byte-ported from the official v285 ELF
 * (full mcp CLI module dumped @231363054; not-found builders `iQn`/`u2t`
 * @231333209/@231333318 vs v284 `wQn`/`Czt` @234837644 — identical templates,
 * v285 adds the `Tn` sanitizer):
 *
 * - item 5: get handler display selection v284 `f=Ie({[o]:i})[o]??fe(i)` →
 *   v285 `h=Die(i)&&!OKe.has(i.scope)?Y(i):Ie({[o]:i})[o]??Y(i)` — a stdio
 *   server whose scope is NOT file-backed (dynamic) renders from the
 *   SANITIZED copy (command → type label, args → [], env values →
 *   [REDACTED]; variable names kept), bypassing the authored registry.
 * - item 6: stdio branch gate v284 `i.type==="stdio"&&f.type==="stdio"` →
 *   v285 `Die(i)&&Die(h)` — a typeless stdio entry now prints Type/Command/
 *   Args/Environment.
 * - item 7: row builder `Fe` gains `if(o.type==="ws")return`${f}: ${o.url}
 *   (WS) - ${a}`;` — "(WS) - " exists ONLY in v285 bytes (@231389086).
 * - item 8: v284 `d.map(Fe).filter(Dr)` → v285 `d.map(Fe).filter(Fr).map(Tn)`
 *   and get renders `R.map(Tn).join("\n")` (v284: `M.join("\n")`) — hostile
 *   names/values cannot inject line breaks or ANSI escapes.
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only what this test drives, restore after.
const actualMcpConfig = await import('../../../services/mcp/config.js')
const actualClient = await import('../../../services/mcp/client.js')
const actualUtils = await import('../../../services/mcp/utils.js')
const actualGraceful = await import('../../../utils/gracefulShutdown.js')
const {
  registerAuthoredUnexpandedConfig,
  clearAuthoredUnexpandedRegistry,
} = await import('../../../services/mcp/redaction.js')

let mockedByName: Record<string, ScopedMcpServerConfig> = {}
let mockedAll: Record<string, ScopedMcpServerConfig> = {}
let mockedProject: Record<string, ScopedMcpServerConfig> = {}
let mockedUserAuthored: Record<string, ScopedMcpServerConfig> = {}
let mockedPendingNames: Set<string> = new Set()

mock.module('../../../services/mcp/config.js', () => ({
  ...actualMcpConfig,
  getMcpConfigByName: (name: string) => mockedByName[name],
  getAllMcpConfigs: async () => ({ servers: mockedAll }),
  getMcpConfigsByScope: (scope: string) =>
    scope === 'project'
      ? { servers: mockedProject }
      : scope === 'user'
        ? { servers: mockedUserAuthored }
        : { servers: {} },
}))

// The list/get handlers health-check every server via connectToServer — the
// real one would spawn stdio subprocesses / open sockets, so report connected.
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

// getProjectMcpServerStatus reads real settings (no CLAUDE_CONFIG_DIR
// redirection in src/utils/settings) — pin it for deterministic pending state.
mock.module('../../../services/mcp/utils.js', () => ({
  ...actualUtils,
  getProjectMcpServerStatus: (name: string) =>
    mockedPendingNames.has(name) ? 'pending' : 'approved',
}))

mock.module('../../../utils/gracefulShutdown.js', () => ({
  ...actualGraceful,
  gracefulShutdown: async () => {},
}))

// NOTE: `src/utils/config.js` is deliberately NOT mocked here. This suite
// isolates via a per-test `CLAUDE_CONFIG_DIR` temp dir (see beforeEach), and the
// server lists the handlers render come from the `services/mcp/config.js` mock
// above — so the real global/project config is already empty of MCP servers.
// Mocking config.js here is both unnecessary and harmful: Bun runs test files in
// one worker and `mock.module` is process-global (OCC-97). A sibling suite
// (mcpRemoveAuthCache280) captures `await import('config.js')` at its top level
// and snapshots `getGlobalConfig()` once; if THIS file's config.js mock is still
// registered at that moment, the sibling snapshots a MOCK and its afterAll
// "restore" re-registers that mock instead of the real module. The stale config
// then leaks into mcpSlice218 #20, whose `getMcpNeedsAuthCount` reads
// `claudeAiMcpEverConnected` via `getGlobalConfig()` after writing it with
// `saveGlobalConfig()` — the frozen snapshot drops the entry and the count is
// short by one. Not mocking config.js keeps the sibling's capture real.

const {
  mcpListHandler,
  mcpGetHandler,
  mcpRemoveHandler,
  mcpLoginHandler,
  mcpLogoutHandler,
} = await import('../mcp.js')

afterAll(() => {
  mock.module('../../../services/mcp/config.js', () => ({ ...actualMcpConfig }))
  mock.module('../../../services/mcp/client.js', () => ({ ...actualClient }))
  mock.module('../../../services/mcp/utils.js', () => ({ ...actualUtils }))
  mock.module('../../../utils/gracefulShutdown.js', () => ({
    ...actualGraceful,
  }))
})

let configDir = ''
let savedConfigDir: string | undefined
let exitSpy: { mockRestore(): void }
let stdoutSpy: { mockRestore(): void }
let logSpy: { mockRestore(): void }
let stderrSpy: { mockRestore(): void }
let exitCodes: Array<number | string | undefined> = []
let logs = ''
let stderr = ''

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'occ-mcp-cli-285-'))
  process.env.CLAUDE_CONFIG_DIR = configDir

  mockedByName = {}
  mockedAll = {}
  mockedProject = {}
  mockedUserAuthored = {}
  mockedPendingNames = new Set()
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
  clearAuthoredUnexpandedRegistry()
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

describe('2.1.285 item 7 — mcpListHandler renders ws servers', () => {
  test('a ws server is listed with its URL, the (WS) marker and health', async () => {
    // Arrange — v284 silently dropped ws rows (no branch in `Fe`); v285 adds
    // `${f}: ${o.url} (WS) - ${a}` between the http and claudeai branches.
    const wsServer = {
      type: 'ws',
      url: 'wss://example.com/mcp',
      scope: 'user',
    } as ScopedMcpServerConfig
    mockedAll = { wssrv: wsServer }
    mockedUserAuthored = { wssrv: wsServer }

    // Act
    await mcpListHandler()

    // Assert
    expect(logs).toContain('wssrv: wss://example.com/mcp (WS) - ✔ Connected')
  })
})

describe('2.1.285 item 8 — mcpListHandler sanitizes hostile rows', () => {
  test('line breaks and ANSI escapes in names/values are neutralized', async () => {
    // Arrange
    const httpServer = {
      type: 'http',
      url: 'http://x.test/mcp',
      scope: 'user',
    } as ScopedMcpServerConfig
    const sseServer = {
      type: 'sse',
      url: 'http://y.test/sse',
      scope: 'user',
    } as ScopedMcpServerConfig
    mockedAll = {
      'evil\nname': httpServer,
      '\x1b[31mred\x1b[0m': sseServer,
    }
    mockedUserAuthored = { ...mockedAll }

    // Act
    await mcpListHandler()

    // Assert — the row text survives, the control characters do not
    expect(logs).toContain('evil name: http://x.test/mcp (HTTP) - ✔ Connected')
    expect(logs).toContain(
      ' [31mred [0m: http://y.test/sse (SSE) - ✔ Connected',
    )
    expect(logs).not.toContain('evil\nname')
    expect(logs).not.toContain('\x1b')
  })
})

describe('2.1.285 item 6 — mcpGetHandler renders typeless stdio servers', () => {
  test('a stdio config omitting `type` prints Type/Command/Args/Environment', async () => {
    // Arrange — v284 required literal `i.type==="stdio"&&f.type==="stdio"`,
    // so this entry printed no details at all; v285 gates on `Die(i)&&Die(h)`
    // (stdio OR typeless).
    const plainServer = {
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'secret-value' },
      scope: 'user',
    } as unknown as ScopedMcpServerConfig
    // E2E-001 fix: mcpGetHandler now resolves through getAllMcpConfigs (the
    // same full-scope set `mcp list` renders), not getMcpConfigByName.
    mockedAll = { plain: plainServer }
    mockedByName = { plain: plainServer }
    mockedUserAuthored = { plain: plainServer }

    // Act
    await mcpGetHandler('plain')

    // Assert — one sanitized joined block (v285 `R.map(Tn).join("\n")`)
    expect(logs).toContain('plain:')
    expect(logs).toContain('  Scope: User config (available in all your projects)')
    expect(logs).toContain('  Status: ✔ Connected')
    expect(logs).toContain('  Type: stdio')
    expect(logs).toContain('  Command: node')
    expect(logs).toContain('  Args: server.js')
    expect(logs).toContain('  Environment:')
    expect(logs).toContain('    TOKEN=secret-value')
    expect(logs).toContain('To remove this server, run: occ mcp remove "plain" -s user')
  })
})

describe('2.1.285 item 5 — mcpGetHandler redacts dynamic-scope stdio secrets', () => {
  test('a plugin/dynamic stdio server shows redacted values but keeps names', async () => {
    // Arrange — v285 ternary `Die(i)&&!OKe.has(i.scope)?Y(i):…` forces the
    // SANITIZED copy for non-file-backed scopes even when the authored
    // unexpanded registry holds the real values (the v284 path would have
    // printed the authored command/args/env verbatim).
    const plugServer = {
      type: 'stdio',
      command: 'secret-cmd',
      args: ['--token=abc'],
      env: { API_KEY: 'super-secret' },
      scope: 'dynamic',
    } as ScopedMcpServerConfig
    // E2E-001 fix: the get handler resolves dynamic-scope servers through
    // getAllMcpConfigs; seed the mocked full-scope set (real-lookup coverage
    // lives in mcpGetDynamicScope285.test.ts).
    mockedAll = { plug: plugServer }
    mockedByName = { plug: plugServer }
    registerAuthoredUnexpandedConfig('plug', plugServer)

    // Act
    await mcpGetHandler('plug')

    // Assert
    expect(logs).toContain('  Scope: Dynamic config (from command line)')
    expect(logs).toContain('  Type: stdio')
    expect(logs).toContain('  Command: stdio')
    expect(logs).toContain('  Args: ')
    expect(logs).toContain('    API_KEY=[REDACTED]')
    expect(logs).not.toContain('secret-cmd')
    expect(logs).not.toContain('--token=abc')
    expect(logs).not.toContain('super-secret')
  })
})

describe('2.1.285 item 8 — not-found messages (iQn / u2t builders)', () => {
  test('mcpGetHandler suggests a close spelling from configured names', async () => {
    // Arrange
    mockedAll = {
      github: {
        type: 'http',
        url: 'http://gh.test/mcp',
        scope: 'user',
      } as ScopedMcpServerConfig,
    }

    // Act
    await mcpGetHandler('githb')

    // Assert
    expect(stderr).toContain(
      'No MCP server named "githb". Did you mean "github"? Run `occ mcp list` to see all.',
    )
    expect(exitCodes[0]).toBe(1)
  })

  test('mcpGetHandler appends the pending-approval note parenthesized', async () => {
    // Arrange — `u2t(t,M,r.size>0)`: M = configured names, r = pending
    // .mcp.json servers.
    mockedAll = {
      alpha: {
        type: 'http',
        url: 'http://a.test/mcp',
        scope: 'user',
      } as ScopedMcpServerConfig,
    }
    mockedProject = {
      pend: { type: 'stdio', command: 'x', args: [], scope: 'project' } as ScopedMcpServerConfig,
    }
    mockedPendingNames = new Set(['pend'])

    // Act
    await mcpGetHandler('evil\nname')

    // Assert — hostile name sanitized; pending note parenthesized after the
    // enumeration.
    expect(stderr).toContain(
      'No MCP server named "evil name". Configured servers: alpha ' +
        '(.mcp.json servers are awaiting approval — run `occ` in this ' +
        'directory to review them.)',
    )
    expect(stderr).not.toContain('\nname')
    expect(exitCodes[0]).toBe(1)
  })

  test('mcpGetHandler stands the pending note alone when nothing is configured', async () => {
    // Arrange
    mockedProject = {
      pend: { type: 'stdio', command: 'x', args: [], scope: 'project' } as ScopedMcpServerConfig,
    }
    mockedPendingNames = new Set(['pend'])

    // Act
    await mcpGetHandler('nope')

    // Assert
    expect(stderr).toContain(
      'No MCP server named "nope". .mcp.json servers are awaiting approval — ' +
        'run `occ` in this directory to review them.',
    )
    expect(exitCodes[0]).toBe(1)
  })

  test('mcpRemoveHandler sanitizes a hostile name in the add-one hint', async () => {
    // Arrange — all three name sources (local config, raw .mcp.json, user
    // config) are empty in this harness.
    // Act
    await mcpRemoveHandler('evil\nname', {})

    // Assert
    expect(stderr).toContain(
      'No MCP server named "evil name". Run `occ mcp add` to add one.',
    )
    expect(exitCodes[0]).toBe(1)
  })

  test('mcpLoginHandler neutralizes ANSI escapes in the queried name', async () => {
    // Act
    await mcpLoginHandler('\x1b[31mred\x1b[0m', {})

    // Assert
    expect(stderr).toContain('No MCP server named " [31mred [0m"')
    expect(stderr).not.toContain('\x1b')
    expect(exitCodes[0]).toBe(1)
  })

  test('mcpLogoutHandler collapses CR/tab runs in the queried name', async () => {
    // Act
    await mcpLogoutHandler('server\r\tname')

    // Assert
    expect(stderr).toContain(
      'No MCP server named "server name". Run `occ mcp add` to add one.',
    )
    expect(exitCodes[0]).toBe(1)
  })
})
