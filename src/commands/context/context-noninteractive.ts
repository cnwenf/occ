import { feature } from 'src/utils/featureFlags.js'
import { getCommandName } from '../../commands.js'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../../Tool.js'
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'
import { getLimitedSkillToolCommands } from '../../tools/SkillTool/prompt.js'
import type { Message } from '../../types/message.js'
import {
  analyzeContextUsage,
  type ContextData,
} from '../../utils/analyzeContext.js'
import { getCwd } from '../../utils/cwd.js'
import { formatTokens, formatTokenEstimate } from '../../utils/format.js'
import { getCanonicalName } from '../../utils/model/model.js'
import {
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
} from '../../utils/messages.js'
import { getSourceDisplayName } from '../../utils/settings/constants.js'
import { plural } from '../../utils/stringUtils.js'

/**
 * 2.1.139 (J18): models whose tokenizer is ~4 bytes/token. All other models
 * (opus-4-7/4-8, sonnet-5, fable-5, …) use a denser ~3 bytes/token. Mirrors
 * the official `fRd` set consulted by `EE(model)`.
 */
const FOUR_BYTES_PER_TOKEN_MODELS = new Set([
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-7-sonnet',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
])

/**
 * Model-aware bytes-per-token ratio for the per-skill frontmatter estimate.
 * Mirrors the official `EE(e)`:
 *   if (!e) return 4;
 *   let n = normalize(getCanonicalName(e)).replace(/[._]/g, '-');
 *   return fRd.has(n) ? 4 : 3;
 *
 * The per-skill estimate previously hardcoded /4, so for denser-tokenizer
 * models (3 bytes/token) it overcounted by ~33%. /context now rescales each
 * skill's frontmatter tokens by the active model's ratio.
 */
function getBytesPerTokenForModel(model: string | undefined): number {
  if (!model) return 4
  const canonical = getCanonicalName(model).replace(/[._]/g, '-')
  return FOUR_BYTES_PER_TOKEN_MODELS.has(canonical) ? 4 : 3
}

/**
 * 2.1.139 (J18): recompute per-skill frontmatter token estimates using the
 * active model's bytes-per-token ratio instead of the analyzer's hardcoded /4.
 *
 * `analyzeContextUsage` counts the *total* skill tokens via the API tokenizer
 * but estimates the *per-skill* breakdown with `estimateSkillFrontmatterTokens`
 * (chars/4), which isn't model-aware. For models with a denser tokenizer
 * (3 bytes/token) that overcounts each skill, so the per-skill rows disagree
 * with the model's actual tokenization. Mirrors the official per-skill
 * `Rf(b(T), EE(model))` = `Math.round(text.length / modelRatio)`.
 */
export async function rescaleSkillTokensForModel(
  data: ContextData,
  model: string,
): Promise<void> {
  const ratio = getBytesPerTokenForModel(model)
  if (ratio === 4) return // already matches the analyzer's /4
  const frontmatter = data.skills?.skillFrontmatter
  if (!frontmatter || frontmatter.length === 0) return

  const skills = await getLimitedSkillToolCommands(getCwd())
  const byName = new Map(skills.map(s => [getCommandName(s), s]))
  for (const sf of frontmatter) {
    const skill = byName.get(sf.name)
    if (!skill) continue
    const text = [getCommandName(skill), skill.description, skill.whenToUse]
      .filter(Boolean)
      .join(' ')
    sf.tokens = roughTokenCountEstimation(text, ratio)
  }
}


/**
 * 2.1.218 #7 (B6): /context reported stale pre-compact token usage after
 * compacting from the message picker.
 *
 * Bug: after a partial compact, messagesToKeep (the preserved segment) retain
 * their pre-compact token usage. getCurrentUsage scans backwards and returns
 * the last usage-bearing message — a kept message whose usage reflects the
 * pre-compact (larger) context, not the post-compact context.
 *
 * Fix: strip usage from messages in the compact boundary's preservedSegment
 * (headUuid..tailUuid inclusive) so getCurrentUsage falls through to the
 * compact summary (fresh) or new post-compact turns (fresh), or returns null
 * (estimation). Returns the array as-is when there is no boundary or no
 * preserved segment. Never mutates the input.
 */
export function stripStaleUsageFromPreservedSegment(
  messages: Message[],
): Message[] {
  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  if (boundaryIndex === -1) {
    return messages
  }
  const boundary = messages[boundaryIndex] as
    | (Message & {
        compactMetadata?: {
          preservedSegment?: {
            headUuid: string
            tailUuid: string
            anchorUuid: string
          }
        }
      })
    | undefined
  const segment = boundary?.compactMetadata?.preservedSegment
  if (!segment) {
    return messages
  }

  // Build a set of UUIDs in the preserved segment for O(1) lookup.
  // The preserved segment is contiguous (headUuid..tailUuid), but some loaders
  // may relink or omit messages, so a set is safer than an index range.
  let needsStrip = false
  const preservedUuids = new Set<string>()
  for (let i = boundaryIndex + 1; i < messages.length; i++) {
    const msg = messages[i]
    const uuid = msg?.uuid
    if (uuid === segment.headUuid) {
      needsStrip = true
    }
    if (needsStrip) {
      if (uuid) {
        preservedUuids.add(uuid)
      }
      if (uuid === segment.tailUuid) {
        break
      }
    }
  }

  if (preservedUuids.size === 0) {
    return messages
  }

  // Immutably strip usage from assistant messages in the preserved segment.
  let changed = false
  const result = messages.map(msg => {
    if (
      msg?.type === 'assistant' &&
      msg.uuid !== undefined &&
      preservedUuids.has(msg.uuid as string) &&
      msg.message &&
      'usage' in msg.message
    ) {
      changed = true
      // Remove the `usage` key so getTokenUsage skips this message.
      const { usage: _omit, ...rest } = msg.message as Record<string, unknown>
      return { ...msg, message: rest } as Message
    }
    return msg
  })

  return changed ? result : messages
}

/**
 * Shared data-collection path for `/context` (slash command) and the SDK
 * `get_context_usage` control request. Mirrors query.ts's pre-API transforms
 * (compact boundary, projectView, microcompact) so the token count reflects
 * what the model actually sees.
 */
type CollectContextDataInput = {
  messages: Message[]
  getAppState: () => AppState
  options: {
    mainLoopModel: string
    tools: Tools
    agentDefinitions: AgentDefinitionsResult
    customSystemPrompt?: string
    appendSystemPrompt?: string
  }
}

export async function collectContextData(
  context: CollectContextDataInput,
): Promise<ContextData> {
  const {
    messages,
    getAppState,
    options: {
      mainLoopModel,
      tools,
      agentDefinitions,
      customSystemPrompt,
      appendSystemPrompt,
    },
  } = context

  let apiView = getMessagesAfterCompactBoundary(messages)

  const { messages: compactedMessages } = await microcompactMessages(apiView)
  const appState = getAppState()

  const data = await analyzeContextUsage(
    compactedMessages,
    mainLoopModel,
    async () => appState.toolPermissionContext,
    tools,
    agentDefinitions,
    undefined, // terminalWidth
    // analyzeContextUsage only reads options.{customSystemPrompt,appendSystemPrompt}
    // but its signature declares the full Pick<ToolUseContext, 'options'>.
    { options: { customSystemPrompt, appendSystemPrompt } } as Pick<
      ToolUseContext,
      'options'
    >,
    undefined, // mainThreadAgentDefinition
    // 2.1.218 #7: strip stale pre-compact usage from the preserved segment so
    // /context shows fresh (post-compact) token usage, not the pre-compact
    // numbers carried by kept messages.
    stripStaleUsageFromPreservedSegment(apiView), // original messages for API usage extraction
  )

  // 2.1.139 (J18): rescale per-skill frontmatter tokens to the model's tokenizer.
  await rescaleSkillTokensForModel(data, mainLoopModel)
  return data
}

export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; value: string }> {
  const data = await collectContextData(context)
  return {
    type: 'text' as const,
    value: formatContextAsMarkdownTable(data),
  }
}

function formatContextAsMarkdownTable(data: ContextData): string {
  const {
    categories,
    totalTokens,
    rawMaxTokens,
    percentage,
    model,
    memoryFiles,
    mcpTools,
    agents,
    skills,
    messageBreakdown,
    systemTools,
    systemPromptSections,
  } = data

  let output = `## Context Usage\n\n`
  output += `**Model:** ${model}  \n`
  output += `**Tokens:** ${formatTokens(totalTokens)} / ${formatTokens(rawMaxTokens)} (${percentage}%)\n`

  // Context-collapse status. Always show when the runtime gate is on —
  // the user needs to know which strategy is managing their context
  // even before anything has fired.
  output += '\n'

  // Main categories table
  const visibleCategories = categories.filter(
    cat =>
      cat.tokens > 0 &&
      cat.name !== 'Free space' &&
      cat.name !== 'Autocompact buffer',
  )

  if (visibleCategories.length > 0) {
    output += `### Estimated usage by category\n\n`
    output += `| Category | Tokens | Percentage |\n`
    output += `|----------|--------|------------|\n`

    for (const cat of visibleCategories) {
      const percentDisplay = ((cat.tokens / rawMaxTokens) * 100).toFixed(1)
      output += `| ${cat.name} | ${formatTokens(cat.tokens)} | ${percentDisplay}% |\n`
    }

    const freeSpaceCategory = categories.find(c => c.name === 'Free space')
    if (freeSpaceCategory && freeSpaceCategory.tokens > 0) {
      const percentDisplay = (
        (freeSpaceCategory.tokens / rawMaxTokens) *
        100
      ).toFixed(1)
      output += `| Free space | ${formatTokens(freeSpaceCategory.tokens)} | ${percentDisplay}% |\n`
    }

    const autocompactCategory = categories.find(
      c => c.name === 'Autocompact buffer',
    )
    if (autocompactCategory && autocompactCategory.tokens > 0) {
      const percentDisplay = (
        (autocompactCategory.tokens / rawMaxTokens) *
        100
      ).toFixed(1)
      output += `| Autocompact buffer | ${formatTokens(autocompactCategory.tokens)} | ${percentDisplay}% |\n`
    }

    output += `\n`
  }

  // MCP tools
  if (mcpTools.length > 0) {
    output += `### MCP Tools\n\n`
    output += `| Tool | Server | Tokens |\n`
    output += `|------|--------|--------|\n`
    for (const tool of mcpTools) {
      output += `| ${tool.name} | ${tool.serverName} | ${formatTokens(tool.tokens)} |\n`
    }
    output += `\n`
  }

  // System tools (ant-only)
  if (
    systemTools &&
    systemTools.length > 0 &&
    process.env.USER_TYPE === 'ant'
  ) {
  }

  // System prompt sections (ant-only)
  if (
    systemPromptSections &&
    systemPromptSections.length > 0 &&
    process.env.USER_TYPE === 'ant'
  ) {
  }

  // Custom agents
  if (agents.length > 0) {
    output += `### Custom Agents\n\n`
    output += `| Agent Type | Source | Tokens |\n`
    output += `|------------|--------|--------|\n`
    for (const agent of agents) {
      let sourceDisplay: string
      switch (agent.source) {
        case 'projectSettings':
          sourceDisplay = 'Project'
          break
        case 'userSettings':
          sourceDisplay = 'User'
          break
        case 'localSettings':
          sourceDisplay = 'Local'
          break
        case 'flagSettings':
          sourceDisplay = 'Flag'
          break
        case 'policySettings':
          sourceDisplay = 'Policy'
          break
        case 'plugin':
          sourceDisplay = 'Plugin'
          break
        case 'built-in':
          sourceDisplay = 'Built-in'
          break
        default:
          sourceDisplay = String(agent.source)
      }
      output += `| ${agent.agentType} | ${sourceDisplay} | ${formatTokens(agent.tokens)} |\n`
    }
    output += `\n`
  }

  // Memory files
  if (memoryFiles.length > 0) {
    output += `### Memory Files\n\n`
    output += `| Type | Path | Tokens |\n`
    output += `|------|------|--------|\n`
    for (const file of memoryFiles) {
      output += `| ${file.type} | ${file.path} | ${formatTokens(file.tokens)} |\n`
    }
    output += `\n`
  }

  // Skills
  if (skills && skills.tokens > 0 && skills.skillFrontmatter.length > 0) {
    output += `### Skills\n\n`
    output += `| Skill | Source | Tokens |\n`
    output += `|-------|--------|--------|\n`
    for (const skill of skills.skillFrontmatter) {
      output += `| ${skill.name} | ${getSourceDisplayName(skill.source)} | ${formatTokenEstimate(skill.tokens)} |\n`
    }
    output += `\n`
  }

  // Message breakdown (ant-only)
  if (messageBreakdown && process.env.USER_TYPE === 'ant') {

    if (messageBreakdown.toolCallsByType.length > 0) {
    }

    if (messageBreakdown.attachmentsByType.length > 0) {
      output += `#### Top Attachments\n\n`
      output += `| Attachment | Tokens |\n`
      output += `|------------|--------|\n`
      for (const attachment of messageBreakdown.attachmentsByType) {
        output += `| ${attachment.name} | ${formatTokens(attachment.tokens)} |\n`
      }
      output += `\n`
    }
  }

  return output
}
