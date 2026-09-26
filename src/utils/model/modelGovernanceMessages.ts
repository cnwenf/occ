/**
 * CC 2.1.283 — user-facing blocked messages for the managed model governance
 * (`deniedModels` / `availableModelsMatch:"exact"`).
 *
 * Byte-verified against the official v2.1.283 linux-x64 ELF:
 *   - `__` (isBlockedByExactAvailableModels) @198791208 region
 *   - `h_` (isModelBlockedByGovernance)      @198791375 (call) — `qhe || __`
 *   - `TH` (getManagedModelGovernanceBlockMessage) @198791411; startup gate
 *     call site @212235445 (`Bn=TH(je)` → print + exit reason
 *     `managed_settings_invalid` — the exit-reason telemetry `Az` has no OCC
 *     surface, so the gate wiring itself is staged; the message contract is
 *     ported byte-exact).
 *   - `ub` (sanitizeModelNameForMessage)     @198783953
 */

import { getSettingsForSource } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { classifyAvailableModelsEntry } from './availableModelsMatch.js'
import { strip1mSuffix, sanitizeModelNameForMessage } from './modelDescriptors.js'
import { isModelDeniedByPolicy } from './modelGovernance.js'
import { isModelAllowed } from './modelAllowlist.js'

/** Official `TH`'s `n` parameter: which flow asks for the message. */
export type GovernanceBlockMessageWhen = 'start' | 'switch'

/**
 * Official `__` (@198791208 region): under exact matching with a policy
 * allowlist that names at least one real model, a model the allowlist does not
 * allow is blocked (this is what constrains the Default option).
 */
export function isBlockedByExactAvailableModels(model: string): boolean {
  const policy = getSettingsForSource('policySettings') as SettingsJson | null
  if (policy?.availableModelsMatch !== 'exact') return false
  const allowlist = policy.availableModels
  if (
    allowlist === undefined ||
    allowlist.every(entry => classifyAvailableModelsEntry(entry).kind === 'ignored')
  ) {
    return false
  }
  return !isModelAllowed(model, { allowlist: [...allowlist] })
}

/** Official `h_` (@198791375): denied OR exact-allowlist-blocked. */
export function isModelBlockedByGovernance(model: string): boolean {
  return isModelDeniedByPolicy(model) || isBlockedByExactAvailableModels(model)
}

/**
 * Official `TH` (@198791411): the block message for the DEFAULT model when
 * managed governance leaves nothing usable — null when the default model is
 * fine. Messages are byte-verbatim from the official binary.
 */
export function getManagedModelGovernanceBlockMessage(
  model: string,
  when: GovernanceBlockMessageWhen = 'start',
): string | null {
  let isDenied: boolean
  let isExactBlocked: boolean
  try {
    isDenied = isModelDeniedByPolicy(model)
    isExactBlocked = !isDenied && isBlockedByExactAvailableModels(model)
  } catch {
    return when === 'start'
      ? null
      : "Can't switch to the default model: Claude Code couldn't read your organization's managed settings to check which models they allow. Restart Claude Code; if this keeps happening, ask your administrator to check the managed settings."
  }
  const displayName = sanitizeModelNameForMessage(strip1mSuffix(model))
  if (isExactBlocked) {
    return `${when === 'start' ? "Claude Code can't start" : "Can't switch to the default model"}: your organization allows only the models listed in "availableModels", and none of them can be used as the default model (${displayName} isn't listed). Ask your administrator to update "availableModels".`
  }
  if (!isDenied) return null
  return when === 'start'
    ? `Claude Code can't start: your organization's managed settings block the default model (${displayName}) in "deniedModels"`
    : `Can't switch to the default model: your organization's managed settings block it (${displayName}) in "deniedModels"}, and none of the models they allow can be used as the default instead. Ask your administrator to update "deniedModels" or "availableModels".`
}
