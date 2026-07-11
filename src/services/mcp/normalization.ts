/**
 * Pure utility functions for MCP name normalization.
 * This file has no dependencies to avoid circular imports.
 */

// Claude.ai server names are prefixed with this string
const CLAUDEAI_SERVER_PREFIX = 'claude.ai '

/**
 * Normalize server names to be compatible with the API pattern ^[a-zA-Z0-9_-]{1,64}$
 * Replaces any invalid characters (including dots and spaces) with underscores.
 *
 * For claude.ai servers (names starting with "claude.ai "), also collapses
 * consecutive underscores and strips leading/trailing underscores to prevent
 * interference with the __ delimiter used in MCP tool names.
 */
export function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (name.startsWith(CLAUDEAI_SERVER_PREFIX)) {
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
  }
  return normalized
}

/**
 * Reserved normalized names for the Claude Browser / Claude Preview MCP
 * servers. These correspond to the official `ONh` set in the 2.1.206 binary
 * (`Fc("Claude Preview")`, `Fc("Claude Browser")`). `Fc` is identical to
 * `normalizeNameForMCP`, so membership is checked against the normalized form.
 *
 * claude-code 2.1.205 #22: "Claude Browser" was added to the reserved set
 * alongside the pre-existing "Claude Preview"; the shared `t5n(e)` gate
 * (`ONh.has(Fc(e))`) blocks users from adding either as a custom MCP server.
 */
const RESERVED_CLAUDE_BROWSER_NAMES = new Set([
  'Claude_Preview',
  'Claude_Browser',
])

/**
 * Returns true when `name` normalizes to a reserved Claude Browser / Claude
 * Preview server name. Mirrors the binary's `t5n(e)` membership check
 * (`ONh.has(Fc(e))`): `normalizeNameForMCP("Claude Browser")` →
 * `"Claude_Browser"`, `normalizeNameForMCP("Claude Preview")` →
 * `"Claude_Preview"`. Case-sensitive on the normalized form, matching the
 * official set's exact casing.
 */
export function isReservedClaudeBrowserName(name: string): boolean {
  return RESERVED_CLAUDE_BROWSER_NAMES.has(normalizeNameForMCP(name))
}

/**
 * Validate an MCP server name against the character/length rules enforced by
 * `addMcpConfig`. Returns a human-readable reason when the name would be
 * rejected on those grounds, or `undefined` when it passes.
 *
 * Note: `addMcpConfig` also rejects reserved names (`workspace`,
 * `claude-in-chrome`, `Claude Browser`, `Claude Preview`) and policy
 * violations — those surface as per-server failures in the import loop,
 * not here.
 */
export function getInvalidMcpServerNameReason(
  name: string,
): string | undefined {
  if (typeof name !== 'string' || name.length === 0) {
    return 'name is empty'
  }
  if (name.length > 64) {
    return 'name is longer than 64 characters'
  }
  if (/[^a-zA-Z0-9_-]/.test(name)) {
    return 'names can only contain letters, numbers, hyphens, and underscores'
  }
  return undefined
}

/**
 * Partition MCP servers by name validity. Used by `add-from-claude-desktop`
 * to report invalid names and continue importing the remaining servers
 * (claude-code 2.1.205 #9).
 */
export function partitionMcpServersByName<T>(
  servers: Record<string, T>,
): {
  valid: Record<string, T>
  invalid: { name: string; reason: string }[]
} {
  const valid: Record<string, T> = {}
  const invalid: { name: string; reason: string }[] = []
  for (const [name, config] of Object.entries(servers)) {
    const reason = getInvalidMcpServerNameReason(name)
    if (reason !== undefined) {
      invalid.push({ name, reason })
    } else {
      valid[name] = config
    }
  }
  return { valid, invalid }
}
