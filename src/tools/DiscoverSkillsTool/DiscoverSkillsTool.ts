// C9 (cross): DiscoverSkillsTool — on-demand skill search.
//
// Mirrors the official 2.1.200 `SearchSkills` tool (name/description/prompt
// match the binary exactly). The official `run` (s6n) posts to the OAuth org
// skill-search endpoint; OCC has no teleport-org client, so call() searches
// the locally-loaded skill set via src/skills/searchSkills.ts instead.
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getProjectRoot } from 'src/bootstrap/state.js'
import type {
  Tool,
  ToolResult,
  ToolUseContext,
} from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  formatSkillSearchResults,
  searchSkills,
} from '../../skills/searchSkills.js'
import {
  DISCOVER_SKILLS_TOOL_DESCRIPTION,
  DISCOVER_SKILLS_TOOL_NAME,
  DISCOVER_SKILLS_TOOL_PROMPT,
} from './prompt.js'

export const inputSchema = lazySchema(() =>
  z.object({
    keywords: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(8)
      .describe(
        "Keyword phrases describing the user's intent or a named product.",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Output = {
  success: boolean
  query: string
  count: number
}

export const DiscoverSkillsTool: Tool<InputSchema, Output> = buildTool({
  name: DISCOVER_SKILLS_TOOL_NAME,
  searchHint: 'search skills by keyword',
  get inputSchema(): InputSchema {
    return inputSchema()
  },

  description: async () => DISCOVER_SKILLS_TOOL_DESCRIPTION,

  prompt: async () => DISCOVER_SKILLS_TOOL_PROMPT,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call({ keywords }, context: ToolUseContext): Promise<ToolResult<Output>> {
    const query = keywords.join(' ')
    logEvent('skill_search', {
      keyword_count: keywords.length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    const cwd = context.options?.cwd ?? getProjectRoot()
    const results = await searchSkills(keywords, cwd)
    const content = formatSkillSearchResults(results)
    return {
      data: {
        success: results.length > 0,
        query,
        count: results.length,
      },
      newMessages: [
        {
          type: 'user' as const,
          message: { role: 'user', content: content },
          isMeta: true,
          uuid: '',
        },
      ],
    }
  },

  mapToolResultToToolResultBlockParam(
    result: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: `${result.count} skill${result.count === 1 ? '' : 's'} matched "${result.query}"`,
    }
  },
})
