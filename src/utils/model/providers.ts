import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { getAWSRegion, isEnvTruthy } from '../envUtils.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'anthropic_aws'
  | 'mantle'
  | 'gateway'

export function getAPIProvider(): APIProvider {
  // Match the official 2.1.200 binary selection order exactly:
  //   CLAUDE_CODE_USE_BEDROCK       -> "bedrock"
  //   CLAUDE_CODE_USE_FOUNDRY       -> "foundry"
  //   CLAUDE_CODE_USE_ANTHROPIC_AWS -> "anthropicAws"   (2.1.198: Claude Platform on AWS)
  //   CLAUDE_CODE_USE_MANTLE        -> "mantle"          (2.1.94: Bedrock Mantle)
  //   CLAUDE_CODE_USE_VERTEX        -> "vertex"
  //   default                       -> "firstParty"
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
      ? 'foundry'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS)
        ? 'anthropic_aws'
        : isEnvTruthy(process.env.CLAUDE_CODE_USE_MANTLE)
          ? 'mantle'
          : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
            ? 'vertex'
            : 'firstParty'
}

/**
 * 2.1.94 (A15): Bedrock Mantle (`CLAUDE_CODE_USE_MANTLE`).
 *
 * Mantle is an Anthropic-operated Bedrock-derived offering routed through
 * `https://bedrock-mantle.<region>.api.aws`. When a user sets BOTH
 * `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_MANTLE`, the binary promotes
 * the effective provider from "bedrock" to "mantle" (mantle wins). This mirrors
 * the binary's promotion helper:
 *   `if (fr() === "bedrock" && it(CLAUDE_CODE_USE_MANTLE)) return "mantle"`
 *
 * Binary references (claude.strings):
 *   - `it(process.env.CLAUDE_CODE_USE_MANTLE)?"mantle"`
 *   - `CLAUDE_CODE_SKIP_MANTLE_AUTH`, `CLAUDE_CODE_MANTLE_BASE_URL`
 *   - `https://bedrock-mantle.${region}.api.aws`, `bedrock-mantle`,
 *     `mantle-fallback`, `tengu_mantle_default_check`
 */
export function isMantleProvider(): boolean {
  return getAPIProvider() === 'mantle'
}

/**
 * The effective provider, applying the bedrock→mantle promotion when both
 * `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_MANTLE` are set. Matches the
 * binary's promotion helper (fr()==="bedrock" && CLAUDE_CODE_USE_MANTLE => "mantle").
 */
export function getEffectiveAPIProvider(): APIProvider {
  const provider = getAPIProvider()
  if (provider === 'bedrock' && isEnvTruthy(process.env.CLAUDE_CODE_USE_MANTLE)) {
    return 'mantle'
  }
  return provider
}

/**
 * Whether auth is skipped for Bedrock Mantle (CLAUDE_CODE_SKIP_MANTLE_AUTH).
 */
export function isSkipMantleAuth(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_SKIP_MANTLE_AUTH)
}

/**
 * Default base URL for Bedrock Mantle, derived from the AWS region.
 * Mirrors the binary's `https://bedrock-mantle.${region}.api.aws`.
 */
export function getMantleBaseURL(): string {
  return (
    process.env.CLAUDE_CODE_MANTLE_BASE_URL ||
    `https://bedrock-mantle.${getAWSRegion()}.api.aws`
  )
}

/**
 * 2.1.198 (A12): Claude Platform on AWS (`anthropicAws` / `anthropic_aws`).
 * Anthropic-operated AWS offering with same-day API parity. Uses bare
 * first-party model IDs (NOT the `anthropic.` Bedrock prefix). The standard
 * Anthropic SDK client is used against an AWS endpoint, authenticated via
 * `ANTHROPIC_AWS_API_KEY` (or desktop-app-managed credentials), with an
 * optional workspace header.
 *
 * Binary references (claude.strings):
 *   - `it(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS)?"anthropicAws"`
 *   - baseURL: `process.env.ANTHROPIC_AWS_BASE_URL||\`https://aws-external-anthropic.${O4e()}.api.aws\``
 *   - "Claude Platform on AWS auth skipped" (CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH)
 *   - auth failover: 403 / CredentialsProviderError are retryable for anthropicAws
 */
export function isAnthropicAwsProvider(): boolean {
  return getAPIProvider() === 'anthropic_aws'
}

/**
 * Default base URL for Claude Platform on AWS, derived from the AWS region.
 * Mirrors the binary's `https://aws-external-anthropic.${region}.api.aws`.
 */
export function getAnthropicAwsBaseURL(): string {
  return (
    process.env.ANTHROPIC_AWS_BASE_URL ||
    `https://aws-external-anthropic.${getAWSRegion()}.api.aws`
  )
}

/**
 * Whether auth is skipped for Claude Platform on AWS
 * (CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH).
 */
export function isSkipAnthropicAwsAuth(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH)
}

/**
 * Workspace header value for Claude Platform on AWS
 * (ANTHROPIC_AWS_WORKSPACE_ID), sent as `anthropic-workspace-id`.
 */
export function getAnthropicAwsWorkspaceId(): string | undefined {
  return process.env.ANTHROPIC_AWS_WORKSPACE_ID
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
