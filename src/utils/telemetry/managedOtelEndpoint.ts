import { getSettingsForSource } from '../settings/settings.js'
import type { SettingSource } from '../settings/constants.js'

/**
 * CC 2.1.217 #9: "Fixed managed settings that set
 * `OTEL_EXPORTER_OTLP_ENDPOINT` not governing all signals — lower-scope
 * signal-specific overrides no longer redirect telemetry away from the
 * managed endpoint."
 *
 * The OpenTelemetry SDK resolves a per-signal OTLP endpoint by consulting
 * the signal-specific env var (`OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT`)
 * first and falling back to the generic `OTEL_EXPORTER_OTLP_ENDPOINT`. A
 * signal-specific value therefore WINS over the generic one — even when the
 * generic value was set at the highest-trust (managed/policy) scope and the
 * signal-specific value came from a lower-scope source (user settings, the
 * spawn env, etc.). That let a lower-scope per-signal override silently
 * redirect one signal's telemetry away from the managed collector.
 *
 * `governManagedOtelEndpoint` restores managed scope precedence: when the
 * managed (policySettings) env sets `OTEL_EXPORTER_OTLP_ENDPOINT`, any
 * lower-scope signal-specific endpoint is stripped so the OTel SDK falls
 * back to the managed generic endpoint for that signal. A signal-specific
 * endpoint that is ITSELF set at managed scope is preserved — it is an
 * intentional managed override, not a lower-scope redirect.
 *
 * This is a pure seam (no `process.env` mutation) so it can be tested with
 * injected env objects and no network. `applyManagedOtelEndpointGovernance`
 * is the thin process.env mutator wired into the telemetry bootstrap path.
 */

const SIGNAL_ENDPOINT_VARS = [
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const

const GENERIC_ENDPOINT_VAR = 'OTEL_EXPORTER_OTLP_ENDPOINT'

/**
 * Return a new env object with lower-scope signal-specific OTLP endpoints
 * suppressed when the managed (policy) env sets the generic endpoint.
 *
 * @param env       The resolved process.env snapshot (any scope).
 * @param policyEnv The managed/policy env slice (highest-trust scope).
 * @returns A new env object; the input is never mutated.
 */
export function governManagedOtelEndpoint(
  env: Record<string, string | undefined>,
  policyEnv: Record<string, string | undefined> | null | undefined,
): Record<string, string | undefined> {
  const managedGenericEndpoint = policyEnv?.[GENERIC_ENDPOINT_VAR]
  if (!managedGenericEndpoint) {
    // No managed generic endpoint — nothing to govern; per-signal endpoints
    // continue to apply per-signal as before.
    return { ...env }
  }

  // Managed generic endpoint is set. Strip lower-scope signal-specific
  // endpoints unless they are themselves set at managed scope (an
  // intentional managed override, which must win).
  const governed: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (
      (SIGNAL_ENDPOINT_VARS as readonly string[]).includes(key) &&
      policyEnv?.[key] === undefined
    ) {
      // Lower-scope signal-specific endpoint — suppress so the OTel SDK
      // falls back to the managed generic endpoint for this signal.
      continue
    }
    governed[key] = value
  }
  return governed
}

/**
 * Apply managed-OTEL-endpoint governance to `process.env` in place.
 *
 * Reads the policySettings env slice via the settings machinery and strips
 * lower-scope signal-specific OTLP endpoints when the managed generic
 * endpoint is present. Call after settings env has been applied (so
 * process.env reflects the merged value) and before the OTel SDK exporters
 * are constructed (so they read the governed env).
 */
export function applyManagedOtelEndpointGovernance(): void {
  const policyEnv = getPolicyEnv()
  const governed = governManagedOtelEndpoint(process.env as Record<string, string | undefined>, policyEnv)

  // Reflect governance onto process.env (delete stripped keys).
  for (const key of SIGNAL_ENDPOINT_VARS) {
    if (governed[key] === undefined && process.env[key] !== undefined) {
      delete process.env[key]
    } else if (governed[key] !== undefined) {
      process.env[key] = governed[key] as string
    }
  }
}

/**
 * Resolve the managed (policySettings) env slice. Exposed for tests that
 * want to inject a fake policy env without touching the settings cache.
 */
export function getPolicyEnv(): Record<string, string | undefined> {
  const settings = getSettingsForSource(
    'policySettings' as SettingSource,
  )
  return (settings?.env ?? {}) as Record<string, string | undefined>
}
