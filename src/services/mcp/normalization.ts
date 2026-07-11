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
 * Validate an MCP server name against the character/length rules enforced by
 * `addMcpConfig`. Returns a human-readable reason when the name would be
 * rejected on those grounds, or `undefined` when it passes.
 *
 * Note: `addMcpConfig` also rejects reserved names (`workspace`,
 * `claude-in-chrome`) and policy violations — those surface as per-server
 * failures in the import loop, not here.
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
