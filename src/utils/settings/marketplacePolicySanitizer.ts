import type { z } from 'zod/v4'
import { checkMarketplaceEntryEnforceability } from '../plugins/marketplacePolicyValidation.js'
import { MarketplaceSourceSchema } from '../plugins/schemas.js'
import { sanitizeForWarningText } from './sanitizeWarningText.js'
import type { ValidationError } from './validation.js'

/**
 * CC 2.1.277 security fix (report_C C9): managed-policy marketplace arrays
 * (`strictKnownMarketplaces` / `blockedMarketplaces`) fail CLOSED per entry,
 * never OPEN per file.
 *
 * Before: a managed-settings.json containing one malformed marketplace entry
 * failed the WHOLE-FILE schema validation → the policy file was dropped →
 * both arrays became undefined → no marketplace restrictions at all
 * (fail-OPEN). A single typo in an org policy silently disabled it.
 *
 * Official v277 mechanism (byte-verified against the ELF): a raw-JSON
 * pre-filter (`hf` null-delete + `yf` per-entry salvage, settings module
 * @0xb7beaae) plus a zod field validator (`Or` @0xb7aabac) with per-field
 * `.catch()` handlers. OCC has no per-field zod rebuild stage, so both
 * layers collapse into this single pre-schema pass — the observable result
 * (final array contents + warning messages) is identical:
 *
 *   - explicit `null`                 → key deleted, treated as unset (official `hf`)
 *   - present but not an array:
 *       strictKnownMarketplaces       → `[]` (empty allowlist = nothing admitted)
 *       blockedMarketplaces           → key dropped
 *   - array entries are parsed one by one against MarketplaceSourceSchema:
 *       schema-invalid entry          → dropped, "Invalid entry was ignored: …"
 *       unenforceable entry (official `Ht`):
 *         in blockedMarketplaces      → KEPT, "Unenforceable entry was kept: …"
 *         in strictKnownMarketplaces  → dropped, "Invalid entry was ignored: …"
 *       everything else               → kept
 *
 * All warning strings are byte-copied from the v277 binary. Applied as a
 * pre-schema filter (filterInvalidPermissionRules / sanitizeSecurityAllowlists
 * precedent) so these two keys can never reject — or be rejected with — the
 * whole policy file. Absent keys stay absent (undefined = unrestricted,
 * unchanged documented semantics).
 *
 * The official validator's first union branch (`qp()`, accepting a bare
 * non-array value into "unset") is an unresolved minified alias; its
 * observable semantics are pinned by `hf` (null → deleted → unset) and by
 * the `.catch()` messages for every other non-array shape.
 */

/** Official `jr` minus `disableSideloadFlags` (a key OCC does not have). */
const POLICY_KEYS = ['strictKnownMarketplaces', 'blockedMarketplaces'] as const

/** Byte-verified from v277 @0x5f73918/0xb7aac1c (strict field `.catch()`). */
const STRICT_PRESENT_INVALID_MESSAGE =
  '"strictKnownMarketplaces" was present but invalid; enforcing an empty allowlist (no marketplaces admitted) until it is fixed.'

/** Byte-verified from v277 (blocked field `.catch()`). */
const BLOCKED_PRESENT_INVALID_MESSAGE =
  '"blockedMarketplaces" was present but invalid and was dropped; its entries cannot be enforced until it is fixed.'

type ZodIssue = z.core.$ZodIssue

/**
 * Port of official `Hr`: first usable issue detail from a zod issue list,
 * recursing into `invalid_union` branches (MarketplaceSourceSchema is a
 * discriminatedUnion, so a bad `source` value yields nested union issues)
 * and honoring a non-empty `note`. Returns null when nothing is usable.
 */
function firstIssueDetail(issues: readonly ZodIssue[]): string | null {
  for (const issue of issues) {
    const prefix =
      issue.path.length > 0
        ? `${issue.path.map(String).join('.')}: `
        : ''
    if (issue.code === 'invalid_union') {
      for (const branch of issue.errors) {
        const detail = firstIssueDetail(branch)
        if (detail !== null) return `${prefix}${detail}`
      }
      const noted = issue as { note?: unknown }
      if (typeof noted.note === 'string' && noted.note !== '')
        return `${prefix}${noted.note}`
    }
    if (issue.message !== '') return `${prefix}${issue.message}`
  }
  return null
}

/**
 * Sanitizes the two marketplace-policy keys in raw parsed settings JSON, in
 * place, before whole-file schema validation. Returns warnings in the
 * ValidationError shape (same channel as sanitizeSecurityAllowlists).
 */
export function sanitizeMarketplacePolicy(
  data: unknown,
  filePath: string,
): ValidationError[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  const warnings: ValidationError[] = []

  for (const key of POLICY_KEYS) {
    if (!(key in obj)) continue
    const raw = obj[key]

    // Official `hf`: an explicit null on a policy tier is treated as unset.
    if (raw === null) {
      delete obj[key]
      continue
    }

    if (!Array.isArray(raw)) {
      // Official per-field `.catch()`: strict fails CLOSED to an empty
      // allowlist; blocked is dropped (a blocklist cannot fail closed
      // without also disabling installs, per the official message).
      if (key === 'strictKnownMarketplaces') {
        obj[key] = []
      } else {
        delete obj[key]
      }
      warnings.push({
        file: filePath,
        path: key,
        message:
          key === 'strictKnownMarketplaces'
            ? STRICT_PRESENT_INVALID_MESSAGE
            : BLOCKED_PRESENT_INVALID_MESSAGE,
        invalidValue: raw,
      })
      continue
    }

    const kept: unknown[] = []
    for (const [index, entry] of raw.entries()) {
      const parsed = MarketplaceSourceSchema().safeParse(entry)
      if (!parsed.success) {
        warnings.push({
          file: filePath,
          path: `${key}[${index}]`,
          // sanitizeForWarningText: CWE-117 — the issue detail can carry
          // policy-controlled text (OCC-132 §7 P3-5).
          message: `Invalid entry was ignored: ${sanitizeForWarningText(
            firstIssueDetail(parsed.error.issues) ?? 'failed validation',
          )}`,
          invalidValue: entry,
        })
        continue
      }
      const problem = checkMarketplaceEntryEnforceability(parsed.data)
      if (problem === null) {
        kept.push(parsed.data)
        continue
      }
      if (key === 'blockedMarketplaces') {
        // Official asymmetry: an unenforceable blocklist entry is KEPT with a
        // warning — it can never match, but marketplace restrictions stay active.
        kept.push(parsed.data)
        warnings.push({
          file: filePath,
          path: `${key}[${index}]`,
          message: `Unenforceable entry was kept: ${sanitizeForWarningText(problem)}; it can never match a marketplace source, but marketplace restrictions stay active`,
          invalidValue: entry,
        })
      } else {
        warnings.push({
          file: filePath,
          path: `${key}[${index}]`,
          message: `Invalid entry was ignored: ${sanitizeForWarningText(problem)}`,
          invalidValue: entry,
        })
      }
    }
    // An all-dropped strict array lands here as [] — truthy, so
    // getStrictKnownMarketplaces() returns [] and isSourceAllowedByPolicy()
    // blocks everything: fail CLOSED.
    obj[key] = kept
  }

  return warnings
}
