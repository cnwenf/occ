/**
 * Multi-ordered fallback model resolution.
 *
 * Matches the official 2.1.200 binary: `fallbackModel` may be a single model
 * name, a comma-separated list (CLI `--fallback-model a,b,default`), or a
 * settings array of up to 3 strings. Each element accepts the literal
 * `"default"`, which expands to the current default main-loop model. The list
 * is de-duplicated (per-element, after resolution) and capped at 3.
 *
 * Binary references (claude.strings):
 *   - `wsa({cli,settings})` — normalize: CLI `?.split(",")` ?? settings array,
 *     per-element `s==="default"?$y():s` → `Go(...)` resolve, `Set` dedup,
 *     `Ya(i)` validate, `r.length===ufp` (ufp=3) cap.
 *   - `q9n(e,t)` — `(Array.isArray(t)?t:t!==void 0?[t]:[]).filter(r=>!q0e(e,r))`
 *     builds the ordered list with the main model de-duplicated out.
 */
import { getDefaultMainLoopModel, parseUserSpecifiedModel } from './model.js'
import { isModelAllowed } from './modelAllowlist.js'

/** Cap on the number of fallback models tried in order (binary `ufp = 3`). */
const MAX_FALLBACK_MODELS = 3

/**
 * Resolve a single fallback element. `"default"` expands to the current
 * default main-loop model; everything else is resolved through
 * `parseUserSpecifiedModel` (so aliases like `sonnet`, `opus` work).
 */
function resolveFallbackElement(element: string): string {
  const trimmed = element.trim()
  if (trimmed === '') return ''
  const resolved = parseUserSpecifiedModel(
    trimmed === 'default' ? getDefaultMainLoopModel() : trimmed,
  )
  return resolved
}

/**
 * Normalize a fallback model setting into an ordered, de-duplicated,
 * validated list of up to 3 resolved model IDs.
 *
 * Accepts either the CLI value (a string that may be comma-separated) or the
 * settings value (a string or array). Returns `undefined` when no valid
 * fallback remains.
 *
 * This is the runtime equivalent of the binary's `wsa({cli, settings})`.
 */
export function normalizeFallbackModels(
  cliFallback: string | undefined,
  settingsFallback: string | string[] | undefined,
): string[] | undefined {
  // CLI takes precedence; it is comma-separated. Settings may be a single
  // string or an array.
  const raw: string[] | undefined = cliFallback
    ? cliFallback.split(',')
    : Array.isArray(settingsFallback)
      ? settingsFallback
      : settingsFallback
        ? [settingsFallback]
        : undefined
  if (raw === undefined) {
    return undefined
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const element of raw) {
    if (typeof element !== 'string') {
      continue
    }
    const resolved = resolveFallbackElement(element)
    if (resolved === '') {
      continue
    }
    if (seen.has(resolved)) {
      continue
    }
    // Skip models disallowed by the availableModels allowlist (binary `Ya(i)`).
    if (!isModelAllowed(resolved)) {
      continue
    }
    seen.add(resolved)
    result.push(resolved)
    if (result.length >= MAX_FALLBACK_MODELS) {
      break
    }
  }
  return result.length > 0 ? result : undefined
}

/**
 * Build the ordered fallback list to try, with the main model de-duplicated
 * out. This is the runtime equivalent of the binary's `q9n(mainModel, fallback)`.
 *
 * The main model is excluded so a retry never re-targets the model that just
 * failed. Within the fallback list, duplicates (post-resolution) are removed.
 */
export function getOrderedFallbackModels(
  mainModel: string,
  fallbackModel: string | string[] | undefined,
): string[] {
  if (fallbackModel === undefined) {
    return []
  }
  const list = Array.isArray(fallbackModel)
    ? fallbackModel
    : [fallbackModel]
  const seen = new Set<string>()
  const result: string[] = []
  for (const element of list) {
    if (typeof element !== 'string') {
      continue
    }
    const resolved = resolveFallbackElement(element)
    if (resolved === '' || resolved === mainModel || seen.has(resolved)) {
      continue
    }
    seen.add(resolved)
    result.push(resolved)
    if (result.length >= MAX_FALLBACK_MODELS) {
      break
    }
  }
  return result
}
