import { z } from 'zod/v4'
import {
  AuthenticationCancelledError,
  getActiveOAuthPromise,
  getOAuthCallbackSubmitter,
} from '../../services/mcp/auth.js'
import {
  sanitizeForDisplay,
  sanitizeServerNameForDisplay,
} from '../../services/mcp/displaySanitize.js'
import { buildMcpToolName } from '../../services/mcp/mcpStringUtils.js'
import {
  redactMcpErrorDetail,
  type UnexpandedScopeResolver,
} from '../../services/mcp/redaction.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { resolveUnexpandedMcpServers } from '../../services/mcp/utils.js'
import type { Tool } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  MCP_AUTH_TOOL_SUFFIX,
  MCP_COMPLETE_AUTH_TOOL_SUFFIX,
  TOOLS_NOW_AVAILABLE_SENTENCE,
} from './mcpAuthStubShared.js'

/** Binary `_` schema @211336157 region — verbatim `.describe()` text. */
const inputSchema = lazySchema(() =>
  z.object({
    callback_url: z
      .string()
      .describe(
        'The full callback URL from the browser address bar after authorizing, e.g. http://localhost:<port>/callback?code=...&state=...',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type McpCompleteAuthOutput = {
  status: 'success' | 'error'
  message: string
}

/**
 * Binary `v(e,r)` @211336157 region (2.1.274): the callback-paste auth-stub
 * tool description. Byte-verified against the live 2.1.274 ELF (direct
 * bytes extraction — `strings` collapses the em-dash/newline context; see
 * docs/upstream-version-gap-occ128.md). `n` is the sibling authenticate
 * tool's name (`mcp__<server>__authenticate`), `xr()` the server-name
 * display sanitizer.
 *
 * Divergence: the official also stamps `mcpInfo.serverType/source/
 * isAuthStub` — OCC's `Tool.mcpInfo` type only carries `{serverName,
 * toolName}` (documented in docs/upstream-version-gap-occ127.md Part II).
 */
export function buildMcpCompleteAuthToolDescription(
  serverName: string,
): string {
  const authenticateToolName = buildMcpToolName(
    serverName,
    MCP_AUTH_TOOL_SUFFIX,
  )
  return (
    `Complete an in-progress OAuth flow for the "${sanitizeServerNameForDisplay(serverName)}" MCP server by submitting the callback URL. Call \`${authenticateToolName}\` first to start the flow and get the authorization URL. ` +
    'After the user authorizes in their browser, the browser is redirected to a `http://localhost:<port>/callback?code=...&state=...` URL — ' +
    'on remote sessions that page fails to load, but the URL in the address bar is still valid. Pass that full URL here as `callback_url`.'
  )
}

/**
 * Creates the second auth-stub pseudo-tool for a needs-auth MCP server:
 * completes an in-progress OAuth flow from a pasted callback URL. This is
 * the remote-session path — the browser redirect to `http://localhost:<port>`
 * fails to load there, but the address-bar URL still carries the valid
 * `?code=...&state=...`, which this tool feeds to the flow's registered
 * submitter and then awaits the token exchange.
 *
 * Official gating semantics (2.1.274): a wrong-state URL makes the submitter
 * return false and the flow KEEPS WAITING (the error message says so) — the
 * live flow is never killed by a stale paste.
 */
export function createMcpCompleteAuthTool(
  serverName: string,
  config: ScopedMcpServerConfig,
  resolveUnexpanded: UnexpandedScopeResolver = resolveUnexpandedMcpServers,
): Tool<InputSchema, McpCompleteAuthOutput> {
  const description = buildMcpCompleteAuthToolDescription(serverName)

  return {
    name: buildMcpToolName(serverName, MCP_COMPLETE_AUTH_TOOL_SUFFIX),
    isMcp: true,
    mcpInfo: { serverName, toolName: MCP_COMPLETE_AUTH_TOOL_SUFFIX },
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    toAutoClassifierInput: () => serverName,
    userFacingName: () => `${serverName} - complete authentication (MCP)`,
    maxResultSizeChars: 10_000,
    renderToolUseMessage: () =>
      `Complete authentication for ${serverName} MCP server`,
    async description() {
      return description
    },
    async prompt() {
      return description
    },
    get inputSchema(): InputSchema {
      return inputSchema()
    },
    async checkPermissions(input): Promise<PermissionDecision> {
      return { behavior: 'allow', updatedInput: input }
    },
    async call(input) {
      const { callback_url: callbackUrl } = input
      const displayName = sanitizeServerNameForDisplay(serverName)
      const authenticateToolName = buildMcpToolName(
        serverName,
        MCP_AUTH_TOOL_SUFFIX,
      )

      const submitter = getOAuthCallbackSubmitter(serverName)
      if (!submitter) {
        return {
          data: {
            status: 'error' as const,
            message: `No OAuth flow is in progress for ${displayName}. Call \`${authenticateToolName}\` first, then retry with the callback URL.`,
          },
        }
      }

      let hasCodeOrError = false
      try {
        const parsed = new URL(callbackUrl)
        hasCodeOrError =
          parsed.searchParams.has('code') || parsed.searchParams.has('error')
      } catch {
        // Unparseable URL — treated as "not a callback URL" below.
      }
      if (!hasCodeOrError) {
        return {
          data: {
            status: 'error' as const,
            message:
              'Invalid callback URL: missing authorization code. Ask the user to paste the full redirect URL from their browser\'s address bar, including the `?code=...&state=...` query string.',
          },
        }
      }

      const activeFlow = getActiveOAuthPromise(serverName)
      if (!submitter(callbackUrl)) {
        return {
          data: {
            status: 'error' as const,
            message: `That callback URL belongs to a different sign-in attempt for ${displayName} (its state does not match the flow in progress), or carries no authorization code. The current flow is still waiting: ask the user for the URL from the page this sign-in opened, then retry.`,
          },
        }
      }

      try {
        await activeFlow
        return {
          data: {
            status: 'success' as const,
            message: `Authentication complete for ${displayName}. ${TOOLS_NOW_AVAILABLE_SENTENCE}`,
          },
        }
      } catch (err) {
        if (err instanceof AuthenticationCancelledError) {
          return {
            data: {
              status: 'error' as const,
              message: `The OAuth flow for ${displayName} was cancelled (a newer attempt may have superseded it). Call \`${authenticateToolName}\` again to restart.`,
            },
          }
        }
        // Official `Xi(Cl(e,r,l(h)))` — redact config secrets from the error
        // detail, then run the display sanitizer (default max 200, redact on).
        return {
          data: {
            status: 'error' as const,
            message: `Authentication failed for ${displayName}: ${sanitizeForDisplay(
              redactMcpErrorDetail(
                serverName,
                config,
                errorMessage(err),
                resolveUnexpanded,
              ),
            )}`,
          },
        }
      }
    },
    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: data.message,
      }
    },
  } satisfies Tool<InputSchema, McpCompleteAuthOutput>
}
