import reject from 'lodash-es/reject.js'
import { z } from 'zod/v4'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  performMCPOAuthFlow,
  setActiveOAuthPromise,
} from '../../services/mcp/auth.js'
import {
  clearMcpAuthCache,
  reconnectMcpServerImpl,
} from '../../services/mcp/client.js'
import {
  isMcpServerAllowedByPolicy,
  isMcpServerDisabled,
} from '../../services/mcp/config.js'
import {
  sanitizeDisplayUrl,
  sanitizeForDisplay,
  sanitizeServerNameForDisplay,
} from '../../services/mcp/displaySanitize.js'
import {
  buildMcpToolName,
  getMcpPrefix,
} from '../../services/mcp/mcpStringUtils.js'
import {
  getMcpErrorEndpoint,
  redactMcpErrorDetail,
  type UnexpandedScopeResolver,
} from '../../services/mcp/redaction.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import {
  getProjectMcpServerStatus,
  resolveUnexpandedMcpServers,
} from '../../services/mcp/utils.js'
import type { Tool } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { createMcpCompleteAuthTool } from './McpCompleteAuthTool.js'
import {
  extractOAuthRedirectUri,
  isRemoteOAuthSession,
  MCP_AUTH_TOOL_SUFFIX,
  MCP_COMPLETE_AUTH_TOOL_SUFFIX,
  TOOLS_BECOME_AVAILABLE_TEXT,
  TOOLS_NOW_AVAILABLE_SENTENCE,
} from './mcpAuthStubShared.js'

const inputSchema = lazySchema(() => z.object({}))
type InputSchema = ReturnType<typeof inputSchema>

export type McpAuthOutput = {
  status: 'auth_url' | 'unsupported' | 'error'
  message: string
  authUrl?: string
}

// ---------------------------------------------------------------------------
// Official 2.1.274 gating helpers (live-binary verified; forensics in
// docs/upstream-version-gap-occ128.md)
// ---------------------------------------------------------------------------

/**
 * Binary `p` (chunk-m720bvaq): default anthropic-hosted local-OAuth
 * blocklist. The official reads it through statsig
 * (`tengu_mcp_local_oauth_blocked_hosts`, `{hosts: p}` default) — OCC's
 * analytics/statsig layer is a stub, so the default list is the constant
 * (documented divergence).
 */
const ANTHROPIC_HOSTED_OAUTH_BLOCKED_HOSTS = [
  'microsoft365.mcp.claude.com',
  'gmail.mcp.claude.com',
  'gcal.mcp.claude.com',
]

/** Binary `i(e)`: lowercase + trailing-dot strip. */
function normalizeHostnameForMatch(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '')
}

/** Binary `c(e)`: does this server URL point at an Anthropic-hosted MCP host? */
export function isAnthropicHostedMcpUrl(url: string | undefined): boolean {
  if (!url) {
    return false
  }
  try {
    const blocked = new Set(
      ANTHROPIC_HOSTED_OAUTH_BLOCKED_HOSTS.map(normalizeHostnameForMatch),
    )
    return blocked.has(normalizeHostnameForMatch(new URL(url).hostname))
  } catch {
    return false
  }
}

/** Binary `GW(e)`: shell-safe name gate for copy-pastable commands. */
const COMMAND_ARG_SAFE_PATTERN = /^\w[\w.@-]*$/

/**
 * Binary `hl("mcp remove", e)` adaptation. The official renders
 * `claude mcp remove <name>`; OCC's convention for user-facing
 * copy-pastable commands is the `occ` binary name (see src/services/auth.ts,
 * insights.ts, addCommand.ts). Same regex gate: unsafe names render nothing.
 */
function renderMcpRemoveCommand(serverName: string): string | null {
  if (!COMMAND_ARG_SAFE_PATTERN.test(serverName)) {
    return null
  }
  return `occ mcp remove ${serverName}`
}

/** Binary `a(e, {scope})`: anthropic-hosted unsupported message. */
export function buildAnthropicHostedMessage(
  serverName: string,
  scope: string | undefined,
): string {
  const base =
    `"${sanitizeServerNameForDisplay(serverName)}" is Anthropic-hosted and doesn't support local OAuth. ` +
    'Connect it via Settings → Connectors on claude.ai (requires ' +
    "`claude login`), then it'll be available here automatically."
  const removeCommand =
    scope === 'local' || scope === 'project' || scope === 'user'
      ? renderMcpRemoveCommand(serverName)
      : null
  if (!removeCommand) {
    return base
  }
  const withRemove = `${base} Remove the stale entry with: \`${removeCommand}\``
  // Official cap: only keep the remove hint when the whole message stays
  // within 1024 code points.
  return [...withRemove].length <= 1024 ? withRemove : base
}

/**
 * Binary `Gf(e,n)` classification, mapped onto OCC's existing policy
 * primitives (isMcpServerAllowedByPolicy = the official denylist/allowlist
 * `CK`/`SEe` chain; project approval = `Ien`'s project branch). Divergence:
 * the official also folds in browser-extension scope checks, auto-discovered
 * servers, and bypass-mode scope trust (`Q_`) — OCC does not ship those
 * subsystems (docs/upstream-version-gap-occ128.md).
 */
function classifyMcpServerAuthBlock(
  serverName: string,
  config: ScopedMcpServerConfig,
): 'managed-policy' | 'project-approval' | null {
  if (!isMcpServerAllowedByPolicy(serverName, config)) {
    return 'managed-policy'
  }
  if (
    config.scope === 'project' &&
    getProjectMcpServerStatus(serverName) !== 'approved'
  ) {
    return 'project-approval'
  }
  return null
}

/** Binary `zQt(e)`. */
function managedPolicyBlockMessage(serverName: string): string {
  return `"${sanitizeServerNameForDisplay(serverName)}" is blocked by your organization's managed policy — it can't be authenticated or reconnected here`
}

/** Binary `WQt(e)`. */
function projectApprovalBlockMessage(serverName: string): string {
  return `"${sanitizeServerNameForDisplay(serverName)}" is a project-scope MCP server (.mcp.json) that is not approved for this project — approve it via /mcp first, then authenticate or reconnect it`
}

/**
 * Binary `D(e,r,n)` @211336157 region (2.1.274): the auth-stub tool
 * description. CC 2.1.274 security fix — previously OCC embedded the raw
 * env-EXPANDED `config.url` here (`${transport} at ${url}`), leaking
 * post-expansion secrets (e.g. `https://user:token@host` from an authored
 * `https://user:${TOKEN}@host`) into model-visible tool descriptions. The
 * official fix derives the location from `getMcpErrorEndpoint(detail:
 * 'origin')` (the AUTHORED unexpanded string, never the expanded one) and
 * runs it through the `nPr(…,256)` display sanitizer; the server name goes
 * through `xr()` (NFKC + quote neutralization + 64-char cap).
 *
 * Divergence: the official also stamps `mcpInfo.serverType/source/isAuthStub`
 * — OCC's `Tool.mcpInfo` type only carries `{serverName, toolName}` and
 * nothing consumes the extra fields (documented in
 * docs/upstream-version-gap-occ127.md Part II).
 */
export function buildMcpAuthToolDescription(
  serverName: string,
  config: ScopedMcpServerConfig,
  resolveUnexpanded: UnexpandedScopeResolver = resolveUnexpandedMcpServers,
): string {
  const transport = config.type ?? 'stdio'
  const displayOrigin = getMcpErrorEndpoint(
    serverName,
    config,
    { detail: 'origin' },
    resolveUnexpanded,
  )
  const location =
    displayOrigin && displayOrigin !== transport
      ? `${transport} at ${sanitizeDisplayUrl(displayOrigin, 256)}`
      : transport
  return (
    `The "${sanitizeServerNameForDisplay(serverName)}" MCP server (${location}) is installed but requires authentication. ` +
    `Call this tool to start the OAuth flow — you'll receive an authorization URL to share with the user. ` +
    `Once the user completes authorization in their browser, the server's real tools will become ${TOOLS_BECOME_AVAILABLE_TEXT}.`
  )
}

/**
 * Creates a pseudo-tool for an MCP server that is installed but not
 * authenticated. Surfaced in place of the server's real tools so the model
 * knows the server exists and can start the OAuth flow on the user's behalf.
 *
 * When called, starts performMCPOAuthFlow with skipBrowserOpen and returns
 * the authorization URL. The OAuth callback completes in the background;
 * once it fires, reconnectMcpServerImpl runs and the server's real tools
 * are swapped into appState.mcp.tools via the existing prefix-based
 * replacement (useManageMCPConnections.updateServer wipes anything matching
 * mcp__<server>__*, so this pseudo-tool is removed automatically).
 *
 * CC 2.1.274: call() now mirrors the official `D.call()` gating order —
 * managed-policy → disabled → project-approval → transport classifier
 * (claudeai-proxy / unsupported-transport / anthropic-hosted) → OAuth start
 * with setActiveOAuthPromise registration — and the auth_url message carries
 * the callback-paste guidance pointing at the sibling
 * `mcp__<server>__complete_authentication` tool (remote/local variants).
 */
export function createMcpAuthTool(
  serverName: string,
  config: ScopedMcpServerConfig,
  resolveUnexpanded: UnexpandedScopeResolver = resolveUnexpandedMcpServers,
): Tool<InputSchema, McpAuthOutput> {
  const transport = config.type ?? 'stdio'
  const description = buildMcpAuthToolDescription(
    serverName,
    config,
    resolveUnexpanded,
  )

  return {
    name: buildMcpToolName(serverName, MCP_AUTH_TOOL_SUFFIX),
    isMcp: true,
    mcpInfo: { serverName, toolName: MCP_AUTH_TOOL_SUFFIX },
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    toAutoClassifierInput: () => serverName,
    userFacingName: () => `${serverName} - authenticate (MCP)`,
    maxResultSizeChars: 10_000,
    renderToolUseMessage: () => `Authenticate ${serverName} MCP server`,
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
    async call(_input, context) {
      const displayName = sanitizeServerNameForDisplay(serverName)

      // Official gating order (binary `Gf`/`ts`/`ID` chain inside `D.call`).
      const policyBlock = classifyMcpServerAuthBlock(serverName, config)
      if (policyBlock === 'managed-policy') {
        return {
          data: {
            status: 'error' as const,
            message: `${managedPolicyBlockMessage(serverName)}. Only an organization admin can change this; do not retry or ask the user to enable it.`,
          },
        }
      }
      if (isMcpServerDisabled(serverName)) {
        return {
          data: {
            status: 'error' as const,
            message: `MCP server ${displayName} is disabled. Ask the user to enable it in /mcp before authenticating.`,
          },
        }
      }
      if (policyBlock === 'project-approval') {
        return {
          data: {
            status: 'error' as const,
            message: `${projectApprovalBlockMessage(serverName)}. Ask the user to approve it; do not retry until they have.`,
          },
        }
      }

      // claude.ai connectors use a separate auth flow (handleClaudeAIAuth in
      // MCPRemoteServerMenu) that we don't invoke programmatically here —
      // just point the user at /mcp.
      if (config.type === 'claudeai-proxy') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `This is a claude.ai MCP connector. Ask the user to run /mcp and select "${displayName}" to authenticate.`,
          },
        }
      }

      // performMCPOAuthFlow only accepts sse/http. needs-auth state is only
      // set on HTTP 401 (UnauthorizedError) so other transports shouldn't
      // reach here, but be defensive.
      if (config.type !== 'sse' && config.type !== 'http') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `Server "${displayName}" uses ${transport} transport which does not support OAuth from this tool. Ask the user to run /mcp and authenticate manually.`,
          },
        }
      }

      // Anthropic-hosted connector URLs cannot do local OAuth at all.
      if (isAnthropicHostedMcpUrl(config.url)) {
        return {
          data: {
            status: 'unsupported' as const,
            message: sanitizeForDisplay(
              buildAnthropicHostedMessage(serverName, config.scope),
              1024,
              'none',
            ),
          },
        }
      }

      const sseOrHttpConfig = config as (
        | McpSSEServerConfig
        | McpHTTPServerConfig
      ) & { scope: ScopedMcpServerConfig['scope'] }

      // Mirror the official `D.call()`: start the flow with no abort signal,
      // capture the URL via onAuthorizationUrl, register the flow promise so
      // `mcp__<server>__complete_authentication` can await token exchange.
      let resolveAuthUrl: ((url: string) => void) | undefined
      const authUrlPromise = new Promise<string>(resolve => {
        resolveAuthUrl = resolve
      })

      const { setAppState } = context

      const oauthPromise = performMCPOAuthFlow(
        serverName,
        sseOrHttpConfig,
        u => resolveAuthUrl?.(u),
        undefined,
        { skipBrowserOpen: true },
      )
      setActiveOAuthPromise(serverName, oauthPromise)

      // Background continuation: once OAuth completes, reconnect and swap
      // the real tools into appState. Prefix-based replacement removes this
      // pseudo-tool since it shares the mcp__<server>__ prefix.
      //
      // Divergences from the official continuation (documented in
      // docs/upstream-version-gap-occ128.md): no identity-epoch (`yr()`)
      // guards and no mcpSessionWiring/adoptServer/orphan clearServerCache
      // dance — OCC keeps its prefix-replacement setAppState swap, plus the
      // official's post-auth disabled/policy recheck.
      void oauthPromise
        .then(async () => {
          clearMcpAuthCache()
          if (
            isMcpServerDisabled(serverName) ||
            !isMcpServerAllowedByPolicy(serverName, config)
          ) {
            logMCPDebug(
              serverName,
              'OAuth completed but the server is now disabled or policy-blocked; not reconnecting',
            )
            return
          }
          const result = await reconnectMcpServerImpl(serverName, config)
          const prefix = getMcpPrefix(serverName)
          setAppState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.map(c =>
                c.name === serverName ? result.client : c,
              ),
              tools: [
                ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                ...result.tools,
              ],
              commands: [
                ...reject(prev.mcp.commands, c => c.name?.startsWith(prefix)),
                ...result.commands,
              ],
              resources: result.resources
                ? { ...prev.mcp.resources, [serverName]: result.resources }
                : prev.mcp.resources,
            },
          }))
          logMCPDebug(
            serverName,
            `OAuth complete, reconnected with ${result.tools.length} tool(s)`,
          )
        })
        .catch(err => {
          // Official `ao(e, \`OAuth flow failed after tool-triggered start:
          // ${lg(Cl(e,r,l(s)))}\`)` — lg = sanitizeForDisplay(…, 2000).
          logMCPError(
            serverName,
            `OAuth flow failed after tool-triggered start: ${sanitizeForDisplay(
              redactMcpErrorDetail(
                serverName,
                config,
                errorMessage(err),
                resolveUnexpanded,
              ),
              2000,
            )}`,
          )
        })

      try {
        // Race: get the URL, or the flow completes without needing one
        // (e.g. XAA with cached IdP token — silent auth).
        const authUrl = await Promise.race([
          authUrlPromise,
          oauthPromise.then(() => null as string | null),
        ])

        if (authUrl) {
          const completeAuthToolName = buildMcpToolName(
            serverName,
            MCP_COMPLETE_AUTH_TOOL_SUFFIX,
          )
          const redirectUri = extractOAuthRedirectUri(authUrl)
          // Official `b` guidance — template literals verified byte-exact
          // against the live 2.1.274 binary (both variants start with TWO
          // newlines; the remote variant embeds the redirect_uri).
          const callbackGuidance = isRemoteOAuthSession()
            ? `\n\nThis session is remote, so after authorizing the browser will try to load \`${redirectUri}?code=...\` and show a connection error — that's expected. Ask the user to copy the full URL from the browser's address bar and paste it into chat, then call \`${completeAuthToolName}\` with that URL as \`callback_url\`.`
            : `\n\nIf the browser shows a connection error on the redirect page, ask the user to paste the full URL from the address bar and call \`${completeAuthToolName}\` with it.`
          return {
            data: {
              status: 'auth_url' as const,
              authUrl,
              message: `Ask the user to open this URL in their browser to authorize the ${displayName} MCP server:\n\n${authUrl}\n\nOnce they complete the flow, the server's tools will become ${TOOLS_BECOME_AVAILABLE_TEXT}.${callbackGuidance}`,
            },
          }
        }

        return {
          data: {
            status: 'auth_url' as const,
            message: `Authentication completed silently for ${displayName}. ${TOOLS_NOW_AVAILABLE_SENTENCE}`,
          },
        }
      } catch (err) {
        // Official `Xi(Cl(e,r,l(s)))` — redact config secrets, then display-
        // sanitize (default max 200).
        const failureDetail = sanitizeForDisplay(
          redactMcpErrorDetail(
            serverName,
            config,
            errorMessage(err),
            resolveUnexpanded,
          ),
        )
        return {
          data: {
            status: 'error' as const,
            message: `Failed to start OAuth flow for ${displayName}: ${failureDetail}. Ask the user to run /mcp and authenticate manually.`,
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
  } satisfies Tool<InputSchema, McpAuthOutput>
}

/**
 * Binary `Qx(e,r)`: the auth-stub factory. The official registers BOTH stub
 * tools for a needs-auth server, and registers NONE in non-interactive
 * sessions (`Te(){return!n().host.launchOptions.isInteractive()}`; OCC
 * equivalent: getIsNonInteractiveSession()). Pre-274 OCC registered only the
 * authenticate stub, unconditionally — `mcp__<server>__complete_authentication`
 * was missing entirely and `-p` mode advertised stubs the official hides
 * (docs/upstream-version-gap-occ128.md).
 */
export function createMcpAuthStubTools(
  serverName: string,
  config: ScopedMcpServerConfig,
  resolveUnexpanded: UnexpandedScopeResolver = resolveUnexpandedMcpServers,
): Tool[] {
  if (getIsNonInteractiveSession()) {
    return []
  }
  return [
    createMcpAuthTool(serverName, config, resolveUnexpanded),
    createMcpCompleteAuthTool(serverName, config, resolveUnexpanded),
  ]
}
