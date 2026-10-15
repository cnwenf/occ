/**
 * CC 2.1.300 changelog #18 — call-site half: the conversation-scoped
 * "ToolSearch declared" latch that feeds `isToolSearchEnabled`'s `autoHeld`
 * parameter (official `Lfr` 7th arg `S`).
 *
 * Official mechanism (byte-verified from the v300 linux-x64 ELF):
 * - Query caller v300@227824350 passes `Q.recordedToolDescriptions?.has(Ci)`
 *   with `Ci="ToolSearch"` (@219935042). `recordedToolDescriptions` is the
 *   per-conversation Map of tool descriptions actually sent to the API,
 *   recorded during tool-IR build (`H1t(st,ir,{...,recorded:
 *   Q.recordedToolDescriptions,...})` @227828656 region; the lazy-names
 *   variant `rbr(st,()=>Q.recordedToolDescriptions&&{names:Q.recordedTool
 *   Descriptions.keys(),...},s,{latch:!0,...})` @227825300).
 * - OCC deviation (documented in toolSearch.ts): no recordedToolDescriptions
 *   ledger exists (#46 STAGED), so a module-level boolean mirrors
 *   `has("ToolSearch")` — per-process ≈ conversation lifetime, same class as
 *   the module-level refusedToolSchemas map (#36).
 * - Conversation reset: official `w3n` @239179269 clears conversation-scoped
 *   API state on transcript_cleared; OCC wires `resetToolSearchDeclared()` +
 *   `clearRefusedToolSchemas()` into `clearSessionCaches` (/clear + resume).
 *
 * This file covers: latch semantics + the clearSessionCaches reset wiring
 * (behavioral — seeded refused-tool-schema map returns to identity-apply
 * after the reset, latch returns to false).
 */
import { describe, expect, test } from 'bun:test'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const {
  isToolSearchDeclared,
  noteToolSearchDeclared,
  resetToolSearchDeclared,
} = await import('../toolSearch.js')

const {
  applyRefusedToolSchemas,
  clearRefusedToolSchemas,
  createToolSchemaRefusedResolver,
} = await import('../../services/api/refusedToolSchemas.js')

const { APIError } = await import('@anthropic-ai/sdk')

function schemaRefused400(index: number): APIError {
  const message = `tools.${index}.input_schema: Input schema is invalid. Please ensure the schema is a valid JSON Schema object.`
  return new APIError(400, { message }, message, undefined)
}

const MCP_TOOL = {
  name: 'mcp__srv__one',
  input_schema: {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a'],
  },
}

function mcpLookup(name: string) {
  if (!name.startsWith('mcp__')) return undefined
  const [, serverName, toolName] = name.split('__')
  return {
    isMcp: true as const,
    mcpInfo: { serverName: serverName ?? 'srv', toolName: toolName ?? 'tool' },
  }
}

describe('CC 2.1.300 #18 — toolSearchDeclared latch (official Q.recordedToolDescriptions.has(Ci))', () => {
  test('fresh conversation starts unheld (normal threshold path)', () => {
    resetToolSearchDeclared()
    expect(isToolSearchDeclared()).toBe(false)
  })

  test('note arms the hold — ToolSearch description went out on the wire', () => {
    noteToolSearchDeclared()
    expect(isToolSearchDeclared()).toBe(true)
    // Idempotent, like Map.set on an existing key.
    noteToolSearchDeclared()
    expect(isToolSearchDeclared()).toBe(true)
  })

  test('reset disarms the hold (conversation cleared/resumed)', () => {
    resetToolSearchDeclared()
    expect(isToolSearchDeclared()).toBe(false)
  })
})

describe('CC 2.1.300 #18/#36 — clearSessionCaches conversation-reset wiring', () => {
  test('clearSessionCaches resets the latch and clears the refused-tool-schema map', async () => {
    // Seed both conversation-scoped states.
    noteToolSearchDeclared()
    expect(isToolSearchDeclared()).toBe(true)
    const resolver = createToolSchemaRefusedResolver()
    const seeded = resolver.resolve(schemaRefused400(0), [MCP_TOOL], mcpLookup)
    expect(seeded).toBeDefined()
    // While seeded, applyRefusedToolSchemas rewrites the refused tool.
    const whileSeeded = applyRefusedToolSchemas([MCP_TOOL])
    expect(whileSeeded).not.toBe(undefined)
    expect((whileSeeded as typeof MCP_TOOL[])[0]?.input_schema).toEqual({
      type: 'object',
    })

    const { clearSessionCaches } = await import(
      '../../commands/clear/caches.js'
    )
    clearSessionCaches()
    // The resets run via dynamic import inside clearSessionCaches — let the
    // microtasks settle (module already loaded, so one macrotask is enough).
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(isToolSearchDeclared()).toBe(false)
    // Official W1t: empty map → the SAME array reference (identity apply).
    const sent = [MCP_TOOL]
    expect(applyRefusedToolSchemas(sent)).toBe(sent)
  })
})

// Keep the module export referenced (clearRefusedToolSchemas is the function
// clearSessionCaches wires; asserting its existence guards accidental renames).
test('clearRefusedToolSchemas remains exported for the /clear wiring', () => {
  expect(typeof clearRefusedToolSchemas).toBe('function')
})
