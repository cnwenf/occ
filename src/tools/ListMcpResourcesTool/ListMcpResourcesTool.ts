import { z } from 'zod/v4'
import {
  ensureConnectedClient,
  fetchResourcesForClient,
} from '../../services/mcp/client.js'
import { filterMcpAppUiResources } from '../../services/mcp/mcpAppUiResources.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { AbortError, errorMessage, isAbortError } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, LIST_MCP_RESOURCES_TOOL_NAME, PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.object({
    server: z
      .string()
      .optional()
      .describe('Optional server name to filter resources by'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.array(
    z.object({
      uri: z.string().describe('Resource URI'),
      name: z.string().describe('Resource name'),
      mimeType: z.string().optional().describe('MIME type of the resource'),
      description: z.string().optional().describe('Resource description'),
      server: z.string().describe('Server that provides this resource'),
    }),
  ),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * CC 2.1.295 (item 5): race a pending request against the turn's abort
 * signal. If the signal fires first, reject with OCC's shared AbortError
 * (repo convention: `throw new AbortError()`).
 *
 * The official ListMcpResourcesTool (`kK`) is abortable —
 * `async call(s,{signal:m})` threads the turn signal into
 * `ensureConnectedClient(i,{signal:m,context:...})` and the resources/list
 * walk, so cancelling the turn interrupts an in-flight listing. OCC's MCP
 * client helpers take no signal parameter, so racing achieves the same
 * interruptibility without changing their signatures.
 */
async function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new AbortError()
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new AbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export const ListMcpResourcesTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.server ?? ''
  },
  shouldDefer: true,
  name: LIST_MCP_RESOURCES_TOOL_NAME,
  searchHint: 'list resources from connected MCP servers',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input, { options: { mcpClients }, abortController }) {
    const { server: targetServer } = input

    const clientsToProcess = targetServer
      ? mcpClients.filter(client => client.name === targetServer)
      : mcpClients

    if (targetServer && clientsToProcess.length === 0) {
      throw new Error(
        `Server "${targetServer}" not found. Available servers: ${mcpClients.map(c => c.name).join(', ')}`,
      )
    }

    // CC 2.1.295 (item 5): the turn's abort signal interrupts an in-flight
    // reconnect / resources/list (official `call(s,{signal:m})` threading).
    const signal = abortController?.signal

    // fetchResourcesForClient is LRU-cached (by server name) and already
    // warm from startup prefetch. Cache is invalidated on onclose and on
    // resources/list_changed notifications, so results are never stale.
    // ensureConnectedClient is a no-op when healthy (memoize hit), but after
    // onclose it returns a fresh connection so the re-fetch succeeds.
    const results = await Promise.all(
      clientsToProcess.map(async client => {
        if (client.type !== 'connected') return []
        try {
          const fresh = await raceAbort(ensureConnectedClient(client), signal)
          const resources = await raceAbort(
            fetchResourcesForClient(fresh),
            signal,
          )
          // 2.1.281: MCP Apps UI resources (ui:// or text/html with
          // profile=mcp-app) are left out of the model's list; they can
          // still be read by URI via ReadMcpResourceTool.
          return filterMcpAppUiResources(resources, client.name)
        } catch (error) {
          // A user abort must escape the per-server catch — the official
          // tool surfaces the abort instead of returning a partial list.
          if (isAbortError(error)) throw error
          // One server's reconnect failure shouldn't sink the whole result.
          logMCPError(client.name, errorMessage(error))
          return []
        }
      }),
    )

    return {
      data: results.flat(),
    }
  },
  renderToolUseMessage,
  userFacingName: () => 'listMcpResources',
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(jsonStringify(output))
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    if (!content || content.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content:
          'No resources found. MCP servers may still provide tools even if they have no resources.',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
