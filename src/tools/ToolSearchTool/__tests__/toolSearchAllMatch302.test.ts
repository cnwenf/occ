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
 * CC 2.1.302 #08 — official `Kt` is ALL-MATCH (@244203400 region):
 *
 *   `Kt=(Un)=>{if(be===void 0||be.size===0)return[];
 *    let so=LX([],Z5(De),Un);
 *    return so.length>0&&so.every((Jn)=>be.has(Jn.name))?so.map((Jn)=>Jn.name):[]}`
 *
 * `LX` collects EVERY pool entry matching the requested name/alias — a name
 * can collide across the pool — and the canonical names come back ONLY when
 * `so.every(loaded)`. A single-find short-circuit (findToolByName) mis-fires
 * "already loaded → no search is needed" when one colliding match is loaded
 * and another is still deferred: the deferred twin is never surfaced.
 *
 * These tests pin the all-match semantics with multi-collision fixtures on
 * both the select path (`[Go,Kt(Go)]` split) and the keyword partial-overlap
 * path (`dn=Yt(...)` — same `Kt` underneath).
 */

const TOOL_USE_ID = 'toolu_allmatch_302'

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

/**
 * Collision fixture: two pool entries share the alias "fetch" — one loaded
 * (non-deferred), one still deferred (not discovered). Official v302
 * semantics: `every(loaded)` is false → Kt returns [] → the name flows to
 * the normal search path and the deferred twin is surfaced.
 */
function collisionTools(): Tools {
  return [
    fakeTool('DataFetch', { aliases: ['fetch'] }),
    fakeTool('WebFetch', { shouldDefer: true, aliases: ['fetch'] }),
  ]
}

describe('CC 2.1.302 #08 — getAlreadyLoadedNames all-match (Kt every(loaded)) semantics', () => {
  test('select of a colliding alias with only one of two pool matches loaded does NOT short-circuit — the deferred twin is still searched', async () => {
    const tools = collisionTools()

    const result = await callSearch('select:fetch', tools)

    // Single-find regression shape would be: matches [] + "Already
    // available in this conversation: DataFetch. … no search is needed."
    // All-match v302: not every match is loaded → search proceeds and
    // resolves the deferred twin from the deferred pool.
    expect(result.data.matches).toEqual(['WebFetch'])
    expect(result.newMessages).toBeUndefined()
    expect('newMessages' in result).toBe(false)
  })

  test('select of a colliding alias where ALL pool matches are loaded reports every canonical name in the note', async () => {
    const tools: Tools = [
      fakeTool('DataFetch', { aliases: ['fetch'] }),
      fakeTool('HttpFetch', { aliases: ['fetch'] }),
    ]

    const result = await callSearch('select:fetch', tools)

    // Official `so.map((Jn)=>Jn.name)` — all matches, not just the first.
    expect(result.data.matches).toEqual([])
    expect(noteText(result)).toBe(
      'Already available in this conversation: DataFetch, HttpFetch. Call them directly; no search is needed.',
    )
  })

  test('same-primary-name collision where the shared name is loaded short-circuits with a deduped single-name note', async () => {
    // Official `be` is a Set of NAMES (`so.every((Jn)=>be.has(Jn.name))`),
    // so two pool entries sharing one primary name are both "loaded" once
    // the name is on the wire — the note dedups to the single canonical
    // name (call() builds alreadyLoaded through a Set). The loaded copy
    // uses alwaysLoad (the isDeferredTool opt-out) so an MCP-named tool
    // can sit on the wire undeferred.
    const tools: Tools = [
      {
        ...fakeTool('mcp__slack__post_message', { isMcp: true }),
        alwaysLoad: true,
      } as unknown as Tool,
      fakeTool('mcp__slack__post_message', {
        isMcp: true,
        shouldDefer: true,
      }),
    ]

    const result = await callSearch('select:mcp__slack__post_message', tools)

    expect(result.data.matches).toEqual([])
    expect(noteText(result)).toBe(
      'Already available in this conversation: mcp__slack__post_message. Call it directly; no search is needed.',
    )
  })

  test('keyword query on a colliding alias proceeds to search and carries no partial note', async () => {
    const tools = collisionTools()

    const result = await callSearch('fetch', tools)

    // Official `dn=Yt(Kt(tn))` partial-overlap path uses the same
    // all-match Kt: with a still-deferred collision match there is no
    // loaded subset to annotate, and the keyword search must run.
    expect(result.data.matches).toEqual(['WebFetch'])
    expect(result.newMessages).toBeUndefined()
  })

  // OCC-121 P3 carryover fix (finding #5): collision fixture for the THIRD
  // getAlreadyLoadedNames call site — the exact-primary-name keyword
  // short-circuit (`exactPoolHit`). The select path and the keyword
  // partial-overlap (alias) path were pinned above, but the exact-name
  // short-circuit had no collision pin: a single-find regression there
  // (find instead of filter+every) would mis-fire "no search is needed"
  // when the query is a loaded tool's primary name AND a still-deferred
  // twin's alias. Mutation: replace getAlreadyLoadedNames's filter+every
  // with a single find → the first test below goes RED.
  test('keyword exact-primary-name hit colliding with a deferred twin alias does NOT short-circuit — search proceeds', async () => {
    const tools: Tools = [
      fakeTool('Deploy'), // loaded (non-deferred), primary name = query
      fakeTool('DeployProd', { shouldDefer: true, aliases: ['Deploy'] }),
    ]

    const result = await callSearch('Deploy', tools)

    // Single-find regression shape: matches [] + "Already available in this
    // conversation: Deploy. … no search is needed." — the deferred alias
    // twin would be silently swallowed. All-match v302: not every match is
    // loaded → the exact-name short-circuit does NOT fire and the keyword
    // search surfaces the deferred twin.
    expect(result.data.matches).toEqual(['DeployProd'])
    expect(result.newMessages).toBeUndefined()
    expect('newMessages' in result).toBe(false)
  })

  test('keyword exact-primary-name collision where ALL matches are loaded short-circuits with every canonical name', async () => {
    // Positive control for the same call site: both pool matches loaded →
    // official `so.map((Jn)=>Jn.name)` note lists every canonical name.
    const tools: Tools = [
      fakeTool('Deploy'),
      {
        ...fakeTool('DeployProd', {
          shouldDefer: true,
          aliases: ['Deploy'],
        }),
        alwaysLoad: true,
      } as unknown as Tool,
    ]

    const result = await callSearch('Deploy', tools)

    expect(result.data.matches).toEqual([])
    expect(noteText(result)).toBe(
      'Already available in this conversation: Deploy, DeployProd. Call them directly; no search is needed.',
    )
  })

  test('keyword partial overlap without collision keeps the single-name note', async () => {
    // Control: unique alias, sole match loaded → note still fires (the
    // all-match change must not regress the non-collision partial path).
    const tools: Tools = [
      fakeTool('NotebookEdit', { aliases: ['notebook'] }),
      fakeTool('NotebookRead', { shouldDefer: true }),
    ]

    const result = await callSearch('notebook', tools)

    expect(result.data.matches).toEqual(['NotebookRead'])
    expect(noteText(result)).toBe(
      'Already available in this conversation: NotebookEdit. Call it directly; no search is needed.',
    )
  })
})
