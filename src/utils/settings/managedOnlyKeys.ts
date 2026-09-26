/**
 * CC 2.1.283 — managed-only settings-key strip for non-policy sources.
 *
 * Byte-verified against the official v2.1.283 linux-x64 ELF:
 *   - `dgn` MANAGED_ONLY_KEYS base @196774265 region: ["managedMcpServers","isolation"]
 *   - `xy`  = [...dgn, "deniedModels", "availableModelsMatch"]
 *   - `Ad`  (stripManagedOnlyKeys) same region; call sites:
 *       - `Dy`  SDK inline settings, file label "SDK inline settings" @~196776900
 *       - `Gye` parseSettingsContent non-policy-file branch          @~196778353
 *     The policy-source branch does NOT strip (managed settings are the only
 *     place these keys are honored).
 *   - `MRe` isInertManagedMcpServersNotice — suppresses the warning for the
 *     managedMcpServers/isolation half; both model-governance keys always warn.
 *
 * Documented deviations:
 *   - OCC subset: OCC's settings schema has no `managedMcpServers`/`isolation`
 *     keys, so only the two model-governance keys are stripped here.
 *   - The official mutates its (already-cloned) input via `delete`; this port
 *     returns a fresh object (immutability convention) — same observable
 *     behavior since callers consume the returned data.
 *   - The official warning carries `preserveOnWrite:!0` (the key survives a
 *     later settings-file rewrite); OCC's ValidationError has no such field
 *     and no rewrite path that would consume it — omitted.
 */

/** Official `xy` restricted to keys OCC's schema knows (see header). */
export const MANAGED_ONLY_KEYS: readonly string[] = [
  'deniedModels',
  'availableModelsMatch',
] as const

/** One strip warning, ValidationError-shaped (official `Ad` record). */
export type ManagedOnlyKeyWarning = {
  readonly file: string
  readonly path: string
  readonly message: string
  readonly severity: 'warning'
}

export type StripManagedOnlyKeysResult<T> = {
  readonly data: T
  readonly warnings: readonly ManagedOnlyKeyWarning[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Official `Ad`: remove the managed-only keys from a non-policy settings
 * object, returning the stripped data plus one warning per removed key
 * (`"<key>" is only honored from managed settings and was ignored here.`).
 */
export function stripManagedOnlyKeys<T extends Record<string, unknown>>(
  data: T,
  fileLabel: string,
): StripManagedOnlyKeysResult<T> {
  if (!isPlainRecord(data)) {
    return { data, warnings: [] }
  }
  const warnings: ManagedOnlyKeyWarning[] = []
  const rest: Record<string, unknown> = { ...data }
  for (const key of MANAGED_ONLY_KEYS) {
    if (!(key in rest)) continue
    delete rest[key]
    warnings.push({
      file: fileLabel,
      path: key,
      message: `"${key}" is only honored from managed settings and was ignored here.`,
      severity: 'warning',
    })
  }
  return { data: rest as T, warnings }
}
