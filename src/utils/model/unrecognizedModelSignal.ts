import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { logForDebugging } from '../debug.js'
import { getCanonicalName, normalizeModelStringForAPI } from './model.js'

/**
 * 2.1.233 alignment (OCC-95): `[claude-code:unrecognized_model]` diagnostic.
 * When a query goes out with a model the CLI does not recognize (not in the
 * known model set and not silenced via `modelOverrides`), emit a one-time
 * per-model warning — on stderr in print mode, into the debug log otherwise —
 * plus the `tengu_api_unrecognized_model` telemetry event.
 *
 * Ported from the official 2.1.233 linux-x64 ELF (byte-verified):
 *
 *   var T$S="[claude-code:unrecognized_model]";
 *   function $xi(e,t){try{if(yHr(e))return;let r=Td(e);
 *     if(!ZE.claim(`unrecognized-model-signal:${r}`))return;
 *     if(rst(e)||rst(r))return;
 *     O("tengu_api_unrecognized_model",{model:Md(e),querySource:b9(t)});
 *     let n=`${T$S} ${Ie({model:e,query_source:t})}`.replace(vot,"");
 *     if(xn()&&V.CLAUDE_CODE_SESSION_KIND!=="bg")VSt(`${n}\n`);
 *     else w(n,{level:"warn"})
 *   }catch(r){Ce(Hi(Hn(r),"unrecognized-model signal failed"))}}
 *
 * Mapping: `Td` ≡ normalizeModelStringForAPI (strips `[1m]`/`[2m]` ANSI
 * width markers); `ZE.claim` ≡ the `claimedSignals` set (once per model per
 * process); `rst` ≡ isModelRecognized (official checks the bundled model
 * catalog `entriesById` + `{"claude-3-opus","claude-3-sonnet","claude-3-haiku"}`
 * + `"claude-mythos-preview"` — OCC has no catalog, so the known set is the
 * canonical ids `firstPartyNameToCanonical` can return, which enumerates
 * every generation OCC knows); `zo` override resolution is inside
 * getCanonicalName (`resolveOverriddenModel` ≡ official `vHr` reverse
 * lookup) — a `modelOverrides` value silences the signal exactly like the
 * official; `xn()` ≡ getIsNonInteractiveSession; `vot` ≡
 * CONTROL_CHARS_PATTERN; the catch-all swallow is official behavior.
 *
 * Documented divergences:
 * - Official `yHr` skips Bedrock `application-inference-profile` models only
 *   while their backing model is still unresolved (sync cache lookup `V3t`);
 *   OCC's `getInferenceProfileBackingModel` is an async API call with no sync
 *   accessor, so OCC skips ALL inference-profile models (never false-flags).
 * - The official recognition set is data-driven (full model catalog) and
 *   broader; OCC's is pattern-derived from firstPartyNameToCanonical.
 */

export const UNRECOGNIZED_MODEL_TAG = '[claude-code:unrecognized_model]'

// binary vot — C0 (minus tab/newline/CR) and C1 control characters
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char matcher (binary-verbatim sanitizer)
const CONTROL_CHARS_PATTERN = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/g

// Once-store: fires at most once per model string per process (binary ZE).
const claimedSignals = new Set<string>()

/**
 * Canonical model ids OCC recognizes (binary `oA` catalog lookup + `Av_` +
 * `TCo`, approximated via firstPartyNameToCanonical's return values).
 */
const KNOWN_CANONICAL_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-4-5',
  'claude-fable-5',
  'claude-3-7-sonnet',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
])

/**
 * Full model ids recognized as-is (binary `TCo`). Checked against the raw
 * (lowercased) model, not the shortened canonical — the official compares
 * `claude-mythos-preview` against the resolved id, and OCC's
 * firstPartyNameToCanonical would shorten it to `claude-mythos`.
 */
const KNOWN_FULL_MODEL_IDS: ReadonlySet<string> = new Set([
  'claude-mythos-preview', // binary TCo
])

/** Binary `rst`/`R4u` — recognized = known canonical id after overrides. */
export function isModelRecognized(model: string): boolean {
  return (
    KNOWN_CANONICAL_MODELS.has(getCanonicalName(model)) ||
    KNOWN_FULL_MODEL_IDS.has(model.toLowerCase())
  )
}

/**
 * Binary `$xi`. Fire-and-forget; never throws (official wraps the body and
 * swallows — the signal must never break a query).
 */
export function signalUnrecognizedModel(
  model: string,
  querySource: string,
): void {
  try {
    // binary yHr — see divergences above: OCC skips all profiles.
    if (model.includes('application-inference-profile')) {
      return
    }
    const normalized = normalizeModelStringForAPI(model) // binary Td
    const claimKey = `unrecognized-model-signal:${normalized}`
    if (claimedSignals.has(claimKey)) {
      return
    }
    claimedSignals.add(claimKey)
    if (isModelRecognized(model) || isModelRecognized(normalized)) {
      return
    }
    logEvent('tengu_api_unrecognized_model', {
      model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      querySource:
        querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    const line = `${UNRECOGNIZED_MODEL_TAG} ${JSON.stringify({ model, query_source: querySource })}`.replace(
      CONTROL_CHARS_PATTERN,
      '',
    )
    if (
      getIsNonInteractiveSession() &&
      process.env.CLAUDE_CODE_SESSION_KIND !== 'bg'
    ) {
      process.stderr.write(`${line}\n`) // binary VSt
    } else {
      logForDebugging(line, { level: 'warn' }) // binary w(...,{level:"warn"})
    }
  } catch {
    // official: "unrecognized-model signal failed" — swallow
  }
}

/** Test-only: clear the once-store. */
export function resetUnrecognizedModelSignalForTesting(): void {
  claimedSignals.clear()
}
