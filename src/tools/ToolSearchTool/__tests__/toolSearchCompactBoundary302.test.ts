// Repo-convention MACRO polyfill (build-time constant polyfilled in cli.tsx).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { describe, expect, test } from 'bun:test'
import type {
  CanUseToolFn,
  Tool,
  ToolResult,
  Tools,
  ToolUseContext,
} from '../../../Tool.js'
import type { AssistantMessage, Message } from '../../../types/message.js'
import { ToolSearchTool, type Output } from '../ToolSearchTool.js'
import { TOOL_SEARCH_TOOL_NAME } from '../constants.js'

/**
 * CC 2.1.302 #08 — the "or after compaction" half of the changelog:
 * "Fixed a prompt cache miss when a tool added mid-session was loaded
 * again through ToolSearch or after compaction."
 *
 * Compaction replaces tool_reference-bearing messages with a summary, so
 * the discovered set is snapshotted onto the boundary marker's
 * `compactMetadata.preCompactDiscoveredTools`; the loaded-set scan
 * (getLoadedToolNames → extractDiscoveredToolNames) reads the carry back
 * from `compact_boundary` system messages. Without that branch a
 * post-compaction ToolSearch would treat a mid-session-loaded deferred
 * tool as undiscovered and re-emit it (re-adding it to the wire tools
 * array — the exact prompt-cache-miss bug the official fixed).
 *
 * These tests pin the compact_boundary carry end-to-end through
 * ToolSearchTool.call — no other fixture in the suite constructs a
 * compact_boundary message, so dropping the branch keeps every other
 * test green.
 */

const TOOL_USE_ID = 'toolu_compact_302'
const MCP_TOOL = 'mcp__slack__post_message'

function fakeTool(
  name: string,
  opts: { shouldDefer?: boolean; isMcp?: boolean } = {},
): Tool {
  return {
    name,
    shouldDefer: opts.shouldDefer,
    isMcp: opts.isMcp,
    async prompt() {
      return `${name} does things`
    },
  } as unknown as Tool
}

function fakeContext(tools: Tools, messages: Message[] = []): ToolUseContext {
  return {
    options: { tools },
    messages,
    getAppState: () => ({ mcp: { clients: [] } }),
  } as unknown as ToolUseContext
}

function fakeParentMessage(): AssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: TOOL_SEARCH_TOOL_NAME,
          input: {},
        },
      ],
    },
  } as unknown as AssistantMessage
}

/** Post-compaction history: ONLY the boundary marker survives, carrying the pre-compact discovered set. */
function compactBoundaryHistory(discovered: string[]): Message[] {
  return [
    {
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: {
        preCompactDiscoveredTools: discovered,
      },
    } as unknown as Message,
  ]
}

const canUseTool = (async () => ({
  result: true,
})) as unknown as CanUseToolFn

async function callSearch(
  query: string,
  tools: Tools,
  messages: Message[] = [],
): Promise<ToolResult<Output>> {
  return ToolSearchTool.call(
    { query, max_results: 5 },
    fakeContext(tools, messages),
    canUseTool,
    fakeParentMessage(),
  )
}

function noteText(result: ToolResult<Output>): string | undefined {
  const first = result.newMessages?.[0]
  if (!first || first.type !== 'user') return undefined
  const content = first.message.content
  return typeof content === 'string' ? content : undefined
}

describe('CC 2.1.302 #08 — compact_boundary preCompactDiscoveredTools carry seeds the loaded set', () => {
  test('select of a deferred tool discovered ONLY via the compact-boundary carry short-circuits with the isMeta note', async () => {
    const tools: Tools = [fakeTool('Read'), fakeTool(MCP_TOOL, { isMcp: true, shouldDefer: true })]
    const messages = compactBoundaryHistory([MCP_TOOL])

    const result = await callSearch(`select:${MCP_TOOL}`, tools, messages)

    // Branch dropped → discovered set empty → the tool looks undiscovered
    // and gets re-emitted as a match (the post-compaction cache-miss bug).
    expect(result.data.matches).toEqual([])
    expect(noteText(result)).toBe(
      `Already available in this conversation: ${MCP_TOOL}. Call it directly; no search is needed.`,
    )
  })

  test('keyword exact-name hit on a boundary-carried tool short-circuits too (Gn/Kn path)', async () => {
    const tools: Tools = [fakeTool('Read'), fakeTool(MCP_TOOL, { isMcp: true, shouldDefer: true })]
    const messages = compactBoundaryHistory([MCP_TOOL])

    const result = await callSearch(MCP_TOOL, tools, messages)

    expect(result.data.matches).toEqual([])
    expect(noteText(result)).toBe(
      `Already available in this conversation: ${MCP_TOOL}. Call it directly; no search is needed.`,
    )
  })

  test('boundary carry coexists with tool_reference history — both seed the same loaded set', async () => {
    const tools: Tools = [
      fakeTool('Read'),
      fakeTool(MCP_TOOL, { isMcp: true, shouldDefer: true }),
      fakeTool('mcp__slack__list_channels', { isMcp: true, shouldDefer: true }),
    ]
    const messages: Message[] = [
      ...compactBoundaryHistory([MCP_TOOL]),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_post_compact',
              content: [
                {
                  type: 'tool_reference',
                  tool_name: 'mcp__slack__list_channels',
                },
              ],
            },
          ],
        },
      } as unknown as Message,
    ]

    const result = await callSearch(
      `select:${MCP_TOOL},mcp__slack__list_channels`,
      tools,
      messages,
    )

    expect(result.data.matches).toEqual([])
    expect(noteText(result)).toBe(
      `Already available in this conversation: ${MCP_TOOL}, mcp__slack__list_channels. Call them directly; no search is needed.`,
    )
  })

  test('compact_boundary WITHOUT the carry leaves the deferred tool searchable (negative control)', async () => {
    const tools: Tools = [fakeTool('Read'), fakeTool(MCP_TOOL, { isMcp: true, shouldDefer: true })]
    const messages: Message[] = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: {},
      } as unknown as Message,
    ]

    const result = await callSearch(`select:${MCP_TOOL}`, tools, messages)

    expect(result.data.matches).toEqual([MCP_TOOL])
    expect(result.newMessages).toBeUndefined()
  })

  test('carry naming an unknown tool does not leak into the loaded note', async () => {
    const tools: Tools = [fakeTool('Read'), fakeTool(MCP_TOOL, { isMcp: true, shouldDefer: true })]
    const messages = compactBoundaryHistory(['mcp__slack__deleted_tool'])

    const result = await callSearch(`select:${MCP_TOOL}`, tools, messages)

    // The carried name is not in the live pool → MCP_TOOL stays
    // undiscovered → normal load, no note.
    expect(result.data.matches).toEqual([MCP_TOOL])
    expect(result.newMessages).toBeUndefined()
  })
})
