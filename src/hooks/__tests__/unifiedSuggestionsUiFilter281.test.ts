import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.281 #147 — @-mention resource suggestions skip MCP Apps UI
 * resources.
 *
 * Binary evidence (v2.1.281 linux-x64 ELF @220778776):
 *   `Object.values(E).flat().filter((dt)=>!XXe(dt)).map((dt)=>({
 *      type:"mcp_resource", displayText:`${dt.server}:${dt.uri}`, …}))`
 * v2.1.280: no XXe filter at this site (0 hits binary-wide).
 *
 * The file-suggestion source is mocked out (not part of the path under
 * test); spread-real + restore is the repo convention because Bun's
 * mock.module leaks across files in the same worker.
 */

const actualDebug = { ...(await import('../../utils/debug.js')) }
const actualFileSuggestions = { ...(await import('../fileSuggestions.js')) }

// Passthrough-flag pattern: bun runs every test file in ONE process and a
// re-mock "restore" does not heal modules whose bindings already resolved to
// the mock namespace. With the flag off (afterAll) both seams delegate to the
// real implementations, so a leaked closure — e.g. `generateFileSuggestions`
// returning [] — can't silently hollow out later files (this exact leak broke
// fileSuggestionsNormalizedScores276 in the full-suite run).
let mocksActive = true
const debugLogs: string[] = []
mock.module('../../utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (...args: unknown[]) => {
    if (!mocksActive)
      return (actualDebug.logForDebugging as (...a: unknown[]) => void)(...args)
    debugLogs.push(String(args[0]))
  },
}))
mock.module('../fileSuggestions.js', () => ({
  ...actualFileSuggestions,
  generateFileSuggestions: ((...args: unknown[]) =>
    mocksActive
      ? []
      : (
          actualFileSuggestions.generateFileSuggestions as (
            ...a: unknown[]
          ) => Promise<unknown[]>
        )(...args)) as typeof actualFileSuggestions.generateFileSuggestions,
}))

afterAll(() => {
  mocksActive = false
  mock.module('../../utils/debug.js', () => ({ ...actualDebug }))
  mock.module('../fileSuggestions.js', () => ({ ...actualFileSuggestions }))
})

const { generateUnifiedSuggestions } = await import('../unifiedSuggestions.js')

type Resource = {
  uri: string
  name: string
  mimeType?: string
  server: string
}

function res(uri: string, server: string, mimeType?: string): Resource {
  return { uri, name: uri, server, ...(mimeType ? { mimeType } : {}) }
}

describe('2.1.281 #147 — @-mention suggestions skip MCP Apps UI resources', () => {
  beforeEach(() => {
    debugLogs.length = 0
  })

  test('ui:// and profile=mcp-app resources never surface as suggestions', async () => {
    const mcpResources = {
      srv: [
        res('ui://dashboard', 'srv'),
        res('res://dashboard-data', 'srv', 'application/json'),
        res('res://app', 'srv', 'text/html;profile=mcp-app'),
      ],
    }

    const items = await generateUnifiedSuggestions('dashboard', mcpResources, [])

    expect(items.map(item => item.displayText)).toEqual([
      'srv:res://dashboard-data',
    ])
  })

  test('bare-@ (showOnEmpty) listing also omits UI resources', async () => {
    const mcpResources = {
      srv: [res('ui://main', 'srv'), res('res://plain', 'srv')],
    }

    const items = await generateUnifiedSuggestions('', mcpResources, [], true)

    expect(items.map(item => item.displayText)).toEqual(['srv:res://plain'])
  })

  test('non-UI resources across servers are untouched', async () => {
    const mcpResources = {
      a: [res('res://one', 'a')],
      b: [res('res://two', 'b', 'text/html')],
    }

    const items = await generateUnifiedSuggestions('res://', mcpResources, [])

    expect(items.map(item => item.displayText).sort()).toEqual([
      'a:res://one',
      'b:res://two',
    ])
    expect(debugLogs).toEqual([])
  })
})
