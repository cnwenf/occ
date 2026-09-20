/**
 * Shared pre-parse sanitization for EVERY policy-settings source.
 *
 * CC 2.1.278 (OCC-132 P3-6): the official parses every policy source —
 * remote, HKLM/plist MDM, managed-settings.json file, and HKCU — through the
 * same sanitized fail-closed schema. Binary evidence (2.1.278 ELF):
 *   `If(e,n)` (generic policy-source parse):
 *     `let d=D2e(r,n,{skipMcpServerEntryFilter:!0,policySource:!0})`
 *     `let c=Qn(nl(n,i),n).safeParse(s)`
 *   `XPe(e,n,s)` (file parse, `s` = policySource): same `Qn(...)` path when
 *   `s` is truthy; plain `Kb().safeParse` only for non-policy files.
 * `Qn` wraps EVERY schema field in a per-field `.catch()`, and the
 * marketplace/MCP-allowlist fields additionally get per-entry fail-closed
 * treatment (`Or`/`Rr` — `Invalid entry was ignored: …`, present-but-invalid
 * collapsing to an empty allowlist). Net contract: one malformed field/entry
 * never rejects the whole policy source.
 *
 * OCC implements the same observable contract as three in-place pre-parse
 * sanitizers (byte-identical warnings) instead of a schema variant:
 *   filterInvalidPermissionRules + sanitizeSecurityAllowlists +
 *   sanitizeMarketplacePolicy.
 * Previously they ran ONLY on the file path (parseSettingsFile); the
 * remote/MDM/HKCU paths parsed with raw `SettingsSchema().safeParse(data)`,
 * so a malformed marketplace or allowlist entry rejected the WHOLE source →
 * policySettings became undefined → enterprise restrictions failed OPEN.
 * This helper runs all three sanitizers on any policy source's raw JSON
 * before schema validation, closing that gap.
 */

import { sanitizeMarketplacePolicy } from './marketplacePolicySanitizer.js'
import { sanitizeSecurityAllowlists } from './sanitizeAllowlists.js'
import { filterInvalidPermissionRules, type ValidationError } from './validation.js'

/**
 * Sanitizes raw parsed policy-source JSON in place, before schema
 * validation. Returns combined warnings in the ValidationError shape (same
 * channel parseSettingsFile uses). Order matches parseSettingsFileUncached:
 * permission rules → security allowlists → marketplace policy.
 */
export function sanitizePolicySourceData(
  data: unknown,
  sourcePath: string,
): ValidationError[] {
  return [
    ...filterInvalidPermissionRules(data, sourcePath),
    ...sanitizeSecurityAllowlists(data, sourcePath),
    ...sanitizeMarketplacePolicy(data, sourcePath),
  ]
}
