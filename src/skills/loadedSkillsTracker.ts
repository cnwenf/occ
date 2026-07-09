/**
 * Session-level tracker for skills whose instructions have been appended to
 * the conversation context (2.1.202).
 *
 * Re-invoking an already-loaded skill previously appended a DUPLICATE copy of
 * its instructions to context. This tracker lets the skill-content injection
 * path (getMessagesForPromptSlashCommand) skip re-appending a skill's body
 * when the same skill — by name + content hash — is already loaded this
 * session.
 *
 * Scoping mirrors the `invokedSkills` store in bootstrap/state.ts: keys are
 * `${agentId ?? ''}:${skillName}` so a subagent's loaded skills don't affect
 * the main thread (and vice versa). The value is the SHA-256 hash of the
 * rendered skill content (hashSkillContent), so an invocation with different
 * args (different rendered content) is NOT considered a duplicate and is
 * re-appended — only a true duplicate (same skill + same rendered content)
 * is skipped.
 *
 * Not cleared at turn boundaries (turn-scoped state lives in skillAttribution).
 * Survives compaction: compaction restoration re-injects skill content from
 * `invokedSkills` independently, so the tracker staying populated stays
 * consistent with what's in context.
 */

// Map<`${agentId ?? ''}:${skillName}`, contentHash>
const loadedSkills: Map<string, string> = new Map()

function key(skillName: string, agentId: string | null): string {
  return `${agentId ?? ''}:${skillName}`
}

/**
 * Whether this skill's instructions (same rendered content hash) are already
 * loaded in the given agent's context this session.
 */
export function isSkillAlreadyLoaded(
  skillName: string,
  contentHash: string,
  agentId: string | null = null,
): boolean {
  return loadedSkills.get(key(skillName, agentId)) === contentHash
}

/**
 * Record that a skill's instructions have been appended to context. Called
 * only when the body is actually injected (not on the dedup-skip path), so
 * the tracker never claims a skill is loaded when its body isn't in context.
 */
export function markSkillLoaded(
  skillName: string,
  contentHash: string,
  agentId: string | null = null,
): void {
  loadedSkills.set(key(skillName, agentId), contentHash)
}

/**
 * Clear all loaded-skill tracking. For tests and session reset.
 */
export function clearLoadedSkills(): void {
  loadedSkills.clear()
}
