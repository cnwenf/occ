import {
  getModelStrings as getModelStringsState,
  setModelStrings as setModelStringsState,
} from 'src/bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { getAWSRegion } from '../envUtils.js'
import { logError } from '../log.js'
import { sequential } from '../sequential.js'
import { getInitialSettings } from '../settings/settings.js'
import {
  applyBedrockRegionPrefix,
  type BedrockRegionPrefix,
  deriveBedrockRegionPrefixFromRegion,
  findFirstMatch,
  getBedrockInferenceProfiles,
  getEffectiveBedrockRegionPrefix,
} from './bedrock.js'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  type CanonicalModelId,
  type ModelKey,
} from './configs.js'
import { type APIProvider, getAPIProvider } from './providers.js'

/**
 * Maps each model version to its provider-specific model ID string.
 * Derived from ALL_MODEL_CONFIGS — adding a model there extends this type.
 */
export type ModelStrings = Record<ModelKey, string>

const MODEL_KEYS = Object.keys(ALL_MODEL_CONFIGS) as ModelKey[]

function getBuiltinModelStrings(provider: APIProvider): ModelStrings {
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    out[key] = ALL_MODEL_CONFIGS[key][provider]
  }
  return out
}

/**
 * Apply a region prefix to every entry (binary `KZr` per-entry `Bpt` call,
 * byte-verified). Foundation models (anthropic.*) gain the prefix; entries
 * with a different existing prefix get it replaced.
 */
function applyRegionPrefixToModelStrings(
  ms: ModelStrings,
  prefix: BedrockRegionPrefix,
): ModelStrings {
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    out[key] = applyBedrockRegionPrefix(ms[key], prefix)
  }
  return out
}

/**
 * Resolve Bedrock model strings with ANTHROPIC_BEDROCK_REGION_PREFIX support.
 * CC 2.1.224 (binary `Koy`, byte-verified port):
 * - the effective prefix (env override or region-derived) is applied to the
 *   hardcoded fallback strings BEFORE any profile lookup;
 * - profile lookup prefers profiles carrying the effective prefix;
 * - three byte-verbatim diagnostics (warn/error/warn) cover the unverified
 *   fallback, the failed fetch, and the mismatched-prefix cases.
 */
async function getBedrockModelStrings(): Promise<ModelStrings> {
  const region = getAWSRegion()
  const effectivePrefix = getEffectiveBedrockRegionPrefix(region)
  const derivedPrefix = deriveBedrockRegionPrefixFromRegion(region)
  const hardcoded = applyRegionPrefixToModelStrings(
    getBuiltinModelStrings('bedrock'),
    effectivePrefix,
  )
  // Warn when the env override is applied without an availability check
  // (profile discovery unavailable) — official closure `o` in `Koy`.
  const warnIfPrefixDiverges = () => {
    if (effectivePrefix !== derivedPrefix) {
      logForDebugging(
        `ANTHROPIC_BEDROCK_REGION_PREFIX=${effectivePrefix} is being applied without an availability check (inference-profile discovery is unavailable). If requests 400, ensure ${effectivePrefix}.* cross-region inference profiles are enabled in this account, or unset the variable to fall back to ${derivedPrefix}.*.`,
        { level: 'warn' },
      )
    }
  }
  let profiles: string[] | undefined
  try {
    profiles = await getBedrockInferenceProfiles()
  } catch (error) {
    logError(error as Error)
    logForDebugging(
      `Failed to list Bedrock inference profiles, falling back to hardcoded models: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
    warnIfPrefixDiverges()
    return hardcoded
  }
  if (!profiles?.length) {
    warnIfPrefixDiverges()
    return hardcoded
  }
  // Each config's firstParty ID is the canonical substring we search for in the
  // user's inference profile list (e.g. "claude-opus-4-6" matches
  // "eu.anthropic.claude-opus-4-6-v1"). Fall back to the hardcoded bedrock ID
  // when no matching profile is found.
  const out = {} as ModelStrings
  const mismatched: string[] = []
  for (const key of MODEL_KEYS) {
    const needle = ALL_MODEL_CONFIGS[key].firstParty
    const value =
      findFirstMatch(profiles, needle, effectivePrefix) || hardcoded[key]
    out[key] = value
    if (
      effectivePrefix !== derivedPrefix &&
      !value.startsWith(`${effectivePrefix}.`)
    ) {
      mismatched.push(needle)
    }
  }
  if (mismatched.length > 0) {
    logForDebugging(
      `ANTHROPIC_BEDROCK_REGION_PREFIX=${effectivePrefix}: ${mismatched.length} model(s) resolved to a different prefix (no ${effectivePrefix}.* profile in this account): ${mismatched.join(', ')}. This is a preference, not a residency guarantee.`,
      { level: 'warn' },
    )
  }
  return out
}

/**
 * Layer user-configured modelOverrides (from settings.json) on top of the
 * provider-derived model strings. Overrides are keyed by canonical first-party
 * model ID (e.g. "claude-opus-4-6") and map to arbitrary provider-specific
 * strings — typically Bedrock inference profile ARNs.
 */
function applyModelOverrides(ms: ModelStrings): ModelStrings {
  const overrides = getInitialSettings().modelOverrides
  if (!overrides) {
    return ms
  }
  const out = { ...ms }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    const key = CANONICAL_ID_TO_KEY[canonicalId as CanonicalModelId]
    if (key && override) {
      out[key] = override
    }
  }
  return out
}

/**
 * Resolve an overridden model ID (e.g. a Bedrock ARN) back to its canonical
 * first-party model ID. If the input doesn't match any current override value,
 * it is returned unchanged. Safe to call during module init (no-ops if settings
 * aren't loaded yet).
 */
export function resolveOverriddenModel(modelId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getInitialSettings().modelOverrides
  } catch {
    return modelId
  }
  if (!overrides) {
    return modelId
  }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    if (override === modelId) {
      return canonicalId
    }
  }
  return modelId
}

const updateBedrockModelStrings = sequential(async () => {
  if (getModelStringsState() !== null) {
    // Already initialized. Doing the check here, combined with
    // `sequential`, allows the test suite to reset the state
    // between tests while still preventing multiple API calls
    // in production.
    return
  }
  try {
    const ms = await getBedrockModelStrings()
    setModelStringsState(ms)
  } catch (error) {
    logError(error as Error)
  }
})

function initModelStrings(): void {
  const ms = getModelStringsState()
  if (ms !== null) {
    // Already initialized
    return
  }
  // Initial with default values for non-Bedrock providers
  if (getAPIProvider() !== 'bedrock') {
    setModelStringsState(getBuiltinModelStrings(getAPIProvider()))
    return
  }
  // On Bedrock, update model strings in the background without blocking.
  // Don't set the state in this case so that we can use `sequential` on
  // `updateBedrockModelStrings` and check for existing state on multiple
  // calls.
  void updateBedrockModelStrings()
}

export function getModelStrings(): ModelStrings {
  const ms = getModelStringsState()
  if (ms === null) {
    initModelStrings()
    // Bedrock path falls through here while the profile fetch runs in the
    // background — still honor overrides on the interim defaults.
    const provider = getAPIProvider()
    const base = getBuiltinModelStrings(provider)
    // CC 2.1.224 (binary `TUe`/`KZr`, byte-verified): the interim Bedrock
    // defaults also carry the effective region prefix — the prefix is not
    // only applied once the profile fetch completes.
    const interim =
      provider === 'bedrock'
        ? applyRegionPrefixToModelStrings(
            base,
            getEffectiveBedrockRegionPrefix(getAWSRegion()),
          )
        : base
    return applyModelOverrides(interim)
  }
  return applyModelOverrides(ms)
}

/**
 * Ensure model strings are fully initialized.
 * For Bedrock users, this waits for the profile fetch to complete.
 * Call this before generating model options to ensure correct region strings.
 */
export async function ensureModelStringsInitialized(): Promise<void> {
  const ms = getModelStringsState()
  if (ms !== null) {
    return
  }

  // For non-Bedrock, initialize synchronously
  if (getAPIProvider() !== 'bedrock') {
    setModelStringsState(getBuiltinModelStrings(getAPIProvider()))
    return
  }

  // For Bedrock, wait for the profile fetch
  await updateBedrockModelStrings()
}
