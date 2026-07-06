import { feature } from 'src/utils/featureFlags.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../../tools/TaskOutputTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../../tools/TaskStopTool/prompt.js'
import type { PermissionRuleValue } from './PermissionRule.js'

// Dead code elimination: ant-only tool names are conditionally required so
// their strings don't leak into external builds. Static imports always bundle.
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../../tools/BriefTool/prompt.js') as typeof import('../../tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

// Maps legacy tool names to their current canonical names.
// When a tool is renamed, add old → new here so permission rules,
// hooks, and persisted wire names resolve to the canonical name.
const LEGACY_TOOL_NAME_ALIASES: Record<string, string> = {
  Task: AGENT_TOOL_NAME,
  KillShell: TASK_STOP_TOOL_NAME,
  AgentOutputTool: TASK_OUTPUT_TOOL_NAME,
  BashOutputTool: TASK_OUTPUT_TOOL_NAME,
  ...((feature('KAIROS') || feature('KAIROS_BRIEF')) && BRIEF_TOOL_NAME
    ? { Brief: BRIEF_TOOL_NAME }
    : {}),
}

export function normalizeLegacyToolName(name: string): string {
  return LEGACY_TOOL_NAME_ALIASES[name] ?? name
}

export function getLegacyToolNames(canonicalName: string): string[] {
  const result: string[] = []
  for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_NAME_ALIASES)) {
    if (canonical === canonicalName) result.push(legacy)
  }
  return result
}

/**
 * Escapes special characters in rule content for safe storage in permission rules.
 * Permission rules use the format "Tool(content)", so parentheses in content must be escaped.
 *
 * Escaping order matters:
 * 1. Escape existing backslashes first (\ -> \\)
 * 2. Then escape parentheses (( -> \(, ) -> \))
 *
 * @example
 * escapeRuleContent('psycopg2.connect()') // => 'psycopg2.connect\\(\\)'
 * escapeRuleContent('echo "test\\nvalue"') // => 'echo "test\\\\nvalue"'
 */
export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, '\\\\') // Escape backslashes first
    .replace(/\(/g, '\\(') // Escape opening parentheses
    .replace(/\)/g, '\\)') // Escape closing parentheses
}

/**
 * Unescapes special characters in rule content after parsing from permission rules.
 * This reverses the escaping done by escapeRuleContent.
 *
 * Unescaping order matters (reverse of escaping):
 * 1. Unescape parentheses first (\( -> (, \) -> ))
 * 2. Then unescape backslashes (\\ -> \)
 *
 * @example
 * unescapeRuleContent('psycopg2.connect\\(\\)') // => 'psycopg2.connect()'
 * unescapeRuleContent('echo "test\\\\nvalue"') // => 'echo "test\\nvalue"'
 */
export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, '(') // Unescape opening parentheses
    .replace(/\\\)/g, ')') // Unescape closing parentheses
    .replace(/\\\\/g, '\\') // Unescape backslashes last
}

/**
 * Parses a permission rule string into its components.
 * Handles escaped parentheses in the content portion.
 *
 * Format: "ToolName" or "ToolName(content)"
 * Content may contain escaped parentheses: \( and \)
 *
 * @example
 * permissionRuleValueFromString('Bash') // => { toolName: 'Bash' }
 * permissionRuleValueFromString('Bash(npm install)') // => { toolName: 'Bash', ruleContent: 'npm install' }
 * permissionRuleValueFromString('Bash(python -c "print\\(1\\)")') // => { toolName: 'Bash', ruleContent: 'python -c "print(1)"' }
 */
export function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  // Find the first unescaped opening parenthesis
  const openParenIndex = findFirstUnescapedChar(ruleString, '(')
  if (openParenIndex === -1) {
    // No parenthesis found - this is just a tool name
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // Find the last unescaped closing parenthesis
  const closeParenIndex = findLastUnescapedChar(ruleString, ')')
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
    // No matching closing paren or malformed - treat as tool name
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // Ensure the closing paren is at the end
  if (closeParenIndex !== ruleString.length - 1) {
    // Content after closing paren - treat as tool name
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  const toolName = ruleString.substring(0, openParenIndex)
  const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex)

  // Missing toolName (e.g., "(foo)") is malformed - treat whole string as tool name
  if (!toolName) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // Empty content (e.g., "Bash()") or standalone wildcard (e.g., "Bash(*)")
  // should be treated as just the tool name (tool-wide rule)
  if (rawContent === '' || rawContent === '*') {
    return { toolName: normalizeLegacyToolName(toolName) }
  }

  // Unescape the content
  const ruleContent = unescapeRuleContent(rawContent)
  return { toolName: normalizeLegacyToolName(toolName), ruleContent }
}

/**
 * Converts a permission rule value to its string representation.
 * Escapes parentheses in the content to prevent parsing issues.
 *
 * @example
 * permissionRuleValueToString({ toolName: 'Bash' }) // => 'Bash'
 * permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'npm install' }) // => 'Bash(npm install)'
 * permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'python -c "print(1)"' }) // => 'Bash(python -c "print\\(1\\)")'
 */
export function permissionRuleValueToString(
  ruleValue: PermissionRuleValue,
): string {
  if (!ruleValue.ruleContent) {
    return ruleValue.toolName
  }
  const escapedContent = escapeRuleContent(ruleValue.ruleContent)
  return `${ruleValue.toolName}(${escapedContent})`
}

/**
 * Find the index of the first unescaped occurrence of a character.
 * A character is escaped if preceded by an odd number of backslashes.
 */
function findFirstUnescapedChar(str: string, char: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      // Count preceding backslashes
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && str[j] === '\\') {
        backslashCount++
        j--
      }
      // If even number of backslashes, the char is unescaped
      if (backslashCount % 2 === 0) {
        return i
      }
    }
  }
  return -1
}

/**
 * Find the index of the last unescaped occurrence of a character.
 * A character is escaped if preceded by an odd number of backslashes.
 */
function findLastUnescapedChar(str: string, char: string): number {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      // Count preceding backslashes
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && str[j] === '\\') {
        backslashCount++
        j--
      }
      // If even number of backslashes, the char is unescaped
      if (backslashCount % 2 === 0) {
        return i
      }
    }
  }
  return -1
}

// ============================================================================
// Tool(param:value) rule syntax (2.1.178+)
// ============================================================================

/**
 * Parse a `param:value` rule content (the part inside `Tool(...)`).
 *
 * A rule like `Agent(model:opus)` parses to `{toolName:'Agent', ruleContent:'model:opus'}`;
 * this function splits that ruleContent into `{param:'model', value:'opus'}`.
 * Returns null when the content has no `:` separator (e.g. a plain Bash command
 * like `npm install` or a legacy `prefix:*` wildcard — those are not param rules).
 *
 * The split is on the FIRST `:` so values may themselves contain colons
 * (e.g. `Bash(timeout:30s)`). A leading `:` (empty param) is not a param rule.
 */
export function parseParamValueRuleContent(
  ruleContent: string,
): { param: string; value: string } | null {
  const colonIndex = ruleContent.indexOf(':')
  if (colonIndex <= 0) return null // no colon, or colon at position 0 (empty param)
  const param = ruleContent.slice(0, colonIndex)
  const value = ruleContent.slice(colonIndex + 1)
  if (param === '' || value === '') return null
  return { param, value }
}

/**
 * Check whether a tool call's input satisfies a `param:value` rule content.
 *
 * For `Agent(model:opus)` against input `{model:'opus', ...}` this returns true.
 * Comparison is string-based so boolean/number input values match their literal
 * rule spelling (`Bash(run_in_background:true)` matches `run_in_background: true`).
 */
export function matchesToolInputParam(
  ruleContent: string,
  input: unknown,
): boolean {
  const parsed = parseParamValueRuleContent(ruleContent)
  if (parsed === null) return false
  if (input == null || typeof input !== 'object') return false
  const record = input as Record<string, unknown>
  const actual = record[parsed.param]
  if (actual === undefined) return false
  return String(actual) === parsed.value
}

/**
 * Result of validating a parsed permission rule value.
 */
export type PermissionRuleValidation = {
  valid: boolean
  error?: string
  suggestion?: string
}

/**
 * Validate a parsed permission rule value for the `Tool(param:value)` /
 * `Tool(prefix:*)` syntax (2.1.178+).
 *
 * Checks (matching the official 2.1.200 validator):
 *   - MCP rules (rules for `mcp__*` tools) do not support patterns in
 *     parentheses — only the bare tool name is allowed.
 *   - The legacy `:*` wildcard prefix syntax must be at the END of the rule
 *     content (e.g. `npm:*` is fine; `npm:*:install` is not).
 *
 * `isMcp` may be passed explicitly for callers that already know the tool kind;
 * otherwise an `mcp__`-prefixed toolName is treated as an MCP rule.
 */
export function validatePermissionRuleValue(
  ruleValue: PermissionRuleValue,
  opts: { isMcp?: boolean } = {},
): PermissionRuleValidation {
  const isMcp = opts.isMcp ?? ruleValue.toolName.startsWith('mcp__')
  if (isMcp && ruleValue.ruleContent !== undefined) {
    return {
      valid: false,
      error: 'MCP rules do not support patterns in parentheses',
    }
  }
  const content = ruleValue.ruleContent
  if (content !== undefined && content.includes(':*') && !content.endsWith(':*')) {
    return {
      valid: false,
      error: 'The :* pattern must be at the end',
      suggestion: 'Move :* to the end of the rule',
    }
  }
  return { valid: true }
}
