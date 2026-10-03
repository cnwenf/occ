import { describe, expect, test } from 'bun:test'
import { fetchToolsForClient } from '../client.js'
import type {
  ConfigScope,
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../types.js'

/**
 * CC 2.1.285 (item 4) — a tool that sets its own
 * `_meta['anthropic/alwaysLoad']` to false STAYS DEFERRED when its
 * dynamic-scope server (--mcp-config / Agent SDK / plugin) sets `alwaysLoad`.
 *
 * Byte evidence — binary factory formula:
 *   v284: alwaysLoad:h||k._meta?.["anthropic/alwaysLoad"]===!0
 *   v285: alwaysLoad:h&&!(r==="dynamic"&&D._meta?.["anthropic/alwaysLoad"]===!1)
 *                  ||D._meta?.["anthropic/alwaysLoad"]===!0
 * Call sites are byte-identical in BOTH versions (v285 @229107828,
 * v284 @231460727): `serverAlwaysLoad:e.config.alwaysLoad===!0,
 * scope:e.config.scope`. "anthropic/alwaysLoad" string hits: v285=8, v284=3.
 * Schema describe text gained ", except a tool the server itself lists with
 * _meta anthropic/alwaysLoad set to false" (v285 3x @197482629 region).
 *
 * fetchToolsForClient is memoized BY SERVER NAME (LRU keyed on client.name),
 * so every case below uses a unique name and clears its cache entry.
 */

function fakeConnection(
  name: string,
  scope: ConfigScope,
  serverAlwaysLoad: boolean | undefined,
  toolMeta: Record<string, unknown> | undefined,
): MCPServerConnection {
  const config = {
    type: 'stdio',
    command: 'srv',
    args: [],
    scope,
    ...(serverAlwaysLoad === undefined ? {} : { alwaysLoad: serverAlwaysLoad }),
  } as ScopedMcpServerConfig
  return {
    type: 'connected',
    name,
    capabilities: { tools: {} },
    config,
    client: {
      request: async () => ({
        tools: [
          {
            name: 'toolA',
            description: 'd',
            inputSchema: { type: 'object' },
            ...(toolMeta === undefined ? {} : { _meta: toolMeta }),
          },
        ],
      }),
    },
    cleanup: async () => {},
  } as unknown as MCPServerConnection
}

async function alwaysLoadFor(
  name: string,
  scope: ConfigScope,
  serverAlwaysLoad: boolean | undefined,
  toolMeta: Record<string, unknown> | undefined,
): Promise<boolean> {
  fetchToolsForClient.cache.delete(name)
  const connection = fakeConnection(name, scope, serverAlwaysLoad, toolMeta)

  const tools = await fetchToolsForClient(connection)

  expect(tools).toHaveLength(1)
  fetchToolsForClient.cache.delete(name)
  return tools[0]?.alwaysLoad === true
}

describe('2.1.285 item 4 — fetchToolsForClient alwaysLoad formula', () => {
  test('dynamic-scope server alwaysLoad + tool _meta false stays deferred', async () => {
    // The headline 2.1.285 fix: explicit tool-level false wins over a
    // dynamic-scope server-level alwaysLoad.
    const result = await alwaysLoadFor('alw285-dyn-meta-false', 'dynamic', true, {
      'anthropic/alwaysLoad': false,
    })

    expect(result).toBe(false)
  })

  test('dynamic-scope server alwaysLoad + tool _meta true loads eagerly', async () => {
    const result = await alwaysLoadFor('alw285-dyn-meta-true', 'dynamic', true, {
      'anthropic/alwaysLoad': true,
    })

    expect(result).toBe(true)
  })

  test('dynamic-scope server alwaysLoad without tool _meta loads eagerly', async () => {
    const result = await alwaysLoadFor('alw285-dyn-no-meta', 'dynamic', true, undefined)

    expect(result).toBe(true)
  })

  test('non-dynamic scope keeps the server-level flag despite tool _meta false', async () => {
    // The v285 override is gated on scope==="dynamic" — a user-scope server
    // with alwaysLoad still force-loads even when the tool says false.
    const result = await alwaysLoadFor('alw285-user-meta-false', 'user', true, {
      'anthropic/alwaysLoad': false,
    })

    expect(result).toBe(true)
  })

  test('tool _meta true loads eagerly without any server flag', async () => {
    const result = await alwaysLoadFor('alw285-nosrv-meta-true', 'dynamic', undefined, {
      'anthropic/alwaysLoad': true,
    })

    expect(result).toBe(true)
  })

  test('tool _meta false without a server flag stays deferred', async () => {
    const result = await alwaysLoadFor('alw285-nosrv-meta-false', 'dynamic', undefined, {
      'anthropic/alwaysLoad': false,
    })

    expect(result).toBe(false)
  })

  test('neither server flag nor tool _meta leaves the tool deferred', async () => {
    const result = await alwaysLoadFor('alw285-plain', 'project', undefined, undefined)

    expect(result).toBe(false)
  })

  test('server alwaysLoad:false never force-loads even with unrelated _meta', async () => {
    const result = await alwaysLoadFor('alw285-srv-false', 'dynamic', false, {
      'anthropic/searchHint': 'hint',
    })

    expect(result).toBe(false)
  })
})

/**
 * CC 2.1.287 (#7) — "Changed MCP server `alwaysLoad: false` to defer all of
 * that server's tools behind tool search."
 *
 * Byte evidence — v287 factories On()@232967426 / La()@233273756 add
 *   serverDefersAllTools:e.config.alwaysLoad===!1
 * (novelty: v286=0 → v287 new) and the v287 gate @232962174 prefixes the
 * v285 formula with `!g&&`:
 *   alwaysLoad:!g&&(h&&!(r==="dynamic"&&U._meta?.["anthropic/alwaysLoad"]===!1)
 *             ||U._meta?.["anthropic/alwaysLoad"]===!0)
 * (g=serverDefersAllTools, h=serverAlwaysLoad, r=config.scope). The !g&&
 * prefix overrides even a tool-level _meta true, so a server with
 * `alwaysLoad:false` defers EVERY one of its tools; `alwaysLoad:true` and
 * undefined are unchanged from the v285 formula.
 */
describe('2.1.287 item 7 — server alwaysLoad:false defers ALL its tools', () => {
  test('server alwaysLoad:false + tool _meta true stays deferred (the v285 formula would have loaded it)', async () => {
    // The headline 2.1.287 change: the !g&& prefix overrides the tool-level
    // _meta['anthropic/alwaysLoad']===true disjunct.
    const result = await alwaysLoadFor('alw287-srv-false-meta-true', 'user', false, {
      'anthropic/alwaysLoad': true,
    })

    expect(result).toBe(false)
  })

  test('server alwaysLoad:false without tool _meta stays deferred', async () => {
    const result = await alwaysLoadFor('alw287-srv-false-no-meta', 'user', false, undefined)

    expect(result).toBe(false)
  })

  test('server alwaysLoad:false defers in dynamic scope too (the !g&& gate is not scope-dependent)', async () => {
    const result = await alwaysLoadFor('alw287-srv-false-dyn-meta-true', 'dynamic', false, {
      'anthropic/alwaysLoad': true,
    })

    expect(result).toBe(false)
  })

  test('server alwaysLoad:true is unchanged (regression guard)', async () => {
    const result = await alwaysLoadFor('alw287-srv-true-no-meta', 'user', true, undefined)

    expect(result).toBe(true)
  })

  test('server without alwaysLoad + tool _meta true still loads eagerly (regression guard)', async () => {
    // A server with at least one non-deferred tool (no server-level
    // alwaysLoad:false) keeps the v285 behavior.
    const result = await alwaysLoadFor('alw287-nosrv-meta-true', 'user', undefined, {
      'anthropic/alwaysLoad': true,
    })

    expect(result).toBe(true)
  })
})
