import {
  type ListResourcesResult,
  ListResourcesResultSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { ensureConnectedClient } from '../../services/mcp/client.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT, READ_MCP_RESOURCE_DIR_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage, userFacingName } from './UI.js'

/**
 * Extension capability key a server declares (in capabilities.extensions)
 * to advertise support for MCP "skills" / directory reads.
 */
const MCP_SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'

/**
 * Default timeout for the resources/directory/read request, mirroring the
 * official binary's Wz() (env MCP_TIMEOUT or 60s).
 */
function getDirectoryReadTimeoutMs(): number {
  return parseInt(process.env.MCP_TIMEOUT || '', 10) || 60_000
}

/**
 * True when the server has declared the io.modelcontextprotocol/skills
 * extension with directoryRead === true. Matches the binary's m8e() check.
 */
function supportsDirectoryRead(
  capabilities: Record<string, unknown> | undefined,
): boolean {
  const ext = (capabilities as
    | Record<string, Record<string, unknown> | undefined>
    | undefined)?.extensions?.[MCP_SKILLS_EXTENSION]
  return (
    ext != null &&
    typeof ext === 'object' &&
    'directoryRead' in ext &&
    ext.directoryRead === true
  )
}

export const inputSchema = lazySchema(() =>
  z.object({
    server: z.string().describe('The MCP server name'),
    uri: z.string().describe('The URI of the directory resource to list'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    resources: z
      .array(
        z.object({
          uri: z.string().describe('Resource URI'),
          name: z.string().optional().describe('Resource name'),
          mimeType: z
            .string()
            .optional()
            .describe('MIME type of the resource (inode/directory for subdirs)'),
          description: z.string().optional().describe('Resource description'),
        }),
      )
      .describe('Direct children of the directory resource'),
    error: z.string().optional().describe('Error message if listing failed'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ReadMcpResourceDirTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.server} ${input.uri}`
  },
  shouldDefer: true,
  name: READ_MCP_RESOURCE_DIR_TOOL_NAME,
  aliases: ['ReadMcpResourceDir'],
  searchHint: 'list the children of an MCP directory resource',
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
  async call(input, { options: { mcpClients } }) {
    const { server: serverName, uri } = input

    const client = mcpClients.find(client => client.name === serverName)

    if (!client) {
      throw new Error(
        `Server "${serverName}" not found. Available servers: ${mcpClients.map(c => c.name).join(', ')}`,
      )
    }

    // Directory listing is gated behind the tengu_mcp_skills flag. When off
    // (the default in this build), surface a clear error rather than
    // attempting an unsupported method. Matches the binary's wx() check.
    if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_mcp_skills', false)) {
      return {
        data: {
          resources: [],
          error: 'Directory listing is not enabled in this build.',
        },
      }
    }

    if (!supportsDirectoryRead(client.capabilities as Record<string, unknown>)) {
      return {
        data: {
          resources: [],
          error: `Server "${client.name}" does not support directory listing.`,
        },
      }
    }

    const connectedClient = await ensureConnectedClient(client)

    // Paginated directory read. The server returns a page of children plus an
    // optional nextCursor; follow cursors until exhausted. An InvalidParams
    // error on the first page means the URI is a file resource, not a
    // directory — tell the model to use ReadMcpResource instead.
    const resources: Output['resources'] = []
    let cursor: string | undefined
    let page = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let result: ListResourcesResult
      try {
        result = (await connectedClient.client.request(
          {
            method: 'resources/directory/read',
            params: { uri, ...(cursor !== undefined && { cursor }) },
          },
          ListResourcesResultSchema,
          { timeout: getDirectoryReadTimeoutMs() },
        )) as ListResourcesResult
      } catch (e) {
        if (
          page === 0 &&
          e instanceof McpError &&
          e.code === ErrorCode.InvalidParams
        ) {
          logMCPError(
            client.name,
            `resources/directory/read ${uri}: page 1 returned ${e.code} — not a directory`,
          )
          return {
            data: {
              resources: [],
              error: `Not a directory resource: ${uri}. If it is a file resource, use ReadMcpResource instead.`,
            },
          }
        }
        throw e
      }
      for (const r of result.resources ?? []) {
        resources.push({
          uri: r.uri,
          name: r.name,
          mimeType: r.mimeType,
          description: r.description,
        })
      }
      cursor = result.nextCursor
      page++
      if (cursor === undefined) break
    }

    logEvent('tengu_mcp_resource_dir_read', {
      server: serverName,
      resultCount: resources.length,
      pages: page,
    })

    return { data: { resources } }
  },
  renderToolUseMessage,
  userFacingName,
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(jsonStringify(output))
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
