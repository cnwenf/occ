/**
 * 2.1.293 (OCC-111, Haiku 5.5 launch): early-stopping guidance section.
 *
 * Ported verbatim from the official 2.1.293 linux-x64 ELF (byte-verified):
 *
 *   function ULo(e,n){
 *     if(!DN("haiku_5_5_early_stopping_guidance",e,n))return null;
 *     return Fr("tengu_idempotent_wolf",!0)?HLo:null
 *   }
 *
 * and wired at v293 into the dynamic system-prompt sections:
 *
 *   ap("heron_brook",()=>BLo()??ULo(h,s))
 *
 * Mapping / divergences:
 * - `DN(capability, model, ...)` ≡ the model-capability check. The v293
 *   catalog entry for claude-haiku-5-5 (@204773604) lists
 *   "haiku_5_5_early_stopping_guidance" in `capabilities`. OCC has no
 *   capability registry; per house convention (see effort.ts / betas.ts /
 *   advisor.ts) the canonical-id substring check stands in for it.
 * - `Fr(flag, default)` ≡ getFeatureValue_CACHED_MAY_BE_STALE. OCC's
 *   GrowthBook is a stub returning the default, so the flag resolves `true`
 *   (same behavior as the official with GrowthBook disabled).
 * - `BLo()` (client-data override arm of heron_brook) is NOT applicable in
 *   OCC — the client-data override channel does not exist here, so the `??`
 *   fallback chain degenerates to ULo alone. STAGED as N/A.
 * - The section is NOT lean-gated in the official (only capability + flag),
 *   so it is wired outside the `...(lean ? [] : [...])` spread in prompts.ts.
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getCanonicalName } from '../utils/model/model.js'

/** Official GrowthBook flag, byte-verified (`Fr("tengu_idempotent_wolf",!0)`). */
export const EARLY_STOPPING_GUIDANCE_FLAG = 'tengu_idempotent_wolf'

/** Official `HLo` — verbatim, 5 paragraphs (byte-verified against the v293 ELF). */
export const HAIKU_5_5_EARLY_STOPPING_GUIDANCE = `The reasoning effort setting changes how much you think before you act. It does not change how much of the request you are expected to finish. A turn lasts as long as you keep working, so a large task can be finished in the turn where it was asked. The size of a task is not a reason to check in first.

Ending your turn stops all work until the user replies, and they may be away for a while. If you stop before changing anything, they come back to the same code they left, plus a message to read and answer. End your turn when the request is done or nothing is left that you can do without them.

Ask before you start only when you cannot name the most likely reading of the request. If you can name it, act on it, and say in your final message which reading you took. The other reason to ask first is that the whole task depends on a fact, a file, or access that only they have. Their approval of a choice you could make yourself is not one of these. Actions that are hard to reverse or outward-facing still need their confirmation. If they say they want to approve something before you go on, such as a plan, stop there. Words that only set an order, such as "plan, then build", are not a stopping point. Do each step and keep going. If they are asking a question or still deciding between options, they want your answer, not a change. If they also asked for work, answer and then do it.

The user can inspect and undo edits to files in the working tree. Such edits are not hard-to-reverse or outward-facing actions, unless they would overwrite changes the user has in progress. That leaves the open choices to you: how to build the change, how to split it up, how to handle a case the request did not cover. Pick what you would recommend, and keep to what the user wrote where they were specific. List your choices in the final message so the user can redirect you. Start editing once you know the first change. A design worked out in files persists, while a long stretch of thinking can be cut off and lost.

When one part of a task is blocked, unclear, or apparently wrong, the rest usually is not. If you suspect a step will fail, try it before you report it. Finish everything that does not depend on the stuck part, and open your final message with what is stuck. Finished parts are useful to the user even when the whole task is not done. Setting up the project so you can build and test it, such as installing its declared dependencies, is part of the work. If the code still cannot be built or run here, say so and make the changes you can verify by reading. If you investigate a problem and cannot find the cause, report what you ruled out and what would settle it. A question at the end of finished work costs the user one reply, the same as a question asked before any work.`

/**
 * Official `DN("haiku_5_5_early_stopping_guidance", model, ...)` capability
 * check: only claude-haiku-5-5 carries the capability in the v293 catalog.
 * Canonicalized so provider-dated ids and `[1m]` variants still match.
 */
function hasEarlyStoppingGuidanceCapability(model: string): boolean {
  return getCanonicalName(model).includes('claude-haiku-5-5')
}

/**
 * Whether the early-stopping guidance is active for this model: the official
 * `ULo` gate is capability AND flag (short-circuit — the flag is only
 * consulted for capable models). OCC's GrowthBook stub returns the default
 * (`true`), mirroring the official with GrowthBook disabled.
 */
export function isEarlyStoppingGuidanceEnabled(model: string): boolean {
  return (
    hasEarlyStoppingGuidanceCapability(model) &&
    getFeatureValue_CACHED_MAY_BE_STALE(EARLY_STOPPING_GUIDANCE_FLAG, true)
  )
}

/**
 * Official `ULo(model, ...)` — the heron_brook section body. Returns the
 * guidance when the model passes the capability + flag gate, otherwise null.
 */
export function getEarlyStoppingGuidanceSection(
  model: string,
): string | null {
  return isEarlyStoppingGuidanceEnabled(model)
    ? HAIKU_5_5_EARLY_STOPPING_GUIDANCE
    : null
}
