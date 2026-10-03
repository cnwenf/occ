/**
 * Per-server `requestTimeout` resolution for the LSP subsystem.
 *
 * Official v288 (gap-report cluster-f #55) adds the config field:
 *   - zod: `requestTimeout: z.number().int().positive().max(2147483647).optional()`
 *   - describe: "Maximum time to wait for the server to answer a request
 *     (milliseconds). Defaults to 60000."
 *   - runtime error text: `Request has exceeded the configured ${ms} ms requestTimeout.`
 *
 * The timeout race itself reuses the shared `withTimeout` helper from
 * `src/utils/sleep.ts` — the same pattern LSPServerInstance already used for
 * `startupTimeout` (its local copy was deduplicated into sleep.ts's export).
 */

/**
 * Official default: "Defaults to 60000." — applied even when the server
 * config leaves `requestTimeout` unset.
 */
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 60000

/** Official zod bound: `.max(2147483647)` (Int32 max, setTimeout ceiling). */
export const MAX_LSP_REQUEST_TIMEOUT_MS = 2147483647

/**
 * Resolve the effective request timeout (ms) from an LSP server config.
 *
 * Mirrors the official zod shape — a value that is not a positive integer
 * <= 2147483647 falls back to the official 60000 ms default (the schema
 * rejects those values at parse time; this is the defensive runtime path for
 * configs that bypass schema validation, e.g. the `any`-typed stub config).
 */
export function resolveRequestTimeoutMs(
  config: { requestTimeout?: unknown } | undefined,
): number {
  const value = config?.requestTimeout
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_LSP_REQUEST_TIMEOUT_MS
  ) {
    return value
  }
  return DEFAULT_LSP_REQUEST_TIMEOUT_MS
}
