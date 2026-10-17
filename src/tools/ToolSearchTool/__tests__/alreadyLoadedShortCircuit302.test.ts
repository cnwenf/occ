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
 * CC 2.1.302 changelog #08 — "Fixed a prompt cache miss when a tool added
 * mid-session was loaded again through ToolSearch or after compaction."
 *
 * Official v302 evidence (@244203400-244206600, helpers Kt/Yt absent in
 * v301): already-loaded tools are NEVER re-emitted as matches. Instead the
 * result carries empty matches plus an isMeta newMessages note:
 *
 *   `Already available in this conversation: ${names.join(", ")}. Call
 *    ${names.length===1?"it":"them"} directly; no search is needed.`
 *
 * Re-emission was the bug: the loaded name flowed back into the wire tools
 * array, mutating the system-prompt tools block and busting the prompt cache.
 *
 * OCC loaded-set source (`be` analogue): live tools that are non-deferred
 * (always on the wire per claude.ts filter) PLUS deferred tools already
 * discovered via tool_reference blocks in message history
 * (extractDiscoveredToolNames — which also reads the compact-boundary
 * preCompactDiscoveredTools carry, covering the "after compaction" half of
 * the changelog).
 */

const TOOL_USE_ID = 'toolu_302_test'

function fakeTool(
  name: string,
  opts: {
    shouldDefer?: boolean
    isMcp?: boolean
    aliases?: string[]
    promptText?: string
  } = {},
): Tool {
  return {
    name,
    aliases: opts.aliases,
    shouldDefer: opts.shouldDefer,
    isMcp: opts.isMcp,
    async prompt() {
      return opts.promptText ?? `${name} does things`
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

/** tool_reference-bearing history, as produced by a prior ToolSearch load. */
function discoveredHistory(toolNames: string[]): Message[] {
  return [
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_prior',
            content: toolNames.map(tool_name => ({
              type: 'tool_reference',
              tool_name,
            })),
          },
        ],
      },
    },
  ] as unknown as Message[]
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

describe('CC 2.1.302 #08 — select path already-loaded short-circuit', () => {
  test('select of a single already-loaded tool returns empty matches plus the isMeta note and does not mutate the tools array', async () => {
    const tools: Tools = [
      fakeTool('Read'),
      fakeTool('NotebookEdit', { shouldDefer: true }),
    ]
    const toolsRef = tools
    const namesBefore = tools.map(t => t.name)

    const result = await callSearch('select:Read', tools)

    expect(result.data.matches).toEqual([])
    expect(result.data.query).toBe('select:Read')
    expect(noteText(result)).toBe(
      'Already available in this conversation: Read. Call it directly; no search is needed.',
    )
    expect(result.newMessages?.[0]?.type).toBe('user')
    expect(
      (result.newMessages?.[0] as { isMeta?: boolean }).isMeta,
    ).toBe(true)
    // SkillTool convention: tagged with the parent tool_use id
    expect(
      (result.newMessages?.[0] as { sourceToolUseID?: string })
        .sourceToolUseID,
    ).toBe(TOOL_USE_ID)
    // Tools array untouched — same reference, same contents
    expect(tools).toBe(toolsRef)
    expect(tools.map(t => t.name)).toEqual(namesBefore)
  })

  test('select of multiple already-loaded tools uses "them" and comma-space join', async () => {
    const tools: Tools = [fakeTool('Read'), fakeTool('Bash')]

    const result = await callSearch('select:Read,Bash', tools)

    expect(result.data.matches).toEqual([])
    expect(noteText(result)).toBe(
      'Already available in this conversation: Read, Bash. Call them directly; no search is needed.',
    )
  })

  test('select of a deferred (not-loaded) tool keeps the normal loading behavior', async () => {
    const tools: Tools = [
      fakeTool('Read'),
      fakeTool('NotebookEdit', { shouldDefer: true }),
    ]

    const result = await callSearch('select:NotebookEdit', tools)

    expect(result.data.matches).toEqual(['NotebookEdit'])
    expect(result.newMessages).toBeUndefined()
    expect('newMessages' in result).toBe(false)
  })

  test('mixed select: loaded name goes through the note, deferred name still loads', async () => {
    const tools: Tools = [
      fakeTool('Read'),
      fakeTool('NotebookEdit', { shouldDefer: true }),
    ]

    const result = await callSearch('select:Read,NotebookEdit', tools)

    // Official split: [Go,Kt(Go)] per name — loaded subset excluded from
    // matches (never re-emitted), to-search subset resolved normally.
    expect(result.data.matches).toEqual(['NotebookEdit'])
    expect(noteText(result)).toBe(
      'Already available in this conversation: Read. Call it directly; no search is needed.',
    )
  })

  test('select of a deferred tool already discovered via tool_reference (mid-session MCP load) short-circuits', async () => {
    const tools: Tools = [
      fakeTool('Read'),
      fakeTool('mcp__slack__post_message', { isMcp: true }),
    ]
    const messages = discoveredHistory(['mcp__slack__post_message'])

    const result = await callSearch('select:mcp__slack__post_message', tools, messages)

    expect(result.data.matches).toEqual([])
    expect(noteText(result)).toBe(
      'Already available in this conversation: mcp__slack__post_message. Call it directly; no search is needed.',
    )
  })

  test('select of an undiscovered deferred tool with no discovery history still loads normally', async () => {
    const tools: Tools = [
      fakeTool('Read'),
      fakeTool('mcp__slack__post_message', { isMcp: true }),
    ]

    const result = await callSearch('select:mcp__slack__post_message', tools)

    expect(result.data.matches).toEqual(['mcp__slack__post_message'])
    expect(result.newMessages).toBeUndefined()
  })

  test('select of an unknown name keeps the existing none-found behavior with no note', async () => {
    const tools: Tools = [fakeTool('Read')]

    const result = await callSearch('select:Nonexistent', tools)

    expect(result.data.matches).toEqual([])
    expect(result.newMessages).toBeUndefined()
  })
})

describe('CC 2.1.302 #08 — keyword path already-loaded short-circuit', () => {
  test('keyword exact-name hit on a loaded tool returns empty matches plus the note (the cache-miss bug is gone)', async () => {
    const tools: Tools = [
      fakeTool('Read'),
      fakeTool('NotebookEdit', { shouldDefer: true }),
    ]
    const namesBefore = tools.map(t => t.name)

    const result = await callSearch('Read', tools)

    expect(result.data.matches).toEqual([])
    expect(noteText(result)).toBe(
      'Already available in this conversation: Read. Call it directly; no search is needed.',
    )
    expect(tools.map(t => t.name)).toEqual(namesBefore)
  })

  test('keyword exact-name hit is case-insensitive like the official Gn lookup', async () => {
    const tools: Tools = [fakeTool('Read')]

    const result = await callSearch('read', tools)

    expect(result.data.matches).toEqual([])
    expect(noteText(result)).toBe(
      'Already available in this conversation: Read. Call it directly; no search is needed.',
    )
  })

  test('keyword exact-name hit on a deferred (not-loaded) tool still returns it for loading', async () => {
    const tools: Tools = [
      fakeTool('Read'),
      fakeTool('NotebookEdit', { shouldDefer: true }),
    ]

    const result = await callSearch('NotebookEdit', tools)

    expect(result.data.matches).toEqual(['NotebookEdit'])
    expect(result.newMessages).toBeUndefined()
  })

  test('keyword partial overlap: alias resolves to a loaded tool — normal result wrapped with the note for the loaded subset', async () => {
    const tools: Tools = [
      fakeTool('NotebookEdit', { aliases: ['notebook'] }),
      fakeTool('NotebookRead', { shouldDefer: true }),
    ]

    const result = await callSearch('notebook', tools)

    // Official `dn=Yt(...)`: the normal keyword result stands, the loaded
    // subset gets the isMeta note appended.
    expect(result.data.matches).toEqual(['NotebookRead'])
    expect(noteText(result)).toBe(
      'Already available in this conversation: NotebookEdit. Call it directly; no search is needed.',
    )
  })

  test('keyword search with no loaded-name resolution carries no note', async () => {
    const tools: Tools = [
      fakeTool('Read'),
      fakeTool('NotebookRead', { shouldDefer: true }),
    ]

    const result = await callSearch('notebook jupyter', tools)

    expect(result.data.matches).toEqual(['NotebookRead'])
    expect(result.newMessages).toBeUndefined()
  })
})

describe('CC 2.1.302 #08 — buildSearchResult shape regression', () => {
  test('normal keyword path result has data only — no newMessages key', async () => {
    const tools: Tools = [
      fakeTool('NotebookRead', { shouldDefer: true }),
    ]

    const result = await callSearch('notebook', tools)

    expect(Object.keys(result).sort()).toEqual(['data'])
    expect(result.data).toEqual({
      matches: ['NotebookRead'],
      query: 'notebook',
      total_deferred_tools: 1,
    })
    expect('pending_mcp_servers' in result.data).toBe(false)
  })
})
