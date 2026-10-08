import { logForDebugging } from './debug.js'

/**
 * Shared name-safety limits/helpers — ported verbatim from the official
 * Claude Code 2.1.292 binary (cluster-c-h-carryover §C6).
 *
 * Official shared constant (@207344922): `iY=256`.
 * Official frontmatter ignorer M4t (@207586013):
 *
 *   function M4t(e,n){if(e==null)return;let r=String(e);if(r.length<=iY)return r;
 *     t(`Frontmatter "name" of ${n} is over ${iY} characters - ignoring it`,{level:"warn"});return}
 *
 * M4t is the "ignore + warn" lane used by the skill loader, plugin agent
 * loader, and plugin command loader: an over-long frontmatter `name` is
 * DROPPED (returns undefined) so the caller falls back to its own default
 * (filename stem / caller-supplied name), and a warning is logged. This is
 * distinct from the agent loader's hard-reject lane (BFo/EXn), which lives in
 * loadAgentsDir.ts and returns the `names must be at most 256 characters`
 * error rather than silently ignoring.
 */

/** Official `iY` — the maximum accepted length for a frontmatter `name`. */
export const NAME_MAX_LENGTH = 256

/**
 * M4t equivalent. Validates a frontmatter `name` value against the 256-char
 * limit.
 *
 * - `null`/`undefined` → `undefined` (no warning; caller falls back).
 * - value whose `String()` form is `<= 256` chars → that string.
 * - value whose `String()` form is `> 256` chars → `undefined` + a `warn`
 *   log with the official message shape, so the caller falls back.
 *
 * @param value  raw frontmatter `name` value (unknown type; coerced via String)
 * @param label  human-readable owner of the name, e.g. `skill <name>` or
 *               `plugin agent <path>` — interpolated verbatim into the warning
 */
export function validateFrontmatterName(
  value: unknown,
  label: string,
): string | undefined {
  if (value == null) {
    return undefined
  }
  const name = String(value)
  if (name.length <= NAME_MAX_LENGTH) {
    return name
  }
  logForDebugging(
    `Frontmatter "name" of ${label} is over ${NAME_MAX_LENGTH} characters - ignoring it`,
    { level: 'warn' },
  )
  return undefined
}
