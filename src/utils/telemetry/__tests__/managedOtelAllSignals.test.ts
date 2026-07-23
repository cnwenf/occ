import { describe, expect, test } from 'bun:test'
import { governManagedOtelEndpoint } from '../managedOtelEndpoint.js'

/**
 * CC 2.1.217 #9: "Fixed managed settings that set
 * `OTEL_EXPORTER_OTLP_ENDPOINT` not governing all signals — lower-scope
 * signal-specific overrides no longer redirect telemetry away from the
 * managed endpoint."
 *
 * When a MANAGED (policy) setting sets the generic
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, lower-scope signal-specific endpoint env
 * vars (`OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT`) must NOT
 * redirect that signal's telemetry away from the managed endpoint. The
 * generic managed endpoint governs all signals instead.
 *
 * The pure `governManagedOtelEndpoint(env, policyEnv)` seam takes the
 * resolved process.env snapshot plus the policySettings env object and
 * returns a new env with lower-scope signal-specific endpoints suppressed
 * when the managed generic endpoint is present. Managed-scope
 * signal-specific endpoints still win (they are the highest-trust scope).
 */

const SIGNAL_ENDPOINTS = [
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const

describe('governManagedOtelEndpoint', () => {
  test('managed OTEL_EXPORTER_OTLP_ENDPOINT suppresses lower-scope signal-specific endpoints', () => {
    // Arrange — managed generic endpoint set; lower-scope per-signal
    // endpoints would otherwise redirect each signal away from managed.
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://managed.example.com',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://attacker.traces.example.com',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
        'https://user.metrics.example.com',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://project.logs.example.com',
      OTEL_TRACES_EXPORTER: 'otlp',
    }
    const policyEnv = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://managed.example.com',
    }

    // Act
    const governed = governManagedOtelEndpoint(env, policyEnv)

    // Assert — generic managed endpoint survives, all lower-scope
    // signal-specific endpoints are stripped so the OTel SDK falls back to
    // the managed endpoint for every signal.
    expect(governed.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      'https://managed.example.com',
    )
    for (const key of SIGNAL_ENDPOINTS) {
      expect(governed[key]).toBeUndefined()
    }
    // Unrelated env vars are preserved.
    expect(governed.OTEL_TRACES_EXPORTER).toBe('otlp')
  })

  test('no managed endpoint — signal-specific endpoints still apply per-signal', () => {
    // Arrange — no policy generic endpoint; per-signal endpoints survive.
    const env = {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://metrics.example.com',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://logs.example.com',
      OTEL_EXPORTER_OTLP_HEADERS: 'k=v',
    }
    const policyEnv = {}

    const governed = governManagedOtelEndpoint(env, policyEnv)

    for (const key of SIGNAL_ENDPOINTS) {
      expect(governed[key]).toBe(env[key])
    }
    expect(governed.OTEL_EXPORTER_OTLP_HEADERS).toBe('k=v')
  })

  test('managed endpoint unset and no signal-specific endpoints — default passthrough', () => {
    const env = {
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_METRICS_EXPORTER: 'none',
    }
    const policyEnv = {}

    const governed = governManagedOtelEndpoint(env, policyEnv)

    // Nothing to govern — env returned unchanged (new object, same entries).
    expect(governed).toEqual(env)
  })

  test('managed-scope signal-specific endpoint is preserved even when managed generic endpoint is also set', () => {
    // Arrange — managed policy sets BOTH the generic endpoint and a
    // signal-specific endpoint. The signal-specific value is itself at
    // managed scope (highest trust), so it must NOT be stripped — it is an
    // intentional managed override, not a lower-scope redirect.
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://managed.example.com',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://managed.traces.example.com',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://user.metrics.example.com',
    }
    const policyEnv = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://managed.example.com',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://managed.traces.example.com',
    }

    const governed = governManagedOtelEndpoint(env, policyEnv)

    // Managed generic + managed traces endpoint survive.
    expect(governed.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      'https://managed.example.com',
    )
    expect(governed.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
      'https://managed.traces.example.com',
    )
    // Lower-scope metrics endpoint is stripped (governed by managed generic).
    expect(governed.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined()
  })

  test('does not mutate the input env (immutable)', () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://managed.example.com',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://lower.example.com',
    }
    const policyEnv = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://managed.example.com' }

    const governed = governManagedOtelEndpoint(env, policyEnv)

    // Input unchanged.
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
      'https://lower.example.com',
    )
    expect(governed).not.toBe(env)
  })
})
