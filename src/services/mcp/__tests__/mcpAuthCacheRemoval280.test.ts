import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScopedMcpServerConfig } from '../types.js'
import {
  _resetMcpAuthCacheForTesting,
  getMcpToolsCommandsAndResources,
  removeMcpAuthCacheEntry,
} from '../client.js'

/**
 * claude-code 2.1.280 (#048) — per-key removal from the MCP needs-auth cache.
 *
 * "Fixed an MCP server re-added under the same name after `claude mcp remove`
 * still showing as needing authentication instead of reconnecting."
 *
 * Byte-verified against the official 2.1.280 linux-x64 ELF:
 *   function ln(e,n){let r=jt(),s=r.authCacheWriteChain.then(async()=>{
 *     let d=await WAe(n);                    // memoized read, .catch(()=>({}))
 *     if(!(e in d))return;                   // absent key → no write at all
 *     if(delete d[e],N()&&n!==void 0){if(!await or(n,d))return}
 *     else await Kt().write(jAe(),S(d));     // rewrite mcp-needs-auth-cache.json
 *     i6e()                                  // invalidate the memoized read
 *   }).catch(()=>{});                        // never rejects
 *   return r.authCacheWriteChain=s,s}                                     @223017165
 *   (duplicate chunk copy as `Ct`                                       @223184732)
 *   cache path: function jAe(){return E(we(),"mcp-needs-auth-cache.json")} @212523133
 *
 * The function already existed in 2.1.278 (5 `removeMcpAuthCacheEntry` hits —
 * `mcp login` called it); the 2.1.280 delta is the 6th hit: the new
 * unconditional call from the `mcp remove` handler (@219311718), covered in
 * src/cli/handlers/__tests__/mcpRemoveAuthCache280.test.ts.
 *
 * The only consumer of the cache is the connect-path gate
 * (`getMcpToolsCommandsAndResources` → `isMcpAuthCached`), which reports a
 * cached server as `needs-auth` without ever dialing it — that is the stale
 * flag a re-added server used to inherit for the rest of the 15-min TTL.
 */

const CACHE_FILENAME = 'mcp-needs-auth-cache.json'

let savedConfigDir: string | undefined
let configDir = ''

/** Let any in-flight writeChain / file work from a previous test settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

function cachePath(): string {
  return join(configDir, CACHE_FILENAME)
}

function readCache(): Record<string, { timestamp: number }> {
  return JSON.parse(readFileSync(cachePath(), 'utf-8')) as Record<
    string,
    { timestamp: number }
  >
}

function writeCache(data: unknown): void {
  writeFileSync(cachePath(), JSON.stringify(data))
}

beforeEach(async () => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  // A fresh dir per test: getClaudeConfigHomeDir() is memoized on
  // CLAUDE_CONFIG_DIR, so a new value yields a new cache path.
  configDir = mkdtempSync(join(tmpdir(), 'occ-mcp-auth-cache-280-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  // Drop the module-level memoized read promise so this test reads its own dir.
  // Uses the dedicated reset (not clearMcpAuthCache) because Bun's mock.module
  // leaks across test files in one worker (OCC-97) and
  // mcpAuthStubTools274.test.ts replaces clearMcpAuthCache with a call counter,
  // which would leave the stale memo in place and make removals look like
  // no-ops. clearMcpAuthCache would also unlink the fixture we seed below.
  _resetMcpAuthCacheForTesting()
  await settle()
})

afterEach(async () => {
  _resetMcpAuthCacheForTesting()
  await settle()
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

describe('2.1.280 #048 — removeMcpAuthCacheEntry', () => {
  test('removes the named entry and preserves its siblings', async () => {
    const now = Date.now()
    writeCache({
      removed: { timestamp: now },
      kept: { timestamp: now },
    })

    await removeMcpAuthCacheEntry('removed')

    expect(readCache()).toEqual({ kept: { timestamp: now } })
  })

  test('an absent key is a no-op — the file is not rewritten', async () => {
    const original = JSON.stringify({ kept: { timestamp: Date.now() } })
    // Raw write (not writeCache, which would JSON-encode the string again).
    writeFileSync(cachePath(), original)

    await removeMcpAuthCacheEntry('never-there')

    // Byte-identical: `if(!(e in d))return` skips the write entirely.
    expect(readFileSync(cachePath(), 'utf-8')).toBe(original)
  })

  test('a missing cache file is tolerated and is not created', async () => {
    expect(existsSync(cachePath())).toBe(false)

    await expect(removeMcpAuthCacheEntry('srv')).resolves.toBeUndefined()

    expect(existsSync(cachePath())).toBe(false)
  })

  test('a corrupt cache file is tolerated (read .catch(()=>({})))', async () => {
    writeFileSync(cachePath(), '{not json at all')

    await expect(removeMcpAuthCacheEntry('srv')).resolves.toBeUndefined()

    // Nothing parsed → no key → no rewrite; the corrupt file is left alone
    // rather than being clobbered or throwing.
    expect(readFileSync(cachePath(), 'utf-8')).toBe('{not json at all')
  })

  test('a cache file holding a non-object JSON value never throws', async () => {
    // `key in "string"` throws a TypeError; the official `.catch(()=>{})`
    // swallows it, so `mcp remove` still succeeds on a damaged cache file.
    writeFileSync(cachePath(), JSON.stringify('not-an-object'))

    await expect(removeMcpAuthCacheEntry('srv')).resolves.toBeUndefined()

    expect(readFileSync(cachePath(), 'utf-8')).toBe(
      JSON.stringify('not-an-object'),
    )
  })

  test('the memoized read is invalidated so the next read sees the removal', async () => {
    const now = Date.now()
    writeCache({ srv: { timestamp: now } })

    // Prime the memoized read promise, then remove.
    await getMcpToolsCommandsAndResources(() => {}, {
      srv: { type: 'claudeai-proxy', scope: 'user' } as ScopedMcpServerConfig,
    })
    await removeMcpAuthCacheEntry('srv')

    expect(readCache()).toEqual({})
  })

  test('concurrent removals serialize on the write chain', async () => {
    const now = Date.now()
    writeCache({
      a: { timestamp: now },
      b: { timestamp: now },
      c: { timestamp: now },
    })

    await Promise.all([
      removeMcpAuthCacheEntry('a'),
      removeMcpAuthCacheEntry('b'),
      removeMcpAuthCacheEntry('c'),
    ])

    expect(readCache()).toEqual({})
  })
})

describe('2.1.280 #048 — connect-path needs-auth gate', () => {
  const httpConfig = {
    type: 'http',
    url: 'http://127.0.0.1:1/mcp',
    scope: 'user',
  } as ScopedMcpServerConfig

  async function gateVerdict(
    name: string,
    config: ScopedMcpServerConfig,
  ): Promise<string[]> {
    const types: string[] = []
    await getMcpToolsCommandsAndResources(
      ({ client }) => {
        types.push(client.type)
      },
      { [name]: config },
    )
    return types
  }

  test('a cached entry short-circuits the connection to needs-auth', async () => {
    writeCache({ srv: { timestamp: Date.now() } })

    expect(await gateVerdict('srv', httpConfig)).toEqual(['needs-auth'])
  })

  test('after removal the same name is no longer flagged needs-auth', async () => {
    writeCache({ srv: { timestamp: Date.now() } })
    expect(await gateVerdict('srv', httpConfig)).toEqual(['needs-auth'])

    await removeMcpAuthCacheEntry('srv')

    // The gate no longer short-circuits: the server is dialed again (this
    // unreachable port fails fast) instead of being reported as needs-auth —
    // which is exactly the re-added-server bug the 2.1.280 fix closes.
    const types = await gateVerdict('srv', httpConfig)
    expect(types).not.toContain('needs-auth')
    expect(types.length).toBe(1)
  })

  test('an expired entry (past the 15-min TTL) does not flag needs-auth', async () => {
    writeCache({ srv: { timestamp: Date.now() - 16 * 60 * 1000 } })

    const types = await gateVerdict('srv', httpConfig)
    expect(types).not.toContain('needs-auth')
  })
})
