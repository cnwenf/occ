import type { Attributes } from '@opentelemetry/api'
import { getSessionId } from 'src/bootstrap/state.js'
import { getOauthAccountInfo } from './auth.js'
import { getOrCreateUserID } from './config.js'
import { envDynamic } from './envDynamic.js'
import { isEnvTruthy } from './envUtils.js'
import { toTaggedId } from './taggedId.js'

// Default configuration for metrics cardinality
const METRICS_CARDINALITY_DEFAULTS = {
  OTEL_METRICS_INCLUDE_SESSION_ID: true,
  OTEL_METRICS_INCLUDE_VERSION: false,
  OTEL_METRICS_INCLUDE_ACCOUNT_UUID: true,
  OTEL_METRICS_INCLUDE_ENTRYPOINT: false,
}

// Known entrypoint identifiers (mirrors the official 2.1.200 valid set).
// CLAUDE_CODE_ENTRYPOINT is only surfaced as app.entrypoint when it appears
// in this set, so unknown values do not leak into metrics cardinality.
const VALID_ENTRYPOINTS = new Set([
  'cli',
  'mcp',
  'sdk-cli',
  'sdk-ts',
  'sdk-py',
  'bench',
  'claude-vscode',
  'claude-code-github-action',
  'local-agent',
  'local_agent',
  'claude-desktop',
  'remote',
  'remote_baku',
  'remote_cowork',
  'remote_trigger',
  'remote_desktop',
  'remote_mobile',
  'claude_in_slack',
  'claude-in-slack',
  'claude-in-teams',
  'claude-desktop-3p',
  'claude-security',
  'ssh-remote',
])

// Returns the entrypoint name from CLAUDE_CODE_ENTRYPOINT when it is a known
// value, otherwise undefined. Used for the app.entrypoint metric attribute.
export function getEntrypointName(): string | undefined {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  return entrypoint && VALID_ENTRYPOINTS.has(entrypoint) ? entrypoint : undefined
}

function shouldIncludeAttribute(
  envVar: keyof typeof METRICS_CARDINALITY_DEFAULTS,
): boolean {
  const defaultValue = METRICS_CARDINALITY_DEFAULTS[envVar]
  const envValue = process.env[envVar]

  if (envValue === undefined) {
    return defaultValue
  }

  return isEnvTruthy(envValue)
}

export function getTelemetryAttributes(): Attributes {
  const userId = getOrCreateUserID()
  const sessionId = getSessionId()

  const attributes: Attributes = {
    'user.id': userId,
  }

  if (shouldIncludeAttribute('OTEL_METRICS_INCLUDE_SESSION_ID')) {
    attributes['session.id'] = sessionId
  }
  if (shouldIncludeAttribute('OTEL_METRICS_INCLUDE_VERSION')) {
    attributes['app.version'] = MACRO.VERSION
  }
  if (shouldIncludeAttribute('OTEL_METRICS_INCLUDE_ENTRYPOINT')) {
    const entrypoint = getEntrypointName()
    if (entrypoint) {
      attributes['app.entrypoint'] = entrypoint
    }
  }

  // Only include OAuth account data when actively using OAuth authentication
  const oauthAccount = getOauthAccountInfo()
  if (oauthAccount) {
    const orgId = oauthAccount.organizationUuid
    const email = oauthAccount.emailAddress
    const accountUuid = oauthAccount.accountUuid

    if (orgId) attributes['organization.id'] = orgId
    if (email) attributes['user.email'] = email

    if (
      accountUuid &&
      shouldIncludeAttribute('OTEL_METRICS_INCLUDE_ACCOUNT_UUID')
    ) {
      attributes['user.account_uuid'] = accountUuid
      attributes['user.account_id'] =
        process.env.CLAUDE_CODE_ACCOUNT_TAGGED_ID ||
        toTaggedId('user', accountUuid)
    }
  }

  // Add terminal type if available
  if (envDynamic.terminal) {
    attributes['terminal.type'] = envDynamic.terminal
  }

  return attributes
}
