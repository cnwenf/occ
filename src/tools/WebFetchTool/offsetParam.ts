import { WEB_FETCH_TOOL_NAME } from './prompt.js'

/**
 * Item #018a (always-on `offset` plumbing) — verbatim ports of the official
 * Claude Code 2.1.292/293 WebFetch strings/helpers (see
 * docs/gap-research-293/webfetch-018-forensics.md §1.2/§2.13/§2.15):
 *
 *   T2t offset param @213374410:
 *     offset:pO(E().int().nonnegative().optional()).describe("Character position in the page text to start reading from. Use it to read on through a page too long for one call, with the value the previous result gave.")
 *   pO/XMe numeric-string coercion @211419386:
 *     function XMe(e){if(typeof e==="string"){let n=e.trim();
 *       if(/^[-+]?\d+(\.\d+)?$/.test(n)){let r=Number(n);if(Number.isFinite(r))return r}}return e}
 *   past_end branch @213387569:
 *     zn=`Nothing left to read from offset ${H}: this page's text is ${Ut.length} characters long.`
 *   M2t continuation message @213373984:
 *     function M2t(e){return` — to read on, call ${dr} again with the same url and offset: ${e}`}
 *   contentLead (secondary_model branch) @213387569:
 *     H>0?`The content below is one part of a longer page: it starts ${H} characters into the page's ${Ut.length}.\n`:""
 *   coverage note (secondary_model branch) @213387569:
 *     zn+=`\n\n[${dr} note: this page's text is ${Ut.length} characters long and the answer above covers only characters ${Ln} to ${Eo}; the final ${Ut.length-Eo} were not read${M2t(Eo)}.]`
 *
 * NOTE (item #018b, STAGED): the gated `agent_raw` verbatim reader (`LLo`) —
 * which fires only inside the built-in `web-fetch` subagent behind
 * CLAUDE_CODE_WEB_FETCH_AGENT / tengu_clever_orbit (default false) — reuses
 * `M2t` for its own truncation notes. That reader is NOT ported; these
 * helpers serve the always-on main-agent (secondary-model) path only.
 */

/** Official `T2t` offset describe text — verbatim (@213374410). */
export const OFFSET_DESCRIBE =
  'Character position in the page text to start reading from. Use it to read on through a page too long for one call, with the value the previous result gave.'

/**
 * Official `XMe` numeric-string coercion (@211419386) — the model sometimes
 * quotes numbers (`"offset":"500"`); strings matching `/^[-+]?\d+(\.\d+)?$/`
 * after trim are coerced to finite numbers, everything else passes through
 * for the inner zod schema to reject. Used via z.preprocess (official `pO`).
 */
export function coerceNumericString(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed)
      if (Number.isFinite(num)) {
        return num
      }
    }
  }
  return value
}

/** Official past_end branch message (§1.2, branch 2) — verbatim template. */
export function makePastEndMessage(
  offset: number,
  totalLength: number,
): string {
  return `Nothing left to read from offset ${offset}: this page's text is ${totalLength} characters long.`
}

/** Official `M2t` continuation message (@213373984) — verbatim template. */
export function continuationMessage(offset: number): string {
  return ` — to read on, call ${WEB_FETCH_TOOL_NAME} again with the same url and offset: ${offset}`
}

/**
 * Official `contentLead` for the secondary-model branch (§1.2, branch 4):
 * passed to the summarizer so it knows the content is a mid-page slice.
 * Includes the official trailing newline.
 */
export function makeContentLead(offset: number, totalLength: number): string {
  return `The content below is one part of a longer page: it starts ${offset} characters into the page's ${totalLength}.\n`
}

/**
 * Official coverage note appended to the secondary-model answer (§1.2,
 * branch 4) when the answer covered only characters `coveredStart`..
 * `coveredEnd` of a `totalLength`-character page:
 *
 *   `\n\n[${dr} note: this page's text is ${Ut.length} characters long and the answer above covers only characters ${Ln} to ${Eo}; the final ${Ut.length-Eo} were not read${M2t(Eo)}.]`
 */
export function makeCoverageNote(
  totalLength: number,
  coveredStart: number,
  coveredEnd: number,
): string {
  return `\n\n[${WEB_FETCH_TOOL_NAME} note: this page's text is ${totalLength} characters long and the answer above covers only characters ${coveredStart} to ${coveredEnd}; the final ${totalLength - coveredEnd} were not read${continuationMessage(coveredEnd)}.]`
}
