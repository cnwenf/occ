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
import { backgroundTimeoutUsageNote } from '../tasks/LocalShellTask/backgroundDeadline.js'
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
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
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
import { getTaskOutputPath } from '../utils/task/diskOutput.js'
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

// ── CC 2.1.295 serve-mode background Bash ─────────────────────────────────
//
// Official 2.1.295 serve factory (s295 verbatim; `y` = http mode, `Y=Sw()`
// is the host-config singleton — stdio `mcp serve` takes the else branch):
//
//   Y.disableBackgroundAgentLaunch(),Y.disableRemoteAgentIsolation(),
//   Y.disableBackgroundDeadline(),y?xIr(Sw()):Y.disableBackgroundCompletionNotice()
//
// New in 2.1.295 (verified absent from s294):
//
//   function Ole(){return!Sw().backgroundCompletionNoticeDisabled}
//   var sYt="Nothing notifies you when the command finishes: read the output
//     file that the result names to check on it. The file gets no line when
//     the command ends, so if you need to know that it has, end the command
//     with an `echo` of your own."
//
// Raw (stdio) serve tool-result serialization — NO mapper call; the
// interactive mapToolResultToToolResultBlockParam texts ("Output is being
// written to: …") never reach raw-serve clients:
//
//   let o=j.data,b=typeof o==="object"&&o!==null&&"backgroundTaskId"in o
//     &&typeof o.backgroundTaskId==="string"
//     ?{...o,backgroundOutputPath:ku(o.backgroundTaskId)}:o;
//   A={content:[{type:"text",text:_(b)}]}
//
// `ku(e)` ≡ OCC getTaskOutputPath(taskId) (join(getTaskOutputDir(),
// `${taskId}.output`)), `_` ≡ jsonStringify. OCC has no host-config singleton,
// so the Ole()-gated serve surface is reproduced here: result enrichment via
// serializeServeToolResultData(), description gating via
// toServeModeBashDescription(). The startup disable*() calls have no OCC
// equivalents beyond the existing setBackgroundDeadlineDisabled setter
// (module-global; staged — see the round's gap notes).

/** Official `sYt` — serve-mode background-completion sentence, verbatim. */
const SERVE_BACKGROUND_NO_NOTICE_SENTENCE =
  'Nothing notifies you when the command finishes: read the output file that the result names to check on it. The file gets no line when the command ends, so if you need to know that it has, end the command with an `echo` of your own.'

/**
 * The interactive Bash usage-note segment (BashTool/prompt.ts
 * getBackgroundUsageNote) that promises completion notifications. The
 * official serve-mode note (fxt()) replaces it: "Only use this if you don't
 * need the result immediately. ${sYt} You do not need to use '&' …" — no
 * notification promise and no backgroundTimeoutUsageNote() suffix.
 */
const INTERACTIVE_BACKGROUND_NOTICE_PROMISE =
  "Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes."

const SERVE_BACKGROUND_NOTICE_REPLACEMENT = `Only use this if you don't need the result immediately. ${SERVE_BACKGROUND_NO_NOTICE_SENTENCE}`

/**
 * Sleep sub-items dropped from the served Bash description where the official
 * gates on Ole() (serve stdio sets backgroundCompletionNoticeDisabled → the
 * Monitor bullet and both notification-promise bullets are not emitted).
 * The "`sleep N` … is blocked" bullet is deliberately NOT in this set: OCC's
 * serve validateInput still blocks long leading sleeps (the official's Ole()
 * gate there lives in BashTool.validateInput — shared file, staged), so
 * keeping that bullet stays truthful to actual OCC serve behavior.
 */
const SERVE_STRIPPED_NOTIFICATION_BULLETS: ReadonlySet<string> = new Set([
  'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.',
  'If your command is long running and you would like to be notified when it finishes — use `run_in_background`. No sleep needed.',
  'If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll.',
])

function isServeStrippedBulletLine(line: string): boolean {
  const trimmed = line.trimStart()
  return (
    trimmed.startsWith('- ') &&
    SERVE_STRIPPED_NOTIFICATION_BULLETS.has(trimmed.slice(2))
  )
}

/**
 * Rewrite the interactive Bash description into the official 2.1.295
 * serve-mode description (evidence-found route — see banner):
 * 1. swap the notification-promise segment for the official `sYt` text,
 * 2. strip the backgroundTimeoutUsageNote() suffix (the official serve note
 *    has none — serve sessions run with disableBackgroundDeadline()),
 * 3. drop the notification-promise sleep bullets (Ole() gating).
 * Pure and idempotent; text the transform does not recognize passes through
 * unchanged.
 */
export function toServeModeBashDescription(description: string): string {
  let transformed = description.replaceAll(
    INTERACTIVE_BACKGROUND_NOTICE_PROMISE,
    SERVE_BACKGROUND_NOTICE_REPLACEMENT,
  )
  const deadlineNote = backgroundTimeoutUsageNote()
  if (deadlineNote !== '') {
    transformed = transformed.replaceAll(deadlineNote, '')
  }
  return transformed
    .split('\n')
    .filter(line => !isServeStrippedBulletLine(line))
    .join('\n')
}

type BackgroundTaskResultData = Record<string, unknown> & {
  backgroundTaskId: string
}

function isBackgroundTaskResultData(
  data: unknown,
): data is BackgroundTaskResultData {
  return (
    typeof data === 'object' &&
    data !== null &&
    'backgroundTaskId' in data &&
    typeof (data as { backgroundTaskId?: unknown }).backgroundTaskId ===
      'string'
  )
}

/**
 * Official raw-serve tool-result serialization (banner evidence): background
 * task results gain `backgroundOutputPath: ku(backgroundTaskId)` — the
 * `.output` file the served client should read, since no completion
 * notification exists in serve mode. Non-background data serializes plain.
 * Immutable (spreads into a new object; the input is never mutated). Errors
 * (e.g. from getTaskOutputPath) propagate to the CallTool handler's catch →
 * explicit isError result + logError, mirroring the official (no local
 * try/catch, never silently swallowed).
 */
export function serializeServeToolResultData(data: unknown): string {
  if (isBackgroundTaskResultData(data)) {
    return jsonStringify({
      ...data,
      backgroundOutputPath: getTaskOutputPath(data.backgroundTaskId),
    })
  }
  return jsonStringify(data)
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
            const description = await tool.prompt({
              getToolPermissionContext: async () => toolPermissionContext,
              tools,
              agents: agentDefinitions.activeAgents,
            })
            return {
              ...tool,
              // CC 2.1.295: the served Bash description is Ole()-gated —
              // serve clients get no background-completion notifications, so
              // the served surface swaps in the official `sYt` text and drops
              // the notification-promise bullets (see toServeModeBashDescription).
              description:
                tool.name === BASH_TOOL_NAME
                  ? toServeModeBashDescription(description)
                  : description,
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
          // Pre-existing CanUseToolFn variance error (committed at HEAD,
          // unrelated to this round): hasPermissionsToUseTool declares an
          // extra optional `hookAskFloor?` param + narrower arg types than the
          // CanUseToolFn alias. Runtime is correct (exercised by the serve
          // e2e tests). Silenced with the same `as never` idiom used on the
          // args above to keep mcp.ts tsc-clean; no behavior change.
          hasPermissionsToUseTool as never,
          createAssistantMessage({
            content: [],
          }),
        )

        return {
          content: [
            {
              type: 'text' as const,
              // CC 2.1.295 raw-serve: background task data gains
              // `backgroundOutputPath` (official `ku` ≡ getTaskOutputPath)
              // before JSON serialization; everything else serializes plain.
              text:
                typeof finalResult === 'string'
                  ? finalResult
                  : serializeServeToolResultData(finalResult.data),
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
