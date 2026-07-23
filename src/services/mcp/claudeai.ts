import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import { getOauthConfig } from 'src/constants/oauth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getClaudeAIOAuthTokens } from 'src/utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvDefinedFalsy } from 'src/utils/envUtils.js'
import { clearMcpAuthCache } from './client.js'
import { normalizeNameForMCP } from './normalization.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from './types.js'

type ClaudeAIMcpServer = {
  type: 'mcp_server'
  id: string
  display_name: string
  url: string
  created_at: string
}

type ClaudeAIMcpServersResponse = {
  data: ClaudeAIMcpServer[]
  has_more: boolean
  next_page: string | null
}

const FETCH_TIMEOUT_MS = 5000
const MCP_SERVERS_BETA_HEADER = 'mcp-servers-2025-12-04'

/**
 * Fetches MCP server configurations from Claude.ai org configs.
 * These servers are managed by the organization via Claude.ai.
 *
 * Results are memoized for the session lifetime (fetch once per CLI session).
 */
export const fetchClaudeAIMcpConfigsIfEligible = memoize(
  async (): Promise<Record<string, ScopedMcpServerConfig>> => {
    try {
      if (isEnvDefinedFalsy(process.env.ENABLE_CLAUDEAI_MCP_SERVERS)) {
        logForDebugging('[claudeai-mcp] Disabled via env var')
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'disabled_env_var' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      const tokens = getClaudeAIOAuthTokens()
      if (!tokens?.accessToken) {
        logForDebugging('[claudeai-mcp] No access token')
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'no_oauth_token' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      // Check for user:mcp_servers scope directly instead of isClaudeAISubscriber().
      // In non-interactive mode, isClaudeAISubscriber() returns false when ANTHROPIC_API_KEY
      // is set (even with valid OAuth tokens) because preferThirdPartyAuthentication() causes
      // isAnthropicAuthEnabled() to return false. Checking the scope directly allows users
      // with both API keys and OAuth tokens to access claude.ai MCPs in print mode.
      if (!tokens.scopes?.includes('user:mcp_servers')) {
        logForDebugging(
          `[claudeai-mcp] Missing user:mcp_servers scope (scopes=${tokens.scopes?.join(',') || 'none'})`,
        )
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'missing_scope' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      const baseUrl = getOauthConfig().BASE_API_URL
      const url = `${baseUrl}/v1/mcp_servers?limit=1000`

      logForDebugging(`[claudeai-mcp] Fetching from ${url}`)

      const response = await axios.get<ClaudeAIMcpServersResponse>(url, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json',
          'anthropic-beta': MCP_SERVERS_BETA_HEADER,
          'anthropic-version': '2023-06-01',
        },
        timeout: FETCH_TIMEOUT_MS,
      })

      const configs: Record<string, ScopedMcpServerConfig> = {}
      // Track used normalized names to detect collisions and assign (2), (3), etc. suffixes.
      // We check the final normalized name (including suffix) to handle edge cases where
      // a suffixed name collides with another server's base name (e.g., "Example Server 2"
      // colliding with "Example Server! (2)" which both normalize to claude_ai_Example_Server_2).
      const usedNormalizedNames = new Set<string>()

      for (const server of response.data.data) {
        const baseName = `claude.ai ${server.display_name}`

        // Try without suffix first, then increment until we find an unused normalized name
        let finalName = baseName
        let finalNormalized = normalizeNameForMCP(finalName)
        let count = 1
        while (usedNormalizedNames.has(finalNormalized)) {
          count++
          finalName = `${baseName} (${count})`
          finalNormalized = normalizeNameForMCP(finalName)
        }
        usedNormalizedNames.add(finalNormalized)

        configs[finalName] = {
          type: 'claudeai-proxy',
          url: server.url,
          id: server.id,
          scope: 'claudeai',
          // CC 2.1.218 #20: a connector returned by the org-config fetch is
          // eligible to connect (the account has access). Populated here so
          // `shouldCountClaudeAiNeedsAuth` reads a real boolean instead of
          // `undefined`; the `eligible === false` exclusion then fires for
          // connectors explicitly marked ineligible (e.g. an account that lost
          // access to an org-configured server), excluding them from the
          // needs-auth count when they are not currently connected.
          eligible: true,
        }
      }

      logForDebugging(
        `[claudeai-mcp] Fetched ${Object.keys(configs).length} servers`,
      )
      logEvent('tengu_claudeai_mcp_eligibility', {
        state:
          'eligible' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return configs
    } catch {
      logForDebugging(`[claudeai-mcp] Fetch failed`)
      return {}
    }
  },
)

/**
 * Clears the memoized cache for fetchClaudeAIMcpConfigsIfEligible.
 * Call this after login so the next fetch will use the new auth tokens.
 */
export function clearClaudeAIMcpConfigsCache(): void {
  fetchClaudeAIMcpConfigsIfEligible.cache.clear?.()
  // Also clear the auth cache so freshly-authorized servers get re-connected
  clearMcpAuthCache()
}

/**
 * Record that a claude.ai connector successfully connected. Idempotent.
 *
 * Gates the "N connectors unavailable/need auth" startup notifications: a
 * connector that was working yesterday and is now failed is a state change
 * worth surfacing; an org-configured connector that's been needs-auth since
 * it showed up is one the user has demonstrably ignored.
 */
export function markClaudeAiMcpConnected(name: string): void {
  saveGlobalConfig(current => {
    const seen = current.claudeAiMcpEverConnected ?? []
    if (seen.includes(name)) return current
    return { ...current, claudeAiMcpEverConnected: [...seen, name] }
  })
}

export function hasClaudeAiMcpEverConnected(name: string): boolean {
  return (getGlobalConfig().claudeAiMcpEverConnected ?? []).includes(name)
}

/**
 * CC 2.1.218 #20: session-scoped set of claude.ai connectors that are
 * currently connected (the binary's `Pgs`). Populated by
 * {@link markClaudeAiMcpConnected} (mirrors `Vsr`), which adds to both this
 * set and the persistent `claudeAiMcpEverConnected` list.
 *
 * The "N MCP servers need authentication" startup notice must NOT count a
 * claude.ai connector that is `eligible === false` AND not currently
 * connected — `zsr(name) = Pgs.has(name)` is the second operand of the
 * binary's `H7o` exclusion.
 */
const currentlyConnectedClaudeAiMcps = new Set<string>()

/**
 * Record that a claude.ai connector successfully connected. Idempotent.
 *
 * Gates the "N connectors unavailable/need auth" startup notifications: a
 * connector that was working yesterday and is now failed is a state change
 * worth surfacing; an org-configured connector that's been needs-auth since
 * it showed up is one the user has demonstrably ignored.
 *
 * CC 2.1.218 #20: also adds to the session currently-connected set (`Pgs`)
 * so the needs-auth count excludes only the connectors that are both
 * ineligible and not connected right now.
 */
export function markClaudeAiMcpConnected(name: string): void {
  currentlyConnectedClaudeAiMcps.add(name)
  saveGlobalConfig(current => {
    const seen = current.claudeAiMcpEverConnected ?? []
    if (seen.includes(name)) return current
    return { ...current, claudeAiMcpEverConnected: [...seen, name] }
  })
}

/** CC 2.1.218 #20: `zsr(name)` — is the connector currently connected (`Pgs.has`). */
export function isClaudeAiMcpCurrentlyConnected(name: string): boolean {
  return currentlyConnectedClaudeAiMcps.has(name)
}

/** CC 2.1.218 #20: clear the session currently-connected set (`Pgs.clear`). */
export function clearClaudeAiMcpCurrentlyConnected(): void {
  currentlyConnectedClaudeAiMcps.clear()
}

/**
 * CC 2.1.218 #20: should a `needs-auth` claude.ai connector be counted in the
 * "N MCP servers need authentication" startup notice? Mirrors the binary's
 * `H7o` claude.ai branch:
 *   if (e.config.eligible === false && !r(e.name)) return false;  // exclude
 *   return t(e.name);                                            // count iff ever connected
 * where `r` = `zsr` (currently connected) and `t` = `Ksr` (ever connected).
 */
function shouldCountClaudeAiNeedsAuth(client: MCPServerConnection): boolean {
  if (client.config.type !== 'claudeai-proxy') return false
  const eligible = (client.config as { eligible?: boolean }).eligible
  if (eligible === false && !isClaudeAiMcpCurrentlyConnected(client.name)) {
    return false
  }
  return hasClaudeAiMcpEverConnected(client.name)
}

/**
 * CC 2.1.218 #20: count needs-auth MCP servers for the startup notice,
 * excluding claude.ai connectors that aren't connected. Mirrors the binary's
 * `Zka(clients, Ksr, zsr)`:
 *   clients.filter(n => n.type === "needs-auth" && H7o(n, Ksr, zsr))
 * where `H7o` excludes `wee` (failed+UNCONFIGURED — never true for needs-auth),
 * excludes claude.ai connectors with `eligible===false && !currentlyConnected`,
 * counts claude.ai connectors iff ever connected, and counts all non-IDE local
 * servers.
 */
export function getMcpNeedsAuthCount(
  clients: readonly MCPServerConnection[],
): number {
  return clients.filter(client => {
    if (client.type !== 'needs-auth') return false
    if (client.config.type === 'claudeai-proxy') {
      return shouldCountClaudeAiNeedsAuth(client)
    }
    // Local (non-claude.ai) needs-auth servers are always counted, except IDE
    // internals (sse-ide / ws-ide) which are never surfaced to the user.
    return (
      client.config.type !== 'sse-ide' && client.config.type !== 'ws-ide'
    )
  }).length
}

/**
 * Test-only: reset the persistent `claudeAiMcpEverConnected` list so unit
 * tests can assert the #20 counting filter in isolation. Not exported to
 * production callers.
 */
export function resetClaudeAiEverConnectedForTest(): void {
  saveGlobalConfig(current => ({
    ...current,
    claudeAiMcpEverConnected: [],
  }))
}
