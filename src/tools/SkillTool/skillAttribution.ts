/**
 * Skill attribution tracking (2.1.186+).
 *
 * When a skill contributes to a turn (invoked via the Skill tool), the
 * official CLI records turn-level attribution so the API request telemetry
 * can tag which skill/agent/plugin drove the request. The attribution object
 * carries `attributionSkill` (the skill name) and `attributionSkillHash`
 * (a SHA-256 hash of the skill file content for version tracking), plus a
 * derived `attributionPlugin` when the skill is plugin-namespaced.
 *
 * `attributionSkillHash` is a SHA-256 digest of the skill's file content,
 * computed at load time (stored as `skillContentHash` on the Command) and
 * passed to `setSkillAttribution` at invocation time. When no content hash is
 * available (e.g. test stubs), the getter falls back to a deterministic djb2
 * hash of the skill name so the field is always populated.
 *
 * The Skill tool sets the attribution when it invokes a skill (inline,
 * forked, or remote). A consumer reading the API telemetry turns the
 * attribution into `_PROTO_skill_name` on the request event — the same field
 * `tengu_skill_tool_invocation` already emits, now also surfaced per-turn.
 */

import { createHash } from 'crypto'
import { djb2Hash } from '../../utils/hash.js'

// Current turn's contributing skill name and content hash.
let attributionSkillName: string | undefined
let attributionContentHash: string | undefined

/**
 * Derive the plugin identifier from a (possibly plugin-qualified) skill name.
 * For "plugin:skill" returns "plugin"; for a bare name returns undefined.
 * Mirrors the official `Leo` derivation used by the attribution builder.
 */
export function deriveAttributionPlugin(
  skillName: string,
): string | undefined {
  const colonIdx = skillName.lastIndexOf(':')
  if (colonIdx > 0) {
    return skillName.slice(0, colonIdx)
  }
  return undefined
}

/**
 * Compute a SHA-256 hash of skill file content for version tracking.
 * @param content - The raw skill file content (SKILL.md body or full file)
 * @returns 64-character hex digest
 */
export function hashSkillContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Stable, non-cryptographic hash of a skill name for telemetry attribution.
 * Deterministic across runs (djb2 → base36), so the same skill always hashes
 * to the same value within a session. Used as a fallback when no content hash
 * is available.
 */
export function attributionSkillHash(skillName: string): string {
  // Matches the official `upt`/`om` call shape; djb2 gives a stable, non-
  // identifying digest rather than emitting the raw skill name in hashes.
  return Math.abs(djb2Hash(skillName)).toString(36)
}

/**
 * Record that a skill contributed to the current turn.
 * Pass `skillName=undefined` to clear (called at turn boundaries).
 * @param skillName - The skill's name
 * @param contentHash - SHA-256 of the skill file content (for version tracking)
 */
export function setSkillAttribution(
  skillName: string | undefined,
  contentHash?: string,
): void {
  attributionSkillName = skillName
  attributionContentHash = contentHash
}

/**
 * The skill name attributed to the current turn, if any.
 */
export function getAttributionSkillName(): string | undefined {
  return attributionSkillName
}

/**
 * The stable hash of the skill attributed to the current turn, if any.
 * Returns the SHA-256 content hash when available; falls back to a djb2 hash
 * of the skill name when only the name was set (backward compat).
 */
export function getAttributionSkillHash(): string | undefined {
  if (attributionSkillName === undefined) return undefined
  if (attributionContentHash !== undefined) return attributionContentHash
  return attributionSkillHash(attributionSkillName)
}

/**
 * The derived plugin for the attributed skill, if it is plugin-namespaced.
 */
export function getAttributionPlugin(): string | undefined {
  return attributionSkillName === undefined
    ? undefined
    : deriveAttributionPlugin(attributionSkillName)
}

/**
 * Build the attribution fragment for the current turn. Mirrors the official
 * `{attributionSkill, attributionPlugin}` shape (agent/mcp fields are owned
 * by other attribution sources). Returns an empty object when no skill is
 * attributed.
 */
export function getSkillAttribution():
  | { attributionSkill: string; attributionPlugin?: string }
  | Record<string, never> {
  if (attributionSkillName === undefined) return {}
  const plugin = deriveAttributionPlugin(attributionSkillName)
  return {
    attributionSkill: attributionSkillName,
    ...(plugin !== undefined && { attributionPlugin: plugin }),
  }
}

/**
 * Clear the current turn's skill attribution.
 */
export function clearSkillAttribution(): void {
  attributionSkillName = undefined
  attributionContentHash = undefined
}
