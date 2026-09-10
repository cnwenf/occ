import { z } from 'zod/v4'
import type { ValidationError } from './validation.js'

/**
 * CC 2.1.267 security fix (changelog #12, Gap-121a): managed-policy security
 * allowlists fail CLOSED on invalid input.
 *
 * Before: a managed-settings.json containing an invalid `allowedHttpHookUrls`
 * (or `httpHookAllowedEnvVars` / `allowedChannelPlugins`) failed whole-file
 * schema validation → the policy file was dropped → the allowlist became
 * undefined → "all URLs allowed" (fail-OPEN). A single typo in an org policy
 * silently disabled the restriction.
 *
 * Official fix (v267 binary, fn `xn` at L1985405): each of the three keys is
 * parsed per-entry — invalid entries are dropped with a warning, and a key
 * that is present-but-invalid (or whose entries are ALL invalid) is replaced
 * with an empty allowlist, which existing consumers already honor as
 * deny-all. Byte-verified message shapes:
 *   - per-entry:      `Invalid entry was ignored: ${detail}`
 *   - all-invalid:    `Every entry of "${key}" was invalid; enforcing an empty allowlist (${reason}) until it is fixed.`
 *   - present-invalid: `"${key}" was present but invalid; enforcing an empty allowlist (${reason}) until it is fixed.`
 *
 * `allowedChannelPlugins` additionally accepts the legacy string form
 * "plugin@marketplace" (official `Ac`: split at the FIRST '@', object form
 * preferred; a statusOnly notice is emitted on accept). The official string
 * pre-validator `VT` is an unresolvable minified alias — per the OCC-121
 * triage decision, a string containing '@' with non-empty halves converts;
 * any other string is dropped as an invalid entry.
 *
 * Applied as a pre-schema filter (filterInvalidPermissionRules precedent) so
 * these three keys can never reject — or be rejected with — the whole file.
 * Absent keys stay absent (undefined = unrestricted for the URL/env lists,
 * ledger fallback for channel plugins — unchanged documented semantics).
 */

const STRING_ENTRY = z.string()

const CHANNEL_PLUGIN_ENTRY = z.object({
  marketplace: z.string(),
  plugin: z.string(),
})

type AllowlistSpec = {
  key: string
  /** Official `r` argument: what deny-all means for this key. */
  emptyReason: string
}

const ALLOWLIST_SPECS: AllowlistSpec[] = [
  { key: 'allowedHttpHookUrls', emptyReason: 'no HTTP hooks may run' },
  {
    key: 'httpHookAllowedEnvVars',
    emptyReason:
      'no environment variables may be interpolated into HTTP hook headers',
  },
  { key: 'allowedChannelPlugins', emptyReason: 'no channel plugins admitted' },
]

type EntryResult =
  | { ok: true; value: unknown; notice?: string }
  | { ok: false; detail: string }

/** Official `xn` issue formatting: `${path.join(".")}: ${message}` when the
 * first zod issue carries a path, else the bare message. */
function issueDetail(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'failed validation'
  return issue.path.length > 0
    ? `${issue.path.join('.')}: ${issue.message}`
    : issue.message
}

function validateAllowlistEntry(
  key: string,
  entry: unknown,
): EntryResult {
  if (key === 'allowedChannelPlugins') {
    // Official `Ac` preprocess: legacy "plugin@marketplace" string form is
    // converted (split at the first '@') before object validation.
    if (typeof entry === 'string') {
      const at = entry.indexOf('@')
      const plugin = entry.slice(0, at)
      const marketplace = entry.slice(at + 1)
      if (at > 0 && marketplace.length > 0) {
        return {
          ok: true,
          value: { marketplace, plugin },
          notice: `"allowedChannelPlugins" entry "${entry}" was accepted; prefer the documented object form {"plugin": "${plugin}", "marketplace": "${marketplace}"}.`,
        }
      }
      // Not the legacy form — fall through: a bare string fails the object
      // schema and is dropped as an invalid entry (official behavior when
      // `VT()` rejects).
    }
    const parsed = CHANNEL_PLUGIN_ENTRY.safeParse(entry)
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, detail: issueDetail(parsed.error) }
  }

  const parsed = STRING_ENTRY.safeParse(entry)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, detail: issueDetail(parsed.error) }
}

/**
 * Sanitizes the three security allowlist keys in raw parsed settings JSON,
 * in place, before whole-file schema validation. Returns warnings in the
 * ValidationError shape (same channel as filterInvalidPermissionRules).
 */
export function sanitizeSecurityAllowlists(
  data: unknown,
  filePath: string,
): ValidationError[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  const warnings: ValidationError[] = []

  for (const { key, emptyReason } of ALLOWLIST_SPECS) {
    if (!(key in obj)) continue
    const raw = obj[key]

    if (!Array.isArray(raw)) {
      // Official `.catch()`: present but invalid → enforce empty allowlist.
      obj[key] = []
      warnings.push({
        file: filePath,
        path: key,
        message: `"${key}" was present but invalid; enforcing an empty allowlist (${emptyReason}) until it is fixed.`,
        invalidValue: raw,
      })
      continue
    }

    const valid: unknown[] = []
    for (const [index, entry] of raw.entries()) {
      const result = validateAllowlistEntry(key, entry)
      if (result.ok) {
        valid.push(result.value)
        if (result.notice !== undefined) {
          warnings.push({
            file: filePath,
            path: `${key}[${index}]`,
            message: result.notice,
          })
        }
      } else {
        warnings.push({
          file: filePath,
          path: `${key}[${index}]`,
          message: `Invalid entry was ignored: ${result.detail}`,
          invalidValue: entry,
        })
      }
    }

    if (raw.length > 0 && valid.length === 0) {
      warnings.push({
        file: filePath,
        path: key,
        message: `Every entry of "${key}" was invalid; enforcing an empty allowlist (${emptyReason}) until it is fixed.`,
      })
    }
    obj[key] = valid
  }

  return warnings
}
