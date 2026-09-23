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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScopedMcpServerConfig } from '../../../services/mcp/types.js'

/**
 * claude-code 2.1.280 (#048) — `claude mcp remove` drops the needs-auth cache
 * entry UNCONDITIONALLY, so a server re-added under the same name inside the
 * 15-min TTL reconnects instead of inheriting the stale `needs-auth` flag.
 *
 * Byte-verified against the official 2.1.280 linux-x64 ELF (@219311718, the
 * `lo(S,o,d,p)` remove handler):
 *
 *   m=async()=>{
 *     if(await me().removeMcpAuthCacheEntry(o,p),        // ← unconditional, first
 *        a&&(a.type==="sse"||a.type==="http"))
 *       try{await V().clearServerTokensFromLocalStorage(o,a),
 *           await V().clearMcpClientConfig(o,a)}
 *       catch(j){t(`mcp remove: secure-storage cleanup for "${o}" failed: ${l(j)}`,
 *                  {level:"warn"})}}
 *   …
 *   await lkn(o,f,p),await m(),i=f       // scoped branch
 *   await lkn(o,M,p),await m(),i=M       // single-scope branch
 *
 * The 2.1.278 handler (@220132743, `Jr(f,o,d,p)`) is identical MINUS the
 * prepended `await removeMcpAuthCacheEntry(...)` — that single call is the
 * whole #048 delta. The warn-log catch around the secure-storage cleanup
 * already existed in 2.1.278 and is ported here too (OCC had no catch, so a
 * keychain failure aborted `mcp remove` after the config was already gone).
 *
 * Cleanup runs only after a successful `removeMcpConfig` — the not-found path
 * must NOT touch the cache (asserted below).
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only what this test drives, restore after.
const actualMcpConfig = await import('../../../services/mcp/config.js')
const actualUtilsConfig = await import('../../../utils/config.js')
const actualAuth = await import('../../../services/mcp/auth.js')

const SERVER = 'srv'
const CACHE_FILENAME = 'mcp-needs-auth-cache.json'

let configDir = ''
let mockedServerConfig: ScopedMcpServerConfig | undefined
let mockedUserServers: Record<string, unknown> = {}
let removedConfigs: Array<{ name: string; scope: string }> = []
let cleanerCalls: Array<{ fn: string; entryAlreadyGone: boolean }> = []
let secureStorageThrows = false

function cachePath(): string {
  return join(configDir, CACHE_FILENAME)
}

function cacheHasKey(name: string): boolean {
  if (!existsSync(cachePath())) {
    return false
  }
  const parsed = JSON.parse(readFileSync(cachePath(), 'utf-8')) as Record<
    string,
    unknown
  >
  return name in parsed
}

function recordCleaner(fn: string): void {
  // Snapshot the real cache file at cleaner time: this is what proves the
  // auth-cache removal happened BEFORE the sse/http secure-storage gate.
  cleanerCalls.push({ fn, entryAlreadyGone: !cacheHasKey(SERVER) })
  if (secureStorageThrows) {
    throw new Error('keychain unavailable')
  }
}

let baseGlobalConfig: Record<string, unknown> = {}
try {
  baseGlobalConfig = actualUtilsConfig.getGlobalConfig() as unknown as Record<
    string,
    unknown
  >
} catch {
  baseGlobalConfig = {}
}

mock.module('../../../services/mcp/config.js', () => ({
  ...actualMcpConfig,
  getMcpConfigByName: (name: string) =>
    name === SERVER ? mockedServerConfig : undefined,
  removeMcpConfig: async (name: string, scope: string) => {
    removedConfigs.push({ name, scope })
  },
  getMcpConfigsByScope: () => ({ servers: {} }),
}))

mock.module('../../../utils/config.js', () => ({
  ...actualUtilsConfig,
  getCurrentProjectConfig: () => ({ ...baseGlobalConfig, mcpServers: {} }),
  getGlobalConfig: () => ({
    ...baseGlobalConfig,
    mcpServers: mockedUserServers,
  }),
}))

mock.module('../../../services/mcp/auth.js', () => ({
  ...actualAuth,
  clearServerTokensFromLocalStorage: () => {
    recordCleaner('clearServerTokensFromLocalStorage')
  },
  clearMcpClientConfig: () => {
    recordCleaner('clearMcpClientConfig')
  },
}))

const { _resetMcpAuthCacheForTesting } = await import(
  '../../../services/mcp/client.js'
)
const { mcpRemoveHandler } = await import('../mcp.js')

afterAll(() => {
  mock.module('../../../services/mcp/config.js', () => ({ ...actualMcpConfig }))
  mock.module('../../../utils/config.js', () => ({ ...actualUtilsConfig }))
  mock.module('../../../services/mcp/auth.js', () => ({ ...actualAuth }))
})

let savedConfigDir: string | undefined
let exitSpy: { mockRestore(): void }
let stdoutSpy: { mockRestore(): void }
let stderrSpy: { mockRestore(): void }
let exitCodes: Array<number | string | undefined> = []
let stdout = ''
let stderr = ''

/** Let any in-flight writeChain / file work from a previous test settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

function seedCache(names: string[]): void {
  const entries: Record<string, { timestamp: number }> = {}
  for (const name of names) {
    entries[name] = { timestamp: Date.now() }
  }
  writeFileSync(cachePath(), JSON.stringify(entries))
}

beforeEach(async () => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'occ-mcp-remove-280-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  // Reset the memoized needs-auth read so the handler sees THIS temp dir.
  // Not clearMcpAuthCache(): Bun's mock.module leaks across test files in one
  // worker (OCC-97) and mcpAuthStubTools274.test.ts replaces that export with a
  // call counter, which would silently leave a stale memo in place.
  _resetMcpAuthCacheForTesting()
  await settle()

  mockedServerConfig = undefined
  mockedUserServers = {}
  removedConfigs = []
  cleanerCalls = []
  secureStorageThrows = false
  exitCodes = []
  stdout = ''
  stderr = ''

  exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code)
    return undefined
  }) as never)
  stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
    (chunk: unknown) => {
      stdout += String(chunk)
      return true
    },
  )
  stderrSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr += args.map(arg => String(arg)).join(' ')
  })
})

afterEach(async () => {
  exitSpy.mockRestore()
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  _resetMcpAuthCacheForTesting()
  await settle()
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

function withServer(config: ScopedMcpServerConfig): void {
  mockedServerConfig = config
  mockedUserServers = { [SERVER]: config }
}

const stdioConfig = {
  type: 'stdio',
  command: 'echo',
  args: [],
  scope: 'user',
} as ScopedMcpServerConfig

const httpConfig = {
  type: 'http',
  url: 'http://127.0.0.1:1/mcp',
  scope: 'user',
} as ScopedMcpServerConfig

const sseConfig = {
  type: 'sse',
  url: 'http://127.0.0.1:1/sse',
  scope: 'user',
} as ScopedMcpServerConfig

describe('2.1.280 #048 — mcpRemoveHandler drops the needs-auth cache entry', () => {
  test('stdio: the entry is removed even though no secure storage applies', async () => {
    withServer(stdioConfig)
    seedCache([SERVER])

    await mcpRemoveHandler(SERVER, {})

    expect(cacheHasKey(SERVER)).toBe(false)
    // The sse/http gate still skips secure storage for a stdio server —
    // proof the removal is unconditional and not part of that branch.
    expect(cleanerCalls).toEqual([])
    expect(removedConfigs).toEqual([{ name: SERVER, scope: 'user' }])
    expect(exitCodes[0]).toBe(0)
    expect(stdout).toContain(`Removed MCP server "${SERVER}" from user config`)
  })

  test('http: the entry is removed BEFORE the secure-storage cleanup', async () => {
    withServer(httpConfig)
    seedCache([SERVER])

    await mcpRemoveHandler(SERVER, {})

    expect(cacheHasKey(SERVER)).toBe(false)
    expect(cleanerCalls).toEqual([
      { fn: 'clearServerTokensFromLocalStorage', entryAlreadyGone: true },
      { fn: 'clearMcpClientConfig', entryAlreadyGone: true },
    ])
    expect(exitCodes[0]).toBe(0)
  })

  test('sse: the entry is removed and secure storage is cleaned', async () => {
    withServer(sseConfig)
    seedCache([SERVER])

    await mcpRemoveHandler(SERVER, {})

    expect(cacheHasKey(SERVER)).toBe(false)
    expect(cleanerCalls.map(call => call.fn)).toEqual([
      'clearServerTokensFromLocalStorage',
      'clearMcpClientConfig',
    ])
    expect(exitCodes[0]).toBe(0)
  })

  test('sibling entries survive a single-server removal', async () => {
    withServer(httpConfig)
    seedCache([SERVER, 'other'])

    await mcpRemoveHandler(SERVER, {})

    expect(cacheHasKey(SERVER)).toBe(false)
    expect(cacheHasKey('other')).toBe(true)
  })

  test('an explicit --scope removal drops the entry too', async () => {
    withServer(httpConfig)
    seedCache([SERVER])

    await mcpRemoveHandler(SERVER, { scope: 'user' })

    expect(removedConfigs[0]).toEqual({ name: SERVER, scope: 'user' })
    expect(cacheHasKey(SERVER)).toBe(false)
    expect(exitCodes[0]).toBe(0)
    expect(stdout).toContain(`Removed MCP server ${SERVER} from user config`)
  })

  test('a secure-storage failure only warns — the removal still succeeds', async () => {
    withServer(httpConfig)
    seedCache([SERVER])
    secureStorageThrows = true

    await mcpRemoveHandler(SERVER, {})

    // Official: the catch logs `mcp remove: secure-storage cleanup for "<name>"
    // failed: <err>` at warn level and the command still reports success.
    expect(cacheHasKey(SERVER)).toBe(false)
    expect(exitCodes[0]).toBe(0)
    expect(stdout).toContain(`Removed MCP server "${SERVER}" from user config`)
    expect(cleanerCalls[0]?.fn).toBe('clearServerTokensFromLocalStorage')
  })

  test('a missing cache file is tolerated on every server type', async () => {
    for (const config of [stdioConfig, httpConfig, sseConfig]) {
      withServer(config)
      removedConfigs = []
      exitCodes = []
      stdout = ''
      cleanerCalls = []
      expect(existsSync(cachePath())).toBe(false)

      await mcpRemoveHandler(SERVER, {})

      expect(existsSync(cachePath())).toBe(false)
      expect(exitCodes[0]).toBe(0)
    }
  })

  test('the not-found path leaves the cache untouched', async () => {
    // No config, no scope holds the name → cliError before any cleanup.
    mockedServerConfig = undefined
    mockedUserServers = {}
    seedCache([SERVER])

    await mcpRemoveHandler(SERVER, {})

    expect(removedConfigs).toEqual([])
    expect(cacheHasKey(SERVER)).toBe(true)
    expect(exitCodes[0]).toBe(1)
    expect(stderr).toContain(`No MCP server found with name: "${SERVER}"`)
  })
})
