import { afterAll, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.281 #147 — ListMcpResourcesTool leaves MCP Apps UI resources out
 * of the model's list and emits the v281-exact debug log.
 *
 * Binary evidence (v2.1.281 linux-x64 ELF @207460730):
 *   `r=await R(n),p=r.filter((g)=>!XXe(g));
 *    if(p.length<r.length)t(`MCP server "${i.name}": ${r.length-p.length}
 *    MCP Apps UI resource(s) left out of ${X3}'s list for the model
 *    (a ui:// URI, or text/html with profile=mcp-app); ${b1} can still
 *    read them by URI`)`
 *   with X3="ListMcpResourcesTool" @201977766, b1="ReadMcpResourceTool"
 *   @200757099, t() = debug-level logger. v2.1.280: 0 hits (new in 281).
 *
 * The MCP client module is mocked (spread-real, repo convention) so the
 * tool sees an UNFILTERED server list — isolating the tool-level filter.
 * CI runs each test file in its own process, so mocks can't leak.
 */

const actualDebug = { ...(await import('../../src/utils/debug.js')) }
const actualClient = { ...(await import('../../src/services/mcp/client.js')) }

// Passthrough-flag pattern: bun runs every test file in ONE process and a
// re-mock "restore" does not heal modules whose bindings already resolved to
// the mock namespace. With the flag off (afterAll) both seams delegate to the
// real implementations — a leaked `fetchResourcesForClient` returning this
// file's fixture silently hollowed out fetchResourcesUiFilter281 in the
// full-suite run.
let mocksActive = true
const debugLogs: string[] = []
let servedResources: Array<{
  uri: string
  name: string
  mimeType?: string
  server?: string
}> = []

mock.module('../../src/utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (...args: unknown[]) => {
    if (!mocksActive)
      return (actualDebug.logForDebugging as (...a: unknown[]) => void)(...args)
    debugLogs.push(String(args[0]))
  },
}))

mock.module('../../src/services/mcp/client.js', () => ({
  ...actualClient,
  ensureConnectedClient: ((client: unknown, ...rest: unknown[]) =>
    mocksActive
      ? client
      : (
          actualClient.ensureConnectedClient as (
            c: unknown,
            ...r: unknown[]
          ) => Promise<unknown>
        )(client, ...rest)) as typeof actualClient.ensureConnectedClient,
  fetchResourcesForClient: ((...args: unknown[]) =>
    mocksActive
      ? servedResources
      : (
          actualClient.fetchResourcesForClient as (
            ...a: unknown[]
          ) => Promise<unknown[]>
        )(...args)) as typeof actualClient.fetchResourcesForClient,
}))

afterAll(() => {
  mocksActive = false
  servedResources = []
  mock.module('../../src/utils/debug.js', () => ({ ...actualDebug }))
  mock.module('../../src/services/mcp/client.js', () => ({ ...actualClient }))
})

const { ListMcpResourcesTool } = await import(
  '../../src/tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
)

function callContext(serverNames: string[]): never {
  return {
    options: {
      mcpClients: serverNames.map(name => ({ name, type: 'connected' })),
    },
  } as never
}

describe('2.1.281 #147 — ListMcpResourcesTool UI-resource filter', () => {
  test('filters ui:// and profile=mcp-app resources out of the tool result', async () => {
    servedResources = [
      { uri: 'ui://dashboard', name: 'Dash', server: 'srvA' },
      { uri: 'res://app', name: 'App', mimeType: 'text/html;profile=mcp-app', server: 'srvA' },
      { uri: 'res://data', name: 'Data', mimeType: 'application/json', server: 'srvA' },
    ]
    debugLogs.length = 0

    const result = await ListMcpResourcesTool.call(
      {} as never,
      callContext(['srvA']),
    )

    expect(result.data.map(r => r.uri)).toEqual(['res://data'])
  })

  test('emits the v281-exact "left out … can still read them by URI" log', async () => {
    servedResources = [
      { uri: 'ui://a', name: 'A', server: 'srvB' },
      { uri: 'ui://b', name: 'B', server: 'srvB' },
      { uri: 'res://c', name: 'C', server: 'srvB' },
    ]
    debugLogs.length = 0

    await ListMcpResourcesTool.call({} as never, callContext(['srvB']))

    expect(debugLogs).toEqual([
      `MCP server "srvB": 2 MCP Apps UI resource(s) left out of ListMcpResourcesTool's list for the model (a ui:// URI, or text/html with profile=mcp-app); ReadMcpResourceTool can still read them by URI`,
    ])
  })

  test('no log and full passthrough when nothing is a UI resource', async () => {
    servedResources = [
      { uri: 'res://c', name: 'C', server: 'srvC' },
      { uri: 'res://d', name: 'D', mimeType: 'text/html', server: 'srvC' },
    ]
    debugLogs.length = 0

    const result = await ListMcpResourcesTool.call(
      {} as never,
      callContext(['srvC']),
    )

    expect(result.data.map(r => r.uri)).toEqual(['res://c', 'res://d'])
    expect(debugLogs).toEqual([])
  })
})
