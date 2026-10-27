import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

/**
 * claude-code 2.1.311 triage-T4-sweep item 65 — per-turn reasoning effort.
 *
 * Official keeps the turn effort on the session state and emits it to the UI:
 *   `function qbt(e){return{...,setTurnEffort(t,n=null){
 *      F2e.emit({kind:"agent-turn-effort",agentId:e,turnEffort:t,turnModel:n})}}}`
 *                                                       (v311 @248426789)
 * and clears it in the turn's `finally`:
 *   `finally{...,He.setTurnEffort(null,null),...}`      (v311 @256711626)
 *
 * The value that reaches the API is computed inline in `buildUserMessage`
 * (v311 @257665029; `...fe&&{effort:fe}` @257665292):
 *   `let fe = xe && eU(Ke) && q!==void 0 && Nce(q).length>0
 *             && jnr(n.options.mainLoopModel, yg(n)) ? "xhigh" : void 0;
 *    if(fe) g("ultrathink_boost");
 *    ...hs({... ...fe&&{effort:fe} ...})`
 *
 * OCC reduction: OCC has no per-message `effort` field and no agent-status
 * emitter, so the turn effort lives in a module-scoped slot that
 * `resolveAppliedEffort` consults (the same precedence position official's
 * `_S` gives `turnEffort`). The slot is written exactly once per prompt
 * submit by `applyUltrathinkTurnEffortBoost`, which clears it when the new
 * prompt does not qualify — OCC's stand-in for the official `finally` reset.
 */

/** The level official raises the turn to (`{layer:{kind:"effort",effort:"xhigh"}}`). */
export const ULTRATHINK_TURN_EFFORT: EffortLevel = 'xhigh'

let currentTurnEffort: EffortLevel | undefined

/** Official `setTurnEffort(t)` — pass undefined to clear (official `null`). */
export function setTurnEffort(level: EffortLevel | undefined): void {
  currentTurnEffort = level
}

/** Official read side of the `agent-turn-effort` slot. */
export function getTurnEffort(): EffortLevel | undefined {
  return currentTurnEffort
}

/**
 * Official `fot(e,n){return Ywn(e,n)&&!mTt(Ns())}` (v311 @242146606) —
 * `Ywn` is the `per_turn_effort` capability probe, `mTt(Ns())` is the
 * "a 1M-context beta is latched on this conversation" exclusion.
 *
 * `Ywn` (v311 @242146277):
 *   `function Ywn(e,n){if(!b_()||!Gq(Nd(e)))return!1;
 *     if(AS(n,"per_turn_effort",e)===!1)return!1;
 *     return jTn(n,"per_turn_effort",e)===!0||QS?.(n,e)===!0}`
 *
 * OCC reduction: the capability probe is the catalog `per_turn_effort` entry.
 * The v311 model registry lists it for exactly four models (byte-verified —
 * each offset is the `"per_turn_effort"` string inside that entry's
 * `capabilities` array; the fifth binary hit @239178434 is the capability-NAME
 * enum `$ts=[…]`, not a model, so this list is complete):
 *   claude-haiku-5-5  @239158609
 *   claude-sonnet-5-5 @239163899
 *   claude-opus-5-5   @239170412
 *   claude-fable-5-1  @239172488
 * No default-true fallback: official requires an explicit catalog entry, so
 * an unknown model string does not gain per-turn effort. The 1M-beta
 * exclusion is dropped — OCC has no sticky-beta conversation latch to read.
 */
export function modelSupportsPerTurnEffort(model: string): boolean {
  const canonical = model.toLowerCase()
  return PER_TURN_EFFORT_MODELS.some(marker => canonical.includes(marker))
}

/** Catalog markers for the `per_turn_effort` capability (see docblock). */
const PER_TURN_EFFORT_MODELS = [
  'opus-5-5',
  'sonnet-5-5',
  'haiku-5-5',
  'fable-5-1',
] as const
