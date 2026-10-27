import { getIsRemoteMode } from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  effortOrdinal,
  getEffortEnvOverride,
  getSentEffortLevel,
  modelSupportsEffort,
  resolveAppliedEffort,
  type EffortValue,
} from '../effort.js'
import { findThinkingTriggerPositions, isUltrathinkEnabled } from '../thinking.js'
import {
  ULTRATHINK_TURN_EFFORT,
  modelSupportsPerTurnEffort,
  setTurnEffort,
} from './turnEffort.js'

/**
 * claude-code 2.1.311 triage-T4-sweep item 65 — "ultrathink" raises the
 * current turn's reasoning effort to `xhigh`.
 *
 * Official handler `ql` (v311 @257369783–257370243, byte-verified verbatim;
 * anchors inside it: `g("ultrathink_boost")` @257370056,
 * `a("tengu_ultrathink",{})` @257370078, `setTurnEffort("xhigh")` @257370113.
 * The v310 binary has zero `g("ultrathink_boost")` hits — this handler is new
 * in 2.1.311):
 *   `function ql(e,n,r,s){try{
 *      if(!(jnr(n,r)&&e.some((S)=>S.mode==="prompt"&&!S.isMeta
 *        &&S.shouldQuery!==!1&&Pd(S.origin)&&!S.textNotTyped
 *        &&eU(S.composerEnter)&&S.preExpansionValue!==void 0
 *        &&Nce(S.preExpansionValue).length>0)))return;
 *      let y=tn({type:"ultrathink_effort"},s);
 *      return g("ultrathink_boost"),a("tengu_ultrathink",{}),
 *        qbt(et()).setTurnEffort("xhigh"),
 *        {layer:{kind:"effort",effort:"xhigh"},reminder:y}
 *    }catch(h){l(h);return}}`
 *
 * Official gate `REt`/`jnr` (v311 @243587988 / @243588108, byte-verified):
 *   `function ce(e){return QS(e)&&!Rt()&&dA()===void 0}`
 *   `function Zqr(e){return fot(e,Je(e))}`
 *   `function REt(e,n){return ITt()&&!_e()&&ce(e)&&Zqr(e)
 *      &&typeof _S(e,n)==="string"&&_S(e,n,{turnEffort:"xhigh"})==="xhigh"}`
 *   `function jnr(e,n){return REt(e,n)&&h(AH(e,n))<h("xhigh")}`
 *
 * OCC reductions (each documented at the clause it replaces):
 *   - `_e()` (`!host.launchOptions.isInteractive()`) — OCC only produces the
 *     ultrathink attachment on the interactive prompt-submit path, so the
 *     non-interactive exclusion is structural rather than a runtime check.
 *   - `fot`'s `!mTt(Ns())` 1M-beta exclusion — see turnEffort.ts.
 *   - `ql`'s queued-composer scan (`e.some(...)`) — OCC's seam receives the
 *     submitted prompt text directly, so the `Nce(...).length>0` clause is
 *     applied to that text.
 *   - `g("ultrathink_boost")` is official's frontend-only channel; OCC has a
 *     single analytics sink, so the event keeps its official name and goes
 *     through `logEvent` (OCC already logs bare non-`tengu_` names, e.g.
 *     `api_request`, `cli_ultrareview`).
 *   - The `reminder` half of `ql`'s return value is OCC's existing
 *     `ultrathink_effort` attachment (see utils/attachments.ts).
 */

/** Official frontend event name (v311 @257370059, @257665136). */
const ULTRATHINK_BOOST_EVENT = 'ultrathink_boost'

/**
 * The model/session half of official `jnr` — everything except the
 * ultrathink feature flag and the prompt text.
 *
 * Returns true when the turn effort may be raised to `xhigh`: the model
 * supports effort at all, the session is local, no `CLAUDE_CODE_EFFORT_LEVEL`
 * override is pinning the effort, the model has the `per_turn_effort`
 * capability, `xhigh` actually survives resolution for that model, and the
 * effort currently in force is strictly below `xhigh`.
 */
export function canBoostTurnEffortForUltrathink(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): boolean {
  // official `ce(e)` = `QS(e) && !Rt() && dA()===void 0`
  if (!modelSupportsEffort(model)) {
    return false
  }
  if (getIsRemoteMode()) {
    return false
  }
  if (getEffortEnvOverride() !== undefined) {
    return false
  }
  // official `Zqr(e)` = `fot(e, Je(e))` — the per_turn_effort capability
  if (!modelSupportsPerTurnEffort(model)) {
    return false
  }
  // official `_S(e,n,{turnEffort:"xhigh"})==="xhigh"` — xhigh must survive
  // resolution (the settings cap / capability downgrade may clamp it away)
  const boosted = resolveAppliedEffort(
    model,
    appStateEffortValue,
    ULTRATHINK_TURN_EFFORT,
  )
  if (boosted !== ULTRATHINK_TURN_EFFORT) {
    return false
  }
  // official `h(AH(e,n)) < h("xhigh")` — headroom below xhigh. Resolved with
  // an explicit `null` turn effort so a stale boost from the previous turn
  // cannot mask its own re-qualification (`undefined` would re-trigger the
  // resolver's live-slot default).
  const current = getSentEffortLevel(model, appStateEffortValue, null) ?? 'high'
  return effortOrdinal(current) < effortOrdinal(ULTRATHINK_TURN_EFFORT)
}

/**
 * Full official `jnr` + the `Nce(preExpansionValue).length>0` clause of `ql`.
 *
 * The trigger positions use the 2.1.311 `da()`-filtered scanner, so a quoted
 * or path-like "ultrathink" does not raise the effort (item 66).
 */
export function shouldBoostTurnEffortForUltrathink(
  text: string,
  model: string,
  appStateEffortValue: EffortValue | undefined,
): boolean {
  // official `ITt()`
  if (!isUltrathinkEnabled()) {
    return false
  }
  // official `Nce(S.preExpansionValue).length>0`
  if (findThinkingTriggerPositions(text).length === 0) {
    return false
  }
  return canBoostTurnEffortForUltrathink(model, appStateEffortValue)
}

/**
 * Official `qbt(et()).setTurnEffort("xhigh")` + `g("ultrathink_boost")`.
 *
 * Called once per prompt submit. The slot is cleared when the prompt does not
 * qualify — OCC's stand-in for official's turn-end `finally` reset
 * (`He.setTurnEffort(null,null)` @256711626), which OCC cannot hook because
 * it has no per-agent turn lifecycle object.
 *
 * @returns true when this turn's effort was raised to `xhigh`.
 */
export function applyUltrathinkTurnEffortBoost(
  text: string,
  model: string,
  appStateEffortValue: EffortValue | undefined,
): boolean {
  const boosted = shouldBoostTurnEffortForUltrathink(
    text,
    model,
    appStateEffortValue,
  )
  setTurnEffort(boosted ? ULTRATHINK_TURN_EFFORT : undefined)
  if (boosted) {
    logEvent(ULTRATHINK_BOOST_EVENT, {})
  }
  return boosted
}
