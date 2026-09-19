/**
 * CC 2.1.277 C2: "Fixed an issue where malformed customApiKeyResponses in
 * ~/.claude.json could hang or error interactive startup for ANTHROPIC_API_KEY
 * users." A hand-edited/corrupted value (`null`, `{}`, a number, mixed-type
 * arrays) previously reached destructuring / `.includes` and threw the v276
 * crash string "Cannot destructure property 'approved' from null or undefined
 * value" (or hung the approval flow).
 *
 * Official v277 mechanism (byte-verified @0xb980a1c in the v277 ELF):
 *
 *   function HR(e){let n=e.customApiKeyResponses;return{
 *     approved:fa(n?.approved),rejected:fa(n?.rejected)}}
 *   function kio(e,n){let{approved:r,rejected:s}=HR(e);
 *     if(r.includes(n))return"approved";
 *     if(s.includes(n))return"rejected";return"new"}
 *
 * where `fa` is the shared string-array normalizer (see
 * utils/configStringArray.ts). Every v277 read AND write site routes through
 * `HR` first, so the write paths normalize BEFORE merging and a malformed
 * persisted value self-heals on the next save:
 *   - auth save: `{...h,customApiKeyResponses:{approved:y.includes(g)?y:[...y,g],rejected:T}}`
 *   - logout:    `if(i.customApiKeyResponses!==void 0)i.customApiKeyResponses={approved:[],rejected:HR(i).rejected}`
 *   - settings toggle: `{approved:[...E,y],rejected:A}` / `{approved:E,rejected:[...A,y]}`
 *     (E/A = HR-derived lists filtered of the truncated key)
 *   - ApproveApiKey: yes → `{approved:[...Y,a],rejected:L}`, no → `{approved:O,rejected:[...V,a]}`
 *
 * Follows the OCC-130 normalize-on-read pattern established by
 * utils/mcpNeedsAuthNotice.ts.
 */
import { normalizeConfigStringArray } from './configStringArray.js'

/** Normalized shape — both lists are always concrete string[]. */
export type CustomApiKeyResponses = {
  approved: string[]
  rejected: string[]
}

/**
 * Structural config view. The field is typed loosely (`unknown`) because the
 * whole point of this module is that the persisted value may be ANY malformed
 * shape (null / number / string / mixed arrays) despite GlobalConfig's
 * `{approved?: string[]; rejected?: string[]}` declaration.
 */
export type ConfigWithCustomApiKeyResponses = {
  customApiKeyResponses?: unknown
}

/**
 * Official `HR` (exported in the binary as `customApiKeyResponsesOf`).
 * Optional-chains the container then normalizes each list via `fa`: a
 * missing/null/primitive container yields `{approved: [], rejected: []}`;
 * mixed arrays keep only their string entries. Never throws.
 */
export function customApiKeyResponsesOf(
  config: ConfigWithCustomApiKeyResponses,
): CustomApiKeyResponses {
  const responses = config.customApiKeyResponses as
    | { approved?: unknown; rejected?: unknown }
    | null
    | undefined
  return {
    approved: normalizeConfigStringArray(responses?.approved),
    rejected: normalizeConfigStringArray(responses?.rejected),
  }
}

/**
 * Official `kio` (exported in the binary as `customApiKeyStatusOf`) — the
 * approval status of a truncated API key, computed over the NORMALIZED lists.
 */
export function customApiKeyStatusOf(
  config: ConfigWithCustomApiKeyResponses,
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const { approved, rejected } = customApiKeyResponsesOf(config)
  if (approved.includes(truncatedApiKey)) return 'approved'
  if (rejected.includes(truncatedApiKey)) return 'rejected'
  return 'new'
}
