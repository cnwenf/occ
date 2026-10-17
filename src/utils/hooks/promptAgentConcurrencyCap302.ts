/**
 * CC 2.1.302 (#035) — "Changed prompt and agent hooks so that at most 12 of
 * one event run at a time; the rest wait their turn."
 *
 * Official binary evidence (2.1.302 linux-x64 ELF @246248866, NEW in v302 —
 * v301 lacks ant/Iee/ZRn entirely at the same site):
 *
 *   var ant=12;
 *   function Iee(e){return e.type==="prompt"||e.type==="agent"}
 *   function ZRn(e,n){let r=e.filter((h,y)=>n(y));
 *     if(r.length<=1)return oJt(e);                    // oJt = generator-merge(gens, cap)
 *     let s=Promise.resolve();
 *     return oJt([...e.filter((h,y)=>!n(y)),           // non-prompt/agent: uncapped merge
 *       oJt(r.map(async function*(h){s=s.then(Yg),await s,yield*h}),ant)])}  // capped at 12, staggered starts
 *
 *   Call site @246372863:
 *     let Lr=ZRn(Mo,(Eo)=>Iee(Kn[Eo].hook)) — the index predicate reads the
 *     matched hook's type for each generator slot.
 *
 * Porting notes:
 * - `oJt` = OCC's `all(generators, concurrencyCap=Infinity)` in
 *   `src/utils/generators.ts` (already cap-aware — same generator-merge).
 * - `Yg` = microtask/yield deferral; OCC has no existing helper, so the
 *   `() => Promise.resolve()` equivalent is used (spec-sanctioned).
 * - Partitioning uses the original-array index predicate, preserving each
 *   part's relative order (official `e.filter((h,y)=>n(y))` semantics).
 * - Keepalive hold scaling (official `lnt`: `K=Math.max(1,Math.ceil(H/ant))`
 *   waves, budget `s=Math.min(w*K+s4r,tCn)` with s4r=60000, tCn=1200000) is
 *   NOT ported: OCC has no "hook-dispatch-hold" keepalive analogue
 *   (grep-verified across src/), so there is no budget to scale.
 */

import { all } from '../generators.js'

/**
 * Official `ant` — verbatim constant. At most this many prompt/agent hooks
 * of a single hook-event dispatch execute concurrently; the rest wait their
 * turn.
 */
export const HOOK_PROMPT_AGENT_CONCURRENCY_CAP = 12

/**
 * Official `Iee` — the hook types routed through the capped merge.
 */
export function isPromptOrAgentHook(hook: { type: string }): boolean {
  return hook.type === 'prompt' || hook.type === 'agent'
}

/** Official `Yg` — microtask deferral staggering the capped stream's starts. */
const yieldMicrotask = (): Promise<void> => Promise.resolve()

/**
 * Official `ZRn`. Merge per-event hook generators, capping only the
 * prompt/agent subset:
 * - ≤1 capped generator → plain uncapped merge (identical to pre-v302
 *   behavior).
 * - Otherwise → outer uncapped merge of [...non-capped generators, inner
 *   capped merge]. The inner merge caps at
 *   HOOK_PROMPT_AGENT_CONCURRENCY_CAP and each capped generator is wrapped
 *   in a shared promise chain (`s = s.then(Yg); await s`) that staggers
 *   starts, matching the official shape exactly.
 *
 * @param generators per-hook result generators, in matched-hook order
 * @param isCappedAtIndex official index predicate `n(y)` — true when the
 *   generator at that index belongs to a prompt/agent hook
 */
export function mergeHookGeneratorsWithPromptAgentCap<A>(
  generators: AsyncGenerator<A, void>[],
  isCappedAtIndex: (index: number) => boolean,
): AsyncGenerator<A, void> {
  const capped = generators.filter(
    (_generator, index) => isCappedAtIndex(index),
  )
  if (capped.length <= 1) {
    return all(generators)
  }
  let startChain = Promise.resolve()
  return all([
    ...generators.filter((_generator, index) => !isCappedAtIndex(index)),
    all(
      capped.map(async function* (generator) {
        startChain = startChain.then(yieldMicrotask)
        await startChain
        yield* generator
      }),
      HOOK_PROMPT_AGENT_CONCURRENCY_CAP,
    ),
  ])
}
