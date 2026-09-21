/**
 * Shared pre-parse sanitization for policy-settings sources.
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
 * collapsing to an empty allowlist). Net official contract: one malformed
 * field/entry never rejects the whole policy source.
 *
 * OCC coverage — NARROWER than the official `Qn` breadth (OCC-132 §7 P2-1,
 * documented truthfully instead of overclaimed). This helper runs three
 * per-entry sanitizers on any policy source's raw JSON before schema
 * validation:
 *   - permissions allow/deny/ask rules          (filterInvalidPermissionRules)
 *   - allowedHttpHookUrls / httpHookAllowedEnvVars / allowedChannelPlugins
 *                                               (sanitizeSecurityAllowlists)
 *   - strictKnownMarketplaces / blockedMarketplaces
 *                                               (sanitizeMarketplacePolicy)
 * For those three field families the observable contract matches the
 * official (per-entry fail-closed, byte-identical warnings). All OTHER
 * SettingsJson fields (e.g. `extraKnownMarketplaces`) do NOT get per-field
 * `.catch()` coverage: a malformed uncovered field still rejects the WHOLE
 * source at the `SettingsSchema().safeParse(data)` calls in settings.ts
 * (parseSettingsFileUncached, ~line 278) and mdm/settings.ts
 * (parseCommandOutputAsSettings, ~line 202). Extending the full official
 * `Qn` per-field `.catch()` breadth to the remaining fields is STAGED for a
 * future round (OCC-132 acceptance ledger §7 P2-1 sanctioned the truthful
 * doc rewrite as this round's cheap option).
 *
 * Remote-path note (same ledger entry): the sanitized reads here cover the
 * two settings.ts policy sites (getSettingsForSourceUncached +
 * loadSettingsFromDisk). The residual remote-raw attack surface flagged at
 * acceptance is the `syncCacheState` disk-cache fallback
 * (`~/.claude/remote-settings.json`, read raw by
 * getRemoteManagedSettingsSyncFromCache); consumers of that cache outside
 * the two sanitized settings.ts sites still see raw JSON.
 *
 * Why this helper exists (OCC-132 P3-6): previously the three sanitizers
 * ran ONLY on the file path (parseSettingsFile); the remote/MDM/HKCU paths
 * parsed with raw `SettingsSchema().safeParse(data)`, so a malformed
 * marketplace or allowlist entry rejected the WHOLE source → policySettings
 * became undefined → enterprise restrictions failed OPEN. Running them on
 * every policy source's raw JSON before schema validation closes that gap
 * for the covered families.
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
