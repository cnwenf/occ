import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Tool, ToolPermissionContext } from '../Tool.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { countMcpToolTokens } from './analyzeContext.js'
import {
  getLargeMemoryFiles,
  getMemoryCharThreshold,
  getMemoryFiles,
} from './claudemd.js'
import { getContextWindowForModel } from './context.js'
import { getMainLoopModel } from './model/model.js'
import { permissionRuleValueToString } from './permissions/permissionRuleParser.js'
import { detectUnreachableRules } from './permissions/shadowedRuleDetection.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import {
  AGENT_DESCRIPTIONS_THRESHOLD,
  getAgentDescriptionsTotalTokens,
} from './statusNoticeHelpers.js'
import { plural } from './stringUtils.js'

// Thresholds (matching status notices and existing patterns)
const MCP_TOOLS_THRESHOLD = 25_000 // 15k tokens

export type ContextWarning = {
  type:
    | 'claudemd_files'
    | 'agent_descriptions'
    | 'mcp_tools'
    | 'unreachable_rules'
  severity: 'warning' | 'error'
  message: string
  details: string[]
  currentValue: number
  threshold: number
}

export type ContextWarnings = {
  claudeMdWarning: ContextWarning | null
  agentWarning: ContextWarning | null
  mcpWarning: ContextWarning | null
  unreachableRulesWarning: ContextWarning | null
}

/**
 * A CLAUDE.md section whose content Claude could derive from the code or git
 * history, and that `/doctor` proposes trimming (claude-code 2.1.206 #2).
 */
export type DerivableClaudeMdSection = {
  path: string
  header: string
  reason: string
}

// Header patterns whose section body is typically derivable. Matching is
// case-insensitive on the bare header text (e.g. "## Project Structure").
const STRUCTURE_HEADER_RE =
  /^\s*#{2,}\s+(project structure|file structure|directory structure|folder structure|directory)\s*$/i
const COMMANDS_HEADER_RE =
  /^\s*#{2,}\s+(commands|scripts|build commands)\s*$/i
const DEPS_HEADER_RE =
  /^\s*#{2,}\s+(dependencies|tech stack|stack)\s*$/i
const PACKAGE_MANAGER_CMD_RE =
  /\b(?:npm|bun|yarn|pnpm|npx)\s+(?:run\s+)?[\w:-]+\b|\bmake\s+\w+/

/**
 * Find CLAUDE.md sections whose content Claude can derive from the code or
 * git history. `/doctor` uses this to propose trimming checked-in memory
 * files instead of only flagging them by size (claude-code 2.1.206 #2).
 *
 * Exported for testing.
 */
export function findDerivableClaudeMdSections(
  files: ReadonlyArray<{ path: string; content: string }>,
): DerivableClaudeMdSection[] {
  const sections: DerivableClaudeMdSection[] = []
  for (const file of files) {
    const lines = file.content.split('\n')
    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      const struct = line.match(STRUCTURE_HEADER_RE)
      const cmds = line.match(COMMANDS_HEADER_RE)
      const deps = line.match(DEPS_HEADER_RE)
      if (struct || cmds || deps) {
        const header = line.trim()
        // Collect the body up to the next same-or-higher level header.
        const bodyStart = i + 1
        let end = bodyStart
        while (end < lines.length && !/^\s*#{2,}\s+/.test(lines[end]!)) {
          end++
        }
        const body = lines.slice(bodyStart, end)
        let reason: string
        if (struct) {
          reason =
            'directory/file structure is derivable from the filesystem'
        } else if (cmds) {
          // Only flag a commands section if it actually restates package
          // manager scripts; otherwise it may carry non-derivable notes.
          if (!body.some(l => PACKAGE_MANAGER_CMD_RE.test(l))) {
            i = end
            continue
          }
          reason = 'commands are derivable from package.json scripts'
        } else {
          reason = 'dependencies are derivable from the package manifest'
        }
        sections.push({ path: file.path, header, reason })
        i = end
        continue
      }
      i++
    }
  }
  return sections
}

async function checkClaudeMdFiles(): Promise<ContextWarning | null> {
  const threshold = getMemoryCharThreshold(
    getContextWindowForModel(getMainLoopModel()),
  )
  const allFiles = await getMemoryFiles()
  const largeFiles = getLargeMemoryFiles(allFiles, threshold)
  // 2.1.206 #2: also flag content Claude could derive (file structure,
  // commands, dependencies) and propose trimming — even when the file
  // isn't large by the size threshold.
  const derivable = findDerivableClaudeMdSections(allFiles)

  // This already filters for files exceeding the (context-scaled) threshold each
  if (largeFiles.length === 0 && derivable.length === 0) {
    return null
  }

  const details: string[] = []
  for (const file of [...largeFiles].sort(
    (a, b) => b.content.length - a.content.length,
  )) {
    details.push(`${file.path}: ${file.content.length.toLocaleString()} chars`)
  }
  for (const section of derivable.slice(0, 10)) {
    details.push(
      `${section.path}: consider trimming "${section.header}" — ${section.reason}`,
    )
  }

  const parts: string[] = []
  if (largeFiles.length > 0) {
    parts.push(
      largeFiles.length === 1
        ? `Large CLAUDE.md file detected (${largeFiles[0]!.content.length.toLocaleString()} chars > ${threshold.toLocaleString()})`
        : `${largeFiles.length} large CLAUDE.md files detected (each > ${threshold.toLocaleString()} chars)`,
    )
  }
  if (derivable.length > 0) {
    parts.push(
      `${derivable.length} CLAUDE.md section${derivable.length === 1 ? '' : 's'} with content Claude could derive — consider trimming`,
    )
  }
  const message = parts.join('; ')

  return {
    type: 'claudemd_files',
    severity: 'warning',
    message,
    details,
    currentValue: largeFiles.length,
    threshold,
  }
}

/**
 * Check agent descriptions token count
 */
async function checkAgentDescriptions(
  agentInfo: AgentDefinitionsResult | null,
): Promise<ContextWarning | null> {
  if (!agentInfo) {
    return null
  }

  const totalTokens = getAgentDescriptionsTotalTokens(agentInfo)

  if (totalTokens <= AGENT_DESCRIPTIONS_THRESHOLD) {
    return null
  }

  // Calculate tokens for each agent
  const agentTokens = agentInfo.activeAgents
    .filter(a => a.source !== 'built-in')
    .map(agent => {
      const description = `${agent.agentType}: ${agent.whenToUse}`
      return {
        name: agent.agentType,
        tokens: roughTokenCountEstimation(description),
      }
    })
    .sort((a, b) => b.tokens - a.tokens)

  const details = agentTokens
    .slice(0, 5)
    .map(agent => `${agent.name}: ~${agent.tokens.toLocaleString()} tokens`)

  if (agentTokens.length > 5) {
    details.push(`(${agentTokens.length - 5} more custom agents)`)
  }

  return {
    type: 'agent_descriptions',
    severity: 'warning',
    message: `Large agent descriptions (~${totalTokens.toLocaleString()} tokens > ${AGENT_DESCRIPTIONS_THRESHOLD.toLocaleString()})`,
    details,
    currentValue: totalTokens,
    threshold: AGENT_DESCRIPTIONS_THRESHOLD,
  }
}

/**
 * Check MCP tools token count
 */
async function checkMcpTools(
  tools: Tool[],
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
): Promise<ContextWarning | null> {
  const mcpTools = tools.filter(tool => tool.isMcp)

  // Note: MCP tools are loaded asynchronously and may not be available
  // when doctor command runs, as it executes before MCP connections are established
  if (mcpTools.length === 0) {
    return null
  }

  try {
    // Use the existing countMcpToolTokens function from analyzeContext
    const model = getMainLoopModel()
    const { mcpToolTokens, mcpToolDetails } = await countMcpToolTokens(
      tools,
      getToolPermissionContext,
      agentInfo,
      model,
    )

    if (mcpToolTokens <= MCP_TOOLS_THRESHOLD) {
      return null
    }

    // Group tools by server
    const toolsByServer = new Map<string, { count: number; tokens: number }>()

    for (const tool of mcpToolDetails) {
      // Extract server name from tool name (format: mcp__servername__toolname)
      const parts = tool.name.split('__')
      const serverName = parts[1] || 'unknown'

      const current = toolsByServer.get(serverName) || { count: 0, tokens: 0 }
      toolsByServer.set(serverName, {
        count: current.count + 1,
        tokens: current.tokens + tool.tokens,
      })
    }

    // Sort servers by token count
    const sortedServers = Array.from(toolsByServer.entries()).sort(
      (a, b) => b[1].tokens - a[1].tokens,
    )

    const details = sortedServers
      .slice(0, 5)
      .map(
        ([name, info]) =>
          `${name}: ${info.count} tools (~${info.tokens.toLocaleString()} tokens)`,
      )

    if (sortedServers.length > 5) {
      details.push(`(${sortedServers.length - 5} more servers)`)
    }

    return {
      type: 'mcp_tools',
      severity: 'warning',
      message: `Large MCP tools context (~${mcpToolTokens.toLocaleString()} tokens > ${MCP_TOOLS_THRESHOLD.toLocaleString()})`,
      details,
      currentValue: mcpToolTokens,
      threshold: MCP_TOOLS_THRESHOLD,
    }
  } catch (_error) {
    // If token counting fails, fall back to character-based estimation
    const estimatedTokens = mcpTools.reduce((total, tool) => {
      const chars = (tool.name?.length || 0) + tool.description.length
      return total + roughTokenCountEstimation(chars.toString())
    }, 0)

    if (estimatedTokens <= MCP_TOOLS_THRESHOLD) {
      return null
    }

    return {
      type: 'mcp_tools',
      severity: 'warning',
      message: `Large MCP tools context (~${estimatedTokens.toLocaleString()} tokens estimated > ${MCP_TOOLS_THRESHOLD.toLocaleString()})`,
      details: [
        `${mcpTools.length} MCP tools detected (token count estimated)`,
      ],
      currentValue: estimatedTokens,
      threshold: MCP_TOOLS_THRESHOLD,
    }
  }
}

/**
 * Check for unreachable permission rules (e.g., specific allow rules shadowed by tool-wide ask rules)
 */
async function checkUnreachableRules(
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
): Promise<ContextWarning | null> {
  const context = await getToolPermissionContext()
  const sandboxAutoAllowEnabled =
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled()

  const unreachable = detectUnreachableRules(context, {
    sandboxAutoAllowEnabled,
  })

  if (unreachable.length === 0) {
    return null
  }

  const details = unreachable.flatMap(r => [
    `${permissionRuleValueToString(r.rule.ruleValue)}: ${r.reason}`,
    `  Fix: ${r.fix}`,
  ])

  return {
    type: 'unreachable_rules',
    severity: 'warning',
    message: `${unreachable.length} ${plural(unreachable.length, 'unreachable permission rule')} detected`,
    details,
    currentValue: unreachable.length,
    threshold: 0,
  }
}

/**
 * Check all context warnings for the doctor command
 */
export async function checkContextWarnings(
  tools: Tool[],
  agentInfo: AgentDefinitionsResult | null,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
): Promise<ContextWarnings> {
  const [claudeMdWarning, agentWarning, mcpWarning, unreachableRulesWarning] =
    await Promise.all([
      checkClaudeMdFiles(),
      checkAgentDescriptions(agentInfo),
      checkMcpTools(tools, getToolPermissionContext, agentInfo),
      checkUnreachableRules(getToolPermissionContext),
    ])

  return {
    claudeMdWarning,
    agentWarning,
    mcpWarning,
    unreachableRulesWarning,
  }
}
