/**
 * CC 2.1.286 (item-A): per-model-family fast-mode rejection store.
 *
 * Official changelog: "Fixed refusal and `--fallback-model` retries failing
 * when the fallback model can't run fast; they now run at standard speed,
 * with a one-time notice in interactive sessions."
 *
 * When the API rejects the `speed` parameter for the model a fallback retry
 * resolved to (a 400 `'…' does not support the \`speed\` parameter`), the
 * model family is recorded here and every later retry for that family runs at
 * standard speed from the first attempt (the withRetry loop-head coercion) —
 * instead of re-failing the whole turn.
 *
 * Binary references (v286 ELF, store `Ll` @199318400-199322600, detectors
 * @206125600+, all byte-verified):
 *   - family key `Mh(e){return kt(Ue(e,{identity:!0}))}` — canonical name with
 *     overrides NOT applied (identity mode), trailing `[1m]` stripped. OCC
 *     mirror: `stripTrailing1mTag(firstPartyNameToCanonical(model))`.
 *   - `lOe(e,n)` — 400 + `/'([^']+)' does not support the \`speed\`
 *     parameter/` and the rejected model's family equals the current model's
 *     family.
 *   - `aBo(e)` — add family to `everFastRejectedModels`; if already in
 *     `fastRejectedFallbackModels` return; else add, log the one-time debug
 *     line, emit both signals.
 *   - `rBt(e)` — `fastRejectedFallbackModels.has(Mh(e))` (try/catch → false).
 *   - `SYn(e)` — family present in EITHER set.
 *   - `n9e()` — clear `fastRejectedFallbackModels` + emit changed.
 *
 * STAGED (recovered, not ported): the interactive one-time notice plugin
 * `qot`/`efo` @226000442 — plugin id `fast-mode-fallback-model-rejected`,
 * gates not-headless + interactive session, notice text
 * `` `Using standard speed on ${getPublicModelDisplayName(model)} · fast mode
 * wasn't available` ``, kind/color `warning`, priority immediate. OCC's
 * plugin/notice surface is out of scope for the retry modules; the
 * `onFallbackModelFastRejected` signal below is the wiring point. Until that
 * plugin lands, `clearFastRejectedFallbackModels` (session-reset `n9e`) and
 * both `on*` subscription signals have ZERO production callers/subscribers —
 * they are STAGED wiring points, exercised only by unit tests.
 *
 * DORMANT IN PRODUCTION — the WHOLE cluster, not just the notice (acceptance
 * re-review finding, 2026-10-02): both stores' only writer is
 * `markFastRejected`, whose only production caller is the withRetry
 * speed-rejection branch — and that branch's gate requires
 * `options.modelIsRefusalFallbackTarget` (ZERO production setters; the
 * official producer is the query-engine refusal/queued dispatch, gap doc §4
 * backlog item 3) OR `hasEverOrFallbackFastRejected` (which needs an
 * already-seeded store — a circular fixpoint). So in OCC production the
 * store is never seeded, the loop-head coercion reads it empty and never
 * fires, and a first speed-param 400 on a fallback still fails the turn.
 * The mechanism is exercised only by tests that inject the flag explicitly
 * (`withRetryIntegration286`); runtime-verified by the acceptance probe
 * (TARGET: production shape → store stays empty; CONTROL: injected flag →
 * branch recovers at standard speed).
 */
import { APIError } from '@anthropic-ai/sdk'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { createSignal } from '../signal.js'
import { firstPartyNameToCanonical } from './model.js'
import { stripTrailing1mTag } from './modelOptions.js'

/**
 * Binary `Mh(e){return kt(Ue(e,{identity:!0}))}` — the model-family key:
 * canonical short name (identity mode: settings overrides NOT applied),
 * trailing `[1m]` tag stripped. `claude-opus-5[1m]`, `claude-opus-5` and
 * `us.anthropic.claude-opus-5` all key to `claude-opus-5`.
 */
export function modelFamilyKey(model: string): string {
  return stripTrailing1mTag(firstPartyNameToCanonical(model))
}

/** Binary `Ll.everFastRejectedModels` — every family ever speed-rejected. */
const everFastRejectedModels = new Set<string>()
/** Binary `Ll.fastRejectedFallbackModels` — families forced to standard speed. */
const fastRejectedFallbackModels = new Set<string>()

/** Binary `Ll.fallbackModelFastRejected` (subscribed by the notice plugin). */
const fallbackModelFastRejected = createSignal<[model: string]>()
/** Binary `Ll.fastRejectedFallbackModelsChanged` (UI re-render signal). */
const fastRejectedFallbackModelsChanged = createSignal()

/**
 * Binary `lOe(e,n)` @206125600+ (byte-verified):
 *   if(!(e instanceof It)||e.status!==400)return!1;
 *   try{let r=e.message?.match(/'([^']+)' does not support the `speed`
 *     parameter/)?.[1];return r!==void 0&&Mh(r)===Mh(n)}
 *   catch(r){return d(ee(r)),!1}
 *
 * True when the API rejected the `speed` parameter for THIS model family
 * (the quoted name in the message normalizes to the same family).
 */
export function isSpeedParamRejection(
  error: unknown,
  model: string,
): boolean {
  if (!(error instanceof APIError) || error.status !== 400) {
    return false
  }
  try {
    const rejected = error.message?.match(
      /'([^']+)' does not support the `speed` parameter/,
    )?.[1]
    return (
      rejected !== undefined &&
      modelFamilyKey(rejected) === modelFamilyKey(model)
    )
  } catch (error_) {
    logError(error_)
    return false
  }
}

/**
 * Binary `aBo(e)` (byte-verified): record the family, log the one-time line,
 * emit both signals. The debug log uses the RAW model string (not the family
 * key), matching the binary's `${e}`.
 */
export function markFastRejected(model: string): void {
  const family = modelFamilyKey(model)
  everFastRejectedModels.add(family)
  if (fastRejectedFallbackModels.has(family)) {
    return
  }
  fastRejectedFallbackModels.add(family)
  logForDebugging(
    `Fast mode rejected for fallback model ${model}; using standard speed for it this session`,
  )
  fallbackModelFastRejected.emit(model)
  fastRejectedFallbackModelsChanged.emit()
}

/**
 * Binary `rBt(e)` (byte-verified): is this model's family already forced to
 * standard speed this session? Drives the withRetry loop-head coercion
 * `if(Ke=!1,h.fastMode&&rBt(h.model))h.fastMode=!1`.
 */
export function isFastRejectedFallback(model: string): boolean {
  try {
    return fastRejectedFallbackModels.has(modelFamilyKey(model))
  } catch (error) {
    logError(error)
    return false
  }
}

/**
 * Binary `SYn(e)`: family present in either set. Gate for the new
 * speed-param-rejection retry branch — a model that was EVER fast-rejected
 * (even outside the fallback set) retries at standard speed instead of
 * failing the turn.
 */
export function hasEverOrFallbackFastRejected(model: string): boolean {
  try {
    const family = modelFamilyKey(model)
    return (
      everFastRejectedModels.has(family) ||
      fastRejectedFallbackModels.has(family)
    )
  } catch (error) {
    logError(error)
    return false
  }
}

/** Binary `n9e()`: clear the fallback set (session reset) + emit changed. */
export function clearFastRejectedFallbackModels(): void {
  if (fastRejectedFallbackModels.size === 0) {
    return
  }
  fastRejectedFallbackModels.clear()
  fastRejectedFallbackModelsChanged.emit()
}

/** Binary `lBo(e)`: subscribe to per-model fast-rejection events. */
export function onFallbackModelFastRejected(
  listener: (model: string) => void,
): () => void {
  return fallbackModelFastRejected.subscribe(listener)
}

/** Subscribe to fallback-set membership changes (UI re-render signal). */
export function onFastRejectedFallbackModelsChanged(
  listener: () => void,
): () => void {
  return fastRejectedFallbackModelsChanged.subscribe(listener)
}

/** Binary `Ll.reset()` — clears BOTH sets (test/session teardown). */
export function resetFastRejectionStore(): void {
  everFastRejectedModels.clear()
  fastRejectedFallbackModels.clear()
  fallbackModelFastRejected.clear()
  fastRejectedFallbackModelsChanged.clear()
}
