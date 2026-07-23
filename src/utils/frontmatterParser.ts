/**
 * Frontmatter parser for markdown files
 * Extracts and parses YAML frontmatter between --- delimiters
 */

import { logForDebugging } from './debug.js'
import type { HooksSettings } from './settings/types.js'
import { parseYaml } from './yaml.js'

export type FrontmatterData = {
  // YAML can return null for keys with no value (e.g., "key:" with nothing after)
  'allowed-tools'?: string | string[] | null
  // 2.1.152: tools blocked while this skill/command is active.
  'disallowed-tools'?: string | string[] | null
  description?: string | null
  // Memory type: 'user', 'feedback', 'project', or 'reference'
  // Only applicable to memory files; narrowed via parseMemoryType() in src/memdir/memoryTypes.ts
  type?: string | null
  'argument-hint'?: string | null
  when_to_use?: string | null
  version?: string | null
  // Only applicable to slash commands -- a string similar to a boolean env var
  // to determine whether to make them visible to the SlashCommand tool.
  'hide-from-slash-command-tool'?: string | null
  // Model alias or name (e.g., 'haiku', 'sonnet', 'opus', or specific model names)
  // Use 'inherit' for commands to use the parent model
  model?: string | null
  // Comma-separated list of skill names to preload (only applicable to agents)
  skills?: string | null
  // Whether users can invoke this skill by typing /skill-name
  // 'true' = user can type /skill-name to invoke
  // 'false' = only model can invoke via Skill tool
  // Default depends on source: commands/ defaults to true, skills/ defaults to false
  'user-invocable'?: string | null
  // Hooks to register when this skill is invoked
  // Keys are hook events (PreToolUse, PostToolUse, Stop, etc.)
  // Values are arrays of matcher configurations with hooks
  // Validated by HooksSchema in loadSkillsDir.ts
  hooks?: HooksSettings | null
  // Effort level for agents (e.g., 'low', 'medium', 'high', 'max', or an integer)
  // Controls the thinking effort used by the agent's model
  effort?: string | null
  // Execution context for skills: 'inline' (default) or 'fork' (run as sub-agent)
  // 'inline' = skill content expands into the current conversation
  // 'fork' = skill runs in a sub-agent with separate context and token budget
  context?: 'inline' | 'fork' | null
  // Agent type to use when forked (e.g., 'Bash', 'general-purpose')
  // Only applicable when context is 'fork'
  agent?: string | null
  // Glob patterns for file paths this skill applies to. Accepts either a
  // comma-separated string or a YAML list of strings.
  // When set, the skill is only activated when the model touches matching files
  // Uses the same format as CLAUDE.md paths frontmatter
  paths?: string | string[] | null
  // Shell to use for !`cmd` and ```! blocks in skill/command .md content.
  // 'bash' (default) or 'powershell'. File-scoped — applies to all !-blocks.
  // Never consults settings.defaultShell: skills are portable across platforms,
  // so the author picks the shell, not the reader. See docs/design/ps-shell-selection.md §5.3.
  shell?: string | null
  [key: string]: unknown
}

export type ParsedMarkdown = {
  frontmatter: FrontmatterData
  content: string
}

// Characters that require quoting in YAML values (when unquoted)
// - { } are flow mapping indicators
// - * is anchor/alias indicator
// - [ ] are flow sequence indicators
// - ': ' (colon followed by space) is key indicator — causes 'Nested mappings
//   are not allowed in compact mappings' when it appears mid-value. Match the
//   pattern rather than bare ':' so '12:34' times and 'https://' URLs stay unquoted.
// - # is comment indicator
// - & is anchor indicator
// - ! is tag indicator
// - | > are block scalar indicators (only at start)
// - % is directive indicator (only at start)
// - @ ` are reserved
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /

/**
 * Pre-processes frontmatter text to quote values that contain special YAML characters.
 * This allows glob patterns like **\/*.{ts,tsx} to be parsed correctly.
 */
function quoteProblematicValues(frontmatterText: string): string {
  const lines = frontmatterText.split('\n')
  const result: string[] = []

  for (const line of lines) {
    // Match simple key: value lines (not indented, not list items, not block scalars)
    const match = line.match(/^([a-zA-Z_-]+):\s+(.+)$/)
    if (match) {
      const [, key, value] = match
      if (!key || !value) {
        result.push(line)
        continue
      }

      // Skip if already quoted
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        result.push(line)
        continue
      }

      // Quote if contains special YAML characters
      if (YAML_SPECIAL_CHARS.test(value)) {
        // Use double quotes and escape any existing double quotes
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        result.push(`${key}: "${escaped}"`)
        continue
      }
    }

    result.push(line)
  }

  return result.join('\n')
}

/**
 * Pre-processes frontmatter text to quote simple `key: value` lines whose
 * value contains a YAML-comment `#` (a leading `#` or a ` #` — a `#` preceded
 * by whitespace). YAML treats such a `#` as the start of a comment, silently
 * truncating the value. {@link quoteProblematicValues} already handles `#`
 * but only runs on the parse-ERROR retry path, so a `#`-value that parses
 * "successfully" (truncated) was never quoted (M10, Claude Code 2.1.214).
 *
 * Narrower than {@link quoteProblematicValues}: only `#`-comment values are
 * quoted here (so glob patterns / flow sequences that currently parse fine
 * are untouched on the primary path; they still get the full retry treatment
 * if the primary parse throws).
 */
function quoteHashCommentValues(frontmatterText: string): string {
  const lines = frontmatterText.split('\n')
  const result: string[] = []

  for (const line of lines) {
    // Match simple key: value lines (not indented, not list items, not block scalars)
    const match = line.match(/^([a-zA-Z_-]+):\s+(.+)$/)
    if (match) {
      const [, key, value] = match
      if (key && value) {
        const alreadyQuoted =
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        // YAML comment `#`: at value start, or preceded by whitespace.
        const hasCommentHash =
          value.startsWith('#') || /\s#/.test(value)
        if (!alreadyQuoted && hasCommentHash) {
          const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
          result.push(`${key}: "${escaped}"`)
          continue
        }
      }
    }
    result.push(line)
  }

  return result.join('\n')
}

export const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/

/**
 * Parses markdown content to extract frontmatter and content
 * @param markdown The raw markdown content
 * @returns Object containing parsed frontmatter and content without frontmatter
 */
export function parseFrontmatter(
  markdown: string,
  sourcePath?: string,
): ParsedMarkdown {
  const match = markdown.match(FRONTMATTER_REGEX)

  if (!match) {
    // No frontmatter found
    return {
      frontmatter: {},
      content: markdown,
    }
  }

  const frontmatterText = match[1] || ''
  const content = markdown.slice(match[0].length)

  let frontmatter: FrontmatterData = {}
  // M10 (2.1.214): pre-quote `#`-comment values so YAML doesn't silently
  // truncate them. quoteProblematicValues (retry path below) only runs on
  // parse errors; a `#`-value parses "successfully" (truncated) so it never
  // reached the retry.
  const preprocessedText = quoteHashCommentValues(frontmatterText)
  try {
    const parsed = parseYaml(preprocessedText) as FrontmatterData | null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed
    }
  } catch {
    // YAML parsing failed - try again after quoting problematic values
    try {
      const quotedText = quoteProblematicValues(frontmatterText)
      const parsed = parseYaml(quotedText) as FrontmatterData | null
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed
      }
    } catch (retryError) {
      // Still failed - log for debugging so users can diagnose broken frontmatter
      const location = sourcePath ? ` in ${sourcePath}` : ''
      logForDebugging(
        `Failed to parse YAML frontmatter${location}: ${retryError instanceof Error ? retryError.message : retryError}`,
        { level: 'warn' },
      )
    }
  }

  return {
    frontmatter,
    content,
  }
}

/**
 * Splits a comma-separated string and expands brace patterns.
 * Commas inside braces are not treated as separators.
 * Also accepts a YAML list (string array) for ergonomic frontmatter.
 * @param input - Comma-separated string, or array of strings, with optional brace patterns
 * @returns Array of expanded strings
 * @example
 * splitPathInFrontmatter("a, b") // returns ["a", "b"]
 * splitPathInFrontmatter("a, src/*.{ts,tsx}") // returns ["a", "src/*.ts", "src/*.tsx"]
 * splitPathInFrontmatter("{a,b}/{c,d}") // returns ["a/c", "a/d", "b/c", "b/d"]
 * splitPathInFrontmatter(["a", "src/*.{ts,tsx}"]) // returns ["a", "src/*.ts", "src/*.tsx"]
 */
export function splitPathInFrontmatter(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    return input.flatMap(splitPathInFrontmatter)
  }
  if (typeof input !== 'string') {
    return []
  }
  // Split by comma while respecting braces
  const parts: string[] = []
  let current = ''
  let braceDepth = 0

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (char === '{') {
      braceDepth++
      current += char
    } else if (char === '}') {
      braceDepth--
      current += char
    } else if (char === ',' && braceDepth === 0) {
      // Split here - we're at a comma outside of braces
      const trimmed = current.trim()
      if (trimmed) {
        parts.push(trimmed)
      }
      current = ''
    } else {
      current += char
    }
  }

  // Add the last part
  const trimmed = current.trim()
  if (trimmed) {
    parts.push(trimmed)
  }

  // Expand brace patterns in each part
  return parts
    .filter(p => p.length > 0)
    .flatMap(pattern => expandBraces(pattern))
}

/**
 * Maximum number of brace expansions a single `paths` frontmatter value may
 * produce before the parser aborts. Matches the official Claude Code binary,
 * which delegates brace expansion to Bun's native globber (`BunObject.rs`):
 *
 *   const MAX_BRACE_EXPANSIONS: u32 = 65536;
 *   if expansion_count > MAX_BRACE_EXPANSIONS {
 *       throw "Too many brace expansions ({} > {})", expansion_count, MAX_BRACE_EXPANSIONS
 *   }
 *
 * CC 2.1.217 #13: a CLAUDE.md/SKILL.md `paths` value with many brace groups
 * could OOM-kill or stall the CLI at startup; the expansion is now
 * budget-bounded. The cap is checked *during* recursion so an exponential
 * pattern (e.g. 30 nested `{a,b}` groups) aborts before allocating gigabytes.
 */
const MAX_BRACE_EXPANSIONS = 65536

/**
 * Expands brace patterns in a glob string.
 * @example
 * expandBraces("src/*.{ts,tsx}") // returns ["src/*.ts", "src/*.tsx"]
 * expandBraces("{a,b}/{c,d}") // returns ["a/c", "a/d", "b/c", "b/d"]
 */
function expandBraces(pattern: string): string[] {
  // Find the first brace group
  const braceMatch = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/)

  if (!braceMatch) {
    // No braces found, return pattern as-is
    return [pattern]
  }

  const prefix = braceMatch[1] || ''
  const alternatives = braceMatch[2] || ''
  const suffix = braceMatch[3] || ''

  // Split alternatives by comma and expand each one
  const parts = alternatives.split(',').map(alt => alt.trim())

  // Recursively expand remaining braces in suffix
  const expanded: string[] = []
  for (const part of parts) {
    const combined = prefix + part + suffix
    // Recursively handle additional brace groups
    const furtherExpanded = expandBraces(combined)
    // CC 2.1.217 #13: budget-bound the expansion count to prevent OOM/stall
    // on pathological patterns. Check before the push so `expanded` never
    // exceeds the cap; `furtherExpanded` is itself bounded by the recursion's
    // own check, so total live allocations stay ≤ ~2× the cap.
    const projected = expanded.length + furtherExpanded.length
    if (projected > MAX_BRACE_EXPANSIONS) {
      throw new Error(
        `Too many brace expansions (${projected} > ${MAX_BRACE_EXPANSIONS})`,
      )
    }
    expanded.push(...furtherExpanded)
  }

  return expanded
}

/**
 * Parses a positive integer value from frontmatter.
 * Handles both number and string representations.
 *
 * @param value The raw value from frontmatter (could be number, string, or undefined)
 * @returns The parsed positive integer, or undefined if invalid or not provided
 */
export function parsePositiveIntFromFrontmatter(
  value: unknown,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  const parsed = typeof value === 'number' ? value : parseInt(String(value), 10)

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed
  }

  return undefined
}

/**
 * Validate and coerce a description value from frontmatter.
 *
 * Strings are returned as-is (trimmed). Primitive values (numbers, booleans)
 * are coerced to strings via String(). Non-scalar values (arrays, objects)
 * are invalid and are logged then omitted. Null, undefined, and
 * empty/whitespace-only strings return null so callers can fall back to
 * a default.
 *
 * @param value - The raw frontmatter description value
 * @param componentName - The skill/command/agent/style name for log messages
 * @param pluginName - The plugin name, if this came from a plugin
 */
export function coerceDescriptionToString(
  value: unknown,
  componentName?: string,
  pluginName?: string,
): string | null {
  if (value == null) {
    return null
  }
  if (typeof value === 'string') {
    return value.trim() || null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  // Non-scalar descriptions (arrays, objects) are invalid — log and omit
  const source = pluginName
    ? `${pluginName}:${componentName}`
    : (componentName ?? 'unknown')
  logForDebugging(`Description invalid for ${source} - omitting`, {
    level: 'warn',
  })
  return null
}

/**
 * Truthy string tokens accepted for skill/plugin frontmatter booleans.
 *
 * Claude Code 2.1.218: "`yes`/`no`/`on`/`off`/`1`/`0` (case-insensitive)
 * as accepted values for skill and plugin frontmatter booleans, alongside
 * `true`/`false`." Binary-verified feature intro in 2.1.218 (absent in
 * 2.1.217). OCC's YAML parser yields `yes`/`no`/`on`/`off` as strings and
 * `1`/`0` as numbers, so all of these must coerce here.
 */
const TRUTHY_BOOLEAN_TOKENS = new Set(['true', 'yes', 'on', '1'])
const FALSY_BOOLEAN_TOKENS = new Set(['false', 'no', 'off', '0'])

/**
 * Parse a boolean frontmatter value.
 *
 * Accepts (case-insensitive, whitespace-trimmed): `true`/`yes`/`on`/`1` →
 * true; `false`/`no`/`off`/`0` → false. Literal booleans and numbers are
 * honored directly (`true`→true, `false`→false, `1`→true, `0`→false).
 * Any other / unknown value returns false (not truthy).
 */
export function parseBooleanFrontmatter(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value !== 'string') return false
  const token = value.trim().toLowerCase()
  if (token === '') return false
  // Explicit falsy tokens resolve to false; everything else is truthy only
  // if it is a known truthy token. This avoids `maybe`/`2` becoming true.
  return TRUTHY_BOOLEAN_TOKENS.has(token) && !FALSY_BOOLEAN_TOKENS.has(token)
}

/**
 * Coerce a frontmatter value to a boolean token, returning `undefined` when
 * the value is not a recognized boolean literal. Shared with the degrade
 * site `parseBackgroundFrontmatter` in loadSkillsDir (CC 2.1.218 #35:
 * `background` frontmatter) so both accept the same token set.
 */
export function coerceBooleanToken(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    return value === 1 ? true : value === 0 ? false : undefined
  }
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase()
    if (TRUTHY_BOOLEAN_TOKENS.has(token)) return true
    if (FALSY_BOOLEAN_TOKENS.has(token)) return false
  }
  return undefined
}

/**
 * Shell values accepted in `shell:` frontmatter for .md `!`-block execution.
 */
export type FrontmatterShell = 'bash' | 'powershell'

const FRONTMATTER_SHELLS: readonly FrontmatterShell[] = ['bash', 'powershell']

/**
 * Parse and validate the `shell:` frontmatter field.
 *
 * Returns undefined for absent/null/empty (caller defaults to bash).
 * Logs a warning and returns undefined for unrecognized values — we fall
 * back to bash rather than failing the skill load, matching how `effort`
 * and other fields degrade.
 */
export function parseShellFrontmatter(
  value: unknown,
  source: string,
): FrontmatterShell | undefined {
  if (value == null) {
    return undefined
  }
  const normalized = String(value).trim().toLowerCase()
  if (normalized === '') {
    return undefined
  }
  if ((FRONTMATTER_SHELLS as readonly string[]).includes(normalized)) {
    return normalized as FrontmatterShell
  }
  logForDebugging(
    `Frontmatter 'shell: ${value}' in ${source} is not recognized. Valid values: ${FRONTMATTER_SHELLS.join(', ')}. Falling back to bash.`,
    { level: 'warn' },
  )
  return undefined
}
