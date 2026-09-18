import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../constants/prompts.js'

/**
 * CC 2.1.276 (ITEM S): "The `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker in a
 * custom `--system-prompt` is now honored for global prompt caching."
 *
 * A caller-supplied system prompt arrives as ONE array element, so
 * `splitSysPromptPrefix` (src/utils/api.ts) — which only recognizes the
 * boundary as a STANDALONE element — never found it and the whole custom
 * prompt fell into the non-cached dynamic bucket. v276 splits the custom
 * prompt at the boundary line before assembling the system-prompt array.
 *
 * Official v276 `sfe` (byte-extracted @198043890):
 *   `function sfe(e){let n=e.split("\n"),r=n.findIndex((h)=>h.trim()===$N);
 *    if(r===-1)return[e];
 *    let s=n.slice(0,r).join("\n")+"\n",g="\n"+n.slice(r+1).join("\n");
 *    return[...s.trim()?[s]:[],$N,...g.trim()?[g]:[]]}`
 * and its call site (@211903676):
 *   `systemPrompt:Is([...typeof s==="string"?sfe(s):Array.isArray(s)?s:L,…])`
 * (v274 baseline @211578729 was `typeof s==="string"?[s]:…` — no split.)
 *
 * The official applies `sfe` at EVERY custom-system-prompt embedding site
 * (@198045791 analysis, @211625532 analysisOnly, @211903676 main), so both
 * OCC embedding sites (QueryEngine.ts and utils/systemPrompt.ts
 * buildEffectiveSystemPrompt) must split. This module is the shared,
 * import-cycle-neutral home for the helper (QueryEngine re-exports it).
 *
 * Whitespace-only sides are dropped, so a boundary on the first/last line
 * yields two elements rather than an empty leading/trailing block. The first
 * boundary line wins (matches the official `findIndex`).
 */
export function splitCustomSystemPromptAtBoundary(prompt: string): string[] {
  const lines = prompt.split('\n')
  const boundaryIndex = lines.findIndex(
    line => line.trim() === SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  )
  if (boundaryIndex === -1) return [prompt]

  const staticPart = `${lines.slice(0, boundaryIndex).join('\n')}\n`
  const dynamicPart = `\n${lines.slice(boundaryIndex + 1).join('\n')}`
  return [
    ...(staticPart.trim() ? [staticPart] : []),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ...(dynamicPart.trim() ? [dynamicPart] : []),
  ]
}
