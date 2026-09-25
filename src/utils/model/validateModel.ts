// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { MODEL_ALIASES } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getAPIProvider } from './providers.js'
import { sideQuery } from '../sideQuery.js'
import {
  NotFoundError,
  APIError,
  APIConnectionError,
  AuthenticationError,
} from '@anthropic-ai/sdk'
import { getModelStrings } from './modelStrings.js'
import { formatAPIError } from '../../services/api/errorUtils.js'

// Cache valid models to avoid repeated API calls
const validModelCache = new Map<string, boolean>()

/**
 * Result of a model validation probe.
 *
 * 2.1.281 (#067): the binary's mapper (`A` @208670286) returns classification
 * flags alongside `valid`/`error` so the `/model` switch flow can tell a retryable
 * transient from an auth re-prompt or an absent model. Callers that read only
 * `{ valid, error }` are unaffected (structural typing — extra optional fields).
 * The binary also carries a `permissionDenied` flag (helper `lDt`); OCC has no
 * equivalent entitlement helper, so that branch stays staged and the flag is
 * intentionally omitted here.
 */
export type ModelValidationResult = {
  valid: boolean
  error?: string
  notFound?: boolean
  authFailed?: boolean
  retryable?: boolean
}

/**
 * Validates a model by attempting an actual API call.
 */
export async function validateModel(
  model: string,
): Promise<ModelValidationResult> {
  const normalizedModel = model.trim()

  // Empty model is invalid
  if (!normalizedModel) {
    return { valid: false, error: 'Model name cannot be empty' }
  }

  // Check against availableModels allowlist before any API call
  if (!isModelAllowed(normalizedModel)) {
    return {
      valid: false,
      error: `Model '${normalizedModel}' is not in the list of available models`,
    }
  }

  // Check if it's a known alias (these are always valid)
  const lowerModel = normalizedModel.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lowerModel)) {
    return { valid: true }
  }

  // Check if it matches ANTHROPIC_CUSTOM_MODEL_OPTION (pre-validated by the user)
  if (normalizedModel === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
    return { valid: true }
  }

  // Check cache first
  if (validModelCache.has(normalizedModel)) {
    return { valid: true }
  }


  // Try to make an actual API call with minimal parameters
  try {
    await sideQuery({
      model: normalizedModel,
      max_tokens: 1,
      maxRetries: 0,
      querySource: 'model_validation',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })

    // If we got here, the model is valid
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  } catch (error) {
    return handleValidationError(error, normalizedModel)
  }
}

function handleValidationError(
  error: unknown,
  modelName: string,
): ModelValidationResult {
  // NotFoundError (404) means the model doesn't exist
  if (error instanceof NotFoundError) {
    const fallback = get3PFallbackSuggestion(modelName)
    const suggestion = fallback ? `. Try '${fallback}' instead` : ''
    return {
      valid: false,
      error: `Model '${modelName}' not found${suggestion}`,
      notFound: true,
    }
  }

  // For other API errors, provide context-specific messages
  if (error instanceof APIError) {
    // 2.1.281 (#067): auth failure sets `authFailed` only — binary mapper `A`
    // (@208670286) does NOT mark it retryable (re-auth is a user action, not a
    // transient). The triage prose listed "authFailed+retryable" for the branch
    // set; the byte-verified binary shows the auth branch carries authFailed alone.
    if (error instanceof AuthenticationError) {
      return {
        valid: false,
        error: 'Authentication failed. Please check your API credentials.',
        authFailed: true,
      }
    }

    if (error instanceof APIConnectionError) {
      return {
        valid: false,
        error: 'Network error. Please check your internet connection.',
        retryable: true,
      }
    }

    // Check error body for model-specific errors
    const errorBody = error.error as unknown
    if (
      errorBody &&
      typeof errorBody === 'object' &&
      'type' in errorBody &&
      errorBody.type === 'not_found_error' &&
      'message' in errorBody &&
      typeof errorBody.message === 'string' &&
      errorBody.message.includes('model:')
    ) {
      return {
        valid: false,
        error: `Model '${modelName}' not found`,
        notFound: true,
      }
    }

    // NOTE (#067, staged): the binary mapper has a `permissionDenied` branch here
    // (`lDt(e)` → "Model '<r>' isn't available for your account"). OCC has no
    // equivalent entitlement helper, so it is not ported (see ModelValidationResult).

    // Generic API error — 2.1.281 (#067): humanize the server message via
    // formatAPIError (binary `QZ`), strip trailing punctuation, and append the
    // " · model not changed" suffix so a failed /model switch never looks applied.
    // `retryable` mirrors binary `C(status)`; the conditional spread keeps the
    // field absent (not `false`) for non-retryable statuses, exactly as the binary.
    return {
      valid: false,
      error: `API error: ${formatAPIError(error).replace(/[.!?…]+$/, '')} · model not changed`,
      ...(isRetryableStatus(error.status) ? { retryable: true } : {}),
    }
  }

  // For unknown errors, be safe and reject
  const errorMessage = error instanceof Error ? error.message : String(error)
  return {
    valid: false,
    error: `Unable to validate model: ${errorMessage}`,
    retryable: true,
  }
}

/**
 * 2.1.281 (#067) binary `C(status)` (@208671019): a model probe is worth retrying
 * when the status is absent (connection-level failure) or a transient/timeout/5xx
 * code — `status === undefined || 408 || 429 || >= 500`.
 */
function isRetryableStatus(status: number | undefined): boolean {
  return (
    status === undefined || status === 408 || status === 429 || status >= 500
  )
}

// @[MODEL LAUNCH]: Add a fallback suggestion chain for the new model → previous version
/**
 * Suggest a fallback model for 3P users when the selected model is unavailable.
 */
function get3PFallbackSuggestion(model: string): string | undefined {
  if (getAPIProvider() === 'firstParty') {
    return undefined
  }
  const lowerModel = model.toLowerCase()
  if (lowerModel.includes('opus-4-6') || lowerModel.includes('opus_4_6')) {
    return getModelStrings().opus41
  }
  if (lowerModel.includes('sonnet-4-6') || lowerModel.includes('sonnet_4_6')) {
    return getModelStrings().sonnet45
  }
  if (lowerModel.includes('sonnet-4-5') || lowerModel.includes('sonnet_4_5')) {
    return getModelStrings().sonnet40
  }
  // 2.1.257 (Fable 5.1 launch): catalog `fallback_3p` fields, byte-verified in
  // the 2.1.258 ELF — fable-5-1 → "claude-fable-5", fable-5 → "claude-opus-5".
  // The fable-5-1 check MUST precede the fable-5 one (substring containment).
  if (lowerModel.includes('fable-5-1') || lowerModel.includes('fable_5_1')) {
    return getModelStrings().fable5
  }
  if (lowerModel.includes('fable-5') || lowerModel.includes('fable_5')) {
    return getModelStrings().opus5
  }
  return undefined
}
