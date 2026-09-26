/**
 * CC 2.1.283 — admin-facing warning collection for the managed model
 * governance settings (`deniedModels` / `availableModelsMatch:"exact"`).
 *
 * Byte-verified against the official v2.1.283 linux-x64 ELF:
 *   - `z5n` (deniedModelsEntryWarnings)          @196788635
 *   - `V5n` (availableModelsExactEntryWarnings)  @196788836
 *   - `Xi`  (collectManagedModelGovernanceWarnings) @197184017
 *
 * The official `Xi` reads `he("policySettings")` itself and is surfaced via a
 * separate "Managed settings notices" channel (`wBr`/
 * surfaceManagedSettingsErrorsHeadless). OCC has no such surface, so the
 * collectors are parameterized by the policy-settings object (keeping this
 * module pure — no settings import, no import cycle) and the records are
 * ValidationError-shaped; src/utils/settings/settings.ts routes them into the
 * existing policyErrors channel (documented deviation).
 *
 * Record shape matches the official exactly:
 * `{file:"managed settings", path, message, severity:"warning", statusOnly:true}`.
 */

import { exactMatchEntryWarning } from './availableModelsMatch.js'
import { parseDeniedModelEntry } from './deniedModels.js'

/** Official notice record (subset of ValidationError the official emits). */
export type ManagedModelGovernanceNotice = {
  readonly file: string
  readonly path: string
  readonly message: string
  readonly severity: 'warning'
  readonly statusOnly: true
}

/** Minimal policy-settings view the collectors need (official `he("policySettings")`). */
export type ModelGovernancePolicyView = {
  readonly deniedModels?: readonly string[]
  readonly availableModels?: readonly string[]
  readonly availableModelsMatch?: string
} | null | undefined

function buildNotice(
  path: 'deniedModels' | 'availableModels',
  message: string,
): ManagedModelGovernanceNotice {
  return {
    file: 'managed settings',
    path,
    message,
    severity: 'warning',
    statusOnly: true,
  }
}

/** Official `z5n` (@196788635): one warning per parseable deniedModels entry. */
export function deniedModelsEntryWarnings(
  policy: ModelGovernancePolicyView,
): readonly ManagedModelGovernanceNotice[] {
  const notices: ManagedModelGovernanceNotice[] = []
  for (const rawEntry of policy?.deniedModels ?? []) {
    const { warning } = parseDeniedModelEntry(rawEntry)
    if (warning !== undefined) {
      notices.push(buildNotice('deniedModels', warning))
    }
  }
  return notices
}

/**
 * Official `V5n` (@196788836): under exact matching, one warning per
 * availableModels entry that `ql` flags (ignored aliases, family wildcards,
 * literal exact-name-only entries).
 */
export function availableModelsExactEntryWarnings(
  policy: ModelGovernancePolicyView,
): readonly ManagedModelGovernanceNotice[] {
  if (policy?.availableModelsMatch !== 'exact') return []
  const entries = policy.availableModels ?? []
  return entries.flatMap(rawEntry => {
    const warning = exactMatchEntryWarning(rawEntry, entries)
    return warning === undefined ? [] : [buildNotice('availableModels', warning)]
  })
}

/** Official `Xi` (@197184017): both collectors, deny warnings first. */
export function collectManagedModelGovernanceWarnings(
  policy: ModelGovernancePolicyView,
): readonly ManagedModelGovernanceNotice[] {
  try {
    return [
      ...deniedModelsEntryWarnings(policy),
      ...availableModelsExactEntryWarnings(policy),
    ]
  } catch {
    return []
  }
}
