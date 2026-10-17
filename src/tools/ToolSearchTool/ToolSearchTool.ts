import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import memoize from 'lodash-es/memoize.js'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  buildTool,
  findToolByName,
  type Tool,
  type ToolDef,
  type ToolResult,
  type Tools,
} from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createUserMessage } from '../../utils/messages.js'
import { escapeRegExp } from '../../utils/stringUtils.js'
import {
  extractDiscoveredToolNames,
  isToolSearchEnabledOptimistic,
} from '../../utils/toolSearch.js'
import {
  getToolUseIDFromParentMessage,
  tagMessagesWithToolUseID,
} from '../utils.js'
import { getPrompt, isDeferredTool, TOOL_SEARCH_TOOL_NAME } from './prompt.js'

export const inputSchema = lazySchema(() =>
  z.object({
    query: z
      .string()
      .describe(
        'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
      ),
    max_results: z
      .number()
      .optional()
      .default(5)
      .describe('Maximum number of results to return (default: 5)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    matches: z.array(z.string()),
    query: z.string(),
    total_deferred_tools: z.number(),
    pending_mcp_servers: z.array(z.string()).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// Track deferred tool names to detect when cache should be cleared
let cachedDeferredToolNames: string | null = null

/**
 * Get a cache key representing the current set of deferred tools.
 */
function getDeferredToolsCacheKey(deferredTools: Tools): string {
  return deferredTools
    .map(t => t.name)
    .sort()
    .join(',')
}

/**
 * Get tool description, memoized by tool name.
 * Used for keyword search scoring.
 */
const getToolDescriptionMemoized = memoize(
  async (toolName: string, tools: Tools): Promise<string> => {
    const tool = findToolByName(tools, toolName)
    if (!tool) {
      return ''
    }
    return tool.prompt({
      getToolPermissionContext: async () => ({
        mode: 'default' as const,
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      }),
      tools,
      agents: [],
    })
  },
  (toolName: string) => toolName,
)

/**
 * Invalidate the description cache if deferred tools have changed.
 */
function maybeInvalidateCache(deferredTools: Tools): void {
  const currentKey = getDeferredToolsCacheKey(deferredTools)
  if (cachedDeferredToolNames !== currentKey) {
    logForDebugging(
      `ToolSearchTool: cache invalidated - deferred tools changed`,
    )
    getToolDescriptionMemoized.cache.clear?.()
    cachedDeferredToolNames = currentKey
  }
}

export function clearToolSearchDescriptionCache(): void {
  getToolDescriptionMemoized.cache.clear?.()
  cachedDeferredToolNames = null
}

/**
 * CC 2.1.302 #08 — the loaded-tool name set (official `be` =
 * `ke.definedByValue` @244204xxx: tool names already defined by value in
 * this conversation). OCC's wire filter (claude.ts) sends non-deferred
 * tools always, and deferred tools once discovered via tool_reference
 * blocks in message history — extractDiscoveredToolNames also reads the
 * compact-boundary preCompactDiscoveredTools carry, so this set survives
 * compaction (the "or after compaction" half of the official changelog).
 */
function getLoadedToolNames(tools: Tools, messages: Message[]): Set<string> {
  const discovered = extractDiscoveredToolNames(messages ?? [])
  const loaded = new Set<string>()
  for (const tool of tools) {
    if (!isDeferredTool(tool) || discovered.has(tool.name)) {
      loaded.add(tool.name)
    }
  }
  return loaded
}

/**
 * CC 2.1.302 #08 — official `Kt` analogue (@244203400 region):
 * `Kt=(Un)=>{if(be===void 0||be.size===0)return[];
 *  let so=LX([],Z5(De),Un);
 *  return so.length>0&&so.every((Jn)=>be.has(Jn.name))?so.map((Jn)=>Jn.name):[]}`
 * Resolves the requested name against the live tool pool (name or alias,
 * via findToolByName — OCC's resolver); returns the canonical name ONLY
 * when every resolved tool is already loaded, otherwise [] so the name
 * flows to the normal search path.
 */
function getAlreadyLoadedNames(
  requested: string,
  tools: Tools,
  loadedNames: Set<string>,
): string[] {
  if (loadedNames.size === 0) {
    return []
  }
  const resolved = findToolByName(tools, requested)
  return resolved !== undefined && loadedNames.has(resolved.name)
    ? [resolved.name]
    : []
}

/**
 * CC 2.1.302 #08 — official `Yt` analogue: builds the isMeta note appended
 * to newMessages when already-loaded tools were requested. Verbatim v302
 * text (@244204xxx). Wrapped via tagMessagesWithToolUseID following the
 * SkillTool precedent (SkillTool.ts:1017-1063). Empty names → no messages,
 * so the result carries no newMessages key (identity wrap, like Yt).
 */
function buildAlreadyLoadedNote(
  names: string[],
  toolUseID: string | undefined,
): ToolResult<Output>['newMessages'] {
  if (names.length === 0) {
    return undefined
  }
  return tagMessagesWithToolUseID(
    [
      createUserMessage({
        content: `Already available in this conversation: ${names.join(', ')}. Call ${names.length === 1 ? 'it' : 'them'} directly; no search is needed.`,
        isMeta: true,
      }),
    ],
    toolUseID,
  )
}

/**
 * Build the search result output structure.
 * CC 2.1.302 #08: carries optional newMessages through (Tool.ts ToolResult
 * already supports the field); the key is omitted when there is no note so
 * the normal-path shape is unchanged.
 */
function buildSearchResult(
  matches: string[],
  query: string,
  totalDeferredTools: number,
  pendingMcpServers?: string[],
  newMessages?: ToolResult<Output>['newMessages'],
): ToolResult<Output> {
  return {
    data: {
      matches,
      query,
      total_deferred_tools: totalDeferredTools,
      ...(pendingMcpServers && pendingMcpServers.length > 0
        ? { pending_mcp_servers: pendingMcpServers }
        : {}),
    },
    ...(newMessages && newMessages.length > 0 ? { newMessages } : {}),
  }
}

/**
 * Parse tool name into searchable parts.
 * Handles both MCP tools (mcp__server__action) and regular tools (CamelCase).
 */
function parseToolName(name: string): {
  parts: string[]
  full: string
  isMcp: boolean
} {
  // Check if it's an MCP tool
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '),
      isMcp: true,
    }
  }

  // Regular tool - split by CamelCase and underscores
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2') // CamelCase to spaces
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  return {
    parts,
    full: parts.join(' '),
    isMcp: false,
  }
}

/**
 * Pre-compile word-boundary regexes for all search terms.
 * Called once per search instead of tools×terms×2 times.
 */
function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>()
  for (const term of terms) {
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`))
    }
  }
  return patterns
}

/**
 * Keyword-based search over tool names and descriptions.
 * Handles both MCP tools (mcp__server__action) and regular tools (CamelCase).
 *
 * The model typically queries with:
 * - Server names when it knows the integration (e.g., "slack", "github")
 * - Action words when looking for functionality (e.g., "read", "list", "create")
 * - Tool-specific terms (e.g., "notebook", "shell", "kill")
 */
async function searchToolsWithKeywords(
  query: string,
  deferredTools: Tools,
  tools: Tools,
  maxResults: number,
): Promise<string[]> {
  const queryLower = query.toLowerCase().trim()

  // Fast path: if query matches a DEFERRED tool name exactly, return it
  // directly. Handles models using a bare tool name instead of select:
  // prefix (seen from subagents/post-compaction).
  // CC 2.1.302 #08: the pool searched here is the deferred pool only —
  // the old `?? tools.find(...)` fallback re-emitted already-loaded tools
  // (the previous "harmless no-op" comment described exactly the bug the
  // official fixed): the re-emission re-added the tool to the wire tools
  // array, mutating the system-prompt tools block and busting the prompt
  // cache. Loaded exact-name hits now short-circuit in call() with the
  // isMeta "Already available" note (official Gn/Kn path).
  const exactMatch = deferredTools.find(t => t.name.toLowerCase() === queryLower)
  if (exactMatch) {
    return [exactMatch.name]
  }

  // If query looks like an MCP tool prefix (mcp__server), find matching tools.
  // Handles models searching by server name with mcp__ prefix.
  if (queryLower.startsWith('mcp__') && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter(t => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map(t => t.name)
    if (prefixMatches.length > 0) {
      return prefixMatches
    }
  }

  const queryTerms = queryLower.split(/\s+/).filter(term => term.length > 0)

  // Partition into required (+prefixed) and optional terms
  const requiredTerms: string[] = []
  const optionalTerms: string[] = []
  for (const term of queryTerms) {
    if (term.startsWith('+') && term.length > 1) {
      requiredTerms.push(term.slice(1))
    } else {
      optionalTerms.push(term)
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms
  const termPatterns = compileTermPatterns(allScoringTerms)

  // Pre-filter to tools matching ALL required terms in name or description
  let candidateTools = deferredTools
  if (requiredTerms.length > 0) {
    const matches = await Promise.all(
      deferredTools.map(async tool => {
        const parsed = parseToolName(tool.name)
        const description = await getToolDescriptionMemoized(tool.name, tools)
        const descNormalized = description.toLowerCase()
        const hintNormalized = tool.searchHint?.toLowerCase() ?? ''
        const matchesAll = requiredTerms.every(term => {
          const pattern = termPatterns.get(term)!
          return (
            parsed.parts.includes(term) ||
            parsed.parts.some(part => part.includes(term)) ||
            pattern.test(descNormalized) ||
            (hintNormalized && pattern.test(hintNormalized))
          )
        })
        return matchesAll ? tool : null
      }),
    )
    candidateTools = matches.filter((t): t is Tool => t !== null)
  }

  const scored = await Promise.all(
    candidateTools.map(async tool => {
      const parsed = parseToolName(tool.name)
      const description = await getToolDescriptionMemoized(tool.name, tools)
      const descNormalized = description.toLowerCase()
      const hintNormalized = tool.searchHint?.toLowerCase() ?? ''

      let score = 0
      for (const term of allScoringTerms) {
        const pattern = termPatterns.get(term)!

        // Exact part match (high weight for MCP server names, tool name parts)
        if (parsed.parts.includes(term)) {
          score += parsed.isMcp ? 12 : 10
        } else if (parsed.parts.some(part => part.includes(term))) {
          score += parsed.isMcp ? 6 : 5
        }

        // Full name fallback (for edge cases)
        if (parsed.full.includes(term) && score === 0) {
          score += 3
        }

        // searchHint match — curated capability phrase, higher signal than prompt
        if (hintNormalized && pattern.test(hintNormalized)) {
          score += 4
        }

        // Description match - use word boundary to avoid false positives
        if (pattern.test(descNormalized)) {
          score += 2
        }
      }

      return { name: tool.name, score }
    }),
  )

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.name)
}

export const ToolSearchTool = buildTool({
  isEnabled() {
    return isToolSearchEnabledOptimistic()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  name: TOOL_SEARCH_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return getPrompt()
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(
    input,
    { options: { tools }, getAppState, messages },
    _canUseTool,
    parentMessage,
  ) {
    const { query, max_results = 5 } = input

    const deferredTools = tools.filter(isDeferredTool)
    maybeInvalidateCache(deferredTools)

    // CC 2.1.302 #08 — the loaded set (official `be`) + the tool-use id for
    // tagging the isMeta note messages (SkillTool convention).
    const loadedNames = getLoadedToolNames(tools, messages ?? [])
    const toolUseID = parentMessage
      ? getToolUseIDFromParentMessage(parentMessage, TOOL_SEARCH_TOOL_NAME)
      : undefined

    // Check for MCP servers still connecting
    function getPendingServerNames(): string[] | undefined {
      const appState = getAppState()
      const pending = appState.mcp.clients.filter(c => c.type === 'pending')
      return pending.length > 0 ? pending.map(s => s.name) : undefined
    }

    // Helper to log search outcome
    function logSearchOutcome(
      matches: string[],
      queryType: 'select' | 'keyword',
    ): void {
      logEvent('tengu_tool_search_outcome', {
        query:
          query as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        queryType:
          queryType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        matchCount: matches.length,
        totalDeferredTools: deferredTools.length,
        maxResults: max_results,
        hasMatches: matches.length > 0,
      })
    }

    // Check for select: prefix — direct tool selection.
    // Supports comma-separated multi-select: `select:A,B,C`.
    // CC 2.1.302 #08 — official split semantics: each requested name maps
    // through `[Go,Kt(Go)]` into loaded (note) vs to-search. ALL loaded →
    // empty matches + isMeta note; the tools array is NOT touched (the old
    // `?? findToolByName(tools)` re-emission of already-loaded tools was
    // exactly the prompt-cache-miss bug the official fixed — re-adding a
    // loaded tool mutates the system-prompt tools block). Mixed selects
    // still resolve the to-search subset from the deferred pool, and every
    // select-path result is wrapped with the note for the loaded subset
    // (official `yn=Yt(Jn)`).
    const selectMatch = query.match(/^select:(.+)$/i)
    if (selectMatch) {
      const requested = selectMatch[1]!
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)

      const perName = requested.map(
        name => [name, getAlreadyLoadedNames(name, tools, loadedNames)] as const,
      )
      const alreadyLoaded = [
        ...new Set(perName.flatMap(([, loaded]) => loaded)),
      ]
      const toSearch = perName.flatMap(([name, loaded]) =>
        loaded.length === 0 ? [name] : [],
      )

      if (alreadyLoaded.length > 0 && toSearch.length === 0) {
        logForDebugging(
          `ToolSearchTool: select of already-loaded ${alreadyLoaded.join(', ')}`,
        )
        logSearchOutcome([], 'select')
        return buildSearchResult(
          [],
          query,
          deferredTools.length,
          undefined,
          buildAlreadyLoadedNote(alreadyLoaded, toolUseID),
        )
      }

      const found: string[] = []
      const missing: string[] = []
      for (const toolName of toSearch) {
        const tool = findToolByName(deferredTools, toolName)
        if (tool) {
          if (!found.includes(tool.name)) found.push(tool.name)
        } else {
          missing.push(toolName)
        }
      }

      const loadedNote = buildAlreadyLoadedNote(alreadyLoaded, toolUseID)

      if (found.length === 0) {
        logForDebugging(
          `ToolSearchTool: select failed — none found: ${missing.join(', ')}`,
        )
        logSearchOutcome([], 'select')
        const pendingServers = getPendingServerNames()
        return buildSearchResult(
          [],
          query,
          deferredTools.length,
          pendingServers,
          loadedNote,
        )
      }

      if (missing.length > 0) {
        logForDebugging(
          `ToolSearchTool: partial select — found: ${found.join(', ')}, missing: ${missing.join(', ')}`,
        )
      } else {
        logForDebugging(`ToolSearchTool: selected ${found.join(', ')}`)
      }
      logSearchOutcome(found, 'select')
      return buildSearchResult(
        found,
        query,
        deferredTools.length,
        undefined,
        loadedNote,
      )
    }

    // CC 2.1.302 #08 — keyword path, official Gn/Kn short-circuit:
    // `Gn=Z5(De).find((Un)=>Un.name.toLowerCase()===tn.toLowerCase())?.name,
    //  Kn=Gn===void 0?[]:Kt(Gn);
    //  if(Kn.length>0) return t("ToolSearchTool: keyword query names
    //  already-loaded …"), zt([],"keyword"), Yt(Kn)(await ot(MD([],_e,ze.length,[])))`
    // An exact-name pool hit on an already-loaded tool returns empty
    // matches + the isMeta note instead of re-emitting the tool.
    const queryTrimmed = query.trim()
    const exactPoolHit = tools.find(
      t => t.name.toLowerCase() === queryTrimmed.toLowerCase(),
    )?.name
    const exactHitLoaded =
      exactPoolHit === undefined
        ? []
        : getAlreadyLoadedNames(exactPoolHit, tools, loadedNames)
    if (exactHitLoaded.length > 0) {
      logForDebugging(
        `ToolSearchTool: keyword query names already-loaded ${exactHitLoaded.join(', ')}`,
      )
      logSearchOutcome([], 'keyword')
      return buildSearchResult(
        [],
        query,
        deferredTools.length,
        undefined,
        buildAlreadyLoadedNote(exactHitLoaded, toolUseID),
      )
    }

    // Partial overlap (official `dn=Yt(...)`): when the raw query resolves
    // (name/alias) to already-loaded tools without an exact primary-name
    // hit, the normal result is wrapped with the note for the loaded
    // subset. OCC's resolver is findToolByName (exact name or alias), so
    // this yields at most one name — mirroring official LX semantics with
    // OCC's resolver.
    const partialLoadedNames =
      exactPoolHit !== undefined || loadedNames.size === 0
        ? []
        : (() => {
            const resolved = findToolByName(tools, queryTrimmed)
            return resolved !== undefined && loadedNames.has(resolved.name)
              ? [resolved.name]
              : []
          })()
    const keywordNote = buildAlreadyLoadedNote(partialLoadedNames, toolUseID)

    // Keyword search
    const matches = await searchToolsWithKeywords(
      query,
      deferredTools,
      tools,
      max_results,
    )

    logForDebugging(
      `ToolSearchTool: keyword search for "${query}", found ${matches.length} matches`,
    )

    logSearchOutcome(matches, 'keyword')

    // Include pending server info when search finds no matches
    if (matches.length === 0) {
      const pendingServers = getPendingServerNames()
      return buildSearchResult(
        matches,
        query,
        deferredTools.length,
        pendingServers,
        keywordNote,
      )
    }

    return buildSearchResult(
      matches,
      query,
      deferredTools.length,
      undefined,
      keywordNote,
    )
  },
  renderToolUseMessage() {
    return null
  },
  userFacingName: () => '',
  /**
   * Returns a tool_result with tool_reference blocks.
   * This format works on 1P/Foundry. Bedrock/Vertex may not support
   * client-side tool_reference expansion yet.
   */
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    if (content.matches.length === 0) {
      let text = 'No matching deferred tools found'
      if (
        content.pending_mcp_servers &&
        content.pending_mcp_servers.length > 0
      ) {
        text += `. Some MCP servers are still connecting: ${content.pending_mcp_servers.join(', ')}. Their tools will become available shortly — try searching again.`
      }
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        content: text,
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: content.matches.map(name => ({
        type: 'tool_reference' as const,
        tool_name: name,
      })),
    } as unknown as ToolResultBlockParam
  },
} satisfies ToolDef<InputSchema, Output>)
