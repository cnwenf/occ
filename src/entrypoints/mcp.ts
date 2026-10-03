import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import review from '../commands/review.js'
import type { Command } from '../commands.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import {
  findToolByName,
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../Tool.js'
import {
  type AgentDefinitionsResult,
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
  getAgentHookTrustKey,
  getGlobalConfigFilePath,
  isAgentHooksOriginTrusted,
  sanitizeTrustKey,
} from '../tools/AgentTool/loadAgentsDir.js'
import { getTools } from '../tools.js'
import { createAbortController } from '../utils/abortController.js'
import { logForDebugging } from '../utils/debug.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { logError } from '../utils/log.js'
import { createAssistantMessage } from '../utils/messages.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { setCwd } from '../utils/Shell.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { getErrorParts } from '../utils/toolErrors.js'
import { zodToJsonSchema } from '../utils/zodToJsonSchema.js'

type ToolInput = Tool['inputSchema']
type ToolOutput = Tool['outputSchema']

const MCP_COMMANDS: Command[] = [review]

/**
 * CC 2.1.288 #62 — official `Gye(def, "subagent", "definition")`: error-level
 * log + telemetry for an agent definition skipped at serve time because the
 * folder its definition file came from is not trusted. Message mirrors the
 * v288 binary's definition variant byte-for-byte (incl. the `Q0t` hint and
 * the `Pn` control-char sanitisation of the agent type). hooks.ts's
 * `skipFrontmatterHooksForUntrustedOrigin` only covers the hooks variant of
 * the official's unified logger, and hooks.ts is out of scope for this port.
 */
function logUntrustedAgentDefinitionSkip(agentDef: {
  agentType: string
  source: string | undefined
  baseDir?: string
}): void {
  // Official `Pn(e.agentType)`: strip control/format chars for safe display.
  const safeAgentType = agentDef.agentType.replace(
    /[\p{Cc}\p{Cf}\u2028\u2029]+/gu,
    ' ',
  )
  const sanitizedKey = sanitizeTrustKey(getAgentHookTrustKey(agentDef))
  const configPath = getGlobalConfigFilePath()
  logForDebugging(
    `Skipping agent '${safeAgentType}': the folder its definition file came from is not trusted (source: ${agentDef.source}). Run Claude Code in that folder once and accept the trust dialog, or set projects[${sanitizedKey}].hasTrustDialogAccepted: true in ${configPath}.`,
    { level: 'error' },
  )
  logEvent('tengu_agent_hooks_origin_untrusted', {
    what:
      'definition' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    source:
      String(
        agentDef.source,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    surface:
      'subagent' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // TODO: mirror the hooks.ts note — always 'false' until --add-dir
    // (fromAdditionalDirectory) discovery lands.
    fromAdditionalDirectory:
      'false' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export async function startMCPServer(
  cwd: string,
  debug: boolean,
  verbose: boolean,
): Promise<void> {
  // Use size-limited LRU cache for readFileState to prevent unbounded memory growth
  // 100 files and 25MB limit should be sufficient for MCP server operations
  const READ_FILE_STATE_CACHE_SIZE = 100
  const readFileStateCache = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )
  setCwd(cwd)

  // CC 2.1.288 #62: load agent definitions asynchronously at startup and
  // thread them into both request handlers — mirrors the official v288 serve
  // entrypoint (binary @240458756):
  //   let N={activeAgents:[],allAgents:[]},
  //       L=pC(oe(),s).then((o)=>{N=Une(o,o.allAgents.filter((T)=>
  //         {if(zce(T))return!0;return Gye(T,"subagent","definition"),!1}))})
  //         .catch(...)
  // and both handlers `await L` before building tools / tool contexts. v287
  // (@239047744) hardcoded the empties OCC used to replicate here, so the
  // Agent tool reported no agents and rejected every subagent_type.
  let agentDefinitions: AgentDefinitionsResult = {
    activeAgents: [],
    allAgents: [],
  }
  const agentDefinitionsPromise = getAgentDefinitionsWithOverrides(cwd)
    .then(loaded => {
      // Official `zce` filter: a definition whose origin folder is not
      // trusted is not servable; every rejection logs + emits telemetry
      // (official `Gye(T,"subagent","definition")`).
      const trustedAllAgents = loaded.allAgents.filter(agentDef => {
        if (isAgentHooksOriginTrusted(agentDef)) {
          return true
        }
        logUntrustedAgentDefinitionSkip(agentDef)
        return false
      })
      // Official `Une(o, filtered)` = {...o, allAgents: filtered,
      // activeAgents: gj(filtered)}; gj is the override-precedence dedup =
      // getActiveAgentsFromList.
      agentDefinitions = {
        ...loaded,
        allAgents: trustedAllAgents,
        activeAgents: getActiveAgentsFromList(trustedAllAgents),
      }
    })
    .catch((error: unknown) => {
      // Official `.catch`: log, keep the initial empties, serve on.
      logError(error)
    })

  const server = new Server(
    {
      name: 'claude/tengu',
      version: MACRO.VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => {
      // Official v288: `await L` before building tools, so prompts see the
      // loaded definitions (`ie` passes `agents:g.activeAgents` to prompt).
      await agentDefinitionsPromise
      // TODO: Also re-expose any MCP tools
      const toolPermissionContext = getEmptyToolPermissionContext()
      const tools = getTools(toolPermissionContext)
      return {
        tools: await Promise.all(
          tools.map(async tool => {
            let outputSchema: ToolOutput | undefined
            if (tool.outputSchema) {
              const convertedSchema = zodToJsonSchema(tool.outputSchema)
              // MCP SDK requires outputSchema to have type: "object" at root level
              // Skip schemas with anyOf/oneOf at root (from z.union, z.discriminatedUnion, etc.)
              // See: https://github.com/anthropics/claude-code/issues/8014
              if (
                typeof convertedSchema === 'object' &&
                convertedSchema !== null &&
                'type' in convertedSchema &&
                convertedSchema.type === 'object'
              ) {
                outputSchema = convertedSchema as ToolOutput
              }
            }
            return {
              ...tool,
              description: await tool.prompt({
                getToolPermissionContext: async () => toolPermissionContext,
                tools,
                agents: agentDefinitions.activeAgents,
              }),
              inputSchema: zodToJsonSchema(tool.inputSchema) as ToolInput,
              outputSchema,
            }
          }),
        ),
      }
    },
  )

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }): Promise<CallToolResult> => {
      // Official v288: `await L` before resolving tools / building the
      // tool-use context, so the Agent tool sees the loaded definitions.
      await agentDefinitionsPromise
      const toolPermissionContext = getEmptyToolPermissionContext()
      // TODO: Also re-expose any MCP tools
      const tools = getTools(toolPermissionContext)
      const tool = findToolByName(tools, name)
      if (!tool) {
        throw new Error(`Tool ${name} not found`)
      }

      // Assume MCP servers do not read messages separately from the tool
      // call arguments.
      const toolUseContext: ToolUseContext = {
        abortController: createAbortController(),
        options: {
          commands: MCP_COMMANDS,
          tools,
          mainLoopModel: getMainLoopModel(),
          thinkingConfig: { type: 'disabled' },
          mcpClients: [],
          mcpResources: {},
          isNonInteractiveSession: true,
          debug,
          verbose,
          // Official v288 threads the full loaded result (`agentDefinitions:N`,
          // incl. allowedAgentTypes) instead of the v287 hardcoded empties.
          agentDefinitions,
        },
        getAppState: () => getDefaultAppState(),
        setAppState: () => {},
        messages: [],
        readFileState: readFileStateCache,
        setInProgressToolUseIDs: () => {},
        setResponseLength: () => {},
        updateFileHistoryState: () => {},
        updateAttributionState: () => {},
      }

      // TODO: validate input types with zod
      try {
        if (!tool.isEnabled()) {
          throw new Error(`Tool ${name} is not enabled`)
        }
        const validationResult = await tool.validateInput?.(
          (args as never) ?? {},
          toolUseContext,
        )
        if (validationResult && !validationResult.result) {
          throw new Error(
            `Tool ${name} input is invalid: ${(validationResult as any).message}`,
          )
        }
        const finalResult = await tool.call(
          (args ?? {}) as never,
          toolUseContext,
          hasPermissionsToUseTool,
          createAssistantMessage({
            content: [],
          }),
        )

        return {
          content: [
            {
              type: 'text' as const,
              text:
                typeof finalResult === 'string'
                  ? finalResult
                  : jsonStringify(finalResult.data),
            },
          ],
        }
      } catch (error) {
        logError(error)

        const parts =
          error instanceof Error ? getErrorParts(error) : [String(error)]
        const errorText = parts.filter(Boolean).join('\n').trim() || 'Error'

        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: errorText,
            },
          ],
        }
      }
    },
  )

  async function runServer() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
  }

  return await runServer()
}
