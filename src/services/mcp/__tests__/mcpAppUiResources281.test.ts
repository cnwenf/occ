import { afterAll, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.281 #147 — MCP Apps UI-resource detector + list filter.
 *
 * Binary evidence (v2.1.281 linux-x64 ELF):
 *   Detector `XXe({uri,mimeType})` @207138863 with constants @207138146:
 *     c="ui://", _="mcp-app", g=1024, l="[!#$%&'*+.^_`|~0-9A-Za-z-]+",
 *     h=/^[ \t]*(l)\/(l)/, sticky param scanner a (/y).
 *   Filter + log @207460730:
 *     `p=r.filter((g)=>!XXe(g))` then
 *     `MCP server "${name}": ${n} MCP Apps UI resource(s) left out of
 *      ListMcpResourcesTool's list for the model (a ui:// URI, or
 *      text/html with profile=mcp-app); ReadMcpResourceTool can still
 *      read them by URI`  (X3="ListMcpResourcesTool" @201977766,
 *      b1="ReadMcpResourceTool" @200757099; logger t() = debug level).
 *   v2.1.280: 0 hits for both strings (feature is new in 281).
 */

// Capture the debug log without touching the real debug-log file. Spread
// the real module and override only logForDebugging (repo convention —
// Bun's mock.module leaks across files in the same worker; CI runs each
// test file in its own process).
const actualDebug = { ...(await import('../../../utils/debug.js')) }
let mocksActive = true
const debugLogs: string[] = []
mock.module('../../../utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (...args: unknown[]) => {
    if (!mocksActive)
      return (actualDebug.logForDebugging as (...a: unknown[]) => void)(...args)
    debugLogs.push(String(args[0]))
  },
}))

afterAll(() => {
  // Passthrough-flag heal: a leaked closure keeps running after this file —
  // with the flag off it delegates to the real logger (bun's re-mock restore
  // alone does not heal already-resolved bindings).
  mocksActive = false
  mock.module('../../../utils/debug.js', () => ({ ...actualDebug }))
})

const { isMcpAppUiResource, filterMcpAppUiResources } = await import(
  '../mcpAppUiResources.js'
)

describe('2.1.281 #147 — isMcpAppUiResource detector', () => {
  test('detects ui:// URIs case-insensitively regardless of mimeType', () => {
    expect(isMcpAppUiResource({ uri: 'ui://dashboard' })).toBe(true)
    expect(isMcpAppUiResource({ uri: 'UI://Dashboard/main' })).toBe(true)
    expect(isMcpAppUiResource({ uri: 'Ui://x', mimeType: 'text/plain' })).toBe(
      true,
    )
  })

  test('does not flag non-ui URIs without a mcp-app mimeType', () => {
    expect(isMcpAppUiResource({ uri: 'file:///tmp/a.txt' })).toBe(false)
    expect(isMcpAppUiResource({ uri: 'https://x/y' })).toBe(false)
    expect(isMcpAppUiResource({ uri: 'uix://not-ui' })).toBe(false)
    expect(isMcpAppUiResource({ uri: 'resource://ui://x' })).toBe(false)
  })

  test('detects text/html with a profile=mcp-app parameter', () => {
    expect(
      isMcpAppUiResource({ uri: 'res://a', mimeType: 'text/html;profile=mcp-app' }),
    ).toBe(true)
    // whitespace around the ';' separator is allowed by the param scanner
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: 'text/html ;profile=mcp-app',
      }),
    ).toBe(true)
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: 'text/html; profile=mcp-app',
      }),
    ).toBe(true)
    // type/subtype and param name/value are case-insensitive
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: 'TEXT/HTML;PROFILE=MCP-APP',
      }),
    ).toBe(true)
    // quoted parameter value
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: 'text/html;profile="mcp-app"',
      }),
    ).toBe(true)
    // quoted value with a backslash escape unescapes to mcp-app
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: 'text/html;profile="mcp\\-app"',
      }),
    ).toBe(true)
    // profile param after other params
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: 'text/html;charset=utf-8;profile=mcp-app',
      }),
    ).toBe(true)
  })

  test('does not flag text/html without profile=mcp-app', () => {
    expect(isMcpAppUiResource({ uri: 'res://a', mimeType: 'text/html' })).toBe(
      false,
    )
    expect(
      isMcpAppUiResource({ uri: 'res://a', mimeType: 'text/html;profile=other' }),
    ).toBe(false)
    expect(
      isMcpAppUiResource({ uri: 'res://a', mimeType: 'text/html;charset=utf-8' }),
    ).toBe(false)
    // bare `profile` without a value is not a match
    expect(
      isMcpAppUiResource({ uri: 'res://a', mimeType: 'text/html;profile' }),
    ).toBe(false)
    // the v281 sticky scanner requires name=value adjacency (no OWS around
    // '='), so a spaced-out assignment is not a match
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: 'text/html;profile = mcp-app',
      }),
    ).toBe(false)
  })

  test('does not flag non-text/html types even with profile=mcp-app', () => {
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: 'text/plain;profile=mcp-app',
      }),
    ).toBe(false)
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: 'application/json;profile=mcp-app',
      }),
    ).toBe(false)
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: 'application/xhtml+xml;profile=mcp-app',
      }),
    ).toBe(false)
  })

  test('ignores over-long mimeTypes (v281 g=1024 length cap)', () => {
    const padding = 'x'.repeat(1100)
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: `text/html;profile=mcp-app;charset=${padding}`,
      }),
    ).toBe(false)
    // just under the cap still detects
    const smallPad = 'x'.repeat(900)
    expect(
      isMcpAppUiResource({
        uri: 'res://a',
        mimeType: `text/html;profile=mcp-app;charset=${smallPad}`,
      }),
    ).toBe(true)
  })

  test('undefined mimeType is not flagged', () => {
    expect(
      isMcpAppUiResource({ uri: 'res://a', mimeType: undefined }),
    ).toBe(false)
  })
})

describe('2.1.281 #147 — filterMcpAppUiResources list filter + log', () => {
  test('drops UI resources and keeps normal ones', () => {
    const resources = [
      { uri: 'ui://dashboard', name: 'dash', server: 'srv' },
      { uri: 'res://data', name: 'data', mimeType: 'application/json', server: 'srv' },
      { uri: 'res://app', name: 'app', mimeType: 'text/html;profile=mcp-app', server: 'srv' },
    ]
    debugLogs.length = 0
    const kept = filterMcpAppUiResources(resources, 'srv')
    expect(kept).toEqual([resources[1]])
  })

  test('emits the v281-exact log with the dropped count', () => {
    const resources = [
      { uri: 'ui://a', name: 'a', server: 'srv' },
      { uri: 'ui://b', name: 'b', server: 'srv' },
      { uri: 'res://c', name: 'c', server: 'srv' },
    ]
    debugLogs.length = 0
    filterMcpAppUiResources(resources, 'myserver')
    expect(debugLogs).toEqual([
      `MCP server "myserver": 2 MCP Apps UI resource(s) left out of ListMcpResourcesTool's list for the model (a ui:// URI, or text/html with profile=mcp-app); ReadMcpResourceTool can still read them by URI`,
    ])
  })

  test('no log and identity contents when nothing is filtered', () => {
    const resources = [
      { uri: 'res://c', name: 'c', server: 'srv' },
      { uri: 'res://d', name: 'd', mimeType: 'text/html', server: 'srv' },
    ]
    debugLogs.length = 0
    const kept = filterMcpAppUiResources(resources, 'srv')
    expect(kept).toEqual(resources)
    expect(debugLogs).toEqual([])
  })

  test('does not mutate the input array (immutable filter)', () => {
    const resources = [
      { uri: 'ui://a', name: 'a', server: 'srv' },
      { uri: 'res://c', name: 'c', server: 'srv' },
    ]
    const snapshot = [...resources]
    filterMcpAppUiResources(resources, 'srv')
    expect(resources).toEqual(snapshot)
  })
})
