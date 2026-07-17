/**
 * CC 2.1.212 — fork session naming.
 *
 * Mirrors the official `uwd` symbol in the 2.1.212 binary (the fork-name
 * derivation used by `/fork` and `/subtask` via the shared `SZr` fork body,
 * where `s = uwd(e)` and `e` is the directive). The changelog (P2 #39):
 * "/fork [names] the copy after your prompt when the session has no title, so
 * the row is recognizable in the agent view." The fork's `custom-title` entry
 * is set to this name.
 *
 * The directive (`/fork <directive>`) is the ONLY input — `uwd` takes a single
 * string (the directive) and derives the name from it. There is no
 * first-prompt fallback inside `uwd`; the `/fork` command requires a directive
 * (see `fork.ts`), so the directive is always present when this runs.
 *
 * Algorithm (verbatim from `uwd` in the 2.1.212 native ELF):
 *
 *   e.trim().split(/\s+/).slice(0,3).join("-").toLowerCase()
 *    .replace(/[^a-z0-9-]/g,"").replace(/-+/g,"-").replace(/^-|-$/g,"")
 *    .slice(0,24) || "fork"
 *
 * i.e. take the first 3 whitespace-separated words, join with `-`, lowercase,
 * drop everything outside `[a-z0-9-]`, collapse runs of `-`, trim leading and
 * trailing `-`, cap at 24 chars, and fall back to `"fork"` when the result is
 * empty.
 */

/** Official `uwd` fallback when the directive yields no usable name. */
export const FORK_NAME_FALLBACK = 'fork'

/**
 * Derive the fork session's display name from the `/fork` directive.
 *
 * Verbatim mirror of the official `uwd` (single-argument; the directive is the
 * only input).
 *
 * @example deriveForkName('Deploy to staging') === 'deploy-to-staging'
 */
export function deriveForkName(directive: string): string {
  return (
    directive
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join('-')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || FORK_NAME_FALLBACK
  )
}
