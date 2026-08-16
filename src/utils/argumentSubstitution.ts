/**
 * Utility for substituting $ARGUMENTS placeholders in skill/command prompts.
 *
 * Supports:
 * - $ARGUMENTS - replaced with the full arguments string
 * - $ARGUMENTS[0], $ARGUMENTS[1], etc. - replaced with individual indexed arguments
 * - $0, $1, etc. - shorthand for $ARGUMENTS[0], $ARGUMENTS[1]
 * - Named arguments (e.g., $foo, $bar) - when argument names are defined in frontmatter
 *
 * Arguments are parsed using shell-quote for proper shell argument handling.
 *
 * 2.1.233 alignment (OCC-95): the substitution core follows the official
 * linux-x64 binary function `sCt` (byte-verified). Compared to the pre-233
 * implementation this ports the official security/robustness rework:
 *
 * - Sentinel-char shielding: substituted values have every `$` replaced with
 *   a U+FFFF sentinel and are wrapped in U+FFFE boundary chars BEFORE later
 *   substitution passes run, so a value like `hi $0 bye` can never be
 *   re-expanded by the `$n` / `$ARGUMENTS` passes (the 2.1.233 fix for
 *   argument re-expansion). Sentinels are restored/stripped at the very end.
 * - Sentinel-forgery sanitization: any U+FFFF/U+FFFE already present in the
 *   template or values is replaced with U+FFFD up front.
 * - `\$` escaping is scoped: only `\$` sequences that precede a substitution
 *   marker (digit, ARGUMENTS, or a declared argument name) are shielded, and
 *   only when not themselves preceded by a backslash (`\\$0` keeps the marker
 *   live). Matches the official escape pass exactly.
 * - Named arguments are regex-escaped and substituted longest-name-first.
 * - The append gate is the substitution flag, not string equality: a template
 *   whose placeholders ALL missed still gets `\nARGUMENTS: <args>` appended
 *   (official behavior; diverged from the pinned 2.1.210 test expectation).
 *
 * The official `sCt` takes an optional 5th transform callback applied to each
 * substituted value (after sentinel sanitization, before `$` shielding —
 * binary order: `Ckn + (o ? o(d) : d).replaceAll("$", vLr) + Ckn` where `d`
 * is the sanitized value). The 2.1.233 binary passes its `Q9`
 * shell-marker escape there for skill/command/plugin argument substitution
 * (plus `Z7t(Q9)` for MCP-untrusted sources); see
 * ../utils/promptShellExecution.ts. OCC wires the same call sites.
 */

import { tryParseShellCommand } from './bash/shellQuote.js'
import { escapeRegExp } from './stringUtils.js'

// 2.1.233 binary sCt sentinel chars — Unicode noncharacters used as in-band
// substitution tokens. User-supplied template/value occurrences are replaced
// with U+FFFD up front so sentinels cannot be forged.
const SHIELDED_DOLLAR = '\uFFFF' // binary vLr — stands in for a literal $
const VALUE_BOUNDARY = '\uFFFE' // binary Ckn — wraps each substituted value
const SENTINEL_REPLACEMENT = '\uFFFD' // binary replacement for forged sentinels

/**
 * Parse an arguments string into an array of individual arguments.
 * Uses shell-quote for proper shell argument parsing including quoted strings.
 *
 * Examples:
 * - "foo bar baz" => ["foo", "bar", "baz"]
 * - 'foo "hello world" baz' => ["foo", "hello world", "baz"]
 * - "foo 'hello world' baz" => ["foo", "hello world", "baz"]
 */
export function parseArguments(args: string): string[] {
  if (!args || !args.trim()) {
    return []
  }

  // Return $KEY to preserve variable syntax literally (don't expand variables)
  const result = tryParseShellCommand(args, key => `$${key}`)
  if (!result.success) {
    // Fall back to simple whitespace split if parsing fails
    return args.split(/\s+/).filter(Boolean)
  }

  // Filter to only string tokens (ignore shell operators, etc.)
  return result.tokens.filter(
    (token): token is string => typeof token === 'string',
  )
}

/**
 * Parse argument names from the frontmatter 'arguments' field.
 * Accepts either a space-separated string or an array of strings.
 *
 * Examples:
 * - "foo bar baz" => ["foo", "bar", "baz"]
 * - ["foo", "bar", "baz"] => ["foo", "bar", "baz"]
 */
export function parseArgumentNames(
  argumentNames: string | string[] | undefined,
): string[] {
  if (!argumentNames) {
    return []
  }

  // Filter out empty strings and numeric-only names (which conflict with $0, $1 shorthand)
  const isValidName = (name: string): boolean =>
    typeof name === 'string' && name.trim() !== '' && !/^\d+$/.test(name)

  if (Array.isArray(argumentNames)) {
    return argumentNames.filter(isValidName)
  }
  if (typeof argumentNames === 'string') {
    return argumentNames.split(/\s+/).filter(isValidName)
  }
  return []
}

/**
 * Generate argument hint showing remaining unfilled args.
 * @param argNames - Array of argument names from frontmatter
 * @param typedArgs - Arguments the user has typed so far
 * @returns Hint string like "[arg2] [arg3]" or undefined if all filled
 */
export function generateProgressiveArgumentHint(
  argNames: string[],
  typedArgs: string[],
): string | undefined {
  const remaining = argNames.slice(typedArgs.length)
  if (remaining.length === 0) return undefined
  return remaining.map(name => `[${name}]`).join(' ')
}

/**
 * Substitute $ARGUMENTS placeholders in content with actual argument values.
 *
 * Follows the official 2.1.233 binary `sCt` pass ordering exactly:
 * 1. sanitize the template (strip forged sentinels)
 * 2. shield `\$` escape sequences that precede a substitution marker
 * 3. named arguments (longest name first)
 * 4. `$ARGUMENTS[n]` indexed (misses preserved verbatim, $ shielded)
 * 5. `$n` shorthand (misses preserved verbatim)
 * 6. `$ARGUMENTS` full-args replaceAll
 * 7. append `\nARGUMENTS: <args>` if nothing substituted (and allowed)
 * 8. restore shielded `$` and strip value boundaries
 *
 * @param content - The content containing placeholders
 * @param args - The raw arguments string (may be undefined/null)
 * @param appendIfNoPlaceholder - If true and no placeholders matched, appends "ARGUMENTS: {args}" to content
 * @param argumentNames - Optional array of named arguments (e.g., ["foo", "bar"]) that map to indexed positions
 * @param valueTransform - Optional 5th-param transform applied to each
 *   substituted value (official sCt param `o`). Runs after sentinel
 *   sanitization and before `$` shielding, on the appended-args path too.
 * @returns The content with placeholders substituted
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
  argumentNames: string[] = [],
  valueTransform?: (value: string) => string,
): string {
  // undefined/null means no args provided - return content unchanged
  // empty string is a valid input that should replace placeholders with empty
  if (args === undefined || args === null) {
    return content
  }

  // binary sCt entry sanitization — user content cannot forge sentinel chars
  let work = content
    .replaceAll(SHIELDED_DOLLAR, SENTINEL_REPLACEMENT)
    .replaceAll(VALUE_BOUNDARY, SENTINEL_REPLACEMENT)

  // binary `i` — wrap a substituted value: sanitize, run the optional 5th-param
  // transform (official order: transform sees the sanitized value), shield every
  // inner `$` so later substitution passes cannot re-expand it (the 2.1.233 fix),
  // and surround with boundary chars so inserted values stay isolated.
  const insertValue = (value: string | undefined): string => {
    const sanitized = (value ?? '')
      .replaceAll(SHIELDED_DOLLAR, SENTINEL_REPLACEMENT)
      .replaceAll(VALUE_BOUNDARY, SENTINEL_REPLACEMENT)
    const transformed = valueTransform ? valueTransform(sanitized) : sanitized
    return (
      VALUE_BOUNDARY +
      transformed.replaceAll('$', SHIELDED_DOLLAR) +
      VALUE_BOUNDARY
    )
  }

  const parsedArgs = parseArguments(args)

  // binary `a` — named arguments mapped to positions, longest name first
  const namedArgs = argumentNames
    .map((name, index) => ({ name, index }))
    .filter(entry => Boolean(entry.name))
    .sort((left, right) => right.name.length - left.name.length)

  // binary escape pass — shield the `\$` escape sequence only when it is not
  // itself preceded by a backslash AND is followed by a substitution marker,
  // so `\$0` becomes a literal `$0` while `\\$0` keeps the marker live.
  // Runtime regex: /(?<!\\)\\\$(?=\d|ARGUMENTS|<names>)/g
  const markerAlternation = [
    '\\d',
    'ARGUMENTS',
    ...namedArgs.map(({ name }) => `${escapeRegExp(name)}(?![\\[\\w])`),
  ].join('|')
  work = work.replace(
    new RegExp(`(?<!\\\\)\\\\\\$(?=${markerAlternation})`, 'g'),
    SHIELDED_DOLLAR,
  )

  let didSubstitute = false

  // Named arguments (e.g., $foo) map to positions: argumentNames[i] -> parsedArgs[i].
  // Match $name but not $name[...] or $nameXxx (word chars).
  for (const { name, index } of namedArgs) {
    work = work.replace(
      new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, 'g'),
      () => {
        didSubstitute = true
        return insertValue(parsedArgs[index])
      },
    )
  }

  // Indexed arguments ($ARGUMENTS[0], $ARGUMENTS[1], etc.)
  // 2.1.210: an unmatched $ARGUMENTS[N] (no arg at that index) is preserved
  // verbatim instead of silently stripped to ''. The leading $ is swapped for
  // the SHIELDED_DOLLAR sentinel so the $ARGUMENTS replaceAll below can't
  // swallow this placeholder's $ARGUMENTS prefix; it is restored to $ at the
  // end. An explicit empty-string arg (parsedArgs[index] === '') is NOT
  // undefined and still substitutes to ''.
  work = work.replace(/\$ARGUMENTS\[(\d+)\]/g, (match, indexStr: string) => {
    const index = parseInt(indexStr, 10)
    if (parsedArgs[index] === undefined) {
      return SHIELDED_DOLLAR + match.slice(1)
    }
    didSubstitute = true
    return insertValue(parsedArgs[index])
  })

  // Shorthand indexed arguments ($0, $1, etc.)
  // 2.1.210: an unmatched $N (no arg at that index) is preserved verbatim
  // (returns the full match) instead of silently stripped to ''. No sentinel
  // is needed: $N contains no $ARGUMENTS substring, so the $ARGUMENTS
  // replaceAll below cannot touch it.
  work = work.replace(/\$(\d+)(?!\w)/g, (match, indexStr: string) => {
    const index = parseInt(indexStr, 10)
    if (parsedArgs[index] === undefined) {
      return match
    }
    didSubstitute = true
    return insertValue(parsedArgs[index])
  })

  // Replace $ARGUMENTS with the full arguments string
  work = work.replaceAll('$ARGUMENTS', () => {
    didSubstitute = true
    return insertValue(args)
  })

  // 2.1.233: the append gate is the substitution flag, not string equality —
  // a template whose placeholders all missed still gets args appended.
  // Empty args (invoked with no args) never append.
  if (!didSubstitute && appendIfNoPlaceholder && args) {
    work = work + `\nARGUMENTS: ${insertValue(args)}`
  }

  // Restore shielded `$` chars and strip value boundaries
  return work.replaceAll(SHIELDED_DOLLAR, '$').replaceAll(VALUE_BOUNDARY, '')
}
