/**
 * Gateway model discovery — list models published by a custom Anthropic-base-URL
 * gateway (`/v1/models`) in the `/model` picker.
 *
 * Matches the official 2.1.200 binary (claude.strings):
 *   - `pyi()` gate: `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` truthy AND
 *     firstParty AND `ANTHROPIC_BASE_URL` set.
 *   - `myi()` cache: `<configHome>/cache/gateway-models.json` with shape
 *     `{ baseUrl, models: [{ id, display_name }] }`.
 *   - `oIn()` read: validate `e.baseUrl === ANTHROPIC_BASE_URL`, map to
 *     `{ value: id, label: display_name ?? id, description: "From gateway" }`.
 *   - fetch: `${base}/v1/models?limit=1000` with `x-api-key`/`Bearer` +
 *     `anthropic-version: 2023-06-01`, filter `^(claude|anthropic)` ids.
 */
import { existsSync, readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { getAnthropicApiKey } from '../auth.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { jsonStringify } from '../slowOperations.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { getAPIProvider } from './providers.js'
import type { ModelOption } from './modelOptions.js'

const GatewayModelSchema = z.object({
  id: z.string(),
  display_name: z.string().optional(),
})

const GatewayModelsResponseSchema = z.object({
  data: z.array(GatewayModelSchema),
})

const GatewayCacheSchema = z.object({
  baseUrl: z.string(),
  models: z.array(GatewayModelSchema),
})

type GatewayCache = z.infer<typeof GatewayCacheSchema>

function getCacheDir(): string {
  return join(getClaudeConfigHomeDir(), 'cache')
}

/** Path to the gateway-models cache file (binary `myi()`). */
export function getGatewayModelsCachePath(): string {
  return join(getCacheDir(), 'gateway-models.json')
}

/**
 * Whether gateway model discovery is enabled (binary `pyi()`).
 *
 * Requires the explicit env opt-in, a first-party provider, and a custom
 * `ANTHROPIC_BASE_URL` (the gateway). Skipped for non-essential traffic.
 */
export function isGatewayModelDiscoveryEnabled(): boolean {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY)) {
    return false
  }
  if (getAPIProvider() !== 'firstParty') {
    return false
  }
  if (!process.env.ANTHROPIC_BASE_URL) {
    return false
  }
  if (isEssentialTrafficOnly()) {
    return false
  }
  return true
}

/**
 * Read cached gateway model options for the picker (binary `oIn()`).
 *
 * Returns `[]` when discovery is disabled, the cache is missing, or the cached
 * `baseUrl` no longer matches the current `ANTHROPIC_BASE_URL` (stale cache
 * from a different gateway).
 */
export function readGatewayModelOptions(): ModelOption[] {
  if (!isGatewayModelDiscoveryEnabled()) {
    return []
  }
  let raw: string
  try {
    raw = readFileSync(getGatewayModelsCachePath(), 'utf-8')
  } catch {
    return []
  }
  const parsed = GatewayCacheSchema.safeParse(safeParseJSON(raw, false))
  if (!parsed.success) {
    return []
  }
  const cache: GatewayCache = parsed.data
  if (cache.baseUrl !== process.env.ANTHROPIC_BASE_URL) {
    return []
  }
  return cache.models
    .filter(m => /^(claude|anthropic)/i.test(m.id))
    .map(m => ({
      value: m.id,
      label: m.display_name ?? m.id,
      description: 'From gateway',
    }))
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  }
  const apiKey = getAnthropicApiKey()
  if (apiKey) {
    headers['x-api-key'] = apiKey
  }
  return headers
}

/**
 * Fetch the gateway's `/v1/models` and persist the result to the cache file.
 *
 * Called during bootstrap so the `/model` picker can read the list
 * synchronously via `readGatewayModelOptions`. No-ops (returns []) when
 * discovery is disabled. Failures are logged and do not throw.
 */
export async function fetchAndCacheGatewayModels(): Promise<void> {
  if (!isGatewayModelDiscoveryEnabled()) {
    return
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL!.replace(/\/+$/, '')
  const url = `${baseUrl}/v1/models?limit=1000`
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      logForDebugging(
        `[Bootstrap] Gateway /v1/models fetch failed: HTTP ${response.status}`,
      )
      return
    }
    const json = safeParseJSON(await response.text(), false)
    const parsed = GatewayModelsResponseSchema.safeParse(json)
    if (!parsed.success) {
      logForDebugging(
        `[Bootstrap] Gateway /v1/models failed validation: ${parsed.error.message}`,
      )
      return
    }
    const models = parsed.data.data.filter(m =>
      /^(claude|anthropic)/i.test(m.id),
    )
    const cache: GatewayCache = {
      baseUrl: process.env.ANTHROPIC_BASE_URL!,
      models,
    }
    await mkdir(getCacheDir(), { recursive: true })
    await writeFile(
      getGatewayModelsCachePath(),
      jsonStringify(cache),
      { encoding: 'utf-8', mode: 0o600 },
    )
    logForDebugging(
      `[Bootstrap] Gateway /v1/models → ${models.length} custom options`,
    )
  } catch (error) {
    logForDebugging(
      `[Bootstrap] Gateway /v1/models fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}

/** Test-only: whether a cache file currently exists (used by e2e/source checks). */
export function gatewayModelsCacheExists(): boolean {
  return existsSync(getGatewayModelsCachePath())
}
