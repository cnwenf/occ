/**
 * Defensive validation for gitignore-style patterns fed to the `ignore` library.
 *
 * Ported from claude-code 2.1.207 changelog #9:
 * "Fixed malformed bracket patterns in rules globs / skill paths / `.ignore` /
 * `.worktreeinclude`"
 *
 * The official binary validates each pattern by probing
 * `ignore().add([pattern]).test("probe")` inside a try/catch BEFORE adding it
 * to the real matcher. Patterns that throw are filtered out and a warning is
 * logged. This prevents malformed bracket patterns (e.g. `[` unclosed, `[abc`
 * unclosed character class) from crashing the process or mis-matching.
 *
 * Four call sites use this validation, each tagged with a category that
 * appears in the warning message and telemetry:
 *   - `claudemd_rule_globs`  — `.claude/rules/*.md` frontmatter `paths`/`globs`
 *   - `skill_paths`          — skill frontmatter `paths`
 *   - `file_suggestions_ignore` — `.ignore` / `.rgignore` files
 *   - `worktreeinclude`      — `.worktreeinclude` file
 */
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'

import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from './debug.js'

export type IgnorePatternSite =
  | 'claudemd_rule_globs'
  | 'skill_paths'
  | 'file_suggestions_ignore'
  | 'worktreeinclude'

/**
 * Splits raw file content into non-empty lines, matching the binary's `c9n`
 * helper: `content.split(/\r?\n/).filter(Boolean)`.
 */
export function splitIgnorePatternLines(content: string): string[] {
  return content.split(/\r?\n/).filter(Boolean)
}

/**
 * Tests whether a single gitignore-style pattern compiles without throwing.
 *
 * Mirrors the binary's `Izc` function:
 * ```js
 * try { ignore().add([pattern]).test("probe"); return null }
 * catch (e) { return e instanceof Error ? e.message : String(e) }
 * ```
 *
 * @returns `null` if the pattern is valid, or the error message if it throws.
 */
export const validateIgnorePattern = memoize(
  (pattern: string): string | null => {
    try {
      // The probe path "probe" is a valid relative path so that checkPath()
      // inside ignore().test() does not throw for path-related reasons; only
      // pattern-compilation errors (e.g. new RegExp() in IgnoreRule._make)
      // surface here.
      ignore().add([pattern]).test('probe')
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  },
)

/**
 * Logs a warning for an uncompilable pattern and fires telemetry.
 *
 * Mirrors the binary's `heg` function:
 * ```
 * [${category}] gitignore-style pattern failed to compile (${errMsg});
 * treating it as matching nothing: ${pattern}
 * ```
 * Telemetry: `tengu_uncompilable_ignore_pattern` with `{ site: category }`.
 */
const logUncompilablePattern = memoize(
  (category: IgnorePatternSite, pattern: string): void => {
    const errorMessage = validateIgnorePattern(pattern)
    logForDebugging(
      `[${category}] gitignore-style pattern failed to compile (${errorMessage}); treating it as matching nothing: ${pattern}`,
      { level: 'warn' },
    )
    logEvent('tengu_uncompilable_ignore_pattern', { site: category })
  },
  (category: IgnorePatternSite, pattern: string) => `${category}\x00${pattern}`,
)

/**
 * Filters an array of gitignore-style patterns, removing any that fail to
 * compile. Each removed pattern logs a warning tagged with `category`.
 *
 * Mirrors the binary's `Itt` function:
 * ```js
 * function Itt(patterns, category) {
 *   return patterns.filter(p => {
 *     if (validateIgnorePattern(p) === null) return true
 *     logUncompilablePattern(category, p)
 *     return false
 *   })
 * }
 * ```
 *
 * @param patterns Array of individual pattern strings (NOT raw multi-line
 *   content). Use `splitIgnorePatternLines()` first for file-content inputs.
 * @param category The call-site category for warning/telemetry tagging.
 * @returns A new array containing only patterns that compile without error.
 */
export function filterValidIgnorePatterns(
  patterns: string[],
  category: IgnorePatternSite,
): string[] {
  return patterns.filter(pattern => {
    if (validateIgnorePattern(pattern) === null) {
      return true
    }
    logUncompilablePattern(category, pattern)
    return false
  })
}
